import { useEffect, useRef, useState } from "react";
import { zoomTranslation, type Point } from "../focalZoom";
import { setReaderOverlay } from "../readerOverlays";
import { MaterialSlider } from "./MaterialControls";

export default function ImageViewer() {
  const [image, setImage] = useState<{ src: string; alt: string; owner: HTMLElement | null } | null>(null);
  const [zoom, setZoom] = useState(100), [pan, setPan] = useState({ x: 0, y: 0 });
  const pointers = useRef(new Map<number, Point>()), gesture = useRef({ distance: 0, center: {x:0,y:0} });
  const zoomRef = useRef(zoom); zoomRef.current = zoom;
  const panRef = useRef(pan); panRef.current = pan;
  const canvas = useRef<HTMLDivElement>(null);
  const translate = (next: Point) => { panRef.current = next; setPan(next); };
  const scale = (value: number, focus?: Point) => {
    const bounds = canvas.current?.getBoundingClientRect();
    const next = Math.max(25, Math.min(800, value));
    if (bounds) { const origin = {x:bounds.left+bounds.width/2,y:bounds.top+bounds.height/2}; translate(zoomTranslation(panRef.current,origin,focus || origin,zoomRef.current,next)); }
    zoomRef.current = next; setZoom(next);
  };
  const fit = () => { zoomRef.current = 100; setZoom(100); translate({x:0,y:0}); };
  useEffect(() => {
    const open = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target.closest<HTMLImageElement>(".markdown-body img") : null;
      if (!target?.currentSrc) return;
      event.preventDefault(); event.stopImmediatePropagation();
      setImage({ src: target.currentSrc, alt: target.alt || "Image", owner: target.closest("[data-note-image-source]") }); fit();
    };
    document.addEventListener("click", open, true);
    return () => document.removeEventListener("click", open, true);
  }, []);
  useEffect(() => { setReaderOverlay("image",!!image);return()=>setReaderOverlay("image",false); }, [!!image]);
  useEffect(() => {
    if (!image) return;
    const previous = document.activeElement as HTMLElement | null;
    document.querySelector<HTMLElement>(".image-viewer button")?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); setImage(null); }
      if ((event.ctrlKey || event.metaKey) && ["+", "=", "-", "0"].includes(event.key)) { event.preventDefault(); event.stopImmediatePropagation(); scale(event.key === "0" ? 100 : zoomRef.current + (event.key === "-" ? -10 : 10)); }
      if (event.key === "Tab") { const controls = Array.from(document.querySelectorAll<HTMLElement>(".image-viewer button,.image-viewer smd-slider")); const active = document.activeElement; if (event.shiftKey && active === controls[0]) { event.preventDefault(); controls.at(-1)?.focus(); } else if (!event.shiftKey && active === controls.at(-1)) { event.preventDefault(); controls[0]?.focus(); } }
    };
    const native = (event: Event) => { const detail = (event as CustomEvent<number | {factor:number;point?:Point}>).detail; scale(zoomRef.current * (typeof detail === "number" ? detail : detail.factor), typeof detail === "number" ? undefined : detail.point); };
    const reset = fit;
    const wheel = (event: WheelEvent) => { event.preventDefault(); event.stopPropagation(); scale(zoomRef.current*Math.exp(-event.deltaY*.002),{x:event.clientX,y:event.clientY}); };
    const surface = canvas.current;
    surface?.addEventListener("wheel",wheel,{passive:false});
    document.addEventListener("keydown", key, true); window.addEventListener("supermd-image-zoom", native);
    window.addEventListener("supermd-image-reset",reset);
    return () => { surface?.removeEventListener("wheel",wheel); window.removeEventListener("supermd-image-reset",reset); document.removeEventListener("keydown", key, true); window.removeEventListener("supermd-image-zoom", native); previous?.focus({ preventScroll: true }); pointers.current.clear(); };
  }, [image]);
  if (!image) return null;
  const edit = (action: string) => { if (image.owner) window.dispatchEvent(new CustomEvent("supermd-image-edit", { detail: { action, image: image.owner } })); setImage(null); };
  return <section className="image-viewer" data-independent-zoom role="dialog" aria-modal="true" aria-label="Image viewer">
    <header><strong>{image.alt}</strong><button onClick={() => setImage(null)} aria-label="Close image viewer">Close</button></header>
    <div className="image-viewer-canvas" ref={canvas} onPointerDown={event => {
      event.currentTarget.setPointerCapture(event.pointerId); pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pointers.current.size === 2) { const [a, b] = [...pointers.current.values()]; gesture.current = { distance: Math.hypot(a.x-b.x, a.y-b.y), center: {x:(a.x+b.x)/2,y:(a.y+b.y)/2} }; }
    }} onPointerMove={event => {
      const old = pointers.current.get(event.pointerId); if (!old) return;
      pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pointers.current.size === 2) { const [a,b] = [...pointers.current.values()], center={x:(a.x+b.x)/2,y:(a.y+b.y)/2}, distance=Math.hypot(a.x-b.x,a.y-b.y); if (gesture.current.distance) { scale(zoomRef.current * distance / gesture.current.distance, gesture.current.center); translate({x:panRef.current.x+center.x-gesture.current.center.x,y:panRef.current.y+center.y-gesture.current.center.y}); } gesture.current={distance,center}; }
      else translate({ x: panRef.current.x + event.clientX-old.x, y: panRef.current.y + event.clientY-old.y });
    }} onPointerUp={event => pointers.current.delete(event.pointerId)} onPointerCancel={event => pointers.current.delete(event.pointerId)}>
      <img draggable={false} src={image.src} alt={image.alt} style={{ transform: `translate(${pan.x}px,${pan.y}px) scale(${zoom/100})` }} />
    </div>
    <footer><div className="image-zoom-control"><span>Zoom</span><MaterialSlider label="Image zoom" min={25} max={800} value={zoom} onChange={scale} motion={document.documentElement.dataset.motion !== "off"}/><output>{Math.round(zoom)}%</output></div><button onClick={fit}>Fit image</button>{image.owner && <><button onClick={() => edit("replace")}>Replace</button><button onClick={() => edit("remove")}>Remove</button></>}</footer>
  </section>;
}
