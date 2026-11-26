import {createContext,Fragment,useCallback,useContext,useEffect,useLayoutEffect,useMemo,useRef,useState,type ClipboardEvent as ReactClipboardEvent,type DragEvent,type RefObject} from 'react';
import MarkdownPreview from './MarkdownPreview';
import type {RenderedMarkdownBlock} from './CachedMarkdown';
import WritingSuggestions from './WritingSuggestions';
import {analyzeDocument,type SourceBlock,type SourceDocumentAnalysis} from '../documentAnalysis';
import {selectedMarkdown,setSelectedMarkdownDrag} from '../copySource';
import type {LiveHistoryEditMeta} from '../noteHistory';
import type {WritingOptions} from '../proofreading';
import type {ReaderAccessibilityPreference} from '../types';
import {useTypewriterScroll} from '../typewriterScroll';
import {LiveBlockShell} from './LiveBlockShell';
import {
  createBlockHistoryState,
  diffTextSpan,
  formatActiveLiveBlock,
  reconcileBlockKeys,
  replayActiveLiveBlockHistory,
  resolveReanchoredHistoryTarget,
  translateRenderedRange,
  useLiveBlockEditing,
  type BlockHistoryState,
  type BlockKeyState,
  type BlockSelection,
  type EditingSession,
  type EditSpan,
  type PendingBlockFocus,
  type SelectionDirection,
} from '../liveBlockHistory';
import {resolveLiveCaretOffset,useLiveInsertionPoint,type SavedLiveSelection} from '../liveInsertionPoint';
import {useLiveViewportHold} from '../useLiveViewportHold';

const noTrustedHosts:string[]=[];
const CARET_KEYS=new Set(['ArrowUp','ArrowDown','PageUp','PageDown','Home','End']);
export type {SourceBlock} from '../documentAnalysis';
export {formatActiveLiveBlock,replayActiveLiveBlockHistory};
export function splitMarkdownBlocks(markdown:string):SourceBlock[]{return analyzeDocument(markdown).bodyBlocks;}

interface ActiveDraftContextValue {
  session:number;
  editorRef:RefObject<HTMLTextAreaElement|null>;
  sourceStart:number;
  text:string;
  caret:number;
  spellCheck:boolean;
  grammarCheck:boolean;
  onChange:(value:string,target:HTMLTextAreaElement,meta?:LiveHistoryEditMeta)=>void;
  onBeforeInput:(inputType?:string)=>void;
  onSuggestionChange:(value:string)=>void;
  onSuggestionAction:(edit?:{from:number;to:number;insertLength:number})=>void;
  onSyncCaret:(area:HTMLTextAreaElement)=>void;
  onPaste:(area:HTMLTextAreaElement,event:ClipboardEvent)=>void;
  onKeyDown:(area:HTMLTextAreaElement,event:KeyboardEvent)=>void;
  onCaretMove:()=>void;
  onRememberSelection:(area:HTMLTextAreaElement)=>void;
  onBlurSession:(session:number,area:HTMLTextAreaElement,shouldClose:boolean,relatedTarget:Element|null)=>void;
}

const ActiveDraftContext=createContext<ActiveDraftContextValue|null>(null);

function ActiveBlockEditor(){
  const draft=useContext(ActiveDraftContext);
  if(!draft)return null;
  return <ActiveBlockEditorInner key={draft.session} draft={draft}/>;
}

