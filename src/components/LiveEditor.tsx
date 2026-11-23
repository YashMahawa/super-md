import {Fragment,useCallback,useEffect,useLayoutEffect,useRef,useState,type ClipboardEvent} from 'react';
import MarkdownPreview from './MarkdownPreview';
import WindowedBlock from './WindowedBlock';
import type {RenderedMarkdownBlock} from './CachedMarkdown';
import {analyzeDocument,type SourceBlock,type SourceDocumentAnalysis} from '../documentAnalysis';
import {useDocumentAnalysis} from '../documentAnalysisWorker';
import {alignRangeToCurrentSource,applyAlignedTaskToggle} from '../revisionEdit';
import {selectedMarkdown,setSelectedMarkdownDrag} from '../copySource';
import type {WritingOptions} from '../proofreading';
import type {ReaderAccessibilityPreference} from '../types';
import WritingSuggestions from './WritingSuggestions';
import {repairPastedMath} from '../mathRepair';
const noTrustedHosts:string[]=[];
export type {SourceBlock} from '../documentAnalysis';
export function splitMarkdownBlocks(markdown:string):SourceBlock[]{return analyzeDocument(markdown).blocks;}

interface Props extends WritingOptions,ReaderAccessibilityPreference {
  sessionId?:string;
  latexAutofix?:boolean;
  markdown:string;onChange:(value:string)=>void;documentPath:string|null;python:string;dark:boolean;
  trustedImageHosts?:string[];onTrustImageHost?:(host:string)=>void;
  sourceAnalysis?:SourceDocumentAnalysis;
}
interface Editing {
  prefix:string;
  text:string;
  suffix:string;
  originalText:string;
  protectedBlock:boolean;
  frozenAnalysis:SourceDocumentAnalysis;
  frozenBlockStart:number;
}

/** One document render preserves references, footnote numbering, duplicate
 * heading IDs and loose lists. Substitute one original-source editing block. */
