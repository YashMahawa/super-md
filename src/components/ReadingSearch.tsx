import { useEffect, useRef, useState } from "react";
import { setReaderOverlay } from "../readerOverlays";
import {ArrowUp,ArrowDown,X,TextAa,Textbox,Asterisk,ArrowsClockwise} from "@phosphor-icons/react";
import {editorFindQuery,editorFindRange} from "./Editor";
import {windowedMatches,revealWindowed,compileSearchPattern,nextSearchMatch,normalizeSearchOptions,type WindowedMatch,type SearchMatchConfig,type SearchMatchOptions} from "../windowedSearch";
import {cancelHeadingNavigation} from '../documentNavigation';
export type {SearchMatchConfig,SearchMatchOptions} from "../windowedSearch";
const cancelSettlingHeading=()=>document.querySelectorAll('.android-reading,.reading-scroll,.live-pane').forEach(cancelHeadingNavigation);
type HighlightRegistry = Map<string, unknown>;
type SourceRange = {from:number;to:number};

function expandRegexReplacement(replacement:string,match:RegExpExecArray,source:string):string {
  return replacement.replace(/\$(?:\$|&|`|'|(\d{1,2})|<([^>]+)>)/g,(token,digits?:string,groupName?:string)=>{
    if(token==="$$")return "$";
    if(token==="$&")return match[0];
    if(token==="$`")return source.slice(0,match.index);
    if(token==="$'")return source.slice(match.index+match[0].length);
    if(digits!==undefined){
      const two=Number(digits);
      if(digits.length===2&&two>0&&two<match.length)return match[two]??"";
      const one=Number(digits[0]);
      if(one>0&&one<match.length)return (match[one]??"")+digits.slice(1);
      return token;
    }
    if(groupName!==undefined&&match.groups){
      return Object.prototype.hasOwnProperty.call(match.groups,groupName)?(match.groups[groupName]??""):"";
    }
    return token;
  });
}

function markdownBracketEnd(raw:string,openIndex=0):number {
  if(raw[openIndex]!=="[")return raw.length;
  let depth=0;
  for(let i=openIndex;i<raw.length;i++){
    const ch=raw[i];
    if(ch==="\\"){i++;continue;}
    if(ch==="`"){
      let ticks=1;while(raw[i+ticks]==="`")ticks++;
      const close=raw.indexOf("`".repeat(ticks),i+ticks);
      if(close>=0){i=close+ticks-1;continue;}
    }
    if(ch==="[")depth++;
    else if(ch==="]"){depth--;if(depth===0)return i;}
  }
  return raw.length;
}

function markdownLinkTailEnd(raw:string,afterBracket:number):number {
  if(raw[afterBracket]==="("){
    let depth=0;
    for(let i=afterBracket;i<raw.length;i++){
      const ch=raw[i];
      if(ch==="\\"){i++;continue;}
      if(ch==="(")depth++;
      else if(ch===")"){depth--;if(depth===0)return i+1;}
    }
    return raw.length;
  }
  if(raw[afterBracket]==="["){
    const end=markdownBracketEnd(raw,afterBracket);
    return end<raw.length?end+1:raw.length;
  }
  return afterBracket;
}

function hiddenSpansInSlice(raw:string,offset:number):SourceRange[] {
  const hidden:SourceRange[]=[];
  for(let i=0;i<raw.length;i++){
    const ch=raw[i];
    if(ch==="\\"){i++;continue;}
    if(ch==="`"){
      let ticks=1;while(raw[i+ticks]==="`")ticks++;
      const close=raw.indexOf("`".repeat(ticks),i+ticks);
      if(close>=0){i=close+ticks-1;continue;}
    }
    if(ch==="!"&&raw[i+1]==="["){
      const close=markdownBracketEnd(raw,i+1);
      if(close<raw.length){
        const end=markdownLinkTailEnd(raw,close+1);
        hidden.push({from:offset+i,to:offset+end});
        i=Math.max(i,end-1);
        continue;
      }
    }
    if(ch==="["){
      const close=markdownBracketEnd(raw,i);
      if(close<raw.length){
        const end=markdownLinkTailEnd(raw,close+1);
        if(end>close+1){
          hidden.push({from:offset+close,to:offset+end});
          i=Math.max(i,end-1);
        }
      }
    }
  }
  return hidden;
}

