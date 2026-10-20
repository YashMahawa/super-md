import {unified} from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import {visit} from 'unist-util-visit';
import type {Root} from 'mdast';
import {remarkObsidianMath} from './obsidianMath';
import {remarkSvgBlocks} from './svgBlocks';
import {remarkSourceSyntax} from './markdownSource';
import {headingSlug} from './headingSlug';

export interface SourceBlock {start:number;end:number;text:string}
export interface OutlineEntry {id:string;title:string;level:number;offset:number}
export interface PythonCellSource {source:string;ordinal:number;offset:number}
export interface DocumentAnalysis {tree:Root;blocks:SourceBlock[];outline:OutlineEntry[];tasks:number[];pythonCells:PythonCellSource[]}
const processor=unified().use(remarkParse).use(remarkSourceSyntax).use(remarkGfm).use(remarkMath).use(remarkObsidianMath).use(remarkSvgBlocks);
const cache=new Map<string,{value:DocumentAnalysis;weight:number}>();let retained=0;
const LIMIT=8_000_000;
function textOf(node:any):string{return typeof node.value==='string'?node.value:(node.children||[]).map(textOf).join('');}

/** One bounded immutable analysis shared by outline, Live and rendering. Only
 * derived syntax is cached; source remains owned by the document/revision. */
export function analyzeDocument(source:string):DocumentAnalysis {
  const hit=cache.get(source);if(hit){cache.delete(source);cache.set(source,hit);return hit.value;}
  const tree=processor.runSync(processor.parse(source),source) as Root;
  const outline:OutlineEntry[]=[],tasks:number[]=[],pythonCells:PythonCellSource[]=[],counts=new Map<string,number>(),pythonCounts=new Map<string,number>();let weight=source.length*2;
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
    if(node.type==='code'&&['python','py'].includes(String(node.lang||'').toLowerCase())){
      const code=String(node.value||''),ordinal=pythonCounts.get(code)||0;
      pythonCounts.set(code,ordinal+1);
      pythonCells.push({source:code,ordinal,offset:node.position?.start.offset??-1});
    }
  });
  const nodes=tree.children.filter(node=>node.position?.start.offset!==undefined);
  const blocks=nodes.length?nodes.map((node,index)=>{const start=index?node.position!.start.offset!:0,end=nodes[index+1]?.position?.start.offset??source.length;return {start,end,text:source.slice(start,end)};}):[{start:0,end:source.length,text:source}];
  const value={tree,blocks,outline,tasks,pythonCells};
  if(weight<=LIMIT){cache.set(source,{value,weight});retained+=weight;while(retained>LIMIT||cache.size>16){const first=cache.keys().next().value!;retained-=cache.get(first)!.weight;cache.delete(first);}}
  return value;
}
