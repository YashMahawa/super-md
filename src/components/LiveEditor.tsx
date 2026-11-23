import {Fragment,useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState,type ClipboardEvent,type KeyboardEvent as ReactKeyboardEvent} from 'react';
import MarkdownPreview from './MarkdownPreview';
import WindowedBlock from './WindowedBlock';
import type {RenderedMarkdownBlock} from './CachedMarkdown';
import {analyzeDocument,type SourceBlock} from '../documentAnalysis';
import {selectedMarkdown,setSelectedMarkdownDrag} from '../copySource';
import type {WritingOptions} from '../proofreading';
import type {ReaderAccessibilityPreference} from '../types';
import WritingSuggestions from './WritingSuggestions';
import {repairPastedMath} from '../mathRepair';
import {
  applyMarkdownUrlPaste,
  formatActionFromKeyEvent,
  normalizeFormatAction,
  parseStandaloneHttpUrl,
  toggleMarkdownFormat,
  type FormatAction,
} from '../markdownFormatting';
const noTrustedHosts:string[]=[];
export type {SourceBlock} from '../documentAnalysis';
export function splitMarkdownBlocks(markdown:string):SourceBlock[]{return analyzeDocument(markdown).blocks;}

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

function notifyHistoryBoundary() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("supermd-history-boundary"));
  }
}

interface Props extends WritingOptions,ReaderAccessibilityPreference {
  latexAutofix?:boolean;
  markdown:string;onChange:(value:string)=>void;documentPath:string|null;python:string;dark:boolean;
  trustedImageHosts?:string[];onTrustImageHost?:(host:string)=>void;
}
interface Editing {prefix:string;text:string;suffix:string;originalText:string;protectedBlock:boolean}

/** One document render preserves references, footnote numbering, duplicate
 * heading IDs and loose lists. Substitute one original-source editing block. */
