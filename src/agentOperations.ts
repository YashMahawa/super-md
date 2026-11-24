/** Bounded, renderer-independent operations used by live agents. Character
 * offsets are Unicode code points, matching the Python CLI (not UTF-16). */
import {analyzeDocument} from './documentAnalysis';
export type AgentPatch = {type:'replace';old:string;new:string;count?:1|'all';expectedCount?:number} | {type:'lines';start_line:number;end_line:number;text:string} | {type:'insert';line:number;text:string};
const encoder=new TextEncoder(),utf8Scratch=new Uint8Array(65_536);
const CHECKPOINT_SHIFT=9,CHECKPOINT_STRIDE=1<<CHECKPOINT_SHIFT,MAX_INDEX_ENTRIES=8,MAX_INDEX_UTF16_UNITS=24_000_000;
type SvgSpan={start:number;end:number;startUtf16:number;endUtf16:number;line_start:number;line_end:number};
type UnicodeIndex={codePoints:number;utf16AtCp:Uint32Array;outline?:AgentHeading[];svgSpans?:SvgSpan[];diagramSpans?:Array<{start:number;end:number}>};
const unicodeCache=new Map<string,UnicodeIndex>();let unicodeCacheUnits=0;
const WORD_CHAR_RE=/[\p{L}\p{N}_]/u,LINE_BREAK_RE=/\r\n|[\r\n\v\f\x85\u2028\u2029]/g;

