// @vitest-environment jsdom
import {act} from 'react';
import {createRoot} from 'react-dom/client';
import {expect,it,vi} from 'vitest';
import {useChartZoom} from './useChartZoom';
import {chartCenters,chartZooms} from './renderedOutputs';

Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});

it('keeps pending graph pans when a resize or palette render precedes the next frame',()=>{
  const source='pending-pan-regression';chartCenters.delete(source);chartZooms.delete(source);
  const frames=new Map<number,FrameRequestCallback>();let id=0;
  vi.stubGlobal('requestAnimationFrame',(callback:FrameRequestCallback)=>{frames.set(++id,callback);return id;});
  vi.stubGlobal('cancelAnimationFrame',(key:number)=>frames.delete(key));
  const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
  function Plot({revision}:{revision:number}){
    const plot=useChartZoom(source);
    return <figure ref={plot.host} data-revision={revision} data-x={plot.center.x} data-y={plot.center.y}><svg data-plot-left="70"/></figure>;
  }
  try{
    act(()=>root.render(<Plot revision={0}/>));
    const svg=host.querySelector('svg')!;
    svg.getBoundingClientRect=()=>({left:0,top:0,width:760,height:380} as DOMRect);
    Object.defineProperty(svg,'viewBox',{value:{baseVal:{width:760,height:380}}});
    act(()=>svg.dispatchEvent(new CustomEvent('supermd-canvas-pan',{detail:{dx:67,dy:31},cancelable:true})));
    expect(frames.size).toBe(1);
    act(()=>root.render(<Plot revision={1}/>));
    act(()=>{for(const [key,callback] of frames){frames.delete(key);callback(16);}});
    expect(Number(host.querySelector('figure')!.dataset.x)).toBeCloseTo(.1,8);
    expect(Number(host.querySelector('figure')!.dataset.y)).toBeCloseTo(-.1,8);
    expect(chartCenters.get(source)).toEqual({x:.1,y:-.1});
  }finally{
    act(()=>root.unmount());host.remove();vi.unstubAllGlobals();chartCenters.delete(source);chartZooms.delete(source);
  }
});
