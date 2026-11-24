// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { native, prepareMarkdown, preparePdfMock, prepareFmdMock, mediaBytesMock, editorBridge, readerTree } = vi.hoisted(() => {
  if (typeof document !== "undefined") {
    document.body.innerHTML = '<div id="root"></div>';
  }
  return {
    native: vi.fn(async (_command: string, _args?: unknown): Promise<unknown> => null),
    prepareMarkdown: vi.fn(),
    preparePdfMock: vi.fn(),
    prepareFmdMock: vi.fn(),
    mediaBytesMock: vi.fn(),
    editorBridge: {
      onChange: null as ((value: string) => void) | null,
    },
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
vi.mock("./preparePdf", () => ({ preparePdf: preparePdfMock }));
vi.mock("./documentMedia", () => ({ prepareFmd: prepareFmdMock }));
vi.mock("./mediaExport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./mediaExport")>();
  return { ...actual, mediaBytes: mediaBytesMock };
});
vi.mock("./components/Editor", () => ({
  default: ({ onChange }: { onChange?: (value: string) => void }) => {
    editorBridge.onChange = onChange ?? null;
    return <div className="mock-editor" />;
  },
  editorReadingOffset: () => 0,
  editorSelectedText: () => null,
  editorViewContext: () => undefined,
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

import { computeAgentDocumentRequest } from "./androidReader";

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
  preparePdfMock.mockReset();
  prepareFmdMock.mockReset();
  mediaBytesMock.mockReset();
  editorBridge.onChange = null;
  document.body.innerHTML = "";
  localStorage.clear();
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  localStorage.clear();
});

async function mountReader() {
  const host = document.createElement("div");
  document.body.append(host);
  root = readerTree.mountRoot!(host);
  await act(async () => {
    root?.render(readerTree.element);
  });
  return host;
}

function callLiveAgent(request: Record<string, unknown>) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    window.supermdAgentRequest!(request, (result, error) => {
      if (error) reject(new Error(error));
      else resolve(result as Record<string, unknown>);
    });
  });
}

const pdfOptions = {
  pageSize: "a4" as const,
  margin: 18,
  fontSize: 11,
  lineHeight: 1.4,
  fontFamily: "Manrope",
  pageNumbers: true,
};

it("forwards the active note Python interpreter when preparing Markdown and Markdown ZIP exports", async () => {
  prepareMarkdown.mockResolvedValue({
    content: "# Study\n\n![Diagram](<image1.svg>)\n",
    assets: { "image1.svg": "data:image/svg+xml;base64,PHN2Zy8+" },
  });

  const host = await mountReader();

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
});

