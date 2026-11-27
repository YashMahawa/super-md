import { Children, createContext, isValidElement, lazy, memo, Suspense, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { invoke } from "../nativeBridge";
import CachedMarkdown,{type MarkdownBlockRenderer} from "./CachedMarkdown";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import type { PluggableList } from "unified";
import { visit } from "unist-util-visit";
import InteractiveChart from "./InteractiveChart";
import StepCards from "./StepCards";
import InlineDiagram,{parseDiagramSource} from "./InlineDiagram";
import {parseBinaryTreeSource} from "./BinaryTree";
import PythonCell from "./PythonCell";
import SvgDiagram from "./SvgDiagram";
import { navigateExternalLink, navigateHeading, navigateWorkspaceLink, remarkHeadingIds, UNSAVED_RELATIVE_NOTE_NOTICE } from "../documentNavigation";
import { trustEquationHref } from "../equationReferences";
import { classifyRenderedLink } from "../workspaceLinks";
import { selectedMarkdown, setSelectedMarkdownDrag } from "../copySource";
import CopyCode from "./CopyCode";
import CodeBlockBoundary from "./CodeBlockBoundary";
import DocumentProperties from "./DocumentProperties";
import {DocumentAppearance} from '../documentAppearance';
import {parseValidatedSvg} from '../svgImage';
import {adaptValidatedSvg,decodeSvgDataUri} from '../svgTheme';
import {analyzeDocument} from '../documentAnalysis';
import type {PythonCellSource, SourceDocumentAnalysis} from '../documentAnalysis';
import {isSvgAssetPath,resolveReaderRasterAsset} from '../readerAssets';
import {commitMediaLayout} from '../mediaLayout';
import {registerMedia,installMediaMenu} from '../mediaExport';
import {isRemoteImageApproved,normalizeApprovedImageUrls,normalizeTrustedImageHosts,remoteImageHost} from '../remoteImageConsent';
import type {ReaderAccessibilityPreference} from '../types';
import type {Components} from 'react-markdown';
export {normalizeCallouts} from '../markdownSource';

const MermaidDiagram = lazy(() => import("./MermaidDiagram"));
function ThemedChart({source,dark}:{source:string;dark:boolean}) {const theme=useContext(DocumentAppearance);return <InteractiveChart source={source} dark={theme?.dark??dark} appearance={theme?.svgAppearance} colors={theme?.colors}/>;}
function ThemedSvg({source,dark}:{source:string;dark:boolean}) {const theme=useContext(DocumentAppearance);return <SvgDiagram source={source} dark={theme?.dark??dark} appearance={theme?.svgAppearance} ink={theme?.svgAppearance==='auto'?theme.ink:theme?.text} colors={theme?.colors}/>;}
function ThemedMermaid({source,dark}:{source:string;dark:boolean}) {const theme=useContext(DocumentAppearance);return <MermaidDiagram source={source} dark={theme?.dark??dark} appearance={theme?.svgAppearance} colors={theme?.colors}/>;}
const EMPTY_TRUSTED_IMAGE_HOSTS: string[] = [];
const EMPTY_APPROVED_IMAGE_URLS: string[] = [];
// Keep this component type stable across edits so unchanged paragraphs and
// their loaded media are not remounted just to classify a standalone figure.
const MarkdownParagraph:Components['p']=({node,children,...props})=>{
  const child=node?.children.length===1?node.children[0]:undefined;
  const standalone=child?.type==='element'&&child.tagName==='img';
  return <p {...props} className={[props.className,standalone?'media-paragraph':''].filter(Boolean).join(' ')||undefined}>{children}</p>;
};
function remarkTaskPositions() {
  return (tree:unknown)=>{let index=0;visit(tree as never,'listItem',(node:any)=>{if(typeof node.checked==='boolean')node.data={...node.data,hProperties:{...node.data?.hProperties,'data-task-index':index++}};});};
}
function remarkSourcePositions(){return (tree:unknown)=>visit(tree as never,(node:any)=>{
  if(!node.position||!node.children)return;
  node.data={...node.data,hProperties:{...node.data?.hProperties,"data-source-start":node.position.start.offset,"data-source-end":node.position.end.offset}};
});}

function textOf(value: ReactNode): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(textOf).join("");
  if (isValidElement<{ children?: ReactNode }>(value)) return textOf(value.props.children);
  return "";
}

