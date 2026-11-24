import {createContext,Fragment,useCallback,useContext,useEffect,useLayoutEffect,useMemo,useRef,useState,type ClipboardEvent,type DragEvent,type RefObject} from 'react';
import MarkdownPreview from './MarkdownPreview';
import WindowedBlock from './WindowedBlock';
import type {RenderedMarkdownBlock} from './CachedMarkdown';
import {analyzeDocument,type SourceBlock,type SourceDocumentAnalysis} from '../documentAnalysis';
import {selectedMarkdown,setSelectedMarkdownDrag} from '../copySource';
import type {WritingOptions} from '../proofreading';
import type {ReaderAccessibilityPreference} from '../types';
import WritingSuggestions from './WritingSuggestions';
import {repairPastedMath} from '../mathRepair';
import {liveEditorCenterDelta,useTypewriterScroll} from '../typewriterScroll';
const noTrustedHosts:string[]=[];
const CARET_KEYS=new Set(['ArrowUp','ArrowDown','PageUp','PageDown','Home','End']);
export type {SourceBlock} from '../documentAnalysis';
export function splitMarkdownBlocks(markdown:string):SourceBlock[]{return analyzeDocument(markdown).blocks;}

interface Props extends WritingOptions,ReaderAccessibilityPreference {
  latexAutofix?:boolean;
  typewriterScroll?:boolean;
  markdown:string;onChange:(value:string)=>void;documentPath:string|null;python:string;dark:boolean;
  trustedImageHosts?:string[];onTrustImageHost?:(host:string)=>void;
}
interface EditingSession {prefix:string;suffix:string;originalText:string;protectedBlock:boolean}

interface ActiveDraftContextValue {
  editorRef:RefObject<HTMLTextAreaElement|null>;
  sourceStart:number;
  text:string;
  spellCheck:boolean;
  grammarCheck:boolean;
  onChange:(value:string)=>void;
  onPaste:(event:ClipboardEvent<HTMLTextAreaElement>)=>void;
  onCaretMove:()=>void;
  onClose:()=>void;
}

const ActiveDraftContext=createContext<ActiveDraftContextValue|null>(null);

function ActiveBlockEditor(){
  const draft=useContext(ActiveDraftContext);
  if(!draft)return null;
  const {editorRef,sourceStart,text,spellCheck,grammarCheck,onChange,onPaste,onCaretMove,onClose}=draft;
  return (
    <div className="live-active-block">
      <textarea
        ref={editorRef}
        data-source-start={sourceStart}
        spellCheck={false}
        value={text}
        style={{height:Math.max(120,text.split('\n').length*27+32)}}
        onPaste={onPaste}
        onChange={event=>onChange(event.target.value)}
        onKeyUp={event=>{if(CARET_KEYS.has(event.key))onCaretMove();}}
        onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();onClose();}}}
        onBlur={event=>{if(!event.relatedTarget||!event.currentTarget.parentElement?.contains(event.relatedTarget))onClose();}}
        aria-label="Edit Markdown block"
      />
      <WritingSuggestions text={text} spellCheck={spellCheck} grammarCheck={grammarCheck} onChange={onChange}/>
    </div>
  );
}

function translateRenderedOffset(offset:number,editing:EditingSession|null,draftText:string):number {
  if(!editing)return offset;
  const editEnd=editing.prefix.length+editing.originalText.length;
  return offset>=editEnd?offset+draftText.length-editing.originalText.length:offset;
}

interface LiveEditorState {
  markdown:string;
  onChange:(value:string)=>void;
  latexAutofix:boolean;
  activeTypewriter:boolean;
  editing:EditingSession|null;
  draftText:string;
  renderedSource:string;
  sourceAnalysis:SourceDocumentAnalysis;
}

/** One document render preserves references, footnote numbering, duplicate
 * heading IDs and loose lists. Substitute one original-source editing block. */
