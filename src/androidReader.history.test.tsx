// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MAX_TRANSFERRED_HISTORY_COST, validHistory, type NoteHistory } from "./noteHistory";

const { native, liveBridge, readerTree } = vi.hoisted(() => {
  if (typeof document !== "undefined") {
    document.body.innerHTML = '<div id="root"></div>';
  }
  return {
    native: vi.fn(async (_command: string, _args?: unknown): Promise<unknown> => null),
    liveBridge: {
      markdown: "",
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
vi.mock("./components/Editor", () => ({
  default: () => <div className="mock-editor" />,
  editorReadingOffset: () => 0,
  editorSelectedText: () => null,
  editorViewContext: () => undefined,
  editorHistory: () => false,
  exportEditorSession: () => undefined,
  importEditorSession: () => {},
  cachedEditorHistory: () => undefined,
}));
vi.mock("./components/LiveEditor", () => ({
  default: ({ markdown, onChange }: { markdown: string; onChange: (value: string) => void }) => {
    liveBridge.markdown = markdown;
    liveBridge.onChange = onChange;
    return <div className="mock-live-editor" data-length={markdown.length} />;
  },
  formatActiveLiveBlock: () => false,
  replayActiveLiveBlockHistory: () => false,
}));
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
  liveBridge.markdown = "";
  liveBridge.onChange = null;
  document.body.innerHTML = "";
  localStorage.clear();
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  localStorage.clear();
});

async function mountFreshReader() {
  if (root) {
    act(() => root?.unmount());
    root = null;
  }
  document.body.innerHTML = "";
  const host = document.createElement("div");
  document.body.append(host);
  root = readerTree.mountRoot!(host);
  await act(async () => {
    root?.render(readerTree.element);
  });
  return host;
}

function makeReaderState(id: string, content: string, viewState?: Record<string, unknown>) {
  return {
    id,
    content,
    path: null,
    mode: "live" as const,
    dark: false,
    fullscreen: false,
    font: "sans",
    size: 17,
    colors: {},
    zoom: 100,
    ...(viewState ? { viewState } : {}),
  };
}

async function flushReader(operation: Record<string, string>) {
  native.mockClear();
  await act(async () => {
    window.supermdFlush!(operation);
  });
  const call = native.mock.calls.find(([cmd]) => cmd === "document_flushed");
  expect(call).toBeDefined();
  return call![1] as {
    id: string;
    content: string;
    viewId: string;
    viewState?: { history?: NoteHistory; top?: number; anchor?: unknown };
  };
}

it("retains newest-step undo/redo below the transfer limit across replay, tear-off, and reload", async () => {
  await mountFreshReader();
  const s0 = "0".repeat(900_000);
  const s1 = "1".repeat(800_000);
  const s2 = "# Compact summary";
  const s3 = `${s2}\n${"2".repeat(2_500_000)}`;

  await act(async () => {
    window.supermdLoad!(makeReaderState("tab-under", s0));
  });
  await act(async () => liveBridge.onChange!(s1));
  await act(async () => liveBridge.onChange!(s2));
  await act(async () => liveBridge.onChange!(s3));
  expect(liveBridge.markdown).toBe(s3);

  // Undo the 2.5M insertion: in-memory undo (900K + 800K = 1.7M) + redo (2.5M) = 4.2M > 4.0M.
  await act(async () => window.supermdHistory!("undo"));
  expect(liveBridge.markdown).toBe(s2);

  // Tear off (`detach_tab`): transferHistory trims oldest 900K undo so BOTH 800K undo and 2.5M redo survive.
  const detached = await flushReader({ action: "detach_tab", target: "tab-under", token: "tok-detach" });
  expect(detached.content).toBe(s2);
  expect(detached.viewState?.history).toBeDefined();
  expect(validHistory(detached.viewState!.history)).toBe(true);

  // Mount a fresh destination window and verify both Undo and Redo work.
  await mountFreshReader();
  await act(async () => {
    window.supermdLoad!(makeReaderState("tab-under", detached.content, detached.viewState));
  });
  expect(liveBridge.markdown).toBe(s2);
  await act(async () => window.supermdHistory!("redo"));
  expect(liveBridge.markdown).toBe(s3);
  await act(async () => window.supermdHistory!("undo"));
  expect(liveBridge.markdown).toBe(s2);
  await act(async () => window.supermdHistory!("undo"));
  expect(liveBridge.markdown).toBe(s1);

  // Reload (`reload_reader`) also preserves the transferred undo/redo stacks cleanly.
  const reloaded = await flushReader({ action: "reload_reader", target: "", token: "tok-reload" });
  expect(validHistory(reloaded.viewState?.history)).toBe(true);
  await mountFreshReader();
  await act(async () => {
    window.supermdLoad!(makeReaderState("tab-under", reloaded.content, reloaded.viewState));
  });
  await act(async () => window.supermdHistory!("redo"));
  expect(liveBridge.markdown).toBe(s2);
});

it("handles newest steps above the transfer limit across in-session replay, tear-off, and reload without losing valid stacks", async () => {
  await mountFreshReader();
  const hugeInitial = "H".repeat(4_500_000);
  const summary = "# Summary after replacing 4.5 MB note";

  await act(async () => {
    window.supermdLoad!(makeReaderState("tab-over", hugeInitial));
  });
  await act(async () => liveBridge.onChange!(summary));
  expect(liveBridge.markdown).toBe(summary);

  // Tear-off before Undo: single 4.5M undo step exceeds 4,000,000, so history is omitted while viewState still flushes.
  const beforeUndoFlush = await flushReader({ action: "detach_tab", target: "tab-over", token: "tok-over-1" });
  expect(beforeUndoFlush.viewState).toBeDefined();
  expect(beforeUndoFlush.viewState?.history).toBeUndefined();
  expect(JSON.stringify(beforeUndoFlush.viewState).length).toBeLessThan(MAX_TRANSFERRED_HISTORY_COST);

  // In-session Undo still restores the full 4.5M note, leaving a tiny redo step (`summary`) that DOES survive reload!
  await act(async () => window.supermdHistory!("undo"));
  expect(liveBridge.markdown).toBe(hugeInitial);
  const afterUndoReload = await flushReader({ action: "reload_reader", target: "", token: "tok-over-2" });
  expect(validHistory(afterUndoReload.viewState?.history)).toBe(true);

  await mountFreshReader();
  await act(async () => {
    window.supermdLoad!(makeReaderState("tab-over", afterUndoReload.content, afterUndoReload.viewState));
  });
  expect(liveBridge.markdown).toBe(hugeInitial);
  await act(async () => window.supermdHistory!("redo"));
  expect(liveBridge.markdown).toBe(summary);

  // Prior small edit + 4.5M paste undone: tear-off drops >4M redo while retaining prior undo.
  await mountFreshReader();
  await act(async () => {
    window.supermdLoad!(makeReaderState("tab-over-paste", "First draft"));
  });
  await act(async () => liveBridge.onChange!("Second draft"));
  await act(async () => liveBridge.onChange!(`Second draft\n${"P".repeat(4_500_000)}`));
  await act(async () => window.supermdHistory!("undo"));
  expect(liveBridge.markdown).toBe("Second draft");

  const moved = await flushReader({
    action: "move_tab",
    target: JSON.stringify({ window: 2, tab: "tab-over-paste", index: 0 }),
    token: "tok-move",
  });
  expect(validHistory(moved.viewState?.history)).toBe(true);

  await mountFreshReader();
  await act(async () => {
    window.supermdLoad!(makeReaderState("tab-over-paste", moved.content, moved.viewState));
  });
  await act(async () => window.supermdHistory!("undo"));
  expect(liveBridge.markdown).toBe("First draft");
  // Redo of the >4M step was cleanly dropped at transfer.
  await act(async () => window.supermdHistory!("redo"));
  expect(liveBridge.markdown).toBe("Second draft");
  await act(async () => window.supermdHistory!("redo"));
  expect(liveBridge.markdown).toBe("Second draft");
});

it("imports valid legacy string snapshots, rejects oversized raw transfers, and isolates independent tab caches", async () => {
  await mountFreshReader();

  // Tab A: imported legacy string history.
  const legacyViewState = {
    history: { undo: ["# Legacy v0", "# Legacy v1"], redo: ["# Legacy v3"], last: 0 },
    top: 40,
  };
  await act(async () => {
    window.supermdLoad!(makeReaderState("tab-legacy", "# Legacy v2", legacyViewState));
  });
  await act(async () => window.supermdHistory!("undo"));
  expect(liveBridge.markdown).toBe("# Legacy v1");
  await act(async () => window.supermdHistory!("redo"));
  expect(liveBridge.markdown).toBe("# Legacy v2");

  // Tab B: normal independent tab history.
  await act(async () => {
    window.supermdLoad!(makeReaderState("tab-b", "Alpha"));
  });
  await act(async () => liveBridge.onChange!("Alpha Beta"));

  // Tab C: active tab performs a 4.5M replacement (> 4,000,000 transfer limit).
  const hugeC = "C".repeat(4_500_000);
  await act(async () => {
    window.supermdLoad!(makeReaderState("tab-c", hugeC));
  });
  await act(async () => liveBridge.onChange!("Compact C"));

  // Detaching inactive Tab B while Tab C holds a 4.5M step still exports Tab B's intact history!
  const detachedB = await flushReader({ action: "detach_tab", target: "tab-b", token: "tok-b" });
  expect(validHistory(detachedB.viewState?.history)).toBe(true);

  // Switching back to Tab A and Tab B preserves their independent undo/redo histories.
  await act(async () => {
    window.supermdLoad!(makeReaderState("tab-legacy", "# Legacy v2"));
  });
  await act(async () => window.supermdHistory!("undo"));
  expect(liveBridge.markdown).toBe("# Legacy v1");

  await act(async () => {
    window.supermdLoad!(makeReaderState("tab-b", "Alpha Beta"));
  });
  await act(async () => window.supermdHistory!("undo"));
  expect(liveBridge.markdown).toBe("Alpha");

  // Direct untrusted oversized raw viewState.history (> 4,000,000) is strictly rejected by validHistory on import.
  await act(async () => {
    window.supermdLoad!(
      makeReaderState("tab-untrusted", "Safe text", {
        history: { undo: ["X".repeat(MAX_TRANSFERRED_HISTORY_COST + 10)], redo: [], last: 0 },
      }),
    );
  });
  await act(async () => window.supermdHistory!("undo"));
  expect(liveBridge.markdown).toBe("Safe text");
});
