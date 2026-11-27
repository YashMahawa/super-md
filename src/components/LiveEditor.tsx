import {createContext,Fragment,useCallback,useContext,useEffect,useLayoutEffect,useMemo,useRef,useState,type ClipboardEvent,type DragEvent,type KeyboardEvent as ReactKeyboardEvent,type ReactNode,type RefObject} from 'react';
import {PencilSimpleIcon} from '@phosphor-icons/react';
import MarkdownPreview from './MarkdownPreview';
import WindowedBlock,{type WindowHeading} from './WindowedBlock';
import type {RenderedMarkdownBlock} from './CachedMarkdown';
import {analyzeDocument,type SourceBlock,type SourceDocumentAnalysis} from '../documentAnalysis';
import {sharedDocumentAnalysisClient,useDocumentAnalysis} from '../documentAnalysisWorker';
import {alignRangeToCurrentSource,applyAlignedTaskToggle} from '../revisionEdit';
import {selectedMarkdown,setSelectedMarkdownDrag} from '../copySource';
import {refreshDocumentExtent} from '../documentZoom';
import type {WritingOptions} from '../proofreading';
import type {ReaderAccessibilityPreference} from '../types';
import WritingSuggestions from './WritingSuggestions';
import {repairPastedMath} from '../mathRepair';
import {
  applyMarkdownUrlPaste,
  formatActionFromKeyEvent,
  normalizeFormatAction,
  notifyHistoryBoundary,
  parseStandaloneHttpUrl,
  toggleMarkdownFormat,
  type FormatAction,
} from '../markdownFormatting';
import {editableBlockSpans,indentMarkdownSelection,isFirstLineCursor,isLastLineCursor} from '../liveBlockFlow';
import {handleLiveEditorKey} from '../liveEditorKeys';
import {liveEditorCenterDelta,useTypewriterScroll} from '../typewriterScroll';
const noTrustedHosts:string[]=[];
const CARET_KEYS=new Set(['ArrowUp','ArrowDown','PageUp','PageDown','Home','End']);
const fullscreenInteractiveSelector='a,button,input,select,textarea,summary,details,img,.note-image,.interactive-chart,.inline-diagram,.svg-figure,.mermaid,.step-cards,.remote-image-card,.image-error,.code-container';
export type {SourceBlock} from '../documentAnalysis';
export function splitMarkdownBlocks(markdown:string):SourceBlock[]{return analyzeDocument(markdown).bodyBlocks;}

interface BlockSnapshot {
  text: string;
  start: number;
  end: number;
  direction: "forward" | "backward" | "none";
}

let activeLiveFormatHandler: ((action: FormatAction) => boolean) | null = null;
let activeLiveHistoryHandler: ((direction: "undo" | "redo") => boolean) | null = null;

export function formatActiveLiveBlock(rawAction: string): boolean {
  const action = normalizeFormatAction(rawAction);
  return !!action && !!activeLiveFormatHandler && activeLiveFormatHandler(action);
}

export function replayActiveLiveBlockHistory(direction: "undo" | "redo"): boolean {
  return !!activeLiveHistoryHandler && activeLiveHistoryHandler(direction);
}

interface Props extends WritingOptions,ReaderAccessibilityPreference {
  sessionId?:string;
  noteId?:string;
  latexAutofix?:boolean;
  typewriterScroll?:boolean;
  markdown:string;onChange:(value:string)=>void;documentPath:string|null;savedDocumentPath?:string|null;python:string;dark:boolean;
  trustedImageHosts?:string[];approvedImageUrls?:readonly string[];onTrustImageHost?:(host:string)=>void;onApproveImageUrl?:(noteId:string|undefined,url:string)=>void;onRemoteImageLoaded?:(noteId:string|undefined,url:string,data:string)=>void;onNotice?:(message:string)=>void;
  sourceAnalysis?:SourceDocumentAnalysis;
}
interface EditingSession {
  session:number;
  prefix:string;
  suffix:string;
  baseMarkdown:string;
  baseSplitEnd:number;
  protectedBlock:boolean;
  frozenAnalysis:SourceDocumentAnalysis;
  insertAfter?:number|'end';
}
interface CloseAnchor {scroller:HTMLElement;element:HTMLElement;top:number}
interface EditSpan {baseSource:string;start:number;oldEnd:number;newEnd:number}

interface ActiveDraftContextValue {
  session:number;
  editorRef:RefObject<HTMLTextAreaElement|null>;
  sourceStart:number;
  text:string;
  caret:number;
  spellCheck:boolean;
  grammarCheck:boolean;
  onChange:(value:string,target:HTMLTextAreaElement)=>void;
  onSuggestionChange:(value:string)=>void;
  onSuggestionAction:(edit?:{from:number;to:number;insertLength:number})=>void;
  onSyncCaret:(area:HTMLTextAreaElement)=>void;
  onPaste:(event:ClipboardEvent<HTMLTextAreaElement>)=>void;
  onKeyDown:(event:ReactKeyboardEvent<HTMLTextAreaElement>)=>void;
  onCaretMove:()=>void;
  onRememberSelection:(area:HTMLTextAreaElement)=>void;
  onBlurSession:(session:number,area:HTMLTextAreaElement,shouldClose:boolean,relatedTarget:Element|null)=>void;
}

const ActiveDraftContext=createContext<ActiveDraftContextValue|null>(null);

function ActiveBlockEditor(){
  const draft=useContext(ActiveDraftContext);
  if(!draft)return null;
  const {session,editorRef,sourceStart,text,caret,spellCheck,grammarCheck,onChange,onSuggestionChange,onSuggestionAction,onSyncCaret,onPaste,onKeyDown,onCaretMove,onRememberSelection,onBlurSession}=draft;
  return (
    <div className="live-active-block">
      <textarea
        ref={editorRef}
        data-source-start={sourceStart}
        spellCheck={false}
        value={text}
        style={{height:Math.max(120,text.split('\n').length*27+32)}}
        onPaste={onPaste}
        onFocus={event=>onRememberSelection(event.currentTarget)}
        onSelect={event=>{onSyncCaret(event.currentTarget);onRememberSelection(event.currentTarget);}}
        onPointerUp={event=>{onSyncCaret(event.currentTarget);onRememberSelection(event.currentTarget);}}
        onClick={event=>{onSyncCaret(event.currentTarget);onRememberSelection(event.currentTarget);}}
        onChange={event=>{onSyncCaret(event.target);onChange(event.target.value,event.currentTarget);}}
        onKeyUp={event=>{onSyncCaret(event.currentTarget);onRememberSelection(event.currentTarget);if(CARET_KEYS.has(event.key))onCaretMove();}}
        onKeyDown={onKeyDown}
        onBlur={event=>{
          if(!event.currentTarget.isConnected)return;
          const related=event.relatedTarget;
          const shouldClose=!(related instanceof Node&&event.currentTarget.parentElement?.contains(related));
          onBlurSession(session,event.currentTarget,shouldClose,related instanceof Element?related:null);
        }}
        aria-label="Edit Markdown block"
      />
      <WritingSuggestions text={text} caret={caret} spellCheck={spellCheck} grammarCheck={grammarCheck} onChange={onSuggestionChange} onAction={onSuggestionAction}/>
    </div>
  );
}

