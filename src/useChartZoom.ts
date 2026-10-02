import { useEffect, useRef, useState } from "react";
import { chartZooms, remember } from "./renderedOutputs";

/** Plot gestures stay inside the plot. Ordinary one-finger scrolling is unchanged. */
export function useChartZoom(source: string) {
  const host = useRef<HTMLElement>(null);
  const [zoom, setZoom] = useState(() => chartZooms.get(source) ?? 1);
  const value = useRef(zoom); value.current = zoom;
  const change = (next: number) => {
    value.current = Math.max(.5, Math.min(8, Number.isFinite(next) ? next : 1));
    setZoom(value.current); remember(chartZooms, source, value.current);
  };
  useEffect(() => {
    change(chartZooms.get(source) ?? 1);
    const element = host.current; if (!element) return;
    let distance = 0, initial = 1, frame = 0, pending = value.current;
    const span = (touches: TouchList) => Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
    const update = (next: number) => {
      pending = next;
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; change(pending); });
    };
    const start = (event: TouchEvent) => {
      if (event.touches.length !== 2) return;
      distance = span(event.touches); initial = value.current;
      element.dataset.chartPinching = "true";
      event.preventDefault(); event.stopPropagation();
    };
    const move = (event: TouchEvent) => {
      if (!distance || event.touches.length !== 2) return;
      event.preventDefault(); event.stopPropagation();
      update(initial * span(event.touches) / distance);
    };
    const end = (event: TouchEvent) => {
      if (event.touches.length >= 2) return;
      if (frame) { cancelAnimationFrame(frame); frame = 0; change(pending); }
      distance = 0; delete element.dataset.chartPinching;
    };
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault(); event.stopPropagation();
      update((frame ? pending : value.current) * Math.exp(-event.deltaY * .002));
    };
    const native = (event: Event) => {
      if (event.defaultPrevented) return;
      const hovered = document.querySelector(".interactive-chart:hover");
      if (hovered ? hovered !== element : !element.contains(document.activeElement)) return;
      event.preventDefault(); change(value.current * (event as CustomEvent<number>).detail);
    };
    element.addEventListener("touchstart", start, {passive: false});
    element.addEventListener("touchmove", move, {passive: false});
    element.addEventListener("touchend", end); element.addEventListener("touchcancel", end);
    element.addEventListener("wheel", wheel, {passive: false});
    window.addEventListener("supermd-chart-native-zoom", native);
    return () => {
      cancelAnimationFrame(frame); delete element.dataset.chartPinching;
      element.removeEventListener("touchstart", start); element.removeEventListener("touchmove", move);
      element.removeEventListener("touchend", end); element.removeEventListener("touchcancel", end);
      element.removeEventListener("wheel", wheel); window.removeEventListener("supermd-chart-native-zoom", native);
    };
  }, [source]);
  return {host, zoom, change};
}
