import type {WritingIssue,WritingOptions} from "./proofreadingCore";
export type {WritingIssue,WritingOptions} from "./proofreadingCore";
let worker:Worker|undefined,sequence=0,idle:ReturnType<typeof setTimeout>|undefined;
const pending=new Map<number,(value:WritingIssue[])=>void>();
const stop=()=>{clearTimeout(idle);idle=undefined;worker?.terminate();worker=undefined;for(const resolve of pending.values())resolve([]);pending.clear();};
const scheduleIdle=()=>{clearTimeout(idle);idle=undefined;if(pending.size===0)idle=setTimeout(stop,45_000);};
export function checkWriting(text:string,options:WritingOptions,blocked:Array<[number,number]>=[]):Promise<WritingIssue[]> {
  if(!options.spellCheck&&!options.grammarCheck||typeof Worker==="undefined")return Promise.resolve([]);
  if(!worker){
    const owner=new Worker(new URL("./proofreading.worker.ts",import.meta.url),{type:"module"});worker=owner;
    owner.onmessage=event=>{if(worker!==owner)return;const {id,issues}=event.data;pending.get(id)?.(issues);pending.delete(id);scheduleIdle();};
    owner.onerror=()=>{if(worker===owner)stop();};
  }
  // Dictionary startup and queued checks are active work, not idle time. A
  // slow device must not silently receive an empty result after 45 seconds.
  clearTimeout(idle);idle=undefined;
  const id=++sequence;
  return new Promise(resolve=>{pending.set(id,resolve);worker!.postMessage({id,text:text.slice(0,12_000),options,blocked});});
}
