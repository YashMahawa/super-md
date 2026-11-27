// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { analyzeDocument, toCompactAnalysis } from "./documentAnalysis";
import type { DocumentAnalysisWorkerRequest, DocumentAnalysisWorkerResponse } from "./documentAnalysis.worker";
import { WORKER_ANALYSIS_MIN_CHARS, sharedDocumentAnalysisClient } from "./documentAnalysisWorker";

function largePadding(phrase: string): string {
  const repeats = Math.ceil((WORKER_ANALYSIS_MIN_CHARS + 2_048) / phrase.length);
  return phrase.repeat(repeats);
}

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

import "./androidReader";

class ResizeObserverMock {
  observe() {}
  disconnect() {}
}
Object.assign(globalThis, { ResizeObserver: ResizeObserverMock });

let root: Root | null = null;

beforeEach(() => {
  sharedDocumentAnalysisClient.reclaimIdle();
  workerPool.instances.length = 0;
  native.mockClear();
  let revision = 0;
  native.mockImplementation(async (command: string) => {
    if (command === "document_sync") {
      revision = 0;
      return { accepted: true, revision: 0 };
    }
    if (command === "document_patch") {
      revision += 1;
      return { accepted: true, revision };
    }
    return null;
  });
  document.body.innerHTML = "";
  document.documentElement.dataset.platform = "android";
  localStorage.clear();
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  workerPool.instances.forEach((worker) => worker.flushAll());
  sharedDocumentAnalysisClient.reclaimIdle();
  delete document.documentElement.dataset.platform;
  delete document.documentElement.dataset.readerOverlay;
  document.body.innerHTML = "";
  localStorage.clear();
});

