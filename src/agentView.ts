import type {Root} from 'mdast';
import {analyzeDocument} from './documentAnalysis';
import {agentCharLength,agentCodePointOffset,countCodePointsRange,hasUnicodeIndex} from './agentOperations';
import type {ExportableMedia} from './mediaExport';
import {mediaAt} from './mediaExport';
import {invoke} from './nativeBridge';
import {parseStepDeck} from './components/StepCards';
import {parseDiagramSource} from './components/InlineDiagram';
import {parseBinaryTreeSource} from './components/BinaryTree';
import {stepDiagramSvg} from './stepPdf';
import {inspectCachedPythonOutput,safePythonFigure} from './renderedOutputs';
export interface AgentDiagram {id:string;kind:string;source:string;start:number;end:number;sourceStart?:number;sourceEnd?:number;url?:string;label?:string;deckTitle?:string;stepLabel?:string;stepIndex?:number;stepCount?:number;activeStep?:boolean}
export interface AgentDiagramOptions {documentPath?:string|null;python?:string;range?:{start:number;end:number}|null}
const definitionCache=new WeakMap<Root,Map<string,string>>();
function documentDefinitions(tree:Root):Map<string,string>{
  const cached=definitionCache.get(tree);if(cached)return cached;
  const definitions=new Map<string,string>();
  const definitionsIn=(node:any)=>{
    if(node.type==='definition'){definitions.set(node.identifier,node.url);return;}
    if(node.type==='paragraph'||node.type==='heading'||node.type==='code'||node.type==='table')return;
    for(const child of node.children??[])definitionsIn(child);
  };
  definitionsIn(tree);definitionCache.set(tree,definitions);return definitions;
}
function isRangeOnly(value:AgentDiagramOptions|{start:number;end:number}|null|undefined):value is {start:number;end:number}{
  return !!value&&typeof (value as {start?:unknown}).start==='number'&&typeof (value as {end?:unknown}).end==='number';
}
/** Stable for this source revision; IDs avoid transmitting large artwork. */
export function agentDiagrams(source:string,options?:AgentDiagramOptions|{start:number;end:number}|null):AgentDiagram[]{
  const resolved:AgentDiagramOptions|undefined=isRangeOnly(options)?{range:options}:options??undefined;
  const range=resolved?.range??null;
  if(range&&range.end<=range.start)return [];
  const hasExecContext=!!resolved&&('documentPath' in resolved||'python' in resolved);
  const result:AgentDiagram[]=[],analysis=analyzeDocument(source),tree=analysis.tree,definitions=documentDefinitions(tree);
  const indexed=hasUnicodeIndex(source);
  let cursorUtf16=range?-1:0,cursorCp=0,pythonOrdinal=0;
  const cursorTo=(targetUtf16:number):number=>{
    if(cursorUtf16<0||targetUtf16<cursorUtf16||(indexed&&targetUtf16-cursorUtf16>1024)){
      cursorUtf16=targetUtf16;cursorCp=agentCodePointOffset(source,targetUtf16);return cursorCp;
    }
    if(targetUtf16===cursorUtf16)return cursorCp;
    let delta=countCodePointsRange(source,cursorUtf16,targetUtf16);
    if(cursorUtf16>0){
      const high=source.charCodeAt(cursorUtf16-1),low=source.charCodeAt(cursorUtf16);
      if(high>=0xd800&&high<=0xdbff&&low>=0xdc00&&low<=0xdfff)delta--;
    }
    cursorUtf16=targetUtf16;cursorCp+=delta;return cursorCp;
  };
  const walk=(node:any)=>{
    if(range&&node.position&&(node.position.end.offset<=range.start||node.position.start.offset>=range.end))return;
    if(node.type==='code'&&['svg','mermaid','smd-chart','smd-tree','smd-diagram'].includes(node.lang)&&node.position){
      const startOffset=node.position.start.offset,endOffset=node.position.end.offset;
      const sourceStart=cursorTo(startOffset),sourceEnd=cursorTo(endOffset);
      result.push({id:`diagram:${sourceStart}`,kind:node.lang,source:node.value,start:startOffset,end:endOffset,sourceStart,sourceEnd});
    }
    if(node.type==='code'&&['python','py'].includes(String(node.lang||'').toLowerCase())&&node.position){
      const startOffset=node.position.start.offset,endOffset=node.position.end.offset;
      const pyIndex=analysis.pythonCells.findIndex(cell=>cell.offset===startOffset&&cell.source===String(node.value||''));
      const cellIndex=pyIndex>=0?pyIndex:pythonOrdinal++;
      const duplicateOrdinal=pyIndex>=0?analysis.pythonCells[pyIndex].ordinal:0;
      const cached=inspectCachedPythonOutput(node.value,{...(hasExecContext?{document:resolved?.documentPath??null}:{}),cell:String(duplicateOrdinal),interpreter:resolved?.python});
      const figures=cached?.images.filter(safePythonFigure).slice(0,16);
      if(figures?.length){
        const sourceStart=cursorTo(startOffset),sourceEnd=cursorTo(endOffset);
        figures.forEach((figure,index)=>{
          result.push({id:`diagram:python:${sourceStart}:${index}`,kind:'python-figure',url:figure,label:`Python cell ${cellIndex+1} — Figure ${index+1}`,source:node.value,start:startOffset,end:endOffset,sourceStart,sourceEnd});
        });
      }
    }
    if(node.type==='code'&&node.lang==='smd-steps'&&node.position){
      const startOffset=node.position.start.offset,endOffset=node.position.end.offset;
      const deck=parseStepDeck(node.value),sourceStart=cursorTo(startOffset),sourceEnd=cursorTo(endOffset);
      deck?.steps.forEach((step,index)=>{
        if(!step.image&&!step.diagram&&!step.chart)return;
        const kind=step.image?'image':step.diagram?'smd-diagram':'smd-chart';
        result.push({id:`diagram:step:${sourceStart}:${index}`,kind,source:step.image?JSON.stringify({image:step.image,alt:step.alt||step.label}):step.diagram?JSON.stringify(step.diagram):step.chart!,start:startOffset,end:endOffset,sourceStart,sourceEnd,...(step.image?{url:step.image}:{}),label:`${deck.title} — ${step.label}`,deckTitle:deck.title,stepLabel:step.label,stepIndex:index,stepCount:deck.steps.length});
      });
    }
    if(['image','imageReference'].includes(node.type)&&node.position){
      const url=node.type==='image'?node.url:definitions.get(node.identifier);
      if(url){
        const startOffset=node.position.start.offset,endOffset=node.position.end.offset;
        const sourceStart=cursorTo(startOffset),sourceEnd=cursorTo(endOffset);
        result.push({id:`diagram:image:${sourceStart}`,kind:'image',url,label:node.alt||'Image',source:source.slice(startOffset,endOffset),start:startOffset,end:endOffset,sourceStart,sourceEnd});
      }
    }
    for(const child of node.children??[])walk(child);
  };
  walk(tree);return result;
}
export function diagramMetadata(source:string,diagram:AgentDiagram){
  const sourceStart=diagram.sourceStart??agentCodePointOffset(source,diagram.start);
  const sourceEnd=diagram.sourceEnd??agentCodePointOffset(source,diagram.end);
  return {id:diagram.id,kind:diagram.kind,sourceStart,sourceEnd,sourceChars:agentCharLength(diagram.source),preview:diagram.label||(diagram.kind==='svg'?'SVG drawing':diagram.source.slice(0,160)),...(diagram.deckTitle?{deckTitle:diagram.deckTitle,stepLabel:diagram.stepLabel,stepIndex:diagram.stepIndex,stepCount:diagram.stepCount}:{}),...(diagram.activeStep!==undefined?{activeStep:diagram.activeStep}:{}),...(diagram.url?{assetReference:diagram.url.startsWith('data:')?'(embedded image)':diagram.url.slice(0,512)}:{})};
}
export async function diagramMedia(diagram:AgentDiagram,documentPath:string|null=null):Promise<ExportableMedia>{
  if(diagram.kind==='image'||diagram.kind==='python-figure'){
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
  if(diagram.kind==='smd-tree'||diagram.kind==='smd-diagram'){
    const parsed=diagram.kind==='smd-tree'?parseBinaryTreeSource(diagram.source):parseDiagramSource(diagram.source);
    if(!parsed)throw Error('Invalid diagram source');
    return {label:diagram.label||parsed.title||'Diagram',svg:()=>stepDiagramSvg(parsed)};
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
