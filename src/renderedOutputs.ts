import type { PythonResult } from "./types";
export const chartValues = new Map<string, Record<string, number>>();
export const chartZooms = new Map<string, number>();
export const chartViews = new Map<string, {azimuth:number;elevation:number}>();
export const pythonResults = new Map<string, PythonResult>();
export function remember<T>(map: Map<string, T>, key: string, value: T) {
  map.set(key, value); if (map.size > 60) map.delete(map.keys().next().value!);
}

export function exportRenderedViews(content: string) {
  const selected = <T,>(map: Map<string, T>) => [...map].filter(([key]) => content.includes(key));
  const result = {values:selected(chartValues), zooms:selected(chartZooms), views:selected(chartViews), python:selected(pythonResults)};
  // Avoid carrying huge derived images through the UI bridge. This is optional
  // runtime state, not source/assets, and never executes Python on restore.
  if (JSON.stringify(result).length > 8_000_000) result.python = [];
  return result;
}
export function importRenderedViews(content: string, data: ReturnType<typeof exportRenderedViews> | undefined) {
  if (!data) return;
  const restore = <T,>(map: Map<string, T>, pairs: [string, T][], valid:(value:T)=>boolean) => {
    if (!Array.isArray(pairs)) return;
    for (const pair of pairs.slice(0,60)) if (Array.isArray(pair) && typeof pair[0] === "string" && content.includes(pair[0]) && valid(pair[1])) remember(map, pair[0], pair[1]);
  };
  const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value);
  restore(chartValues, data.values, value => !!value && typeof value === "object" && Object.values(value).every(finite));
  restore(chartZooms, data.zooms, value => finite(value) && value >= .5 && value <= 8);
  restore(chartViews, data.views, value => !!value && finite(value.azimuth) && finite(value.elevation));
  restore(pythonResults, data.python, value => !!value && typeof value.ok === "boolean" && typeof value.stdout === "string" && typeof value.stderr === "string" && Array.isArray(value.images) && value.images.length <= 20 && value.images.every(image => typeof image === "string" && /^data:image\/(png|jpeg|svg\+xml);base64,/.test(image)));
}
