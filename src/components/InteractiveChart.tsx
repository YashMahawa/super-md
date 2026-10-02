import { useEffect, useId, useMemo, useState, type CSSProperties } from "react";
import { compileMathExpression } from "../mathExpression";
import { parseChartSpec, lineSegments } from "../chartModel";
import { chartValues, remember } from "../renderedOutputs";
import SurfaceChart from "./SurfaceChart";

const palette = ["#6750a4", "#006a6a", "#b3261e", "#7d5700", "#3f6374"];
const darkPalette = ["#d0bcff", "#72d6d6", "#ffb4ab", "#efd18a", "#a1cce0"];

export default function InteractiveChart({source,dark=false}:{source:string;dark?:boolean}) {
  const clipId = useId().replace(/:/g,"_");
  const parsed = useMemo(()=>{try{return {spec:parseChartSpec(source),error:""};}catch(error){return {spec:null,error:String(error)};}},[source]);
  const initial = ()=>chartValues.get(source)||Object.fromEntries((parsed.spec?.sliders||[]).map(slider=>[slider.name,slider.value]));
  const [values,setValues] = useState<Record<string,number>>(initial);
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
  if(!parsed.spec) return <div className="render-error" role="status">Invalid smd-chart: {parsed.error}</div>;
  const spec=parsed.spec,colors=spec.series.map((series,i)=>series.color||(dark?darkPalette:palette)[i%palette.length]);
  const xMin=spec.x?.min??(spec.x?.max!==undefined?spec.x.max-20:-10),xMax=spec.x?.max??xMin+20;
  const allY=rawSeries.flat().map(point=>point[1]).filter(Number.isFinite);
  const yMin=spec.y?.min??(allY.length?Math.min(...allY,-1):-1);
  const upper=spec.y?.max??(allY.length?Math.max(...allY,1):1),yMax=upper>yMin?upper:yMin+2;
  const width=760,height=360,left=56,top=24,right=20,bottom=46;
  const clamp=(value:number,low:number,high:number)=>Math.max(low,Math.min(high,value));
  const px=(x:number)=>clamp(left+(x-xMin)/(xMax-xMin)*(width-left-right),-1e6,1e6);
  const py=(y:number)=>clamp(top+(1-(y-yMin)/(yMax-yMin))*(height-top-bottom),-1e6,1e6);
  if(spec.mode!=="surface3d" && (!(xMax>xMin) || !Number.isFinite(xMax-xMin) || !Number.isFinite(yMax-yMin))) return <div className="render-error">Chart limits are outside a usable numeric range. Specify finite axis limits.</div>;
  return <figure className="interactive-chart">
    {spec.title && <figcaption>{spec.title}</figcaption>}
    {spec.mode==="surface3d" ? <SurfaceChart key={source} source={source} spec={spec} values={effectiveValues} colors={colors}/> : <>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={spec.title||"Interactive graph"}>
        <defs><clipPath id={clipId}><rect x={left} y={top} width={width-left-right} height={height-top-bottom}/></clipPath></defs>
        <line className="chart-axis" x1={left} x2={width-right} y1={clamp(py(0),top,height-bottom)} y2={clamp(py(0),top,height-bottom)}/>
        <line className="chart-axis" x1={clamp(px(0),left,width-right)} x2={clamp(px(0),left,width-right)} y1={top} y2={height-bottom}/>
        <text x={left} y={height-12}>{spec.x?.label||`x: ${xMin} … ${xMax}`}</text><text x={8} y={18}>{spec.y?.label||`y: ${yMin.toPrecision(3)} … ${yMax.toPrecision(3)}`}</text>
        <g clipPath={`url(#${clipId})`}>{rawSeries.flatMap((points,index)=>lineSegments(points,yMax-yMin).map((segment,j)=><polyline key={`${index}-${j}`} fill="none" stroke={colors[index]} strokeWidth="3" points={segment.map(([x,y])=>`${px(x).toFixed(2)},${py(y).toFixed(2)}`).join(" ")}/>) )}</g>
      </svg>
      {!allY.length && <div className="chart-warning" role="status">No finite samples. Check the expression and variable names.</div>}
    </>}
    <div className="chart-controls">{(spec.sliders||[]).map(slider=><label key={slider.name}><span>{slider.label||slider.name}: <strong>{Number(effectiveValues[slider.name].toPrecision(5))}</strong></span><input type="range" min={slider.min} max={slider.max} step={slider.step??(slider.max-slider.min)/100} value={effectiveValues[slider.name]} style={{"--chart-progress":`${100*(effectiveValues[slider.name]-slider.min)/(slider.max-slider.min)}%`} as CSSProperties} onChange={event=>setValues(current=>{const next={...current,[slider.name]:Number(event.target.value)};remember(chartValues,source,next);return next;})}/></label>)}</div>
    <div className="chart-legend">{spec.series.map((series,index)=><span key={index}><i style={{color:colors[index]}}>●</i> {series.name||series.expression||`Series ${index+1}`}</span>)}</div>
  </figure>;
}
