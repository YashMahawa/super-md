import {useCallback,useEffect,useLayoutEffect,useRef,type RefObject} from 'react';
import {analyzeDocument,type SourceBlock} from './documentAnalysis';
import {repairPastedMath} from './mathRepair';
import {
  applyMarkdownUrlPaste,
  formatActionFromKeyEvent,
  normalizeFormatAction,
  notifyHistoryBoundary,
  parseStandaloneHttpUrl,
  toggleMarkdownFormat,
  type FormatAction,
} from './markdownFormatting';
import {editableBlockSpans,indentMarkdownSelection,isFirstLineCursor,isLastLineCursor} from './liveBlockFlow';
import {handleLiveEditorKey} from './liveEditorKeys';
import {registerLiveTextareaHistory,tryLiveTextareaHistory,type LiveHistoryEditMeta} from './noteHistory';

export const MAX_BLOCK_HISTORY=60;
export const BLOCK_TYPING_COALESCE_MS=600;
export type SelectionDirection='forward'|'backward'|'none';

export interface BlockSelection {start:number;end:number;direction?:SelectionDirection}
export interface BlockSnapshot {text:string;start:number;end:number;direction:SelectionDirection}
export interface DiscreteSelectionStep {
  beforeText:string;beforeStart:number;beforeEnd:number;beforeDirection:SelectionDirection;
  afterText:string;afterStart:number;afterEnd:number;afterDirection:SelectionDirection;
}
export interface BlockHistoryState {
  undo:BlockSnapshot[];redo:BlockSnapshot[];last:number;
  discreteUndo:DiscreteSelectionStep[];discreteRedo:DiscreteSelectionStep[];
}
export interface EditingSession {
  session:number;prefix:string;suffix:string;baseMarkdown:string;baseSplitEnd:number;
  protectedBlock:boolean;insertAfter?:number|'end';
}
export interface EditSpan {baseSource:string;start:number;oldEnd:number;newEnd:number}
export interface BlockKeyState {source:string;keys:Map<number,string>;seq:number}
export type PendingBlockFocus={offset:number}|'end'|null;

interface PendingSuggestionEdit {
  from:number;to:number;insertLength:number;
  origStart:number;origEnd:number;origDirection:SelectionDirection;
  selectionStart:number;selectionEnd:number;selectionDirection:SelectionDirection;
}

export function diffTextSpan(previous:string,next:string):{start:number;oldEnd:number;newEnd:number}{
  let start=0,oldEnd=previous.length,newEnd=next.length;
  while(start<oldEnd&&start<newEnd&&previous[start]===next[start])start++;
  while(oldEnd>start&&newEnd>start&&previous[oldEnd-1]===next[newEnd-1]){oldEnd--;newEnd--;}
  return {start,oldEnd,newEnd};
}

export function translateRenderedRange(start:number,end:number,editing:EditingSession|null,syncedMarkdown:string):[number,number]{
  if(!editing||end<=editing.baseSplitEnd)return [start,end];
  const delta=syncedMarkdown.length-editing.baseMarkdown.length;
  return [start>=editing.baseSplitEnd?start+delta:start,end+delta];
}

export function reconcileBlockKeys(state:BlockKeyState,renderedSource:string,blocks:readonly SourceBlock[],editSpanRef:{current:EditSpan|null}):Map<number,string>{
  if(state.source===renderedSource&&state.keys.size===blocks.length&&blocks.every(item=>state.keys.has(item.start)))return state.keys;
  const previousSource=state.source,previousKeys=state.keys,span=editSpanRef.current;
  const {start:diffStart,oldEnd,newEnd}=span&&previousSource===span.baseSource&&renderedSource.length-previousSource.length===span.newEnd-span.oldEnd
    ?span:diffTextSpan(previousSource,renderedSource);
  editSpanRef.current=null;
  const delta=newEnd-oldEnd,nextKeys=new Map<number,string>(),used=new Set<string>();
  for(const item of blocks){
    let assigned:string|undefined;
    if(item.start<=diffStart){
      const candidate=previousKeys.get(item.start);
      if(candidate&&!used.has(candidate))assigned=candidate;
    }
    if(!assigned&&item.start>=newEnd){
      const candidate=previousKeys.get(item.start-delta);
      if(candidate&&!used.has(candidate))assigned=candidate;
    }
    if(!assigned)assigned=`block-k-${++state.seq}`;
    used.add(assigned);
    nextKeys.set(item.start,assigned);
  }
  state.source=renderedSource;
  state.keys=nextKeys;
  return nextKeys;
}

