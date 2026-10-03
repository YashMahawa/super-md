import {Fragment,jsx,jsxs} from "react/jsx-runtime";
import {toJsxRuntime} from "hast-util-to-jsx-runtime";
import {unified,type PluggableList} from "unified";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import {defaultUrlTransform,type Components} from "react-markdown";
import {visit} from "unist-util-visit";
import type {Root} from "hast";

// Theme, mode and tab changes must not run KaTeX/highlighting again. Cache
// immutable, sanitized trees, with a byte estimate and LRU bound, not an
// unbounded collection of whole documents or screenshots.
const cache=new Map<string,{tree:Root;weight:number}>();let retained=0;
const LIMIT=24_000_000;
export function cachedMarkdownTree(source:string,remarkPlugins:PluggableList,rehypePlugins:PluggableList):Root {
  const hit=cache.get(source);if(hit){cache.delete(source);cache.set(source,hit);return hit.tree;}
  const processor=unified().use(remarkParse).use(remarkPlugins).use(remarkRehype,{allowDangerousHtml:true}).use(rehypePlugins);
  const tree=processor.runSync(processor.parse(source)) as Root;let weight=source.length*2;
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
  if(weight<=LIMIT){cache.set(source,{tree,weight});retained+=weight;while(retained>LIMIT||cache.size>512){const first=cache.keys().next().value!;retained-=cache.get(first)!.weight;cache.delete(first);}}
  return tree;
}
export default function CachedMarkdown({children,remarkPlugins,rehypePlugins,components}:{children:string;remarkPlugins:PluggableList;rehypePlugins:PluggableList;components:Components}){
  return toJsxRuntime(cachedMarkdownTree(children,remarkPlugins,rehypePlugins),{Fragment,jsx,jsxs,components,ignoreInvalidStyle:true,passKeys:true,passNode:true});
}