it("bundles companion assets and supports archive mode for agent export_document requests", async () => {
  prepareMarkdown.mockResolvedValue({
    content: "# Study\n\n![Diagram](<image1.svg>)\n",
    assets: { "image1.svg": "data:image/svg+xml;base64,PHN2Zy8+" },
  });
  native.mockImplementation(async (command: string, args?: unknown) => {
    if (command === "agent_export_native") {
      return { accepted: true, jobId: (args as { requestId?: string } | undefined)?.requestId };
    }
    return null;
  });

  await mountReader();

  const content = "# Study\n\n![Diagram](diagram.svg)\n";
  await act(async () => {
    window.supermdLoad!({
      id: "tab-agent-export",
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

  const context = await callLiveAgent({ action: "get_context", tabId: "tab-agent-export" });

  await callLiveAgent({
    action: "export_document",
    tabId: "tab-agent-export",
    expectedRevision: context.revision,
    requestId: "job-md",
    format: "md",
    filename: "Study.md",
    options: { pageSize: "a4" },
  });
  expect(prepareMarkdown).toHaveBeenCalledWith(content, "/vault/Study.md", {
    compatible: false,
    python: "/opt/venv/bin/python",
  });
  expect(native).toHaveBeenCalledWith("agent_export_native", {
    id: "tab-agent-export",
    expectedRevision: context.revision,
    requestId: "job-md",
    format: "md",
    filename: "Study.md",
    content: "# Study\n\n![Diagram](<image1.svg>)\n",
    assets: { "image1.svg": "data:image/svg+xml;base64,PHN2Zy8+" },
    options: { pageSize: "a4" },
  });

  prepareMarkdown.mockClear();
  native.mockClear();
  await callLiveAgent({
    action: "export_document",
    tabId: "tab-agent-export",
    expectedRevision: context.revision,
    requestId: "job-mdzip",
    format: "md",
    filename: "Study.zip",
    options: { archive: true },
  });
  expect(prepareMarkdown).toHaveBeenCalledWith(content, "/vault/Study.md", {
    compatible: true,
    python: "/opt/venv/bin/python",
  });
  expect(native).toHaveBeenCalledWith("agent_export_native", {
    id: "tab-agent-export",
    expectedRevision: context.revision,
    requestId: "job-mdzip",
    format: "mdzip",
    archive: true,
    filename: "Study.zip",
    content: "# Study\n\n![Diagram](<image1.svg>)\n",
    assets: { "image1.svg": "data:image/svg+xml;base64,PHN2Zy8+" },
    options: {},
  });

  prepareMarkdown.mockClear();
  native.mockClear();
  await callLiveAgent({
    action: "export_document",
    tabId: "tab-agent-export",
    expectedRevision: context.revision,
    requestId: "job-direct-mdzip",
    format: "mdzip",
    filename: "Bundle",
  });
  expect(prepareMarkdown).toHaveBeenCalledWith(content, "/vault/Study.md", {
    compatible: true,
    python: "/opt/venv/bin/python",
  });
  expect(native).toHaveBeenCalledWith("agent_export_native", {
    id: "tab-agent-export",
    expectedRevision: context.revision,
    requestId: "job-direct-mdzip",
    format: "mdzip",
    archive: true,
    filename: "Bundle",
    content: "# Study\n\n![Diagram](<image1.svg>)\n",
    assets: { "image1.svg": "data:image/svg+xml;base64,PHN2Zy8+" },
    options: {},
  });
});

it("shares read and diagram actions across snapshot and live agent handlers while preserving distinct fallbacks", async () => {
  await mountReader();

  const svgSource = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 20"><rect width="40" height="20"/></svg>';
  const content = `# Study 🧭\n\nIntroductory search target.\n\n## Architecture\n\n\`\`\`svg\n${svgSource}\n\`\`\`\n\n## Notes\n\nClosing search target.\n`;

  await act(async () => {
    window.supermdLoad!({
      id: "tab-agent",
      content,
      path: "/vault/Agent.md",
      mode: "reader",
      dark: false,
      fullscreen: false,
      font: "sans",
      size: 16,
      colors: { primary: "#386a57" },
      zoom: 100,
    });
  });

  // flush_current, list_tabs, and tabId validation run before expectedRevision checks in live mode.
  const flushed = await callLiveAgent({ action: "flush_current", expectedRevision: "stale-revision" });
  const revision = String(flushed.revision);
  const fullLength = Array.from(content).length;
  expect(flushed).toEqual({ tabId: "tab-agent", revision, sourceLength: fullLength });

  const listed = await callLiveAgent({
    action: "list_tabs",
    expectedRevision: "stale-revision",
    tabs: [{ id: "tab-agent", title: "Agent" }, { id: "other", title: "Other" }],
  });
  expect(listed).toEqual({
    tabs: [
      { id: "tab-agent", tabId: "tab-agent", title: "Agent", revision, sourceLength: fullLength },
      { id: "other", title: "Other" },
    ],
  });

  await expect(
    callLiveAgent({ action: "read_tab", tabId: "other-tab", expectedRevision: "stale-revision" }),
  ).rejects.toThrow("Select this tab before requesting its live reader");

  const sharedRequests: Array<Record<string, unknown>> = [
    { action: "read_tab", offset: 0, limit: 60, view: "source" },
    { action: "outline_tab", offset: 0, limit: 10 },
    { action: "search_tab", query: "search target", limit: 5, context: 12 },
    { action: "list_diagrams", offset: 0, limit: 10 },
  ];

  for (const request of sharedRequests) {
    const snapshotResult = await computeAgentDocumentRequest({ ...request, content, tabId: "tab-agent" });
    const liveResult = await callLiveAgent({ ...request, tabId: "tab-agent" });
    expect(liveResult).toEqual(snapshotResult);
  }

  const diagramsResult = await computeAgentDocumentRequest({ action: "list_diagrams", content, tabId: "tab-agent" });
  const diagramId = (diagramsResult.diagrams as Array<{ id: string }>)[0].id;

  const snapshotDiagram = await computeAgentDocumentRequest({
    action: "get_diagram",
    content,
    tabId: "tab-agent",
    diagramId,
    expectedRevision: revision,
    offset: 0,
    limit: 500,
  });
  const liveDiagram = await callLiveAgent({
    action: "get_diagram",
    tabId: "tab-agent",
    diagramId,
    expectedRevision: revision,
    offset: 0,
    limit: 500,
  });
  expect(liveDiagram).toEqual(snapshotDiagram);
  expect(snapshotDiagram.sourceLength).toBe(fullLength);
  expect(snapshotDiagram.text).toBe(svgSource);

  // Shared revision and diagram validation errors match across both entry points.
  for (const run of [
    (req: Record<string, unknown>) => computeAgentDocumentRequest({ ...req, content, tabId: "tab-agent" }),
    (req: Record<string, unknown>) => callLiveAgent({ ...req, tabId: "tab-agent" }),
  ]) {
    await expect(run({ action: "read_tab", expectedRevision: "stale-revision" })).rejects.toThrow(
      "Revision conflict: the note changed; read it again before editing",
    );
    await expect(run({ action: "get_diagram", diagramId })).rejects.toThrow(
      "A current expectedRevision is required to retrieve this diagram",
    );
    await expect(run({ action: "get_diagram", diagramId: "diagram:missing", expectedRevision: revision })).rejects.toThrow(
      "Diagram not found in this revision",
    );
  }

  // get_diagram_image shares diagram lookup on live reader and keeps snapshot rejection intact.
  await expect(
    computeAgentDocumentRequest({ action: "get_diagram_image", content, tabId: "tab-agent", diagramId, expectedRevision: revision }),
  ).rejects.toThrow("Diagram image requests require the active reader view");
  await expect(callLiveAgent({ action: "get_diagram_image", tabId: "tab-agent", diagramId })).rejects.toThrow(
    "A current expectedRevision is required to retrieve this diagram",
  );
  await expect(
    callLiveAgent({ action: "get_diagram_image", tabId: "tab-agent", diagramId: "diagram:missing", expectedRevision: revision }),
  ).rejects.toThrow("Diagram not found in this revision");

  mediaBytesMock.mockResolvedValue({
    body: "cG5nLWJ5dGVz",
    mimeType: "image/png",
    filename: "SVG drawing.png",
    width: 80,
    height: 40,
  });
  const diagramImage = await callLiveAgent({
    action: "get_diagram_image",
    tabId: "tab-agent",
    diagramId,
    expectedRevision: revision,
    width: 320,
  });
  expect(diagramImage).toEqual({
    tabId: "tab-agent",
    revision,
    sourceLength: fullLength,
    diagramId,
    mime_type: "image/png",
    data: "cG5nLWJ5dGVz",
    width: 80,
    height: 40,
  });

  // Fallback errors remain distinct between snapshot and live handlers.
  await expect(
    computeAgentDocumentRequest({ action: "unsupported_custom_action", content, tabId: "tab-agent" }),
  ).rejects.toThrow("Unsupported snapshot agent action");
  await expect(callLiveAgent({ action: "unsupported_custom_action", tabId: "tab-agent" })).rejects.toThrow(
    "Unsupported live reader action",
  );
});

it("flushes pending editProtocol edits before Portable, PDF, and Markdown exports", async () => {
  let releasePatch: (() => void) | null = null;
  native.mockImplementation(async (command: string, args?: unknown) => {
    if (command === "document_sync") return { accepted: true, revision: 0 };
    if (command === "document_patch") {
      const payload = args as { revision: number };
      await new Promise<void>((resolve) => {
        releasePatch = resolve;
      });
      return { accepted: true, revision: payload.revision };
    }
    return null;
  });
  prepareFmdMock.mockImplementation(async (markdown: string) => ({ content: markdown, assets: {} }));
  preparePdfMock.mockImplementation(async (markdown: string) => ({ markdown, images: {} }));
  prepareMarkdown.mockImplementation(async (markdown: string) => ({ content: markdown, assets: {} }));

  await mountReader();
  await act(async () => {
    window.supermdLoad!({
      id: "tab-flush",
      content: "# Initial\n",
      path: "/vault/Flush.md",
      mode: "editor",
      dark: false,
      fullscreen: false,
      font: "sans",
      size: 16,
      editProtocol: 1,
      colors: { primary: "#386a57" },
      zoom: 100,
    });
  });

  // 1. Portable (.smd) export waits for pending edit patch acknowledgement.
  await act(async () => {
    editorBridge.onChange!("# Portable flushed\n");
  });
  await vi.waitFor(() => expect(releasePatch).not.toBeNull());
  const portablePromise = window.supermdPortable!(true) as unknown as Promise<void>;
  expect(prepareFmdMock).not.toHaveBeenCalled();
  await act(async () => {
    releasePatch!();
    releasePatch = null;
    await portablePromise;
  });
  expect(prepareFmdMock).toHaveBeenCalledWith("# Portable flushed\n", "/vault/Flush.md");
  expect(native).toHaveBeenCalledWith(
    "export_fmd_native",
    expect.objectContaining({ id: "tab-flush", originalContent: "# Portable flushed\n", save: true }),
  );

  // 2. PDF export waits for pending edit patch acknowledgement.
  await act(async () => {
    editorBridge.onChange!("# PDF flushed\n");
  });
  await vi.waitFor(() => expect(releasePatch).not.toBeNull());
  let pdfPromise!: Promise<void>;
  await act(async () => {
    pdfPromise = window.supermdExport!(pdfOptions) as unknown as Promise<void>;
  });
  expect(preparePdfMock).not.toHaveBeenCalled();
  await act(async () => {
    releasePatch!();
    releasePatch = null;
    await pdfPromise;
  });
  expect(preparePdfMock).toHaveBeenCalledWith(
    "# PDF flushed\n",
    "/vault/Flush.md",
    "embedded",
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(native).toHaveBeenCalledWith(
    "export_pdf_native",
    expect.objectContaining({ id: "tab-flush", markdown: "# PDF flushed\n" }),
  );

  // 3. Markdown export waits for pending edit patch acknowledgement.
  await act(async () => {
    editorBridge.onChange!("# Markdown flushed\n");
  });
  await vi.waitFor(() => expect(releasePatch).not.toBeNull());
  const mdPromise = window.supermdExportMarkdown!(false) as unknown as Promise<void>;
  expect(prepareMarkdown).not.toHaveBeenCalled();
  await act(async () => {
    releasePatch!();
    releasePatch = null;
    await mdPromise;
  });
  expect(prepareMarkdown).toHaveBeenCalledWith("# Markdown flushed\n", "/vault/Flush.md", {
    compatible: false,
    python: "embedded",
  });
  expect(native).toHaveBeenCalledWith("export_markdown_native", {
    id: "tab-flush",
    content: "# Markdown flushed\n",
    assets: {},
    archive: false,
  });
});

it("reports export_failed when the active tab switches during a pre-export editProtocol flush", async () => {
  const host = await mountReader();

  const exportHooks: Array<{ name: string; start: () => Promise<void> }> = [
    { name: "portable", start: () => window.supermdPortable!(false) as unknown as Promise<void> },
    { name: "pdf", start: () => window.supermdExport!(pdfOptions) as unknown as Promise<void> },
    { name: "markdown", start: () => window.supermdExportMarkdown!(true) as unknown as Promise<void> },
  ];

  for (const [index, hook] of exportHooks.entries()) {
    let releaseSync: (() => void) | null = null;
    const originId = `tab-origin-${index}`;
    const switchedId = `tab-switched-${index}`;

    native.mockClear();
    native.mockImplementation(async (command: string, args?: unknown) => {
      if (command === "document_sync" && (args as { id: string }).id === originId) {
        await new Promise<void>((resolve) => {
          releaseSync = resolve;
        });
        return { accepted: true, revision: 0 };
      }
      if (command === "document_sync") return { accepted: true, revision: 0 };
      return null;
    });

    await act(async () => {
      window.supermdLoad!({
        id: originId,
        content: `# Origin ${hook.name}\n`,
        path: `/vault/${originId}.md`,
        mode: "reader",
        dark: false,
        fullscreen: false,
        font: "sans",
        size: 16,
        editProtocol: 1,
        colors: { primary: "#386a57" },
        zoom: 100,
      });
    });

    let exporting!: Promise<void>;
    await act(async () => {
      exporting = hook.start();
    });
    await vi.waitFor(() => expect(releaseSync).not.toBeNull());

    await act(async () => {
      window.supermdLoad!({
        id: switchedId,
        content: "# Switched\n",
        path: `/vault/${switchedId}.md`,
        mode: "reader",
        dark: false,
        fullscreen: false,
        font: "sans",
        size: 16,
        editProtocol: 1,
        colors: { primary: "#386a57" },
        zoom: 100,
      });
    });

    await act(async () => {
      releaseSync!();
      await exporting;
    });

    expect(native).toHaveBeenCalledWith("export_failed", { error: "Error: The export note changed" });
    expect(prepareFmdMock).not.toHaveBeenCalled();
    expect(preparePdfMock).not.toHaveBeenCalled();
    expect(prepareMarkdown).not.toHaveBeenCalled();
    expect(host.querySelector(".reader-export-progress")).toBeNull();
  }
});
