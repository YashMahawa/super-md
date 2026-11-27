import { refreshDocumentExtent, shiftDocumentOriginY } from "./documentZoom";

export interface VerticalBandRect {
  top: number;
  bottom: number;
}

interface ClearanceEntry {
  targetEl: HTMLElement;
  prop: "margin-bottom" | "padding-top";
  inlineValue: string;
  basePx: number;
  appliedPx: number;
}

const activeClearances = new Map<HTMLElement, ClearanceEntry>();

const SEARCH_TOP_MARGIN = 12;
const SEARCH_BOTTOM_MARGIN = 16;

export function resolveSearchScroller(target?: Element | null, host?: Element | null): HTMLElement | null {
  return (
    target?.closest<HTMLElement>(".android-reading,.reading-scroll,.cm-scroller") ??
    (host?.matches(".android-reading,.reading-scroll,.cm-scroller")
      ? (host as HTMLElement)
      : host?.closest<HTMLElement>(".android-reading,.reading-scroll,.cm-scroller") ?? null)
  );
}

function unobstructedBand(scroller: HTMLElement): { scrollerRect: DOMRect; visibleTop: number; visibleBottom: number } | null {
  const scrollerRect = scroller.getBoundingClientRect();
  if (scrollerRect.width <= 0 && scrollerRect.height <= 0) return null;
  const scope = scroller.closest(".android-document,.workspace") ?? scroller.ownerDocument;
  const searchBar = scope.querySelector<HTMLElement>(".reading-search");
  let visibleTop = scrollerRect.top + SEARCH_TOP_MARGIN;
  if (searchBar) {
    const searchRect = searchBar.getBoundingClientRect();
    const overlapsHorizontally = searchRect.width <= 0 || (searchRect.right > scrollerRect.left && searchRect.left < scrollerRect.right);
    if (searchRect.height > 0 && overlapsHorizontally && searchRect.bottom > scrollerRect.top) {
      visibleTop = Math.max(visibleTop, searchRect.bottom + SEARCH_TOP_MARGIN);
    }
  }
  const clampedTop = Math.min(visibleTop, Math.max(scrollerRect.top, scrollerRect.bottom - 24));
  const visibleBottom = Math.max(clampedTop + 20, scrollerRect.bottom - SEARCH_BOTTOM_MARGIN);
  return { scrollerRect, visibleTop: clampedTop, visibleBottom };
}

function resolveClearanceTarget(scroller: HTMLElement): { targetEl: HTMLElement; prop: "margin-bottom" | "padding-top" } {
  const spacer = scroller.querySelector<HTMLElement>(":scope > .reader-chrome-spacer");
  if (spacer) return { targetEl: spacer, prop: "margin-bottom" };
  return { targetEl: scroller, prop: "padding-top" };
}

function setSearchTopClearance(scroller: HTMLElement, nextPx: number): void {
  const clampedNext = Math.max(0, Math.ceil(nextPx));
  let entry = activeClearances.get(scroller);
  if (!entry) {
    if (clampedNext === 0 || !scroller.isConnected) return;
    const { targetEl, prop } = resolveClearanceTarget(scroller);
    const computed =
      typeof getComputedStyle === "function" ? parseFloat(getComputedStyle(targetEl).getPropertyValue(prop) || "0") : 0;
    entry = {
      targetEl,
      prop,
      inlineValue: targetEl.style.getPropertyValue(prop),
      basePx: Number.isFinite(computed) ? computed : 0,
      appliedPx: 0,
    };
    activeClearances.set(scroller, entry);
  }
  const delta = clampedNext - entry.appliedPx;
  if (delta === 0) return;
  entry.appliedPx = clampedNext;
  if (clampedNext === 0) {
    if (entry.inlineValue) entry.targetEl.style.setProperty(entry.prop, entry.inlineValue);
    else entry.targetEl.style.removeProperty(entry.prop);
    activeClearances.delete(scroller);
  } else {
    entry.targetEl.style.setProperty(entry.prop, `${entry.basePx + clampedNext}px`);
  }
  if (scroller.isConnected && scroller.matches(".android-reading")) {
    shiftDocumentOriginY(scroller, delta);
    refreshDocumentExtent(scroller);
  }
}

