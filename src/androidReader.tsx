import { createRoot } from "react-dom/client";
import {flushSync} from 'react-dom';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import "@fontsource-variable/manrope";
import "@fontsource-variable/jetbrains-mono";
import "@fontsource-variable/jetbrains-mono/wght-italic.css";
import "@fontsource-variable/roboto";
import "@fontsource-variable/roboto/wght-italic.css";
import "@fontsource-variable/noto-sans";
import "@fontsource-variable/noto-sans/wght-italic.css";
import "@fontsource-variable/noto-serif";
import "@fontsource-variable/noto-serif/wght-italic.css";
import "katex/dist/katex.min.css";
import "./styles.css";
import "./androidReader.css";
import "./customTheme.css";
import { isBuiltinReaderFont, resolveReaderFontStack } from "./readerFonts";
import Editor, { cachedEditorHistory, editorHistory, editorSelectedText, exportEditorSession, formatEditorSession, importEditorSession, type PortableEditorSession } from "./components/Editor";
import { extractSelectedText } from "./copySource";
import {applySharedAnchor,captureSharedAnchor,clearProgrammaticAnchorScroll,detectSplitPaneFromTarget,isProgrammaticAnchorScroll,primeEditorAnchor,revealEditorOffset,type AnchorViewMode,type SharedSourceAnchor,type SplitAnchorPane} from "./sourceAnchor";
import { exportRenderedViews, importRenderedViews } from "./renderedOutputs";
import LiveEditor, { formatActiveLiveBlock, replayActiveLiveBlockHistory } from "./components/LiveEditor";
import MarkdownPreview from "./components/MarkdownPreview";
import { invoke } from "./nativeBridge";
import {ReaderEdits,type SourceChange} from './readerEdits';
import { preparePdf } from "./preparePdf";
import type { ExportOptions,ReaderAccessibilityPreference } from "./types";
import { clampPreviewZoom } from "./zoom";
import MediaTools from "./components/MediaTools";
import { dismissReaderOverlay, hasReaderOverlay } from "./readerOverlays";
import { prepareFmd } from "./documentMedia";
import { NoteRemoteImageConsentStore } from "./remoteImageConsent";
import { prepareMarkdownExport } from "./markdownExport";
import ImageViewer from "./components/ImageViewer";
import MathRepairPanel from "./components/MathRepairPanel";
import ThemeGuideDialog from "./components/ThemeGuideDialog";
import { markScrollInput, scrollInputVersion } from "./scrollAnchor";
import ReadingSearch, { type ReadingSearchSeed } from "./components/ReadingSearch";
import type { Point } from "./focalZoom";
import { invalidateDocumentZoom } from "./documentZoom";
import { documentOutline, navigateToHeading, cancelHeadingNavigation, resolveHeadingOffset } from "./documentNavigation";
import { readerSourceAnalysis } from "./readerSourceAnalysis";
import {OutlineWorkerClient} from './outlineWorker';
import {recordHistory,replayHistory,historySize,validHistory,type NoteHistory} from './noteHistory';
import {loadReadingLocation,saveReadingLocation,type ReadingLocation} from './readingLocations';
import {mediaFilter,mediaTone,type MediaAppearance} from './mediaAppearance';
import MediaThemeFilters from './components/MediaThemeFilters';
import ExportProgressIndicator from './components/ExportProgressIndicator';
import {DocumentAppearance} from './documentAppearance';
import {applyCustomStyle,type CustomStyle} from './customTheme';
import {isTypewriterShortcutEvent,setTypewriterScroll} from './typewriterScroll';
import {computeAgentDocumentRequest,useReaderAgentRuntime} from './readerAgentRuntime';
import {useReaderGestureControls,useReaderGesturesAndZoom} from './useReaderGesturesAndZoom';
export {computeAgentDocumentRequest};
const DocumentPreview = memo(MarkdownPreview);
const LiveDocument = memo(LiveEditor);
const SourceEditor = memo(Editor);
function isTextEntryField(target: EventTarget | null): boolean {
  if (target instanceof HTMLTextAreaElement) return true;
  if (!(target instanceof HTMLInputElement)) return false;
  return !/^(?:checkbox|radio|range|button|submit|reset|file|color|image|hidden)$/i.test(target.type);
}
interface PdfExportStatus {id:string;phase:'preparing'|'typesetting'|'publishing';completed:number;total:number;cancelRequested?:boolean}