export function resolveReanchoredHistoryTarget(
  previousMarkdown:string,
  nextMarkdown:string,
):{start:number;end:number;caretOffset:number;protectedHint?:boolean}|null{
  const {start:diffStart,newEnd}=diffTextSpan(previousMarkdown,nextMarkdown);
  const analysis=analyzeDocument(nextMarkdown);
  const bodyHasNodes=analysis.tree.children.some(node=>node.position?.start.offset!==undefined);
  const frontmatterEnd=analysis.frontmatter?.end??0;
  if(frontmatterEnd>0&&newEnd<=frontmatterEnd&&diffStart<frontmatterEnd)return null;
  if(!nextMarkdown.trim()||!bodyHasNodes){
    const start=analysis.bodyBlocks[0]?.start??0;
    const caretOffset=Math.max(0,nextMarkdown.length-start);
    return {start,end:nextMarkdown.length,caretOffset,protectedHint:false};
  }
  const spans=editableBlockSpans(nextMarkdown,analysis);
  if(!spans.length)return null;
  const target=spans.find(span=>span.start<=diffStart&&newEnd<=span.end)??spans.filter(span=>span.start<=newEnd).at(-1)??spans[0];
  const caretOffset=Math.max(0,Math.min(target.end-target.start,newEnd-target.start));
  return {start:target.start,end:target.end,caretOffset};
}

export function createBlockHistoryState():BlockHistoryState{
  return {undo:[],redo:[],last:0,discreteUndo:[],discreteRedo:[]};
}

function pushTrimmedUndo(history:BlockHistoryState,snapshot:BlockSnapshot):void{
  history.undo.push(snapshot);
  while(history.undo.length>MAX_BLOCK_HISTORY)history.undo.shift();
}

export function pushBlockUndoSnapshot(history:BlockHistoryState,snapshot:BlockSnapshot):void{
  pushTrimmedUndo(history,snapshot);
  history.redo=[];
  history.last=0;
}

export function pushDiscreteSelectionStep(history:BlockHistoryState,step:DiscreteSelectionStep):void{
  history.discreteUndo.push(step);
  while(history.discreteUndo.length>MAX_BLOCK_HISTORY)history.discreteUndo.shift();
  history.discreteRedo=[];
}

export function recordCoalescedBlockTypingSnapshot(history:BlockHistoryState,previousSnapshot:BlockSnapshot,nextText:string,now:number=Date.now()):void{
  if(now-history.last>BLOCK_TYPING_COALESCE_MS||Math.abs(nextText.length-previousSnapshot.text.length)>1||history.undo.length===0){
    pushTrimmedUndo(history,previousSnapshot);
  }
  history.redo=[];
  history.last=now;
  history.discreteRedo=[];
}

export function popBlockHistorySnapshot(history:BlockHistoryState,direction:'undo'|'redo',currentSnapshot:BlockSnapshot):BlockSnapshot|null{
  const snapshot=history[direction].pop();
  if(!snapshot)return null;
  const opposite=direction==='undo'?history.redo:history.undo;
  opposite.push(currentSnapshot);
  history.last=0;
  return snapshot;
}

let activeLiveFormatHandler:((action:FormatAction)=>boolean)|null=null;

export function setActiveLiveBlockHandlers(
  formatHandler:((action:FormatAction)=>boolean)|null,
  historyHandler?:((direction:'undo'|'redo')=>boolean)|null,
):()=>void{
  activeLiveFormatHandler=formatHandler;
  const clearHistory=historyHandler!==undefined?registerLiveTextareaHistory(historyHandler):null;
  return()=>{
    if(activeLiveFormatHandler===formatHandler)activeLiveFormatHandler=null;
    clearHistory?.();
  };
}

