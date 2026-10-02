export function captureScrollAnchor(root: HTMLElement): () => void {
  const bounds = root.getBoundingClientRect(), y = bounds.top + Math.min(bounds.height * .35, 180), x = bounds.left + bounds.width * .45;
  const caret = (document as Document & { caretRangeFromPoint?: (x:number,y:number)=>Range|null }).caretRangeFromPoint?.(x,y);
  const range = caret && root.contains(caret.startContainer) ? caret.cloneRange() : null;
  const blocks = Array.from(root.querySelectorAll<HTMLElement>("p,h1,h2,h3,h4,li,pre,table,.cm-line"));
  const block = blocks.find(node => { const rect=node.getBoundingClientRect(); return rect.top <= y && rect.bottom >= y; }) || blocks.find(node => node.getBoundingClientRect().bottom > bounds.top);
  const initial = range?.getBoundingClientRect();
  const useRange = !!initial?.height;
  const top = useRange ? initial!.top : block?.getBoundingClientRect().top;
  const scroll = root.scrollTop, max = Math.max(1,root.scrollHeight-root.clientHeight);
  return () => {
    if (!root.isConnected) return;
    const next = useRange && range?.startContainer.isConnected ? range.getBoundingClientRect().top : block?.isConnected ? block.getBoundingClientRect().top : undefined;
    if (top !== undefined && next !== undefined) root.scrollTop += next-top;
    else root.scrollTop = scroll/max * Math.max(0,root.scrollHeight-root.clientHeight);
  };
}
