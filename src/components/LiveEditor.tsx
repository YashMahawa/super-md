import {Fragment,useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState,type ClipboardEvent,type ReactNode} from 'react';
import {PencilSimple} from '@phosphor-icons/react';
import MarkdownPreview from './MarkdownPreview';
import WindowedBlock,{type WindowHeading} from './WindowedBlock';
import type {RenderedMarkdownBlock} from './CachedMarkdown';
import {analyzeDocument,type SourceBlock} from '../documentAnalysis';
import {selectedMarkdown,setSelectedMarkdownDrag} from '../copySource';
import {refreshDocumentExtent} from '../documentZoom';
import type {WritingOptions} from '../proofreading';
import type {ReaderAccessibilityPreference} from '../types';
import WritingSuggestions from './WritingSuggestions';
import {repairPastedMath} from '../mathRepair';
const noTrustedHosts:string[]=[];
const fullscreenInteractiveSelector='a,button,input,select,textarea,summary,details,img,.note-image,.interactive-chart,.inline-diagram,.svg-figure,.mermaid,.step-cards,.remote-image-card,.image-error,.code-container';
export type {SourceBlock} from '../documentAnalysis';
export function splitMarkdownBlocks(markdown:string):SourceBlock[]{return analyzeDocument(markdown).blocks;}

interface LiveBlockShellProps {
  windowed:boolean;estimate:number;text:string;headings:WindowHeading[];
  start:number;end:number;blockIndex:number;active:boolean;protectedHint:boolean;
  onOpen:(element:HTMLElement,start:number,end:number,protectedHint:boolean)=>void;
  activeEditor?:ReactNode;children:ReactNode;
}
function LiveBlockShell({windowed,estimate,text,headings,start,end,blockIndex,active,protectedHint,onOpen,activeEditor,children}:LiveBlockShellProps){
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
      if(active||(event.target as Element).closest('a,button,input,select,textarea,summary,.interactive-chart,img,.note-image'))return;
      window.getSelection()?.removeAllRanges();onOpen(event.currentTarget,start,end,protectedHint);
    }}
    onKeyDown={event=>{if(!active&&event.target===event.currentTarget&&(event.key==='Enter'||event.key==='F2')){event.preventDefault();onOpen(event.currentTarget,start,end,protectedHint);}}}>
    {revealed?<button type="button" className="live-block-edit" data-independent-zoom aria-label="Edit block" title="Edit block" onClick={event=>{
      event.preventDefault();event.stopPropagation();
      const owner=event.currentTarget.closest<HTMLElement>('.live-block');
      if(owner)onOpen(owner,start,end,protectedHint);
    }}><PencilSimple size={13} weight="bold" aria-hidden="true"/><span>Edit</span></button>:null}
    {active?activeEditor:children}
  </WindowedBlock>;
}

interface Props extends WritingOptions,ReaderAccessibilityPreference {
  latexAutofix?:boolean;
  markdown:string;onChange:(value:string)=>void;documentPath:string|null;python:string;dark:boolean;
  trustedImageHosts?:string[];onTrustImageHost?:(host:string)=>void;
}
interface Editing {prefix:string;text:string;suffix:string;originalText:string;protectedBlock:boolean}
interface CloseAnchor {scroller:HTMLElement;element:HTMLElement;top:number}

/** One document render preserves references, footnote numbering, duplicate
 * heading IDs and loose lists. Substitute one original-source editing block. */
