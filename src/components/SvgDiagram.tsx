import { useEffect,useMemo,useRef,useState } from "react";
import {registerMedia,type ExportableMedia} from '../mediaExport';
import { parseValidatedSvg,presentValidatedSvg,serializeValidatedSvg,svgSizingStyle } from "../svgImage";
import type {MediaAppearance} from '../mediaAppearance';
import {adaptValidatedSvg} from '../svgTheme';
import {commitMediaLayout} from '../mediaLayout';

const inkColor = () => typeof document === "undefined" ? "#1c2635" : getComputedStyle(document.documentElement).getPropertyValue("--text").trim() || "#1c2635";

export default function SvgDiagram({ source, appearance, ink, colors, dark=false, preserveOriginal=false, label='SVG drawing',exportMedia }: { source: string; dark?: boolean; appearance?:MediaAppearance; ink?:string;colors?:Record<string,string>;preserveOriginal?:boolean;label?:string;exportMedia?:ExportableMedia }) {
  const element=useRef<HTMLImageElement>(null),[sized,setSized]=useState(false);
  const [failed,setFailed]=useState('');
  const raw=preserveOriginal||!!appearance&&appearance!=='original',visualInk=raw?undefined:ink||inkColor();
  const adapts=appearance==='auto'||appearance==='monochrome';
  // Only mounted diagrams create display variants when the palette changes;
  // the Markdown tree and offscreen diagrams remain cached/windowed.
  const validated=useMemo(()=>{try{return {svg:parseValidatedSvg(source),error:''};}catch(error){return {svg:null,error:String(error)};}},[source]);
  const backing=validated.svg?.backing??'#fdfdfc';
  const sizingStyle=useMemo(()=>svgSizingStyle(validated.svg?.dimensions),[validated.svg]);
  const rendered=useMemo(()=>{
    if(!validated.svg)return {svg:'',mode:'color' as const,error:validated.error};
    try{
      if(adapts)return {svg:adaptValidatedSvg(validated.svg,colors??{primary:ink??inkColor()},dark,appearance==='monochrome'),mode:'color' as const,error:''};
      if(raw)return {svg:serializeValidatedSvg(validated.svg),mode:'color' as const,error:''};
      return {...presentValidatedSvg(validated.svg,visualInk!),error:''};
    }catch(error){return {svg:'',mode:'color' as const,error:String(error)};}
  },[validated,adapts,raw,visualInk,appearance,colors,dark,ink]);
  const adapted=rendered.svg;
  const backdrop=appearance==='contrast'?backing:undefined;
  useEffect(()=>registerMedia(element.current,exportMedia??{label,svg:()=>source}),[source,label,exportMedia,rendered.error,failed]);
  if (rendered.error || failed===adapted) return <p className="render-error" role="alert">{rendered.error || 'The drawing could not be decoded or loaded.'}</p>;
  return <figure className={`svg-figure svg-figure--${rendered.mode}`} style={!sized?{position:'relative',minHeight:60}:undefined}>{!sized&&<span className="image-loading" role="status">Loading drawing…</span>}<img ref={element} draggable={false} data-media-kind="svg" data-svg-sized={sizingStyle?'true':undefined} data-media-adapted={adapts?'true':undefined} data-light-ink={backing==='#222026'?'true':undefined} className="svg-diagram" style={{...sizingStyle,backgroundColor:backdrop,...(!sized?{position:'absolute',height:0,visibility:'hidden'}:{})} as React.CSSProperties} src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(adapted)}`} alt={label} decoding="async" onLoad={()=>{if(!sized)commitMediaLayout(element.current,()=>setSized(true));}} onError={()=>commitMediaLayout(element.current,()=>setFailed(adapted))} /></figure>;
}
