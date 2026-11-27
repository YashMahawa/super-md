import {expect,test} from 'vitest';
import {
  MAX_CACHED_HISTORIES,
  MAX_GROUP_COST,
  MAX_HISTORY_ENTRIES,
  MAX_HISTORY_STACK_COST,
  MAX_SINGLE_STEP_COST,
  MAX_TRANSFERRED_HISTORY_COST,
  applyHistoryEdit,
  historySize,
  reconcileHistory,
  recordHistory,
  replayHistory,
  transferHistory,
  trimHistoryCache,
  validHistory,
  type NoteHistory,
} from './noteHistory';
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
  expect(validHistory(transferHistory(h))).toBe(true);
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

test('splits coalesced deletion and insertion groups when forward or inverse character cost reaches MAX_GROUP_COST',()=>{
  // Forward cost branch (adjacent backward deletion merging into prior.insert).
  const delHistory:NoteHistory={undo:[],redo:[],last:0};
  const base='xy'+'a'.repeat(MAX_GROUP_COST-25);
  recordHistory(delHistory,base,'xy',1000); // cost = (MAX_GROUP_COST - 25) + 24 = MAX_GROUP_COST - 1
  expect(delHistory.undo).toHaveLength(1);
  recordHistory(delHistory,'xy','x',1050); // merges 'y' -> cost = MAX_GROUP_COST
  expect(delHistory.undo).toHaveLength(1);
  expect(historySize(delHistory)).toBe(MAX_GROUP_COST);
  recordHistory(delHistory,'x','',1100); // would reach MAX_GROUP_COST + 1 -> starts new group
  expect(delHistory.undo).toHaveLength(2);
  expect(validHistory(delHistory)).toBe(true);
  const afterFirstDelUndo=replayHistory(delHistory,'','undo');
  expect(afterFirstDelUndo).toBe('x');
  expect(replayHistory(delHistory,afterFirstDelUndo!,'undo')).toBe(base);

  // Inverse cost branch (adjacent forward typing merging into prior.remove).
  const insHistory:NoteHistory={undo:[],redo:[],last:0};
  const typedPrefix='a'.repeat(MAX_GROUP_COST-25);
  recordHistory(insHistory,'',typedPrefix,2000); // inverseCost = MAX_GROUP_COST - 1
  recordHistory(insHistory,typedPrefix,typedPrefix+'b',2050); // inverseCost = MAX_GROUP_COST
  expect(insHistory.undo).toHaveLength(1);
  recordHistory(insHistory,typedPrefix+'b',typedPrefix+'bc',2100); // inverseCost would exceed MAX_GROUP_COST -> splits
  expect(insHistory.undo).toHaveLength(2);
  const beforeFinalChar=replayHistory(insHistory,typedPrefix+'bc','undo');
  expect(beforeFinalChar).toBe(typedPrefix+'b');
  expect(replayHistory(insHistory,beforeFinalChar!,'undo')).toBe('');
  expect(historySize(insHistory)).toBeLessThanOrEqual(MAX_GROUP_COST+48);
  expect(validHistory(insHistory)).toBe(true);

  // Separate edit in coalesced group branch (non-adjacent single-char edits).
  const multiHistory:NoteHistory={undo:[],redo:[],last:0};
  const padded='a'.repeat(MAX_GROUP_COST-48)+'z';
  recordHistory(multiHistory,padded,'z',3000); // cost = MAX_GROUP_COST - 24
  recordHistory(multiHistory,'z','',3050); // +25 -> MAX_GROUP_COST + 1 -> splits into second group
  expect(multiHistory.undo).toHaveLength(2);
  expect(replayHistory(multiHistory,'','undo')).toBe('z');
  expect(replayHistory(multiHistory,'z','undo')).toBe(padded);
});

