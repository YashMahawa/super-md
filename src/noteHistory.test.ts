import {expect,test} from 'vitest';
import {applyHistoryEdit,recordHistory,reconcileHistory,replayHistory,historySize,validHistory,type NoteHistory} from './noteHistory';
test('typing in a huge note stores tiny edits and preserves grouped undo/redo',()=>{
  const original='# Huge note\n'+'Content '.repeat(500_000),h:NoteHistory={undo:[],redo:[],last:0};let content=original;
  for(let i=0;i<100;i++){const next=content+'x';recordHistory(h,content,next,1000+i*10);content=next;}
  expect(historySize(h)).toBeLessThan(4000);expect(h.undo).toHaveLength(1);expect(validHistory(h)).toBe(true);
  expect(replayHistory(h,content,'undo')).toBe(original);expect(replayHistory(h,original,'redo')).toBe(content);
// Keep the full 4 MB / 100-keystroke correctness workload on slower CI hosts.
// This is not a latency benchmark: concurrent renderer tests can delay it.
},30_000);
test('splits a long coalesced typing run before transfer validation rejects it',()=>{
  const h:NoteHistory={undo:[],redo:[],last:0};let content='',afterFirstGroup='';
  for(let i=0;i<10_025;i++){const next=(i%2?'x':'y')+content;recordHistory(h,content,next,1000+i);content=next;if(i===9_999)afterFirstGroup=content;}
  expect(h.undo).toHaveLength(2);
  expect((h.undo[0] as unknown[]).length).toBe(10_000);
  expect((h.undo[1] as unknown[]).length).toBe(25);
  expect(validHistory(h)).toBe(true);
  const beforeFinalGroup=replayHistory(h,content,'undo');
  expect(beforeFinalGroup).toBe(afterFirstGroup);
  expect(validHistory(h)).toBe(true);
  const original=replayHistory(h,beforeFinalGroup!,'undo');
  expect(original).toBe('');
  expect(validHistory(h)).toBe(true);
  const afterFirstRedo=replayHistory(h,original!,'redo');
  expect(afterFirstRedo).toBe(afterFirstGroup);
  const restored=replayHistory(h,afterFirstRedo!,'redo');
  expect(restored).toBe(content);
  expect(validHistory(h)).toBe(true);
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
test('interior insertions, deletions, and cost eviction match uncached historySize',()=>{
  const seed:NoteHistory={undo:[],redo:[],last:0};
  recordHistory(seed,'alpha gamma','alpha old gamma',1000);
  const h:NoteHistory={undo:structuredClone(seed.undo),redo:[],last:1000};
  recordHistory(h,'alpha old gamma','alpha oldx gamma',1100);
  recordHistory(h,'alpha oldx gamma','alpha oldxy gamma',1150);
  recordHistory(h,'alpha oldxy gamma','alpha oldx gamma',1200);
  recordHistory(h,'alpha oldx gamma','alpha old gamma',1250);
  expect(historySize(h)).toBe(historySize({undo:structuredClone(h.undo),redo:structuredClone(h.redo),last:0}));
  expect(replayHistory(h,'alpha old gamma','undo')).toBe('alpha gamma');
  expect(historySize(h)).toBe(historySize({undo:structuredClone(h.undo),redo:structuredClone(h.redo),last:0}));
  expect(replayHistory(h,'alpha gamma','redo')).toBe('alpha old gamma');
  expect(historySize(h)).toBe(historySize({undo:structuredClone(h.undo),redo:structuredClone(h.redo),last:0}));
  const evicted:NoteHistory={undo:[],redo:[],last:0};
  recordHistory(evicted,'x'.repeat(1_500_000),'short',1000);
  recordHistory(evicted,'short','y'.repeat(1_500_000),2000);
  expect(evicted.undo).toHaveLength(2);
  recordHistory(evicted,'y'.repeat(1_500_000),'z'.repeat(2_100_000),3000);
  expect(evicted.undo).toHaveLength(2);
  recordHistory(evicted,'z'.repeat(2_100_000),'final',4000);
  expect(evicted.undo).toHaveLength(1);
  expect(replayHistory(evicted,'final','undo')).toBe('z'.repeat(2_100_000));
});
test('reconcileHistory syncs native textarea undo/redo across exact, multi-group, and coalesced steps',()=>{
  const h:NoteHistory={undo:[],redo:[],last:0};
  // Seed an earlier block edit so we verify earlier undo entries remain intact.
  const d0='# Heading\n\nAlpha\n\nBeta';
  const d1='# Heading\n\nAlpha 1\n\nBeta';
  recordHistory(h,d0,d1,1000);

  // Coalesced typing run in Block 2: "Beta" -> "Beta world"
  let current=d1;
  for(const [idx,ch] of [...' world'].entries()){
    const next=current+ch;
    recordHistory(h,current,next,2000+idx*40);
    current=next;
  }
  expect(current).toBe('# Heading\n\nAlpha 1\n\nBeta world');
  expect(h.undo).toHaveLength(2);

  // Partial native undo ("Beta world" -> "Beta ") splits the coalesced group cleanly.
  const partial='# Heading\n\nAlpha 1\n\nBeta ';
  reconcileHistory(h,current,partial,'undo');
  expect(validHistory(h)).toBe(true);
  expect(historySize(h)).toBe(historySize({undo:structuredClone(h.undo),redo:structuredClone(h.redo),last:0}));

  // Leaving the block and redoing restores "Beta world"; undoing twice crosses back to d1 then d0.
  expect(replayHistory(h,partial,'redo')).toBe(current);
  reconcileHistory(h,current,partial,'undo');
  expect(replayHistory(h,partial,'undo')).toBe(d1);
  expect(replayHistory(h,d1,'undo')).toBe(d0);
  expect(replayHistory(h,d0,'redo')).toBe(d1);
  expect(replayHistory(h,d1,'redo')).toBe(partial);
  expect(replayHistory(h,partial,'redo')).toBe(current);

  // Multi-group native undo (two >600ms groups undone in one native textarea step) preserves prior history.
  const afterPause=current+'!';
  recordHistory(h,current,afterPause,5000);
  const afterSecondPause=afterPause+'?';
  recordHistory(h,afterPause,afterSecondPause,6000);
  reconcileHistory(h,afterSecondPause,current,'undo');
  expect(validHistory(h)).toBe(true);
  expect(replayHistory(h,current,'redo')).toBe(afterSecondPause);
  reconcileHistory(h,afterSecondPause,current,'undo');
  reconcileHistory(h,current,afterSecondPause,'redo');
  expect(replayHistory(h,afterSecondPause,'undo')).toBe(current);

  // Coalesced backspace deletion split by partial native undo.
  const delHistory:NoteHistory={undo:[],redo:[],last:0};
  let text='abcd';
  for(let i=0;i<4;i++){
    const next=text.slice(0,-1);
    recordHistory(delHistory,text,next,1000+i*30);
    text=next;
  }
  expect(text).toBe('');
  reconcileHistory(delHistory,'','ab','undo');
  expect(validHistory(delHistory)).toBe(true);
  expect(replayHistory(delHistory,'ab','undo')).toBe('abcd');
  expect(replayHistory(delHistory,'abcd','redo')).toBe('ab');
  expect(replayHistory(delHistory,'ab','redo')).toBe('');
});
test('isolated edits (such as writing suggestions) never coalesce into surrounding keystrokes',()=>{
  const h:NoteHistory={undo:[],redo:[],last:0};
  const s0='Fix teh word';
  const s1='Fix teh word!';
  const s2='Fix the word!';
  const s3='Fix the word!?';
  applyHistoryEdit(h,s0,s1,1000);
  // Same-length replacement within 600ms with isolateHistory: true
  applyHistoryEdit(h,s1,s2,1100,{isolateHistory:true});
  // Immediate single-character keystroke within 600ms after isolated edit
  applyHistoryEdit(h,s2,s3,1200);
  expect(h.undo).toHaveLength(3);
  expect(replayHistory(h,s3,'undo')).toBe(s2);
  expect(replayHistory(h,s2,'undo')).toBe(s1);
  expect(replayHistory(h,s1,'undo')).toBe(s0);
  expect(replayHistory(h,s0,'redo')).toBe(s1);
  expect(replayHistory(h,s1,'redo')).toBe(s2);
  expect(replayHistory(h,s2,'redo')).toBe(s3);
});