function releaseScrollerTopClearance(scroller: HTMLElement): void {
  const entry = activeClearances.get(scroller);
  if (!entry || entry.appliedPx <= 0) return;
  const applied = entry.appliedPx;
  const prevScrollTop = scroller.scrollTop;
  setSearchTopClearance(scroller, 0);
  scroller.scrollTop = prevScrollTop > applied ? prevScrollTop - applied : 0;
}

export function clearSearchTopClearances(): void {
  for (const scroller of Array.from(activeClearances.keys())) {
    releaseScrollerTopClearance(scroller);
  }
  activeClearances.clear();
}

function isVerticallyScrollableElement(el: HTMLElement): boolean {
  if (el.scrollHeight <= el.clientHeight + 1) return false;
  const inlineY = el.style.overflowY || el.style.overflow;
  if (inlineY === "auto" || inlineY === "scroll" || inlineY === "overlay") return true;
  if (typeof getComputedStyle === "function") {
    const oy = getComputedStyle(el).overflowY;
    if (oy === "auto" || oy === "scroll" || oy === "overlay") return true;
  }
  return false;
}

function scrollNestedScrollables(
  anchorEl: Element | null,
  scroller: HTMLElement,
  range: Range | null,
  mode: "center" | "ensure-visible",
): void {
  for (let cur = anchorEl; cur && cur !== scroller; cur = cur.parentElement) {
    if (!(cur instanceof HTMLElement) || !isVerticallyScrollableElement(cur)) continue;
    const curRect = cur.getBoundingClientRect();
    if (curRect.height <= 0) continue;
    const matchRect = readRangeOrElementRect(range, cur === anchorEl ? null : anchorEl);
    if (!matchRect) continue;
    const matchHeight = Math.max(0, matchRect.bottom - matchRect.top);
    const pad = Math.min(12, curRect.height * 0.15);
    const innerTop = curRect.top + pad;
    const innerBottom = Math.max(innerTop + 8, curRect.bottom - pad);
    const innerBand = Math.max(1, innerBottom - innerTop);
    if (mode === "ensure-visible" && matchRect.top >= innerTop && (matchRect.bottom <= innerBottom || matchHeight >= innerBand)) {
      continue;
    }
    const desiredInnerTop =
      matchHeight >= innerBand
        ? innerTop
        : mode === "ensure-visible"
          ? matchRect.top < innerTop
            ? innerTop
            : innerBottom - matchHeight
          : curRect.top + (curRect.height - matchHeight) / 2;
    const maxScroll = Math.max(0, cur.scrollHeight - cur.clientHeight);
    cur.scrollTop = Math.max(0, Math.min(maxScroll, cur.scrollTop + (matchRect.top - desiredInnerTop)));
  }
}

export function readRangeOrElementRect(
  range: Range | null | undefined,
  target: Element | null | undefined,
  maxFallbackSliceHeight?: number,
  proportionalOffset?: number,
): VerticalBandRect | null {
  if (range) {
    if (typeof range.getClientRects === "function") {
      const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 || r.height > 0);
      if (rects.length > 0) {
        let top = Infinity;
        let bottom = -Infinity;
        for (const r of rects) {
          if (r.top < top) top = r.top;
          if (r.bottom > bottom) bottom = r.bottom;
        }
        if (Number.isFinite(top) && Number.isFinite(bottom)) return { top, bottom };
      }
    }
    if (typeof range.getBoundingClientRect === "function") {
      const rect = range.getBoundingClientRect();
      if (rect.width > 0 || rect.height > 0) return { top: rect.top, bottom: rect.bottom };
    }
  }
  if (!target || typeof target.getBoundingClientRect !== "function") return null;
  const targetRect = target.getBoundingClientRect();
  if (targetRect.width <= 0 && targetRect.height <= 0) return null;
  if (maxFallbackSliceHeight && targetRect.height > maxFallbackSliceHeight) {
    const slice = Math.min(32, maxFallbackSliceHeight);
    const ratio = proportionalOffset !== undefined && Number.isFinite(proportionalOffset) ? Math.max(0, Math.min(1, proportionalOffset)) : 0;
    const top = targetRect.top + Math.max(0, targetRect.height - slice) * ratio;
    return { top, bottom: top + slice };
  }
  return { top: targetRect.top, bottom: targetRect.bottom };
}

