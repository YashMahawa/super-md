import { createRoot } from "react-dom/client";
import {flushSync} from 'react-dom';
import {createGapSelection,type GapSelection} from './gapSelection';
import {FrameScrollQueue,zoomFrameStep} from './frameMotion';
import {applyChainedNativeScroll,NON_VIEWER_OVERLAY_SELECTOR,resolveNativeWheelScrollOrigin} from './nativeWheelScroll';
import {agentCharLength,agentCodePointOffset,agentOutlinePage,agentRead,agentRevision,agentSearch,agentSectionForExport,agentUtf16Offset,applyAgentPatchesDetailed,countCodePointsRange} from './agentOperations';
import {suggestMathRepairs,applyMathRepairs} from './mathRepair';
import {agentDiagrams,diagramMetadata,diagramMedia,visibleSourceRange,type AgentDiagramOptions} from './agentView';
import {mediaBytes} from './mediaExport';
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
import Editor, { editorReadingOffset, editorSelectedText, editorViewContext, editorHistory, exportEditorSession, formatEditorSession, importEditorSession, type PortableEditorSession } from "./components/Editor";
import { extractSelectedText } from "./copySource";
import {readingOffset} from "./readingPosition";
import {applySharedAnchor,captureSharedAnchor,clearProgrammaticAnchorScroll,detectSplitPaneFromTarget,hasExternalAnchorScroll,isProgrammaticAnchorScroll,primeEditorAnchor,revealEditorOffset,snapshotAnchorScroll,type AnchorScrollSnapshot,type AnchorViewMode,type SharedSourceAnchor,type SplitAnchorPane} from "./sourceAnchor";
import { exportRenderedViews, importRenderedViews, inspectCachedPythonOutput, safePythonFigure } from "./renderedOutputs";
import { analyzeDocument } from "./documentAnalysis";
import { parseFrontmatter } from "./frontmatter";
import LiveEditor, { formatActiveLiveBlock } from "./components/LiveEditor";
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
import { captureScrollAnchor,markScrollInput,scrollInputVersion } from "./scrollAnchor";
import {rememberWindowedScrollSource} from './windowedSearch';
import ReadingSearch, { isValidSeedOccurrence, type ReadingSearchSeed } from "./components/ReadingSearch";
import type { Point } from "./focalZoom";
import { applyDocumentZoom,documentPoint,invalidateDocumentZoom,settleDocumentZoom,refreshDocumentExtent,enforceDocumentCenter } from "./documentZoom";
import { documentOutline, navigateToHeading, cancelHeadingNavigation, readingKeyboardScrollDelta, resolveHeadingOffset } from "./documentNavigation";
import { readerSourceAnalysis } from "./readerSourceAnalysis";
import {OutlineWorkerClient} from './outlineWorker';
import {applyHistoryEdit,replayHistory,transferHistory,trimHistoryCache,tryLiveTextareaHistory,validHistory,type LiveHistoryEditMeta,type NoteHistory} from './noteHistory';
import {cachedEditorHistory} from './components/Editor';
import {loadReadingLocation,saveReadingLocation,type ReadingLocation} from './readingLocations';
import {mediaFilter,mediaTone,type MediaAppearance} from './mediaAppearance';
import MediaThemeFilters from './components/MediaThemeFilters';
import ExportProgressIndicator from './components/ExportProgressIndicator';
import {DocumentAppearance} from './documentAppearance';
import {applyCustomStyle,type CustomStyle} from './customTheme';
import {isTypewriterShortcutEvent,setTypewriterScroll} from './typewriterScroll';
import {createSplitScrollSyncController,resolveSplitRootPaneScroller,type SplitScrollSyncController} from './splitScrollSync';
const DocumentPreview = memo(MarkdownPreview);
const LiveDocument = memo(LiveEditor);
const SourceEditor = memo(Editor);
function isTextEntryField(target: EventTarget | null): boolean {
  if (target instanceof HTMLTextAreaElement) return true;
  if (!(target instanceof HTMLInputElement)) return false;
  return !/^(?:checkbox|radio|range|button|submit|reset|file|color|image|hidden)$/i.test(target.type);
}
interface PdfExportStatus {id:string;phase:'preparing'|'typesetting'|'publishing';completed:number;total:number;cancelRequested?:boolean}

import { handoffSharedSourceAnchorOnLoad, parseImportedAnchor, snapshotOutgoingTabOrPathAnchor, useSharedSourceAnchor, type NoteView, type PendingHeadingNavigation } from "./useSharedSourceAnchor";
interface ReaderState extends ReaderAccessibilityPreference { id: string; content: string; path: string | null; portable?: boolean; mode: "live" | "editor" | "reader" | "split"; dark: boolean; fullscreen: boolean; font: string; size: number; editProtocol?: number; latexAutofix?:boolean; typewriterScroll?:boolean; spellCheck?:boolean; grammarCheck?:boolean; width?: number; widthPercent?:number; lineHeight?:number; colors: Record<string, string>; zoom: number; motion?: boolean; python?: string; viewState?: NoteView }
declare global { interface Window {supermdAgentRequest?:(request:Record<string,unknown>,callback?:(result:unknown,error:string)=>void)=>void;supermdAgentCompute?:(request:Record<string,unknown>,callback:(result:unknown,error:string)=>void)=>void;supermdThemeGuide?:()=>void;supermdDismiss?:()=>boolean;supermdSetZoom?:(zoom:number,requestedAt?:number)=>void;supermdHeading?:(id:string,offset?:number)=>void;supermdHistory?:(direction:"undo"|"redo")=>void;supermdFormat?:(action:string)=>boolean;supermdNativeWheel?:(dx:number,dy:number,point:Point,held:boolean,modifier?:boolean)=>void;supermdToggleTypewriter?:()=>void;} }
export interface PortableWriteOptions { id?: string; localAssets?: string[]; omitLocalAssets?: boolean }
type ReaderLoadPayload = Omit<ReaderState, "pendingHeading" | "content"> & { content?: string; contentUnchanged?: boolean; localAssets?: string[] | null; pendingHeading?: PendingHeadingNavigation | string | null };
declare global { interface Window { supermdLoad?: (state: ReaderLoadPayload) => void; supermdExport?: (options: ExportOptions) => void; supermdExportMarkdown?: (archive?: boolean) => void; supermdFind?: (replaceOrQuery?: boolean | string, options?: { caseSensitive?: boolean; replace?: boolean; sourceStart?: number; sourceEnd?: number; matchText?: string }) => void; supermdFindStep?: (direction?: number) => void; supermdPortable?: (save: boolean, options?: PortableWriteOptions) => void; supermdZoomBy?: (factor:number,focus?:Point)=>void; supermdResetZoom?: ()=>void; supermdRepairMath?: ()=>void; supermdFlush?: (operation:Record<string,string>)=>void } }
declare global { interface Window {supermdChromeInset?:(height:number)=>void} }
declare global { interface Window {supermdSavePosition?:()=>void;supermdBeforeNavigate?:()=>Promise<void>} }
declare global {interface Window {supermdExportPhase?:(id:string,phase:'typesetting'|'publishing')=>void}}
interface ReaderState { centerLock?:boolean; customStyle?:CustomStyle; restorePosition?:boolean; readingLocation?:ReadingLocation|null; pendingHeading?:PendingHeadingNavigation|null; imageAppearance?:MediaAppearance; svgAppearance?:MediaAppearance; imageContrast?:number; seededFind?:{query:string;caseSensitive?:boolean;sourceStart?:number;sourceEnd?:number;matchText?:string;nonce?:number}|null }
function normalizeSeedBounds(start?: unknown, end?: unknown, matchText?: unknown): { sourceStart?: number; sourceEnd?: number; matchText?: string } {
  if (typeof start === "number" && typeof end === "number" && Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end >= start) {
    return { sourceStart: start, sourceEnd: end, ...(typeof matchText === "string" && matchText ? { matchText } : {}) };
  }
  return {};
}
function willSeedNavigate(
  content: string,
  query: unknown,
  caseSensitive?: boolean,
  start?: unknown,
  end?: unknown,
  matchText?: unknown,
): boolean {
  if (typeof query !== "string" || !query) return false;
  const trimmedQuery = query.slice(0, 200);
  const bounds = normalizeSeedBounds(start, end, matchText);
  if (bounds.sourceStart !== undefined && bounds.sourceEnd !== undefined) {
    return isValidSeedOccurrence(
      content,
      { from: bounds.sourceStart, to: bounds.sourceEnd },
      trimmedQuery,
      Boolean(caseSensitive),
      bounds.matchText,
    );
  }
  return true;
}
type AgentDocumentBase={tabId:string;revision:string;sourceLength:number};
function resolveAgentDiagram(content:string,revision:string,request:Record<string,unknown>,diagramOptions?:AgentDiagramOptions){
  if(request.expectedRevision!==revision)throw Error('A current expectedRevision is required to retrieve this diagram');
  const diagram=agentDiagrams(content,diagramOptions).find(item=>item.id===request.diagramId);if(!diagram)throw Error('Diagram not found in this revision');
  return diagram;
}
function readAgentDocument(content:string,base:AgentDocumentBase,request:Record<string,unknown>,diagramOptions?:AgentDiagramOptions):Record<string,unknown>|null{
  if(request.expectedRevision!==undefined&&request.expectedRevision!==base.revision)throw Error('Revision conflict: the note changed; read it again before editing');
  const action=request.action;
  if(action==='read_tab')return {...base,...agentRead(content,request.offset,request.limit,request.heading,request.view)};
  if(action==='outline_tab')return {...base,...agentOutlinePage(content,request.offset,request.limit)};
  if(action==='search_tab')return {...base,...agentSearch(content,request.query,request.limit,request.context,{offset:request.offset,caseSensitive:request.caseSensitive,wholeWord:request.wholeWord,regex:request.regex,excludeDiagrams:request.excludeDiagrams})};
  const resolvedDiagramOptions=diagramOptions??{documentPath:typeof request.path==='string'?request.path:undefined,python:typeof request.python==='string'?request.python:undefined};
  if(action==='list_diagrams'){
    const diagrams=agentDiagrams(content,resolvedDiagramOptions),offset=request.offset===undefined?0:request.offset,limit=request.limit===undefined?80:request.limit;
    if(typeof offset!=='number'||!Number.isInteger(offset)||offset<0)throw Error('diagram offset must be a nonnegative integer');
    if(typeof limit!=='number'||!Number.isInteger(limit)||limit<1||limit>80)throw Error('diagram limit must be 1–80');
    if(offset>diagrams.length)throw Error(`diagram offset must be between 0 and ${diagrams.length}`);
    const end=Math.min(diagrams.length,offset+limit);return {...base,diagrams:diagrams.slice(offset,end).map(item=>diagramMetadata(content,item)),total:diagrams.length,nextOffset:end<diagrams.length?end:null,truncated:end<diagrams.length};
  }
  if(action==='get_diagram'){
    const diagram=resolveAgentDiagram(content,base.revision,request,resolvedDiagramOptions);
    return {...base,...diagramMetadata(content,diagram),...agentRead(diagram.source,request.offset,request.limit,undefined,'source')};
  }
  return null;
}
/** Pure snapshot operations for native-owned inactive tabs. `content` is added
 * only by the trusted native router and is never accepted from MCP requests. */
