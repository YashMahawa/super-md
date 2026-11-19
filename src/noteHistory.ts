/** Cross-mode undo stores changed ranges, not a full multi-megabyte note for
 * every keystroke. CodeMirror's persistent history remains a compatibility path. */
export interface TextEdit {from:number;remove:number;insert:string}
export type HistoryEntry=string|TextEdit[]; // Accept older window transfers.
export interface NoteHistory {undo:HistoryEntry[];redo:HistoryEntry[];last:number}
const MAX_HISTORY_EDITS=10_000;
export function textEdit(before:string,after:string):TextEdit {
  if(after.startsWith(before))return {from:before.length,remove:0,insert:after.slice(before.length)};
  if(before.startsWith(after))return {from:after.length,remove:before.length-after.length,insert:''};
  let from=0,end=0;
  while(from<before.length&&from<after.length&&before.charCodeAt(from)===after.charCodeAt(from))from++;
  if(from===0&&after.endsWith(before))return {from:0,remove:0,insert:after.slice(0,after.length-before.length)};
  if(from===0&&before.endsWith(after))return {from:0,remove:before.length-after.length,insert:''};
  while(end<before.length-from&&end<after.length-from&&before.charCodeAt(before.length-1-end)===after.charCodeAt(after.length-1-end))end++;
  return {from,remove:before.length-from-end,insert:after.slice(from,after.length-end)};
}
export function historyCost(entry:HistoryEntry):number {
  if(typeof entry==='string')return entry.length;
  let size=0;
  for(let i=0;i<entry.length;i++)size+=entry[i].insert.length+24;
  return size;
}
export function historySize(history:NoteHistory):number {
  let size=0;
  for(let i=0;i<history.undo.length;i++)size+=historyCost(history.undo[i]);
  for(let i=0;i<history.redo.length;i++)size+=historyCost(history.redo[i]);
  return size;
}
export function recordHistory(history:NoteHistory,before:string,after:string,now=Date.now()):void {
  const edit=textEdit(after,before),last=history.undo.at(-1);
  // Transferred history validation caps each edit group. Start another group
  // before this one reaches that bound so long uninterrupted typing remains
  // undoable after session restore.
  if(now-history.last>600||Math.abs(after.length-before.length)>1||!Array.isArray(last)||last.length>=MAX_HISTORY_EDITS)history.undo.push([edit]);
  else {
    const prior=last.at(-1)!;
    if(!prior.insert&&!edit.insert&&edit.from===prior.from+prior.remove)prior.remove+=edit.remove;
    else if(!prior.remove&&!edit.remove&&edit.from+edit.insert.length===prior.from){prior.from=edit.from;prior.insert=edit.insert+prior.insert;}
    else last.push(edit);
  }
  history.redo=[];history.last=now;
  // Keep the newest edit undoable even if it replaces a very large document.
  if(history.undo.length>1) {
    while(history.undo.length>60)history.undo.shift();
    if(history.undo.length>1) {
      let cost=historySize(history);
      while(history.undo.length>1&&cost>2_000_000)cost-=historyCost(history.undo.shift()!);
    }
  }
}
export function replayHistory(history:NoteHistory,current:string,direction:'undo'|'redo'):string|undefined {
  const entry=history[direction].pop();if(entry===undefined)return;
  const inverse:TextEdit[]=[];
  if(typeof entry==='string'){inverse.push(textEdit(entry,current));current=entry;}
  else for(const edit of [...entry].reverse()) {
    inverse.push({from:edit.from,remove:edit.insert.length,insert:current.slice(edit.from,edit.from+edit.remove)});
    current=current.slice(0,edit.from)+edit.insert+current.slice(edit.from+edit.remove);
  }
  history[direction==='undo'?'redo':'undo'].push(inverse);history.last=0;return current;
}
export function validHistory(value:unknown):value is NoteHistory {
  if(!value||typeof value!=='object')return false;
  const h=value as NoteHistory;
  return [h.undo,h.redo].every(list=>Array.isArray(list)&&list.length<=60&&list.every(entry=>typeof entry==='string'||Array.isArray(entry)&&entry.length<=MAX_HISTORY_EDITS&&entry.every(edit=>edit&&Number.isSafeInteger(edit.from)&&edit.from>=0&&Number.isSafeInteger(edit.remove)&&edit.remove>=0&&typeof edit.insert==='string')))&&historySize(h)<=4_000_000;
}
