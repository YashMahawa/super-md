import type {Point} from './focalZoom';

const controls='a,button,input,textarea,select,summary,.cm-editor,.interactive-chart,.note-image,.image-viewer,[data-independent-zoom]';
function caretAt(root:HTMLElement,point:Point):Range|null {
  const range=(root.ownerDocument as Document&{caretRangeFromPoint?:(x:number,y:number)=>Range|null}).caretRangeFromPoint?.(point.x,point.y);
  if(!range||range.startContainer.nodeType!==Node.TEXT_NODE||!root.contains(range.startContainer)||range.startContainer.parentElement?.closest(controls+',.katex-mathml,annotation'))return null;
  return range;
}
function glyphBounds(range:Range,previous=false):DOMRect|null {
  const node=range.startContainer,length=node.textContent?.length??0;if(!length)return null;
  const glyph=range.cloneRange(),start=Math.max(0,Math.min(range.startOffset-(previous?1:0),length-1));glyph.setStart(node,start);glyph.setEnd(node,start+1);
  const rect=glyph.getBoundingClientRect();return rect.height&&rect.width?rect:null;
}
/** A blank callout gutter/margin is not the title or previous paragraph. Let
 * actual text hits retain native selection; only blank starts use the next
 * visible line. Probe a bounded neighbourhood, never every block in a note. */
export function followingGapCaret(root:HTMLElement,point:Point):Range|null {
  const initial=caretAt(root,point);
  // A caret is an insertion boundary: the right half of a glyph can resolve
  // after that character. Check both neighbours before treating it as a gap.
  if(initial&&[glyphBounds(initial),glyphBounds(initial,true)].some(glyph=>glyph&&point.x>=glyph.left-1&&point.x<=glyph.right+1&&point.y>=glyph.top-1&&point.y<=glyph.bottom+1))return null;
  const page=root.querySelector<HTMLElement>('.document-page'),bounds=root.getBoundingClientRect(),paper=page?.getBoundingClientRect()??bounds;
  const x=Math.max(Math.max(bounds.left,paper.left)+1,Math.min(point.x,Math.min(bounds.right,paper.right)-2));
  const limit=Math.min(bounds.bottom-2,point.y+192);
  for(let y=point.y;y<=limit;y+=4){
    const range=caretAt(root,{x,y}),rect=range&&glyphBounds(range);
    if(range&&rect&&rect.top>=point.y-1&&rect.bottom>=y&&rect.top<=y+4)return range.cloneRange();
  }
  return null;
}
export interface GapSelection {start(event:PointerEvent,root:HTMLElement):boolean;move(event:PointerEvent):void;end():void;refresh():void;cancelStationary():void}
/** The browser's native blank-space anchor can be a preceding heading. Own
 * this one gesture so it cannot reset that anchor during drag. Text hits,
 * double clicks, links, images, editor controls and touch handles stay native. */
export function createGapSelection(onDrag:()=>void):GapSelection {
  let active:{root:HTMLElement;anchor:Range;origin:Point;point:Point;moved:boolean}|null=null,edgeFrame=0,scrollFrame=0,last=0;
  const update=()=>{
    const drag=active;if(!drag?.moved||!drag.anchor.startContainer.isConnected)return;
    const bounds=drag.root.getBoundingClientRect(),point={x:Math.max(bounds.left+1,Math.min(drag.point.x,bounds.right-2)),y:Math.max(bounds.top+1,Math.min(drag.point.y,bounds.bottom-2))};
    const focus=caretAt(drag.root,point);if(!focus)return;
    // While still in the initial gap, do not extend backwards into its title.
    if(drag.point.y>=drag.origin.y&&focus.compareBoundaryPoints(Range.START_TO_START,drag.anchor)<0)return;
    drag.root.ownerDocument.getSelection()?.setBaseAndExtent(drag.anchor.startContainer,drag.anchor.startOffset,focus.startContainer,focus.startOffset);
  };
  const velocity=()=>{
    if(!active?.moved)return 0;const b=active.root.getBoundingClientRect(),y=active.point.y;
    return y<b.top+24?-Math.min(1,(b.top+24-y)/24)*b.height*1.2:y>b.bottom-24?Math.min(1,(y-b.bottom+24)/24)*b.height*1.2:0;
  };
  const edge=(time:number)=>{
    edgeFrame=0;const speed=velocity();if(!active||!speed){last=0;return;}
    const elapsed=last?Math.min(40,time-last):0;last=time;const before=active.root.scrollTop;
    active.root.scrollTop+=speed*elapsed/1000;update();
    if(active.root.scrollTop!==before||!elapsed)edgeFrame=requestAnimationFrame(edge);
  };
  const end=()=>{active=null;cancelAnimationFrame(edgeFrame);cancelAnimationFrame(scrollFrame);edgeFrame=scrollFrame=0;last=0;};
  return {
    start(event,root){
      end();if(event.defaultPrevented||event.pointerType!=='mouse'||event.button!==0||event.altKey||event.ctrlKey||event.metaKey||event.shiftKey||event.detail>1||(event.target as Element).closest(controls))return false;
      const point={x:event.clientX,y:event.clientY},anchor=followingGapCaret(root,point);if(!anchor)return false;
      event.preventDefault();(root.ownerDocument.activeElement as HTMLElement|null)?.blur();
      root.ownerDocument.getSelection()?.collapse(anchor.startContainer,anchor.startOffset);
      active={root,anchor,origin:point,point,moved:false};return true;
    },
    move(event){
      if(!active)return;if(!(event.buttons&1)){end();return;}
      active.point={x:event.clientX,y:event.clientY};
      if(!active.moved&&Math.hypot(active.point.x-active.origin.x,active.point.y-active.origin.y)<3)return;
      active.moved=true;onDrag();update();event.preventDefault();
      if(velocity()){if(!edgeFrame)edgeFrame=requestAnimationFrame(edge);}else{cancelAnimationFrame(edgeFrame);edgeFrame=0;last=0;}
    },
    refresh(){if(active?.moved&&!scrollFrame)scrollFrame=requestAnimationFrame(()=>{scrollFrame=0;update();});},
    cancelStationary(){if(active&&!active.moved)end();},end,
  };
}
