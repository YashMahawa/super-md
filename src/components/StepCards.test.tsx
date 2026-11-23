// @vitest-environment jsdom
import {afterEach, describe, expect, it, vi} from "vitest";
import {act} from "react";
import {createRoot, type Root} from "react-dom/client";
import {renderToStaticMarkup} from "react-dom/server";
import StepCards,{parseStepDeck} from "./StepCards";
import MarkdownPreview from "./MarkdownPreview";
const deck=JSON.stringify({title:"Heap insertion",steps:[
  {label:"Initial",image:"assets/one.svg",description:"Start with a valid heap."},
  {label:"Bubble up",image:"assets/two.svg",description:"Compare against the parent."},
  {label:"Finished",image:"assets/three.svg",description:"Stop at the root."}
]});
Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
let root:Root|null=null;
afterEach(()=>{if(root){act(()=>root?.unmount());root=null;}document.body.innerHTML="";});
describe("step cards",()=>{
  it("embeds existing interactive 2D charts alongside diagrams in one deck",async()=>{
    const source=JSON.stringify({title:"Graph and tree steps",steps:[
      {label:"Graph",chart:{title:"Wave with control",series:[{expression:"sin(a*x)"}],sliders:[{name:"a",value:1,min:0.5,max:3}]},description:"Explore the wave."},
      {label:"Tree",diagram:{values:[10,5,7]},description:"Now view a heap."},
      {label:"Again",chart:{title:"Another graph",series:[{points:[[0,0],[1,1],[2,4]]}]}}
    ]});
    expect(parseStepDeck(source)?.steps[0].chart).toContain("sin(a*x)");
    expect(parseStepDeck(source)?.steps[1].diagram?.nodes).toHaveLength(3);
    const invalid=JSON.stringify({title:"Unsafe",steps:[{label:"A",chart:{series:[{expression:"not_a_function(x)"}]}},{label:"B",description:"ok"}]});
    expect(parseStepDeck(invalid)).toBeNull();
    const host=document.createElement("div");document.body.append(host);root=createRoot(host);
    await act(async()=>root?.render(<StepCards source={source} renderImage={()=>null} renderChart={s=><div className="actual-2d-chart" data-chart={s}/>}/>));
    expect(host.querySelectorAll(".actual-2d-chart")).toHaveLength(2);
    expect(host.querySelector(".step-cards-chart-stack.is-visible")).toBeTruthy();
    const chartElement=host.querySelector(".step-cards-chart-frame.is-current")!;
    await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="Next step"]')!.click());
    expect(host.querySelector(".step-cards-inline-figure svg")).toBeTruthy();
    expect(host.querySelector(".step-cards-chart-stack.is-visible")).toBeNull();
    await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="Previous step"]')!.click());
    expect(host.querySelector(".step-cards-chart-frame.is-current")).toBe(chartElement);
    expect(host.querySelector(".step-cards-figure-stack")).toBeNull();
  });

  it("renders through the ordinary Markdown fence in read mode",()=>{
    const markdown="```smd-steps\n"+deck+"\n```";
    const html=renderToStaticMarkup(<MarkdownPreview markdown={markdown} documentPath={null} python="" dark/>);
    expect(html).toContain("step-cards");
    expect(html).toContain("Heap insertion");
    expect(html).toContain("Previous step");
    expect(html).not.toContain("&quot;steps&quot;");
  });
  it("accepts bounded data, rejects malformed or unsafe shapes",()=>{
    expect(parseStepDeck(deck)?.steps).toHaveLength(3);
    expect(parseStepDeck("{broken")).toBeNull();
    expect(parseStepDeck(JSON.stringify({title:"X",steps:[]}))).toBeNull();
    expect(parseStepDeck(JSON.stringify({title:"X",steps:[{label:"one",description:"hello"},{label:"two"}]}))).toBeNull();
    expect(parseStepDeck("x".repeat(24001))).toBeNull();
  });
  it("server-renders one stage, not all pictures",()=>{
    const html=renderToStaticMarkup(<StepCards source={deck} renderImage={(src,alt)=><img src={src} alt={alt}/>}/>);
    expect(html).toContain("Heap insertion");
    expect(html).toContain("assets/one.svg");
    expect(html).toContain("assets/two.svg");
    expect(html).toContain("step-cards-figure is-offstage");
    expect(html).toContain("1 / 3");
  });
  it("supports next/previous, slider, boundaries and keyboard navigation",async()=>{
    const host=document.createElement("div");document.body.append(host);root=createRoot(host);
    await act(async()=>root?.render(<StepCards source={deck} renderImage={(src,alt)=><img src={src} alt={alt}/>}/>));
    const panel=host.querySelector<HTMLElement>(".step-cards")!;
    const previous=host.querySelector<HTMLButtonElement>('[aria-label="Previous step"]')!;
    const next=host.querySelector<HTMLButtonElement>('[aria-label="Next step"]')!;
    const range=host.querySelector<HTMLInputElement>('input[type="range"]')!;
    expect(previous.disabled).toBe(true);
    expect(host.querySelector(".step-cards-figure.is-current img")?.getAttribute("src")).toBe("assets/one.svg");
    await act(async()=>next.click());
    expect(host.querySelector(".step-cards-figure.is-current img")?.getAttribute("src")).toBe("assets/two.svg");
    expect(range.value).toBe("2");
    await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(range,"3");range.dispatchEvent(new Event("input",{bubbles:true}));});
    expect(host.querySelector(".step-cards-figure.is-current img")?.getAttribute("src")).toBe("assets/three.svg");
    expect(next.disabled).toBe(true);
    panel.focus();
    await act(async()=>panel.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowLeft",bubbles:true,cancelable:true})));
    expect(host.querySelector(".step-cards-figure.is-current img")?.getAttribute("src")).toBe("assets/two.svg");
    await act(async()=>previous.click());
    expect(host.querySelector(".step-cards-figure.is-current img")?.getAttribute("src")).toBe("assets/one.svg");
  });
});
