import {Fragment,jsx,jsxs} from "react/jsx-runtime";
import {toJsxRuntime} from "hast-util-to-jsx-runtime";
import {unified,type PluggableList} from "unified";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import {defaultUrlTransform,type Components} from "react-markdown";
import {visit} from "unist-util-visit";
import type {Root} from "hast";
import {useMemo} from "react";
import WindowedBlock,{useWindowing} from "./WindowedBlock";

// Theme, mode and tab changes must not run KaTeX/highlighting again. Cache
// immutable, sanitized trees, with a byte estimate and LRU bound, not an
// unbounded collection of whole documents or screenshots.
const cache=new Map<string,{tree:Root;weight:number}>();let retained=0;
const LIMIT=24_000_000;
export function cachedMarkdownTree(source:string,remarkPlugins:PluggableList,rehypePlugins:PluggableList,deferred=false):Root {
  const key=(deferred?'deferred:':'full:')+source;
  const hit=cache.get(key);if(hit){cache.delete(key);cache.set(key,hit);return hit.tree;}
  const processor=unified().use(remarkParse).use(remarkPlugins).use(remarkRehype,{allowDangerousHtml:true}).use(rehypePlugins);
  const tree=processor.runSync(processor.parse(source),source) as Root;let weight=source.length*2;
  visit(tree,(node:any,index,parent:any)=>{
    weight+=160+(typeof node.value==="string"?node.value.length*2:0);
    if(node.type==="raw"&&parent&&index!==undefined){parent.children[index]={type:"text",value:node.value};return;}
    if(node.type!=="element")return;
    for(const key of ["href","src","cite","poster","longDesc","action"]){
      if(typeof node.properties[key]!=="string")continue;
      const url=node.properties[key];
      node.properties[key]=node.tagName==="img"&&key==="src"&&/^data:image\/(?:png|jpeg|gif|webp|avif|svg\+xml);base64,/i.test(url)?url:defaultUrlTransform(url);
    }
  });
  if(weight<=LIMIT){cache.set(key,{tree,weight});retained+=weight;while(retained>LIMIT||cache.size>512){const first=cache.keys().next().value!;retained-=cache.get(first)!.weight;cache.delete(first);}}
  return tree;
}
export default function CachedMarkdown({children,remarkPlugins,rehypePlugins,components}:{children:string;remarkPlugins:PluggableList;rehypePlugins:PluggableList;components:Components}){
  const windowing=useWindowing()&&children.length>80_000;
  const tree=cachedMarkdownTree(children,remarkPlugins,windowing?[]:rehypePlugins,windowing);
  const blocks=useMemo(()=>windowing?tree.children.filter(node=>node.type!=='text'||node.value.trim()).map((node:any,index)=>({node,index,text:plainText(node),headings:headingsOf(node),estimate:Math.min(1200,Math.max(80,plainText(node).length/65*30+(node.tagName==='pre'?220:40)))})):[],[tree,windowing]);
  if(!windowing)return toJsxRuntime(tree,{Fragment,jsx,jsxs,components,ignoreInvalidStyle:true,passKeys:true,passNode:true});
  return <>{blocks.map(block=><WindowedBlock key={block.index} enabled estimate={block.estimate} text={block.text} headings={block.headings} data-source-start={block.node.properties?.['data-source-start']??block.node.position?.start.offset} data-source-end={block.node.properties?.['data-source-end']??block.node.position?.end.offset}><DeferredMarkdown node={block.node} plugins={rehypePlugins} components={components}/></WindowedBlock>)}</>;
}
function plainText(node:any):string {return node.type==='text'?node.value:(node.children||[]).map(plainText).join('')+(/^(p|li|pre|h[1-6])$/.test(node.tagName||'')?'\n':'');}
function headingsOf(node:any):Array<{id:string;key:string}> {const result:Array<{id:string;key:string}>=[];visit(node,(entry:any)=>{if(entry.type==='element'&&entry.properties?.['data-heading-key'])result.push({id:String(entry.properties.id),key:String(entry.properties['data-heading-key'])});});return result;}
function DeferredMarkdown({node,plugins,components}:{node:any;plugins:PluggableList;components:Components}) {
  // Expanded KaTeX/highlighting trees live only with visible blocks. Raw trees
  // retain references/heading IDs from the whole-document parse.
  const tree=useMemo(()=>unified().use(plugins).runSync({type:'root',children:[structuredClone(node)]} as Root) as Root,[node]);
  return toJsxRuntime(tree,{Fragment,jsx,jsxs,components,ignoreInvalidStyle:true,passKeys:true,passNode:true});
}
