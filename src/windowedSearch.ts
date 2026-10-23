/** Lightweight text indexes stay available when expensive rendered blocks leave
 * the viewport. The registry is released with each document, never persisted. */
import {flushSync} from 'react-dom';
import {refreshDocumentExtent} from './documentZoom';
const blocks=new Map<HTMLElement,string>();
const pendingAnchors=new WeakSet<HTMLElement>();
/** Mount/unmount one observer batch before paint. A deferred RAF correction
 * loses the anchor when another wheel/momentum step arrives before React
 * commits. Keep the latest viewport, change only layout, and restore its source
 * synchronously; never replay an earlier scrollTop or scroll gesture. */
export function commitWindowedLayout(root:Element|Document|null,update:()=>void):void {
  const host=root instanceof HTMLElement?root:null;
  const restore=host?captureWindowedScrollAnchor(host):undefined;
  flushSync(update);
  if(host)refreshDocumentExtent(host);
  restore?.();
}
/** Synchronous layout transaction only; never retain this across input frames. */
export function captureWindowedScrollAnchor(root:HTMLElement,changing?:HTMLElement):()=>void {
  const anchor=!root.dataset.navigating?windowedViewportAnchor(root,changing):undefined;
  const top=anchor?.getBoundingClientRect().top;
  return()=>{if(root.isConnected&&!root.dataset.navigating&&anchor?.isConnected&&root.contains(anchor)&&top!==undefined)root.scrollTop+=anchor.getBoundingClientRect().top-top;};
}
function windowedViewportAnchor(root:HTMLElement,changing?:HTMLElement):HTMLElement|undefined {
  if(root.scrollTop<1)return;
  const bounds=root.getBoundingClientRect(),x=bounds.left+bounds.width*.5;
  let hit:HTMLElement|undefined;
  // The preferred line can be in a paragraph margin. Try a bounded handful of
  // viewport points, not a scan through thousands of offscreen wrappers.
  for(const y of [Math.min(160,bounds.height*.35),bounds.height*.1,bounds.height*.6,bounds.height*.85]){
    const candidate=document.elementFromPoint(x,bounds.top+y)?.closest<HTMLElement>('[data-windowed-block]');
    if(candidate&&root.contains(candidate)){
      if(candidate===changing){
        // A loading label has no stable intrinsic geometry. If it occupies the
        // sample point, keep the already-visible source immediately after it,
        // not the top of the placeholder that is about to grow.
        let next=candidate.nextElementSibling;
        for(let i=0;next&&i<64;i++,next=next.nextElementSibling){
          if(next instanceof HTMLElement&&next.dataset.windowedMounted==='true'){
            const rect=next.getBoundingClientRect();
            if(rect.top>=bounds.bottom)break;
            if(rect.bottom>bounds.top)return next;
          }
        }
        continue;
      }
      if(candidate.dataset.windowedMounted==='true')return candidate;
      hit??=candidate;
    }
  }
  if(hit&&root.contains(hit)){
    // Fast scrolling can put the sample point on an estimated placeholder.
    // Its own top cannot anchor the real content below it as it expands.
    // Prefer a nearby, already-mounted block; never search the whole note.
    let next=hit.nextElementSibling,previous=hit.previousElementSibling;
    for(let i=0;i<64;i++){
      if(next instanceof HTMLElement&&next!==changing&&next.dataset.windowedMounted==='true')return next;
      if(previous instanceof HTMLElement&&previous!==changing&&previous.dataset.windowedMounted==='true')return previous;
      next=next?.nextElementSibling??null;previous=previous?.previousElementSibling??null;
      if(!next&&!previous)break;
    }
  }
}
/** Preserve one viewport anchor for a batch of lazy mount/unmount changes. */
export function preserveWindowedScroll(element:HTMLElement):void {
  const root=element.closest<HTMLElement>('.android-reading');if(!root||root.dataset.navigating||pendingAnchors.has(root)||root.scrollTop<1)return;
  const rect=root.getBoundingClientRect(),x=rect.left+rect.width*.5,y=rect.top+Math.min(160,rect.height*.35);
  const anchor=document.elementFromPoint(x,y)?.closest<HTMLElement>('[data-windowed-block]');if(!anchor)return;
  const top=anchor.getBoundingClientRect().top,scroll=root.scrollTop;pendingAnchors.add(root);
  requestAnimationFrame(()=>{pendingAnchors.delete(root);if(root.isConnected&&anchor.isConnected&&Math.abs(root.scrollTop-scroll)<1)root.scrollTop+=anchor.getBoundingClientRect().top-top;});
}
export function registerWindowedText(element:HTMLElement,text:string):()=>void {
  blocks.set(element,text);return()=>{blocks.delete(element);};
}
export interface WindowedMatch {element:HTMLElement;ordinal:number}
export function windowedMatches(host:Element,query:string,caseSensitive=false):WindowedMatch[]|null {
  if(!host.querySelector('[data-windowed-block]'))return null;
  const result:WindowedMatch[]=[];
  if(!query.trim())return result;
  const pattern=new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"),caseSensitive?"gu":"giu");
  for(const [element,text] of blocks){
    if(!host.contains(element))continue;
    pattern.lastIndex=0;let ordinal=0;
    while(pattern.exec(text)){result.push({element,ordinal:ordinal++});if(result.length>=5000)return result;}
  }
  // Registration order may change after a Live edit. Restore document order.
  return result.sort((a,b)=>a.element===b.element?a.ordinal-b.ordinal:a.element.compareDocumentPosition(b.element)&Node.DOCUMENT_POSITION_FOLLOWING?-1:1);
}
export function revealWindowed(element:HTMLElement):void {
  element.closest('[data-windowed-block]')?.dispatchEvent(new Event('supermd-reveal-window'));
}
