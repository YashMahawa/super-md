import {Fragment,jsx,jsxs} from "react/jsx-runtime";
import {toJsxRuntime} from "hast-util-to-jsx-runtime";
import {unified,type PluggableList,type Processor} from "unified";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import {defaultUrlTransform,type Components} from "react-markdown";
import {visit} from "unist-util-visit";
import type {Root} from "hast";
import {memo,useMemo,type ReactNode} from "react";
import WindowedBlock,{useWindowing} from "./WindowedBlock";
import {analyzeDocument,type SourceDocumentAnalysis} from '../documentAnalysis';

// Theme, mode and tab changes must not run KaTeX/highlighting again. Cache
// immutable, sanitized trees, with a byte estimate and LRU bound, not an
// unbounded collection of whole documents or screenshots.
const LIMIT=24_000_000;
const MAX_ENTRIES=512;
const MAX_PIPELINES=32;

interface DocumentCacheEntry {
  key:string;
  tree:Root;
  weight:number;
  blockWeight:number;
  blocks:Set<string>;
}
interface BlockLruEntry {
  id:string;
  owner:DocumentCacheEntry;
  node:object;
  pluginKey:string;
  weight:number;
}

const cache=new Map<string,DocumentCacheEntry>();
const blockLru=new Map<string,BlockLruEntry>();
const blockCache=new WeakMap<object,Map<string,Root>>();
const ownerByNode=new WeakMap<object,DocumentCacheEntry>();
const plainBlockByNode=new WeakMap<object,string>();
let retained=0;

const objectIds=new WeakMap<object,number>();
let nextObjectId=1;
function idOfObject(target:object):number {
  let id=objectIds.get(target);
  if(!id){id=nextObjectId++;objectIds.set(target,id);}
  return id;
}
function isPlainObject(value:unknown):value is Record<string,unknown> {
  if(typeof value!=="object"||value===null)return false;
  const proto=Object.getPrototypeOf(value);
  return proto===Object.prototype||proto===null;
}
function serializePluginValue(value:unknown):string {
  if(value===null||value===undefined||typeof value==="boolean"||typeof value==="number"||typeof value==="string")return JSON.stringify(value)??"undefined";
  if(typeof value==="function")return `fn#${idOfObject(value)}`;
  if(Array.isArray(value))return `[${value.map(serializePluginValue).join(",")}]`;
  if(isPlainObject(value))return `{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${serializePluginValue(value[k])}`).join(",")}}`;
  if(typeof value==="object")return `obj#${idOfObject(value)}`;
  return String(value);
}

const listKeys=new WeakMap<PluggableList,string>();
function pluggableListKey(plugins:PluggableList):string {
  const hit=listKeys.get(plugins);
  if(hit!==undefined)return hit;
  const key=serializePluginValue(plugins);
  listKeys.set(plugins,key);
  return key;
}

type HastTransformer=(tree:Root,file:unknown)=>void;
const sharedRehypeTransformers=new Map<string,HastTransformer>();
function sharedRehypePlugin(plugin:typeof rehypeKatex|typeof rehypeHighlight,options:unknown,key:string):()=>HastTransformer {
  let transformer=sharedRehypeTransformers.get(key);
  if(!transformer){
    transformer=(plugin as (opts?:unknown)=>HastTransformer)(options);
    if(sharedRehypeTransformers.size>=MAX_PIPELINES)sharedRehypeTransformers.delete(sharedRehypeTransformers.keys().next().value!);
    sharedRehypeTransformers.set(key,transformer);
  }
  const resolved=transformer;
  return ()=>resolved;
}
function normalizeRehypePlugins(plugins:PluggableList):PluggableList {
  return plugins.map(item=>{
    const fn=Array.isArray(item)?item[0]:item;
    const extra=Array.isArray(item)&&item.length>2;
    const opts=Array.isArray(item)?item[1]:undefined;
    if(opts===false||extra)return item;
    if(fn===rehypeKatex)return sharedRehypePlugin(rehypeKatex,opts,serializePluginValue([fn,opts]));
    if(fn===rehypeHighlight)return sharedRehypePlugin(rehypeHighlight,opts,serializePluginValue([fn,opts]));
    return item;
  });
}

