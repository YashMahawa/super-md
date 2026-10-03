import {unified} from "unified";
import remarkParse from "remark-parse";
import remarkMath from "remark-math";
import retextEnglish from "retext-english";
import repeatedWords from "retext-repeated-words";
import indefiniteArticle from "retext-indefinite-article";
import {VFile} from "vfile";

export interface WritingOptions {spellCheck?:boolean;grammarCheck?:boolean}
export interface WritingIssue {from:number;to:number;message:string;kind:"spelling"|"grammar";replacements:string[]}
export interface Speller {correct(word:string):boolean;suggest(word:string):string[]}
const markdown=unified().use(remarkParse).use(remarkMath);
const grammar=unified().use(retextEnglish).use(repeatedWords).use(indefiniteArticle);
const technical=new Set("markdown matplotlib numpy mermaid latex katex supermd smd fmd geogebra obsidian qt qml pdf cli api android linux macos javascript typescript python manrope github yash mahawar".split(" "));

/** Preserve exact UTF-16 offsets; never check code, URLs, math or image bytes. */
export function proseMask(source:string):string {
  const clean=source.replace(/[^\n\r]/g," ").split("");
  const walk=(node:any)=>{
    if(["code","inlineCode","math","inlineMath","html","image","link","linkReference","definition"].includes(node.type))return;
    if(node.type==="text" && node.position){const start=node.position.start.offset,end=node.position.end.offset;for(let i=start;i<end;i++)clean[i]=source[i];}
    else for(const child of node.children||[])walk(child);
  };
  walk(markdown.parse(source));
  return clean.join("");
}
export function writingIssues(source:string,options:WritingOptions,speller?:Speller,blocked:Array<[number,number]>=[]):WritingIssue[] {
  const text=proseMask(source),issues:WritingIssue[]=[];
  const allowed=(from:number,to:number)=>!blocked.some(([a,b])=>from<b&&to>a);
  if(options.grammarCheck){
    const file=new VFile({value:text});grammar.runSync(grammar.parse(file),file);
    for(const message of file.messages){
      const position=message.place as {start?:{offset?:number};end?:{offset?:number}}|undefined;
      const from=position?.start?.offset,to=position?.end?.offset;
      if(from===undefined||to===undefined||!allowed(from,to))continue;
      const expected=(message as any).expected;
      issues.push({from,to,message:message.reason,kind:"grammar",replacements:Array.isArray(expected)?expected.slice(0,3):[]});
    }
  }
  if(options.spellCheck&&speller){
    const candidates:Array<{word:string;from:number;to:number}>=[];
    for(const match of text.matchAll(/\b[A-Za-z][A-Za-z’'-]{2,39}\b/g)){
      const word=match[0],from=match.index!,to=from+word.length;
      if(technical.has(word.toLowerCase())||/^[A-Z]+$/.test(word)||!allowed(from,to))continue;
      if(!speller.correct(word.replace(/’/g,"'")))candidates.push({word,from,to});
      if(candidates.length>=30)break;
    }
    // Suggestions are expensive. Compute only a few, and never on the UI thread.
    const suggestions=new Map<string,string[]>();
    for(const {word,from,to} of candidates){
      if(!suggestions.has(word))suggestions.set(word,suggestions.size<8?speller.suggest(word).slice(0,3):[]);
      issues.push({from,to,message:`Possible spelling error: ${word}`,kind:"spelling",replacements:suggestions.get(word)!});
    }
  }
  return issues.sort((a,b)=>a.from-b.from).slice(0,40);
}
