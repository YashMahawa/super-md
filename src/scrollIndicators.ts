/** Native-document scroll lanes stay reserved; indicators appear only on input.
 * Event delegation also covers Source/Live editors created after mode changes.
 * This updates classes only, never React state or the native bridge per frame. */
const SCROLL_INDICATOR_SELECTOR =
  ".android-reading,.cm-scroller,.katex-display,.markdown-body table,.markdown-body pre";

function canScrollAxis(target: HTMLElement, axis: "x" | "y"): boolean {
  const extent =
    axis === "x"
      ? target.scrollWidth - target.clientWidth
      : target.scrollHeight - target.clientHeight;
  if (extent <= 1) return false;
  const style = target.ownerDocument.defaultView?.getComputedStyle(target);
  if (!style) return true;
  const overflow = axis === "x" ? style.overflowX : style.overflowY;
  return overflow !== "hidden" && overflow !== "clip";
}

function hasScrollableOverflow(target: HTMLElement): boolean {
  return canScrollAxis(target, "x") || canScrollAxis(target, "y");
}

function visualLaneScale(target: HTMLElement): number {
  const page = target.closest<HTMLElement>(".document-page");
  if (!page || target === page) return 1;
  const scale = Number(page.dataset.scale);
  return Number.isFinite(scale) && scale > 1 ? scale : 1;
}

function resolveHoveredIndicator(
  start: Element | null,
  clientX: number,
  clientY: number,
): HTMLElement | null {
  let current = start ? start.closest<HTMLElement>(SCROLL_INDICATOR_SELECTOR) : null;
  while (current) {
    const overflowsX = canScrollAxis(current, "x");
    const overflowsY = canScrollAxis(current, "y");
    if (overflowsX || overflowsY) {
      const rect = current.getBoundingClientRect();
      if (
        clientX >= rect.left - 1 &&
        clientX <= rect.right + 1 &&
        clientY >= rect.top - 1 &&
        clientY <= rect.bottom + 1
      ) {
        const scale = visualLaneScale(current);
        const inVerticalLane = overflowsY && clientX >= rect.right - 24 * scale;
        const inHorizontalLane = overflowsX && clientY >= rect.bottom - 16 * scale;
        if (inVerticalLane || inHorizontalLane) return current;
      }
    }
    current = current.parentElement?.closest<HTMLElement>(SCROLL_INDICATOR_SELECTOR) ?? null;
  }
  return null;
}

export function installScrollIndicators() {
  const timers = new Map<HTMLElement, number>();
  let hovered: HTMLElement | null = null;
  const hover = (next: HTMLElement | null) => {
    if (next === hovered) return;
    hovered?.classList.remove("scroll-indicator-hover");
    hovered = next;
    hovered?.classList.add("scroll-indicator-hover");
  };
  const scroll = (event: Event) => {
    const target = event.target;
    if (
      !(target instanceof HTMLElement) ||
      !target.matches(SCROLL_INDICATOR_SELECTOR) ||
      !hasScrollableOverflow(target)
    ) {
      return;
    }
    target.classList.add("scroll-indicator-active");
    window.clearTimeout(timers.get(target));
    timers.set(target, window.setTimeout(() => {
      target.classList.remove("scroll-indicator-active"); timers.delete(target);
    }, 650));
  };
  const move = (event: PointerEvent) => {
    const start =
      event.target instanceof Element
        ? event.target
        : event.target instanceof Node
          ? event.target.parentElement
          : null;
    hover(resolveHoveredIndicator(start, event.clientX, event.clientY));
  };
  const leave = (event: PointerEvent) => { if (!event.relatedTarget) hover(null); };
  document.addEventListener("scroll", scroll, true);
  document.addEventListener("pointermove", move, {passive: true});
  document.addEventListener("pointerout", leave, {passive: true});
  return () => {
    document.removeEventListener("scroll", scroll, true);
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerout", leave);
    hover(null);
    timers.forEach((timer, target) => { window.clearTimeout(timer); target.classList.remove("scroll-indicator-active"); });
    timers.clear();
  };
}
