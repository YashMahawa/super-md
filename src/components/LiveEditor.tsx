import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import MarkdownPreview from "./MarkdownPreview";
import WindowedBlock from "./WindowedBlock";
import {documentOutline,headingSlug} from "../documentNavigation";
import {selectedMarkdown} from '../copySource';
import type {ClipboardEvent} from 'react';
import type {WritingOptions} from '../proofreading';
import WritingSuggestions from './WritingSuggestions';
const noTrustedHosts: string[] = [];

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
      if (math && trimmed.endsWith("$$")) math = false;
      else if (trimmed.startsWith("$$") && !trimmed.slice(2).includes("$$")) math = true;
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

interface Props extends WritingOptions {
  markdown: string;
  onChange: (value: string) => void;
  documentPath: string | null;
  python: string;
  dark: boolean;
  trustedImageHosts?: string[];
  onTrustImageHost?: (host: string) => void;
}

export default function LiveEditor({ markdown, onChange, documentPath, python, dark, trustedImageHosts = noTrustedHosts, onTrustImageHost,spellCheck=false,grammarCheck=false }: Props) {
  const [editing, setEditing] = useState<{ prefix: string; text: string; suffix: string; original: number } | null>(null);
  // Viewport top of the block being opened, so the editor appears exactly in its place.
  const anchorTop = useRef<number | null>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const open = (element: HTMLElement, prefix: string, text: string, suffix: string) => {
    anchorTop.current = element.getBoundingClientRect().top;
    setEditing({ prefix, text, suffix, original: text.length });
  };
  useLayoutEffect(() => {
    const area = editor.current;
    if (!area || anchorTop.current === null) return;
    const scroller = area.closest<HTMLElement>(".android-reading,.reading-scroll,.preview-pane,.live-scroll");
    const anchor = anchorTop.current;
    anchorTop.current = null;
    const hold = () => { const delta = area.getBoundingClientRect().top - anchor; if (scroller && Math.abs(delta) > .5) scroller.scrollTop += delta; };
    hold();
    area.focus({ preventScroll: true });
    // Neighbouring blocks may re-measure lazily for a few frames; keep the
    // editor pinned where the block was until that settles or the user scrolls.
    let frames = 0, frame = 0, stopped = false;
    const stop = () => { stopped = true; };
    const inputs = ["wheel", "touchstart", "keydown"] as const;
    inputs.forEach(name => window.addEventListener(name, stop, { capture: true, passive: true }));
    const tick = () => { if (stopped || !area.isConnected) return; hold(); if (++frames < 24) frame = requestAnimationFrame(tick); };
    frame = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(frame); inputs.forEach(name => window.removeEventListener(name, stop, { capture: true })); };
  }, [editing?.prefix]);
  const blocks = useMemo(() => splitMarkdownBlocks(markdown), [markdown]);
  const large=markdown.length>80_000;
  const headingMap=useMemo(()=>{
    const map=new Map<number,Array<{id:string;key:string}>>();if(!large)return map;
    for(const heading of documentOutline(markdown)){
      let low=0,high=blocks.length-1;while(low<high){const middle=Math.floor((low+high+1)/2);if(blocks[middle].start<=heading.offset)low=middle;else high=middle-1;}
      const start=blocks[low].start,list=map.get(start)||[];list.push({id:heading.id,key:headingSlug(heading.title)});map.set(start,list);
    }return map;
  },[large,blocks,markdown]);
  const before = useMemo(() => editing ? splitMarkdownBlocks(editing.prefix).filter((block) => block.text.trim()) : [], [editing?.prefix]);
  const after = useMemo(() => editing ? splitMarkdownBlocks(editing.suffix).filter((block) => block.text.trim()) : [], [editing?.suffix]);
  const copy=(event:ClipboardEvent)=>{if((event.target as Element).closest('textarea'))return;const source=selectedMarkdown(window.getSelection(),markdown);if(source!==null){event.clipboardData.setData('text/plain',source);event.preventDefault();}};
  useEffect(() => { if (editing && markdown !== editing.prefix + editing.text + editing.suffix) setEditing(null); }, [markdown, editing]);
  const renderBlock = (block: SourceBlock, index: number, base = 0, keyBase = base) => <WindowedBlock enabled={large} estimate={Math.min(1500,Math.max(80,block.text.length/65*30))} text={block.text.replace(/\*\*|__|`/g,'')} headings={headingMap.get(base+block.start)} className="live-block" data-source-start={base + block.start} data-source-end={base + block.end} key={`block-${keyBase + block.start}`} tabIndex={0} role="group" aria-label={`Editable block ${index + 1}`} onDoubleClick={(event) => {
    if ((event.target as Element).closest("a,button,input,select,textarea,summary,.interactive-chart,img,.note-image")) return;
    window.getSelection()?.removeAllRanges();
    open(event.currentTarget, markdown.slice(0, base + block.start), block.text, markdown.slice(base + block.end));
  }} onKeyDown={(event) => {
    if (event.target === event.currentTarget && (event.key === "Enter" || event.key === "F2")) { event.preventDefault(); open(event.currentTarget, markdown.slice(0, base + block.start), block.text, markdown.slice(base + block.end)); }
  }}>
    <MarkdownPreview markdown={block.text} onChange={text=>onChange(markdown.slice(0,base+block.start)+text+markdown.slice(base+block.end))} documentPath={documentPath} python={python} dark={dark} trustedImageHosts={trustedImageHosts} onTrustImageHost={onTrustImageHost} />
  </WindowedBlock>;
  if (editing) {
    // One flat keyed list, so blocks around the editor are kept, not remounted
    // (a remount drops their measured size and makes the page jump).
    return <div className="live-document" onCopy={copy}>{[
      ...before.map((block, index) => renderBlock(block, index)),
      <div key="active" className="live-active-block"><textarea ref={editor} data-source-start={editing.prefix.length} spellCheck={false} value={editing.text} style={{ height: Math.max(120, editing.text.split("\n").length * 27 + 32) }} onChange={(event) => {
        const text = event.target.value;
        setEditing({ ...editing, text });
        onChange(editing.prefix + text + editing.suffix);
      }} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setEditing(null); } }} onBlur={event => {if(!event.relatedTarget || !event.currentTarget.parentElement?.contains(event.relatedTarget))setEditing(null);}} aria-label="Edit Markdown block" /><WritingSuggestions text={editing.text} spellCheck={spellCheck} grammarCheck={grammarCheck} onChange={text=>{setEditing({...editing,text});onChange(editing.prefix+text+editing.suffix);}} /></div>,
      ...after.map((block, index) => renderBlock(block, index, editing.prefix.length + editing.text.length, editing.prefix.length + editing.original)),
    ]}</div>;
  }
  return <div className="live-document" onCopy={copy}>{blocks.map((block, index) => renderBlock(block, index))}</div>;
}
