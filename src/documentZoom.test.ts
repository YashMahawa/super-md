// @vitest-environment jsdom
import {expect,it,vi} from 'vitest';
import {applyDocumentZoom,invalidateDocumentZoom,settleDocumentZoom,refreshDocumentExtent} from './documentZoom';
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
  applyDocumentZoom(root,160,80);settleDocumentZoom(root);
  expect(page.style.zoom).toBe('1.6');expect(page.dataset.selectionScale).toBe('1.6');expect(page.style.transform).not.toContain('scale');
  applyDocumentZoom(root,180,80);expect(page.style.zoom).toBe('1');expect(page.dataset.selectionScale).toBeUndefined();expect(page.dataset.scale).toBe('1.8');
});
it('lazy content height updates never replay zoom or write the user scroll position',()=>{
  const root=document.createElement('section'),space=document.createElement('div'),page=document.createElement('div');page.className='document-page';root.append(space);space.append(page);
  page.getBoundingClientRect=()=>({left:0,top:0} as DOMRect);root.getBoundingClientRect=()=>({left:0,top:0,width:1000,height:800} as DOMRect);
  Object.defineProperty(root,'clientWidth',{value:1000});let height=10000;Object.defineProperty(page,'offsetHeight',{get:()=>height});
  applyDocumentZoom(root,175,80);settleDocumentZoom(root);root.scrollTop=700;
  height=12000;expect(refreshDocumentExtent(root)).toBe(true);
  expect(root.scrollTop).toBe(700);expect(page.style.zoom).toBe('1.75');expect(page.dataset.selectionScale).toBe('1.75');expect(space.style.height).toBe('21000px');
});
