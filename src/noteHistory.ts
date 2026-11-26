/** Cross-mode undo stores changed ranges, not a full multi-megabyte note for
 * every keystroke. CodeMirror's persistent history remains a compatibility path. */
export interface TextEdit {from:number;remove:number;insert:string}
export type HistoryEntry=string|TextEdit[]; // Accept older window transfers.
export interface NoteHistory {undo:HistoryEntry[];redo:HistoryEntry[];last:number}
export interface LiveHistoryEditMeta {historyDirection?:'undo'|'redo';isolateHistory?:boolean}
const MAX_HISTORY_EDITS=10_000;
const MAX_RECONCILE_STEPS=512;
const entryCosts=new WeakMap<TextEdit[],number>();
let liveTextareaHistoryRunner:((direction:'undo'|'redo')=>boolean)|null=null;
export function registerLiveTextareaHistory(runner:((direction:'undo'|'redo')=>boolean)|null):()=>void {
  liveTextareaHistoryRunner=runner;
  return()=>{if(liveTextareaHistoryRunner===runner)liveTextareaHistoryRunner=null;};
}
export function tryLiveTextareaHistory(direction:'undo'|'redo'):boolean {
  return liveTextareaHistoryRunner?liveTextareaHistoryRunner(direction):false;
}
function setGroupCost(group:TextEdit[]):void {
  let size=0;for(let i=0;i<group.length;i++)size+=group[i].insert.length+24;
  entryCosts.set(group,size);
}
function applyEntry(current:string,entry:HistoryEntry):string {
  if(typeof entry==='string')return entry;
  for(let i=entry.length-1;i>=0;i--){
    const edit=entry[i];
    current=current.slice(0,edit.from)+edit.insert+current.slice(edit.from+edit.remove);
  }
  return current;
}
export function textEdit(before:string,after:string):TextEdit {
  if(after.startsWith(before))return {from:before.length,remove:0,insert:after.slice(before.length)};
  if(before.startsWith(after))return {from:after.length,remove:before.length-after.length,insert:''};
  let from=0,end=0;
  while(from<before.length&&from<after.length&&before.charCodeAt(from)===after.charCodeAt(from))from++;
  if(before.length<=after.length&&after.endsWith(from===0?before:before.slice(from)))return {from,remove:0,insert:after.slice(from,after.length-(before.length-from))};
  if(after.length<before.length&&before.endsWith(from===0?after:after.slice(from)))return {from,remove:before.length-after.length,insert:''};
  while(end<before.length-from&&end<after.length-from&&before.charCodeAt(before.length-1-end)===after.charCodeAt(after.length-1-end))end++;
  return {from,remove:before.length-from-end,insert:after.slice(from,after.length-end)};
}
export function historyCost(entry:HistoryEntry):number {
  if(typeof entry==='string')return entry.length;
  const cached=entryCosts.get(entry);if(cached!==undefined)return cached;
  let size=0;for(let i=0;i<entry.length;i++)size+=entry[i].insert.length+24;
  return size;
}
export function historySize(history:NoteHistory):number {
  let size=0;
  for(let i=0;i<history.undo.length;i++)size+=historyCost(history.undo[i]);
  for(let i=0;i<history.redo.length;i++)size+=historyCost(history.redo[i]);
  return size;
}
export function recordHistory(history:NoteHistory,before:string,after:string,now=Date.now(),options?:{isolate?:boolean}):void {
  const edit=textEdit(after,before),last=history.undo.at(-1),isolate=Boolean(options?.isolate);
  // Transferred history validation caps each edit group. Start another group
  // before this one reaches that bound so long uninterrupted typing remains
  // undoable after session restore.
  if(isolate||now-history.last>600||Math.abs(after.length-before.length)>1||!Array.isArray(last)||last.length>=MAX_HISTORY_EDITS){
    const group=[edit];entryCosts.set(group,edit.insert.length+24);history.undo.push(group);
  } else {
    const prior=last.at(-1)!,prevCost=historyCost(last);
    if(!prior.insert&&!edit.insert&&edit.from===prior.from+prior.remove){prior.remove+=edit.remove;entryCosts.set(last,prevCost);}
    else if(!prior.remove&&!edit.remove&&edit.from+edit.insert.length===prior.from){prior.from=edit.from;prior.insert=edit.insert+prior.insert;entryCosts.set(last,prevCost+edit.insert.length);}
    else {last.push(edit);entryCosts.set(last,prevCost+edit.insert.length+24);}
  }
  history.redo=[];history.last=isolate?0:now;
  if(history.undo.length<=1)return;
  // Keep the newest edit undoable even if it replaces a very large document.
  let cost=historySize(history);
  while(history.undo.length>1&&(history.undo.length>60||cost>2_000_000))cost-=historyCost(history.undo.shift()!);
}
export function reconcileHistory(history:NoteHistory,before:string,after:string,direction:'undo'|'redo'):void {
  if(before===after)return;
  const source=history[direction],target=history[direction==='undo'?'redo':'undo'];
  const pushTarget=(fromDoc:string,toDoc:string)=>{
    const inverseEdit=textEdit(fromDoc,toDoc),inverseGroup=[inverseEdit];
    entryCosts.set(inverseGroup,inverseEdit.insert.length+24);
    target.push(inverseGroup);
    history.last=0;
    let cost=historySize(history);
    while(target.length>1&&(target.length>60||cost>2_000_000))cost-=historyCost(target.shift()!);
    while(cost>4_000_000&&source.length>0&&target.length>0)cost-=historyCost(source.shift()!);
  };
  let cursor=before,steps=0;
  for(let g=source.length-1;g>=0&&steps<MAX_RECONCILE_STEPS;g--){
    const entry=source[g];
    if(typeof entry==='string'){
      steps++;
      if(entry===after){source.length=g;pushTarget(after,before);return;}
      cursor=entry;
      continue;
    }
    for(let i=entry.length-1;i>=0&&steps<MAX_RECONCILE_STEPS;i--){
      steps++;
      const edit=entry[i];
      const nextCursor=cursor.slice(0,edit.from)+edit.insert+cursor.slice(edit.from+edit.remove);
      if(nextCursor===after){
        if(i===0)source.length=g;
        else{const remaining=entry.slice(0,i);setGroupCost(remaining);source.length=g+1;source[g]=remaining;}
        pushTarget(after,before);
        return;
      }
      if(!edit.insert&&edit.remove>1){
        const kept=edit.remove-(cursor.length-after.length);
        if(kept>0&&kept<edit.remove&&(
          cursor.slice(0,edit.from+kept)+cursor.slice(edit.from+edit.remove)===after||
          cursor.slice(0,edit.from)+cursor.slice(edit.from+edit.remove-kept)===after
        )){
          const remaining=[...entry.slice(0,i),{from:edit.from,remove:kept,insert:''}];
          setGroupCost(remaining);source.length=g+1;source[g]=remaining;
          pushTarget(after,before);
          return;
        }
      }else if(!edit.remove&&edit.insert.length>1){
        const restored=after.length-cursor.length;
        if(restored>0&&restored<edit.insert.length){
          if(cursor.slice(0,edit.from)+edit.insert.slice(0,restored)+cursor.slice(edit.from)===after){
            const remaining=[...entry.slice(0,i),{from:edit.from+restored,remove:0,insert:edit.insert.slice(restored)}];
            setGroupCost(remaining);source.length=g+1;source[g]=remaining;
            pushTarget(after,before);
            return;
          }
          if(cursor.slice(0,edit.from)+edit.insert.slice(edit.insert.length-restored)+cursor.slice(edit.from)===after){
            const remaining=[...entry.slice(0,i),{from:edit.from,remove:0,insert:edit.insert.slice(0,edit.insert.length-restored)}];
            setGroupCost(remaining);source.length=g+1;source[g]=remaining;
            pushTarget(after,before);
            return;
          }
        }
      }
      cursor=nextCursor;
    }
  }
  if(source.length>0){
    const topGroupStart=applyEntry(before,source.pop()!);
    if(after!==topGroupStart){
      const remEdit=textEdit(after,topGroupStart),remGroup=[remEdit];
      entryCosts.set(remGroup,remEdit.insert.length+24);
      source.push(remGroup);
    }
  }
  pushTarget(after,before);
}
export function applyHistoryEdit(history:NoteHistory,before:string,after:string,now=Date.now(),meta?:LiveHistoryEditMeta):void {
  if(before===after)return;
  if(meta?.historyDirection){reconcileHistory(history,before,after,meta.historyDirection);return;}
  recordHistory(history,before,after,now,meta?.isolateHistory?{isolate:true}:undefined);
}
export function replayHistory(history:NoteHistory,current:string,direction:'undo'|'redo'):string|undefined {
  const entry=history[direction].pop();if(entry===undefined)return;
  const inverse:TextEdit[]=[];let inverseCost=0;
  if(typeof entry==='string'){const edit=textEdit(entry,current);inverse.push(edit);inverseCost=edit.insert.length+24;current=entry;}
  else for(let i=entry.length-1;i>=0;i--) {
    const edit=entry[i],removed=current.slice(edit.from,edit.from+edit.remove);
    inverse.push({from:edit.from,remove:edit.insert.length,insert:removed});
    inverseCost+=removed.length+24;
    current=current.slice(0,edit.from)+edit.insert+current.slice(edit.from+edit.remove);
  }
  entryCosts.set(inverse,inverseCost);
  history[direction==='undo'?'redo':'undo'].push(inverse);history.last=0;return current;
}
export function validHistory(value:unknown):value is NoteHistory {
  if(!value||typeof value!=='object')return false;
  const h=value as NoteHistory;
  return [h.undo,h.redo].every(list=>Array.isArray(list)&&list.length<=60&&list.every(entry=>typeof entry==='string'||Array.isArray(entry)&&entry.length<=MAX_HISTORY_EDITS&&entry.every(edit=>edit&&Number.isSafeInteger(edit.from)&&edit.from>=0&&Number.isSafeInteger(edit.remove)&&edit.remove>=0&&typeof edit.insert==='string')))&&historySize(h)<=4_000_000;
}
