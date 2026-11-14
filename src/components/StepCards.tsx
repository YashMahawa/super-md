import {useEffect,useMemo,useRef,useState, type KeyboardEvent, type ReactNode} from "react";
import InlineDiagram,{parseDiagram,type DiagramSpec} from "./InlineDiagram";
import {parseBinaryTree} from "./BinaryTree";
import {parseChartSpec} from "../chartModel";

export interface StepCard { label:string; image?:string; diagram?:DiagramSpec; chart?:string; description?:string; markdown?:string; alt?:string }
export interface StepDeck { title:string; steps:StepCard[] }

/** Pure parsing with bounds; no authored scripts or HTML are executed. */
export function parseStepDeck(source:string):StepDeck|null {
  try {
    if(source.length>120000)return null;
    const value:unknown=JSON.parse(source);
    if(!value||typeof value!=="object"||Array.isArray(value))return null;
    const raw=value as Record<string,unknown>;
    if(typeof raw.title!=="string"||!raw.title.trim()||raw.title.length>120)return null;
    if(!Array.isArray(raw.steps)||raw.steps.length<2||raw.steps.length>40)return null;
    const steps:StepCard[]=[];
    for(const item of raw.steps){
      if(!item||typeof item!=="object"||Array.isArray(item))return null;
      const s=item as Record<string,unknown>;
      if(typeof s.label!=="string"||!s.label.trim()||s.label.length>100)return null;
      if(s.image!==undefined&&(typeof s.image!=="string"||!s.image.trim()||s.image.length>2048))return null;
      if(s.description!==undefined&&(typeof s.description!=="string"||s.description.length>1500))return null;
      if(s.markdown!==undefined&&(typeof s.markdown!=="string"||s.markdown.length>12000))return null;
      if(s.alt!==undefined&&(typeof s.alt!=="string"||s.alt.length>200))return null;
      const diagram=s.diagram===undefined?undefined:(parseDiagram(s.diagram)??parseBinaryTree(s.diagram));
      if(s.diagram!==undefined&&!diagram)return null;
      let chart:string|undefined;
      if(s.chart!==undefined){
        if(!s.chart||typeof s.chart!=="object"||Array.isArray(s.chart))return null;
        chart=JSON.stringify(s.chart);
        if(chart.length>28000)return null;
        try{parseChartSpec(chart);}catch{return null;}
      }
      if([s.image!==undefined,!!diagram,!!chart].filter(Boolean).length>1)return null;
      if(s.image===undefined&&!s.description&&!s.markdown&&!diagram&&!chart)return null;
      steps.push({label:s.label.trim(),...(typeof s.image==="string"?{image:s.image}:{}),...(diagram?{diagram}:{}),...(chart?{chart}:{}),...(typeof s.description==="string"?{description:s.description}:{}),...(typeof s.markdown==="string"?{markdown:s.markdown}:{}),...(typeof s.alt==="string"?{alt:s.alt}:{})});
    }
    return {title:raw.title.trim(),steps};
  } catch {return null;}
}