export function scrollRectIntoSearchScroller(
  scroller: HTMLElement,
  initialRect: VerticalBandRect,
  resolveLiveRect?: () => VerticalBandRect | null,
  mode: "center" | "ensure-visible" = "center",
): void {
  if (scroller.matches(".android-reading")) refreshDocumentExtent(scroller);
  const band = unobstructedBand(scroller);
  if (!band) return;
  const { scrollerRect, visibleTop, visibleBottom } = band;
  const bandHeight = Math.max(1, visibleBottom - visibleTop);
  let rect = resolveLiveRect?.() ?? initialRect;
  let matchHeight = Math.max(0, rect.bottom - rect.top);

  if (mode === "ensure-visible" && rect.top >= visibleTop && (rect.bottom <= visibleBottom || matchHeight >= bandHeight)) {
    return;
  }

  const existingApplied = activeClearances.get(scroller)?.appliedPx ?? 0;
  if (existingApplied > 0) {
    const unpaddedZeroTop = rect.top + scroller.scrollTop - existingApplied;
    if (unpaddedZeroTop >= visibleTop) {
      releaseScrollerTopClearance(scroller);
      rect = resolveLiveRect?.() ?? {
        top: unpaddedZeroTop - scroller.scrollTop,
        bottom: unpaddedZeroTop - scroller.scrollTop + matchHeight,
      };
      matchHeight = Math.max(0, rect.bottom - rect.top);
    }
  }

  let desiredTop: number;
  if (matchHeight >= bandHeight) {
    desiredTop = visibleTop;
  } else if (mode === "ensure-visible") {
    desiredTop = rect.top < visibleTop ? visibleTop : visibleBottom - matchHeight;
  } else {
    const naturalCenterTop = scrollerRect.top + (scrollerRect.height - matchHeight) / 2;
    desiredTop = Math.max(visibleTop, Math.min(visibleBottom - matchHeight, naturalCenterTop));
  }

  const prevScrollTop = scroller.scrollTop;
  const targetScrollTop = prevScrollTop + (rect.top - desiredTop);

  if (targetScrollTop < 0) {
    if (prevScrollTop !== 0) scroller.scrollTop = 0;
    if (scroller.matches(".android-reading")) refreshDocumentExtent(scroller);
    const currentApplied = activeClearances.get(scroller)?.appliedPx ?? 0;
    const atZero = resolveLiveRect?.() ?? { top: rect.top + prevScrollTop, bottom: rect.bottom + prevScrollTop };
    const unpaddedTop = atZero.top - currentApplied;
    if (unpaddedTop < visibleTop) {
      setSearchTopClearance(scroller, visibleTop - unpaddedTop);
      scroller.scrollTop = 0;
    } else if (currentApplied > 0) {
      setSearchTopClearance(scroller, 0);
      scroller.scrollTop = 0;
    }
    return;
  }

  if (
    Math.abs(targetScrollTop - prevScrollTop) <= 0.5 &&
    rect.top >= visibleTop - 1 &&
    (rect.bottom <= visibleBottom + 1 || matchHeight >= bandHeight)
  ) {
    return;
  }

  scroller.scrollTop = targetScrollTop;
  if (scroller.matches(".android-reading")) refreshDocumentExtent(scroller);
  if (resolveLiveRect) {
    const after = resolveLiveRect();
    if (after) {
      const afterHeight = Math.max(0, after.bottom - after.top);
      if (after.top < visibleTop) {
        const nextTop = scroller.scrollTop + (after.top - visibleTop);
        if (nextTop < 0) {
          const cur = scroller.scrollTop;
          scroller.scrollTop = 0;
          const currentApplied = activeClearances.get(scroller)?.appliedPx ?? 0;
          const zeroRect = resolveLiveRect() ?? { top: after.top + cur, bottom: after.bottom + cur };
          const unpaddedTop = zeroRect.top - currentApplied;
          if (unpaddedTop < visibleTop) {
            setSearchTopClearance(scroller, visibleTop - unpaddedTop);
            scroller.scrollTop = 0;
          }
        } else {
          scroller.scrollTop = nextTop;
        }
      } else if (afterHeight < bandHeight && after.bottom > visibleBottom) {
        scroller.scrollTop += after.bottom - visibleBottom;
      }
    }
  }
}

