/** Bounded, renderer-independent operations used by live agents. Character
 * offsets are Unicode code points, matching the Python CLI (not UTF-16). */
export type AgentPatch = {type:'replace';old:string;new:string;count?:1|'all'} | {type:'lines';start_line:number;end_line:number;text:string};
const encoder=new TextEncoder();
export function agentCharLength(text:string):number {let size=0;for(const _ of text)size++;return size;}
export function agentUtf16Offset(text:string,offset:number):number {
  if(!Number.isInteger(offset)||offset<0)throw Error('offset must be a non-negative Unicode character offset');
  let chars=0,index=0;while(index<text.length&&chars<offset){index+=text.codePointAt(index)!>0xffff?2:1;chars++;}
  if(chars!==offset)throw Error('offset is beyond the document');return index;
}
export async function agentRevision(text:string):Promise<string> {
  const hash=await crypto.subtle.digest('SHA-256',encoder.encode(text));
  return Array.from(new Uint8Array(hash),value=>value.toString(16).padStart(2,'0')).join('');
}
function boundedInt(value:unknown,fallback:number,min:number,max:number):number {
  const next=value===undefined?fallback:value;
  if(typeof next!=='number'||!Number.isInteger(next)||next<min||next>max)throw Error(`Expected an integer between ${min} and ${max}`);
  return next;
}
function lines(text:string):string[] {return text.match(/[^\r\n\v\f\x85\u2028\u2029]*(?:\r\n|[\r\n\v\f\x85\u2028\u2029]|$)/g)?.filter(Boolean)??[];}
export function applyAgentPatches(source:string,operations:unknown):string {
  if(!Array.isArray(operations)||operations.length<1||operations.length>100||encoder.encode(JSON.stringify(operations)).length>64_000)throw Error('Provide 1–100 patch operations within 64 KB');
  let edited=source;
  for(const operation of operations){
    if(!operation||typeof operation!=='object')throw Error('Each patch must be an object');
    if(operation.type==='replace'){
      const {old,new:replacement,count=1}=operation;
      if(typeof old!=='string'||!old||typeof replacement!=='string'||(count!==1&&count!=='all'))throw Error('Invalid exact replacement');
      let occurrences=0,cursor=0;while((cursor=edited.indexOf(old,cursor))>=0){occurrences++;cursor+=old.length;}
      if(!occurrences||(count===1&&occurrences!==1))throw Error(`Exact replacement expected ${count===1?'one':'at least one'} match; found ${occurrences}`);
      edited=count==='all'?edited.split(old).join(replacement):edited.replace(old,()=>replacement);
    }else if(operation.type==='lines'){
      const parts=lines(edited),start=boundedInt(operation.start_line,0,1,parts.length+1),end=boundedInt(operation.end_line,0,start,parts.length+1);
      if(typeof operation.text!=='string')throw Error('lines.text must be text');
      let replacement=operation.text;
      if(replacement&&!/[\r\n]$/.test(replacement)&&end<=parts.length&&parts[end-1].endsWith('\n'))replacement+='\n';
      edited=parts.slice(0,start-1).join('')+replacement+parts.slice(Math.min(end,parts.length)).join('');
    }else throw Error('Patch type must be replace or lines');
    if(encoder.encode(edited).length>20_000_000)throw Error('Edited Markdown exceeds 20 MB');
  }
  return edited;
}
export function agentOutline(source:string) {
  const headings:Array<{index:number;level:number;title:string;line:number;start:number}>=[];
  let position=0,line=0,fence:{marker:string;length:number}|null=null;
  for(const part of lines(source)){
    line++;const opening=/^ {0,3}(`{3,}|~{3,})/.exec(part);
    if(opening){const marker=opening[1][0],length=opening[1].length;if(!fence)fence={marker,length};else if(fence.marker===marker&&length>=fence.length&&!part.slice(opening[0].length).trim())fence=null;}
    else if(!fence){const heading=/^ {0,3}(#{1,6})[\t ]+(.+?)\s*#*\s*$/.exec(part);if(heading)headings.push({index:headings.length,level:heading[1].length,title:heading[2].slice(0,300),line,start:position});}
    position+=agentCharLength(part);
  }
  return headings;
}
type SvgSpan={start:number;end:number;line_start:number;line_end:number};
function svgSpans(source:string):SvgSpan[] {
  const spans:SvgSpan[]=[];let position=0,lineNumber=1;
  let open:{marker:string;length:number;start:number;lineStart:number;svg:boolean;probe:string}|null=null;
  for(const part of lines(source)){
    const body=part.replace(/[\r\n\v\f\x85\u2028\u2029]+$/u,'');
    const fence=/^ {0,3}(`{3,}|~{3,})/.exec(body);
    if(fence){
      const marker=fence[1][0],length=fence[1].length;
      if(!open){const language=body.slice(fence[0].length).trim().split(/\s+/,1)[0]?.toLowerCase()??'';open={marker,length,start:position+agentCharLength(part),lineStart:lineNumber+1,svg:['svg','svg+xml','image/svg+xml'].includes(language),probe:''};}
      else if(marker===open.marker&&length>=open.length){if(open.svg||open.probe.trimStart().toLowerCase().startsWith('<svg'))spans.push({start:open.start,end:position,line_start:open.lineStart,line_end:Math.max(open.lineStart,lineNumber-1)});open=null;}
      position+=agentCharLength(part);lineNumber++;continue;
    }
    if(open&&open.probe.length<2048)open.probe+=body.slice(0,Math.min(512,2048-open.probe.length));
    position+=agentCharLength(part);lineNumber++;
  }
  if(open&&(open.svg||open.probe.trimStart().toLowerCase().startsWith('<svg')))spans.push({start:open.start,end:position,line_start:open.lineStart,line_end:Math.max(open.lineStart,lineNumber-1)});
  return spans;
}
function elideSvgPage(source:string,start:number,end:number,page:string) {
  const omissions:Array<{source_start:number;source_end:number;line_start:number;line_end:number;omitted_chars:number;omitted_lines:number}>=[];
  const pieces:string[]=[];let cursor=start;
  for(const span of svgSpans(source)){
    const left=Math.max(start,span.start),right=Math.min(end,span.end);if(left>=right)continue;
    pieces.push(source.slice(agentUtf16Offset(source,cursor),agentUtf16Offset(source,left)));
    const item={source_start:span.start,source_end:span.end,line_start:span.line_start,line_end:span.line_end,
      omitted_chars:span.end-span.start,omitted_lines:Math.max(1,span.line_end-span.line_start+1)};omissions.push(item);
    pieces.push(`[SVG omitted: ${item.omitted_chars} chars, source lines ${item.line_start}–${item.line_end}]\n`);cursor=right;
  }
  if(!omissions.length)return {text:page,svg_omissions:omissions};
  pieces.push(source.slice(agentUtf16Offset(source,cursor),agentUtf16Offset(source,end)));
  return {text:pieces.join(''),svg_omissions:omissions};
}
function prosePageEnd(source:string,start:number,limit:number,maxEnd:number) {
  let cursor=start,remaining=limit;
  for(const span of svgSpans(source)){
    if(span.end<=cursor||span.start>=maxEnd)continue;
    if(span.start>cursor){const available=Math.min(span.start,maxEnd)-cursor,take=Math.min(available,remaining);cursor+=take;remaining-=take;if(!remaining)return cursor;}
    // SVG source is replaced by a small marker, so consume it without using
    // the bounded prose budget and continue into ordinary text after the fence.
    cursor=Math.min(maxEnd,Math.max(cursor,span.end));if(cursor>=maxEnd)return maxEnd;
  }
  return Math.min(maxEnd,cursor+remaining);
}
export function agentRead(source:string,offset:unknown=0,limit:unknown=12_000,heading?:unknown,view:unknown='prose') {
  if(view!=='prose'&&view!=='source')throw Error('view must be prose or source');
  let start=boundedInt(offset,0,0,agentCharLength(source)),end=agentCharLength(source);
  if(heading!==undefined){const headings=agentOutline(source),index=boundedInt(heading,0,0,headings.length-1),item=headings[index];start=item.start;end=headings.slice(index+1).find(next=>next.level<=item.level)?.start??end;}
  const count=boundedInt(limit,12_000,1,12_000),finish=view==='prose'?prosePageEnd(source,start,count,end):Math.min(end,start+count);
  const exact=source.slice(agentUtf16Offset(source,start),agentUtf16Offset(source,finish));
  const viewResult=view==='prose'?elideSvgPage(source,start,finish,exact):{text:exact,svg_omissions:[] as Array<{source_start:number;source_end:number;line_start:number;line_end:number;omitted_chars:number;omitted_lines:number}>};
  return {...viewResult,start,end:finish,total_chars:end,next_offset:finish<end?finish:null,truncated:finish<end,view,returned_chars:agentCharLength(viewResult.text)};
}
export function agentSearch(source:string,query:unknown,limit:unknown=10,context:unknown=100) {
  if(typeof query!=='string'||!query||agentCharLength(query)>500)throw Error('query must contain 1–500 characters');
  const maximum=boundedInt(limit,10,1,25),around=boundedInt(context,100,0,500);
  const regex=new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'giu');
  const matches:Array<{offset:number;line:number;text:string}>=[];let cursor=0,position=0,line=1,match:RegExpExecArray|null;
  while(matches.length<maximum&&(match=regex.exec(source))){
    const before=source.slice(cursor,match.index);position+=agentCharLength(before);line+=(before.match(/\n/g)||[]).length;
    const left=Math.max(0,match.index-around),right=Math.min(source.length,match.index+match[0].length+around);
    matches.push({offset:position,line,text:source.slice(left,right)});cursor=match.index;
  }
  return {matches,truncated:matches.length===maximum&&regex.exec(source)!==null};
}
