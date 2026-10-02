import { useEffect, useId, useMemo, useState, type CSSProperties } from "react";
import { compileMathExpression } from "../mathExpression";
import { parseChartSpec, lineSegments } from "../chartModel";
import { chartValues, chartGrids, remember } from "../renderedOutputs";
import SurfaceChart from "./SurfaceChart";
import { useChartZoom } from "../useChartZoom";
import { axisNumber, axisTicks } from "../focalZoom";

const palette = ["#6750a4", "#006a6a", "#b3261e", "#7d5700", "#3f6374"];
const darkPalette = ["#d0bcff", "#72d6d6", "#ffb4ab", "#efd18a", "#a1cce0"];

export default function InteractiveChart({source,dark=false}:{source:string;dark?:boolean}) {
  const clipId = useId().replace(/:/g,"_");
  const plot = useChartZoom(source);
  const parsed = useMemo(()=>{try{return {spec:parseChartSpec(source),error:""};}catch(error){return {spec:null,error:String(error)};}},[source]);
  const initial = ()=>chartValues.get(source)||Object.fromEntries((parsed.spec?.sliders||[]).map(slider=>[slider.name,slider.value]));
  const [values,setValues] = useState<Record<string,number>>(initial);
  const [grid,setGrid] = useState(()=>chartGrids.get(source)??true);
  const [point,setPoint] = useState<{x:number;y:number}|null>(null);
  const [viewport,setViewport] = useState(760);
  useEffect(()=>{
    const svg=plot.host.current?.querySelector("svg");if(!svg || typeof ResizeObserver==="undefined")return;
    const observer=new ResizeObserver(entries=>{const next=Math.round(entries[0].contentRect.width);if(next>0)setViewport(next);});
    observer.observe(svg);return()=>observer.disconnect();
  },[source,parsed.spec?.mode]);
  useEffect(()=>setValues(initial()),[source]);
  const effectiveValues = useMemo(()=>Object.fromEntries((parsed.spec?.sliders||[]).map(slider=>[slider.name,Math.max(slider.min,Math.min(slider.max,Number.isFinite(values[slider.name])?values[slider.name]:slider.value))])),[parsed,values]);
  const compiled = useMemo(()=>(parsed.spec?.series||[]).map(series=>series.expression?compileMathExpression(series.expression):null),[parsed]);
  const rawSeries = useMemo(()=>{
    const spec=parsed.spec;if(!spec || spec.mode==="surface3d") return [];
    const low=spec.x?.min??(spec.x?.max!==undefined?spec.x.max-20:-10),high=spec.x?.max??low+20,steps=spec.x?.steps??160;
    return spec.series.map((series,index)=>series.points||Array.from({length:steps+1},(_,i)=>{
      const x=low+i*(high-low)/steps;
      return [x,compiled[index]!({...effectiveValues,x})] as [number,number];
    }));
  },[parsed,effectiveValues,compiled]);
  const spec=parsed.spec;
  const geometry = useMemo(()=>{
  if(!spec)return null;
  const baseMin=spec.x?.min??(spec.x?.max!==undefined?spec.x.max-20:-10),baseMax=spec.x?.max??baseMin+20;
  const xMid=(baseMin+baseMax)/2+plot.center.x*(baseMax-baseMin),xHalf=(baseMax-baseMin)/(2*plot.zoom),xMin=xMid-xHalf,xMax=xMid+xHalf;
  const allY=rawSeries.flat().map(point=>point[1]).filter(Number.isFinite);
  const baseYMin=spec.y?.min??(allY.length?Math.min(...allY,-1):-1);
  const upper=spec.y?.max??(allY.length?Math.max(...allY,1):1),baseYMax=upper>baseYMin?upper:baseYMin+2;
  const yMid=(baseYMin+baseYMax)/2+plot.center.y*(baseYMax-baseYMin),yHalf=(baseYMax-baseYMin)/(2*plot.zoom),yMin=yMid-yHalf,yMax=yMid+yHalf;
  // Expressions follow the visible domain. Explicit point sets remain finite data.
  const visibleSeries=spec.mode==="surface3d" ? [] : spec.series.map((series,index)=>series.points || Array.from({length:Math.max(240,spec.x?.steps??160)+1},(_,i)=>{ const x=xMin+i*(xMax-xMin)/Math.max(240,spec.x?.steps??160);return [x,compiled[index]!({...effectiveValues,x})] as [number,number]; }));
  return {xMin,xMax,yMin,yMax,allY,visibleSeries};
  },[spec,rawSeries,compiled,effectiveValues,plot.zoom,plot.center]);
  if(!spec || !geometry) return <div className="render-error" role="status">Invalid smd-chart: {parsed.error}</div>;
  const {xMin,xMax,yMin,yMax,allY,visibleSeries}=geometry;
  const colors=spec.series.map((series,i)=>series.color||(dark?darkPalette:palette)[i%palette.length]);
  // SVG units follow the displayed width so tick labels remain actual reading
  // size on phones. SSR/PDF preparation retains a deterministic 760px canvas.
  const width=Math.max(280,viewport),height=Math.max(240,Math.min(360,width*.5)),left=70,top=24,right=20,bottom=46;
  const clamp=(value:number,low:number,high:number)=>Math.max(low,Math.min(high,value));
  const px=(x:number)=>clamp(left+(x-xMin)/(xMax-xMin)*(width-left-right),-1e6,1e6);
  const py=(y:number)=>clamp(top+(1-(y-yMin)/(yMax-yMin))*(height-top-bottom),-1e6,1e6);
  if(spec.mode!=="surface3d" && (!(xMax>xMin) || !Number.isFinite(xMax-xMin) || !Number.isFinite(yMax-yMin))) return <div className="render-error">Chart limits are outside a usable numeric range. Specify finite axis limits.</div>;
  return <figure ref={plot.host} className="interactive-chart" data-independent-zoom data-plot-zoom={plot.zoom} style={{"--surface-label-size":`${Math.min(36,13*760/Math.max(280,viewport))}px`} as CSSProperties}>
    {spec.title && <figcaption>{spec.title}</figcaption>}
    <div className="chart-toolbar"><button aria-pressed={grid} onClick={()=>{remember(chartGrids,source,!grid);setGrid(!grid);}}>Grid</button><output className="chart-coordinate" aria-live="off">{spec.mode!=="surface3d" && point ? `(${axisNumber(point.x)}, ${axisNumber(point.y)})` : ""}</output></div>
    {spec.mode==="surface3d" ? <SurfaceChart key={source} source={source} spec={spec} values={effectiveValues} colors={colors} zoom={plot.zoom} center={plot.center} grid={grid}/> : <>
      <svg viewBox={`0 0 ${width} ${height}`} data-plot-left={left} role="img" aria-label={spec.title||"Interactive graph"} onPointerMove={event=>{ const rect=event.currentTarget.getBoundingClientRect(), x=(event.clientX-rect.left)/rect.width*width,y=(event.clientY-rect.top)/rect.height*height;if(x>=left && x<=width-right && y>=top && y<=height-bottom) setPoint({x:xMin+(x-left)/(width-left-right)*(xMax-xMin),y:yMax-(y-top)/(height-top-bottom)*(yMax-yMin)});else setPoint(null); }} onPointerLeave={event=>{if(event.pointerType==="mouse")setPoint(null);}} onPointerDown={event=>{const rect=event.currentTarget.getBoundingClientRect();const x=(event.clientX-rect.left)/rect.width*width,y=(event.clientY-rect.top)/rect.height*height;if(x>=left && x<=width-right && y>=top && y<=height-bottom)setPoint({x:xMin+(x-left)/(width-left-right)*(xMax-xMin),y:yMax-(y-top)/(height-top-bottom)*(yMax-yMin)});}}>
        <defs><clipPath id={clipId}><rect x={left} y={top} width={width-left-right} height={height-top-bottom}/></clipPath></defs>
        <line className="chart-axis" x1={left} x2={width-right} y1={clamp(py(0),top,height-bottom)} y2={clamp(py(0),top,height-bottom)}/>
        <line className="chart-axis" x1={clamp(px(0),left,width-right)} x2={clamp(px(0),left,width-right)} y1={top} y2={height-bottom}/>
        {axisTicks(xMin,xMax,Math.max(2,Math.min(8,Math.floor((width-left-right)/90)))).map(x=><g key={`x${x}`}>{grid && <line className="chart-grid" x1={px(x)} x2={px(x)} y1={top} y2={height-bottom}/>}<text x={px(x)} y={height-bottom+20} textAnchor="middle">{axisNumber(x)}</text></g>)}
        {axisTicks(yMin,yMax,4).map(y=><g key={`y${y}`}>{grid && <line className="chart-grid" x1={left} x2={width-right} y1={py(y)} y2={py(y)}/>}<text x={left-10} y={py(y)+4} textAnchor="end">{axisNumber(y)}</text></g>)}
        <text x={width-right} y={height-8} textAnchor="end">{spec.x?.label||"x"}</text><text x={left} y={16}>{spec.y?.label||"y"}</text>
        <g clipPath={`url(#${clipId})`}>{visibleSeries.flatMap((points,index)=>lineSegments(points,yMax-yMin).map((segment,j)=><polyline key={`${index}-${j}`} fill="none" stroke={colors[index]} strokeWidth="2.5" points={segment.map(([x,y])=>`${px(x).toFixed(2)},${py(y).toFixed(2)}`).join(" ")}/>) )}{point && <circle cx={px(point.x)} cy={py(point.y)} r={4} fill="var(--primary)"/>}</g>
      </svg>
      {!allY.length && <div className="chart-warning" role="status">No finite samples. Check the expression and variable names.</div>}
    </>}
    <div className="chart-controls">{(spec.sliders||[]).map(slider=><label key={slider.name}><span>{slider.label||slider.name}: <strong>{Number(effectiveValues[slider.name].toPrecision(5))}</strong></span><input type="range" min={slider.min} max={slider.max} step={slider.step??(slider.max-slider.min)/100} value={effectiveValues[slider.name]} style={{"--chart-progress":`${100*(effectiveValues[slider.name]-slider.min)/(slider.max-slider.min)}%`} as CSSProperties} onChange={event=>setValues(current=>{const next={...current,[slider.name]:Number(event.target.value)};remember(chartValues,source,next);return next;})}/></label>)}</div>
    <div className="chart-legend">{spec.series.map((series,index)=><span key={index}><i aria-hidden="true" style={{color:colors[index]}}/> {series.name||series.expression||`Series ${index+1}`}</span>)}</div>
  </figure>;
}
