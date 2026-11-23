/** Bounded, renderer-independent operations used by live agents. Character
 * offsets are Unicode code points, matching the Python CLI (not UTF-16). */
import {analyzeDocument} from './documentAnalysis';
export type AgentPatch = {type:'replace';old:string;new:string;count?:1|'all';expectedCount?:number} | {type:'lines';start_line:number;end_line:number;text:string} | {type:'insert';line:number;text:string};
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
export type AgentPatchSummary={operationIndex:number;type:AgentPatch['type'];startOffset:number;endOffset:number;deltaChars:number};
export function applyAgentPatchesDetailed(source:string,operations:unknown):{text:string;applied:number;operations:AgentPatchSummary[]} {
  if(!Array.isArray(operations)||operations.length<1||operations.length>100||encoder.encode(JSON.stringify(operations)).length>64_000)throw Error('Provide 1–100 patch operations within 64 KB');
  let edited=source;const summaries:AgentPatchSummary[]=[];
  for(const [operationIndex,operation] of operations.entries()){
    const fail=(message:string):never=>{throw Error(`operations[${operationIndex}]: ${message}`);};
    if(!operation||typeof operation!=='object'||Array.isArray(operation))fail('Each patch must be an object');
    const op=operation as Record<string,unknown>,kind=op.type;
    const validateKeys=(allowed:string[])=>{for(const key of Object.keys(op))if(!allowed.includes(key))fail(`Unknown field '${key}'; expected ${allowed.join(', ')}`);};
    const previous=edited;let startOffset=0,endOffset=0;
    if(kind==='replace'){
      validateKeys(['type','old','new','count','expectedCount']);
      const oldValue=op.old,replacementValue=op.new,expectedCount=op.expectedCount,count=op.count===undefined?(typeof expectedCount==='number'&&expectedCount>1?'all':1):op.count;
      if(typeof oldValue!=='string'||!oldValue)fail('replace.old must be non-empty text');
      if(typeof replacementValue!=='string')fail('replace.new must be text');
      const old=oldValue as string,replacement=replacementValue as string;
      if(count!==1&&count!=='all')fail("replace.count must be 1 or 'all'");
      if(expectedCount!==undefined&&(typeof expectedCount!=='number'||!Number.isInteger(expectedCount)||expectedCount<1))fail('replace.expectedCount must be a positive integer');
      let occurrences=0,cursor=0,lastMatchEnd=0;while((cursor=edited.indexOf(old,cursor))>=0){occurrences++;lastMatchEnd=cursor+old.length;cursor=lastMatchEnd;}
      if(!occurrences||(count===1&&occurrences!==1)||(expectedCount!==undefined&&occurrences!==expectedCount))fail(`Exact replacement expected ${expectedCount??(count===1?'one':'at least one')} match; found ${occurrences}`);
      const first=edited.indexOf(old);startOffset=agentCharLength(edited.slice(0,first));endOffset=count==='all'?agentCharLength(edited.slice(0,lastMatchEnd)):startOffset+agentCharLength(old);
      edited=count==='all'?edited.split(old).join(replacement):edited.replace(old,()=>replacement);
    }else if(kind==='lines'||kind==='insert'){
      const isInsert=kind==='insert';validateKeys(isInsert?['type','line','text']:['type','start_line','end_line','text']);
      const parts=lines(edited),lineKey=isInsert?'line':'start_line',lineValue=op[lineKey];
      if(typeof lineValue!=='number'||!Number.isInteger(lineValue))fail(`${isInsert?'insert.line':'lines.start_line'} must be an integer`);
      const start=lineValue as number;
      if(start<1||start>parts.length+1)fail(`${isInsert?'insert.line':'lines.start_line'} must be between 1 and ${parts.length+1}`);
      let end=start;
      if(!isInsert){const endValue=op.end_line;if(typeof endValue!=='number'||!Number.isInteger(endValue))fail('lines.end_line must be an integer');end=endValue as number;if(end<start||end>parts.length+1)fail(`lines.end_line must be between ${start} and ${parts.length+1}`);}
      if(typeof op.text!=='string')fail(`${isInsert?'insert':'lines'}.text must be text`);
      startOffset=agentCharLength(parts.slice(0,start-1).join(''));endOffset=isInsert?startOffset:agentCharLength(parts.slice(0,Math.min(end,parts.length)).join(''));
      let replacement=op.text as string;
      if(isInsert&&start===parts.length+1&&parts.length&&!/[\r\n\v\f\x85\u2028\u2029]$/.test(parts[parts.length-1]))replacement=(edited.match(/\r\n|[\r\n\v\f\x85\u2028\u2029]/)?.[0]??'\n')+replacement;
      if(replacement&&!/[\r\n\v\f\x85\u2028\u2029]$/.test(replacement)&&!isInsert&&end<=parts.length&&/[\r\n\v\f\x85\u2028\u2029]$/.test(parts[end-1]))replacement+='\n';
      edited=parts.slice(0,start-1).join('')+replacement+parts.slice(isInsert?start-1:Math.min(end,parts.length)).join('');
    }else fail("Patch type must be 'replace', 'lines' or 'insert'");
    if(encoder.encode(edited).length>20_000_000)fail('Edited Markdown exceeds 20 MB');
    summaries.push({operationIndex,type:kind as AgentPatch['type'],startOffset,endOffset,deltaChars:agentCharLength(edited)-agentCharLength(previous)});
  }
  return {text:edited,applied:summaries.length,operations:summaries};
}
export function applyAgentPatches(source:string,operations:unknown):string{return applyAgentPatchesDetailed(source,operations).text;}
export type AgentHeading={index:number;level:number;title:string;line:number;start:number;sectionStart:number;sectionEnd:number};
export function agentOutline(source:string):AgentHeading[] {
  const headings:Array<{index:number;level:number;title:string;line:number;start:number}>=[];
  let position=0,line=0,fence:{marker:string;length:number}|null=null;
  for(const part of lines(source)){
    line++;const opening=/^ {0,3}(`{3,}|~{3,})/.exec(part);
    if(opening){const marker=opening[1][0],length=opening[1].length;if(!fence)fence={marker,length};else if(fence.marker===marker&&length>=fence.length&&!part.slice(opening[0].length).trim())fence=null;}
    else if(!fence){const heading=/^ {0,3}(#{1,6})[\t ]+(.+?)\s*#*\s*$/.exec(part);if(heading)headings.push({index:headings.length,level:heading[1].length,title:heading[2].slice(0,300),line,start:position});}
    position+=agentCharLength(part);
  }
  const sectionEnds=headings.map(()=>agentCharLength(source)),stack:number[]=[];
  for(const heading of headings){
    while(stack.length&&headings[stack[stack.length-1]].level>=heading.level)sectionEnds[stack.pop()!]=heading.start;
    stack.push(heading.index);
  }
  return headings.map((heading,index)=>({...heading,sectionStart:heading.start,sectionEnd:sectionEnds[index]}));
}
export function agentOutlinePage(source:string,offset:unknown=0,limit:unknown=80){
  const headings=agentOutline(source);
  if(typeof offset!=='number'||!Number.isInteger(offset)||offset<0||offset>headings.length)throw Error(`outline offset must be between 0 and ${headings.length}`);
  if(typeof limit!=='number'||!Number.isInteger(limit)||limit<1||limit>80)throw Error('outline limit must be between 1 and 80');
  const pageOffset=offset,end=Math.min(headings.length,pageOffset+limit);
  return {headings:headings.slice(pageOffset,end),offset:pageOffset,total:headings.length,nextOffset:end<headings.length?end:null,truncated:end<headings.length,documentLength:agentCharLength(source)};
}
function headingSlug(title:string){return title.normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,'-').replace(/^-+|-+$/g,'');}
function headingAmbiguous(selector:string,matches:AgentHeading[]):never{
  const shown=matches.slice(0,5).map(item=>`${item.index}: ${item.title.slice(0,80)} (line ${item.line})`).join('; ');
  throw Error(`Heading selector '${selector.slice(0,80)}' is ambiguous (${matches.length} matches); candidates: ${shown}${matches.length>5?'; …':''}. Use an outline index or a more specific exact title/slug.`);
}
export function resolveAgentHeading(headings:AgentHeading[],selector:unknown):AgentHeading{
  if(typeof selector==='number'&&Number.isInteger(selector)&&selector>=0){const heading=headings[selector];if(heading)return heading;throw Error(`Heading index ${selector} is not present in this document`);}
  if(typeof selector!=='string'||!selector.trim()||selector.length>300)throw Error('heading must be an outline index or exact title, slug, or numbered heading prefix');
  const query=selector.trim(),exact=headings.filter(item=>item.title===query);
  if(exact.length===1)return exact[0];if(exact.length>1)return headingAmbiguous(query,exact);
  const slug=headingSlug(query),slugMatches=headings.filter(item=>headingSlug(item.title)===slug);
  if(slugMatches.length===1)return slugMatches[0];if(slugMatches.length>1)return headingAmbiguous(query,slugMatches);
  if(/^\d+(?:\.\d+)*$/.test(query)){
    const escaped=query.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),numbered=headings.filter(item=>new RegExp(`^${escaped}(?:$|[\\s:)\\-—]|\\.(?=\\s))`).test(item.title));
    if(numbered.length===1)return numbered[0];if(numbered.length>1)return headingAmbiguous(query,numbered);
  }
  throw Error(`No heading matches '${query.slice(0,80)}'; use an exact title, slug, or outline index`);
}
export function agentSection(source:string,selector:unknown){
  const documentLength=agentCharLength(source),heading=resolveAgentHeading(agentOutline(source),selector);
  return {text:source.slice(agentUtf16Offset(source,heading.sectionStart),agentUtf16Offset(source,heading.sectionEnd)),
    sectionStart:heading.sectionStart,sectionEnd:heading.sectionEnd,documentLength};
}
/** Prepare a portable export slice by carrying over only reference definitions
 * used by that section whose first definition is outside its source range. */
export function agentSectionForExport(source:string,selector:unknown){
  const section=agentSection(source,selector),start=agentUtf16Offset(source,section.sectionStart),end=agentUtf16Offset(source,section.sectionEnd);
  const definitions=new Map<string,any>(),used=new Set<string>(),stack:any[]=[analyzeDocument(source).tree];
  while(stack.length){const node=stack.pop();if(node.type==='definition'&&!definitions.has(node.identifier))definitions.set(node.identifier,node);
    if((node.type==='imageReference'||node.type==='linkReference')&&node.position?.start.offset>=start&&node.position?.end.offset<=end)used.add(node.identifier);
    if(node.children)for(let index=node.children.length-1;index>=0;index--)stack.push(node.children[index]);}
  const needed=[...used].map(identifier=>definitions.get(identifier)).filter(node=>node&&!(node.position.start.offset>=start&&node.position.end.offset<=end))
    .sort((left,right)=>left.position.start.offset-right.position.start.offset).map(node=>source.slice(node.position.start.offset,node.position.end.offset));
  return {...section,text:needed.length?`${section.text}${section.text&&!/[\r\n]$/.test(section.text)?'\n':''}\n${needed.join('\n')}\n`:section.text};
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
  const documentLength=agentCharLength(source);let sectionStart=0,sectionEnd=documentLength;
  const requestedOffset=boundedInt(offset,0,0,documentLength);
  if(heading!==undefined){const section=agentSection(source,heading);sectionStart=section.sectionStart;sectionEnd=section.sectionEnd;}
  if(requestedOffset>sectionEnd)throw Error(`offset must be within the selected section (sectionEnd ${sectionEnd})`);
  const start=heading===undefined?requestedOffset:Math.max(sectionStart,requestedOffset);
  const end=sectionEnd;
  const count=boundedInt(limit,12_000,1,12_000),finish=view==='prose'?prosePageEnd(source,start,count,end):Math.min(end,start+count);
  const exact=source.slice(agentUtf16Offset(source,start),agentUtf16Offset(source,finish));
  const viewResult=view==='prose'?elideSvgPage(source,start,finish,exact):{text:exact,svg_omissions:[] as Array<{source_start:number;source_end:number;line_start:number;line_end:number;omitted_chars:number;omitted_lines:number}>};
  return {...viewResult,start,end:finish,total_chars:sectionEnd-sectionStart,next_offset:finish<sectionEnd?finish:null,truncated:finish<sectionEnd,view,returned_chars:agentCharLength(viewResult.text),sectionStart,sectionEnd,documentLength};
}
type SearchOptions={offset?:unknown;caseSensitive?:unknown;wholeWord?:unknown;regex?:unknown;excludeDiagrams?:unknown};
type SearchMatch={offset:number;line:number;text:string;matchOffset:number;matchLength:number;snippetOffset:number};
function searchDiagramSpans(source:string):Array<{start:number;end:number}>{
  const spans=svgSpans(source).map(span=>({start:span.start,end:span.end}));let position=0,open:{marker:string;length:number;start:number;enabled:boolean}|null=null;
  for(const part of lines(source)){
    const body=part.replace(/[\r\n\v\f\x85\u2028\u2029]+$/u,'');const fence=/^ {0,3}(`{3,}|~{3,})/.exec(body);
    if(fence){const marker=fence[1][0],length=fence[1].length;if(!open){const language=body.slice(fence[0].length).trim().split(/\s+/,1)[0]?.toLowerCase()??'';open={marker,length,start:position+agentCharLength(part),enabled:['svg','svg+xml','image/svg+xml','mermaid','smd-chart'].includes(language)};}
      else if(marker===open.marker&&length>=open.length){if(open.enabled)spans.push({start:open.start,end:position});open=null;}}
    position+=agentCharLength(part);
  }
  if(open?.enabled)spans.push({start:open.start,end:agentCharLength(source)});return spans.filter((span,index)=>spans.findIndex(other=>other.start===span.start&&other.end===span.end)===index).sort((a,b)=>a.start-b.start);
}
function safeRegex(query:string):RegExp{
  let inClass=false,escaped=false;
  for(const ch of query){if(escaped){if(/[1-9]/.test(ch)||ch==='k')throw Error('regex supports no backreferences');if(!inClass&&(ch==='b'||ch==='B'))throw Error('regex supports no zero-width word-boundary assertions');escaped=false;continue;}
    if(ch==='\\'){escaped=true;continue;}if(ch==='[')inClass=true;else if(ch===']')inClass=false;else if(!inClass&&'*+?{}()|'.includes(ch))throw Error('regex supports literals, dot, character classes and anchors only; quantifiers, groups and alternation are not supported');}
  if(escaped)throw Error('regex ends with an incomplete escape');
  let compiled:RegExp;try{compiled=new RegExp(query,'gmu');}catch{throw Error('regex is not valid in the supported safe subset');}
  if(compiled.test(''))throw Error('regex must match at least one character');return compiled;
}
export function agentSearch(source:string,query:unknown,limit:unknown=10,context:unknown=100,options:SearchOptions={}) {
  if(typeof query!=='string'||!query||agentCharLength(query)>500)throw Error('query must contain 1–500 characters');
  const sourceLength=agentCharLength(source),maximum=boundedInt(limit,10,1,25),around=boundedInt(context,100,0,500),offset=boundedInt(options.offset,0,0,sourceLength);
  for(const key of ['caseSensitive','wholeWord','regex','excludeDiagrams'] as const)if(options[key]!==undefined&&typeof options[key]!=='boolean')throw Error(`${key} must be a boolean`);
  const caseSensitive=options.caseSensitive===true,wholeWord=options.wholeWord===true,useRegex=options.regex===true,excludeDiagrams=options.excludeDiagrams===true;
  const sourcePoints=wholeWord?Array.from(source):[];let normalized='';
  if(!useRegex&&!caseSensitive)for(const point of source)normalized+=point.toLowerCase();
  const normalizedQuery=!useRegex&&!caseSensitive?Array.from(query).map(ch=>ch.toLowerCase()).join(''):query;
  const matcher=useRegex?safeRegex(query):new RegExp(normalizedQuery.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'gu');
  const spans=excludeDiagrams?searchDiagramSpans(source).map(item=>({start:agentCharLength(source.slice(0,item.start)),end:agentCharLength(source.slice(0,item.end))})):[];
  const matches:SearchMatch[]=[];let totalMatches=0,remainingMatches=0;const isWord=(value:string|undefined)=>value!==undefined&&/[\p{L}\p{N}_]/u.test(value);
  const fromSource=(startCp:number,endCp:number)=>{const left=agentUtf16Offset(source,startCp),right=agentUtf16Offset(source,endCp);return {left,right};};
  const accept=(startCp:number,endCp:number)=>{
    if(endCp<=startCp)return false;
    if(wholeWord&&(isWord(sourcePoints[startCp-1])||isWord(sourcePoints[endCp])))return false;
    if(spans.some(span=>startCp<span.end&&endCp>span.start))return false;
    totalMatches++;
    if(startCp<offset)return true;
    remainingMatches++;
    if(matches.length<maximum){const {left}=fromSource(startCp,endCp),snippetOffset=Math.max(0,startCp-around),snippetEnd=Math.min(sourceLength,endCp+around),snippetLeft=agentUtf16Offset(source,snippetOffset),snippetRight=agentUtf16Offset(source,snippetEnd);
      matches.push({offset:startCp,line:source.slice(0,left).split('\n').length,text:source.slice(snippetLeft,snippetRight),matchOffset:startCp,matchLength:endCp-startCp,snippetOffset});}
    return true;
  };
  if(useRegex){let match:RegExpExecArray|null,utf16Cursor=0,cpCursor=0;while((match=matcher.exec(source))){if(!match[0].length){matcher.lastIndex=match.index+Math.max(1,source.codePointAt(match.index)!>0xffff?2:1);continue;}cpCursor+=agentCharLength(source.slice(utf16Cursor,match.index));utf16Cursor=match.index;const startCp=cpCursor;cpCursor+=agentCharLength(match[0]);utf16Cursor+=match[0].length;accept(startCp,cpCursor);}}
  else if(caseSensitive){let cursor=0,matchIndex:number,cpCursor=0;while((matchIndex=source.indexOf(query,cursor))>=0){cpCursor+=agentCharLength(source.slice(cursor,matchIndex));const startCp=cpCursor,endCp=startCp+agentCharLength(query);accept(startCp,endCp);cursor=matchIndex+query.length;cpCursor=endCp;}}
  else {let cursor=0,found:number,sourceCp=0,normalizedCp=0,utf16Cp=0;
    const boundaryAt=(target:number):number|undefined=>{while(utf16Cp<source.length&&normalizedCp<target){const point=source.codePointAt(utf16Cp)!,value=String.fromCodePoint(point);normalizedCp+=value.toLowerCase().length;sourceCp++;utf16Cp+=value.length;}return normalizedCp===target?sourceCp:undefined;};
    while((found=normalized.indexOf(normalizedQuery,cursor))>=0){const startCp=boundaryAt(found),endCp=boundaryAt(found+normalizedQuery.length);if(startCp!==undefined&&endCp!==undefined)accept(startCp,endCp);cursor=found+Math.max(1,normalizedQuery.length);}}
  const truncated=remainingMatches>matches.length,last=matches[matches.length-1],nextOffset=truncated&&last?last.matchOffset+last.matchLength:null;
  return {matches,truncated,totalMatches,remainingMatches,nextOffset};
}
