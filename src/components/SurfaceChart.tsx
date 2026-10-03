import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ChartSpec } from "../types";
import { compileMathExpression } from "../mathExpression";
import { chartViews, remember } from "../renderedOutputs";
import { type Point as Focus } from "../focalZoom";
import GraphProbe from "./GraphProbe";
type Point = [number,number,number];
type View = {azimuth:number;elevation:number};
export default function SurfaceChart({source,spec,values,colors,zoom=1,center={x:0,y:0},grid=true}:{source:string;spec:ChartSpec;values:Record<string,number>;colors:string[];zoom?:number;center?:Focus;grid?:boolean}) {
  const clipId = `surface-${useId().replace(/:/g, "")}`;
  const [view,setView] = useState<View>(()=>chartViews.get(source)||{azimuth:35,elevation:28});
  const viewRef = useRef(view); viewRef.current = view;
  const svgRef=useRef<SVGSVGElement>(null);
  const drag = useRef<{id:number;x:number;y:number;view:View}|null>(null);
  const frame = useRef(0), pendingView = useRef<View|null>(null);
  useEffect(()=>()=>cancelAnimationFrame(frame.current),[]);
  const x0=spec.x?.min??(spec.x?.max!==undefined?spec.x.max-8:-4),x1=spec.x?.max??x0+8;
  const y0=spec.y?.min??(spec.y?.max!==undefined?spec.y.max-8:-4),y1=spec.y?.max??y0+8;
  const steps = Math.max(8,Math.min(32,spec.x?.steps??20));
  const baseline = useMemo(()=>spec.series.map(series=>{
    const evaluate = compileMathExpression(series.expression!);
    return Array.from({length:steps+1},(_,row)=>Array.from({length:steps+1},(_,column)=>{
      const x=x0+column*(x1-x0)/steps, y=y0+row*(y1-y0)/steps;
      return [x,y,evaluate({...values,x,y})] as Point;
    }));
  }),[spec,values,x0,x1,y0,y1,steps]);
  const heights = useMemo(()=>baseline.flat(2).map(point=>point[2]).filter(Number.isFinite),[baseline]);
  const z0 = spec.z?.min??(heights.length?Math.min(...heights):0);
  const upper = spec.z?.max??(heights.length?Math.max(...heights):1), z1=upper>z0?upper:z0+Math.max(1,Math.abs(z0)*.1);
  // Resample expressions in the visible world domain, rather than magnifying a
  // fixed, clipped mesh. Preserve the original vertical scale while orbiting.
  const grids = useMemo(()=>{
    const a=view.azimuth*Math.PI/180,e=view.elevation*Math.PI/180;
    const horizontal=center.x*760/180,depth=-center.y*440/(115*Math.max(.1,Math.sin(e)));
    const cx=(x0+x1)/2+(horizontal*Math.cos(a)+depth*Math.sin(a))*(x1-x0)/2;
    const cy=(y0+y1)/2+(-horizontal*Math.sin(a)+depth*Math.cos(a))*(y1-y0)/2;
    const extent=Math.max(.1,1/zoom)*1.5;
    return spec.series.map(series=>{
      const evaluate=compileMathExpression(series.expression!);
      return Array.from({length:steps+1},(_,row)=>Array.from({length:steps+1},(_,column)=>{
        const x=cx+(column/steps-.5)*(x1-x0)*extent,y=cy+(row/steps-.5)*(y1-y0)*extent;
        return [x,y,evaluate({...values,x,y})] as Point;
      }));
    });
  },[spec,values,x0,x1,y0,y1,steps,zoom,center.x,center.y,view.azimuth,view.elevation]);
  const project = ([x,y,z]:Point) => {
    const a=view.azimuth*Math.PI/180,e=view.elevation*Math.PI/180;
    const nx=2*(x-x0)/(x1-x0)-1,ny=2*(y-y0)/(y1-y0)-1,nz=2*(z-z0)/(z1-z0)-1;
    const horizontal=nx*Math.cos(a)-ny*Math.sin(a),depth=nx*Math.sin(a)+ny*Math.cos(a);
    const clamp=(v:number)=>Math.max(-1e6,Math.min(1e6,v));
    return [clamp(380+horizontal*180*zoom-center.x*760*zoom),clamp(220+(depth*Math.sin(e)-nz*Math.cos(e))*115*zoom+center.y*440*zoom)];
  };
  const path = (points:Point[])=>{
    let pen=false;
    return points.map(point=>{
      if(!point.every(Number.isFinite)) {pen=false;return "";}
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
  const mesh = useMemo(()=><>{grid && Array.from({length:9},(_,i)=>{const x=x0+i*(x1-x0)/8,y=y0+i*(y1-y0)/8;return <g key={`grid${i}`} className="chart-grid"><path fill="none" d={path([[x,y0,z0],[x,y1,z0]])}/><path fill="none" d={path([[x0,y,z0],[x1,y,z0]])}/></g>;})}{grids.map((surface,index)=><g key={index} stroke={colors[index]} fill="none" strokeWidth={grid?"1.4":".65"} strokeOpacity={grid?1:.5} strokeLinejoin="round">{surface.slice(0,-1).flatMap((row,r)=>row.slice(0,-1).map((_,c)=>{const cell=[surface[r][c],surface[r][c+1],surface[r+1][c+1],surface[r+1][c]];return cell.every(p=>p.every(Number.isFinite))?<polygon key={`p${r}-${c}`} points={cell.map(p=>project(p).map(v=>v.toFixed(2)).join(",")).join(" ")} fill={colors[index]} fillOpacity=".08" stroke="none"/>:null;}))}{surface.map((row,i)=><path key={`r${i}`} d={path(row)}/>)}{surface[0].map((_,column)=><path key={`c${column}`} d={path(surface.map(row=>row[column]))}/>)}</g>)}</>,[grids,grid,colors.join(","),view.azimuth,view.elevation,zoom,center.x,center.y,z0,z1]);
  if(!heights.length) return <div className="chart-warning">No finite surface samples. Check the expression and slider variable names.</div>;
  if(!(x1>x0) || !(y1>y0) || !(z1>z0) || !Number.isFinite(z1-z0)) return <div className="chart-warning">Surface limits are outside a usable numeric range. Specify finite axis limits.</div>;
  return <>
    <svg ref={svgRef} data-independent-zoom data-azimuth={view.azimuth} data-elevation={view.elevation} viewBox="0 0 760 440" className="surface-chart" role="img" tabIndex={0} aria-label={`${spec.title||"Interactive 3D surface"}. Mouse-drag to rotate. Two-finger move pans, pinch zooms. Arrow keys rotate.`} style={{touchAction:"pan-y"}}
      onKeyDown={event=>{if(["ArrowLeft","ArrowRight","ArrowUp","ArrowDown"].includes(event.key)){event.preventDefault();change({azimuth:view.azimuth+(event.key==="ArrowLeft"?-5:event.key==="ArrowRight"?5:0),elevation:Math.max(5,Math.min(85,view.elevation+(event.key==="ArrowUp"?5:event.key==="ArrowDown"?-5:0)))});}}}
      onPointerDown={event=>{if(event.pointerType!=="mouse" || event.button!==0) return;event.currentTarget.setPointerCapture(event.pointerId);drag.current={id:event.pointerId,x:event.clientX,y:event.clientY,view:viewRef.current};}}
      onPointerMove={event=>{const start=drag.current;if(!start || start.id!==event.pointerId || event.currentTarget.closest('[data-chart-pinching]'))return;pendingView.current={azimuth:start.view.azimuth+(event.clientX-start.x)*.4,elevation:Math.max(5,Math.min(85,start.view.elevation-(event.clientY-start.y)*.3))};if(!frame.current) frame.current=requestAnimationFrame(()=>{frame.current=0;if(pendingView.current) {change(pendingView.current);pendingView.current=null;}});}}
      onPointerUp={finishDrag} onPointerCancel={finishDrag}>
      <defs><clipPath id={clipId}><rect width="760" height="440"/></clipPath></defs>
      <g clipPath={`url(#${clipId})`}>
        {mesh}
        {axis([x0,y0,z0],[x1,y0,z0],spec.x?.label||"x")}
        {axis([x0,y0,z0],[x0,y1,z0],spec.y?.label||"y")}
        {axis([x0,y0,z0],[x0,y0,z1],spec.z?.label||"z")}
      </g>
      <GraphProbe svg={svgRef} locate={(x,y)=>{let best:Point|null=null,closest=30;for(const surface of grids)for(const row of surface)for(const p of row){if(!p.every(Number.isFinite))continue;const [px,py]=project(p),distance=Math.hypot(px-x,py-y);if(distance<closest){closest=distance;best=p;}}if(!best)return null;const [px,py]=project(best);return {x:px,y:py,coordinates:best};}}/>
    </svg>
  </>;
}
