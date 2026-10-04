import type { Point } from "./focalZoom";
type Geometry={page:HTMLElement;space:HTMLElement;width:number;height:number;viewport:number;bounds:DOMRect;originX:number;originY:number;left:number};
const geometry=new WeakMap<HTMLElement,Geometry>();
export function invalidateDocumentZoom(root:HTMLElement):void {geometry.delete(root);}
/** Lazy math/images can change page height while the user scrolls. Update the
 * extent only: reapplying zoom here would repeatedly unset selection zoom and
 * write scrollTop, fighting touchpad momentum and native selection handles. */
export function refreshDocumentExtent(root:HTMLElement):boolean {
  const measured=geometry.get(root);if(!measured || measured.viewport!==root.clientWidth)return false;
  const height=measured.page.offsetHeight;
  if(height!==measured.height){measured.height=height;measured.space.style.height=`${height*(Number(measured.page.dataset.scale)||1)}px`;}
  const bounds=root.getBoundingClientRect();
  // Native chrome may change the viewport's origin without changing its width.
  measured.originX+=bounds.left-measured.bounds.left;measured.originY+=bounds.top-measured.bounds.top;measured.bounds=bounds;
  return true;
}
/** Modern WebView selection handles need layout zoom at rest. Older Chromium
 * uses pre-standard CSS zoom geometry, which disagrees with hit testing. Keep
 * its compositor scale instead. Detect the standardized API, not OS/version.
 * https://developer.chrome.com/release-notes/128#standardized_css_zoom_property */
export function settleDocumentZoom(root:HTMLElement):void {
  const measured=geometry.get(root);if(!measured)return;
  const {page}=measured,scale=Number(page.dataset.scale)||1;
  const standardized='currentCSSZoom' in page;
  page.style.zoom=standardized?String(scale):'1';
  page.style.transform=standardized?`translateX(${measured.left/scale}px)`:`translateX(${measured.left}px) scale(${scale})`;
  page.dataset.selectionScale=String(scale);
  page.dataset.selectionModel=standardized?'layout':'transform';
}
/** Layout at the user's base reading width, then magnify the whole page. Font,
 * math, tables and wrapping stay in the same relative positions as in a PDF. */
/** The unscaled page coordinate under a viewport point. A glide holds this
 * fixed across frames, so clamped intermediate scrolls cannot accumulate drift. */
export function documentPoint(root:HTMLElement, focus?:Point):Point|null {
  const measured=geometry.get(root);if(!measured)return null;
  const scale=Number(measured.page.dataset.scale)||1,bounds=measured.bounds;
  const target=focus||{x:bounds.left+bounds.width/2,y:bounds.top+(root.scrollTop<1?0:bounds.height*.35)};
  return {x:(target.x-measured.originX-measured.left+root.scrollLeft)/scale,y:(target.y-measured.originY+root.scrollTop)/scale};
}
export function applyDocumentZoom(root:HTMLElement, zoom:number, widthPercent:number, focus?:Point, previousFocus=focus, anchor?:Point|null):void {
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
  // Where the page's left edge sat on screen before this zoom step.
  const visibleLeft=measured.left-root.scrollLeft;
  const oldScale=Number(page.dataset.scale)||1,next=zoom/100;
  const point=anchor||{x:(oldFocus.x-measured.originX-measured.left+root.scrollLeft)/oldScale,y:(oldFocus.y-measured.originY+root.scrollTop)/oldScale};
  const width=Math.max(240,(viewport-32)*widthPercent/100);
  // A compositor transform keeps KaTeX/layout out of each pinch frame. CSS
  // zoom invalidates layout throughout a long document even with fixed wraps.
  // Horizontal room, so the page never sticks to the left edge: once it is
  // magnified past the window it can slide until either edge has a reading
  // margin, and fullscreen lets even a narrower page slide sideways.
  const scaled=width*next,overflow=scaled+32>viewport;
  const fullscreen=root.ownerDocument.documentElement.dataset.fullscreen==="true";
  const room=overflow?Math.max(16,viewport*.25):fullscreen?Math.max(0,viewport-scaled-32):0;
  const left=overflow?room:room?16+room:Math.max(16,(viewport-scaled)/2);
  const spaceWidth=overflow?scaled+2*room:room?viewport+room:viewport;
  if(page.style.zoom && page.style.zoom!=="1")page.style.zoom="1";
  delete page.dataset.selectionScale;
  delete page.dataset.selectionModel;
  if(width!==measured.width){page.style.width=`${width}px`;page.style.marginLeft="0px";measured.width=width;measured.height=page.offsetHeight;}
  page.style.transform=`translateX(${left}px) scale(${next})`;page.dataset.scale=String(next);page.dataset.zoomLeft=String(left);measured.left=left;
  space.style.width=`${spaceWidth}px`;
  space.style.height=`${measured.height*next}px`;
  // Solve the focal translation analytically. Reading the whole page's bounds
  // and offsetHeight after every write forced layout in each pinch frame.
  // A magnified page opens with its line starts in view; fullscreen slack is centred.
  if(first && !focus){root.scrollLeft=overflow?room-16:(spaceWidth-viewport)/2;root.scrollTop=0;}
  else {
    root.scrollLeft=measured.originX+left+point.x*next-target.x;root.scrollTop=measured.originY+point.y*next-target.y;
    // Keyboard/settings zoom has no focal point: keep line starts where they
    // were instead of pushing them off the left edge.
    if(!focus&&overflow&&visibleLeft>=0)root.scrollLeft=left-Math.min(visibleLeft,room);
  }
}