/** One diagram at a time; keyboard, buttons and native range slider. */
export default function StepCards({source,renderImage,renderChart,renderMarkdown}:{source:string;renderImage:(src:string,alt:string)=>ReactNode;renderChart?:(source:string)=>ReactNode;renderMarkdown?:(source:string)=>ReactNode}) {
  const deck=useMemo(()=>parseStepDeck(source),[source]);
  const [index,setIndex]=useState(0);
  const hovered=useRef(false);
  const region=useRef<HTMLElement>(null);
  const figureRef=useRef<HTMLDivElement>(null);
  const imageHeights=useRef<Map<number,number>>(new Map());
  const [figureHeight,setFigureHeight]=useState<number|null>(null);
  // Mount nearby slides ahead of time. Once loaded, a slide stays mounted so
  // moving back, forward, or dragging the slider never re-fetches its asset.
  const [mounted,setMounted]=useState<Set<number>>(()=>new Set([0,1,2]));
  useEffect(()=>{setIndex(0);setMounted(new Set([0,1,2]));imageHeights.current.clear();setFigureHeight(null);},[source]);
  const count=deck?.steps.length??0;
  const current=Math.min(index,count-1);
  useEffect(()=>{
    const host=figureRef.current;
    if(!host || !deck?.steps[current]?.image){setFigureHeight(null);return;}
    const measure=()=>{
      const img=host.querySelector<HTMLImageElement>(".step-cards-figure.is-current img");
      if(!img || !img.complete || img.naturalWidth<=0 || img.naturalHeight<=0)return;
      const width=host.clientWidth;
      if(!width)return;
      const desired=Math.max(88,Math.ceil(Math.min(680,Math.max(180,window.innerHeight*.65),width*img.naturalHeight/img.naturalWidth)+2));
      imageHeights.current.set(current,desired);
      setFigureHeight(old=>old===desired?old:desired);
    };
    setFigureHeight(imageHeights.current.get(current)??null);
    measure();
    host.addEventListener("load",measure,true);
    const mutation=typeof MutationObserver!=="undefined"?new MutationObserver(measure):null;
    mutation?.observe(host,{childList:true,subtree:true});
    const resize=typeof ResizeObserver!=="undefined"?new ResizeObserver(measure):null;
    resize?.observe(host);
    return()=>{host.removeEventListener("load",measure,true);mutation?.disconnect();resize?.disconnect();};
  },[deck,current]);
  const go=(next:number)=>{
    const target=Math.max(0,Math.min(next,count-1));
    setMounted(prev=>{
      const upcoming=new Set(prev);
      for(let i=Math.max(0,target-1);i<=Math.min(count-1,target+2);i++)upcoming.add(i);
      return upcoming.size===prev.size?prev:upcoming;
    });
    setIndex(target);
  };
  useEffect(()=>{
    const key=(event:globalThis.KeyboardEvent)=>{
      const target=event.target instanceof Element?event.target:null;
      if(!hovered.current||event.defaultPrevented||event.altKey||event.ctrlKey||event.metaKey||event.shiftKey||region.current?.contains(document.activeElement)||target?.closest('input,textarea,[contenteditable="true"],.cm-editor'))return;
      if(event.key==='ArrowRight'||event.key==='ArrowLeft'){event.preventDefault();go(current+(event.key==='ArrowRight'?1:-1));}
    };
    window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);
  });
  const onKeyDown=(event:KeyboardEvent<HTMLElement>)=>{
    if(event.altKey||event.ctrlKey||event.metaKey||event.shiftKey)return;
    if(event.target instanceof HTMLInputElement||event.target instanceof HTMLTextAreaElement)return;
    if(event.key==="ArrowRight"){event.preventDefault();event.stopPropagation();go(current+1);}
    else if(event.key==="ArrowLeft"){event.preventDefault();event.stopPropagation();go(current-1);}
  };
  if(!deck)return <section className="step-cards step-cards-error" role="alert">Invalid step cards. Use a fenced <code>smd-steps</code> block with a title and 2–40 labeled steps.</section>;
  const step=deck.steps[current];
  return <section className={"step-cards"+(!step.markdown?" is-visual-only":"")} role="region" tabIndex={0} aria-label={deck.title+": interactive steps"} ref={region} onPointerEnter={()=>{hovered.current=true;}} onPointerLeave={()=>{hovered.current=false;}} onKeyDown={onKeyDown} data-step-count={count}>
    <div className="step-cards-layout">
    <div className="step-cards-stage">
      {deck.steps.some(slide=>slide.image)&&<div className={"step-cards-figure-stack"+(step.image?"":" is-inactive")} ref={figureRef} style={step.image && figureHeight?{height:figureHeight}:undefined}>
        {deck.steps.map((slide,i)=>mounted.has(i)&&slide.image&&
          <div key={i} className={"step-cards-figure "+(i===current?"is-current":"is-offstage")} aria-hidden={i!==current} inert={i!==current}>
            {renderImage(slide.image,slide.alt??(deck.title+": "+slide.label))}
          </div>)}
      </div>}
      {step.diagram&&<div className="step-cards-inline-figure"><InlineDiagram diagram={step.diagram}/></div>}
      {deck.steps.some(slide=>slide.chart)&&<div className={"step-cards-chart-stack"+(step.chart?" is-visible":"")}>
        {deck.steps.map((slide,i)=>mounted.has(i)&&slide.chart&&<div key={i} className={"step-cards-chart-frame "+(i===current?"is-current":"is-offstage")} aria-hidden={i!==current} inert={i!==current}>
          {renderChart?renderChart(slide.chart):<div className="step-cards-error">2D chart rendering is unavailable in this reader.</div>}
        </div>)}
      </div>}
    </div>
    <aside className="step-cards-notes">
    <header className="step-cards-heading">
      <strong>{deck.title}</strong><span className="step-cards-progress" aria-label={"Step "+(current+1)+" of "+count}>{current+1} / {count}</span>
    </header>
      <div className="step-cards-step-title" aria-live="polite">{step.label}</div>
      {step.markdown&&<div className="step-cards-description">{renderMarkdown?renderMarkdown(step.markdown):<p>{step.markdown}</p>}</div>}
    </aside>
    </div>
    <footer className="step-cards-controls">
      {!step.markdown&&<span className="step-cards-compact-label">{step.label} <small>{current+1}/{count}</small></span>}
      {!step.markdown&&step.description&&<details className="step-cards-legacy-note"><summary>Explanation</summary><div>{renderMarkdown?renderMarkdown(step.description):step.description}</div></details>}
      <button type="button" className="step-cards-arrow" aria-label="Previous step" disabled={current===0} onClick={()=>go(current-1)}><span aria-hidden="true">‹</span><span className="step-cards-arrow-text">Previous</span></button>
      <label className="step-cards-slider-wrap"><input className="step-cards-slider" type="range" min={1} max={count} step={1} value={current+1} aria-label={"Choose step of "+deck.title} aria-valuetext={"Step "+(current+1)+" of "+count+": "+step.label} onChange={event=>go(Number(event.currentTarget.value)-1)}/></label>
      <button type="button" className="step-cards-arrow" aria-label="Next step" disabled={current===count-1} onClick={()=>go(current+1)}><span className="step-cards-arrow-text">Next</span><span aria-hidden="true">›</span></button>
    </footer>
  </section>;
}
