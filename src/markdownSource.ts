import {visit} from 'unist-util-visit';
import {parseFrontmatter} from './frontmatter';
import {encodeMarkdownDestination,formatWikilinkMarkdown,isLikelyInlineLinkDestination,parseOriginalWikilinkSlice} from './workspaceLinks';

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

const CALLOUT_START=/^:::callout\s+([\w-]+)(?:\s+(.+))?\s*$/i;
const THEMATIC_BREAK=/^(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const TABLE_DELIMITER=/^(?:\|[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?|:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)+\|?)[ \t]*$/;

interface LinePrefix {quoteDepth:number;pos:number;baseCol:number;indent:number;contentPos:number}
interface ClassifiedLine {start:number;end:number;quoteDepth:number;rest:string;kind:'fence'|'indented'|'blank'|'single'|'paraStart'|'paraCont'|'tableRow';codeStart:number}

function scanLinePrefix(line:string,maxQuotes=Infinity):LinePrefix {
  let pos=0,col=0,baseCol=0,quoteDepth=0;
  while(quoteDepth<maxQuotes&&pos<line.length){
    let nextPos=pos,nextCol=col;
    while(nextPos<line.length&&(line[nextPos]===' '||line[nextPos]==='\t')){
      const step=line[nextPos]==='\t'?4-(nextCol%4):1;
      if(nextCol+step-baseCol>3)break;
      nextCol+=step;nextPos++;
    }
    if(line[nextPos]!=='>')break;
    quoteDepth++;pos=nextPos+1;col=nextCol+1;
    if(line[pos]===' '){pos++;col++;baseCol=col;}
    else if(line[pos]==='\t')baseCol=col+1;
    else baseCol=col;
  }
  let contentPos=pos,contentCol=col;
  while(contentPos<line.length&&(line[contentPos]===' '||line[contentPos]==='\t')){
    contentCol+=line[contentPos]==='\t'?4-(contentCol%4):1;contentPos++;
  }
  return {quoteDepth,pos,baseCol,indent:contentCol-baseCol,contentPos};
}

function isValidFenceOpen(rest:string):{char:string;length:number}|null {
  const match=/^(`{3,}|~{3,})(.*)$/.exec(rest);
  if(!match||(match[1][0]==='`'&&match[2].includes('`')))return null;
  return {char:match[1][0],length:match[1].length};
}

function classifyMarkdownLines(source:string):ClassifiedLine[] {
  const rawLines=source.split('\n'),result:ClassifiedLine[]=[];
  let offset=0,inParagraph=false,prevQuoteDepth=0;
  let fence:{char:string;length:number;quoteDepth:number;listOffset:number}|null=null;
  const listStack:Array<{quoteDepth:number;contentIndent:number}>=[];
  for(const raw of rawLines){
    const line=raw.endsWith('\r')?raw.slice(0,-1):raw,start=offset,end=start+line.length;
    offset+=raw.length+1;
    if(fence){
      const p=scanLinePrefix(line,fence.quoteDepth);
      if(p.quoteDepth<fence.quoteDepth||(p.contentPos<line.length&&p.indent<fence.listOffset)){
        fence=null;
      }else{
        const effIndent=p.indent-fence.listOffset,rest=line.slice(p.contentPos);
        const close=effIndent>=0&&effIndent<=3?/^(`{3,}|~{3,})[ \t]*$/.exec(rest):null;
        if(close&&close[1][0]===fence.char&&close[1].length>=fence.length)fence=null;
        inParagraph=false;prevQuoteDepth=p.quoteDepth;
        result.push({start,end,quoteDepth:p.quoteDepth,rest,kind:'fence',codeStart:start});
        continue;
      }
    }
    const p=scanLinePrefix(line),rest=line.slice(p.contentPos),isBlank=p.contentPos===line.length;
    while(listStack.length&&listStack[listStack.length-1].quoteDepth>p.quoteDepth)listStack.pop();
    if(isBlank){
      inParagraph=false;prevQuoteDepth=p.quoteDepth;
      result.push({start,end,quoteDepth:p.quoteDepth,rest,kind:'blank',codeStart:end});
      continue;
    }
    if(p.quoteDepth>prevQuoteDepth)inParagraph=false;
    if(!inParagraph){
      while(listStack.length&&listStack[listStack.length-1].quoteDepth===p.quoteDepth&&p.indent<listStack[listStack.length-1].contentIndent)listStack.pop();
    }else{
      let parentIndent=0;
      for(let s=listStack.length-1;s>=0&&listStack[s].quoteDepth===p.quoteDepth;s--){
        if(listStack[s].contentIndent<=p.indent){parentIndent=listStack[s].contentIndent;break;}
      }
      if(p.indent-parentIndent<=3&&(isValidFenceOpen(rest)||THEMATIC_BREAK.test(rest)||/^#{1,6}(?:[ \t]+|$)/.test(rest)||(p.quoteDepth===0&&p.indent===0&&CALLOUT_START.test(line))||(p.quoteDepth===0&&rest.trim()===':::')||/^([-+*]|1[.)])[ \t]+\S/.test(rest))){
        while(listStack.length&&listStack[listStack.length-1].quoteDepth===p.quoteDepth&&p.indent<listStack[listStack.length-1].contentIndent)listStack.pop();
      }
    }
    const activeList=listStack.length&&listStack[listStack.length-1].quoteDepth===p.quoteDepth?listStack[listStack.length-1]:undefined;
    const listOffset=activeList?activeList.contentIndent:0,effIndent=p.indent-listOffset;
    if(!inParagraph&&effIndent>=4){
      prevQuoteDepth=p.quoteDepth;
      result.push({start,end,quoteDepth:p.quoteDepth,rest,kind:'indented',codeStart:start+p.pos});
      continue;
    }
    const openFence=effIndent>=0&&effIndent<=3?isValidFenceOpen(rest):null;
    if(openFence){
      fence={...openFence,quoteDepth:p.quoteDepth,listOffset};
      inParagraph=false;prevQuoteDepth=p.quoteDepth;
      result.push({start,end,quoteDepth:p.quoteDepth,rest,kind:'fence',codeStart:start});
      continue;
    }
    if(p.quoteDepth===0&&p.indent===0&&CALLOUT_START.test(line)){
      inParagraph=true;prevQuoteDepth=0;
      result.push({start,end,quoteDepth:0,rest,kind:'single',codeStart:end});
      continue;
    }
    if(p.quoteDepth===0&&effIndent<=3&&rest.trim()===':::'){
      inParagraph=false;prevQuoteDepth=0;
      result.push({start,end,quoteDepth:0,rest,kind:'blank',codeStart:end});
      continue;
    }
    if(inParagraph&&effIndent>=0&&effIndent<=3&&p.quoteDepth===prevQuoteDepth&&/^(?:=+|-+)[ \t]*$/.test(rest)){
      inParagraph=false;prevQuoteDepth=p.quoteDepth;
      result.push({start,end,quoteDepth:p.quoteDepth,rest,kind:'blank',codeStart:end});
      continue;
    }
    if(effIndent>=0&&effIndent<=3&&THEMATIC_BREAK.test(rest)){
      inParagraph=false;prevQuoteDepth=p.quoteDepth;
      result.push({start,end,quoteDepth:p.quoteDepth,rest,kind:'blank',codeStart:end});
      continue;
    }
    if(effIndent>=0&&effIndent<=3&&/^#{1,6}(?:[ \t]+|$)/.test(rest)){
      inParagraph=false;prevQuoteDepth=p.quoteDepth;
      result.push({start,end,quoteDepth:p.quoteDepth,rest,kind:'single',codeStart:end});
      continue;
    }
    const listMatch=effIndent>=0&&effIndent<=3?/^([-+*]|(\d{1,9})[.)])(?:([ \t]+)(.*)|())$/.exec(rest):null;
    if(listMatch&&(!inParagraph||(listMatch[4]&&(!listMatch[2]||listMatch[2]==='1')))){
      while(listStack.length&&listStack[listStack.length-1].quoteDepth===p.quoteDepth&&p.indent<listStack[listStack.length-1].contentIndent)listStack.pop();
      const markerWidth=listMatch[1].length,markerEndCol=p.baseCol+p.indent+markerWidth;
      const spaces=listMatch[3]||'',itemRest=listMatch[4]||'';
      if(!itemRest){
        listStack.push({quoteDepth:p.quoteDepth,contentIndent:p.indent+markerWidth+1});
        inParagraph=false;prevQuoteDepth=p.quoteDepth;
        result.push({start,end,quoteDepth:p.quoteDepth,rest,kind:'blank',codeStart:end});
        continue;
      }
      let afterCol=markerEndCol;
      for(let s=0;s<spaces.length;s++)afterCol+=spaces[s]==='\t'?4-(afterCol%4):1;
      const spaceCols=afterCol-markerEndCol;
      if(spaceCols>=5){
        listStack.push({quoteDepth:p.quoteDepth,contentIndent:p.indent+markerWidth+1});
        inParagraph=false;prevQuoteDepth=p.quoteDepth;
        result.push({start,end,quoteDepth:p.quoteDepth,rest,kind:'indented',codeStart:start+p.contentPos+markerWidth+1});
        continue;
      }
      const contentIndent=afterCol-p.baseCol;
      listStack.push({quoteDepth:p.quoteDepth,contentIndent});
      const itemFence=isValidFenceOpen(itemRest);
      if(itemFence){
        fence={...itemFence,quoteDepth:p.quoteDepth,listOffset:contentIndent};
        inParagraph=false;prevQuoteDepth=p.quoteDepth;
        result.push({start,end,quoteDepth:p.quoteDepth,rest,kind:'fence',codeStart:start+p.contentPos+markerWidth+spaces.length});
        continue;
      }
      if(/^#{1,6}(?:[ \t]+|$)/.test(itemRest)||THEMATIC_BREAK.test(itemRest)){
        inParagraph=false;prevQuoteDepth=p.quoteDepth;
        result.push({start,end,quoteDepth:p.quoteDepth,rest,kind:'single',codeStart:end});
        continue;
      }
      inParagraph=true;prevQuoteDepth=p.quoteDepth;
      result.push({start,end,quoteDepth:p.quoteDepth,rest:itemRest,kind:'paraStart',codeStart:end});
      continue;
    }
    const kind=inParagraph?'paraCont':'paraStart';
    inParagraph=true;prevQuoteDepth=p.quoteDepth;
    result.push({start,end,quoteDepth:p.quoteDepth,rest,kind,codeStart:end});
  }
  return result;
}

