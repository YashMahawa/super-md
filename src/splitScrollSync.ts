import { readingOffset, revealReadingOffset } from "./readingPosition";
import {
  captureSharedAnchor,
  clearProgrammaticAnchorScroll,
  detectSplitPaneFromTarget,
  isProgrammaticAnchorScroll,
  markProgrammaticAnchorScroll,
  revealEditorOffset,
  type SplitAnchorPane,
} from "./sourceAnchor";

export const SPLIT_SCROLL_SETTLE_MS = 120;

const NESTED_INNER_SCROLLER_SELECTOR = [
  ".markdown-body pre",
  ".python-source",
  ".cell-output pre",
  ".markdown-body table",
  ".step-cards-notes",
  ".step-cards-layout",
  ".katex-display",
  ".mermaid",
].join(",");

export function resolveSplitRootPaneScroller(
  target: EventTarget | null,
): { pane: SplitAnchorPane; scroller: HTMLElement } | null {
  if (!(target instanceof HTMLElement)) return null;
  if (target.classList.contains("cm-scroller")) return { pane: "editor", scroller: target };
  if (target.classList.contains("android-reading")) return { pane: "preview", scroller: target };
  return null;
}

export function isConsumedBySplitInnerScroller(event: Event): boolean {
  const raw = event.target;
  const start = raw instanceof Element ? raw : raw instanceof Node ? raw.parentElement : null;
  if (!start) return false;
  let node: Element | null = start;
  while (node && !node.classList.contains("android-reading") && !node.classList.contains("cm-scroller")) {
    if (node instanceof HTMLElement && !node.matches(".document-page,.document-page-space")) {
      const style = node.ownerDocument.defaultView?.getComputedStyle(node);
      const explicitInner = node.matches(NESTED_INNER_SCROLLER_SELECTOR);
      const styleScrollableX = style ? style.overflowX === "auto" || style.overflowX === "scroll" : false;
      const styleScrollableY = style ? style.overflowY === "auto" || style.overflowY === "scroll" : false;
      if (explicitInner || styleScrollableX || styleScrollableY) {
        const overflowsX = (explicitInner || styleScrollableX) && node.scrollWidth > node.clientWidth + 1;
        const overflowsY =
          (explicitInner || styleScrollableY) &&
          !node.classList.contains("katex-display") &&
          node.scrollHeight > node.clientHeight + 1;
        if (overflowsX || overflowsY) {
          if (typeof WheelEvent !== "undefined" && event instanceof WheelEvent) {
            const dx = event.deltaX || (event.shiftKey ? event.deltaY : 0);
            const dy = event.shiftKey && !event.deltaX ? 0 : event.deltaY;
            if (Math.abs(dx) >= Math.abs(dy) && dx !== 0) {
              if (
                overflowsX &&
                ((dx < 0 && node.scrollLeft > 0) || (dx > 0 && node.scrollLeft + node.clientWidth < node.scrollWidth - 1))
              ) {
                return true;
              }
            } else if (dy !== 0) {
              if (
                overflowsY &&
                ((dy < 0 && node.scrollTop > 0) || (dy > 0 && node.scrollTop + node.clientHeight < node.scrollHeight - 1))
              ) {
                return true;
              }
            }
          } else if (event.type === "pointerdown" || event.type === "touchstart") {
            return true;
          }
        }
      }
    }
    node = node.parentElement;
  }
  return false;
}

export interface SplitScrollStateSnapshot {
  id: string;
  mode: string;
}

export interface SplitScrollSyncControllerOptions {
  getState: () => SplitScrollStateSnapshot | null;
  isRestoring: () => boolean;
  isZooming?: () => boolean;
  onPaneSelected: (pane: SplitAnchorPane) => void;
  settleDelayMs?: number;
  doc?: Document;
}

export interface SplitScrollSyncController {
  handleInput: (event: Event) => void;
  handleScroll: (event: Event) => void;
  notePaneInteraction: (pane: SplitAnchorPane) => void;
  primeScrollTops: (tops: { editor: number | null; preview: number | null }) => void;
  cancelPending: () => void;
  dispose: () => void;
}