export function formatActiveLiveBlock(rawAction:string):boolean{
  const action=normalizeFormatAction(rawAction);
  return !!action&&!!activeLiveFormatHandler&&activeLiveFormatHandler(action);
}

export function replayActiveLiveBlockHistory(direction:'undo'|'redo'):boolean{
  return tryLiveTextareaHistory(direction);
}

export interface UseLiveBlockEditingOptions {
  editing:EditingSession|null;
  editorRef:RefObject<HTMLTextAreaElement|null>;
  latestRef:RefObject<{editing:EditingSession|null;draftText:string;latexAutofix:boolean;onHistory?:(direction:'undo'|'redo')=>boolean}>;
  syncedMarkdownRef:RefObject<string>;
  blockHistory:RefObject<BlockHistoryState>;
  lastSelection:RefObject<{start:number;end:number;direction:SelectionDirection}>;
  pendingSelection:RefObject<BlockSelection|null>;
  pendingInputMetaRef:RefObject<LiveHistoryEditMeta|null>;
  pendingBlockFocus:RefObject<PendingBlockFocus>;
  setCaret:(caret:number)=>void;
  rememberSelection:(area:HTMLTextAreaElement|null,current?:EditingSession|null)=>void;
  update:(text:string,selectionStart?:number,selectionEnd?:number,meta?:LiveHistoryEditMeta)=>void;
  closeEditor:(target?:Element|null,clientY?:number|null)=>void;
  openInsertedBlock:(baseDoc:string,insertPos:number,insertAfter:number|'end')=>void;
  openDocBlock:(element:HTMLElement|null,start:number,end:number,baseDoc?:string,selection?:BlockSelection,protectedHint?:boolean)=>void;
}

