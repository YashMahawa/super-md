// @vitest-environment jsdom
import {afterEach, describe, expect, it} from "vitest";
import {act} from "react";
import {createRoot, type Root} from "react-dom/client";
import {renderToStaticMarkup} from "react-dom/server";
import StepCards,{parseStepDeck} from "./StepCards";
import MarkdownPreview from "./MarkdownPreview";
import {stepIndices} from "../renderedOutputs";
const deck=JSON.stringify({title:"Heap insertion",steps:[
  {label:"Initial",image:"assets/one.svg",description:"Start with a valid heap."},
  {label:"Bubble up",image:"assets/two.svg",description:"Compare against the parent."},
  {label:"Finished",image:"assets/three.svg",description:"Stop at the root."}
]});
Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
let root:Root|null=null;
afterEach(()=>{if(root){act(()=>root?.unmount());root=null;}document.body.innerHTML="";stepIndices.clear();});
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

  it("retains active step across remounts and preserves index and Slide viewer during matching live edits",async()=>{
    const fiveSteps=(title:string,labels:string[],note="Initial prose")=>JSON.stringify({
      title,
      steps:labels.map((label,i)=>({label,image:`assets/s${i+1}.svg`,markdown:`${note} ${i+1}`}))
    });
    const initialSource=fiveSteps("Wave derivation",["Setup","Boundary","Harmonics","Superposition","Summary"]);
    const host=document.createElement("div");document.body.append(host);root=createRoot(host);
    await act(async()=>root?.render(<StepCards source={initialSource} renderImage={(src,alt)=><img src={src} alt={alt}/>}/>));
    const next=host.querySelector<HTMLButtonElement>('[aria-label="Next step"]')!;
    await act(async()=>next.click());
    await act(async()=>next.click());
    await act(async()=>next.click());
    expect(stepIndices.get(initialSource)).toBe(3);
    expect(host.querySelector(".step-cards-figure.is-current img")?.getAttribute("src")).toBe("assets/s4.svg");

    // Simulate windowing / mode-switch unmount and remount.
    await act(async()=>root?.render(<div/>));
    await act(async()=>root?.render(<StepCards source={initialSource} renderImage={(src,alt)=><img src={src} alt={alt}/>}/>));
    expect(host.querySelector(".step-cards-progress")?.textContent).toBe("4 / 5");
    expect(host.querySelector(".step-cards-figure.is-current img")?.getAttribute("src")).toBe("assets/s4.svg");

    // Open Slide viewer and live-edit step prose while keeping title, then while keeping step label.
    await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="Enlarge slide"]')!.click());
    expect(document.querySelector('[role="dialog"][aria-label="Slide viewer"]')).toBeTruthy();

    const editedProse=fiveSteps("Wave derivation",["Setup","Boundary","Harmonics","Updated superposition","Summary"],"Edited prose");
    await act(async()=>root?.render(<StepCards source={editedProse} renderImage={(src,alt)=><img src={src} alt={alt}/>}/>));
    expect(document.querySelector('[role="dialog"][aria-label="Slide viewer"]')).toBeTruthy();
    expect(document.body.querySelector(".step-cards-step-title")?.textContent).toBe("Updated superposition");
    expect(document.body.querySelector(".step-cards-description")?.textContent).toContain("Edited prose 4");

    const editedTitle=fiveSteps("Renamed wave deck",["Setup","Boundary","Harmonics","Updated superposition","Summary"],"Renamed deck prose");
    await act(async()=>root?.render(<StepCards source={editedTitle} renderImage={(src,alt)=><img src={src} alt={alt}/>}/>));
    expect(document.querySelector('[role="dialog"][aria-label="Slide viewer"]')).toBeTruthy();
    expect(document.body.querySelector(".step-cards-progress")?.textContent).toBe("4 / 5");

    // Switching to an unrelated deck resets index to 0 and closes Slide viewer.
    const unrelated=fiveSteps("Completely different topic",["Alpha","Beta"]);
    await act(async()=>root?.render(<StepCards source={unrelated} renderImage={(src,alt)=><img src={src} alt={alt}/>}/>));
    expect(document.querySelector('[role="dialog"][aria-label="Slide viewer"]')).toBeNull();
    expect(host.querySelector(".step-cards-progress")?.textContent).toBe("1 / 2");
  });

  it("exposes enlarge on text-only steps and hides inert zoom controls on chart and text slides",async()=>{
    const mixed=JSON.stringify({title:"Mixed study deck",steps:[
      {label:"Text overview",markdown:" Pure text step with **notes**."},
      {label:"Interactive plot",chart:{series:[{expression:"ln(x)"}],x:{min:1,max:5}}},
      {label:"Diagram step",diagram:{values:[8,4,12]}}
    ]});
    const host=document.createElement("div");document.body.append(host);root=createRoot(host);
    await act(async()=>root?.render(<MarkdownPreview markdown={"```smd-steps\n"+mixed+"\n```"} documentPath={null} python="" dark={false}/>));
    const enlarge=host.querySelector<HTMLButtonElement>(".step-cards.has-no-visual .step-cards-enlarge")!;
    expect(enlarge).toBeTruthy();
    await act(async()=>enlarge.click());
    const viewer=()=>document.querySelector<HTMLElement>('[role="dialog"][aria-label="Slide viewer"]')!;
    expect(viewer()).toBeTruthy();
    expect(viewer().querySelector('[aria-label="Slide image zoom"]')).toBeNull();
    expect(viewer().querySelector('[aria-label="Fit slide image"]')).toBeNull();
    expect(viewer().querySelector('[aria-label="Close slide viewer"]')).toBeTruthy();

    // Advance to chart slide: zoom and Fit remain hidden.
    await act(async()=>viewer().querySelector<HTMLButtonElement>('[aria-label="Next step"]')!.click());
    expect(viewer().querySelector('[aria-label="Slide image zoom"]')).toBeNull();
    expect(viewer().querySelector('[aria-label="Fit slide image"]')).toBeNull();

    // Advance to diagram slide: zoom and Fit appear, and live MarkdownPreview edits keep Slide viewer open.
    await act(async()=>viewer().querySelector<HTMLButtonElement>('[aria-label="Next step"]')!.click());
    expect(viewer().querySelector('[aria-label="Slide image zoom"]')?.textContent).toBe("100%");
    expect(viewer().querySelector('[aria-label="Fit slide image"]')).toBeTruthy();
    expect(host.querySelector('.step-cards-placeholder[data-output-pinned="true"]')).toBeTruthy();
    const updatedMixed=JSON.stringify({title:"Mixed study deck",steps:[
      {label:"Text overview",markdown:" Pure text step with **notes**."},
      {label:"Interactive plot",chart:{series:[{expression:"ln(x)"}],x:{min:1,max:5}}},
      {label:"Diagram step",markdown:"Live edited slide notes.",diagram:{values:[8,4,12]}}
    ]});
    await act(async()=>root?.render(<MarkdownPreview markdown={"# Live heading\n\n```smd-steps\n"+updatedMixed+"\n```"} documentPath={null} python="" dark={false}/>));
    expect(viewer()).toBeTruthy();
    expect(viewer().querySelector(".step-cards-progress")?.textContent).toBe("3 / 3");
    expect(viewer().textContent).toContain("Live edited slide notes.");
  });
});