type AnyProcessor=Processor<any,any,any,any,any>;
const markdownProcessors=new Map<string,AnyProcessor>();
function getMarkdownProcessor(remarkPlugins:PluggableList,rehypePlugins:PluggableList,pipelineKey:string):AnyProcessor {
  const hit=markdownProcessors.get(pipelineKey);
  if(hit){markdownProcessors.delete(pipelineKey);markdownProcessors.set(pipelineKey,hit);return hit;}
  const processor=unified().use(remarkParse).use(remarkPlugins).use(remarkRehype,{allowDangerousHtml:true}).use(normalizeRehypePlugins(rehypePlugins)).freeze();
  if(markdownProcessors.size>=MAX_PIPELINES)markdownProcessors.delete(markdownProcessors.keys().next().value!);
  markdownProcessors.set(pipelineKey,processor);
  return processor;
}

const rehypeProcessors=new Map<string,AnyProcessor>();
function getRehypeProcessor(rehypePlugins:PluggableList,key=pluggableListKey(rehypePlugins)):AnyProcessor {
  const hit=rehypeProcessors.get(key);
  if(hit){rehypeProcessors.delete(key);rehypeProcessors.set(key,hit);return hit;}
  const processor=unified().use(normalizeRehypePlugins(rehypePlugins)).freeze();
  if(rehypeProcessors.size>=MAX_PIPELINES)rehypeProcessors.delete(rehypeProcessors.keys().next().value!);
  rehypeProcessors.set(key,processor);
  return processor;
}

interface RehypeProfile {
  key:string;
  custom:boolean;
  katexList:PluggableList|null;
  katexKey:string;
  highlightList:PluggableList|null;
  highlightKey:string;
  katexBeforeHighlight:boolean;
  detect:boolean;
  plainText:ReadonlySet<string>;
}
const rehypeProfiles=new WeakMap<PluggableList,RehypeProfile>();
function getRehypeProfile(plugins:PluggableList):RehypeProfile {
  const hit=rehypeProfiles.get(plugins);
  if(hit)return hit;
  const key=pluggableListKey(plugins);
  let custom=false,katexIndex=-1,highlightIndex=-1,detect=false;
  let katexList:PluggableList|null=null,highlightList:PluggableList|null=null;
  let plainText:ReadonlySet<string>=new Set();
  for(let i=0;i<plugins.length;i++){
    const item=plugins[i];
    if(Array.isArray(item)&&item[1]===false)continue;
    const fn=Array.isArray(item)?item[0]:item;
    const opts=Array.isArray(item)?item[1]:undefined;
    const extra=Array.isArray(item)&&item.length>2;
    if(fn===rehypeKatex&&!extra&&katexIndex<0){
      katexIndex=i;katexList=[item];
    }else if(fn===rehypeHighlight&&!extra&&highlightIndex<0&&(opts===undefined||opts===null||isPlainObject(opts))){
      highlightIndex=i;highlightList=[item];
      detect=Boolean(opts&&(opts as {detect?:unknown}).detect);
      const pt=opts&&(opts as {plainText?:unknown}).plainText;
      plainText=new Set(Array.isArray(pt)?pt.map(String):[]);
    }else{
      custom=true;
    }
  }
  const profile:RehypeProfile={
    key,
    custom,
    katexList,
    katexKey:katexList?pluggableListKey(katexList):"",
    highlightList,
    highlightKey:highlightList?pluggableListKey(highlightList):"",
    katexBeforeHighlight:katexIndex>=0&&(highlightIndex<0||katexIndex<highlightIndex),
    detect,
    plainText,
  };
  rehypeProfiles.set(plugins,profile);
  return profile;
}