function isHiddenMarkdownRange(content:string,span:HTMLElement,range:SourceRange):boolean {
  const link=span.closest<HTMLElement>("a[data-source-start]");
  if(link){
    const start=Number(link.dataset.sourceStart),end=Number(link.dataset.sourceEnd);
    if(Number.isFinite(start)&&Number.isFinite(end)){
      const raw=content.slice(start,end);
      if(raw.startsWith("[")){
        const labelClose=start+markdownBracketEnd(raw,0);
        if(range.from>=labelClose||range.to>labelClose+1)return true;
      }
    }
  }
  const start=Number(span.dataset.sourceStart),end=Number(span.dataset.sourceEnd);
  if(Number.isFinite(start)&&Number.isFinite(end)&&end>=start&&end-start<=200_000){
    const hidden=hiddenSpansInSlice(content.slice(start,end),start);
    if(hidden.some(h=>range.from>=h.from&&range.to<=h.to))return true;
  }
  return false;
}

function resolveTightestSourceSpan(host:Element,range:SourceRange):HTMLElement|null {
  const elements=host.querySelectorAll<HTMLElement>("[data-source-start]");
  let enclosing:HTMLElement|null=null,enclosingLen=Infinity;
  let overlapping:HTMLElement|null=null,overlappingLen=Infinity;
  let preceding:HTMLElement|null=null,followingStart=Infinity;
  for(const el of elements){
    if(el.tagName==="TEXTAREA")continue;
    const start=Number(el.dataset.sourceStart),end=Number(el.dataset.sourceEnd);
    if(!Number.isFinite(start)||!Number.isFinite(end))continue;
    const len=end-start;
    if(start<=range.from&&range.to<=end&&len<=enclosingLen){enclosing=el;enclosingLen=len;}
    else if(start<=range.from&&range.from<end&&len<=overlappingLen){overlapping=el;overlappingLen=len;}
    if(end<=range.from)preceding=el;
    else if(start>=range.to&&start<followingStart)followingStart=start;
  }
  if(enclosing||overlapping)return enclosing||overlapping;
  if(preceding){
    const next=preceding.nextElementSibling;
    if(next instanceof HTMLElement&&next.classList.contains("code-container")&&range.to<=followingStart)return next;
  }else{
    const body=host.matches(".markdown-body")?host:host.querySelector(".markdown-body");
    const first=body?.firstElementChild;
    if(first instanceof HTMLElement&&first.classList.contains("code-container")&&range.to<=followingStart)return first;
  }
  return null;
}

export function resolveSourceBlock(host:Element,range:SourceRange):HTMLElement|null {
  const span=resolveTightestSourceSpan(host,range);
  if(span)return span;
  const elements=host.querySelectorAll<HTMLElement>("[data-source-start]");
  let fallback:HTMLElement|null=null;
  for(const el of elements){
    if(el.tagName==="TEXTAREA")continue;
    const start=Number(el.dataset.sourceStart);
    if(Number.isFinite(start)&&start<=range.from)fallback=el;
  }
  return fallback;
}

function openDetailsAncestors(element:Element|null):void {
  for(let owner=element?.closest("details");owner;owner=owner.parentElement?.closest("details")||null)owner.open=true;
  if(element?.classList.contains("code-container")){
    const disclosure=element.querySelector<HTMLDetailsElement>("details.code-disclosure");
    if(disclosure)disclosure.open=true;
  }
}

function sameDomRange(a:Range,b:Range):boolean {
  return a.startContainer===b.startContainer&&a.startOffset===b.startOffset&&a.endContainer===b.endContainer&&a.endOffset===b.endOffset;
}

