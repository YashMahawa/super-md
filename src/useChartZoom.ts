import { useEffect, useRef, useState } from "react";
import { chartZooms, remember } from "./renderedOutputs";
import { zoomPlotCenter, type Point } from "./focalZoom";
import { chartCenters } from "./renderedOutputs";
import { wheelIntent } from "./wheelIntent";

/** Plot gestures stay inside the plot. Ordinary one-finger scrolling is unchanged. */
export function useChartZoom(source: string) {
  const host = useRef<HTMLElement>(null);
  const [zoom, setZoom] = useState(() => chartZooms.get(source) ?? 1);
  const value = useRef(zoom); value.current = zoom;
  const [center,setCenter] = useState<Point>(()=>chartCenters.get(source) ?? {x:0,y:0});
  const centerRef = useRef(center); centerRef.current = center;
  const pointer = useRef<Point>({x:.5,y:.5});
  const locate = (point: Point) => {
    const svg = host.current?.querySelector("svg"), rect=svg?.getBoundingClientRect();
    if (!rect) return {x:.5,y:.5};
    // Match the line plot's padded data rectangle, rather than its axis labels.
    const x=(point.x-rect.left)/rect.width, y=(point.y-rect.top)/rect.height;
    const width=svg?.viewBox.baseVal.width||760,height=svg?.viewBox.baseVal.height||360,left=Number(svg?.getAttribute("data-plot-left")||56);
    return {x:Math.max(0,Math.min(1,(x-left/width)/((width-left-20)/width))),y:Math.max(0,Math.min(1,(y-24/height)/((height-70)/height)))};
  };
  const change = (requested: number, focus:Point={x:.5,y:.5}) => {
    const next = Math.max(.05, Math.min(64, Number.isFinite(requested) ? requested : 1));
    const position=zoomPlotCenter(centerRef.current,value.current,next,focus);
    centerRef.current=position;setCenter(position);remember(chartCenters,source,position);
    value.current = next;
    setZoom(value.current); remember(chartZooms, source, value.current);
  };
  useEffect(() => {
    change(chartZooms.get(source) ?? 1);
    const element = host.current?.querySelector("svg"); if (!element) return;
    let distance = 0, frame = 0, pending = value.current, focus={x:.5,y:.5}, held=false;
    let midpoint:Point|null=null, drag:Point|null=null,panFrame=0;
    const pan = (dx:number,dy:number)=>{
      const rect=element.getBoundingClientRect();
      const width=element.viewBox.baseVal.width||760,height=element.viewBox.baseVal.height||360;
      const w=rect.width*(width-Number(element.getAttribute("data-plot-left")||70)-20)/width;
      const h=rect.height*(height-70)/height;
      const next={x:centerRef.current.x-dx/(w*value.current),y:centerRef.current.y+dy/(h*value.current)};
      centerRef.current=next;remember(chartCenters,source,next);
      if(!panFrame)panFrame=requestAnimationFrame(()=>{panFrame=0;setCenter(centerRef.current);});
    };
    const press = (event:PointerEvent)=>{if(event.pointerType==="mouse" && event.button===0){held=true;drag={x:event.clientX,y:event.clientY};element.setPointerCapture(event.pointerId);event.preventDefault();}};
    const release = ()=>{held=false;drag=null;};
    const span = (touches: TouchList) => Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
    const update = (next: number, point: Point) => {
      pending = next; focus=point;
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; change(pending,focus); });
    };
    const start = (event: TouchEvent) => {
      if (event.touches.length !== 2) return;
      distance = span(event.touches);
      midpoint={x:(event.touches[0].clientX+event.touches[1].clientX)/2,y:(event.touches[0].clientY+event.touches[1].clientY)/2};
      element.dataset.chartPinching = "true";
      event.preventDefault(); event.stopPropagation();
    };
    const move = (event: TouchEvent) => {
      if (!distance || event.touches.length !== 2) return;
      event.preventDefault(); event.stopPropagation();
      const next=span(event.touches),point={x:(event.touches[0].clientX+event.touches[1].clientX)/2,y:(event.touches[0].clientY+event.touches[1].clientY)/2};
      change(value.current*next/distance,locate(midpoint||point));
      if(midpoint)pan(point.x-midpoint.x,point.y-midpoint.y);
      midpoint=point;
      distance=next;
    };
    const end = (event: TouchEvent) => {
      if (event.touches.length >= 2) return;
      if (frame) { cancelAnimationFrame(frame); frame = 0; change(pending,focus); }
      distance = 0; midpoint=null; delete element.dataset.chartPinching;
    };
    const wheel = (event: WheelEvent) => {
      const intent=wheelIntent(event,held);if(intent==="scroll")return;
      event.preventDefault(); event.stopPropagation();
      if(intent==="pan")pan(-event.deltaX,-event.deltaY);
      else update((frame ? pending : value.current) * Math.exp(-event.deltaY * .002),locate({x:event.clientX,y:event.clientY}));
    };
    const native = (event: Event) => {
      if (event.defaultPrevented) return;
      const hovered = document.querySelector(".interactive-chart svg:hover");
      if (hovered ? hovered !== element : !element.contains(document.activeElement)) return;
      event.preventDefault(); change(value.current * (event as CustomEvent<number>).detail,pointer.current);
    };
    const track = (event: PointerEvent) => { pointer.current=locate({x:event.clientX,y:event.clientY});if(drag && held && event.pointerType==="mouse"){pan(event.clientX-drag.x,event.clientY-drag.y);drag={x:event.clientX,y:event.clientY};event.preventDefault();} };
    const nativePan=(event:Event)=>{const detail=(event as CustomEvent<{dx:number;dy:number}>).detail;event.preventDefault();pan(-detail.dx,-detail.dy);};
    element.addEventListener("supermd-canvas-pan",nativePan);
    element.addEventListener("pointermove",track);
    element.addEventListener("pointerdown",press);
    window.addEventListener("pointerup",release);window.addEventListener("blur",release);
    element.addEventListener("pointercancel",release);element.addEventListener("lostpointercapture",release);
    element.addEventListener("touchstart", start, {passive: false});
    element.addEventListener("touchmove", move, {passive: false});
    element.addEventListener("touchend", end); element.addEventListener("touchcancel", end);
    element.addEventListener("wheel", wheel, {passive: false});
    window.addEventListener("supermd-chart-native-zoom", native);
    return () => {
      cancelAnimationFrame(frame);cancelAnimationFrame(panFrame); delete element.dataset.chartPinching;
      element.removeEventListener("pointermove",track);
      element.removeEventListener("supermd-canvas-pan",nativePan);
      element.removeEventListener("pointerdown",press);
      window.removeEventListener("pointerup",release);window.removeEventListener("blur",release);
      element.removeEventListener("pointercancel",release);element.removeEventListener("lostpointercapture",release);
      element.removeEventListener("touchstart", start); element.removeEventListener("touchmove", move);
      element.removeEventListener("touchend", end); element.removeEventListener("touchcancel", end);
      element.removeEventListener("wheel", wheel); window.removeEventListener("supermd-chart-native-zoom", native);
    };
  }, [source]);
  return {host, zoom, center, change};
}
