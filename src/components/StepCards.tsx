import {useEffect,useMemo,useRef,useState, type CSSProperties, type KeyboardEvent, type ReactNode} from "react";
import {createPortal} from "react-dom";
import {setReaderOverlay} from "../readerOverlays";
import {zoomTranslation,type Point} from "../focalZoom";
import {wheelIntent} from "../wheelIntent";
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
  const [figureHeight,setFigureHeight]=useState<number|null>(null);
  const [fitWidth,setFitWidth]=useState<number|null>(null);
  const [expanded,setExpanded]=useState(false);
  const [placeholderHeight,setPlaceholderHeight]=useState(0);
  const navigation=useRef<(next:number)=>void>(()=>{});
  const [zoom,setZoom]=useState(100),[pan,setPan]=useState<Point>({x:0,y:0});
  const zoomRef=useRef(100),panRef=useRef<Point>({x:0,y:0});
  const pointers=useRef(new Map<number,Point>()),gesture=useRef({distance:0,center:{x:0,y:0}});
  const translate=(next:Point)=>{panRef.current=next;setPan(next);};
  const scale=(value:number,focus?:Point)=>{
    const next=Math.max(25,Math.min(800,value)),bounds=figureRef.current?.getBoundingClientRect();
    if(bounds){const origin={x:bounds.x+bounds.width/2,y:bounds.y+bounds.height/2};translate(zoomTranslation(panRef.current,origin,focus??origin,zoomRef.current,next));}
    zoomRef.current=next;setZoom(next);
  };
  const fit=()=>{zoomRef.current=100;setZoom(100);translate({x:0,y:0});pointers.current.clear();};
  // Mount nearby slides ahead of time. Once loaded, a slide stays mounted so
  // moving back, forward, or dragging the slider never re-fetches its asset.
  const [mounted,setMounted]=useState<Set<number>>(()=>new Set([0,1,2]));
  useEffect(()=>{setIndex(0);setMounted(new Set([0,1,2]));setFigureHeight(null);setFitWidth(null);setExpanded(false);},[source]);
  const count=deck?.steps.length??0;
  const current=Math.min(index,count-1);
  const currentRef=useRef(current);currentRef.current=current;
  useEffect(()=>{fit();region.current?.querySelector('.step-cards-notes')?.scrollTo?.(0,0);},[current,expanded]);
  useEffect(()=>{
    const host=figureRef.current;
    if(!host || (!deck?.steps[current]?.image&&!deck?.steps[current]?.diagram)){setFigureHeight(null);setFitWidth(null);return;}
    const measure=()=>{
      const img=host.querySelector<HTMLImageElement>(".step-cards-figure.is-current img");
      const vector=host.querySelector<SVGSVGElement>('.step-cards-inline-figure svg')?.viewBox?.baseVal;
      const naturalWidth=img?.naturalWidth??vector?.width??0,naturalHeight=img?.naturalHeight??vector?.height??0;
      if(img&&!img.complete||naturalWidth<=0||naturalHeight<=0)return;
      const width=host.clientWidth;
      if(!width)return;
      const budget=expanded?Math.max(80,window.innerHeight-110):Math.max(80,window.innerHeight*.72);
      const desired=Math.ceil(Math.min(budget,width*naturalHeight/naturalWidth));
      const maxWidth=Math.ceil(budget*naturalWidth/naturalHeight);
      setFigureHeight(old=>old===desired?old:desired);
      setFitWidth(old=>old===maxWidth?old:maxWidth);
    };
    measure();
    host.addEventListener("load",measure,true);
    window.addEventListener("resize",measure);
    const mutation=typeof MutationObserver!=="undefined"?new MutationObserver(measure):null;
    mutation?.observe(host,{childList:true,subtree:true});
    const resize=typeof ResizeObserver!=="undefined"?new ResizeObserver(measure):null;
    resize?.observe(host);
    return()=>{window.removeEventListener("resize",measure);host.removeEventListener("load",measure,true);mutation?.disconnect();resize?.disconnect();};
  },[deck,current,expanded]);
  const go=(next:number)=>{
    const target=Math.max(0,Math.min(next,count-1));
    setMounted(prev=>{
      const upcoming=new Set(prev);
      for(let i=Math.max(0,target-1);i<=Math.min(count-1,target+2);i++)upcoming.add(i);
      return upcoming.size===prev.size?prev:upcoming;
    });
    setIndex(target);
  };
  navigation.current=go;
  const enlarge=()=>{if(!expanded){setPlaceholderHeight(region.current?.getBoundingClientRect().height??0);setExpanded(true);}};
  useEffect(()=>{
    const node=region.current;
    const open=()=>enlarge();
    node?.addEventListener('supermd-step-expand',open);
    return()=>node?.removeEventListener('supermd-step-expand',open);
  },[expanded]);
  useEffect(()=>{
    if(!expanded)return;
    setReaderOverlay('step-viewer',true);
    document.querySelector<HTMLButtonElement>('.step-viewer-close')?.focus();
    const key=(event:globalThis.KeyboardEvent)=>{
      if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();setExpanded(false);return;}
      if((event.ctrlKey||event.metaKey)&&['+','=','-','0'].includes(event.key)){event.preventDefault();event.stopImmediatePropagation();scale(event.key==='0'?100:zoomRef.current+(event.key==='-'?-10:10));return;}
      if(event.key==='Tab'){
        const items=Array.from(document.querySelectorAll<HTMLElement>('.step-viewer button:not(:disabled),.step-viewer input,.step-viewer a[href],.step-viewer summary'));
        if(event.shiftKey&&document.activeElement===items[0]){event.preventDefault();items.at(-1)?.focus();}
        else if(!event.shiftKey&&document.activeElement===items.at(-1)){event.preventDefault();items[0]?.focus();}
        return;
      }
      if(event.ctrlKey||event.metaKey||event.altKey||event.shiftKey)return;
      const target=event.target instanceof Element?event.target:null;
      if(target?.closest('textarea,[contenteditable="true"],input:not([type="range"])'))return;
      if(event.key==='ArrowLeft'||event.key==='ArrowRight'){
        event.preventDefault();event.stopImmediatePropagation();
        navigation.current(currentRef.current+(event.key==='ArrowRight'?1:-1));
      }
    };
    const native=(event:Event)=>{const detail=(event as CustomEvent<number|{factor:number;point?:Point}>).detail;scale(zoomRef.current*(typeof detail==='number'?detail:detail.factor),typeof detail==='number'?undefined:detail.point);};
    const reset=()=>fit();
    const surface=figureRef.current;
    const wheel=(event:WheelEvent)=>{if((event.target as Element)?.closest('.interactive-chart'))return;event.preventDefault();event.stopPropagation();if(wheelIntent(event)==='pan')translate({x:panRef.current.x-event.deltaX,y:panRef.current.y-event.deltaY});else scale(zoomRef.current*Math.exp(-event.deltaY*.002),{x:event.clientX,y:event.clientY});};
    const nativePan=(event:Event)=>{const {dx,dy}=(event as CustomEvent<{dx:number;dy:number}>).detail;event.preventDefault();translate({x:panRef.current.x-dx,y:panRef.current.y-dy});};
    document.addEventListener('keydown',key,true);
    window.addEventListener('supermd-image-zoom',native);window.addEventListener('supermd-image-reset',reset);
    surface?.addEventListener('wheel',wheel,{passive:false});surface?.addEventListener('supermd-canvas-pan',nativePan);
    return()=>{document.removeEventListener('keydown',key,true);window.removeEventListener('supermd-image-zoom',native);window.removeEventListener('supermd-image-reset',reset);surface?.removeEventListener('wheel',wheel);surface?.removeEventListener('supermd-canvas-pan',nativePan);setReaderOverlay('step-viewer',false);requestAnimationFrame(()=>region.current?.focus({preventScroll:true}));};
  },[expanded]);
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
  const card=<section className={"step-cards"+(!step.markdown?" is-visual-only":"")+(!step.image&&!step.diagram&&!step.chart?" has-no-visual":"")+(expanded?" is-expanded":"")} style={{...(fitWidth?{'--step-image-fit-width':`${fitWidth}px`}:{}),...(figureHeight?{'--step-figure-height':`${figureHeight}px`}:{}),'--step-viewer-transform':`translate(${pan.x}px,${pan.y}px) scale(${zoom/100})`} as CSSProperties} role="region" tabIndex={0} aria-label={deck.title+": interactive steps"} ref={region} onPointerEnter={()=>{hovered.current=true;}} onPointerLeave={()=>{hovered.current=false;}} onKeyDown={onKeyDown} data-step-count={count}>
    <div className="step-cards-layout">
    <div className={'step-cards-stage'+(expanded?' image-viewer-canvas':'')} ref={figureRef} onClick={event=>{if(!expanded&&event.target instanceof Element&&event.target.closest('.step-cards-inline-figure svg'))enlarge();}}
      onPointerDown={event=>{
        if(!expanded||step.chart||event.button!==0)return;
        event.currentTarget.setPointerCapture(event.pointerId);pointers.current.set(event.pointerId,{x:event.clientX,y:event.clientY});
        if(pointers.current.size===2){const [a,b]=[...pointers.current.values()];gesture.current={distance:Math.hypot(a.x-b.x,a.y-b.y),center:{x:(a.x+b.x)/2,y:(a.y+b.y)/2}};}
      }} onPointerMove={event=>{
        const old=pointers.current.get(event.pointerId);if(!old)return;
        pointers.current.set(event.pointerId,{x:event.clientX,y:event.clientY});
        if(pointers.current.size===2){const [a,b]=[...pointers.current.values()],center={x:(a.x+b.x)/2,y:(a.y+b.y)/2},distance=Math.hypot(a.x-b.x,a.y-b.y);if(gesture.current.distance){scale(zoomRef.current*distance/gesture.current.distance,gesture.current.center);translate({x:panRef.current.x+center.x-gesture.current.center.x,y:panRef.current.y+center.y-gesture.current.center.y});}gesture.current={distance,center};}
        else translate({x:panRef.current.x+event.clientX-old.x,y:panRef.current.y+event.clientY-old.y});
      }} onPointerUp={event=>pointers.current.delete(event.pointerId)} onPointerCancel={event=>pointers.current.delete(event.pointerId)}>
      {!expanded&&<button type="button" className="step-cards-enlarge" aria-label="Enlarge slide" onClick={enlarge}>⤢</button>}
      {deck.steps.some(slide=>slide.image)&&<div className={"step-cards-figure-stack"+(step.image?"":" is-inactive")} style={step.image && figureHeight?{height:figureHeight}:undefined}>
        {deck.steps.map((slide,i)=>mounted.has(i)&&slide.image&&
          <div key={i} className={"step-cards-figure "+(i===current?"is-current":"is-offstage")} aria-hidden={i!==current} inert={i!==current}>
            {renderImage(slide.image,slide.alt??(deck.title+": "+slide.label))}
          </div>)}
      </div>}
      {step.diagram&&<div className="step-cards-inline-figure" style={figureHeight?{height:figureHeight}:undefined}><InlineDiagram diagram={step.diagram}/></div>}
      {deck.steps.some(slide=>slide.chart)&&<div className={"step-cards-chart-stack"+(step.chart?" is-visible":"")}>
        {deck.steps.map((slide,i)=>mounted.has(i)&&slide.chart&&<div key={i} className={"step-cards-chart-frame "+(i===current?"is-current":"is-offstage")} aria-hidden={i!==current} inert={i!==current}>
          {renderChart?renderChart(slide.chart):<div className="step-cards-error">2D chart rendering is unavailable in this reader.</div>}
        </div>)}
      </div>}
    </div>
    <aside className="step-cards-notes">
    {step.markdown&&<header className="step-cards-heading"><strong>{deck.title}</strong></header>}
      <div className="step-cards-step-title" aria-live="polite">{step.label}</div>
      {step.markdown&&<div className="step-cards-description">{renderMarkdown?renderMarkdown(step.markdown):<p>{step.markdown}</p>}</div>}
      {!step.markdown&&step.description&&<details className="step-cards-legacy-note"><summary>Explanation</summary><div>{renderMarkdown?renderMarkdown(step.description):step.description}</div></details>}
    </aside>
    </div>
    <footer className="step-cards-controls">
      <button type="button" className="step-cards-arrow" aria-label="Previous step" disabled={current===0} onClick={()=>go(current-1)}><span aria-hidden="true">‹</span><span className="step-cards-arrow-text">Previous</span></button>
      <label className="step-cards-slider-wrap"><input className="step-cards-slider" type="range" min={1} max={count} step={1} value={current+1} aria-label={"Choose step of "+deck.title} aria-valuetext={"Step "+(current+1)+" of "+count+": "+step.label} onChange={event=>go(Number(event.currentTarget.value)-1)}/></label>
      <button type="button" className="step-cards-arrow" aria-label="Next step" disabled={current===count-1} onClick={()=>go(current+1)}><span className="step-cards-arrow-text">Next</span><span aria-hidden="true">›</span></button>
      <span className="step-cards-progress" aria-label={"Step "+(current+1)+" of "+count}>{current+1} / {count}</span>
    </footer>
  </section>;
  return expanded?<><div className="step-cards-placeholder" style={{height:placeholderHeight}}/>{createPortal(<div className="image-viewer step-viewer markdown-body" data-independent-zoom role="dialog" aria-modal="true" aria-label="Slide viewer"><div className="step-viewer-toolbar"><output aria-label="Slide image zoom">{Math.round(zoom)}%</output><button aria-label="Fit slide image" onClick={fit}>Fit</button><button className="step-viewer-close" aria-label="Close slide viewer" onClick={()=>setExpanded(false)}>Close</button></div>{card}</div>,document.body)}</>:card;
}
