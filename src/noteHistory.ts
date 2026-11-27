/** Cross-mode undo stores changed ranges, not a full multi-megabyte note for
 * every keystroke. CodeMirror's persistent history remains a compatibility path. */
export interface TextEdit {from:number;remove:number;insert:string}
export type HistoryEntry=string|TextEdit[]; // Accept older window transfers.
export interface NoteHistory {undo:HistoryEntry[];redo:HistoryEntry[];last:number}
export const MAX_HISTORY_ENTRIES=60;
export const MAX_HISTORY_EDITS=10_000;
export const MAX_GROUP_COST=500_000;
export const MAX_HISTORY_STACK_COST=2_000_000;
export const MAX_TRANSFERRED_HISTORY_COST=4_000_000;
export const MAX_SINGLE_STEP_COST=20_000_024;
export const MAX_CACHED_HISTORIES=40;
const entryCosts=new WeakMap<TextEdit[],number>();
const entryInverseCosts=new WeakMap<TextEdit[],number>();
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
function groupInverseCost(entry:TextEdit[]):number {
  const cached=entryInverseCosts.get(entry);if(cached!==undefined)return cached;
  let size=0;for(let i=0;i<entry.length;i++)size+=entry[i].remove+24;
  entryInverseCosts.set(entry,size);
  return size;
}
function stackCost(entries:HistoryEntry[]):number {
  let size=0;
  for(let i=0;i<entries.length;i++)size+=historyCost(entries[i]);
  return size;
}
function trimStack(entries:HistoryEntry[],cost=stackCost(entries)):number {
  while(entries.length>1&&(entries.length>MAX_HISTORY_ENTRIES||cost>MAX_HISTORY_STACK_COST))cost-=historyCost(entries.shift()!);
  return cost;
}
function isValidHistoryEntry(entry:unknown):entry is HistoryEntry {
  return typeof entry==='string'||Array.isArray(entry)&&entry.length<=MAX_HISTORY_EDITS&&entry.every(edit=>edit&&Number.isSafeInteger(edit.from)&&edit.from>=0&&Number.isSafeInteger(edit.remove)&&edit.remove>=0&&typeof edit.insert==='string');
}
function cloneHistoryEntry(entry:HistoryEntry):HistoryEntry {
  if(typeof entry==='string')return entry;
  let cost=0,inverseCost=0;
  const copy=new Array<TextEdit>(entry.length);
  for(let i=0;i<entry.length;i++){
    const edit=entry[i];
    copy[i]={from:edit.from,remove:edit.remove,insert:edit.insert};
    cost+=edit.insert.length+24;
    inverseCost+=edit.remove+24;
  }
  entryCosts.set(copy,cost);
  entryInverseCosts.set(copy,inverseCost);
  return copy;
}
export function historySize(history:NoteHistory):number {
  return stackCost(history.undo)+stackCost(history.redo);
}
export function recordHistory(history:NoteHistory,before:string,after:string,now=Date.now()):void {
  const edit=textEdit(after,before),editCost=edit.insert.length+24,editInverseCost=edit.remove+24;
  history.redo=[];
  if(editCost>MAX_SINGLE_STEP_COST){
    // Skipping the newest transition invalidates older relative offsets on undo.
    history.undo=[];history.last=0;return;
  }
  const last=history.undo.at(-1);
  let coalesced=false;
  // Transferred history validation caps each edit group in edit count and total
  // character cost. Start another group before forward or inverse cost reaches
  // MAX_GROUP_COST so long uninterrupted typing or deletion stays bounded.
  if(now-history.last<=600&&Math.abs(after.length-before.length)<=1&&Array.isArray(last)&&last.length>0&&last.length<MAX_HISTORY_EDITS){
    const prior=last.at(-1)!,prevCost=historyCost(last),prevInverseCost=groupInverseCost(last);
    if(!prior.insert&&!edit.insert&&edit.from===prior.from+prior.remove){
      const nextInverseCost=prevInverseCost+edit.remove;
      if(prevCost<=MAX_GROUP_COST&&nextInverseCost<=MAX_GROUP_COST){
        prior.remove+=edit.remove;entryCosts.set(last,prevCost);entryInverseCosts.set(last,nextInverseCost);coalesced=true;
      }
    } else if(!prior.remove&&!edit.remove&&edit.from+edit.insert.length===prior.from){
      const nextCost=prevCost+edit.insert.length;
      if(nextCost<=MAX_GROUP_COST&&prevInverseCost<=MAX_GROUP_COST){
        prior.from=edit.from;prior.insert=edit.insert+prior.insert;entryCosts.set(last,nextCost);entryInverseCosts.set(last,prevInverseCost);coalesced=true;
      }
    } else {
      const nextCost=prevCost+editCost,nextInverseCost=prevInverseCost+editInverseCost;
      if(nextCost<=MAX_GROUP_COST&&nextInverseCost<=MAX_GROUP_COST){
        last.push(edit);entryCosts.set(last,nextCost);entryInverseCosts.set(last,nextInverseCost);coalesced=true;
      }
    }
  }
  if(!coalesced){
    const group=[edit];entryCosts.set(group,editCost);entryInverseCosts.set(group,editInverseCost);history.undo.push(group);
  }
  history.last=now;
  if(history.undo.length<=1)return;
  // Keep the newest edit undoable (up to MAX_SINGLE_STEP_COST) even if it replaces a very large document.
  trimStack(history.undo);
}
export function replayHistory(history:NoteHistory,current:string,direction:'undo'|'redo'):string|undefined {
  const source=history[direction],entry=source.pop();if(entry===undefined)return;
  const target=history[direction==='undo'?'redo':'undo'];
  let inverse:TextEdit[]=[];let inverseCost=0,inverseReverseCost=0,exceeded=false;
  if(typeof entry==='string'){
    const edit=textEdit(entry,current);
    inverseCost=edit.insert.length+24;
    if(inverseCost>MAX_SINGLE_STEP_COST)exceeded=true;
    else{inverse=[edit];inverseReverseCost=edit.remove+24;}
    current=entry;
  } else for(let i=entry.length-1;i>=0;i--) {
    const edit=entry[i],removedLen=Math.max(0,Math.min(edit.remove,current.length-edit.from));
    inverseCost+=removedLen+24;
    if(inverseCost>MAX_SINGLE_STEP_COST)exceeded=true;
    if(!exceeded){
      const removed=current.slice(edit.from,edit.from+edit.remove);
      inverse.push({from:edit.from,remove:edit.insert.length,insert:removed});
      inverseReverseCost+=edit.insert.length+24;
    }
    current=current.slice(0,edit.from)+edit.insert+current.slice(edit.from+edit.remove);
  }
  history.last=0;
  trimStack(source);
  if(source.length===1&&historyCost(source[0])>MAX_SINGLE_STEP_COST)source.length=0;
  if(exceeded){target.length=0;return current;}
  entryCosts.set(inverse,inverseCost);
  entryInverseCosts.set(inverse,inverseReverseCost);
  target.push(inverse);
  trimStack(target);
  return current;
}
export function validHistory(value:unknown):value is NoteHistory {
  if(!value||typeof value!=='object')return false;
  const h=value as NoteHistory;
  return [h.undo,h.redo].every(list=>Array.isArray(list)&&list.length<=MAX_HISTORY_ENTRIES&&list.every(isValidHistoryEntry))&&historySize(h)<=MAX_TRANSFERRED_HISTORY_COST;
}
export function transferHistory(value:unknown):NoteHistory|undefined {
  if(!value||typeof value!=='object')return undefined;
  const raw=value as Partial<NoteHistory>;
  if(!Array.isArray(raw.undo)||!Array.isArray(raw.redo))return undefined;
  if(!raw.undo.every(isValidHistoryEntry)||!raw.redo.every(isValidHistoryEntry))return undefined;
  const undo=raw.undo.slice(-MAX_HISTORY_ENTRIES).map(cloneHistoryEntry);
  const redo=raw.redo.slice(-MAX_HISTORY_ENTRIES).map(cloneHistoryEntry);
  // Each stack replays outward from `current`, so if its newest entry exceeds
  // the strict transfer limit, that stack cannot be transferred; the opposite
  // stack starts from `current` independently and remains eligible.
  if(undo.length>0&&historyCost(undo.at(-1)!)>MAX_TRANSFERRED_HISTORY_COST)undo.length=0;
  if(redo.length>0&&historyCost(redo.at(-1)!)>MAX_TRANSFERRED_HISTORY_COST)redo.length=0;
  let undoCost=stackCost(undo),redoCost=stackCost(redo);
  while(undoCost+redoCost>MAX_TRANSFERRED_HISTORY_COST&&(undo.length>1||redo.length>1)){
    if(redo.length>1&&(undo.length<=1||redoCost>=undoCost))redoCost-=historyCost(redo.shift()!);
    else undoCost-=historyCost(undo.shift()!);
  }
  if(undoCost+redoCost>MAX_TRANSFERRED_HISTORY_COST){
    redo.length=0;redoCost=0;
  }
  if(undo.length===0&&redo.length===0)return undefined;
  return {undo,redo,last:0};
}
export function trimHistoryCache(histories:Map<string,NoteHistory>,activeId:string):void {
  let inactiveRetained=0;
  for(const [id,cached] of [...histories.entries()]){
    if(id===activeId)continue;
    if(historySize(cached)>MAX_TRANSFERRED_HISTORY_COST){
      const trimmed=transferHistory(cached);
      if(trimmed){histories.set(id,trimmed);inactiveRetained+=historySize(trimmed);}
      else histories.delete(id);
    } else {
      inactiveRetained+=historySize(cached);
    }
  }
  const activeHistory=histories.get(activeId);
  const activeCharge=activeHistory?Math.min(historySize(activeHistory),MAX_HISTORY_STACK_COST):0;
  const inactiveBudget=MAX_TRANSFERRED_HISTORY_COST-activeCharge;
  for(const [id,cached] of histories.entries()){
    if(histories.size<=MAX_CACHED_HISTORIES&&inactiveRetained<=inactiveBudget)break;
    if(id===activeId)continue;
    histories.delete(id);
    inactiveRetained-=historySize(cached);
  }
}
