import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { zoomTranslation, type Point } from "../focalZoom";
import { setReaderOverlay } from "../readerOverlays";
import { svgImage } from "../svgImage";
import { wheelIntent } from "../wheelIntent";
import type {CSSProperties} from 'react';

function presentation(target:HTMLImageElement):CSSProperties {
  const style=getComputedStyle(target);
  return {filter:style.filter,backgroundColor:style.backgroundColor,outline:style.outline,outlineOffset:style.outlineOffset,borderRadius:style.borderRadius,boxShadow:style.boxShadow};
}

export function inlineDiagramDataUrl(svg:SVGSVGElement):string {
  const clone=svg.cloneNode(true) as SVGSVGElement;
  clone.removeAttribute("xmlns");
  if(clone.namespaceURI!=="http://www.w3.org/2000/svg")clone.setAttribute("xmlns","http://www.w3.org/2000/svg");
  const box=svg.getAttribute("viewBox")?.trim().split(/[\s,]+/).map(Number);
  if(box?.length===4&&box.every(Number.isFinite)&&box[2]>0&&box[3]>0){
    clone.setAttribute("width",String(box[2]));
    clone.setAttribute("height",String(box[3]));
  }
  const liveNodes=[svg,...Array.from(svg.querySelectorAll("*"))];
  const cloneNodes=[clone,...Array.from(clone.querySelectorAll("*"))];
  for(let i=0;i<liveNodes.length;i++){
    const live=liveNodes[i],copy=cloneNodes[i];
    if(!copy)continue;
    const cs=getComputedStyle(live);
    const tag=live.localName;
    if(tag==="line"){
      copy.setAttribute("stroke",cs.stroke&&cs.stroke!=="none"?cs.stroke:"#aeb8c7");
      copy.setAttribute("stroke-width",cs.strokeWidth&&cs.strokeWidth!=="0px"?cs.strokeWidth:"3");
      copy.setAttribute("stroke-linecap",cs.strokeLinecap||"round");
      copy.setAttribute("fill","none");
      if(live.classList.contains("is-dashed")){
        copy.setAttribute("stroke-dasharray",cs.strokeDasharray&&cs.strokeDasharray!=="none"?cs.strokeDasharray:"5 7");
        copy.setAttribute("opacity",cs.opacity&&cs.opacity!=="1"?cs.opacity:"0.48");
      }
    } else if(tag==="g"&&live.classList.contains("is-muted")){
      copy.setAttribute("opacity",cs.opacity&&cs.opacity!=="1"?cs.opacity:"0.36");
    } else if(tag==="circle"||tag==="rect"){
      const active=live.parentElement?.classList.contains("is-active"),visited=live.parentElement?.classList.contains("is-visited");
      copy.setAttribute("fill",cs.fill&&cs.fill!=="none"?cs.fill:(active?"#ffb367":visited?"#153d4b":"#2b3038"));
      copy.setAttribute("stroke",cs.stroke&&cs.stroke!=="none"?cs.stroke:(active?"#df934e":visited?"#73e3e0":"#b7ceff"));
      copy.setAttribute("stroke-width",cs.strokeWidth&&cs.strokeWidth!=="0px"?cs.strokeWidth:"2.5");
    } else if(tag==="text"){
      const active=live.parentElement?.classList.contains("is-active"),visited=live.parentElement?.classList.contains("is-visited");
      copy.setAttribute("fill",cs.fill&&cs.fill!=="none"?cs.fill:(active?"#1b2735":visited?"#f1faff":"#edf0f7"));
      copy.setAttribute("font-family",cs.fontFamily||"sans-serif");
      copy.setAttribute("font-size",cs.fontSize||"21px");
      copy.setAttribute("font-weight",cs.fontWeight||"700");
    }
  }
  const safe=svgImage(new XMLSerializer().serializeToString(clone));
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(safe)}`;
}

function diagramPresentation(svg:SVGSVGElement):CSSProperties {
  const style=getComputedStyle(svg);
  return style.filter&&style.filter!=="none"?{filter:style.filter}:{};
}

function samePresentation(a:CSSProperties,b:CSSProperties):boolean {
  const ka=Object.keys(a) as (keyof CSSProperties)[],kb=Object.keys(b) as (keyof CSSProperties)[];
  return ka.length===kb.length&&ka.every(k=>a[k]===b[k]);
}

export default function ImageViewer() {
  const [image, setImage] = useState<{ src: string; alt: string; presentation:CSSProperties; owner: HTMLElement | null; liveBlock: HTMLElement | null } | null>(null);
  const [zoom, setZoom] = useState(100), [pan, setPan] = useState({ x: 0, y: 0 });
  const pointers = useRef(new Map<number, Point>()), gesture = useRef({ distance: 0, center: {x:0,y:0} });
  const tapStarts = useRef(new Map<number, {x:number;y:number;multi:boolean}>());
  const lastTap = useRef<{time:number;x:number;y:number}>({time:0,x:0,y:0});
  const touchStart = useRef<{x:number;y:number;multi:boolean}|null>(null);
  const zoomRef = useRef(zoom); zoomRef.current = zoom;
  const panRef = useRef(pan); panRef.current = pan;
  const canvas = useRef<HTMLDivElement>(null);
  const source=useRef<HTMLImageElement|SVGSVGElement|null>(null);
  const openTimer=useRef(0);
  const skipRestoreFocus=useRef(false);
  const imageRef=useRef(image);imageRef.current=image;
  const translate = (next: Point) => { panRef.current = next; setPan(next); };
  const scale = (value: number, focus?: Point) => {
    const bounds = canvas.current?.getBoundingClientRect();
    const next = Math.max(25, Math.min(800, value));
    if (bounds) { const origin = {x:bounds.left+bounds.width/2,y:bounds.top+bounds.height/2}; translate(zoomTranslation(panRef.current,origin,focus || origin,zoomRef.current,next)); }
    zoomRef.current = next; setZoom(next);
  };
  const fit = () => { zoomRef.current = 100; setZoom(100); translate({x:0,y:0}); pointers.current.clear(); tapStarts.current.clear(); lastTap.current = {time:0,x:0,y:0}; };
  const recordTap = (x:number, y:number) => {
    const now = Date.now(), prev = lastTap.current;
    if (now - prev.time <= 320 && Math.hypot(x - prev.x, y - prev.y) <= 36) { fit(); return; }
    lastTap.current = { time: now, x, y };
  };
  useEffect(() => {
    const cancelPending = () => {
      if (openTimer.current) {
        window.clearTimeout(openTimer.current);
        openTimer.current = 0;
      }
    };
    const showForTarget = (target: HTMLImageElement, liveBlock: HTMLElement | null) => {
      const src = target.currentSrc || target.getAttribute("src") || "";
      if (!src) return;
      const slide = target.closest(".step-cards");
      if (slide) { slide.dispatchEvent(new Event("supermd-step-expand")); return; }
      source.current = target;
      setImage({ src, alt: target.alt || "Image", presentation: presentation(target), owner: target.closest("[data-note-image-source]"), liveBlock });
      fit();
    };
    const open = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || document.querySelector(".media-save-menu")) return;
      const element = event.target instanceof Element ? event.target : null;
      if (!element || element.closest(".image-viewer")) return;
      const target = element.closest<HTMLImageElement>(".markdown-body img");
      if (target) {
        const src = target.currentSrc || target.getAttribute("src") || "";
        if (!src) return;
        const liveBlock = target.closest<HTMLElement>(".live-block");
        event.preventDefault(); event.stopImmediatePropagation();
        cancelPending();
        if (!liveBlock) {
          showForTarget(target, null);
          return;
        }
        if (event.detail > 1) return;
        openTimer.current = window.setTimeout(() => {
          openTimer.current = 0;
          if (!target.isConnected || !liveBlock.isConnected || liveBlock.querySelector("textarea")) return;
          showForTarget(target, liveBlock);
        }, 180);
        return;
      }
      const diagramFigure = element.closest<HTMLElement>(".markdown-body .inline-diagram");
      const diagramSvg = element.closest<SVGSVGElement>(".markdown-body .inline-diagram svg") ?? diagramFigure?.querySelector<SVGSVGElement>("svg") ?? null;
      if (!diagramSvg) return;
      const liveBlock = diagramSvg.closest<HTMLElement>(".live-block");
      const showDiagram = (block: HTMLElement | null): boolean => {
        const slide = diagramSvg.closest(".step-cards");
        if (slide) { slide.dispatchEvent(new Event("supermd-step-expand")); return true; }
        try {
          const src = inlineDiagramDataUrl(diagramSvg);
          source.current = diagramSvg;
          const label = diagramSvg.getAttribute("aria-label") || diagramFigure?.getAttribute("aria-label") || "Diagram";
          setImage({ src, alt: label, presentation: diagramPresentation(diagramSvg), owner: null, liveBlock: block }); fit();
          return true;
        } catch {
          /* Malformed SVG stays inline without crashing the reader. */
          return false;
        }
      };
      if (!liveBlock) {
        cancelPending();
        if (showDiagram(null)) { event.preventDefault(); event.stopImmediatePropagation(); }
        return;
      }
      event.preventDefault(); event.stopImmediatePropagation();
      cancelPending();
      if (event.detail > 1) return;
      openTimer.current = window.setTimeout(() => {
        openTimer.current = 0;
        if (!diagramSvg.isConnected || !liveBlock.isConnected || liveBlock.querySelector("textarea")) return;
        showDiagram(liveBlock);
      }, 180);
    };
    const onDoubleClick = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target?.closest(".live-block")) return;
      cancelPending();
      if (imageRef.current?.liveBlock) {
        skipRestoreFocus.current = true;
        setImage(null);
      }
    };
    const onLiveEditOpened = () => {
      cancelPending();
      if (imageRef.current?.liveBlock) {
        skipRestoreFocus.current = true;
        setImage(null);
      }
    };
    document.addEventListener("click", open, true);
    document.addEventListener("dblclick", onDoubleClick, true);
    window.addEventListener("supermd-live-edit-opened", onLiveEditOpened);
    return () => {
      cancelPending();
      document.removeEventListener("click", open, true);
      document.removeEventListener("dblclick", onDoubleClick, true);
      window.removeEventListener("supermd-live-edit-opened", onLiveEditOpened);
    };
  }, []);
  useLayoutEffect(() => { setReaderOverlay("image",!!image);return()=>setReaderOverlay("image",false); }, [!!image]);
  useEffect(()=>{
    if(!image){source.current=null;return;}
    if(!source.current)return;
    const target=source.current;
    const sync=()=>{
      if(!target.isConnected){setImage(null);return;}
      if(target instanceof SVGSVGElement){
        try {
          const src=inlineDiagramDataUrl(target),style=diagramPresentation(target);
          setImage(previous=>previous&&(previous.src!==src||!samePresentation(previous.presentation,style))?{...previous,src,presentation:style}:previous);
        } catch { /* Keep previous valid snapshot. */ }
        return;
      }
      const src=target.currentSrc||target.src,style=presentation(target);
      setImage(previous=>previous&&(previous.src!==src||!samePresentation(previous.presentation,style))?{...previous,src,presentation:style}:previous);
    };
    // Appearance changes should affect an already-open viewer too, without
    // resetting its magnification or moving the image under the person's hand.
    const observer=new MutationObserver(sync);
    observer.observe(document.documentElement,{attributes:true,attributeFilter:['style','data-theme','data-image-appearance','data-svg-appearance']});
    observer.observe(target,{attributes:true,attributeFilter:['src','style']});
    if(target instanceof HTMLImageElement)target.addEventListener('load',sync);
    return()=>{observer.disconnect();if(target instanceof HTMLImageElement)target.removeEventListener('load',sync);};
  },[!!image]);
  useLayoutEffect(() => {
    if (!image) return;
    const previous = document.activeElement as HTMLElement | null;
    document.querySelector<HTMLElement>(".image-viewer button")?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); setImage(null); }
      if ((event.ctrlKey || event.metaKey) && ["+", "=", "-", "0"].includes(event.key)) { event.preventDefault(); event.stopImmediatePropagation(); scale(event.key === "0" ? 100 : zoomRef.current + (event.key === "-" ? -10 : 10)); }
      if (event.key === "Tab") { const controls = Array.from(document.querySelectorAll<HTMLElement>(".image-viewer button")); const active = document.activeElement; if (event.shiftKey && active === controls[0]) { event.preventDefault(); controls.at(-1)?.focus(); } else if (!event.shiftKey && active === controls.at(-1)) { event.preventDefault(); controls[0]?.focus(); } }
    };
    const native = (event: Event) => { const detail = (event as CustomEvent<number | {factor:number;point?:Point}>).detail; scale(zoomRef.current * (typeof detail === "number" ? detail : detail.factor), typeof detail === "number" ? undefined : detail.point); };
    const reset = fit;
    const wheel = (event: WheelEvent) => { event.preventDefault(); event.stopPropagation(); if(wheelIntent(event)==="pan")translate({x:panRef.current.x-event.deltaX,y:panRef.current.y-event.deltaY});else scale(zoomRef.current*Math.exp(-event.deltaY*.002),{x:event.clientX,y:event.clientY}); };
    const surface = canvas.current;
    const nativePan=(event:Event)=>{const {dx,dy}=(event as CustomEvent<{dx:number;dy:number}>).detail;event.preventDefault();translate({x:panRef.current.x-dx,y:panRef.current.y-dy});};
    surface?.addEventListener("supermd-canvas-pan",nativePan);
    surface?.addEventListener("wheel",wheel,{passive:false});
    document.addEventListener("keydown", key, true); window.addEventListener("supermd-image-zoom", native);
    window.addEventListener("supermd-image-reset",reset);
    return () => { surface?.removeEventListener("supermd-canvas-pan",nativePan);surface?.removeEventListener("wheel",wheel); window.removeEventListener("supermd-image-reset",reset); document.removeEventListener("keydown", key, true); window.removeEventListener("supermd-image-zoom", native); if (skipRestoreFocus.current) skipRestoreFocus.current = false; else previous?.focus({ preventScroll: true }); pointers.current.clear(); tapStarts.current.clear(); };
  }, [!!image]);
  if (!image) return null;
  const edit = (action: string) => { if (image.owner) window.dispatchEvent(new CustomEvent("supermd-image-edit", { detail: { action, image: image.owner } })); setImage(null); };
  const editSource = () => {
    const block = image.liveBlock;
    skipRestoreFocus.current = true;
    setImage(null);
    if (block?.isConnected) block.dispatchEvent(new CustomEvent("supermd-edit-block", { bubbles: true }));
  };
  return <section className="image-viewer" data-independent-zoom role="dialog" aria-modal="true" aria-label="Image viewer">
    <header><strong>{image.alt}</strong><button type="button" onClick={() => setImage(null)} aria-label="Close image viewer">Close</button></header>
    <div className="image-viewer-canvas" ref={canvas} onDoubleClick={fit} onTouchStart={event => {
      if (event.touches.length === 1) touchStart.current = { x: event.touches[0].clientX, y: event.touches[0].clientY, multi: false };
      else if (touchStart.current) { touchStart.current.multi = true; lastTap.current = {time:0,x:0,y:0}; }
    }} onTouchEnd={event => {
      const start = touchStart.current;
      if (event.touches.length === 0) touchStart.current = null;
      if (!start || start.multi || event.changedTouches.length !== 1) return;
      const touch = event.changedTouches[0];
      if (Math.hypot(touch.clientX - start.x, touch.clientY - start.y) <= 12) recordTap(touch.clientX, touch.clientY);
      else lastTap.current = {time:0,x:0,y:0};
    }} onPointerDown={event => {
      event.currentTarget.setPointerCapture?.(event.pointerId); pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const multi = pointers.current.size >= 2;
      if (multi) { for (const entry of tapStarts.current.values()) entry.multi = true; lastTap.current = {time:0,x:0,y:0}; }
      tapStarts.current.set(event.pointerId, { x: event.clientX, y: event.clientY, multi });
      if (pointers.current.size === 2) { const [a, b] = [...pointers.current.values()]; gesture.current = { distance: Math.hypot(a.x-b.x, a.y-b.y), center: {x:(a.x+b.x)/2,y:(a.y+b.y)/2} }; }
    }} onPointerMove={event => {
      const old = pointers.current.get(event.pointerId); if (!old) return;
      pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pointers.current.size === 2) { const [a,b] = [...pointers.current.values()], center={x:(a.x+b.x)/2,y:(a.y+b.y)/2}, distance=Math.hypot(a.x-b.x,a.y-b.y); if (gesture.current.distance) { scale(zoomRef.current * distance / gesture.current.distance, gesture.current.center); translate({x:panRef.current.x+center.x-gesture.current.center.x,y:panRef.current.y+center.y-gesture.current.center.y}); } gesture.current={distance,center}; }
      else translate({ x: panRef.current.x + event.clientX-old.x, y: panRef.current.y + event.clientY-old.y });
    }} onPointerUp={event => {
      pointers.current.delete(event.pointerId);
      const start = tapStarts.current.get(event.pointerId); tapStarts.current.delete(event.pointerId);
      if (!start || start.multi || event.pointerType === "mouse") return;
      touchStart.current = null;
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) <= 12) recordTap(event.clientX, event.clientY);
      else lastTap.current = {time:0,x:0,y:0};
    }} onPointerCancel={event => { pointers.current.delete(event.pointerId); tapStarts.current.delete(event.pointerId); }}>
      <img draggable={false} src={image.src} alt={image.alt} style={{ ...image.presentation, transform: `translate(${pan.x}px,${pan.y}px) scale(${zoom/100})` }} />
    </div>
    <footer><output aria-label="Image zoom">{Math.round(zoom)}%</output><button type="button" onClick={fit}>Fit</button>{image.liveBlock?.isConnected && <button type="button" onClick={editSource}>Edit source</button>}{image.owner && <><button type="button" onClick={() => edit("replace")}>Replace</button><button type="button" onClick={() => edit("remove")}>Remove</button></>}</footer>
  </section>;
}
