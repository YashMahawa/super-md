/** Nested scroll resolution and per-axis boundary chaining for native Qt
 * touchpad/wheel deltas routed through `window.supermdNativeWheel`. */

export const MODAL_SCROLL_BOUNDARY_SELECTOR = [
  '.theme-guide-dialog',
  '.step-viewer',
  '.image-viewer',
  '.math-repair-panel',
  '.media-dialog',
  '.reader-export-progress',
  '.reading-search',
].join(',');

export const NON_VIEWER_OVERLAY_SELECTOR = [
  '.theme-guide-dialog',
  '.math-repair-panel',
  '.media-dialog',
  '.reader-export-progress',
  '.reading-search',
].join(',');

const EXPLICIT_SCROLL_REGION_SELECTOR = [
  // Code regions
  '.markdown-body pre',
  '.python-source',
  '.cell-output pre',
  '.cm-scroller',
  'textarea',
  // Table regions
  '.markdown-body table',
  // Study, math & diagram regions
  '.step-cards-notes',
  '.step-cards-layout',
  '.katex-display',
  '.mermaid',
  '.svg-figure:not(.mermaid .svg-figure):not(.cell-output .svg-figure)',
  '.markdown-body .media-paragraph',
  // Workspace & dialog scroll containers
  '.android-reading',
  '.android-source',
  '.reading-scroll',
  '.theme-guide-body',
  '.theme-guide-preset-list',
  '.math-repair-list',
  '.media-dialog',
  '.reader-export-progress',
  '.reading-search',
  '.export-error',
].join(',');

const NON_SCROLL_WRAPPER_SELECTOR = 'html,body,#root,.document-page,.document-page-space';

const subpixelCarry = new WeakMap<HTMLElement, { x: number; y: number }>();

export interface NativeScrollChainOptions {
  centerLock?: boolean;
  onReadingScroll?: (reading: HTMLElement, attemptedDy: number) => void;
}

function isScrollableOverflow(value: string): boolean {
  return value === 'auto' || value === 'scroll';
}

function isBlockedOverflow(value: string): boolean {
  return value === 'hidden' || value === 'clip';
}

export function isScrollChainCandidate(element: HTMLElement): boolean {
  if (element.matches(NON_SCROLL_WRAPPER_SELECTOR)) return false;
  if (element.matches(EXPLICIT_SCROLL_REGION_SELECTOR)) return true;
  const view = element.ownerDocument.defaultView;
  if (!view) return false;
  const style = view.getComputedStyle(element);
  return isScrollableOverflow(style.overflowX) || isScrollableOverflow(style.overflowY);
}

function canScrollAxis(element: HTMLElement, axis: 'x' | 'y', centerLock: boolean): boolean {
  if (axis === 'x' && centerLock && element.matches('.android-reading')) return false;
  const view = element.ownerDocument.defaultView;
  const style = view?.getComputedStyle(element);
  const overflow = style ? (axis === 'x' ? style.overflowX : style.overflowY) : '';
  if (isBlockedOverflow(overflow)) return false;
  if (isScrollableOverflow(overflow)) return true;
  // Support explicit scroll regions in lightweight DOM environments where
  // external stylesheets are not attached.
  if (overflow === '' || overflow === 'visible') {
    if (axis === 'y' && element.matches('.katex-display,.svg-figure,.media-paragraph')) return false;
    return element.matches(EXPLICIT_SCROLL_REGION_SELECTOR);
  }
  return false;
}

