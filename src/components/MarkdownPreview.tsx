import { Children, isValidElement, useEffect, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import { visit } from "unist-util-visit";
import InteractiveChart from "./InteractiveChart";
import MermaidDiagram from "./MermaidDiagram";
import PythonCell from "./PythonCell";

function textOf(value: ReactNode): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(textOf).join("");
  if (isValidElement<{ children?: ReactNode }>(value)) return textOf(value.props.children);
  return "";
}

function normalizeCallouts(markdown: string): string {
  const portable = markdown
    .replace(/^---\n[\s\S]*?\n---\n/, "")
    .replace(/!\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_all, path, label) => `![${label ?? path}](${path})`)
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

function remarkCallouts() {
  return (tree: unknown) => visit(tree as never, "blockquote", (node: any) => {
    const paragraph = node.children?.[0];
    const first = paragraph?.children?.[0];
    if (first?.type !== "text") return;
    const match = first.value.match(/^\[!(\w+)\][+-]?\s*(.*)$/);
    if (!match) return;
    const type = match[1].toLowerCase();
    const title = match[2] || type[0].toUpperCase() + type.slice(1);
    first.value = "";
    node.data = { hName: "aside", hProperties: { className: `callout callout-${type}`, "data-callout-title": title } };
  });
}

function AssetImage({ src = "", alt = "", documentPath }: { src?: string; alt?: string; documentPath: string | null }) {
  const [resolved, setResolved] = useState(src);
  useEffect(() => {
    if (!documentPath || /^(data:|https?:|blob:)/.test(src)) { setResolved(src); return; }
    invoke<string>("load_asset", { documentPath, source: src }).then(setResolved).catch(() => setResolved(src));
  }, [documentPath, src]);
  return <img src={resolved} alt={alt} loading="lazy" />;
}

interface Props {
  markdown: string;
  documentPath: string | null;
  python: string;
  dark: boolean;
}

export default function MarkdownPreview({ markdown, documentPath, python, dark }: Props) {
  const normalized = normalizeCallouts(markdown);
  return (
    <article className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath, remarkCallouts]}
        rehypePlugins={[rehypeKatex, rehypeHighlight]}
        components={{
          img: ({ src, alt }) => <AssetImage src={src} alt={alt} documentPath={documentPath} />,
          a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>,
          pre: ({ children }) => {
            const child = Children.only(children) as React.ReactElement<{ className?: string; children?: ReactNode }>;
            const language = child.props.className?.match(/language-([\w-]+)/)?.[1];
            const source = textOf(child.props.children).replace(/\n$/, "");
            if (language === "smd-chart") return <InteractiveChart source={source} />;
            if (language === "mermaid") return <MermaidDiagram source={source} dark={dark} />;
            if (language === "python" || language === "py") return <PythonCell source={source} python={python} />;
            return <pre>{children}</pre>;
          }
        }}
      >{normalized}</ReactMarkdown>
    </article>
  );
}