export default function LiveEditor({sessionId='live-editor',markdown,onChange,documentPath,python,dark,trustedImageHosts=noTrustedHosts,onTrustImageHost,spellCheck=false,grammarCheck=false,latexAutofix=false,fullDocumentAccessibility=false,sourceAnalysis:externalAnalysis}:Props){
  const [editing,setEditing]=useState<Editing|null>(null);
  const anchorTop=useRef<number|null>(null),editor=useRef<HTMLTextAreaElement>(null);
  const internalAnalysis=useDocumentAnalysis(sessionId,markdown,'live',{enabled:!externalAnalysis});
  const latestAnalysis=externalAnalysis??internalAnalysis.pinnedAnalysis;
  const activeAnalysis=editing?editing.frozenAnalysis:latestAnalysis;

  const open=(element:HTMLElement,baseStart:number,baseEnd:number)=>{
    if(!activeAnalysis)return;
    const aligned=!activeAnalysis.source.trim()&&!markdown.trim()
      ? {from:0,to:markdown.length}
      : alignRangeToCurrentSource(activeAnalysis.source,markdown,baseStart,baseEnd);
    if(!aligned)return;
    anchorTop.current=element.getBoundingClientRect().top;
    const text=markdown.slice(aligned.from,aligned.to);
    const protectedBlock=activeAnalysis.analysis.tree.children.some(node=>['code','math','html','definition'].includes(node.type)&&(node.position?.start.offset??-1)>=baseStart&&(node.position?.end.offset??Infinity)<=baseEnd);
    setEditing({
      prefix:markdown.slice(0,aligned.from),
      text,
      suffix:markdown.slice(aligned.to),
      originalText:text,
      protectedBlock,
      frozenAnalysis:activeAnalysis,
      frozenBlockStart:baseStart,
    });
  };
  useLayoutEffect(()=>{
    const area=editor.current;if(!area||anchorTop.current===null)return;
    const scroller=area.closest<HTMLElement>('.android-reading,.reading-scroll,.preview-pane,.live-scroll'),anchor=anchorTop.current;anchorTop.current=null;
    const hold=()=>{const delta=area.getBoundingClientRect().top-anchor;if(scroller&&Math.abs(delta)>.5)scroller.scrollTop+=delta;};
    hold();area.focus({preventScroll:true});
    let frames=0,frame=0,stopped=false;const stop=()=>{stopped=true;};
    const inputs=['wheel','touchstart','keydown'] as const;
    inputs.forEach(name=>window.addEventListener(name,stop,{capture:true,passive:true}));
    const tick=()=>{if(stopped||!area.isConnected)return;hold();if(++frames<24)frame=requestAnimationFrame(tick);};frame=requestAnimationFrame(tick);
    return()=>{cancelAnimationFrame(frame);inputs.forEach(name=>window.removeEventListener(name,stop,{capture:true}));};
  },[editing?.prefix]);
  useEffect(()=>{if(editing&&markdown!==editing.prefix+editing.text+editing.suffix)setEditing(null);},[markdown,editing]);
  const renderedSource=activeAnalysis?.source??'';
  const copy=(event:ClipboardEvent)=>{if((event.target as Element).closest('textarea'))return;const source=selectedMarkdown(window.getSelection(),renderedSource);if(source!==null){event.clipboardData.setData('text/plain',source);event.preventDefault();}};
  const update=(text:string)=>{if(!editing)return;setEditing({...editing,text});onChange(editing.prefix+text+editing.suffix);};
  const paste=(event:ClipboardEvent<HTMLTextAreaElement>)=>{
    if(!latexAutofix||!editing||event.defaultPrevented||event.clipboardData.files.length)return;
    const area=event.currentTarget,from=area.selectionStart,to=area.selectionEnd;
    if(editing.protectedBlock&&!(from===0&&to===area.value.length))return;
    const raw=event.clipboardData.getData('text/plain');
    if(!/[\\$^]/.test(raw))return;
    const before=(editing.prefix.slice(-16_384)+area.value.slice(Math.max(0,from-16_384),from)).slice(-16_384);
    const after=(area.value.slice(to,to+16_384)+editing.suffix.slice(0,16_384)).slice(0,16_384);
    const repaired=repairPastedMath(raw,before,after);if(repaired===raw)return;
    // Browser editing commands preserve the textarea's native undo history.
    // If unavailable, leave the original paste to the platform without loss.
    try {if(document.execCommand('insertText',false,repaired))event.preventDefault();}catch{/* Preserve native paste. */}
  };
  const textarea=()=> <div className="live-active-block"><textarea ref={editor} data-source-start={editing!.prefix.length} spellCheck={false} value={editing!.text} style={{height:Math.max(120,editing!.text.split('\n').length*27+32)}} onPaste={paste} onChange={event=>update(event.target.value)} onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();setEditing(null);}}} onBlur={event=>{if(!event.relatedTarget||!event.currentTarget.parentElement?.contains(event.relatedTarget))setEditing(null);}} aria-label="Edit Markdown block"/><WritingSuggestions text={editing!.text} spellCheck={spellCheck} grammarCheck={grammarCheck} onChange={update}/></div>;

  const handleToggleTask=useCallback((baseSource:string,offset:number,checked:boolean):boolean=>{
    const aligned=applyAlignedTaskToggle(baseSource,markdown,offset,checked);
    if(!aligned)return false;
    setEditing(null);
    onChange(aligned.content);
    return true;
  },[markdown,onChange]);

  if(!activeAnalysis){
    return <div className="reader-loading" role="status"><span className="expressive-loading-shape" aria-hidden="true"/>Preparing your document</div>;
  }

  const blocks=activeAnalysis.analysis.blocks;
  const renderBlock=(entry:RenderedMarkdownBlock)=>{
    const offset=entry.node.position?.start.offset;
    // Generated footnote sections have no editable span. Render exactly once.
    if(offset===undefined)return <Fragment key={`extra-${entry.index}`}>{entry.content}</Fragment>;
    let low=0,high=blocks.length-1;while(low<high){const middle=(low+high+1)>>>1;if(blocks[middle].start<=offset)low=middle;else high=middle-1;}
    // Inter-block whitespace belongs outside the editor. Replacing all text
    // in a heading/paragraph must not join it onto the following source block.
    const block=blocks[low];
    const baseStart=block.start;
    const baseEnd=entry.node.position?.end.offset??block.end;
    const active=!!editing&&baseStart===editing.frozenBlockStart;
    const aligned=active
      ? {from:editing!.prefix.length,to:editing!.prefix.length+editing!.text.length}
      : alignRangeToCurrentSource(activeAnalysis.source,markdown,baseStart,baseEnd);
    const start=aligned?.from??baseStart;
    const end=aligned?.to??baseEnd;
    return <WindowedBlock key={`block-${baseStart}`} enabled={entry.windowed&&!active} estimate={entry.estimate} text={entry.text} headings={entry.headings} className="live-block" data-source-start={start} data-source-end={end} data-rendered-start={baseStart} data-rendered-end={baseEnd} tabIndex={0} role="group" aria-label={`Editable block ${low+1}`} onDoubleClick={event=>{
      if(active||(event.target as Element).closest('a,button,input,select,textarea,summary,.interactive-chart,img,.note-image'))return;
      window.getSelection()?.removeAllRanges();open(event.currentTarget,baseStart,baseEnd);
    }} onKeyDown={event=>{if(!active&&event.target===event.currentTarget&&(event.key==='Enter'||event.key==='F2')){event.preventDefault();open(event.currentTarget,baseStart,baseEnd);}}}>
      {active?textarea():entry.content}
    </WindowedBlock>;
  };

  return <div className="live-document" onCopy={copy} onDragStart={event=>{setSelectedMarkdownDrag(event.nativeEvent,renderedSource);}}>
    {!renderedSource.trim()?(editing?textarea():<section className="live-block" tabIndex={0} role="group" aria-label="Editable block 1" onDoubleClick={event=>open(event.currentTarget,0,activeAnalysis.source.length)} onKeyDown={event=>{if(event.key==='Enter'||event.key==='F2'){event.preventDefault();open(event.currentTarget,0,activeAnalysis.source.length);}}}/> ):<MarkdownPreview markdown={renderedSource} onToggleTask={handleToggleTask} documentPath={documentPath} python={python} dark={dark} trustedImageHosts={trustedImageHosts} onTrustImageHost={onTrustImageHost} renderBlock={renderBlock} fullDocumentAccessibility={fullDocumentAccessibility} sourceAnalysis={activeAnalysis}/>}
  </div>;
}
