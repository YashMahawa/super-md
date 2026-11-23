// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {FrameScrollQueue,zoomFrameStep} from './frameMotion';
afterEach(()=>document.body.replaceChildren());
it('uses elapsed time so 60, 120 and 240Hz have the same zoom easing duration',()=>{
  const values=[60,120,240].map(hz=>{let value=100;for(let i=0;i<hz/10;i++)value=zoomFrameStep(value,200,1000/hz);return value;});
  expect(values[0]).toBeCloseTo(values[1],8);expect(values[1]).toBeCloseTo(values[2],8);
  expect(zoomFrameStep(199.99,200,8)).toBe(200);
});
it('coalesces high-rate native input without dropping distance or running idle frames',()=>{
  const root=document.createElement('div');document.body.append(root);const frames:FrameRequestCallback[]=[];
  const request=vi.fn((cb:FrameRequestCallback)=>{frames.push(cb);return frames.length;}),apply=vi.fn();
  const queue=new FrameScrollQueue(apply,request,vi.fn());
  for(let i=0;i<240;i++)queue.scroll(root,.5,2);
  expect(request).toHaveBeenCalledTimes(1);frames[0](1000/60);
  expect(apply).toHaveBeenCalledExactlyOnceWith(root,120,480);expect(request).toHaveBeenCalledTimes(1);
  queue.scroll(root,0,10);expect(request).toHaveBeenCalledTimes(2);frames[1](1000/30);
  expect(apply).toHaveBeenLastCalledWith(root,0,10);
});
it('cancels queued movement on document changes and ignores removed scrollers',()=>{
  const root=document.createElement('div');document.body.append(root);const frames:FrameRequestCallback[]=[];
  const cancel=vi.fn(),apply=vi.fn();const queue=new FrameScrollQueue(apply,cb=>{frames.push(cb);return frames.length;},cancel);
  queue.scroll(root,0,30);queue.clear();expect(cancel).toHaveBeenCalledWith(1);frames[0](16);expect(apply).not.toHaveBeenCalled();
  queue.scroll(root,0,20);root.remove();frames[1](32);expect(apply).not.toHaveBeenCalled();
});
