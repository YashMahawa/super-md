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
import Editor, { editorHistory, exportEditorSession, importEditorSession, type PortableEditorSession } from "./components/Editor";
import { exportRenderedViews, importRenderedViews } from "./renderedOutputs";
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
import ReadingSearch from "./components/ReadingSearch";
import type { Point } from "./focalZoom";
import { applyDocumentZoom } from "./documentZoom";
import { documentOutline, navigateToHeading } from "./documentNavigation";
const DocumentPreview = memo(MarkdownPreview);
const LiveDocument = memo(LiveEditor);
const SourceEditor = memo(Editor);

type NoteHistory = {undo:string[];redo:string[];last:number};
interface NoteView { editor?: PortableEditorSession; history?:NoteHistory; top?: number; rendered?: ReturnType<typeof exportRenderedViews> }
interface ReaderState { id: string; content: string; path: string | null; mode: "live" | "editor" | "reader" | "split"; dark: boolean; fullscreen: boolean; font: string; size: number; width?: number; widthPercent?:number; lineHeight?:number; colors: Record<string, string>; zoom: number; motion?: boolean; python?: string; viewState?: NoteView }
declare global { interface Window {supermdDismiss?:()=>boolean;supermdSetZoom?:(zoom:number)=>void;supermdHeading?:(id:string,offset?:number)=>void;supermdHistory?:(direction:"undo"|"redo")=>void;supermdNativeWheel?:(dx:number,dy:number,point:Point,held:boolean)=>void;} }
declare global { interface Window { supermdLoad?: (state: ReaderState) => void; supermdExport?: (options: ExportOptions) => void; supermdExportMarkdown?: () => void; supermdFind?: () => void; supermdPortable?: (save: boolean) => void; supermdZoomBy?: (factor:number,focus?:Point)=>void; supermdResetZoom?: ()=>void; supermdRepairMath?: ()=>void; supermdFlush?: (operation:Record<string,string>)=>void } }
function Reader() {
  const [state, setState] = useState<ReaderState | null>(null);
  const [repairing, setRepairing] = useState(false);
  const [searching,setSearching] = useState(false);
  const [trustedHosts,setTrustedHosts] = useState<string[]>([]);
  const trustHost = useCallback((host:string)=>setTrustedHosts(current=>current.includes(host)?current:[...current,host]),[]);
  const reference = useRef(state); reference.current = state;
  const zoomReference = useRef(100);
  const pendingChange = useRef(0);
  const noteViews = useRef(new Map<string, NoteView>());
  const histories=useRef(new Map<string,NoteHistory>());
  const replaying=useRef(false);
  const loadedFonts=useRef(new Map<string,Promise<FontFace>>());
  const cursor=useRef<Point|undefined>(undefined);
  const anchors = (focus?:Point) => Array.from(document.querySelectorAll<HTMLElement>(".android-reading,.cm-scroller")).filter(root=>{const r=root.getBoundingClientRect();return !focus || focus.x>=r.left&&focus.x<=r.right&&focus.y>=r.top&&focus.y<=r.bottom;}).map(root=>captureScrollAnchor(root,focus));
  const applyZoomStyle=(focus?:Point,previousFocus=focus)=>{document.querySelector<HTMLElement>(".android-source")?.style.setProperty("--workspace-scale",String(zoomReference.current/100));document.querySelectorAll<HTMLElement>(".android-reading").forEach(root=>applyDocumentZoom(root,zoomReference.current,reference.current?.widthPercent??80,focus,previousFocus));};
  const anchored = (update:()=>void) => { const restore = anchors(); update(); requestAnimationFrame(()=>restore.forEach(callback=>callback())); };
  useEffect(() => {
    window.supermdDismiss=()=>{const element=document.querySelector(".image-viewer,.math-repair-panel,.reading-search,.cm-search,.live-active-block textarea");if(!element)return false;const target=element.matches("textarea")?element:document.activeElement||document;target.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}));if(element.matches("textarea"))(element as HTMLElement).blur();return true;};
    window.supermdLoad = (next) => {
      const old = reference.current;
      if (old && old.id !== next.id) {
        noteViews.current.set(old.id, {top: document.querySelector<HTMLElement>(".android-reading")?.scrollTop ?? 0});
        if (noteViews.current.size > 40) noteViews.current.delete(noteViews.current.keys().next().value!);
      }
      if (next.viewState && old?.id !== next.id) {
        importEditorSession(next.id, next.viewState.editor);
        importRenderedViews(next.content, next.viewState.rendered);
        const history=next.viewState.history;
        if(history && [history.undo,history.redo].every(list=>Array.isArray(list)&&list.length<=60&&list.every(text=>typeof text==="string")&&list.reduce((size,text)=>size+text.length,0)<=2_000_000))histories.current.set(next.id,{undo:[...history.undo],redo:[...history.redo],last:0});
        noteViews.current.set(next.id, next.viewState);
      }
      const load = () => { setState(next); zoomReference.current = next.zoom; };
      if (old?.id === next.id && old.mode === next.mode) anchored(load); else load();
    };
    window.supermdHistory=direction=>{
      const current=reference.current;if(!current)return;
      replaying.current=true;
      if(current.mode==="editor" || current.mode==="split") editorHistory(current.id,direction);
      else {const history=histories.current.get(current.id);if(history){const from=history[direction],to=history[direction==="undo"?"redo":"undo"],next=from.pop();if(next!==undefined){to.push(current.content);history.last=0;update(next);}}}
      replaying.current=false;
    };
    window.supermdZoomBy = (factor,focus=cursor.current) => { if (document.querySelector(".image-viewer")) { window.dispatchEvent(new CustomEvent("supermd-image-zoom",{detail:{factor,point:focus}})); return; } zoomReference.current=clampPreviewZoom(zoomReference.current*factor);applyZoomStyle(focus);void invoke("zoom_changed",{zoom:zoomReference.current}); };
    window.supermdSetZoom=value=>{const next=clampPreviewZoom(value);if(Math.abs(next-zoomReference.current)<.01)return;zoomReference.current=next;applyZoomStyle();};
    window.supermdHeading=(id,offset)=>{if(reference.current?.mode==="editor"){window.dispatchEvent(new CustomEvent("supermd-goto-offset",{detail:offset??0}));return;}const root=document.querySelector(".android-reading");if(root)navigateToHeading(root,id);};
    window.supermdResetZoom = () => { if (document.querySelector(".image-viewer")) { window.dispatchEvent(new Event("supermd-image-reset")); return; } window.supermdZoomBy?.(100/zoomReference.current); };
    window.supermdRepairMath = () => setRepairing(true);
    window.supermdNativeWheel=(dx,dy,point,held)=>{
      const target=document.elementFromPoint(point.x,point.y),canvas=target?.closest(".interactive-chart svg,.image-viewer-canvas");
      if(held){if(canvas?.matches("svg"))canvas.dispatchEvent(new WheelEvent("wheel",{bubbles:true,cancelable:true,ctrlKey:true,deltaY:dy,clientX:point.x,clientY:point.y}));else window.supermdZoomBy?.(Math.exp(-dy*.002),point);return;}
      if(canvas){canvas.dispatchEvent(new CustomEvent("supermd-canvas-pan",{detail:{dx,dy},cancelable:true}));return;}
      const scroller=target?.closest<HTMLElement>(".android-reading,.cm-scroller,.image-viewer-canvas,.math-repair-list,.media-dialog");
      scroller?.scrollBy({left:dx,top:dy,behavior:"instant"});
    };
    window.supermdFlush = operation => {
      const current = reference.current; if (!current) return;
      let id = current.id;
      if (operation.action === "move_tab") { try { id = JSON.parse(operation.target).tab; } catch { return; } }
      else if (operation.action === "detach_tab") id = operation.target;
      const view = operation.action === "move_tab" || operation.action === "detach_tab" ? {editor:exportEditorSession(id),history:histories.current.get(id), ...(id === current.id ? {top:document.querySelector<HTMLElement>(".android-reading")?.scrollTop ?? 0,rendered:exportRenderedViews(current.content)} : noteViews.current.get(id))} : undefined;
      void invoke("document_flushed",{id:current.id,content:current.content,operation,viewId:id,viewState:view});
    };
    window.supermdFind = () => { if(reference.current?.mode==="editor" || reference.current?.mode==="split") requestAnimationFrame(()=>window.dispatchEvent(new Event("supermd-find")));else setSearching(true); };
    window.supermdPortable = async (save) => {
      const current = reference.current; if (!current) return;
      try { const prepared = await prepareFmd(current.content, current.path); await invoke("export_fmd_native", { ...prepared, originalContent: current.content, id: current.id, save }); }
      catch (error) { await invoke("export_failed", { error: String(error) }); }
    };
    window.supermdExport = async (options) => {
      const current = reference.current; if (!current) return;
      try { const prepared = await preparePdf(current.content, current.path); await invoke("export_pdf_native", { ...prepared, options: {...options, themeAccent: current.colors.primary}, id: current.id }); }
      catch (error) { await invoke("export_failed", { error: String(error) }); }
    };
    window.supermdExportMarkdown = async () => {
      const current = reference.current; if (!current) return;
      try { await invoke("export_markdown_native", {id: current.id, content: current.content}); }
      catch (error) { await invoke("export_failed", {error: String(error)}); }
    };
    void invoke("reader_ready");
    return () => { delete window.supermdLoad; delete window.supermdExport; delete window.supermdExportMarkdown; delete window.supermdPortable; delete window.supermdZoomBy; delete window.supermdResetZoom; delete window.supermdRepairMath; delete window.supermdFlush; delete window.supermdSetZoom; delete window.supermdHeading; };
  }, []);
  useEffect(()=>{if(state)void invoke("document_outline",{id:state.id,headings:documentOutline(state.content)}).catch(()=>{});},[state?.id,state?.content]);
  useLayoutEffect(() => {
    if (!state) return;
    const root = document.documentElement; root.dataset.theme = state.dark ? "dark" : "light"; root.dataset.motion = state.motion === false ? "off" : "on";
    root.style.setProperty("--reader-size", `${state.size}px`);
    root.style.setProperty("--editor-size", `${Math.max(12, Math.min(24, state.size - 2))}px`);
    const fonts: Record<string,string> = {sans:"Manrope,'Manrope Variable', sans-serif",serif:"'Noto Serif','Noto Serif Variable', Georgia, serif",mono:"'JetBrains Mono','JetBrains Mono Variable', monospace",Manrope:"Manrope,'Manrope Variable',sans-serif","JetBrains Mono":"'JetBrains Mono','JetBrains Mono Variable',monospace","Noto Sans":"'Noto Sans',sans-serif","Noto Serif":"'Noto Serif','Noto Serif Variable',serif",Roboto:"Roboto,'Roboto Variable',sans-serif",roboto:"Roboto,'Roboto Variable',sans-serif",noto:"'Noto Sans',sans-serif",system:"system-ui,sans-serif"};
    root.style.setProperty("--reader-font",fonts[state.font] || `${JSON.stringify(state.font)}, sans-serif`);
    root.style.setProperty("--reader-width",`${state.widthPercent??80}%`);
    root.style.setProperty("--reading-max-width",`${state.widthPercent??80}%`);
    root.style.setProperty("--reader-leading",String(state.lineHeight??1.65));
    Object.entries(state.colors).forEach(([key, value]) => root.style.setProperty(`--${key}`, value));
    applyZoomStyle();
  }, [state]);
  useEffect(()=>{const root=document.querySelector<HTMLElement>(".android-reading");if(!root || typeof ResizeObserver==="undefined")return;let frame=0;const observer=new ResizeObserver(()=>{if(!frame)frame=requestAnimationFrame(()=>{frame=0;applyZoomStyle();});});observer.observe(root);const page=root.querySelector(".document-page");if(page)observer.observe(page);return()=>{observer.disconnect();cancelAnimationFrame(frame);};},[state?.id,state?.mode]);
  useEffect(()=>{
    if(!state || ["sans","serif","mono","noto","roboto","system","Manrope","Roboto","Noto Sans","Noto Serif","JetBrains Mono"].includes(state.font) || !window.SuperMD || typeof FontFace==="undefined")return;
    const family=state.font;
    if(!loadedFonts.current.has(family)){
      const loading=invoke<{family:string;data:string}>("load_font",{family}).then(async value=>{const face=new FontFace(value.family,`url(${value.data})`);await face.load();const restore=anchors();document.fonts.add(face);restore.forEach(callback=>callback());return face;});
      loadedFonts.current.set(family,loading);void loading.catch(()=>loadedFonts.current.delete(family));
      while(loadedFonts.current.size>6){const oldest=loadedFonts.current.keys().next().value!;const cached=loadedFonts.current.get(oldest)!;loadedFonts.current.delete(oldest);void cached.then(face=>{if(reference.current?.font!==oldest)document.fonts.delete(face);}).catch(()=>{});}
    }
  },[state]);
  useLayoutEffect(() => {
    if (!state) return;
    const top = noteViews.current.get(state.id)?.top;
    if (typeof top === "number" && Number.isFinite(top)) {
      const host = document.querySelector<HTMLElement>(".android-reading");
      if (host) host.scrollTop = Math.max(0, top);
    }
  }, [state?.id, state?.mode]);
  useEffect(() => {
    const find=(event:KeyboardEvent)=>{if((event.ctrlKey || event.metaKey) && event.key.toLowerCase()==="f" && reference.current?.mode!=="editor" && reference.current?.mode!=="split"){event.preventDefault();setSearching(true);}};
    const history=(event:KeyboardEvent)=>{
      if(!(event.ctrlKey||event.metaKey)||event.altKey)return;
      const key=event.key.toLowerCase();if(key!=="z"&&key!=="y")return;
      if(document.querySelector(".image-viewer,.math-repair-panel,.reading-search,.media-dialog"))return;
      // Leave a Live textarea's native editing history intact; Source and Read
      // route through the same bounded note history on hardware keyboards.
      if(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)return;
      event.preventDefault();event.stopImmediatePropagation();window.supermdHistory?.(key==="y"||event.shiftKey?"redo":"undo");
    };
    document.addEventListener("keydown",find);
    document.addEventListener("keydown",history,true);
    return()=>{document.removeEventListener("keydown",find);document.removeEventListener("keydown",history,true);};
  },[]);
  useEffect(() => {
    let startDistance = 0, startZoom = 100, pinching = false, frame = 0,focus:Point|undefined,previousFocus:Point|undefined,mouseHeld=false;
    const track=(event:PointerEvent)=>{cursor.current={x:event.clientX,y:event.clientY};};
    let drag:{root:HTMLElement;point:Point;moved:boolean}|null=null;
    const down=(event:PointerEvent)=>{
      if(event.pointerType!=="mouse"||event.button!==0)return;mouseHeld=true;
      const target=event.target as Element,root=target.closest<HTMLElement>(".android-reading");
      if(root && (reference.current?.mode==="reader" || reference.current?.fullscreen) && !event.shiftKey && !target.closest("a,button,input,textarea,summary,img,.note-image,[data-independent-zoom]")){
        drag={root,point:{x:event.clientX,y:event.clientY},moved:false};root.setPointerCapture(event.pointerId);
      }
    };
    const pan=(event:PointerEvent)=>{if(!drag)return;const dx=event.clientX-drag.point.x,dy=event.clientY-drag.point.y;if(!drag.moved && Math.hypot(dx,dy)<4)return;drag.moved=true;drag.root.classList.add("is-panning");window.getSelection()?.removeAllRanges();drag.root.scrollLeft-=dx;drag.root.scrollTop-=dy;drag.point={x:event.clientX,y:event.clientY};event.preventDefault();};
    const up=()=>{mouseHeld=false;drag?.root.classList.remove("is-panning");drag=null;};
    document.addEventListener("pointermove",track);document.addEventListener("pointerdown",down);document.addEventListener("pointerup",up);window.addEventListener("blur",up);
    document.addEventListener("pointermove",pan);document.addEventListener("pointercancel",up);
    const distance = (touches: TouchList) => Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
    const start = (event: TouchEvent) => { if (event.touches.length === 2 && !(event.target as Element).closest("input,[data-independent-zoom]")) { startDistance = distance(event.touches); startZoom = zoomReference.current; pinching = true;previousFocus={x:(event.touches[0].clientX+event.touches[1].clientX)/2,y:(event.touches[0].clientY+event.touches[1].clientY)/2}; } };
    const move = (event: TouchEvent) => { if (event.touches.length === 2 && pinching && startDistance > 0) {
      event.preventDefault(); zoomReference.current = clampPreviewZoom(startZoom * distance(event.touches) / startDistance);
      focus={x:(event.touches[0].clientX+event.touches[1].clientX)/2,y:(event.touches[0].clientY+event.touches[1].clientY)/2};
      // Coalesce input to one visual update per frame. Parsing Markdown and
      // crossing the native bridge are deliberately excluded from pinch frames.
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; applyZoomStyle(focus,previousFocus);previousFocus=focus; });
    } };
    const end = (event: TouchEvent) => { if (pinching && event.touches.length < 2) { pinching = false; void invoke("zoom_changed", { zoom: zoomReference.current }); } };
    document.addEventListener("touchstart", start, { passive: true }); document.addEventListener("touchmove", move, { passive: false }); document.addEventListener("touchend", end); document.addEventListener("touchcancel", end);
    const wheel = (event:WheelEvent) => { if ((event.ctrlKey || event.metaKey || mouseHeld || event.buttons&1) && !(event.target as Element).closest("[data-independent-zoom]")) { event.preventDefault(); window.supermdZoomBy?.(Math.exp(-event.deltaY*.002),{x:event.clientX,y:event.clientY}); } };
    document.addEventListener("wheel",wheel,{passive:false});
    return () => { document.removeEventListener("pointermove",pan);document.removeEventListener("pointercancel",up);document.removeEventListener("pointermove",track);document.removeEventListener("pointerdown",down);document.removeEventListener("pointerup",up);window.removeEventListener("blur",up);cancelAnimationFrame(frame); document.removeEventListener("wheel",wheel); document.removeEventListener("touchstart", start); document.removeEventListener("touchmove", move); document.removeEventListener("touchend", end); document.removeEventListener("touchcancel", end); };
  }, []);
  const update = useCallback((content: string) => {
    const previous=reference.current!;
    if(content===previous.content)return;
    if(!replaying.current){
      const history=histories.current.get(previous.id)||{undo:[],redo:[],last:0},now=Date.now();
      if(now-history.last>600 || Math.abs(content.length-previous.content.length)>1 || !history.undo.length)history.undo.push(previous.content);
      history.redo=[];history.last=now;
      while(history.undo.length>60 || history.undo.reduce((size,text)=>size+text.length,0)>2_000_000)history.undo.shift();
      histories.current.delete(previous.id);histories.current.set(previous.id,history);
      let retained=[...histories.current.values()].reduce((size,h)=>size+[...h.undo,...h.redo].reduce((n,text)=>n+text.length,0),0);
      for(const [id,cached] of histories.current){if(histories.current.size<=40&&retained<=4_000_000)break;if(id===previous.id)continue;histories.current.delete(id);retained-=[...cached.undo,...cached.redo].reduce((n,text)=>n+text.length,0);}
    }
    const next = { ...reference.current!, content }; setState(next); reference.current = next;
    // The bridge receives every edit immediately, so closing/rotating cannot lose
    // a pending debounced WebView update. Disk snapshots are debounced natively.
    window.clearTimeout(pendingChange.current);
    void invoke("document_changed", { id: next.id, content });
  }, []);
  if (!state) return <div className="reader-loading">Opening your workspace…</div>;
  return <div className={`android-document mode-${state.mode}`}>
    {searching && (state.mode==="reader" || state.mode==="live") && <ReadingSearch content={state.content} close={()=>setSearching(false)}/>}
    <ImageViewer />
    {repairing && <MathRepairPanel content={state.content} apply={update} close={()=>setRepairing(false)} />}
    <MediaTools key={state.id} documentId={state.id} content={state.content} documentPath={state.path} onInsert={(text, point) => { const content = reference.current!.content; const from = Math.min(point?.from ?? content.length, content.length); const to = Math.max(from, Math.min(point?.to ?? from, content.length)); update(content.slice(0, from) + text + content.slice(to)); }} onNotice={(error) => { void invoke("export_failed", { error }); }} />
    {(state.mode === "editor" || state.mode === "split") && <section className="android-source"><SourceEditor key={state.id} sessionId={state.id} value={state.content} onChange={update} dark={state.dark} focusMode={state.fullscreen} /></section>}
    {state.mode === "live" && <section className="android-reading"><div className="document-page-space"><div className="document-page"><LiveDocument key={state.id} markdown={state.content} onChange={update} documentPath={state.path} python={state.python || "embedded"} dark={state.dark} trustedImageHosts={trustedHosts} onTrustImageHost={trustHost} /></div></div></section>}
    {(state.mode === "reader" || state.mode === "split") && <section className="android-reading"><div className="document-page-space"><div className="document-page"><DocumentPreview markdown={state.content} onChange={update} documentPath={state.path} python={state.python || "embedded"} dark={state.dark} trustedImageHosts={trustedHosts} onTrustImageHost={trustHost} /></div></div></section>}
  </div>;
}
createRoot(document.getElementById("root")!).render(<Reader />);