function maskInlineCode(source:string,mask:Uint8Array,segStart:number,segEnd:number):void {
  interface BacktickRun {start:number;end:number;len:number;escaped:boolean;next:number}
  const runs:BacktickRun[]=[];
  const headByLen=new Map<number,number>(),tailByLen=new Map<number,number>();
  for(let i=segStart;i<segEnd;){
    if(source[i]!=='`'){i++;continue;}
    let slashes=0;
    for(let j=i-1;j>=segStart&&source[j]==='\\';j--)slashes++;
    const start=i;
    while(i<segEnd&&source[i]==='`')i++;
    const len=i-start,idx=runs.length;
    runs.push({start,end:i,len,escaped:(slashes&1)===1,next:-1});
    const prev=tailByLen.get(len);
    if(prev===undefined)headByLen.set(len,idx);else runs[prev].next=idx;
    tailByLen.set(len,idx);
  }
  for(let k=0;k<runs.length;){
    const open=runs[k];
    const openStart=open.escaped?open.start+1:open.start,openLen=open.escaped?open.len-1:open.len;
    if(openLen<=0){k++;continue;}
    let cand=headByLen.get(openLen);
    while(cand!==undefined&&cand>=0&&cand<=k)cand=runs[cand].next;
    if(cand===undefined||cand<0){headByLen.delete(openLen);k++;continue;}
    headByLen.set(openLen,runs[cand].next);
    mask.fill(1,openStart,runs[cand].end);
    k=cand+1;
  }
}