export function remarkCallouts() {
  return (tree: unknown) => visit(tree as never, "blockquote", (node: any) => {
    const paragraph = node.children?.[0];
    const first = paragraph?.children?.[0];
    if (first?.type !== "text") return;
    const match = first.value.match(/^\[!([\w-]+)\]([+-]?)[ \t]*/i);
    if (!match) return;
    const type = match[1].toLowerCase();
    const fold = match[2];
    first.value = first.value.slice(match[0].length);
    // A title is a line of inline Markdown, not just the first text node.
    // Keep emphasis, links and math in their original AST form and split only
    // the first line, even if its newline is inside an emphasis/link node.
    const split=(children:any[]):{title:any[];body:any[];ended:boolean}=>{
      const title:any[]=[],body:any[]=[];let ended=false;
      for(const child of children){
        if(ended){body.push(child);continue;}
        if(child.type==='break'){ended=true;continue;}
        if(child.type==='text'){
          const at=child.value.indexOf('\n');
          if(at>=0){if(at)title.push({...child,value:child.value.slice(0,at)});if(child.value.length>at+1)body.push({...child,value:child.value.slice(at+1)});ended=true;}
          else if(child.value)title.push(child);
        }else if(child.children){
          const parts=split(child.children);if(parts.title.length)title.push({...child,children:parts.title});if(parts.body.length)body.push({...child,children:parts.body});ended=parts.ended;
        }else title.push(child);
      }
      return {title,body,ended};
    };
    const parts=split(paragraph.children);
    paragraph.children=parts.body;
    if(!paragraph.children.length)node.children.shift();
    const hasCustomTitle=parts.title.some((child:any)=>child.type!=='text'||child.value.trim());
    const title=hasCustomTitle?parts.title:[{type:'text',value:type[0].toUpperCase()+type.slice(1)}];
    const collapsible = Boolean(fold) || type === "answer" || type === "solution";
    node.children.unshift({
      type: "paragraph",
      data: { hName: collapsible ? "summary" : "p", hProperties: { className: "callout-title" } },
      children: title
    });
    node.data = { hName: collapsible ? "details" : "aside", hProperties: { ...(collapsible ? {open:fold === "+"} : {}), className: `callout callout-${type}`, "data-callout-type": type, ...(fold ? {"data-callout-fold": fold} : {}), ...(!hasCustomTitle ? {"data-callout-default-title": "true"} : {}) } };
  });
}

export const DIAGRAM_PLAIN_TEXT_LANGUAGES = ["svg", "mermaid", "smd-tree", "smd-diagram", "smd-steps", "smd-chart"] as const;
export const PREVIEW_REMARK_PLUGINS: PluggableList = [remarkCallouts, remarkHeadingIds, remarkTaskPositions, remarkSourcePositions];
export const PREVIEW_REHYPE_PLUGINS: PluggableList = [[rehypeKatex, { trust: trustEquationHref }], [rehypeHighlight, { plainText: [...DIAGRAM_PLAIN_TEXT_LANGUAGES] }]];