export function isSearchMatchInUnobstructedBand(options: {
  range?: Range | null;
  target?: Element | null;
  host?: Element | null;
  proportionalOffset?: number;
}): boolean {
  const { range = null, target = null, host = null, proportionalOffset } = options;
  const anchorEl =
    target ??
    (range
      ? range.startContainer.nodeType === Node.ELEMENT_NODE
        ? (range.startContainer as Element)
        : range.startContainer.parentElement
      : null);
  if (anchorEl?.closest('[data-windowed-mounted="false"]')) return false;
  const scroller = resolveSearchScroller(anchorEl, host);
  if (!scroller) return true;
  if (scroller.matches(".android-reading")) refreshDocumentExtent(scroller);
  const band = unobstructedBand(scroller);
  if (!band) return true;
  for (let cur = anchorEl; cur && cur !== scroller; cur = cur.parentElement) {
    if (!(cur instanceof HTMLElement) || !isVerticallyScrollableElement(cur)) continue;
    const curRect = cur.getBoundingClientRect();
    if (curRect.height <= 0) continue;
    const innerRect = readRangeOrElementRect(range, cur === anchorEl ? null : anchorEl);
    if (!innerRect) continue;
    const innerHeight = Math.max(0, innerRect.bottom - innerRect.top);
    const pad = Math.min(12, curRect.height * 0.15);
    const innerTop = curRect.top + pad;
    const innerBottom = Math.max(innerTop + 8, curRect.bottom - pad);
    const innerBand = Math.max(1, innerBottom - innerTop);
    if (innerRect.top < innerTop - 1 || (innerHeight < innerBand && innerRect.bottom > innerBottom + 1)) {
      return false;
    }
  }
  const bandHeight = Math.max(1, band.visibleBottom - band.visibleTop);
  const rect = readRangeOrElementRect(range, anchorEl, bandHeight, proportionalOffset);
  if (!rect) return false;
  const matchHeight = Math.max(0, rect.bottom - rect.top);
  return rect.top >= band.visibleTop - 1 && (rect.bottom <= band.visibleBottom + 1 || matchHeight >= bandHeight);
}