export default function LiveEditor({markdown,onChange,documentPath,python,dark,trustedImageHosts=noTrustedHosts,onTrustImageHost,spellCheck=false,grammarCheck=false,latexAutofix=false,typewriterScroll,fullDocumentAccessibility=false}:Props){
  const [editing,setEditing]=useState<EditingSession|null>(null);
  const [draftText,setDraftText]=useState('');
  const activeTypewriter=useTypewriterScroll(typewriterScroll);
  const docRef=useRef<HTMLDivElement>(null),appliedTypewriter=useRef(false),typingFrame=useRef(0);
  const anchorTop=useRef<number|null>(null),editor=useRef<HTMLTextAreaElement>(null);
  const renderedSource=editing?editing.prefix+editing.originalText+editing.suffix:markdown;
  const sourceAnalysis=useMemo(()=>({source:renderedSource,analysis:analyzeDocument(renderedSource)}),[renderedSource]);
  const blocks=sourceAnalysis.analysis.blocks;
  const latestRef=useRef<LiveEditorState>({markdown,onChange,latexAutofix,activeTypewriter,editing,draftText,renderedSource,sourceAnalysis});
  latestRef.current={markdown,onChange,latexAutofix,activeTypewriter,editing,draftText,renderedSource,sourceAnalysis};
  const open=useCallback((element:HTMLElement,renderedStart:number,renderedEnd:number)=>{
    anchorTop.current=element.getBoundingClientRect().top;
    const {editing:currentEditing,draftText:currentDraft,markdown:latestMarkdown,sourceAnalysis:latestAnalysis}=latestRef.current;
    const activeMarkdown=currentEditing?currentEditing.prefix+currentDraft+currentEditing.suffix:latestMarkdown;
    const start=translateRenderedOffset(renderedStart,currentEditing,currentDraft);
    const end=translateRenderedOffset(renderedEnd,currentEditing,currentDraft);
    const analysis=currentEditing&&activeMarkdown!==latestAnalysis.source?analyzeDocument(activeMarkdown):latestAnalysis.analysis;
    const text=activeMarkdown.slice(start,end);
    const protectedBlock=analysis.tree.children.some(node=>['code','math','html','definition'].includes(node.type)&&(node.position?.start.offset??-1)>=start&&(node.position?.end.offset??Infinity)<=end);
    setDraftText(text);
    setEditing({prefix:activeMarkdown.slice(0,start),suffix:activeMarkdown.slice(end),originalText:text,protectedBlock});
  },[]);
  useLayoutEffect(()=>{
    const doc=docRef.current;if(!doc)return;
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
  },[activeTypewriter]);
  useLayoutEffect(()=>{
    const area=editor.current;if(!area)return;
    const scroller=area.closest<HTMLElement>('.android-reading,.reading-scroll,.preview-pane,.live-scroll'),anchor=anchorTop.current;anchorTop.current=null;
    if(!activeTypewriter){
      if(anchor===null)return;
      const hold=()=>{const delta=area.getBoundingClientRect().top-anchor;if(scroller&&Math.abs(delta)>.5)scroller.scrollTop+=delta;};
      hold();area.focus({preventScroll:true});
      let frames=0,frame=0,stopped=false;const stop=()=>{stopped=true;};
      const inputs=['wheel','touchstart','keydown'] as const;
      inputs.forEach(name=>window.addEventListener(name,stop,{capture:true,passive:true}));
      const tick=()=>{if(stopped||!area.isConnected)return;hold();if(++frames<24)frame=requestAnimationFrame(tick);};frame=requestAnimationFrame(tick);
      return()=>{cancelAnimationFrame(frame);inputs.forEach(name=>window.removeEventListener(name,stop,{capture:true}));};
    }
    if(anchor!==null&&scroller){
      const initialDelta=area.getBoundingClientRect().top-anchor;
      if(Math.abs(initialDelta)>.5)scroller.scrollTop+=initialDelta;
    }
    if(document.activeElement!==area)area.focus({preventScroll:true});
    if(!scroller)return;
    const reducedMotion=document.documentElement.dataset.motion==='off'||document.documentElement.dataset.reduceMotion==='true'||(typeof window.matchMedia==='function'&&window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    if(reducedMotion){
      const align=()=>{const delta=liveEditorCenterDelta(area,scroller,false);if(Math.abs(delta)>.5)scroller.scrollTop+=delta;};
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
  },[editing,activeTypewriter]);
  useEffect(()=>()=>{if(typingFrame.current)cancelAnimationFrame(typingFrame.current);},[]);
  const syncActiveCaretCenter=useCallback(()=>{
    if(!latestRef.current.activeTypewriter)return;
    if(typingFrame.current)cancelAnimationFrame(typingFrame.current);
    typingFrame.current=requestAnimationFrame(()=>{
      typingFrame.current=0;
      const area=editor.current;if(!area||!area.isConnected)return;
      const scroller=area.closest<HTMLElement>('.android-reading,.reading-scroll,.preview-pane,.live-scroll');
      if(!scroller)return;
      const delta=liveEditorCenterDelta(area,scroller,area.value.includes('\n'));
      if(Math.abs(delta)>1)scroller.scrollTop+=delta;
    });
  },[]);
  useEffect(()=>{
    const {editing:currentEditing,draftText:currentDraft}=latestRef.current;
    if(currentEditing&&markdown!==currentEditing.prefix+currentDraft+currentEditing.suffix)setEditing(null);
  },[markdown]);
  const closeEditing=useCallback(()=>setEditing(null),[]);
  const copy=useCallback((event:ClipboardEvent)=>{
    if((event.target as Element).closest('textarea'))return;
    const source=selectedMarkdown(window.getSelection(),latestRef.current.renderedSource);
    if(source!==null){event.clipboardData.setData('text/plain',source);event.preventDefault();}
  },[]);
  const dragStart=useCallback((event:DragEvent<HTMLDivElement>)=>{
    setSelectedMarkdownDrag(event.nativeEvent,latestRef.current.renderedSource);
  },[]);
  const update=useCallback((text:string)=>{
    const {editing:currentEditing,onChange:emitChange}=latestRef.current;
    if(!currentEditing)return;
    setDraftText(text);
    emitChange(currentEditing.prefix+text+currentEditing.suffix);
    syncActiveCaretCenter();
  },[syncActiveCaretCenter]);
  const paste=useCallback((event:ClipboardEvent<HTMLTextAreaElement>)=>{
    const {latexAutofix:autofix,editing:currentEditing}=latestRef.current;
    if(!autofix||!currentEditing||event.defaultPrevented||event.clipboardData.files.length)return;
    const area=event.currentTarget,from=area.selectionStart,to=area.selectionEnd;
    if(currentEditing.protectedBlock&&!(from===0&&to===area.value.length))return;
    const raw=event.clipboardData.getData('text/plain');
    if(!/[\\$^]/.test(raw))return;
    const before=(currentEditing.prefix.slice(-16_384)+area.value.slice(Math.max(0,from-16_384),from)).slice(-16_384);
    const after=(area.value.slice(to,to+16_384)+currentEditing.suffix.slice(0,16_384)).slice(0,16_384);
    const repaired=repairPastedMath(raw,before,after);if(repaired===raw)return;
    // Browser editing commands preserve the textarea's native undo history.
    // If unavailable, leave the original paste to the platform without loss.
    try {if(document.execCommand('insertText',false,repaired))event.preventDefault();}catch{/* Preserve native paste. */}
  },[]);
  const activeDraftValue=useMemo<ActiveDraftContextValue|null>(
    ()=>editing?{
      editorRef:editor,
      sourceStart:editing.prefix.length,
      text:draftText,
      spellCheck,
      grammarCheck,
      onChange:update,
      onPaste:paste,
      onCaretMove:syncActiveCaretCenter,
      onClose:closeEditing,
    }:null,
    [editing,draftText,spellCheck,grammarCheck,update,paste,syncActiveCaretCenter,closeEditing],
  );
  const renderBlock=useCallback((entry:RenderedMarkdownBlock)=>{
    const offset=entry.node.position?.start.offset;
    // Generated footnote sections have no editable span. Render exactly once.
    if(offset===undefined)return <Fragment key={`extra-${entry.key}`}>{entry.content}</Fragment>;
    let low=0,high=blocks.length-1;while(low<high){const middle=(low+high+1)>>>1;if(blocks[middle].start<=offset)low=middle;else high=middle-1;}
    // Inter-block whitespace belongs outside the editor. Replacing all text
    // in a heading/paragraph must not join it onto the following source block.
    const block=blocks[low],start=block.start,end=entry.node.position?.end.offset??block.end,active=!!editing&&block.start===editing.prefix.length;
    return <WindowedBlock key={`block-${entry.key}`} enabled={entry.windowed&&!active} estimate={entry.estimate} text={entry.text} headings={entry.headings} className="live-block" data-source-start={start} data-source-end={end} tabIndex={0} role="group" aria-label={`Editable block ${low+1}`} onDoubleClick={event=>{
      if(active||(event.target as Element).closest('a,button,input,select,textarea,summary,.interactive-chart,img,.note-image'))return;
      window.getSelection()?.removeAllRanges();open(event.currentTarget,start,end);
    }} onKeyDown={event=>{if(!active&&event.target===event.currentTarget&&(event.key==='Enter'||event.key==='F2')){event.preventDefault();open(event.currentTarget,start,end);}}}>
      {active?<ActiveBlockEditor/>:entry.content}
    </WindowedBlock>;
  },[blocks,editing,open]);
  const previewChange=useCallback((next:string)=>{
    const {editing:currentEditing,draftText:currentDraft,onChange:emitChange,renderedSource:frozenSource}=latestRef.current;
    if(!currentEditing){emitChange(next);return;}
    // Translate a checkbox outside the frozen editor without losing its draft.
    const activeMarkdown=currentEditing.prefix+currentDraft+currentEditing.suffix;
    let start=0,end=frozenSource.length,nextEnd=next.length;
    while(start<end&&start<nextEnd&&frozenSource[start]===next[start])start++;
    while(end>start&&nextEnd>start&&frozenSource[end-1]===next[nextEnd-1]){end--;nextEnd--;}
    const from=translateRenderedOffset(start,currentEditing,currentDraft),to=translateRenderedOffset(end,currentEditing,currentDraft);
    setEditing(null);
    emitChange(activeMarkdown.slice(0,from)+next.slice(start,nextEnd)+activeMarkdown.slice(to));
  },[]);
  return <ActiveDraftContext.Provider value={activeDraftValue}>
    <div ref={docRef} className="live-document" onCopy={copy} onDragStart={dragStart}>
      {!renderedSource.trim()?(editing?<ActiveBlockEditor/>:<section className="live-block" tabIndex={0} role="group" aria-label="Editable block 1" onDoubleClick={event=>open(event.currentTarget,0,latestRef.current.markdown.length)} onKeyDown={event=>{if(event.key==='Enter'||event.key==='F2'){event.preventDefault();open(event.currentTarget,0,latestRef.current.markdown.length);}}}/> ):<MarkdownPreview markdown={renderedSource} onChange={previewChange} documentPath={documentPath} python={python} dark={dark} trustedImageHosts={trustedImageHosts} onTrustImageHost={onTrustImageHost} renderBlock={renderBlock} fullDocumentAccessibility={fullDocumentAccessibility} sourceAnalysis={sourceAnalysis}/>}
    </div>
  </ActiveDraftContext.Provider>;
}