function ActiveBlockEditorInner({draft}:{draft:ActiveDraftContextValue}){
  const {session,editorRef,sourceStart,text,caret,spellCheck,grammarCheck,onSuggestionChange,onSuggestionAction}=draft;
  const areaRef=useRef<HTMLTextAreaElement|null>(null);
  const draftRef=useRef(draft);
  draftRef.current=draft;
  const getOrCreateTextarea=useCallback(()=>{
    let area=areaRef.current;
    if(!area){
      const initial=draftRef.current;
      area=document.createElement('textarea');
      area.setAttribute('data-source-start',String(initial.sourceStart));
      area.spellcheck=false;
      area.setAttribute('spellcheck','false');
      area.setAttribute('aria-label','Edit Markdown block');
      area.defaultValue=initial.text;
      area.value=initial.text;
      area.style.height=`${Math.max(120,initial.text.split('\n').length*27+32)}px`;
      areaRef.current=area;
    }
    return area;
  },[]);
  const setHostRef=useCallback((host:HTMLDivElement|null)=>{
    const ref=draftRef.current.editorRef as {current:HTMLTextAreaElement|null};
    if(!host){
      if(ref.current===areaRef.current)ref.current=null;
      return;
    }
    const area=getOrCreateTextarea();
    if(area.parentElement!==host)host.insertBefore(area,host.firstChild);
    ref.current=area;
  },[getOrCreateTextarea]);
  useLayoutEffect(()=>{
    const area=areaRef.current;
    if(!area)return;
    (draftRef.current.editorRef as {current:HTMLTextAreaElement|null}).current=area;
    let disposed=false;
    const onPaste=(event:ClipboardEvent)=>draftRef.current.onPaste(area,event);
    const onBeforeInput=(event:Event)=>draftRef.current.onBeforeInput((event as InputEvent).inputType);
    const onFocus=()=>draftRef.current.onRememberSelection(area);
    const onSelect=()=>{draftRef.current.onSyncCaret(area);draftRef.current.onRememberSelection(area);};
    const onPointerUp=()=>{draftRef.current.onSyncCaret(area);draftRef.current.onRememberSelection(area);};
    const onClick=()=>{draftRef.current.onSyncCaret(area);draftRef.current.onRememberSelection(area);};
    const onInput=(event:Event)=>{
      const inputType=(event as InputEvent).inputType;
      const dir=inputType==='historyUndo'?'undo':inputType==='historyRedo'?'redo':undefined;
      draftRef.current.onSyncCaret(area);
      draftRef.current.onChange(area.value,area,dir?{historyDirection:dir}:undefined);
    };
    const onKeyUp=(event:KeyboardEvent)=>{
      draftRef.current.onSyncCaret(area);
      draftRef.current.onRememberSelection(area);
      if(CARET_KEYS.has(event.key))draftRef.current.onCaretMove();
    };
    const onKeyDown=(event:KeyboardEvent)=>draftRef.current.onKeyDown(area,event);
    const onBlur=(event:FocusEvent)=>{
      if(disposed||!area.isConnected)return;
      const related=event.relatedTarget;
      const shouldClose=!(related instanceof Node&&area.parentElement?.contains(related));
      draftRef.current.onBlurSession(session,area,shouldClose,related instanceof Element?related:null);
    };
    area.addEventListener('paste',onPaste);
    area.addEventListener('beforeinput',onBeforeInput);
    area.addEventListener('focus',onFocus);
    area.addEventListener('select',onSelect);
    area.addEventListener('pointerup',onPointerUp);
    area.addEventListener('click',onClick);
    area.addEventListener('input',onInput);
    area.addEventListener('keyup',onKeyUp);
    area.addEventListener('keydown',onKeyDown);
    area.addEventListener('blur',onBlur);
    return()=>{
      disposed=true;
      area.removeEventListener('paste',onPaste);
      area.removeEventListener('beforeinput',onBeforeInput);
      area.removeEventListener('focus',onFocus);
      area.removeEventListener('select',onSelect);
      area.removeEventListener('pointerup',onPointerUp);
      area.removeEventListener('click',onClick);
      area.removeEventListener('input',onInput);
      area.removeEventListener('keyup',onKeyUp);
      area.removeEventListener('keydown',onKeyDown);
      area.removeEventListener('blur',onBlur);
      const ref=draftRef.current.editorRef as {current:HTMLTextAreaElement|null};
      if(ref.current===area)ref.current=null;
    };
  },[session]);
  useLayoutEffect(()=>{
    const area=editorRef.current??areaRef.current;
    if(!area)return;
    const nextStart=String(sourceStart);
    if(area.getAttribute('data-source-start')!==nextStart)area.setAttribute('data-source-start',nextStart);
    if(area.value!==text)area.value=text;
    const nextHeight=`${Math.max(120,text.split('\n').length*27+32)}px`;
    if(area.style.height!==nextHeight)area.style.height=nextHeight;
  },[editorRef,sourceStart,text]);
  return (
    <div ref={setHostRef} className="live-active-block">
      <WritingSuggestions text={text} caret={caret} spellCheck={spellCheck} grammarCheck={grammarCheck} onChange={onSuggestionChange} onAction={onSuggestionAction}/>
    </div>
  );
}

interface Props extends WritingOptions,ReaderAccessibilityPreference {
  latexAutofix?:boolean;
  typewriterScroll?:boolean;
  markdown:string;onChange:(value:string,meta?:LiveHistoryEditMeta)=>void;documentPath:string|null;savedDocumentPath?:string|null;python:string;dark:boolean;
  onHistory?:(direction:'undo'|'redo')=>boolean;
  historyReplayToken?:number;
  trustedImageHosts?:string[];onTrustImageHost?:(host:string)=>void;onNotice?:(message:string)=>void;
}

interface LiveEditorState {
  markdown:string;
  onChange:(value:string,meta?:LiveHistoryEditMeta)=>void;
  onHistory?:(direction:'undo'|'redo')=>boolean;
  latexAutofix:boolean;
  activeTypewriter:boolean;
  editing:EditingSession|null;
  draftText:string;
  renderedSource:string;
  sourceAnalysis:SourceDocumentAnalysis;
  frontmatter:SourceDocumentAnalysis['analysis']['frontmatter'];
}

/** One document render preserves references, footnote numbering, duplicate
 * heading IDs and loose lists. Substitute one original-source editing block. */
