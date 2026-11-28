// @vitest-environment jsdom
import { act, useLayoutEffect, useRef, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { native, applyDocumentZoomMock, clearProgrammaticMock, readerTree } = vi.hoisted(() => {
  if (typeof document !== "undefined") {
    document.body.innerHTML = '<div id="root"></div>';
  }
  return {
    native: vi.fn(async (_command: string, _args?: unknown): Promise<unknown> => null),
    applyDocumentZoomMock: vi.fn(),
    clearProgrammaticMock: vi.fn(),
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
vi.mock("./documentZoom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./documentZoom")>();
  return { ...actual, applyDocumentZoom: applyDocumentZoomMock };
});
vi.mock("./sourceAnchor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sourceAnchor")>();
  return { ...actual, clearProgrammaticAnchorScroll: clearProgrammaticMock };
});
vi.mock("./components/Editor", () => ({
  default: () => <div className="cm-scroller" />,
  editorReadingOffset: () => 0,
  editorSelectedText: () => null,
  editorViewContext: () => undefined,
  editorHistory: () => false,
  exportEditorSession: () => undefined,
  formatEditorSession: () => false,
  importEditorSession: () => {},
  cachedEditorHistory: () => undefined,
}));
vi.mock("./components/LiveEditor", () => ({
  default: () => <div className="mock-live-editor" />,
  formatActiveLiveBlock: () => false,
  replayActiveLiveBlockHistory: () => false,
}));
vi.mock("./components/MarkdownPreview", () => ({ default: () => <div className="mock-preview" /> }));
vi.mock("./components/MediaTools", () => ({ default: () => null }));
vi.mock("./components/ImageViewer", () => ({ default: () => null }));
vi.mock("./components/MathRepairPanel", () => ({ default: () => null }));
vi.mock("./components/ThemeGuideDialog", () => ({ default: () => null }));
vi.mock("./components/ReadingSearch", () => ({ default: () => null }));

import { useReaderGestureControls, useReaderGesturesAndZoom, type GesturesReaderState } from "./useReaderGesturesAndZoom";
import type { SplitAnchorPane } from "./sourceAnchor";
import "./androidReader";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
class ResizeObserverMock {
  observe() {}
  disconnect() {}
}
Object.assign(globalThis, { ResizeObserver: ResizeObserverMock });

const EXPECTED_SUPERMD_GLOBALS = [
  "supermdAgentCompute", "supermdAgentRequest", "supermdBeforeNavigate", "supermdChromeInset", "supermdDismiss",
  "supermdExport", "supermdExportMarkdown", "supermdExportPhase", "supermdFind", "supermdFindStep",
  "supermdFlush", "supermdFormat", "supermdHeading", "supermdHistory", "supermdLoad",
  "supermdNativeWheel", "supermdPortable", "supermdRepairMath", "supermdResetZoom", "supermdSavePosition",
  "supermdSelectedText", "supermdSetZoom", "supermdThemeGuide", "supermdToggleTypewriter", "supermdZoomBy",
] as const;

