import {useCallback,useEffect,useLayoutEffect,useRef,type RefObject} from 'react';
import {refreshDocumentExtent} from './documentZoom';
import {liveEditorCenterDelta} from './typewriterScroll';
import type {BlockSelection,EditingSession,PendingBlockFocus} from './liveBlockHistory';

const LIVE_SCROLLER_SELECTOR='.android-reading,.reading-scroll,.preview-pane,.live-scroll';
export interface CloseAnchor {scroller:HTMLElement;element:HTMLElement;top:number}

export function captureLiveCloseAnchor(area:HTMLTextAreaElement|null,target?:Element|null,clientY?:number|null):CloseAnchor|null{
  const scroller=area?.closest<HTMLElement>(LIVE_SCROLLER_SELECTOR);
  if(!scroller||scroller.dataset.navigating)return null;
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
  return anchorElement?.isConnected?{scroller,element:anchorElement,top:anchorElement.getBoundingClientRect().top}:null;
}

export interface UseLiveViewportHoldOptions {
  editing:EditingSession|null;
  activeTypewriter:boolean;
  rootRef:RefObject<HTMLDivElement|null>;
  editorRef:RefObject<HTMLTextAreaElement|null>;
  anchorTop:RefObject<number|null>;
  pendingSelection:RefObject<BlockSelection|null>;
  pendingBlockFocus:RefObject<PendingBlockFocus>;
  latestRef:RefObject<{activeTypewriter:boolean}>;
  syncSelection:(area?:HTMLTextAreaElement|null,current?:EditingSession|null)=>void;
}

export function useLiveViewportHold({
  editing,activeTypewriter,rootRef,editorRef,anchorTop,pendingSelection,pendingBlockFocus,latestRef,syncSelection,
}:UseLiveViewportHoldOptions){
  const lastHandledSession=useRef(0),appliedTypewriter=useRef(false),typingFrame=useRef(0);
  const closeAnchorRef=useRef<CloseAnchor|null>(null);

  const captureCloseAnchor=useCallback((target?:Element|null,clientY?:number|null)=>{
    const captured=captureLiveCloseAnchor(editorRef.current,target,clientY);
    if(captured)closeAnchorRef.current=captured;
  },[editorRef]);

  useLayoutEffect(()=>{
    const doc=rootRef.current;if(!doc)return;
    const scroller=doc.closest<HTMLElement>(LIVE_SCROLLER_SELECTOR);
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
  },[activeTypewriter,rootRef]);

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
    const area=editorRef.current;if(!area)return;
    const scroller=area.closest<HTMLElement>(LIVE_SCROLLER_SELECTOR);
    const anchor=anchorTop.current;anchorTop.current=null;
    const sel=pendingSelection.current;pendingSelection.current=null;
    if(isNewSession||document.activeElement!==area)area.focus({preventScroll:true});
    if(sel)area.setSelectionRange(Math.min(sel.start,area.value.length),Math.min(sel.end,area.value.length),sel.direction||'none');
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
  },[activeTypewriter,anchorTop,editing,editorRef,pendingBlockFocus,pendingSelection,rootRef,syncSelection]);

  useEffect(()=>()=>{if(typingFrame.current)cancelAnimationFrame(typingFrame.current);},[]);
  const syncActiveCaretCenter=useCallback(()=>{
    if(!latestRef.current.activeTypewriter)return;
    if(typingFrame.current)cancelAnimationFrame(typingFrame.current);
    typingFrame.current=requestAnimationFrame(()=>{
      typingFrame.current=0;
      const area=editorRef.current;if(!area||!area.isConnected)return;
      const scroller=area.closest<HTMLElement>(LIVE_SCROLLER_SELECTOR);
      if(!scroller)return;
      if(scroller.matches('.android-reading'))refreshDocumentExtent(scroller);
      const delta=liveEditorCenterDelta(area,scroller,area.value.includes('\n'));
      if(Math.abs(delta)>1)scroller.scrollTop+=delta;
    });
  },[editorRef,latestRef]);

  return {closeAnchorRef,typingFrame,captureCloseAnchor,syncActiveCaretCenter};
}