interface LiveBlockShellProps {
  windowed:boolean;estimate:number;text:string;headings:WindowHeading[];
  start:number;end:number;blockIndex:number;active:boolean;protectedHint:boolean;
  onOpen:(element:HTMLElement,start:number,end:number,protectedHint:boolean)=>void;
  children:ReactNode;
}
function LiveBlockShell({windowed,estimate,text,headings,start,end,blockIndex,active,protectedHint,onOpen,children}:LiveBlockShellProps){
  const [hovered,setHovered]=useState(false);
  const [focused,setFocused]=useState(false);
  const [tapped,setTapped]=useState(false);
  const blockElRef=useRef<HTMLElement|null>(null);
  const pressingRef=useRef(false);
  const tapStartRef=useRef<{id:number;x:number;y:number;moved:boolean}|null>(null);
  useLayoutEffect(()=>{
    let f2=0;
    const f1=requestAnimationFrame(()=>{f2=requestAnimationFrame(()=>{if(blockElRef.current&&!pressingRef.current)blockElRef.current.dataset.liveMeasured='true';});});
    return()=>{cancelAnimationFrame(f1);cancelAnimationFrame(f2);};
  },[]);
  useEffect(()=>{
    if(active){setTapped(false);return;}
    if(!blockElRef.current?.contains(document.activeElement))setFocused(false);
  },[active]);
  useEffect(()=>{
    if(!tapped)return;
    const clearOutside=(event:PointerEvent)=>{
      const target=event.target instanceof Node?event.target:null;
      if(target&&!blockElRef.current?.contains(target))setTapped(false);
    };
    document.addEventListener('pointerdown',clearOutside,true);
    return()=>document.removeEventListener('pointerdown',clearOutside,true);
  },[tapped]);
  const revealed=!active&&(hovered||focused||tapped);
  return <WindowedBlock blockRef={blockElRef} enabled={windowed&&!active} estimate={estimate} text={text} headings={headings} className="live-block" data-source-start={start} data-source-end={end} tabIndex={0} role="group" aria-label={`Editable block ${blockIndex+1}`}
    onPointerEnter={event=>{blockElRef.current=event.currentTarget;if(event.pointerType==='mouse'&&event.buttons===0&&!document.querySelector('.is-panning'))setHovered(true);}}
    onPointerMove={event=>{
      blockElRef.current=event.currentTarget;
      if(tapStartRef.current?.id===event.pointerId&&Math.hypot(event.clientX-tapStartRef.current.x,event.clientY-tapStartRef.current.y)>8)tapStartRef.current.moved=true;
      if(event.pointerType==='mouse'&&event.buttons===0&&!hovered&&!document.querySelector('.is-panning'))setHovered(true);
    }}
    onPointerLeave={event=>{pressingRef.current=false;if(event.pointerType==='mouse')setHovered(false);}}
    onPointerDown={event=>{
      blockElRef.current=event.currentTarget;
      pressingRef.current=true;
      if(event.pointerType==='mouse')return;
      tapStartRef.current={id:event.pointerId,x:event.clientX,y:event.clientY,moved:false};
    }}
    onPointerUp={event=>{
      pressingRef.current=false;
      if(event.pointerType==='mouse')return;
      const tap=tapStartRef.current;tapStartRef.current=null;
      if(active||!tap||tap.id!==event.pointerId||tap.moved||Math.hypot(event.clientX-tap.x,event.clientY-tap.y)>8)return;
      if(document.querySelector('.is-panning')||window.getSelection()?.toString())return;
      const target=event.target instanceof Element?event.target:null;
      if(target?.closest('.live-block-edit,.live-active-block,.image-viewer,.reading-search,.media-dialog,.math-repair-panel'))return;
      if(document.documentElement.dataset.fullscreen==='true'&&!target?.closest(fullscreenInteractiveSelector))return;
      setTapped(true);
    }}
    onPointerCancel={()=>{pressingRef.current=false;tapStartRef.current=null;}}
    onFocus={event=>{blockElRef.current=event.currentTarget;if(!pressingRef.current)setFocused(true);}}
    onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node|null))setFocused(false);}}
    onDoubleClick={event=>{
      if(active||(event.target as Element).closest('a,button,input,select,textarea'))return;
      window.getSelection()?.removeAllRanges();onOpen(event.currentTarget,start,end,protectedHint);
    }}
    onKeyDown={event=>{if(!active&&event.target===event.currentTarget&&(event.key==='Enter'||event.key==='F2')){event.preventDefault();onOpen(event.currentTarget,start,end,protectedHint);}}}>
    {revealed?<button type="button" className="live-block-edit" data-independent-zoom aria-label="Edit block" title="Edit block" onClick={event=>{
      event.preventDefault();event.stopPropagation();
      const owner=event.currentTarget.closest<HTMLElement>('.live-block');
      if(owner)onOpen(owner,start,end,protectedHint);
    }}><PencilSimpleIcon size={13} weight="bold" aria-hidden="true"/><span>Edit</span></button>:null}
    {active?<ActiveBlockEditor/>:children}
  </WindowedBlock>;
}

function translateRenderedRange(start:number,end:number,editing:EditingSession|null,syncedMarkdown:string):[number,number] {
  if(!editing||end<=editing.baseSplitEnd)return [start,end];
  const delta=syncedMarkdown.length-editing.baseMarkdown.length;
  return [start>=editing.baseSplitEnd?start+delta:start,end+delta];
}

function resolveDocAnalysis(doc:string,candidate:SourceDocumentAnalysis|null):SourceDocumentAnalysis {
  if(candidate?.source===doc)return candidate;
  return sharedDocumentAnalysisClient.peek(doc)??{source:doc,analysis:analyzeDocument(doc)};
}

interface LiveEditorState {
  markdown:string;
  onChange:(value:string)=>void;
  latexAutofix:boolean;
  activeTypewriter:boolean;
  editing:EditingSession|null;
  draftText:string;
  renderedSource:string;
  sourceAnalysis:SourceDocumentAnalysis|null;
  frontmatter:SourceDocumentAnalysis['analysis']['frontmatter'];
}

/** One document render preserves references, footnote numbering, duplicate
 * heading IDs and loose lists. Substitute one original-source editing block. */
