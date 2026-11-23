// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { native, readerTree } = vi.hoisted(() => {
  if (typeof document !== "undefined") {
    document.body.innerHTML = '<div id="root"></div>';
  }
  return {
    native: vi.fn(async (_command: string, _args?: unknown): Promise<unknown> => ({ accepted: true, revision: 0 })),
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
vi.mock("./markdownExport", () => ({ prepareMarkdownExport: vi.fn() }));
vi.mock("./preparePdf", () => ({ preparePdf: vi.fn() }));
vi.mock("./documentMedia", () => ({ prepareFmd: vi.fn() }));
vi.mock("./components/Editor", () => ({
  default: ({ onChange }: { onChange: (value: string) => void }) => (
    <button
      type="button"
      className="mock-editor-type"
      onClick={() => onChange("# Tab 1\n\nUnsaved draft\n")}
    />
  ),
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

async function mountReader(): Promise<HTMLDivElement> {
  const host = document.createElement("div");
  document.body.append(host);
  root = readerTree.mountRoot!(host);
  await act(async () => {
    root?.render(readerTree.element);
  });
  return host;
}

beforeEach(() => {
  native.mockClear();
  native.mockImplementation(async () => ({ accepted: true, revision: 0 }));
  document.body.innerHTML = "";
  localStorage.clear();
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  localStorage.clear();
});

describe("androidReader supermdFlush handoff and conflict handling", () => {
  it("acknowledges android_flush before the initial supermdLoad without hanging or setting an edit error", async () => {
    const host = await mountReader();
    native.mockClear();

    await act(async () => {
      window.supermdFlush!({ action: "android_flush", target: "welcome-tab", token: "token-pre-load" });
      await Promise.resolve();
    });

    expect(native).toHaveBeenCalledWith("document_flushed", {
      id: "",
      token: "token-pre-load",
      error: "The active note changed before its edit flush",
    });
    expect(host.querySelector(".reader-edit-error")).toBeNull();
  });

  it("reports active-note mismatch during tab handoff without showing a reader edit error alert", async () => {
    const host = await mountReader();
    await act(async () => {
      window.supermdLoad!({
        id: "tab-1",
        content: "# First External Open\n",
        path: "content://share/first.md",
        mode: "reader",
        dark: false,
        fullscreen: false,
        font: "sans",
        size: 16,
        colors: { primary: "#386a57" },
        zoom: 100,
        editProtocol: 1,
      } as Parameters<NonNullable<Window["supermdLoad"]>>[0]);
    });
    native.mockClear();

    await act(async () => {
      window.supermdFlush!({ action: "android_flush", target: "tab-2", token: "token-handoff" });
      await Promise.resolve();
    });

    expect(native).toHaveBeenCalledWith("document_flushed", {
      id: "tab-1",
      token: "token-handoff",
      error: expect.stringContaining("The active note changed before its edit flush"),
    });
    expect(host.querySelector(".reader-edit-error")).toBeNull();
  });

  it("preserves reader edit error reporting when flushing the active note fails edit synchronization", async () => {
    const host = await mountReader();
    native.mockImplementation(async (command: string) => {
      if (command === "document_sync" || command === "document_patch" || command === "document_resync") {
        return { accepted: false, reason: "conflict" };
      }
      return { accepted: true };
    });

    await act(async () => {
      window.supermdLoad!({
        id: "tab-1",
        content: "# Tab 1\n",
        path: "content://share/first.md",
        mode: "editor",
        dark: false,
        fullscreen: false,
        font: "sans",
        size: 16,
        colors: { primary: "#386a57" },
        zoom: 100,
        editProtocol: 1,
      } as Parameters<NonNullable<Window["supermdLoad"]>>[0]);
    });
    await act(async () => {
      (host.querySelector(".mock-editor-type") as HTMLButtonElement).click();
      await Promise.resolve();
    });
    native.mockClear();

    await act(async () => {
      window.supermdFlush!({ action: "android_flush", target: "tab-1", token: "token-conflict" });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(native).toHaveBeenCalledWith(
      "document_flushed",
      expect.objectContaining({
        id: "tab-1",
        token: "token-conflict",
        error: expect.stringContaining("changed outside this edit session"),
      }),
    );
    expect(host.querySelector(".reader-edit-error")?.textContent).toContain("changed outside this edit session");
  });
});
