/** Flatten Super MD-only presentation blocks for Obsidian/CommonMark readers. */
import {unified} from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import {remarkObsidianMath} from './obsidianMath';
import {visit} from 'unist-util-visit';
import {parseStepDeck} from './components/StepCards';
import {parseDiagramSource} from './components/InlineDiagram';
import {parseBinaryTreeSource} from './components/BinaryTree';
import {stepDiagramSvg} from './stepPdf';
import {svgImage} from './svgImage';
import {normalizeCalloutBlocks} from './markdownSource';
import {maskFrontmatter,parseFrontmatter} from './frontmatter';
import {looksLikeSvg,remarkSvgBlocks} from './svgBlocks';
import {pythonOutput} from './renderedOutputs';
const svgUri=(source:string)=>'data:image/svg+xml;base64,'+btoa(Array.from(new TextEncoder().encode(svgImage(source)),v=>String.fromCharCode(v)).join(''));
const label=(value:string)=>value.replace(/[\\[\]*_`]/g,'\\$&').replace(/[\r\n]+/g,' ');
const image=(source:string,alt='Diagram')=>`![${label(alt)}](<${source}>)`;
const codeFence=(text:string)=>'`'.repeat(Math.max(3,...Array.from(text.matchAll(/`+/g),m=>m[0].length+1)));
export async function compatibleMarkdown(markdown:string,documentPath:string|null,python='embedded',depth=0):Promise<string>{
 if(depth>5)throw Error('Nested step content is too deep to export.');
 markdown=normalizeCalloutBlocks(markdown).value;
 const frontmatterEnd=parseFrontmatter(markdown)?.end??0;
 const masked=maskFrontmatter(markdown);
 const processor=unified().use(remarkParse).use(remarkGfm).use(remarkMath).use(remarkObsidianMath);
 const tree=remarkSvgBlocks()(processor.parse(masked),{value:masked});
 const blocks:any[]=[];
 visit(tree,(node:any)=>{if(node.position&&node.position.start.offset>=frontmatterEnd&&(node.type==='code'||node.type==='html'&&looksLikeSvg(node.value)))blocks.push(node);});
 const pythonOrdinals=new Map<string,number>();
 const edits:Array<{start:number;end:number;value:string}>=[];
 for(const node of blocks){
  const lang=node.type==='html'?'svg':String(node.lang||'').toLowerCase();let value:string|undefined;
  if(lang==='smd-steps'){
   const deck=parseStepDeck(node.value);if(!deck)throw Error('Invalid step sequence; fix it before exporting.');
   const parts=[`**${label(deck.title)}**`];
   for(const step of deck.steps){
    parts.push(`**${label(step.label)}**`);
    if(step.image)parts.push(image(step.image,step.alt||step.label));
    else if(step.diagram)parts.push(image(svgUri(stepDiagramSvg(step.diagram)),step.alt||step.label));
    else if(step.chart)parts.push(await compatibleMarkdown('```smd-chart\n'+step.chart+'\n```',documentPath,python,depth+1));
    if(step.markdown)parts.push(await compatibleMarkdown(step.markdown,documentPath,python,depth+1));
    else if(step.description)parts.push(step.description);
   }
   value=parts.join('\n\n');
  }else if(lang==='svg')value=image(svgUri(node.value));
  else if(lang==='smd-tree'||lang==='smd-diagram'){
   const diagram=lang==='smd-tree'?parseBinaryTreeSource(node.value):parseDiagramSource(node.value);
   if(!diagram)throw Error('Invalid diagram; fix it before exporting.');
   value=image(svgUri(stepDiagramSvg(diagram)),diagram.title||'Diagram');
  }else if(lang==='smd-chart'){
   // Reuse the checked static chart renderer. Never run code.
   const {preparePdf}=await import('./preparePdf');
   const prepared=await preparePdf('```smd-chart\n'+node.value+'\n```',documentPath,python);
   value=prepared.content.replace(/\r?\n$/,'');
   if(/```json/.test(value))throw Error('This retired 3D chart has no static snapshot; replace it with a figure before sharing.');
   for(const [name,body] of Object.entries(prepared.assets)){
    const ext=name.split('.').pop();const mime=ext==='svg'?'svg+xml':ext==='jpg'?'jpeg':'png';
    value=value.replaceAll(name,'data:image/'+mime+';base64,'+body);
   }
  }else if(lang==='python'||lang==='py'){
   const source=String(node.value||''),ordinal=pythonOrdinals.get(source)||0;
   pythonOrdinals.set(source,ordinal+1);
   const pythonContext=documentPath?{document:documentPath,cell:String(ordinal),interpreter:python||'embedded'}:undefined;
   const output=await pythonOutput(source,pythonContext);
   if(output&&!output.ok)throw Error(`Python cell failed; fix it before exporting:\n${output.stderr}`);
   if(output?.ok){
    const fence=codeFence(source);
    const parts=[`${fence}python\n${source.replace(/\n$/,'')}\n${fence}`];
    const warning=output.provenance?.unsaved?'Execution output was not saved to the local output store.':!output.provenance?.verified?'Unverified saved output: its document and runtime provenance could not be confirmed.':null;
    if(warning)parts.push(`*${warning}*`);
    if(output.stdout){
     const outFence=codeFence(output.stdout);
     parts.push(`${outFence}text\n${output.stdout.replace(/\n$/,'')}\n${outFence}`);
    }
    for(const img of output.images)parts.push(image(img,'Matplotlib figure'));
    value=parts.join('\n\n').split('\n').map(line=>line?`> ${line}`:'>').join('\n');
   }
  }
  else if(lang.startsWith('smd-'))throw Error(`Unsupported custom block ${lang}; replace it with a static figure before sharing.`);
  if(value!==undefined){
   const start=node.position.start.offset;
   const prefix=markdown.slice(markdown.lastIndexOf('\n',start-1)+1,start);
   if(prefix&&/^[ >\t]*$/.test(prefix))value=value.replace(/\n/g,'\n'+prefix);
   edits.push({start,end:node.position.end.offset,value});
  }
 }
 let content=markdown;
 for(const edit of edits.sort((a,b)=>b.start-a.start))content=content.slice(0,edit.start)+edit.value+content.slice(edit.end);
 return content;
}
