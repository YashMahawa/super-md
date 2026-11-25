import {unified} from "unified";
import remarkParse from "remark-parse";
import remarkMath from "remark-math";
import retextEnglish from "retext-english";
import repeatedWords from "retext-repeated-words";
import indefiniteArticle from "retext-indefinite-article";
import {VFile} from "vfile";

export const PROOFREADING_MAX_CHARS=12_000;
export interface WritingOptions {spellCheck?:boolean;grammarCheck?:boolean;customWords?:Iterable<string>}
export interface WritingIssue {from:number;to:number;message:string;kind:"spelling"|"grammar";replacements:string[];word?:string}
export interface Speller {correct(word:string):boolean;suggest(word:string):string[]}
export interface ProofreadingWindow {from:number;to:number;text:string;truncated:boolean;blocked:Array<[number,number]>}
const markdown=unified().use(remarkParse).use(remarkMath);
const grammar=unified().use(retextEnglish).use(repeatedWords).use(indefiniteArticle);
const technical=new Set("markdown matplotlib numpy mermaid latex katex supermd smd fmd geogebra obsidian qt qml pdf cli api android linux macos javascript typescript python manrope github yash mahawar".split(" "));
const PROTECTED_NODE_TYPES=new Set(["code","inlineCode","math","inlineMath","html","image","link","linkReference","definition"]);
const INLINE_PROTECTED_TYPES=new Set(["inlineCode","inlineMath","html","image","link","linkReference"]);

function cleanReplacements(items:unknown):string[] {
  if(!Array.isArray(items))return [];
  const unique:string[]=[];
  for(const item of items){
    if(typeof item!=="string"||!item.trim())continue;
    if(!unique.includes(item))unique.push(item);
    if(unique.length>=3)break;
  }
  return unique;
}

function normalizeWord(word:string):string {
  return word.replace(/[’‘]/g,"'");
}

/** Fast O(1)-ish line/word boundary window calculation around caret without AST parsing. */
export function computeWindowBounds(source:string,caret:number,maxChars=PROOFREADING_MAX_CHARS):{from:number;to:number;truncated:boolean} {
  if(source.length<=maxChars)return {from:0,to:source.length,truncated:false};
  const clampedCaret=Math.max(0,Math.min(source.length,Number.isFinite(caret)?Math.trunc(caret):0));
  let from=Math.max(0,Math.min(source.length-maxChars,clampedCaret-Math.floor(maxChars/2)));
  let to=from+maxChars;
  if(from>0){
    const nl=source.indexOf("\n",from);
    if(nl!==-1&&nl+1<=Math.min(clampedCaret,from+300))from=nl+1;
    else if(from<clampedCaret&&!/\s/.test(source[from-1])){
      while(from<clampedCaret&&!/\s/.test(source[from]))from++;
      while(from<clampedCaret&&/\s/.test(source[from]))from++;
    }
  }
  if(to<source.length){
    const minEnd=Math.max(clampedCaret,to-300);
    const nl=source.lastIndexOf("\n",to-1);
    if(nl>=minEnd)to=nl;
    else if(to>clampedCaret&&!/\s/.test(source[to])){
      while(to>clampedCaret&&!/\s/.test(source[to]))to--;
    }
  }
  return {from,to,truncated:true};
}

/** Center a <= 12,000-char proofreading window around caret without splitting words or Markdown syntax. */
export function selectProofreadingWindow(source:string,caret:number,maxChars=PROOFREADING_MAX_CHARS):ProofreadingWindow {
  if(source.length<=maxChars)return {from:0,to:source.length,text:source,truncated:false,blocked:[]};
  const clampedCaret=Math.max(0,Math.min(source.length,Number.isFinite(caret)?Math.trunc(caret):0));
  const protectedSpans:Array<{from:number;to:number;inline:boolean}>=[];
  const collect=(node:any)=>{
    if(PROTECTED_NODE_TYPES.has(node.type)){
      const s=node.position?.start?.offset,e=node.position?.end?.offset;
      if(typeof s==="number"&&typeof e==="number"&&e>s)protectedSpans.push({from:s,to:e,inline:INLINE_PROTECTED_TYPES.has(node.type)&&e-s<2_000});
      return;
    }
    for(const child of node.children||[])collect(child);
  };
  collect(markdown.parse(source));
  let {from,to}=computeWindowBounds(source,clampedCaret,maxChars);
  for(const span of protectedSpans){
    if(span.inline&&span.from<from&&from<span.to&&span.to<=clampedCaret)from=span.to;
    if(span.inline&&span.from<to&&to<span.to&&span.from>=clampedCaret)to=span.from;
  }
  // Ensure inline formatting delimiters like **bold** or _italic_ are not split mid-token.
  if(from>0&&from<clampedCaret&&!/\s/.test(source[from-1])){
    const insideProtected=protectedSpans.some(span=>span.from<=from&&from<span.to);
    if(!insideProtected){
      while(from<clampedCaret&&!/\s/.test(source[from]))from++;
      while(from<clampedCaret&&/\s/.test(source[from]))from++;
    }
  }
  if(to<source.length&&to>clampedCaret&&!/\s/.test(source[to])){
    const insideProtected=protectedSpans.some(span=>span.from<to&&to<=span.to);
    if(!insideProtected){
      while(to>clampedCaret&&!/\s/.test(source[to]))to--;
    }
  }
  const blocked:Array<[number,number]>=[];
  for(const span of protectedSpans){
    if(span.to>from&&span.from<to){
      blocked.push([Math.max(0,span.from-from),Math.min(to-from,span.to-from)]);
    }
  }
  return {from,to,text:source.slice(from,to),truncated:true,blocked};
}

