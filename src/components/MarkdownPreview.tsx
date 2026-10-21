import { Children, isValidElement, lazy, memo, Suspense, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { invoke } from "../nativeBridge";
import CachedMarkdown,{type MarkdownBlockRenderer} from "./CachedMarkdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import { visit } from "unist-util-visit";
import InteractiveChart from "./InteractiveChart";
import PythonCell from "./PythonCell";
import SvgDiagram from "./SvgDiagram";
import { remarkSvgBlocks } from "../svgBlocks";
import { remarkObsidianMath } from "../obsidianMath";
import { navigateHeading, remarkHeadingIds } from "../documentNavigation";
import { selectedMarkdown } from "../copySource";
import CopyCode from "./CopyCode";
import CodeBlockBoundary from "./CodeBlockBoundary";
import {DocumentAppearance} from '../documentAppearance';
import {svgDataBackdrop} from '../svgImage';
import {adaptSvgData} from '../svgTheme';
import {analyzeDocument} from '../documentAnalysis';
import type {SourceDocumentAnalysis} from '../documentAnalysis';
import {resolveReaderRasterAsset} from '../readerAssets';
import type {ReaderAccessibilityPreference} from '../types';
export {normalizeCallouts} from '../markdownSource';

const MermaidDiagram = lazy(() => import("./MermaidDiagram"));
function ThemedChart({source,dark}:{source:string;dark:boolean}) {const theme=useContext(DocumentAppearance);return <InteractiveChart source={source} dark={theme?.dark??dark} appearance={theme?.svgAppearance} colors={theme?.colors}/>;}
function ThemedSvg({source,dark}:{source:string;dark:boolean}) {const theme=useContext(DocumentAppearance);return <SvgDiagram source={source} dark={theme?.dark??dark} appearance={theme?.svgAppearance} ink={theme?.svgAppearance==='auto'?theme.ink:theme?.text} colors={theme?.colors}/>;}
function ThemedMermaid({source,dark}:{source:string;dark:boolean}) {const theme=useContext(DocumentAppearance);return <MermaidDiagram source={source} dark={theme?.dark??dark} appearance={theme?.svgAppearance} colors={theme?.colors}/>;}
const EMPTY_TRUSTED_IMAGE_HOSTS: string[] = [];
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
    const match = first.value.match(/^\[!([\w-]+)\]([+-]?)[ \t]*([^\n]*)/i);
    if (!match) return;
    const type = match[1].toLowerCase();
    const title = match[3].trim() || type[0].toUpperCase() + type.slice(1);
    first.value = first.value.slice(match[0].length).replace(/^\n/, "");
    if (!first.value) paragraph.children.shift();
    if (paragraph.children.length === 0) node.children.shift();
    const collapsible = Boolean(match[2]) || type === "answer" || type === "solution";
    node.children.unshift({
      type: "paragraph",
      data: { hName: collapsible ? "summary" : "p", hProperties: { className: "callout-title" } },
      children: [{ type: "text", value: title }]
    });
    node.data = { hName: collapsible ? "details" : "aside", hProperties: { ...(collapsible ? {open:match[2] === "+"} : {}), className: `callout callout-${type}`, "data-callout-type": type } };
  });
}

