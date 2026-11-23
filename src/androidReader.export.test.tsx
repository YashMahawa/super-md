// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { agentRevision } from "./agentOperations";

const { native, prepareMarkdown, readerTree } = vi.hoisted(() => {
  if (typeof document !== "undefined") {
    document.body.innerHTML = '<div id="root"></div>';
  }
  return {
    native: vi.fn(async (_command: string, _args?: unknown): Promise<unknown> => null),
    prepareMarkdown: vi.fn(),
    readerTree: {
      element: null as ReactNode,
      mountRoot: null as ((container: Element | DocumentFragment) => Root) | null,
    },
  };
});

vi.mock("react-dom/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-dom/client")>();
  readerTree.mountRoot = actual.createRoot;
  return {
    ...actual,
    createRoot: () => ({
      render: (node: ReactNode) => {
        readerTree.element = node;
      },
      unmount: () => {},
    }),
  };
});
vi.mock("./nativeBridge", () => ({ invoke: native }));
vi.mock("./markdownExport", () => ({ prepareMarkdownExport: prepareMarkdown }));
vi.mock("./preparePdf", () => ({ preparePdf: vi.fn() }));
vi.mock("./documentMedia", () => ({ prepareFmd: vi.fn() }));
vi.mock("./components/Editor", () => ({
  default: () => <div className="mock-editor" />,
  editorReadingOffset: () => 0,
  editorHistory: () => false,
  exportEditorSession: () => undefined,
  importEditorSession: () => {},
  cachedEditorHistory: () => undefined,
}));
vi.mock("./components/LiveEditor", () => ({ default: () => <div className="mock-live-editor" /> }));
vi.mock("./components/MarkdownPreview", () => ({ default: () => <div className="mock-preview" /> }));
vi.mock("./components/MediaTools", () => ({ default: () => null }));
vi.mock("./components/ImageViewer", () => ({ default: () => null }));
vi.mock("./components/MathRepairPanel", () => ({ default: () => null }));
vi.mock("./components/ThemeGuideDialog", () => ({ default: () => null }));
vi.mock("./components/ReadingSearch", () => ({ default: () => null }));

import "./androidReader";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
class ResizeObserverMock {
  observe() {}
  disconnect() {}
}
Object.assign(globalThis, { ResizeObserver: ResizeObserverMock });

let root: Root | null = null;

beforeEach(() => {
  native.mockClear();
  native.mockImplementation(async () => null);
  prepareMarkdown.mockReset();
  document.body.innerHTML = "";
  localStorage.clear();
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  localStorage.clear();
});

it("forwards the active note Python interpreter when preparing Markdown, Markdown ZIP, and live agent mdzip exports", async () => {
  native.mockImplementation(async (command: string, args?: unknown) => {
    if (command === "agent_export_native") {
      return { jobId: "job-zip-1", status: "running", ...(args as object) };
    }
    return null;
  });
  prepareMarkdown.mockResolvedValue({
    content: "# Study\n\n![Diagram](<image1.svg>)\n",
    assets: { "image1.svg": "data:image/svg+xml;base64,PHN2Zy8+" },
  });

  const host = document.createElement("div");
  document.body.append(host);
  root = readerTree.mountRoot!(host);
  await act(async () => {
    root?.render(readerTree.element);
  });

  const content = "# Study\n\nLink [[Concept Note]]\n";
  await act(async () => {
    window.supermdLoad!({
      id: "tab-1",
      content,
      path: "/vault/Study.md",
      mode: "reader",
      dark: false,
      fullscreen: false,
      font: "sans",
      size: 16,
      colors: { primary: "#386a57" },
      zoom: 100,
      python: "/opt/venv/bin/python",
    });
  });
  expect(host.querySelector(".android-document")).not.toBeNull();

  await window.supermdExportMarkdown!(true);
  expect(prepareMarkdown).toHaveBeenCalledWith(content, "/vault/Study.md", {
    compatible: true,
    python: "/opt/venv/bin/python",
  });
  expect(native).toHaveBeenCalledWith("export_markdown_native", {
    id: "tab-1",
    content: "# Study\n\n![Diagram](<image1.svg>)\n",
    assets: { "image1.svg": "data:image/svg+xml;base64,PHN2Zy8+" },
    archive: true,
  });

  prepareMarkdown.mockClear();
  native.mockClear();
  await window.supermdExportMarkdown!(false);
  expect(prepareMarkdown).toHaveBeenCalledWith(content, "/vault/Study.md", {
    compatible: false,
    python: "/opt/venv/bin/python",
  });
  expect(native).toHaveBeenCalledWith("export_markdown_native", {
    id: "tab-1",
    content: "# Study\n\n![Diagram](<image1.svg>)\n",
    assets: { "image1.svg": "data:image/svg+xml;base64,PHN2Zy8+" },
    archive: false,
  });

  prepareMarkdown.mockClear();
  native.mockClear();
  const revision = await agentRevision(content);
  const reply = await new Promise<{ result: unknown; error: string }>((resolve) => {
    window.supermdAgentRequest!(
      {
        requestId: "req-mdzip-1",
        action: "export_document",
        tabId: "tab-1",
        format: "mdzip",
        filename: "Study",
        expectedRevision: revision,
      },
      (result, error) => resolve({ result, error }),
    );
  });

  expect(reply.error).toBe("");
  expect(prepareMarkdown).toHaveBeenCalledWith(content, "/vault/Study.md", {
    compatible: true,
    python: "/opt/venv/bin/python",
  });
  expect(reply.result).toMatchObject({
    jobId: "job-zip-1",
    status: "running",
    format: "mdzip",
    filename: "Study",
  });
});