function elementVisualScale(element: HTMLElement): number {
  const page = element.closest<HTMLElement>('.document-page');
  if (!page || element === page) return 1;
  if (page.style.zoom && page.style.zoom !== '1') return 1;
  const scale = Number(page.dataset.scale);
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

function performElementScrollBy(element: HTMLElement, dx: number, dy: number): void {
  if (!dx && !dy) return;
  if (typeof element.scrollBy === 'function') {
    element.scrollBy({ left: dx, top: dy, behavior: 'instant' });
    return;
  }
  if (dx) {
    const maxLeft = Math.max(0, element.scrollWidth - element.clientWidth);
    element.scrollLeft = Math.max(0, Math.min(maxLeft, element.scrollLeft + dx));
  }
  if (dy) {
    const maxTop = Math.max(0, element.scrollHeight - element.clientHeight);
    element.scrollTop = Math.max(0, Math.min(maxTop, element.scrollTop + dy));
  }
}

function fallbackInsideBoundary(boundary: HTMLElement): HTMLElement | null {
  if (boundary.matches('.theme-guide-dialog')) {
    return boundary.querySelector<HTMLElement>('.theme-guide-body');
  }
  if (boundary.matches('.math-repair-panel')) {
    return boundary.querySelector<HTMLElement>('.math-repair-list');
  }
  if (boundary.matches('.android-source')) {
    return boundary.querySelector<HTMLElement>('.cm-scroller') ?? boundary;
  }
  return isScrollChainCandidate(boundary) ? boundary : null;
}

/** Resolve the innermost scroll-chain element at the pointer target, bounded
 * by active modal overlays or workspace panes. */
export function resolveNativeWheelScrollOrigin(
  target: Element | null,
  doc: Document = document,
): HTMLElement | null {
  const start = target instanceof Element ? target : null;
  if (start) {
    const textarea = start.closest<HTMLTextAreaElement>('textarea');
    if (textarea) return textarea;

    const modal = start.closest<HTMLElement>(MODAL_SCROLL_BOUNDARY_SELECTOR);
    if (modal) {
      let node: Element | null = start;
      while (node) {
        if (node instanceof HTMLElement && isScrollChainCandidate(node)) return node;
        if (node === modal) break;
        node = node.parentElement;
      }
      return fallbackInsideBoundary(modal);
    }

    const pane = start.closest<HTMLElement>('.android-source,.android-reading,.reading-scroll');
    if (pane) {
      let node: Element | null = start;
      while (node) {
        if (node instanceof HTMLElement && isScrollChainCandidate(node)) return node;
        if (node === pane) break;
        node = node.parentElement;
      }
      return fallbackInsideBoundary(pane);
    }
  }
  return doc.querySelector<HTMLElement>('.android-reading');
}

/** Collect the ordered ancestor scroll chain from `origin` outward, stopping
 * at modal overlays or workspace pane roots so overlays never leak scroll into
 * the background note. */
export function collectNativeWheelScrollChain(origin: HTMLElement): HTMLElement[] {
  if (origin.tagName === 'TEXTAREA') return [origin];

  const boundary =
    origin.closest<HTMLElement>(MODAL_SCROLL_BOUNDARY_SELECTOR) ??
    origin.closest<HTMLElement>('.android-source,.android-reading,.reading-scroll') ??
    origin;

  const chain: HTMLElement[] = [];
  let current: HTMLElement | null = origin;
  while (current) {
    if (isScrollChainCandidate(current)) chain.push(current);
    if (current === boundary) break;
    current = current.parentElement;
  }

  const fallback = fallbackInsideBoundary(boundary);
  if (fallback && !chain.includes(fallback)) chain.push(fallback);
  return chain;
}

function consumeAxisOnElement(
  scroller: HTMLElement,
  axis: 'x' | 'y',
  remainingScreenDelta: number,
  scale: number,
  isTerminalScroller: boolean,
): number {
  if (!remainingScreenDelta) return 0;

  const maxScroll =
    axis === 'x'
      ? Math.max(0, scroller.scrollWidth - scroller.clientWidth)
      : Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  const before = axis === 'x' ? scroller.scrollLeft : scroller.scrollTop;
  const roomBefore = remainingScreenDelta > 0 ? maxScroll - before : before;

  if (roomBefore <= 0.5 && !isTerminalScroller) {
    const carry = subpixelCarry.get(scroller);
    if (carry) carry[axis] = 0;
    return remainingScreenDelta;
  }

  const carry = subpixelCarry.get(scroller) ?? { x: 0, y: 0 };
  if (carry[axis] * remainingScreenDelta < 0) carry[axis] = 0;

  const wantLayoutDelta = remainingScreenDelta / scale + carry[axis];
  if (axis === 'x') performElementScrollBy(scroller, wantLayoutDelta, 0);
  else performElementScrollBy(scroller, 0, wantLayoutDelta);

  const after = axis === 'x' ? scroller.scrollLeft : scroller.scrollTop;
  const actualLayoutDelta = after - before;
  const refreshedMax =
    axis === 'x'
      ? Math.max(0, scroller.scrollWidth - scroller.clientWidth)
      : Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  const roomAfter = remainingScreenDelta > 0 ? refreshedMax - after : after;

  if (roomAfter > 1 && (actualLayoutDelta !== 0 || Math.abs(wantLayoutDelta) < 1)) {
    carry[axis] = wantLayoutDelta - actualLayoutDelta;
    subpixelCarry.set(scroller, carry);
    return 0;
  }

  carry[axis] = 0;
  subpixelCarry.set(scroller, carry);
  const consumedScreenDelta = actualLayoutDelta * scale;
  const leftover =
    remainingScreenDelta > 0
      ? Math.max(0, remainingScreenDelta - Math.max(0, consumedScreenDelta))
      : Math.min(0, remainingScreenDelta - Math.min(0, consumedScreenDelta));
  return Math.abs(leftover) < 0.01 ? 0 : leftover;
}

/** Apply `(dx, dy)` screen-pixel scroll deltas starting at `origin` and chain
 * unconsumed horizontal/vertical movement across ancestor scrollers. */
export function applyChainedNativeScroll(
  origin: HTMLElement,
  dx: number,
  dy: number,
  options: NativeScrollChainOptions = {},
): void {
  let remX = Number.isFinite(dx) ? dx : 0;
  let remY = Number.isFinite(dy) ? dy : 0;
  if (!remX && !remY) return;

  const centerLock = Boolean(options.centerLock);
  const chain = collectNativeWheelScrollChain(origin);
  for (let i = 0; i < chain.length; i++) {
    if (!remX && !remY) break;
    const scroller = chain[i];
    if (!scroller.isConnected) continue;

    const isReading = scroller.matches('.android-reading');
    if (isReading && remY) options.onReadingScroll?.(scroller, remY);

    const isTerminal = i === chain.length - 1;
    const scale = elementVisualScale(scroller);

    if (remX && canScrollAxis(scroller, 'x', centerLock)) {
      remX = consumeAxisOnElement(scroller, 'x', remX, scale, isTerminal);
    }
    if (remY && canScrollAxis(scroller, 'y', centerLock)) {
      remY = consumeAxisOnElement(scroller, 'y', remY, scale, isTerminal);
    }
  }
}
