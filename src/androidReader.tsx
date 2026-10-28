import { createRoot } from "react-dom/client";
import {flushSync} from 'react-dom';
import {createGapSelection,type GapSelection} from './gapSelection';
import {FrameScrollQueue,zoomFrameStep} from './frameMotion';
import {agentCharLength,agentOutline,agentRead,agentRevision,agentSearch,applyAgentPatches} from './agentOperations';
import {suggestMathRepairs,applyMathRepairs} from './mathRepair';
import {agentDiagrams,diagramMetadata,diagramMedia,visibleSourceRange} from './agentView';
import {mediaBytes} from './mediaExport';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import "@fontsource-variable/manrope";
import "@fontsource-variable/jetbrains-mono";
import "@fontsource-variable/roboto";
import "@fontsource-variable/noto-serif";
import "katex/dist/katex.min.css";
import "./styles.css";
import "./androidReader.css";
import "./customTheme.css";
import Editor, { editorReadingOffset, editorHistory, exportEditorSession, importEditorSession, type PortableEditorSession } from "./components/Editor";
import {readingOffset,revealReadingOffset} from "./readingPosition";
import { exportRenderedViews, importRenderedViews } from "./renderedOutputs";
import LiveEditor from "./components/LiveEditor";
import MarkdownPreview from "./components/MarkdownPreview";
import { invoke } from "./nativeBridge";
import {ReaderEdits,type SourceChange} from './readerEdits';
import { preparePdf } from "./preparePdf";
import type { ExportOptions,ReaderAccessibilityPreference } from "./types";
import { clampPreviewZoom } from "./zoom";
import MediaTools from "./components/MediaTools";
import { prepareFmd } from "./documentMedia";
import ImageViewer from "./components/ImageViewer";
import MathRepairPanel from "./components/MathRepairPanel";
import ThemeGuideDialog from "./components/ThemeGuideDialog";
import { captureScrollAnchor,markScrollInput,scrollInputVersion } from "./scrollAnchor";
import {rememberWindowedScrollSource} from './windowedSearch';
import ReadingSearch from "./components/ReadingSearch";
import type { Point } from "./focalZoom";
import { applyDocumentZoom,documentPoint,invalidateDocumentZoom,settleDocumentZoom,refreshDocumentExtent,enforceDocumentCenter } from "./documentZoom";
import { documentOutline, navigateToHeading, cancelHeadingNavigation } from "./documentNavigation";
import { readerSourceAnalysis } from "./readerSourceAnalysis";
import {OutlineWorkerClient} from './outlineWorker';
import {recordHistory,replayHistory,historySize,validHistory,type NoteHistory} from './noteHistory';
import {cachedEditorHistory} from './components/Editor';
import {loadReadingLocation,saveReadingLocation,type ReadingLocation} from './readingLocations';
import {mediaFilter,mediaTone,type MediaAppearance} from './mediaAppearance';
import MediaThemeFilters from './components/MediaThemeFilters';
import ExportProgressIndicator from './components/ExportProgressIndicator';
import {DocumentAppearance} from './documentAppearance';
import {applyCustomStyle,type CustomStyle} from './customTheme';
const DocumentPreview = memo(MarkdownPreview);
const LiveDocument = memo(LiveEditor);
const SourceEditor = memo(Editor);
interface PdfExportStatus {id:string;phase:'preparing'|'typesetting'|'publishing';completed:number;total:number;cancelRequested?:boolean}

