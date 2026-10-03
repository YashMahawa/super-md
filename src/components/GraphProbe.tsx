import {useEffect,useRef,type RefObject} from "react";
import {axisNumber} from "../focalZoom";

export type Probe = {x:number;y:number;coordinates:number[]};
/** Pointer-only overlay: moving the probe never re-renders an expensive mesh. */
export default function GraphProbe({svg,locate}:{svg:RefObject<SVGSVGElement|null>;locate:(x:number,y:number)=>Probe|null}) {
  const marker=useRef<SVGCircleElement>(null),tooltip=useRef<HTMLOutputElement>(null),lookup=useRef(locate);
  lookup.current=locate;
  useEffect(()=>{
    const host=svg.current;if(!host)return;
    const output=document.createElement("output");output.className="graph-probe";output.hidden=true;output.setAttribute("aria-live","off");document.body.append(output);tooltip.current=output;
    const fingers=new Set<number>();
    const hide=()=>{marker.current?.setAttribute("visibility","hidden");if(tooltip.current)tooltip.current.hidden=true;};
    const show=(event:PointerEvent)=>{
      if(event.pointerType!=="mouse" && (fingers.size!==1||!fingers.has(event.pointerId))){hide();return;}
      if(host.closest("[data-chart-pinching]")){hide();return;}
      const rect=host.getBoundingClientRect(),box=host.viewBox.baseVal;
      const result=lookup.current((event.clientX-rect.left)/rect.width*box.width,(event.clientY-rect.top)/rect.height*box.height);
      if(!result){hide();return;}
      marker.current?.setAttribute("cx",String(result.x));marker.current?.setAttribute("cy",String(result.y));marker.current?.setAttribute("visibility","visible");
      const output=tooltip.current;if(!output)return;
      output.textContent=`(${result.coordinates.map(axisNumber).join(", ")})`;output.hidden=false;
      // Prefer the right of the pointer; stay inside the actual viewport.
      output.style.left=`${Math.min(window.innerWidth-output.offsetWidth-8,event.clientX+14)}px`;
      output.style.top=`${Math.max(8,Math.min(window.innerHeight-output.offsetHeight-8,event.clientY-16))}px`;
    };
    const down=(event:PointerEvent)=>{if(event.pointerType!=="mouse")fingers.add(event.pointerId);show(event);};
    const up=(event:PointerEvent)=>{fingers.delete(event.pointerId);if(event.pointerType!=="mouse")hide();};
    host.addEventListener("pointerdown",down);host.addEventListener("pointermove",show);host.addEventListener("pointerleave",hide);
    window.addEventListener("pointerup",up);window.addEventListener("pointercancel",up);window.addEventListener("scroll",hide,true);
    return()=>{hide();output.remove();tooltip.current=null;host.removeEventListener("pointerdown",down);host.removeEventListener("pointermove",show);host.removeEventListener("pointerleave",hide);window.removeEventListener("pointerup",up);window.removeEventListener("pointercancel",up);window.removeEventListener("scroll",hide,true);};
  },[svg]);
  return <circle ref={marker} visibility="hidden" r="4" fill="var(--primary)" pointerEvents="none"/>;
}