export function resolveSourceHighlightRange(host:Element,content:string,ranges:SourceRange[],activeIndex:number,query:string,options:SearchMatchConfig=false):Range|null {
  const target=ranges[activeIndex];
  if(!target)return null;
  const span=resolveTightestSourceSpan(host,target);
  if(!span||span.closest('[data-windowed-mounted="false"]'))return null;
  if(isHiddenMarkdownRange(content,span,target))return null;
  const domRanges=readingMatches(span,query,options);
  if(!domRanges.length)return null;
  const ownedDomRanges=domRanges.filter(r=>{
    const common=r.commonAncestorContainer.nodeType===Node.ELEMENT_NODE?r.commonAncestorContainer as Element:r.commonAncestorContainer.parentElement;
    const owner=common?.closest("[data-source-start]");
    return !owner||owner===span||!span.contains(owner);
  });
  if(!ownedDomRanges.length)return null;
  let ordinal=0;
  for(let i=0;i<activeIndex;i++){
    const candidate=ranges[i];
    if(resolveTightestSourceSpan(host,candidate)===span&&!isHiddenMarkdownRange(content,span,candidate))ordinal++;
  }
  return ownedDomRanges[ordinal]??null;
}

export function readingMatches(host: Element, query: string, options:SearchMatchConfig=false): Range[] {
  const {pattern}=compileSearchPattern(query,options,false);
  if(!pattern)return [];
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  const parts: Array<{node:Text;start:number;end:number}> = [];
  let text="", node:Node|null, block:Element|null=null;
  while ((node=walker.nextNode())) {
    const parent=node.parentElement;
    if (!parent || parent.closest("button,input,textarea,svg,annotation,.katex-mathml,.chart-controls,.chart-toolbar,.chart-legend,.image-edit-tools,.image-loading,.image-error,.remote-image-card")) continue;
    const nextBlock=parent.closest("p,h1,h2,h3,h4,li,pre,td,summary");
    if (block !== nextBlock) {text+="\n";block=nextBlock;}
    const value=node.textContent||"";
    parts.push({node:node as Text,start:text.length,end:text.length+value.length});text+=value;
  }
  // Case folding can expand Unicode characters and invalidate DOM offsets.
  // Regex matches retain the original UTF-16 positions instead.
  const ranges:Range[]=[];
  let match:RegExpExecArray|null, firstIndex=0,lastIndex=0;
  while((match=nextSearchMatch(pattern,text)) && ranges.length<5000) {
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
export function replaceSourceMatches(content:string,query:string,replacement:string,options:SearchMatchConfig=false,index?:number):string {
  const {regexp}=normalizeSearchOptions(options);
  const {pattern}=compileSearchPattern(query,options,true);
  if(!pattern)return content;
  let result="",cursor=0,ordinal=0,match:RegExpExecArray|null;
  while((match=nextSearchMatch(pattern,content))){
    const shouldReplace=index===undefined||ordinal===index;
    const insert=shouldReplace?(regexp?expandRegexReplacement(replacement,match,content):replacement):match[0];
    result+=content.slice(cursor,match.index)+insert;
    cursor=match.index+match[0].length;
    ordinal++;
    if(index!==undefined&&ordinal>index)break;
  }
  return ordinal===0?content:result+content.slice(cursor);
}
export function sourceMatches(content:string,query:string,options:SearchMatchConfig=false):Array<{from:number;to:number}> {
  const {pattern}=compileSearchPattern(query,options,true);
  if(!pattern)return [];
  const matches:Array<{from:number;to:number}>=[];
  let match:RegExpExecArray|null;
  while((match=nextSearchMatch(pattern,content))&&matches.length<5000){
    matches.push({from:match.index,to:match.index+match[0].length});
  }
  return matches;
}
export default function ReadingSearch({content,close,onChange,sourceSession,initialReplace=false}:{content:string;close:()=>void;onChange?:(content:string)=>void;sourceSession?:string;initialReplace?:boolean}) {
  const [query,setQuery]=useState(()=>window.getSelection()?.toString().slice(0,200)||"");
  const [matches,setMatches]=useState<Range[]>([]),[index,setIndex]=useState(-1);
  const indexRef=useRef(index);indexRef.current=index;
  const updateIndex=(next:number)=>{indexRef.current=next;setIndex(next);};
  const [caseSensitive,setCaseSensitive]=useState(false),[wholeWord,setWholeWord]=useState(false),[regexp,setRegexp]=useState(false);
  const [replacing,setReplacing]=useState(Boolean(initialReplace&&onChange)),[replacement,setReplacement]=useState("");
  const [sourceRanges,setSourceRanges]=useState<Array<{from:number;to:number}>>([]);
  const [windowed,setWindowed]=useState<WindowedMatch[]|null>(null);
  const filterOptions:SearchMatchOptions={caseSensitive,wholeWord,regexp};
  const {error:regexError}=compileSearchPattern(query,filterOptions,true);
  const sourceSearch=!!sourceSession||replacing;
  const count=regexError?0:sourceSearch?sourceRanges.length:windowed?.length??matches.length;
  const input=useRef<HTMLInputElement>(null);
  const closeRef=useRef(close);closeRef.current=close;
  const pendingReplaceIndex=useRef<number|null>(null);
  const prevCriteria=useRef({query,caseSensitive,wholeWord,regexp});
  const registry=typeof CSS==="undefined" ? undefined : (CSS as typeof CSS & {highlights?:HighlightRegistry}).highlights;
  const HighlightClass=(window as typeof window & {Highlight?:new(...ranges:Range[])=>unknown}).Highlight;

  const revealAndHighlightSource=(targetIndex:number,ranges:SourceRange[],sourceText:string,scroll:boolean)=>{
    const range=ranges[targetIndex];
    if(!range)return;
    if(scroll&&sourceSession)editorFindRange(sourceSession,range.from,range.to);
    const host=document.querySelector(".android-reading")||document.querySelector(".markdown-body");
    if(!host)return;
    const block=resolveSourceBlock(host,range);
    const wasUnmounted=!!block?.closest('[data-windowed-mounted="false"]');
    if(block&&scroll){
      revealWindowed(block);
      openDetailsAncestors(block);
      block.scrollIntoView({block:"center",behavior:"instant"});
    }
    const applyHighlight=()=>{
      if(registry&&HighlightClass){
        if(wasUnmounted)registry.set("smd-search",new HighlightClass(...readingMatches(host,query,filterOptions)));
        registry.delete("smd-search-current");
        const domRange=resolveSourceHighlightRange(host,sourceText,ranges,targetIndex,query,filterOptions);
        if(domRange){
          if(scroll){
            openDetailsAncestors(domRange.startContainer.parentElement);
            domRange.startContainer.parentElement?.scrollIntoView({block:"center",behavior:"instant"});
          }
          registry.set("smd-search-current",new HighlightClass(domRange));
        }else if(scroll){
          const refined=resolveSourceBlock(host,range);
          if(refined){openDetailsAncestors(refined);refined.scrollIntoView({block:"center",behavior:"instant"});}
        }
      }else if(scroll){
        const domRange=resolveSourceHighlightRange(host,sourceText,ranges,targetIndex,query,filterOptions);
        if(domRange){
          openDetailsAncestors(domRange.startContainer.parentElement);
          domRange.startContainer.parentElement?.scrollIntoView({block:"center",behavior:"instant"});
        }
      }
    };
    if(wasUnmounted)requestAnimationFrame(()=>requestAnimationFrame(applyHighlight));
    else applyHighlight();
  };

  const toggleReplacing=(nextReplacing:boolean)=>{
    if(nextReplacing===replacing||!onChange)return;
    let nextIndex=index;
    if(!sourceSession&&index>=0){
      const host=document.querySelector(".android-reading")||document.querySelector(".markdown-body");
      if(nextReplacing){
        if(!sourceRanges.length)nextIndex=-1;
        else if(windowed&&host){
          const active=windowed[index];
          if(active){
            const start=Number(active.element.dataset.sourceStart),end=Number(active.element.dataset.sourceEnd);
            let seen=0,mapped=-1;
            for(let i=0;i<sourceRanges.length;i++){
              const sr=sourceRanges[i];
              if(sr.from>=start&&sr.to<=end&&!isHiddenMarkdownRange(content,active.element,sr)){
                if(seen===active.ordinal){mapped=i;break;}
                seen++;
              }
            }
            nextIndex=mapped>=0?mapped:Math.min(index,sourceRanges.length-1);
          }else nextIndex=Math.min(index,sourceRanges.length-1);
        }else if(host&&matches[index]){
          const targetDom=matches[index];
          let mapped=-1;
          for(let i=0;i<sourceRanges.length;i++){
            const resolved=resolveSourceHighlightRange(host,content,sourceRanges,i,query,filterOptions);
            if(resolved&&sameDomRange(resolved,targetDom)){mapped=i;break;}
          }
          nextIndex=mapped>=0?mapped:Math.min(index,sourceRanges.length-1);
        }else nextIndex=Math.min(index,sourceRanges.length-1);
      }else{
        const sr=sourceRanges[index];
        if(windowed){
          if(!windowed.length||!sr)nextIndex=-1;
          else{
            let mapped=-1;
            for(let i=0;i<windowed.length;i++){
              const w=windowed[i],start=Number(w.element.dataset.sourceStart),end=Number(w.element.dataset.sourceEnd);
              if(sr.from>=start&&sr.from<=end){mapped=i;break;}
            }
            nextIndex=mapped>=0?mapped:Math.min(index,windowed.length-1);
          }
        }else{
          if(!matches.length||!sr||!host)nextIndex=-1;
          else{
            const resolved=resolveSourceHighlightRange(host,content,sourceRanges,index,query,filterOptions);
            const mapped=resolved?matches.findIndex(m=>sameDomRange(m,resolved)):-1;
            nextIndex=mapped>=0?mapped:Math.min(index,matches.length-1);
          }
        }
      }
    }
    setReplacing(nextReplacing);
    if(nextIndex!==index)updateIndex(nextIndex);
  };
  const toggleReplacingRef=useRef(toggleReplacing);toggleReplacingRef.current=toggleReplacing;

  const move=(direction:number) => {
    // Search is a new deliberate navigation, just like pan/zoom. A briefly
    // observing heading jump must not pull the viewport back after this move.
    cancelSettlingHeading();
    if(regexError)return;
    const current=indexRef.current;
    if(sourceSearch){
      if(!sourceRanges.length)return;
      const next=(current<0?(direction<0?sourceRanges.length-1:0):(current+direction+sourceRanges.length)%sourceRanges.length);
      updateIndex(next);
      revealAndHighlightSource(next,sourceRanges,content,true);
      return;
    }
    if(windowed){
      if(!windowed.length)return;
      const next=(current<0?(direction<0?windowed.length-1:0):(current+direction+windowed.length)%windowed.length),match=windowed[next];
      revealWindowed(match.element);
      openDetailsAncestors(match.element);
      match.element.scrollIntoView({block:'center',behavior:'instant'});
      updateIndex(next);
      requestAnimationFrame(()=>requestAnimationFrame(()=>{
        const ranges=readingMatches(match.element,query,filterOptions),range=ranges[match.ordinal];
        if(registry&&HighlightClass){
          const host=document.querySelector(".android-reading")||match.element;
          registry.set('smd-search',new HighlightClass(...readingMatches(host,query,filterOptions)));
          registry.delete('smd-search-current');
          if(range)registry.set('smd-search-current',new HighlightClass(range));
        }
        if(range){openDetailsAncestors(range.startContainer.parentElement);range.startContainer.parentElement?.scrollIntoView({block:'center',behavior:'instant'});}
      }));
      return;
    }
    if(!matches.length)return;
    const next=(current<0?(direction<0?matches.length-1:0):(current+direction+matches.length)%matches.length), range=matches[next];
    const element=range.startContainer.parentElement;
    openDetailsAncestors(element);
    element?.scrollIntoView({block:"center",behavior:"instant"});
    updateIndex(next);
  };
  const moveRef=useRef(move);moveRef.current=move;

  const handleSingleReplace=()=>{
    if(!onChange||!query||regexError||!sourceRanges.length)return;
    if(index<0){move(1);return;}
    const target=sourceRanges[index];
    if(!target)return;
    const nextContent=replaceSourceMatches(content,query,replacement,filterOptions,index);
    const replacedEnd=target.to+(nextContent.length-content.length);
    const nextRanges=sourceMatches(nextContent,query,filterOptions);
    const nextIndex=!nextRanges.length?-1:(()=>{const found=nextRanges.findIndex(r=>r.from>=replacedEnd);return found>=0?found:0;})();
    if(nextContent===content){
      updateIndex(nextIndex);
      if(nextIndex>=0)revealAndHighlightSource(nextIndex,nextRanges,nextContent,true);
      return;
    }
    pendingReplaceIndex.current=nextIndex;
    onChange(nextContent);
  };

  const handleReplaceAll=()=>{
    if(!onChange||!query||regexError||!sourceRanges.length)return;
    const nextContent=replaceSourceMatches(content,query,replacement,filterOptions);
    if(nextContent===content){updateIndex(-1);return;}
    pendingReplaceIndex.current=-1;
    onChange(nextContent);
  };

  useEffect(()=>{
    cancelSettlingHeading();
    setReaderOverlay("search",true);
    const focus=(event?:Event)=>{
      const detail=(event as CustomEvent<{replace?:boolean}>|undefined)?.detail;
      if(detail?.replace)toggleReplacingRef.current(true);
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
    const step=(event:Event)=>{
      const direction=(event as CustomEvent<number>).detail;
      moveRef.current(direction<0?-1:1);
    };
    focus();
    const key=(event:KeyboardEvent)=>{if(event.key==="Escape"){event.preventDefault();event.stopImmediatePropagation();closeRef.current();}};
    document.addEventListener("keydown",key,true);
    window.addEventListener("supermd-find-focus",focus);
    window.addEventListener("supermd-find-step",step);
    return()=>{setReaderOverlay("search",false);document.removeEventListener("keydown",key,true);window.removeEventListener("supermd-find-focus",focus);window.removeEventListener("supermd-find-step",step);};
  },[]);

  useEffect(()=>{
    const prev=prevCriteria.current;
    const criteriaChanged=prev.query!==query||prev.caseSensitive!==caseSensitive||prev.wholeWord!==wholeWord||prev.regexp!==regexp;
    prevCriteria.current={query,caseSensitive,wholeWord,regexp};
    const nextSourceRanges=regexError?[]:sourceMatches(content,query,filterOptions);
    setSourceRanges(nextSourceRanges);
    if(sourceSession)editorFindQuery(sourceSession,regexError?"":query,caseSensitive,{wholeWord,regexp});
    let targetIndex=index;
    let shouldScrollReplaced=false;
    if(criteriaChanged||regexError){
      pendingReplaceIndex.current=null;
      targetIndex=-1;
      if(indexRef.current!==-1)updateIndex(-1);
    }else if(pendingReplaceIndex.current!==null){
      targetIndex=pendingReplaceIndex.current;
      pendingReplaceIndex.current=null;
      shouldScrollReplaced=targetIndex>=0;
      updateIndex(targetIndex);
    }else if(sourceSearch&&indexRef.current>=nextSourceRanges.length){
      targetIndex=nextSourceRanges.length-1;
      updateIndex(targetIndex);
    }
    const frame=requestAnimationFrame(()=>{
      const host=document.querySelector(".android-reading")||document.querySelector(".markdown-body");
      const nextWindowed=host&&!regexError?windowedMatches(host,query,filterOptions):null;
      const result=host&&!regexError?readingMatches(host,query,filterOptions):[];
      setWindowed(nextWindowed);
      setMatches(result);
      if(!sourceSearch&&!criteriaChanged&&!regexError){
        const total=nextWindowed?.length??result.length;
        if(targetIndex>=total)updateIndex(total-1);
      }
      if(registry&&HighlightClass)registry.set("smd-search",new HighlightClass(...result));
      if(shouldScrollReplaced&&targetIndex>=0&&nextSourceRanges[targetIndex]){
        revealAndHighlightSource(targetIndex,nextSourceRanges,content,true);
      }
    });
    return()=>{cancelAnimationFrame(frame);registry?.delete("smd-search");registry?.delete("smd-search-current");if(sourceSession)editorFindQuery(sourceSession,"",false);};
  },[query,content,caseSensitive,wholeWord,regexp,sourceSession]);

  useEffect(()=>{
    if(!registry||!HighlightClass)return;
    if(regexError||index<0){registry.delete("smd-search-current");return;}
    if(sourceSearch){
      const host=document.querySelector(".android-reading")||document.querySelector(".markdown-body");
      if(!host){registry.delete("smd-search-current");return;}
      registry.delete("smd-search-current");
      const domRange=resolveSourceHighlightRange(host,content,sourceRanges,index,query,filterOptions);
      if(domRange)registry.set("smd-search-current",new HighlightClass(domRange));
      return;
    }
    if(!windowed){
      registry.delete("smd-search-current");
      if(matches[index])registry.set("smd-search-current",new HighlightClass(matches[index]));
    }
  },[index,matches,windowed,sourceRanges,sourceSearch,content,query,caseSensitive,wholeWord,regexp,regexError]);

  useEffect(()=>{
    const host=document.querySelector('.android-reading');if(!host||!windowed||!query||regexError)return;
    let frame=0;const refresh=()=>{if(frame)return;frame=requestAnimationFrame(()=>{frame=0;if(registry&&HighlightClass)registry.set('smd-search',new HighlightClass(...readingMatches(host,query,filterOptions)));});};
    host.addEventListener('supermd-window-change',refresh);
    return()=>{cancelAnimationFrame(frame);host.removeEventListener('supermd-window-change',refresh);};
  },[windowed,query,caseSensitive,wholeWord,regexp,regexError]);

  return <aside className="reading-search" data-independent-zoom role="search" aria-label="Find in note">
    <input ref={input} aria-label="Find in note" aria-invalid={!!regexError||undefined} role="searchbox" type="text" inputMode="search" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="Find in this note" value={query} onChange={event=>setQuery(event.target.value)} onKeyDown={event=>{if(event.key==="Enter"){event.preventDefault();move(event.shiftKey?-1:1);}}}/>
    <output aria-live="polite" className={regexError?"search-error":undefined} title={regexError?regexError:count>=5000?'Showing the first 5,000 matches. Narrow your search to find later results.':undefined}>{regexError ? regexError : count ? `${index<0 ? 0 : index+1} / ${count}${count>=5000?'+':''}` : query ? "No matches" : ""}</output>
    <button className="search-icon" aria-label="Previous match" disabled={!count} onClick={()=>move(-1)} title="Previous match (Shift+Enter / Shift+F3)"><ArrowUp size={20} weight="bold"/></button>
    <button className="search-icon" aria-label="Next match" disabled={!count} onClick={()=>move(1)} title="Next match (Enter / F3)"><ArrowDown size={20} weight="bold"/></button>
    <button className="search-icon" aria-pressed={caseSensitive} onClick={()=>setCaseSensitive(!caseSensitive)} title="Match case" aria-label="Match case"><TextAa size={20} weight="bold"/></button>
    <button className="search-icon" aria-pressed={wholeWord} onClick={()=>setWholeWord(!wholeWord)} title="Match whole word" aria-label="Match whole word"><Textbox size={20} weight="bold"/></button>
    <button className="search-icon" aria-pressed={regexp} onClick={()=>setRegexp(!regexp)} title="Regular expression" aria-label="Regular expression"><Asterisk size={20} weight="bold"/></button>
    {onChange&&<button className="search-icon" aria-pressed={replacing} onClick={()=>toggleReplacing(!replacing)} title="Replace in source (Ctrl+H)" aria-label="Replace in source"><ArrowsClockwise size={20} weight="bold"/></button>}
    <button className="search-icon" onClick={close} title="Close search (Esc)" aria-label="Close search"><X size={20} weight="bold"/></button>
    {replacing&&onChange&&<div className="search-replace"><input aria-label="Replacement text" placeholder="Replace with" value={replacement} onChange={e=>setReplacement(e.target.value)}/><button disabled={!query||!!regexError||!count} onClick={handleSingleReplace}>Replace</button><button disabled={!query||!!regexError||!count} onClick={handleReplaceAll}>Replace all</button><small>{regexError?`${regexError}.`:regexp?"Replaces regex matches in Markdown source ($1, $&, $$ supported).":"Replaces literal text in Markdown source."}</small></div>}
  </aside>;
}