export default function LiveEditor({markdown,onChange,documentPath,python,dark,trustedImageHosts=noTrustedHosts,onTrustImageHost,spellCheck=false,grammarCheck=false,latexAutofix=false,fullDocumentAccessibility=false}:Props){
  const [editing,setEditing]=useState<Editing|null>(null);
  const anchorTop=useRef<number|null>(null),editor=useRef<HTMLTextAreaElement>(null);
  const closeAnchorRef=useRef<CloseAnchor|null>(null);
  const sessionRef=useRef(0);
  const outsidePressRef=useRef<{active:boolean;deferredClose:boolean;target:HTMLElement|null;clientY:number|null;session:number;timer:number}>({active:false,deferredClose:false,target:null,clientY:null,session:0,timer:0});
  const editSpanRef=useRef<{start:number;oldEnd:number;newEnd:number}|null>(null);
  const blockKeyState=useRef<{source:string;keys:Map<number,string>;seq:number}>({source:'',keys:new Map(),seq:0});

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
    captureCloseAnchor(target,clientY);
    setEditing(null);
  },[captureCloseAnchor]);

  const open=(element:HTMLElement,start:number,end:number,protectedHint?:boolean)=>{
    sessionRef.current+=1;
    window.clearTimeout(outsidePressRef.current.timer);
    outsidePressRef.current={active:false,deferredClose:false,target:null,clientY:null,session:sessionRef.current,timer:0};
    closeAnchorRef.current=null;
    anchorTop.current=element.getBoundingClientRect().top;
    const text=markdown.slice(start,end);
    const protectedBlock=protectedHint??sourceAnalysis.analysis.tree.children.some(node=>['code','math','html','definition'].includes(node.type)&&(node.position?.start.offset??-1)>=start&&(node.position?.end.offset??Infinity)<=end);
    setEditing({prefix:markdown.slice(0,start),text,suffix:markdown.slice(end),originalText:text,protectedBlock});
  };

  useLayoutEffect(()=>{
    const area=editor.current;if(!area||anchorTop.current===null)return;
    const scroller=area.closest<HTMLElement>('.android-reading,.reading-scroll,.preview-pane,.live-scroll'),anchor=anchorTop.current;anchorTop.current=null;
    let frames=0,frame=0,stopped=false,writingScroll=false;const stop=()=>{stopped=true;};
    const hold=()=>{if(scroller?.matches('.android-reading'))refreshDocumentExtent(scroller);const delta=area.getBoundingClientRect().top-anchor;if(scroller&&Math.abs(delta)>.5){writingScroll=true;scroller.scrollTop+=delta;writingScroll=false;}};
    hold();area.focus({preventScroll:true});
    const onScroll=()=>{if(!writingScroll)stopped=true;};
    const inputs=['wheel','touchstart','pointerdown','keydown','input'] as const;
    inputs.forEach(name=>window.addEventListener(name,stop,{capture:true,passive:true}));
    scroller?.addEventListener('scroll',onScroll,{passive:true});
    const tick=()=>{if(stopped||!area.isConnected)return;hold();if(++frames<24)frame=requestAnimationFrame(tick);};frame=requestAnimationFrame(tick);
    return()=>{cancelAnimationFrame(frame);scroller?.removeEventListener('scroll',onScroll);inputs.forEach(name=>window.removeEventListener(name,stop,{capture:true}));};
  },[editing?.prefix]);

  useLayoutEffect(()=>{
    if(editing)return;
    const pending=closeAnchorRef.current;closeAnchorRef.current=null;
    if(!pending||!pending.scroller.isConnected||pending.scroller.dataset.navigating||!pending.element.isConnected)return;
    if(pending.scroller.matches('.android-reading'))refreshDocumentExtent(pending.scroller);
    const delta=pending.element.getBoundingClientRect().top-pending.top;
    if(Math.abs(delta)>.5)pending.scroller.scrollTop+=delta;
  },[editing]);

  useEffect(()=>{
    if(editing){
      editSpanRef.current={start:editing.prefix.length,oldEnd:editing.prefix.length+editing.originalText.length,newEnd:editing.prefix.length+editing.text.length};
    }
  },[editing]);

  const isEditing=Boolean(editing);
  useEffect(()=>{
    if(!isEditing)return;
    const finish=()=>{
      const state=outsidePressRef.current;
      window.clearTimeout(state.timer);
      const {deferredClose,target,clientY,session}=state;
      const focusLeft=document.activeElement!==editor.current&&!editor.current?.parentElement?.contains(document.activeElement);
      state.active=false;state.deferredClose=false;state.target=null;state.clientY=null;state.timer=0;
      if(session===sessionRef.current&&(deferredClose||focusLeft))closeEditor(target,clientY);
    };
    const beginPress=(event:PointerEvent|MouseEvent)=>{
      const target=event.target instanceof Element?event.target as HTMLElement:null;
      if(target?.closest('.live-active-block')){
        window.clearTimeout(outsidePressRef.current.timer);
        outsidePressRef.current.active=false;
        outsidePressRef.current.deferredClose=false;
        return;
      }
      window.clearTimeout(outsidePressRef.current.timer);
      outsidePressRef.current.active=true;
      outsidePressRef.current.target=target;
      outsidePressRef.current.clientY=event.clientY;
      outsidePressRef.current.session=sessionRef.current;
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
      if(target?.closest('.live-active-block'))return;
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

  const renderedSource=editing?editing.prefix+editing.originalText+editing.suffix:markdown;
  const sourceAnalysis=useMemo(()=>({source:renderedSource,analysis:analyzeDocument(renderedSource)}),[renderedSource]);
  const blocks=sourceAnalysis.analysis.blocks;

  const blockKeys=useMemo(()=>{
    const state=blockKeyState.current;
    if(state.source===renderedSource&&state.keys.size===blocks.length&&blocks.every(item=>state.keys.has(item.start)))return state.keys;
    const previousSource=state.source,previousKeys=state.keys;
    let diffStart=0,oldEnd=previousSource.length,newEnd=renderedSource.length;
    if(!editing&&editSpanRef.current&&renderedSource.length-previousSource.length===editSpanRef.current.newEnd-editSpanRef.current.oldEnd){
      diffStart=editSpanRef.current.start;
      oldEnd=editSpanRef.current.oldEnd;
      newEnd=editSpanRef.current.newEnd;
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
  },[renderedSource,blocks,editing]);

  useEffect(()=>{if(editing&&markdown!==editing.prefix+editing.text+editing.suffix)closeEditor();},[markdown,editing,closeEditor]);
  const copy=(event:ClipboardEvent)=>{if((event.target as Element).closest('textarea'))return;const source=selectedMarkdown(window.getSelection(),markdown);if(source!==null){event.clipboardData.setData('text/plain',source);event.preventDefault();}};
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
  const textarea=()=> <div className="live-active-block"><textarea ref={editor} data-source-start={editing!.prefix.length} spellCheck={false} value={editing!.text} style={{height:Math.max(120,editing!.text.split('\n').length*27+32)}} onPaste={paste} onChange={event=>update(event.target.value)} onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeEditor();}}} onBlur={event=>{
    if(event.relatedTarget instanceof Node&&event.currentTarget.parentElement?.contains(event.relatedTarget))return;
    if(outsidePressRef.current.active){outsidePressRef.current.deferredClose=true;return;}
    closeEditor(event.relatedTarget instanceof Element?event.relatedTarget:null);
  }} aria-label="Edit Markdown block"/><WritingSuggestions text={editing!.text} spellCheck={spellCheck} grammarCheck={grammarCheck} onChange={update}/></div>;
  const currentOffset=(offset:number)=>editing&&offset>=editing.prefix.length+editing.originalText.length?offset+editing.text.length-editing.originalText.length:offset;
  const renderBlock=(entry:RenderedMarkdownBlock)=>{
    const offset=entry.node.position?.start.offset;
    // Generated footnote sections have no editable span. Render exactly once.
    if(offset===undefined)return <Fragment key={`extra-${entry.index}`}>{entry.content}</Fragment>;
    let low=0,high=blocks.length-1;while(low<high){const middle=(low+high+1)>>>1;if(blocks[middle].start<=offset)low=middle;else high=middle-1;}
    // Inter-block whitespace belongs outside the editor. Replacing all text
    // in a heading/paragraph must not join it onto the following source block.
    const block=blocks[low],start=currentOffset(block.start),end=currentOffset(entry.node.position?.end.offset??block.end),active=!!editing&&block.start===editing.prefix.length;
    const blockKey=blockKeys.get(block.start)??`block-${block.start}`;
    const protectedHint=['code','math','html','definition'].includes(entry.node.type);
    return <LiveBlockShell key={blockKey} windowed={entry.windowed} estimate={entry.estimate} text={entry.text} headings={entry.headings} start={start} end={end} blockIndex={low} active={active} protectedHint={protectedHint} onOpen={open} activeEditor={active?textarea():undefined}>
      {entry.content}
    </LiveBlockShell>;
  };
  const previewChange=(next:string)=>{
    if(!editing){onChange(next);return;}
    // Translate a checkbox outside the frozen editor without losing its draft.
    let start=0,end=renderedSource.length,nextEnd=next.length;
    while(start<end&&start<nextEnd&&renderedSource[start]===next[start])start++;
    while(end>start&&nextEnd>start&&renderedSource[end-1]===next[nextEnd-1]){end--;nextEnd--;}
    const from=currentOffset(start),to=currentOffset(end);
    captureCloseAnchor(outsidePressRef.current.target,outsidePressRef.current.clientY);
    window.clearTimeout(outsidePressRef.current.timer);
    outsidePressRef.current.active=false;outsidePressRef.current.deferredClose=false;
    setEditing(null);
    onChange(markdown.slice(0,from)+next.slice(start,nextEnd)+markdown.slice(to));
  };
  return <div className="live-document" onCopy={copy} onDragStart={event=>{setSelectedMarkdownDrag(event.nativeEvent,renderedSource);}}>
    {!renderedSource.trim()?(editing?textarea():<section className="live-block" tabIndex={0} role="group" aria-label="Editable block 1" onClick={event=>open(event.currentTarget,0,markdown.length,false)} onDoubleClick={event=>open(event.currentTarget,0,markdown.length,false)} onKeyDown={event=>{if(event.key==='Enter'||event.key==='F2'){event.preventDefault();open(event.currentTarget,0,markdown.length,false);}}}/> ):<MarkdownPreview markdown={renderedSource} onChange={previewChange} documentPath={documentPath} python={python} dark={dark} trustedImageHosts={trustedImageHosts} onTrustImageHost={onTrustImageHost} renderBlock={renderBlock} fullDocumentAccessibility={fullDocumentAccessibility} sourceAnalysis={sourceAnalysis}/>}
  </div>;
}
