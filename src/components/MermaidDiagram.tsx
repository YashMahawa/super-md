import { useEffect, useMemo, useRef, useState } from "react";
import { cachedMermaid, renderMermaid } from "../mermaidRenderer";
import {canUsePele} from '../peleRenderer';
import SvgDiagram from './SvgDiagram';
import type {MediaAppearance} from '../mediaAppearance';
import {commitMediaLayout} from '../mediaLayout';
export default function MermaidDiagram({ source, dark, appearance, colors }: { source: string; dark: boolean; appearance?:MediaAppearance;colors?:Record<string,string> }) {
  const [rendered, setRendered] = useState<{svg:string;dark:boolean;source:string}>();
  const [failure,setFailure]=useState<{source:string;dark:boolean;message:string}>();
  const previous=useRef<{source:string;dark:boolean}|undefined>(undefined);
  const container=useRef<HTMLDivElement>(null);
  // Appearance is a display variant, never a change to the authored diagram.
  // Adapt/monochrome/invert start from light source colours, so dark-mode
  // inversion is not applied a second time to a dark Mermaid rendering.
  const renderDark=(!appearance||appearance==='original')&&dark;
  const cached=cachedMermaid(source,renderDark);
  const exportMedia=useMemo(()=>({label:'Mermaid diagram',svg:()=>renderMermaid(source,false),source:{text:source,extension:'mmd' as const}}),[source]);
  useEffect(() => {
    let active=true;
    const controller=new AbortController();
    const themeOnly=previous.current?.source===source&&previous.current.dark!==renderDark;
    previous.current={source,dark:renderDark};
    const run=()=>{renderMermaid(source, renderDark, controller.signal).then((svg) => { if(active)commitMediaLayout(container.current,()=>{setRendered({svg,dark:renderDark,source});setFailure(undefined);}); }).catch((reason) => {if(active&&!controller.signal.aborted)commitMediaLayout(container.current,()=>setFailure({source,dark:renderDark,message:String(reason)}));});};
    // A cached/theme-only transition is not typing and needs no debounce.
    const timer=cachedMermaid(source,renderDark)||themeOnly?(run(),undefined):window.setTimeout(run,canUsePele(source)?40:220);
    return () => { active=false;controller.abort();if(timer!==undefined)window.clearTimeout(timer); };
  }, [renderDark, source]);
  if (failure?.source===source&&failure.dark===renderDark&&!cached) return <div ref={container} className="render-error">Mermaid: {failure.message}</div>;
  const display=cached?{svg:cached,dark:renderDark}:rendered?.source===source?rendered:undefined;
  // Keep authored themeCSS inside an inert image. It must not style the app,
  // other notes, or a diagram with a different theme.
  return <div ref={container} className="mermaid" data-render-dark={display?String(display.dark):undefined}>{display?<SvgDiagram source={display.svg} dark={!appearance||appearance==='original'?display.dark:dark} appearance={appearance} colors={colors} preserveOriginal label="Mermaid diagram" exportMedia={exportMedia}/>:<span className="image-loading" role="status">Loading diagram…</span>}</div>;
}
