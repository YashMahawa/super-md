import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkMath from "remark-math";
import { visit } from "unist-util-visit";
import katex from "katex";
import { remarkObsidianMath } from "./obsidianMath";

export interface MathRepair { from: number; to: number; before: string; after: string; reason: string }
const command = /\\(?:frac|dfrac|tfrac|sqrt|sum|prod|int|iint|lim|boxed|alpha|beta|theta|pi|sigma|omega|lambda|Delta|mathbb|mathbf|mathcal|vec|begin)\b/;
const strong = (text:string) => command.test(text) || /[A-Za-z][\^_]/.test(text) || /[=<>]/.test(text) && /[A-Za-z]/.test(text) && /[\\^_+*/-]/.test(text);
const explicitMath=(text:string)=>strong(text)||/[A-Za-z]/.test(text)&&/[+*/=<>]/.test(text)&&!/[A-Za-z]{3,}/.test(text);
function cleanFormula(body:string): string {
  return body.trim().replace(/[\u00a0\u200b\ufeff]/g," ")
    .replace(/\\begin\{(?:align\*?|aligned\*?)\}/g,"\\begin{aligned}").replace(/\\end\{(?:align\*?|aligned\*?)\}/g,"\\end{aligned}")
    .replace(/\\begin\{gather\*?\}/g,"\\begin{gathered}").replace(/\\end\{gather\*?\}/g,"\\end{gathered}")
    .replace(/\\(?:begin|end)\{equation\*?\}/g,"").trim();
}
function valid(body:string): boolean {
  if(!body || body.length>12000 || /\\(?:gdef|def|newcommand|renewcommand|includegraphics|href|html\w*)\b/.test(body))return false;
  try {katex.renderToString(body,{throwOnError:true,strict:"ignore",trust:false,maxExpand:100,maxSize:20,displayMode:true});return true;}catch{return false;}
}
function repairedFormula(body:string): string|null {
  let next=cleanFormula(body);
  if(valid(next))return next;
  let depth=0;
  for(let i=0;i<next.length;i++){
    if(next[i]==="\\"){i++;continue;}
    if(next[i]==="{")depth++;if(next[i]==="}")depth--;
    if(depth<0)return null;
  }
  if(depth>0 && depth<=2 && command.test(next))next+="}".repeat(depth);
  if(valid(next))return next;
  const left=(next.match(/\\left\b/g)||[]).length,right=(next.match(/\\right\b/g)||[]).length;
  if(left!==right) {const without=next.replace(/\\(?:left|right)\b/g,"");if(valid(without))return without;}
  return null;
}
function mathOnly(text:string):boolean {
  if(!strong(text) || /https?:|[`$]|^\s*(?:#|[-*]\s|\d+\.\s)/.test(text))return false;
  const stripped=text.replace(/\\(?:text|mathrm|operatorname)\{[^{}]*\}/g,"").replace(/\\(?:begin|end)\{[^{}]*\}/g,"").replace(/\\[A-Za-z]+/g,"");
  return !/[A-Za-z]{3,}/.test(stripped);
}
/** Shared by Qt and Android. Only validated suggestions with exact offsets;
 * never silently rewrite code, links, currency or ambiguous prose. */
export function suggestMathRepairs(markdown: string): MathRepair[] {
  const protectedRanges:Array<[number,number]>=[],mathRanges:Array<[number,number]>=[],unfinished:Array<{from:number;to:number;body:string}>=[];
  // Parse protections without math so an unfinished $$ cannot hide later code.
  visit(unified().use(remarkParse).parse(markdown),(node:any)=>{
    if(["code","inlineCode","link","image","definition","html"].includes(node.type)&&node.position)protectedRanges.push([node.position.start.offset,node.position.end.offset]);
  });
  visit(unified().use(remarkParse).use(remarkMath).use(remarkObsidianMath).parse(markdown),(node:any)=>{
    if(["math","inlineMath"].includes(node.type)&&node.position){
      const from=node.position.start.offset,to=node.position.end.offset;mathRanges.push([from,to]);
      const raw=markdown.slice(from,to);
      if(node.type==="math"&&raw.startsWith("$$")&&!/\n[ \t]*\$\$[ \t]*$/.test(raw))unfinished.push({from,to,body:raw.slice(2)});
    }
  });
  const changes:MathRepair[]=[],cache=new Map<string,string|null>();
  const repair=(body:string)=>{if(!cache.has(body))cache.set(body,repairedFormula(body));return cache.get(body)!;};
  const overlaps=(ranges:Array<[number,number]>,from:number,to:number)=>ranges.some(([start,end])=>from<end&&to>start);
  const add=(from:number,to:number,after:string,reason:string,existing=false)=>{
    if(changes.length>=200||markdown.slice(from,to)===after||overlaps(protectedRanges,from,to)||!existing&&overlaps(mathRanges,from,to)||changes.some(change=>from<change.to&&to>change.from))return;
    changes.push({from,to,before:markdown.slice(from,to),after,reason});
  };
  const wrap=(body:string,display:boolean)=>display?`$$\n${body}\n$$`:`$${body}$`;
  for(const item of unfinished){if(!mathOnly(item.body))continue;const body=repair(item.body);if(body!==null)add(item.from,item.to,wrap(body,true),"Close an unfinished display math block",true);}
  for(const match of markdown.matchAll(/\\([([])([\s\S]{1,12000}?)\\([)\]])/g)){
    if(match.index>0&&markdown[match.index-1]==="\\")continue;
    const body=repair(match[2]);if(body===null)continue;
    const display=match[1]==="[";
    add(match.index,match.index+match[0].length,wrap(body,display),match[3]===(display?"]":")")?"Normalize LaTeX delimiters":"Match LaTeX opening and closing delimiters");
  }
  const dollarBlocks:Array<[number,number]>=[];
  for(const match of markdown.matchAll(/(?<![\\$])\$\$([\s\S]{1,12000}?)\$\$(?!\$)/g)){
    const from=match.index,to=from+match[0].length;dollarBlocks.push([from,to]);
    if(!strong(match[1])||/\n\s*#/.test(match[1]))continue;
    const body=repair(match[1]);if(body!==null)add(from,to,wrap(body,true),"Normalize display fences and formula syntax",true);
  }
  for(const match of markdown.matchAll(/(?<![\\$])\$(?!\$)([^\n$]{1,2000})\$(?!\$)/g)){
    const from=match.index,to=from+match[0].length;
    if(overlaps(dollarBlocks,from,to)||!explicitMath(match[1]))continue;
    const body=repair(match[1]);if(body!==null)add(from,to,wrap(body,false),"Trim math delimiter spacing and repair formula syntax",true);
  }
  for(const match of markdown.matchAll(/\\\$([^\n$]{1,2000})\\\$/g)){
    if(!mathOnly(match[1]))continue;const body=repair(match[1]);if(body!==null)add(match.index,match.index+match[0].length,wrap(body,false),"Restore copied math dollar delimiters");
  }
  for(const match of markdown.matchAll(/^[ \t]*(\\begin\{(aligned|align\*?|equation\*?|gather\*?|cases|matrix|pmatrix|bmatrix)\}[\s\S]{1,12000}?\\end\{\2\})[ \t]*$/gm)){
    const body=repair(match[1]);if(body!==null)add(match.index,match.index+match[0].length,wrap(body,true),"Enclose a standalone LaTeX environment");
  }
  for(const match of markdown.matchAll(/^[ \t]*([^\n]+)[ \t]*$/gm)){
    const quote=match[1].match(/^(?:>[ \t]*)+/)?.[0]||"";
    let expression=match[1].slice(quote.length).trim(),reason="Enclose a standalone formula missing dollar signs";
    const delimiter=expression.match(/^(\${1,2})\s*([^$]+?)(\${0,2})$/);
    const missingOpen=expression.match(/^([^$]+?)\${1,2}$/);
    if(delimiter&&delimiter[1]===delimiter[3])continue;
    if(delimiter&&mathOnly(delimiter[2])){expression=delimiter[2];reason="Complete an unfinished math dollar delimiter";}
    else if(missingOpen&&mathOnly(missingOpen[1])){expression=missingOpen[1];reason="Restore a missing opening math dollar delimiter";}
    if(!mathOnly(expression))continue;
    const body=repair(expression);if(body!==null)add(match.index+(quote?match[0].indexOf(match[1])+quote.length:0),match.index+match[0].length,wrap(body,!quote),reason,!!delimiter||!!missingOpen);
  }
  // Inline formulas consume balanced TeX arguments, stopping at prose. A lone
  // Greek command in a sentence is ambiguous and is deliberately not guessed.
  for(const match of markdown.matchAll(/\\(?:frac|dfrac|tfrac|sqrt|boxed|mathbb|mathbf|vec)\b/g)){
    const from=match.index;if(overlaps(protectedRanges,from,from+match[0].length)||overlaps(mathRanges,from,from+match[0].length))continue;
    let end=from,depth=0;
    while(end<Math.min(markdown.length,from+2000)){
      const char=markdown[end];if(char==="\n"||char==="$"||char==="`"||depth===0&&/[,;:!?]/.test(char))break;
      if(char==="\\"){const token=markdown.slice(end).match(/^\\(?:[A-Za-z]+|[^\n])/);if(!token)break;end+=token[0].length;continue;}
      if(char==="{")depth++;else if(char==="}"){if(!depth)break;depth--;}
      if(!depth&&/[A-Za-z]/.test(char)){const word=markdown.slice(end).match(/^[A-Za-z]+/)![0];if(word.length>1&&!["sin","cos","tan","log","ln","exp"].includes(word))break;end+=word.length;continue;}
      if(!depth&&char==="."&&!/\d/.test(markdown[end+1]||""))break;
      end++;
    }
    const raw=markdown.slice(from,end).trimEnd();if(!raw)continue;
    const body=repair(raw),closing=markdown.slice(from+raw.length).match(/^\${1,2}/)?.[0]||"";
    if(body!==null)add(from,from+raw.length+closing.length,wrap(body,false),"Enclose an inline formula missing dollar signs");
  }
  return changes.sort((a,b)=>a.from-b.from);
}
export function applyMathRepairs(markdown: string, changes: MathRepair[]): string {
  return [...changes].sort((a,b)=>b.from-a.from).reduce((content,change)=> content.slice(change.from,change.to) === change.before ? content.slice(0,change.from)+change.after+content.slice(change.to) : content,markdown);
}
