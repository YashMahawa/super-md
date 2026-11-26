// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { native, editorAnchors, readerTree } = vi.hoisted(() => {
  if (typeof document !== "undefined") {
    document.body.innerHTML = '<div id="root"></div>';
  }
  return {
    native: vi.fn(async (_command: string, _args?: unknown): Promise<unknown> => true),
    editorAnchors: new Map<string, { offset: number; caretOffset?: number } | null>(),
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
vi.mock("./components/Editor", () => ({
  default: ({ sessionId }: { sessionId: string }) => (
    <div className="mock-editor" data-doc-id={sessionId} data-primed-offset={editorAnchors.get(sessionId)?.offset ?? ""} />
  ),
  editorReadingOffset: (id: string) => editorAnchors.get(id)?.offset ?? 0,
  editorSelectedText: () => null,
  editorViewContext: () => ({ editorTop: 240 }),
  editorHistory: () => false,
  exportEditorSession: () => undefined,
  importEditorSession: () => {},
  cachedEditorHistory: () => undefined,
  primeEditorAnchor: (id: string, anchor: { offset: number; caretOffset?: number } | null) => {
    editorAnchors.set(id, anchor);
  },
  revealEditorOffset: () => {},
  formatEditorSession: () => false,
}));
vi.mock("./components/LiveEditor", () => ({
  default: ({ markdown }: { markdown: string }) => (
    <div className="live-document">
      <p data-source-start="0" data-source-end={String(markdown.length)}>
        {markdown}
      </p>
    </div>
  ),
  formatActiveLiveBlock: () => false,
  replayActiveLiveBlockHistory: () => false,
}));
vi.mock("./components/MarkdownPreview", () => ({
  default: ({ markdown }: { markdown: string }) => (
    <div className="markdown-body">
      <p data-source-start="0" data-source-end={String(markdown.length)}>
        {markdown}
      </p>
    </div>
  ),
}));
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

const basePayload = {
  dark: false,
  fullscreen: false,
  font: "Manrope",
  size: 18,
  motion: false,
  colors: {},
};

function currentAppliedScale(): string {
  return (
    document.querySelector<HTMLElement>(".document-page")?.dataset.scale ||
    document.querySelector<HTMLElement>(".android-source")?.style.getPropertyValue("--workspace-scale") ||
    ""
  );
}

async function mountReader() {
  const host = document.createElement("div");
  document.body.append(host);
  root = readerTree.mountRoot!(host);
  await act(async () => {
    root?.render(readerTree.element);
  });
}

describe("nativeReader per-note mode and zoom across tab switches", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    native.mockClear();
    native.mockImplementation(async () => true);
    editorAnchors.clear();
    document.body.innerHTML = "";
    localStorage.clear();
  });

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = null;
    vi.useRealTimers();
    document.body.innerHTML = "";
    localStorage.clear();
  });

  it("applies distinct mode and zoom per note (including unsaved drafts) and configured defaults for new notes", async () => {
    await mountReader();

    // Load saved Note A in reader mode at 165% zoom.
    await act(async () => {
      window.supermdLoad?.({
        ...basePayload,
        id: "saved-note-a",
        path: "/notes/a.md",
        content: "# Saved Note A\n\nAlpha content.",
        mode: "reader",
        zoom: 165,
      });
    });
    expect(document.querySelector(".markdown-body")).not.toBeNull();
    expect(document.querySelector(".mock-editor")).toBeNull();
    expect(currentAppliedScale()).toBe("1.65");

    // Switch to unsaved Draft B (path === id) in editor mode at 135% zoom.
    await act(async () => {
      window.supermdLoad?.({
        ...basePayload,
        id: "unsaved-draft-b",
        path: "unsaved-draft-b",
        content: "# Draft B\n\nUnsaved beta draft.",
        mode: "editor",
        zoom: 135,
      });
    });
    expect(document.querySelector(".mock-editor")?.getAttribute("data-doc-id")).toBe("unsaved-draft-b");
    expect(document.querySelector(".markdown-body")).toBeNull();
    expect(currentAppliedScale()).toBe("1.35");

    // Switch to a brand-new Note C using configured defaults (live mode at 110% zoom).
    await act(async () => {
      window.supermdLoad?.({
        ...basePayload,
        id: "new-note-c",
        path: "new-note-c",
        content: "",
        mode: "live",
        zoom: 110,
      });
    });
    expect(document.querySelector(".live-document")).not.toBeNull();
    expect(currentAppliedScale()).toBe("1.1");

    // Switch back to saved Note A -> restores reader mode and 165% zoom.
    await act(async () => {
      window.supermdLoad?.({
        ...basePayload,
        id: "saved-note-a",
        path: "/notes/a.md",
        content: "# Saved Note A\n\nAlpha content.",
        mode: "reader",
        zoom: 165,
      });
    });
    expect(document.querySelector(".markdown-body")).not.toBeNull();
    expect(currentAppliedScale()).toBe("1.65");
  });

  it("flushes pending gesture zoom with the outgoing note id on immediate tab switch without clobbering the incoming tab", async () => {
    await mountReader();

    await act(async () => {
      window.supermdLoad?.({
        ...basePayload,
        id: "draft-a",
        path: "draft-a",
        content: "# Draft A",
        mode: "live",
        zoom: 100,
      });
    });
    expect(currentAppliedScale()).toBe("1");

    // Trigger gesture zoom on Draft A (100 * 1.4 = 140), then switch tabs BEFORE the 220ms debounce fires.
    await act(async () => {
      window.supermdZoomBy?.(1.4, { x: 200, y: 200 });
    });
    expect(native.mock.calls.filter(([cmd]) => cmd === "zoom_changed")).toHaveLength(0);

    await act(async () => {
      window.supermdLoad?.({
        ...basePayload,
        id: "saved-b",
        path: "/notes/b.md",
        content: "# Saved B",
        mode: "split",
        zoom: 125,
      });
    });

    const zoomCalls = native.mock.calls.filter(([cmd]) => cmd === "zoom_changed");
    expect(zoomCalls).toHaveLength(1);
    expect(zoomCalls[0][1]).toEqual({
      id: "draft-a",
      zoom: 140,
      fullscreen: false,
    });
    expect(document.querySelector<HTMLElement>(".document-page")?.dataset.scale).toBe("1.25");
    expect(document.querySelector<HTMLElement>(".android-source")?.style.getPropertyValue("--workspace-scale")).toBe("1.25");

    // Advancing past 220ms must NOT emit a stale zoom_changed for Draft A onto Saved B.
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(native.mock.calls.filter(([cmd]) => cmd === "zoom_changed")).toHaveLength(1);
    expect(currentAppliedScale()).toBe("1.25");
  });
});