interface NoteView { editor?: PortableEditorSession; history?:NoteHistory; top?: number; rendered?: ReturnType<typeof exportRenderedViews> }
interface ReaderState extends ReaderAccessibilityPreference { id: string; content: string; path: string | null; mode: "live" | "editor" | "reader" | "split"; dark: boolean; fullscreen: boolean; font: string; size: number; latexAutofix?:boolean;spellCheck?:boolean; grammarCheck?:boolean; width?: number; widthPercent?:number; lineHeight?:number; colors: Record<string, string>; zoom: number; motion?: boolean; python?: string; viewState?: NoteView }
declare global { interface Window {supermdAgentRequest?:(request:Record<string,unknown>,callback?:(result:unknown,error:string)=>void)=>void;supermdThemeGuide?:()=>void;supermdDismiss?:()=>boolean;supermdSetZoom?:(zoom:number,requestedAt?:number)=>void;supermdHeading?:(id:string,offset?:number)=>void;supermdHistory?:(direction:"undo"|"redo")=>void;supermdNativeWheel?:(dx:number,dy:number,point:Point,held:boolean,modifier?:boolean)=>void;} }
declare global { interface Window { supermdLoad?: (state: ReaderState) => void; supermdExport?: (options: ExportOptions) => void; supermdExportMarkdown?: () => void; supermdFind?: () => void; supermdPortable?: (save: boolean) => void; supermdZoomBy?: (factor:number,focus?:Point)=>void; supermdResetZoom?: ()=>void; supermdRepairMath?: ()=>void; supermdFlush?: (operation:Record<string,string>)=>void } }
declare global { interface Window {supermdChromeInset?:(height:number)=>void} }
declare global { interface Window {supermdSavePosition?:()=>void} }
declare global {interface Window {supermdExportPhase?:(id:string,phase:'typesetting'|'publishing')=>void}}
interface ReaderState { centerLock?:boolean; customStyle?:CustomStyle; restorePosition?:boolean; readingLocation?:ReadingLocation|null; imageAppearance?:MediaAppearance; svgAppearance?:MediaAppearance; imageContrast?:number }
function Reader() {
  const [state, setState] = useState<ReaderState | null>(null);
  const readerAnalysis=useMemo(()=>state?readerSourceAnalysis(state.mode,state.content):null,[state?.mode,state?.content]);
  const [repairing, setRepairing] = useState(false);
  const [searching,setSearching] = useState(false);
  const [pdfExport,setPdfExport]=useState<PdfExportStatus|null>(null);
  const exportOwner=useRef<{id:string;controller:AbortController;phase:PdfExportStatus['phase']}|null>(null);
  const cancelPdfExport=useCallback(async()=>{
    const owner=exportOwner.current;if(!owner||owner.phase==='publishing')return;
    setPdfExport(value=>value?.id===owner.id?{...value,cancelRequested:true}:value);
    if(owner.phase==='preparing'){owner.controller.abort();return;}
    try{
      const result=await invoke<{cancelled:boolean}>('cancel_export',{jobId:owner.id});
      if(!result?.cancelled&&exportOwner.current?.id===owner.id){owner.phase='publishing';setPdfExport(value=>value?.id===owner.id?{...value,phase:'publishing',cancelRequested:false}:value);}
    }catch{
      // An older native host may not support cancellation once typesetting starts.
      if(exportOwner.current?.id===owner.id){owner.phase='publishing';setPdfExport(value=>value?.id===owner.id?{...value,phase:'publishing',cancelRequested:false}:value);}
    }
  },[]);
  useEffect(()=>{
    window.supermdExportPhase=(id,phase)=>{const owner=exportOwner.current;if(owner?.id!==id)return;owner.phase=phase;setPdfExport(value=>value?.id===id?{...value,phase,cancelRequested:false}:value);};
    return()=>{delete window.supermdExportPhase;};
  },[]);
  const [trustedHosts,setTrustedHosts] = useState<string[]>([]);
  const documentAppearance=useMemo(()=>({dark:state?.dark??false,svgAppearance:state?.svgAppearance,ink:state?.colors.primary,text:state?.colors.text,colors:state?.colors}),[state?.dark,state?.svgAppearance,JSON.stringify(state?.colors)]);
  const trustHost = useCallback((host:string)=>setTrustedHosts(current=>current.includes(host)?current:[...current,host]),[]);
  const reference = useRef(state); reference.current = state;
  const outlineWorker=useRef<OutlineWorkerClient|null>(null);
  const edits=useRef<ReaderEdits|null>(null);
  if(!edits.current)edits.current=new ReaderEdits((command,args)=>invoke(command,args));
  const [editError,setEditError]=useState('');
  const [themeGuide,setThemeGuide]=useState(false);
  const zoomReference = useRef(100);
  const zoomGestureAt = useRef(0);
  const pendingChange = useRef(0);
  const noteViews = useRef(new Map<string, NoteView>());
  const histories=useRef(new Map<string,NoteHistory>());
  const trimHistories=(active:string)=>{let retained=[...histories.current.values()].reduce((size,h)=>size+historySize(h),0);for(const [id,cached] of histories.current){if(histories.current.size<=40&&retained<=4_000_000)break;if(id===active)continue;histories.current.delete(id);retained-=historySize(cached);}};
  const replaying=useRef(false);
  const loadedFonts=useRef(new Map<string,Promise<FontFace>>());
  const cursor=useRef<Point|undefined>(undefined);
  const zoomFrame=useRef(0),zoomTimer=useRef(0),zoomFocus=useRef<Point|undefined>(undefined),zoomTarget=useRef<number|null>(null),zoomAnchors=useRef<{focus?:Point;points:Map<HTMLElement,Point|null>}>({points:new Map()});
  const zoomFrameTime=useRef(0);
  const settleTimer=useRef(0);
  const selectingText=useRef(false);
  const gapSelection=useRef<GapSelection|null>(null);
  const savePosition=useRef(()=>{});
  const layoutKey=useRef('');
  const customLayout=useRef<{id:string;mode:string;metrics:string}|null>(null);
  const chromeRequestAt=useRef(0);
  const chromeLastAction=useRef<string|undefined>(undefined);
  const requestChrome=(action:'show'|'hide'|'toggle')=>{
    if(document.documentElement.dataset.host!=='qt'||!reference.current?.fullscreen)return;
    if(action!=='toggle'&&action===chromeLastAction.current&&performance.now()-chromeRequestAt.current<80)return;
    chromeRequestAt.current=performance.now();chromeLastAction.current=action;void invoke('reader_chrome',{action});
  };
  const settleSelection=()=>{window.clearTimeout(settleTimer.current);if(document.documentElement.dataset.platform!=='android')return;settleTimer.current=window.setTimeout(()=>{
    // Touch handles need settled layout geometry at rest. Never change layout
    // geometry mid-drag; desktop selection stays on its compositor geometry.
    if(!selectingText.current)document.querySelectorAll<HTMLElement>('.android-reading').forEach(settleDocumentZoom);
  },240);};
  const modeOffset=useRef<number|null>(null);
  const anchors = (focus?:Point) => Array.from(document.querySelectorAll<HTMLElement>(".android-reading,.cm-scroller")).filter(root=>{const r=root.getBoundingClientRect();return !focus || focus.x>=r.left&&focus.x<=r.right&&focus.y>=r.top&&focus.y<=r.bottom;}).map(root=>captureScrollAnchor(root,focus));
  const applyZoomStyle=(focus?:Point,previousFocus=focus,anchors?:Map<HTMLElement,Point|null>)=>{document.querySelector<HTMLElement>(".android-source")?.style.setProperty("--workspace-scale",String(zoomReference.current/100));document.querySelectorAll<HTMLElement>(".android-reading").forEach(root=>applyDocumentZoom(root,zoomReference.current,reference.current?.widthPercent??90,focus,previousFocus,anchors?.get(root),reference.current?.centerLock===true));};
  const anchored = (update:()=>void) => { const restore = anchors(); update(); requestAnimationFrame(()=>restore.forEach(callback=>callback())); };
  useEffect(() => {
    const nativeScroll=new FrameScrollQueue((scroller,dx,dy)=>{
      const reading=scroller.matches('.android-reading');
      if(reading){cancelHeadingNavigation(scroller);rememberWindowedScrollSource(scroller,dy);if(Math.abs(dy)>2)requestChrome('hide');}
      scroller.scrollBy({left:reading&&reference.current?.centerLock?0:dx,top:dy,behavior:'instant'});
    });
    window.supermdSavePosition=()=>savePosition.current();
    window.supermdChromeInset=height=>{
      const top=Math.max(0,Math.min(480,Number.isFinite(height)?height:0));
      const html=document.documentElement;
      if(html.style.getPropertyValue('--native-chrome-inset')===`${top}px`)return;
      const restore=anchors();
      // A spacer at the start of the NOTE protects its title; it is not a
      // viewport inset and is unchanged when native chrome merely hides.
      html.style.setProperty('--native-chrome-inset',`${top}px`);
      document.querySelectorAll<HTMLElement>('.android-reading').forEach(invalidateDocumentZoom);
      requestAnimationFrame(()=>{restore.forEach(callback=>callback());applyZoomStyle();settleSelection();});
    };
    window.supermdThemeGuide=()=>setThemeGuide(true);
    window.supermdDismiss=()=>{const element=document.querySelector(".theme-guide-dialog")||document.querySelector(".image-viewer,.math-repair-panel,.reading-search,.cm-search,.live-active-block textarea");if(!element)return false;const target=element.matches("textarea")?element:document.activeElement||document;target.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}));if(element.matches("textarea"))(element as HTMLElement).blur();return true;};
    window.supermdLoad = (incoming) => {
      const old = reference.current;
      // Native omits content it received from this reader, unchanged since.
      const {contentUnchanged,...rest}=incoming as ReaderState&{contentUnchanged?:boolean};
      if(contentUnchanged&&(!old||old.id!==rest.id))return;
      const next=(contentUnchanged?{...rest,content:old!.content}:rest) as ReaderState;
      if(old&&(old.id!==next.id||old.mode!==next.mode||old.fullscreen!==next.fullscreen)){nativeScroll.clear();gapSelection.current?.end();}
      const draft=edits.current!.unacknowledged(next.id);
      if(draft!==undefined&&next.content!==draft&&!contentUnchanged){
        next.content=draft;
        setEditError('A native update arrived while edits were awaiting acknowledgement. Your editor draft has been kept. Save or close will wait for a verified edit session.');
      }
      if((next as ReaderState&{editProtocol?:number}).editProtocol===1){
        edits.current!.open(next.id,next.content);
        // Retiring an untouched stale baseline also retires its reader-only
        // warning. Never hide an error while an unacknowledged draft remains.
        if(draft===undefined&&(old?.id!==next.id||old?.content!==next.content))setEditError('');
      }
      if(old?.id===next.id)next.readingLocation=old.readingLocation;
      if(old&&(old.id!==next.id||old.mode!==next.mode||old.fullscreen!==next.fullscreen))document.querySelectorAll('.android-reading').forEach(cancelHeadingNavigation);
      if(old&&(old.id!==next.id||old.mode!==next.mode)){const history=histories.current.get(next.id);if(history)history.last=0;}
      if(old&&old.id===next.id&&old.mode!==next.mode){
        const root=document.querySelector<HTMLElement>(".android-reading");
        modeOffset.current=old.mode==="editor"?(editorReadingOffset(old.id)??0):root?readingOffset(root):0;
      }
      if(old&&[...new Set([...Object.keys(old),...Object.keys(next)])].every(key=>key==="zoom"&&old.fullscreen===next.fullscreen?true:key==="viewState"?!next.viewState:key==="colors"||key==="customStyle"?JSON.stringify((old as any)[key])===JSON.stringify((next as any)[key]):(old as any)[key]===(next as any)[key]))return;
      if (old && old.id !== next.id) {
        savePosition.current();
        noteViews.current.set(old.id, {top: document.querySelector<HTMLElement>(".android-reading")?.scrollTop ?? 0});
        if (noteViews.current.size > 40) noteViews.current.delete(noteViews.current.keys().next().value!);
      }
      if(old&&old.id===next.id&&old.path!==next.path&&next.restorePosition!==false){savePosition.current();const location=loadReadingLocation(old.path);if(location)saveReadingLocation(next.path,location);}
      if (next.viewState && old?.id !== next.id) {
        importEditorSession(next.id, next.viewState.editor);
        importRenderedViews(next.content, next.viewState.rendered);
        const history=next.viewState.history;
        if(validHistory(history))histories.current.set(next.id,{undo:structuredClone(history.undo),redo:structuredClone(history.redo),last:0});
        trimHistories(next.id);
        noteViews.current.set(next.id, {top:next.viewState.top});
      }
      // Native snapshots may have been queued before the latest pinch frame.
      // Within one workspace mode the reader owns its gesture scale; explicit
      // native zoom controls use supermdSetZoom instead of echoing a snapshot.
      const sameViewport=old && old.fullscreen===next.fullscreen;
      // A viewport switch presents the zoom the user asked for, even mid-glide.
      if(old&&!sameViewport&&zoomTarget.current!==null){zoomReference.current=zoomTarget.current;zoomTarget.current=null;}
      const enteringFullscreen=old && !old.fullscreen && next.fullscreen;
      const loaded={...next,zoom:sameViewport||enteringFullscreen?zoomReference.current:clampPreviewZoom(next.zoom),viewState:undefined};
      if(enteringFullscreen){
        // A pinch acknowledgement can still be queued in the native bridge.
        // Keep its presented scale on entry and reconcile both native contexts.
        void invoke("zoom_changed",{zoom:loaded.zoom,fullscreen:false});
        void invoke("zoom_changed",{zoom:loaded.zoom,fullscreen:true});
      }
      if(old && !sameViewport){window.clearTimeout(zoomTimer.current);cancelAnimationFrame(zoomFrame.current);zoomFrame.current=0;zoomTarget.current=null;}
      const load = () => { reference.current=loaded;setState(loaded); zoomReference.current = loaded.zoom; };
      if (old?.id === next.id && old.mode === next.mode) anchored(load); else load();
    };
    window.supermdHistory=direction=>{
      if(document.querySelector('.theme-guide-dialog'))return;
      if(document.activeElement instanceof HTMLInputElement||document.activeElement instanceof HTMLTextAreaElement){document.execCommand(direction);return;}
      const current=reference.current;if(!current)return;
      replaying.current=true;
      const history=histories.current.get(current.id);const next=history?replayHistory(history,current.content,direction):undefined;
      if(next!==undefined)update(next);
      else if(current.mode==="editor"||current.mode==="split")editorHistory(current.id,direction);
      else {const cached=cachedEditorHistory(current.id,direction,current.content);if(cached!==undefined)update(cached);}
      replaying.current=false;
    };
    window.supermdZoomBy = (factor,focus=cursor.current) => {
      zoomGestureAt.current=Date.now();
      if (document.querySelector(".image-viewer")) { window.dispatchEvent(new CustomEvent("supermd-image-zoom",{detail:{factor,point:focus}})); return; }
      cancelHeadingNavigation(document.querySelector('.android-reading'));
      const target=clampPreviewZoom((zoomTarget.current??zoomReference.current)*factor);zoomFocus.current=focus;
      // Keyboard and wheel-notch steps glide to the target; continuous pinch
      // and touchpad deltas are already small and apply directly.
      const glide=Math.abs(Math.log(factor))>.03&&document.documentElement.dataset.motion!=="off"&&!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      if(glide){
        if(zoomTarget.current===null||zoomAnchors.current.focus!==focus)zoomAnchors.current={focus,points:new Map(Array.from(document.querySelectorAll<HTMLElement>(".android-reading"),root=>[root,documentPoint(root,focus)]))};
        zoomTarget.current=target;
      } else {zoomTarget.current=null;zoomReference.current=target;}
      const step=(time:number)=>{
        const elapsed=time-zoomFrameTime.current;zoomFrameTime.current=time;
        const goal=zoomTarget.current;
        if(goal!==null){zoomReference.current=zoomFrameStep(zoomReference.current,goal,elapsed);if(zoomReference.current===goal)zoomTarget.current=null;}
        applyZoomStyle(zoomFocus.current,zoomFocus.current,goal!==null?zoomAnchors.current.points:undefined);
        if(zoomTarget.current!==null)zoomFrame.current=requestAnimationFrame(step);else{zoomFrame.current=0;settleSelection();}
      };
      if(!zoomFrame.current){zoomFrameTime.current=performance.now();zoomFrame.current=requestAnimationFrame(step);}
      window.clearTimeout(zoomTimer.current);const fullscreen=reference.current?.fullscreen;zoomTimer.current=window.setTimeout(()=>void invoke("zoom_changed",{zoom:target,fullscreen}),220);
    };
    window.supermdSetZoom=(value,requestedAt)=>{if(requestedAt!==undefined&&requestedAt<zoomGestureAt.current)return;window.clearTimeout(zoomTimer.current);cancelAnimationFrame(zoomFrame.current);zoomFrame.current=0;zoomTarget.current=null;const next=clampPreviewZoom(value);if(Math.abs(next-zoomReference.current)<.01)return;cancelHeadingNavigation(document.querySelector('.android-reading'));zoomReference.current=next;applyZoomStyle();settleSelection();};
    window.supermdHeading=(id,offset)=>{markScrollInput();if(reference.current?.mode==="editor"){window.dispatchEvent(new CustomEvent("supermd-goto-offset",{detail:offset??0}));return;}const root=document.querySelector(".android-reading");if(root)navigateToHeading(root,id);};
    window.supermdResetZoom = () => { if (document.querySelector(".image-viewer")) { window.dispatchEvent(new Event("supermd-image-reset")); return; } window.supermdZoomBy?.(100/(zoomTarget.current??zoomReference.current)); };
    window.supermdRepairMath = () => setRepairing(true);
    window.supermdNativeWheel=(dx,dy,point,held,modifier=false)=>{
      markScrollInput();
      const target=document.elementFromPoint(point.x,point.y),canvas=target?.closest(".interactive-chart svg,.image-viewer-canvas");
      if(target?.closest('.theme-guide-dialog')){const body=target.closest<HTMLElement>('.theme-guide-body');if(!held&&body)nativeScroll.scroll(body,dx,dy);return;}
      const editor=target?.closest<HTMLTextAreaElement>('textarea');
      if(editor){nativeScroll.scroll(editor,dx,dy);return;}
      if(held&&(modifier||canvas||(!selectingText.current&&!window.getSelection()?.toString()))){gapSelection.current?.cancelStationary();if(canvas?.matches("svg"))canvas.dispatchEvent(new WheelEvent("wheel",{bubbles:true,cancelable:true,ctrlKey:true,deltaY:dy,clientX:point.x,clientY:point.y}));else window.supermdZoomBy?.(Math.exp(-dy*.002),point);return;}
      if(canvas){canvas.dispatchEvent(new CustomEvent("supermd-canvas-pan",{detail:{dx,dy},cancelable:true}));return;}
      const scroller=target?.closest<HTMLElement>(".android-reading,.cm-scroller,.image-viewer-canvas,.math-repair-list,.media-dialog") || document.querySelector<HTMLElement>('.android-reading');
      if(scroller)nativeScroll.scroll(scroller,dx,dy);
    };
    window.supermdFlush = operation => {
      savePosition.current();
      const current = reference.current; if (!current) return;
      if(operation.action==='android_flush'){
        void (async()=>{
          if(current.id!==operation.target)throw new Error('The active note changed before its edit flush');
          if((current as ReaderState&{editProtocol?:number}).editProtocol===1)await edits.current!.flush(current.id);
          const latest=reference.current;
          if(!latest||latest.id!==operation.target)throw new Error('The active note changed during its edit flush');
          await invoke('document_flushed',{id:latest.id,token:operation.token,content:latest.content});
        })().catch(error=>{
          setEditError(String(error));
          void invoke('document_flushed',{id:current.id,token:operation.token,error:String(error)}).catch(()=>{});
        });
        return;
      }
      let id = current.id;
      if (operation.action === "move_tab") { try { id = JSON.parse(operation.target).tab; } catch { return; } }
      else if (operation.action === "detach_tab") id = operation.target;
      const view = operation.action === "move_tab" || operation.action === "detach_tab" || operation.action === "reload_reader" ? {editor:exportEditorSession(id),history:histories.current.get(id), ...(id === current.id ? {top:document.querySelector<HTMLElement>(".android-reading")?.scrollTop ?? 0,rendered:exportRenderedViews(current.content)} : noteViews.current.get(id))} : undefined;
      void (async()=>{
        if((current as ReaderState&{editProtocol?:number}).editProtocol===1)await edits.current!.flush(current.id);
        // Snapshot after the acknowledgement barrier, including edits made while waiting.
        const latest=reference.current;
        await invoke("document_flushed",{id:current.id,content:latest?.id===current.id?latest.content:current.content,operation,viewId:id,viewState:view});
      })().catch(error=>setEditError(String(error)));
    };
    window.supermdFind = () => {if(document.querySelector('.theme-guide-dialog'))return;flushSync(()=>setSearching(true));window.dispatchEvent(new Event("supermd-find-focus"));};
    window.supermdPortable = async (save) => {
      const current = reference.current; if (!current) return;
      try {
        if((current as ReaderState&{editProtocol?:number}).editProtocol===1)await edits.current!.flush(current.id);
        const latest=reference.current;if(!latest||latest.id!==current.id)throw new Error('The export note changed');
        const prepared = await prepareFmd(latest.content, latest.path); await invoke("export_fmd_native", { ...prepared, originalContent: latest.content, id: latest.id, save }); }
      catch (error) { await invoke("export_failed", { error: String(error) }); }
    };
    window.supermdExport = async (options) => {
      const current = reference.current; if (!current) return;
      if(exportOwner.current)return;
      const owner={id:crypto.randomUUID(),controller:new AbortController(),phase:'preparing' as PdfExportStatus['phase']};
      exportOwner.current=owner;setPdfExport({id:owner.id,phase:'preparing',completed:0,total:0});
      try {
        if((current as ReaderState&{editProtocol?:number}).editProtocol===1)await edits.current!.flush(current.id);
        const latest=reference.current;if(!latest||latest.id!==current.id)throw new Error('The export note changed');
        const prepared = await preparePdf(latest.content, latest.path, latest.python || "embedded",{signal:owner.controller.signal,onProgress:progress=>setPdfExport(value=>value?.id===owner.id?{...value,completed:progress.completed,total:progress.total}:value)});
        owner.controller.signal.throwIfAborted();
        owner.phase='typesetting';setPdfExport({id:owner.id,phase:'typesetting',completed:0,total:0});
        await invoke("export_pdf_native", { ...prepared, options: {...options, themeAccent: latest.colors.primary}, id: latest.id,jobId:owner.id }); }
      catch (error) { await invoke("export_failed", { error: owner.controller.signal.aborted||(error instanceof Error&&error.message==='PDF export cancelled')?'PDF export cancelled':String(error) }); }
      finally{if(exportOwner.current?.id===owner.id){exportOwner.current=null;setPdfExport(null);}}
    };
    window.supermdExportMarkdown = async () => {
      const current = reference.current; if (!current) return;
      try {
        if((current as ReaderState&{editProtocol?:number}).editProtocol===1)await edits.current!.flush(current.id);
        const latest=reference.current;if(!latest||latest.id!==current.id)throw new Error('The export note changed');
        await invoke("export_markdown_native", {id: latest.id, content: latest.content}); }
      catch (error) { await invoke("export_failed", {error: String(error)}); }
    };
    void invoke("reader_ready");
    return () => {nativeScroll.clear();cancelAnimationFrame(zoomFrame.current);window.clearTimeout(zoomTimer.current);delete window.supermdThemeGuide;delete window.supermdSavePosition;delete window.supermdChromeInset;delete window.supermdLoad; delete window.supermdExport; delete window.supermdExportMarkdown; delete window.supermdPortable; delete window.supermdZoomBy; delete window.supermdResetZoom; delete window.supermdRepairMath; delete window.supermdFlush; delete window.supermdSetZoom; delete window.supermdHeading; };
  }, []);
  useEffect(()=>{
    if(!state)return;
    // Outline is derived state, not durable edits. Coalesce expensive Source
    // typing work and cancel obsolete document generations before parsing.
    const {id,content}=state;
    const controller=new AbortController();
    const workerBacked=state.mode==='editor'&&content.length>80_000&&typeof Worker!=='undefined';
    const timer=window.setTimeout(()=>{
      if(reference.current?.id!==id||reference.current.content!==content)return;
      void (async()=>{
        let headings;
        try{
          if(readerAnalysis?.source===content)headings=readerAnalysis.analysis.outline;
          else if(workerBacked){outlineWorker.current??=new OutlineWorkerClient();headings=await outlineWorker.current.request(content,controller.signal);}
          else headings=documentOutline(content);
        }catch{
          if(controller.signal.aborted)return;
          // Worker creation/analysis can be unavailable in an older WebView;
          // keep the existing synchronous analysis as the correctness path.
          headings=readerAnalysis?.source===content?readerAnalysis.analysis.outline:documentOutline(content);
        }
        if(controller.signal.aborted||reference.current?.id!==id||reference.current.content!==content)return;
        void invoke('document_outline',{id,headings}).catch(()=>{});
      })();
    },content.length>80_000?180:0);
    return()=>{window.clearTimeout(timer);controller.abort();if(workerBacked)outlineWorker.current?.cancel();};
  },[state?.id,state?.content,state?.mode,readerAnalysis]);
  useEffect(()=>()=>{outlineWorker.current?.dispose();outlineWorker.current=null;},[]);
  useLayoutEffect(() => {
    if (!state) return;
    const nextCustom={id:state.id,mode:state.mode,metrics:JSON.stringify(state.customStyle?.metrics??{})};
    const previousCustom=customLayout.current;
    const restoreCustom=previousCustom?.id===state.id&&previousCustom.mode===state.mode&&previousCustom.metrics!==nextCustom.metrics?anchors():[];
    customLayout.current=nextCustom;
    const root = document.documentElement; root.dataset.theme = state.dark ? "dark" : "light"; root.dataset.motion = state.motion === false ? "off" : "on";root.dataset.fullscreen=String(state.fullscreen);
    root.style.setProperty("--reader-size", `${state.size}px`);
    root.style.setProperty("--editor-size", `${Math.max(12, Math.min(24, state.size - 2))}px`);
    const fonts: Record<string,string> = {sans:"Manrope,'Manrope Variable', sans-serif",serif:"'Noto Serif','Noto Serif Variable', Georgia, serif",mono:"'JetBrains Mono','JetBrains Mono Variable', monospace",Manrope:"Manrope,'Manrope Variable',sans-serif","JetBrains Mono":"'JetBrains Mono','JetBrains Mono Variable',monospace","Noto Sans":"'Noto Sans',sans-serif","Noto Serif":"'Noto Serif','Noto Serif Variable',serif",Roboto:"Roboto,'Roboto Variable',sans-serif",roboto:"Roboto,'Roboto Variable',sans-serif",noto:"'Noto Sans',sans-serif",system:"system-ui,sans-serif"};
    root.style.setProperty("--reader-font",fonts[state.font] || `${JSON.stringify(state.font)}, sans-serif`);
    root.style.setProperty("--reader-width",`${state.widthPercent??90}%`);
    root.style.setProperty("--reading-max-width",`${state.widthPercent??90}%`);
    root.style.setProperty("--reader-leading",String(state.lineHeight??1.65));
    Object.entries(state.colors).forEach(([key, value]) => root.style.setProperty(`--${key}`, value));
    const styleKey=applyCustomStyle(root,state.customStyle,state.colors);
    root.style.setProperty('--image-filter',mediaFilter(state.imageAppearance,state.dark,state.imageContrast));
    root.style.setProperty('--svg-filter',mediaFilter(state.svgAppearance,state.dark,state.imageContrast));
    root.dataset.imageAppearance=state.imageAppearance??'original';root.dataset.svgAppearance=state.svgAppearance??'original';
    root.style.setProperty('--media-edge',mediaTone(state.colors,state.dark).ink);
    root.style.setProperty('--media-separation',`${Math.max(1,Math.min(2,state.imageContrast??1.25))}px`);
    // A palette-only change must not unset CSS zoom, remeasure a long page or
    // write scrollTop. These operations used to race with momentum scrolling.
    const nextLayout=JSON.stringify([state.id,state.mode,state.fullscreen,state.font,state.size,state.widthPercent,state.lineHeight,styleKey]);
    if(layoutKey.current!==nextLayout){layoutKey.current=nextLayout;document.querySelectorAll<HTMLElement>('.android-reading').forEach(invalidateDocumentZoom);applyZoomStyle();settleSelection();}
    if(restoreCustom.length)requestAnimationFrame(()=>restoreCustom.forEach(restore=>restore()));
  // A source edit (especially checking a task) is not a new viewport. Rebuilding
  // zoom geometry here resets settled CSS zoom before the native selection and
  // scroll position have caught up, which jumps on mobile and magnified pages.
  // ResizeObserver updates the content extent without changing magnification.
  }, [state?.id,state?.mode,state?.dark,state?.fullscreen,state?.font,state?.size,
      state?.widthPercent,state?.lineHeight,state?.motion,state?.imageAppearance,state?.svgAppearance,state?.imageContrast,JSON.stringify(state?.colors),JSON.stringify(state?.customStyle)]);
  useEffect(()=>{const root=document.querySelector<HTMLElement>(".android-reading");if(!root || typeof ResizeObserver==="undefined")return;let frame=0;const page=root.querySelector<HTMLElement>(".document-page");const observer=new ResizeObserver(()=>{if(!frame)frame=requestAnimationFrame(()=>{frame=0;
    // A scheduled gesture owns its focal point. A resize callback must not
    // consume the pending scale at the default center before that frame runs.
    if(Math.abs(Number(page?.dataset.scale)*100-zoomReference.current)<.01 && !refreshDocumentExtent(root)){invalidateDocumentZoom(root);applyZoomStyle();settleSelection();}
  });});observer.observe(root);if(page)observer.observe(page);return()=>{observer.disconnect();cancelAnimationFrame(frame);};},[state?.id,state?.mode]);
  useLayoutEffect(()=>{if(state){applyZoomStyle();settleSelection();}},[state?.centerLock]);
  // A Range must not retain a detached previous note after a tab switch or
  // source replacement, including edits made directly inside this reader.
  useLayoutEffect(()=>{document.querySelectorAll<HTMLElement>('.android-reading').forEach(root=>rememberWindowedScrollSource(root,0));},[state?.id,state?.content,state?.mode]);
  useEffect(()=>{
    const lock=(event:Event)=>{const root=event.target;if(root instanceof HTMLElement&&root.matches('.android-reading'))enforceDocumentCenter(root);};
    document.addEventListener('scroll',lock,{capture:true,passive:true});
    return()=>document.removeEventListener('scroll',lock,true);
  },[]);
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
    const hosts=Array.from(document.querySelectorAll<HTMLElement>(".android-reading"));
    hosts.forEach(host=>delete host.dataset.measured);
    let measure=requestAnimationFrame(()=>{measure=requestAnimationFrame(()=>hosts.forEach(host=>{host.dataset.measured="true";}));});
    return()=>cancelAnimationFrame(measure);
  }, [state?.id, state?.mode]);
  useLayoutEffect(() => {
    if (!state) return;
    const startingInput=scrollInputVersion();
    const saved=state.restorePosition!==false?(state.readingLocation??loadReadingLocation(state.path===state.id?null:state.path)):undefined;
    const top = noteViews.current.get(state.id)?.top ?? (saved?.mode===state.mode&&Math.abs(saved.zoom-zoomReference.current)<1?saved.top:undefined);
    if(modeOffset.current!==null){
      const offset=modeOffset.current;modeOffset.current=null;
      // The new view settles over several frames (editor mount, zoom geometry,
      // lazy math and fonts). Re-apply the source anchor until it is stable,
      // and stop as soon as the person scrolls or types.
      let stopped=false;const stop=()=>{stopped=true;};
      const inputs=["wheel","touchstart","keydown","pointerdown"] as const;
      inputs.forEach(name=>window.addEventListener(name,stop,{capture:true,passive:true}));
      const apply=()=>{
        if(stopped||scrollInputVersion()!==startingInput)return;
        if(state.mode==="editor")window.dispatchEvent(new CustomEvent("supermd-goto-offset",{detail:offset}));
        else {const host=document.querySelector<HTMLElement>(".android-reading");if(host)revealReadingOffset(host,offset);}
      };
      requestAnimationFrame(()=>{apply();requestAnimationFrame(apply);});
      const timers=[120,320,700].map(delay=>window.setTimeout(apply,delay));
      window.setTimeout(()=>inputs.forEach(name=>window.removeEventListener(name,stop,{capture:true})),760);
      return()=>{stopped=true;timers.forEach(window.clearTimeout);};
    }
    if(top===undefined&&!saved)return;
    let stopped=false;
    const stop=()=>{stopped=true;};
    const inputs=['wheel','touchstart','pointerdown','keydown'] as const;
    inputs.forEach(name=>window.addEventListener(name,stop,{capture:true,passive:true}));
    const restore=()=>{
      if(stopped||scrollInputVersion()!==startingInput)return;
      const host=document.querySelector<HTMLElement>('.android-reading');
      if(host){if(top!==undefined)host.scrollTop=Math.max(0,top);else if(saved)revealReadingOffset(host,saved.offset);}
      else if(saved)window.dispatchEvent(new CustomEvent('supermd-goto-offset',{detail:saved.offset}));
    };
    const frame=requestAnimationFrame(()=>{restore();requestAnimationFrame(restore);});
    const timers=[120,320,700].map(delay=>window.setTimeout(restore,delay));
    return()=>{stopped=true;cancelAnimationFrame(frame);timers.forEach(window.clearTimeout);inputs.forEach(name=>window.removeEventListener(name,stop,{capture:true}));};
  }, [state?.id, state?.mode]);
  useEffect(()=>{
    if(!state||state.restorePosition===false)return;
    const path=state.path===state.id?null:state.path;if(!path)return;
    const root=document.querySelector<HTMLElement>('.android-reading,.cm-scroller');if(!root)return;
    let timer=0;
    const save=()=>{if(root.isConnected){const location={top:root.scrollTop,offset:state.mode==='editor'?(editorReadingOffset(state.id)??0):readingOffset(root),zoom:zoomReference.current,mode:state.mode};saveReadingLocation(path,location);void invoke('reading_position',{id:state.id,location}).catch(()=>{});}};
    const scroll=()=>{window.clearTimeout(timer);timer=window.setTimeout(save,900);};
    savePosition.current=save;
    root.addEventListener('scroll',scroll,{passive:true});window.addEventListener('pagehide',save);document.addEventListener('visibilitychange',save);
    // A native/heading jump can finish before this passive effect subscribes.
    // Persist its settled viewport too, even if no later scroll event arrives.
    scroll();
    return()=>{window.clearTimeout(timer);save();root.removeEventListener('scroll',scroll);window.removeEventListener('pagehide',save);document.removeEventListener('visibilitychange',save);savePosition.current=()=>{};};
  },[state?.id,state?.mode,state?.path,state?.restorePosition]);
  useEffect(() => {
    const find=(event:KeyboardEvent)=>{if(document.documentElement.dataset.host==='qt')return;if((event.ctrlKey || event.metaKey) && event.key.toLowerCase()==="f"){event.preventDefault();event.stopImmediatePropagation();window.supermdFind?.();}};
    const history=(event:KeyboardEvent)=>{
      if(document.documentElement.dataset.host==='qt')return;
      if(!(event.ctrlKey||event.metaKey)||event.altKey)return;
      const key=event.key.toLowerCase();if(key!=="z"&&key!=="y")return;
      if(document.querySelector(".image-viewer,.math-repair-panel,.reading-search,.media-dialog"))return;
      // Leave a Live textarea's native editing history intact; Source and Read
      // route through the same bounded note history on hardware keyboards.
      if(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)return;
      event.preventDefault();event.stopImmediatePropagation();window.supermdHistory?.(key==="y"||event.shiftKey?"redo":"undo");
    };
    document.addEventListener("keydown",find,true);
    document.addEventListener("keydown",history,true);
    return()=>{document.removeEventListener("keydown",find,true);document.removeEventListener("keydown",history,true);};
  },[]);
  useEffect(() => {
    let tap=0;
    const click=(event:MouseEvent)=>{
      const target=event.target as Element;
      if(document.documentElement.dataset.host!=='qt'||!reference.current?.fullscreen||!target.closest('.android-reading'))return;
      window.clearTimeout(tap);
      if(event.detail>1||event.altKey||event.ctrlKey||event.metaKey||target.closest('a,button,input,textarea,summary,img,.note-image,.interactive-chart,[data-independent-zoom]'))return;
      if(window.getSelection()?.toString())return;
      tap=window.setTimeout(()=>{if(!window.getSelection()?.toString()&&!document.querySelector('.live-active-block textarea,.reading-search,.media-dialog,.image-viewer,.math-repair-panel'))requestChrome('toggle');},260);
    };
    document.addEventListener('click',click);
    return()=>{window.clearTimeout(tap);document.removeEventListener('click',click);};
  },[]);
  useEffect(() => {
    let startDistance = 0, startZoom = 100, pinching = false, frame = 0,mouseHeld=false,focus:Point|undefined,previousFocus:Point|undefined;
    let selectionStart:Point|null=null;
    const gaps=createGapSelection(()=>{selectingText.current=true;});gapSelection.current=gaps;
    const track=(event:PointerEvent)=>{cursor.current={x:event.clientX,y:event.clientY};if(mouseHeld&&selectionStart&&Math.hypot(event.clientX-selectionStart.x,event.clientY-selectionStart.y)>=3)selectingText.current=true;gaps.move(event);};
    const selectionScroll=(event:Event)=>{if((event.target as Element)?.matches?.('.android-reading'))gaps.refresh();};
    let drag:{root:HTMLElement;point:Point;moved:boolean}|null=null;
    const down=(event:PointerEvent)=>{
      if(event.pointerType!=="mouse"||event.button!==0)return;mouseHeld=true;
      const target=event.target as Element,root=target.closest<HTMLElement>(".android-reading");
      cancelHeadingNavigation(root);
      selectingText.current=false;
      const candidate=!!root&&!event.altKey&&!target.closest('a,button,input,textarea,summary,img,.note-image,.interactive-chart,[data-independent-zoom]');
      selectionStart=candidate?{x:event.clientX,y:event.clientY}:null;
      // Freeze the presented geometry before the browser begins selecting.
      // CSS zoom rounds small borders/line boxes differently from transforms;
      // switching here can move the intended line out from under the pointer.
      if(candidate){window.clearTimeout(settleTimer.current);gaps.start(event,root!);}
      if(root && (reference.current?.mode==="reader" || reference.current?.fullscreen) && event.altKey && !target.closest("a,button,input,textarea,summary,img,.note-image,[data-independent-zoom]")){
        drag={root,point:{x:event.clientX,y:event.clientY},moved:false};root.setPointerCapture(event.pointerId);
      }
    };
    const pan=(event:PointerEvent)=>{if(!drag)return;const dx=event.clientX-drag.point.x,dy=event.clientY-drag.point.y;if(!drag.moved && Math.hypot(dx,dy)<4)return;drag.moved=true;drag.root.classList.add("is-panning");window.getSelection()?.removeAllRanges();rememberWindowedScrollSource(drag.root,-dy);if(!reference.current?.centerLock)drag.root.scrollLeft-=dx;drag.root.scrollTop-=dy;drag.point={x:event.clientX,y:event.clientY};event.preventDefault();};
    const up=()=>{mouseHeld=false;selectionStart=null;gaps.end();if(selectingText.current){selectingText.current=false;settleSelection();}drag?.root.classList.remove("is-panning");drag=null;};
    document.addEventListener('scroll',selectionScroll,true);
    document.addEventListener("pointermove",track);document.addEventListener("pointerdown",down);document.addEventListener("pointerup",up);window.addEventListener("blur",up);
    document.addEventListener("pointermove",pan);document.addEventListener("pointercancel",up);
    const distance = (touches: TouchList) => Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
    let touchY:number|undefined;
    const start = (event: TouchEvent) => { touchY=event.touches.length===1?event.touches[0].clientY:undefined;cancelHeadingNavigation((event.target as Element).closest('.android-reading'));if (event.touches.length === 2 && !(event.target as Element).closest("input,textarea,[data-independent-zoom]")) { zoomGestureAt.current=Date.now();window.clearTimeout(zoomTimer.current);cancelAnimationFrame(zoomFrame.current);zoomFrame.current=0;zoomTarget.current=null;window.clearTimeout(settleTimer.current);startDistance = distance(event.touches); startZoom = zoomReference.current; pinching = true;previousFocus={x:(event.touches[0].clientX+event.touches[1].clientX)/2,y:(event.touches[0].clientY+event.touches[1].clientY)/2}; } };
    const move = (event: TouchEvent) => { if(event.touches.length===1){const target=event.target as Element,root=target.closest<HTMLElement>('.android-reading');if(root&&touchY!==undefined&&!target.closest('textarea,input,[data-independent-zoom]'))rememberWindowedScrollSource(root,touchY-event.touches[0].clientY);touchY=event.touches[0].clientY;}else touchY=undefined;if (event.touches.length === 2 && pinching && startDistance > 0) {
      event.preventDefault(); zoomTarget.current = null; zoomReference.current = clampPreviewZoom(startZoom * distance(event.touches) / startDistance);
      focus={x:(event.touches[0].clientX+event.touches[1].clientX)/2,y:(event.touches[0].clientY+event.touches[1].clientY)/2};
      // Coalesce input to one visual update per frame. Parsing Markdown and
      // crossing the native bridge are deliberately excluded from pinch frames.
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; applyZoomStyle(focus,previousFocus);previousFocus=focus; });
    } };
    const end = (event: TouchEvent) => { if (pinching && event.touches.length < 2) { pinching = false;if(frame){cancelAnimationFrame(frame);frame=0;applyZoomStyle(focus,previousFocus);previousFocus=focus;}settleSelection(); void invoke("zoom_changed", { zoom: zoomReference.current,fullscreen:reference.current?.fullscreen }); } };
    document.addEventListener("touchstart", start, { passive: true }); document.addEventListener("touchmove", move, { passive: false }); document.addEventListener("touchend", end); document.addEventListener("touchcancel", end);
    const wheel = (event:WheelEvent) => {
      const target=event.target as Element,root=target.closest('.android-reading');cancelHeadingNavigation(root);
      const heldPageZoom=(mouseHeld||!!(event.buttons&1))&&!!root&&!selectingText.current&&!window.getSelection()?.toString();
      if ((event.ctrlKey || event.metaKey || heldPageZoom) && !target.closest("textarea,input,[data-independent-zoom]")) { event.preventDefault();gaps.cancelStationary();window.supermdZoomBy?.(Math.exp(-event.deltaY*.002),{x:event.clientX,y:event.clientY}); }
      else if(root instanceof HTMLElement&&!event.ctrlKey&&!event.metaKey&&!target.closest('textarea,input,.interactive-chart,.note-image,[data-independent-zoom]')){rememberWindowedScrollSource(root,event.deltaY*(event.deltaMode===1?16:event.deltaMode===2?root.clientHeight:1));if(Math.abs(event.deltaY)>2)requestChrome('hide');}
    };
    const scrollKey=(event:KeyboardEvent)=>{
      const target=event.target as Element;
      if(event.defaultPrevented||event.ctrlKey||event.metaKey||event.altKey||target.closest('input,textarea,button,summary,[contenteditable="true"],.image-viewer,.media-dialog,.reading-search'))return;
      const root=target.closest<HTMLElement>('.android-reading')||(target===document.body?document.querySelector<HTMLElement>('.android-reading'):null);
      if(!root)return;
      const page=root.clientHeight*.875;
      const delta=event.key==='ArrowUp'?-40:event.key==='ArrowDown'?40:event.key==='PageUp'?-page:event.key==='PageDown'?page:event.key===' '?(event.shiftKey?-page:page):0;
      if(delta)rememberWindowedScrollSource(root,delta);
    };
    document.addEventListener("wheel",wheel,{passive:false});
    document.addEventListener('keydown',scrollKey);
    return () => {gaps.end();gapSelection.current=null;document.removeEventListener('scroll',selectionScroll,true);document.removeEventListener('keydown',scrollKey);document.removeEventListener("pointermove",pan);document.removeEventListener("pointercancel",up);document.removeEventListener("pointermove",track);document.removeEventListener("pointerdown",down);document.removeEventListener("pointerup",up);window.removeEventListener("blur",up);cancelAnimationFrame(frame); document.removeEventListener("wheel",wheel); document.removeEventListener("touchstart", start); document.removeEventListener("touchmove", move); document.removeEventListener("touchend", end); document.removeEventListener("touchcancel", end); };
  }, []);
  const update = useCallback((content: string,changes?:SourceChange[]) => {
    const previous=reference.current!;
    if(content===previous.content)return;
    if(!replaying.current){
      const history=histories.current.get(previous.id)||{undo:[],redo:[],last:0},now=Date.now();
      recordHistory(history,previous.content,content,now);
      histories.current.delete(previous.id);histories.current.set(previous.id,history);
      trimHistories(previous.id);
    }
    const next = { ...reference.current!, content }; setState(next); reference.current = next;
    // The bridge receives every edit immediately, so closing/rotating cannot lose
    // a pending debounced WebView update. Disk snapshots are debounced natively.
    window.clearTimeout(pendingChange.current);
    const delivery=(next as ReaderState&{editProtocol?:number}).editProtocol===1?edits.current!.change(next.id,content,changes):invoke("document_changed",{id:next.id,content});
    void delivery.then(()=>setEditError(''),error=>setEditError(String(error)));
  }, []);
  useEffect(()=>{
    let pending=false,disposed=false;
    window.supermdAgentRequest=(request,callback)=>{
      const reply=(result:unknown,error='')=>{if(disposed)return;if(callback)callback(result,error);else void invoke('agent_result',{requestId:request.requestId,result,error});};
      if(pending){reply(null,'The reader is handling another agent request; retry shortly.');return;}
      pending=true;
      void (async()=>{
        const current=reference.current;if(!current)throw Error('The reader is not ready');
        if((current as ReaderState&{editProtocol?:number}).editProtocol===1)await edits.current!.flush(current.id);
        const note=reference.current;if(!note||note.id!==current.id)throw Error('The active tab changed; refresh the tab list');
        const revision=await agentRevision(note.content);
        if(reference.current?.id!==note.id||reference.current.content!==note.content)throw Error('The note changed while reading; retry');
        const base={tabId:note.id,revision,sourceLength:agentCharLength(note.content)};
        if(request.action==='flush_current')return base;
        if(request.action==='list_tabs'){
          const tabs=Array.isArray(request.tabs)?request.tabs:[];
          return {tabs:tabs.map(item=>{const tab=item as Record<string,unknown>;return tab.id===note.id?{...tab,...base,id:note.id}:tab;})};
        }
        if(request.tabId!==undefined&&request.tabId!==note.id)throw Error('Select this tab before requesting its live reader');
        if(request.expectedRevision!==undefined&&request.expectedRevision!==revision)throw Error('Revision conflict: the note changed; read it again before editing');
        if(request.action==='read_tab')return {...base,...agentRead(note.content,request.offset,request.limit,request.heading,request.view)};
        if(request.action==='outline_tab'){const headings=agentOutline(note.content);return {...base,headings:headings.slice(0,80),total:headings.length,truncated:headings.length>80};}
        if(request.action==='search_tab')return {...base,...agentSearch(note.content,request.query,request.limit,request.context)};
        if(request.action==='list_diagrams'){
          const diagrams=agentDiagrams(note.content);return {...base,diagrams:diagrams.slice(0,80).map(item=>diagramMetadata(note.content,item)),total:diagrams.length,truncated:diagrams.length>80};
        }
        if(request.action==='get_diagram'||request.action==='get_diagram_image'){
          if(request.expectedRevision!==revision)throw Error('A current expectedRevision is required to retrieve this diagram');
          const diagram=agentDiagrams(note.content).find(item=>item.id===request.diagramId);if(!diagram)throw Error('Diagram not found in this revision');
          if(request.action==='get_diagram')return {...base,...diagramMetadata(note.content,diagram),...agentRead(diagram.source,request.offset,request.limit,undefined,'source')};
          const imageFormat=request.action==='get_diagram_image'&&request.imageFormat==='jpeg'?'jpeg':'png';
          const image=await mediaBytes(await diagramMedia(diagram,note.path),imageFormat,typeof request.width==='number'?Math.min(1600,Math.max(64,Math.round(request.width))):1600);return {...base,diagramId:diagram.id,mime_type:image.mimeType,data:image.body,width:image.width,height:image.height};
        }
        if(request.action==='get_context'){
          const host=document.querySelector<HTMLElement>('.android-reading,.cm-scroller'),bounds=host?.getBoundingClientRect();
          const visible=host&&bounds?Array.from(host.querySelectorAll<HTMLElement>('h1,h2,h3,h4,p,li,pre')).filter(element=>{const box=element.getBoundingClientRect();return box.bottom>bounds.top&&box.top<bounds.bottom&&box.height>0;}).slice(0,30):[];
          const visibleText=visible.map(element=>{const copy=element.cloneNode(true) as HTMLElement;copy.querySelectorAll('.katex-mathml,button,script,style').forEach(node=>node.remove());return copy.textContent?.trim()??'';}).join('\n').slice(0,2000);
          const range=host?visibleSourceRange(host,note.content):null,offset=range?.start??(host?(note.mode==='editor'?(editorReadingOffset(note.id)??0):readingOffset(host)):0);
          const requestedContextLimit=typeof request.limit==='number'&&Number.isFinite(request.limit)?Math.max(1,Math.min(12000,Math.floor(request.limit))):6000;
          const sourceOffset=agentCharLength(note.content.slice(0,offset)),sourceLimit=Math.max(1,Math.min(requestedContextLimit,agentCharLength(note.content.slice(offset,range?.end??offset+requestedContextLimit))));
          const diagrams=agentDiagrams(note.content).filter(item=>range?item.end>range.start&&item.start<range.end:item.start>=offset&&item.start<offset+requestedContextLimit);
          const visiblePage=agentRead(range?note.content.slice(0,range.end):note.content,sourceOffset,sourceLimit);
          // The viewport bounds the page text, not the document's pagination.
          const visibleSource={...visiblePage,total_chars:base.sourceLength,next_offset:visiblePage.end<base.sourceLength?visiblePage.end:null,truncated:visiblePage.end<base.sourceLength};
          const viewportRect=host?.getBoundingClientRect();
          const left=viewportRect?Math.max(0,viewportRect.left):0,top=viewportRect?Math.max(0,viewportRect.top):0;
          const right=viewportRect?Math.min(window.innerWidth,viewportRect.right):0,bottom=viewportRect?Math.min(window.innerHeight,viewportRect.bottom):0;
          return {...base,mode:note.mode,zoom:zoomReference.current,reading:{offset:sourceOffset,scrollFraction:host?host.scrollTop/Math.max(1,host.scrollHeight-host.clientHeight):0,heading:visible.find(element=>/^H[1-6]$/.test(element.tagName))?.textContent?.slice(0,300)??'',visibleText},visibleSource,diagrams:diagrams.slice(0,30).map(item=>diagramMetadata(note.content,item)),viewport:{x:left,y:top,width:Math.max(0,right-left),height:Math.max(0,bottom-top),viewportWidth:window.innerWidth,viewportHeight:window.innerHeight,devicePixelRatio:window.devicePixelRatio},selection:{text:window.getSelection()?.toString().slice(0,2000)??''}};
        }
        if(request.action==='latex_review'){
          const repairs=suggestMathRepairs(note.content);let remaining=48000;
          const view=[];
          for(const [index,repair] of repairs.slice(0,40).entries()){
            const item={index,before:repair.before.slice(0,2000),after:repair.after.slice(0,2000),reason:repair.reason},size=JSON.stringify(item).length;
            if(size>remaining)break;remaining-=size;view.push(item);
          }
          return {...base,repairs:view,total:repairs.length,truncated:view.length<repairs.length};
        }
        if(request.action==='patch_tab'||request.action==='latex_apply'){
          if(typeof request.expectedRevision!=='string'||request.expectedRevision!==revision)throw Error('A current expectedRevision is required to edit a tab');
          let content:string,applied=0;
          if(request.action==='latex_apply'){
            const selected=request.repairIndices;
            if(!Array.isArray(selected)||!selected.length||selected.length>40||selected.some(index=>!Number.isInteger(index)||index<0))throw Error('Choose 1–40 repairIndices from latex_review');
            const repairs=suggestMathRepairs(note.content),indices=Array.from(new Set(selected)) as number[];
            if(indices.some(index=>index>=repairs.length))throw Error('A selected repair is no longer available');
            content=applyMathRepairs(note.content,indices.map(index=>repairs[index]));applied=indices.length;
          }else content=applyAgentPatches(note.content,request.operations);
          if(reference.current?.id!==note.id||reference.current.content!==note.content)throw Error('Revision conflict: typing changed the note before the edit');
          const history=histories.current.get(note.id);if(history)history.last=0;
          update(content);const nextHistory=histories.current.get(note.id);if(nextHistory)nextHistory.last=0;
          if((note as ReaderState&{editProtocol?:number}).editProtocol===1)await edits.current!.flush(note.id);
          return {tabId:note.id,revision:await agentRevision(content),changed:content!==note.content,applied};
        }
        if(request.action==='export_document'){
          const format=request.format;if(!['pdf','smd','md'].includes(String(format)))throw Error('Export format must be pdf, smd or md');
          const prepared=format==='pdf'?await preparePdf(note.content,note.path,note.python||'embedded'):format==='smd'?await prepareFmd(note.content,note.path):{content:note.content};
          return await invoke('agent_export_native',{...prepared,id:note.id,expectedRevision:revision,requestId:request.requestId,format,filename:request.filename,options:request.options});
        }
        throw Error('Unsupported live reader action');
      })().then(result=>reply(result),error=>reply(null,error instanceof Error?error.message:'Agent request failed')).finally(()=>{pending=false;});
    };
    return()=>{disposed=true;delete window.supermdAgentRequest;};
  },[update]);
  if (!state) return <div className="reader-loading" role="status"><span className="expressive-loading-shape" aria-hidden="true"/>Opening your workspace</div>;
  return <DocumentAppearance.Provider value={documentAppearance}><div className={`android-document mode-${state.mode}`}>
    {themeGuide&&<ThemeGuideDialog close={()=>setThemeGuide(false)}/>}
    {pdfExport&&<div className="reader-export-backdrop"><section className="reader-export-progress" role="dialog" aria-modal="true" aria-label="Exporting PDF" onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();void cancelPdfExport();}}}>
      <h2>Exporting PDF</h2>
      <div className="reader-export-status">
        <ExportProgressIndicator completed={pdfExport.phase==='preparing'?pdfExport.completed:undefined} total={pdfExport.phase==='preparing'?pdfExport.total:undefined}/>
        <div><p role="status">{pdfExport.cancelRequested?'Cancelling export…':pdfExport.phase==='preparing'?'Preparing text, diagrams and images':pdfExport.phase==='typesetting'?'Typesetting your document':'Saving to destination'}</p>
        <p className="reader-export-detail">{pdfExport.phase==='publishing'?'Finishing the destination write safely.':pdfExport.phase==='preparing'&&pdfExport.total>0?`${pdfExport.completed} of ${pdfExport.total} preparation steps`:'Your original note is unchanged.'}</p></div>
      </div>
      {pdfExport.phase!=='publishing'&&<button type="button" autoFocus disabled={pdfExport.cancelRequested} onClick={()=>void cancelPdfExport()}>Cancel export</button>}
    </section></div>}
    {editError&&<div role="alert" className="reader-edit-error">{editError}</div>}
    <MediaThemeFilters colors={state.colors} dark={state.dark}/>
    {searching && <ReadingSearch content={state.content} close={()=>setSearching(false)} onChange={update} sourceSession={state.mode==="editor"||state.mode==="split"?state.id:undefined}/>}
    <ImageViewer />
    {repairing && <MathRepairPanel content={state.content} apply={update} close={()=>setRepairing(false)} />}
    <MediaTools key={state.id} documentId={state.id} content={state.content} documentPath={state.path} onInsert={(text, point) => { const content = reference.current!.content; const from = Math.min(point?.from ?? content.length, content.length); const to = Math.max(from, Math.min(point?.to ?? from, content.length)); update(content.slice(0, from) + text + content.slice(to)); }} onNotice={(error) => { void invoke("export_failed", { error }); }} />
    {(state.mode === "editor" || state.mode === "split") && <section className="android-source"><SourceEditor key={state.id} sessionId={state.id} value={state.content} onChange={update} dark={state.dark} focusMode={state.fullscreen} latexAutofix={state.latexAutofix} spellCheck={state.spellCheck} grammarCheck={state.grammarCheck} /></section>}
    {state.mode === "live" && <section className="android-reading" data-full-document-accessibility={state.fullDocumentAccessibility ? "true" : undefined}><div className="reader-chrome-spacer" aria-hidden="true"/><div key={state.id} className="document-page-space"><div className="document-page"><LiveDocument key={state.id} latexAutofix={state.latexAutofix} spellCheck={state.spellCheck} grammarCheck={state.grammarCheck} markdown={state.content} onChange={update} documentPath={state.path} python={state.python || "embedded"} dark={false} trustedImageHosts={trustedHosts} onTrustImageHost={trustHost} fullDocumentAccessibility={state.fullDocumentAccessibility} /></div></div></section>}
    {(state.mode === "reader" || state.mode === "split") && <section className="android-reading" data-full-document-accessibility={state.fullDocumentAccessibility ? "true" : undefined}><div className="reader-chrome-spacer" aria-hidden="true"/><div key={state.id} className="document-page-space"><div className="document-page"><DocumentPreview markdown={state.content} onChange={update} documentPath={state.path} python={state.python || "embedded"} dark={false} trustedImageHosts={trustedHosts} onTrustImageHost={trustHost} fullDocumentAccessibility={state.fullDocumentAccessibility} sourceAnalysis={readerAnalysis?.source===state.content?readerAnalysis:undefined} /></div></div></section>}
  </div></DocumentAppearance.Provider>;
}
createRoot(document.getElementById("root")!).render(<Reader />);