function isSurrogatePairAt(text:string,index:number,end=text.length):boolean {
  if(index+1>=end)return false;
  const high=text.charCodeAt(index);if(high<0xd800||high>0xdbff)return false;
  const low=text.charCodeAt(index+1);return low>=0xdc00&&low<=0xdfff;
}
export function countCodePointsRange(text:string,from=0,to=text.length):number {
  if(to<=from)return 0;
  let pairs=0,i=from;const last=to-1;
  while(i<last){
    const pair=((((text.charCodeAt(i)&0xfc00)^0xd800)-1)&(((text.charCodeAt(i+1)&0xfc00)^0xdc00)-1))>>>31;
    pairs+=pair;i+=1+pair;
  }
  return to-from-pairs;
}
function utf8ByteLength(text:string):number {
  const length=text.length;
  if(!length)return 0;
  if(length<=21_845)return encoder.encodeInto(text,utf8Scratch).written;
  let pos=0,bytes=0;
  while(pos<length){
    let end=Math.min(length,pos+21_845);
    if(end<length&&isSurrogatePairAt(text,end-1,length))end--;
    bytes+=encoder.encodeInto(text.slice(pos,end),utf8Scratch).written;
    pos=end;
  }
  return bytes;
}
function unicodeIndex(text:string):UnicodeIndex {
  const cached=unicodeCache.get(text);
  if(cached){unicodeCache.delete(text);unicodeCache.set(text,cached);return cached;}
  const slots=new Uint32Array((text.length>>>CHECKPOINT_SHIFT)+1);
  let slotCount=0,cp=0;const length=text.length,last=length-1;
  for(let i=0;i<length;){
    if((cp&(CHECKPOINT_STRIDE-1))===0)slots[slotCount++]=i;
    const pair=i<last?((((text.charCodeAt(i)&0xfc00)^0xd800)-1)&(((text.charCodeAt(i+1)&0xfc00)^0xdc00)-1))>>>31:0;
    i+=1+pair;cp++;
  }
  const built:UnicodeIndex={codePoints:cp,utf16AtCp:slotCount===slots.length?slots:slots.subarray(0,slotCount)};
  if(length<=MAX_INDEX_UTF16_UNITS){
    while(unicodeCache.size>=MAX_INDEX_ENTRIES||(unicodeCache.size>0&&unicodeCacheUnits+length>MAX_INDEX_UTF16_UNITS)){
      const oldest=unicodeCache.keys().next().value!;unicodeCacheUnits-=oldest.length;unicodeCache.delete(oldest);
    }
    unicodeCache.set(text,built);unicodeCacheUnits+=length;
  }
  return built;
}
export function hasUnicodeIndex(text:string):boolean {return text.length<CHECKPOINT_STRIDE||unicodeCache.has(text);}
function advanceUtf16ByCodePoints(text:string,utf16Index:number,steps:number):number {
  let index=utf16Index,remaining=steps;const length=text.length;
  while(index<length&&remaining>0){
    const code=text.charCodeAt(index);
    index+=code>=0xd800&&code<=0xdbff&&index+1<length&&text.charCodeAt(index+1)>=0xdc00&&text.charCodeAt(index+1)<=0xdfff?2:1;
    remaining--;
  }
  if(remaining!==0)throw Error('offset is beyond the document');
  return index;
}
function retreatUtf16ByCodePoints(text:string,utf16Index:number,steps:number):number {
  let index=utf16Index;
  for(let step=0;step<steps&&index>0;step++){
    index--;const code=text.charCodeAt(index);
    if(code>=0xdc00&&code<=0xdfff&&index>0){const high=text.charCodeAt(index-1);if(high>=0xd800&&high<=0xdbff)index--;}
  }
  return index;
}
export function agentCharLength(text:string):number {
  return text.length<CHECKPOINT_STRIDE?countCodePointsRange(text,0,text.length):unicodeIndex(text).codePoints;
}
export function agentUtf16Offset(text:string,offset:number):number {
  if(!Number.isInteger(offset)||offset<0)throw Error('offset must be a non-negative Unicode character offset');
  if(offset===0)return 0;
  if(text.length<CHECKPOINT_STRIDE)return advanceUtf16ByCodePoints(text,0,offset);
  const idx=unicodeIndex(text);
  if(offset>idx.codePoints)throw Error('offset is beyond the document');
  if(offset===idx.codePoints)return text.length;
  if(idx.codePoints===text.length)return offset;
  const slot=offset>>>CHECKPOINT_SHIFT;
  return advanceUtf16ByCodePoints(text,idx.utf16AtCp[slot],offset-(slot<<CHECKPOINT_SHIFT));
}
export function agentCodePointOffset(text:string,utf16Offset:number):number {
  const limit=Math.max(0,Math.min(text.length,utf16Offset));
  if(limit===0)return 0;
  if(text.length<CHECKPOINT_STRIDE)return countCodePointsRange(text,0,limit);
  const idx=unicodeIndex(text);
  if(limit===text.length)return idx.codePoints;
  if(idx.codePoints===text.length)return limit;
  let lo=0,hi=idx.utf16AtCp.length-1;
  while(lo<hi){const mid=(lo+hi+1)>>>1;if(idx.utf16AtCp[mid]<=limit)lo=mid;else hi=mid-1;}
  return (lo<<CHECKPOINT_SHIFT)+countCodePointsRange(text,idx.utf16AtCp[lo],limit);
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
function isLineBreakCode(code:number):boolean {return (code>=0x0a&&code<=0x0d)||code===0x85||code===0x2028||code===0x2029;}
function endsWithLineBreak(text:string):boolean {return text.length>0&&isLineBreakCode(text.charCodeAt(text.length-1));}
function trailingLineBreak(text:string):string {
  const len=text.length;if(!len||!isLineBreakCode(text.charCodeAt(len-1)))return '\n';
  return len>=2&&text.charCodeAt(len-2)===0x0d&&text.charCodeAt(len-1)===0x0a?'\r\n':text.slice(len-1);
}
type LineRecord={text:string;chars:number;bytes:number};
function lineChars(record:LineRecord):number {return record.chars>=0?record.chars:(record.chars=countCodePointsRange(record.text,0,record.text.length));}
function lineBytes(record:LineRecord):number {return record.bytes>=0?record.bytes:(record.bytes=utf8ByteLength(record.text));}
function splitLineRecords(text:string):LineRecord[] {
  if(!text)return [];
  const records:LineRecord[]=[];
  LINE_BREAK_RE.lastIndex=0;
  let index=0,match:RegExpExecArray|null;
  while((match=LINE_BREAK_RE.exec(text))){
    const end=match.index+match[0].length;
    records.push({text:text.slice(index,end),chars:-1,bytes:-1});
    index=end;
  }
  if(index<text.length)records.push({text:text.slice(index),chars:-1,bytes:-1});
  return records;
}
function peelLeft(text:string):{prefix:string;stub:string} {
  if(text.length<=64)return {prefix:'',stub:text};
  let cut=text.length-2;
  if(isSurrogatePairAt(text,cut-1,text.length))cut--;
  return {prefix:text.slice(0,cut),stub:text.slice(cut)};
}
function peelRight(text:string):{stub:string;suffix:string} {
  if(text.length<=64)return {stub:text,suffix:''};
  let cut=2;
  if(isSurrogatePairAt(text,cut-1,text.length))cut++;
  return {stub:text.slice(0,cut),suffix:text.slice(cut)};
}
function spliceSplit(leftPrefix:string,leftStub:string,middle:string,rightStub:string,rightSuffix:string,leftRec:LineRecord|null,rightRec:LineRecord|null):LineRecord[] {
  const records=splitLineRecords(middle);
  if(leftPrefix){
    const first=records[0];
    const chars=leftRec&&leftRec.chars>=0?leftRec.chars-countCodePointsRange(leftStub,0,leftStub.length)+lineChars(first):-1;
    const bytes=leftRec&&leftRec.bytes>=0?leftRec.bytes-utf8ByteLength(leftStub)+lineBytes(first):-1;
    records[0]={text:leftPrefix+first.text,chars,bytes};
  }
  if(rightSuffix){
    const lastIdx=records.length-1,last=records[lastIdx];
    const chars=rightRec&&rightRec.chars>=0&&(last.chars>=0||lastIdx>0||!leftPrefix)?lineChars(last)+rightRec.chars-countCodePointsRange(rightStub,0,rightStub.length):-1;
    const bytes=rightRec&&rightRec.bytes>=0&&(last.bytes>=0||lastIdx>0||!leftPrefix)?lineBytes(last)+rightRec.bytes-utf8ByteLength(rightStub):-1;
    records[lastIdx]={text:last.text+rightSuffix,chars,bytes};
  }
  return records;
}
function boundaryDelta(leftGuard:string,oldBody:string,newBody:string,rightGuard:string,includeChars:boolean):{deltaChars:number;deltaBytes:number} {
  const oldWin=leftGuard+oldBody+rightGuard,newWin=leftGuard+newBody+rightGuard;
  const deltaBytes=utf8ByteLength(newWin)-utf8ByteLength(oldWin);
  const deltaChars=includeChars?countCodePointsRange(newWin,0,newWin.length)-countCodePointsRange(oldWin,0,oldWin.length):0;
  return {deltaChars,deltaBytes};
}
export type AgentPatchSummary={operationIndex:number;type:AgentPatch['type'];startOffset:number;endOffset:number;deltaChars:number};
function patchDocument(source:string,operations:unknown,includeSummaries:boolean):{text:string;applied:number;operations:AgentPatchSummary[]} {
  if(!Array.isArray(operations)||operations.length<1||operations.length>100||utf8ByteLength(JSON.stringify(operations))>64_000)throw Error('Provide 1–100 patch operations within 64 KB');
  let edited:string|null=source,lineTable:LineRecord[]|null=null;
  let totalBytes=-1;
  const summaries:AgentPatchSummary[]=[];
  for(const [operationIndex,operation] of operations.entries()){
    const fail=(message:string):never=>{throw Error(`operations[${operationIndex}]: ${message}`);};
    if(!operation||typeof operation!=='object'||Array.isArray(operation))fail('Each patch must be an object');
    const op=operation as Record<string,unknown>,kind=op.type;
    const validateKeys=(allowed:string[])=>{for(const key of Object.keys(op))if(!allowed.includes(key))fail(`Unknown field '${key}'; expected ${allowed.join(', ')}`);};
    let startOffset=0,endOffset=0,deltaChars=0,deltaBytes=0;
    if(kind==='replace'){
      validateKeys(['type','old','new','count','expectedCount']);
      const oldValue=op.old,replacementValue=op.new,expectedCount=op.expectedCount,count=op.count===undefined?(typeof expectedCount==='number'&&expectedCount>1?'all':1):op.count;
      if(typeof oldValue!=='string'||!oldValue)fail('replace.old must be non-empty text');
      if(typeof replacementValue!=='string')fail('replace.new must be text');
      const old=oldValue as string,replacement=replacementValue as string;
      if(count!==1&&count!=='all')fail("replace.count must be 1 or 'all'");
      if(expectedCount!==undefined&&(typeof expectedCount!=='number'||!Number.isInteger(expectedCount)||expectedCount<1))fail('replace.expectedCount must be a positive integer');
      if(edited===null)edited=lineTable!.map(item=>item.text).join('');
      if(totalBytes<0)totalBytes=utf8ByteLength(edited);
      if(count===1){
        const first=edited.indexOf(old);
        let occurrences=first>=0?1:0;
        if(first>=0){let cursor=first+old.length;while((cursor=edited.indexOf(old,cursor))>=0){occurrences++;cursor+=old.length;}}
        if(occurrences!==1||(expectedCount!==undefined&&occurrences!==expectedCount))fail(`Exact replacement expected ${expectedCount??'one'} match; found ${occurrences}`);
        const uEnd=first+old.length;
        const delta=boundaryDelta(first>0?edited.slice(first-1,first):'',old,replacement,uEnd<edited.length?edited.slice(uEnd,uEnd+1):'',includeSummaries);
        deltaChars=delta.deltaChars;deltaBytes=delta.deltaBytes;
        if(totalBytes+deltaBytes>20_000_000)fail('Edited Markdown exceeds 20 MB');
        if(lineTable!==null){
          let lineIdx=0,lineUtf16Start=0,prefixCp=0;
          while(lineIdx<lineTable.length-1&&lineUtf16Start+lineTable[lineIdx].text.length<=first){
            lineUtf16Start+=lineTable[lineIdx].text.length;if(includeSummaries)prefixCp+=lineChars(lineTable[lineIdx]);lineIdx++;
          }
          const firstLine=lineIdx,firstLineOffset=first-lineUtf16Start;
          if(includeSummaries){
            startOffset=prefixCp+countCodePointsRange(lineTable[firstLine].text,0,firstLineOffset);
            endOffset=startOffset+countCodePointsRange(old,0,old.length);
          }
          let endLine=firstLine,endLineUtf16Start=lineUtf16Start;
          while(endLine<lineTable.length-1&&endLineUtf16Start+lineTable[endLine].text.length<uEnd){
            endLineUtf16Start+=lineTable[endLine].text.length;endLine++;
          }
          const head=lineTable[firstLine].text.slice(0,firstLineOffset),tail=lineTable[endLine].text.slice(uEnd-endLineUtf16Start);
          const usePrev=!head.length&&firstLine>0,useNext=!tail.length&&endLine+1<lineTable.length;
          const windowStart=usePrev?firstLine-1:firstLine,windowEnd=useNext?endLine+2:endLine+1;
          const leftLine=usePrev?lineTable[windowStart].text:head,rightLine=useNext?lineTable[windowEnd-1].text:tail;
          const leftPeeled=peelLeft(leftLine),rightPeeled=peelRight(rightLine);
          const newRecords=spliceSplit(leftPeeled.prefix,leftPeeled.stub,leftPeeled.stub+replacement+rightPeeled.stub,rightPeeled.stub,rightPeeled.suffix,usePrev?lineTable[windowStart]:null,useNext?lineTable[windowEnd-1]:null);
          if(newRecords.length<=4096)lineTable.splice(windowStart,windowEnd-windowStart,...newRecords);
          else lineTable=lineTable.slice(0,windowStart).concat(newRecords,lineTable.slice(windowEnd));
        }else if(includeSummaries){
          startOffset=countCodePointsRange(edited,0,first);
          endOffset=startOffset+countCodePointsRange(old,0,old.length);
        }
        edited=edited.slice(0,first)+replacement+edited.slice(uEnd);
      }else{
        lineTable=null;
        const positions:number[]=[];let cursor=0;
        while((cursor=edited.indexOf(old,cursor))>=0){positions.push(cursor);cursor+=old.length;}
        const occurrences=positions.length;
        if(!occurrences||(expectedCount!==undefined&&occurrences!==expectedCount))fail(`Exact replacement expected ${expectedCount??'at least one'} match; found ${occurrences}`);
        if(includeSummaries){
          const first=positions[0],lastMatchEnd=positions[occurrences-1]+old.length;
          startOffset=countCodePointsRange(edited,0,first);
          let spanChars=countCodePointsRange(edited,first,lastMatchEnd);
          if(first>0&&lastMatchEnd>first&&isSurrogatePairAt(edited,first-1))spanChars--;
          endOffset=startOffset+spanChars;
        }
        const pieces:string[]=[];let prevEnd=0,idx=0;
        while(idx<occurrences){
          const groupStart=positions[idx];let groupIdx=idx,groupNew=replacement;
          while(groupIdx+1<occurrences&&positions[groupIdx+1]-(positions[groupIdx]+old.length)<2){
            groupNew+=edited.slice(positions[groupIdx]+old.length,positions[groupIdx+1])+replacement;
            groupIdx++;
          }
          const groupEnd=positions[groupIdx]+old.length;
          const delta=boundaryDelta(groupStart>0?edited.slice(groupStart-1,groupStart):'',edited.slice(groupStart,groupEnd),groupNew,groupEnd<edited.length?edited.slice(groupEnd,groupEnd+1):'',includeSummaries);
          deltaChars+=delta.deltaChars;deltaBytes+=delta.deltaBytes;
          for(let m=idx;m<=groupIdx;m++){pieces.push(edited.slice(prevEnd,positions[m]),replacement);prevEnd=positions[m]+old.length;}
          idx=groupIdx+1;
        }
        if(totalBytes+deltaBytes>20_000_000)fail('Edited Markdown exceeds 20 MB');
        pieces.push(edited.slice(prevEnd));
        edited=pieces.join('');
      }
    }else if(kind==='lines'||kind==='insert'){
      const isInsert=kind==='insert';validateKeys(isInsert?['type','line','text']:['type','start_line','end_line','text']);
      const lineKey=isInsert?'line':'start_line',lineValue=op[lineKey];
      if(typeof lineValue!=='number'||!Number.isInteger(lineValue))fail(`${isInsert?'insert.line':'lines.start_line'} must be an integer`);
      if(lineTable===null){
        if(totalBytes<0)totalBytes=utf8ByteLength(edited!);
        lineTable=splitLineRecords(edited!);
      }
      const lineCount=lineTable.length,start=lineValue as number;
      if(start<1||start>lineCount+1)fail(`${isInsert?'insert.line':'lines.start_line'} must be between 1 and ${lineCount+1}`);
      let end=start;
      if(!isInsert){const endValue=op.end_line;if(typeof endValue!=='number'||!Number.isInteger(endValue))fail('lines.end_line must be an integer');end=endValue as number;if(end<start||end>lineCount+1)fail(`lines.end_line must be between ${start} and ${lineCount+1}`);}
      if(typeof op.text!=='string')fail(`${isInsert?'insert':'lines'}.text must be text`);
      const spliceStart=start-1,spliceEnd=isInsert?spliceStart:Math.min(end,lineCount);
      if(includeSummaries){
        for(let i=0;i<spliceStart;i++)startOffset+=lineChars(lineTable[i]);
        endOffset=startOffset;
        if(!isInsert)for(let i=spliceStart;i<spliceEnd;i++)endOffset+=lineChars(lineTable[i]);
      }
      let replacement=op.text as string;
      if(isInsert&&start===lineCount+1&&lineCount&&!endsWithLineBreak(lineTable[lineCount-1].text)){
        replacement=(lineCount>=2?trailingLineBreak(lineTable[0].text):'\n')+replacement;
      }
      if(replacement&&!endsWithLineBreak(replacement)&&!isInsert&&end<=lineCount&&endsWithLineBreak(lineTable[end-1].text))replacement+='\n';
      const windowStart=Math.max(0,spliceStart-1),windowEnd=Math.min(lineCount,spliceEnd+1);
      const hasLeft=spliceStart>windowStart,hasRight=windowEnd>spliceEnd;
      const leftPeeled=peelLeft(hasLeft?lineTable[windowStart].text:''),rightPeeled=peelRight(hasRight?lineTable[windowEnd-1].text:'');
      const middle=leftPeeled.stub+replacement+rightPeeled.stub;
      let oldBytes=utf8ByteLength(leftPeeled.stub)+utf8ByteLength(rightPeeled.stub);
      for(let i=spliceStart;i<spliceEnd;i++)oldBytes+=lineBytes(lineTable[i]);
      deltaBytes=utf8ByteLength(middle)-oldBytes;
      if(totalBytes+deltaBytes>20_000_000)fail('Edited Markdown exceeds 20 MB');
      if(includeSummaries){
        let oldChars=countCodePointsRange(leftPeeled.stub,0,leftPeeled.stub.length)+countCodePointsRange(rightPeeled.stub,0,rightPeeled.stub.length);
        for(let i=spliceStart;i<spliceEnd;i++)oldChars+=lineChars(lineTable[i]);
        deltaChars=countCodePointsRange(middle,0,middle.length)-oldChars;
      }
      const newRecords=spliceSplit(leftPeeled.prefix,leftPeeled.stub,middle,rightPeeled.stub,rightPeeled.suffix,hasLeft?lineTable[windowStart]:null,hasRight?lineTable[windowEnd-1]:null);
      if(newRecords.length<=4096)lineTable.splice(windowStart,windowEnd-windowStart,...newRecords);
      else lineTable=lineTable.slice(0,windowStart).concat(newRecords,lineTable.slice(windowEnd));
      edited=null;
    }else fail("Patch type must be 'replace', 'lines' or 'insert'");
    totalBytes+=deltaBytes;
    if(includeSummaries)summaries.push({operationIndex,type:kind as AgentPatch['type'],startOffset,endOffset,deltaChars});
  }
  const finalText=edited??lineTable!.map(item=>item.text).join('');
  return {text:finalText,applied:operations.length,operations:summaries};
}
export function applyAgentPatchesDetailed(source:string,operations:unknown):{text:string;applied:number;operations:AgentPatchSummary[]} {
  return patchDocument(source,operations,true);
}
export function applyAgentPatches(source:string,operations:unknown):string{return patchDocument(source,operations,false).text;}
export type AgentHeading={index:number;level:number;title:string;line:number;start:number;sectionStart:number;sectionEnd:number};
function outlineWithLength(source:string):{headings:AgentHeading[];documentLength:number} {
  const idx=source.length>=CHECKPOINT_STRIDE?unicodeIndex(source):null;
  if(idx?.outline)return {headings:idx.outline,documentLength:idx.codePoints};
  const raw:Array<{index:number;level:number;title:string;line:number;start:number}>=[];
  let position=0,line=0,fence:{marker:string;length:number}|null=null,lineStart=0;
  const sourceLen=source.length;
  while(lineStart<sourceLen){
    let cursor=lineStart;while(cursor<sourceLen&&!isLineBreakCode(source.charCodeAt(cursor)))cursor++;
    const bodyEnd=cursor;
    const lineEnd=cursor<sourceLen?(source.charCodeAt(cursor)===0x0d&&cursor+1<sourceLen&&source.charCodeAt(cursor+1)===0x0a?cursor+2:cursor+1):cursor;
    line++;
    let indent=lineStart;while(indent<bodyEnd&&indent-lineStart<3&&source.charCodeAt(indent)===0x20)indent++;
    const firstChar=indent<bodyEnd?source.charCodeAt(indent):-1;
    if(firstChar===0x60||firstChar===0x7e){
      const body=source.slice(lineStart,bodyEnd),opening=/^ {0,3}(`{3,}|~{3,})/.exec(body);
      if(opening){const marker=opening[1][0],length=opening[1].length;if(!fence)fence={marker,length};else if(fence.marker===marker&&length>=fence.length&&!body.slice(opening[0].length).trim())fence=null;}
    }else if(!fence&&firstChar===0x23){
      const body=source.slice(lineStart,bodyEnd),heading=/^ {0,3}(#{1,6})[\t ]+(.+?)\s*#*\s*$/.exec(body);
      if(heading)raw.push({index:raw.length,level:heading[1].length,title:heading[2].slice(0,300),line,start:position});
    }
    position+=countCodePointsRange(source,lineStart,lineEnd);
    lineStart=lineEnd;
  }
  const documentLength=position,sectionEnds=new Array<number>(raw.length).fill(documentLength),stack:number[]=[];
  for(const heading of raw){
    while(stack.length&&raw[stack[stack.length-1]].level>=heading.level)sectionEnds[stack.pop()!]=heading.start;
    stack.push(heading.index);
  }
  const headings=raw.map((heading,index)=>({...heading,sectionStart:heading.start,sectionEnd:sectionEnds[index]}));
  if(idx)idx.outline=headings;
  return {headings,documentLength};
}
export function agentOutline(source:string):AgentHeading[] {return outlineWithLength(source).headings.map(item=>({...item}));}
export function agentOutlinePage(source:string,offset:unknown=0,limit:unknown=80){
  const {headings,documentLength}=outlineWithLength(source);
  if(typeof offset!=='number'||!Number.isInteger(offset)||offset<0||offset>headings.length)throw Error(`outline offset must be between 0 and ${headings.length}`);
  if(typeof limit!=='number'||!Number.isInteger(limit)||limit<1||limit>80)throw Error('outline limit must be between 1 and 80');
  const pageOffset=offset,end=Math.min(headings.length,pageOffset+limit);
  return {headings:headings.slice(pageOffset,end),offset:pageOffset,total:headings.length,nextOffset:end<headings.length?end:null,truncated:end<headings.length,documentLength};
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
  const {headings,documentLength}=outlineWithLength(source),heading=resolveAgentHeading(headings,selector);
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
function collectFenceSpans(source:string,includeDiagrams:boolean):SvgSpan[] {
  const spans:SvgSpan[]=[],sourceLen=source.length;let position=0,lineNumber=1,lineStart=0;
  let open:{marker:string;length:number;start:number;startUtf16:number;lineStart:number;matched:boolean;probe:string}|null=null;
  while(lineStart<sourceLen){
    let cursor=lineStart;while(cursor<sourceLen&&!isLineBreakCode(source.charCodeAt(cursor)))cursor++;
    const bodyEnd=cursor;
    const lineEnd=cursor<sourceLen?(source.charCodeAt(cursor)===0x0d&&cursor+1<sourceLen&&source.charCodeAt(cursor+1)===0x0a?cursor+2:cursor+1):cursor;
    const lineChars=countCodePointsRange(source,lineStart,lineEnd);
    let indent=lineStart;while(indent<bodyEnd&&indent-lineStart<3&&source.charCodeAt(indent)===0x20)indent++;
    const firstChar=indent<bodyEnd?source.charCodeAt(indent):-1;
    let handledFence=false;
    if(firstChar===0x60||firstChar===0x7e){
      const body=source.slice(lineStart,bodyEnd),fence=/^ {0,3}(`{3,}|~{3,})/.exec(body);
      if(fence){
        const marker=fence[1][0],length=fence[1].length;
        if(!open){
          const language=body.slice(fence[0].length).trim().split(/\s+/,1)[0]?.toLowerCase()??'';
          const matched=includeDiagrams?['svg','svg+xml','image/svg+xml','mermaid','smd-chart'].includes(language):['svg','svg+xml','image/svg+xml'].includes(language);
          open={marker,length,start:position+lineChars,startUtf16:lineEnd,lineStart:lineNumber+1,matched,probe:''};
        }else if(marker===open.marker&&length>=open.length){
          if(open.matched||open.probe.trimStart().toLowerCase().startsWith('<svg')){
            spans.push({start:open.start,end:position,startUtf16:open.startUtf16,endUtf16:lineStart,line_start:open.lineStart,line_end:Math.max(open.lineStart,lineNumber-1)});
          }
          open=null;
        }
        handledFence=true;
      }
    }
    if(!handledFence&&open&&!open.matched&&open.probe.length<2048){
      const take=Math.min(512,2048-open.probe.length,bodyEnd-lineStart);
      if(take>0)open.probe+=source.slice(lineStart,lineStart+take);
    }
    position+=lineChars;lineNumber++;lineStart=lineEnd;
  }
  if(open&&(open.matched||open.probe.trimStart().toLowerCase().startsWith('<svg'))){
    spans.push({start:open.start,end:position,startUtf16:open.startUtf16,endUtf16:source.length,line_start:open.lineStart,line_end:Math.max(open.lineStart,lineNumber-1)});
  }
  return spans;
}
function svgSpans(source:string):SvgSpan[] {
  const idx=source.length>=CHECKPOINT_STRIDE?unicodeIndex(source):null;
  if(idx?.svgSpans)return idx.svgSpans;
  const spans=collectFenceSpans(source,false);
  if(idx)idx.svgSpans=spans;
  return spans;
}
function elideSvgPage(source:string,start:number,end:number,spans:SvgSpan[],startUtf16:number) {
  const omissions:Array<{source_start:number;source_end:number;line_start:number;line_end:number;omitted_chars:number;omitted_lines:number}>=[];
  const pieces:string[]=[];let cursor=start,utf16Cursor=startUtf16;
  const moveCursor=(target:number):number=>{
    if(target>cursor){utf16Cursor=advanceUtf16ByCodePoints(source,utf16Cursor,target-cursor);cursor=target;}
    return utf16Cursor;
  };
  for(const span of spans){
    const left=Math.max(start,span.start),right=Math.min(end,span.end);if(left>=right)continue;
    const fromUtf16=utf16Cursor;
    const leftUtf16=left===span.start?span.startUtf16:moveCursor(left);
    pieces.push(source.slice(fromUtf16,leftUtf16));
    const item={source_start:span.start,source_end:span.end,line_start:span.line_start,line_end:span.line_end,
      omitted_chars:span.end-span.start,omitted_lines:Math.max(1,span.line_end-span.line_start+1)};omissions.push(item);
    pieces.push(`[SVG omitted: ${item.omitted_chars} chars, source lines ${item.line_start}–${item.line_end}]\n`);
    if(right===span.end){cursor=span.end;utf16Cursor=span.endUtf16;}
    else{cursor=left;utf16Cursor=leftUtf16;moveCursor(right);}
  }
  if(!omissions.length)return {text:source.slice(startUtf16,moveCursor(end)),svg_omissions:omissions};
  const tailFrom=utf16Cursor;pieces.push(source.slice(tailFrom,moveCursor(end)));
  return {text:pieces.join(''),svg_omissions:omissions};
}
function prosePageEnd(start:number,limit:number,maxEnd:number,spans:SvgSpan[]) {
  let cursor=start,remaining=limit;
  for(const span of spans){
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
  const count=boundedInt(limit,12_000,1,12_000);
  const spans=view==='prose'?svgSpans(source):[];
  const finish=view==='prose'?prosePageEnd(start,count,end,spans):Math.min(end,start+count);
  const startUtf16=agentUtf16Offset(source,start);
  const viewResult=view==='prose'
    ?elideSvgPage(source,start,finish,spans,startUtf16)
    :{text:source.slice(startUtf16,advanceUtf16ByCodePoints(source,startUtf16,finish-start)),svg_omissions:[] as Array<{source_start:number;source_end:number;line_start:number;line_end:number;omitted_chars:number;omitted_lines:number}>};
  return {...viewResult,start,end:finish,total_chars:sectionEnd-sectionStart,next_offset:finish<sectionEnd?finish:null,truncated:finish<sectionEnd,view,returned_chars:agentCharLength(viewResult.text),sectionStart,sectionEnd,documentLength};
}
type SearchOptions={offset?:unknown;caseSensitive?:unknown;wholeWord?:unknown;regex?:unknown;excludeDiagrams?:unknown};
type SearchMatch={offset:number;line:number;text:string;matchOffset:number;matchLength:number;snippetOffset:number};
function searchDiagramSpans(source:string):Array<{start:number;end:number}>{
  const idx=source.length>=CHECKPOINT_STRIDE?unicodeIndex(source):null;
  if(idx?.diagramSpans)return idx.diagramSpans;
  const spans=collectFenceSpans(source,true).map(span=>({start:span.start,end:span.end}));
  if(idx)idx.diagramSpans=spans;
  return spans;
}
function safeRegex(query:string):RegExp{
  let inClass=false,escaped=false;
  for(const ch of query){if(escaped){if(/[1-9]/.test(ch)||ch==='k')throw Error('regex supports no backreferences');if(!inClass&&(ch==='b'||ch==='B'))throw Error('regex supports no zero-width word-boundary assertions');escaped=false;continue;}
    if(ch==='\\'){escaped=true;continue;}if(ch==='[')inClass=true;else if(ch===']')inClass=false;else if(!inClass&&'*+?{}()|'.includes(ch))throw Error('regex supports literals, dot, character classes and anchors only; quantifiers, groups and alternation are not supported');}
  if(escaped)throw Error('regex ends with an incomplete escape');
  let compiled:RegExp;try{compiled=new RegExp(query,'gmu');}catch{throw Error('regex is not valid in the supported safe subset');}
  if(compiled.test(''))throw Error('regex must match at least one character');return compiled;
}
function foldSearchCase(text:string):string {
  return (text.indexOf('\u03a3')>=0?text.replaceAll('\u03a3','\u03c3'):text).toLowerCase();
}
function isAsciiWordCode(code:number):boolean {
  return (code>=0x30&&code<=0x39)||(code>=0x41&&code<=0x5a)||(code>=0x61&&code<=0x7a)||code===0x5f;
}
function hasAdjacentWordBefore(source:string,leftUtf16:number):boolean {
  if(leftUtf16<=0)return false;
  const prev=source.charCodeAt(leftUtf16-1);
  if(prev<0x80)return isAsciiWordCode(prev);
  const start=prev>=0xdc00&&prev<=0xdfff&&leftUtf16>=2&&source.charCodeAt(leftUtf16-2)>=0xd800&&source.charCodeAt(leftUtf16-2)<=0xdbff?leftUtf16-2:leftUtf16-1;
  return WORD_CHAR_RE.test(source.slice(start,leftUtf16));
}
function hasAdjacentWordAfter(source:string,rightUtf16:number):boolean {
  if(rightUtf16>=source.length)return false;
  const next=source.charCodeAt(rightUtf16);
  if(next<0x80)return isAsciiWordCode(next);
  const end=next>=0xd800&&next<=0xdbff&&rightUtf16+1<source.length&&source.charCodeAt(rightUtf16+1)>=0xdc00&&source.charCodeAt(rightUtf16+1)<=0xdfff?rightUtf16+2:rightUtf16+1;
  return WORD_CHAR_RE.test(source.slice(rightUtf16,end));
}
export function agentSearch(source:string,query:unknown,limit:unknown=10,context:unknown=100,options:SearchOptions={}) {
  if(typeof query!=='string'||!query||agentCharLength(query)>500)throw Error('query must contain 1–500 characters');
  const sourceLength=agentCharLength(source),maximum=boundedInt(limit,10,1,25),around=boundedInt(context,100,0,500),offset=boundedInt(options.offset,0,0,sourceLength);
  for(const key of ['caseSensitive','wholeWord','regex','excludeDiagrams'] as const)if(options[key]!==undefined&&typeof options[key]!=='boolean')throw Error(`${key} must be a boolean`);
  const caseSensitive=options.caseSensitive===true,wholeWord=options.wholeWord===true,useRegex=options.regex===true,excludeDiagrams=options.excludeDiagrams===true;
  const spans=excludeDiagrams?searchDiagramSpans(source):[];
  const matches:SearchMatch[]=[];let totalMatches=0,remainingMatches=0,spanIndex=0,lineCursorUtf16=0,lineNumber=1;
  const accept=(startCp:number,endCp:number,leftUtf16:number,rightUtf16:number)=>{
    if(endCp<=startCp)return false;
    if(wholeWord&&(hasAdjacentWordBefore(source,leftUtf16)||hasAdjacentWordAfter(source,rightUtf16)))return false;
    if(spans.length){
      while(spanIndex<spans.length&&spans[spanIndex].end<=startCp)spanIndex++;
      if(spanIndex<spans.length&&startCp<spans[spanIndex].end&&endCp>spans[spanIndex].start)return false;
    }
    totalMatches++;
    if(startCp<offset)return true;
    remainingMatches++;
    if(matches.length<maximum){
      let nl:number;while((nl=source.indexOf('\n',lineCursorUtf16))>=0&&nl<leftUtf16){lineNumber++;lineCursorUtf16=nl+1;}
      lineCursorUtf16=leftUtf16;
      const snippetOffset=Math.max(0,startCp-around),snippetEnd=Math.min(sourceLength,endCp+around);
      const snippetLeft=retreatUtf16ByCodePoints(source,leftUtf16,startCp-snippetOffset);
      const snippetRight=advanceUtf16ByCodePoints(source,rightUtf16,snippetEnd-endCp);
      matches.push({offset:startCp,line:lineNumber,text:source.slice(snippetLeft,snippetRight),matchOffset:startCp,matchLength:endCp-startCp,snippetOffset});
    }
    return true;
  };
  if(useRegex){
    const matcher=safeRegex(query);
    let match:RegExpExecArray|null,utf16Cursor=0,cpCursor=0;
    while((match=matcher.exec(source))){
      if(!match[0].length){matcher.lastIndex=match.index+(isSurrogatePairAt(source,match.index)?2:1);continue;}
      cpCursor+=countCodePointsRange(source,utf16Cursor,match.index);utf16Cursor=match.index;
      const startCp=cpCursor,leftUtf16=utf16Cursor;
      cpCursor+=countCodePointsRange(match[0],0,match[0].length);utf16Cursor+=match[0].length;
      accept(startCp,cpCursor,leftUtf16,utf16Cursor);
    }
  }else if(caseSensitive){
    const queryCpLength=countCodePointsRange(query,0,query.length);
    let searchFrom=0,utf16Cursor=0,cpCursor=0,matchIndex:number;
    while((matchIndex=source.indexOf(query,searchFrom))>=0){
      const matchEnd=matchIndex+query.length;
      if((matchIndex>0&&isSurrogatePairAt(source,matchIndex-1))||(matchEnd<source.length&&isSurrogatePairAt(source,matchEnd-1))){
        searchFrom=matchIndex+1;continue;
      }
      cpCursor+=countCodePointsRange(source,utf16Cursor,matchIndex);
      const startCp=cpCursor,endCp=startCp+queryCpLength;
      accept(startCp,endCp,matchIndex,matchEnd);
      utf16Cursor=matchEnd;cpCursor=endCp;searchFrom=matchEnd;
    }
  }else{
    const normalized=foldSearchCase(source),normalizedQuery=foldSearchCase(query);
    let cursor=0,found:number,sourceCp=0,normalizedCp=0,utf16Cp=0;
    const advanceToNormalized=(target:number):boolean=>{
      while(utf16Cp<source.length&&normalizedCp<target){
        const code=source.charCodeAt(utf16Cp);
        if(code>=0xd800&&code<=0xdbff&&utf16Cp+1<source.length){
          const low=source.charCodeAt(utf16Cp+1);
          if(low>=0xdc00&&low<=0xdfff){normalizedCp+=2;sourceCp++;utf16Cp+=2;continue;}
        }
        normalizedCp+=code===0x0130?2:1;sourceCp++;utf16Cp++;
      }
      return normalizedCp===target;
    };
    while((found=normalized.indexOf(normalizedQuery,cursor))>=0){
      if(!advanceToNormalized(found)){cursor=found+1;continue;}
      const startCp=sourceCp,leftUtf16=utf16Cp,savedNorm=normalizedCp;
      if(!advanceToNormalized(found+normalizedQuery.length)){
        sourceCp=startCp;utf16Cp=leftUtf16;normalizedCp=savedNorm;cursor=found+1;continue;
      }
      accept(startCp,sourceCp,leftUtf16,utf16Cp);
      cursor=found+Math.max(1,normalizedQuery.length);
    }
  }
  const truncated=remainingMatches>matches.length,last=matches[matches.length-1],nextOffset=truncated&&last?last.matchOffset+last.matchLength:null;
  return {matches,truncated,totalMatches,remainingMatches,nextOffset};
}