function maskTableCells(source:string,mask:Uint8Array,lineStart:number,lineEnd:number):void {
  let cellStart=lineStart;
  for(let i=lineStart;i<lineEnd;i++){
    if(source[i]!=='|')continue;
    let slashes=0;
    for(let j=i-1;j>=cellStart&&source[j]==='\\';j--)slashes++;
    if((slashes&1)===0){
      if(i>cellStart)maskInlineCode(source,mask,cellStart,i);
      cellStart=i+1;
    }
  }
  if(lineEnd>cellStart)maskInlineCode(source,mask,cellStart,lineEnd);
}

function computeCodeMask(source:string,lines=classifyMarkdownLines(source)):Uint8Array {
  const mask=new Uint8Array(source.length);
  for(let i=1;i<lines.length;i++){
    const prev=lines[i-1],curr=lines[i];
    if((prev.kind==='paraStart'||prev.kind==='paraCont')&&curr.kind==='paraCont'&&prev.quoteDepth===curr.quoteDepth&&TABLE_DELIMITER.test(curr.rest)&&prev.rest.includes('|')){
      prev.kind='tableRow';curr.kind='blank';
      for(let j=i+1;j<lines.length&&(lines[j].kind==='paraStart'||lines[j].kind==='paraCont')&&lines[j].quoteDepth===curr.quoteDepth;j++){
        lines[j].kind=lines[j].rest.includes('|')?'tableRow':'single';
      }
    }
  }
  for(let i=0;i<lines.length;i++){
    const line=lines[i];
    if(line.kind==='fence'||line.kind==='indented'){mask.fill(1,line.codeStart,line.end);continue;}
    if(line.kind==='single'){maskInlineCode(source,mask,line.start,line.end);continue;}
    if(line.kind==='tableRow'){maskTableCells(source,mask,line.start,line.end);continue;}
    if(line.kind==='paraStart'||line.kind==='paraCont'){
      const paraStart=line.start;
      while(i+1<lines.length&&lines[i+1].kind==='paraCont')i++;
      maskInlineCode(source,mask,paraStart,lines[i].end);
    }
  }
  return mask;
}

