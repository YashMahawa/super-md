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
import {normalizeMarkdownSource} from './markdownSource';
const svgUri=(source:string)=>'data:image/svg+xml;base64,'+btoa(Array.from(new TextEncoder().encode(svgImage(source)),v=>String.fromCharCode(v)).join(''));
const label=(value:string)=>value.replace(/[\\[\]*_`]/g,'\\$&').replace(/[\r\n]+/g,' ');
const image=(source:string,alt='Diagram')=>`![${label(alt)}](<${source}>)`;
export async function compatibleMarkdown(markdown:string,documentPath:string|null,depth=0):Promise<string>{
 if(depth>5)throw Error('Nested step content is too deep to export.');
 if(/^:::callout\s/m.test(markdown)){
  const front=markdown.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/)?.[0]||'';
  markdown=front+normalizeMarkdownSource(markdown).value;
 }
 const tree=unified().use(remarkParse).use(remarkGfm).use(remarkMath).use(remarkObsidianMath).parse(markdown);
 const blocks:any[]=[];
 visit(tree,(node:any)=>{if(node.position&&(node.type==='code'||node.type==='html'&&/^\s*<svg\b/i.test(node.value)))blocks.push(node);});
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
    else if(step.chart)parts.push(await compatibleMarkdown('```smd-chart\n'+step.chart+'\n```',documentPath,depth+1));
    if(step.markdown)parts.push(await compatibleMarkdown(step.markdown,documentPath,depth+1));
    else if(step.description)parts.push(step.description);
   }
   value=parts.join('\n\n');
  }else if(lang==='svg')value=image(svgUri(node.value));
  else if(lang==='smd-tree'||lang==='smd-diagram'){
   const diagram=lang==='smd-tree'?parseBinaryTreeSource(node.value):parseDiagramSource(node.value);
   if(!diagram)throw Error('Invalid diagram; fix it before exporting.');
   value=image(svgUri(stepDiagramSvg(diagram)),diagram.title||'Diagram');
  }else if(['smd-chart','python','py'].includes(lang)){
   // Reuse the checked static renderer and saved-output reader. Never run code.
   const {preparePdf}=await import('./preparePdf');
   const prepared=await preparePdf('```'+lang+'\n'+node.value+'\n```',documentPath);
   value=prepared.content;
   if(lang==='smd-chart'&&/```json/.test(value))throw Error('This retired 3D chart has no static snapshot; replace it with a figure before sharing.');
   for(const [name,body] of Object.entries(prepared.assets)){
    const ext=name.split('.').pop();const mime=ext==='svg'?'svg+xml':ext==='jpg'?'jpeg':'png';
    value=value.replaceAll(name,'data:image/'+mime+';base64,'+body);
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
