import type { PythonResult } from "./types";
export const chartValues = new Map<string, Record<string, number>>();
export const chartZooms = new Map<string, number>();
export const chartViews = new Map<string, {azimuth:number;elevation:number}>();
export const pythonResults = new Map<string, PythonResult>();
export function remember<T>(map: Map<string, T>, key: string, value: T) {
  map.set(key, value); if (map.size > 60) map.delete(map.keys().next().value!);
}