function AssetImage({ src = "", alt = "", documentPath, trustedImageHosts, onTrustImageHost }: { src?: string; alt?: string; documentPath: string | null; trustedImageHosts: string[]; onTrustImageHost?: (host: string) => void }) {
  const isRemote = /^https?:\/\//i.test(src);
  const embedded = /^(data:|blob:)/i.test(src);
  let host = "";
  if (isRemote) {
    try { host = new URL(src).host; }
    catch { host = "invalid address"; }
  }
  const [allowedOnceSource, setAllowedOnceSource] = useState<string | null>(null);
  const [resolved, setResolved] = useState(embedded ? src : "");
  const [error, setError] = useState("");
  const [selected, setSelected] = useState(false);
  const svgBacking=useMemo(()=>svgDataBackdrop(resolved),[resolved]);
  const appearance=useContext(DocumentAppearance);
  const adaptsSvg=appearance?.svgAppearance==='auto'||appearance?.svgAppearance==='monochrome';
  const adaptedSource=useMemo(()=>adaptsSvg&&svgBacking?adaptSvgData(resolved,appearance?.colors??{},appearance?.dark??false,appearance?.svgAppearance==='monochrome'):resolved,[resolved,svgBacking,appearance,adaptsSvg]);
  // A one-time approval belongs to the exact URL the user approved. Keeping
  // that scope in state avoids a passive-effect reset window when `src` changes.
  const allowed = allowedOnceSource === src || trustedImageHosts.includes(host);
  useEffect(() => {
    let active = true;
    setError("");
    if (embedded) { setResolved(src); return; }
    setResolved("");
    if (isRemote) {
      if (!allowed) return;
      // Explicit consent routes through the bounded native fetcher, not a raw
      // remote request from a local WebEngine page. This also works offline after insertion.
      invoke<{body:string}>("fetch_resource",{url:src,image:true})
        .then(value=>{if(active) setResolved(value.body);})
        .catch(reason=>{if(active) setError(String(reason));});
      return ()=>{active=false;};
    }
    if (!documentPath && !/^assets\/import-[\w-]+\./.test(src)) { setError("Save this document to resolve relative images."); return; }
    (async () => {
      try {
        const streamed = documentPath ? await resolveReaderRasterAsset(documentPath, src) : null;
        if (!active) return;
        if (streamed) { setResolved(streamed); return; }
        const value = await invoke<string>("load_asset", { documentPath: documentPath || "", source: src });
        if (active) setResolved(value);
      } catch (reason) {
        if (active) setError(String(reason));
      }
    })();
    return () => { active = false; };
  }, [documentPath, embedded, isRemote, src, allowed]);
  if (isRemote && !allowed) return <span className="remote-image-card" role="group" aria-label={`Remote image from ${host}`}><span><strong>{alt || "Remote image"}</strong><small>{host} · blocked until you choose to load it</small></span><span className="remote-image-actions"><button onClick={() => setAllowedOnceSource(src)}>Load image</button>{onTrustImageHost && <button onClick={() => onTrustImageHost(host)}>Trust domain</button>}</span></span>;
  if (error) return <span className="image-error" role="img" aria-label={alt || "Image unavailable"}>Image unavailable: {alt || src}<small>{error}</small></span>;
  if (!resolved) return <span className="image-loading" role="status">Loading image…</span>;
  return <span className={`note-image ${selected ? "is-selected" : ""}`} data-note-image-source={src} tabIndex={0} aria-label={`Image controls: ${alt || "Image"}`} onFocus={() => setSelected(true)} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setSelected(false); }} onClick={(event) => { event.stopPropagation(); setSelected(true); event.currentTarget.focus(); }} onKeyDown={(event) => { if (event.key === "Escape") { setSelected(false); event.stopPropagation(); } }}>
    <img draggable={false} data-media-adapted={adaptsSvg&&svgBacking?'true':undefined} data-media-kind={resolved.startsWith('data:image/svg+xml')?'svg':'image'} data-light-ink={svgBacking==='#222026'?'true':undefined} style={svgBacking?{'--svg-contrast-backing':svgBacking} as React.CSSProperties:undefined} src={adaptedSource} alt={alt} loading="lazy" decoding="async" onError={() => setError("The image could not be decoded or loaded.")} />
    {selected && <span className="image-edit-tools" role="toolbar" aria-label="Selected image"><button onClick={(event) => { event.stopPropagation(); window.dispatchEvent(new CustomEvent("supermd-image-edit", { detail: { action: "replace", image: event.currentTarget.closest("[data-note-image-source]") } })); }}>Replace</button><button onClick={(event) => { event.stopPropagation(); window.dispatchEvent(new CustomEvent("supermd-image-edit", { detail: { action: "remove", image: event.currentTarget.closest("[data-note-image-source]") } })); }}>Remove</button></span>}
  </span>;
}

interface Props extends ReaderAccessibilityPreference {
  markdown: string;
  documentPath: string | null;
  python: string;
  dark: boolean;
  trustedImageHosts?: string[];
  onTrustImageHost?: (host: string) => void;
  onChange?: (markdown:string)=>void;
  renderBlock?:MarkdownBlockRenderer;
  sourceAnalysis?:SourceDocumentAnalysis;
}