export function createSplitScrollSyncController(
  options: SplitScrollSyncControllerOptions,
): SplitScrollSyncController {
  const {
    getState,
    isRestoring,
    isZooming = () => false,
    onPaneSelected,
    settleDelayMs = SPLIT_SCROLL_SETTLE_MS,
    doc = document,
  } = options;

  let recordedTops: { editor: number | null; preview: number | null } = { editor: null, preview: null };
  let suppressedTargets: Record<SplitAnchorPane, { top: number } | null> = {
    editor: null,
    preview: null,
  };
  let settleTimer: ReturnType<typeof setTimeout> | null = null;

  const cancelPending = () => {
    if (settleTimer !== null) {
      clearTimeout(settleTimer);
      settleTimer = null;
    }
  };

  const findPaneScroller = (pane: SplitAnchorPane): HTMLElement | null =>
    doc.querySelector<HTMLElement>(pane === "editor" ? ".cm-scroller" : ".android-reading");

  const notePaneInteraction = (pane: SplitAnchorPane) => {
    if (getState()?.mode !== "split") return;
    suppressedTargets[pane] = null;
    clearProgrammaticAnchorScroll(findPaneScroller(pane));
    onPaneSelected(pane);
  };

  const primeScrollTops = (tops: { editor: number | null; preview: number | null }) => {
    cancelPending();
    recordedTops = { editor: tops.editor, preview: tops.preview };
    suppressedTargets = {
      editor: tops.editor !== null ? { top: tops.editor } : null,
      preview: tops.preview !== null ? { top: tops.preview } : null,
    };
  };

  const hasBlockingSplitOverlay = (): boolean =>
    Boolean(doc.querySelector(".reading-search,.cm-search,.live-active-block"));

  const alignOtherPane = (scheduledTabId: string, sourcePane: SplitAnchorPane) => {
    settleTimer = null;
    const current = getState();
    if (!current || current.id !== scheduledTabId || current.mode !== "split") return;
    if (isRestoring() || isZooming() || hasBlockingSplitOverlay()) return;
    const readingRoot = doc.querySelector<HTMLElement>(".android-reading");
    if (!readingRoot || readingRoot.dataset.navigating === "true") return;

    onPaneSelected(sourcePane);

    if (sourcePane === "editor") {
      const cmScroller = doc.querySelector<HTMLElement>(".cm-scroller");
      const offset =
        cmScroller && cmScroller.clientHeight > 0 && cmScroller.scrollTop <= 1
          ? 0
          : captureSharedAnchor({ id: current.id, mode: "editor", zoom: 100, readingRoot: null }).offset;
      const previousPreviewTop = readingRoot.scrollTop;
      markProgrammaticAnchorScroll(readingRoot);
      revealReadingOffset(readingRoot, offset);
      const nextPreviewTop = readingRoot.scrollTop;
      recordedTops.preview = nextPreviewTop;
      if (Math.abs(nextPreviewTop - previousPreviewTop) > 0.5) {
        suppressedTargets.preview = { top: nextPreviewTop };
      } else {
        suppressedTargets.preview = null;
        clearProgrammaticAnchorScroll(readingRoot);
      }
      return;
    }

    const offset =
      readingRoot.clientHeight > 0 && readingRoot.scrollTop <= 1 ? 0 : readingOffset(readingRoot);
    revealEditorOffset(current.id, offset, { updateSelection: false });
    const cmScroller = doc.querySelector<HTMLElement>(".cm-scroller");
    if (cmScroller) {
      const nextEditorTop = cmScroller.scrollTop;
      recordedTops.editor = nextEditorTop;
      markProgrammaticAnchorScroll(cmScroller);
      suppressedTargets.editor = { top: nextEditorTop };
    }
  };

  const handleInput = (event: Event) => {
    if (getState()?.mode !== "split") return;
    if (isConsumedBySplitInnerScroller(event)) return;
    const pane = detectSplitPaneFromTarget(event.target);
    if (pane) notePaneInteraction(pane);
  };

  const handleScroll = (event: Event) => {
    const current = getState();
    if (!current || current.mode !== "split") return;
    const resolved = resolveSplitRootPaneScroller(event.target);
    if (!resolved) return;
    const { pane, scroller } = resolved;

    if (isRestoring() || isZooming()) {
      recordedTops[pane] = scroller.scrollTop;
      return;
    }

    const readingRoot = pane === "preview" ? scroller : doc.querySelector<HTMLElement>(".android-reading");
    if (readingRoot?.dataset.navigating === "true") {
      recordedTops[pane] = scroller.scrollTop;
      return;
    }

    if (isProgrammaticAnchorScroll(scroller)) {
      recordedTops[pane] = scroller.scrollTop;
      suppressedTargets[pane] = { top: scroller.scrollTop };
      return;
    }

    const suppressed = suppressedTargets[pane];
    if (suppressed) {
      if (Math.abs(scroller.scrollTop - suppressed.top) <= 2) {
        recordedTops[pane] = scroller.scrollTop;
        return;
      }
      suppressedTargets[pane] = null;
    }

    const recorded = recordedTops[pane];
    if (recorded !== null && Math.abs(scroller.scrollTop - recorded) <= 2) return;

    recordedTops[pane] = scroller.scrollTop;
    onPaneSelected(pane);

    if (hasBlockingSplitOverlay()) {
      cancelPending();
      return;
    }

    cancelPending();
    const tabId = current.id;
    settleTimer = setTimeout(() => alignOtherPane(tabId, pane), settleDelayMs);
  };

  const dispose = () => {
    cancelPending();
    suppressedTargets = { editor: null, preview: null };
  };

  return {
    handleInput,
    handleScroll,
    notePaneInteraction,
    primeScrollTops,
    cancelPending,
    dispose,
  };
}