/** Index-preserving CommonMark code mask: replaces fenced, indented, and inline
 * code characters with spaces while keeping every line break and UTF-16 offset. */
export function maskCode(markdown:string):string {
  const mask=computeCodeMask(markdown),chars=markdown.split('');
  for(let i=0;i<chars.length;i++)if(mask[i]&&chars[i]!=='\r'&&chars[i]!=='\n')chars[i]=' ';
  return chars.join('');
}

export function hasCallouts(markdown:string):boolean {
  const fm=parseFrontmatter(markdown),body=fm?markdown.slice(fm.end):markdown;
  for(const line of classifyMarkdownLines(body)){
    if(line.kind!=='fence'&&line.kind!=='indented'&&CALLOUT_START.test(body.slice(line.start,line.end)))return true;
  }
  return false;
}

export function normalizeCalloutBlocks(value:string,skipFrontmatter=true):Stage {
  if(!/:::callout\s/i.test(value))return {value,originalOffset:offset=>offset};
  const frontmatterEnd=skipFrontmatter?(parseFrontmatter(value)?.end??0):0;
  const body=frontmatterEnd?value.slice(frontmatterEnd):value;
  const edits:Edit[]=[];let depth=0;
  for(const line of classifyMarkdownLines(body)){
    const text=body.slice(line.start,line.end),insideCode=line.kind==='fence'||line.kind==='indented';
    const start=!insideCode&&CALLOUT_START.exec(text);
    if(start){depth++;edits.push({start:frontmatterEnd+line.start,end:frontmatterEnd+line.end,text:`${'> '.repeat(depth)}[!${start[1].toUpperCase()}] ${start[2]?.replace(/^['"]|['"]$/g,'')||start[1]}`});}
    else if(!insideCode&&text.trim()===':::'&&depth){depth--;edits.push({start:frontmatterEnd+line.start,end:frontmatterEnd+line.end,text:'> '.repeat(depth).trimEnd()});}
    else if(depth)edits.push({start:frontmatterEnd+line.start,end:frontmatterEnd+line.start,text:'> '.repeat(depth)});
  }
  return replaceStage(value,edits);
}

function unmaskedRangesFromMask(mask:Uint8Array):Array<[number,number]> {
  const ranges:Array<[number,number]>=[];let start=-1;
  for(let i=0;i<mask.length;i++){
    if(!mask[i]){if(start<0)start=i;}
    else if(start>=0){ranges.push([start,i]);start=-1;}
  }
  if(start>=0)ranges.push([start,mask.length]);
  return ranges;
}