export async function computeAgentDocumentRequest(request:Record<string,unknown>):Promise<Record<string,unknown>> {
  const content=request.content,tabId=request.tabId,action=request.action;
  if(typeof content!=='string'||typeof tabId!=='string')throw Error('Native document snapshot is required');
  const revision=await agentRevision(content),sourceLength=agentCharLength(content),base={tabId,revision,sourceLength};
  const readResult=readAgentDocument(content,base,request);if(readResult)return readResult;
  if(action==='patch_tab'){
    if(typeof request.expectedRevision!=='string'||request.expectedRevision!==revision)throw Error('A current expectedRevision is required to edit a tab');
    const patch=applyAgentPatchesDetailed(content,request.operations);
    return {...base,baseRevision:revision,baseSourceLength:sourceLength,revision:await agentRevision(patch.text),sourceLength:agentCharLength(patch.text),changed:patch.text!==content,applied:patch.applied,operations:patch.operations,patchedContent:patch.text};
  }
  if(action==='get_diagram_image')throw Error('Diagram image requests require the active reader view');
  throw Error('Unsupported snapshot agent action');
}
export function Reader() {
  const [state, setState] = useState<ReaderState | null>(null);
  const readerAnalysis=useMemo(()=>state?readerSourceAnalysis(state.mode,state.content):null,[state?.mode,state?.content]);
  const [repairing, setRepairing] = useState(false);
  const [searching,setSearching] = useState(false);
  const [searchReplace,setSearchReplace] = useState(false);
  const [searchSeed,setSearchSeed] = useState<ReadingSearchSeed|null>(null);
  const searchSeedNonce = useRef(0);
  const suppressRestoreForSeed = useRef(false);
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
  useEffect(()=>{
    window.supermdExportPhase=(id,phase)=>{const owner=exportOwner.current;if(owner?.id!==id)return;owner.phase=phase;setPdfExport(value=>value?.id===id?{...value,phase,cancelRequested:false}:value);};
    return()=>{delete window.supermdExportPhase;};
  },[]);
  const [trustedHosts,setTrustedHosts] = useState<string[]>([]);
  const trustedHostsRef = useRef(trustedHosts); trustedHostsRef.current = trustedHosts;
  const noteImageConsent = useRef(new NoteRemoteImageConsentStore());
  const noteLocalAssets = useRef(new Map<string, string[]>());
  const [imageConsentVersion, setImageConsentVersion] = useState(0);
  const documentAppearance=useMemo(()=>({dark:state?.dark??false,svgAppearance:state?.svgAppearance,ink:state?.colors.primary,text:state?.colors.text,colors:state?.colors}),[state?.dark,state?.svgAppearance,JSON.stringify(state?.colors)]);
  const trustHost = useCallback((host:string)=>setTrustedHosts(current=>{if(current.includes(host))return current;const next=[...current,host];trustedHostsRef.current=next;return next;}),[]);
  const reference = useRef(state); reference.current = state;
  const approveImageUrl = useCallback((noteId:string|undefined,url:string)=>{if(noteId&&noteImageConsent.current.approve(noteId,url))setImageConsentVersion(value=>value+1);},[]);
  const recordRemoteImageLoaded = useCallback((noteId:string|undefined,url:string,data:string)=>{if(noteId)noteImageConsent.current.recordLoaded(noteId,url,data);},[]);
  const approvedImageUrls = useMemo(()=>noteImageConsent.current.approvedUrls(state?.id),[state?.id,imageConsentVersion]);
  const consumedHeadingToken = useRef<string | null>(null);
  const layoutNavigatedHeadingToken = useRef<string | null>(null);
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
  const zoomReference = useRef(100);
  const zoomGestureAt = useRef(0);
  const pendingChange = useRef(0);
  const noteViews = useRef(new Map<string, NoteView>());
  const histories=useRef(new Map<string,NoteHistory>());
  const trimHistories=(active:string)=>trimHistoryCache(histories.current,active);
  const replaying=useRef(false);
  const [historyReplayToken,setHistoryReplayToken]=useState(0);
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
  const modeAnchor=useRef<SharedSourceAnchor|null>(null);
  const splitPane=useRef<SplitAnchorPane|null>(null);
  const restoringSplit=useRef(false);
  const restoringSplitSeq=useRef(0);
  const splitScrollTops=useRef<{editor:number|null;preview:number|null}>({editor:null,preview:null});
  const splitSyncRef=useRef<SplitScrollSyncController|null>(null);
  if(!splitSyncRef.current){
    splitSyncRef.current=createSplitScrollSyncController({
      getState:()=>reference.current?{id:reference.current.id,mode:reference.current.mode}:null,
      isRestoring:()=>restoringSplit.current,
      isZooming:()=>zoomFrame.current!==0||Date.now()-zoomGestureAt.current<320,
      onPaneSelected:pane=>{splitPane.current=pane;},
    });
  }
  const anchors = (focus?:Point) => Array.from(document.querySelectorAll<HTMLElement>(".android-reading,.cm-scroller")).filter(root=>{const r=root.getBoundingClientRect();return !focus || focus.x>=r.left&&focus.x<=r.right&&focus.y>=r.top&&focus.y<=r.bottom;}).map(root=>captureScrollAnchor(root,focus));
  const applyZoomStyle=(focus?:Point,previousFocus=focus,anchors?:Map<HTMLElement,Point|null>)=>{document.querySelector<HTMLElement>(".android-source")?.style.setProperty("--workspace-scale",String(zoomReference.current/100));document.querySelectorAll<HTMLElement>(".android-reading").forEach(root=>applyDocumentZoom(root,zoomReference.current,reference.current?.widthPercent??90,focus,previousFocus,anchors?.get(root),reference.current?.centerLock===true));};
  const anchored = (update:()=>void) => { const restore = anchors(); update(); requestAnimationFrame(()=>restore.forEach(callback=>callback())); };
  useLayoutEffect(() => {
    const nativeScroll=new FrameScrollQueue((scroller,dx,dy)=>{
      applyChainedNativeScroll(scroller,dx,dy,{
        centerLock:Boolean(reference.current?.centerLock),
        onReadingScroll:(reading,attemptedDy)=>{if(reference.current?.mode==='split')splitSyncRef.current?.notePaneInteraction('preview');cancelHeadingNavigation(reading);rememberWindowedScrollSource(reading,attemptedDy);if(Math.abs(attemptedDy)>2)requestChrome('hide');},
      });
    });
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
      const {contentUnchanged,seededFind,localAssets,...rest}=incoming;
      const applyIncomingFind=(targetContent:string)=>{
        if(seededFind&&typeof seededFind.query==='string'){
          if(willSeedNavigate(targetContent,seededFind.query,seededFind.caseSensitive,seededFind.sourceStart,seededFind.sourceEnd,seededFind.matchText)){
            requestAnimationFrame(()=>markScrollInput());
          }
          searchSeedNonce.current+=1;
          setSearchSeed({query:seededFind.query.slice(0,200),caseSensitive:seededFind.caseSensitive,...normalizeSeedBounds(seededFind.sourceStart,seededFind.sourceEnd,seededFind.matchText),nonce:searchSeedNonce.current});
          setSearchReplace(false);
          setSearching(true);
          requestAnimationFrame(()=>window.dispatchEvent(new CustomEvent("supermd-find-focus",{detail:{replace:false}})));
        }
      };
      if(contentUnchanged&&(!old||old.id!==rest.id))return;
      if(Array.isArray(localAssets)){
        const keys=localAssets.filter((item):item is string=>typeof item==='string'&&item.length>0);
        noteLocalAssets.current.delete(rest.id);
        if(keys.length>0){
          noteLocalAssets.current.set(rest.id,keys);
          if(noteLocalAssets.current.size>40)noteLocalAssets.current.delete(noteLocalAssets.current.keys().next().value!);
        }
      }else if(localAssets===null||rest.portable===false||(old?.id===rest.id&&!contentUnchanged&&old.path!==rest.path)){
        noteLocalAssets.current.delete(rest.id);
      }
      const next=(contentUnchanged?{...rest,content:old!.content}:{...rest,content:rest.content??""}) as ReaderState;
      const rawPending=(rest as {pendingHeading?:PendingHeadingNavigation|string|null}).pendingHeading;
      if(typeof rawPending==='string'){
        const trimmed=rawPending.trim();
        next.pendingHeading=trimmed?{heading:trimmed,token:`legacy:${next.id}:${++legacyHeadingSeq.current}:${trimmed}`}:null;
      }
      if(old&&(old.id!==next.id||old.mode!==next.mode||old.fullscreen!==next.fullscreen)){nativeScroll.clear();gapSelection.current?.end();splitSyncRef.current?.cancelPending();}
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
      const hasActiveSeedNavigation = Boolean(
        seededFind &&
          willSeedNavigate(
            next.content,
            seededFind.query,
            seededFind.caseSensitive,
            seededFind.sourceStart,
            seededFind.sourceEnd,
            seededFind.matchText,
          ),
      );
      const { hasNewPendingHeading, unconsumedOldHeadingOffset } = handoffSharedSourceAnchorOnLoad({
        old,
        next,
        zoom: zoomReference.current,
        hasActiveSeedNavigation,
        refs: { consumedHeadingToken, suppressedRestoreToken, savePosition, modeAnchor, splitPane },
        onHistoryBoundary: () => { const history = histories.current.get(next.id); if (history) history.last = 0; },
      });
      if(old&&[...new Set([...Object.keys(old),...Object.keys(next)])].every(key=>key==="zoom"&&old.fullscreen===next.fullscreen?true:key==="viewState"?!next.viewState:key==="colors"||key==="customStyle"||key==="pendingHeading"?JSON.stringify((old as any)[key])===JSON.stringify((next as any)[key]):(old as any)[key]===(next as any)[key])){applyIncomingFind(next.content);return;}
      snapshotOutgoingTabOrPathAnchor({
        old,
        next,
        zoom: zoomReference.current,
        unconsumedOldHeadingOffset,
        refs: { noteViews, savePosition, modeAnchor, splitPane, suppressedRestoreKey },
        onOutgoingTabSwitch: () => { if (!seededFind) setSearchSeed(null); },
      });
      if (next.viewState && old?.id !== next.id) {
        importEditorSession(next.id, next.viewState.editor);
        importRenderedViews(next.content, next.viewState.rendered);
        const history=next.viewState.history;
        histories.current.delete(next.id);
        if(validHistory(history)){const imported=transferHistory(history);if(imported)histories.current.set(next.id,imported);}
        trimHistories(next.id);
        const importedAnchor=parseImportedAnchor(next.viewState.anchor);
        noteViews.current.set(next.id, {top:next.viewState.top, ...(importedAnchor?{anchor:importedAnchor}:{})});
      } else if (old && old.id !== next.id) {
        trimHistories(next.id);
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
      const load = () => {
        if (hasActiveSeedNavigation && (!old || old.id !== loaded.id || old.mode !== loaded.mode)) {
          suppressRestoreForSeed.current = true;
          modeAnchor.current = null;
          primeEditorAnchor(loaded.id, null);
        }
        if (typeof loaded.typewriterScroll === "boolean") setTypewriterScroll(loaded.typewriterScroll, { persist: false });
        reference.current = loaded;
        setState(loaded);
        zoomReference.current = loaded.zoom;
        applyIncomingFind(loaded.content);
      };
      const typewriterChanged = Boolean(old?.typewriterScroll) !== Boolean(loaded.typewriterScroll);
      if (old?.id === next.id && old.mode === next.mode && !hasNewPendingHeading && !typewriterChanged && !hasActiveSeedNavigation) anchored(load); else load();
    };
    window.supermdHistory=direction=>{
      if(document.querySelector('.theme-guide-dialog'))return;
      const activeEl=document.activeElement;
      if(isTextEntryField(activeEl)){
        const inLiveBlock=activeEl instanceof HTMLTextAreaElement&&Boolean(activeEl.closest('.live-active-block'));
        if(!inLiveBlock){document.execCommand(direction);return;}
        if(tryLiveTextareaHistory(direction))return;
      }
      const current=reference.current;if(!current)return;
      replaying.current=true;
      try{
        const history=histories.current.get(current.id);const next=history?replayHistory(history,current.content,direction):undefined;
        if(next!==undefined){if(current.mode==='live')setHistoryReplayToken(n=>n+1);update(next);}
        else if(current.mode==="editor"||current.mode==="split")editorHistory(current.id,direction);
        else {const cached=cachedEditorHistory(current.id,direction,current.content);if(cached!==undefined){if(current.mode==='live')setHistoryReplayToken(n=>n+1);update(cached);}}
      }finally{replaying.current=false;}
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
    window.supermdResetZoom = () => { if (document.querySelector(".image-viewer")) { window.dispatchEvent(new Event("supermd-image-reset")); return; } window.supermdZoomBy?.(100/(zoomTarget.current??zoomReference.current)); };
    window.supermdRepairMath = () => setRepairing(true);
    window.supermdToggleTypewriter = () => changeTypewriter(!(reference.current?.typewriterScroll ?? false));
    window.supermdNativeWheel=(dx,dy,point,held,modifier=false)=>{
      markScrollInput();
      const noteSplitWheelTarget=(node:Element)=>{
        if(reference.current?.mode!=="split")return;
        const rootPane=resolveSplitRootPaneScroller(node);
        if(rootPane)splitSyncRef.current?.notePaneInteraction(rootPane.pane);
      };
      const target=document.elementFromPoint(point.x,point.y),canvas=target?.closest(".interactive-chart svg,.image-viewer-canvas");
      if(target?.closest(NON_VIEWER_OVERLAY_SELECTOR)){if(!held){const origin=resolveNativeWheelScrollOrigin(target);if(origin)nativeScroll.scroll(origin,dx,dy);}return;}
      const editor=target?.closest<HTMLTextAreaElement>('textarea');
      if(editor){noteSplitWheelTarget(editor);nativeScroll.scroll(editor,dx,dy);return;}
      const slideNotes=target?.closest<HTMLElement>('.step-viewer .step-cards-notes');
      if(slideNotes&&!modifier){const origin=resolveNativeWheelScrollOrigin(target);if(origin)nativeScroll.scroll(origin,dx,dy);return;}
      if(held&&!target?.closest('input')&&(modifier||canvas||(!selectingText.current&&!window.getSelection()?.toString()))){gapSelection.current?.cancelStationary();if(canvas?.matches("svg"))canvas.dispatchEvent(new WheelEvent("wheel",{bubbles:true,cancelable:true,ctrlKey:true,deltaY:dy,clientX:point.x,clientY:point.y}));else window.supermdZoomBy?.(Math.exp(-dy*.002),point);return;}
      if(canvas){canvas.dispatchEvent(new CustomEvent("supermd-canvas-pan",{detail:{dx,dy},cancelable:true}));return;}
      const scroller=resolveNativeWheelScrollOrigin(target);
      if(scroller){noteSplitWheelTarget(scroller);nativeScroll.scroll(scroller,dx,dy);}
    };
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
      const captureView = operation.action === "move_tab" || operation.action === "detach_tab" || operation.action === "reload_reader";
      const baseView = captureView ? {editor:exportEditorSession(id), ...(id === current.id ? (()=>{const liveAnchor=captureSharedAnchor({id:current.id,mode:current.mode,zoom:zoomReference.current,readingRoot:document.querySelector<HTMLElement>(".android-reading"),preferredSplitPane:splitPane.current});return {top:liveAnchor.readingTop ?? 0,anchor:liveAnchor,rendered:exportRenderedViews(current.content)};})() : noteViews.current.get(id))} : undefined;
      void (async()=>{
        if(current.editProtocol===1)await edits.current!.flush(current.id);
        // Snapshot after the acknowledgement barrier, including edits made while waiting.
        const latest=reference.current;
        const view=baseView?{...baseView,history:transferHistory(histories.current.get(id))}:undefined;
        await invoke("document_flushed",{id:current.id,content:latest?.id===current.id?latest.content:current.content,operation,viewId:id,viewState:view});
      })().catch(error=>setEditError(String(error)));
    };
    window.supermdFind = (replaceOrQuery, options) => {
      if(document.querySelector('.theme-guide-dialog'))return;
      if(typeof replaceOrQuery==='string'&&willSeedNavigate(reference.current?.content??"",replaceOrQuery,options?.caseSensitive,options?.sourceStart,options?.sourceEnd,options?.matchText))markScrollInput();
      const requestedReplace=typeof replaceOrQuery==="boolean"?replaceOrQuery:Boolean(options?.replace);
      const openReplace=requestedReplace&&reference.current?.mode!=="reader";
      flushSync(()=>{
        if(typeof replaceOrQuery==='string'){
          searchSeedNonce.current+=1;
          setSearchSeed({query:replaceOrQuery.slice(0,200),caseSensitive:options?.caseSensitive,...normalizeSeedBounds(options?.sourceStart,options?.sourceEnd,options?.matchText),nonce:searchSeedNonce.current});
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
    window.supermdPortable = async (save, options) => {
      const current = reference.current; if (!current) return;
      try {
        if (options?.id && current.id !== options.id) throw new Error('The export note changed');
        const latest = await flushExportNote(current);
        if (options?.id && latest.id !== options.id) throw new Error('The export note changed');
        const consentPolicy = noteImageConsent.current.policy(latest.id, trustedHostsRef.current);
        const scopedLocalAssets = options?.id ? (latest.id === options.id ? noteLocalAssets.current.get(options.id) : undefined) : noteLocalAssets.current.get(latest.id);
        const localAssets = options?.localAssets ?? scopedLocalAssets;
        const omitLocalAssets = options?.omitLocalAssets ?? Boolean(localAssets?.length);
        const fmdOptions = {
          ...consentPolicy,
          ...(latest.portable !== undefined ? { portable: latest.portable } : {}),
          ...(localAssets !== undefined ? { localAssets } : {}),
          ...(omitLocalAssets ? { omitLocalAssets: true } : {}),
        };
        const prepared = await prepareFmd(latest.content, latest.path, fmdOptions);
        if (reference.current?.id !== latest.id || reference.current.content !== latest.content) throw new Error('The export note changed');
        await invoke("export_fmd_native", { ...prepared, originalContent: latest.content, id: latest.id, save, ...(omitLocalAssets ? { mergeLocalAssets: true } : {}) }); }
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
    return () => {nativeScroll.clear();cancelAnimationFrame(zoomFrame.current);window.clearTimeout(zoomTimer.current);delete window.supermdSelectedText;delete window.supermdThemeGuide;delete window.supermdSavePosition;delete window.supermdBeforeNavigate;delete window.supermdChromeInset;delete window.supermdLoad; delete window.supermdExport; delete window.supermdExportMarkdown; delete window.supermdPortable; delete window.supermdZoomBy; delete window.supermdResetZoom; delete window.supermdRepairMath; delete window.supermdToggleTypewriter; delete window.supermdFlush; delete window.supermdSetZoom; delete window.supermdHeading; delete window.supermdFormat; delete window.supermdHistory; delete window.supermdDismiss; delete window.supermdFind; delete window.supermdFindStep; };
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
  useSharedSourceAnchor({
    state,
    reference,
    zoomReference,
    refs: { noteViews, savePosition, modeAnchor, splitPane, restoringSplit, restoringSplitSeq, splitScrollTops, splitSync: splitSyncRef, consumedHeadingToken, layoutNavigatedHeadingToken, suppressedRestoreToken, suppressedRestoreKey, suppressRestoreForSeed },
  });
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
      const key=event.key.toLowerCase();if(key!=="z"&&(key!=="y"||event.shiftKey))return;
      if(document.querySelector(".image-viewer,.math-repair-panel,.reading-search,.media-dialog"))return;
      // Preserve non-document inputs while routing Live block textareas through
      // supermdHistory so native undo/redo reconciles and crosses block boundaries.
      if(isTextEntryField(event.target)&&!(event.target instanceof HTMLTextAreaElement&&event.target.closest('.live-active-block')))return;
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
      const target=event.target instanceof Element?event.target:null;
      const root=target?.closest<HTMLElement>('.android-reading')||(!target||target===document.body||target===document.documentElement?document.querySelector<HTMLElement>('.android-reading'):null);
      if(!root)return;
      const delta=readingKeyboardScrollDelta(event,root);
      if(delta===null)return;
      cancelHeadingNavigation(root);
      rememberWindowedScrollSource(root,delta);
    };
    document.addEventListener("wheel",wheel,{passive:false});
    document.addEventListener('keydown',scrollKey);
    return () => {gaps.end();gapSelection.current=null;document.removeEventListener('scroll',selectionScroll,true);document.removeEventListener('keydown',scrollKey);document.removeEventListener("pointermove",pan);document.removeEventListener("pointercancel",up);document.removeEventListener("pointermove",track);document.removeEventListener("pointerdown",down);document.removeEventListener("pointerup",up);window.removeEventListener("blur",up);cancelAnimationFrame(frame); document.removeEventListener("wheel",wheel); document.removeEventListener("touchstart", start); document.removeEventListener("touchmove", move); document.removeEventListener("touchend", end); document.removeEventListener("touchcancel", end); };
  }, []);
  const update = useCallback((content: string,changes?:SourceChange[],historyMeta?:LiveHistoryEditMeta) => {
    const previous=reference.current!;
    if(content===previous.content)return;
    if(!replaying.current){
      const history=histories.current.get(previous.id)||{undo:[],redo:[],last:0},now=Date.now();
      applyHistoryEdit(history,previous.content,content,now,historyMeta);
      histories.current.delete(previous.id);histories.current.set(previous.id,history);
      trimHistories(previous.id);
    } else {
      const history=histories.current.get(previous.id);
      if(history){histories.current.delete(previous.id);histories.current.set(previous.id,history);trimHistories(previous.id);}
    }
    const next = { ...reference.current!, content }; setState(next); reference.current = next;
    // The bridge receives every edit immediately, so closing/rotating cannot lose
    // a pending debounced WebView update. Disk snapshots are debounced natively.
    window.clearTimeout(pendingChange.current);
    const delivery=next.editProtocol===1?edits.current!.change(next.id,content,changes):invoke("document_changed",{id:next.id,content});
    void delivery.then(()=>setEditError(''),error=>setEditError(String(error)));
  }, []);
  const handleLiveChange = useCallback((content: string, meta?: LiveHistoryEditMeta) => update(content, undefined, meta), [update]);
  const handleLiveHistory = useCallback((direction: "undo" | "redo") => { window.supermdHistory?.(direction); return true; }, []);
  useEffect(()=>{
    const MAX_AGENT_QUEUE=16;
    let active=false,disposed=false;
    const queue:Array<{request:Record<string,unknown>;reply:(result:unknown,error?:string)=>void}>=[];
    const executeRequest=async(request:Record<string,unknown>)=>{
      const current=reference.current;if(!current)throw Error('The reader is not ready');
      if(current.editProtocol===1)await edits.current!.flush(current.id);
      const note=reference.current;if(!note||note.id!==current.id)throw Error('The active tab changed; refresh the tab list');
      const revision=await agentRevision(note.content);
      if(reference.current?.id!==note.id||reference.current.content!==note.content)throw Error('The note changed while reading; retry');
      const base={tabId:note.id,revision,sourceLength:agentCharLength(note.content)};
      const diagramOptions={documentPath:note.path,python:note.python||'embedded'};
      if(request.action==='flush_current')return base;
      if(request.action==='list_tabs'){
        const tabs=Array.isArray(request.tabs)?request.tabs:[];
        return {tabs:tabs.map(item=>{const tab=item as Record<string,unknown>;return tab.id===note.id?{...tab,...base,id:note.id}:tab;})};
      }
      if(request.tabId!==undefined&&request.tabId!==note.id)throw Error('Select this tab before requesting its live reader');
      const readResult=readAgentDocument(note.content,base,request,diagramOptions);if(readResult)return readResult;
      if(request.action==='get_diagram_image'){
        const diagram=resolveAgentDiagram(note.content,revision,request,diagramOptions);
        const imageFormat=request.imageFormat==='jpeg'?'jpeg':'png';
        const image=await mediaBytes(await diagramMedia(diagram,note.path),imageFormat,typeof request.width==='number'?Math.min(1600,Math.max(64,Math.round(request.width))):1600);return {...base,diagramId:diagram.id,mime_type:image.mimeType,data:image.body,width:image.width,height:image.height};
      }
      if(request.action==='get_context'){
        const analysis=readerSourceAnalysis(note.mode,note.content)?.analysis??analyzeDocument(note.content);
        const parsedFm=parseFrontmatter(note.content);
        const fmProps=parsedFm?.properties;
        const visibleMetadataProps=(()=>{
          if(!fmProps)return undefined;
          const out:Record<string,unknown>={};
          if(fmProps.title)out.title=fmProps.title.slice(0,300);
          if(fmProps.authors.length){
            const boundedAuthors=fmProps.authors.slice(0,20).map(a=>a.slice(0,200));
            out.author=boundedAuthors.join(', ').slice(0,500);
            out.authors=boundedAuthors;
          }
          if(fmProps.tags.length){
            out.tags=fmProps.tags.slice(0,50).map(t=>t.slice(0,100));
          }
          return Object.keys(out).length?out:undefined;
        })();
        const headingAtOffset=(utf16Offset:number)=>{
          let current='';
          for(const item of analysis.outline){if(item.offset<=utf16Offset)current=item.title;else break;}
          return current.slice(0,300);
        };
        const cleanNodeText=(element:HTMLElement)=>{
          const copy=element.cloneNode(true) as HTMLElement;
          copy.querySelectorAll('.katex-mathml,button,script,style,[inert],[aria-hidden="true"]').forEach(node=>node.remove());
          return copy.textContent?.trim()??'';
        };
        const requestedContextLimit=typeof request.limit==='number'&&Number.isFinite(request.limit)?Math.max(1,Math.min(12000,Math.floor(request.limit))):6000;
        let host:HTMLElement|null=null;
        let visibleText='';
        let heading='';
        let scrollFraction=0;
        let range:{start:number;end:number}|null=null;
        let offset=0;
        let selectionText='';

        if(note.mode==='editor'){
          const editorCtx=editorViewContext(note.id);
          host=editorCtx?.scroller??document.querySelector<HTMLElement>('.cm-scroller');
          if(editorCtx){
            offset=editorCtx.offset;
            range={start:editorCtx.visibleStart,end:editorCtx.visibleEnd};
            visibleText=editorCtx.visibleText;
            scrollFraction=editorCtx.scrollFraction;
            selectionText=editorCtx.selectionText||window.getSelection()?.toString()||'';
          }else{
            offset=editorReadingOffset(note.id)??0;
            selectionText=editorSelectedText(note.id)||window.getSelection()?.toString()||'';
            visibleText=note.content.slice(offset,offset+2000).trim();
          }
          heading=headingAtOffset(offset)||(fmProps?.title?.slice(0,300)??'');
        }else{
          host=document.querySelector<HTMLElement>('.android-reading');
          const bounds=host?.getBoundingClientRect();
          const activeTextarea=note.mode==='live'?host?.querySelector<HTMLTextAreaElement>('.live-active-block textarea'):null;
          const visibleParts:string[]=[];
          let firstBlockHeading='';
          let propertiesHeaderVisible=false;
          if(host&&bounds){
            const propsEl=host.querySelector<HTMLElement>('[data-frontmatter-properties],.document-properties');
            if(propsEl){
              const pBox=propsEl.getBoundingClientRect();
              if(pBox.bottom>bounds.top&&pBox.top<bounds.bottom&&pBox.height>0){
                propertiesHeaderVisible=true;
                const titleEl=propsEl.querySelector<HTMLElement>('[data-frontmatter-field="title"]');
                if(titleEl){
                  const tBox=titleEl.getBoundingClientRect();
                  if(tBox.bottom>bounds.top&&tBox.top<bounds.bottom&&tBox.height>0){
                    const tText=titleEl.textContent?.trim();
                    if(tText)visibleParts.push(tText);
                  }
                }
                const authorEl=propsEl.querySelector<HTMLElement>('[data-frontmatter-field="author"]');
                if(authorEl){
                  const aBox=authorEl.getBoundingClientRect();
                  if(aBox.bottom>bounds.top&&aBox.top<bounds.bottom&&aBox.height>0){
                    const aText=authorEl.textContent?.trim();
                    if(aText)visibleParts.push(`Author: ${aText}`);
                  }
                }
                const visibleTags:string[]=[];
                for(const tagEl of propsEl.querySelectorAll<HTMLElement>('[data-frontmatter-field="tag"]')){
                  const tagBox=tagEl.getBoundingClientRect();
                  if(tagBox.bottom>bounds.top&&tagBox.top<bounds.bottom&&tagBox.height>0){
                    const tagText=tagEl.textContent?.trim();
                    if(tagText)visibleTags.push(tagText);
                  }
                }
                if(visibleTags.length)visibleParts.push(`Tags: ${visibleTags.join(', ')}`);
              }
            }
            const candidates=Array.from(host.querySelectorAll<HTMLElement>('h1,h2,h3,h4,p,li,pre,.live-active-block textarea'));
            for(const element of candidates){
              if(element instanceof HTMLTextAreaElement){
                const box=element.getBoundingClientRect();
                if(box.bottom>bounds.top&&box.top<bounds.bottom&&box.height>0){
                  const draft=element.value.trim();
                  if(draft)visibleParts.push(draft);
                }
                continue;
              }
              if(element.closest('.live-active-block'))continue;
              const box=element.getBoundingClientRect();
              if(box.bottom>bounds.top&&box.top<bounds.bottom&&box.height>0){
                if(!firstBlockHeading&&/^H[1-6]$/.test(element.tagName))firstBlockHeading=element.textContent?.trim().slice(0,300)??'';
                const text=cleanNodeText(element);
                if(text)visibleParts.push(text);
              }
              if(visibleParts.length>=30)break;
            }
          }
          range=host?visibleSourceRange(host,note.content):null;
          if(propertiesHeaderVisible&&parsedFm&&parsedFm.end>0){
            range=range?{start:0,end:Math.max(range.end,parsedFm.end)}:{start:0,end:parsedFm.end};
          }
          if(activeTextarea&&bounds){
            const taRect=activeTextarea.getBoundingClientRect();
            const taStart=Number(activeTextarea.dataset.sourceStart);
            if(Number.isInteger(taStart)&&taStart>=0&&taRect.bottom>bounds.top&&taRect.top<bounds.bottom&&taRect.height>0){
              const taEnd=Math.min(note.content.length,taStart+activeTextarea.value.length);
              range=range?{start:Math.min(range.start,taStart),end:Math.max(range.end,taEnd)}:taEnd>taStart?{start:taStart,end:taEnd}:null;
            }
          }
          offset=range?.start??(host?readingOffset(host):0);
          if(activeTextarea&&activeTextarea.selectionEnd>activeTextarea.selectionStart){
            const taStart=Number(activeTextarea.dataset.sourceStart);
            if(Number.isInteger(taStart)&&taStart>=0)offset=Math.min(note.content.length,taStart+activeTextarea.selectionStart);
          }
          heading=firstBlockHeading||headingAtOffset(offset)||(fmProps?.title?.slice(0,300)??'');
          scrollFraction=host?host.scrollTop/Math.max(1,host.scrollHeight-host.clientHeight):0;
          visibleText=visibleParts.join('\n').slice(0,2000);
          if(note.mode==='split'){
            selectionText=editorSelectedText(note.id)||window.getSelection()?.toString()||'';
          }else if(note.mode==='live'&&activeTextarea&&activeTextarea.selectionEnd>activeTextarea.selectionStart){
            selectionText=activeTextarea.value.slice(activeTextarea.selectionStart,activeTextarea.selectionEnd);
          }else{
            selectionText=window.getSelection()?.toString()||'';
          }
        }

        // Inspect active StepCards decks (both inline and portaled .step-viewer dialogs on document.body).
        interface ActiveDeckState {deckTitle:string;stepLabel:string;stepIndex:number;stepCount:number;start?:number;end?:number;expanded:boolean;notesText:string}
        const activeDecks:ActiveDeckState[]=[];
        const readDeckState=(cardEl:HTMLElement,sourceAnchor:Element|null,expanded:boolean):ActiveDeckState|null=>{
          const deckTitle=cardEl.dataset.deckTitle?.trim()||'';
          const stepLabel=cardEl.dataset.stepLabel?.trim()||'';
          const stepIndex=Number(cardEl.dataset.stepIndex);
          const stepCount=Number(cardEl.dataset.stepCount);
          if(!deckTitle||!Number.isInteger(stepIndex)||stepIndex<0||!Number.isInteger(stepCount)||stepCount<1)return null;
          const block=sourceAnchor?.closest<HTMLElement>('[data-source-start][data-source-end]');
          const start=block?Number(block.dataset.sourceStart):NaN;
          const end=block?Number(block.dataset.sourceEnd):NaN;
          const notesEl=cardEl.querySelector<HTMLElement>('.step-cards-notes');
          const notesParts:string[]=[];
          if(stepLabel)notesParts.push(stepLabel);
          if(notesEl){
            const desc=notesEl.querySelector<HTMLElement>('.step-cards-description');
            if(desc){const cleaned=cleanNodeText(desc);if(cleaned)notesParts.push(cleaned);}
            else{
              const legacy=notesEl.querySelector<HTMLElement>('.step-cards-legacy-note');
              if(legacy){const cleaned=cleanNodeText(legacy);if(cleaned)notesParts.push(cleaned);}
            }
          }
          return {
            deckTitle,stepLabel,stepIndex,stepCount,expanded,
            ...(Number.isInteger(start)&&Number.isInteger(end)&&start>=0&&end>start?{start,end}:{}),
            notesText:notesParts.join('\n').trim(),
          };
        };
        for(const viewer of document.querySelectorAll<HTMLElement>('.step-viewer')){
          const cardEl=viewer.querySelector<HTMLElement>('.step-cards');
          if(!cardEl)continue;
          const deckId=cardEl.dataset.stepDeckId;
          const placeholder=deckId&&host?Array.from(host.querySelectorAll<HTMLElement>('.step-cards-placeholder')).find(el=>el.dataset.stepDeckId===deckId)??null:null;
          const parsed=readDeckState(cardEl,placeholder,true);
          if(parsed)activeDecks.push(parsed);
        }
        if(host){
          const hostBounds=host.getBoundingClientRect();
          for(const cardEl of host.querySelectorAll<HTMLElement>('.step-cards')){
            const box=cardEl.getBoundingClientRect();
            if(box.height<=0||box.bottom<=hostBounds.top||box.top>=hostBounds.bottom)continue;
            const parsed=readDeckState(cardEl,cardEl,false);
            if(parsed)activeDecks.push(parsed);
          }
        }
        const primaryDeck=activeDecks.find(d=>d.expanded)??activeDecks[0];
        if(primaryDeck?.expanded){
          if(primaryDeck.notesText){
            const slideSummary=`${primaryDeck.deckTitle} — ${primaryDeck.notesText}`;
            visibleText=[slideSummary,visibleText].filter(Boolean).join('\n').slice(0,2000);
          }
          if(primaryDeck.start!==undefined&&primaryDeck.end!==undefined){
            offset=primaryDeck.start;
            range=range?{start:Math.min(range.start,primaryDeck.start),end:Math.max(range.end,primaryDeck.end)}:{start:primaryDeck.start,end:primaryDeck.end};
          }
        }else if(primaryDeck&&primaryDeck.notesText&&!visibleText.includes(primaryDeck.stepLabel)){
          visibleText=[visibleText,`${primaryDeck.deckTitle} — ${primaryDeck.notesText}`].filter(Boolean).join('\n').slice(0,2000);
        }

        const visibleRange=range??{start:offset,end:Math.min(note.content.length,offset+requestedContextLimit)};
        const sourceOffset=agentCodePointOffset(note.content,offset),sourceLimit=Math.max(1,Math.min(requestedContextLimit,countCodePointsRange(note.content,offset,visibleRange.end)));
        let diagramScanRange:{start:number;end:number}|null=activeDecks.some(deck=>deck.expanded&&deck.start===undefined)?null:{...visibleRange};
        if(diagramScanRange){
          for(const deck of activeDecks){
            if(deck.expanded&&deck.start!==undefined&&deck.end!==undefined){
              diagramScanRange={start:Math.min(diagramScanRange.start,deck.start),end:Math.max(diagramScanRange.end,deck.end)};
            }
          }
        }
        const allDiagrams=agentDiagrams(note.content,diagramScanRange?{...diagramOptions,range:diagramScanRange}:diagramOptions);
        const filteredDiagrams=allDiagrams.filter(item=>{
          if(activeDecks.some(deck=>deck.expanded&&(deck.start!==undefined?item.start===deck.start:item.deckTitle===deck.deckTitle)))return true;
          return range?item.end>range.start&&item.start<range.end:item.start>=offset&&item.start<offset+requestedContextLimit;
        }).map(item=>{
          if(item.stepIndex===undefined)return item;
          const matchingDeck=activeDecks.find(deck=>deck.start!==undefined?deck.start===item.start:deck.deckTitle===item.deckTitle);
          return matchingDeck?{...item,activeStep:item.stepIndex===matchingDeck.stepIndex}:item;
        });
        // Prioritize active slide diagrams so a 30-item cap never drops the open slide.
        filteredDiagrams.sort((a,b)=>Number(b.activeStep===true)-Number(a.activeStep===true));

        // Summarize cached outputs for executed Python cells without ever running unexecuted code.
        const pythonCells:Array<Record<string,unknown>>=[];
        let cellOrdinal=0;
        const walkPython=(node:any)=>{
          if(pythonCells.length>=8)return;
          if(node.position?.start?.offset!==undefined&&node.position?.end?.offset!==undefined&&(node.position.end.offset<=visibleRange.start||node.position.start.offset>=visibleRange.end))return;
          if(node.type==='code'&&['python','py'].includes(String(node.lang||'').toLowerCase())&&node.position?.start?.offset!==undefined&&node.position?.end?.offset!==undefined){
            const cellStart=node.position.start.offset,cellEnd=node.position.end.offset;
            const pyIndex=analysis.pythonCells.findIndex(cell=>cell.offset===cellStart&&cell.source===String(node.value||''));
            const ordinal=pyIndex>=0?pyIndex:cellOrdinal++;
            const inRange=range?cellEnd>range.start&&cellStart<range.end:cellStart>=offset&&cellStart<offset+requestedContextLimit;
            if(inRange&&pythonCells.length<8){
              const duplicateOrdinal=pyIndex>=0?analysis.pythonCells[pyIndex].ordinal:0;
              const cached=inspectCachedPythonOutput(node.value,{document:note.path??null,cell:String(duplicateOrdinal),interpreter:note.python||'embedded'});
              if(cached){
                const codeStart=agentCodePointOffset(note.content,cellStart),codeEnd=agentCodePointOffset(note.content,cellEnd);
                const figures=cached.images.filter(safePythonFigure).slice(0,16).map((_,idx)=>`diagram:python:${codeStart}:${idx}`);
                const stdoutLimit=500,stderrLimit=500;
                pythonCells.push({
                  ordinal,
                  sourceStart:codeStart,
                  sourceEnd:codeEnd,
                  ok:cached.ok,
                  stdout:cached.stdout.slice(0,stdoutLimit),
                  ...(cached.stdout.length>stdoutLimit?{stdoutTruncated:true}:{}),
                  stderr:cached.stderr.slice(0,stderrLimit),
                  ...(cached.stderr.length>stderrLimit?{stderrTruncated:true}:{}),
                  figureIds:figures,
                });
              }
            }
          }
          for(const child of node.children??[])walkPython(child);
        };
        walkPython(analysis.tree);

        const splitRangeEnd=!!range&&range.end>0&&range.end<note.content.length&&note.content.charCodeAt(range.end-1)>=0xd800&&note.content.charCodeAt(range.end-1)<=0xdbff&&note.content.charCodeAt(range.end)>=0xdc00&&note.content.charCodeAt(range.end)<=0xdfff;
        const visiblePage=splitRangeEnd
          ?agentRead(note.content.slice(0,range!.end),sourceOffset,sourceLimit)
          :agentRead(note.content,sourceOffset,sourceLimit,undefined,'prose',range?Math.max(sourceOffset,agentCodePointOffset(note.content,range.end)):undefined);
        // The viewport bounds the page text, not the document's pagination.
        const visibleSource={...visiblePage,total_chars:base.sourceLength,next_offset:visiblePage.end<base.sourceLength?visiblePage.end:null,truncated:visiblePage.end<base.sourceLength};
        const portalViewer=primaryDeck?.expanded?document.querySelector<HTMLElement>('.step-viewer'):null;
        const viewportRect=(portalViewer??host)?.getBoundingClientRect();
        const left=viewportRect?Math.max(0,viewportRect.left):0,top=viewportRect?Math.max(0,viewportRect.top):0;
        const right=viewportRect?Math.min(window.innerWidth,viewportRect.right):0,bottom=viewportRect?Math.min(window.innerHeight,viewportRect.bottom):0;
        const activeStepSummary=primaryDeck?{
          deckTitle:primaryDeck.deckTitle.slice(0,200),
          stepLabel:primaryDeck.stepLabel.slice(0,200),
          stepIndex:primaryDeck.stepIndex,
          stepCount:primaryDeck.stepCount,
          activeStep:true as const,
          ...(primaryDeck.expanded?{expanded:true}:{}),
        }:undefined;
        const contextPayload:Record<string,unknown>={
          ...base,
          mode:note.mode,
          zoom:zoomReference.current,
          ...(visibleMetadataProps?{properties:visibleMetadataProps}:{}),
          reading:{offset:sourceOffset,scrollFraction,heading,visibleText},
          visibleSource,
          diagrams:filteredDiagrams.slice(0,30).map(item=>diagramMetadata(note.content,item)),
          ...(pythonCells.length?{pythonCells}:{}),
          ...(activeStepSummary?{activeStep:activeStepSummary}:{}),
          viewport:{x:left,y:top,width:Math.max(0,right-left),height:Math.max(0,bottom-top),viewportWidth:window.innerWidth,viewportHeight:window.innerHeight,devicePixelRatio:window.devicePixelRatio},
          selection:{text:selectionText.slice(0,2000)},
        };
        // Enforce local MCP's 24 KB UTF-8 cap on get_context responses.
        const encodedSize=(value:unknown)=>new TextEncoder().encode(JSON.stringify(value)).length;
        if(encodedSize(contextPayload)>23_000&&Array.isArray(contextPayload.pythonCells)){
          contextPayload.pythonCells=(contextPayload.pythonCells as Array<Record<string,unknown>>).slice(0,4).map(cell=>({...cell,stdout:String(cell.stdout??'').slice(0,200),stderr:String(cell.stderr??'').slice(0,200)}));
        }
        while(encodedSize(contextPayload)>23_000){
          const vs=contextPayload.visibleSource as Record<string,unknown>;
          const currentText=String(vs.text??'');
          if(currentText.length<=200)break;
          const currentChars=agentCharLength(currentText);
          if(currentChars<=200)break;
          const targetChars=Math.max(200,Math.floor(currentChars*0.7));
          const trimmed=currentText.slice(0,agentUtf16Offset(currentText,targetChars));
          const nextEnd=(vs.start as number)+targetChars;
          contextPayload.visibleSource={...vs,text:trimmed,returned_chars:targetChars,end:nextEnd,next_offset:nextEnd<base.sourceLength?nextEnd:null,truncated:nextEnd<base.sourceLength};
        }
        return contextPayload;
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
        let content:string,applied=0,patchOperations:unknown[]|undefined;
        if(request.action==='latex_apply'){
          const selected=request.repairIndices;
          if(!Array.isArray(selected)||!selected.length||selected.length>40||selected.some(index=>!Number.isInteger(index)||index<0))throw Error('Choose 1–40 repairIndices from latex_review');
          const repairs=suggestMathRepairs(note.content),indices=Array.from(new Set(selected)) as number[];
          if(indices.some(index=>index>=repairs.length))throw Error('A selected repair is no longer available');
          content=applyMathRepairs(note.content,indices.map(index=>repairs[index]));applied=indices.length;
        }else {const patch=applyAgentPatchesDetailed(note.content,request.operations);content=patch.text;applied=patch.applied;patchOperations=patch.operations;}
        if(reference.current?.id!==note.id||reference.current.content!==note.content)throw Error('Revision conflict: typing changed the note before the edit');
        const history=histories.current.get(note.id);if(history)history.last=0;
        update(content);const nextHistory=histories.current.get(note.id);if(nextHistory)nextHistory.last=0;
        if(note.editProtocol===1)await edits.current!.flush(note.id);
        const response:{tabId:string;revision:string;changed:boolean;applied:number;operations?:unknown[]}={tabId:note.id,revision:await agentRevision(content),changed:content!==note.content,applied};
        if(patchOperations)response.operations=patchOperations;
        return response;
      }
      if(request.action==='export_document'){
        const format=String(request.format);if(!['pdf','smd','md','mdzip'].includes(format))throw Error('Export format must be pdf, smd, md or mdzip');
        const suppliedOptions=request.options&&typeof request.options==='object'&&!Array.isArray(request.options)?request.options as Record<string,unknown>:{};
        const rawArchive=Object.prototype.hasOwnProperty.call(suppliedOptions,'archive')?suppliedOptions.archive:(request as Record<string,unknown>).archive;
        if(rawArchive!==undefined&&typeof rawArchive!=='boolean')throw Error('Export archive option must be a boolean');
        if(rawArchive===true&&format!=='md'&&format!=='mdzip')throw Error('Archive mode is only supported for Markdown exports');
        const archive=format==='mdzip'||rawArchive===true;
        const hasSection=Object.prototype.hasOwnProperty.call(suppliedOptions,'section'),section=hasSection?agentSectionForExport(note.content,suppliedOptions.section):undefined;
        const exportContent=section?.text??note.content,{section:_section,archive:_archive,...exportOptions}=suppliedOptions;
        const consentPolicy=noteImageConsent.current.policy(note.id,trustedHostsRef.current);
        const prepared=format==='pdf'?await preparePdf(exportContent,note.path,note.python||'embedded',consentPolicy):format==='smd'?await prepareFmd(exportContent,note.path,note.portable!==undefined?{...consentPolicy,portable:note.portable}:consentPolicy):await prepareMarkdownExport(exportContent,note.path,{compatible:archive,python:note.python||'embedded'});
        if(reference.current?.id!==note.id||reference.current.content!==note.content)throw Error('Revision conflict: the note changed while preparing the export');
        const result=await invoke<Record<string,unknown>>('agent_export_native',{...prepared,id:note.id,expectedRevision:revision,requestId:request.requestId,format:archive?'mdzip':format,...(archive?{archive:true}:{}),filename:request.filename,options:exportOptions});
        return section?{...result,sectionStart:section.sectionStart,sectionEnd:section.sectionEnd,documentLength:section.documentLength}:result;
      }
      throw Error('Unsupported live reader action');
    };
    const pumpQueue=()=>{
      if(active||disposed)return;
      const next=queue.shift();
      if(!next)return;
      active=true;
      void executeRequest(next.request).then(
        result=>{active=false;if(disposed)next.reply(null,'The reader view closed before completing the agent request');else{next.reply(result);pumpQueue();}},
        error=>{active=false;if(disposed)next.reply(null,'The reader view closed before completing the agent request');else{next.reply(null,error instanceof Error?error.message:'Agent request failed');pumpQueue();}},
      );
    };
    const handleCompute:NonNullable<Window['supermdAgentCompute']>=(request,callback)=>{
      void computeAgentDocumentRequest(request).then(result=>callback(result,''),error=>callback(null,error instanceof Error?error.message:'Agent request failed'));
    };
    const handleRequest:NonNullable<Window['supermdAgentRequest']>=(request,callback)=>{
      let settled=false;
      const reply=(result:unknown,error='')=>{
        if(settled)return;
        settled=true;
        if(callback)callback(result,error);
        else void invoke('agent_result',{requestId:request.requestId,result,error});
      };
      if(disposed){reply(null,'The reader view is unmounted');return;}
      if(active&&queue.length>=MAX_AGENT_QUEUE){reply(null,'The reader agent request queue is full; retry shortly.');return;}
      queue.push({request,reply});
      pumpQueue();
    };
    window.supermdAgentCompute=handleCompute;
    window.supermdAgentRequest=handleRequest;
    return()=>{
      disposed=true;
      for(const pendingItem of queue.splice(0)){pendingItem.reply(null,'The reader view closed before completing the agent request');}
      if(window.supermdAgentRequest===handleRequest)delete window.supermdAgentRequest;
      if(window.supermdAgentCompute===handleCompute)delete window.supermdAgentCompute;
    };
  },[update]);
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
    <MediaTools documentId={state.id} content={state.content} documentPath={state.path} onInsert={(text, point) => { const current = reference.current; if (!current || current.id !== state.id) return; const content = current.content; const from = Math.min(point?.from ?? content.length, content.length); const to = Math.max(from, Math.min(point?.to ?? from, content.length)); update(content.slice(0, from) + text + content.slice(to), undefined, { isolateHistory: true }); }} onNotice={(error) => { void invoke("export_failed", { error }); }} />
    {(state.mode === "editor" || state.mode === "split") && <section className="android-source"><SourceEditor key={state.id} sessionId={state.id} documentPath={state.path === state.id ? null : state.path} value={state.content} onChange={update} dark={state.dark} focusMode={state.fullscreen} latexAutofix={state.latexAutofix} typewriterScroll={state.typewriterScroll} onTypewriterChange={changeTypewriter} spellCheck={state.spellCheck} grammarCheck={state.grammarCheck} /></section>}
    {state.mode === "live" && <section className="android-reading" data-full-document-accessibility={state.fullDocumentAccessibility ? "true" : undefined}><div className="reader-chrome-spacer" aria-hidden="true"/><div key={state.id} className="document-page-space"><div className="document-page"><LiveDocument key={state.id} noteId={state.id} latexAutofix={state.latexAutofix} typewriterScroll={state.typewriterScroll} spellCheck={state.spellCheck} grammarCheck={state.grammarCheck} markdown={state.content} onChange={handleLiveChange} onHistory={handleLiveHistory} historyReplayToken={historyReplayToken} documentPath={state.path} savedDocumentPath={state.path === state.id ? null : state.path} python={state.python || "embedded"} dark={false} trustedImageHosts={trustedHosts} approvedImageUrls={approvedImageUrls} onTrustImageHost={trustHost} onApproveImageUrl={approveImageUrl} onRemoteImageLoaded={recordRemoteImageLoaded} fullDocumentAccessibility={state.fullDocumentAccessibility} /></div></div></section>}
    {(state.mode === "reader" || state.mode === "split") && <section className="android-reading" data-full-document-accessibility={state.fullDocumentAccessibility ? "true" : undefined}><div className="reader-chrome-spacer" aria-hidden="true"/><div key={state.id} className="document-page-space"><div className="document-page"><DocumentPreview noteId={state.id} markdown={state.content} onChange={update} documentPath={state.path} savedDocumentPath={state.path === state.id ? null : state.path} python={state.python || "embedded"} dark={false} trustedImageHosts={trustedHosts} approvedImageUrls={approvedImageUrls} onTrustImageHost={trustHost} onApproveImageUrl={approveImageUrl} onRemoteImageLoaded={recordRemoteImageLoaded} fullDocumentAccessibility={state.fullDocumentAccessibility} sourceAnalysis={readerAnalysis?.source===state.content?readerAnalysis:undefined} /></div></div></section>}
  </div></DocumentAppearance.Provider>;
}
const rootElement = document.getElementById("root");
if (rootElement) {
  const mountReaderRoot = () => createRoot(rootElement).render(<Reader />);
  if ((globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT) mountReaderRoot();
  else flushSync(mountReaderRoot);
}
