import { useState } from "react";
import { PencilSimple } from "@phosphor-icons/react";
import MarkdownPreview from "./MarkdownPreview";

export interface SourceBlock { start: number; end: number; text: string }

export function splitMarkdownBlocks(markdown: string): SourceBlock[] {
  if (!markdown) return [{ start: 0, end: 0, text: "" }];
  const blocks: SourceBlock[] = [];
  let start = 0;
  let offset = 0;
  let fence = "";
  let callout = false;
  let math = false;
  for (const line of markdown.match(/.*(?:\n|$)/g) || []) {
    if (!line) continue;
    const trimmed = line.trim();
    const fenceStart = trimmed.match(/^(`{3,}|~{3,})/);
    if (fenceStart) {
      if (!fence) fence = fenceStart[1][0].repeat(fenceStart[1].length);
      else if (trimmed.startsWith(fence)) fence = "";
    } else if (!fence) {
      if (/^:::callout\b/.test(trimmed)) callout = true;
      else if (trimmed === ":::") callout = false;
      if (trimmed === "$$") math = !math;
    }
    offset += line.length;
    if (!trimmed && !fence && !callout && !math && offset > start) {
      blocks.push({ start, end: offset, text: markdown.slice(start, offset) });
      start = offset;
    }
  }
  if (start < markdown.length) blocks.push({ start, end: markdown.length, text: markdown.slice(start) });
  return blocks.length ? blocks : [{ start: 0, end: 0, text: "" }];
}

interface Props {
  markdown: string;
  onChange: (value: string) => void;
  documentPath: string | null;
  python: string;
  dark: boolean;
  trustedImageHosts: string[];
  onTrustImageHost: (host: string) => void;
}

export default function LiveEditor({ markdown, onChange, documentPath, python, dark, trustedImageHosts, onTrustImageHost }: Props) {
  const [editing, setEditing] = useState<{ prefix: string; text: string; suffix: string } | null>(null);
  const renderBlock = (block: SourceBlock, index: number, base = 0) => <section className="live-block" key={`${base + block.start}-${index}`}>
    <button className="live-edit-button" title="Edit this block" aria-label={`Edit block ${index + 1}`} onClick={() => setEditing({ prefix: markdown.slice(0, base + block.start), text: block.text, suffix: markdown.slice(base + block.end) })}><PencilSimple size={15} /></button>
    <MarkdownPreview markdown={block.text} documentPath={documentPath} python={python} dark={dark} trustedImageHosts={trustedImageHosts} onTrustImageHost={onTrustImageHost} />
  </section>;
  if (editing) {
    const before = splitMarkdownBlocks(editing.prefix).filter((block) => block.text.trim());
    const after = splitMarkdownBlocks(editing.suffix).filter((block) => block.text.trim());
    return <div className="live-document">
      {before.map((block, index) => renderBlock(block, index))}
      <div className="live-active-block"><textarea autoFocus spellCheck={false} value={editing.text} style={{ minHeight: Math.max(120, editing.text.split("\n").length * 27 + 32) }} onChange={(event) => {
        const text = event.target.value;
        setEditing({ ...editing, text });
        onChange(editing.prefix + text + editing.suffix);
      }} onBlur={() => setEditing(null)} aria-label="Edit Markdown block" /></div>
      {after.map((block, index) => renderBlock(block, index, editing.prefix.length + editing.text.length))}
    </div>;
  }
  return <div className="live-document">{splitMarkdownBlocks(markdown).map((block, index) => renderBlock(block, index))}</div>;
}