test('bounds inverse edits added in replayHistory by stack cost and entry count',()=>{
  const h:NoteHistory={undo:[],redo:[],last:0};
  let content='seed';
  const states=[content];
  for(let i=0;i<4;i++){
    const next=content+String(i).repeat(900_000);
    recordHistory(h,content,next,1000+i*1000);
    content=next;
    states.push(content);
  }
  // Forward insertions store empty `insert` in undo, so undo cost is tiny.
  expect(historySize(h)).toBe(4*24);
  // Undoing all 4 pushes ~900 KB inverse entries onto redo; redo trims oldest to stay <= 2,000,000.
  for(let step=4;step>=1;step--){
    content=replayHistory(h,content,'undo')!;
    expect(content).toBe(states[step-1]);
    expect(validHistory(h)).toBe(true);
    expect(historySize(h)).toBeLessThanOrEqual(MAX_HISTORY_STACK_COST+4*24);
  }
  expect(h.undo).toHaveLength(0);
  expect(h.redo).toHaveLength(2);
  expect(historySize(h)).toBeLessThanOrEqual(MAX_HISTORY_STACK_COST);
  // Redoing the 2 retained newest steps restores from state[0] -> Wait: shifting oldest redo drops states[3]->states[4] and states[2]->states[3],
  // keeping states[0]->states[1] and states[1]->states[2] contiguous from current (states[0])!
  const redo1=replayHistory(h,content,'redo')!;
  expect(redo1).toBe(states[1]);
  const redo2=replayHistory(h,redo1,'redo')!;
  expect(redo2).toBe(states[2]);
  expect(replayHistory(h,redo2,'redo')).toBeUndefined();

  // Imported/manual stack exceeding 60 entries trims oldest entries on replay while keeping contiguity.
  const many:NoteHistory={undo:[],redo:[],last:0};
  let text='';
  for(let i=0;i<65;i++){
    const next=text+'a';
    many.undo.push([{from:text.length,remove:1,insert:''}]);
    text=next;
  }
  const afterUndo=replayHistory(many,text,'undo')!;
  expect(afterUndo).toBe('a'.repeat(64));
  expect(many.undo.length).toBeLessThanOrEqual(MAX_HISTORY_ENTRIES);
  expect(validHistory(many)).toBe(true);
});

