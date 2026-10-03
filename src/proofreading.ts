import type {WritingIssue,WritingOptions} from "./proofreadingCore";
export type {WritingIssue,WritingOptions} from "./proofreadingCore";
let worker:Worker|undefined,sequence=0,idle:ReturnType<typeof setTimeout>|undefined;
const pending=new Map<number,(value:WritingIssue[])=>void>();
const stop=()=>{worker?.terminate();worker=undefined;for(const resolve of pending.values())resolve([]);pending.clear();};
export function checkWriting(text:string,options:WritingOptions,blocked:Array<[number,number]>=[]):Promise<WritingIssue[]> {
  if(!options.spellCheck&&!options.grammarCheck||typeof Worker==="undefined")return Promise.resolve([]);
  if(!worker){worker=new Worker(new URL("./proofreading.worker.ts",import.meta.url),{type:"module"});worker.onmessage=event=>{const {id,issues}=event.data;pending.get(id)?.(issues);pending.delete(id);};worker.onerror=stop;}
  clearTimeout(idle);idle=setTimeout(stop,45_000);
  const id=++sequence;
  return new Promise(resolve=>{pending.set(id,resolve);worker!.postMessage({id,text:text.slice(0,12_000),options,blocked});});
}
