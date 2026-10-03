import { Children, isValidElement, lazy, memo, Suspense, useEffect, useMemo, useState, type ReactNode } from "react";
import {unified} from "unified";
import remarkParse from "remark-parse";
import { invoke } from "../nativeBridge";
import CachedMarkdown from "./CachedMarkdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import { visit } from "unist-util-visit";
import InteractiveChart from "./InteractiveChart";
import PythonCell from "./PythonCell";
import SvgDiagram from "./SvgDiagram";
import { remarkObsidianMath } from "../obsidianMath";
import { headingSlug, navigateHeading, remarkHeadingIds } from "../documentNavigation";
import { selectedMarkdown } from "../copySource";
import CopyCode from "./CopyCode";
import CodeBlockBoundary from "./CodeBlockBoundary";

const MermaidDiagram = lazy(() => import("./MermaidDiagram"));
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

export function normalizeCallouts(markdown: string): string {
  const portable = markdown
    .replace(/^---\n[\s\S]*?\n---\n/, "")
    .replace(/!\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_all, path, label) => `![${label ?? path}](${encodeURI(path)})`)
    .replace(/\[\[(#[\s\S]*?)\]\]/g, (_all, value: string) => { const [target, label] = value.split("|"); return `[${label || target.slice(1)}](#${headingSlug(target.slice(1))})`; })
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_all, target, label) => `[${label ?? target}](${target.endsWith(".md") ? target : `${target}.md`})`);
  const lines = portable.split("\n");
  const output: string[] = [];
  let current: { type: string; title: string; lines: string[] } | null = null;
  for (const line of lines) {
    const start = line.match(/^:::callout\s+(\w+)(?:\s+(.+))?\s*$/i);
    if (start && !current) {
      current = { type: start[1].toUpperCase(), title: start[2]?.replace(/^['"]|['"]$/g, "") || start[1], lines: [] };
    } else if (line.trim() === ":::" && current) {
      output.push(`> [!${current.type}] ${current.title}`, ...current.lines.map((value) => `> ${value}`), "");
      current = null;
    } else if (current) current.lines.push(line);
    else output.push(line);
  }
  if (current) output.push(`> [!${current.type}] ${current.title}`, ...current.lines.map((value) => `> ${value}`));
  return output.join("\n");
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
  const [allowOnce, setAllowOnce] = useState(false);
  const [resolved, setResolved] = useState(embedded ? src : "");
  const [error, setError] = useState("");
  const [selected, setSelected] = useState(false);
  const allowed = allowOnce || trustedImageHosts.includes(host);
  useEffect(() => { setAllowOnce(false); }, [src]);
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
    invoke<string>("load_asset", { documentPath: documentPath || "", source: src })
      .then((value) => { if (active) setResolved(value); })
      .catch((reason) => { if (active) setError(String(reason)); });
    return () => { active = false; };
  }, [documentPath, embedded, isRemote, src, allowed]);
  if (isRemote && !allowed) return <span className="remote-image-card" role="group" aria-label={`Remote image from ${host}`}><span><strong>{alt || "Remote image"}</strong><small>{host} · blocked until you choose to load it</small></span><span className="remote-image-actions"><button onClick={() => setAllowOnce(true)}>Load image</button>{onTrustImageHost && <button onClick={() => onTrustImageHost(host)}>Trust domain</button>}</span></span>;
  if (error) return <span className="image-error" role="img" aria-label={alt || "Image unavailable"}>Image unavailable: {alt || src}<small>{error}</small></span>;
  if (!resolved) return <span className="image-loading" role="status">Loading image…</span>;
  return <span className={`note-image ${selected ? "is-selected" : ""}`} data-note-image-source={src} tabIndex={0} aria-label={`Image controls: ${alt || "Image"}`} onFocus={() => setSelected(true)} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setSelected(false); }} onClick={(event) => { event.stopPropagation(); setSelected(true); event.currentTarget.focus(); }} onKeyDown={(event) => { if (event.key === "Escape") { setSelected(false); event.stopPropagation(); } }}>
    <img src={resolved} alt={alt} loading="lazy" onError={() => setError("The image could not be decoded or loaded.")} />
    {selected && <span className="image-edit-tools" role="toolbar" aria-label="Selected image"><button onClick={(event) => { event.stopPropagation(); window.dispatchEvent(new CustomEvent("supermd-image-edit", { detail: { action: "replace", image: event.currentTarget.closest("[data-note-image-source]") } })); }}>Replace</button><button onClick={(event) => { event.stopPropagation(); window.dispatchEvent(new CustomEvent("supermd-image-edit", { detail: { action: "remove", image: event.currentTarget.closest("[data-note-image-source]") } })); }}>Remove</button></span>}
  </span>;
}

