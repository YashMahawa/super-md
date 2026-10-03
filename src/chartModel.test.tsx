import { expect,it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { lineSegments,parseChartSpec } from "./chartModel";
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
