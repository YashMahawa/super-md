export function captureScrollAnchor(root: HTMLElement, focus?:{x:number;y:number}): () => void {
  const bounds = root.getBoundingClientRect(), y = focus?.y ?? bounds.top + Math.min(bounds.height * .35, 180), x = focus?.x ?? bounds.left + bounds.width * .45;
  const caret = (document as Document & { caretRangeFromPoint?: (x:number,y:number)=>Range|null }).caretRangeFromPoint?.(x,y);
  const range = caret && root.contains(caret.startContainer) ? caret.cloneRange() : null;
  if(range?.startContainer.nodeType===Node.TEXT_NODE && range.startOffset<(range.startContainer.textContent?.length??0))range.setEnd(range.startContainer,range.startOffset+1);
  const initial = range?.getBoundingClientRect();
  const useRange = !!initial?.height;
  // A caret anchor already identifies the visible text. Walking every block
  // anyway made native state/theme updates proportional to document length.
  const blocks = useRange?[]:Array.from(root.querySelectorAll<HTMLElement>("p,h1,h2,h3,h4,li,pre,table,.cm-line"));
  const block = blocks.find(node => { const rect=node.getBoundingClientRect(); return rect.top <= y && rect.bottom >= y; }) || blocks.find(node => node.getBoundingClientRect().bottom > bounds.top);
  const top = useRange ? initial!.top : block?.getBoundingClientRect().top;
  const left=useRange?initial!.left:undefined;
  const scroll = root.scrollTop, max = Math.max(1,root.scrollHeight-root.clientHeight);
  return () => {
    if (!root.isConnected) return;
    // At the start of a note, stay at its start. Anchoring a paragraph farther
    // down while fonts/reflow change would otherwise crop the title above it.
    if (scroll <= 1 && !focus) { root.scrollTop = 0; return; }
    const next = useRange && range?.startContainer.isConnected ? range.getBoundingClientRect().top : block?.isConnected ? block.getBoundingClientRect().top : undefined;
    if (top !== undefined && next !== undefined) root.scrollTop += next-top;
    else root.scrollTop = scroll/max * Math.max(0,root.scrollHeight-root.clientHeight);
    if(focus && left!==undefined && range?.startContainer.isConnected)root.scrollLeft+=range.getBoundingClientRect().left-left;
  };
}
