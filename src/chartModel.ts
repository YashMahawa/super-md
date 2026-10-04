import type { ChartSpec } from "./types";
import { compileMathExpression } from "./mathExpression";

const finite = (value:unknown):value is number=>typeof value === "number" && Number.isFinite(value);
const object = (value:unknown):value is Record<string,unknown>=>value !== null && typeof value === "object" && !Array.isArray(value);
export function parseChartSpec(source:string):ChartSpec {
  if(source.length>500_000) throw new Error("Chart JSON exceeds 500 KB");
  const value:unknown = JSON.parse(source);
  if(!object(value)) throw new Error("Chart must be a JSON object");
  if(value.mode === "surface3d") throw new Error("Interactive 3D graphs are no longer supported. Use a Python/Matplotlib cell for 3D figures; the original source is unchanged.");
  if(value.mode !== undefined && value.mode !== "line") throw new Error("Chart mode must be line");
  if(value.title !== undefined && (typeof value.title !== "string" || value.title.length>500)) throw new Error("Chart title must be text (up to 500 characters)");
  if(!Array.isArray(value.series) || !value.series.length || value.series.length>16) throw new Error("Use 1–16 line series");
  for(const axisName of ["x","y"]) {
    const axis = value[axisName];
    if(axis === undefined) continue;
    if(!object(axis)) throw new Error(`${axisName} axis must be an object`);
    for(const key of ["min","max","steps"]) if(axis[key] !== undefined && !finite(axis[key])) throw new Error(`${axisName}.${key} must be finite`);
    if(finite(axis.min) && finite(axis.max) && (axis.max<=axis.min || !Number.isFinite(axis.max-axis.min))) throw new Error(`${axisName}.max must exceed min within a finite range`);
    if(axis.steps !== undefined && (!finite(axis.steps) || axis.steps<8 || axis.steps>1000 || !Number.isInteger(axis.steps))) throw new Error("Sampling steps must be an integer from 8 to 1000");
    if(axis.label !== undefined && (typeof axis.label !== "string" || axis.label.length>200)) throw new Error("Axis label must be short text");
  }
  for(const series of value.series) {
    if(!object(series)) throw new Error("Each series must be an object");
    if(series.name !== undefined && (typeof series.name !== "string" || series.name.length>300)) throw new Error("Series name must be short text");
    if(series.color !== undefined && (typeof series.color !== "string" || !/^#[\da-f]{6}$/i.test(series.color))) throw new Error("Series colors use #RRGGBB");
    if(series.points !== undefined) {
      if(!Array.isArray(series.points) || series.points.length>10000 || !series.points.every(point=>Array.isArray(point) && point.length===2 && point.every(finite))) throw new Error("Points must be finite [x,y] pairs (up to 10000 per series)");
    } else {
      if(typeof series.expression !== "string") throw new Error("Each series needs an expression or points");
      compileMathExpression(series.expression);
    }
  }
  if(value.sliders !== undefined && (!Array.isArray(value.sliders) || value.sliders.length>16)) throw new Error("Sliders must be an array (up to 16)");
  const names = new Set<string>();
  for(const slider of (value.sliders || []) as unknown[]) {
    if(!object(slider) || typeof slider.name !== "string" || !/^[A-Za-z_][\w]{0,39}$/.test(slider.name) || ["x","y","z","pi","e","__proto__","constructor","prototype"].includes(slider.name) || names.has(slider.name)) throw new Error("Slider names must be unique variable names, not reserved names");
    names.add(slider.name);
    if(!finite(slider.min) || !finite(slider.max) || slider.max<=slider.min || !Number.isFinite(slider.max-slider.min) || !finite(slider.value) || slider.value<slider.min || slider.value>slider.max) throw new Error("Slider min, max and value must form a finite valid range");
    if(slider.step !== undefined && (!finite(slider.step) || slider.step<=0)) throw new Error("Slider step must be positive");
    if(slider.label !== undefined && (typeof slider.label !== "string" || slider.label.length>200)) throw new Error("Slider label must be short text");
  }
  return value as unknown as ChartSpec;
}

export function lineSegments(points:Array<[number,number]>,span:number):Array<Array<[number,number]>> {
  const segments:Array<Array<[number,number]>> = [];
  let current:Array<[number,number]> = [];
  const end = ()=>{if(current.length>1) segments.push(current); current=[];};
  for(const point of points) {
    if(!point.every(Number.isFinite)) {end();continue;}
    if(current.length && Math.abs(point[1]-current.at(-1)![1])>span*4) end();
    current.push(point);
  }
  end(); return segments;
}

export type Sample = [number, number];
export type Curve = (x:number)=>number;
export type ChartFeature = {x:number;y:number;kind:"root"|"maximum"|"minimum"|"intersection";series:number;other?:number};

/** A throwing or non-finite evaluation is a gap in the curve, never a crash. */
export function safeCurve(evaluate:((scope:Record<string,number>)=>number)|null, scope:Record<string,number>):Curve|null {
  if(!evaluate)return null;
  return (x:number)=>{try{const y=evaluate({...scope,x});return typeof y==="number"&&Number.isFinite(y)?y:Number.NaN;}catch{return Number.NaN;}};
}

const bisect=(f:Curve,a:number,b:number)=>{
  let fa=f(a);
  for(let i=0;i<48;i++){const m=(a+b)/2,fm=f(m);if(!Number.isFinite(fm))return Number.NaN;if(fm===0)return m;if((fa<0)===(fm<0)){a=m;fa=fm;}else b=m;}
  return (a+b)/2;
};
const golden=(f:Curve,a:number,b:number,maximum:boolean)=>{
  const g=(Math.sqrt(5)-1)/2,score=(x:number)=>maximum?f(x):-f(x);
  let c=b-g*(b-a),d=a+g*(b-a);
  for(let i=0;i<40;i++){if(score(c)>score(d))b=d;else a=c;c=b-g*(b-a);d=a+g*(b-a);}
  return (a+b)/2;
};

/** Roots, turning points and intersections that a probe can lock onto (GeoGebra style). */
export function chartFeatures(samples:Sample[][], curves:Array<Curve|null>, span:number):ChartFeature[] {
  const features:ChartFeature[]=[];
  const jump=(a:number,b:number)=>Math.abs(a-b)>span*4;
  samples.forEach((points,series)=>{
    const f=curves[series];
    for(let i=1;i<points.length&&features.length<400;i++){
      const [x0,y0]=points[i-1],[x1,y1]=points[i];
      if(!Number.isFinite(y0)||!Number.isFinite(y1)||jump(y0,y1))continue;
      if(y0===0)features.push({x:x0,y:0,kind:"root",series});
      else if(y0<0!==y1<0&&y1!==0){const x=f?bisect(f,x0,x1):x0-y0*(x1-x0)/(y1-y0);if(Number.isFinite(x))features.push({x,y:0,kind:"root",series});}
      if(i+1<points.length&&f){
        const y2=points[i+1][1];
        if(!Number.isFinite(y2)||jump(y1,y2))continue;
        const maximum=y1>y0&&y1>=y2,minimum=y1<y0&&y1<=y2;
        if(maximum||minimum){const x=golden(f,x0,points[i+1][0],maximum),y=f(x);if(Number.isFinite(y))features.push({x,y,kind:maximum?"maximum":"minimum",series});}
      }
    }
  });
  for(let a=0;a<samples.length;a++)for(let b=a+1;b<samples.length;b++){
    const fa=curves[a],fb=curves[b];if(!fa||!fb)continue;
    const difference=(x:number)=>fa(x)-fb(x),points=samples[a];
    for(let i=1;i<points.length&&features.length<600;i++){
      const x0=points[i-1][0],x1=points[i][0],d0=difference(x0),d1=difference(x1);
      if(!Number.isFinite(d0)||!Number.isFinite(d1)||jump(d0,d1))continue;
      if(d0<0!==d1<0&&d1!==0){const x=bisect(difference,x0,x1),y=fa(x);if(Number.isFinite(y))features.push({x,y,kind:"intersection",series:a,other:b});}
    }
  }
  return features;
}

export function seriesLabel(series:{name?:string;expression?:string;points?:unknown}, index:number):string {
  if(series.name)return series.name;
  if(series.expression)return `y = ${series.expression.replace(/\bMath\./g,"").replace(/\*\*/g,"^").replace(/\s*\*\s*/g,"·")}`;
  return `Series ${index+1}`;
}
