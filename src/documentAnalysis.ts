import {unified} from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import {visit} from 'unist-util-visit';
import type {Root} from 'mdast';
import {remarkObsidianMath} from './obsidianMath';
import {remarkSvgBlocks} from './svgBlocks';
import {remarkBracedFences} from './fenceLanguage';
import {remarkImageAttributes,remarkSourceSyntax} from './markdownSource';
import {remarkStudySyntax} from './studySyntax';
import {remarkEquationReferences} from './equationReferences';
import {parseFrontmatter,type ParsedFrontmatter} from './frontmatter';
import {headingSlug} from './headingSlug';
import {
  calloutDisclosureBaseKey,
  codeDisclosureBaseKey,
  defaultCalloutOpen,
  defaultCodeDisclosureOpen,
  hashDisclosureSignature,
  isCollapsibleCallout,
  isFoldedCodeLanguage,
  scopedDisclosureKey,
  type DisclosureDescriptor,
} from './disclosureState';

export type {DisclosureDescriptor} from './disclosureState';
export interface SourceBlock {start:number;end:number;text:string}
export interface OutlineEntry {id:string;title:string;level:number;offset:number}
export interface PythonCellSource {source:string;ordinal:number;offset:number}
export interface DocumentAnalysis {tree:Root;blocks:SourceBlock[];bodyBlocks:SourceBlock[];frontmatter:ParsedFrontmatter|null;outline:OutlineEntry[];tasks:number[];pythonCells:PythonCellSource[];disclosures:DisclosureDescriptor[]}
export interface SourceDocumentAnalysis {source:string;analysis:DocumentAnalysis}
const processor=unified().use(remarkParse).use(remarkSourceSyntax).use(remarkGfm,{singleTilde:false}).use(remarkMath).use(remarkObsidianMath).use([remarkImageAttributes,remarkSvgBlocks,remarkBracedFences,remarkStudySyntax,remarkEquationReferences]);
const cache=new Map<string,{value:DocumentAnalysis;weight:number}>();let retained=0;
const LIMIT=8_000_000;
function textOf(node:any):string{return typeof node.value==='string'?node.value:(node.children||[]).map(textOf).join('');}

/** One bounded immutable analysis shared by outline, Live and rendering. Only
 * derived syntax is cached; source remains owned by the document/revision. */