function highlightLanguage(classes:unknown):string|false|undefined {
  if(!Array.isArray(classes))return undefined;
  let name:string|undefined;
  for(let i=0;i<classes.length;i++){
    const value=String(classes[i]);
    if(value==="no-highlight"||value==="nohighlight")return false;
    if(!name&&value.startsWith("lang-"))name=value.slice(5);
    if(!name&&value.startsWith("language-"))name=value.slice(9);
  }
  return name;
}

function scanBlockNode(current:any,parentTag:string|null,state:{hasMath:boolean;hasCode:boolean},profile:RehypeProfile):void {
  if(!current)return;
  if(current.type==="element"){
    const classes=current.properties?.className;
    if(!state.hasMath&&profile.katexList&&Array.isArray(classes)){
      for(let i=0;i<classes.length;i++){
        const c=classes[i];
        if(c==="language-math"||c==="math-display"||c==="math-inline"){state.hasMath=true;break;}
      }
    }
    if(!state.hasCode&&profile.highlightList&&current.tagName==="code"&&parentTag==="pre"){
      const lang=highlightLanguage(classes);
      if(lang!==false&&((!lang&&profile.detect)||(Boolean(lang)&&!(lang==="math"&&profile.katexBeforeHighlight)&&!profile.plainText.has(lang!)))){
        state.hasCode=true;
      }
    }
    if((state.hasMath||!profile.katexList)&&(state.hasCode||!profile.highlightList))return;
  }
  const children=current.children;
  if(Array.isArray(children)){
    const nextParent=current.type==="element"?current.tagName:null;
    for(let i=0;i<children.length;i++){
      scanBlockNode(children[i],nextParent,state,profile);
      if((state.hasMath||!profile.katexList)&&(state.hasCode||!profile.highlightList))return;
    }
  }
}

function sanitizeAndMeasureHast(tree:Root,baseWeight=0):number {
  let weight=baseWeight;
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
  return weight;
}

function measureHastWeight(node:any):number {
  let weight=160+(typeof node.value==="string"?node.value.length*2:0);
  const children=node.children;
  if(Array.isArray(children)){
    for(let i=0;i<children.length;i++)weight+=measureHastWeight(children[i]);
  }
  return weight;
}

function evictOldestBlock():boolean {
  const firstId=blockLru.keys().next().value;
  if(firstId===undefined)return false;
  const entry=blockLru.get(firstId)!;
  blockLru.delete(firstId);
  entry.owner.blocks.delete(firstId);
  entry.owner.blockWeight-=entry.weight;
  retained-=entry.weight;
  const byPlugin=blockCache.get(entry.node);
  byPlugin?.delete(entry.pluginKey);
  if(byPlugin&&!byPlugin.size)blockCache.delete(entry.node);
  return true;
}

function evictDocument(docKey:string):void {
  const entry=cache.get(docKey);
  if(!entry)return;
  for(const blockId of entry.blocks){
    const block=blockLru.get(blockId);
    if(block){
      const byPlugin=blockCache.get(block.node);
      byPlugin?.delete(block.pluginKey);
      if(byPlugin&&!byPlugin.size)blockCache.delete(block.node);
      blockLru.delete(blockId);
    }
  }
  entry.blocks.clear();
  retained-=entry.weight+entry.blockWeight;
  entry.blockWeight=0;
  cache.delete(docKey);
}

export function previewCacheStats():{documents:number;blocks:number;retained:number} {
  return {documents:cache.size,blocks:blockLru.size,retained};
}
export function hasCachedBlockOutput(node:object):boolean {
  const byPlugin=blockCache.get(node);
  return Boolean(byPlugin&&byPlugin.size>0);
}

