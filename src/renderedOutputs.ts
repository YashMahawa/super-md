import type { PythonContext, PythonProvenance, PythonResult } from "./types";
import {invoke} from './nativeBridge';
export const chartValues = new Map<string, Record<string, number>>();
export const chartZooms = new Map<string, number>();
export const chartCenters = new Map<string, {x:number;y:number}>();
export const chartGrids = new Map<string, boolean>();
export const pythonResults = new Map<string, PythonResult>();
const scopedPythonResults = new Map<string, PythonResult>();
const scopedPythonContexts = new Map<string, PythonContext>();
const scopedPythonSources = new Map<string, string>();
const storedPython=new Set<string>();
let storedCharacters=0;
function storageKey(source:string,context?:PythonContext):string {return context?JSON.stringify([source,context.document,context.cell,context.interpreter]):JSON.stringify([source]);}
export function pythonContextKey(source:string,context:PythonContext):string {return storageKey(source,context);}
function markPythonStored(source:string,context?:PythonContext):void {
  const key=storageKey(source,context);
  if(storedPython.delete(key))storedCharacters-=key.length;
  storedPython.add(key);storedCharacters+=key.length;
  while(storedCharacters>2_000_000||storedPython.size>5000){const first=storedPython.values().next().value!;storedPython.delete(first);storedCharacters-=first.length;}
}
function forgetPythonStored(key:string):void {
  if(storedPython.delete(key))storedCharacters-=key.length;
}
const loadingPython=new Map<string,Promise<PythonResult|undefined>>();
export function pythonStored(source:string,context?:PythonContext):boolean {return storedPython.has(storageKey(source,context));}
function validPython(value:unknown):value is Omit<PythonResult,'provenance'> {const result=value as PythonResult;return !!result&&typeof result.ok==='boolean'&&typeof result.stdout==='string'&&typeof result.stderr==='string'&&Array.isArray(result.images)&&result.images.length<=20&&result.images.every(image=>typeof image==='string'&&/^data:image\/(png|jpeg|svg\+xml);base64,/.test(image));}
function verifiedProvenance(value:unknown,context:PythonContext):PythonProvenance|undefined {
  const provenance=value as PythonProvenance;
  return provenance?.verified===true&&provenance.document===context.document&&provenance.cell===context.cell&&typeof provenance.interpreter==='string'&&provenance.interpreter.length>0?provenance:undefined;
}
function unpackPython(value:unknown,context?:PythonContext):PythonResult|undefined {
  if(!value||typeof value!=='object')return;
  const envelope=value as {result?:unknown;provenance?:unknown};
  const body=envelope.result&&typeof envelope.result==='object'?envelope.result:value;
  if(!validPython(body))return;
  const bodyProvenance=(body as PythonResult).provenance;
  const provenance=context?verifiedProvenance(envelope.provenance??bodyProvenance,context):undefined;
  return {...body,provenance:provenance??{verified:false,reason:'Legacy saved output; document and runtime were not recorded'}};
}
export function cachedPythonOutput(source:string,context?:PythonContext):PythonResult|undefined {
  if(context)return scopedPythonResults.get(storageKey(source,context));
  const result=pythonResults.get(source);
  return result&&!result.provenance?{...result,provenance:{verified:false,reason:'Unscoped legacy output'}}:result;
}
export function rememberPythonOutput(source:string,result:PythonResult,context?:PythonContext):void {
  if(context){const key=storageKey(source,context);scopedPythonContexts.set(key,context);scopedPythonSources.set(key,source);remember(scopedPythonResults,key,result);if(!scopedPythonResults.has(key)){scopedPythonContexts.delete(key);scopedPythonSources.delete(key);forgetPythonStored(key);}}
  else remember(pythonResults,source,{...result,provenance:{verified:false,reason:'Unscoped legacy output'}});
}
export async function storePythonOutput(source:string,result:PythonResult,context?:PythonContext,freshExecution=false):Promise<boolean> {
  if(context){
    const verified=verifiedProvenance(result.provenance,context);
    // `freshExecution` is set only from the just-completed run callback; the
    // native bridge additionally checks its exact pending result/context.
    const unsavedRetry=freshExecution&&result.provenance?.unsaved===true;
    if(!verified&&!unsavedRetry)return false;
    if(!freshExecution){markPythonStored(source,context);return true;}
  }
  const payload={stdout:result.stdout,stderr:result.stderr,images:result.images,ok:result.ok};
  try {await invoke('cache_python_output',{source,result:payload,...(context?{context}:{})});markPythonStored(source,context);return true;} catch {return false;}
}
export async function loadPythonOutput(source:string,context?:PythonContext):Promise<PythonResult|undefined> {
  const cached=cachedPythonOutput(source,context);if(cached)return cached;
  const key=storageKey(source,context),pending=loadingPython.get(key);if(pending)return pending;
  const load=(async()=>{try {
    const value=await invoke<unknown>('load_python_output',{source,...(context?{context}:{})});
    const result=unpackPython(value,context);
    if(result){markPythonStored(source,context);rememberPythonOutput(source,result,context);return result;}
  } catch { /* An unrun cell or unavailable cache never executes code. */ }finally{loadingPython.delete(key);}})();
  loadingPython.set(key,load);return load;
}
const visiblePython = new Set<{source:string;result:PythonResult;context?:PythonContext}>();
export function retainVisiblePython(source:string,result:PythonResult,context?:PythonContext){const record={source,result,context};visiblePython.add(record);return()=>{visiblePython.delete(record);};}
export async function pythonOutput(source:string,context?:PythonContext):Promise<PythonResult|undefined> {for(const entry of visiblePython)if(entry.source===source&&storageKey(entry.source,entry.context)===storageKey(source,context))return entry.result;return loadPythonOutput(source,context);}
export function remember<T>(map: Map<string, T>, key: string, value: T) {
  map.delete(key);map.set(key, value);
  if (map === pythonResults || map === scopedPythonResults) {
    // Images dominate retained memory. Sixty base64 figures can otherwise
    // retain gigabytes after their tabs have closed. Current visible results
    // stay owned by PythonCell; this cap only evicts optional redisplay cache.
    const cost=(source:string,result:PythonResult)=>2*(source.length+result.stdout.length+result.stderr.length+result.images.reduce((n,image)=>n+image.length,0));
    let bytes=[...pythonResults].reduce((n,[source,result])=>n+cost(source,result),0)+[...scopedPythonResults].reduce((n,[key,result])=>n+cost(key,result),0);
    for(const mapEntry of [[pythonResults,[...pythonResults]],[scopedPythonResults,[...scopedPythonResults]]] as const)for(const [source,result] of mapEntry[1]){if(bytes<=16_000_000 && pythonResults.size+scopedPythonResults.size<=60)break;mapEntry[0].delete(source);bytes-=cost(source,result);if(mapEntry[0]===scopedPythonResults){scopedPythonContexts.delete(source);scopedPythonSources.delete(source);forgetPythonStored(source);}}
  } else {
    // Slider metadata is small. Retain graph states without keeping rendered
    // geometry, so scrolling through a large note doesn't reset its graphs.
    let bytes=[...map].reduce((size,[source,data])=>size+2*(source.length+JSON.stringify(data).length),0);
    for(const [source,data] of map){if(bytes<=4_000_000&&map.size<=5000)break;map.delete(source);bytes-=2*(source.length+JSON.stringify(data).length);}
  }
}

