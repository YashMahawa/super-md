import { Children, isValidElement, lazy, memo, Suspense, useEffect, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import { visit } from "unist-util-visit";
import InteractiveChart from "./InteractiveChart";
import PythonCell from "./PythonCell";

const MermaidDiagram = lazy(() => import("./MermaidDiagram"));

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
    node.children.unshift({
      type: "paragraph",
      data: { hProperties: { className: "callout-title" } },
      children: [{ type: "text", value: title }]
    });
    node.data = { hName: "aside", hProperties: { className: `callout callout-${type}`, "data-callout-type": type } };
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
  useEffect(() => {
    let active = true;
    setError("");
    setAllowOnce(false);
    if (isRemote || embedded) { setResolved(src); return; }
    setResolved("");
    if (!documentPath) { setError("Save this document to resolve relative images."); return; }
    invoke<string>("load_asset", { documentPath, source: src })
      .then((value) => { if (active) setResolved(value); })
      .catch((reason) => { if (active) setError(String(reason)); });
    return () => { active = false; };
  }, [documentPath, embedded, isRemote, src]);
  if (isRemote && !allowOnce && !trustedImageHosts.includes(host)) return <span className="remote-image-card" role="group" aria-label={`Remote image from ${host}`}><span><strong>{alt || "Remote image"}</strong><small>{host} · blocked until you choose to load it</small></span><span className="remote-image-actions"><button onClick={() => setAllowOnce(true)}>Load image</button><button onClick={() => onTrustImageHost?.(host)}>Trust domain</button></span></span>;
  if (error) return <span className="image-error" role="img" aria-label={alt || "Image unavailable"}>Image unavailable: {alt || src}<small>{error}</small></span>;
  if (!resolved) return <span className="image-loading" role="status">Loading image…</span>;
  return <img src={resolved} alt={alt} loading="lazy" onError={() => setError("The image could not be decoded or loaded.")} />;
}

interface Props {
  markdown: string;
  documentPath: string | null;
  python: string;
  dark: boolean;
  trustedImageHosts?: string[];
  onTrustImageHost?: (host: string) => void;
}

function MarkdownPreview({ markdown, documentPath, python, dark, trustedImageHosts = [], onTrustImageHost }: Props) {
  const normalized = normalizeCallouts(markdown);
  return (
    <article className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath, remarkCallouts]}
        rehypePlugins={[rehypeKatex, rehypeHighlight]}
        components={{
          img: ({ src, alt }) => <AssetImage src={src} alt={alt} documentPath={documentPath} trustedImageHosts={trustedImageHosts} onTrustImageHost={onTrustImageHost} />,
          a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>,
          pre: ({ children }) => {
            const child = Children.only(children) as React.ReactElement<{ className?: string; children?: ReactNode }>;
            const language = child.props.className?.match(/language-([\w-]+)/)?.[1];
            const source = textOf(child.props.children).replace(/\n$/, "");
            if (language === "smd-chart") return <InteractiveChart source={source} />;
            if (language === "mermaid") return <Suspense fallback={<span className="image-loading" role="status">Loading diagram…</span>}><MermaidDiagram source={source} dark={dark} /></Suspense>;
            if (language === "python" || language === "py") return <PythonCell source={source} python={python} />;
            return <pre>{children}</pre>;
          }
        }}
      >{normalized}</ReactMarkdown>
    </article>
  );
}

export default memo(MarkdownPreview);