export function cachedMarkdownTree(source:string,remarkPlugins:PluggableList,rehypePlugins:PluggableList,deferred=false,sourceAnalysis?:SourceDocumentAnalysis):Root {
  const remarkKey=pluggableListKey(remarkPlugins);
  const rehypeKey=pluggableListKey(rehypePlugins);
  const pipelineKey=`${remarkKey}|${rehypeKey}`;
  const key=`${pipelineKey}:${deferred?'deferred:':'full:'}${source}`;
  const hit=cache.get(key);if(hit){cache.delete(key);cache.set(key,hit);return hit.tree;}
  const processor=getMarkdownProcessor(remarkPlugins,rehypePlugins,pipelineKey);
  const analysis=sourceAnalysis?.source===source?sourceAnalysis.analysis:analyzeDocument(source);
  const tree=processor.runSync(structuredClone(analysis.tree),source) as Root;
  const weight=sanitizeAndMeasureHast(tree,source.length*2);
  if(weight<=LIMIT){
    const entry:DocumentCacheEntry={key,tree,weight,blockWeight:0,blocks:new Set()};
    for(const child of tree.children){
      if(typeof child==="object"&&child!==null)ownerByNode.set(child,entry);
    }
    cache.set(key,entry);
    retained+=weight;
    while(cache.size+blockLru.size>MAX_ENTRIES&&blockLru.size>0)evictOldestBlock();
    while(retained>LIMIT||cache.size>MAX_ENTRIES){
      const first=cache.keys().next().value;
      if(first===undefined)break;
      evictDocument(first);
    }
  }
  return tree;
}
function resolveDeferredBlockTree(node:any,plugins:PluggableList):Root {
  if(!plugins.length||typeof node!=="object"||node===null)return {type:"root",children:[node]} as Root;
  const profile=getRehypeProfile(plugins);
  if(!profile.custom&&plainBlockByNode.get(node)===profile.key)return {type:"root",children:[node]} as Root;
  let activePlugins=plugins;
  let activeKey=profile.key;
  if(!profile.custom){
    const state={hasMath:false,hasCode:false};
    scanBlockNode(node,null,state,profile);
    if(!state.hasMath&&!state.hasCode){
      plainBlockByNode.set(node,profile.key);
      return {type:"root",children:[node]} as Root;
    }
    if(state.hasMath&&!state.hasCode&&profile.katexList){
      activePlugins=profile.katexList;activeKey=profile.katexKey;
    }else if(!state.hasMath&&state.hasCode&&profile.highlightList){
      activePlugins=profile.highlightList;activeKey=profile.highlightKey;
    }
  }
  const blockId=`${idOfObject(node)}|${activeKey}`;
  const cachedByPlugin=blockCache.get(node);
  const cachedTree=cachedByPlugin?.get(activeKey);
  if(cachedTree){
    const lruHit=blockLru.get(blockId);
    if(lruHit){blockLru.delete(blockId);blockLru.set(blockId,lruHit);}
    return cachedTree;
  }
  const expanded=getRehypeProcessor(activePlugins,activeKey).runSync({type:"root",children:[structuredClone(node)]} as Root) as Root;
  const weight=profile.custom?sanitizeAndMeasureHast(expanded,0):measureHastWeight(expanded);
  const owner=ownerByNode.get(node);
  if(owner&&cache.get(owner.key)===owner&&owner.weight+weight<=LIMIT){
    let byPlugin=blockCache.get(node);
    if(!byPlugin){byPlugin=new Map();blockCache.set(node,byPlugin);}
    byPlugin.set(activeKey,expanded);
    blockLru.set(blockId,{id:blockId,owner,node,pluginKey:activeKey,weight});
    owner.blocks.add(blockId);
    owner.blockWeight+=weight;
    retained+=weight;
    while((retained>LIMIT||cache.size+blockLru.size>MAX_ENTRIES)&&blockLru.size>1){
      const firstId=blockLru.keys().next().value!;
      if(firstId===blockId)break;
      evictOldestBlock();
    }
    while(retained>LIMIT||cache.size+blockLru.size>MAX_ENTRIES){
      const firstDoc=cache.keys().next().value;
      if(firstDoc===undefined||firstDoc===owner.key)break;
      evictDocument(firstDoc);
    }
  }
  return expanded;
}

