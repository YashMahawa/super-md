import {useEffect,useMemo,useState, type KeyboardEvent, type ReactNode} from "react";
import InlineDiagram,{parseDiagram,type DiagramSpec} from "./InlineDiagram";
import {parseBinaryTree} from "./BinaryTree";

export interface StepCard { label:string; image?:string; diagram?:DiagramSpec; description?:string; alt?:string }
export interface StepDeck { title:string; steps:StepCard[] }

/** Pure parsing with bounds; no authored scripts or HTML are executed. */
export function parseStepDeck(source:string):StepDeck|null {
  try {
    if(source.length>24000)return null;
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
      if(s.alt!==undefined&&(typeof s.alt!=="string"||s.alt.length>200))return null;
      const diagram=s.diagram===undefined?undefined:(parseDiagram(s.diagram)??parseBinaryTree(s.diagram));
      if(s.diagram!==undefined&&!diagram)return null;
      if(s.image!==undefined&&diagram)return null;
      if(s.image===undefined&&!s.description&&!diagram)return null;
      steps.push({label:s.label.trim(),...(typeof s.image==="string"?{image:s.image}:{}),...(diagram?{diagram}:{}),...(typeof s.description==="string"?{description:s.description}:{}),...(typeof s.alt==="string"?{alt:s.alt}:{})});
    }
    return {title:raw.title.trim(),steps};
  } catch {return null;}
}

/** One diagram at a time; keyboard, buttons and native range slider. */
export default function StepCards({source,renderImage}:{source:string;renderImage:(src:string,alt:string)=>ReactNode}) {
  const deck=useMemo(()=>parseStepDeck(source),[source]);
  const [index,setIndex]=useState(0);
  // Mount nearby slides ahead of time. Once loaded, a slide stays mounted so
  // moving back, forward, or dragging the slider never re-fetches its asset.
  const [mounted,setMounted]=useState<Set<number>>(()=>new Set([0,1,2]));
  useEffect(()=>{setIndex(0);setMounted(new Set([0,1,2]));},[source]);
  const count=deck?.steps.length??0;
  const current=Math.min(index,count-1);
  const go=(next:number)=>{
    const target=Math.max(0,Math.min(next,count-1));
    setMounted(prev=>{
      const upcoming=new Set(prev);
      for(let i=Math.max(0,target-1);i<=Math.min(count-1,target+2);i++)upcoming.add(i);
      return upcoming.size===prev.size?prev:upcoming;
    });
    setIndex(target);
  };
  const onKeyDown=(event:KeyboardEvent<HTMLElement>)=>{
    if(event.altKey||event.ctrlKey||event.metaKey||event.shiftKey)return;
    if(event.target instanceof HTMLInputElement||event.target instanceof HTMLButtonElement)return;
    if(event.key==="ArrowRight"){event.preventDefault();event.stopPropagation();go(current+1);}
    else if(event.key==="ArrowLeft"){event.preventDefault();event.stopPropagation();go(current-1);}
  };
  if(!deck)return <section className="step-cards step-cards-error" role="alert">Invalid step cards. Use a fenced <code>smd-steps</code> block with a title and 2–40 labeled steps.</section>;
  const step=deck.steps[current];
  return <section className="step-cards" role="region" tabIndex={0} aria-label={deck.title+": interactive steps"} onKeyDown={onKeyDown} data-step-count={count}>
    <header className="step-cards-heading">
      <strong>{deck.title}</strong><span className="step-cards-progress" aria-label={"Step "+(current+1)+" of "+count}>{current+1} / {count}</span>
    </header>
    <div className="step-cards-stage">
      <div className="step-cards-step-title" aria-live="polite">{step.label}</div>
      {deck.steps.some(slide=>slide.image)&&<div className="step-cards-figure-stack">
        {deck.steps.map((slide,i)=>mounted.has(i)&&slide.image&&
          <div key={i} className={"step-cards-figure "+(i===current?"is-current":"is-offstage")} aria-hidden={i!==current} inert={i!==current}>
            {renderImage(slide.image,slide.alt??(deck.title+": "+slide.label))}
          </div>)}
      </div>}
      {step.diagram&&<div className="step-cards-inline-figure"><InlineDiagram diagram={step.diagram}/></div>}
      {step.description&&<p className="step-cards-description" aria-live="polite">{step.description}</p>}
    </div>
    <footer className="step-cards-controls">
      <button type="button" className="step-cards-arrow" aria-label="Previous step" disabled={current===0} onClick={()=>go(current-1)}><span aria-hidden="true">‹</span><span className="step-cards-arrow-text">Previous</span></button>
      <label className="step-cards-slider-wrap"><span className="sr-only">Choose step</span><input className="step-cards-slider" type="range" min={1} max={count} step={1} value={current+1} aria-label={"Choose step of "+deck.title} aria-valuetext={"Step "+(current+1)+" of "+count+": "+step.label} onChange={event=>go(Number(event.currentTarget.value)-1)}/></label>
      <button type="button" className="step-cards-arrow" aria-label="Next step" disabled={current===count-1} onClick={()=>go(current+1)}><span className="step-cards-arrow-text">Next</span><span aria-hidden="true">›</span></button>
    </footer>
  </section>;
}