export function useLiveBlockEditing({
  editing,editorRef,latestRef,syncedMarkdownRef,blockHistory,lastSelection,pendingSelection,pendingInputMetaRef,pendingBlockFocus,
  setCaret,rememberSelection,update,closeEditor,openInsertedBlock,openDocBlock,
}:UseLiveBlockEditingOptions){
  const suppressHistoryPush=useRef(false);
  const pendingSuggestionEditRef=useRef<PendingSuggestionEdit|null>(null);
  const lastSessionRef=useRef<number|null>(null);
  const currentSession=editing?.session??null;
  if(lastSessionRef.current!==currentSession){
    lastSessionRef.current=currentSession;
    pendingSuggestionEditRef.current=null;
  }

  const handleBeforeInput=useCallback((inputType?:string)=>{
    if(inputType==='historyUndo')pendingInputMetaRef.current={historyDirection:'undo'};
    else if(inputType==='historyRedo')pendingInputMetaRef.current={historyDirection:'redo'};
  },[pendingInputMetaRef]);

  const applyInlineBlockEdit=useCallback((
    area:HTMLTextAreaElement,currentDraft:string,replaceFrom:number,replaceTo:number,replacement:string,
    nextValue:string,nextStart:number,nextEnd:number,direction:SelectionDirection='none',
    origOverride?:{start:number;end:number;direction:SelectionDirection},
  )=>{
    const origStart=origOverride?.start??area.selectionStart;
    const origEnd=origOverride?.end??area.selectionEnd;
    const origDirection=origOverride?.direction??(area.selectionDirection||'none');
    if(nextValue!==area.value){
      pushBlockUndoSnapshot(blockHistory.current,{text:currentDraft,start:origStart,end:origEnd,direction:origDirection});
      pushDiscreteSelectionStep(blockHistory.current,{
        beforeText:currentDraft,beforeStart:origStart,beforeEnd:origEnd,beforeDirection:origDirection,
        afterText:nextValue,afterStart:nextStart,afterEnd:nextEnd,afterDirection:direction,
      });
      pendingSelection.current={start:nextStart,end:nextEnd,direction};
      notifyHistoryBoundary();
      suppressHistoryPush.current=true;
      pendingInputMetaRef.current={isolateHistory:true};
      area.focus({preventScroll:true});
      area.setSelectionRange(replaceFrom,replaceTo);
      let applied=false;
      try{
        applied=typeof document.execCommand==='function'&&(replacement.length>0?document.execCommand('insertText',false,replacement):document.execCommand('delete',false));
      }catch{applied=false;}
      pendingInputMetaRef.current=null;
      suppressHistoryPush.current=false;
      if(!applied||area.value!==nextValue){
        update(nextValue,nextStart,nextEnd,{isolateHistory:true});
        area.value=nextValue;
      }else if(latestRef.current.draftText!==nextValue){
        update(nextValue,nextStart,nextEnd,{isolateHistory:true});
      }
      notifyHistoryBoundary();
    }
    area.focus({preventScroll:true});
    area.setSelectionRange(nextStart,nextEnd,direction);
    lastSelection.current={start:nextStart,end:nextEnd,direction};
    setCaret(nextStart);
    rememberSelection(area,latestRef.current.editing);
  },[blockHistory,lastSelection,latestRef,pendingInputMetaRef,pendingSelection,rememberSelection,setCaret,update]);

  const commitDiscreteBlockEdit=useCallback((
    nextText:string,nextStart:number,nextEnd:number,nextDirection:SelectionDirection='none',
    origOverride?:{start:number;end:number;direction:SelectionDirection},
  )=>{
    const {editing:current,draftText:currentDraft}=latestRef.current,area=editorRef.current;
    if(!current||!area)return false;
    if(nextText===currentDraft&&nextStart===area.selectionStart&&nextEnd===area.selectionEnd)return true;
    if(nextText===currentDraft){
      area.focus({preventScroll:true});
      area.setSelectionRange(nextStart,nextEnd,nextDirection);
      lastSelection.current={start:nextStart,end:nextEnd,direction:nextDirection};
      setCaret(nextStart);
      rememberSelection(area,current);
      pendingSelection.current=null;
      return true;
    }
    const {start:diffStart,oldEnd:prevEnd,newEnd:nextDiffEnd}=diffTextSpan(currentDraft,nextText);
    applyInlineBlockEdit(area,currentDraft,diffStart,prevEnd,nextText.slice(diffStart,nextDiffEnd),nextText,nextStart,nextEnd,nextDirection,origOverride);
    return true;
  },[applyInlineBlockEdit,editorRef,lastSelection,latestRef,pendingSelection,rememberSelection,setCaret]);

  const applyLiveFormat=useCallback((action:FormatAction):boolean=>{
    const {editing:current,draftText:currentDraft}=latestRef.current,area=editorRef.current;
    if(!current||!area)return false;
    const start=area.selectionStart,end=area.selectionEnd,reversed=area.selectionDirection==='backward';
    const range=reversed?{anchor:end,head:start}:{anchor:start,head:end};
    const result=toggleMarkdownFormat(currentDraft,[range],action,0);
    const nextRange=result.ranges[0];
    const nextStart=Math.min(nextRange.anchor,nextRange.head),nextEnd=Math.max(nextRange.anchor,nextRange.head);
    const nextDirection:SelectionDirection=nextRange.anchor>nextRange.head?'backward':nextStart<nextEnd?'forward':'none';
    return commitDiscreteBlockEdit(result.doc,nextStart,nextEnd,nextDirection);
  },[commitDiscreteBlockEdit,editorRef,latestRef]);

  const replayBlockHistory=useCallback((direction:'undo'|'redo'):boolean=>{
    const {editing:current,draftText:currentDraft}=latestRef.current,area=editorRef.current;
    if(!current||!area)return false;
    const snapshot=popBlockHistorySnapshot(blockHistory.current,direction,{
      text:currentDraft,start:area.selectionStart,end:area.selectionEnd,direction:area.selectionDirection||'none',
    });
    if(!snapshot)return false;
    const start=Math.max(0,Math.min(snapshot.text.length,snapshot.start));
    const end=Math.max(start,Math.min(snapshot.text.length,snapshot.end));
    pendingSelection.current={start,end,direction:snapshot.direction};
    area.value=snapshot.text;
    area.setSelectionRange(start,end,snapshot.direction);
    lastSelection.current={start,end,direction:snapshot.direction};
    setCaret(start);
    update(snapshot.text,start,end,{historyDirection:direction});
    rememberSelection(area,latestRef.current.editing);
    return true;
  },[blockHistory,editorRef,lastSelection,latestRef,pendingSelection,rememberSelection,setCaret,update]);

  const hasEditing=Boolean(editing);
  useEffect(()=>{
    if(!hasEditing){
      if(activeLiveFormatHandler===applyLiveFormat)activeLiveFormatHandler=null;
      return;
    }
    const clearHandlers=setActiveLiveBlockHandlers(applyLiveFormat);
    const onFormatEvent=(event:Event)=>{
      const detail=(event as CustomEvent<{action?:string;prefix?:string;suffix?:string;block?:boolean}>).detail;
      const action=normalizeFormatAction(detail?.action);
      if(action){applyLiveFormat(action);return;}
      const area=editorRef.current,{editing:current,draftText:currentDraft}=latestRef.current;
      if(!area||!current)return;
      const prefix=detail?.prefix??'';
      if(detail?.block){
        const caretPos=area.selectionEnd;
        commitDiscreteBlockEdit(currentDraft.slice(0,caretPos)+prefix+currentDraft.slice(caretPos),caretPos+prefix.length,caretPos+prefix.length);
        return;
      }
      const suffix=detail?.suffix??prefix,from=area.selectionStart,to=area.selectionEnd;
      const wrapped=`${prefix}${currentDraft.slice(from,to)}${suffix}`;
      commitDiscreteBlockEdit(currentDraft.slice(0,from)+wrapped+currentDraft.slice(to),from+prefix.length,from+prefix.length+(to-from));
    };
    window.addEventListener('supermd-format',onFormatEvent);
    return()=>{
      window.removeEventListener('supermd-format',onFormatEvent);
      clearHandlers();
    };
  },[hasEditing,applyLiveFormat,commitDiscreteBlockEdit,editorRef,latestRef]);

  const syncTextareaCaret=useCallback((area:HTMLTextAreaElement)=>setCaret(area.selectionStart),[setCaret]);

  useLayoutEffect(()=>{
    if(!hasEditing)return;
    return registerLiveTextareaHistory(direction=>{
      const area=editorRef.current;
      if(!area||document.activeElement!==area)return false;
      if(typeof document.execCommand!=='function')return replayBlockHistory(direction);
      const beforeValue=area.value,beforeSynced=syncedMarkdownRef.current;
      pendingInputMetaRef.current={historyDirection:direction};
      let executed=false;
      try{executed=document.execCommand(direction);}catch{executed=false;}
      if(!executed||(area.value===beforeValue&&syncedMarkdownRef.current===beforeSynced)){
        pendingInputMetaRef.current=null;
        return false;
      }
      if(area.value!==latestRef.current.draftText){
        syncTextareaCaret(area);
        update(area.value,area.selectionStart,area.selectionEnd,{historyDirection:direction});
      }
      if(pendingSelection.current){
        const max=area.value.length;
        const start=Math.max(0,Math.min(max,pendingSelection.current.start));
        const end=Math.max(start,Math.min(max,pendingSelection.current.end));
        const selDir=pendingSelection.current.direction||'none';
        area.setSelectionRange(start,end,selDir);
        lastSelection.current={start,end,direction:selDir};
        setCaret(start);
      }
      pendingInputMetaRef.current=null;
      rememberSelection(area,latestRef.current.editing);
      return true;
    });
  },[editorRef,hasEditing,lastSelection,latestRef,pendingInputMetaRef,pendingSelection,rememberSelection,replayBlockHistory,setCaret,syncTextareaCaret,syncedMarkdownRef,update]);

  const handleSuggestionAction=useCallback((edit?:{from:number;to:number;insertLength:number})=>{
    const area=editorRef.current;if(!area){pendingSuggestionEditRef.current=null;return;}
    const origStart=area.selectionStart,origEnd=area.selectionEnd;
    const direction=area.selectionDirection||'none';
    let start=origStart,end=origEnd;
    if(edit){
      const delta=edit.insertLength-(edit.to-edit.from);
      const mapOffset=(pos:number)=>pos<=edit.from?pos:pos>=edit.to?pos+delta:edit.from+edit.insertLength;
      start=mapOffset(start);end=mapOffset(end);
      pendingSelection.current={start,end,direction};
      pendingSuggestionEditRef.current={...edit,origStart,origEnd,origDirection:direction,selectionStart:start,selectionEnd:end,selectionDirection:direction};
      setCaret(start);
    }else pendingSuggestionEditRef.current=null;
    area.focus({preventScroll:true});
    queueMicrotask(()=>{
      const current=editorRef.current,{editing:active,draftText:latestDraft}=latestRef.current;
      if(!current||!current.isConnected)return;
      current.focus({preventScroll:true});
      if(!active||current.value===latestDraft){
        if(pendingSelection.current){
          const nextStart=Math.max(0,Math.min(current.value.length,pendingSelection.current.start));
          const nextEnd=Math.max(nextStart,Math.min(current.value.length,pendingSelection.current.end));
          const nextDir=pendingSelection.current.direction||'none';
          pendingSelection.current=null;
          current.setSelectionRange(nextStart,nextEnd,nextDir);
          lastSelection.current={start:nextStart,end:nextEnd,direction:nextDir};
          setCaret(nextStart);
        }
        rememberSelection(current,active);
      }
    });
  },[editorRef,lastSelection,latestRef,pendingSelection,rememberSelection,setCaret]);

  const paste=useCallback((area:HTMLTextAreaElement,event:ClipboardEvent)=>{
    const {latexAutofix:autofix,editing:currentEditing}=latestRef.current;
    if(!currentEditing||event.defaultPrevented||!event.clipboardData||event.clipboardData.files.length)return;
    const from=area.selectionStart,to=area.selectionEnd;
    const raw=event.clipboardData.getData('text/plain');
    if(!raw)return;
    if(parseStandaloneHttpUrl(raw)){
      event.preventDefault();
      const fullDoc=currentEditing.prefix+area.value+currentEditing.suffix;
      const wrapped=currentEditing.protectedBlock?null:applyMarkdownUrlPaste(fullDoc,[{anchor:currentEditing.prefix.length+from,head:currentEditing.prefix.length+to}],raw);
      const insert=wrapped&&wrapped.changes.length===1?wrapped.changes[0].insert:raw;
      const caretPos=from+insert.length;
      commitDiscreteBlockEdit(area.value.slice(0,from)+insert+area.value.slice(to),caretPos,caretPos);
      return;
    }
    if(!autofix||!/[\\$^]/.test(raw))return;
    if(currentEditing.protectedBlock&&!(from===0&&to===area.value.length))return;
    const before=(currentEditing.prefix.slice(-16_384)+area.value.slice(Math.max(0,from-16_384),from)).slice(-16_384);
    const after=(area.value.slice(to,to+16_384)+currentEditing.suffix.slice(0,16_384)).slice(0,16_384);
    const repaired=repairPastedMath(raw,before,after);if(repaired===raw)return;
    event.preventDefault();
    const caretPos=from+repaired.length;
    commitDiscreteBlockEdit(area.value.slice(0,from)+repaired+area.value.slice(to),caretPos,caretPos);
  },[commitDiscreteBlockEdit,latestRef]);

  const onEditorKeyDown=useCallback((area:HTMLTextAreaElement,event:KeyboardEvent)=>{
    if(event.isComposing||event.keyCode===229)return;
    const {editing:active,draftText:currentDraft,onHistory:triggerHistory}=latestRef.current;
    if(!active)return;
    if(event.key==='Tab'&&!event.ctrlKey&&!event.metaKey&&!event.altKey){
      event.preventDefault();event.stopPropagation();
      const direction=area.selectionDirection||'none';
      const result=indentMarkdownSelection(area.value,area.selectionStart,area.selectionEnd,event.shiftKey);
      applyInlineBlockEdit(area,currentDraft,result.lineStart,result.blockEnd,result.replacement,result.value,result.selectionStart,result.selectionEnd,direction);
      return;
    }
    if(event.key==='Escape'){
      rememberSelection(area,active);
      event.preventDefault();event.stopPropagation();
      pendingBlockFocus.current=active.insertAfter!==undefined&&currentDraft===''?(active.insertAfter==='end'?'end':{offset:active.insertAfter}):{offset:active.prefix.length};
      closeEditor();
      return;
    }
    if(event.key==='Enter'&&(event.metaKey||event.ctrlKey)&&!event.altKey&&!event.shiftKey){
      event.preventDefault();event.stopPropagation();
      if(active.insertAfter!==undefined&&currentDraft.trim()===''){area.focus({preventScroll:true});return;}
      const committed=syncedMarkdownRef.current;
      const insertPos=active.prefix.length+currentDraft.length;
      const spans=editableBlockSpans(committed);
      const afterSpan=spans.filter(span=>span.end<=insertPos).at(-1);
      openInsertedBlock(committed,insertPos,afterSpan?afterSpan.blockStart:'end');
      return;
    }
    if(event.key==='Enter'&&!event.ctrlKey&&!event.metaKey&&!event.altKey&&!event.shiftKey){
      const next=handleLiveEditorKey({
        text:area.value,selectionStart:area.selectionStart,selectionEnd:area.selectionEnd,
        key:event.key,shiftKey:event.shiftKey,ctrlKey:event.ctrlKey,metaKey:event.metaKey,altKey:event.altKey,
        isComposing:event.isComposing,protectedBlock:active.protectedBlock,
      });
      if(next){
        event.preventDefault();event.stopPropagation();
        const {start:diffStart,oldEnd:prevEnd,newEnd:nextEnd}=diffTextSpan(area.value,next.text);
        applyInlineBlockEdit(area,currentDraft,diffStart,prevEnd,next.text.slice(diffStart,nextEnd),next.text,next.selectionStart,next.selectionEnd);
        return;
      }
    }
    if(!event.ctrlKey&&!event.metaKey&&!event.altKey&&!event.shiftKey){
      const untouchedInsert=active.insertAfter!==undefined&&currentDraft==='';
      if(event.key==='ArrowUp'&&isFirstLineCursor(area.value,area.selectionStart,area.selectionEnd)){
        const committed=syncedMarkdownRef.current,spans=editableBlockSpans(committed);
        const activeStart=untouchedInsert?active.baseSplitEnd:active.prefix.length;
        const prev=spans.filter(span=>span.end<=activeStart).at(-1);
        if(prev){
          event.preventDefault();event.stopPropagation();
          const len=prev.end-prev.start;
          openDocBlock(null,prev.start,prev.end,committed,{start:len,end:len});
        }
        return;
      }
      if(event.key==='ArrowDown'&&isLastLineCursor(area.value,area.selectionStart,area.selectionEnd)){
        const committed=syncedMarkdownRef.current,spans=editableBlockSpans(committed);
        const activeEnd=untouchedInsert?active.baseSplitEnd:active.prefix.length+currentDraft.length;
        const next=spans.find(span=>span.start>=activeEnd);
        if(next){
          event.preventDefault();event.stopPropagation();
          openDocBlock(null,next.start,next.end,committed,{start:0,end:0});
        }
        return;
      }
    }
    if(document.documentElement.dataset.host==='qt')return;
    if((event.ctrlKey||event.metaKey)&&!event.altKey){
      const lower=event.key.toLowerCase();
      const historyDir=lower==='z'?(event.shiftKey?'redo':'undo'):lower==='y'&&!event.shiftKey?'redo':null;
      if(historyDir){
        if(triggerHistory){
          event.preventDefault();event.stopPropagation();
          triggerHistory(historyDir);
          return;
        }
        if(typeof window!=='undefined'&&window.supermdHistory){
          event.preventDefault();event.stopPropagation();
          window.supermdHistory(historyDir);
          return;
        }
        if(tryLiveTextareaHistory(historyDir)){
          event.preventDefault();event.stopPropagation();
          return;
        }
      }
    }
    const formatAction=formatActionFromKeyEvent(event);
    if(formatAction){
      event.preventDefault();event.stopPropagation();
      applyLiveFormat(formatAction);
    }
  },[applyInlineBlockEdit,applyLiveFormat,closeEditor,latestRef,openDocBlock,openInsertedBlock,pendingBlockFocus,rememberSelection,syncedMarkdownRef]);

  const handleTextareaChange=useCallback((nextText:string,target:HTMLTextAreaElement,meta?:LiveHistoryEditMeta)=>{
    const {editing:active,draftText:currentDraft}=latestRef.current;
    if(!active)return;
    const resolvedDir=meta?.historyDirection??pendingInputMetaRef.current?.historyDirection;
    let selStart=target.selectionStart,selEnd=target.selectionEnd;
    let selDir:SelectionDirection=target.selectionDirection||'none';
    if(resolvedDir==='undo'){
      const top=blockHistory.current.discreteUndo.at(-1);
      if(top&&top.afterText===currentDraft&&top.beforeText===nextText){
        blockHistory.current.discreteUndo.pop();
        blockHistory.current.discreteRedo.push(top);
        selStart=Math.max(0,Math.min(nextText.length,top.beforeStart));
        selEnd=Math.max(selStart,Math.min(nextText.length,top.beforeEnd));
        selDir=top.beforeDirection;
        pendingSelection.current={start:selStart,end:selEnd,direction:selDir};
        target.setSelectionRange(selStart,selEnd,selDir);
        setCaret(selStart);
      }
    }else if(resolvedDir==='redo'){
      const top=blockHistory.current.discreteRedo.at(-1);
      if(top&&top.beforeText===currentDraft&&top.afterText===nextText){
        blockHistory.current.discreteRedo.pop();
        blockHistory.current.discreteUndo.push(top);
        selStart=Math.max(0,Math.min(nextText.length,top.afterStart));
        selEnd=Math.max(selStart,Math.min(nextText.length,top.afterEnd));
        selDir=top.afterDirection;
        pendingSelection.current={start:selStart,end:selEnd,direction:selDir};
        target.setSelectionRange(selStart,selEnd,selDir);
        setCaret(selStart);
      }
    }else if(!suppressHistoryPush.current){
      recordCoalescedBlockTypingSnapshot(blockHistory.current,{
        text:currentDraft,
        start:lastSelection.current.start,
        end:lastSelection.current.end,
        direction:lastSelection.current.direction,
      },nextText);
    }
    lastSelection.current={start:selStart,end:selEnd,direction:selDir};
    update(nextText,selStart,selEnd,meta);
  },[blockHistory,lastSelection,latestRef,pendingInputMetaRef,pendingSelection,setCaret,update]);

  const handleSuggestionChange=useCallback((next:string)=>{
    const suggestionEdit=pendingSuggestionEditRef.current;
    pendingSuggestionEditRef.current=null;
    const area=editorRef.current;
    if(area&&suggestionEdit){
      const replacement=next.slice(suggestionEdit.from,suggestionEdit.from+suggestionEdit.insertLength);
      applyInlineBlockEdit(
        area,latestRef.current.draftText,suggestionEdit.from,suggestionEdit.to,replacement,
        next,suggestionEdit.selectionStart,suggestionEdit.selectionEnd,suggestionEdit.selectionDirection,
        {start:suggestionEdit.origStart,end:suggestionEdit.origEnd,direction:suggestionEdit.origDirection},
      );
      return;
    }
    if(area){
      commitDiscreteBlockEdit(next,next.length,next.length,'none');
      return;
    }
    update(next,undefined,undefined,{isolateHistory:true});
  },[applyInlineBlockEdit,commitDiscreteBlockEdit,editorRef,latestRef,update]);

  return {handleBeforeInput,handleTextareaChange,handleSuggestionChange,handleSuggestionAction,syncTextareaCaret,paste,onEditorKeyDown};
}
