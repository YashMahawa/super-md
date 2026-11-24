import {Fragment,useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState,type ClipboardEvent,type KeyboardEvent as ReactKeyboardEvent,type MouseEvent as ReactMouseEvent} from 'react';
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
import {editableBlockSpans,indentMarkdownSelection,isFirstLineCursor,isLastLineCursor} from '../liveBlockFlow';
import {liveEditorCenterDelta,useTypewriterScroll} from '../typewriterScroll';
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
  const editingRef=useRef<Editing|null>(editing);editingRef.current=editing;
  const markdownRef=useRef(markdown);markdownRef.current=markdown;
  const onChangeRef=useRef(onChange);onChangeRef.current=onChange;
  const activeTypewriter=useTypewriterScroll(typewriterScroll);
  const activeTypewriterRef=useRef(activeTypewriter);activeTypewriterRef.current=activeTypewriter;
  const sessionCounter=useRef(0),lastHandledSession=useRef(0);
  const appliedTypewriter=useRef(false),typingFrame=useRef(0);
  const anchorTop=useRef<number|null>(null),editor=useRef<HTMLTextAreaElement>(null),rootRef=useRef<HTMLDivElement>(null);
  const blockHistory=useRef<{undo:BlockSnapshot[];redo:BlockSnapshot[];last:number}>({undo:[],redo:[],last:0});
  const suppressHistoryPush=useRef(false);
  const lastSelection=useRef<{start:number;end:number;direction:"forward"|"backward"|"none"}>({start:0,end:0,direction:"none"});
  const pendingSelection=useRef<{start:number;end:number;direction?:"forward"|"backward"|"none"}|null>(null);
  const pendingBlockFocus=useRef<{offset:number}|'end'|null>(null);

  const syncSelectionFromDom=()=>{
    const area=editor.current;
    if(!area)return;
    lastSelection.current={
      start:area.selectionStart,
      end:area.selectionEnd,
      direction:area.selectionDirection||"none",
    };
  };

  const renderedSource=editing?editing.baseMarkdown:markdown;
  const sourceAnalysis=useMemo(()=>({source:renderedSource,analysis:analyzeDocument(renderedSource)}),[renderedSource]);
  const blocks=sourceAnalysis.analysis.blocks;

  const openBlock=(element:HTMLElement|null,start:number,end:number,baseDoc=editingRef.current?editingRef.current.syncedMarkdown:markdownRef.current,selection?:{start:number;end:number})=>{
    anchorTop.current=element?element.getBoundingClientRect().top:null;
    blockHistory.current={undo:[],redo:[],last:0};
    lastSelection.current={start:selection?.start??0,end:selection?.end??0,direction:"none"};
    pendingSelection.current=selection?{start:selection.start,end:selection.end,direction:"none"}:null;
    const analysis=baseDoc===sourceAnalysis.source?sourceAnalysis.analysis:analyzeDocument(baseDoc);
    const text=baseDoc.slice(start,end);
    const protectedBlock=analysis.tree.children.some(node=>['code','math','html','definition'].includes(node.type)&&(node.position?.start.offset??-1)>=start&&(node.position?.end.offset??Infinity)<=end);
    setEditing({session:++sessionCounter.current,prefix:baseDoc.slice(0,start),text,suffix:baseDoc.slice(end),baseMarkdown:baseDoc,baseSplitEnd:end,syncedMarkdown:baseDoc,protectedBlock});
  };

  const openInsertedBlock=(baseDoc:string,insertPos:number,insertAfter:number|'end')=>{
    anchorTop.current=null;
    blockHistory.current={undo:[],redo:[],last:0};
    lastSelection.current={start:0,end:0,direction:"none"};
    pendingSelection.current={start:0,end:0,direction:"none"};
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
    if(sel)area.setSelectionRange(Math.min(sel.start,area.value.length),Math.min(sel.end,area.value.length),sel.direction||"none");
    syncSelectionFromDom();
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

  useEffect(()=>()=>{if(typingFrame.current)cancelAnimationFrame(typingFrame.current);},[]);
  const syncActiveCaretCenter=useCallback(()=>{
    if(!activeTypewriterRef.current)return;
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

  useLayoutEffect(()=>{
    const sel=pendingSelection.current,area=editor.current;
    if(!sel||!area)return;
    pendingSelection.current=null;
    area.focus({preventScroll:true});
    const max=area.value.length;
    const start=Math.max(0,Math.min(max,sel.start));
    const end=Math.max(start,Math.min(max,sel.end));
    const direction=sel.direction||"none";
    area.setSelectionRange(start,end,direction);
    lastSelection.current={start,end,direction};
  },[editing?.text]);

  useEffect(()=>{
    if(!editing)return;
    const activeSession=editing.session;
    const outsidePointerDown=(event:PointerEvent)=>{
      const target=event.target instanceof Element?event.target:null;
      if(target&&!target.closest('.live-active-block'))setEditing(current=>current?.session===activeSession?null:current);
    };
    document.addEventListener('pointerdown',outsidePointerDown,true);
    return()=>document.removeEventListener('pointerdown',outsidePointerDown,true);
  },[editing?.session]);

  useEffect(()=>{
    const active=editingRef.current;
    if(active&&markdown!==active.syncedMarkdown)setEditing(null);
  },[markdown]);

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
  const update=useCallback((text:string)=>{
    const active=editingRef.current;if(!active)return;
    if(active.insertAfter!==undefined&&text===''){
      const changed=active.syncedMarkdown!==active.baseMarkdown;
      const nextState={...active,text:'',syncedMarkdown:active.baseMarkdown};
      editingRef.current=nextState;setEditing(nextState);
      if(changed)onChangeRef.current(active.baseMarkdown);
      syncActiveCaretCenter();
      return;
    }
    const nextMarkdown=active.prefix+text+active.suffix;
    const nextState={...active,text,syncedMarkdown:nextMarkdown};
    editingRef.current=nextState;setEditing(nextState);
    onChangeRef.current(nextMarkdown);
    syncActiveCaretCenter();
  },[syncActiveCaretCenter]);

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
  const onEditorKeyDown=(event:ReactKeyboardEvent<HTMLTextAreaElement>)=>{
    const active=editingRef.current;if(!active)return;
    const area=event.currentTarget;
    if(event.key==='Tab'&&!event.ctrlKey&&!event.metaKey&&!event.altKey){
      event.preventDefault();event.stopPropagation();
      const origStart=area.selectionStart,origEnd=area.selectionEnd;
      const direction=area.selectionDirection||"none";
      const result=indentMarkdownSelection(area.value,origStart,origEnd,event.shiftKey);
      if(result.value!==area.value){
        blockHistory.current.undo.push({
          text:active.text,
          start:origStart,
          end:origEnd,
          direction,
        });
        while(blockHistory.current.undo.length>60)blockHistory.current.undo.shift();
        blockHistory.current.redo=[];
        blockHistory.current.last=0;
        notifyHistoryBoundary();
        suppressHistoryPush.current=true;
        area.setSelectionRange(result.lineStart,result.blockEnd);
        let applied=false;
        try{
          applied=result.replacement.length>0?document.execCommand('insertText',false,result.replacement):document.execCommand('delete',false);
        }catch{applied=false;}
        suppressHistoryPush.current=false;
        if(!applied||area.value!==result.value){
          update(result.value);
          area.value=result.value;
        }else if(editingRef.current?.text!==result.value){
          update(result.value);
        }
        notifyHistoryBoundary();
      }
      area.setSelectionRange(result.selectionStart,result.selectionEnd,direction);
      lastSelection.current={start:result.selectionStart,end:result.selectionEnd,direction};
      area.focus({preventScroll:true});
      return;
    }
    if(event.key==='Escape'){
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
    const active=editingRef.current;
    if(!active)return;
    if(!suppressHistoryPush.current){
      const now=Date.now();
      if(
        now-blockHistory.current.last>600||
        Math.abs(nextText.length-active.text.length)>1||
        blockHistory.current.undo.length===0
      ){
        blockHistory.current.undo.push({
          text:active.text,
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
    update(nextText);
  };

  const textarea=()=>{
    const activeSession=editing!.session;
    return <div className="live-active-block"><textarea ref={editor} data-source-start={editing!.prefix.length} spellCheck={false} value={editing!.text} style={{height:Math.max(120,editing!.text.split('\n').length*27+32)}} onPaste={paste} onSelect={syncSelectionFromDom} onKeyUp={event=>{syncSelectionFromDom();if(['ArrowUp','ArrowDown','PageUp','PageDown','Home','End'].includes(event.key))syncActiveCaretCenter();}} onPointerUp={syncSelectionFromDom} onFocus={syncSelectionFromDom} onChange={event=>handleTextareaChange(event.target.value,event.target)} onKeyDown={onEditorKeyDown} onBlur={event=>{if(!event.currentTarget.isConnected)return;if(event.relatedTarget&&!event.currentTarget.parentElement?.contains(event.relatedTarget))setEditing(current=>current?.session===activeSession?null:current);}} aria-label="Edit Markdown block"/><WritingSuggestions text={editing!.text} spellCheck={spellCheck} grammarCheck={grammarCheck} onChange={next=>commitDiscreteBlockEdit(next,next.length,next.length)}/></div>;
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
    {!renderedSource.trim()?(editing?textarea():<section className="live-block" tabIndex={0} role="group" aria-label="Editable block 1" onDoubleClick={event=>openBlock(event.currentTarget,0,markdown.length)} onKeyDown={event=>{if(event.key==='Enter'||event.key==='F2'){event.preventDefault();openBlock(event.currentTarget,0,markdown.length);}}}/> ):<>
      <MarkdownPreview markdown={renderedSource} onChange={previewChange} documentPath={documentPath} python={python} dark={dark} trustedImageHosts={trustedImageHosts} onTrustImageHost={onTrustImageHost} renderBlock={renderBlock} fullDocumentAccessibility={fullDocumentAccessibility} sourceAnalysis={sourceAnalysis}/>
      {editing?.insertAfter==='end'&&<section className="live-block" role="group" aria-label="New Markdown block">{textarea()}</section>}
    </>}
  </div>;
}
