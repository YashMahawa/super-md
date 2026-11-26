import {useCallback,useEffect,useRef,type ClipboardEvent,type KeyboardEvent as ReactKeyboardEvent,type RefObject} from 'react';
import type {SourceBlock} from './documentAnalysis';
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

export const MAX_BLOCK_HISTORY=60;
export const BLOCK_TYPING_COALESCE_MS=600;
export type SelectionDirection='forward'|'backward'|'none';

export interface BlockSelection {start:number;end:number;direction?:SelectionDirection}
export interface BlockSnapshot {text:string;start:number;end:number;direction:SelectionDirection}
export interface BlockHistoryState {undo:BlockSnapshot[];redo:BlockSnapshot[];last:number}
export interface EditingSession {
  session:number;prefix:string;suffix:string;baseMarkdown:string;baseSplitEnd:number;
  protectedBlock:boolean;insertAfter?:number|'end';
}
export interface EditSpan {baseSource:string;start:number;oldEnd:number;newEnd:number}
export interface BlockKeyState {source:string;keys:Map<number,string>;seq:number}
export type PendingBlockFocus={offset:number}|'end'|null;

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

export function createBlockHistoryState():BlockHistoryState{return {undo:[],redo:[],last:0};}

function pushTrimmedUndo(history:BlockHistoryState,snapshot:BlockSnapshot):void{
  history.undo.push(snapshot);
  while(history.undo.length>MAX_BLOCK_HISTORY)history.undo.shift();
}

export function pushBlockUndoSnapshot(history:BlockHistoryState,snapshot:BlockSnapshot):void{
  pushTrimmedUndo(history,snapshot);
  history.redo=[];
  history.last=0;
}