test('pins down newest-step undo/redo retention on both sides of the transfer limit across replay and transfer',()=>{
  // 1. Exact transfer limit boundary (cost === 4,000,000): retained across record, replay, and transfer.
  const exactDoc='b'.repeat(MAX_TRANSFERRED_HISTORY_COST-24);
  const atLimit:NoteHistory={undo:[],redo:[],last:0};
  recordHistory(atLimit,exactDoc,'after',1000);
  expect(historySize(atLimit)).toBe(MAX_TRANSFERRED_HISTORY_COST);
  expect(validHistory(atLimit)).toBe(true);
  const transferredExact=transferHistory(atLimit);
  expect(transferredExact).toBeDefined();
  expect(validHistory(transferredExact)).toBe(true);
  expect(replayHistory(transferredExact!,'after','undo')).toBe(exactDoc);
  expect(replayHistory(transferredExact!,exactDoc,'redo')).toBe('after');

  // 2. Below transfer limit per stack, combined > 4,000,000 after replay:
  //    in-session retains full undo + oversized redo; transferHistory evicts oldest undo to retain BOTH undo and redo.
  const s0='0'.repeat(1_000_000);
  const s1='1'.repeat(800_000);
  const s2='short';
  const s3=s2+'2'.repeat(2_500_000);
  const mixed:NoteHistory={undo:[],redo:[],last:0};
  recordHistory(mixed,s0,s1,1000); // undo[0] ~ 1.0M
  recordHistory(mixed,s1,s2,2000); // undo[1] ~ 0.8M (total undo ~ 1.8M <= 2.0M)
  recordHistory(mixed,s2,s3,3000); // undo[2] = 24 chars
  expect(mixed.undo).toHaveLength(3);
  const afterPasteUndo=replayHistory(mixed,s3,'undo')!;
  expect(afterPasteUndo).toBe(s2);
  // In-session keeps undo ([1.0M, 0.8M]) and redo ([2.5M]).
  expect(mixed.undo).toHaveLength(2);
  expect(mixed.redo).toHaveLength(1);
  expect(historySize(mixed)).toBeGreaterThan(MAX_TRANSFERRED_HISTORY_COST);
  // Tear-off / reload trims oldest undo (1.0M) so BOTH remaining undo (0.8M) and redo (2.5M) transfer cleanly.
  const transferredMixed=transferHistory(mixed)!;
  expect(validHistory(transferredMixed)).toBe(true);
  expect(transferredMixed.undo).toHaveLength(1);
  expect(transferredMixed.redo).toHaveLength(1);
  expect(replayHistory(structuredClone(transferredMixed),s2,'undo')).toBe(s1);
  expect(replayHistory(structuredClone(transferredMixed),s2,'redo')).toBe(s3);
  // Meanwhile in-session mixed still walks all the way back to s0.
  expect(replayHistory(mixed,s2,'undo')).toBe(s1);
  expect(replayHistory(mixed,s1,'undo')).toBe(s0);

  // When singleton undo + singleton redo still exceed 4,000,000, transferHistory preserves committed undo.
  const singletonConflict:NoteHistory={undo:[],redo:[],last:0};
  const c0='u'.repeat(1_800_000);
  const c1='mid';
  const c2=c1+'r'.repeat(2_500_000);
  recordHistory(singletonConflict,c0,c1,1000);
  recordHistory(singletonConflict,c1,c2,2000);
  expect(replayHistory(singletonConflict,c2,'undo')).toBe(c1);
  const transferredSingleton=transferHistory(singletonConflict)!;
  expect(validHistory(transferredSingleton)).toBe(true);
  expect(transferredSingleton.undo).toHaveLength(1);
  expect(transferredSingleton.redo).toHaveLength(0);
  expect(replayHistory(transferredSingleton,c1,'undo')).toBe(c0);

  // 3. Above transfer limit (cost === 4,000,001 and 4,500,000):
  //    in-session undo/redo works; tear-off drops only the >4M stack while retaining any <=4M opposite stack.
  const overLimitDoc='o'.repeat(MAX_TRANSFERRED_HISTORY_COST-23); // cost = 4,000,001
  const justOver:NoteHistory={undo:[],redo:[],last:0};
  recordHistory(justOver,overLimitDoc,'replaced',1000);
  expect(historySize(justOver)).toBe(MAX_TRANSFERRED_HISTORY_COST+1);
  expect(validHistory(justOver)).toBe(false);
  expect(transferHistory(justOver)).toBeUndefined();
  // In-session Undo restores overLimitDoc and leaves tiny inverse on redo, which IS transferable!
  expect(replayHistory(justOver,'replaced','undo')).toBe(overLimitDoc);
  const transferredAfterUndo=transferHistory(justOver)!;
  expect(validHistory(transferredAfterUndo)).toBe(true);
  expect(replayHistory(transferredAfterUndo,overLimitDoc,'redo')).toBe('replaced');

  // Prior small edit + 4.5M paste undone -> redo has 4.5M (>4M), undo has prior small edit (<=4M):
  // transferHistory drops >4M redo and retains undo.
  const overPaste:NoteHistory={undo:[],redo:[],last:0};
  recordHistory(overPaste,'base','base edited',1000);
  const hugeAdded='base edited'+'p'.repeat(4_500_000);
  recordHistory(overPaste,'base edited',hugeAdded,2000);
  expect(replayHistory(overPaste,hugeAdded,'undo')).toBe('base edited');
  expect(validHistory(overPaste)).toBe(false);
  const transferredOverPaste=transferHistory(overPaste)!;
  expect(validHistory(transferredOverPaste)).toBe(true);
  expect(transferredOverPaste.undo).toHaveLength(1);
  expect(transferredOverPaste.redo).toHaveLength(0);
  expect(replayHistory(transferredOverPaste,'base edited','undo')).toBe('base');

  // 4. Hard single-step ceiling (> MAX_SINGLE_STEP_COST): bounded in recordHistory and replayHistory.
  const beyondCeiling='m'.repeat(MAX_SINGLE_STEP_COST);
  const ceilingHist:NoteHistory={undo:[],redo:[],last:0};
  recordHistory(ceilingHist,'seed','seed2',1000);
  recordHistory(ceilingHist,beyondCeiling,'tiny',2000); // editCost = MAX_SINGLE_STEP_COST + 24 > MAX_SINGLE_STEP_COST
  expect(ceilingHist.undo).toHaveLength(0);
  expect(ceilingHist.redo).toHaveLength(0);

  const ceilingInsert:NoteHistory={undo:[],redo:[],last:0};
  recordHistory(ceilingInsert,'alpha','beta',1000);
  const hugeInsert='beta'+beyondCeiling;
  recordHistory(ceilingInsert,'beta',hugeInsert,2000); // undo editCost = 24
  expect(ceilingInsert.undo).toHaveLength(2);
  expect(replayHistory(ceilingInsert,hugeInsert,'undo')).toBe('beta');
  expect(ceilingInsert.redo).toHaveLength(0); // > MAX_SINGLE_STEP_COST inverse not retained
  expect(replayHistory(ceilingInsert,'beta','undo')).toBe('alpha'); // prior undo step still intact!
});