interface NoteView { editor?: PortableEditorSession; history?:NoteHistory; top?: number; anchor?: SharedSourceAnchor; rendered?: ReturnType<typeof exportRenderedViews> }
function parseImportedAnchor(raw: unknown): SharedSourceAnchor | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const candidate = raw as Record<string, unknown>;
  if (typeof candidate.offset !== "number" || !Number.isFinite(candidate.offset) || candidate.offset < 0) return undefined;
  if (typeof candidate.zoom !== "number" || !Number.isFinite(candidate.zoom) || candidate.zoom <= 0) return undefined;
  if (candidate.mode !== "reader" && candidate.mode !== "live" && candidate.mode !== "editor" && candidate.mode !== "split") return undefined;
  return {
    offset: candidate.offset,
    ...(typeof candidate.caretOffset === "number" && Number.isFinite(candidate.caretOffset) && candidate.caretOffset >= 0 ? { caretOffset: candidate.caretOffset } : {}),
    mode: candidate.mode,
    zoom: candidate.zoom,
    ...(typeof candidate.readingTop === "number" && Number.isFinite(candidate.readingTop) && candidate.readingTop >= 0 ? { readingTop: candidate.readingTop } : {}),
    ...(typeof candidate.editorTop === "number" && Number.isFinite(candidate.editorTop) && candidate.editorTop >= 0 ? { editorTop: candidate.editorTop } : {}),
  };
}
interface ReaderState extends ReaderAccessibilityPreference { id: string; content: string; path: string | null; mode: "live" | "editor" | "reader" | "split"; dark: boolean; fullscreen: boolean; font: string; size: number; editProtocol?: number; latexAutofix?:boolean; typewriterScroll?:boolean; spellCheck?:boolean; grammarCheck?:boolean; width?: number; widthPercent?:number; lineHeight?:number; colors: Record<string, string>; zoom: number; motion?: boolean; python?: string; viewState?: NoteView }
declare global { interface Window {supermdThemeGuide?:()=>void;supermdDismiss?:()=>boolean;supermdSetZoom?:(zoom:number,requestedAt?:number)=>void;supermdHeading?:(id:string,offset?:number)=>void;supermdHistory?:(direction:"undo"|"redo")=>void;supermdFormat?:(action:string)=>boolean;supermdNativeWheel?:(dx:number,dy:number,point:Point,held:boolean,modifier?:boolean)=>void;supermdToggleTypewriter?:()=>void;} }
declare global { interface Window { supermdLoad?: (state: Omit<ReaderState, "pendingHeading"> & { pendingHeading?: PendingHeadingNavigation | string | null }) => void; supermdExport?: (options: ExportOptions) => void; supermdExportMarkdown?: (archive?: boolean) => void; supermdFind?: (replaceOrQuery?: boolean | string, options?: { caseSensitive?: boolean; replace?: boolean }) => void; supermdFindStep?: (direction?: number) => void; supermdPortable?: (save: boolean) => void; supermdZoomBy?: (factor:number,focus?:Point)=>void; supermdResetZoom?: ()=>void; supermdRepairMath?: ()=>void; supermdFlush?: (operation:Record<string,string>)=>void } }
declare global { interface Window {supermdChromeInset?:(height:number)=>void} }
declare global { interface Window {supermdSavePosition?:()=>void;supermdBeforeNavigate?:()=>Promise<void>} }
declare global {interface Window {supermdExportPhase?:(id:string,phase:'typesetting'|'publishing')=>void}}
interface PendingHeadingNavigation { heading: string; token: string }
interface ReaderState { centerLock?:boolean; customStyle?:CustomStyle; restorePosition?:boolean; readingLocation?:ReadingLocation|null; pendingHeading?:PendingHeadingNavigation|null; imageAppearance?:MediaAppearance; svgAppearance?:MediaAppearance; imageContrast?:number; seededFind?:{query:string;caseSensitive?:boolean}|null }
export function Reader() {
  const [state, setState] = useState<ReaderState | null>(null);
  const readerAnalysis=useMemo(()=>state?readerSourceAnalysis(state.mode,state.content):null,[state?.mode,state?.content]);
  const [repairing, setRepairing] = useState(false);
  const [searching,setSearching] = useState(false);
  const [searchReplace,setSearchReplace] = useState(false);
  const [searchSeed,setSearchSeed] = useState<ReadingSearchSeed|null>(null);
  const searchSeedNonce = useRef(0);
  const searchingRef = useRef(false); searchingRef.current = searching;
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
  useLayoutEffect(()=>{
    window.supermdExportPhase=(id,phase)=>{const owner=exportOwner.current;if(owner?.id!==id)return;owner.phase=phase;setPdfExport(value=>value?.id===id?{...value,phase,cancelRequested:false}:value);};
    return()=>{delete window.supermdExportPhase;};
  },[]);
  const [trustedHosts,setTrustedHosts] = useState<string[]>([]);
  const trustedHostsRef = useRef(trustedHosts); trustedHostsRef.current = trustedHosts;
  const noteImageConsent = useRef(new NoteRemoteImageConsentStore());
  const [imageConsentVersion, setImageConsentVersion] = useState(0);
  const documentAppearance=useMemo(()=>({dark:state?.dark??false,svgAppearance:state?.svgAppearance,ink:state?.colors.primary,text:state?.colors.text,colors:state?.colors}),[state?.dark,state?.svgAppearance,JSON.stringify(state?.colors)]);
  const trustHost = useCallback((host:string)=>setTrustedHosts(current=>{if(current.includes(host))return current;const next=[...current,host];trustedHostsRef.current=next;return next;}),[]);
  const reference = useRef(state); reference.current = state;
  const approveImageUrl = useCallback((noteId:string|undefined,url:string)=>{if(noteId&&noteImageConsent.current.approve(noteId,url))setImageConsentVersion(value=>value+1);},[]);
  const recordRemoteImageLoaded = useCallback((noteId:string|undefined,url:string,data:string)=>{if(noteId)noteImageConsent.current.recordLoaded(noteId,url,data);},[]);
  const approvedImageUrls = useMemo(()=>noteImageConsent.current.approvedUrls(state?.id),[state?.id,imageConsentVersion]);
  const consumedHeadingToken = useRef<string | null>(null);
  const suppressedRestoreToken = useRef<string | null>(null);
  const suppressedRestoreKey = useRef<string | null>(null);
  const legacyHeadingSeq = useRef(0);
  const changeTypewriter = useCallback((enabled: boolean) => {
    setTypewriterScroll(enabled, { persist: false });
    const current = reference.current;
    if (current && current.typewriterScroll !== enabled) {
      const next = { ...current, typewriterScroll: enabled };
      reference.current = next;
      setState(next);
    }
    void invoke("typewriter_scroll", { enabled }).catch(() => {});
  }, []);
  const outlineWorker=useRef<OutlineWorkerClient|null>(null);
  const edits=useRef<ReaderEdits|null>(null);
  if(!edits.current)edits.current=new ReaderEdits((command,args)=>invoke(command,args));
  const [editError,setEditError]=useState('');
  const [themeGuide,setThemeGuide]=useState(false);
  const pendingChange = useRef(0);
  const noteViews = useRef(new Map<string, NoteView>());
  const histories=useRef(new Map<string,NoteHistory>());
  const trimHistories=(active:string)=>{let retained=[...histories.current.values()].reduce((size,h)=>size+historySize(h),0);for(const [id,cached] of histories.current){if(histories.current.size<=40&&retained<=4_000_000)break;if(id===active)continue;histories.current.delete(id);retained-=historySize(cached);}};
  const replaying=useRef(false);
  const loadedFonts=useRef(new Map<string,Promise<FontFace>>());
  const savePosition=useRef(()=>{});
  const layoutKey=useRef('');
  const customLayout=useRef<{id:string;mode:string;metrics:string}|null>(null);
  const modeAnchor=useRef<SharedSourceAnchor|null>(null);
  const splitPane=useRef<SplitAnchorPane|null>(null);
  const restoringSplit=useRef(false);
  const restoringSplitSeq=useRef(0);
  const splitScrollTops=useRef<{editor:number|null;preview:number|null}>({editor:null,preview:null});
  const gestureControls=useReaderGestureControls({reference,splitPane});
  const {zoomReference,zoomTarget,settleSelection,anchors,applyZoomStyle,anchored,cancelZoomGlide,clearViewportGestures,zoomBy,setZoom,resetZoom,handleNativeWheel}=gestureControls;
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
    const delivery=next.editProtocol===1?edits.current!.change(next.id,content,changes):invoke("document_changed",{id:next.id,content});
    void delivery.then(()=>setEditError(''),error=>setEditError(String(error)));
  }, []);
  useReaderAgentRuntime({reference,edits,zoomReference,histories,trustedHostsRef,noteImageConsent,update});
  useLayoutEffect(() => {
    window.supermdSavePosition=()=>savePosition.current();
    window.supermdSelectedText=()=>extractSelectedText({source:reference.current?.content,editorSelection:()=>reference.current?editorSelectedText(reference.current.id):null});
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
    window.supermdDismiss=dismissReaderOverlay;
    window.supermdLoad = (incoming) => {
      const old = reference.current;
      // Native omits content it received from this reader, unchanged since.
      const {contentUnchanged,seededFind,...rest}=incoming as ReaderState&{contentUnchanged?:boolean};
      const applyIncomingFind=()=>{
        if(seededFind&&typeof seededFind.query==='string'){
          searchSeedNonce.current+=1;
          setSearchSeed({query:seededFind.query.slice(0,200),caseSensitive:seededFind.caseSensitive,nonce:searchSeedNonce.current});
          setSearchReplace(false);
          setSearching(true);
          requestAnimationFrame(()=>window.dispatchEvent(new CustomEvent("supermd-find-focus",{detail:{replace:false}})));
        }
      };
      if(contentUnchanged&&(!old||old.id!==rest.id))return;
      const next=(contentUnchanged?{...rest,content:old!.content}:rest) as ReaderState;
      const rawPending=(rest as {pendingHeading?:PendingHeadingNavigation|string|null}).pendingHeading;
      if(typeof rawPending==='string'){
        const trimmed=rawPending.trim();
        next.pendingHeading=trimmed?{heading:trimmed,token:`legacy:${next.id}:${++legacyHeadingSeq.current}:${trimmed}`}:null;
      }
      if(old&&(old.id!==next.id||old.mode!==next.mode||old.fullscreen!==next.fullscreen))clearViewportGestures();
      const draft=edits.current!.unacknowledged(next.id);
      if(draft!==undefined&&next.content!==draft&&!contentUnchanged){
        next.content=draft;
        setEditError('A native update arrived while edits were awaiting acknowledgement. Your editor draft has been kept. Save or close will wait for a verified edit session.');
      }
      if(next.editProtocol===1){
        edits.current!.open(next.id,next.content);
        // Retiring an untouched stale baseline also retires its reader-only
        // warning. Never hide an error while an unacknowledged draft remains.
        if(draft===undefined&&(old?.id!==next.id||old?.content!==next.content))setEditError('');
      }
      if(old?.id===next.id)next.readingLocation=old.readingLocation;
      if(old?.id===next.id&&!next.pendingHeading&&old.pendingHeading)next.pendingHeading=old.pendingHeading;
      const hasNewPendingHeading = Boolean(next.pendingHeading?.token && next.pendingHeading.token !== old?.pendingHeading?.token);
      if(old&&(old.id!==next.id||old.mode!==next.mode||old.fullscreen!==next.fullscreen))document.querySelectorAll('.android-reading').forEach(cancelHeadingNavigation);
      if(old&&(old.id!==next.id||old.mode!==next.mode)){const history=histories.current.get(next.id);if(history)history.last=0;}
      if(old&&old.id===next.id&&old.mode!==next.mode){
        if(hasNewPendingHeading){
          modeAnchor.current=null;
          splitPane.current=null;
          primeEditorAnchor(next.id,null);
        }else{
          const root=document.querySelector<HTMLElement>(".android-reading");
          const captured=captureSharedAnchor({
            id:old.id,
            mode:old.mode,
            zoom:zoomReference.current,
            readingRoot:root,
            preferredSplitPane:splitPane.current,
          });
          modeAnchor.current=captured;
          splitPane.current=null;
          if(next.mode==="editor"||next.mode==="split"){
            primeEditorAnchor(next.id,{offset:captured.offset,caretOffset:captured.caretOffset});
          }else{
            primeEditorAnchor(next.id,null);
          }
        }
      }
      if(old&&[...new Set([...Object.keys(old),...Object.keys(next)])].every(key=>key==="zoom"&&old.fullscreen===next.fullscreen?true:key==="viewState"?!next.viewState:key==="colors"||key==="customStyle"||key==="pendingHeading"?JSON.stringify((old as any)[key])===JSON.stringify((next as any)[key]):(old as any)[key]===(next as any)[key])){applyIncomingFind();return;}
      if (old && old.id !== next.id) {
        savePosition.current();
        const outgoingAnchor=captureSharedAnchor({
          id:old.id,
          mode:old.mode,
          zoom:zoomReference.current,
          readingRoot:document.querySelector<HTMLElement>(".android-reading"),
          preferredSplitPane:splitPane.current,
        });
        noteViews.current.set(old.id, {top: outgoingAnchor.readingTop ?? 0, anchor: outgoingAnchor, rendered: exportRenderedViews(old.content)});
        if (noteViews.current.size > 40) noteViews.current.delete(noteViews.current.keys().next().value!);
        if (suppressedRestoreKey.current?.startsWith(`${old.id}:`)) suppressedRestoreKey.current = null;
        modeAnchor.current=null;
        splitPane.current=null;
      }
      if(old&&old.id===next.id&&old.path!==next.path&&next.restorePosition!==false){
        savePosition.current();
        const oldPath=old.path===old.id?null:old.path;
        const nextPath=next.path===next.id?null:next.path;
        if(nextPath){
          const snap=captureSharedAnchor({id:old.id,mode:old.mode,zoom:zoomReference.current,readingRoot:document.querySelector<HTMLElement>(".android-reading"),preferredSplitPane:splitPane.current});
          const location=loadReadingLocation(oldPath)??{top:old.mode==="editor"?(snap.editorTop??0):(snap.readingTop??0),offset:snap.offset,zoom:zoomReference.current,mode:old.mode};
          saveReadingLocation(nextPath,location);
          void invoke("reading_position",{id:next.id,location}).catch(()=>{});
        }
      }
      if (next.viewState && old?.id !== next.id) {
        importEditorSession(next.id, next.viewState.editor);
        importRenderedViews(next.content, next.viewState.rendered);
        const history=next.viewState.history;
        if(validHistory(history))histories.current.set(next.id,{undo:structuredClone(history.undo),redo:structuredClone(history.redo),last:0});
        trimHistories(next.id);
        const importedAnchor=parseImportedAnchor(next.viewState.anchor);
        noteViews.current.set(next.id, {top:next.viewState.top, ...(importedAnchor?{anchor:importedAnchor}:{})});
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
      if(old && !sameViewport)cancelZoomGlide();
      if (hasNewPendingHeading) {
        modeAnchor.current = null;
        if (next.mode === "editor" || next.mode === "split") {
          const headingOffset = resolveHeadingOffset(next.content, next.pendingHeading!.heading);
          if (headingOffset !== null) {
            if (next.mode === "split") splitPane.current = "preview";
            primeEditorAnchor(next.id, { offset: headingOffset, caretOffset: headingOffset });
          } else {
            primeEditorAnchor(next.id, null);
          }
        } else {
          primeEditorAnchor(next.id, null);
        }
      }
      const load = () => { if (typeof loaded.typewriterScroll === "boolean") setTypewriterScroll(loaded.typewriterScroll, { persist: false }); reference.current=loaded;setState(loaded); zoomReference.current = loaded.zoom; applyIncomingFind(); };
      const typewriterChanged = Boolean(old?.typewriterScroll) !== Boolean(loaded.typewriterScroll);
      if (old?.id === next.id && old.mode === next.mode && !hasNewPendingHeading && !typewriterChanged) anchored(load); else load();
    };
    window.supermdHistory=direction=>{
      if(document.querySelector('.theme-guide-dialog'))return;
      const active=document.activeElement;
      if(active instanceof HTMLTextAreaElement && active.closest('.live-active-block')){
        const current=reference.current;
        const previousContent=current?.content;
        replaying.current=true;
        const applied=replayActiveLiveBlockHistory(direction);
        if(applied&&current&&previousContent!==undefined){
          const history=histories.current.get(current.id);
          if(history)replayHistory(history,previousContent,direction);
        }
        replaying.current=false;
        if(applied)return;
      }
      if(isTextEntryField(active)){document.execCommand(direction);return;}
      const current=reference.current;if(!current)return;
      replaying.current=true;
      const history=histories.current.get(current.id);const next=history?replayHistory(history,current.content,direction):undefined;
      if(next!==undefined)update(next);
      else if(current.mode==="editor"||current.mode==="split")editorHistory(current.id,direction);
      else {const cached=cachedEditorHistory(current.id,direction,current.content);if(cached!==undefined)update(cached);}
      replaying.current=false;
    };
    window.supermdFormat=action=>{
      if(hasReaderOverlay())return false;
      const active=document.activeElement;
      if(active instanceof HTMLElement&&active.closest('.cm-panels,.cm-search'))return false;
      const current=reference.current;if(!current||current.mode==="reader")return false;
      if(current.mode==="live")return formatActiveLiveBlock(action);
      if(current.mode==="editor"||current.mode==="split")return formatEditorSession(current.id,action);
      return false;
    };
    window.supermdZoomBy=zoomBy;
    window.supermdSetZoom=setZoom;
    window.supermdHeading=(id,offset)=>{
      markScrollInput();
      const current=reference.current;
      if(current?.mode==="editor"||current?.mode==="split"){
        const resolvedOffset=offset??(resolveHeadingOffset(current.content,id)??undefined);
        if(current.mode==="editor"){
          window.dispatchEvent(new CustomEvent("supermd-goto-offset",{detail:resolvedOffset??0}));
          return;
        }
        if(resolvedOffset!==undefined){
          splitPane.current="preview";
          revealEditorOffset(current.id,resolvedOffset,{caretOffset:resolvedOffset});
        }
      }
      const root=document.querySelector(".android-reading");
      if(root)navigateToHeading(root,id);
    };
    window.supermdBeforeNavigate=async()=>{
      savePosition.current();
      const current=reference.current;
      if(!current)return;
      if((current as ReaderState&{editProtocol?:number}).editProtocol===1&&edits.current!.unacknowledged(current.id)!==undefined){
        await edits.current!.flush(current.id);
      }
    };
    window.supermdResetZoom=resetZoom;
    window.supermdRepairMath = () => setRepairing(true);
    window.supermdToggleTypewriter = () => changeTypewriter(!(reference.current?.typewriterScroll ?? false));
    window.supermdNativeWheel=handleNativeWheel;
    window.supermdFlush = operation => {
      savePosition.current();
      const current = reference.current;
      if(operation.action==='android_flush'){
        if(edits.current?.unacknowledged(operation.target)!==undefined&&current?.id!==operation.target){
          void invoke('document_flushed',{id:operation.target,token:operation.token,error:'Reader has unacknowledged edits for this note'}).catch(()=>{});
          return;
        }
        if(!current){
          void invoke('document_flushed',{id:'',token:operation.token,error:'Reader has not loaded a note yet'}).catch(()=>{});
          return;
        }
        if(current.id!==operation.target){
          void invoke('document_flushed',{id:current.id,token:operation.token,error:'The active note changed before its edit flush'}).catch(()=>{});
          return;
        }
        void (async()=>{
          if(current.editProtocol===1)await edits.current!.flush(current.id);
          const latest=reference.current;
          if(!latest||latest.id!==operation.target){
            await invoke('document_flushed',{id:latest?.id??'',token:operation.token,error:'The active note changed during its edit flush'});
            return;
          }
          await invoke('document_flushed',{id:latest.id,token:operation.token,content:latest.content});
        })().catch(error=>{
          setEditError(String(error));
          void invoke('document_flushed',{id:current.id,token:operation.token,error:String(error)}).catch(()=>{});
        });
        return;
      }
      if (!current) return;
      let id = current.id;
      if (operation.action === "move_tab") { try { id = JSON.parse(operation.target).tab; } catch { return; } }
      else if (operation.action === "detach_tab") id = operation.target;
      const view = operation.action === "move_tab" || operation.action === "detach_tab" || operation.action === "reload_reader" ? {editor:exportEditorSession(id),history:histories.current.get(id), ...(id === current.id ? (()=>{const liveAnchor=captureSharedAnchor({id:current.id,mode:current.mode,zoom:zoomReference.current,readingRoot:document.querySelector<HTMLElement>(".android-reading"),preferredSplitPane:splitPane.current});return {top:liveAnchor.readingTop ?? 0,anchor:liveAnchor,rendered:exportRenderedViews(current.content)};})() : noteViews.current.get(id))} : undefined;
      void (async()=>{
        if(current.editProtocol===1)await edits.current!.flush(current.id);
        // Snapshot after the acknowledgement barrier, including edits made while waiting.
        const latest=reference.current;
        await invoke("document_flushed",{id:current.id,content:latest?.id===current.id?latest.content:current.content,operation,viewId:id,viewState:view});
      })().catch(error=>setEditError(String(error)));
    };
    window.supermdFind = (replaceOrQuery, options) => {
      if(document.querySelector('.theme-guide-dialog'))return;
      const requestedReplace=typeof replaceOrQuery==="boolean"?replaceOrQuery:Boolean(options?.replace);
      const openReplace=requestedReplace&&reference.current?.mode!=="reader";
      flushSync(()=>{
        if(typeof replaceOrQuery==='string'){
          searchSeedNonce.current+=1;
          setSearchSeed({query:replaceOrQuery.slice(0,200),caseSensitive:options?.caseSensitive,nonce:searchSeedNonce.current});
          setSearchReplace(openReplace);
        } else if(!searchingRef.current) {
          setSearchReplace(openReplace);
        }
        setSearching(true);
      });
      window.dispatchEvent(new CustomEvent("supermd-find-focus",{detail:{replace:openReplace}}));
    };
    window.supermdFindStep = (direction = 1) => {
      if(document.querySelector('.theme-guide-dialog'))return;
      const step=direction<0?-1:1;
      if(!searchingRef.current){
        flushSync(()=>{setSearchReplace(false);setSearching(true);});
        requestAnimationFrame(()=>window.dispatchEvent(new CustomEvent("supermd-find-step",{detail:step})));
        return;
      }
      window.dispatchEvent(new CustomEvent("supermd-find-step",{detail:step}));
    };
    const flushExportNote = async (current: ReaderState) => {
      if (current.editProtocol === 1) await edits.current!.flush(current.id);
      const latest = reference.current;
      if (!latest || latest.id !== current.id) throw new Error('The export note changed');
      return latest;
    };
    window.supermdPortable = async (save) => {
      const current = reference.current; if (!current) return;
      try {
        const latest = await flushExportNote(current);
        const prepared = await prepareFmd(latest.content, latest.path, noteImageConsent.current.policy(latest.id, trustedHostsRef.current)); await invoke("export_fmd_native", { ...prepared, originalContent: latest.content, id: latest.id, save }); }
      catch (error) { await invoke("export_failed", { error: String(error) }); }
    };
    window.supermdExport = async (options) => {
      const current = reference.current; if (!current) return;
      if(exportOwner.current)return;
      const owner={id:crypto.randomUUID(),controller:new AbortController(),phase:'preparing' as PdfExportStatus['phase']};
      exportOwner.current=owner;setPdfExport({id:owner.id,phase:'preparing',completed:0,total:0});
      try {
        const latest = await flushExportNote(current);
        const prepared = await preparePdf(latest.content, latest.path, latest.python || "embedded",{signal:owner.controller.signal,...noteImageConsent.current.policy(latest.id, trustedHostsRef.current),onProgress:progress=>setPdfExport(value=>value?.id===owner.id?{...value,completed:progress.completed,total:progress.total}:value)});
        owner.controller.signal.throwIfAborted();
        owner.phase='typesetting';setPdfExport({id:owner.id,phase:'typesetting',completed:0,total:0});
        await invoke("export_pdf_native", { ...prepared, options: {...options, themeAccent: latest.colors.primary}, id: latest.id,jobId:owner.id }); }
      catch (error) { await invoke("export_failed", { error: owner.controller.signal.aborted||(error instanceof Error&&error.message==='PDF export cancelled')?'PDF export cancelled':String(error) }); }
      finally{if(exportOwner.current?.id===owner.id){exportOwner.current=null;setPdfExport(null);}}
    };
    window.supermdExportMarkdown = async (archive = false) => {
      const current = reference.current; if (!current) return;
      try {
        const latest = await flushExportNote(current);
        const prepared=await prepareMarkdownExport(latest.content,latest.path,{compatible:archive,python:latest.python||"embedded"});
        if(reference.current?.id!==latest.id||reference.current.content!==latest.content)throw new Error('The note changed while preparing the Markdown export');
        await invoke("export_markdown_native", {id: latest.id, content: prepared.content, assets: prepared.assets, archive}); }
      catch (error) { await invoke("export_failed", {error: String(error)}); }
    };
    void invoke("reader_ready");
    return () => {delete window.supermdSelectedText;delete window.supermdThemeGuide;delete window.supermdSavePosition;delete window.supermdBeforeNavigate;delete window.supermdChromeInset;delete window.supermdLoad; delete window.supermdExport; delete window.supermdExportMarkdown; delete window.supermdPortable; delete window.supermdZoomBy; delete window.supermdResetZoom; delete window.supermdRepairMath; delete window.supermdToggleTypewriter; delete window.supermdNativeWheel; delete window.supermdFlush; delete window.supermdSetZoom; delete window.supermdHeading; delete window.supermdFormat; delete window.supermdHistory; delete window.supermdDismiss; delete window.supermdFind; delete window.supermdFindStep; };
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
    root.style.setProperty("--reader-font", resolveReaderFontStack(state.font));
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
  useReaderGesturesAndZoom({state,reference,controls:gestureControls});
  useEffect(()=>{
    if(!state || isBuiltinReaderFont(state.font) || !window.SuperMD || typeof FontFace==="undefined")return;
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
  useEffect(()=>{
    const trackInput=(event:Event)=>{
      if(reference.current?.mode!=="split")return;
      const pane=detectSplitPaneFromTarget(event.target);
      if(pane){
        const scroller=pane==="editor"?document.querySelector(".cm-scroller"):document.querySelector(".android-reading");
        clearProgrammaticAnchorScroll(scroller);
        splitPane.current=pane;
      }
    };
    const trackScroll=(event:Event)=>{
      if(reference.current?.mode!=="split"||restoringSplit.current)return;
      const pane=detectSplitPaneFromTarget(event.target);
      if(!pane||!(event.target instanceof HTMLElement))return;
      if(isProgrammaticAnchorScroll(event.target))return;
      const recorded=splitScrollTops.current[pane];
      if(recorded!==null&&Math.abs(event.target.scrollTop-recorded)<=2)return;
      splitScrollTops.current[pane]=event.target.scrollTop;
      splitPane.current=pane;
    };
    const inputEvents=["wheel","pointerdown","touchstart","keydown","focusin"] as const;
    inputEvents.forEach(name=>document.addEventListener(name,trackInput,{capture:true,passive:true}));
    document.addEventListener("scroll",trackScroll,{capture:true,passive:true});
    return()=>{
      inputEvents.forEach(name=>document.removeEventListener(name,trackInput,true));
      document.removeEventListener("scroll",trackScroll,true);
    };
  },[]);
  useLayoutEffect(() => {
    if (!state) return;
    if (state.pendingHeading?.token && state.pendingHeading.token !== suppressedRestoreToken.current) {
      suppressedRestoreToken.current = state.pendingHeading.token;
      suppressedRestoreKey.current = `${state.id}:${state.mode}`;
      noteViews.current.delete(state.id);
      modeAnchor.current = null;
      if (state.mode === "editor" || state.mode === "split") {
        const headingOffset = resolveHeadingOffset(state.content, state.pendingHeading.heading);
        if (headingOffset !== null) {
          if (state.mode === "split") splitPane.current = "preview";
          primeEditorAnchor(state.id, { offset: headingOffset, caretOffset: headingOffset });
        } else {
          primeEditorAnchor(state.id, null);
        }
      } else {
        primeEditorAnchor(state.id, null);
      }
      markScrollInput();
      const host = state.mode !== "editor" ? document.querySelector<HTMLElement>(".android-reading") : null;
      if (host && !host.querySelector('[data-windowed-mounted="false"]')) {
        navigateToHeading(host, state.pendingHeading.heading);
      }
      return;
    }
    const startingInput=scrollInputVersion();
    const initialContent=state.content;
    const shouldStop=()=>
      reference.current?.id!==state.id||
      reference.current?.mode!==state.mode||
      reference.current?.content!==initialContent||
      scrollInputVersion()!==startingInput||
      Boolean(window.getSelection()?.toString())||
      Boolean(document.querySelector(".reading-search,.cm-search,.live-active-block"));
    const runGuarded=(fn:()=>void)=>{
      if(state.mode==="split"){
        const seq=++restoringSplitSeq.current;
        restoringSplit.current=true;
        fn();
        splitScrollTops.current={
          editor:document.querySelector<HTMLElement>(".cm-scroller")?.scrollTop??null,
          preview:document.querySelector<HTMLElement>(".android-reading")?.scrollTop??null,
        };
        requestAnimationFrame(()=>{if(restoringSplitSeq.current===seq)restoringSplit.current=false;});
      }else{
        splitScrollTops.current={editor:null,preview:null};
        fn();
      }
    };
    if(modeAnchor.current!==null){
      suppressedRestoreKey.current=null;
      const anchor=modeAnchor.current;modeAnchor.current=null;
      if(state.mode==="editor"||state.mode==="split"){
        primeEditorAnchor(state.id,{offset:anchor.offset,caretOffset:anchor.caretOffset});
      }else{
        primeEditorAnchor(state.id,null);
      }
      // The new view settles over several frames (editor mount, zoom geometry,
      // lazy math and fonts). Re-apply the source anchor until it is stable,
      // and stop as soon as the person scrolls, types or opens search/live edit.
      let stopped=false;const stop=()=>{stopped=true;};
      const inputs=["wheel","touchstart","keydown","pointerdown","supermd-goto-offset"] as const;
      inputs.forEach(name=>window.addEventListener(name,stop,{capture:true,passive:true}));
      let firstPass=true;
      const apply=()=>{
        if(stopped||shouldStop())return;
        const updateSelection=firstPass;
        firstPass=false;
        runGuarded(()=>{
          applySharedAnchor({
            id:state.id,
            targetMode:state.mode,
            targetZoom:zoomReference.current,
            anchor,
            readingRoot:document.querySelector<HTMLElement>(".android-reading"),
            allowExactTop:false,
            updateSelection,
          });
        });
      };
      apply();
      let innerFrame=0;
      const outerFrame=requestAnimationFrame(()=>{apply();innerFrame=requestAnimationFrame(apply);});
      const timers=[120,320,700].map(delay=>window.setTimeout(apply,delay));
      return()=>{stopped=true;cancelAnimationFrame(outerFrame);cancelAnimationFrame(innerFrame);timers.forEach(window.clearTimeout);inputs.forEach(name=>window.removeEventListener(name,stop,{capture:true}));};
    }
    if (suppressedRestoreKey.current === `${state.id}:${state.mode}`) return;
    suppressedRestoreKey.current = null;
    const cachedView=noteViews.current.get(state.id);
    const saved=state.restorePosition!==false?(state.readingLocation??loadReadingLocation(state.path===state.id?null:state.path)):undefined;
    const savedMode:AnchorViewMode=saved?.mode==="editor"||saved?.mode==="live"||saved?.mode==="split"?saved.mode:"reader";
    const resolvedAnchor:SharedSourceAnchor|undefined=cachedView?.anchor
      ??(cachedView?.top!==undefined?{offset:0,mode:state.mode,zoom:zoomReference.current,readingTop:cachedView.top}:undefined)
      ??(saved?{offset:saved.offset,mode:savedMode,zoom:saved.zoom,...(savedMode==="editor"?{editorTop:saved.top}:{readingTop:saved.top})}:undefined);
    if(!resolvedAnchor){
      primeEditorAnchor(state.id,null);
      const host=document.querySelector<HTMLElement>(".android-reading");
      if(host)host.scrollTop=0;
      return;
    }
    if(state.mode==="editor"||state.mode==="split"){
      const sameGeometry=resolvedAnchor.mode===state.mode&&Math.abs(resolvedAnchor.zoom-zoomReference.current)<1;
      if(sameGeometry&&resolvedAnchor.editorTop!==undefined){
        primeEditorAnchor(state.id,{offset:resolvedAnchor.offset,top:resolvedAnchor.editorTop});
      }else{
        primeEditorAnchor(state.id,{offset:resolvedAnchor.offset,caretOffset:resolvedAnchor.caretOffset});
      }
    }else{
      primeEditorAnchor(state.id,null);
    }
    let stopped=false;
    const stop=()=>{stopped=true;};
    const inputs=['wheel','touchstart','pointerdown','keydown','supermd-goto-offset'] as const;
    inputs.forEach(name=>window.addEventListener(name,stop,{capture:true,passive:true}));
    let firstPass=true;
    const restore=()=>{
      if(stopped||shouldStop())return;
      const updateSelection=firstPass;
      firstPass=false;
      runGuarded(()=>{
        applySharedAnchor({
          id:state.id,
          targetMode:state.mode,
          targetZoom:zoomReference.current,
          anchor:resolvedAnchor,
          readingRoot:document.querySelector<HTMLElement>(".android-reading"),
          allowExactTop:true,
          updateSelection,
        });
      });
    };
    restore();
    let innerFrame=0;
    const frame=requestAnimationFrame(()=>{restore();innerFrame=requestAnimationFrame(restore);});
    const timers=[120,320,700].map(delay=>window.setTimeout(restore,delay));
    return()=>{stopped=true;cancelAnimationFrame(frame);cancelAnimationFrame(innerFrame);timers.forEach(window.clearTimeout);inputs.forEach(name=>window.removeEventListener(name,stop,{capture:true}));};
  }, [state?.id, state?.mode, state?.pendingHeading?.token]);
  useEffect(() => {
    if (!state?.pendingHeading?.token || state.pendingHeading.token === consumedHeadingToken.current) return;
    consumedHeadingToken.current = state.pendingHeading.token;
    const startingInput = scrollInputVersion();
    const targetHeading = state.pendingHeading.heading;
    const offset = state.mode === "editor" || state.mode === "split" ? resolveHeadingOffset(state.content, targetHeading) : null;
    let stopped = false;
    const stop = () => { stopped = true; };
    const inputs = ["wheel", "touchstart", "keydown", "pointerdown", "supermd-goto-offset"] as const;
    inputs.forEach(name => window.addEventListener(name, stop, {capture: true, passive: true}));
    const applyEditorJump = (focusEditor: boolean) => {
      if (stopped || scrollInputVersion() !== startingInput || offset === null) return;
      if (state.mode === "split") {
        splitPane.current = "preview";
        revealEditorOffset(state.id, offset, { caretOffset: offset });
      } else {
        revealEditorOffset(state.id, offset, { caretOffset: offset, focus: focusEditor });
      }
    };
    let innerFrame = 0;
    let outerFrame = 0;
    if (state.mode === "editor" || state.mode === "split") {
      applyEditorJump(state.mode === "editor");
      outerFrame = requestAnimationFrame(() => {
        applyEditorJump(false);
        innerFrame = requestAnimationFrame(() => applyEditorJump(false));
      });
    }
    const host = state.mode !== "editor" ? document.querySelector<HTMLElement>(".android-reading") : null;
    if (host) navigateToHeading(host, targetHeading);
    const timers = (state.mode === "editor" || state.mode === "split")
      ? [120, 320].map(delay => window.setTimeout(() => applyEditorJump(false), delay))
      : [];
    const cleanupTimer = window.setTimeout(() => inputs.forEach(name => window.removeEventListener(name, stop, {capture: true})), 400);
    return () => {
      stopped = true;
      cancelAnimationFrame(outerFrame);
      cancelAnimationFrame(innerFrame);
      timers.forEach(window.clearTimeout);
      window.clearTimeout(cleanupTimer);
      inputs.forEach(name => window.removeEventListener(name, stop, {capture: true}));
    };
  }, [state?.id, state?.mode, state?.pendingHeading?.token]);
  useEffect(()=>{
    if(!state||state.restorePosition===false)return;
    const path=state.path===state.id?null:state.path;if(!path)return;
    const roots=Array.from(document.querySelectorAll<HTMLElement>('.android-reading,.cm-scroller'));
    if(!roots.length)return;
    let timer=0;
    const save=()=>{
      if(!roots.some(node=>node.isConnected))return;
      const snap=captureSharedAnchor({
        id:state.id,
        mode:state.mode,
        zoom:zoomReference.current,
        readingRoot:document.querySelector<HTMLElement>('.android-reading'),
        preferredSplitPane:splitPane.current,
      });
      const location:ReadingLocation={
        top:Math.max(0,state.mode==='editor'?(snap.editorTop??0):(snap.readingTop??0)),
        offset:snap.offset,
        zoom:zoomReference.current,
        mode:state.mode,
      };
      saveReadingLocation(path,location);
      void invoke('reading_position',{id:state.id,location}).catch(()=>{});
    };
    const scroll=()=>{window.clearTimeout(timer);timer=window.setTimeout(save,900);};
    savePosition.current=save;
    roots.forEach(node=>node.addEventListener('scroll',scroll,{passive:true}));
    window.addEventListener('pagehide',save);document.addEventListener('visibilitychange',save);
    // A native/heading jump can finish before this passive effect subscribes.
    // Persist its settled viewport too, even if no later scroll event arrives.
    scroll();
    return()=>{window.clearTimeout(timer);save();roots.forEach(node=>node.removeEventListener('scroll',scroll));window.removeEventListener('pagehide',save);document.removeEventListener('visibilitychange',save);savePosition.current=()=>{};};
  },[state?.id,state?.mode,state?.path,state?.restorePosition]);
  useLayoutEffect(() => {
    const find=(event:KeyboardEvent)=>{
      if(document.documentElement.dataset.host==='qt')return;
      if(!event.ctrlKey&&!event.metaKey&&!event.altKey&&event.key==="F3"){
        event.preventDefault();event.stopImmediatePropagation();window.supermdFindStep?.(event.shiftKey?-1:1);return;
      }
      if((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey){
        const key=event.key.toLowerCase();
        if(key==="f"||key==="h"){event.preventDefault();event.stopImmediatePropagation();window.supermdFind?.(key==="h");}
      }
    };
    const history=(event:KeyboardEvent)=>{
      if(document.documentElement.dataset.host==='qt')return;
      if(!(event.ctrlKey||event.metaKey)||event.altKey)return;
      const key=event.key.toLowerCase();if(key!=="z"&&key!=="y")return;
      if(document.querySelector(".image-viewer,.math-repair-panel,.reading-search,.media-dialog"))return;
      // Leave a Live textarea's native editing history intact; Source and Read
      // route through the same bounded note history on hardware keyboards.
      if(isTextEntryField(event.target))return;
      event.preventDefault();event.stopImmediatePropagation();window.supermdHistory?.(key==="y"||event.shiftKey?"redo":"undo");
    };
    const historyBoundary=()=>{
      const current=reference.current;if(!current)return;
      const entry=histories.current.get(current.id);
      if(entry)entry.last=0;
    };
    const typewriterKey=(event:KeyboardEvent)=>{
      if(document.documentElement.dataset.host==='qt'||event.defaultPrevented)return;
      if(!isTypewriterShortcutEvent(event))return;
      event.preventDefault();changeTypewriter(!(reference.current?.typewriterScroll ?? false));
    };
    document.addEventListener("keydown",find,true);
    document.addEventListener("keydown",history,true);
    document.addEventListener("keydown",typewriterKey);
    window.addEventListener("supermd-history-boundary",historyBoundary);
    return()=>{document.removeEventListener("keydown",find,true);document.removeEventListener("keydown",history,true);document.removeEventListener("keydown",typewriterKey);window.removeEventListener("supermd-history-boundary",historyBoundary);};
  },[changeTypewriter]);
  const editorFocusReported=useRef<boolean|null>(null);
  const syncEditorFocus=useCallback(()=>{
    const current=reference.current;
    let focused=false;
    if(current&&current.mode!=="reader"&&!hasReaderOverlay()){
      const active=document.activeElement;
      if(active instanceof HTMLElement&&!active.closest(".cm-panels,.cm-search")){
        if(current.mode==="live")focused=active.matches(".live-active-block textarea");
        else if(current.mode==="editor"||current.mode==="split")focused=!!active.closest(".cm-editor .cm-content");
      }
    }
    if(editorFocusReported.current!==focused){
      editorFocusReported.current=focused;
      if(document.documentElement.dataset.host!=="qt")void invoke("editor_focus_changed",{focused}).catch(()=>{});
    }
  },[]);
  useEffect(()=>{
    let timer=0;
    const onFocusIn=()=>{window.clearTimeout(timer);syncEditorFocus();};
    const onFocusOut=()=>{window.clearTimeout(timer);timer=window.setTimeout(syncEditorFocus,0);};
    document.addEventListener("focusin",onFocusIn,true);
    document.addEventListener("focusout",onFocusOut,true);
    return()=>{window.clearTimeout(timer);document.removeEventListener("focusin",onFocusIn,true);document.removeEventListener("focusout",onFocusOut,true);};
  },[syncEditorFocus]);
  useEffect(()=>{syncEditorFocus();},[state?.id,state?.mode,searching,repairing,themeGuide,syncEditorFocus]);
  if (!state) return <div className="reader-loading" role="status"><span className="expressive-loading-shape" aria-hidden="true"/>Opening your workspace</div>;
  return <DocumentAppearance.Provider value={documentAppearance}><div className={`android-document mode-${state.mode}`}>
    {themeGuide&&<ThemeGuideDialog dark={state.dark} close={()=>setThemeGuide(false)}/>}
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
    {searching && <ReadingSearch content={state.content} close={()=>{setSearching(false);setSearchReplace(false);setSearchSeed(null);}} onChange={state.mode==="reader"?undefined:update} sourceSession={state.mode==="editor"||state.mode==="split"?state.id:undefined} seed={searchSeed} initialReplace={searchReplace}/>}
    <ImageViewer />
    {repairing && <MathRepairPanel content={state.content} apply={update} close={()=>setRepairing(false)} />}
    <MediaTools documentId={state.id} content={state.content} documentPath={state.path} onInsert={(text, point) => { const current = reference.current; if (!current || current.id !== state.id) return; const content = current.content; const from = Math.min(point?.from ?? content.length, content.length); const to = Math.max(from, Math.min(point?.to ?? from, content.length)); update(content.slice(0, from) + text + content.slice(to)); }} onNotice={(error) => { void invoke("export_failed", { error }); }} />
    {(state.mode === "editor" || state.mode === "split") && <section className="android-source"><SourceEditor key={state.id} sessionId={state.id} documentPath={state.path === state.id ? null : state.path} value={state.content} onChange={update} dark={state.dark} focusMode={state.fullscreen} latexAutofix={state.latexAutofix} typewriterScroll={state.typewriterScroll} onTypewriterChange={changeTypewriter} spellCheck={state.spellCheck} grammarCheck={state.grammarCheck} /></section>}
    {state.mode === "live" && <section className="android-reading" data-full-document-accessibility={state.fullDocumentAccessibility ? "true" : undefined}><div className="reader-chrome-spacer" aria-hidden="true"/><div key={state.id} className="document-page-space"><div className="document-page"><LiveDocument key={state.id} noteId={state.id} latexAutofix={state.latexAutofix} typewriterScroll={state.typewriterScroll} spellCheck={state.spellCheck} grammarCheck={state.grammarCheck} markdown={state.content} onChange={update} documentPath={state.path} savedDocumentPath={state.path === state.id ? null : state.path} python={state.python || "embedded"} dark={false} trustedImageHosts={trustedHosts} approvedImageUrls={approvedImageUrls} onTrustImageHost={trustHost} onApproveImageUrl={approveImageUrl} onRemoteImageLoaded={recordRemoteImageLoaded} fullDocumentAccessibility={state.fullDocumentAccessibility} /></div></div></section>}
    {(state.mode === "reader" || state.mode === "split") && <section className="android-reading" data-full-document-accessibility={state.fullDocumentAccessibility ? "true" : undefined}><div className="reader-chrome-spacer" aria-hidden="true"/><div key={state.id} className="document-page-space"><div className="document-page"><DocumentPreview noteId={state.id} markdown={state.content} onChange={update} documentPath={state.path} savedDocumentPath={state.path === state.id ? null : state.path} python={state.python || "embedded"} dark={false} trustedImageHosts={trustedHosts} approvedImageUrls={approvedImageUrls} onTrustImageHost={trustHost} onApproveImageUrl={approveImageUrl} onRemoteImageLoaded={recordRemoteImageLoaded} fullDocumentAccessibility={state.fullDocumentAccessibility} sourceAnalysis={readerAnalysis?.source===state.content?readerAnalysis:undefined} /></div></div></section>}
  </div></DocumentAppearance.Provider>;
}
const rootElement = document.getElementById("root");
if (rootElement) {
  const mountReaderRoot = () => createRoot(rootElement).render(<Reader />);
  if ((globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT) mountReaderRoot();
  else flushSync(mountReaderRoot);
}