export default function LiveEditor({markdown,onChange,documentPath,python,dark,trustedImageHosts=noTrustedHosts,onTrustImageHost,spellCheck=false,grammarCheck=false,latexAutofix=false,fullDocumentAccessibility=false}:Props){
  const [editing,setEditing]=useState<Editing|null>(null);
  const editingRef=useRef<Editing|null>(null);editingRef.current=editing;
  const onChangeRef=useRef(onChange);onChangeRef.current=onChange;
  const anchorTop=useRef<number|null>(null),editor=useRef<HTMLTextAreaElement>(null);
  const blockHistory=useRef<{undo:BlockSnapshot[];redo:BlockSnapshot[];last:number}>({undo:[],redo:[],last:0});
  const lastSelection=useRef<{start:number;end:number;direction:"forward"|"backward"|"none"}>({start:0,end:0,direction:"none"});
  const pendingSelection=useRef<{start:number;end:number;direction:"forward"|"backward"|"none"}|null>(null);

  const syncSelectionFromDom=()=>{
    const area=editor.current;
    if(!area)return;
    lastSelection.current={
      start:area.selectionStart,
      end:area.selectionEnd,
      direction:area.selectionDirection||"none",
    };
  };

  const open=(element:HTMLElement,start:number,end:number)=>{
    anchorTop.current=element.getBoundingClientRect().top;
    const text=markdown.slice(start,end),protectedBlock=sourceAnalysis.analysis.tree.children.some(node=>['code','math','html','definition'].includes(node.type)&&(node.position?.start.offset??-1)>=start&&(node.position?.end.offset??Infinity)<=end);
    blockHistory.current={undo:[],redo:[],last:0};
    lastSelection.current={start:0,end:0,direction:"none"};
    pendingSelection.current=null;
    setEditing({prefix:markdown.slice(0,start),text,suffix:markdown.slice(end),originalText:text,protectedBlock});
  };
  useLayoutEffect(()=>{
    const area=editor.current;if(!area||anchorTop.current===null)return;
    const scroller=area.closest<HTMLElement>('.android-reading,.reading-scroll,.preview-pane,.live-scroll'),anchor=anchorTop.current;anchorTop.current=null;
    const hold=()=>{const delta=area.getBoundingClientRect().top-anchor;if(scroller&&Math.abs(delta)>.5)scroller.scrollTop+=delta;};
    hold();area.focus({preventScroll:true});syncSelectionFromDom();
    let frames=0,frame=0,stopped=false;const stop=()=>{stopped=true;};
    const inputs=['wheel','touchstart','keydown'] as const;
    inputs.forEach(name=>window.addEventListener(name,stop,{capture:true,passive:true}));
    const tick=()=>{if(stopped||!area.isConnected)return;hold();if(++frames<24)frame=requestAnimationFrame(tick);};frame=requestAnimationFrame(tick);
    return()=>{cancelAnimationFrame(frame);inputs.forEach(name=>window.removeEventListener(name,stop,{capture:true}));};
  },[editing?.prefix]);

  useLayoutEffect(()=>{
    const sel=pendingSelection.current,area=editor.current;
    if(!sel||!area)return;
    pendingSelection.current=null;
    area.focus({preventScroll:true});
    const max=area.value.length;
    const start=Math.max(0,Math.min(max,sel.start));
    const end=Math.max(start,Math.min(max,sel.end));
    area.setSelectionRange(start,end,sel.direction);
    lastSelection.current={start,end,direction:sel.direction};
  },[editing?.text]);

  useEffect(()=>{
    if(!editing)return;
    const outsidePointerDown=(event:PointerEvent)=>{
      const target=event.target instanceof Element?event.target:null;
      if(target&&!target.closest('.live-active-block'))setEditing(null);
    };
    document.addEventListener('pointerdown',outsidePointerDown,true);
    return()=>document.removeEventListener('pointerdown',outsidePointerDown,true);
  },[!!editing]);

  const renderedSource=editing?editing.prefix+editing.originalText+editing.suffix:markdown;
  const sourceAnalysis=useMemo(()=>({source:renderedSource,analysis:analyzeDocument(renderedSource)}),[renderedSource]);
  const blocks=sourceAnalysis.analysis.blocks;
  useEffect(()=>{if(editing&&markdown!==editing.prefix+editing.text+editing.suffix)setEditing(null);},[markdown,editing]);
  const copy=(event:ClipboardEvent)=>{if((event.target as Element).closest('textarea'))return;const source=selectedMarkdown(window.getSelection(),markdown);if(source!==null){event.clipboardData.setData('text/plain',source);event.preventDefault();}};
  const update=useCallback((text:string)=>{
    const current=editingRef.current;if(!current)return;
    const nextEditing={...current,text};
    editingRef.current=nextEditing;
    setEditing(nextEditing);
    onChangeRef.current(current.prefix+text+current.suffix);
  },[]);

  const commitDiscreteBlockEdit=useCallback((
    nextText:string,
    nextStart:number,
    nextEnd:number,
    nextDirection:"forward"|"backward"|"none"="none",
  )=>{
    const current=editingRef.current,area=editor.current;
    if(!current||!area)return false;
    if(nextText===current.text&&nextStart===area.selectionStart&&nextEnd===area.selectionEnd)return true;
    blockHistory.current.undo.push({
      text:current.text,
      start:area.selectionStart,
      end:area.selectionEnd,
      direction:area.selectionDirection||"none",
    });
    while(blockHistory.current.undo.length>60)blockHistory.current.undo.shift();
    blockHistory.current.redo=[];
    blockHistory.current.last=0;
    pendingSelection.current={start:nextStart,end:nextEnd,direction:nextDirection};
    if(nextText===current.text){
      area.focus({preventScroll:true});
      area.setSelectionRange(nextStart,nextEnd,nextDirection);
      lastSelection.current={start:nextStart,end:nextEnd,direction:nextDirection};
      pendingSelection.current=null;
      return true;
    }
    notifyHistoryBoundary();
    update(nextText);
    notifyHistoryBoundary();
    return true;
  },[update]);

  const applyLiveFormat=useCallback((action:FormatAction):boolean=>{
    const current=editingRef.current,area=editor.current;
    if(!current||!area)return false;
    const start=area.selectionStart,end=area.selectionEnd,reversed=area.selectionDirection==="backward";
    const range=reversed?{anchor:end,head:start}:{anchor:start,head:end};
    const result=toggleMarkdownFormat(current.text,[range],action,0);
    const nextRange=result.ranges[0];
    const nextStart=Math.min(nextRange.anchor,nextRange.head);
    const nextEnd=Math.max(nextRange.anchor,nextRange.head);
    const nextDirection:"forward"|"backward"|"none"=nextRange.anchor>nextRange.head?"backward":nextStart<nextEnd?"forward":"none";
    return commitDiscreteBlockEdit(result.doc,nextStart,nextEnd,nextDirection);
  },[commitDiscreteBlockEdit]);

  const replayBlockHistory=useCallback((direction:"undo"|"redo"):boolean=>{
    const current=editingRef.current,area=editor.current;
    if(!current||!area)return false;
    const stack=blockHistory.current[direction];
    const snapshot=stack.pop();
    if(!snapshot)return false;
    const opposite=direction==="undo"?blockHistory.current.redo:blockHistory.current.undo;
    opposite.push({
      text:current.text,
      start:area.selectionStart,
      end:area.selectionEnd,
      direction:area.selectionDirection||"none",
    });
    blockHistory.current.last=0;
    pendingSelection.current={start:snapshot.start,end:snapshot.end,direction:snapshot.direction};
    update(snapshot.text);
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
      const area=editor.current,current=editingRef.current;
      if(!area||!current)return;
      const prefix=detail?.prefix??"";
      if(detail?.block){
        const caret=area.selectionEnd;
        commitDiscreteBlockEdit(current.text.slice(0,caret)+prefix+current.text.slice(caret),caret+prefix.length,caret+prefix.length);
        return;
      }
      const suffix=detail?.suffix??prefix,from=area.selectionStart,to=area.selectionEnd;
      const wrapped=`${prefix}${current.text.slice(from,to)}${suffix}`;
      commitDiscreteBlockEdit(current.text.slice(0,from)+wrapped+current.text.slice(to),from+prefix.length,from+prefix.length+(to-from));
    };
    window.addEventListener('supermd-format',onFormatEvent);
    return()=>{
      window.removeEventListener('supermd-format',onFormatEvent);
      if(activeLiveFormatHandler===applyLiveFormat)activeLiveFormatHandler=null;
      if(activeLiveHistoryHandler===replayBlockHistory)activeLiveHistoryHandler=null;
    };
  },[!!editing,applyLiveFormat,replayBlockHistory,commitDiscreteBlockEdit]);

  const paste=(event:ClipboardEvent<HTMLTextAreaElement>)=>{
    if(!editing||event.defaultPrevented||event.clipboardData.files.length)return;
    const area=event.currentTarget,from=area.selectionStart,to=area.selectionEnd;
    const raw=event.clipboardData.getData('text/plain');
    if(!raw)return;
    const standaloneUrl=parseStandaloneHttpUrl(raw);
    if(standaloneUrl){
      event.preventDefault();
      const fullDoc=editing.prefix+area.value+editing.suffix;
      const wrapped=editing.protectedBlock?null:applyMarkdownUrlPaste(
        fullDoc,
        [{anchor:editing.prefix.length+from,head:editing.prefix.length+to}],
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
    if(!latexAutofix||!/[\\$^]/.test(raw))return;
    if(editing.protectedBlock&&!(from===0&&to===area.value.length))return;
    const before=(editing.prefix.slice(-16_384)+area.value.slice(Math.max(0,from-16_384),from)).slice(-16_384);
    const after=(area.value.slice(to,to+16_384)+editing.suffix.slice(0,16_384)).slice(0,16_384);
    const repaired=repairPastedMath(raw,before,after);if(repaired===raw)return;
    event.preventDefault();
    const nextBlockText=area.value.slice(0,from)+repaired+area.value.slice(to);
    const caret=from+repaired.length;
    commitDiscreteBlockEdit(nextBlockText,caret,caret);
  };

  const handleTextareaKeyDown=(event:ReactKeyboardEvent<HTMLTextAreaElement>)=>{
    if(event.key==='Escape'){
      event.preventDefault();event.stopPropagation();setEditing(null);return;
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
  };

  const handleTextareaChange=(nextText:string,target:HTMLTextAreaElement)=>{
    if(!editing)return;
    const now=Date.now();
    if(
      now-blockHistory.current.last>600||
      Math.abs(nextText.length-editing.text.length)>1||
      blockHistory.current.undo.length===0
    ){
      blockHistory.current.undo.push({
        text:editing.text,
        start:lastSelection.current.start,
        end:lastSelection.current.end,
        direction:lastSelection.current.direction,
      });
      while(blockHistory.current.undo.length>60)blockHistory.current.undo.shift();
    }
    blockHistory.current.redo=[];
    blockHistory.current.last=now;
    lastSelection.current={
      start:target.selectionStart,
      end:target.selectionEnd,
      direction:target.selectionDirection||"none",
    };
    update(nextText);
  };

  const textarea=()=> <div className="live-active-block"><textarea ref={editor} data-source-start={editing!.prefix.length} spellCheck={false} value={editing!.text} style={{height:Math.max(120,editing!.text.split('\n').length*27+32)}} onPaste={paste} onSelect={syncSelectionFromDom} onKeyUp={syncSelectionFromDom} onPointerUp={syncSelectionFromDom} onFocus={syncSelectionFromDom} onChange={event=>handleTextareaChange(event.target.value,event.target)} onKeyDown={handleTextareaKeyDown} onBlur={event=>{if(event.relatedTarget&&!event.currentTarget.parentElement?.contains(event.relatedTarget))setEditing(null);}} aria-label="Edit Markdown block"/><WritingSuggestions text={editing!.text} spellCheck={spellCheck} grammarCheck={grammarCheck} onChange={next=>commitDiscreteBlockEdit(next,next.length,next.length)}/></div>;
  const currentOffset=(offset:number)=>editing&&offset>=editing.prefix.length+editing.originalText.length?offset+editing.text.length-editing.originalText.length:offset;
  const renderBlock=(entry:RenderedMarkdownBlock)=>{
    const offset=entry.node.position?.start.offset;
    // Generated footnote sections have no editable span. Render exactly once.
    if(offset===undefined)return <Fragment key={`extra-${entry.index}`}>{entry.content}</Fragment>;
    let low=0,high=blocks.length-1;while(low<high){const middle=(low+high+1)>>>1;if(blocks[middle].start<=offset)low=middle;else high=middle-1;}
    // Inter-block whitespace belongs outside the editor. Replacing all text
    // in a heading/paragraph must not join it onto the following source block.
    const block=blocks[low],start=currentOffset(block.start),end=currentOffset(entry.node.position?.end.offset??block.end),active=!!editing&&block.start===editing.prefix.length;
    return <WindowedBlock key={`block-${block.start}`} enabled={entry.windowed&&!active} estimate={entry.estimate} text={entry.text} headings={entry.headings} className="live-block" data-source-start={start} data-source-end={end} tabIndex={0} role="group" aria-label={`Editable block ${low+1}`} onDoubleClick={event=>{
      if(active||(event.target as Element).closest('a,button,input,select,textarea,summary,.interactive-chart,img,.note-image'))return;
      window.getSelection()?.removeAllRanges();open(event.currentTarget,start,end);
    }} onKeyDown={event=>{if(!active&&event.target===event.currentTarget&&(event.key==='Enter'||event.key==='F2')){event.preventDefault();open(event.currentTarget,start,end);}}}>
      {active?textarea():entry.content}
    </WindowedBlock>;
  };
  const previewChange=(next:string)=>{
    if(!editing){onChange(next);return;}
    // Translate a checkbox outside the frozen editor without losing its draft.
    let start=0,end=renderedSource.length,nextEnd=next.length;
    while(start<end&&start<nextEnd&&renderedSource[start]===next[start])start++;
    while(end>start&&nextEnd>start&&renderedSource[end-1]===next[nextEnd-1]){end--;nextEnd--;}
    const from=currentOffset(start),to=currentOffset(end);setEditing(null);
    onChange(markdown.slice(0,from)+next.slice(start,nextEnd)+markdown.slice(to));
  };
  return <div className="live-document" onCopy={copy} onDragStart={event=>{setSelectedMarkdownDrag(event.nativeEvent,renderedSource);}}>
    {!renderedSource.trim()?(editing?textarea():<section className="live-block" tabIndex={0} role="group" aria-label="Editable block 1" onDoubleClick={event=>open(event.currentTarget,0,markdown.length)} onKeyDown={event=>{if(event.key==='Enter'||event.key==='F2'){event.preventDefault();open(event.currentTarget,0,markdown.length);}}}/> ):<MarkdownPreview markdown={renderedSource} onChange={previewChange} documentPath={documentPath} python={python} dark={dark} trustedImageHosts={trustedImageHosts} onTrustImageHost={onTrustImageHost} renderBlock={renderBlock} fullDocumentAccessibility={fullDocumentAccessibility} sourceAnalysis={sourceAnalysis}/>}
  </div>;
}
