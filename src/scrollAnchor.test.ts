// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {captureScrollAnchor,markScrollInput} from './scrollAnchor';
const originalCaret=Object.getOwnPropertyDescriptor(document,'caretRangeFromPoint');
afterEach(()=>{vi.restoreAllMocks();document.body.replaceChildren();if(originalCaret)Object.defineProperty(document,'caretRangeFromPoint',originalCaret);else Reflect.deleteProperty(document,'caretRangeFromPoint');});
it('does not restore an old anchor over newer native or browser scroll input',()=>{
  const root=document.createElement('div');document.body.append(root);root.scrollTop=200;
  const restore=captureScrollAnchor(root);markScrollInput();root.scrollTop=450;restore();expect(root.scrollTop).toBe(450);
  const next=captureScrollAnchor(root);document.dispatchEvent(new WheelEvent('wheel'));root.scrollTop=600;next();expect(root.scrollTop).toBe(600);root.remove();
});
it('does not mistake a live Range retargeted from removed loading text for its original anchor',()=>{
  const root=document.createElement('div'),block=document.createElement('section'),label=document.createElement('span');
  block.dataset.windowedBlock='';label.textContent='Loading image';block.append(label);root.append(block);document.body.append(root);root.scrollTop=700;
  const text=label.firstChild!,range=document.createRange();range.setStart(text,0);range.setEnd(text,1);
  vi.spyOn(range,'cloneRange').mockReturnValue(range);
  Object.defineProperty(range,'getBoundingClientRect',{value:()=>({top:range.startContainer===text?180:0,height:range.startContainer===text?16:0,left:0})});
  Object.defineProperty(document,'caretRangeFromPoint',{configurable:true,value:()=>range});
  vi.spyOn(root,'getBoundingClientRect').mockReturnValue({top:0,left:0,width:800,height:600} as DOMRect);
  vi.spyOn(block,'getBoundingClientRect').mockReturnValue({top:140,height:400} as DOMRect);
  const restore=captureScrollAnchor(root);text.remove();
  expect(range.startContainer).toBe(label);expect(range.startContainer.isConnected).toBe(true);expect(text.isConnected).toBe(false);
  restore();expect(root.scrollTop).toBe(700);
});
