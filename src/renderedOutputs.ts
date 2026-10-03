import type { PythonResult } from "./types";
import {invoke} from './nativeBridge';
export const chartValues = new Map<string, Record<string, number>>();
export const chartZooms = new Map<string, number>();
export const chartCenters = new Map<string, {x:number;y:number}>();
export const chartGrids = new Map<string, boolean>();
export const chartViews = new Map<string, {azimuth:number;elevation:number}>();
export const pythonResults = new Map<string, PythonResult>();
const storedPython=new Set<string>();
let storedCharacters=0;
function markPythonStored(source:string):void {
  if(storedPython.delete(source))storedCharacters-=source.length;
  storedPython.add(source);storedCharacters+=source.length;
  while(storedCharacters>2_000_000||storedPython.size>5000){const first=storedPython.values().next().value!;storedPython.delete(first);storedCharacters-=first.length;}
}
const loadingPython=new Map<string,Promise<PythonResult|undefined>>();
export function pythonStored(source:string):boolean {return storedPython.has(source);}
function validPython(value:unknown):value is PythonResult {const result=value as PythonResult;return !!result&&typeof result.ok==='boolean'&&typeof result.stdout==='string'&&typeof result.stderr==='string'&&Array.isArray(result.images)&&result.images.length<=20&&result.images.every(image=>typeof image==='string'&&/^data:image\/(png|jpeg|svg\+xml);base64,/.test(image));}
export async function storePythonOutput(source:string,result:PythonResult):Promise<boolean> {
  try {await invoke('cache_python_output',{source,result});markPythonStored(source);return true;} catch {return false;}
}
export async function loadPythonOutput(source:string):Promise<PythonResult|undefined> {
  const cached=pythonResults.get(source);if(cached)return cached;
  const pending=loadingPython.get(source);if(pending)return pending;
  const load=(async()=>{try {const result=await invoke<unknown>('load_python_output',{source});if(validPython(result)){markPythonStored(source);remember(pythonResults,source,result);return result;}} catch { /* An unrun cell or unavailable cache never executes code. */ }finally{loadingPython.delete(source);}})();
  loadingPython.set(source,load);return load;
}
const visiblePython = new Set<{source:string;result:PythonResult}>();
export function retainVisiblePython(source:string,result:PythonResult){const record={source,result};visiblePython.add(record);return()=>{visiblePython.delete(record);};}
export async function pythonOutput(source:string):Promise<PythonResult|undefined> {for(const entry of visiblePython)if(entry.source===source)return entry.result;return loadPythonOutput(source);}
export function remember<T>(map: Map<string, T>, key: string, value: T) {
  map.delete(key);map.set(key, value);
  if (map === pythonResults) {
    // Images dominate retained memory. Sixty base64 figures can otherwise
    // retain gigabytes after their tabs have closed. Current visible results
    // stay owned by PythonCell; this cap only evicts optional redisplay cache.
    const cost=(source:string,result:PythonResult)=>2*(source.length+result.stdout.length+result.stderr.length+result.images.reduce((n,image)=>n+image.length,0));
    let bytes=[...pythonResults].reduce((n,[source,result])=>n+cost(source,result),0);
    for(const [source,result] of pythonResults){if(bytes<=16_000_000 && pythonResults.size<=60)break;pythonResults.delete(source);bytes-=cost(source,result);}
  } else {
    // Camera/slider metadata is small. Retain many graph states without keeping
    // their meshes, so scrolling through a large note doesn't reset its graphs.
    let bytes=[...map].reduce((size,[source,data])=>size+2*(source.length+JSON.stringify(data).length),0);
    for(const [source,data] of map){if(bytes<=4_000_000&&map.size<=5000)break;map.delete(source);bytes-=2*(source.length+JSON.stringify(data).length);}
  }
}

export function exportRenderedViews(content: string) {
  const selected = <T,>(map: Map<string, T>) => [...map].filter(([key]) => content.includes(key));
  const result = {values:selected(chartValues), zooms:selected(chartZooms), centers:selected(chartCenters), grids:selected(chartGrids), views:selected(chartViews), python:selected(pythonResults)};
  // Avoid carrying huge derived images through the UI bridge. This is optional
  // runtime state, not source/assets, and never executes Python on restore.
  if (JSON.stringify(result).length > 8_000_000) result.python = [];
  return result;
}
export function importRenderedViews(content: string, data: ReturnType<typeof exportRenderedViews> | undefined) {
  if (!data) return;
  const restore = <T,>(map: Map<string, T>, pairs: [string, T][], valid:(value:T)=>boolean) => {
    if (!Array.isArray(pairs)) return;
    for (const pair of pairs.slice(0,map===pythonResults?60:5000)) if (Array.isArray(pair) && typeof pair[0] === "string" && content.includes(pair[0]) && valid(pair[1])) remember(map, pair[0], pair[1]);
  };
  const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value);
  restore(chartValues, data.values, value => !!value && typeof value === "object" && Object.values(value).every(finite));
  restore(chartZooms, data.zooms, value => finite(value) && value >= .05 && value <= 64);
  restore(chartCenters, data.centers, value => !!value && finite(value.x) && finite(value.y));
  restore(chartGrids, data.grids, value => typeof value === "boolean");
  restore(chartViews, data.views, value => !!value && finite(value.azimuth) && finite(value.elevation));
  restore(pythonResults, data.python, value => !!value && typeof value.ok === "boolean" && typeof value.stdout === "string" && typeof value.stderr === "string" && Array.isArray(value.images) && value.images.length <= 20 && value.images.every(image => typeof image === "string" && /^data:image\/(png|jpeg|svg\+xml);base64,/.test(image)));
}