function MarkdownPreview({ markdown, documentPath, python, dark, trustedImageHosts = EMPTY_TRUSTED_IMAGE_HOSTS, onTrustImageHost, onChange,renderBlock,fullDocumentAccessibility=false,sourceAnalysis }: Props) {
  const analysis=useMemo(()=>sourceAnalysis?.source===markdown?sourceAnalysis.analysis:analyzeDocument(markdown),[markdown,sourceAnalysis]);
  const tasks=onChange?analysis.tasks:[];
  const renderImage = useCallback(({src,alt}:{src?:string;alt?:string})=><AssetImage src={src} alt={alt} documentPath={documentPath} trustedImageHosts={trustedImageHosts} onTrustImageHost={onTrustImageHost}/>,[documentPath,trustedImageHosts,onTrustImageHost]);
  return (
    <article className="markdown-body" onCopy={event=>{if(event.currentTarget.closest('.live-document'))return;const source=selectedMarkdown(window.getSelection(),markdown);if(source!==null){event.clipboardData.setData("text/plain",source);event.preventDefault();}}}>
      <CachedMarkdown
        sourceAnalysis={{source:markdown,analysis}}
        renderBlock={renderBlock}
        windowingEnabled={!fullDocumentAccessibility}
        remarkPlugins={[remarkGfm, remarkMath, remarkObsidianMath, remarkSvgBlocks, remarkCallouts, remarkHeadingIds, remarkTaskPositions,remarkSourcePositions]}
        rehypePlugins={[rehypeKatex, rehypeHighlight]}
        components={{
          input: ({node: _node,...props}) => <input {...props} disabled={!onChange} onChange={()=>{}} />,
          li: ({node,children,...props}) => <li {...props} className={Array.isArray(node?.properties.className)?node.properties.className.join(' '):undefined} onChange={event=>{const index=Number(node?.properties['data-task-index']);const offset=tasks[index];if(offset===undefined || !onChange || !(event.target instanceof HTMLInputElement))return;onChange(markdown.slice(0,offset)+(event.target.checked?'x':' ')+markdown.slice(offset+1));}}>{children}</li>,
          img: renderImage,
          a: ({node:_node,href,children,...props}) => <a {...props} href={href} target={href?.startsWith("#") ? undefined : "_blank"} rel="noreferrer" onClick={event => { if (navigateHeading(event.currentTarget)) { event.preventDefault(); event.stopPropagation(); } else event.currentTarget.dataset.visited='true'; }}>{children}</a>,
          pre: ({ node, children }) => {
            const child = Children.only(children) as React.ReactElement<{ className?: string; children?: ReactNode }>;
            const language = child.props.className?.match(/language-([\w-]+)/)?.[1];
            const source = textOf(child.props.children).replace(/\n$/, "");
            const nodeData=node as {position?:{start?:{offset?:number}};properties?:Record<string,unknown>}|undefined;
            const offset=Number(nodeData?.properties?.['data-source-start']??nodeData?.position?.start?.offset);
            const pythonCell=['python','py'].includes(language||'')?analysis.pythonCells.find(cell=>cell.source===source&&cell.offset===offset):undefined;
            const context=documentPath&&pythonCell?{document:documentPath,cell:String(pythonCell.ordinal),interpreter:python||'embedded'}:undefined;
            const protectedBlock = (block: ReactNode) => <CodeBlockBoundary key={`${language}:${source}`} source={source}>{block}</CodeBlockBoundary>;
            if (language === "smd-chart") return protectedBlock(<ThemedChart source={source} dark={dark} />);
            if (language === "svg") return protectedBlock(<ThemedSvg source={source} dark={dark} />);
            if (language === "mermaid") return protectedBlock(<Suspense fallback={<span className="image-loading" role="status">Loading diagram…</span>}><ThemedMermaid source={source} dark={dark} /></Suspense>);
            if (language === "python" || language === "py") return protectedBlock(<PythonCell source={source} python={python} context={context} highlighted={child.props.children} />);
            return <div className="code-container"><CopyCode source={source}/><details className="code-disclosure" open={source.split("\n").length <= 12}><summary>{language || "Code"} <span>{source.split("\n").length} lines</span></summary><pre>{children}</pre></details></div>;
          }
        }}
      >{markdown}</CachedMarkdown>
    </article>
  );
}

export default memo(MarkdownPreview);
