import {useEffect,useRef,type RefObject} from "react";
import {axisNumber} from "../focalZoom";

export type Probe = {x:number;y:number;coordinates:number[];label?:string;color?:string;kind?:string;guide?:{left:number;bottom:number}};
/** Pointer-only overlay: moving the probe never re-renders an expensive mesh. */
export default function GraphProbe({svg,locate}:{svg:RefObject<SVGSVGElement|null>;locate:(x:number,y:number,touch:boolean)=>Probe|null}) {
  const group=useRef<SVGGElement>(null),tooltip=useRef<HTMLOutputElement>(null),lookup=useRef(locate);
  lookup.current=locate;
  useEffect(()=>{
    const host=svg.current;if(!host)return;
    const output=document.createElement("output");output.className="graph-probe";output.hidden=true;output.setAttribute("aria-live","off");document.body.append(output);tooltip.current=output;
    const fingers=new Set<number>();
    const hide=()=>{group.current?.setAttribute("visibility","hidden");if(tooltip.current)tooltip.current.hidden=true;};
    const show=(event:PointerEvent)=>{
      if(event.pointerType!=="mouse" && (fingers.size!==1||!fingers.has(event.pointerId))){hide();return;}
      if(host.closest("[data-chart-pinching]")||(event.pointerType==="mouse"&&event.buttons&1)){hide();return;}
      const rect=host.getBoundingClientRect(),box=host.viewBox.baseVal;
      const result=lookup.current((event.clientX-rect.left)/rect.width*box.width,(event.clientY-rect.top)/rect.height*box.height,event.pointerType!=="mouse");
      const marker=group.current;
      if(!result||!marker){hide();return;}
      const color=result.color||"var(--primary)";
      marker.style.setProperty("--probe-color",color);
      const [ring,dot,vertical,horizontal]=Array.from(marker.children) as SVGElement[];
      for(const circle of [ring,dot]){circle.setAttribute("cx",String(result.x));circle.setAttribute("cy",String(result.y));}
      const guide=result.guide||{left:result.x,bottom:result.y};
      vertical.setAttribute("x1",String(result.x));vertical.setAttribute("x2",String(result.x));vertical.setAttribute("y1",String(result.y));vertical.setAttribute("y2",String(guide.bottom));
      horizontal.setAttribute("x1",String(guide.left));horizontal.setAttribute("x2",String(result.x));horizontal.setAttribute("y1",String(result.y));horizontal.setAttribute("y2",String(result.y));
      marker.dataset.kind=result.kind||"";
      marker.setAttribute("visibility","visible");
      const output=tooltip.current;if(!output)return;
      output.replaceChildren();
      output.style.setProperty("--probe-color",color);
      if(result.label){const name=document.createElement("span");name.className="graph-probe-label";name.textContent=result.kind?`${result.kind}, ${result.label}`:result.label;output.append(name);}
      const value=document.createElement("strong");value.textContent=`(${result.coordinates.map(axisNumber).join(", ")})`;output.append(value);
      output.hidden=false;
      // Anchor to the locked point, not the pointer; stay inside the viewport.
      const anchorX=rect.left+result.x/box.width*rect.width,anchorY=rect.top+result.y/box.height*rect.height;
      const right=anchorX+16+output.offsetWidth<window.innerWidth-8;
      output.style.left=`${Math.max(8,right?anchorX+16:anchorX-16-output.offsetWidth)}px`;
      output.style.top=`${Math.max(8,Math.min(window.innerHeight-output.offsetHeight-8,anchorY-output.offsetHeight-12))}px`;
    };
    const down=(event:PointerEvent)=>{if(event.pointerType!=="mouse")fingers.add(event.pointerId);show(event);};
    const up=(event:PointerEvent)=>{fingers.delete(event.pointerId);if(event.pointerType!=="mouse")hide();};
    host.addEventListener("pointerdown",down);host.addEventListener("pointermove",show);host.addEventListener("pointerleave",hide);
    window.addEventListener("pointerup",up);window.addEventListener("pointercancel",up);window.addEventListener("scroll",hide,true);
    return()=>{hide();output.remove();tooltip.current=null;host.removeEventListener("pointerdown",down);host.removeEventListener("pointermove",show);host.removeEventListener("pointerleave",hide);window.removeEventListener("pointerup",up);window.removeEventListener("pointercancel",up);window.removeEventListener("scroll",hide,true);};
  },[svg]);
  return <g ref={group} className="graph-probe-marker" visibility="hidden" pointerEvents="none">
    <circle className="graph-probe-ring" r="10"/>
    <circle className="graph-probe-dot" r="4.5"/>
    <line className="graph-probe-guide"/>
    <line className="graph-probe-guide"/>
  </g>;
}
