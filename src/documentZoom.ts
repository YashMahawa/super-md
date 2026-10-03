import type { Point } from "./focalZoom";
/** Layout at the user's base reading width, then magnify the whole page. Font,
 * math, tables and wrapping stay in the same relative positions as in a PDF. */
export function applyDocumentZoom(root:HTMLElement, zoom:number, widthPercent:number, focus?:Point, previousFocus=focus):void {
  const page=root.querySelector<HTMLElement>(".document-page");if(!page)return;
  const old=page.getBoundingClientRect(),bounds=root.getBoundingClientRect();
  const target=focus||{x:bounds.left+bounds.width/2,y:bounds.top+(root.scrollTop<1?0:bounds.height*.35)};
  const oldFocus=previousFocus||target;
  const oldScale=Number(page.dataset.scale)||1,next=zoom/100;
  const point={x:(oldFocus.x-old.left)/oldScale,y:(oldFocus.y-old.top)/oldScale};
  const width=Math.max(240,(root.clientWidth-32)*widthPercent/100);
  // A compositor transform keeps KaTeX/layout out of each pinch frame. CSS
  // zoom invalidates layout throughout a long document even with fixed wraps.
  const left=Math.max(16,(root.clientWidth-width*next)/2);
  page.style.width=`${width}px`;page.style.marginLeft="0px";page.style.transform=`translateX(${left}px) scale(${next})`;page.dataset.scale=String(next);
  const space=page.parentElement!;space.style.width=`${Math.max(root.clientWidth,width*next+32)}px`;
  space.style.height=`${page.offsetHeight*next}px`;
  const after=page.getBoundingClientRect();
  root.scrollLeft+=after.left+point.x*next-target.x;
  root.scrollTop+=after.top+point.y*next-target.y;
}
