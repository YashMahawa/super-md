/** Lightweight text indexes stay available when expensive rendered blocks leave
 * the viewport. The registry is released with each document, never persisted. */
const blocks=new Map<HTMLElement,string>();
const pendingAnchors=new WeakSet<HTMLElement>();
/** Preserve one viewport anchor for a batch of lazy mount/unmount changes. */
export function preserveWindowedScroll(element:HTMLElement):void {
  const root=element.closest<HTMLElement>('.android-reading');if(!root||pendingAnchors.has(root)||root.scrollTop<1)return;
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
