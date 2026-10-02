import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ChartSpec } from "../types";
import { compileMathExpression } from "../mathExpression";
import { chartViews, remember } from "../renderedOutputs";
type Point = [number,number,number];
type View = {azimuth:number;elevation:number};
export default function SurfaceChart({source,spec,values,colors,zoom=1}:{source:string;spec:ChartSpec;values:Record<string,number>;colors:string[];zoom?:number}) {
  const clipId = `surface-${useId().replace(/:/g, "")}`;
  const [view,setView] = useState<View>(()=>chartViews.get(source)||{azimuth:35,elevation:28});
  const [rotating,setRotating] = useState(false);
  const viewRef = useRef(view); viewRef.current = view;
  const drag = useRef<{id:number;x:number;y:number;view:View}|null>(null);
  const frame = useRef(0), pendingView = useRef<View|null>(null);
  useEffect(()=>()=>cancelAnimationFrame(frame.current),[]);
  const x0=spec.x?.min??(spec.x?.max!==undefined?spec.x.max-8:-4),x1=spec.x?.max??x0+8;
  const y0=spec.y?.min??(spec.y?.max!==undefined?spec.y.max-8:-4),y1=spec.y?.max??y0+8;
  const steps = Math.max(8,Math.min(40,spec.x?.steps??20));
  const grids = useMemo(()=>spec.series.map(series=>{
    const evaluate = compileMathExpression(series.expression!);
    return Array.from({length:steps+1},(_,row)=>Array.from({length:steps+1},(_,column)=>{
      const x=x0+column*(x1-x0)/steps, y=y0+row*(y1-y0)/steps;
      return [x,y,evaluate({...values,x,y})] as Point;
    }));
  }),[spec,values,x0,x1,y0,y1,steps]);
  const heights = grids.flat(2).map(point=>point[2]).filter(Number.isFinite);
  const z0 = spec.z?.min??(heights.length?Math.min(...heights):0);
  const upper = spec.z?.max??(heights.length?Math.max(...heights):1), z1=upper>z0?upper:z0+Math.max(1,Math.abs(z0)*.1);
  const project = ([x,y,z]:Point) => {
    const a=view.azimuth*Math.PI/180,e=view.elevation*Math.PI/180;
    const nx=2*(x-x0)/(x1-x0)-1,ny=2*(y-y0)/(y1-y0)-1,nz=2*(z-z0)/(z1-z0)-1;
    const horizontal=nx*Math.cos(a)-ny*Math.sin(a),depth=nx*Math.sin(a)+ny*Math.cos(a);
    return [380+horizontal*180*zoom,230+(depth*Math.sin(e)-nz*Math.cos(e))*115*zoom];
  };
  const path = (points:Point[])=>{
    let pen=false;
    return points.map(point=>{
      if(!point.every(Number.isFinite) || point[2]<z0 || point[2]>z1) {pen=false;return "";}
      const [x,y]=project(point),command=pen?"L":"M";pen=true;
      return `${command}${x.toFixed(2)},${y.toFixed(2)}`;
    }).join(" ");
  };
  const axis = (from:Point,to:Point,label:string)=>{
    const [x1,y1]=project(from),[x2,y2]=project(to);
    return <g key={label}><line className="chart-axis" x1={x1} y1={y1} x2={x2} y2={y2}/><text x={x2+8} y={y2}>{label}</text></g>;
  };
  const change = (next:View)=>{viewRef.current=next;setView(next);remember(chartViews,source,next);};
  const finishDrag = ()=>{cancelAnimationFrame(frame.current);frame.current=0;if(pendingView.current) {change(pendingView.current);pendingView.current=null;}drag.current=null;};
  if(!heights.length) return <div className="chart-warning">No finite surface samples. Check the expression and slider variable names.</div>;
  if(!(x1>x0) || !(y1>y0) || !(z1>z0) || !Number.isFinite(z1-z0)) return <div className="chart-warning">Surface limits are outside a usable numeric range. Specify finite axis limits.</div>;
  return <>
    <svg viewBox="0 0 760 440" className="surface-chart" role="img" aria-label={spec.title||"Interactive 3D surface"} style={{touchAction:rotating?"none":"pan-y"}} data-independent-zoom={rotating?"true":undefined}
      onPointerDown={event=>{if(event.pointerType!=="mouse" && !rotating) return;event.currentTarget.setPointerCapture(event.pointerId);drag.current={id:event.pointerId,x:event.clientX,y:event.clientY,view:viewRef.current};}}
      onPointerMove={event=>{const start=drag.current;if(!start || start.id!==event.pointerId || event.currentTarget.closest('[data-chart-pinching]')) return;pendingView.current={azimuth:start.view.azimuth+(event.clientX-start.x)*.4,elevation:Math.max(5,Math.min(85,start.view.elevation-(event.clientY-start.y)*.3))};if(!frame.current) frame.current=requestAnimationFrame(()=>{frame.current=0;if(pendingView.current) {change(pendingView.current);pendingView.current=null;}});}}
      onPointerUp={finishDrag} onPointerCancel={finishDrag}>
      <defs><clipPath id={clipId}><rect width="760" height="440"/></clipPath></defs>
      <g clipPath={`url(#${clipId})`}>
        {grids.map((grid,index)=><g key={index} stroke={colors[index]} fill="none" strokeWidth="1.4" strokeLinejoin="round">{grid.map((row,i)=><path key={`r${i}`} d={path(row)}/>)}{grid[0].map((_,column)=><path key={`c${column}`} d={path(grid.map(row=>row[column]))}/>)}</g>)}
        {axis([x0,y0,z0],[x1,y0,z0],spec.x?.label||"x")}
        {axis([x0,y0,z0],[x0,y1,z0],spec.y?.label||"y")}
        {axis([x0,y0,z0],[x0,y0,z1],spec.z?.label||"z")}
      </g>
      <text x="18" y="420">z: {z0.toPrecision(3)} … {z1.toPrecision(3)}</text>
    </svg>
    <div className="chart-controls surface-controls"><label>Orbit: {Math.round(view.azimuth)}°<input aria-label="3D orbit" type="range" min={-180} max={180} value={((view.azimuth+540)%360)-180} onChange={event=>change({...view,azimuth:Number(event.target.value)})}/></label><label>Tilt: {Math.round(view.elevation)}°<input aria-label="3D tilt" type="range" min={5} max={85} value={view.elevation} onChange={event=>change({...view,elevation:Number(event.target.value)})}/></label></div>
    <div className="chart-view-actions"><button aria-pressed={rotating} onClick={()=>setRotating(!rotating)}>{rotating?"Done rotating":"Touch rotation"}</button><button onClick={()=>change({azimuth:35,elevation:28})}>Reset view</button><small>Drag with a mouse, use the sliders, or enable touch rotation. Otherwise swiping scrolls your note.</small></div>
  </>;
}
