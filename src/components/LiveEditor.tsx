import {Fragment,useEffect,useLayoutEffect,useMemo,useRef,useState,type ClipboardEvent,type KeyboardEvent as ReactKeyboardEvent,type MouseEvent as ReactMouseEvent} from 'react';
import MarkdownPreview from './MarkdownPreview';
import WindowedBlock from './WindowedBlock';
import type {RenderedMarkdownBlock} from './CachedMarkdown';
import {analyzeDocument,type SourceBlock} from '../documentAnalysis';
import {selectedMarkdown,setSelectedMarkdownDrag} from '../copySource';
import type {WritingOptions} from '../proofreading';
import type {ReaderAccessibilityPreference} from '../types';
import WritingSuggestions from './WritingSuggestions';
import {repairPastedMath} from '../mathRepair';
import {editableBlockSpans,indentMarkdownSelection,isFirstLineCursor,isLastLineCursor} from '../liveBlockFlow';
import {handleLiveEditorKey} from '../liveEditorKeys';
import {liveEditorCenterDelta,useTypewriterScroll} from '../typewriterScroll';
const noTrustedHosts:string[]=[];
export type {SourceBlock} from '../documentAnalysis';
export function splitMarkdownBlocks(markdown:string):SourceBlock[]{return analyzeDocument(markdown).blocks;}

interface Props extends WritingOptions,ReaderAccessibilityPreference {
  latexAutofix?:boolean;
  typewriterScroll?:boolean;
  markdown:string;onChange:(value:string)=>void;documentPath:string|null;python:string;dark:boolean;
  trustedImageHosts?:string[];onTrustImageHost?:(host:string)=>void;
}
interface Editing {
  session:number;
  prefix:string;
  text:string;
  suffix:string;
  baseMarkdown:string;
  baseSplitEnd:number;
  syncedMarkdown:string;
  protectedBlock:boolean;
  insertAfter?:number|'end';
}

/** One document render preserves references, footnote numbering, duplicate
 * heading IDs and loose lists. Substitute one original-source editing block. */