export default function LiveEditor({sessionId,noteId,markdown,onChange,documentPath,savedDocumentPath,python,dark,trustedImageHosts=noTrustedHosts,approvedImageUrls,onTrustImageHost,onApproveImageUrl,onRemoteImageLoaded,onNotice,spellCheck=false,grammarCheck=false,latexAutofix=false,typewriterScroll,fullDocumentAccessibility=false,sourceAnalysis:externalAnalysis}:Props){
  const [editing,setEditing]=useState<EditingSession|null>(null);
  const [draftText,setDraftText]=useState('');
  const [caret,setCaret]=useState(0);
  const activeTypewriter=useTypewriterScroll(typewriterScroll);
  const sessionCounter=useRef(0),lastHandledSession=useRef(0);
  const appliedTypewriter=useRef(false),typingFrame=useRef(0);
  const anchorTop=useRef<number|null>(null),editor=useRef<HTMLTextAreaElement>(null),rootRef=useRef<HTMLDivElement>(null);
  const blockHistory=useRef<{undo:BlockSnapshot[];redo:BlockSnapshot[];last:number}>({undo:[],redo:[],last:0});
  const suppressHistoryPush=useRef(false);
  const lastSelection=useRef<{start:number;end:number;direction:"forward"|"backward"|"none"}>({start:0,end:0,direction:"none"});
  const pendingSelection=useRef<{start:number;end:number;direction?:"forward"|"backward"|"none"}|null>(null);
  const pendingBlockFocus=useRef<{offset:number}|'end'|null>(null);
  const closeAnchorRef=useRef<CloseAnchor|null>(null);
  const outsidePressRef=useRef<{active:boolean;deferredClose:boolean;target:HTMLElement|null;clientY:number|null;session:number;timer:number}>({active:false,deferredClose:false,target:null,clientY:null,session:0,timer:0});
  const editSpanRef=useRef<EditSpan|null>(null);
  const blockKeyState=useRef<{source:string;keys:Map<number,string>;seq:number}>({source:'',keys:new Map(),seq:0});
  const syncedMarkdownRef=useRef(markdown);
  if(!editing)syncedMarkdownRef.current=markdown;
  const savedSelection=useRef<{from:number;to:number;markdown:string}|null>(null);

  const internalAnalysis=useDocumentAnalysis(sessionId??noteId??'live-editor',markdown,'live',{enabled:!externalAnalysis});
  const latestAnalysis=externalAnalysis??internalAnalysis.pinnedAnalysis;
  const sourceAnalysis=editing?editing.frozenAnalysis:latestAnalysis;
  const hasAnalysis=sourceAnalysis!==null;
  const renderedSource=sourceAnalysis?.source??'';
  const blocks=sourceAnalysis?.analysis.bodyBlocks??[];
  const frontmatter=sourceAnalysis?.analysis.frontmatter??null;
  const hasBodyNodes=sourceAnalysis?sourceAnalysis.analysis.tree.children.some(node=>node.position?.start.offset!==undefined):false;
  const latestRef=useRef<LiveEditorState>({markdown,onChange,latexAutofix,activeTypewriter,editing,draftText,renderedSource,sourceAnalysis,frontmatter});
  latestRef.current={markdown,onChange,latexAutofix,activeTypewriter,editing,draftText,renderedSource,sourceAnalysis,frontmatter};

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
      direction:area.selectionDirection||"none",
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

  const blockKeys=useMemo(()=>{
    const state=blockKeyState.current;
    if(state.source===renderedSource&&state.keys.size===blocks.length&&blocks.every(item=>state.keys.has(item.start)))return state.keys;
    const previousSource=state.source,previousKeys=state.keys;
    let diffStart=0,oldEnd=previousSource.length,newEnd=renderedSource.length;
    const span=editSpanRef.current;
    if(span&&previousSource===span.baseSource&&renderedSource.length-previousSource.length===span.newEnd-span.oldEnd){
      diffStart=span.start;
      oldEnd=span.oldEnd;
      newEnd=span.newEnd;
    }else{
      while(diffStart<oldEnd&&diffStart<newEnd&&previousSource[diffStart]===renderedSource[diffStart])diffStart++;
      while(oldEnd>diffStart&&newEnd>diffStart&&previousSource[oldEnd-1]===renderedSource[newEnd-1]){oldEnd--;newEnd--;}
    }
    editSpanRef.current=null;
    const delta=newEnd-oldEnd;
    const nextKeys=new Map<number,string>();
    const used=new Set<string>();
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
  },[renderedSource,blocks]);

  const captureCloseAnchor=useCallback((target?:Element|null,clientY?:number|null)=>{
    const area=editor.current;
    const scroller=area?.closest<HTMLElement>('.android-reading,.reading-scroll,.preview-pane,.live-scroll');
    if(!scroller||scroller.dataset.navigating)return;
    const activeBlock=area?.closest<HTMLElement>('.live-block');
    let anchorElement:HTMLElement|null=null;
    if(target&&scroller.contains(target)&&!target.closest('.live-active-block')){
      anchorElement=target.closest<HTMLElement>('.live-block')??(target instanceof HTMLElement?target:target.parentElement);
    }
    if(!anchorElement&&activeBlock){
      const activeBounds=activeBlock.getBoundingClientRect(),scrollerBounds=scroller.getBoundingClientRect();
      const nextBlock=activeBlock.nextElementSibling instanceof HTMLElement?activeBlock.nextElementSibling:null;
      if(typeof clientY==='number'&&clientY>activeBounds.bottom&&nextBlock)anchorElement=nextBlock;
      else if(activeBounds.top>=scrollerBounds.top-4)anchorElement=activeBlock;
      else if(nextBlock)anchorElement=nextBlock;
      else anchorElement=activeBlock;
    }
    if(anchorElement?.isConnected)closeAnchorRef.current={scroller,element:anchorElement,top:anchorElement.getBoundingClientRect().top};
  },[]);

  const closeEditor=useCallback((target?:Element|null,clientY?:number|null)=>{
    if(typingFrame.current){cancelAnimationFrame(typingFrame.current);typingFrame.current=0;}
    window.clearTimeout(outsidePressRef.current.timer);
    outsidePressRef.current.active=false;
    outsidePressRef.current.deferredClose=false;
    captureCloseAnchor(target,clientY);
    latestRef.current.editing=null;
    setEditing(null);
  },[captureCloseAnchor]);

  const resetOutsidePress=useCallback((session:number)=>{
    window.clearTimeout(outsidePressRef.current.timer);
    outsidePressRef.current={active:false,deferredClose:false,target:null,clientY:null,session,timer:0};
    closeAnchorRef.current=null;
  },[]);

  const openDocBlock=useCallback((element:HTMLElement|null,start:number,end:number,baseDoc?:string,selection?:{start:number;end:number;direction?:'forward'|'backward'|'none'},protectedHint?:boolean)=>{
    const {editing:currentEditing,markdown:latestMarkdown,sourceAnalysis:currentAnalysis}=latestRef.current;
    const resolvedDoc=baseDoc??(currentEditing?syncedMarkdownRef.current:latestMarkdown);
    const session=++sessionCounter.current;
    resetOutsidePress(session);
    anchorTop.current=element?element.getBoundingClientRect().top:null;
    blockHistory.current={undo:[],redo:[],last:0};
    lastSelection.current={start:selection?.start??0,end:selection?.end??0,direction:selection?.direction??"none"};
    pendingSelection.current=selection??null;
    const frozenAnalysis=resolveDocAnalysis(resolvedDoc,currentAnalysis);
    const text=resolvedDoc.slice(start,end);
    const protectedBlock=protectedHint??frozenAnalysis.analysis.tree.children.some(node=>['code','math','html','definition'].includes(node.type)&&(node.position?.start.offset??-1)>=start&&(node.position?.end.offset??Infinity)<=end);
    const nextSession:EditingSession={session,prefix:resolvedDoc.slice(0,start),suffix:resolvedDoc.slice(end),baseMarkdown:resolvedDoc,baseSplitEnd:end,protectedBlock,frozenAnalysis};
    syncedMarkdownRef.current=resolvedDoc;
    latestRef.current.editing=nextSession;
    latestRef.current.draftText=text;
    setCaret(selection?.start??0);
    setDraftText(text);
    setEditing(nextSession);
  },[resetOutsidePress]);

  const openRenderedBlock=useCallback((element:HTMLElement|null,renderedStart:number,renderedEnd:number,protectedHint?:boolean)=>{
    const {editing:currentEditing,markdown:latestMarkdown,sourceAnalysis:currentAnalysis}=latestRef.current;
    if(currentEditing){
      const activeDoc=syncedMarkdownRef.current;
      const [start,end]=translateRenderedRange(renderedStart,renderedEnd,currentEditing,activeDoc);
      openDocBlock(element,start,end,activeDoc,undefined,protectedHint);
      return;
    }
    if(!currentAnalysis)return;
    if(currentAnalysis.source===latestMarkdown){
      openDocBlock(element,renderedStart,renderedEnd,latestMarkdown,undefined,protectedHint);
      return;
    }
    const aligned=!currentAnalysis.source.trim()&&!latestMarkdown.trim()
      ? {from:0,to:latestMarkdown.length}
      : alignRangeToCurrentSource(currentAnalysis.source,latestMarkdown,renderedStart,renderedEnd);
    if(!aligned)return;
    openDocBlock(element,aligned.from,aligned.to,latestMarkdown,undefined,protectedHint);
  },[openDocBlock]);

  const openInsertedBlock=useCallback((baseDoc:string,insertPos:number,insertAfter:number|'end')=>{
    const session=++sessionCounter.current;
    resetOutsidePress(session);
    anchorTop.current=null;
    blockHistory.current={undo:[],redo:[],last:0};
    lastSelection.current={start:0,end:0,direction:"none"};
    pendingSelection.current={start:0,end:0,direction:"none"};
    setCaret(0);
    const frozenAnalysis=resolveDocAnalysis(baseDoc,latestRef.current.sourceAnalysis);
    const head=baseDoc.slice(0,insertPos),tail=baseDoc.slice(insertPos);
    const sepBefore=!head.length||head.endsWith('\n\n')?'':head.endsWith('\n')?'\n':'\n\n';
    const suffix=!tail.trim()?(tail.includes('\n')?'\n':''):tail.startsWith('\n\n')?tail:tail.startsWith('\n')?'\n'+tail:'\n\n'+tail;
    const nextSession:EditingSession={session,prefix:head+sepBefore,suffix,baseMarkdown:baseDoc,baseSplitEnd:insertPos,protectedBlock:false,frozenAnalysis,insertAfter};
    syncedMarkdownRef.current=baseDoc;
    latestRef.current.editing=nextSession;
    latestRef.current.draftText='';
    setDraftText('');
    setEditing(nextSession);
  },[resetOutsidePress]);

  const appendTrailingBlock=useCallback(()=>{
    const {editing:active,markdown:latestMarkdown,sourceAnalysis:currentAnalysis}=latestRef.current;
    if(active?.insertAfter==='end'){editor.current?.focus({preventScroll:true});return;}
    const baseDoc=active?syncedMarkdownRef.current:latestMarkdown;
    const analysis=resolveDocAnalysis(baseDoc,currentAnalysis).analysis;
    const bodyHasNodes=analysis.tree.children.some(node=>node.position?.start.offset!==undefined);
    if(!baseDoc.trim()||!bodyHasNodes){
      const start=analysis.bodyBlocks[0]?.start??0;
      openDocBlock(rootRef.current?.querySelector<HTMLElement>('.live-block')??null,start,baseDoc.length,baseDoc,{start:0,end:0},false);
      return;
    }
    const insertPos=baseDoc.replace(/[ \t]*\n+$/,'').length;
    openInsertedBlock(baseDoc,insertPos,'end');
  },[openDocBlock,openInsertedBlock]);

  useLayoutEffect(()=>{
    const doc=rootRef.current;if(!doc)return;
    const scroller=doc.closest<HTMLElement>('.android-reading,.reading-scroll,.preview-pane,.live-scroll');
    const beforePad=Number.parseFloat(getComputedStyle(doc).paddingTop)||0;
    const syncPad=()=>{
      if(!scroller||scroller.clientHeight<=0)return;
      doc.style.setProperty('--live-typewriter-pad',`${Math.max(24,Math.floor(scroller.clientHeight/2))}px`);
    };
    if(activeTypewriter){doc.dataset.typewriter='true';syncPad();}
    else{delete doc.dataset.typewriter;doc.style.removeProperty('--live-typewriter-pad');}
    const afterPad=Number.parseFloat(getComputedStyle(doc).paddingTop)||0;
    if(appliedTypewriter.current!==activeTypewriter){
      appliedTypewriter.current=activeTypewriter;
      if(scroller&&afterPad!==beforePad)scroller.scrollTop=Math.max(0,scroller.scrollTop+(afterPad-beforePad));
    }
    if(!activeTypewriter||!scroller||typeof ResizeObserver==='undefined')return;
    const observer=new ResizeObserver(syncPad);observer.observe(scroller);
    return()=>observer.disconnect();
  },[activeTypewriter,hasAnalysis]);

  useLayoutEffect(()=>{
    if(!editing){
      lastHandledSession.current=0;
      const pendingClose=closeAnchorRef.current;closeAnchorRef.current=null;
      if(pendingClose&&pendingClose.scroller.isConnected&&!pendingClose.scroller.dataset.navigating&&pendingClose.element.isConnected){
        if(pendingClose.scroller.matches('.android-reading'))refreshDocumentExtent(pendingClose.scroller);
        const delta=pendingClose.element.getBoundingClientRect().top-pendingClose.top;
        if(Math.abs(delta)>.5)pendingClose.scroller.scrollTop+=delta;
      }
      const target=pendingBlockFocus.current;
      if(target!==null){
        pendingBlockFocus.current=null;
        const candidates=Array.from(rootRef.current?.querySelectorAll<HTMLElement>('.live-block')??[]);
        if(candidates.length){
          const match=target==='end'?candidates.at(-1):candidates.find(el=>{const s=Number(el.dataset.sourceStart??0),e=Number(el.dataset.sourceEnd??Infinity);return e>target.offset&&s<=target.offset;})??candidates.filter(el=>Number(el.dataset.sourceStart??0)<=target.offset).at(-1)??candidates[0];
          match?.focus({preventScroll:true});
        }
      }
      return;
    }
    const isNewSession=lastHandledSession.current!==editing.session;
    lastHandledSession.current=editing.session;
    if(isNewSession)window.dispatchEvent(new CustomEvent('supermd-live-edit-opened'));
    const area=editor.current;if(!area)return;
    const scroller=area.closest<HTMLElement>('.android-reading,.reading-scroll,.preview-pane,.live-scroll');
    const anchor=anchorTop.current;anchorTop.current=null;
    const sel=pendingSelection.current;pendingSelection.current=null;
    if(isNewSession||document.activeElement!==area)area.focus({preventScroll:true});
    if(sel)area.setSelectionRange(Math.min(sel.start,area.value.length),Math.min(sel.end,area.value.length),sel.direction||"none");
    syncSelection(area,editing);
    if(!activeTypewriter){
      if(!isNewSession)return;
      if(anchor===null){
        if(scroller){
          if(scroller.matches('.android-reading'))refreshDocumentExtent(scroller);
          const box=area.getBoundingClientRect(),view=scroller.getBoundingClientRect();
          if(view.height>0&&(box.bottom>view.bottom-24||box.top<view.top+24)){
            scroller.scrollTop+=box.top<view.top+24?box.top-view.top-32:box.bottom-view.bottom+48;
          }
        }
        return;
      }
      let frames=0,frame=0,stopped=false,writingScroll=false;const stop=()=>{stopped=true;};
      const hold=()=>{if(scroller?.matches('.android-reading'))refreshDocumentExtent(scroller);const delta=area.getBoundingClientRect().top-anchor;if(scroller&&Math.abs(delta)>.5){writingScroll=true;scroller.scrollTop+=delta;writingScroll=false;}};
      hold();
      const onScroll=()=>{if(!writingScroll)stopped=true;};
      const inputs=['wheel','touchstart','pointerdown','keydown','input'] as const;
      inputs.forEach(name=>window.addEventListener(name,stop,{capture:true,passive:true}));
      scroller?.addEventListener('scroll',onScroll,{passive:true});
      const tick=()=>{if(stopped||!area.isConnected)return;hold();if(++frames<24)frame=requestAnimationFrame(tick);};frame=requestAnimationFrame(tick);
      return()=>{cancelAnimationFrame(frame);scroller?.removeEventListener('scroll',onScroll);inputs.forEach(name=>window.removeEventListener(name,stop,{capture:true}));};
    }
    if(anchor!==null&&scroller){
      if(scroller.matches('.android-reading'))refreshDocumentExtent(scroller);
      const initialDelta=area.getBoundingClientRect().top-anchor;
      if(Math.abs(initialDelta)>.5)scroller.scrollTop+=initialDelta;
    }
    if(!scroller)return;
    const reducedMotion=document.documentElement.dataset.motion==='off'||document.documentElement.dataset.reduceMotion==='true'||(typeof window.matchMedia==='function'&&window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    if(reducedMotion){
      const align=()=>{if(scroller.matches('.android-reading'))refreshDocumentExtent(scroller);const delta=liveEditorCenterDelta(area,scroller,false);if(Math.abs(delta)>.5)scroller.scrollTop+=delta;};
      align();
      let frames=0,frame=0,stopped=false;const stop=()=>{stopped=true;};
      const inputs=['wheel','touchstart'] as const;
      inputs.forEach(name=>window.addEventListener(name,stop,{capture:true,passive:true}));
      const tick=()=>{if(stopped||!area.isConnected)return;align();if(++frames<12)frame=requestAnimationFrame(tick);};frame=requestAnimationFrame(tick);
      return()=>{cancelAnimationFrame(frame);inputs.forEach(name=>window.removeEventListener(name,stop,{capture:true}));};
    }
    let frames=0,frame=0,stopped=false,lastTime=performance.now();const stop=()=>{stopped=true;};
    const inputs=['wheel','touchstart'] as const;
    inputs.forEach(name=>window.addEventListener(name,stop,{capture:true,passive:true}));
    const glide=(now:number)=>{
      if(stopped||!area.isConnected)return;
      if(scroller.matches('.android-reading'))refreshDocumentExtent(scroller);
      const elapsed=Math.max(8,Math.min(50,now-lastTime));lastTime=now;
      const delta=liveEditorCenterDelta(area,scroller,false);
      if(Math.abs(delta)<=.75){
        if(Math.abs(delta)>.1)scroller.scrollTop+=delta;
        if(++frames<24)frame=requestAnimationFrame(glide);
        return;
      }
      scroller.scrollTop+=delta*(1-Math.pow(.55,elapsed/(1000/60)));
      if(++frames<36)frame=requestAnimationFrame(glide);
    };
    frame=requestAnimationFrame(glide);
    return()=>{cancelAnimationFrame(frame);inputs.forEach(name=>window.removeEventListener(name,stop,{capture:true}));};
  },[editing,activeTypewriter,syncSelection]);

  useLayoutEffect(()=>{
    const sel=pendingSelection.current,area=editor.current;
    if(!editing||!sel||!area)return;
    pendingSelection.current=null;
    area.focus({preventScroll:true});
    const max=area.value.length;
    const start=Math.max(0,Math.min(max,sel.start));
    const end=Math.max(start,Math.min(max,sel.end));
    const direction=sel.direction||"none";
    area.setSelectionRange(start,end,direction);
    lastSelection.current={start,end,direction};
    setCaret(start);
    rememberSelection(area,latestRef.current.editing);
  },[editing,draftText,rememberSelection]);

  useEffect(()=>()=>{if(typingFrame.current)cancelAnimationFrame(typingFrame.current);},[]);
  const syncActiveCaretCenter=useCallback(()=>{
    if(!latestRef.current.activeTypewriter)return;
    if(typingFrame.current)cancelAnimationFrame(typingFrame.current);
    typingFrame.current=requestAnimationFrame(()=>{
      typingFrame.current=0;
      const area=editor.current;if(!area||!area.isConnected)return;
      const scroller=area.closest<HTMLElement>('.android-reading,.reading-scroll,.preview-pane,.live-scroll');
      if(!scroller)return;
      if(scroller.matches('.android-reading'))refreshDocumentExtent(scroller);
      const delta=liveEditorCenterDelta(area,scroller,area.value.includes('\n'));
      if(Math.abs(delta)>1)scroller.scrollTop+=delta;
    });
  },[]);

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
    const active=latestRef.current.editing;
    if(active&&markdown!==syncedMarkdownRef.current)closeEditor();
    if(savedSelection.current&&savedSelection.current.markdown!==markdown)savedSelection.current=null;
  },[markdown,closeEditor]);

  useEffect(()=>{
    if(!editing)return;
    const syncCaret=()=>{const area=editor.current;if(area&&document.activeElement===area)setCaret(area.selectionStart);};
    document.addEventListener('selectionchange',syncCaret);
    return()=>document.removeEventListener('selectionchange',syncCaret);
  },[Boolean(editing)]);

  useEffect(()=>{
    const point=(event:Event)=>{
      const detail=(event as CustomEvent<{point?:{from:number;to:number};x?:number;y?:number;coords?:{x:number;y:number};target?:Element|null}>).detail;
      if(!detail||detail.point!==undefined)return;
      const x=typeof detail.x==='number'?detail.x:detail.coords?.x;
      const y=typeof detail.y==='number'?detail.y:detail.coords?.y;
      const hasCoords=typeof x==='number'&&typeof y==='number'&&Number.isFinite(x)&&Number.isFinite(y);
      const {markdown:currentMarkdown,editing:currentEditing,draftText:latestDraft,frontmatter:currentFrontmatter}=latestRef.current;
      const activeDoc=currentEditing?syncedMarkdownRef.current:currentMarkdown;
      if(hasCoords||detail.target){
        const root=rootRef.current;
        if(!root||!root.isConnected)return;
        const surface=root.closest<HTMLElement>('.android-reading,.reading-scroll,.live-pane,.live-scroll')??root;
        const rawTarget=detail.target instanceof Element?detail.target:(hasCoords&&typeof document.elementFromPoint==='function'?document.elementFromPoint(x!,y!):null);
        const bounds=surface.getBoundingClientRect();
        const surfaceHasLayout=bounds.width>0&&bounds.height>0;
        if(rawTarget){
          if(!surface.contains(rawTarget)&&!root.contains(rawTarget))return;
        }else{
          if(!hasCoords||!surfaceHasLayout||x!<bounds.left||x!>bounds.right||y!<bounds.top||y!>bounds.bottom)return;
        }
        const clampOffset=(offset:number)=>Math.max(0,Math.min(offset,activeDoc.length));
        const resolveBlockSpan=(blockEl:HTMLElement):[number,number]|null=>{
          if(currentEditing&&(blockEl.matches('.live-active-block')||blockEl.querySelector('.live-active-block')||blockEl.closest('.live-active-block'))){
            if(currentEditing.insertAfter!==undefined&&latestDraft===''){
              const pos=clampOffset(currentEditing.baseSplitEnd);
              return [pos,pos];
            }
            const start=clampOffset(currentEditing.prefix.length);
            const end=Math.max(start,clampOffset(currentEditing.prefix.length+latestDraft.length));
            return [start,end];
          }
          const rawStart=blockEl.dataset.sourceStart!==undefined?Number(blockEl.dataset.sourceStart):NaN;
          const rawEnd=blockEl.dataset.sourceEnd!==undefined?Number(blockEl.dataset.sourceEnd):NaN;
          if(!Number.isFinite(rawStart)||!Number.isFinite(rawEnd))return null;
          const [start,end]=translateRenderedRange(rawStart,rawEnd,currentEditing,activeDoc);
          const clampedStart=clampOffset(start);
          return [clampedStart,Math.max(clampedStart,clampOffset(end))];
        };
        if(rawTarget?.closest('[data-frontmatter-properties],.document-properties')){
          const pos=clampOffset(currentFrontmatter?.end??0);
          detail.point={from:pos,to:pos};
          return;
        }
        const hitBlock=rawTarget?.closest<HTMLElement>('.live-block,.live-active-block');
        if(hitBlock&&root.contains(hitBlock)){
          const span=resolveBlockSpan(hitBlock);
          if(span){
            detail.point={from:span[1],to:span[1]};
            return;
          }
        }
        const blockEls=Array.from(root.querySelectorAll<HTMLElement>('.live-block,.live-active-block')).filter(el=>!el.parentElement?.closest('.live-block'));
        const measured=blockEls.map(el=>({el,span:resolveBlockSpan(el),rect:el.getBoundingClientRect()})).filter((entry):entry is {el:HTMLElement;span:[number,number];rect:DOMRect}=>entry.span!==null);
        if(!measured.length){
          const pos=clampOffset(currentFrontmatter?.end??activeDoc.length);
          detail.point={from:pos,to:pos};
          return;
        }
        if(hasCoords&&measured.some(entry=>entry.rect.height>0||entry.rect.top!==0||entry.rect.bottom!==0)){
          if(y!<measured[0].rect.top){
            const pos=clampOffset(currentFrontmatter?.end??measured[0].span[0]);
            detail.point={from:pos,to:pos};
            return;
          }
          let chosen=measured[0];
          for(const entry of measured){
            if(entry.rect.top<=y!)chosen=entry;
            else break;
          }
          detail.point={from:chosen.span[1],to:chosen.span[1]};
          return;
        }
        const lastEnd=measured[measured.length-1].span[1];
        detail.point={from:lastEnd,to:lastEnd};
        return;
      }
      if(editor.current&&currentEditing)rememberSelection(editor.current,currentEditing);
      const saved=savedSelection.current;
      if(!saved||saved.markdown!==activeDoc){savedSelection.current=null;return;}
      const from=Math.max(0,Math.min(saved.from,activeDoc.length));
      const to=Math.max(from,Math.min(saved.to,activeDoc.length));
      detail.point={from,to};
    };
    window.addEventListener('supermd-insertion-point',point);
    return()=>window.removeEventListener('supermd-insertion-point',point);
  },[rememberSelection]);

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
  },[openRenderedBlock,appendTrailingBlock,hasAnalysis]);

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

  const copy=useCallback((event:ClipboardEvent)=>{
    if((event.target as Element).closest('textarea'))return;
    const source=selectedMarkdown(window.getSelection(),latestRef.current.renderedSource);
    if(source!==null){event.clipboardData.setData('text/plain',source);event.preventDefault();}
  },[]);

  const dragStart=useCallback((event:DragEvent<HTMLDivElement>)=>{
    setSelectedMarkdownDrag(event.nativeEvent,latestRef.current.renderedSource);
  },[]);

  const update=useCallback((text:string,selectionStart?:number,selectionEnd?:number)=>{
    const {editing:active,onChange:emitChange,frontmatter:currentFrontmatter}=latestRef.current;
    if(!active)return;
    latestRef.current.draftText=text;
    setDraftText(text);
    if(active.insertAfter!==undefined&&text===''){
      const changed=syncedMarkdownRef.current!==active.baseMarkdown;
      syncedMarkdownRef.current=active.baseMarkdown;
      editSpanRef.current=null;
      const pos=Math.max(0,Math.min(active.baseSplitEnd,active.baseMarkdown.length));
      savedSelection.current={from:pos,to:pos,markdown:active.baseMarkdown};
      if(changed)emitChange(active.baseMarkdown);
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
    emitChange(nextMarkdown);
    syncActiveCaretCenter();
  },[syncActiveCaretCenter]);

  const pendingSuggestionSelection=useRef<{start:number;end:number;direction:"forward"|"backward"|"none"}|null>(null);

  const commitDiscreteBlockEdit=useCallback((
    nextText:string,
    nextStart:number,
    nextEnd:number,
    nextDirection:"forward"|"backward"|"none"="none",
  )=>{
    const {editing:current,draftText:currentDraft}=latestRef.current,area=editor.current;
    if(!current||!area)return false;
    if(nextText===currentDraft&&nextStart===area.selectionStart&&nextEnd===area.selectionEnd)return true;
    blockHistory.current.undo.push({
      text:currentDraft,
      start:area.selectionStart,
      end:area.selectionEnd,
      direction:area.selectionDirection||"none",
    });
    while(blockHistory.current.undo.length>60)blockHistory.current.undo.shift();
    blockHistory.current.redo=[];
    blockHistory.current.last=0;
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
  },[rememberSelection,update]);

  const applyLiveFormat=useCallback((action:FormatAction):boolean=>{
    const {editing:current,draftText:currentDraft}=latestRef.current,area=editor.current;
    if(!current||!area)return false;
    const start=area.selectionStart,end=area.selectionEnd,reversed=area.selectionDirection==="backward";
    const range=reversed?{anchor:end,head:start}:{anchor:start,head:end};
    const result=toggleMarkdownFormat(currentDraft,[range],action,0);
    const nextRange=result.ranges[0];
    const nextStart=Math.min(nextRange.anchor,nextRange.head);
    const nextEnd=Math.max(nextRange.anchor,nextRange.head);
    const nextDirection:"forward"|"backward"|"none"=nextRange.anchor>nextRange.head?"backward":nextStart<nextEnd?"forward":"none";
    return commitDiscreteBlockEdit(result.doc,nextStart,nextEnd,nextDirection);
  },[commitDiscreteBlockEdit]);

  const replayBlockHistory=useCallback((direction:"undo"|"redo"):boolean=>{
    const {editing:current,draftText:currentDraft}=latestRef.current,area=editor.current;
    if(!current||!area)return false;
    const stack=blockHistory.current[direction];
    const snapshot=stack.pop();
    if(!snapshot)return false;
    const opposite=direction==="undo"?blockHistory.current.redo:blockHistory.current.undo;
    opposite.push({
      text:currentDraft,
      start:area.selectionStart,
      end:area.selectionEnd,
      direction:area.selectionDirection||"none",
    });
    blockHistory.current.last=0;
    pendingSelection.current={start:snapshot.start,end:snapshot.end,direction:snapshot.direction};
    setCaret(snapshot.start);
    update(snapshot.text,snapshot.start,snapshot.end);
    return true;
  },[update]);

  useEffect(()=>{
    if(!editing){
      if(activeLiveFormatHandler===applyLiveFormat)activeLiveFormatHandler=null;
      if(activeLiveHistoryHandler===replayBlockHistory)activeLiveHistoryHandler=null;
      return;
    }
    activeLiveFormatHandler=applyLiveFormat;
    activeLiveHistoryHandler=replayBlockHistory;
    const onFormatEvent=(event:Event)=>{
      const detail=(event as CustomEvent<{action?:string;prefix?:string;suffix?:string;block?:boolean}>).detail;
      const action=normalizeFormatAction(detail?.action);
      if(action){applyLiveFormat(action);return;}
      const area=editor.current,{editing:current,draftText:currentDraft}=latestRef.current;
      if(!area||!current)return;
      const prefix=detail?.prefix??"";
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
      if(activeLiveFormatHandler===applyLiveFormat)activeLiveFormatHandler=null;
      if(activeLiveHistoryHandler===replayBlockHistory)activeLiveHistoryHandler=null;
    };
  },[!!editing,applyLiveFormat,replayBlockHistory,commitDiscreteBlockEdit]);

  const handleSuggestionAction=useCallback((edit?:{from:number;to:number;insertLength:number})=>{
    const area=editor.current;if(!area)return;
    const direction=area.selectionDirection||"none";
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
      const current=editor.current,{editing:active,draftText:latestDraft}=latestRef.current;
      if(!current||!current.isConnected)return;
      current.focus({preventScroll:true});
      if(!active||current.value===latestDraft){
        if(pendingSelection.current){
          const nextStart=Math.max(0,Math.min(current.value.length,pendingSelection.current.start));
          const nextEnd=Math.max(nextStart,Math.min(current.value.length,pendingSelection.current.end));
          const nextDir=pendingSelection.current.direction||"none";
          pendingSelection.current=null;
          current.setSelectionRange(nextStart,nextEnd,nextDir);
          lastSelection.current={start:nextStart,end:nextEnd,direction:nextDir};
          setCaret(nextStart);
        }
        rememberSelection(current,active);
      }
    });
  },[rememberSelection]);

  const paste=useCallback((event:ClipboardEvent<HTMLTextAreaElement>)=>{
    const {latexAutofix:autofix,editing:currentEditing}=latestRef.current;
    if(!currentEditing||event.defaultPrevented||event.clipboardData.files.length)return;
    const area=event.currentTarget,from=area.selectionStart,to=area.selectionEnd;
    const raw=event.clipboardData.getData('text/plain');
    if(!raw)return;
    const standaloneUrl=parseStandaloneHttpUrl(raw);
    if(standaloneUrl){
      event.preventDefault();
      const fullDoc=currentEditing.prefix+area.value+currentEditing.suffix;
      const wrapped=currentEditing.protectedBlock?null:applyMarkdownUrlPaste(
        fullDoc,
        [{anchor:currentEditing.prefix.length+from,head:currentEditing.prefix.length+to}],
        raw,
      );
      if(wrapped&&wrapped.changes.length===1){
        const insert=wrapped.changes[0].insert;
        const nextBlockText=area.value.slice(0,from)+insert+area.value.slice(to);
        const caret=from+insert.length;
        commitDiscreteBlockEdit(nextBlockText,caret,caret);
      }else{
        const nextBlockText=area.value.slice(0,from)+raw+area.value.slice(to);
        const caret=from+raw.length;
        commitDiscreteBlockEdit(nextBlockText,caret,caret);
      }
      return;
    }
    if(!autofix||!/[\\$^]/.test(raw))return;
    if(currentEditing.protectedBlock&&!(from===0&&to===area.value.length))return;
    const before=(currentEditing.prefix.slice(-16_384)+area.value.slice(Math.max(0,from-16_384),from)).slice(-16_384);
    const after=(area.value.slice(to,to+16_384)+currentEditing.suffix.slice(0,16_384)).slice(0,16_384);
    const repaired=repairPastedMath(raw,before,after);if(repaired===raw)return;
    event.preventDefault();
    const nextBlockText=area.value.slice(0,from)+repaired+area.value.slice(to);
    const caret=from+repaired.length;
    commitDiscreteBlockEdit(nextBlockText,caret,caret);
  },[commitDiscreteBlockEdit]);

  const applyInlineBlockEdit=useCallback((
    area:HTMLTextAreaElement,
    currentDraft:string,
    replaceFrom:number,
    replaceTo:number,
    replacement:string,
    nextValue:string,
    nextStart:number,
    nextEnd:number,
    direction:"forward"|"backward"|"none"="none",
  )=>{
    const origStart=area.selectionStart,origEnd=area.selectionEnd;
    const origDirection=area.selectionDirection||"none";
    if(nextValue!==area.value){
      blockHistory.current.undo.push({
        text:currentDraft,
        start:origStart,
        end:origEnd,
        direction:origDirection,
      });
      while(blockHistory.current.undo.length>60)blockHistory.current.undo.shift();
      blockHistory.current.redo=[];
      blockHistory.current.last=0;
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
  },[rememberSelection,update]);

  const syncTextareaCaret=useCallback((area:HTMLTextAreaElement)=>setCaret(area.selectionStart),[]);

  const onEditorKeyDown=useCallback((event:ReactKeyboardEvent<HTMLTextAreaElement>)=>{
    if(event.nativeEvent.isComposing||event.keyCode===229)return;
    const {editing:active,draftText:currentDraft}=latestRef.current;
    if(!active)return;
    const area=event.currentTarget;
    if(event.key==='Tab'&&!event.ctrlKey&&!event.metaKey&&!event.altKey){
      event.preventDefault();event.stopPropagation();
      const direction=area.selectionDirection||"none";
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
        let diffStart=0,prevEnd=area.value.length,nextEnd=next.text.length;
        while(diffStart<prevEnd&&diffStart<nextEnd&&area.value[diffStart]===next.text[diffStart])diffStart++;
        while(prevEnd>diffStart&&nextEnd>diffStart&&area.value[prevEnd-1]===next.text[nextEnd-1]){prevEnd--;nextEnd--;}
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
        const dir:"undo"|"redo"=lower==='y'||event.shiftKey?'redo':'undo';
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
  },[applyInlineBlockEdit,closeEditor,openInsertedBlock,openDocBlock,rememberSelection,replayBlockHistory,applyLiveFormat]);

  const handleTextareaChange=useCallback((nextText:string,target:HTMLTextAreaElement)=>{
    const {editing:active,draftText:currentDraft}=latestRef.current;
    if(!active)return;
    if(!suppressHistoryPush.current){
      const now=Date.now();
      if(
        now-blockHistory.current.last>600||
        Math.abs(nextText.length-currentDraft.length)>1||
        blockHistory.current.undo.length===0
      ){
        blockHistory.current.undo.push({
          text:currentDraft,
          start:lastSelection.current.start,
          end:lastSelection.current.end,
          direction:lastSelection.current.direction,
        });
        while(blockHistory.current.undo.length>60)blockHistory.current.undo.shift();
      }
      blockHistory.current.redo=[];
      blockHistory.current.last=now;
    }
    lastSelection.current={
      start:target.selectionStart,
      end:target.selectionEnd,
      direction:target.selectionDirection||"none",
    };
    update(nextText,target.selectionStart,target.selectionEnd);
  },[update]);

  const handleSuggestionChange=useCallback((next:string)=>{
    const mapped=pendingSuggestionSelection.current;
    pendingSuggestionSelection.current=null;
    const nextStart=mapped?mapped.start:next.length;
    const nextEnd=mapped?mapped.end:nextStart;
    const nextDirection=mapped?mapped.direction:"none";
    commitDiscreteBlockEdit(next,nextStart,nextEnd,nextDirection);
  },[commitDiscreteBlockEdit]);

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
      onSuggestionChange:handleSuggestionChange,
      onSuggestionAction:handleSuggestionAction,
      onSyncCaret:syncTextareaCaret,
      onPaste:paste,
      onKeyDown:onEditorKeyDown,
      onCaretMove:syncActiveCaretCenter,
      onRememberSelection:handleRememberSelection,
      onBlurSession:blurSession,
    }:null,
    [editing,draftText,caret,spellCheck,grammarCheck,handleTextareaChange,handleSuggestionChange,handleSuggestionAction,syncTextareaCaret,paste,onEditorKeyDown,syncActiveCaretCenter,handleRememberSelection,blurSession],
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
    const protectedHint=['code','math','html','definition'].includes(entry.node.type);
    return (
      <Fragment key={blockKey}>
        <LiveBlockShell windowed={entry.windowed} estimate={entry.estimate} text={entry.text} headings={entry.headings} start={start} end={end} blockIndex={low} active={active} protectedHint={protectedHint} onOpen={openRenderedBlock}>
          {entry.content}
        </LiveBlockShell>
        {insertedBelow&&<section className="live-block" role="group" aria-label="New Markdown block"><ActiveBlockEditor/></section>}
      </Fragment>
    );
  },[blocks,blockKeys,editing,openRenderedBlock]);

  const handleToggleTask=useCallback((baseSource:string,offset:number,checked:boolean):boolean=>{
    const {editing:currentEditing,markdown:currentMarkdown,onChange:emitChange}=latestRef.current;
    if(currentEditing){
      const activeDoc=syncedMarkdownRef.current;
      const [from,to]=translateRenderedRange(offset,offset+1,currentEditing,activeDoc);
      if(to-from!==1||![' ','x','X'].includes(activeDoc[from]??''))return false;
      captureCloseAnchor(outsidePressRef.current.target,outsidePressRef.current.clientY);
      window.clearTimeout(outsidePressRef.current.timer);
      outsidePressRef.current.active=false;
      outsidePressRef.current.deferredClose=false;
      latestRef.current.editing=null;
      setEditing(null);
      emitChange(activeDoc.slice(0,from)+(checked?'x':' ')+activeDoc.slice(to));
      return true;
    }
    const aligned=applyAlignedTaskToggle(baseSource,currentMarkdown,offset,checked);
    if(!aligned)return false;
    emitChange(aligned.content);
    return true;
  },[captureCloseAnchor]);

  const previewChange=useCallback((next:string)=>{
    const {editing:currentEditing,onChange:emitChange,renderedSource:frozenSource}=latestRef.current;
    if(!currentEditing){emitChange(next);return;}
    // Translate a checkbox outside the frozen editor without losing its draft.
    const activeDoc=syncedMarkdownRef.current;
    let start=0,end=frozenSource.length,nextEnd=next.length;
    while(start<end&&start<nextEnd&&frozenSource[start]===next[start])start++;
    while(end>start&&nextEnd>start&&frozenSource[end-1]===next[nextEnd-1]){end--;nextEnd--;}
    const [from,to]=translateRenderedRange(start,end,currentEditing,activeDoc);
    captureCloseAnchor(outsidePressRef.current.target,outsidePressRef.current.clientY);
    window.clearTimeout(outsidePressRef.current.timer);
    outsidePressRef.current.active=false;
    outsidePressRef.current.deferredClose=false;
    latestRef.current.editing=null;
    setEditing(null);
    emitChange(activeDoc.slice(0,from)+next.slice(start,nextEnd)+activeDoc.slice(to));
  },[captureCloseAnchor]);

  if(!sourceAnalysis){
    return <div className="reader-loading" role="status"><span className="expressive-loading-shape" aria-hidden="true"/>Preparing your document</div>;
  }

  return <ActiveDraftContext.Provider value={activeDraftValue}>
    <div ref={rootRef} className="live-document" onCopy={copy} onDragStart={dragStart}>
      {!frontmatter&&!renderedSource.trim()?(editing?<ActiveBlockEditor/>:<section className="live-block" data-source-start={0} data-source-end={markdown.length} tabIndex={0} role="group" aria-label="Editable block 1" onClick={event=>openDocBlock(event.currentTarget,0,latestRef.current.markdown.length,latestRef.current.markdown,undefined,false)} onDoubleClick={event=>openDocBlock(event.currentTarget,0,latestRef.current.markdown.length,latestRef.current.markdown,undefined,false)} onKeyDown={event=>{if(event.key==='Enter'||event.key==='F2'){event.preventDefault();openDocBlock(event.currentTarget,0,latestRef.current.markdown.length,latestRef.current.markdown,undefined,false);}}}/> ):<>
        <MarkdownPreview noteId={noteId} markdown={renderedSource} onChange={previewChange} onToggleTask={handleToggleTask} documentPath={documentPath} savedDocumentPath={savedDocumentPath} python={python} dark={dark} trustedImageHosts={trustedImageHosts} approvedImageUrls={approvedImageUrls} onTrustImageHost={onTrustImageHost} onApproveImageUrl={onApproveImageUrl} onRemoteImageLoaded={onRemoteImageLoaded} onNotice={onNotice} renderBlock={renderBlock} fullDocumentAccessibility={fullDocumentAccessibility} sourceAnalysis={sourceAnalysis}/>
        {!hasBodyNodes?(editing?<ActiveBlockEditor/>:<section className="live-block" data-source-start={blocks[0].start} data-source-end={markdown.length} tabIndex={0} role="group" aria-label="Editable block 1" onClick={event=>openDocBlock(event.currentTarget,blocks[0].start,latestRef.current.markdown.length,latestRef.current.markdown,undefined,false)} onDoubleClick={event=>openDocBlock(event.currentTarget,blocks[0].start,latestRef.current.markdown.length,latestRef.current.markdown,undefined,false)} onKeyDown={event=>{if(event.key==='Enter'||event.key==='F2'){event.preventDefault();openDocBlock(event.currentTarget,blocks[0].start,latestRef.current.markdown.length,latestRef.current.markdown,undefined,false);}}}/> ):editing?.insertAfter==='end'&&<section className="live-block" role="group" aria-label="New Markdown block"><ActiveBlockEditor/></section>}
      </>}
    </div>
  </ActiveDraftContext.Provider>;
}
