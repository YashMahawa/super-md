import {visit} from 'unist-util-visit';
import {headingSlug} from './headingSlug';

interface Edit {start:number;end:number;text:string}
interface Stage {value:string;originalOffset:(offset:number)=>number}
function replaceStage(source:string,edits:Edit[]):Stage {
  const chunks:string[]=[],mapping:Array<{start:number;end:number;from:number;to:number;delta:number}>=[];
  let previous=0,delta=0;
  for(const edit of edits){
    chunks.push(source.slice(previous,edit.start),edit.text);
    const start=edit.start+delta;delta+=edit.text.length-(edit.end-edit.start);
    mapping.push({start,end:start+edit.text.length,from:edit.start,to:edit.end,delta});previous=edit.end;
  }
  chunks.push(source.slice(previous));
  return {value:chunks.join(''),originalOffset(offset){
    let low=0,high=mapping.length;
    while(low<high){const mid=(low+high)>>>1;if(mapping[mid].start<=offset)low=mid+1;else high=mid;}
    const edit=mapping[low-1];
    if(!edit)return offset;
    if(offset>=edit.end)return offset-edit.delta;
    return edit.from+Math.min(offset-edit.start,edit.to-edit.from);
  }};
}
function regexStage(source:string,regex:RegExp,replacement:(...args:any[])=>string):Stage {
  const edits:Edit[]=[];
  source.replace(regex,(...args:any[])=>{const start=args[args.length-2] as number;edits.push({start,end:start+args[0].length,text:replacement(...args)});return args[0];});
  return replaceStage(source,edits);
}

/** Render-only syntax normalization with a sparse offset map. Source positions
 * always address the original note, including frontmatter and wiki/callout edits. */
export function normalizeMarkdownSource(markdown:string):Stage {
  const stages:Stage[]=[];let value=markdown;
  const add=(stage:Stage)=>{stages.push(stage);value=stage.value;};
  add(regexStage(value,/^---\r?\n[\s\S]*?\r?\n---\r?\n/,()=>''));
  add(regexStage(value,/!\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,(_all,path,label)=>`![${label??path}](${encodeURI(path)})`));
  add(regexStage(value,/\[\[(#[\s\S]*?)\]\]/g,(_all,target:string)=>{const [id,label]=target.split('|');return `[${label||id.slice(1)}](#${headingSlug(id.slice(1))})`;}));
  add(regexStage(value,/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,(_all,target,label)=>`[${label??target}](${target.endsWith('.md')?target:`${target}.md`})`));
  const edits:Edit[]=[];let offset=0,current=false;
  for(const line of value.split('\n')){
    const start=line.match(/^:::callout\s+(\w+)(?:\s+(.+))?\s*$/i);
    if(start&&!current){current=true;edits.push({start:offset,end:offset+line.length,text:`> [!${start[1].toUpperCase()}] ${start[2]?.replace(/^['"]|['"]$/g,'')||start[1]}`});}
    else if(line.trim()===':::'&&current){current=false;edits.push({start:offset,end:offset+line.length,text:''});}
    else if(current)edits.push({start:offset,end:offset,text:'> '});
    offset+=line.length+1;
  }
  add(replaceStage(value,edits));
  return {value,originalOffset(offset){for(let i=stages.length-1;i>=0;i--)offset=stages[i].originalOffset(offset);return offset;}};
}
export function normalizeCallouts(markdown:string):string{return normalizeMarkdownSource(markdown).value;}

export function remarkSourceSyntax(this:any){
  const parser=this.parser;
  this.parser=(source:string,file:any)=>{
    const normalized=normalizeMarkdownSource(source),tree=parser(normalized.value,file);
    if(normalized.value===source)return tree;
    const lines=[0];for(let i=0;i<source.length;i++)if(source[i]==='\n')lines.push(i+1);
    const point=(value:any)=>{const offset=normalized.originalOffset(value.offset);let low=0,high=lines.length;while(low<high){const mid=(low+high)>>>1;if(lines[mid]<=offset)low=mid+1;else high=mid;}return {offset,line:low,column:offset-lines[low-1]+1};};
    visit(tree,(node:any)=>{if(node.position)node.position={start:point(node.position.start),end:point(node.position.end)};});
    return tree;
  };
}