function unmaskedRegexStage(source:string,ranges:Array<[number,number]>,regex:RegExp,replacement:(...args:any[])=>string):{stage:Stage;ranges:Array<[number,number]>} {
  const edits:Edit[]=[],nextRanges:Array<[number,number]>=[];
  let delta=0;
  for(const [rangeStart,rangeEnd] of ranges){
    const nextStart=rangeStart+delta,slice=source.slice(rangeStart,rangeEnd);
    slice.replace(regex,(...args:any[])=>{
      const localStart=args[args.length-2] as number,matchText=args[0] as string,text=replacement(...args);
      edits.push({start:rangeStart+localStart,end:rangeStart+localStart+matchText.length,text});
      delta+=text.length-matchText.length;
      return matchText;
    });
    nextRanges.push([nextStart,rangeEnd+delta]);
  }
  return {stage:replaceStage(source,edits),ranges:nextRanges};
}

export interface NormalizeMarkdownOptions {
  encodeLinkDestinations?: boolean;
}

function isUnmaskedEscaped(source:string,mask:Uint8Array,at:number):boolean {
  let slashes=0;
  for(let j=at-1;j>=0&&!mask[j]&&source[j]==='\\';j--)slashes++;
  return (slashes&1)===1;
}

function computeCodeAndMathMask(source:string):Uint8Array {
  const mask=computeCodeMask(source);
  for(let i=0;i<source.length;){
    if(mask[i]||source[i]!=='$'||isUnmaskedEscaped(source,mask,i)){i++;continue;}
    if(source[i+1]==='$'&&!mask[i+1]){
      if(source[i+2]==='$'){while(i<source.length&&source[i]==='$')i++;continue;}
      let close=-1;
      for(let j=i+2;j+1<source.length;j++){
        if(!mask[j]&&!mask[j+1]&&source[j]==='$'&&source[j+1]==='$'&&source[j+2]!=='$'&&!isUnmaskedEscaped(source,mask,j)){close=j;break;}
      }
      if(close>=0){mask.fill(1,i,close+2);i=close+2;}else i+=2;
      continue;
    }
    const next=source[i+1];
    if(!next||/\s/.test(next)){i++;continue;}
    let close=-1;
    for(let j=i+1;j<source.length;j++){
      if(source[j]==='\n'){
        let k=j+1;while(k<source.length&&(source[k]===' '||source[k]==='\t'||source[k]==='\r'))k++;
        if(source[k]==='\n')break;
      }
      if(!mask[j]&&source[j]==='$'&&source[j+1]!=='$'&&!isUnmaskedEscaped(source,mask,j)&&!/\s/.test(source[j-1])&&!/\d/.test(source[j+1]||'')){close=j;break;}
    }
    if(close>=0){mask.fill(1,i,close+1);i=close+1;}else i++;
  }
  return mask;
}

function stripPercentComments(source:string):Stage {
  if(!source.includes('%%'))return {value:source,originalOffset:offset=>offset};
  const mask=computeCodeAndMathMask(source),edits:Edit[]=[];
  const isDelim=(at:number)=>at+1<source.length&&source[at]==='%'&&source[at+1]==='%'&&!mask[at]&&!mask[at+1]&&!isUnmaskedEscaped(source,mask,at);
  for(let i=0;i+1<source.length;){
    if(!isDelim(i)){i++;continue;}
    let close=-1;
    for(let j=i+2;j+1<source.length;j++){if(isDelim(j)){close=j;break;}}
    if(close<0)break;
    edits.push({start:i,end:close+2,text:''});
    i=close+2;
  }
  return edits.length?replaceStage(source,edits):{value:source,originalOffset:offset=>offset};
}

/** Render-only syntax normalization with a sparse offset map. Source positions
 * always address the original note, including frontmatter and wiki/callout edits. */