/** Preserve exact UTF-16 offsets; never check code, URLs, math or image bytes. */
export function proseMask(source:string,blocked:Array<[number,number]>=[]):string {
  let prepared=source;
  if(blocked.length){
    const chars=source.split("");
    for(const [rawFrom,rawTo] of blocked){
      const start=Math.max(0,rawFrom),end=Math.min(chars.length,rawTo);
      for(let i=start;i<end;i++){
        if(chars[i]!=="\n"&&chars[i]!=="\r")chars[i]=" ";
      }
    }
    prepared=chars.join("");
  }
  const clean=prepared.replace(/[^\n\r]/g," ").split("");
  const walk=(node:any)=>{
    if(PROTECTED_NODE_TYPES.has(node.type))return;
    if(node.type==="text" && node.position){const start=node.position.start.offset,end=node.position.end.offset;for(let i=start;i<end;i++)clean[i]=prepared[i];}
    else for(const child of node.children||[])walk(child);
  };
  walk(markdown.parse(prepared));
  return clean.join("");
}

export function writingIssues(source:string,options:WritingOptions,speller?:Speller,blocked:Array<[number,number]>=[]):WritingIssue[] {
  const text=proseMask(source,blocked),issues:WritingIssue[]=[];
  const allowed=(from:number,to:number)=>!blocked.some(([a,b])=>from<b&&to>a);
  if(options.grammarCheck){
    const file=new VFile({value:text});grammar.runSync(grammar.parse(file),file);
    for(const message of file.messages){
      const position=message.place as {start?:{offset?:number};end?:{offset?:number}}|undefined;
      const from=position?.start?.offset,to=position?.end?.offset;
      if(from===undefined||to===undefined||!allowed(from,to))continue;
      issues.push({from,to,message:message.reason,kind:"grammar",replacements:cleanReplacements((message as any).expected)});
    }
  }
  if(options.spellCheck&&speller){
    const custom=new Set<string>();
    if(options.customWords){
      for(const entry of options.customWords){
        if(typeof entry==="string"){
          const normalized=normalizeWord(entry).trim().replace(/^['-]+|['-]+$/g,"").toLowerCase();
          if(normalized)custom.add(normalized);
        }
      }
    }
    const isExempt=(norm:string):boolean=>{
      const lower=norm.toLowerCase();
      const stem=lower.endsWith("'s")?lower.slice(0,-2):lower;
      return technical.has(lower)||technical.has(stem)||custom.has(lower)||custom.has(stem)||/^[A-Z]+(?:'[sS])?$/.test(norm);
    };
    const correctness=new Map<string,boolean>();
    const isCorrect=(norm:string):boolean=>{
      let ok=correctness.get(norm);
      if(ok===undefined){ok=speller.correct(norm);correctness.set(norm,ok);}
      return ok;
    };
    const candidates:Array<{word:string;norm:string;key:string;from:number;to:number}>=[];
    const uniqueUnknowns=new Set<string>();
    const recordIfMisspelled=(word:string,from:number,to:number)=>{
      if(!allowed(from,to))return;
      const norm=normalizeWord(word);
      if(isExempt(norm))return;
      const key=norm.toLowerCase();
      if(!uniqueUnknowns.has(key)&&uniqueUnknowns.size>=30)return;
      if(!isCorrect(norm)){
        uniqueUnknowns.add(key);
        candidates.push({word,norm,key,from,to});
      }
    };
    for(const match of text.matchAll(/\b[A-Za-z][A-Za-z’‘'-]{2,79}\b/g)){
      const token=match[0],tokenFrom=match.index!,tokenTo=tokenFrom+token.length;
      if(!token.includes("-")){
        recordIfMisspelled(token,tokenFrom,tokenTo);
        continue;
      }
      const normToken=normalizeWord(token);
      if(allowed(tokenFrom,tokenTo)&&(isExempt(normToken)||isCorrect(normToken)))continue;
      for(const subMatch of token.matchAll(/[A-Za-z]+(?:[’‘'][A-Za-z]+)*/g)){
        const sub=subMatch[0];
        if(sub.length<3)continue;
        const subFrom=tokenFrom+subMatch.index!,subTo=subFrom+sub.length;
        recordIfMisspelled(sub,subFrom,subTo);
      }
    }
    // Suggestions are expensive. Compute only a few unique words, and never on the UI thread.
    const suggestions=new Map<string,string[]>();
    const suggestedStems=new Set<string>();
    for(const {word,norm,key,from,to} of candidates){
      if(!suggestions.has(norm)){
        if((suggestedStems.has(key)||suggestedStems.size<8)&&suggestions.size<12){
          suggestedStems.add(key);
          suggestions.set(norm,cleanReplacements(speller.suggest(norm)));
        }else{
          suggestions.set(norm,[]);
        }
      }
      issues.push({from,to,word,message:`Possible spelling error: ${word}`,kind:"spelling",replacements:suggestions.get(norm)!});
    }
  }
  issues.sort((a,b)=>a.from-b.from);
  if(issues.length<=40)return issues;
  // Preserve at least one occurrence of each distinct issue so a heavily repeated
  // term at the top of a window cannot push unique downstream typos past 40.
  const primary:WritingIssue[]=[],extras:WritingIssue[]=[],seenIssueKeys=new Set<string>();
  for(const issue of issues){
    const key=issue.kind==="spelling"?`s:${(issue.word||source.slice(issue.from,issue.to)).toLowerCase()}`:`g:${issue.message}:${issue.from}`;
    if(!seenIssueKeys.has(key)&&primary.length<40){seenIssueKeys.add(key);primary.push(issue);}
    else extras.push(issue);
  }
  const combined=[...primary,...extras.slice(0,Math.max(0,40-primary.length))];
  return combined.sort((a,b)=>a.from-b.from);
}
