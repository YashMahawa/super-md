import {analyzeDocument} from './documentAnalysis';
import {agentCharLength} from './agentOperations';
import type {ExportableMedia} from './mediaExport';
import {mediaAt} from './mediaExport';
import {invoke} from './nativeBridge';
export interface AgentDiagram {id:string;kind:string;source:string;start:number;end:number;url?:string;label?:string}
/** Stable for this source revision; IDs avoid transmitting large artwork. */
export function agentDiagrams(source:string):AgentDiagram[]{
  const result:AgentDiagram[]=[],tree=analyzeDocument(source).tree;
  const definitions=new Map<string,string>();
  const definitionsIn=(node:any)=>{if(node.type==='definition')definitions.set(node.identifier,node.url);for(const child of node.children??[])definitionsIn(child);};definitionsIn(tree);
  const walk=(node:any)=>{
    if(node.type==='code'&&['svg','mermaid','smd-chart'].includes(node.lang)&&node.position){
      result.push({id:`diagram:${node.position.start.offset}`,kind:node.lang,source:node.value,start:node.position.start.offset,end:node.position.end.offset});
    }
    if(['image','imageReference'].includes(node.type)&&node.position){
      const url=node.type==='image'?node.url:definitions.get(node.identifier);
      if(url)result.push({id:`diagram:image:${node.position.start.offset}`,kind:'image',url,label:node.alt||'Image',source:source.slice(node.position.start.offset,node.position.end.offset),start:node.position.start.offset,end:node.position.end.offset});
    }
    for(const child of node.children??[])walk(child);
  };
  walk(tree);return result;
}
export function diagramMetadata(source:string,diagram:AgentDiagram){
  return {id:diagram.id,kind:diagram.kind,sourceStart:agentCharLength(source.slice(0,diagram.start)),sourceEnd:agentCharLength(source.slice(0,diagram.end)),sourceChars:agentCharLength(diagram.source),preview:diagram.kind==='svg'?'SVG drawing':diagram.kind==='image'?diagram.label:diagram.source.slice(0,160),...(diagram.url?{assetReference:diagram.url.startsWith('data:')?'(embedded image)':diagram.url.slice(0,512)}:{})};
}
export async function diagramMedia(diagram:AgentDiagram,documentPath:string|null=null):Promise<ExportableMedia>{
  if(diagram.kind==='image'){
    for(const element of document.querySelectorAll<HTMLElement>('[data-note-image-source]')){
      if(element.dataset.noteImageSource===diagram.url){const loaded=mediaAt(element.querySelector('img'));if(loaded)return loaded;}
    }
    const source=diagram.url!;
    if(/^https?:\/\//i.test(source))throw Error('Load this remote image in the app before requesting its pixels');
    const uri=source.startsWith('data:')?source:await invoke<string>('load_asset',{documentPath:documentPath||'',source});
    if(uri.startsWith('data:image/svg+xml')){
      const comma=uri.indexOf(','),svg=uri.slice(0,comma).includes(';base64')?new TextDecoder().decode(Uint8Array.from(atob(uri.slice(comma+1)),char=>char.charCodeAt(0))):decodeURIComponent(uri.slice(comma+1));
      return {label:diagram.label||'Image',svg:()=>svg};
    }
    return {label:diagram.label||'Image',uri:()=>uri};
  }
  if(diagram.kind==='svg')return {label:'SVG drawing',svg:()=>diagram.source};
  if(diagram.kind==='mermaid'){const {renderMermaid}=await import('./mermaidRenderer');return {label:'Mermaid diagram',svg:()=>renderMermaid(diagram.source,false)};}
  const [{renderToStaticMarkup},{createElement},{default:Chart},{neutralChartSvg}]=await Promise.all([import('react-dom/server'),import('react'),import('./components/InteractiveChart'),import('./mediaExport')]);
  const html=renderToStaticMarkup(createElement(Chart,{source:diagram.source,dark:false})),parsedDocument=new DOMParser().parseFromString(html,'text/html'),svg=parsedDocument.querySelector('svg');
  if(!svg)throw Error(parsedDocument.querySelector('.render-error')?.textContent??'Cannot render this chart');
  return {label:'Chart',svg:()=>neutralChartSvg(svg)};
}
export function visibleSourceRange(host:HTMLElement,source:string):{start:number;end:number}|null {
  const bounds=host.getBoundingClientRect(),startCandidates:number[]=[],endCandidates:number[]=[];
  for(const element of host.querySelectorAll<HTMLElement>('[data-source-start][data-source-end]')){
    const rect=element.getBoundingClientRect();if(!rect.height||rect.bottom<=bounds.top||rect.top>=bounds.bottom||rect.right<=bounds.left||rect.left>=bounds.right)continue;
    const start=Number(element.dataset.sourceStart),end=Number(element.dataset.sourceEnd);
    if(Number.isInteger(start)&&Number.isInteger(end)&&start>=0&&end>start&&end<=source.length){startCandidates.push(start);endCandidates.push(end);}
  }
  return startCandidates.length?{start:Math.min(...startCandidates),end:Math.max(...endCandidates)}:null;
}
