/** Small persistent location index: source offsets and geometry, never note text. */
export interface ReadingLocation { top:number; offset:number; zoom:number; mode:string }
const KEY='supermd.reading-locations.v1';
const valid=(value:unknown):value is ReadingLocation=>{
  const v=value as ReadingLocation;
  return !!v && Number.isFinite(v.top) && v.top>=0 && Number.isFinite(v.offset) && v.offset>=0 && Number.isFinite(v.zoom) && v.zoom>0 && typeof v.mode==='string';
};
export function loadReadingLocation(path:string|null):ReadingLocation|undefined {
  if(!path)return;
  try { const value=JSON.parse(localStorage.getItem(KEY)||'[]').find((entry:unknown[])=>Array.isArray(entry)&&entry[0]===path)?.[1];return valid(value)?value:undefined; } catch { return; }
}
export function saveReadingLocation(path:string|null,location:ReadingLocation):void {
  if(!path||!valid(location))return;
  try {
    const old:unknown=JSON.parse(localStorage.getItem(KEY)||'[]');
    const entries=Array.isArray(old)?old.filter(entry=>Array.isArray(entry)&&typeof entry[0]==='string'&&entry[0]!==path&&valid(entry[1])):[];
    localStorage.setItem(KEY,JSON.stringify([[path,location],...entries].slice(0,200)));
  } catch { /* A private/full store must never prevent reading or editing. */ }
}
