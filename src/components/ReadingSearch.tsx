import { useEffect, useRef, useState } from "react";
import { setReaderOverlay } from "../readerOverlays";
type HighlightRegistry = Map<string, unknown>;
export function readingMatches(host: Element, query: string): Range[] {
  if (!query.trim()) return [];
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  const parts: Array<{node:Text;start:number;end:number}> = [];
  let text="", node:Node|null, block:Element|null=null;
  while ((node=walker.nextNode())) {
    const parent=node.parentElement;
    if (!parent || parent.closest("button,input,textarea,svg,annotation,.katex-mathml,.chart-controls,.chart-toolbar,.chart-legend,.image-edit-tools")) continue;
    const nextBlock=parent.closest("p,h1,h2,h3,h4,li,pre,td,summary");
    if (block !== nextBlock) {text+="\n";block=nextBlock;}
    const value=node.textContent||"";
    parts.push({node:node as Text,start:text.length,end:text.length+value.length});text+=value;
  }
  // Case folding can expand Unicode characters and invalidate DOM offsets.
  // Literal regex matches retain the original UTF-16 positions instead.
  const pattern=new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"),"giu"),ranges:Range[]=[];
  let match:RegExpExecArray|null, firstIndex=0,lastIndex=0;
  while((match=pattern.exec(text)) && ranges.length<5000) {
    const start=match.index,end=start+match[0].length;
    while(firstIndex<parts.length && parts[firstIndex].end<=start)firstIndex++;
    lastIndex=Math.max(lastIndex,firstIndex);
    while(lastIndex<parts.length && parts[lastIndex].end<end)lastIndex++;
    const first=parts[firstIndex],last=parts[lastIndex];
    if(!first || !last)continue;
    const range=document.createRange();range.setStart(first.node,Math.max(0,start-first.start));range.setEnd(last.node,end-last.start);ranges.push(range);
  }
  return ranges;
}
export default function ReadingSearch({content,close}:{content:string;close:()=>void}) {
  const [query,setQuery]=useState(()=>window.getSelection()?.toString().slice(0,200)||"");
  const [matches,setMatches]=useState<Range[]>([]),[index,setIndex]=useState(-1);
  const input=useRef<HTMLInputElement>(null), current=useRef({matches,index});current.current={matches,index};
  const closeRef=useRef(close);closeRef.current=close;
  const registry=typeof CSS==="undefined" ? undefined : (CSS as typeof CSS & {highlights?:HighlightRegistry}).highlights;
  const HighlightClass=(window as typeof window & {Highlight?:new(...ranges:Range[])=>unknown}).Highlight;
  const move=(direction:number) => {
    const {matches,index}=current.current;if(!matches.length)return;
    const next=(index+direction+matches.length)%matches.length, range=matches[next];
    let element=range.startContainer.parentElement;
    for(let owner=element?.closest("details");owner;owner=owner.parentElement?.closest("details")||null) owner.open=true;
    element?.scrollIntoView({block:"center",behavior:"instant"});
    setIndex(next);
  };
  useEffect(()=>{setReaderOverlay("search",true);input.current?.focus();input.current?.select();const key=(event:KeyboardEvent)=>{if(event.key==="Escape"){event.preventDefault();event.stopImmediatePropagation();closeRef.current();}};document.addEventListener("keydown",key,true);return()=>{setReaderOverlay("search",false);document.removeEventListener("keydown",key,true);};},[]);
  useEffect(()=>{
    const frame=requestAnimationFrame(()=>{const host=document.querySelector(".android-reading")||document.querySelector(".markdown-body");const result=host?readingMatches(host,query):[];setMatches(result);setIndex(-1);if(registry&&HighlightClass)registry.set("smd-search",new HighlightClass(...result));});
    return()=>{cancelAnimationFrame(frame);registry?.delete("smd-search");registry?.delete("smd-search-current");};
  },[query,content]);
  useEffect(()=>{if(registry&&HighlightClass){registry.delete("smd-search-current");if(index>=0&&matches[index])registry.set("smd-search-current",new HighlightClass(matches[index]));}},[index,matches]);
  return <aside className="reading-search" data-independent-zoom role="search" aria-label="Find in note"><input ref={input} aria-label="Find in note" type="search" placeholder="Find in this note" value={query} onChange={event=>setQuery(event.target.value)} onKeyDown={event=>{if(event.key==="Enter"){event.preventDefault();move(event.shiftKey?-1:1);}}}/><output aria-live="polite">{matches.length ? `${index<0 ? "—" : index+1} / ${matches.length}` : query ? "No matches" : ""}</output><button disabled={!matches.length} onClick={()=>move(-1)} title="Previous match (Shift+Enter)">Previous</button><button disabled={!matches.length} onClick={()=>move(1)} title="Next match (Enter)">Next</button><button onClick={close} title="Close search (Esc)" aria-label="Close search">Close · Esc</button></aside>;
}
