import {expect,test} from 'vitest';
import {recordHistory,replayHistory,historySize,validHistory,type NoteHistory} from './noteHistory';
test('typing in a huge note stores tiny edits and preserves grouped undo/redo',()=>{
  const original='# Huge note\n'+'Content '.repeat(500_000),h:NoteHistory={undo:[],redo:[],last:0};let content=original;
  for(let i=0;i<100;i++){const next=content+'x';recordHistory(h,content,next,1000+i*10);content=next;}
  expect(historySize(h)).toBeLessThan(4000);expect(h.undo).toHaveLength(1);expect(validHistory(h)).toBe(true);
  expect(replayHistory(h,content,'undo')).toBe(original);expect(replayHistory(h,original,'redo')).toBe(content);
});
test('replacement/deletion and legacy transferred snapshots remain reversible',()=>{
  const h:NoteHistory={undo:[],redo:[],last:0};const original='😀 A note with $x^2$';const changed='😀 A note with $y^3$';
  recordHistory(h,original,changed,1000);recordHistory(h,changed,'😀 A note',2000);
  expect(replayHistory(h,'😀 A note','undo')).toBe(changed);expect(replayHistory(h,changed,'undo')).toBe(original);
  expect(replayHistory(h,original,'redo')).toBe(changed);expect(replayHistory(h,changed,'redo')).toBe('😀 A note');
  const legacy:NoteHistory={undo:[original],redo:[],last:0};expect(replayHistory(legacy,changed,'undo')).toBe(original);expect(replayHistory(legacy,original,'redo')).toBe(changed);
});
test('a large replacement is still undoable rather than silently losing all history',()=>{
  const original='a'.repeat(2_100_000),h:NoteHistory={undo:[],redo:[],last:0};recordHistory(h,original,'replacement');
  expect(h.undo).toHaveLength(1);expect(replayHistory(h,'replacement','undo')).toBe(original);
  expect(validHistory({undo:[[{from:-1,remove:1,insert:''}]],redo:[]})).toBe(false);
});
