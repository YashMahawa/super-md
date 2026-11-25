// @vitest-environment jsdom
import { afterEach,describe,expect,it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { lineSegments,parseChartSpec,chartFeatures,safeCurve,seriesLabel,sliderStep } from "./chartModel";
import InteractiveChart from "./components/InteractiveChart";
import { chartValues, chartZooms, remember } from "./renderedOutputs";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | null = null;
afterEach(() => {
  if (root) { act(() => root?.unmount()); root = null; }
  document.body.innerHTML = "";
  chartValues.clear();
  chartZooms.clear();
});
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

  it("supports ln(x), rejects undeclared chart variables, and warns on NaN curves in multi-series plots", () => {
    const lnChart = JSON.stringify({ series: [{ name: "Natural log", expression: "ln(x)" }], x: { min: -2, max: 6 } });
    const lnHtml = renderToStaticMarkup(<InteractiveChart source={lnChart} />);
    expect(lnHtml).toContain("chart-line");
    expect(lnHtml).not.toContain("chart-warning");
    expect(lnHtml).not.toContain("render-error");

    for (const bad of [
      { series: [{ expression: "a * sin(x)" }] },
      { series: [{ expression: "a * sin(b * x)" }], sliders: [{ name: "a", min: 0.1, max: 2, value: 1 }] },
      { series: [{ expression: "y + x" }] },
    ]) {
      const source = JSON.stringify(bad);
      expect(() => parseChartSpec(source)).toThrow(/Unknown chart variable/);
      expect(renderToStaticMarkup(<InteractiveChart source={source} />)).toContain("render-error");
    }

    const multiNaN = JSON.stringify({
      series: [
        { name: "Valid wave", expression: "sin(x)" },
        { name: "Invalid log", expression: "ln(x)" }
      ],
      x: { min: -6, max: -1 }
    });
    const multiHtml = renderToStaticMarkup(<InteractiveChart source={multiNaN} />);
    expect(multiHtml).toContain("chart-line");
    expect(multiHtml).toContain("chart-warning");
    expect(multiHtml).toContain("Invalid log");
    expect(multiHtml).not.toContain("Valid wave.");
  });

  it("aligns omitted-step sliders onto declared defaults and resets sliders without resetting plot zoom", async () => {
    for (const slider of [
      { min: 0.2, max: 3, value: 1 },
      { min: 0.1, max: 3, value: 1 },
      { min: 0.15, max: 2, value: 0.73 },
      { min: -3, max: 3, value: 0 },
    ]) {
      const step = sliderStep(slider);
      const input = document.createElement("input");
      input.type = "range";
      input.min = String(slider.min);
      input.max = String(slider.max);
      input.step = String(step);
      input.value = String(slider.value);
      expect(Number(input.value)).toBeCloseTo(slider.value, 10);
    }

    const source = JSON.stringify({
      title: "A changing wave",
      series: [{ name: "Sine", expression: "sin(a*x)" }],
      sliders: [{ name: "a", label: "Amplitude", min: 0.2, max: 3, value: 1 }]
    });
    remember(chartZooms, source, 2);
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root?.render(<InteractiveChart source={source} />));

    expect(host.querySelectorAll("svg")).toHaveLength(1);
    expect(host.querySelector('button[title="Reset sliders"]')).toBeNull();
    expect(host.querySelector('button[title="Reset view"]')).toBeTruthy();

    const range = host.querySelector<HTMLInputElement>('.chart-controls input[type="range"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(range, "1.5");
      range.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(host.querySelector(".chart-slider-head output")?.textContent).toBe("1.5");
    expect(host.querySelectorAll("svg")).toHaveLength(1);

    const resetSliders = host.querySelector<HTMLButtonElement>('button[title="Reset sliders"]')!;
    expect(resetSliders).toBeTruthy();
    await act(async () => resetSliders.click());
    expect(host.querySelector(".chart-slider-head output")?.textContent).toBe("1");
    expect(host.querySelector('button[title="Reset sliders"]')).toBeNull();
    // Zoom reset stays independent and intact.
    expect(host.querySelector(".interactive-chart")?.getAttribute("data-plot-zoom")).toBe("2");
    expect(host.querySelector('button[title="Reset view"]')).toBeTruthy();
  });
});