export default function LiveEditor({markdown,onChange,documentPath,python,dark,trustedImageHosts=noTrustedHosts,onTrustImageHost,spellCheck=false,grammarCheck=false,latexAutofix=false,typewriterScroll,fullDocumentAccessibility=false}:Props){
  const [editing,setEditing]=useState<Editing|null>(null);
  const [caret,setCaret]=useState(0);
  const editingRef=useRef(editing);editingRef.current=editing;
  const markdownRef=useRef(markdown);markdownRef.current=markdown;
  const activeTypewriter=useTypewriterScroll(typewriterScroll);
  const sessionCounter=useRef(0),lastHandledSession=useRef(0);
  const appliedTypewriter=useRef(false),typingFrame=useRef(0);
  const anchorTop=useRef<number|null>(null),editor=useRef<HTMLTextAreaElement>(null),rootRef=useRef<HTMLDivElement>(null);
  const pendingSelection=useRef<{start:number;end:number;direction?:'forward'|'backward'|'none'}|null>(null);
  const pendingBlockFocus=useRef<{offset:number}|'end'|null>(null);
  const savedSelection=useRef<{from:number;to:number;markdown:string}|null>(null);

  const rememberSelection=(area:HTMLTextAreaElement|null,current=editingRef.current)=>{
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
  };

  const renderedSource=editing?editing.baseMarkdown:markdown;
  const sourceAnalysis=useMemo(()=>({source:renderedSource,analysis:analyzeDocument(renderedSource)}),[renderedSource]);
  const blocks=sourceAnalysis.analysis.blocks;

  const openBlock=(element:HTMLElement|null,start:number,end:number,baseDoc=editingRef.current?editingRef.current.syncedMarkdown:markdownRef.current,selection?:{start:number;end:number})=>{
    anchorTop.current=element?element.getBoundingClientRect().top:null;
    pendingSelection.current=selection??null;
    const analysis=baseDoc===sourceAnalysis.source?sourceAnalysis.analysis:analyzeDocument(baseDoc);
    const text=baseDoc.slice(start,end);
    const protectedBlock=analysis.tree.children.some(node=>['code','math','html','definition'].includes(node.type)&&(node.position?.start.offset??-1)>=start&&(node.position?.end.offset??Infinity)<=end);
    setCaret(selection?.start??0);
    setEditing({session:++sessionCounter.current,prefix:baseDoc.slice(0,start),text,suffix:baseDoc.slice(end),baseMarkdown:baseDoc,baseSplitEnd:end,syncedMarkdown:baseDoc,protectedBlock});
  };

  const openInsertedBlock=(baseDoc:string,insertPos:number,insertAfter:number|'end')=>{
    anchorTop.current=null;
    pendingSelection.current={start:0,end:0};
    setCaret(0);
    const head=baseDoc.slice(0,insertPos),tail=baseDoc.slice(insertPos);
    const sepBefore=!head.length||head.endsWith('\n\n')?'':head.endsWith('\n')?'\n':'\n\n';
    const suffix=!tail.trim()?(tail.includes('\n')?'\n':''):tail.startsWith('\n\n')?tail:tail.startsWith('\n')?'\n'+tail:'\n\n'+tail;
    setEditing({session:++sessionCounter.current,prefix:head+sepBefore,text:'',suffix,baseMarkdown:baseDoc,baseSplitEnd:insertPos,syncedMarkdown:baseDoc,protectedBlock:false,insertAfter});
  };

  const appendTrailingBlock=()=>{
    const active=editingRef.current;
    if(active?.insertAfter==='end'){editor.current?.focus({preventScroll:true});return;}
    const baseDoc=active?active.syncedMarkdown:markdownRef.current;
    if(!baseDoc.trim()){openBlock(rootRef.current?.querySelector<HTMLElement>('.live-block')??null,0,baseDoc.length,baseDoc,{start:0,end:0});return;}
    const insertPos=baseDoc.replace(/[ \t]*\n+$/,'').length;
    openInsertedBlock(baseDoc,insertPos,'end');
  };

  const handlersRef=useRef({openBlock,appendTrailingBlock});
  handlersRef.current={openBlock,appendTrailingBlock};

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
  },[activeTypewriter]);

  useLayoutEffect(()=>{
    if(!editing){
      lastHandledSession.current=0;
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
    if(sel)area.setSelectionRange(Math.min(sel.start,area.value.length),Math.min(sel.end,area.value.length),sel.direction);
    rememberSelection(area,editing);
    if(!activeTypewriter){
      if(!isNewSession)return;
      if(anchor===null){
        if(scroller){
          const box=area.getBoundingClientRect(),view=scroller.getBoundingClientRect();
          if(view.height>0&&(box.bottom>view.bottom-24||box.top<view.top+24)){
            scroller.scrollTop+=box.top<view.top+24?box.top-view.top-32:box.bottom-view.bottom+48;
          }
        }
        return;
      }
      const hold=()=>{const delta=area.getBoundingClientRect().top-anchor;if(scroller&&Math.abs(delta)>.5)scroller.scrollTop+=delta;};
      hold();
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
  },[editing?.session,activeTypewriter]);
  useLayoutEffect(()=>{
    const selection=pendingSelection.current,area=editor.current;
    if(!editing||!selection||!area)return;
    pendingSelection.current=null;
    const len=area.value.length;
    const nextStart=Math.min(selection.start,len),nextEnd=Math.min(selection.end,len);
    area.setSelectionRange(nextStart,nextEnd,selection.direction);
    setCaret(nextStart);
    rememberSelection(area,editing);
  },[editing]);
  useEffect(()=>()=>{if(typingFrame.current)cancelAnimationFrame(typingFrame.current);},[]);
  const syncActiveCaretCenter=()=>{
    if(!activeTypewriter)return;
    if(typingFrame.current)cancelAnimationFrame(typingFrame.current);
    typingFrame.current=requestAnimationFrame(()=>{
      typingFrame.current=0;
      const area=editor.current;if(!area||!area.isConnected)return;
      const scroller=area.closest<HTMLElement>('.android-reading,.reading-scroll,.preview-pane,.live-scroll');
      if(!scroller)return;
      const delta=liveEditorCenterDelta(area,scroller,area.value.includes('\n'));
      if(Math.abs(delta)>1)scroller.scrollTop+=delta;
    });
  };
  useEffect(()=>{
    const active=editingRef.current;
    if(active&&markdown!==active.syncedMarkdown)setEditing(null);
    if(savedSelection.current&&savedSelection.current.markdown!==markdown)savedSelection.current=null;
  },[markdown]);

  useEffect(()=>{
    if(!editing)return;
    const syncCaret=()=>{const area=editor.current;if(area&&document.activeElement===area)setCaret(area.selectionStart);};
    document.addEventListener('selectionchange',syncCaret);
    return()=>document.removeEventListener('selectionchange',syncCaret);
  },[Boolean(editing)]);

  useEffect(()=>{
    const point=(event:Event)=>{
      const detail=(event as CustomEvent<{point?:{from:number;to:number};x?:number;y?:number;coords?:{x:number;y:number}}>).detail;
      if(!detail||detail.point!==undefined)return;
      const x=typeof detail.x==='number'?detail.x:detail.coords?.x;
      const y=typeof detail.y==='number'?detail.y:detail.coords?.y;
      if(typeof x==='number'&&typeof y==='number'&&Number.isFinite(x)&&Number.isFinite(y))return;
      const currentMarkdown=markdownRef.current,currentEditing=editingRef.current;
      if(editor.current&&currentEditing)rememberSelection(editor.current,currentEditing);
      const saved=savedSelection.current;
      if(!saved||saved.markdown!==currentMarkdown){savedSelection.current=null;return;}
      const from=Math.max(0,Math.min(saved.from,currentMarkdown.length));
      const to=Math.max(from,Math.min(saved.to,currentMarkdown.length));
      detail.point={from,to};
    };
    window.addEventListener('supermd-insertion-point',point);
    return()=>window.removeEventListener('supermd-insertion-point',point);
  },[]);

  useEffect(()=>{
    const root=rootRef.current;if(!root)return;
    const onEditBlock=(event:Event)=>{
      const blockEl=(event.target instanceof Element?event.target:null)?.closest<HTMLElement>('.live-block');
      if(!blockEl||!root.contains(blockEl))return;
      const start=Number(blockEl.dataset.sourceStart),end=Number(blockEl.dataset.sourceEnd);
      if(Number.isFinite(start)&&Number.isFinite(end)){
        window.getSelection()?.removeAllRanges();
        handlersRef.current.openBlock(blockEl,start,end);
      }
    };
    const onContainerDoubleClick=(event:MouseEvent)=>{
      const target=event.target instanceof Element?event.target:null;
      if(!target||target.closest('.live-block,.live-active-block,a,button,input,select,textarea,.reading-search,.image-viewer'))return;
      const doc=editingRef.current?editingRef.current.syncedMarkdown:markdownRef.current;
      if(!doc.trim())return;
      const allBlocks=root.querySelectorAll<HTMLElement>('.live-block');
      const lastBlock=allBlocks[allBlocks.length-1];
      if(lastBlock){
        const rect=lastBlock.getBoundingClientRect();
        if(rect.height>0&&event.clientY<rect.bottom-2)return;
      }
      window.getSelection()?.removeAllRanges();
      handlersRef.current.appendTrailingBlock();
    };
    root.addEventListener('supermd-edit-block',onEditBlock);
    const scroller=root.closest<HTMLElement>('.android-reading,.reading-scroll,.live-pane');
    const surface=scroller??root;
    surface.addEventListener('dblclick',onContainerDoubleClick);
    return()=>{
      root.removeEventListener('supermd-edit-block',onEditBlock);
      surface.removeEventListener('dblclick',onContainerDoubleClick);
    };
  },[]);

  const copy=(event:ClipboardEvent)=>{if((event.target as Element).closest('textarea'))return;const source=selectedMarkdown(window.getSelection(),markdown);if(source!==null){event.clipboardData.setData('text/plain',source);event.preventDefault();}};
  const update=(text:string,selectionStart?:number,selectionEnd?:number)=>{
    const active=editingRef.current;if(!active)return;
    if(active.insertAfter!==undefined&&text===''){
      const changed=active.syncedMarkdown!==active.baseMarkdown;
      const nextState={...active,text:'',syncedMarkdown:active.baseMarkdown};
      const pos=Math.max(0,Math.min(active.baseSplitEnd,active.baseMarkdown.length));
      savedSelection.current={from:pos,to:pos,markdown:active.baseMarkdown};
      editingRef.current=nextState;setEditing(nextState);
      if(changed)onChange(active.baseMarkdown);
      syncActiveCaretCenter();
      return;
    }
    const nextMarkdown=active.prefix+text+active.suffix,base=active.prefix.length;
    if(selectionStart!==undefined&&selectionEnd!==undefined){
      const from=Math.max(0,Math.min(base+selectionStart,nextMarkdown.length));
      const to=Math.max(from,Math.min(base+selectionEnd,nextMarkdown.length));
      savedSelection.current={from,to,markdown:nextMarkdown};
    }else if(savedSelection.current){
      const max=base+text.length;
      const from=Math.max(base,Math.min(savedSelection.current.from,max));
      const to=Math.max(from,Math.min(savedSelection.current.to,max));
      savedSelection.current={from,to,markdown:nextMarkdown};
    }
    const nextState={...active,text,syncedMarkdown:nextMarkdown};
    editingRef.current=nextState;setEditing(nextState);
    onChange(nextMarkdown);
    syncActiveCaretCenter();
  };
  const handleSuggestionAction=(edit?:{from:number;to:number;insertLength:number})=>{
    const area=editor.current;if(!area)return;
    let start=area.selectionStart,end=area.selectionEnd;
    if(edit){
      const delta=edit.insertLength-(edit.to-edit.from);
      const mapOffset=(pos:number)=>pos<=edit.from?pos:pos>=edit.to?pos+delta:edit.from+edit.insertLength;
      start=mapOffset(start);end=mapOffset(end);
      pendingSelection.current={start,end};
      setCaret(start);
    }
    area.focus({preventScroll:true});
    queueMicrotask(()=>{
      const current=editor.current,active=editingRef.current;if(!current||!current.isConnected)return;
      current.focus({preventScroll:true});
      if(!active||current.value===active.text){
        if(pendingSelection.current){
          const nextStart=Math.max(0,Math.min(current.value.length,pendingSelection.current.start));
          const nextEnd=Math.max(nextStart,Math.min(current.value.length,pendingSelection.current.end));
          pendingSelection.current=null;
          current.setSelectionRange(nextStart,nextEnd);
        }
        rememberSelection(current,active);
      }
    });
  };
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
  const syncTextareaCaret=(area:HTMLTextAreaElement)=>setCaret(area.selectionStart);
  const onEditorKeyDown=(event:ReactKeyboardEvent<HTMLTextAreaElement>)=>{
    if(event.nativeEvent.isComposing||event.keyCode===229)return;
    const active=editingRef.current;if(!active)return;
    const area=event.currentTarget;
    if(event.key==='Tab'&&!event.ctrlKey&&!event.metaKey&&!event.altKey){
      event.preventDefault();event.stopPropagation();
      const direction=area.selectionDirection;
      const result=indentMarkdownSelection(area.value,area.selectionStart,area.selectionEnd,event.shiftKey);
      if(result.value!==area.value){
        pendingSelection.current={start:result.selectionStart,end:result.selectionEnd,direction};
        area.setSelectionRange(result.lineStart,result.blockEnd);
        let applied=false;
        try{
          applied=result.replacement.length>0?document.execCommand('insertText',false,result.replacement):document.execCommand('delete',false);
        }catch{applied=false;}
        if(!applied||area.value!==result.value){
          update(result.value,result.selectionStart,result.selectionEnd);
          area.value=result.value;
        }else if(editingRef.current?.text!==result.value){
          update(result.value,result.selectionStart,result.selectionEnd);
        }
      }
      area.setSelectionRange(result.selectionStart,result.selectionEnd,direction);
      setCaret(result.selectionStart);
      rememberSelection(area,editingRef.current);
      area.focus({preventScroll:true});
      return;
    }
    if(event.key==='Escape'){
      rememberSelection(area,active);
      event.preventDefault();event.stopPropagation();
      pendingBlockFocus.current=active.insertAfter!==undefined&&active.text===''?(active.insertAfter==='end'?'end':{offset:active.insertAfter}):{offset:active.prefix.length};
      setEditing(null);
      return;
    }
    if(event.key==='Enter'&&(event.metaKey||event.ctrlKey)&&!event.altKey&&!event.shiftKey){
      event.preventDefault();event.stopPropagation();
      if(active.insertAfter!==undefined&&active.text.trim()===''){area.focus({preventScroll:true});return;}
      const committed=active.syncedMarkdown;
      const insertPos=active.prefix.length+active.text.length;
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
        if(next.text!==area.value){
          let diffStart=0,prevEnd=area.value.length,nextEnd=next.text.length;
          while(diffStart<prevEnd&&diffStart<nextEnd&&area.value[diffStart]===next.text[diffStart])diffStart++;
          while(prevEnd>diffStart&&nextEnd>diffStart&&area.value[prevEnd-1]===next.text[nextEnd-1]){prevEnd--;nextEnd--;}
          const replacement=next.text.slice(diffStart,nextEnd);
          pendingSelection.current={start:next.selectionStart,end:next.selectionEnd};
          area.setSelectionRange(diffStart,prevEnd);
          let applied=false;
          try{
            applied=replacement.length>0?document.execCommand('insertText',false,replacement):document.execCommand('delete',false);
          }catch{applied=false;}
          if(!applied||area.value!==next.text){
            update(next.text,next.selectionStart,next.selectionEnd);
            area.value=next.text;
          }else if(editingRef.current?.text!==next.text){
            update(next.text,next.selectionStart,next.selectionEnd);
          }
        }
        area.setSelectionRange(next.selectionStart,next.selectionEnd);
        rememberSelection(area,editingRef.current);
        area.focus({preventScroll:true});
        return;
      }
    }
    if(!event.ctrlKey&&!event.metaKey&&!event.altKey&&!event.shiftKey){
      if(event.key==='ArrowUp'&&isFirstLineCursor(area.value,area.selectionStart,area.selectionEnd)){
        const committed=active.syncedMarkdown,spans=editableBlockSpans(committed);
        const prev=spans.filter(span=>span.end<=active.prefix.length).at(-1);
        if(prev){
          event.preventDefault();event.stopPropagation();
          const len=prev.end-prev.start;
          openBlock(null,prev.start,prev.end,committed,{start:len,end:len});
        }
        return;
      }
      if(event.key==='ArrowDown'&&isLastLineCursor(area.value,area.selectionStart,area.selectionEnd)){
        const committed=active.syncedMarkdown,spans=editableBlockSpans(committed);
        const activeEnd=active.prefix.length+active.text.length;
        const next=spans.find(span=>span.start>=activeEnd);
        if(next){
          event.preventDefault();event.stopPropagation();
          openBlock(null,next.start,next.end,committed,{start:0,end:0});
        }
        return;
      }
    }
  };

  const textarea=()=>{
    const activeSession=editing!.session;
    const sourceStart=editing!.insertAfter!==undefined&&editing!.text===''?editing!.baseSplitEnd:editing!.prefix.length;
    return <div className="live-active-block"><textarea ref={editor} data-source-start={sourceStart} spellCheck={false} value={editing!.text} style={{height:Math.max(120,editing!.text.split('\n').length*27+32)}} onPaste={paste} onFocus={event=>rememberSelection(event.currentTarget)} onSelect={event=>{syncTextareaCaret(event.currentTarget);rememberSelection(event.currentTarget);}} onPointerUp={event=>{syncTextareaCaret(event.currentTarget);rememberSelection(event.currentTarget);}} onClick={event=>{syncTextareaCaret(event.currentTarget);rememberSelection(event.currentTarget);}} onChange={event=>{syncTextareaCaret(event.target);update(event.target.value,event.target.selectionStart,event.target.selectionEnd);}} onKeyUp={event=>{syncTextareaCaret(event.currentTarget);rememberSelection(event.currentTarget);if(['ArrowUp','ArrowDown','PageUp','PageDown','Home','End'].includes(event.key))syncActiveCaretCenter();}} onKeyDown={onEditorKeyDown} onBlur={event=>{if(!event.currentTarget.isConnected)return;if(editingRef.current?.session===activeSession)rememberSelection(event.currentTarget,editingRef.current);if(!event.relatedTarget||!event.currentTarget.parentElement?.contains(event.relatedTarget))setEditing(current=>current?.session===activeSession?null:current);}} aria-label="Edit Markdown block"/><WritingSuggestions text={editing!.text} caret={caret} spellCheck={spellCheck} grammarCheck={grammarCheck} onChange={text=>update(text,pendingSelection.current?.start,pendingSelection.current?.end)} onAction={handleSuggestionAction}/></div>;
  };
  const currentOffset=(offset:number)=>editing&&offset>=editing.baseSplitEnd?offset+editing.syncedMarkdown.length-editing.baseMarkdown.length:offset;
  const renderBlock=(entry:RenderedMarkdownBlock)=>{
    const offset=entry.node.position?.start.offset;
    // Generated footnote sections have no editable span. Render exactly once.
    if(offset===undefined)return <Fragment key={`extra-${entry.index}`}>{entry.content}</Fragment>;
    let low=0,high=blocks.length-1;while(low<high){const middle=(low+high+1)>>>1;if(blocks[middle].start<=offset)low=middle;else high=middle-1;}
    // Inter-block whitespace belongs outside the editor. Replacing all text
    // in a heading/paragraph must not join it onto the following source block.
    const block=blocks[low],start=currentOffset(block.start),end=currentOffset(entry.node.position?.end.offset??block.end);
    const active=!!editing&&editing.insertAfter===undefined&&block.start===editing.prefix.length;
    const insertedBelow=!!editing&&editing.insertAfter===block.start;
    const rendered=<WindowedBlock key={`block-${block.start}`} enabled={entry.windowed&&!active} estimate={entry.estimate} text={entry.text} headings={entry.headings} className="live-block" data-source-start={start} data-source-end={end} tabIndex={0} role="group" aria-label={`Editable block ${low+1}`} onDoubleClick={(event:ReactMouseEvent<HTMLElement>)=>{
      if(active||(event.target as Element).closest('a,button,input,select,textarea'))return;
      window.getSelection()?.removeAllRanges();openBlock(event.currentTarget,start,end);
    }} onKeyDown={event=>{if(!active&&event.target===event.currentTarget&&(event.key==='Enter'||event.key==='F2')){event.preventDefault();openBlock(event.currentTarget,start,end);}}}>
      {active?textarea():entry.content}
    </WindowedBlock>;
    return insertedBelow?<Fragment key={`insert-${block.start}`}>{rendered}<section className="live-block" role="group" aria-label="New Markdown block">{textarea()}</section></Fragment>:rendered;
  };
  const previewChange=(next:string)=>{
    if(!editing){onChange(next);return;}
    // Translate a checkbox outside the frozen editor without losing its draft.
    let start=0,end=renderedSource.length,nextEnd=next.length;
    while(start<end&&start<nextEnd&&renderedSource[start]===next[start])start++;
    while(end>start&&nextEnd>start&&renderedSource[end-1]===next[nextEnd-1]){end--;nextEnd--;}
    const from=currentOffset(start),to=currentOffset(end),currentDoc=editing.syncedMarkdown;setEditing(null);
    onChange(currentDoc.slice(0,from)+next.slice(start,nextEnd)+currentDoc.slice(to));
  };
  return <div ref={rootRef} className="live-document" onCopy={copy} onDragStart={event=>{setSelectedMarkdownDrag(event.nativeEvent,renderedSource);}}>
    {!renderedSource.trim()?(editing?textarea():<section className="live-block" data-source-start={0} data-source-end={markdown.length} tabIndex={0} role="group" aria-label="Editable block 1" onDoubleClick={event=>openBlock(event.currentTarget,0,markdown.length)} onKeyDown={event=>{if(event.key==='Enter'||event.key==='F2'){event.preventDefault();openBlock(event.currentTarget,0,markdown.length);}}}/> ):<>
      <MarkdownPreview markdown={renderedSource} onChange={previewChange} documentPath={documentPath} python={python} dark={dark} trustedImageHosts={trustedImageHosts} onTrustImageHost={onTrustImageHost} renderBlock={renderBlock} fullDocumentAccessibility={fullDocumentAccessibility} sourceAnalysis={sourceAnalysis}/>
      {editing?.insertAfter==='end'&&<section className="live-block" role="group" aria-label="New Markdown block">{textarea()}</section>}
    </>}
  </div>;
}
