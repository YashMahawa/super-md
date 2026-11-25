// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { analyzeDocument, toCompactAnalysis, type SourceDocumentAnalysis } from "./documentAnalysis";
import type { DocumentAnalysisWorkerRequest, DocumentAnalysisWorkerResponse } from "./documentAnalysis.worker";
import { sharedDocumentAnalysisClient } from "./documentAnalysisWorker";

const { native, readerTree, workerPool } = vi.hoisted(() => {
  if (typeof document !== "undefined") {
    document.body.innerHTML = '<div id="root"></div>';
  }
  return {
    native: vi.fn(async (_command: string, _args?: unknown): Promise<unknown> => null),
    readerTree: {
      element: null as ReactNode,
      mountRoot: null as ((container: Element | DocumentFragment) => Root) | null,
    },
    workerPool: {
      instances: [] as Array<{
        onmessage: ((event: MessageEvent<DocumentAnalysisWorkerResponse>) => void) | null;
        onerror: ((event: ErrorEvent) => void) | null;
        onmessageerror: ((event: MessageEvent) => void) | null;
        posted: DocumentAnalysisWorkerRequest[];
        flushAll: () => void;
      }>,
    },
  };
});

class ControlledGlobalWorker {
  onmessage: ((event: MessageEvent<DocumentAnalysisWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  posted: DocumentAnalysisWorkerRequest[] = [];
  private cursor = 0;

  constructor(_url: string | URL, _options?: WorkerOptions) {
    workerPool.instances.push(this);
  }

  postMessage(data: DocumentAnalysisWorkerRequest) {
    this.posted.push(data);
  }

  terminate() {}

  flushAll() {
    while (this.cursor < this.posted.length) {
      const req = this.posted[this.cursor++];
      const compact = toCompactAnalysis(analyzeDocument(req.source));
      this.onmessage?.({ data: { id: req.id, analysis: compact } } as MessageEvent<DocumentAnalysisWorkerResponse>);
    }
  }
}

Object.assign(globalThis, { Worker: ControlledGlobalWorker, IS_REACT_ACT_ENVIRONMENT: true });

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
vi.mock("./preparePdf", () => ({ preparePdf: vi.fn() }));
vi.mock("./documentMedia", () => ({ prepareFmd: vi.fn() }));
vi.mock("./markdownExport", () => ({ prepareMarkdownExport: vi.fn() }));
vi.mock("./components/Editor", () => ({
  default: ({ value, onChange }: { value: string; onChange: (next: string) => void }) => (
    <div className="cm-scroller" data-value={value} onClick={() => onChange(`${value}\nedited`)} />
  ),
  editorReadingOffset: () => 0,
  editorSelectedText: () => null,
  editorViewContext: () => undefined,
  editorHistory: () => false,
  exportEditorSession: () => undefined,
  importEditorSession: () => {},
  cachedEditorHistory: () => undefined,
}));
vi.mock("./components/LiveEditor", () => ({
  default: ({ sourceAnalysis }: { sourceAnalysis?: SourceDocumentAnalysis }) => (
    <div className="mock-live-editor">
      <h1>{sourceAnalysis?.analysis.outline[0]?.title ?? ""}</h1>
    </div>
  ),
}));
vi.mock("./components/MarkdownPreview", () => ({
  default: ({ markdown, sourceAnalysis }: { markdown: string; sourceAnalysis?: SourceDocumentAnalysis }) => (
    <div className="markdown-body" data-rendered-source={markdown}>
      <h1>{sourceAnalysis?.analysis.outline[0]?.title ?? ""}</h1>
    </div>
  ),
}));
vi.mock("./components/MediaTools", () => ({ default: () => null }));
vi.mock("./components/ImageViewer", () => ({ default: () => null }));
vi.mock("./components/MathRepairPanel", () => ({ default: () => null }));
vi.mock("./components/ThemeGuideDialog", () => ({ default: () => null }));
vi.mock("./components/ReadingSearch", () => ({ default: () => null }));

import "./androidReader";

class ResizeObserverMock {
  observe() {}
  disconnect() {}
}
Object.assign(globalThis, { ResizeObserver: ResizeObserverMock });

let root: Root | null = null;
const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;

beforeEach(() => {
  sharedDocumentAnalysisClient.reclaimIdle();
  workerPool.instances.length = 0;
  native.mockClear();
  native.mockImplementation(async (command: string) => {
    if (command === "document_sync") return { accepted: true, revision: 0 };
    return null;
  });
  document.body.innerHTML = "";
  localStorage.clear();
  Object.defineProperty(window, "innerWidth", { value: 1024, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: 768, configurable: true });
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    if (this.classList.contains("android-reading") || this.classList.contains("cm-scroller")) {
      return new DOMRect(0, 48, 960, 680);
    }
    if (this.tagName === "H1") {
      return new DOMRect(24, 72, 600, 36);
    }
    return originalGetBoundingClientRect.call(this);
  };
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  workerPool.instances.forEach((worker) => worker.flushAll());
  sharedDocumentAnalysisClient.reclaimIdle();
  HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
  document.body.innerHTML = "";
  localStorage.clear();
});

it("waits for background worker analysis and DOM commit before resolving get_context and isolates wholesale native note replacements", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  root = readerTree.mountRoot!(host);
  await act(async () => {
    root?.render(readerTree.element);
  });

  await act(async () => {
    window.supermdLoad!({
      id: "tab-live",
      content: "# Second tab\n\nFreshly activated body.\n",
      path: "/vault/Second.md",
      mode: "reader",
      dark: false,
      fullscreen: false,
      font: "sans",
      size: 16,
      colors: { primary: "#386a57" },
      zoom: 100,
    });
  });

  // While the worker job is still in flight, .android-reading is not yet mounted.
  expect(host.querySelector(".android-reading")).toBeNull();
  expect(host.querySelector(".reader-loading")).not.toBeNull();

  // Issue get_context immediately (as native activate_document / render_tab does).
  const contextPromise = new Promise<{ result: Record<string, unknown> | null; error: string }>((resolve) => {
    window.supermdAgentRequest!(
      { requestId: "ctx-1", action: "get_context", tabId: "tab-live" },
      (result, error) => resolve({ result: result as Record<string, unknown> | null, error }),
    );
  });

  // Complete the background worker job after get_context has already started waiting.
  await act(async () => {
    await Promise.resolve();
    workerPool.instances.forEach((worker) => worker.flushAll());
  });

  const { result: contextResult, error: contextError } = await contextPromise;
  expect(contextError).toBe("");
  expect(contextResult).not.toBeNull();
  const viewport = contextResult!.viewport as { width: number; height: number };
  const reading = contextResult!.reading as { heading: string };
  expect(viewport.width).toBe(960);
  expect(viewport.height).toBe(680);
  expect(reading.heading).toBe("Second tab");

  // Wholesale external replacement on the SAME tab id retains the reading container
  // while get_context waits for the new worker analysis + DOM commit before resolving.
  const existingReading = host.querySelector(".android-reading");
  expect(existingReading).not.toBeNull();

  await act(async () => {
    window.supermdLoad!({
      id: "tab-live",
      content: "# Immersive reading\n\nReplaced note body.\n",
      path: "/vault/Second.md",
      mode: "reader",
      dark: false,
      fullscreen: false,
      font: "sans",
      size: 16,
      colors: { primary: "#386a57" },
      zoom: 100,
    });
  });

  // Container stays mounted across same-tab updates so scroll anchors survive.
  expect(host.querySelector(".android-reading")).toBe(existingReading);

  let replacedSettled = false;
  const replacedContextPromise = new Promise<{ result: Record<string, unknown> | null; error: string }>((resolve) => {
    window.supermdAgentRequest!(
      { requestId: "ctx-2", action: "get_context", tabId: "tab-live" },
      (result, error) => {
        replacedSettled = true;
        resolve({ result: result as Record<string, unknown> | null, error });
      },
    );
  });

  await act(async () => {
    await Promise.resolve();
  });
  expect(replacedSettled).toBe(false);

  await act(async () => {
    workerPool.instances.forEach((worker) => worker.flushAll());
    await new Promise((resolve) => setTimeout(resolve, 40));
  });

  const { result: replacedContext, error: replacedError } = await replacedContextPromise;
  expect(replacedError).toBe("");
  expect((replacedContext!.reading as { heading: string }).heading).toBe("Immersive reading");
  expect(host.querySelector(".android-reading")).toBe(existingReading);
  expect(host.querySelector("h1")?.textContent).toBe("Immersive reading");
});

