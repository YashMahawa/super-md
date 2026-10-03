import type { Point } from "./focalZoom";
type Geometry={page:HTMLElement;space:HTMLElement;width:number;height:number;viewport:number;bounds:DOMRect;originX:number;originY:number;left:number};
const geometry=new WeakMap<HTMLElement,Geometry>();
export function invalidateDocumentZoom(root:HTMLElement):void {geometry.delete(root);}
/** WebView's native selection handles need an untransformed scale at rest.
 * Pinching remains composited; layout zoom is committed once the gesture ends. */
export function settleDocumentZoom(root:HTMLElement):void {
  const measured=geometry.get(root);if(!measured)return;
  const {page}=measured,scale=Number(page.dataset.scale)||1;
  page.style.zoom=String(scale);
  page.style.transform=`translateX(${measured.left/scale}px)`;
  page.dataset.selectionScale=String(scale);
}
/** Layout at the user's base reading width, then magnify the whole page. Font,
 * math, tables and wrapping stay in the same relative positions as in a PDF. */
export function applyDocumentZoom(root:HTMLElement, zoom:number, widthPercent:number, focus?:Point, previousFocus=focus):void {
  let measured=geometry.get(root);
  if(!measured){
    const page=root.querySelector<HTMLElement>(".document-page");if(!page)return;
    const old=page.getBoundingClientRect(),bounds=root.getBoundingClientRect(),left=Number(page.dataset.zoomLeft)||0;
    measured={page,space:page.parentElement!,width:0,height:page.offsetHeight,viewport:root.clientWidth,bounds,originX:old.left+root.scrollLeft-left,originY:old.top+root.scrollTop,left};geometry.set(root,measured);
  }
  const {page,space,bounds,viewport}=measured;
  const first=!page.dataset.scale;
  const target=focus||{x:bounds.left+bounds.width/2,y:bounds.top+(root.scrollTop<1?0:bounds.height*.35)};
  const oldFocus=previousFocus||target;
  const oldScale=Number(page.dataset.scale)||1,next=zoom/100;
  const point={x:(oldFocus.x-measured.originX-measured.left+root.scrollLeft)/oldScale,y:(oldFocus.y-measured.originY+root.scrollTop)/oldScale};
  const width=Math.max(240,(viewport-32)*widthPercent/100);
  // A compositor transform keeps KaTeX/layout out of each pinch frame. CSS
  // zoom invalidates layout throughout a long document even with fixed wraps.
  const left=Math.max(16,(viewport-width*next)/2);
  if(page.style.zoom && page.style.zoom!=="1")page.style.zoom="1";
  delete page.dataset.selectionScale;
  if(width!==measured.width){page.style.width=`${width}px`;page.style.marginLeft="0px";measured.width=width;measured.height=page.offsetHeight;}
  page.style.transform=`translateX(${left}px) scale(${next})`;page.dataset.scale=String(next);page.dataset.zoomLeft=String(left);measured.left=left;
  space.style.width=`${Math.max(viewport,width*next+32)}px`;
  space.style.height=`${measured.height*next}px`;
  // Solve the focal translation analytically. Reading the whole page's bounds
  // and offsetHeight after every write forced layout in each pinch frame.
  if(first && !focus){root.scrollLeft=0;root.scrollTop=0;}
  else {root.scrollLeft=measured.originX+left+point.x*next-target.x;root.scrollTop=measured.originY+point.y*next-target.y;}
}
