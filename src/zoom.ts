export const MIN_PREVIEW_ZOOM = 60;
export const MAX_PREVIEW_ZOOM = 240;

export function clampPreviewZoom(value: number): number {
  if (!Number.isFinite(value)) return 100;
  return Math.max(MIN_PREVIEW_ZOOM, Math.min(MAX_PREVIEW_ZOOM, Math.round(value)));
}

export function previewLayoutWidth(viewportWidth: number, preferredWidth: number, zoomPercent: number): number {
  const padding = viewportWidth < 760 ? 32 : 72;
  const available = Math.max(80, viewportWidth - padding);
  return Math.min(preferredWidth, available / (clampPreviewZoom(zoomPercent) / 100));
}

export function zoomShortcut(event: Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "altKey" | "code" | "key">): "in" | "out" | "reset" | null {
  if ((!event.ctrlKey && !event.metaKey) || event.altKey) return null;
  if (event.code === "Equal" || event.code === "NumpadAdd" || event.key === "+") return "in";
  if (event.code === "Minus" || event.code === "NumpadSubtract" || event.key === "-") return "out";
  if (event.code === "Digit0" || event.code === "Numpad0") return "reset";
  return null;
}
