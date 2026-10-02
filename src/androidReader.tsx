import { createRoot } from "react-dom/client";
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import "@fontsource-variable/manrope";
import "@fontsource-variable/jetbrains-mono";
import "@fontsource-variable/roboto";
import "@fontsource-variable/noto-serif";
import "katex/dist/katex.min.css";
import "highlight.js/styles/github-dark.css";
import "./styles.css";
import "./androidReader.css";
import Editor from "./components/Editor";
import LiveEditor from "./components/LiveEditor";
import MarkdownPreview from "./components/MarkdownPreview";
import { invoke } from "./nativeBridge";
import { preparePdf } from "./preparePdf";
import type { ExportOptions } from "./types";
import { clampPreviewZoom } from "./zoom";
import MediaTools from "./components/MediaTools";
import { prepareFmd } from "./documentMedia";
import ImageViewer from "./components/ImageViewer";
import MathRepairPanel from "./components/MathRepairPanel";
import { captureScrollAnchor } from "./scrollAnchor";
const DocumentPreview = memo(MarkdownPreview);
const LiveDocument = memo(LiveEditor);
const SourceEditor = memo(Editor);

interface ReaderState { id: string; content: string; path: string | null; mode: "live" | "editor" | "reader" | "split"; dark: boolean; fullscreen: boolean; font: string; size: number; width?: number; colors: Record<string, string>; zoom: number; motion?: boolean; python?: string }
declare global { interface Window { supermdLoad?: (state: ReaderState) => void; supermdExport?: (options: ExportOptions) => void; supermdFind?: () => void; supermdPortable?: (save: boolean) => void; supermdZoomBy?: (factor:number)=>void; supermdResetZoom?: ()=>void; supermdRepairMath?: ()=>void; supermdFlush?: (operation:Record<string,string>)=>void } }
function Reader() {
  const [state, setState] = useState<ReaderState | null>(null);
  const [zoom, setZoom] = useState(100);
  const [repairing, setRepairing] = useState(false);
  const [trustedHosts,setTrustedHosts] = useState<string[]>([]);
  const trustHost = useCallback((host:string)=>setTrustedHosts(current=>current.includes(host)?current:[...current,host]),[]);
  const reference = useRef(state); reference.current = state;
  const zoomReference = useRef(zoom);
  const pendingChange = useRef(0);
  const anchors = () => Array.from(document.querySelectorAll<HTMLElement>(".android-reading,.cm-scroller")).map(captureScrollAnchor);
  const anchored = (update:()=>void) => { const restore = anchors(); update(); requestAnimationFrame(()=>restore.forEach(callback=>callback())); };
  useEffect(() => {
    window.supermdLoad = (next) => { const old = reference.current; const load = () => { setState(next); zoomReference.current = next.zoom; setZoom(next.zoom); }; if (old?.id === next.id && old.mode === next.mode) anchored(load); else load(); };
    window.supermdZoomBy = (factor) => { if (document.querySelector(".image-viewer")) { window.dispatchEvent(new CustomEvent("supermd-image-zoom",{detail:factor})); return; } anchored(()=> { zoomReference.current = clampPreviewZoom(zoomReference.current*factor); document.documentElement.style.setProperty("--workspace-scale",String(zoomReference.current/100)); setZoom(zoomReference.current); }); void invoke("zoom_changed",{zoom:zoomReference.current}); };
    window.supermdResetZoom = () => { if (document.querySelector(".image-viewer")) { window.dispatchEvent(new Event("supermd-image-reset")); return; } window.supermdZoomBy?.(100/zoomReference.current); };
    window.supermdRepairMath = () => setRepairing(true);
    window.supermdFlush = operation => { const current = reference.current; if(current) void invoke("document_flushed",{id:current.id,content:current.content,operation}); };
    window.supermdFind = () => requestAnimationFrame(()=>window.dispatchEvent(new Event("supermd-find")));
    window.supermdPortable = async (save) => {
      const current = reference.current; if (!current) return;
      try { const prepared = await prepareFmd(current.content, current.path); await invoke("export_fmd_native", { ...prepared, originalContent: current.content, id: current.id, save }); }
      catch (error) { await invoke("export_failed", { error: String(error) }); }
    };
    window.supermdExport = async (options) => {
      const current = reference.current; if (!current) return;
      try { const prepared = await preparePdf(current.content, current.path); await invoke("export_pdf_native", { ...prepared, options, id: current.id }); }
      catch (error) { await invoke("export_failed", { error: String(error) }); }
    };
    void invoke("reader_ready");
    return () => { delete window.supermdLoad; delete window.supermdExport; delete window.supermdPortable; delete window.supermdZoomBy; delete window.supermdResetZoom; delete window.supermdRepairMath; delete window.supermdFlush; };
  }, []);
  useLayoutEffect(() => {
    if (!state) return;
    const root = document.documentElement; root.dataset.theme = state.dark ? "dark" : "light"; root.dataset.motion = state.motion === false ? "off" : "on";
    root.style.setProperty("--reader-size", `${state.size}px`);
    const fonts: Record<string,string> = {sans:"'Manrope Variable', sans-serif",serif:"'Noto Serif Variable', Georgia, serif",mono:"'JetBrains Mono Variable', monospace",Manrope:"'Manrope Variable',sans-serif","JetBrains Mono":"'JetBrains Mono Variable',monospace","Noto Sans":"'Noto Sans',sans-serif","Noto Serif":"'Noto Serif Variable',serif",Roboto:"'Roboto Variable',sans-serif",roboto:"'Roboto Variable',sans-serif",noto:"'Noto Sans',sans-serif",system:"system-ui,sans-serif"};
    root.style.setProperty("--reader-font",fonts[state.font] || `${JSON.stringify(state.font)}, sans-serif`);
    root.style.setProperty("--reader-width",state.width ? `${state.width}px` : "100%");
    root.style.setProperty("--reading-max-width",state.width ? `${state.width}px` : "none");
    root.style.setProperty("--workspace-scale", String(zoom / 100));
    Object.entries(state.colors).forEach(([key, value]) => root.style.setProperty(`--${key}`, value));
  }, [state, zoom]);
  useEffect(() => {
    let startDistance = 0, startZoom = 100, pinching = false, frame = 0;
    const distance = (touches: TouchList) => Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
    const start = (event: TouchEvent) => { if (event.touches.length === 2 && !(event.target as Element).closest("input,[data-independent-zoom]")) { startDistance = distance(event.touches); startZoom = zoomReference.current; pinching = true; } };
    const move = (event: TouchEvent) => { if (event.touches.length === 2 && pinching && startDistance > 0) {
      event.preventDefault(); zoomReference.current = clampPreviewZoom(startZoom * distance(event.touches) / startDistance);
      // Coalesce input to one visual update per frame. Parsing Markdown and
      // crossing the native bridge are deliberately excluded from pinch frames.
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; const restore = anchors(); document.documentElement.style.setProperty("--workspace-scale", String(zoomReference.current / 100)); restore.forEach(callback=>callback()); });
    } };
    const end = (event: TouchEvent) => { if (pinching && event.touches.length < 2) { pinching = false; setZoom(zoomReference.current); void invoke("zoom_changed", { zoom: zoomReference.current }); } };
    document.addEventListener("touchstart", start, { passive: true }); document.addEventListener("touchmove", move, { passive: false }); document.addEventListener("touchend", end); document.addEventListener("touchcancel", end);
    const wheel = (event:WheelEvent) => { if ((event.ctrlKey || event.metaKey) && !(event.target as Element).closest("[data-independent-zoom]")) { event.preventDefault(); window.supermdZoomBy?.(Math.exp(-event.deltaY*.002)); } };
    document.addEventListener("wheel",wheel,{passive:false});
    return () => { cancelAnimationFrame(frame); document.removeEventListener("wheel",wheel); document.removeEventListener("touchstart", start); document.removeEventListener("touchmove", move); document.removeEventListener("touchend", end); document.removeEventListener("touchcancel", end); };
  }, []);
  const update = useCallback((content: string) => {
    const next = { ...reference.current!, content }; setState(next); reference.current = next;
    // The bridge receives every edit immediately, so closing/rotating cannot lose
    // a pending debounced WebView update. Disk snapshots are debounced natively.
    window.clearTimeout(pendingChange.current);
    void invoke("document_changed", { id: next.id, content });
  }, []);
  if (!state) return <div className="reader-loading">Opening your workspace…</div>;
  return <div className={`android-document mode-${state.mode}`}>
    <ImageViewer />
    {repairing && <MathRepairPanel content={state.content} apply={update} close={()=>setRepairing(false)} />}
    <MediaTools key={state.id} documentId={state.id} content={state.content} documentPath={state.path} onInsert={(text, point) => { const content = reference.current!.content; const from = Math.min(point?.from ?? content.length, content.length); const to = Math.max(from, Math.min(point?.to ?? from, content.length)); update(content.slice(0, from) + text + content.slice(to)); }} onNotice={(error) => { void invoke("export_failed", { error }); }} />
    {(state.mode === "editor" || state.mode === "split") && <section className="android-source"><SourceEditor key={state.id} sessionId={state.id} value={state.content} onChange={update} dark={state.dark} focusMode={state.fullscreen} /></section>}
    {state.mode === "live" && <section className="android-reading"><LiveDocument key={state.id} markdown={state.content} onChange={update} documentPath={state.path} python={state.python || "embedded"} dark={state.dark} trustedImageHosts={trustedHosts} onTrustImageHost={trustHost} /></section>}
    {(state.mode === "reader" || state.mode === "split") && <section className="android-reading"><DocumentPreview markdown={state.content} documentPath={state.path} python={state.python || "embedded"} dark={state.dark} trustedImageHosts={trustedHosts} onTrustImageHost={trustHost} /></section>}
  </div>;
}
createRoot(document.getElementById("root")!).render(<Reader />);