export function scrollSearchMatchIntoView(options: {
  range?: Range | null;
  target?: Element | null;
  host?: Element | null;
  proportionalOffset?: number;
  mode?: "center" | "ensure-visible";
}): void {
  const { range = null, target = null, host = null, proportionalOffset, mode = "center" } = options;
  const anchorEl =
    target ??
    (range
      ? range.startContainer.nodeType === Node.ELEMENT_NODE
        ? (range.startContainer as Element)
        : range.startContainer.parentElement
      : null);
  const scroller = resolveSearchScroller(anchorEl, host);
  if (scroller) scrollNestedScrollables(anchorEl, scroller, range, mode);
  if (scroller?.matches(".android-reading")) refreshDocumentExtent(scroller);
  const band = scroller ? unobstructedBand(scroller) : null;
  if (!scroller || !band) {
    if (mode === "center") anchorEl?.scrollIntoView?.({ block: "center", behavior: "instant" });
    return;
  }
  const bandHeight = Math.max(1, band.visibleBottom - band.visibleTop);
  const readRect = () => readRangeOrElementRect(range, anchorEl, bandHeight, proportionalOffset);
  const initialRect = readRect();
  if (!initialRect) {
    if (mode === "center") anchorEl?.scrollIntoView?.({ block: "center", behavior: "instant" });
    return;
  }
  scrollRectIntoSearchScroller(scroller, initialRect, readRect, mode);
}

const MANUAL_SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);
const SEARCH_SETTLE_WINDOW_MS = 1600;
const SEARCH_SETTLE_MAX_MS = 3200;

export interface SearchSettleHandle {
  stop: () => void;
  recordScrollerState: () => void;
}

