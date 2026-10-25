// @vitest-environment jsdom
import {expect,it,vi} from 'vitest';
import {applyDocumentZoom,enforceDocumentCenter,invalidateDocumentZoom,settleDocumentZoom,refreshDocumentExtent} from './documentZoom';
it('zoomed-out desktop translation aligns native selection without changing base wrapping width',()=>{
  const previous=document.documentElement.dataset.platform;
  document.documentElement.dataset.platform='desktop';
  try {
    const root=document.createElement('section'),space=document.createElement('div'),page=document.createElement('div');page.className='document-page';root.append(space);space.append(page);
    page.getBoundingClientRect=()=>({left:800.5,top:0} as DOMRect);root.getBoundingClientRect=()=>({left:800.5,top:0,width:799,height:800} as DOMRect);
    Object.defineProperty(root,'clientWidth',{value:799});Object.defineProperty(page,'offsetHeight',{value:10000});
    applyDocumentZoom(root,40,90,undefined,undefined,undefined,true);
    const left=Number(page.dataset.zoomLeft),base=Number.parseFloat(page.style.width);
    expect(left).toBe(Math.round(left));expect(base).toBeCloseTo((799-32)*.9);
    expect(Math.abs(left+base*.4/2-799/2)).toBeLessThanOrEqual(.5);
  } finally {if(previous===undefined)delete document.documentElement.dataset.platform;else document.documentElement.dataset.platform=previous;}
});
it('centre lock survives off-centre zoom and horizontal gestures without touching vertical momentum',()=>{
  const root=document.createElement('section'),space=document.createElement('div'),page=document.createElement('div');page.className='document-page';root.append(space);space.append(page);
  const bounds=vi.fn(()=>({left:0,top:0,width:1000,height:800} as DOMRect));root.getBoundingClientRect=bounds;page.getBoundingClientRect=bounds;
  Object.defineProperty(root,'clientWidth',{value:1000});Object.defineProperty(page,'offsetHeight',{value:100000});
  for(const fullscreen of ['false','true']){
    document.documentElement.dataset.fullscreen=fullscreen;
    for(const zoom of [40,100,200,300]){
      applyDocumentZoom(root,zoom,80,{x:140,y:300},undefined,undefined,true);
      const scaled=Number.parseFloat(page.style.width)*zoom/100,left=Number(page.dataset.zoomLeft);
      expect(left+scaled/2-root.scrollLeft).toBeCloseTo(500);
      root.scrollTop=1234;root.scrollLeft+=80;const reads=bounds.mock.calls.length;
      enforceDocumentCenter(root);expect(root.scrollTop).toBe(1234);expect(bounds).toHaveBeenCalledTimes(reads);
      expect(left+scaled/2-root.scrollLeft).toBeCloseTo(500);
    }
  }
  applyDocumentZoom(root,200,80,undefined,undefined,undefined,false);root.scrollLeft=42;enforceDocumentCenter(root);expect(root.scrollLeft).toBe(42);
  delete document.documentElement.dataset.fullscreen;
});
it('keeps zoom frames independent of document measurement after initial layout',()=>{
  const root=document.createElement('section'),space=document.createElement('div'),page=document.createElement('div');page.className='document-page';root.append(space);space.append(page);
  const pageBounds=vi.fn(()=>({left:0,top:0,width:800,height:100000} as DOMRect)),rootBounds=vi.fn(()=>({left:0,top:0,width:1000,height:800} as DOMRect));page.getBoundingClientRect=pageBounds;root.getBoundingClientRect=rootBounds;
  const height=vi.fn(()=>100000);Object.defineProperty(page,'offsetHeight',{get:height});Object.defineProperty(root,'clientWidth',{value:1000});
  applyDocumentZoom(root,100,80);const reads=height.mock.calls.length;
  for(let i=0;i<60;i++)applyDocumentZoom(root,100+i,80,{x:400,y:300});
  expect(pageBounds).toHaveBeenCalledTimes(1);expect(rootBounds).toHaveBeenCalledTimes(1);expect(height).toHaveBeenCalledTimes(reads);expect(page.dataset.scale).toBe('1.59');
  invalidateDocumentZoom(root);applyDocumentZoom(root,160,80);expect(pageBounds).toHaveBeenCalledTimes(2);
});
it('settles selection to layout zoom without changing the focal scale',()=>{
  const root=document.createElement('section'),space=document.createElement('div'),page=document.createElement('div');page.className='document-page';root.append(space);space.append(page);
  page.getBoundingClientRect=()=>({left:0,top:0} as DOMRect);root.getBoundingClientRect=()=>({left:0,top:0,width:1000,height:800} as DOMRect);
  Object.defineProperty(root,'clientWidth',{value:1000});Object.defineProperty(page,'offsetHeight',{value:10000});
  Object.defineProperty(page,'currentCSSZoom',{get:()=>Number(page.style.zoom)||1});
  applyDocumentZoom(root,160,80);settleDocumentZoom(root);
  expect(page.style.zoom).toBe('1.6');expect(page.dataset.selectionScale).toBe('1.6');expect(page.style.transform).not.toContain('scale');
  applyDocumentZoom(root,180,80);expect(page.style.zoom).toBe('1');expect(page.dataset.selectionScale).toBeUndefined();expect(page.dataset.scale).toBe('1.8');
});
it('lazy content height updates never replay zoom or write the user scroll position',()=>{
  const root=document.createElement('section'),space=document.createElement('div'),page=document.createElement('div');page.className='document-page';root.append(space);space.append(page);
  page.getBoundingClientRect=()=>({left:0,top:0} as DOMRect);root.getBoundingClientRect=()=>({left:0,top:0,width:1000,height:800} as DOMRect);
  Object.defineProperty(root,'clientWidth',{value:1000});let height=10000;Object.defineProperty(page,'offsetHeight',{get:()=>height});
  Object.defineProperty(page,'currentCSSZoom',{get:()=>Number(page.style.zoom)||1});
  applyDocumentZoom(root,175,80);settleDocumentZoom(root);root.scrollTop=700;
  height=12000;expect(refreshDocumentExtent(root)).toBe(true);
  expect(root.scrollTop).toBe(700);expect(page.style.zoom).toBe('1.75');expect(page.dataset.selectionScale).toBe('1.75');expect(space.style.height).toBe('21000px');
});
it('legacy zoom geometry keeps transformed visual and native hit-test coordinates aligned',()=>{
  const root=document.createElement('section'),space=document.createElement('div'),page=document.createElement('div');page.className='document-page';root.append(space);space.append(page);
  page.getBoundingClientRect=()=>({left:0,top:0} as DOMRect);root.getBoundingClientRect=()=>({left:0,top:0,width:1000,height:800} as DOMRect);
  Object.defineProperty(root,'clientWidth',{value:1000});Object.defineProperty(page,'offsetHeight',{value:10000});
  applyDocumentZoom(root,175,80);root.scrollTop=500;settleDocumentZoom(root);
  expect(page.style.zoom).toBe('1');expect(page.style.transform).toBe('translateX(250px) scale(1.75)');expect(page.dataset.selectionModel).toBe('transform');expect(root.scrollTop).toBe(500);
  refreshDocumentExtent(root);expect(page.dataset.selectionScale).toBe('1.75');expect(root.scrollTop).toBe(500);
});