function AssetImage({ noteId, src = "", alt = "", documentPath, trustedImageHosts, approvedImageUrls = EMPTY_APPROVED_IMAGE_URLS, onTrustImageHost, onApproveImageUrl, onRemoteImageLoaded, editable = false }: { noteId?: string; src?: string; alt?: string; documentPath: string | null; trustedImageHosts: string[]; approvedImageUrls?: readonly string[]; onTrustImageHost?: (host: string) => void; onApproveImageUrl?: (noteId: string | undefined, url: string) => void; onRemoteImageLoaded?: (noteId: string | undefined, url: string, data: string) => void; editable?: boolean }) {
  const isRemote = /^https?:\/\//i.test(src);
  const embedded = /^(data:|blob:)/i.test(src);
  const validRemoteHost = isRemote ? remoteImageHost(src) : null;
  let host = validRemoteHost ?? "";
  if (isRemote && !host) {
    try { host = new URL(src).host || "invalid address"; }
    catch { host = "invalid address"; }
  }
  const [allowedOnce, setAllowedOnce] = useState<{ noteId?: string; src: string } | null>(null);
  const [resolved, setResolved] = useState(embedded ? src : "");
  const [error, setError] = useState("");
  const mediaElement=useRef<HTMLSpanElement>(null);
  const imageElement=useRef<HTMLImageElement>(null);
  const onRemoteImageLoadedRef = useRef(onRemoteImageLoaded);
  onRemoteImageLoadedRef.current = onRemoteImageLoaded;
  const [sizedSource,setSizedSource]=useState('');
  const [assetEpoch,setAssetEpoch]=useState(0);
  const [permissionRetry,setPermissionRetry]=useState(0);
  useEffect(()=>{
    const changed=()=>setAssetEpoch(value=>value+1);
    window.addEventListener('supermd-assets-changed',changed);
    return()=>window.removeEventListener('supermd-assets-changed',changed);
  },[]);
  useEffect(()=>{
    const restored=(event:Event)=>{
      if(!error||isRemote||embedded)return;
      const detail=(event as CustomEvent<{documentPath?:unknown;source?:unknown}>).detail;
      if(!detail||String(detail.documentPath??'')!==(documentPath??'')||detail.source!==src)return;
      commitMediaLayout(mediaElement.current,()=>{setError('');setResolved('');setPermissionRetry(value=>value+1);});
    };
    window.addEventListener('supermd-asset-access-restored',restored);
    return()=>window.removeEventListener('supermd-asset-access-restored',restored);
  },[documentPath,embedded,error,isRemote,src]);
  const isSvgData=/^data:image\/svg\+xml(?:[;,]|$)/i.test(resolved);
  const validatedSvg=useMemo(()=>{
    if(!resolved||!isSvgData)return null;
    try{return {svg:parseValidatedSvg(decodeSvgDataUri(resolved)),error:''};}
    catch(reason){return {svg:null,error:reason instanceof Error?reason.message:String(reason)};}
  },[resolved,isSvgData]);
  const svgBacking=validatedSvg?.svg?.backing;
  const appearance=useContext(DocumentAppearance);
  const adaptsSvg=appearance?.svgAppearance==='auto'||appearance?.svgAppearance==='monochrome';
  const adapted=useMemo(()=>{
    if(!resolved||!isSvgData)return {src:resolved,error:''};
    if(!validatedSvg?.svg)return {src:'',error:validatedSvg?.error??'This SVG is not valid XML.'};
    if(!adaptsSvg)return {src:resolved,error:''};
    try{
      return {src:'data:image/svg+xml;charset=utf-8,'+encodeURIComponent(adaptValidatedSvg(validatedSvg.svg,appearance?.colors??{},appearance?.dark??false,appearance?.svgAppearance==='monochrome')),error:''};
    }catch(reason){
      return {src:'',error:reason instanceof Error?reason.message:String(reason)};
    }
  },[resolved,isSvgData,validatedSvg,appearance,adaptsSvg]);
  const adaptedSource=adapted.src;
  const displayError=error||adapted.error;
  // A one-time approval belongs to the exact note and URL the user approved.
  // Keeping both in state avoids leaking across tab switches or passive effects.
  const trustedSet = useMemo(() => normalizeTrustedImageHosts(trustedImageHosts), [trustedImageHosts]);
  const approvedSet = useMemo(() => normalizeApprovedImageUrls(approvedImageUrls), [approvedImageUrls]);
  const allowed = Boolean(validRemoteHost) && ((allowedOnce !== null && allowedOnce.src === src && allowedOnce.noteId === noteId) || isRemoteImageApproved(src, trustedSet, approvedSet));
  useEffect(() => {
    let active = true;
    const originNoteId = noteId;
    const fail=(reason:string)=>{if(active)commitMediaLayout(mediaElement.current,()=>setError(reason));};
    setError("");
    if (embedded) { setResolved(src); return; }
    if(!assetEpoch)setResolved("");
    if (isRemote) {
      if (!allowed) { setResolved(""); return; }
      // Explicit consent routes through the bounded native fetcher, not a raw
      // remote request from a local WebEngine page. This also works offline after insertion.
      invoke<{body:string}>("fetch_resource",{url:src,image:true})
        .then(value=>{if(validRemoteHost&&/^data:image\//i.test(value.body))onRemoteImageLoadedRef.current?.(originNoteId,src,value.body);if(active)commitMediaLayout(mediaElement.current,()=>setResolved(value.body));})
        .catch(reason=>fail(String(reason)));
      return ()=>{active=false;};
    }
    if (!documentPath && !/^assets\/import-[\w-]+\./.test(src)) { queueMicrotask(()=>fail("Save this document to resolve relative images.")); return ()=>{active=false;}; }
    (async () => {
      try {
        const streamed = documentPath && !isSvgAssetPath(src) ? await resolveReaderRasterAsset(documentPath, src) : null;
        if (!active) return;
        if (streamed) { commitMediaLayout(mediaElement.current,()=>setResolved(streamed)); return; }
        const value = await invoke<string>("load_asset", { documentPath: documentPath || "", source: src });
        if (active)commitMediaLayout(mediaElement.current,()=>setResolved(value));
      } catch (reason) {
        fail(String(reason));
      }
    })();
    return () => { active = false; };
  }, [noteId, documentPath, embedded, isRemote, src, allowed, assetEpoch, permissionRetry]);
  useEffect(()=>{
    if(!resolved||displayError||isRemote&&!allowed)return;
    const svg=isSvgData;
    return registerMedia(imageElement.current,{label:alt||'Image',uri:()=>resolved,...(svg?{svg:()=>decodeSvgDataUri(resolved)}:{})});
  },[resolved,displayError,isSvgData,isRemote,allowed,alt]);
  const readonlyAttr = editable ? undefined : "true";
  const noteIdAttr = noteId || undefined;
  if (isRemote && !allowed) return <span ref={mediaElement} className="remote-image-card" data-note-id={noteIdAttr} data-note-image-source={src} data-note-image-readonly={readonlyAttr} role="group" aria-label={`Remote image from ${host}`}><span><strong>{alt || "Remote image"}</strong><small>{host} · blocked until you choose to load it</small></span><span className="remote-image-actions"><button type="button" onClick={() => { if (validRemoteHost) { const originNoteId = noteId; setAllowedOnce({ noteId: originNoteId, src }); onApproveImageUrl?.(originNoteId, src); } }}>Load image</button>{onTrustImageHost && validRemoteHost && <button type="button" onClick={() => onTrustImageHost(validRemoteHost)}>Trust domain</button>}</span></span>;
  if (displayError) return <span ref={mediaElement} className="image-error" data-note-id={noteIdAttr} data-note-image-source={src} data-note-image-readonly={readonlyAttr} role={editable ? "group" : "img"} aria-label={alt || "Image unavailable"}><span>Image unavailable: {alt || src}<small>{displayError}</small></span>{editable && <span className="image-error-actions"><button type="button" onClick={(event) => { event.stopPropagation(); window.dispatchEvent(new CustomEvent("supermd-image-edit", { detail: { action: "replace", image: event.currentTarget.closest("[data-note-image-source]") } })); }}>Replace</button><button type="button" onClick={(event) => { event.stopPropagation(); window.dispatchEvent(new CustomEvent("supermd-image-edit", { detail: { action: "remove", image: event.currentTarget.closest("[data-note-image-source]") } })); }}>Remove</button></span>}</span>;
  if (!resolved) return <span ref={mediaElement} className="image-loading" data-note-id={noteIdAttr} role="status">Loading image…</span>;
  const sizing=sizedSource!==resolved;
  return <span ref={mediaElement} className={`note-image ${isSvgData?'note-image--diagram':''} ${sizing?'image-loading':''}`} style={sizing?{width:'100%',boxSizing:'border-box'}:undefined} data-note-id={noteIdAttr} data-note-image-source={src} data-note-image-readonly={readonlyAttr} tabIndex={0} aria-label={`Image: ${alt || "Image"}`}>
    {sizing&&<span role="status">Loading image…</span>}
    <img ref={imageElement} draggable={false} data-media-adapted={adaptsSvg&&svgBacking?'true':undefined} data-media-kind={isSvgData?'svg':'image'} data-light-ink={svgBacking==='#222026'?'true':undefined} style={{...(svgBacking?{'--svg-contrast-backing':svgBacking}:{}),...(sizing?{position:'absolute',height:0,visibility:'hidden'}:{})} as React.CSSProperties} src={adaptedSource} alt={alt} loading="lazy" decoding="async" onLoad={()=>{if(sizedSource!==resolved)commitMediaLayout(imageElement.current,()=>setSizedSource(resolved));}} onError={() => commitMediaLayout(imageElement.current,()=>setError("The image could not be decoded or loaded."))} />
  </span>;
}

interface Props extends ReaderAccessibilityPreference {
  noteId?: string;
  markdown: string;
  documentPath: string | null;
  savedDocumentPath?: string | null;
  python: string;
  dark: boolean;
  trustedImageHosts?: string[];
  approvedImageUrls?: readonly string[];
  onTrustImageHost?: (host: string) => void;
  onApproveImageUrl?: (noteId: string | undefined, url: string) => void;
  onRemoteImageLoaded?: (noteId: string | undefined, url: string, data: string) => void;
  onChange?: (markdown:string)=>void;
  onNotice?: (message: string) => void;
  renderBlock?:MarkdownBlockRenderer;
  sourceAnalysis?:SourceDocumentAnalysis;
}

interface MarkdownPreviewLiveState {
  markdown: string;
  tasks: number[];
  onChange?: (markdown: string) => void;
  pythonCells: PythonCellSource[];
  resolvedNotePath: string | null;
  savedDocumentPath?: string | null;
  onNotice?: (message: string) => void;
  reportLinkNotice: (rawMessage: string) => void;
  clearLinkNotice: () => void;
}

interface MarkdownPreviewContextValue {
  noteId?: string;
  documentPath: string | null;
  python: string;
  dark: boolean;
  trustedImageHosts: string[];
  approvedImageUrls: readonly string[];
  onTrustImageHost?: (host: string) => void;
  onApproveImageUrl?: (noteId: string | undefined, url: string) => void;
  onRemoteImageLoaded?: (noteId: string | undefined, url: string, data: string) => void;
  editable: boolean;
  liveStateRef: RefObject<MarkdownPreviewLiveState>;
}

const EMPTY_TASKS: number[] = [];
const EMPTY_PYTHON_CELLS: PythonCellSource[] = [];
const NOOP = () => {};
const DEFAULT_LIVE_STATE: RefObject<MarkdownPreviewLiveState> = {
  current: {
    markdown: "",
    tasks: EMPTY_TASKS,
    onChange: undefined,
    pythonCells: EMPTY_PYTHON_CELLS,
    resolvedNotePath: null,
    savedDocumentPath: undefined,
    onNotice: undefined,
    reportLinkNotice: NOOP,
    clearLinkNotice: NOOP,
  },
};
const MarkdownPreviewContext = createContext<MarkdownPreviewContextValue>({
  noteId: undefined,
  documentPath: null,
  python: "",
  dark: false,
  trustedImageHosts: EMPTY_TRUSTED_IMAGE_HOSTS,
  approvedImageUrls: EMPTY_APPROVED_IMAGE_URLS,
  onTrustImageHost: undefined,
  onApproveImageUrl: undefined,
  onRemoteImageLoaded: undefined,
  editable: false,
  liveStateRef: DEFAULT_LIVE_STATE,
});

const MarkdownInput: Components['input'] = ({ node: _node, checked, ...props }) => {
  const { editable } = useContext(MarkdownPreviewContext);
  const isTaskCheckbox = props.type === 'checkbox';
  return (
    <input
      {...props}
      data-task-checkbox={isTaskCheckbox ? '' : undefined}
      checked={isTaskCheckbox ? Boolean(checked) : checked}
      disabled={!editable}
      onChange={NOOP}
    />
  );
};

const MarkdownListItem: Components['li'] = ({ node, children, ...props }) => {
  const { liveStateRef } = useContext(MarkdownPreviewContext);
  const rawTaskIndex = node?.properties?.['data-task-index'];
  const hasTaskIndex = rawTaskIndex !== undefined && rawTaskIndex !== null;
  return (
    <li
      {...props}
      className={Array.isArray(node?.properties.className) ? node.properties.className.join(' ') : undefined}
      onChange={hasTaskIndex ? event => {
        const target = event.target;
        if (
          !(target instanceof HTMLInputElement) ||
          target.type !== 'checkbox' ||
          !target.hasAttribute('data-task-checkbox') ||
          target.closest('li') !== event.currentTarget
        ) {
          return;
        }
        event.stopPropagation();
        const { tasks, onChange, markdown } = liveStateRef.current;
        const offset = tasks[Number(rawTaskIndex)];
        if (offset === undefined || !onChange) return;
        onChange(markdown.slice(0, offset) + (target.checked ? 'x' : ' ') + markdown.slice(offset + 1));
      } : undefined}
    >
      {children}
    </li>
  );
};

const MarkdownImage: Components['img'] = ({ src, alt }) => {
  const { noteId, documentPath, trustedImageHosts, approvedImageUrls, onTrustImageHost, onApproveImageUrl, onRemoteImageLoaded, editable } = useContext(MarkdownPreviewContext);
  return <AssetImage noteId={noteId} src={src} alt={alt} documentPath={documentPath} trustedImageHosts={trustedImageHosts} approvedImageUrls={approvedImageUrls} onTrustImageHost={onTrustImageHost} onApproveImageUrl={onApproveImageUrl} onRemoteImageLoaded={onRemoteImageLoaded} editable={editable} />;
};

const MarkdownLink: Components['a'] = ({ node: _node, href, children, ...props }) => {
  const { liveStateRef } = useContext(MarkdownPreviewContext);
  const rawProps = props as Record<string, unknown>;
  const wikilinkTarget = typeof rawProps['data-wikilink'] === 'string' ? rawProps['data-wikilink'] : undefined;
  const wikilinkFragment = typeof rawProps['data-heading-fragment'] === 'string' ? rawProps['data-heading-fragment'] : undefined;
  const classified = classifyRenderedLink(href, wikilinkTarget, wikilinkFragment);
  const isExternal = classified.kind === 'external';
  return (
    <a
      {...props}
      href={href}
      target={isExternal ? "_blank" : undefined}
      rel={isExternal ? "noreferrer" : undefined}
      onClick={event => {
        if (classified.kind === 'same-note') {
          if (navigateHeading(event.currentTarget)) {
            event.preventDefault();
            event.stopPropagation();
          }
          return;
        }
        if (classified.kind === 'workspace') {
          event.preventDefault();
          event.stopPropagation();
          event.currentTarget.dataset.visited = 'true';
          const { resolvedNotePath, reportLinkNotice, clearLinkNotice } = liveStateRef.current;
          if (!resolvedNotePath && (typeof window === 'undefined' || !window.SuperMD)) {
            reportLinkNotice(UNSAVED_RELATIVE_NOTE_NOTICE);
            return;
          }
          clearLinkNotice();
          navigateWorkspaceLink(classified, resolvedNotePath, liveStateRef.current.reportLinkNotice);
          return;
        }
        if (classified.kind === 'external') {
          event.currentTarget.dataset.visited = 'true';
          if (navigateExternalLink(classified.url)) {
            event.preventDefault();
            event.stopPropagation();
          }
          return;
        }
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      {children}
    </a>
  );
};

const MarkdownPre: Components['pre'] = ({ node, children }) => {
  const { noteId, documentPath, python, dark, trustedImageHosts, approvedImageUrls, onTrustImageHost, onApproveImageUrl, onRemoteImageLoaded, liveStateRef } = useContext(MarkdownPreviewContext);
  const child = Children.only(children) as React.ReactElement<{ className?: string; children?: ReactNode }>;
  const language = child.props.className?.match(/language-([\w-]+)/)?.[1];
  const source = textOf(child.props.children).replace(/\n$/, "");
  const nodeData = node as { position?: { start?: { offset?: number }; end?: { offset?: number } }; properties?: Record<string, unknown> } | undefined;
  const offset = Number(nodeData?.properties?.['data-source-start'] ?? nodeData?.position?.start?.offset);
  const endOffset = Number(nodeData?.properties?.['data-source-end'] ?? nodeData?.position?.end?.offset);
  const hasRange = Number.isInteger(offset) && Number.isInteger(endOffset) && offset >= 0 && endOffset > offset;
  const srcStart = hasRange ? offset : undefined;
  const srcEnd = hasRange ? endOffset : undefined;
  const pythonCell = ['python', 'py'].includes(language || '')
    ? liveStateRef.current.pythonCells.find(cell => cell.source === source && cell.offset === offset)
    : undefined;
  const context = documentPath && pythonCell
    ? { document: documentPath, cell: String(pythonCell.ordinal), interpreter: python || 'embedded' }
    : undefined;
  const protectedBlock = (block: ReactNode) => <CodeBlockBoundary key={`${language}:${source}`} source={source}>{block}</CodeBlockBoundary>;
  if (language === "smd-tree") return protectedBlock(<InlineDiagram diagram={parseBinaryTreeSource(source)} />);
  if (language === "smd-diagram") return protectedBlock(<InlineDiagram diagram={parseDiagramSource(source)} />);
  if (language === "smd-steps") return (
    <CodeBlockBoundary key={language} source={source}>
      <StepCards
        source={source}
        sourceStart={srcStart}
        sourceEnd={srcEnd}
        renderImage={(src, alt) => <AssetImage noteId={noteId} src={src} alt={alt} documentPath={documentPath} trustedImageHosts={trustedImageHosts} approvedImageUrls={approvedImageUrls} onTrustImageHost={onTrustImageHost} onApproveImageUrl={onApproveImageUrl} onRemoteImageLoaded={onRemoteImageLoaded} />}
        renderChart={chartSource => <ThemedChart source={chartSource} dark={dark} />}
        renderMarkdown={text => <MemoizedMarkdownPreview noteId={noteId} markdown={text} documentPath={documentPath} savedDocumentPath={liveStateRef.current.savedDocumentPath} python={python} dark={dark} trustedImageHosts={trustedImageHosts} approvedImageUrls={approvedImageUrls} onTrustImageHost={onTrustImageHost} onApproveImageUrl={onApproveImageUrl} onRemoteImageLoaded={onRemoteImageLoaded} onNotice={liveStateRef.current.onNotice} />}
      />
    </CodeBlockBoundary>
  );
  if (language === "smd-chart") return protectedBlock(<ThemedChart source={source} dark={dark} />);
  if (language === "svg") return protectedBlock(<ThemedSvg source={source} dark={dark} />);
  if (language === "mermaid") return protectedBlock(<Suspense fallback={<span className="image-loading" role="status">Loading diagram…</span>}><ThemedMermaid source={source} dark={dark} /></Suspense>);
  if (language === "python" || language === "py") return protectedBlock(<PythonCell source={source} python={python} context={context} sourceStart={srcStart} sourceEnd={srcEnd} highlighted={child.props.children} />);
  const sourceText = liveStateRef.current.markdown;
  const lineBreak = srcStart !== undefined ? sourceText.indexOf("\n", srcStart) : -1;
  const fenced = lineBreak >= 0 && (srcEnd === undefined || lineBreak < srcEnd) && /^[ \t>]*(`{3,}|~{3,})/.test(sourceText.slice(srcStart, lineBreak));
  const bodyStart = fenced ? lineBreak + 1 : srcStart;
  const bodyEnd = fenced && bodyStart !== undefined ? Math.min(srcEnd ?? bodyStart + source.length, bodyStart + source.length) : srcEnd;
  return <div className="code-container" data-source-start={srcStart} data-source-end={srcEnd}><CopyCode source={source} /><details className="code-disclosure" open={source.split("\n").length <= 12}><summary>{language || "Code"} <span>{source.split("\n").length} lines</span></summary><pre data-source-start={bodyStart} data-source-end={bodyEnd}>{children}</pre></details></div>;
};

const MARKDOWN_COMPONENTS: Components = {
  p: MarkdownParagraph,
  input: MarkdownInput,
  li: MarkdownListItem,
  img: MarkdownImage,
  a: MarkdownLink,
  pre: MarkdownPre,
};

function MarkdownPreview({ noteId, markdown, documentPath, savedDocumentPath, python, dark, trustedImageHosts = EMPTY_TRUSTED_IMAGE_HOSTS, approvedImageUrls = EMPTY_APPROVED_IMAGE_URLS, onTrustImageHost, onApproveImageUrl, onRemoteImageLoaded, onChange, onNotice, renderBlock,fullDocumentAccessibility=false,sourceAnalysis }: Props) {
  useEffect(installMediaMenu,[]);
  const [linkNotice, setLinkNotice] = useState("");
  const resolvedNotePath = savedDocumentPath === undefined ? documentPath : savedDocumentPath;
  useEffect(() => { setLinkNotice(""); }, [markdown, documentPath, savedDocumentPath]);
  const reportLinkNotice = useCallback((rawMessage: string) => {
    const clean = rawMessage.replace(/^Error:\s*/, "").trim() || "Could not open linked note.";
    setLinkNotice(clean);
    onNotice?.(clean);
  }, [onNotice]);
  const clearLinkNotice = useCallback(() => { setLinkNotice(""); }, []);
  const analysis=useMemo(()=>sourceAnalysis?.source===markdown?sourceAnalysis.analysis:analyzeDocument(markdown),[markdown,sourceAnalysis]);
  const editable=Boolean(onChange);
  const tasks=editable?analysis.tasks:EMPTY_TASKS;
  const liveStateRef=useRef<MarkdownPreviewLiveState>({markdown,tasks,onChange,pythonCells:analysis.pythonCells,resolvedNotePath,savedDocumentPath,onNotice,reportLinkNotice,clearLinkNotice});
  liveStateRef.current={markdown,tasks,onChange,pythonCells:analysis.pythonCells,resolvedNotePath,savedDocumentPath,onNotice,reportLinkNotice,clearLinkNotice};
  const previewContext=useMemo<MarkdownPreviewContextValue>(
    ()=>({noteId,documentPath,python,dark,trustedImageHosts,approvedImageUrls,onTrustImageHost,onApproveImageUrl,onRemoteImageLoaded,editable,liveStateRef}),
    [noteId,documentPath,python,dark,trustedImageHosts,approvedImageUrls,onTrustImageHost,onApproveImageUrl,onRemoteImageLoaded,editable],
  );
  const resolvedSourceAnalysis=useMemo(
    ()=>sourceAnalysis?.source===markdown?sourceAnalysis:{source:markdown,analysis},
    [markdown,analysis,sourceAnalysis],
  );
  return (
    <MarkdownPreviewContext.Provider value={previewContext}>
      <article className="markdown-body" data-note-id={noteId || undefined} onCopy={event=>{if(event.currentTarget.closest('.live-document'))return;const source=selectedMarkdown(window.getSelection(),markdown);if(source!==null){event.clipboardData.setData("text/plain",source);event.preventDefault();}}} onDragStart={event=>{if(!event.currentTarget.closest('.live-document'))setSelectedMarkdownDrag(event.nativeEvent,markdown);}}>
        {linkNotice && <div role="status" className="reader-link-notice"><span>{linkNotice}</span><button type="button" aria-label="Dismiss notice" onClick={clearLinkNotice}>Dismiss</button></div>}
        {analysis.frontmatter?.properties && <DocumentProperties properties={analysis.frontmatter.properties} />}
        <CachedMarkdown
          sourceAnalysis={resolvedSourceAnalysis}
          renderBlock={renderBlock}
          windowingEnabled={!fullDocumentAccessibility}
          remarkPlugins={PREVIEW_REMARK_PLUGINS}
          rehypePlugins={PREVIEW_REHYPE_PLUGINS}
          components={MARKDOWN_COMPONENTS}
        >{markdown}</CachedMarkdown>
      </article>
    </MarkdownPreviewContext.Provider>
  );
}

const MemoizedMarkdownPreview = memo(MarkdownPreview);
export default MemoizedMarkdownPreview;