describe("useReaderGesturesAndZoom and Reader bridge wiring", () => {
  let root: Root | null = null;

  beforeEach(() => {
    native.mockClear();
    native.mockImplementation(async () => null);
    applyDocumentZoomMock.mockClear();
    clearProgrammaticMock.mockClear();
    document.body.innerHTML = "";
    document.documentElement.removeAttribute("style");
    delete document.documentElement.dataset.fullscreen;
    localStorage.clear();
  });

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = null;
    document.body.innerHTML = "";
    localStorage.clear();
  });

  it("runs host CSS/fullscreen layout updates before useReaderGesturesAndZoom centerLock zoom sync", async () => {
    const observedFullscreenAtZoomApply: Array<string | undefined> = [];
    applyDocumentZoomMock.mockImplementation(() => {
      observedFullscreenAtZoomApply.push(document.documentElement.dataset.fullscreen);
    });

    let exposedControls: ReturnType<typeof useReaderGestureControls> | null = null;
    let exposedSplitPane: { current: SplitAnchorPane | null } | null = null;

    function Harness({ state }: { state: GesturesReaderState }) {
      const reference = useRef<GesturesReaderState | null>(state);
      reference.current = state;
      const splitPane = useRef<SplitAnchorPane | null>(null);
      const controls = useReaderGestureControls({ reference, splitPane });
      exposedControls = controls;
      exposedSplitPane = splitPane;
      useLayoutEffect(() => {
        document.documentElement.dataset.fullscreen = String(state.fullscreen);
      }, [state.fullscreen]);
      useReaderGesturesAndZoom({ state, reference, controls });
      return (
        <div className="mode-split">
          <section className="android-source"><div className="cm-editor"><div className="cm-scroller" /></div></section>
          <section className="android-reading"><div className="document-page" /></section>
        </div>
      );
    }

    const host = document.createElement("div");
    document.body.append(host);
    root = readerTree.mountRoot!(host);

    await act(async () => {
      root?.render(<Harness state={{ id: "n1", content: "# Hi", mode: "split", fullscreen: false, centerLock: false }} />);
    });
    expect(observedFullscreenAtZoomApply).toEqual(["false"]);

    observedFullscreenAtZoomApply.length = 0;
    await act(async () => {
      root?.render(<Harness state={{ id: "n1", content: "# Hi", mode: "split", fullscreen: true, centerLock: true }} />);
    });
    expect(observedFullscreenAtZoomApply).toEqual(["true"]);

    // setZoom updates workspace scale and ignores stale requestedAt timestamps before zoomGestureAt.
    exposedControls!.refs.zoomGestureAt.current = 2000;
    exposedControls!.setZoom(150, 1500);
    expect(exposedControls!.zoomReference.current).toBe(100);
    exposedControls!.setZoom(150, 2500);
    expect(exposedControls!.zoomReference.current).toBe(150);
    expect(host.querySelector<HTMLElement>(".android-source")?.style.getPropertyValue("--workspace-scale")).toBe("1.5");

    // handleNativeWheel tracks split pane targets and delegates modifier zoom to supermdZoomBy.
    const cmScroller = host.querySelector<HTMLElement>(".cm-scroller")!;
    const originalElementFromPoint = document.elementFromPoint;
    document.elementFromPoint = () => cmScroller;
    const zoomSpy = vi.fn();
    window.supermdZoomBy = zoomSpy;
    try {
      exposedControls!.handleNativeWheel(0, 24, { x: 20, y: 20 }, false, false);
      expect(exposedSplitPane!.current).toBe("editor");
      expect(clearProgrammaticMock).toHaveBeenCalledWith(cmScroller);

      exposedControls!.handleNativeWheel(0, -50, { x: 20, y: 20 }, true, true);
      expect(zoomSpy).toHaveBeenCalledWith(Math.exp(50 * 0.002), { x: 20, y: 20 });

      exposedControls!.resetZoom();
      expect(zoomSpy).toHaveBeenLastCalledWith(100 / 150);
    } finally {
      document.elementFromPoint = originalElementFromPoint;
      delete window.supermdZoomBy;
    }
  });

  it("registers all 25 window.supermd* globals synchronously before reader_ready and removes them on unmount", async () => {
    let presentAtReady: string[] = [];
    native.mockImplementation(async (command: string) => {
      if (command === "reader_ready") {
        presentAtReady = EXPECTED_SUPERMD_GLOBALS.filter(
          (key) => typeof (window as unknown as Record<string, unknown>)[key] === "function",
        );
      }
      return null;
    });

    const host = document.createElement("div");
    document.body.append(host);
    root = readerTree.mountRoot!(host);
    await act(async () => {
      root?.render(readerTree.element);
    });

    expect(presentAtReady).toEqual([...EXPECTED_SUPERMD_GLOBALS]);

    act(() => root?.unmount());
    root = null;
    const remaining = EXPECTED_SUPERMD_GLOBALS.filter(
      (key) => (window as unknown as Record<string, unknown>)[key] !== undefined,
    );
    expect(remaining).toEqual([]);
  });
});