it("hides desktop fullscreen chrome on wheel even before the initial worker analysis mounts .android-reading", async () => {
  document.documentElement.dataset.host = "qt";
  const host = document.createElement("div");
  document.body.append(host);
  root = readerTree.mountRoot!(host);
  await act(async () => {
    root?.render(readerTree.element);
  });

  try {
    await act(async () => {
      window.supermdLoad!({
        id: "desktop-fullscreen-load",
        content: "# Fullscreen note\n\nBody text.\n",
        path: null,
        mode: "reader",
        dark: false,
        fullscreen: true,
        font: "sans",
        size: 18,
        colors: { primary: "#386a57" },
        zoom: 100,
      });
    });

    const loading = host.querySelector(".reader-loading");
    expect(loading).not.toBeNull();
    expect(host.querySelector(".android-reading")).toBeNull();

    await act(async () => {
      loading!.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 120 }));
    });

    expect(native).toHaveBeenCalledWith("reader_chrome", { action: "hide" });
  } finally {
    delete document.documentElement.dataset.host;
  }
});

it("signals reader_ready without pre-spawning a worker and settles android_flush immediately before and during worker analysis", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  root = readerTree.mountRoot!(host);
  await act(async () => {
    root?.render(readerTree.element);
  });

  expect(native).toHaveBeenCalledWith("reader_ready");
  expect(workerPool.instances).toHaveLength(0);

  // An android_flush arriving before the first supermdLoad must fail fast instead of hanging 12s.
  await act(async () => {
    window.supermdFlush!({ action: "android_flush", target: "welcome-id", token: "early-token" });
    await Promise.resolve();
  });
  expect(native).toHaveBeenCalledWith(
    "document_flushed",
    expect.objectContaining({
      id: "welcome-id",
      token: "early-token",
      error: expect.stringContaining("not loaded"),
    }),
  );

  // Once supermdLoad runs, android_flush resolves immediately even while background worker analysis is still pending.
  await act(async () => {
    window.supermdLoad!({
      id: "first-ext",
      editProtocol: 1,
      content: "# First External Open\n\nFirst body.\n",
      path: "content://share/first.md",
      mode: "live",
      dark: false,
      fullscreen: false,
      font: "sans",
      size: 16,
      colors: { primary: "#386a57" },
      zoom: 100,
    });
  });
  expect(workerPool.instances).toHaveLength(1);
  expect(host.querySelector(".android-reading")).toBeNull();

  await act(async () => {
    window.supermdFlush!({ action: "android_flush", target: "first-ext", token: "loaded-token" });
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(native).toHaveBeenCalledWith("document_flushed", {
    id: "first-ext",
    token: "loaded-token",
    content: "# First External Open\n\nFirst body.\n",
  });
});
