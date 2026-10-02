import { useEffect, useRef, useState } from "react";

export default function ImageViewer() {
  const [image, setImage] = useState<{ src: string; alt: string; owner: HTMLElement | null } | null>(null);
  const [zoom, setZoom] = useState(100), [pan, setPan] = useState({ x: 0, y: 0 });
  const pointers = useRef(new Map<number, { x: number; y: number }>()), gesture = useRef({ distance: 0, zoom: 100 });
  const zoomRef = useRef(zoom); zoomRef.current = zoom;
  const canvas = useRef<HTMLDivElement>(null);
  const scale = (value: number) => { zoomRef.current = Math.max(25, Math.min(800, value)); setZoom(zoomRef.current); };
  useEffect(() => {
    const open = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target.closest<HTMLImageElement>(".markdown-body img") : null;
      if (!target?.currentSrc) return;
      event.preventDefault(); event.stopImmediatePropagation();
      setImage({ src: target.currentSrc, alt: target.alt || "Image", owner: target.closest("[data-note-image-source]") }); setZoom(100); setPan({ x: 0, y: 0 });
    };
    document.addEventListener("click", open, true);
    return () => document.removeEventListener("click", open, true);
  }, []);
  useEffect(() => {
    if (!image) return;
    const previous = document.activeElement as HTMLElement | null;
    document.querySelector<HTMLElement>(".image-viewer button")?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.stopImmediatePropagation(); setImage(null); }
      if ((event.ctrlKey || event.metaKey) && ["+", "=", "-", "0"].includes(event.key)) { event.preventDefault(); event.stopImmediatePropagation(); scale(event.key === "0" ? 100 : zoomRef.current + (event.key === "-" ? -10 : 10)); }
      if (event.key === "Tab") { const controls = Array.from(document.querySelectorAll<HTMLElement>(".image-viewer button,.image-viewer input")); if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1)?.focus(); } else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0]?.focus(); } }
    };
    const native = (event: Event) => { scale(zoomRef.current * (event as CustomEvent<number>).detail); };
    const reset = () => { scale(100); setPan({x:0,y:0}); };
    const wheel = (event: WheelEvent) => { event.preventDefault(); event.stopPropagation(); scale(zoomRef.current*Math.exp(-event.deltaY*.002)); };
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
      if (pointers.current.size === 2) { const [a, b] = [...pointers.current.values()]; gesture.current = { distance: Math.hypot(a.x-b.x, a.y-b.y), zoom }; }
    }} onPointerMove={event => {
      const old = pointers.current.get(event.pointerId); if (!old) return;
      pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pointers.current.size === 2) { const [a,b] = [...pointers.current.values()]; if (gesture.current.distance) scale(gesture.current.zoom * Math.hypot(a.x-b.x,a.y-b.y) / gesture.current.distance); }
      else setPan(current => ({ x: current.x + event.clientX-old.x, y: current.y + event.clientY-old.y }));
    }} onPointerUp={event => pointers.current.delete(event.pointerId)} onPointerCancel={event => pointers.current.delete(event.pointerId)}>
      <img draggable={false} src={image.src} alt={image.alt} style={{ transform: `translate(${pan.x}px,${pan.y}px) scale(${zoom/100})` }} />
    </div>
    <footer><label>Image zoom <input aria-label="Image zoom" type="range" min={25} max={800} value={zoom} onChange={event => scale(Number(event.target.value))} /></label><span>{Math.round(zoom)}%</span><button onClick={() => { setZoom(100); setPan({x:0,y:0}); }}>Fit image</button>{image.owner && <><button onClick={() => edit("replace")}>Replace</button><button onClick={() => edit("remove")}>Remove</button></>}</footer>
  </section>;
}
