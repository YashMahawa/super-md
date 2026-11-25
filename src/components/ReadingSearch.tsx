import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { setReaderOverlay } from "../readerOverlays";
import {ArrowUpIcon,ArrowDownIcon,XIcon,TextAaIcon,ArrowsClockwiseIcon} from "@phosphor-icons/react";
import {editorFindQuery,editorFindRange} from "./Editor";
import {windowedMatches,revealWindowed,type WindowedMatch} from "../windowedSearch";
import {cancelHeadingNavigation} from '../documentNavigation';
import {refreshDocumentExtent} from '../documentZoom';
const cancelSettlingHeading=()=>document.querySelectorAll('.android-reading,.reading-scroll,.live-pane').forEach(cancelHeadingNavigation);
const findReadingHost=()=>document.querySelector<HTMLElement>('.android-reading,.reading-scroll,.live-document,.markdown-body');
type HighlightRegistry = Map<string, unknown>;
type SourceRange = {from:number;to:number};
export function nextSearchIndex(index:number,direction:number,count:number):number {
  if(count<=0)return -1;
  if(index<0)return direction<0?count-1:0;
  return ((index+direction)%count+count)%count;
}
export function readingMatches(host: Element, query: string, caseSensitive=false): Range[] {
  if (!query.trim()) return [];
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  const parts: Array<{node:Text;start:number;end:number}> = [];
  let text="", node:Node|null, block:Element|null=null;
  while ((node=walker.nextNode())) {
    const parent=node.parentElement;
    if (!parent || parent.closest("button,input,textarea,svg,annotation,.katex-mathml,.chart-controls,.chart-toolbar,.chart-legend,.image-edit-tools,[data-frontmatter-properties],.document-properties")) continue;
    const nextBlock=parent.closest("p,h1,h2,h3,h4,li,pre,td,summary");
    if (block !== nextBlock) {text+="\n";block=nextBlock;}
    const value=node.textContent||"";
    parts.push({node:node as Text,start:text.length,end:text.length+value.length});text+=value;
  }
  // Case folding can expand Unicode characters and invalidate DOM offsets.
  // Literal regex matches retain the original UTF-16 positions instead.
  const pattern=new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"),caseSensitive?"gu":"giu"),ranges:Range[]=[];
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
export function replaceSourceMatches(content:string,query:string,replacement:string,caseSensitive=false,index?:number):string {
  if(!query)return content;
  const regex=new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"),caseSensitive?"gu":"giu");let ordinal=0;
  return content.replace(regex,match=>index===undefined||ordinal++===index?replacement:match);
}
export function sourceMatches(content:string,query:string,caseSensitive=false):SourceRange[] {
  if(!query)return [];
  const regex=new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"),caseSensitive?"gu":"giu");
  const matches:SourceRange[]=[];
  for(const match of content.matchAll(regex)){matches.push({from:match.index!,to:match.index!+match[0].length});if(matches.length>=5000)break;}
  return matches;
}
function sourceBounds(element:Element):{start:number;end:number}|null {
  const start=Number(element.getAttribute("data-source-start")),end=Number(element.getAttribute("data-source-end"));
  return Number.isFinite(start)&&Number.isFinite(end)&&end>=start?{start,end}:null;
}
function visibleSourceSpan(owner:HTMLElement,content:string):{start:number;end:number}|null {
  const bounds=sourceBounds(owner);if(!bounds)return null;
  let {start,end}=bounds;
  if(owner.tagName==="A"&&content[start]==="["){
    let depth=0;
    for(let i=start;i<end;i++){
      if(content[i]==="\\"){i++;continue;}
      if(content[i]==="[")depth++;
      else if(content[i]==="]"&&--depth===0)return {start:start+1,end:i};
    }
  }
  if(owner.matches("details.callout,aside.callout")){
    const marker=content.slice(start,end).match(/^(?:>[ \t]*)?\[![\w-]+\][+-]?[ \t]*/i);
    if(marker)start+=marker[0].length;
  }
  return {start,end};
}
function findContainingBlock(host:Element,from:number,to:number):HTMLElement|null {
  const candidates=host.querySelectorAll<HTMLElement>(".live-block[data-source-start],[data-windowed-block][data-source-start]");
  let best:HTMLElement|null=null,fallback:HTMLElement|null=null;
  const scan=(nodes:Iterable<HTMLElement>)=>{
    for(const node of nodes){
      const bounds=sourceBounds(node);if(!bounds)continue;
      if(bounds.start<=from&&to<=bounds.end){if(!best||bounds.end-bounds.start<sourceBounds(best)!.end-sourceBounds(best)!.start)best=node;}
      else if(bounds.start<=from&&from<bounds.end)fallback=node;
    }
  };
  scan(candidates);
  if(!best&&!fallback)scan(host.querySelectorAll<HTMLElement>("[data-source-start][data-source-end]"));
  return best||fallback;
}
function openDisclosuresFor(target:Element|null,scope?:Element|null,range?:SourceRange):boolean {
  let opened=false;
  for(let owner=target?.closest("details")||null;owner;owner=owner.parentElement?.closest("details")||null){
    if(!owner.open){owner.open=true;opened=true;}
  }
  if(scope&&range){
    for(const details of scope.querySelectorAll<HTMLDetailsElement>("details")){
      if(details.open)continue;
      const bounds=sourceBounds(details.closest("[data-source-start]")||details);
      if(!bounds||(bounds.start<=range.from&&range.from<=bounds.end)){details.open=true;opened=true;}
    }
  }
  return opened;
}
function deepestSourceOwner(root:Element,from:number,to:number):HTMLElement|null {
  let best:HTMLElement|null=sourceBounds(root)?root as HTMLElement:null;
  for(const node of root.querySelectorAll<HTMLElement>("[data-source-start][data-source-end]")){
    const bounds=sourceBounds(node);if(!bounds)continue;
    if(bounds.start<=from&&to<=bounds.end){
      if(!best||best.contains(node)||bounds.end-bounds.start<=sourceBounds(best)!.end-sourceBounds(best)!.start)best=node;
    }
  }
  return best;
}
function sameRange(a:Range,b:Range):boolean {
  return a.startContainer===b.startContainer&&a.startOffset===b.startOffset&&a.endContainer===b.endContainer&&a.endOffset===b.endOffset;
}
function directOwnerMatches(owner:HTMLElement,visible:{start:number;end:number},allSourceRanges:SourceRange[],query:string,caseSensitive:boolean):{directSource:SourceRange[];directDom:Range[]} {
  const childSpans=Array.from(owner.querySelectorAll<HTMLElement>("[data-source-start][data-source-end]")).map(sourceBounds).filter((item):item is {start:number;end:number}=>item!==null);
  const directSource=allSourceRanges.filter(item=>item.from>=visible.start&&item.to<=visible.end&&!childSpans.some(child=>child.start<=item.from&&item.to<=child.end));
  const directDom=readingMatches(owner,query,caseSensitive).filter(candidate=>{
    if(owner.matches(".code-container")&&candidate.startContainer.parentElement?.closest("summary"))return false;
    const candidateOwner=candidate.startContainer.parentElement?.closest<HTMLElement>("[data-source-start][data-source-end]");
    return !candidateOwner||candidateOwner===owner||!owner.contains(candidateOwner);
  });
  return {directSource,directDom};
}
function mapSourceRangeToDomRange(scope:HTMLElement,target:SourceRange,allSourceRanges:SourceRange[],content:string,query:string,caseSensitive:boolean):Range|null {
  const owner=deepestSourceOwner(scope,target.from,target.to);if(!owner)return null;
  const visible=visibleSourceSpan(owner,content);
  if(!visible||target.from<visible.start||target.to>visible.end)return null;
  const {directSource,directDom}=directOwnerMatches(owner,visible,allSourceRanges,query,caseSensitive);
  const ordinal=directSource.findIndex(item=>item.from===target.from&&item.to===target.to);
  return ordinal>=0?directDom[ordinal]??null:null;
}
function mapDomRangeToSourceIndex(range:Range,allSourceRanges:SourceRange[],content:string,query:string,caseSensitive:boolean):number {
  const owner=range.startContainer.parentElement?.closest<HTMLElement>("[data-source-start][data-source-end]");
  if(!owner)return -1;
  const visible=visibleSourceSpan(owner,content);if(!visible)return -1;
  const {directSource,directDom}=directOwnerMatches(owner,visible,allSourceRanges,query,caseSensitive);
  const ordinal=directDom.findIndex(candidate=>sameRange(candidate,range));
  const target=ordinal>=0?directSource[ordinal]:undefined;
  return target?allSourceRanges.findIndex(item=>item.from===target.from&&item.to===target.to):-1;
}
function revealMountedBlock(element:HTMLElement):void {
  if(element.closest('[data-windowed-mounted="false"]'))flushSync(()=>revealWindowed(element));
  else revealWindowed(element);
}
export interface ReadingSearchSeed {
  query: string;
  caseSensitive?: boolean;
  nonce: number;
}
export default function ReadingSearch({content,close,onChange,sourceSession,seed}:{content:string;close:()=>void;onChange?:(content:string)=>void;sourceSession?:string;seed?:ReadingSearchSeed|null}) {
  const [query,setQuery]=useState(()=>seed?seed.query.slice(0,200):window.getSelection()?.toString().slice(0,200)||"");
  const [matches,setMatches]=useState<Range[]>([]),[index,setIndex]=useState(-1);
  const [caseSensitive,setCaseSensitive]=useState(()=>Boolean(seed?.caseSensitive)),[replacing,setReplacing]=useState(false),[replacement,setReplacement]=useState("");
  const [sourceRanges,setSourceRanges]=useState<SourceRange[]>([]);
  const [windowed,setWindowed]=useState<WindowedMatch[]|null>(null);
  const [appliedNonce,setAppliedNonce]=useState<number|null>(seed?seed.nonce:null);
  const pendingAutoSelect=useRef(Boolean(seed&&seed.query));
  if(seed&&appliedNonce!==seed.nonce){
    setAppliedNonce(seed.nonce);
    pendingAutoSelect.current=Boolean(seed.query);
    setQuery(seed.query.slice(0,200));
    if(seed.caseSensitive!==undefined)setCaseSensitive(Boolean(seed.caseSensitive));
  }
  const canReplace=Boolean(onChange);
  const activeReplacing=canReplace&&replacing;
  const sourceSearch=!!sourceSession||activeReplacing;
  const count=sourceSearch?sourceRanges.length:windowed?.length??matches.length;
  const input=useRef<HTMLInputElement>(null), current=useRef({matches,index,sourceRanges,windowed});current.current={matches,index,sourceRanges,windowed};
  const closeRef=useRef(close);closeRef.current=close;
  const registry=typeof CSS==="undefined" ? undefined : (CSS as typeof CSS & {highlights?:HighlightRegistry}).highlights;
  const HighlightClass=(window as typeof window & {Highlight?:new(...ranges:Range[])=>unknown}).Highlight;
  useEffect(()=>{if(!canReplace&&replacing)setReplacing(false);},[canReplace,replacing]);
  const syncHighlights=(host:Element|null,activeRange?:Range|null)=>{
    if(!registry||!HighlightClass)return;
    const all=host?readingMatches(host,query,caseSensitive):[];
    registry.set("smd-search",new HighlightClass(...all));
    registry.delete("smd-search-current");
    if(activeRange)registry.set("smd-search-current",new HighlightClass(activeRange));
  };
  const activeDomRangeFor=(targetIndex:number,host:Element|null):Range|null=>{
    if(targetIndex<0||!host)return null;
    if(!sourceSession&&activeReplacing){
      const target=sourceRanges[targetIndex];if(!target)return null;
      const block=findContainingBlock(host,target.from,target.to);
      if(!block||block.closest('[data-windowed-mounted="false"]'))return null;
      return mapSourceRangeToDomRange(block,target,sourceRanges,content,query,caseSensitive);
    }
    if(windowed){
      const match=windowed[targetIndex];
      if(!match||match.element.closest('[data-windowed-mounted="false"]'))return null;
      return readingMatches(match.element,query,caseSensitive)[match.ordinal]??null;
    }
    return matches[targetIndex]??null;
  };
  const scrollTargetIntoView=(host:Element|null,range:Range|null,fallback:HTMLElement|null)=>{
    const scroller=host?.closest<HTMLElement>('.android-reading')??(host?.matches('.android-reading')?host as HTMLElement:null);
    if(scroller)refreshDocumentExtent(scroller);
    const target=range?.startContainer.parentElement??fallback;
    target?.scrollIntoView?.({block:"center",behavior:"instant"});
  };
  const selectSourceRange=(next:number,ranges:SourceRange[],host:HTMLElement|null)=>{
    const range=ranges[next];if(!range)return;
    if(sourceSession){editorFindRange(sourceSession,range.from,range.to);setIndex(next);return;}
    const block=host?findContainingBlock(host,range.from,range.to):null;
    if(block)revealMountedBlock(block);
    let domRange=block?mapSourceRangeToDomRange(block,range,ranges,content,query,caseSensitive):null;
    const opened=openDisclosuresFor(domRange?.startContainer.parentElement??block,block,range);
    if(opened&&block)domRange=mapSourceRangeToDomRange(block,range,ranges,content,query,caseSensitive);
    const frontmatterHeader=!block?host?.querySelector<HTMLElement>("[data-frontmatter-properties],.document-properties")??null:null;
    const fallback=(block?deepestSourceOwner(block,range.from,range.to):frontmatterHeader)??block;
    scrollTargetIntoView(host,domRange,fallback);
    syncHighlights(host,domRange);
    setIndex(next);
    requestAnimationFrame(()=>{
      const liveHost=findReadingHost();
      const liveBlock=liveHost?findContainingBlock(liveHost,range.from,range.to):null;
      const liveRange=liveBlock?mapSourceRangeToDomRange(liveBlock,range,ranges,content,query,caseSensitive):null;
      const liveFallback=liveBlock??liveHost?.querySelector<HTMLElement>("[data-frontmatter-properties],.document-properties")??null;
      scrollTargetIntoView(liveHost,liveRange,liveFallback);
      syncHighlights(liveHost,liveRange);
    });
  };
  const selectWindowedMatch=(next:number,win:WindowedMatch[],host:HTMLElement|null)=>{
    const match=win[next];if(!match)return;
    revealMountedBlock(match.element);
    let range=readingMatches(match.element,query,caseSensitive)[match.ordinal]??null;
    if(openDisclosuresFor(range?.startContainer.parentElement??match.element,match.element))range=readingMatches(match.element,query,caseSensitive)[match.ordinal]??null;
    scrollTargetIntoView(host,range,match.element);
    syncHighlights(host,range);
    setIndex(next);
    requestAnimationFrame(()=>requestAnimationFrame(()=>{
      const liveHost=findReadingHost();
      const liveRange=readingMatches(match.element,query,caseSensitive)[match.ordinal]??null;
      openDisclosuresFor(liveRange?.startContainer.parentElement??match.element,match.element);
      scrollTargetIntoView(liveHost,liveRange,match.element);
      syncHighlights(liveHost,liveRange);
    }));
  };
  const selectDomMatch=(next:number,list:Range[],host:HTMLElement|null)=>{
    const range=list[next];if(!range)return;
    openDisclosuresFor(range.startContainer.parentElement);
    scrollTargetIntoView(host,range,range.startContainer.parentElement);
    syncHighlights(host,range);
    setIndex(next);
  };
  const toggleReplacing=()=>{
    const nextReplacing=!activeReplacing;
    const host=findReadingHost();
    if(!sourceSession&&index>=0&&host){
      if(nextReplacing){
        let currentRange:Range|null=null;
        if(windowed){
          const item=windowed[index];
          if(item){revealMountedBlock(item.element);currentRange=readingMatches(item.element,query,caseSensitive)[item.ordinal]??null;}
        }else currentRange=matches[index]??null;
        setIndex(currentRange?mapDomRangeToSourceIndex(currentRange,sourceRanges,content,query,caseSensitive):-1);
      }else{
        const sourceTarget=sourceRanges[index];
        const block=sourceTarget?findContainingBlock(host,sourceTarget.from,sourceTarget.to):null;
        if(block&&sourceTarget){
          revealMountedBlock(block);
          const mapped=mapSourceRangeToDomRange(block,sourceTarget,sourceRanges,content,query,caseSensitive);
          if(!mapped)setIndex(-1);
          else if(windowed){
            const blockRanges=readingMatches(block,query,caseSensitive);
            const ordinal=blockRanges.findIndex(candidate=>sameRange(candidate,mapped));
            const windowedElement=block.closest<HTMLElement>("[data-windowed-block]")??block;
            setIndex(ordinal>=0?windowed.findIndex(item=>item.element===windowedElement&&item.ordinal===ordinal):-1);
          }else{
            const fresh=readingMatches(host,query,caseSensitive);
            setMatches(fresh);
            setIndex(fresh.findIndex(candidate=>sameRange(candidate,mapped)));
          }
        }else setIndex(-1);
      }
    }
    setReplacing(nextReplacing);
  };
  const move=(direction:number) => {
    // Search is a new deliberate navigation, just like pan/zoom. A briefly
    // observing heading jump must not pull the viewport back after this move.
    cancelSettlingHeading();
    const {matches,index,sourceRanges,windowed}=current.current;
    const host=findReadingHost();
    if(sourceSearch){
      if(!sourceRanges.length)return;
      selectSourceRange(nextSearchIndex(index,direction,sourceRanges.length),sourceRanges,host);
      return;
    }
    if(windowed){
      if(!windowed.length)return;
      selectWindowedMatch(nextSearchIndex(index,direction,windowed.length),windowed,host);
      return;
    }
    if(!matches.length)return;
    selectDomMatch(nextSearchIndex(index,direction,matches.length),matches,host);
  };
  useEffect(()=>{
    cancelSettlingHeading();
    setReaderOverlay("search",true);
    const focus=()=>{
      let attempts=0;
      const focusInput=()=>{
        const field=input.current;
        if(field){field.focus({preventScroll:true});field.select();}
        // Native menus/toolbars can retain host focus while React mounts this
        // overlay. Reassert focus across the mount frames so the very next key
        // reaches the search field, including when Find is opened repeatedly.
        if(document.activeElement!==field&&attempts++<4)requestAnimationFrame(focusInput);
      };
      focusInput();
    };
    focus();
    const key=(event:KeyboardEvent)=>{
      if(event.key!=="Escape")return;
      if(document.querySelector(".media-save-menu,.image-viewer,.math-repair-panel,.media-dialog,.theme-guide-dialog"))return;
      event.preventDefault();event.stopImmediatePropagation();closeRef.current();
    };
    document.addEventListener("keydown",key,true);window.addEventListener("supermd-find-focus",focus);
    return()=>{setReaderOverlay("search",false);document.removeEventListener("keydown",key,true);window.removeEventListener("supermd-find-focus",focus);};
  },[]);
  useEffect(()=>{
    const sources=sourceMatches(content,query,caseSensitive);
    setSourceRanges(sources);
    if(sourceSession)editorFindQuery(sourceSession,query,caseSensitive);
    const autoSelect=pendingAutoSelect.current;
    pendingAutoSelect.current=false;
    const frame=requestAnimationFrame(()=>{
      const host=findReadingHost();
      const win=host?windowedMatches(host,query,caseSensitive):null;
      setWindowed(win);
      const result=host?readingMatches(host,query,caseSensitive):[];
      setMatches(result);
      if(autoSelect){
        if(sourceSearch&&sources.length){selectSourceRange(0,sources,host);return;}
        if(win&&win.length){selectWindowedMatch(0,win,host);return;}
        if(result.length){selectDomMatch(0,result,host);return;}
      }
      setIndex(-1);
      if(registry&&HighlightClass){
        registry.set("smd-search",new HighlightClass(...result));
        registry.delete("smd-search-current");
      }
    });
    return()=>{cancelAnimationFrame(frame);registry?.delete("smd-search");registry?.delete("smd-search-current");if(sourceSession)editorFindQuery(sourceSession,"",false);};
  },[query,content,caseSensitive,sourceSession,seed?.nonce]);
  useEffect(()=>{
    if(!registry||!HighlightClass)return;
    const host=findReadingHost();
    syncHighlights(host,activeDomRangeFor(index,host));
  },[index,matches,windowed,activeReplacing,sourceSession]);
  useEffect(()=>{
    const host=findReadingHost();if(!host||(!windowed&&!activeReplacing)||!query)return;
    let frame=0;
    const refresh=()=>{
      if(frame)return;
      frame=requestAnimationFrame(()=>{
        frame=0;
        syncHighlights(host,activeDomRangeFor(current.current.index,host));
      });
    };
    host.addEventListener('supermd-window-change',refresh);
    return()=>{cancelAnimationFrame(frame);host.removeEventListener('supermd-window-change',refresh);};
  },[windowed,activeReplacing,query,caseSensitive,sourceRanges,content]);
  return <aside className="reading-search" data-independent-zoom role="search" aria-label="Find in note">
    <input ref={input} aria-label="Find in note" role="searchbox" type="text" inputMode="search" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="Find in this note" value={query} onChange={event=>setQuery(event.target.value)} onKeyDown={event=>{if(event.key==="Enter"){event.preventDefault();move(event.shiftKey?-1:1);}}}/>
    <output aria-live="polite" title={count>=5000?'Showing the first 5,000 matches. Narrow your search to find later results.':undefined}>{count ? `${index<0 ? 0 : index+1} / ${count}${count>=5000?'+':''}` : query ? "No matches" : ""}</output>
    <button className="search-icon" aria-label="Previous match" disabled={!count} onClick={()=>move(-1)} title="Previous match (Shift+Enter)"><ArrowUpIcon size={20} weight="bold"/></button>
    <button className="search-icon" aria-label="Next match" disabled={!count} onClick={()=>move(1)} title="Next match (Enter)"><ArrowDownIcon size={20} weight="bold"/></button>
    <button className="search-icon" aria-pressed={caseSensitive} onClick={()=>setCaseSensitive(!caseSensitive)} title="Match case" aria-label="Match case"><TextAaIcon size={20} weight="bold"/></button>
    {canReplace&&<button className="search-icon" aria-pressed={activeReplacing} onClick={toggleReplacing} title="Replace in source" aria-label="Replace in source"><ArrowsClockwiseIcon size={20} weight="bold"/></button>}
    <button className="search-icon" onClick={close} title="Close search (Esc)" aria-label="Close search"><XIcon size={20} weight="bold"/></button>
    {activeReplacing&&onChange&&<div className="search-replace"><input aria-label="Replacement text" placeholder="Replace with" value={replacement} onChange={e=>setReplacement(e.target.value)}/><button disabled={!count||index<0} onClick={()=>{if(!count||index<0)return;onChange(replaceSourceMatches(content,query,replacement,caseSensitive,index));}}>Replace</button><button disabled={!count} onClick={()=>{if(!count)return;onChange(replaceSourceMatches(content,query,replacement,caseSensitive));}}>Replace all</button><small>Replaces literal text in Markdown source.</small></div>}
  </aside>;
}