interface Props {
  markdown: string;
  documentPath: string | null;
  python: string;
  dark: boolean;
  trustedImageHosts?: string[];
  onTrustImageHost?: (host: string) => void;
  onChange?: (markdown:string)=>void;
}

function MarkdownPreview({ markdown, documentPath, python, dark, trustedImageHosts = [], onTrustImageHost, onChange }: Props) {
  const normalized = useMemo(()=>normalizeCallouts(markdown),[markdown]);
  const tasks=useMemo(()=>{
    if(!onChange || !/\[[ xX]\]/.test(markdown))return [];
    const prefix=markdown.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/)?.[0].length||0;
    const tree=unified().use(remarkParse).use(remarkGfm).use(remarkMath).parse(markdown.slice(prefix));
    const offsets:number[]=[];
    visit(tree,'listItem',(node:any)=>{if(typeof node.checked!=='boolean')return;const start=prefix+node.position.start.offset;const marker=markdown.slice(start,node.position.end.offset+prefix).match(/^\s*(?:[-+*]|\d+[.)])\s+\[([ xX])\]/);if(marker)offsets.push(start+marker[0].lastIndexOf('[')+1);});
    return offsets;
  },[markdown,onChange]);
  return (
    <article className="markdown-body" onCopy={event=>{if(event.currentTarget.closest('.live-document'))return;const source=selectedMarkdown(window.getSelection(),normalized);if(source!==null){event.clipboardData.setData("text/plain",source);event.preventDefault();}}}>
      <CachedMarkdown
        remarkPlugins={[remarkGfm, remarkMath, remarkObsidianMath, remarkCallouts, remarkHeadingIds, remarkTaskPositions,remarkSourcePositions]}
        rehypePlugins={[rehypeKatex, rehypeHighlight]}
        components={{
          input: ({node: _node,...props}) => <input {...props} disabled={!onChange} onChange={()=>{}} />,
          li: ({node,children}) => <li className={Array.isArray(node?.properties.className)?node.properties.className.join(' '):undefined} onChange={event=>{const index=Number(node?.properties['data-task-index']);const offset=tasks[index];if(offset===undefined || !onChange || !(event.target instanceof HTMLInputElement))return;onChange(markdown.slice(0,offset)+(event.target.checked?'x':' ')+markdown.slice(offset+1));}}>{children}</li>,
          img: ({ src, alt }) => <AssetImage src={src} alt={alt} documentPath={documentPath} trustedImageHosts={trustedImageHosts} onTrustImageHost={onTrustImageHost} />,
          a: ({ href, children }) => <a href={href} target={href?.startsWith("#") ? undefined : "_blank"} rel="noreferrer" onClick={event => { if (navigateHeading(event.currentTarget)) { event.preventDefault(); event.stopPropagation(); } else event.currentTarget.dataset.visited='true'; }}>{children}</a>,
          pre: ({ children }) => {
            const child = Children.only(children) as React.ReactElement<{ className?: string; children?: ReactNode }>;
            const language = child.props.className?.match(/language-([\w-]+)/)?.[1];
            const source = textOf(child.props.children).replace(/\n$/, "");
            const protectedBlock = (block: ReactNode) => <CodeBlockBoundary key={`${language}:${source}`} source={source}>{block}</CodeBlockBoundary>;
            if (language === "smd-chart") return protectedBlock(<InteractiveChart source={source} dark={dark} />);
            if (language === "svg") return protectedBlock(<SvgDiagram source={source} />);
            if (language === "mermaid") return protectedBlock(<Suspense fallback={<span className="image-loading" role="status">Loading diagram…</span>}><MermaidDiagram source={source} dark={dark} /></Suspense>);
            if (language === "python" || language === "py") return protectedBlock(<PythonCell source={source} python={python} highlighted={child.props.children} />);
            return <div className="code-container"><CopyCode source={source}/><details className="code-disclosure" open={source.split("\n").length <= 12}><summary>{language || "Code"} <span>{source.split("\n").length} lines</span></summary><pre>{children}</pre></details></div>;
          }
        }}
      >{normalized}</CachedMarkdown>
    </article>
  );
}

export default memo(MarkdownPreview);