export interface RenderedMarkdownBlock {key:string;node:any;index:number;content:ReactNode;text:string;headings:Array<{id:string;key:string}>;estimate:number;windowed:boolean}
export type MarkdownBlockRenderer=(block:RenderedMarkdownBlock)=>ReactNode;
export default function CachedMarkdown({children,remarkPlugins,rehypePlugins,components,renderBlock,windowingEnabled=true,sourceAnalysis}:{children:string;remarkPlugins:PluggableList;rehypePlugins:PluggableList;components:Components;renderBlock?:MarkdownBlockRenderer;windowingEnabled?:boolean;sourceAnalysis?:SourceDocumentAnalysis}){
  const supportsWindowing=useWindowing(),windowing=windowingEnabled&&supportsWindowing&&children.length>80_000;
  const tree=cachedMarkdownTree(children,remarkPlugins,windowing?[]:rehypePlugins,windowing,sourceAnalysis);
  const hasBlockView=Boolean(renderBlock);
  const blocks=useMemo<RenderedMarkdownBlock[]>(()=>{
    if(!windowing&&!hasBlockView)return [];
    const counts=new Map<string,number>();
    return tree.children.filter(node=>node.type!=='text'||node.value.trim()).map((node:any,index)=>{
      const kind=blockKind(node),ordinal=counts.get(kind)??0;
      counts.set(kind,ordinal+1);
      const key=`${kind}-${ordinal}`;
      const text=plainText(node);
      const content=windowing
        ?<DeferredMarkdown node={node} plugins={rehypePlugins} components={components}/>
        :toJsxRuntime({type:'root',children:[node]},{Fragment,jsx,jsxs,components,ignoreInvalidStyle:true,passKeys:true,passNode:true});
      return {key,node,index,text,content,headings:headingsOf(node),estimate:Math.min(1200,Math.max(80,text.length/65*30+(node.tagName==='pre'?220:40))),windowed:windowing};
    });
  },[tree,windowing,hasBlockView,rehypePlugins,components]);
  const fullContent=useMemo(()=>!hasBlockView&&!windowing?toJsxRuntime(tree,{Fragment,jsx,jsxs,components,ignoreInvalidStyle:true,passKeys:true,passNode:true}):null,[tree,windowing,hasBlockView,components]);
  if(renderBlock)return <>{blocks.map(block=>renderBlock(block))}</>;
  if(!windowing)return fullContent;
  return <>{blocks.map(block=><WindowedBlock key={block.key} enabled estimate={block.estimate} text={block.text} headings={block.headings} data-source-start={block.node.properties?.['data-source-start']??block.node.position?.start.offset} data-source-end={block.node.properties?.['data-source-end']??block.node.position?.end.offset}>{block.content}</WindowedBlock>)}</>;
}
function blockKind(node:any):string {
  if(node.type!=='element')return String(node.type||'node');
  if(node.tagName==='pre'){
    const lang=highlightLanguage(node.children?.[0]?.properties?.className);
    return lang?`pre:${lang}`:'pre';
  }
  return String(node.tagName);
}
function plainText(node:any):string {return node.type==='text'?node.value:(node.children||[]).map(plainText).join('')+(/^(p|li|pre|h[1-6])$/.test(node.tagName||'')?'\n':'');}
function headingsOf(node:any):Array<{id:string;key:string}> {const result:Array<{id:string;key:string}>=[];visit(node,(entry:any)=>{if(entry.type==='element'&&entry.properties?.id)result.push({id:String(entry.properties.id),key:String(entry.properties['data-heading-key']??entry.properties.id)});});return result;}
const DeferredMarkdown=memo(function DeferredMarkdown({node,plugins,components}:{node:any;plugins:PluggableList;components:Components}) {
  // Expanded KaTeX/highlighting trees are cached alongside their parent document
  // entry, while plain prose and diagram blocks render directly without cloning.
  const tree=useMemo(()=>resolveDeferredBlockTree(node,plugins),[node,plugins]);
  return toJsxRuntime(tree,{Fragment,jsx,jsxs,components,ignoreInvalidStyle:true,passKeys:true,passNode:true});
});
