// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Reader } from "./androidReader";
import Editor, { editorFindRange, editorSelectedText, exportEditorSession } from "./components/Editor";
import {
  registerEditorAnchorAdapter,
  type PendingEditorAnchor,
  type SplitAnchorPane,
} from "./sourceAnchor";
import {
  SPLIT_SCROLL_SETTLE_MS,
  createSplitScrollSyncController,
  isConsumedBySplitInnerScroller,
  resolveSplitRootPaneScroller,
} from "./splitScrollSync";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();

function mockRect(el: Element, top: number, height: number, left = 0, width = 520): void {
  el.getBoundingClientRect = () =>
    ({
      top,
      bottom: top + height,
      left,
      right: left + width,
      width,
      height,
      x: left,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect;
}

describe("native Split view settled scroll alignment", () => {
  let host: HTMLDivElement | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    registerEditorAnchorAdapter("split-note", null);
    host?.remove();
    host = null;
  });

  function buildSplitDom() {
    host = document.createElement("div");
    host.className = "android-document mode-split";
    host.innerHTML = `
      <div class="android-source">
        <div class="cm-editor"><div class="cm-scroller"><div class="cm-content"></div></div></div>
      </div>
      <div class="android-reading">
        <div class="document-page-space">
          <div class="document-page">
            <div class="markdown-body">
              <h2 data-source-start="0" data-source-end="20">Intro</h2>
              <p data-source-start="22" data-source-end="180">Paragraph one</p>
              <pre data-source-start="182" data-source-end="310"><code>wide code block</code></pre>
              <table data-source-start="312" data-source-end="440"><tbody><tr><td>wide cell</td></tr></tbody></table>
              <h2 data-source-start="450" data-source-end="480">Target Section</h2>
              <p data-source-start="482" data-source-end="700">Deep body</p>
            </div>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(host);

    const cmScroller = host.querySelector<HTMLElement>(".cm-scroller")!;
    const readingRoot = host.querySelector<HTMLElement>(".android-reading")!;
    Object.defineProperty(cmScroller, "clientHeight", { value: 400, configurable: true });
    Object.defineProperty(cmScroller, "scrollHeight", { value: 2400, configurable: true });
    Object.defineProperty(readingRoot, "clientHeight", { value: 400, configurable: true });
    Object.defineProperty(readingRoot, "scrollHeight", { value: 2800, configurable: true });
    mockRect(cmScroller, 0, 400);
    mockRect(readingRoot, 0, 400);

    const blocks: Array<[HTMLElement, number, number]> = [
      [readingRoot.querySelectorAll("h2")[0]!, 20, 36],
      [readingRoot.querySelectorAll("p")[0]!, 70, 120],
      [readingRoot.querySelector("pre")!, 210, 90],
      [readingRoot.querySelector("table")!, 320, 90],
      [readingRoot.querySelectorAll("h2")[1]!, 860, 36],
      [readingRoot.querySelectorAll("p")[1]!, 910, 180],
    ];
    for (const [node, baseTop, height] of blocks) {
      node.getBoundingClientRect = () => {
        const top = baseTop - readingRoot.scrollTop;
        return {
          top,
          bottom: top + height,
          left: 16,
          right: 500,
          width: 484,
          height,
          x: 16,
          y: top,
          toJSON: () => ({}),
        } as DOMRect;
      };
    }

    return { cmScroller, readingRoot };
  }

  it("aligns Source -> Preview and Preview -> Source only after scrolling settles without ping-pong feedback", () => {
    const { cmScroller, readingRoot } = buildSplitDom();
    let editorOffset = 0;
    const appliedToEditor: Array<{ anchor: PendingEditorAnchor; focus?: boolean }> = [];

    registerEditorAnchorAdapter("split-note", {
      readingOffset: () => editorOffset,
      caretOffset: () => 48,
      scrollTop: () => cmScroller.scrollTop,
      applyAnchor: (anchor, focus) => {
        appliedToEditor.push({ anchor, focus });
        cmScroller.scrollTop = anchor.offset === 0 ? 0 : Math.round(anchor.offset * 1.4);
      },
    });

    let selectedPane: SplitAnchorPane | null = null;
    const controller = createSplitScrollSyncController({
      getState: () => ({ id: "split-note", mode: "split" }),
      isRestoring: () => false,
      onPaneSelected: (pane) => {
        selectedPane = pane;
      },
    });
    controller.primeScrollTops({ editor: 0, preview: 0 });

    // 1. Continuous Source scroll coalesces until scrolling settles for SPLIT_SCROLL_SETTLE_MS.
    controller.handleInput(new WheelEvent("wheel", { deltaY: 120 }));
    Object.defineProperty(cmScroller, "scrollTop", { value: 240, writable: true, configurable: true });
    editorOffset = 182;
    controller.handleScroll({ target: cmScroller } as unknown as Event);

    vi.advanceTimersByTime(SPLIT_SCROLL_SETTLE_MS - 30);
    expect(readingRoot.scrollTop).toBe(0);

    // Continued scroll resets the settle window.
    cmScroller.scrollTop = 620;
    editorOffset = 450;
    controller.handleScroll({ target: cmScroller } as unknown as Event);
    vi.advanceTimersByTime(SPLIT_SCROLL_SETTLE_MS - 20);
    expect(readingRoot.scrollTop).toBe(0);

    // Once settled, Preview aligns to Target Section (baseTop 860 - gap 16 = 844).
    vi.advanceTimersByTime(25);
    expect(readingRoot.scrollTop).toBe(844);
    expect(selectedPane).toBe("editor");

    // Browser fires async scroll event for Preview's programmatic scrollTop change:
    // must NOT bounce back into Editor or flip selectedPane!
    controller.handleScroll({ target: readingRoot } as unknown as Event);
    vi.advanceTimersByTime(SPLIT_SCROLL_SETTLE_MS * 3);
    expect(appliedToEditor).toHaveLength(0);
    expect(selectedPane).toBe("editor");

    // 2. Deliberate scroll in the opposite direction (Preview -> Source) clears suppression and aligns Editor.
    const wheelOnPreview = new WheelEvent("wheel", { deltaY: -200, bubbles: true });
    Object.defineProperty(wheelOnPreview, "target", { value: readingRoot });
    controller.handleInput(wheelOnPreview);
    expect(selectedPane).toBe("preview");

    readingRoot.scrollTop = 310; // Top of viewport sits at table (sourceStart 312).
    controller.handleScroll({ target: readingRoot } as unknown as Event);
    vi.advanceTimersByTime(SPLIT_SCROLL_SETTLE_MS - 10);
    expect(appliedToEditor).toHaveLength(0);

    vi.advanceTimersByTime(15);
    expect(appliedToEditor).toHaveLength(1);
    expect(appliedToEditor[0].anchor).toEqual({
      offset: 312,
      caretOffset: undefined,
      top: undefined,
      updateSelection: false,
    });
    expect(appliedToEditor[0].focus).toBeUndefined();
    expect(cmScroller.scrollTop).toBe(Math.round(312 * 1.4));
    expect(selectedPane).toBe("preview");

    // Programmatic scroll echo from Editor does NOT bounce back to Preview.
    const previewTopAfterReverse = readingRoot.scrollTop;
    controller.handleScroll({ target: cmScroller } as unknown as Event);
    vi.advanceTimersByTime(SPLIT_SCROLL_SETTLE_MS * 3);
    expect(readingRoot.scrollTop).toBe(previewTopAfterReverse);
    expect(selectedPane).toBe("preview");

    controller.dispose();
  });

  it("cancels a queued source-pane sync when focus or pointer interaction selects the opposing pane before settle", () => {
    const { cmScroller, readingRoot } = buildSplitDom();
    const cmContent = cmScroller.querySelector<HTMLElement>(".cm-content")!;
    let editorOffset = 0;
    const appliedToEditor: Array<{ anchor: PendingEditorAnchor; focus?: boolean }> = [];

    registerEditorAnchorAdapter("split-note", {
      readingOffset: () => editorOffset,
      caretOffset: () => 48,
      scrollTop: () => cmScroller.scrollTop,
      applyAnchor: (anchor, focus) => {
        appliedToEditor.push({ anchor, focus });
        cmScroller.scrollTop = anchor.offset === 0 ? 0 : Math.round(anchor.offset * 1.4);
      },
    });

    const selectedHistory: SplitAnchorPane[] = [];
    const controller = createSplitScrollSyncController({
      getState: () => ({ id: "split-note", mode: "split" }),
      isRestoring: () => false,
      onPaneSelected: (pane) => {
        selectedHistory.push(pane);
      },
    });
    Object.defineProperty(cmScroller, "scrollTop", { value: 180, writable: true, configurable: true });
    Object.defineProperty(readingRoot, "scrollTop", { value: 0, writable: true, configurable: true });
    controller.primeScrollTops({ editor: 180, preview: 0 });

    // 1. Real preview scroll queues Preview -> Source sync, then editor focus selects editor before settle:
    // must NOT flip selection back to preview (preview -> editor -> preview) or move editor viewport.
    readingRoot.scrollTop = 310;
    controller.handleScroll({ target: readingRoot } as unknown as Event);
    expect(selectedHistory).toEqual(["preview"]);

    vi.advanceTimersByTime(SPLIT_SCROLL_SETTLE_MS - 40);
    const focusEditor = new FocusEvent("focusin", { bubbles: true });
    Object.defineProperty(focusEditor, "target", { value: cmContent });
    controller.handleInput(focusEditor);
    expect(selectedHistory).toEqual(["preview", "editor"]);

    vi.advanceTimersByTime(SPLIT_SCROLL_SETTLE_MS * 3);
    expect(selectedHistory).toEqual(["preview", "editor"]);
    expect(appliedToEditor).toHaveLength(0);
    expect(cmScroller.scrollTop).toBe(180);

    // 2. Real editor scroll queues Source -> Preview sync, then pointerdown on preview selects preview before settle:
    // must NOT flip selection back to editor or overwrite preview scrollTop.
    cmScroller.scrollTop = 620;
    editorOffset = 450;
    controller.handleScroll({ target: cmScroller } as unknown as Event);
    expect(selectedHistory).toEqual(["preview", "editor", "editor"]);

    vi.advanceTimersByTime(SPLIT_SCROLL_SETTLE_MS - 35);
    const pointerPreview = new Event("pointerdown", { bubbles: true });
    Object.defineProperty(pointerPreview, "target", { value: readingRoot });
    controller.handleInput(pointerPreview);
    expect(selectedHistory).toEqual(["preview", "editor", "editor", "preview"]);

    vi.advanceTimersByTime(SPLIT_SCROLL_SETTLE_MS * 3);
    expect(selectedHistory).toEqual(["preview", "editor", "editor", "preview"]);
    expect(readingRoot.scrollTop).toBe(310);

    // 3. Subsequent uncancelled preview scroll still aligns editor cleanly after settle.
    readingRoot.scrollTop = 844;
    controller.handleScroll({ target: readingRoot } as unknown as Event);
    vi.advanceTimersByTime(SPLIT_SCROLL_SETTLE_MS + 10);
    expect(appliedToEditor).toHaveLength(1);
    expect(appliedToEditor[0].anchor.offset).toBe(450);
    expect(selectedHistory.at(-1)).toBe("preview");

    controller.dispose();
  });

  it("suppresses delayed editor scroll echoes when CodeMirror refines scrollTop on the next animation frame", () => {
    const { cmScroller, readingRoot } = buildSplitDom();
    Object.defineProperty(cmScroller, "scrollTop", { value: 0, writable: true, configurable: true });
    Object.defineProperty(readingRoot, "scrollTop", { value: 0, writable: true, configurable: true });

    registerEditorAnchorAdapter("split-note", {
      readingOffset: () => 450,
      caretOffset: () => undefined,
      scrollTop: () => cmScroller.scrollTop,
      applyAnchor: () => {
        // First synchronous pass uses estimated wrapped height; follow-up rAF refines scrollTop.
        cmScroller.scrollTop = 520;
        window.requestAnimationFrame(() => {
          cmScroller.scrollTop = 695;
        });
      },
    });

    let selectedPane: SplitAnchorPane | null = null;
    const controller = createSplitScrollSyncController({
      getState: () => ({ id: "split-note", mode: "split" }),
      isRestoring: () => false,
      onPaneSelected: (pane) => {
        selectedPane = pane;
      },
    });
    controller.primeScrollTops({ editor: 0, preview: 0 });

    const wheelOnPreview = new WheelEvent("wheel", { deltaY: 240, bubbles: true });
    Object.defineProperty(wheelOnPreview, "target", { value: readingRoot });
    controller.handleInput(wheelOnPreview);
    readingRoot.scrollTop = 844;
    controller.handleScroll({ target: readingRoot } as unknown as Event);

    // Advance past settle + rAF refinement, then stall > 220ms before the browser delivers cmScroller's scroll event.
    vi.advanceTimersByTime(SPLIT_SCROLL_SETTLE_MS + 320);
    expect(cmScroller.scrollTop).toBe(695);

    const previewTopBeforeEcho = readingRoot.scrollTop;
    controller.handleScroll({ target: cmScroller } as unknown as Event);
    vi.advanceTimersByTime(SPLIT_SCROLL_SETTLE_MS * 3);
    expect(selectedPane).toBe("preview");
    expect(readingRoot.scrollTop).toBe(previewTopBeforeEcho);

    controller.dispose();
  });

  it("ignores independent inner scrollers (<pre>, <table>) while allowing chained root scrolling", () => {
    const { cmScroller, readingRoot } = buildSplitDom();
    const pre = readingRoot.querySelector<HTMLElement>("pre")!;
    const table = readingRoot.querySelector<HTMLElement>("table")!;

    // Make <pre> overflow both horizontally and vertically, and <table> overflow horizontally only.
    Object.defineProperty(pre, "clientWidth", { value: 300, configurable: true });
    Object.defineProperty(pre, "scrollWidth", { value: 900, configurable: true });
    Object.defineProperty(pre, "clientHeight", { value: 120, configurable: true });
    Object.defineProperty(pre, "scrollHeight", { value: 420, configurable: true });

    Object.defineProperty(table, "clientWidth", { value: 300, configurable: true });
    Object.defineProperty(table, "scrollWidth", { value: 860, configurable: true });
    Object.defineProperty(table, "clientHeight", { value: 90, configurable: true });
    Object.defineProperty(table, "scrollHeight", { value: 90, configurable: true });

    expect(resolveSplitRootPaneScroller(pre)).toBeNull();
    expect(resolveSplitRootPaneScroller(table)).toBeNull();
    expect(resolveSplitRootPaneScroller(cmScroller)?.pane).toBe("editor");
    expect(resolveSplitRootPaneScroller(readingRoot)?.pane).toBe("preview");

    const appliedOffsets: number[] = [];
    registerEditorAnchorAdapter("split-note", {
      readingOffset: () => 0,
      caretOffset: () => undefined,
      scrollTop: () => cmScroller.scrollTop,
      applyAnchor: (anchor) => {
        appliedOffsets.push(anchor.offset);
      },
    });

    let selectedPane: SplitAnchorPane | null = "editor";
    const controller = createSplitScrollSyncController({
      getState: () => ({ id: "split-note", mode: "split" }),
      isRestoring: () => false,
      onPaneSelected: (pane) => {
        selectedPane = pane;
      },
    });
    controller.primeScrollTops({ editor: 0, preview: 0 });

    // Horizontal wheel & scroll on <table> and vertical wheel & scroll inside <pre> stay independent.
    const hWheelTable = new WheelEvent("wheel", { deltaX: 80, deltaY: 0 });
    Object.defineProperty(hWheelTable, "target", { value: table });
    expect(isConsumedBySplitInnerScroller(hWheelTable)).toBe(true);
    controller.handleInput(hWheelTable);
    table.scrollLeft = 140;
    controller.handleScroll({ target: table } as unknown as Event);

    const vWheelPre = new WheelEvent("wheel", { deltaX: 0, deltaY: 60 });
    Object.defineProperty(vWheelPre, "target", { value: pre });
    expect(isConsumedBySplitInnerScroller(vWheelPre)).toBe(true);
    controller.handleInput(vWheelPre);
    pre.scrollTop = 90;
    controller.handleScroll({ target: pre } as unknown as Event);

    vi.advanceTimersByTime(SPLIT_SCROLL_SETTLE_MS * 3);
    expect(appliedOffsets).toHaveLength(0);
    expect(selectedPane).toBe("editor");
    expect(table.scrollLeft).toBe(140);
    expect(pre.scrollTop).toBe(90);

    // Vertical wheel over horizontally-only overflowing <table> is NOT consumed by <table>, so root scroll works.
    const vWheelTable = new WheelEvent("wheel", { deltaX: 0, deltaY: 140 });
    Object.defineProperty(vWheelTable, "target", { value: table });
    expect(isConsumedBySplitInnerScroller(vWheelTable)).toBe(false);
    controller.handleInput(vWheelTable);
    expect(selectedPane).toBe("preview");

    controller.dispose();
  });

  it("preserves CodeMirror caret and range selection when Preview scrolling aligns Source", () => {
    host = document.createElement("div");
    host.className = "android-document mode-split";
    const editorContainer = document.createElement("div");
    editorContainer.className = "android-source";
    const readingRoot = document.createElement("div");
    readingRoot.className = "android-reading";
    readingRoot.innerHTML = `<div class="markdown-body"><h2 data-source-start="420" data-source-end="450">Section 10</h2></div>`;
    host.append(editorContainer, readingRoot);
    document.body.appendChild(host);

    Object.defineProperty(readingRoot, "clientHeight", { value: 360, configurable: true });
    Object.defineProperty(readingRoot, "scrollHeight", { value: 2200, configurable: true });
    mockRect(readingRoot, 0, 360);
    const heading = readingRoot.querySelector<HTMLElement>("h2")!;
    mockRect(heading, 20, 34);

    const markdown = Array.from({ length: 30 }, (_, idx) => `## Section ${idx + 1}\n\nLine body for section ${idx + 1}.`).join("\n\n");
    const root = createRoot(editorContainer);
    act(() => {
      root.render(
        <Editor
          sessionId="caret-split-note"
          value={markdown}
          onChange={() => {}}
          dark={false}
          focusMode={false}
        />,
      );
    });

    // Place a non-empty selection near the start of the document via CodeMirror session.
    const cmContent = editorContainer.querySelector<HTMLElement>(".cm-content")!;
    expect(cmContent).toBeTruthy();
    editorFindRange("caret-split-note", 3, 12);
    expect(editorSelectedText("caret-split-note")).toBe("Section 1");
    const exportedBefore = exportEditorSession("caret-split-note")!;
    expect(exportedBefore).toBeDefined();

    const controller = createSplitScrollSyncController({
      getState: () => ({ id: "caret-split-note", mode: "split" }),
      isRestoring: () => false,
      onPaneSelected: () => {},
    });
    controller.primeScrollTops({ editor: 0, preview: 0 });

    const wheel = new WheelEvent("wheel", { deltaY: 220 });
    Object.defineProperty(wheel, "target", { value: readingRoot });
    controller.handleInput(wheel);
    readingRoot.scrollTop = 640;
    controller.handleScroll({ target: readingRoot } as unknown as Event);

    act(() => {
      vi.advanceTimersByTime(SPLIT_SCROLL_SETTLE_MS + 20);
    });

    const exportedAfter = exportEditorSession("caret-split-note")!;
    expect(editorSelectedText("caret-split-note")).toBe("Section 1");
    expect((exportedAfter.state as { selection: unknown }).selection).toEqual(
      (exportedBefore.state as { selection: unknown }).selection,
    );
    expect(document.activeElement).not.toBe(cmContent);

    controller.dispose();
    act(() => root.unmount());
  });

  it("preserves exact tab restoration in native <Reader /> Split view without firing a settle sync", async () => {
    vi.useRealTimers();
    host = document.createElement("div");
    document.body.appendChild(host);

    (window as Window & { SuperMD?: unknown }).SuperMD = {
      post(id: string) {
        queueMicrotask(() => window.supermdReply?.(id, true, null));
      },
    };

    const root = createRoot(host);
    await act(async () => {
      root.render(<Reader />);
    });

    const noteA = Array.from({ length: 40 }, (_, i) => `## Section ${i + 1}\n\nContent paragraph ${i + 1}.`).join("\n\n");
    const noteB = "# Short Note B\n\nHello.";
    const base = {
      dark: false,
      fullscreen: false,
      colors: { surface: "#ffffff", text: "#111111", muted: "#666666", outline: "#dddddd", primary: "#3366cc" },
      font: "Manrope",
      size: 16,
      zoom: 100,
      motion: false,
    };

    await act(async () => {
      window.supermdLoad?.({
        ...base,
        id: "tab-a",
        path: null,
        content: noteA,
        mode: "split",
        viewState: {
          top: 910,
          anchor: { offset: 340, mode: "split", zoom: 100, editorTop: 425, readingTop: 910 },
        },
      });
    });

    const cmScroller = host.querySelector<HTMLElement>(".cm-scroller")!;
    const readingRoot = host.querySelector<HTMLElement>(".android-reading")!;
    Object.defineProperty(cmScroller, "clientHeight", { value: 400, configurable: true });
    Object.defineProperty(cmScroller, "scrollHeight", { value: 2600, configurable: true });
    Object.defineProperty(readingRoot, "clientHeight", { value: 400, configurable: true });
    Object.defineProperty(readingRoot, "scrollHeight", { value: 3200, configurable: true });

    // Allow initial restore and any settle timers (> 200ms) to run:
    // exact distinct editorTop (425) and readingTop (910) must NOT overwrite each other!
    cmScroller.dispatchEvent(new Event("scroll"));
    readingRoot.dispatchEvent(new Event("scroll"));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, SPLIT_SCROLL_SETTLE_MS + 90));
    });
    expect(cmScroller.scrollTop).toBe(425);
    expect(readingRoot.scrollTop).toBe(910);

    // Switch to Tab B and back to Tab A in Split: exact editorTop & readingTop stay preserved.
    await act(async () => {
      window.supermdLoad?.({ ...base, id: "tab-b", path: null, content: noteB, mode: "split" });
    });
    await act(async () => {
      window.supermdLoad?.({ ...base, id: "tab-a", path: null, content: noteA, mode: "split" });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, SPLIT_SCROLL_SETTLE_MS + 90));
    });

    const restoredCm = host.querySelector<HTMLElement>(".cm-scroller")!;
    const restoredReading = host.querySelector<HTMLElement>(".android-reading")!;
    expect(restoredCm.scrollTop).toBe(425);
    expect(restoredReading.scrollTop).toBe(910);

    await act(async () => {
      root.unmount();
    });
    delete (window as Window & { SuperMD?: unknown }).SuperMD;
  });
});
