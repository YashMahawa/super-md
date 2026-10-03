// @vitest-environment jsdom
import {expect,it,vi} from 'vitest';
import {applyDocumentZoom,invalidateDocumentZoom} from './documentZoom';
it('keeps zoom frames independent of document measurement after initial layout',()=>{
  const root=document.createElement('section'),space=document.createElement('div'),page=document.createElement('div');page.className='document-page';root.append(space);space.append(page);
  const pageBounds=vi.fn(()=>({left:0,top:0,width:800,height:100000} as DOMRect)),rootBounds=vi.fn(()=>({left:0,top:0,width:1000,height:800} as DOMRect));page.getBoundingClientRect=pageBounds;root.getBoundingClientRect=rootBounds;
  const height=vi.fn(()=>100000);Object.defineProperty(page,'offsetHeight',{get:height});Object.defineProperty(root,'clientWidth',{value:1000});
  applyDocumentZoom(root,100,80);const reads=height.mock.calls.length;
  for(let i=0;i<60;i++)applyDocumentZoom(root,100+i,80,{x:400,y:300});
  expect(pageBounds).toHaveBeenCalledTimes(1);expect(rootBounds).toHaveBeenCalledTimes(1);expect(height).toHaveBeenCalledTimes(reads);expect(page.dataset.scale).toBe('1.59');
  invalidateDocumentZoom(root);applyDocumentZoom(root,160,80);expect(pageBounds).toHaveBeenCalledTimes(2);
});
