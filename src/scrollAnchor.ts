let inputVersion=0;
export function markScrollInput():void {inputVersion++;}
export function scrollInputVersion():number {return inputVersion;}
if(typeof document!=='undefined')for(const name of ['wheel','touchstart','touchmove','pointerdown','keydown'])document.addEventListener(name,markScrollInput,{capture:true,passive:true});
export function captureScrollAnchor(root: HTMLElement, focus?:{x:number;y:number}): () => void {
  const capturedInput=inputVersion;
  const bounds = root.getBoundingClientRect(), y = focus?.y ?? bounds.top + Math.min(bounds.height * .35, 180), x = focus?.x ?? bounds.left + bounds.width * .45;
  const caret = (document as Document & { caretRangeFromPoint?: (x:number,y:number)=>Range|null }).caretRangeFromPoint?.(x,y);
  const range = caret && root.contains(caret.startContainer) ? caret.cloneRange() : null;
  if(range?.startContainer.nodeType===Node.TEXT_NODE && range.startOffset<(range.startContainer.textContent?.length??0))range.setEnd(range.startContainer,range.startOffset+1);
  const initial = range?.getBoundingClientRect();
  const useRange = !!initial?.height;
  // A caret anchor already identifies the visible text. Walking every block
  // anyway made native state/theme updates proportional to document length.
  const stable=range?.startContainer.parentElement?.closest<HTMLElement>('[data-windowed-block]');
  const blocks = useRange?[]:Array.from(root.querySelectorAll<HTMLElement>("[data-windowed-block],p,h1,h2,h3,h4,li,pre,table,.cm-line"));
  const block = stable || blocks.find(node => { const rect=node.getBoundingClientRect(); return rect.top <= y && rect.bottom >= y; }) || blocks.find(node => node.getBoundingClientRect().bottom > bounds.top);
  const blockTop=block?.getBoundingClientRect().top;
  const top = useRange ? initial!.top : block?.getBoundingClientRect().top;
  const left=useRange?initial!.left:undefined;
  const scroll = root.scrollTop, max = Math.max(1,root.scrollHeight-root.clientHeight);
  return () => {
    // An asynchronous palette/layout update must never rewind a newer scroll.
    if (!root.isConnected || inputVersion!==capturedInput) return;
    // At the start of a note, stay at its start. Anchoring a paragraph farther
    // down while fonts/reflow change would otherwise crop the title above it.
    if (scroll <= 1 && !focus) { root.scrollTop = 0; return; }
    const rangeAlive=useRange && range?.startContainer.isConnected;
    const next = rangeAlive ? range!.getBoundingClientRect().top : block?.isConnected ? block.getBoundingClientRect().top : undefined;
    const previous=rangeAlive?top:blockTop;
    if (previous !== undefined && next !== undefined) root.scrollTop += next-previous;
    else root.scrollTop = scroll/max * Math.max(0,root.scrollHeight-root.clientHeight);
    if(focus && left!==undefined && range?.startContainer.isConnected)root.scrollLeft+=range.getBoundingClientRect().left-left;
  };
}