test('retains and bounds legacy string snapshots on both sides of the transfer limit',()=>{
  const legacyA='A'.repeat(1_500_000);
  const legacyB='B'.repeat(1_500_000);
  const current='Current text';
  const under:NoteHistory={undo:[legacyA],redo:[legacyB],last:0};
  expect(validHistory(under)).toBe(true);
  const transferredUnder=transferHistory(under)!;
  expect(validHistory(transferredUnder)).toBe(true);
  expect(replayHistory(transferredUnder,current,'undo')).toBe(legacyA);
  expect(replayHistory(transferredUnder,legacyA,'redo')).toBe(current);

  // Multi-entry legacy stack > 4,000,000 evicts oldest snapshot while keeping newer snapshots.
  const legacyOld='O'.repeat(2_000_000);
  const overMulti:NoteHistory={undo:[legacyOld,legacyA,legacyB],redo:[],last:0};
  expect(validHistory(overMulti)).toBe(false);
  const transferredMulti=transferHistory(overMulti)!;
  expect(validHistory(transferredMulti)).toBe(true);
  expect(transferredMulti.undo).toEqual([legacyA,legacyB]);
  const step1=replayHistory(transferredMulti,current,'undo')!;
  expect(step1).toBe(legacyB);
  expect(replayHistory(transferredMulti,step1,'undo')).toBe(legacyA);

  // Oversized newest legacy snapshot (> 4,000,000) on redo drops redo while retaining valid legacy undo.
  const legacyHuge='H'.repeat(4_500_000);
  const legacySmall='Legacy baseline';
  const overNewestRedo:NoteHistory={undo:[legacySmall],redo:[legacyHuge],last:0};
  expect(validHistory(overNewestRedo)).toBe(false);
  const transferredLegacy=transferHistory(overNewestRedo)!;
  expect(validHistory(transferredLegacy)).toBe(true);
  expect(transferredLegacy.undo).toEqual([legacySmall]);
  expect(transferredLegacy.redo).toEqual([]);
  expect(replayHistory(transferredLegacy,current,'undo')).toBe(legacySmall);
});

test('isolates independent tab caches when active or background tabs hold oversized steps',()=>{
  const caches=new Map<string,NoteHistory>();
  const tabA:NoteHistory={undo:[],redo:[],last:0};
  recordHistory(tabA,'A'.repeat(400_000),'Tab A edited',1000);
  caches.set('tab-a',tabA);

  const tabB:NoteHistory={undo:[],redo:[],last:0};
  recordHistory(tabB,'B'.repeat(400_000),'Tab B edited',2000);
  caches.set('tab-b',tabB);

  // Active Tab C records a 4.5M oversized step (> 4,000,000 transfer limit): Tab A and Tab B stay intact.
  const tabC:NoteHistory={undo:[],redo:[],last:0};
  recordHistory(tabC,'C0','C1',3000);
  const c2='C1'+'C'.repeat(4_500_000);
  recordHistory(tabC,'C1',c2,4000);
  expect(replayHistory(tabC,c2,'undo')).toBe('C1'); // tabC now has undo: ['C0'], redo: [4.5M]
  caches.set('tab-c',tabC);
  trimHistoryCache(caches,'tab-c');
  expect(caches.has('tab-a')).toBe(true);
  expect(caches.has('tab-b')).toBe(true);
  expect(caches.has('tab-c')).toBe(true);

  // Switching active tab back to Tab A trims now-inactive Tab C's >4M redo while preserving Tab C's undo and Tab A/B.
  trimHistoryCache(caches,'tab-a');
  expect(caches.has('tab-a')).toBe(true);
  expect(caches.has('tab-b')).toBe(true);
  const trimmedC=caches.get('tab-c')!;
  expect(validHistory(trimmedC)).toBe(true);
  expect(trimmedC.undo).toHaveLength(1);
  expect(trimmedC.redo).toHaveLength(0);
  expect(replayHistory(trimmedC,'C1','undo')).toBe('C0');
  expect(replayHistory(caches.get('tab-a')!,'Tab A edited','undo')).toBe('A'.repeat(400_000));
  expect(replayHistory(caches.get('tab-b')!,'Tab B edited','undo')).toBe('B'.repeat(400_000));

  // Cap at MAX_CACHED_HISTORIES (40) evicts oldest LRU inactive entries without evicting activeId.
  const manyTabs=new Map<string,NoteHistory>();
  for(let i=0;i<MAX_CACHED_HISTORIES+3;i++){
    const h:NoteHistory={undo:[],redo:[],last:0};
    recordHistory(h,`before-${i}`,`after-${i}`,1000+i);
    manyTabs.set(`tab-${i}`,h);
  }
  trimHistoryCache(manyTabs,'tab-0'); // tab-0 is active, so tab-1, tab-2, tab-3 are oldest inactive
  expect(manyTabs.size).toBe(MAX_CACHED_HISTORIES);
  expect(manyTabs.has('tab-0')).toBe(true);
  expect(manyTabs.has('tab-1')).toBe(false);
  expect(manyTabs.has('tab-2')).toBe(false);
  expect(manyTabs.has('tab-3')).toBe(false);
  expect(manyTabs.has(`tab-${MAX_CACHED_HISTORIES+2}`)).toBe(true);
});


