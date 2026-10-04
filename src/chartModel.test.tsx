import { describe,expect,it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { lineSegments,parseChartSpec,chartFeatures,safeCurve,seriesLabel } from "./chartModel";
import InteractiveChart from "./components/InteractiveChart";
it("rejects malformed shapes before rendering can crash",()=>{
  for(const spec of [null,[],{series:null},{series:[null]},{series:[],sliders:{}},{series:[{expression:"x"}],sliders:{}},{series:[{points:[null]}]},{series:[{expression:"x",color:"url(file:///secret)"}]},{series:[{expression:"x"}],sliders:[{name:"x",min:0,max:1,value:.5}]}]) {
    const source=JSON.stringify(spec);
    expect(()=>parseChartSpec(source)).toThrow();
    expect(renderToStaticMarkup(<InteractiveChart source={source}/>)).toContain("render-error");
  }
});
it("breaks curves at undefined points instead of drawing across the singularity",()=>{
  expect(lineSegments([[0,0],[1,1],[2,Number.NaN],[3,1],[4,0]],2)).toHaveLength(2);
});
it("retires interactive 3D without rewriting existing source",()=>{
  const source=JSON.stringify({mode:"surface3d",series:[{name:"Bowl",expression:"a*(x^2+y^2)",color:"#006a6a"},{name:"Saddle",expression:"x^2-y^2",color:"#6750a4"}],sliders:[{name:"a",min:.1,max:2,value:1}],x:{min:-2,max:2,steps:16},y:{min:-2,max:2}});
  const rendered=renderToStaticMarkup(<InteractiveChart source={source}/>);
  expect(()=>parseChartSpec(source)).toThrow("Python/Matplotlib");
  expect(rendered).toContain("Interactive 3D graphs are no longer supported");
  expect(rendered).not.toContain("<svg");
  expect(JSON.parse(source).mode).toBe("surface3d");
});

describe("graph probing features", () => {
  const sample = (f:(x:number)=>number) => Array.from({length:241},(_,i)=>{const x=-4+i*8/240;return [x,f(x)] as [number,number];});
  it("locks onto roots, turning points and intersections", () => {
    const parabola = (x:number)=>x*x-1, line=(x:number)=>x;
    const features = chartFeatures([sample(parabola),sample(line)],[parabola,line],20);
    const near = (kind:string,x:number,y:number)=>features.some(f=>f.kind===kind&&Math.abs(f.x-x)<1e-6&&Math.abs(f.y-y)<1e-6);
    expect(near("root",-1,0)).toBe(true);
    expect(near("root",1,0)).toBe(true);
    expect(near("minimum",0,-1)).toBe(true);
    expect(near("intersection",(1+Math.sqrt(5))/2,(1+Math.sqrt(5))/2)).toBe(true);
    expect(near("intersection",(1-Math.sqrt(5))/2,(1-Math.sqrt(5))/2)).toBe(true);
  });
  it("treats poles and throwing evaluators as gaps", () => {
    const curve = safeCurve(()=>{throw new Error("bad");},{})!;
    expect(Number.isNaN(curve(1))).toBe(true);
    const tangent = Math.tan;
    expect(chartFeatures([sample(tangent)],[tangent],8).filter(f=>f.kind==="root").every(f=>Math.abs(Math.tan(f.x))<1e-6)).toBe(true);
  });
  it("names equations readably", () => {
    expect(seriesLabel({expression:"a * Math.sin(x)"},0)).toBe("y = a·sin(x)");
    expect(seriesLabel({name:"Wave",expression:"sin(x)"},0)).toBe("Wave");
    expect(renderToStaticMarkup(<InteractiveChart source={JSON.stringify({series:[{expression:"x^2"}]})}/>)).toContain("y = x^2");
  });
});