export function recordCoalescedBlockTypingSnapshot(history:BlockHistoryState,previousSnapshot:BlockSnapshot,nextText:string,now:number=Date.now()):void{
  if(now-history.last>BLOCK_TYPING_COALESCE_MS||Math.abs(nextText.length-previousSnapshot.text.length)>1||history.undo.length===0){
    pushTrimmedUndo(history,previousSnapshot);
  }
  history.redo=[];
  history.last=now;
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
let activeLiveHistoryHandler:((direction:'undo'|'redo')=>boolean)|null=null;

export function setActiveLiveBlockHandlers(
  formatHandler:((action:FormatAction)=>boolean)|null,
  historyHandler:((direction:'undo'|'redo')=>boolean)|null,
):()=>void{
  activeLiveFormatHandler=formatHandler;
  activeLiveHistoryHandler=historyHandler;
  return()=>{
    if(activeLiveFormatHandler===formatHandler)activeLiveFormatHandler=null;
    if(activeLiveHistoryHandler===historyHandler)activeLiveHistoryHandler=null;
  };
}

export function formatActiveLiveBlock(rawAction:string):boolean{
  const action=normalizeFormatAction(rawAction);
  return !!action&&!!activeLiveFormatHandler&&activeLiveFormatHandler(action);
}

export function replayActiveLiveBlockHistory(direction:'undo'|'redo'):boolean{
  return !!activeLiveHistoryHandler&&activeLiveHistoryHandler(direction);
}

export interface UseLiveBlockEditingOptions {
  editing:EditingSession|null;
  editorRef:RefObject<HTMLTextAreaElement|null>;
  latestRef:RefObject<{editing:EditingSession|null;draftText:string;latexAutofix:boolean}>;
  syncedMarkdownRef:RefObject<string>;
  blockHistory:RefObject<BlockHistoryState>;
  lastSelection:RefObject<{start:number;end:number;direction:SelectionDirection}>;
  pendingSelection:RefObject<BlockSelection|null>;
  pendingBlockFocus:RefObject<PendingBlockFocus>;
  setCaret:(caret:number)=>void;
  rememberSelection:(area:HTMLTextAreaElement|null,current?:EditingSession|null)=>void;
  update:(text:string,selectionStart?:number,selectionEnd?:number)=>void;
  closeEditor:(target?:Element|null,clientY?:number|null)=>void;
  openInsertedBlock:(baseDoc:string,insertPos:number,insertAfter:number|'end')=>void;
  openDocBlock:(element:HTMLElement|null,start:number,end:number,baseDoc?:string,selection?:BlockSelection,protectedHint?:boolean)=>void;
}

export function useLiveBlockEditing({
  editing,editorRef,latestRef,syncedMarkdownRef,blockHistory,lastSelection,pendingSelection,pendingBlockFocus,
  setCaret,rememberSelection,update,closeEditor,openInsertedBlock,openDocBlock,
}:UseLiveBlockEditingOptions){
  const suppressHistoryPush=useRef(false);
  const pendingSuggestionSelection=useRef<{start:number;end:number;direction:SelectionDirection}|null>(null);

  const commitDiscreteBlockEdit=useCallback((nextText:string,nextStart:number,nextEnd:number,nextDirection:SelectionDirection='none')=>{
    const {editing:current,draftText:currentDraft}=latestRef.current,area=editorRef.current;
    if(!current||!area)return false;
    if(nextText===currentDraft&&nextStart===area.selectionStart&&nextEnd===area.selectionEnd)return true;
    pushBlockUndoSnapshot(blockHistory.current,{text:currentDraft,start:area.selectionStart,end:area.selectionEnd,direction:area.selectionDirection||'none'});
    pendingSelection.current={start:nextStart,end:nextEnd,direction:nextDirection};
    setCaret(nextStart);
    if(nextText===currentDraft){
      area.focus({preventScroll:true});
      area.setSelectionRange(nextStart,nextEnd,nextDirection);
      lastSelection.current={start:nextStart,end:nextEnd,direction:nextDirection};
      rememberSelection(area,current);
      pendingSelection.current=null;
      return true;
    }
    notifyHistoryBoundary();
    update(nextText,nextStart,nextEnd);
    notifyHistoryBoundary();
    return true;
  },[blockHistory,editorRef,lastSelection,latestRef,pendingSelection,rememberSelection,setCaret,update]);

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
    const snapshot=popBlockHistorySnapshot(blockHistory.current,direction,{text:currentDraft,start:area.selectionStart,end:area.selectionEnd,direction:area.selectionDirection||'none'});
    if(!snapshot)return false;
    pendingSelection.current={start:snapshot.start,end:snapshot.end,direction:snapshot.direction};
    setCaret(snapshot.start);
    update(snapshot.text,snapshot.start,snapshot.end);
    return true;
  },[blockHistory,editorRef,latestRef,pendingSelection,setCaret,update]);

  const hasEditing=Boolean(editing);
  useEffect(()=>{
    if(!hasEditing){
      if(activeLiveFormatHandler===applyLiveFormat)activeLiveFormatHandler=null;
      if(activeLiveHistoryHandler===replayBlockHistory)activeLiveHistoryHandler=null;
      return;
    }
    const clearHandlers=setActiveLiveBlockHandlers(applyLiveFormat,replayBlockHistory);
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
  },[hasEditing,applyLiveFormat,replayBlockHistory,commitDiscreteBlockEdit,editorRef,latestRef]);

  const handleSuggestionAction=useCallback((edit?:{from:number;to:number;insertLength:number})=>{
    const area=editorRef.current;if(!area)return;
    const direction=area.selectionDirection||'none';
    let start=area.selectionStart,end=area.selectionEnd;
    if(edit){
      const delta=edit.insertLength-(edit.to-edit.from);
      const mapOffset=(pos:number)=>pos<=edit.from?pos:pos>=edit.to?pos+delta:edit.from+edit.insertLength;
      start=mapOffset(start);end=mapOffset(end);
      pendingSuggestionSelection.current={start,end,direction};
      pendingSelection.current={start,end,direction};
      setCaret(start);
    }
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

  const paste=useCallback((event:ClipboardEvent<HTMLTextAreaElement>)=>{
    const {latexAutofix:autofix,editing:currentEditing}=latestRef.current;
    if(!currentEditing||event.defaultPrevented||event.clipboardData.files.length)return;
    const area=event.currentTarget,from=area.selectionStart,to=area.selectionEnd;
    const raw=event.clipboardData.getData('text/plain');
    if(!raw)return;
    if(parseStandaloneHttpUrl(raw)){
      event.preventDefault();
      const fullDoc=currentEditing.prefix+area.value+currentEditing.suffix;
      const wrapped=currentEditing.protectedBlock?null:applyMarkdownUrlPaste(fullDoc,[{anchor:currentEditing.prefix.length+from,head:currentEditing.prefix.length+to}],raw);
      const insert=wrapped&&wrapped.changes.length===1?wrapped.changes[0].insert:raw;
      const caret=from+insert.length;
      commitDiscreteBlockEdit(area.value.slice(0,from)+insert+area.value.slice(to),caret,caret);
      return;
    }
    if(!autofix||!/[\\$^]/.test(raw))return;
    if(currentEditing.protectedBlock&&!(from===0&&to===area.value.length))return;
    const before=(currentEditing.prefix.slice(-16_384)+area.value.slice(Math.max(0,from-16_384),from)).slice(-16_384);
    const after=(area.value.slice(to,to+16_384)+currentEditing.suffix.slice(0,16_384)).slice(0,16_384);
    const repaired=repairPastedMath(raw,before,after);if(repaired===raw)return;
    event.preventDefault();
    const caret=from+repaired.length;
    commitDiscreteBlockEdit(area.value.slice(0,from)+repaired+area.value.slice(to),caret,caret);
  },[commitDiscreteBlockEdit,latestRef]);

  const applyInlineBlockEdit=useCallback((
    area:HTMLTextAreaElement,currentDraft:string,replaceFrom:number,replaceTo:number,replacement:string,
    nextValue:string,nextStart:number,nextEnd:number,direction:SelectionDirection='none',
  )=>{
    const origStart=area.selectionStart,origEnd=area.selectionEnd,origDirection=area.selectionDirection||'none';
    if(nextValue!==area.value){
      pushBlockUndoSnapshot(blockHistory.current,{text:currentDraft,start:origStart,end:origEnd,direction:origDirection});
      pendingSelection.current={start:nextStart,end:nextEnd,direction};
      notifyHistoryBoundary();
      suppressHistoryPush.current=true;
      area.setSelectionRange(replaceFrom,replaceTo);
      let applied=false;
      try{
        applied=replacement.length>0?document.execCommand('insertText',false,replacement):document.execCommand('delete',false);
      }catch{applied=false;}
      suppressHistoryPush.current=false;
      if(!applied||area.value!==nextValue){
        update(nextValue,nextStart,nextEnd);
        area.value=nextValue;
      }else if(latestRef.current.draftText!==nextValue){
        update(nextValue,nextStart,nextEnd);
      }
      notifyHistoryBoundary();
    }
    area.setSelectionRange(nextStart,nextEnd,direction);
    lastSelection.current={start:nextStart,end:nextEnd,direction};
    setCaret(nextStart);
    rememberSelection(area,latestRef.current.editing);
    area.focus({preventScroll:true});
  },[blockHistory,lastSelection,latestRef,pendingSelection,rememberSelection,setCaret,update]);

  const syncTextareaCaret=useCallback((area:HTMLTextAreaElement)=>setCaret(area.selectionStart),[setCaret]);

  const onEditorKeyDown=useCallback((event:ReactKeyboardEvent<HTMLTextAreaElement>)=>{
    if(event.nativeEvent.isComposing||event.keyCode===229)return;
    const {editing:active,draftText:currentDraft}=latestRef.current;
    if(!active)return;
    const area=event.currentTarget;
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
        isComposing:event.nativeEvent.isComposing,protectedBlock:active.protectedBlock,
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
      if(lower==='z'||lower==='y'){
        const dir:'undo'|'redo'=lower==='y'||event.shiftKey?'redo':'undo';
        if(blockHistory.current[dir].length>0){
          event.preventDefault();event.stopPropagation();
          if(typeof window!=='undefined'&&window.supermdHistory)window.supermdHistory(dir);
          else replayBlockHistory(dir);
          return;
        }
      }
    }
    const formatAction=formatActionFromKeyEvent(event);
    if(formatAction){
      event.preventDefault();event.stopPropagation();
      applyLiveFormat(formatAction);
    }
  },[applyInlineBlockEdit,applyLiveFormat,blockHistory,closeEditor,latestRef,openDocBlock,openInsertedBlock,pendingBlockFocus,rememberSelection,replayBlockHistory,syncedMarkdownRef]);

  const handleTextareaChange=useCallback((nextText:string,target:HTMLTextAreaElement)=>{
    const {editing:active,draftText:currentDraft}=latestRef.current;
    if(!active)return;
    if(!suppressHistoryPush.current){
      recordCoalescedBlockTypingSnapshot(blockHistory.current,{
        text:currentDraft,
        start:lastSelection.current.start,
        end:lastSelection.current.end,
        direction:lastSelection.current.direction,
      },nextText);
    }
    lastSelection.current={start:target.selectionStart,end:target.selectionEnd,direction:target.selectionDirection||'none'};
    update(nextText,target.selectionStart,target.selectionEnd);
  },[blockHistory,lastSelection,latestRef,update]);

  const handleSuggestionChange=useCallback((next:string)=>{
    const mapped=pendingSuggestionSelection.current;
    pendingSuggestionSelection.current=null;
    const nextStart=mapped?mapped.start:next.length,nextEnd=mapped?mapped.end:nextStart,nextDirection=mapped?mapped.direction:'none';
    commitDiscreteBlockEdit(next,nextStart,nextEnd,nextDirection);
  },[commitDiscreteBlockEdit]);

  return {handleTextareaChange,handleSuggestionChange,handleSuggestionAction,syncTextareaCaret,paste,onEditorKeyDown};
}