it("completes small-note reviewed math repair synchronously without spawning a worker (matching StudioUiTest.kt)", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  root = readerTree.mountRoot!(host);
  await act(async () => {
    root?.render(readerTree.element);
  });

  // 1. Load Welcome-like sample note with KaTeX in reader mode (<= 80,000 chars -> synchronous).
  await act(async () => {
    window.supermdLoad!({
      id: "tab-1",
      editProtocol: 1,
      content: "# Welcome\n\nInline $e^{i\\pi}+1=0$ formula.\n",
      path: "tab-1",
      mode: "reader",
      dark: false,
      fullscreen: false,
      font: "Manrope",
      size: 15,
      colors: { primary: "#42669e" },
      zoom: 100,
    });
  });
  expect(workerPool.instances).toHaveLength(0);
  expect(host.querySelectorAll(".katex").length).toBe(1);

  // 2. Replace the note on the same tab id with raw un-delimited TeX in live mode (exact StudioUiTest.kt fixture).
  const original = String.raw`Given \frac{a}{b} = c, continue.`;
  await act(async () => {
    window.supermdLoad!({
      id: "tab-1",
      editProtocol: 1,
      content: original,
      path: "tab-1",
      mode: "live",
      dark: false,
      fullscreen: false,
      font: "Manrope",
      size: 15,
      colors: { primary: "#42669e" },
      zoom: 100,
    });
  });
  expect(workerPool.instances).toHaveLength(0);
  expect(host.querySelector(".markdown-body")).not.toBeNull();
  expect(host.querySelectorAll(".katex").length).toBe(0);

  // 3. Open reviewed math repair panel and apply 1 repair synchronously.
  native.mockClear();
  await act(async () => {
    window.supermdRepairMath!();
  });
  expect(native).toHaveBeenCalledWith("reader_overlay_changed", { open: true, image: false });

  const applyButton = [...host.querySelectorAll("button")].find(
    (btn) => btn.textContent?.trim() === "Apply 1 repair",
  );
  expect(applyButton).toBeDefined();

  await act(async () => {
    applyButton!.click();
  });

  expect(workerPool.instances).toHaveLength(0);
  expect(native).toHaveBeenCalledWith("reader_overlay_changed", { open: false, image: false });
  expect(host.querySelectorAll(".katex").length).toBe(1);

  // 4. Native toolbar Undo and Redo restore original and repaired math synchronously.
  await act(async () => {
    window.supermdHistory!("undo");
  });
  expect(host.querySelectorAll(".katex").length).toBe(0);

  await act(async () => {
    window.supermdHistory!("redo");
  });
  expect(host.querySelectorAll(".katex").length).toBe(1);

  await act(async () => {
    window.supermdFlush!({ action: "android_flush", target: "tab-1", token: "sync-after-redo" });
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(native).toHaveBeenCalledWith("document_flushed", {
    id: "tab-1",
    token: "sync-after-redo",
    content: String.raw`Given $\frac{a}{b} = c$, continue.`,
  });
});

it("unmounts stale KaTeX on large-note replacement, clears repair overlay before worker KaTeX commit, and undoes/redoes reviewed math repairs", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  root = readerTree.mountRoot!(host);
  await act(async () => {
    root?.render(readerTree.element);
  });

  const welcomeLarge = `# Welcome\n\nInline $e^{i\\pi}+1=0$ formula.\n\n${largePadding("Alpha welcome study paragraph. ")}`;
  await act(async () => {
    window.supermdLoad!({
      id: "tab-1",
      editProtocol: 1,
      content: welcomeLarge,
      path: "tab-1",
      mode: "reader",
      dark: false,
      fullscreen: false,
      font: "Manrope",
      size: 15,
      colors: { primary: "#42669e" },
      zoom: 100,
    });
  });
  await act(async () => {
    workerPool.instances.forEach((worker) => worker.flushAll());
  });
  expect(host.querySelectorAll(".katex").length).toBe(1);

  // Replace the note on the same tab id with a large note containing raw un-delimited TeX in live mode.
  const largeSuffix = largePadding("Omega lecture notes paragraph without math. ");
  const original = `${String.raw`Given \frac{a}{b} = c, continue.`}\n\n${largeSuffix}`;
  await act(async () => {
    window.supermdLoad!({
      id: "tab-1",
      editProtocol: 1,
      content: original,
      path: "tab-1",
      mode: "live",
      dark: false,
      fullscreen: false,
      font: "Manrope",
      size: 15,
      colors: { primary: "#42669e" },
      zoom: 100,
    });
  });
  // Stale Welcome KaTeX must be unmounted immediately even before the worker finishes.
  expect(host.querySelectorAll(".katex").length).toBe(0);

  await act(async () => {
    workerPool.instances.forEach((worker) => worker.flushAll());
  });
  expect(host.querySelector(".markdown-body")).not.toBeNull();
  expect(host.querySelectorAll(".katex").length).toBe(0);

  // Open reviewed math repair panel and apply 1 repair.
  native.mockClear();
  await act(async () => {
    window.supermdRepairMath!();
  });
  expect(native).toHaveBeenCalledWith("reader_overlay_changed", { open: true, image: false });

  const applyButton = [...host.querySelectorAll("button")].find(
    (btn) => btn.textContent?.trim() === "Apply 1 repair",
  );
  expect(applyButton).toBeDefined();

  await act(async () => {
    applyButton!.click();
  });

  // reader_overlay_changed({ open: false }) MUST be sent synchronously on Apply click,
  // BEFORE the background worker finishes analyzing and committing the repaired .katex DOM!
  expect(native).toHaveBeenCalledWith("reader_overlay_changed", { open: false, image: false });
  expect(host.querySelectorAll(".katex").length).toBe(0);

  await act(async () => {
    workerPool.instances.forEach((worker) => worker.flushAll());
  });
  expect(host.querySelectorAll(".katex").length).toBe(1);

  // Native toolbar Undo and Redo restore original and repaired math cleanly.
  await act(async () => {
    window.supermdHistory!("undo");
  });
  await act(async () => {
    workerPool.instances.forEach((worker) => worker.flushAll());
  });
  expect(host.querySelectorAll(".katex").length).toBe(0);

  await act(async () => {
    window.supermdHistory!("redo");
  });
  await act(async () => {
    workerPool.instances.forEach((worker) => worker.flushAll());
  });
  expect(host.querySelectorAll(".katex").length).toBe(1);

  // Flush confirms WebView's acknowledged document equals the redone repair.
  await act(async () => {
    window.supermdFlush!({ action: "android_flush", target: "tab-1", token: "after-redo" });
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(native).toHaveBeenCalledWith("document_flushed", {
    id: "tab-1",
    token: "after-redo",
    content: `${String.raw`Given $\frac{a}{b} = c$, continue.`}\n\n${largeSuffix}`,
  });
});
