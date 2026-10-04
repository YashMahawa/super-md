import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from "react";
import { compileMathExpression } from "../mathExpression";
import { parseChartSpec, lineSegments, safeCurve, chartFeatures, seriesLabel, type ChartFeature, type Curve, type Sample } from "../chartModel";
import { chartValues, chartGrids, remember } from "../renderedOutputs";
import { useChartZoom } from "../useChartZoom";
import { axisNumber, axisTicks } from "../focalZoom";
import GraphProbe, { type Probe } from "./GraphProbe";

const palette = ["#6750a4", "#006a6a", "#b3261e", "#7d5700", "#3f6374"];
const darkPalette = ["#d0bcff", "#72d6d6", "#ffb4ab", "#efd18a", "#a1cce0"];
const featureNames: Record<ChartFeature["kind"], string> = {root:"Root", maximum:"Maximum", minimum:"Minimum", intersection:"Intersection"};

export default function InteractiveChart({source,dark=false}:{source:string;dark?:boolean}) {
  const clipId = useId().replace(/:/g,"_");
  const plot = useChartZoom(source);
  const parsed = useMemo(()=>{try{return {spec:parseChartSpec(source),error:""};}catch(error){return {spec:null,error:String(error)};}},[source]);
  const initial = ()=>chartValues.get(source)||Object.fromEntries((parsed.spec?.sliders||[]).map(slider=>[slider.name,slider.value]));
  const [values,setValues] = useState<Record<string,number>>(initial);
  const [grid,setGrid] = useState(()=>chartGrids.get(source)??true);
  const svgRef=useRef<SVGSVGElement>(null);
  const [viewport,setViewport] = useState(760);
  useEffect(()=>{
    const svg=plot.host.current?.querySelector("svg");if(!svg || typeof ResizeObserver==="undefined")return;
    const observer=new ResizeObserver(entries=>{const next=Math.round(entries[0].contentRect.width);if(next>0)setViewport(next);});
    observer.observe(svg);return()=>observer.disconnect();
  },[source,parsed.spec?.mode]);
  useEffect(()=>setValues(initial()),[source]);
  const effectiveValues = useMemo(()=>Object.fromEntries((parsed.spec?.sliders||[]).map(slider=>[slider.name,Math.max(slider.min,Math.min(slider.max,Number.isFinite(values[slider.name])?values[slider.name]:slider.value))])),[parsed,values]);
  const compiled = useMemo(()=>(parsed.spec?.series||[]).map(series=>{try{return series.expression?compileMathExpression(series.expression):null;}catch{return null;}}),[parsed]);
  const curves = useMemo<Array<Curve|null>>(()=>compiled.map(evaluate=>safeCurve(evaluate,effectiveValues)),[compiled,effectiveValues]);
  const rawSeries = useMemo(()=>{
    const spec=parsed.spec;if(!spec) return [];
    const low=spec.x?.min??(spec.x?.max!==undefined?spec.x.max-20:-10),high=spec.x?.max??low+20,steps=spec.x?.steps??160;
    return spec.series.map((series,index)=>series.points||Array.from({length:steps+1},(_,i)=>{
      const x=low+i*(high-low)/steps;
      return [x,curves[index]?.(x)??Number.NaN] as Sample;
    }));
  },[parsed,curves]);
  const spec=parsed.spec;
  const geometry = useMemo(()=>{
    if(!spec)return null;
    const baseMin=spec.x?.min??(spec.x?.max!==undefined?spec.x.max-20:-10),baseMax=spec.x?.max??baseMin+20;
    const xMid=(baseMin+baseMax)/2+plot.center.x*(baseMax-baseMin),xHalf=(baseMax-baseMin)/(2*plot.zoom),xMin=xMid-xHalf,xMax=xMid+xHalf;
    const allY=rawSeries.flat().map(point=>point[1]).filter(Number.isFinite);
    let low=Infinity,high=-Infinity;for(const y of allY){if(y<low)low=y;if(y>high)high=y;}
    const baseYMin=spec.y?.min??(allY.length?Math.min(low,-1):-1);
    const upper=spec.y?.max??(allY.length?Math.max(high,1):1),baseYMax=upper>baseYMin?upper:baseYMin+2;
    const yMid=(baseYMin+baseYMax)/2+plot.center.y*(baseYMax-baseYMin),yHalf=(baseYMax-baseYMin)/(2*plot.zoom),yMin=yMid-yHalf,yMax=yMid+yHalf;
    // Expressions follow the visible domain. Explicit point sets remain finite data.
    const steps=Math.max(240,spec.x?.steps??160);
    const visibleSeries=spec.series.map((series,index)=>series.points || Array.from({length:steps+1},(_,i)=>{ const x=xMin+i*(xMax-xMin)/steps;return [x,curves[index]?.(x)??Number.NaN] as Sample; }));
    return {xMin,xMax,yMin,yMax,hasSamples:allY.length>0,visibleSeries};
  },[spec,rawSeries,curves,plot.zoom,plot.center]);
  const features = useMemo(()=>geometry&&spec?chartFeatures(geometry.visibleSeries,spec.series.map((series,index)=>series.points?null:curves[index]),geometry.yMax-geometry.yMin):[],[geometry,curves,spec]);
  if(!spec || !geometry) return <div className="render-error" role="status">Invalid smd-chart: {parsed.error}</div>;
  const {xMin,xMax,yMin,yMax,hasSamples,visibleSeries}=geometry;
  const colors=spec.series.map((series,i)=>series.color||(dark?darkPalette:palette)[i%palette.length]);
  const labels=spec.series.map(seriesLabel);
  // SVG units follow the displayed width so tick labels remain actual reading
  // size on phones. SSR/PDF preparation retains a deterministic 760px canvas.
  const width=Math.max(280,viewport),height=Math.max(240,Math.min(380,width*.52)),left=70,top=24,right=20,bottom=46;
  const plotWidth=width-left-right,plotHeight=height-top-bottom;
  const clamp=(value:number,low:number,high:number)=>Math.max(low,Math.min(high,value));
  const px=(x:number)=>clamp(left+(x-xMin)/(xMax-xMin)*plotWidth,-1e6,1e6);
  const py=(y:number)=>clamp(top+(1-(y-yMin)/(yMax-yMin))*plotHeight,-1e6,1e6);
  if(!(xMax>xMin) || !Number.isFinite(xMax-xMin) || !Number.isFinite(yMax-yMin)) return <div className="render-error">Chart limits are outside a usable numeric range. Specify finite axis limits.</div>;
  const axisY=clamp(py(0),top,height-bottom),axisX=clamp(px(0),left,width-right);
  // Name each curve where it leaves the plot, like a hand-labelled graph.
  const endLabels=spec.series.length>6?[]:visibleSeries.map((points,index)=>{
    for(let i=points.length-1;i>=0;i--){const [x,y]=points[i];if(Number.isFinite(y)&&x>=xMin&&x<=xMax&&y>=yMin&&y<=yMax)return {index,x:px(x),y:py(y)};}
    return null;
  }).filter((label):label is {index:number;x:number;y:number}=>!!label).sort((a,b)=>a.y-b.y);
  for(let i=1;i<endLabels.length;i++)endLabels[i].y=Math.max(endLabels[i].y,endLabels[i-1].y+18);
  for(const label of endLabels)label.y=clamp(label.y,top+18,height-bottom-4);
  const locate=(x:number,y:number,touch:boolean):Probe|null=>{
    if(!touch&&(x<left||x>width-right||y<top||y>height-bottom))return null;
    const dataX=xMin+(clamp(x,left,width-right)-left)/plotWidth*(xMax-xMin);
    let best:{series:number;x:number;y:number;distance:number}|null=null;
    spec.series.forEach((series,index)=>{
      if(series.points){for(const [sx,sy] of series.points){const distance=Math.hypot(px(sx)-x,py(sy)-y);if(!best||distance<best.distance)best={series:index,x:sx,y:sy,distance};}return;}
      const value=curves[index]?.(dataX);
      if(value===undefined||!Number.isFinite(value))return;
      const distance=Math.abs(py(value)-y);
      if(!best||distance<best.distance)best={series:index,x:dataX,y:value,distance};
    });
    // Lock onto roots, turning points and intersections near the pointer.
    let feature:ChartFeature|null=null,featureDistance=touch?44:20;
    for(const candidate of features){const distance=Math.hypot(px(candidate.x)-x,py(candidate.y)-y);if(distance<featureDistance){feature=candidate;featureDistance=distance;}}
    const guide={left:axisX,bottom:axisY};
    if(feature){
      const label=feature.kind==="intersection"?`${labels[feature.series]} and ${labels[feature.other!]}`:labels[feature.series];
      return {x:px(feature.x),y:py(feature.y),coordinates:[feature.x,feature.y],label,color:colors[feature.series],kind:featureNames[feature.kind],guide};
    }
    const found=best as {series:number;x:number;y:number;distance:number}|null;
    // A mouse far from every curve shows nothing, never an off-curve coordinate.
    if(!found||(!touch&&found.distance>36)||found.y<yMin||found.y>yMax)return null;
    return {x:px(found.x),y:py(found.y),coordinates:[found.x,found.y],label:labels[found.series],color:colors[found.series],guide};
  };
  const moved=plot.zoom!==1||plot.center.x!==0||plot.center.y!==0;
  return <figure ref={plot.host} className="interactive-chart" data-plot-zoom={plot.zoom} data-center-x={plot.center.x} data-center-y={plot.center.y}>
    {spec.title && <figcaption>{spec.title}</figcaption>}
    <div className="chart-toolbar">
      <div className="chart-legend" role="list" aria-label="Equations">{spec.series.map((series,index)=><span role="listitem" key={index} style={{"--series-color":colors[index]} as CSSProperties}><i aria-hidden="true"/>{labels[index]}{series.name&&series.expression?<small>y = {series.expression.replace(/\bMath\./g,"")}</small>:null}</span>)}</div>
      {/* Text-only buttons: the plot must stay the figure's only <svg>. */}
      <div className="chart-actions">
        {moved && <button type="button" onClick={plot.reset} title="Reset view">Reset view</button>}
        <button type="button" aria-pressed={grid} title="Grid" onClick={()=>{remember(chartGrids,source,!grid);setGrid(!grid);}}>Grid</button>
      </div>
    </div>
    <div data-independent-zoom onDoubleClick={moved?plot.reset:undefined}>
      <svg ref={svgRef} viewBox={`0 0 ${width} ${height}`} data-plot-left={left} role="img" aria-label={spec.title||`Graph of ${labels.join(", ")}`}>
        <defs><clipPath id={clipId}><rect x={left} y={top} width={plotWidth} height={plotHeight}/></clipPath></defs>
        {axisTicks(xMin,xMax,Math.max(2,Math.min(8,Math.floor(plotWidth/90)))).map(x=><g key={`x${x}`}>{grid && <line className="chart-grid" x1={px(x)} x2={px(x)} y1={top} y2={height-bottom}/>}<text className="chart-tick" x={px(x)} y={height-bottom+20} textAnchor="middle">{axisNumber(x)}</text></g>)}
        {axisTicks(yMin,yMax,4).map(y=><g key={`y${y}`}>{grid && <line className="chart-grid" x1={left} x2={width-right} y1={py(y)} y2={py(y)}/>}<text className="chart-tick" x={left-10} y={py(y)+4} textAnchor="end">{axisNumber(y)}</text></g>)}
        <line className="chart-axis" x1={left} x2={width-right} y1={axisY} y2={axisY}/>
        <line className="chart-axis" x1={axisX} x2={axisX} y1={top} y2={height-bottom}/>
        <text className="chart-axis-label" x={width-right} y={height-8} textAnchor="end">{spec.x?.label||"x"}</text><text className="chart-axis-label" x={left} y={16}>{spec.y?.label||"y"}</text>
        <g clipPath={`url(#${clipId})`}>{visibleSeries.flatMap((points,index)=>lineSegments(points,yMax-yMin).map((segment,j)=><polyline key={`${index}-${j}`} className="chart-line" fill="none" stroke={colors[index]} strokeWidth="2.75" strokeLinejoin="round" strokeLinecap="round" points={segment.map(([x,y])=>`${px(x).toFixed(2)},${py(y).toFixed(2)}`).join(" ")}/>) )}</g>
        {endLabels.map(label=><text key={`label${label.index}`} className="chart-curve-label" x={Math.min(label.x,width-right)-6} y={label.y-8} textAnchor="end" fill={colors[label.index]} style={{fill:colors[label.index]}}>{labels[label.index]}</text>)}
        <GraphProbe svg={svgRef} locate={locate}/>
      </svg></div>
      {!hasSamples && <div className="chart-warning" role="status">No finite samples. Check the expression and variable names.</div>}
    {!!spec.sliders?.length && <div className="chart-controls">{spec.sliders.map(slider=>{const value=effectiveValues[slider.name];return <label key={slider.name}>
      <span className="chart-slider-head"><span>{slider.label||slider.name}</span><output>{Number(value.toPrecision(5))}</output></span>
      <input type="range" min={slider.min} max={slider.max} step={slider.step??(slider.max-slider.min)/100} value={value} aria-valuetext={`${slider.label||slider.name} = ${Number(value.toPrecision(5))}`} style={{"--chart-progress":`${100*(value-slider.min)/(slider.max-slider.min)}%`} as CSSProperties} onChange={event=>setValues(current=>{const next={...current,[slider.name]:Number(event.target.value)};remember(chartValues,source,next);return next;})}/>
      <span className="chart-slider-range" aria-hidden="true"><span>{axisNumber(slider.min)}</span><span>{axisNumber(slider.max)}</span></span>
    </label>;})}</div>}
  </figure>;
}