export function startSearchSettle(
  anchorHost: Element | null,
  step: (verifyOnly?: boolean) => boolean | "realigned",
  onStop?: () => void,
): SearchSettleHandle | null {
  const scroller = anchorHost?.matches(".android-reading,.reading-scroll")
    ? (anchorHost as HTMLElement)
    : anchorHost?.closest<HTMLElement>(".android-reading,.reading-scroll") ??
      document.querySelector<HTMLElement>(".android-reading,.reading-scroll");
  const eventHost = scroller ?? anchorHost;
  if (!eventHost) return null;
  let active = true, frame = 0, timer = 0, remainingFrames = 4, verifyFrames = 2, adjustGuard = 8;
  let dirtyLayout = false, layoutMutating = false, mutatingQueued = false;
  const nowMs = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
  const startedAt = nowMs();
  let recordedScrollTop = scroller?.scrollTop ?? 0, recordedScrollHeight = scroller?.scrollHeight ?? 0;
  const recordScrollerState = () => {
    if (scroller) { recordedScrollTop = scroller.scrollTop; recordedScrollHeight = scroller.scrollHeight; }
  };
  const inSearchUi = (target: EventTarget | null) => target instanceof Element && Boolean(target.closest(".reading-search"));
  const stop = () => {
    if (!active) return;
    active = false; cancelAnimationFrame(frame); frame = 0;
    window.clearTimeout(timer); observer?.disconnect();
    eventHost.removeEventListener("supermd-window-change", onWindowChange);
    scroller?.removeEventListener("scroll", onScroll);
    window.removeEventListener("wheel", onUserGesture, { capture: true });
    window.removeEventListener("touchstart", onUserGesture, { capture: true });
    window.removeEventListener("touchmove", onUserGesture, { capture: true });
    window.removeEventListener("pointerdown", onUserGesture, { capture: true });
    window.removeEventListener("keydown", onKeyDown, { capture: true });
    window.removeEventListener("supermd-goto-offset", stop);
    onStop?.();
  };
  const armStopTimer = () => {
    if (!active) return;
    window.clearTimeout(timer);
    const remainingCap = Math.max(0, SEARCH_SETTLE_MAX_MS - (nowMs() - startedAt));
    if (remainingCap <= 0) { stop(); return; }
    timer = window.setTimeout(stop, Math.min(SEARCH_SETTLE_WINDOW_MS, remainingCap));
  };
  const runPass = () => {
    frame = 0;
    if (!active) return;
    const verifyOnly = remainingFrames <= 0 && !dirtyLayout;
    dirtyLayout = false;
    const prevScrollTop = scroller?.scrollTop ?? 0, prevScrollHeight = scroller?.scrollHeight ?? 0;
    const result = step(verifyOnly);
    if (!result) { stop(); return; }
    recordScrollerState();
    const heightChanged = Boolean(scroller && scroller.scrollHeight !== prevScrollHeight);
    if (heightChanged) adjustGuard = 8;
    const adjusted = Boolean(heightChanged || result === "realigned" || (scroller && Math.abs(scroller.scrollTop - prevScrollTop) > 0.5));
    if (remainingFrames > 0) {
      remainingFrames--;
      if (adjusted) verifyFrames = 2;
      frame = requestAnimationFrame(runPass);
    } else if (adjusted && adjustGuard > 0) {
      adjustGuard--; verifyFrames = 2; frame = requestAnimationFrame(runPass);
    } else if (verifyFrames > 0) {
      verifyFrames--;
      if (verifyFrames > 0) frame = requestAnimationFrame(runPass);
    }
  };
  const schedulePass = (fromLayoutChange = false) => {
    if (!active) return;
    if (fromLayoutChange) { dirtyLayout = true; verifyFrames = 2; adjustGuard = 8; }
    if (!frame) frame = requestAnimationFrame(runPass);
  };
  const onUserGesture = (event: Event) => { if (!inSearchUi(event.target)) stop(); };
  const onKeyDown = (event: KeyboardEvent) => { if (!inSearchUi(event.target) && MANUAL_SCROLL_KEYS.has(event.key)) stop(); };
  const onWindowChange = () => {
    if (!active) return;
    layoutMutating = true;
    if (!mutatingQueued) {
      mutatingQueued = true;
      queueMicrotask(() => { mutatingQueued = false; layoutMutating = false; if (active) recordScrollerState(); });
    }
    armStopTimer();
    schedulePass(true);
  };
  const onScroll = () => {
    if (!active || !scroller || layoutMutating) return;
    if (scroller.scrollHeight !== recordedScrollHeight) { recordScrollerState(); armStopTimer(); schedulePass(true); return; }
    if (Math.abs(scroller.scrollTop - recordedScrollTop) > 2) stop();
  };
  const page = scroller?.querySelector<HTMLElement>(".document-page,.preview-page,.live-document,.markdown-body") ?? (eventHost instanceof HTMLElement ? eventHost : null);
  const pageSpace = scroller?.querySelector<HTMLElement>(".document-page-space") ?? null;
  const readPageHeight = (entry?: ResizeObserverEntry) =>
    (entry && entry.target === page ? entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height : undefined) ?? page?.offsetHeight ?? page?.getBoundingClientRect().height ?? 0;
  let lastPageHeight = readPageHeight();
  const observer = (page || pageSpace) && typeof ResizeObserver !== "undefined"
    ? new ResizeObserver((entries) => {
        if (!active) return;
        const nextHeight = readPageHeight(entries.find((e) => e.target === page));
        const scrollerHeightChanged = Boolean(scroller && scroller.scrollHeight !== recordedScrollHeight);
        if (Math.abs(nextHeight - lastPageHeight) <= 0.5 && !scrollerHeightChanged) return;
        lastPageHeight = nextHeight;
        if (scrollerHeightChanged) recordScrollerState();
        armStopTimer();
        schedulePass(true);
      })
    : undefined;
  if (page && observer) observer.observe(page);
  if (pageSpace && pageSpace !== page && observer) observer.observe(pageSpace);
  eventHost.addEventListener("supermd-window-change", onWindowChange);
  scroller?.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("wheel", onUserGesture, { capture: true, passive: true });
  window.addEventListener("touchstart", onUserGesture, { capture: true, passive: true });
  window.addEventListener("touchmove", onUserGesture, { capture: true, passive: true });
  window.addEventListener("pointerdown", onUserGesture, { capture: true, passive: true });
  window.addEventListener("keydown", onKeyDown, { capture: true, passive: true });
  window.addEventListener("supermd-goto-offset", stop);
  armStopTimer();
  remainingFrames--;
  frame = requestAnimationFrame(runPass);
  return { stop, recordScrollerState };
}
