/** Native-document scroll lanes stay reserved; indicators appear only on input.
 * Event delegation also covers Source/Live editors created after mode changes.
 * This updates classes only, never React state or the native bridge per frame. */
export function installScrollIndicators() {
  const selector = ".android-reading,.cm-scroller";
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
    if (!(target instanceof HTMLElement) || !target.matches(selector)) return;
    target.classList.add("scroll-indicator-active");
    window.clearTimeout(timers.get(target));
    timers.set(target, window.setTimeout(() => {
      target.classList.remove("scroll-indicator-active"); timers.delete(target);
    }, 650));
  };
  const move = (event: PointerEvent) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>(selector) : null;
    if (!target) { hover(null); return; }
    const rect = target.getBoundingClientRect();
    const inLane = event.clientX >= rect.right - 24 || event.clientY >= rect.bottom - 16;
    hover(inLane ? target : null);
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
