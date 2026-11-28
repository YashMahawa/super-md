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

it('commits pinch midpoint pans before a subsequent native wheel pan without an intervening frame',()=>{
  const source='pinch-then-native-wheel-regression';chartCenters.delete(source);chartZooms.delete(source);
  const frames=new Map<number,FrameRequestCallback>();let id=0;
  vi.stubGlobal('requestAnimationFrame',(callback:FrameRequestCallback)=>{frames.set(++id,callback);return id;});
  vi.stubGlobal('cancelAnimationFrame',(key:number)=>frames.delete(key));
  const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
  const flushFrames=()=>{for(const [key,callback] of Array.from(frames.entries())){frames.delete(key);callback(16);}};
  const touch=(type:string,points:Array<{clientX:number;clientY:number}>)=>
    Object.assign(new Event(type,{bubbles:true,cancelable:true}),{touches:points});
  function Plot(){
    const plot=useChartZoom(source);
    return <figure ref={plot.host} data-zoom={plot.zoom} data-x={plot.center.x} data-y={plot.center.y}><svg data-plot-left="70"/></figure>;
  }
  try{
    act(()=>root.render(<Plot/>));
    const figure=host.querySelector('figure')!,svg=host.querySelector('svg')!;
    // Match the 1280x720 browser CI geometry (rectWidth 1089.1875, viewBox 1089 => data width w = 999.1720041322328).
    svg.getBoundingClientRect=()=>({left:0,top:0,width:1089.1875,height:380} as DOMRect);
    Object.defineProperty(svg,'viewBox',{value:{baseVal:{width:1089,height:380}}});

    // Prior horizontal drag (-60px screen movement => -60/w center shift), committed on its frame.
    act(()=>{svg.dispatchEvent(new CustomEvent('supermd-canvas-pan',{detail:{dx:-60,dy:0},cancelable:true}));flushFrames();});
    const prior=Number(figure.dataset.x);

    // Stage 1: Two-finger pan (+25px) followed by pinch-to-2x (+50px midpoint shift) and touchend, with NO rAF fired yet.
    const touches=(dx:number,span:number)=>[{clientX:70+dx,clientY:100},{clientX:70+dx+span,clientY:100}];
    act(()=>{
      svg.dispatchEvent(touch('touchstart',touches(0,100)));
      svg.dispatchEvent(touch('touchmove',touches(25,100)));
      svg.dispatchEvent(touch('touchmove',touches(25,200)));
      svg.dispatchEvent(touch('touchend',[]));
    });

    expect(frames.size).toBe(0);
    expect(Number(figure.dataset.zoom)).toBeCloseTo(2,8);
    const panBefore=Number(figure.dataset.x);
    expect(panBefore).toBeLessThan(prior);
    // Settled post-pinch center includes the -50/(2*w) midpoint shift (~ -0.32256611), not the half-committed ~ -0.29754539.
    expect(panBefore).toBeCloseTo(-0.3225661106105244,12);
    act(()=>flushFrames());
    expect(Number(figure.dataset.x)).toBe(panBefore);

    // Stage 2: Native wheel pan (supermdNativeWheel(30, 10, point, false) -> supermd-canvas-pan {dx:30, dy:10}).
    const panBeforeY=Number(figure.dataset.y);
    act(()=>{svg.dispatchEvent(new CustomEvent('supermd-canvas-pan',{detail:{dx:30,dy:10},cancelable:true}));});
    expect(frames.size).toBe(1);
    act(()=>flushFrames());
    expect(Number(figure.dataset.x)).toBeGreaterThan(panBefore);
    expect(Number(figure.dataset.x)).toBeCloseTo(-0.30755368038032865,12);
    expect(Number(figure.dataset.y)).toBeLessThan(panBeforeY);
    expect(Number(figure.dataset.zoom)).toBeCloseTo(2,8);
  }finally{
    act(()=>root.unmount());host.remove();vi.unstubAllGlobals();chartCenters.delete(source);chartZooms.delete(source);
  }
});

it('coalesces pure two-finger touch pans across frames and flushes on touchend',()=>{
  const source='two-finger-pan-flush';chartCenters.delete(source);chartZooms.delete(source);
  const frames=new Map<number,FrameRequestCallback>();let id=0;
  vi.stubGlobal('requestAnimationFrame',(callback:FrameRequestCallback)=>{frames.set(++id,callback);return id;});
  vi.stubGlobal('cancelAnimationFrame',(key:number)=>frames.delete(key));
  const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
  const touch=(type:string,points:Array<{clientX:number;clientY:number}>)=>
    Object.assign(new Event(type,{bubbles:true,cancelable:true}),{touches:points});
  function Plot(){
    const plot=useChartZoom(source);
    return <figure ref={plot.host} data-zoom={plot.zoom} data-x={plot.center.x} data-y={plot.center.y}><svg data-plot-left="70"/></figure>;
  }
  try{
    act(()=>root.render(<Plot/>));
    const figure=host.querySelector('figure')!,svg=host.querySelector('svg')!;
    svg.getBoundingClientRect=()=>({left:0,top:0,width:760,height:380} as DOMRect);
    Object.defineProperty(svg,'viewBox',{value:{baseVal:{width:760,height:380}}});
    act(()=>{
      svg.dispatchEvent(touch('touchstart',[{clientX:70,clientY:100},{clientX:170,clientY:100}]));
      svg.dispatchEvent(touch('touchmove',[{clientX:137,clientY:69},{clientX:237,clientY:69}]));
    });
    expect(frames.size).toBe(1);
    act(()=>{svg.dispatchEvent(touch('touchend',[]));});
    expect(frames.size).toBe(0);
    expect(Number(figure.dataset.x)).toBeCloseTo(-.1,8);
    expect(Number(figure.dataset.y)).toBeCloseTo(-.1,8);
    expect(Number(figure.dataset.zoom)).toBe(1);
  }finally{
    act(()=>root.unmount());host.remove();vi.unstubAllGlobals();chartCenters.delete(source);chartZooms.delete(source);
  }
});
