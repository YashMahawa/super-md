import { refreshDocumentExtent, shiftDocumentOriginY } from "./documentZoom";

export interface VerticalBandRect {
  top: number;
  bottom: number;
}

interface ClearanceEntry {
  inlinePaddingTop: string;
  basePaddingPx: number;
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

function increaseSearchTopClearance(scroller: HTMLElement, extraPx: number): void {
  if (extraPx <= 0 || !scroller.isConnected) return;
  let entry = activeClearances.get(scroller);
  if (!entry) {
    const computed = typeof getComputedStyle === "function" ? parseFloat(getComputedStyle(scroller).paddingTop || "0") : 0;
    entry = {
      inlinePaddingTop: scroller.style.paddingTop,
      basePaddingPx: Number.isFinite(computed) ? computed : 0,
      appliedPx: 0,
    };
    activeClearances.set(scroller, entry);
  }
  const delta = Math.ceil(extraPx);
  entry.appliedPx += delta;
  scroller.style.paddingTop = `${entry.basePaddingPx + entry.appliedPx}px`;
  if (scroller.matches(".android-reading")) {
    shiftDocumentOriginY(scroller, delta);
    refreshDocumentExtent(scroller);
  }
}

export function clearSearchTopClearances(): void {
  for (const [scroller, entry] of activeClearances) {
    if (entry.appliedPx > 0) {
      const prevScrollTop = scroller.scrollTop;
      if (entry.inlinePaddingTop) scroller.style.paddingTop = entry.inlinePaddingTop;
      else scroller.style.removeProperty("padding-top");
      if (scroller.isConnected && scroller.matches(".android-reading")) {
        shiftDocumentOriginY(scroller, -entry.appliedPx);
        refreshDocumentExtent(scroller);
      }
      scroller.scrollTop = prevScrollTop > entry.appliedPx ? prevScrollTop - entry.appliedPx : 0;
    }
  }
  activeClearances.clear();
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
  const { visibleTop, visibleBottom } = band;
  const bandHeight = Math.max(1, visibleBottom - visibleTop);
  const rect = resolveLiveRect?.() ?? initialRect;
  const matchHeight = Math.max(0, rect.bottom - rect.top);

  if (mode === "ensure-visible" && rect.top >= visibleTop && (rect.bottom <= visibleBottom || matchHeight >= bandHeight)) {
    return;
  }

  let desiredTop: number;
  if (matchHeight >= bandHeight) {
    desiredTop = visibleTop;
  } else if (mode === "ensure-visible") {
    desiredTop = rect.top < visibleTop ? visibleTop : visibleBottom - matchHeight;
  } else {
    desiredTop = visibleTop + (bandHeight - matchHeight) / 2;
  }

  const prevScrollTop = scroller.scrollTop;
  const targetScrollTop = prevScrollTop + (rect.top - desiredTop);

  if (targetScrollTop < 0) {
    if (prevScrollTop !== 0) scroller.scrollTop = 0;
    if (scroller.matches(".android-reading")) refreshDocumentExtent(scroller);
    const atZero = resolveLiveRect?.() ?? { top: rect.top + prevScrollTop, bottom: rect.bottom + prevScrollTop };
    if (atZero.top < visibleTop) {
      increaseSearchTopClearance(scroller, visibleTop - atZero.top);
      scroller.scrollTop = 0;
    }
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
          const zeroRect = resolveLiveRect() ?? { top: after.top + cur, bottom: after.bottom + cur };
          if (zeroRect.top < visibleTop) {
            increaseSearchTopClearance(scroller, visibleTop - zeroRect.top);
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
