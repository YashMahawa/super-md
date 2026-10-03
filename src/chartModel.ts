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