export function analyzeDocument(source:string):DocumentAnalysis {
  const hit=cache.get(source);if(hit){cache.delete(source);cache.set(source,hit);return hit.value;}
  const frontmatter=parseFrontmatter(source),fmEnd=frontmatter?.end??0;
  const tree=processor.runSync(processor.parse(source),source) as Root;
  const outline:OutlineEntry[]=[],tasks:number[]=[],pythonCells:PythonCellSource[]=[],disclosures:DisclosureDescriptor[]=[],counts=new Map<string,number>(),pythonCounts=new Map<string,number>(),disclosureCounts=new Map<string,number>();let weight=source.length*2;
  visit(tree,(node:any)=>{
    weight+=160+(typeof node.value==='string'?node.value.length*2:0);
    if(node.type==='heading'){
      const title=textOf(node),slug=headingSlug(title),count=counts.get(slug)||0;counts.set(slug,count+1);
      if(outline.length<2000)outline.push({id:slug+(count?`-${count}`:''),title,level:node.depth,offset:node.position?.start.offset||0});
    }
    if(node.type==='listItem'&&typeof node.checked==='boolean'){
      const start=node.position.start.offset,marker=source.slice(start,node.position.end.offset).match(/^\s*(?:[-+*]|\d+[.)])\s+\[([ xX])\]/);
      if(marker)tasks.push(start+marker[0].lastIndexOf('[')+1);
    }
    if(node.type==='blockquote'){
      const first=node.children?.[0]?.children?.[0];
      const match=first?.type==='text'?first.value.match(/^\[!([\w-]+)\]([+-]?)[ \t]*/i):null;
      if(match){
        const type=match[1].toLowerCase(),fold=match[2]||'';
        if(isCollapsibleCallout(type,fold)){
          const offset=node.position?.start.offset??-1,endOffset=node.position?.end.offset??-1;
          const rawSlice=offset>=0&&endOffset>offset?source.slice(offset,endOffset):'';
          const baseKey=calloutDisclosureBaseKey(fold,type,rawSlice),ordinal=disclosureCounts.get(baseKey)||0;
          disclosureCounts.set(baseKey,ordinal+1);
          disclosures.push({key:`${baseKey}#${ordinal}`,kind:'callout',offset,endOffset,defaultOpen:defaultCalloutOpen(fold)});
        }
      }
    }
    if(node.type==='code'){
      const rawLang=String(node.lang||'').trim().match(/^([\w-]+)/)?.[1]??'';
      if(['python','py'].includes(rawLang.toLowerCase())){
        const code=String(node.value||''),ordinal=pythonCounts.get(code)||0;
        pythonCounts.set(code,ordinal+1);
        pythonCells.push({source:code,ordinal,offset:node.position?.start.offset??-1});
      }else if(isFoldedCodeLanguage(rawLang)){
        const code=String(node.value||'').replace(/\n$/,'');
        const offset=node.position?.start.offset??-1,endOffset=node.position?.end.offset??-1;
        const baseKey=codeDisclosureBaseKey(rawLang,code),ordinal=disclosureCounts.get(baseKey)||0;
        disclosureCounts.set(baseKey,ordinal+1);
        disclosures.push({key:`${baseKey}#${ordinal}`,kind:'code',offset,endOffset,defaultOpen:defaultCodeDisclosureOpen(code)});
      }
    }
  });
  const nodes=tree.children.filter(node=>node.position?.start.offset!==undefined);
  const blocks=nodes.length?nodes.map((node,index)=>{const start=index?node.position!.start.offset!:0,end=nodes[index+1]?.position?.start.offset??source.length;return {start,end,text:source.slice(start,end)};}):[{start:0,end:source.length,text:source}];
  const bodyBlocks=nodes.length?nodes.map((node,index)=>{const firstStart=fmEnd?Math.max(fmEnd,source.lastIndexOf('\n',node.position!.start.offset!-1)+1):0,start=index?node.position!.start.offset!:firstStart,end=nodes[index+1]?.position?.start.offset??source.length;return {start,end,text:source.slice(start,end)};}):[{start:fmEnd,end:source.length,text:source.slice(fmEnd)}];
  const value={tree,blocks,bodyBlocks,frontmatter,outline,tasks,pythonCells,disclosures};
  if(weight<=LIMIT){cache.set(source,{value,weight});retained+=weight;while(retained>LIMIT||cache.size>16){const first=cache.keys().next().value!;retained-=cache.get(first)!.weight;cache.delete(first);}}
  return value;
}

export function validDisclosureDefaults(source:string,parentScope?:string):Map<string,boolean> {
  const analysis=analyzeDocument(source);
  const defaults=new Map<string,boolean>();
  for(const entry of analysis.disclosures)defaults.set(scopedDisclosureKey(parentScope,entry.key),entry.defaultOpen);
  if(source.includes('smd-steps')){
    visit(analysis.tree,(node:any)=>{
      if(node.type!=='code'||String(node.lang||'').trim()!=='smd-steps')return;
      const deckSource=String(node.value||'').replace(/\n$/,'');
      if(deckSource.length>120000)return;
      try{
        const parsed=JSON.parse(deckSource) as {steps?:Array<{markdown?:unknown}>};
        if(!Array.isArray(parsed?.steps))return;
        const deckHash=hashDisclosureSignature(deckSource);
        for(const step of parsed.steps){
          if(typeof step?.markdown==='string'&&step.markdown.trim()&&step.markdown.length<=12000){
            const childScope=scopedDisclosureKey(parentScope,`step:${deckHash}:${hashDisclosureSignature(step.markdown)}`);
            for(const [k,v] of validDisclosureDefaults(step.markdown,childScope))defaults.set(k,v);
          }
        }
      }catch{/* ignore malformed step decks */}
    });
  }
  return defaults;
}