export default function LiveEditor({markdown,onChange,onHistory,historyReplayToken,documentPath,savedDocumentPath,python,dark,trustedImageHosts=noTrustedHosts,onTrustImageHost,onNotice,spellCheck=false,grammarCheck=false,latexAutofix=false,typewriterScroll,fullDocumentAccessibility=false}:Props){
  const [editing,setEditing]=useState<EditingSession|null>(null);
  const [draftText,setDraftText]=useState('');
  const [caret,setCaret]=useState(0);
  const activeTypewriter=useTypewriterScroll(typewriterScroll);
  const sessionCounter=useRef(0);
  const anchorTop=useRef<number|null>(null),editor=useRef<HTMLTextAreaElement>(null),rootRef=useRef<HTMLDivElement>(null);
  const blockHistory=useRef<BlockHistoryState>(createBlockHistoryState());
  const lastSelection=useRef<{start:number;end:number;direction:SelectionDirection}>({start:0,end:0,direction:'none'});
  const pendingSelection=useRef<BlockSelection|null>(null);
  const pendingInputMetaRef=useRef<LiveHistoryEditMeta|null>(null);
  const appliedHistoryReplayRef=useRef(historyReplayToken);
  const pendingBlockFocus=useRef<PendingBlockFocus>(null);
  const outsidePressRef=useRef<{active:boolean;deferredClose:boolean;target:HTMLElement|null;clientY:number|null;session:number;timer:number}>({active:false,deferredClose:false,target:null,clientY:null,session:0,timer:0});
  const editSpanRef=useRef<EditSpan|null>(null);
  const blockKeyState=useRef<BlockKeyState>({source:'',keys:new Map(),seq:0});
  const syncedMarkdownRef=useRef(markdown);
  if(!editing)syncedMarkdownRef.current=markdown;
  const savedSelection=useRef<SavedLiveSelection|null>(null);

  const renderedSource=editing?editing.baseMarkdown:markdown;
  const sourceAnalysis=useMemo(()=>({source:renderedSource,analysis:analyzeDocument(renderedSource)}),[renderedSource]);
  const blocks=sourceAnalysis.analysis.bodyBlocks;
  const frontmatter=sourceAnalysis.analysis.frontmatter;
  const hasBodyNodes=sourceAnalysis.analysis.tree.children.some(node=>node.position?.start.offset!==undefined);
  const protectedSpans=useMemo(()=>sourceAnalysis.analysis.tree.children.filter(node=>['code','math','html','definition'].includes(node.type)&&node.position?.start.offset!==undefined&&node.position?.end.offset!==undefined).map(node=>[node.position!.start.offset!,node.position!.end.offset!] as const),[sourceAnalysis]);
  const latestRef=useRef<LiveEditorState>({markdown,onChange,onHistory,latexAutofix,activeTypewriter,editing,draftText,renderedSource,sourceAnalysis,frontmatter});
  latestRef.current={markdown,onChange,onHistory,latexAutofix,activeTypewriter,editing,draftText,renderedSource,sourceAnalysis,frontmatter};

  const rememberSelection=useCallback((area:HTMLTextAreaElement|null,current:EditingSession|null=latestRef.current.editing)=>{
    if(!area||!current)return;
    if(current.insertAfter!==undefined&&area.value===''){
      const doc=current.baseMarkdown,pos=Math.max(0,Math.min(current.baseSplitEnd,doc.length));
      savedSelection.current={from:pos,to:pos,markdown:doc};
      return;
    }
    const base=current.prefix.length,doc=current.prefix+area.value+current.suffix;
    const from=Math.max(0,Math.min(base+area.selectionStart,doc.length));
    const to=Math.max(from,Math.min(base+area.selectionEnd,doc.length));
    savedSelection.current={from,to,markdown:doc};
  },[]);

  const syncSelection=useCallback((area:HTMLTextAreaElement|null=editor.current,current:EditingSession|null=latestRef.current.editing)=>{
    if(!area)return;
    lastSelection.current={
      start:area.selectionStart,
      end:area.selectionEnd,
      direction:area.selectionDirection||'none',
    };
    rememberSelection(area,current);
  },[rememberSelection]);

  useEffect(()=>{
    const startSelect=(event:PointerEvent|MouseEvent)=>{
      if('pointerType' in event&&event.pointerType!=='mouse')return;
      if(event.button!==0)return;
      const target=event.target instanceof Element?event.target:null;
      if(target?.closest('.live-block-edit'))return;
      document.documentElement.dataset.liveSelecting='true';
    };
    const endSelect=()=>{delete document.documentElement.dataset.liveSelecting;};
    document.addEventListener('pointerdown',startSelect,true);
    document.addEventListener('mousedown',startSelect,true);
    document.addEventListener('pointerup',endSelect,true);
    document.addEventListener('mouseup',endSelect,true);
    document.addEventListener('pointercancel',endSelect,true);
    window.addEventListener('blur',endSelect);
    return()=>{
      endSelect();
      document.removeEventListener('pointerdown',startSelect,true);
      document.removeEventListener('mousedown',startSelect,true);
      document.removeEventListener('pointerup',endSelect,true);
      document.removeEventListener('mouseup',endSelect,true);
      document.removeEventListener('pointercancel',endSelect,true);
      window.removeEventListener('blur',endSelect);
    };
  },[]);

  const blockKeys=useMemo(()=>reconcileBlockKeys(blockKeyState.current,renderedSource,blocks,editSpanRef),[renderedSource,blocks]);

  const {closeAnchorRef,typingFrame,captureCloseAnchor,syncActiveCaretCenter}=useLiveViewportHold({
    editing,
    activeTypewriter,
    rootRef,
    editorRef:editor,
    anchorTop,
    pendingSelection,
    pendingBlockFocus,
    latestRef,
    syncSelection,
  });

  const closeEditor=useCallback((target?:Element|null,clientY?:number|null)=>{
    if(typingFrame.current){cancelAnimationFrame(typingFrame.current);typingFrame.current=0;}
    window.clearTimeout(outsidePressRef.current.timer);
    outsidePressRef.current.active=false;
    outsidePressRef.current.deferredClose=false;
    captureCloseAnchor(target,clientY);
    latestRef.current.editing=null;
    setEditing(null);
  },[captureCloseAnchor,typingFrame]);

  const resetOutsidePress=useCallback((session:number)=>{
    window.clearTimeout(outsidePressRef.current.timer);
    outsidePressRef.current={active:false,deferredClose:false,target:null,clientY:null,session,timer:0};
    closeAnchorRef.current=null;
  },[closeAnchorRef]);

  const openDocBlock=useCallback((element:HTMLElement|null,start:number,end:number,baseDoc?:string,selection?:BlockSelection,protectedHint?:boolean)=>{
    const {editing:currentEditing,markdown:latestMarkdown,sourceAnalysis:latestAnalysis}=latestRef.current;
    const resolvedDoc=baseDoc??(currentEditing?syncedMarkdownRef.current:latestMarkdown);
    const session=++sessionCounter.current;
    resetOutsidePress(session);
    anchorTop.current=element?element.getBoundingClientRect().top:null;
    blockHistory.current=createBlockHistoryState();
    pendingInputMetaRef.current=null;
    lastSelection.current={start:selection?.start??0,end:selection?.end??0,direction:selection?.direction??'none'};
    pendingSelection.current=selection??null;
    const text=resolvedDoc.slice(start,end);
    const protectedBlock=protectedHint??(resolvedDoc===latestAnalysis.source?latestAnalysis.analysis:analyzeDocument(resolvedDoc)).tree.children.some(node=>['code','math','html','definition'].includes(node.type)&&(node.position?.start.offset??-1)>=start&&(node.position?.end.offset??Infinity)<=end);
    const nextSession:EditingSession={session,prefix:resolvedDoc.slice(0,start),suffix:resolvedDoc.slice(end),baseMarkdown:resolvedDoc,baseSplitEnd:end,protectedBlock};
    syncedMarkdownRef.current=resolvedDoc;
    latestRef.current.editing=nextSession;
    latestRef.current.draftText=text;
    setCaret(selection?.start??0);
    setDraftText(text);
    setEditing(nextSession);
  },[resetOutsidePress]);

  const openRenderedBlock=useCallback((element:HTMLElement|null,renderedStart:number,renderedEnd:number,protectedHint?:boolean,caretRange?:Range|null)=>{
    const {editing:currentEditing,markdown:latestMarkdown,renderedSource:frozenSource,sourceAnalysis:latestAnalysis}=latestRef.current;
    const activeDoc=currentEditing?syncedMarkdownRef.current:latestMarkdown;
    const [start,end]=translateRenderedRange(renderedStart,renderedEnd,currentEditing,activeDoc);
    const caretOffset=!protectedHint&&caretRange
      ?resolveLiveCaretOffset(element,caretRange,frozenSource,renderedStart,renderedEnd,latestAnalysis.source===frozenSource?latestAnalysis.analysis.tree:undefined)
      :null;
    openDocBlock(element,start,end,activeDoc,caretOffset!==null?{start:caretOffset,end:caretOffset}:undefined,protectedHint);
  },[openDocBlock]);

  const openInsertedBlock=useCallback((baseDoc:string,insertPos:number,insertAfter:number|'end')=>{
    const session=++sessionCounter.current;
    resetOutsidePress(session);
    anchorTop.current=null;
    blockHistory.current=createBlockHistoryState();
    pendingInputMetaRef.current=null;
    lastSelection.current={start:0,end:0,direction:'none'};
    pendingSelection.current={start:0,end:0,direction:'none'};
    setCaret(0);
    const head=baseDoc.slice(0,insertPos),tail=baseDoc.slice(insertPos);
    const sepBefore=!head.length||head.endsWith('\n\n')?'':head.endsWith('\n')?'\n':'\n\n';
    const suffix=!tail.trim()?(tail.includes('\n')?'\n':''):tail.startsWith('\n\n')?tail:tail.startsWith('\n')?'\n'+tail:'\n\n'+tail;
    const nextSession:EditingSession={session,prefix:head+sepBefore,suffix,baseMarkdown:baseDoc,baseSplitEnd:insertPos,protectedBlock:false,insertAfter};
    syncedMarkdownRef.current=baseDoc;
    latestRef.current.editing=nextSession;
    latestRef.current.draftText='';
    setDraftText('');
    setEditing(nextSession);
  },[resetOutsidePress]);

  const appendTrailingBlock=useCallback(()=>{
    const {editing:active,markdown:latestMarkdown,sourceAnalysis:latestAnalysis}=latestRef.current;
    if(active?.insertAfter==='end'){editor.current?.focus({preventScroll:true});return;}
    const baseDoc=active?syncedMarkdownRef.current:latestMarkdown;
    const analysis=baseDoc===latestAnalysis.source?latestAnalysis.analysis:analyzeDocument(baseDoc);
    const bodyHasNodes=analysis.tree.children.some(node=>node.position?.start.offset!==undefined);
    if(!baseDoc.trim()||!bodyHasNodes){
      const start=analysis.bodyBlocks[0]?.start??0;
      openDocBlock(rootRef.current?.querySelector<HTMLElement>('.live-block')??null,start,baseDoc.length,baseDoc,{start:0,end:0},false);
      return;
    }
    const insertPos=baseDoc.replace(/[ \t]*\n+$/,'').length;
    openInsertedBlock(baseDoc,insertPos,'end');
  },[openDocBlock,openInsertedBlock]);

  const reanchorHistorySession=useCallback((previousMarkdown:string,nextMarkdown:string)=>{
    const target=resolveReanchoredHistoryTarget(previousMarkdown,nextMarkdown);
    if(!target){closeEditor();return;}
    openDocBlock(null,target.start,target.end,nextMarkdown,{start:target.caretOffset,end:target.caretOffset},target.protectedHint);
  },[closeEditor,openDocBlock]);

  useLayoutEffect(()=>{
    const isHistoryReplay=historyReplayToken!==appliedHistoryReplayRef.current;
    appliedHistoryReplayRef.current=historyReplayToken;
    const active=latestRef.current.editing;
    const previousMarkdown=syncedMarkdownRef.current;
    if(active&&markdown!==previousMarkdown){
      if(isHistoryReplay)reanchorHistorySession(previousMarkdown,markdown);
      else closeEditor();
    }
    if(savedSelection.current&&savedSelection.current.markdown!==markdown)savedSelection.current=null;
  },[markdown,historyReplayToken,closeEditor,reanchorHistorySession]);

  useLayoutEffect(()=>{
    const sel=pendingSelection.current,area=editor.current;
    if(!editing||!sel||!area)return;
    pendingSelection.current=null;
    area.focus({preventScroll:true});
    const max=area.value.length;
    const start=Math.max(0,Math.min(max,sel.start));
    const end=Math.max(start,Math.min(max,sel.end));
    const direction=sel.direction||'none';
    area.setSelectionRange(start,end,direction);
    lastSelection.current={start,end,direction};
    setCaret(start);
    rememberSelection(area,latestRef.current.editing);
  },[editing,draftText,rememberSelection]);

  const isEditing=Boolean(editing);
  useEffect(()=>{
    if(!isEditing)return;
    const finish=()=>{
      const state=outsidePressRef.current;
      window.clearTimeout(state.timer);
      const {deferredClose,target,clientY,session}=state;
      const focusLeft=document.activeElement!==editor.current&&!editor.current?.parentElement?.contains(document.activeElement);
      state.active=false;state.deferredClose=false;state.target=null;state.clientY=null;state.timer=0;
      const current=latestRef.current.editing;
      if(current&&current.session===session&&(deferredClose||focusLeft))closeEditor(target,clientY);
    };
    const beginPress=(event:PointerEvent|MouseEvent)=>{
      const target=event.target instanceof Element?event.target as HTMLElement:null;
      if(target?.closest('.live-active-block,.formatbar')){
        window.clearTimeout(outsidePressRef.current.timer);
        outsidePressRef.current.active=false;
        outsidePressRef.current.deferredClose=false;
        return;
      }
      window.clearTimeout(outsidePressRef.current.timer);
      outsidePressRef.current.active=true;
      outsidePressRef.current.target=target;
      outsidePressRef.current.clientY=event.clientY;
      outsidePressRef.current.session=latestRef.current.editing?.session??sessionCounter.current;
    };
    const onPointerUp=(event:PointerEvent)=>{
      if(!outsidePressRef.current.active)return;
      window.clearTimeout(outsidePressRef.current.timer);
      outsidePressRef.current.clientY=event.clientY;
      // Touch browsers synthesize mousedown -> blur -> mouseup -> click after
      // pointerup; keep deferral alive until that click dispatches.
      outsidePressRef.current.timer=window.setTimeout(finish,event.pointerType==='touch'?80:0);
    };
    const onMouseUp=(event:MouseEvent)=>{
      if(!outsidePressRef.current.active)return;
      window.clearTimeout(outsidePressRef.current.timer);
      outsidePressRef.current.clientY=event.clientY;
      outsidePressRef.current.timer=window.setTimeout(finish,0);
    };
    const onClick=(event:MouseEvent)=>{
      if(!outsidePressRef.current.active)return;
      const target=event.target instanceof HTMLElement?event.target:null;
      if(target?.closest('.live-active-block,.formatbar'))return;
      if(target)outsidePressRef.current.target=target;
      outsidePressRef.current.deferredClose=true;
      outsidePressRef.current.clientY=event.clientY;
      window.clearTimeout(outsidePressRef.current.timer);
      outsidePressRef.current.timer=window.setTimeout(finish,0);
    };
    const onPointerCancel=()=>{if(outsidePressRef.current.active)finish();};
    document.addEventListener('pointerdown',beginPress,true);
    document.addEventListener('mousedown',beginPress,true);
    document.addEventListener('pointerup',onPointerUp,true);
    document.addEventListener('mouseup',onMouseUp,true);
    document.addEventListener('pointercancel',onPointerCancel,true);
    document.addEventListener('click',onClick,true);
    return()=>{
      window.clearTimeout(outsidePressRef.current.timer);
      document.removeEventListener('pointerdown',beginPress,true);
      document.removeEventListener('mousedown',beginPress,true);
      document.removeEventListener('pointerup',onPointerUp,true);
      document.removeEventListener('mouseup',onMouseUp,true);
      document.removeEventListener('pointercancel',onPointerCancel,true);
      document.removeEventListener('click',onClick,true);
    };
  },[isEditing,closeEditor]);

  useEffect(()=>{
    if(!isEditing)return;
    const syncCaret=()=>{const area=editor.current;if(area&&document.activeElement===area)setCaret(area.selectionStart);};
    document.addEventListener('selectionchange',syncCaret);
    return()=>document.removeEventListener('selectionchange',syncCaret);
  },[isEditing]);

  useLiveInsertionPoint(rootRef,editor,latestRef,syncedMarkdownRef,savedSelection,rememberSelection);

  useEffect(()=>{
    const root=rootRef.current;if(!root)return;
    const onEditBlock=(event:Event)=>{
      const blockEl=(event.target instanceof Element?event.target:null)?.closest<HTMLElement>('.live-block');
      if(!blockEl||!root.contains(blockEl))return;
      const start=Number(blockEl.dataset.sourceStart),end=Number(blockEl.dataset.sourceEnd);
      if(Number.isFinite(start)&&Number.isFinite(end)){
        window.getSelection()?.removeAllRanges();
        openRenderedBlock(blockEl,start,end);
      }
    };
    const onContainerDoubleClick=(event:MouseEvent)=>{
      const target=event.target instanceof Element?event.target:null;
      if(!target||target.closest('.live-block,.live-active-block,a,button,input,select,textarea,.reading-search,.image-viewer,.media-dialog,.math-repair-panel,[data-frontmatter-properties],.document-properties'))return;
      const doc=latestRef.current.editing?syncedMarkdownRef.current:latestRef.current.markdown;
      if(!doc.trim())return;
      const allBlocks=root.querySelectorAll<HTMLElement>('.live-block');
      const lastBlock=allBlocks[allBlocks.length-1];
      if(lastBlock){
        const rect=lastBlock.getBoundingClientRect();
        if(rect.height>0&&event.clientY<rect.bottom-2)return;
      }
      window.getSelection()?.removeAllRanges();
      appendTrailingBlock();
    };
    root.addEventListener('supermd-edit-block',onEditBlock);
    const scroller=root.closest<HTMLElement>('.android-reading,.reading-scroll,.live-pane');
    const surface=scroller??root;
    surface.addEventListener('dblclick',onContainerDoubleClick);
    return()=>{
      root.removeEventListener('supermd-edit-block',onEditBlock);
      surface.removeEventListener('dblclick',onContainerDoubleClick);
    };
  },[openRenderedBlock,appendTrailingBlock]);

  const handleRememberSelection=useCallback((area:HTMLTextAreaElement)=>{
    syncSelection(area,latestRef.current.editing);
  },[syncSelection]);

  const blurSession=useCallback((session:number,area:HTMLTextAreaElement,shouldClose:boolean,relatedTarget:Element|null)=>{
    if(latestRef.current.editing?.session===session)rememberSelection(area,latestRef.current.editing);
    if(!shouldClose)return;
    if(outsidePressRef.current.active&&outsidePressRef.current.session===session){
      outsidePressRef.current.deferredClose=true;
      return;
    }
    if(latestRef.current.editing?.session===session)closeEditor(relatedTarget);
  },[rememberSelection,closeEditor]);

  const copy=useCallback((event:ReactClipboardEvent)=>{
    if((event.target as Element).closest('textarea'))return;
    const source=selectedMarkdown(window.getSelection(),latestRef.current.renderedSource);
    if(source!==null){event.clipboardData.setData('text/plain',source);event.preventDefault();}
  },[]);

  const dragStart=useCallback((event:DragEvent<HTMLDivElement>)=>{
    setSelectedMarkdownDrag(event.nativeEvent,latestRef.current.renderedSource);
  },[]);

  const emitEditorChange=useCallback((value:string,meta?:LiveHistoryEditMeta)=>{
    const emit=latestRef.current.onChange;
    if(meta&&(meta.historyDirection||meta.isolateHistory))emit(value,meta);
    else emit(value);
  },[]);

  const update=useCallback((text:string,selectionStart?:number,selectionEnd?:number,meta?:LiveHistoryEditMeta)=>{
    const {editing:active,frontmatter:currentFrontmatter}=latestRef.current;
    const resolvedMeta=meta??pendingInputMetaRef.current??undefined;
    pendingInputMetaRef.current=null;
    if(!active)return;
    latestRef.current.draftText=text;
    setDraftText(text);
    if(active.insertAfter!==undefined&&text===''){
      const changed=syncedMarkdownRef.current!==active.baseMarkdown;
      syncedMarkdownRef.current=active.baseMarkdown;
      editSpanRef.current=null;
      const pos=Math.max(0,Math.min(active.baseSplitEnd,active.baseMarkdown.length));
      savedSelection.current={from:pos,to:pos,markdown:active.baseMarkdown};
      if(changed)emitEditorChange(active.baseMarkdown,resolvedMeta);
      syncActiveCaretCenter();
      return;
    }
    const needsNewline=Boolean(currentFrontmatter)&&active.prefix.length===currentFrontmatter!.end&&active.prefix.length>0&&!active.prefix.endsWith('\n')&&text.length>0;
    const prefix=needsNewline?active.prefix+'\n':active.prefix;
    const nextMarkdown=prefix+text+active.suffix,base=prefix.length;
    if(selectionStart!==undefined&&selectionEnd!==undefined){
      const from=Math.max(0,Math.min(base+selectionStart,nextMarkdown.length));
      const to=Math.max(from,Math.min(base+selectionEnd,nextMarkdown.length));
      savedSelection.current={from,to,markdown:nextMarkdown};
    }else if(savedSelection.current){
      const delta=prefix.length-active.prefix.length;
      const max=base+text.length;
      const from=Math.max(base,Math.min(savedSelection.current.from+delta,max));
      const to=Math.max(from,Math.min(savedSelection.current.to+delta,max));
      savedSelection.current={from,to,markdown:nextMarkdown};
    }
    editSpanRef.current={
      baseSource:active.baseMarkdown,
      start:Math.min(prefix.length,active.baseSplitEnd),
      oldEnd:active.baseSplitEnd,
      newEnd:active.baseSplitEnd+nextMarkdown.length-active.baseMarkdown.length,
    };
    if(prefix!==active.prefix){
      const nextSession={...active,prefix};
      latestRef.current.editing=nextSession;
      setEditing(nextSession);
    }
    syncedMarkdownRef.current=nextMarkdown;
    emitEditorChange(nextMarkdown,resolvedMeta);
    syncActiveCaretCenter();
  },[emitEditorChange,syncActiveCaretCenter]);

  const {handleBeforeInput,handleTextareaChange,handleSuggestionChange,handleSuggestionAction,syncTextareaCaret,paste,onEditorKeyDown}=useLiveBlockEditing({
    editing,
    editorRef:editor,
    latestRef,
    syncedMarkdownRef,
    blockHistory,
    lastSelection,
    pendingSelection,
    pendingInputMetaRef,
    pendingBlockFocus,
    setCaret,
    rememberSelection,
    update,
    closeEditor,
    openInsertedBlock,
    openDocBlock,
  });

  const activeDraftValue=useMemo<ActiveDraftContextValue|null>(
    ()=>editing?{
      session:editing.session,
      editorRef:editor,
      sourceStart:editing.insertAfter!==undefined&&draftText===''?editing.baseSplitEnd:editing.prefix.length,
      text:draftText,
      caret,
      spellCheck,
      grammarCheck,
      onChange:handleTextareaChange,
      onBeforeInput:handleBeforeInput,
      onSuggestionChange:handleSuggestionChange,
      onSuggestionAction:handleSuggestionAction,
      onSyncCaret:syncTextareaCaret,
      onPaste:paste,
      onKeyDown:onEditorKeyDown,
      onCaretMove:syncActiveCaretCenter,
      onRememberSelection:handleRememberSelection,
      onBlurSession:blurSession,
    }:null,
    [editing,draftText,caret,spellCheck,grammarCheck,handleTextareaChange,handleBeforeInput,handleSuggestionChange,handleSuggestionAction,syncTextareaCaret,paste,onEditorKeyDown,syncActiveCaretCenter,handleRememberSelection,blurSession],
  );

  const renderBlock=useCallback((entry:RenderedMarkdownBlock)=>{
    const offset=entry.node.position?.start.offset;
    // Generated footnote sections have no editable span. Render exactly once.
    if(offset===undefined)return <Fragment key={`extra-${entry.key}`}>{entry.content}</Fragment>;
    let low=0,high=blocks.length-1;while(low<high){const middle=(low+high+1)>>>1;if(blocks[middle].start<=offset)low=middle;else high=middle-1;}
    // Inter-block whitespace belongs outside the editor. Replacing all text
    // in a heading/paragraph must not join it onto the following source block.
    const block=blocks[low],start=block.start,end=entry.node.position?.end.offset??block.end;
    const active=!!editing&&editing.insertAfter===undefined&&block.start===editing.prefix.length;
    const insertedBelow=!!editing&&editing.insertAfter===block.start;
    const blockKey=blockKeys.get(block.start)??`block-${entry.key}`;
    const protectedHint=protectedSpans.some(([s,e])=>s>=start&&e<=end);
    return (
      <Fragment key={blockKey}>
        <LiveBlockShell windowed={entry.windowed} estimate={entry.estimate} text={entry.text} headings={entry.headings} start={start} end={end} blockIndex={low} active={active} protectedHint={protectedHint} onOpen={openRenderedBlock} editor={<ActiveBlockEditor/>}>
          {entry.content}
        </LiveBlockShell>
        {insertedBelow&&<section className="live-block" role="group" aria-label="New Markdown block"><ActiveBlockEditor/></section>}
      </Fragment>
    );
  },[blocks,blockKeys,editing,openRenderedBlock,protectedSpans]);

  const previewChange=useCallback((next:string)=>{
    const {editing:currentEditing,renderedSource:frozenSource}=latestRef.current;
    if(!currentEditing){emitEditorChange(next,{isolateHistory:true});return;}
    // Translate a checkbox outside the frozen editor without losing its draft.
    const activeDoc=syncedMarkdownRef.current;
    const {start,oldEnd:end,newEnd:nextEnd}=diffTextSpan(frozenSource,next);
    const [from,to]=translateRenderedRange(start,end,currentEditing,activeDoc);
    captureCloseAnchor(outsidePressRef.current.target,outsidePressRef.current.clientY);
    window.clearTimeout(outsidePressRef.current.timer);
    outsidePressRef.current.active=false;
    outsidePressRef.current.deferredClose=false;
    latestRef.current.editing=null;
    setEditing(null);
    emitEditorChange(activeDoc.slice(0,from)+next.slice(start,nextEnd)+activeDoc.slice(to),{isolateHistory:true});
  },[captureCloseAnchor,emitEditorChange]);

  return <ActiveDraftContext.Provider value={activeDraftValue}>
    <div ref={rootRef} className="live-document" onCopy={copy} onDragStart={dragStart}>
      {!frontmatter&&!renderedSource.trim()?(editing?<ActiveBlockEditor/>:<section className="live-block" data-source-start={0} data-source-end={markdown.length} tabIndex={0} role="group" aria-label="Editable block 1" onClick={event=>openDocBlock(event.currentTarget,0,latestRef.current.markdown.length,latestRef.current.markdown,undefined,false)} onDoubleClick={event=>openDocBlock(event.currentTarget,0,latestRef.current.markdown.length,latestRef.current.markdown,undefined,false)} onKeyDown={event=>{if(event.key==='Enter'||event.key==='F2'){event.preventDefault();openDocBlock(event.currentTarget,0,latestRef.current.markdown.length,latestRef.current.markdown,undefined,false);}}}/> ):<>
        <MarkdownPreview markdown={renderedSource} onChange={previewChange} documentPath={documentPath} savedDocumentPath={savedDocumentPath} python={python} dark={dark} trustedImageHosts={trustedImageHosts} onTrustImageHost={onTrustImageHost} onNotice={onNotice} renderBlock={renderBlock} fullDocumentAccessibility={fullDocumentAccessibility} sourceAnalysis={sourceAnalysis}/>
        {!hasBodyNodes?(editing?<ActiveBlockEditor/>:<section className="live-block" data-source-start={blocks[0].start} data-source-end={markdown.length} tabIndex={0} role="group" aria-label="Editable block 1" onClick={event=>openDocBlock(event.currentTarget,blocks[0].start,latestRef.current.markdown.length,latestRef.current.markdown,undefined,false)} onDoubleClick={event=>openDocBlock(event.currentTarget,blocks[0].start,latestRef.current.markdown.length,latestRef.current.markdown,undefined,false)} onKeyDown={event=>{if(event.key==='Enter'||event.key==='F2'){event.preventDefault();openDocBlock(event.currentTarget,blocks[0].start,latestRef.current.markdown.length,latestRef.current.markdown,undefined,false);}}}/> ):editing?.insertAfter==='end'&&<section className="live-block" role="group" aria-label="New Markdown block"><ActiveBlockEditor/></section>}
      </>}
    </div>
  </ActiveDraftContext.Provider>;
}
