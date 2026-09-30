import { createRoot } from "react-dom/client";
import { useEffect, useRef, useState } from "react";
import "@fontsource-variable/manrope";
import "@fontsource-variable/jetbrains-mono";
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

interface ReaderState { id: string; content: string; path: string | null; mode: "live" | "editor" | "reader" | "split"; dark: boolean; fullscreen: boolean; font: string; size: number; colors: Record<string, string>; zoom: number; motion?: boolean }
declare global { interface Window { supermdLoad?: (state: ReaderState) => void; supermdExport?: (options: ExportOptions) => void; supermdFind?: () => void } }
function Reader() {
  const [state, setState] = useState<ReaderState | null>(null);
  const [zoom, setZoom] = useState(100);
  const reference = useRef(state); reference.current = state;
  const zoomReference = useRef(zoom); zoomReference.current = zoom;
  const pendingChange = useRef(0);
  useEffect(() => {
    window.supermdLoad = (next) => { setState(next); setZoom(next.zoom); };
    window.supermdFind = () => window.dispatchEvent(new Event("supermd-find"));
    window.supermdExport = async (options) => {
      const current = reference.current; if (!current) return;
      try { const prepared = await preparePdf(current.content, current.path); await invoke("export_pdf_native", { ...prepared, options }); }
      catch (error) { await invoke("export_failed", { error: String(error) }); }
    };
    void invoke("reader_ready");
    return () => { delete window.supermdLoad; delete window.supermdExport; };
  }, []);
  useEffect(() => {
    if (!state) return;
    const root = document.documentElement; root.dataset.theme = state.dark ? "dark" : "light"; root.dataset.motion = state.motion === false ? "off" : "on";
    root.style.setProperty("--reader-size", `${state.size}px`);
    root.style.setProperty("--reader-font", state.font === "serif" ? "Georgia, serif" : state.font === "mono" ? "'JetBrains Mono Variable', monospace" : "'Manrope Variable', sans-serif");
    root.style.setProperty("--workspace-scale", String(zoom / 100));
    Object.entries(state.colors).forEach(([key, value]) => root.style.setProperty(`--${key}`, value));
  }, [state, zoom]);
  useEffect(() => {
    let startDistance = 0, startZoom = 100, pinching = false;
    const distance = (touches: TouchList) => Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
    const start = (event: TouchEvent) => { if (event.touches.length === 2 && !(event.target as Element).closest("input")) { startDistance = distance(event.touches); startZoom = zoomReference.current; pinching = true; } };
    const move = (event: TouchEvent) => { if (event.touches.length === 2 && pinching && startDistance > 0) { event.preventDefault(); setZoom(clampPreviewZoom(startZoom * distance(event.touches) / startDistance)); } };
    const end = () => { if (pinching) { pinching = false; void invoke("zoom_changed", { zoom: zoomReference.current }); } };
    document.addEventListener("touchstart", start, { passive: true }); document.addEventListener("touchmove", move, { passive: false }); document.addEventListener("touchend", end);
    return () => { document.removeEventListener("touchstart", start); document.removeEventListener("touchmove", move); document.removeEventListener("touchend", end); };
  }, []);
  if (!state) return <div className="reader-loading">Opening your workspace…</div>;
  const update = (content: string) => {
    const next = { ...reference.current!, content }; setState(next); reference.current = next;
    // The bridge receives every edit immediately, so closing/rotating cannot lose
    // a pending debounced WebView update. Disk snapshots are debounced natively.
    window.clearTimeout(pendingChange.current);
    void invoke("document_changed", { id: next.id, content });
  };
  return <div className={`android-document mode-${state.mode}`}>
    {(state.mode === "editor" || state.mode === "split") && <section className="android-source"><Editor key={state.id} sessionId={state.id} value={state.content} onChange={update} dark={state.dark} focusMode={state.fullscreen} /></section>}
    {state.mode === "live" && <section className="android-reading"><LiveEditor key={state.id} markdown={state.content} onChange={update} documentPath={state.path} python="embedded" dark={state.dark} /></section>}
    {(state.mode === "reader" || state.mode === "split") && <section className="android-reading"><MarkdownPreview markdown={state.content} documentPath={state.path} python="embedded" dark={state.dark} /></section>}
  </div>;
}
createRoot(document.getElementById("root")!).render(<Reader />);