export function normalizeMarkdownSource(markdown:string, options:NormalizeMarkdownOptions={}):Stage {
  const encodeLinks=Boolean(options.encodeLinkDestinations);
  const stages:Stage[]=[];let value=markdown;
  const add=(stage:Stage)=>{stages.push(stage);value=stage.value;};
  const fm=parseFrontmatter(value);
  if(fm)add(replaceStage(value,[{start:0,end:fm.end,text:''}]));
  else if(value.startsWith('\uFEFF'))add(replaceStage(value,[{start:0,end:1,text:''}]));
  add(stripPercentComments(value));
  let ranges=unmaskedRangesFromMask(computeCodeAndMathMask(value));
  const addUnmasked=(regex:RegExp,replacement:(...args:any[])=>string)=>{const next=unmaskedRegexStage(value,ranges,regex,replacement);ranges=next.ranges;add(next.stage);};
  addUnmasked(/!\[\[([^\[\r\n\]|]+)(?:\|([^\r\n\]]+))?\]\]/g,(_all,rawPath:string,spec?:string)=>{
    const path=spec!==undefined&&rawPath.endsWith('\\')?rawPath.slice(0,-1):rawPath;
    const sized=spec&&/^(?:(.*?)(?:\\)?\|)?\s*(0*[1-9]\d*(?:\.\d+)?)\s*(?:x\s*\d+(?:\.\d+)?\s*)?$/i.exec(spec);
    const alt=sized?(sized[1]?.trim()||path):(spec??path);
    const dest=encodeLinks?encodeMarkdownDestination(path.trim()):encodeURI(path);
    return `![${alt}](${dest})${sized?`{width=${sized[2]}}`:''}`;
  });
  addUnmasked(/\[\[([^\[\r\n\]]+?)\]\]/g,(all,inner:string)=>formatWikilinkMarkdown(inner,encodeLinks)??all);
  if(encodeLinks){
    addUnmasked(/(!?\[(?:\\.|\[[^\r\n\[\]]*\]|[^\[\]\r\n])*\]\()([^<>\r\n()]+?)((?:\s+(?:"[^"\r\n]*"|'[^'\r\n]*'))?)(\))/g,(all,open:string,dest:string,title:string,close:string)=>isLikelyInlineLinkDestination(dest)?`${open}${encodeMarkdownDestination(dest)}${title}${close}`:all);
  }
  add(normalizeCalloutBlocks(value,false));
  return {value,originalOffset(offset){for(let i=stages.length-1;i>=0;i--)offset=stages[i].originalOffset(offset);return offset;}};
}
export function normalizeCallouts(markdown:string):string{return normalizeMarkdownSource(markdown,{encodeLinkDestinations:true}).value;}

export function remarkImageAttributes() {
  return (tree:any)=>{
    visit(tree,(parent:any)=>{
      if(!Array.isArray(parent.children))return;
      for(let i=0;i<parent.children.length-1;i++){
        const current=parent.children[i],next=parent.children[i+1];
        if((current?.type==='image'||current?.type==='imageReference')&&next?.type==='text'&&typeof next.value==='string'){
          const stripped=next.value.replace(/^\{[^}\r\n]*\b(?:width|zoom)\s*=\s*[^}\r\n]+\}/i,'');
          if(stripped!==next.value){
            if(stripped)parent.children[i+1]={...next,value:stripped};
            else parent.children.splice(i+1,1);
          }
        }
      }
    });
  };
}

export function remarkSourceSyntax(this:any){
  const parser=this.parser;
  this.parser=(source:string,file:any)=>{
    const normalized=normalizeMarkdownSource(source,{encodeLinkDestinations:true}),tree=parser(normalized.value,file);
    if(normalized.value===source)return tree;
    const lines=[0];for(let i=0;i<source.length;i++)if(source[i]==='\n')lines.push(i+1);
    const point=(value:any)=>{const offset=normalized.originalOffset(value.offset);let low=0,high=lines.length;while(low<high){const mid=(low+high)>>>1;if(lines[mid]<=offset)low=mid+1;else high=mid;}return {offset,line:low,column:offset-lines[low-1]+1};};
    visit(tree,(node:any)=>{
      if(!node.position)return;
      node.position={start:point(node.position.start),end:point(node.position.end)};
      if(node.type==='link'&&typeof node.position.start?.offset==='number'&&typeof node.position.end?.offset==='number'){
        const parsed=parseOriginalWikilinkSlice(source.slice(node.position.start.offset,node.position.end.offset));
        if(parsed&&!parsed.sameNote){
          const hProperties={...(node.data as any)?.hProperties,'data-wikilink':parsed.target,...(parsed.fragment?{'data-heading-fragment':parsed.fragment}:{})};
          node.data={...node.data,hProperties};
        }
      }
    });
    return tree;
  };
}