export function exportRenderedViews(content: string) {
  const selected = <T,>(map: Map<string, T>) => [...map].filter(([key]) => content.includes(key));
  const pythonScoped=[...scopedPythonResults].flatMap(([key,value])=>{
    const source=scopedPythonSources.get(key),context=scopedPythonContexts.get(key);
    return source&&context&&content.includes(source)&&verifiedProvenance(value.provenance,context)?[[source,context,value] as [string,PythonContext,PythonResult]]:[];
  });
  const result = {values:selected(chartValues), zooms:selected(chartZooms), centers:selected(chartCenters), grids:selected(chartGrids), python:selected(pythonResults),pythonScoped};
  // Avoid carrying huge derived images through the UI bridge. This is optional
  // runtime state, not source/assets, and never executes Python on restore.
  if (JSON.stringify(result).length > 8_000_000) {result.python = [];result.pythonScoped=[];}
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
  if(Array.isArray(data.python))for(const pair of data.python.slice(0,60))if(Array.isArray(pair)&&typeof pair[0]==='string'&&content.includes(pair[0])&&validPython(pair[1]))rememberPythonOutput(pair[0],{...pair[1],provenance:{verified:false,reason:'Unscoped legacy output'}});
  if(Array.isArray(data.pythonScoped))for(const entry of data.pythonScoped.slice(0,60)){
    if(!Array.isArray(entry)||typeof entry[0]!=='string'||!content.includes(entry[0]))continue;
    const context=entry[1] as PythonContext,result=entry[2] as PythonResult;
    if(!context||typeof context.document!=='string'||typeof context.cell!=='string'||typeof context.interpreter!=='string'||!verifiedProvenance(result?.provenance,context)||!validPython(result))continue;
    rememberPythonOutput(entry[0],result,context);markPythonStored(entry[0],context);
  }
}
