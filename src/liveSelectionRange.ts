import type {Root} from 'mdast';
import {visit} from 'unist-util-visit';
import {caretRangeAtPoint} from './caretPoint';
import {analyzeDocument,type SourceDocumentAnalysis} from './documentAnalysis';
import {translateRenderedRange,type EditingSession,type SelectionDirection} from './liveBlockHistory';
import {toggleMarkdownFormat,type FormatAction} from './markdownFormatting';

export interface LiveEditingSpanContext {baseMarkdown:string;baseSplitEnd:number}
export interface LiveRenderedSelectionRange {
  blockElement:HTMLElement;renderedBlockStart:number;renderedBlockEnd:number;renderedFrom:number;renderedTo:number;
  blockStart:number;blockEnd:number;from:number;to:number;reversed:boolean;
}
export interface PlannedLiveFormat {doc:string;nextBlockText:string;nextStart:number;nextEnd:number;nextDirection:SelectionDirection}

const EXCLUDED_SELECTION_CONTAINER_SELECTOR='textarea,input,select,button,.cm-editor,.live-active-block,.live-block-edit,.code-toolbar,.cell-toolbar,.cell-output,[data-frontmatter-properties],.document-properties,.reading-search,.image-viewer,.media-dialog,.math-repair-panel,[data-windowed-mounted="false"]';
const NON_TEXT_DOUBLE_CLICK_TARGET_SELECTOR='a,button,input,select,textarea,img,.note-image,.image-error,.remote-image-card,.image-loading,svg,hr,.live-block-edit,.code-toolbar,.cell-toolbar,.cell-output,[data-frontmatter-properties],.document-properties,[data-windowed-mounted="false"]';
const NON_TEXT_CARET_CONTAINER_SELECTOR='button,input,select,textarea,img,.note-image,.image-error,.remote-image-card,.image-loading,svg,hr,.live-block-edit,.code-toolbar,.cell-toolbar,.cell-output,[data-frontmatter-properties],.document-properties,[data-windowed-mounted="false"]';
const LEAF_BLOCK_SELECTOR='p,h1,h2,h3,h4,h5,h6,li,summary,td,th,pre';
const RAW_HTML_TOKEN=/(<!--[\s\S]*?-->|<\/?(?:br|mark|sub|sup|kbd|u)(?:\s+(?:[^>"']|"[^"]*"|'[^']*')*)?\s*\/?>)/gi;
const BR_HTML_TAG=/^<br(?:\s+(?:[^>"']|"[^"]*"|'[^']*')*)?\s*\/?>$/i;
const OPEN_HTML_TAG=/^<(mark|sub|sup|kbd|u)(?:\s+(?:[^>"']|"[^"]*"|'[^']*')*)?>$/i;
const CLOSE_HTML_TAG=/^<\/(mark|sub|sup|kbd|u)\s*>$/i;
const IMAGE_ATTR_PREFIX=/^\{[^}\r\n]*\b(?:width|zoom)\s*=\s*[^}\r\n]+\}/i;

interface SourceUnit {from:number;to:number;char:string}
interface InlineWrapperBounds {kind:string;outerStart:number;innerStart:number;innerEnd:number;outerEnd:number}
interface ResolvedScopeStream {children:any[];scopeStart:number;scopeEnd:number;synthesizedCalloutTitle?:boolean}
interface DomBoundaryHit {unit:number;preferPrevEnd:boolean;mathOrdinal:number|null}
interface DomRangeStream {text:string;start:DomBoundaryHit;end:DomBoundaryHit}
type MappedRenderedSpan={kind:'caret';offset:number}|{kind:'range';from:number;to:number};

const elementAt=(node:Node|null):Element|null=>!node?null:node instanceof Element?node:node.parentElement;
const closestLeafInBlock=(el:Element,blockEl:HTMLElement):HTMLElement|null=>{const leaf=el.closest<HTMLElement>(LEAF_BLOCK_SELECTOR);return leaf&&blockEl.contains(leaf)?leaf:null;};
export const translateLiveRenderedRange:(start:number,end:number,editing:LiveEditingSpanContext|null,activeDoc:string)=>[number,number]=
  (start,end,editing,activeDoc)=>translateRenderedRange(start,end,editing as EditingSession|null,activeDoc);

function isSelectionBackward(selection:Selection):boolean{
  const {anchorNode,anchorOffset,focusNode,focusOffset}=selection;
  if(!anchorNode||!focusNode)return false;
  if(anchorNode===focusNode)return anchorOffset>focusOffset;
  try{
    const a=anchorNode.ownerDocument?.createRange(),f=focusNode.ownerDocument?.createRange();
    if(!a||!f)return false;
    a.setStart(anchorNode,anchorOffset);a.collapse(true);f.setStart(focusNode,focusOffset);f.collapse(true);
    return a.compareBoundaryPoints(Range.START_TO_START,f)>0;
  }catch{return false;}
}
function findPercentCommentClose(raw:string,openIndex:number):number{
  for(let i=openIndex+2;i+1<raw.length;i++)if(raw[i]==='%'&&raw[i+1]==='%'&&raw[i-1]!=='\\')return i+2;
  return -1;
}
function skipIgnoredComments(source:string,cursor:number,limitEnd:number):number{
  let pos=cursor;
  while(pos<limitEnd){
    if(pos+1<limitEnd&&source[pos]==='%'&&source[pos+1]==='%'&&(pos===0||source[pos-1]!=='\\')){const close=findPercentCommentClose(source.slice(pos,limitEnd),0);if(close>0){pos+=close;continue;}}
    if(source.startsWith('<!--',pos)){const close=source.indexOf('-->',pos+4);if(close>=0&&close+3<=limitEnd){pos=close+3;continue;}}
    break;
  }
  return pos;
}
function consumeTextUnits(raw:string,value:string,baseOffset:number):{units:SourceUnit[];consumedRaw:number}{
  if(raw===value)return {units:Array.from(value,(char,i)=>({from:baseOffset+i,to:baseOffset+i+1,char})),consumedRaw:value.length};
  const out:SourceUnit[]=[];let r=0,v=0;
  while(v<value.length&&r<raw.length){
    if(raw[r]==='%'&&raw[r+1]==='%'&&(r===0||raw[r-1]!=='\\')&&!(value[v]==='%'&&value[v+1]==='%')){const end=findPercentCommentClose(raw,r);if(end>r){r=end;continue;}}
    if(raw.startsWith('<!--',r)&&!value.startsWith('<!--',v)){const end=raw.indexOf('-->',r+4);if(end>=0){r=end+3;continue;}}
    const vCh=value[v],rCh=raw[r];
    if(vCh==='\n'){const nl=/^[ \t]*\r?\n[ \t>]*/.exec(raw.slice(r));if(nl){out.push({from:baseOffset+r,to:baseOffset+r+nl[0].length,char:'\n'});r+=nl[0].length;v++;continue;}}
    if(rCh==='\\'&&r+1<raw.length&&raw[r+1]===vCh){out.push({from:baseOffset+r,to:baseOffset+r+2,char:vCh});r+=2;v++;continue;}
    if(rCh==='&'){
      const entity=/^&(?:#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/.exec(raw.slice(r));
      if(entity&&(rCh!==vCh||!raw.slice(r).startsWith(value.slice(v,v+entity[0].length)))){
        const unitLen=(value.codePointAt(v)??0)>0xffff?2:1;
        for(let k=0;k<unitLen&&v+k<value.length;k++)out.push({from:baseOffset+(k===0?r:r+entity[0].length),to:baseOffset+r+entity[0].length,char:value[v+k]});
        r+=entity[0].length;v+=unitLen;continue;
      }
    }
    out.push({from:baseOffset+r,to:baseOffset+r+1,char:vCh});r++;v++;
  }
  while(v<value.length){const clamped=baseOffset+Math.min(r,raw.length);out.push({from:clamped,to:clamped,char:value[v++]});}
  return {units:out,consumedRaw:r};
}
function inlineMathInnerBounds(source:string,start:number,end:number):[number,number]{
  const raw=source.slice(start,end);
  if((raw.startsWith('\\(')&&raw.endsWith('\\)')&&raw.length>=4)||(raw.startsWith('$$')&&raw.endsWith('$$')&&raw.length>=4))return [start+2,end-2];
  return raw.startsWith('$')&&raw.endsWith('$')&&raw.length>=2?[start+1,end-1]:[start,end];
}
function inlineCodeInnerBounds(source:string,start:number,end:number,value:string):[number,number]{
  const raw=source.slice(start,end);let ticks=0;
  while(ticks<raw.length&&raw[ticks]==='`')ticks++;
  if(ticks===0||ticks*2>raw.length)return [start,end];
  const inner=raw.slice(ticks,raw.length-ticks);
  if(inner.length===value.length+2&&inner.startsWith(' ')&&inner.endsWith(' ')&&inner.slice(1,-1)===value)return [start+ticks+1,end-ticks-1];
  if(inner.length===value.length)return [start+ticks,end-ticks];
  const idx=raw.indexOf(value,ticks);
  return idx>=0?[start+idx,start+idx+value.length]:[start+ticks,Math.max(start+ticks,end-ticks)];
}
const flattenInlineText=(nodes:any[]):string=>nodes.reduce((out,n)=>out+(typeof n?.value==='string'?n.value:Array.isArray(n?.children)?flattenInlineText(n.children):''),'');
const stripPositionsBefore=(nodes:any[],minOffset:number):any[]=>nodes.map(n=>!n||typeof n!=='object'?n:{
  ...n,position:typeof n.position?.start?.offset==='number'&&n.position.start.offset>=minOffset?n.position:undefined,
  ...(Array.isArray(n.children)?{children:stripPositionsBefore(n.children,minOffset)}:{}),
});

function collectMdastInlineStream(children:any[],source:string,scopeStart:number,scopeEnd:number,units:SourceUnit[],wrappers:InlineWrapperBounds[],mathWrappers:InlineWrapperBounds[]):void{
  const htmlStack:Array<{tag:string;outerStart:number;innerStartUnit:number}>=[];
  let cursor=scopeStart,prevImageEnd=-1;

  const walkList=(nodes:any[],limitEnd:number)=>{
    for(const node of nodes){
      if(!node)continue;
      let start:number|undefined=node.position?.start?.offset,end:number|undefined=node.position?.end?.offset;
      const followedImage=prevImageEnd>=0,imageAttrEnd=prevImageEnd;
      prevImageEnd=-1;

      if(node.type==='text'&&typeof node.value==='string'){
        if(typeof start==='number'&&typeof end==='number'){
          let effStart=followedImage&&imageAttrEnd>start&&imageAttrEnd<=end?imageAttrEnd:start;
          if(followedImage&&effStart===start&&end>start){
            const attr=IMAGE_ATTR_PREFIX.exec(source.slice(start,end));
            if(attr&&end-start-attr[0].length>=node.value.length)effStart=start+attr[0].length;
          }
          units.push(...consumeTextUnits(source.slice(effStart,end),node.value,effStart).units);cursor=end;
        }else{
          cursor=skipIgnoredComments(source,cursor,limitEnd);
          if(followedImage){const attr=IMAGE_ATTR_PREFIX.exec(source.slice(cursor,limitEnd));if(attr)cursor+=attr[0].length;}
          const consumed=consumeTextUnits(source.slice(cursor,limitEnd),node.value,cursor);
          units.push(...consumed.units);cursor+=consumed.consumedRaw;
        }
        continue;
      }
      const rawEqTex=node.data?.hProperties?.['data-source-tex'];
      if(typeof rawEqTex==='string'&&rawEqTex.length>0){
        cursor=skipIgnoredComments(source,cursor,limitEnd);
        const foundAt=source.startsWith(rawEqTex,cursor)?cursor:source.indexOf(rawEqTex,cursor);
        const eqStart=foundAt>=cursor&&foundAt+rawEqTex.length<=limitEnd?foundAt:cursor,eqEnd=Math.min(limitEnd,eqStart+rawEqTex.length);
        for(const ch of flattenInlineText(node.children??[]))units.push({from:eqStart,to:eqEnd,char:ch});
        wrappers.push({kind:'equationRef',outerStart:eqStart,innerStart:eqStart,innerEnd:eqEnd,outerEnd:eqEnd});cursor=eqEnd;continue;
      }
      if(node.type==='inlineCode'&&typeof node.value==='string'){
        if(typeof start!=='number'||typeof end!=='number'){
          cursor=skipIgnoredComments(source,cursor,limitEnd);
          if(!source.startsWith('`',cursor)){const nextTick=source.indexOf('`',cursor);if(nextTick>=cursor&&nextTick<limitEnd)cursor=nextTick;}
          const m=/^(`+)([\s\S]*?)\1/.exec(source.slice(cursor,limitEnd));
          if(m){start=cursor;end=cursor+m[0].length;}
        }
        if(typeof start==='number'&&typeof end==='number'){
          const [innerStart,innerEnd]=inlineCodeInnerBounds(source,start,end,node.value);
          wrappers.push({kind:'inlineCode',outerStart:start,innerStart,innerEnd,outerEnd:end});
          for(let i=0;i<node.value.length;i++){const pos=Math.min(innerEnd,innerStart+i);units.push({from:pos,to:Math.min(innerEnd,pos+1),char:node.value[i]});}
          cursor=end;continue;
        }
      }
      if(node.type==='inlineMath'){
        if(typeof start!=='number'||typeof end!=='number'){
          cursor=skipIgnoredComments(source,cursor,limitEnd);
          const m=/^(?:\\\([\s\S]*?\\\)|\$\$[\s\S]*?\$\$|\$(?:\\.|[^$\\\r\n])+\$)/.exec(source.slice(cursor,limitEnd));
          if(m){start=cursor;end=cursor+m[0].length;}
        }
        if(typeof start==='number'&&typeof end==='number'){
          const [innerStart,innerEnd]=inlineMathInnerBounds(source,start,end);
          const entry:InlineWrapperBounds={kind:'inlineMath',outerStart:start,innerStart,innerEnd,outerEnd:end};
          wrappers.push(entry);mathWrappers.push(entry);units.push({from:start,to:end,char:'\uFFFC'});cursor=end;continue;
        }
      }
      if(node.type==='break'&&typeof start==='number'&&typeof end==='number'){units.push({from:start,to:end,char:'\n'});cursor=end;continue;}
      if((node.type==='image'||node.type==='imageReference')&&typeof start==='number'&&typeof end==='number'){
        const attr=IMAGE_ATTR_PREFIX.exec(source.slice(end,limitEnd)),outerEnd=attr?end+attr[0].length:end;
        wrappers.push({kind:node.type,outerStart:start,innerStart:start,innerEnd:outerEnd,outerEnd});
        units.push({from:start,to:outerEnd,char:'\uFFFC'});cursor=outerEnd;prevImageEnd=outerEnd;continue;
      }
      if(node.type==='footnoteReference'&&typeof start==='number'&&typeof end==='number'){
        wrappers.push({kind:'footnoteReference',outerStart:start,innerStart:start,innerEnd:end,outerEnd:end});
        units.push({from:start,to:end,char:'\uFFFC'});cursor=end;continue;
      }
      if(node.type==='html'&&typeof node.value==='string'&&typeof start==='number'){
        let htmlCursor=start;
        for(const part of node.value.split(RAW_HTML_TOKEN)){
          if(!part)continue;
          const partStart=htmlCursor,partEnd=htmlCursor+part.length;htmlCursor=partEnd;
          if(part.startsWith('<!--')&&part.endsWith('-->'))continue;
          if(BR_HTML_TAG.test(part)){units.push({from:partStart,to:partEnd,char:'\n'});continue;}
          const open=OPEN_HTML_TAG.exec(part);
          if(open&&!part.slice(0,-1).trimEnd().endsWith('/')){htmlStack.push({tag:open[1].toLowerCase(),outerStart:partStart,innerStartUnit:units.length});continue;}
          const close=CLOSE_HTML_TAG.exec(part);
          if(close){
            const matchIdx=htmlStack.map(h=>h.tag).lastIndexOf(close[1].toLowerCase());
            if(matchIdx>=0){
              const paired=htmlStack.splice(matchIdx,1)[0],innerStart=units[paired.innerStartUnit]?.from??partStart;
              const innerEnd=units.length>paired.innerStartUnit?units[units.length-1].to:innerStart;
              wrappers.push({kind:'html',outerStart:paired.outerStart,innerStart,innerEnd,outerEnd:partEnd});continue;
            }
          }
          for(let i=0;i<part.length;i++)units.push({from:partStart+i,to:partStart+i+1,char:part[i]});
        }
        cursor=typeof end==='number'?end:htmlCursor;continue;
      }
      if(node.type==='link'&&typeof start==='number'&&typeof end==='number'){
        const rawLink=source.slice(start,end);
        if(rawLink.startsWith('[[')&&rawLink.endsWith(']]')&&rawLink.length>=4){
          const innerSlice=rawLink.slice(2,-2),pipeIdx=innerSlice.indexOf('|');
          const innerStart=pipeIdx>=0?start+2+pipeIdx+1:innerSlice.startsWith('#')?start+3:start+2,innerEnd=end-2;
          units.push(...consumeTextUnits(source.slice(innerStart,innerEnd),flattenInlineText(node.children??[]),innerStart).units);
          wrappers.push({kind:'wikilink',outerStart:start,innerStart,innerEnd,outerEnd:end});cursor=end;continue;
        }
      }
      const studyDelim=node.type==='highlight'?'==':node.type==='subscript'?'~':node.type==='superscript'?'^':null;
      if(studyDelim&&Array.isArray(node.children)&&(typeof start!=='number'||typeof end!=='number')){
        cursor=skipIgnoredComments(source,cursor,limitEnd);
        if(!source.startsWith(studyDelim,cursor)){const next=source.indexOf(studyDelim,cursor);if(next>=cursor&&next<limitEnd)cursor=next;}
        const outerStart=cursor,innerStart=source.startsWith(studyDelim,cursor)?cursor+studyDelim.length:cursor;
        cursor=innerStart;const beforeUnit=units.length;walkList(node.children,limitEnd);
        const afterUnit=units.length;cursor=skipIgnoredComments(source,cursor,limitEnd);
        const resolvedInnerEnd=afterUnit>beforeUnit?units[afterUnit-1].to:cursor,closePos=Math.max(cursor,resolvedInnerEnd);
        const outerEnd=source.startsWith(studyDelim,closePos)?closePos+studyDelim.length:closePos;cursor=outerEnd;
        wrappers.push({kind:String(node.type),outerStart,innerStart:afterUnit>beforeUnit?units[beforeUnit].from:innerStart,innerEnd:resolvedInnerEnd,outerEnd});continue;
      }
      if(Array.isArray(node.children)){
        const beforeUnit=units.length,resolvedStart=typeof start==='number'?start:(cursor=skipIgnoredComments(source,cursor,limitEnd));
        const rawNode=source.slice(resolvedStart,typeof end==='number'?end:limitEnd);
        let childLead=0;
        if(node.type==='strong'&&(rawNode.startsWith('**')||rawNode.startsWith('__')))childLead=2;
        else if(node.type==='emphasis'&&(rawNode.startsWith('*')||rawNode.startsWith('_')))childLead=1;
        else if(node.type==='delete')while(childLead<rawNode.length&&rawNode[childLead]==='~')childLead++;
        else if(node.type==='link'&&(rawNode.startsWith('[')||rawNode.startsWith('<')))childLead=1;
        cursor=resolvedStart+childLead;walkList(node.children,typeof end==='number'?end:limitEnd);
        const afterUnit=units.length,resolvedEnd=typeof end==='number'?end:Math.min(limitEnd,cursor+childLead);
        if(afterUnit>beforeUnit)wrappers.push({kind:String(node.type||'inline'),outerStart:resolvedStart,innerStart:units[beforeUnit].from,innerEnd:units[afterUnit-1].to,outerEnd:resolvedEnd});
        cursor=resolvedEnd;
      }
    }
  };
  walkList(children,scopeEnd);
}

function splitCalloutParagraphChildren(paragraph:any,source:string){
  const paraStart:number|undefined=paragraph?.position?.start?.offset,paraEnd:number|undefined=paragraph?.position?.end?.offset,first=paragraph?.children?.[0];
  if(typeof paraStart!=='number'||typeof paraEnd!=='number'||first?.type!=='text'||typeof first.value!=='string')return null;
  const match=/^\[!([\w-]+)\]([+-]?)[ \t]*/i.exec(first.value);
  if(!match)return null;
  const firstStart:number=typeof first.position?.start?.offset==='number'?first.position.start.offset:paraStart;
  const rawMatch=/^\[!([\w-]+)\]([+-]?)[ \t]*/i.exec(source.slice(firstStart,paraEnd));
  const titleStart=firstStart+(rawMatch?rawMatch[0].length:match[0].length),firstEnd:number|undefined=first.position?.end?.offset;
  const trimmedFirst={...first,value:first.value.slice(match[0].length),...(typeof firstEnd==='number'?{position:{start:{offset:titleStart},end:{offset:firstEnd}}}:{})};
  let computedTitleEnd=paraEnd,computedBodyStart=paraEnd;
  const splitNodes=(nodes:any[]):{title:any[];body:any[];ended:boolean}=>{
    const title:any[]=[],body:any[]=[];let ended=false;
    for(const child of nodes){
      if(ended){body.push(child);continue;}
      if(child.type==='break'){
        if(typeof child.position?.start?.offset==='number')computedTitleEnd=child.position.start.offset;
        if(typeof child.position?.end?.offset==='number')computedBodyStart=child.position.end.offset;
        ended=true;continue;
      }
      if(child.type==='text'&&typeof child.value==='string'){
        const at=child.value.indexOf('\n');
        if(at>=0){
          const cStart:number|undefined=child.position?.start?.offset,cEnd:number|undefined=child.position?.end?.offset;
          let titleEndOffset:number|undefined,bodyStartOffset:number|undefined;
          if(typeof cStart==='number'&&typeof cEnd==='number'){
            const u=consumeTextUnits(source.slice(cStart,cEnd),child.value,cStart).units;
            titleEndOffset=at>0?u[at-1].to:cStart;bodyStartOffset=u[at]?.to??cEnd;
            computedTitleEnd=titleEndOffset;computedBodyStart=bodyStartOffset;
          }
          if(at>0)title.push({...child,value:child.value.slice(0,at),position:typeof cStart==='number'&&typeof titleEndOffset==='number'?{start:{offset:cStart},end:{offset:titleEndOffset}}:undefined});
          if(child.value.length>at+1)body.push({...child,value:child.value.slice(at+1),position:typeof bodyStartOffset==='number'&&typeof cEnd==='number'?{start:{offset:bodyStartOffset},end:{offset:cEnd}}:undefined});
          ended=true;
        }else if(child.value.length>0)title.push(child);
      }else if(Array.isArray(child.children)){
        const parts=splitNodes(child.children);
        if(parts.title.length)title.push({...child,children:parts.title});
        if(parts.body.length)body.push({...child,children:parts.body});
        ended=parts.ended;
      }else title.push(child);
    }
    return {title,body,ended};
  };

  const split=splitNodes([trimmedFirst,...paragraph.children.slice(1)]);
  if(computedBodyStart===paraEnd&&split.body.length>0){const nl=/\r?\n[ \t>]*/.exec(source.slice(titleStart,paraEnd));if(nl){computedTitleEnd=titleStart+nl.index;computedBodyStart=titleStart+nl.index+nl[0].length;}}
  const hadExplicitTitle=split.title.some((child:any)=>child.type!=='text'||child.value.trim().length>0);
  return {title:split.title,body:split.body,hadExplicitTitle,titleStart,titleEnd:hadExplicitTitle?computedTitleEnd:titleStart,bodyStart:computedBodyStart,bodyEnd:paraEnd};
}
function computeContentBoundsForNode(node:any,source:string):[number,number]{
  const start:number=node.position.start.offset,end:number=node.position.end.offset,firstChildStart:number|undefined=node.children?.[0]?.position?.start?.offset;
  if(typeof firstChildStart==='number')return [firstChildStart,end];
  const raw=source.slice(start,end);
  if(node.type==='heading'){const p=/^[ \t]{0,3}#{1,6}[ \t]*/.exec(raw),s=/[ \t]+#+[ \t]*$/.exec(raw),c=p?start+p[0].length:start;return [c,s&&end-s[0].length>=c?end-s[0].length:end];}
  if(node.type==='tableCell'){const l=/^\|?[ \t]*/.exec(raw),t=/[ \t]*\|?$/.exec(raw),c=l?start+l[0].length:start;return [c,t&&end-t[0].length>=c?end-t[0].length:end];}
  if(node.type==='paragraph'){const q=/^[ \t>]+/.exec(raw);if(q&&raw[q[0].length]!==undefined)return [start+q[0].length,end];}
  return [start,end];
}

function resolveScopeMdastChildren(scopeEl:HTMLElement,blockEl:HTMLElement,source:string,tree:Root):ResolvedScopeStream|null{
  const calloutEl=scopeEl.closest<HTMLElement>('details.callout,aside.callout');
  if(calloutEl&&blockEl.contains(calloutEl)){
    const bStart=Number(blockEl.dataset.sourceStart),bEnd=Number(blockEl.dataset.sourceEnd);
    const cStart=Number(calloutEl.dataset.sourceStart),cEnd=Number(calloutEl.dataset.sourceEnd);
    let exactBq:any=null,fallbackBq:any=null;
    visit(tree,'blockquote',(node:any)=>{
      if(!node.position)return;
      const nStart=node.position.start.offset,nEnd=node.position.end.offset;
      if(Number.isFinite(cStart)&&Number.isFinite(cEnd)&&nStart===cStart&&nEnd===cEnd)exactBq=node;
      else if(!fallbackBq&&nStart>=bStart&&nEnd<=bEnd)fallbackBq=node;
    });
    const blockquoteNode=exactBq??fallbackBq,firstPara=blockquoteNode?.children?.[0];
    if(firstPara?.type==='paragraph'){
      const split=splitCalloutParagraphChildren(firstPara,source);
      if(split){
        const bqStart:number=blockquoteNode.position.start.offset,paraEnd:number=firstPara.position.end.offset;
        const fenceMatch=/^[ \t]*:::callout[ \t]+([\w-]+)(?:[ \t]+([^\r\n]*?))?[ \t]*(\r?\n|$)/i.exec(source.slice(bqStart,paraEnd));
        const isTitle=scopeEl.classList.contains('callout-title')&&scopeEl.parentElement===calloutEl;
        const isFirstBody=Number(scopeEl.dataset.sourceStart)===firstPara.position?.start?.offset&&Number(scopeEl.dataset.sourceEnd)===paraEnd;
        if(fenceMatch){
          const fenceLineEnd=bqStart+fenceMatch[0].length,rawLine1End=fenceLineEnd-fenceMatch[3].length,rawTitle=fenceMatch[2]?.trim()??'';
          if(isTitle){
            if(!rawTitle)return {children:[],scopeStart:rawLine1End,scopeEnd:rawLine1End,synthesizedCalloutTitle:true};
            const prefixMatch=/^[ \t]*:::callout[ \t]+[\w-]+[ \t]+/i.exec(fenceMatch[0])!;
            let tStart=bqStart+prefixMatch[0].length,tEnd=tStart+rawTitle.length;
            if(rawTitle[0]==='"'||rawTitle[0]==="'")tStart++;
            if(tEnd>tStart&&(source[tEnd-1]==='"'||source[tEnd-1]==="'"))tEnd--;
            return {children:stripPositionsBefore(split.title,Infinity),scopeStart:tStart,scopeEnd:tEnd};
          }
          if(isFirstBody)return {children:stripPositionsBefore(split.body,fenceLineEnd),scopeStart:fenceLineEnd,scopeEnd:paraEnd};
        }else{
          if(isTitle)return split.hadExplicitTitle?{children:split.title,scopeStart:split.titleStart,scopeEnd:split.titleEnd}:{children:[],scopeStart:split.titleStart,scopeEnd:split.titleStart,synthesizedCalloutTitle:true};
          if(isFirstBody)return {children:split.body,scopeStart:split.bodyStart,scopeEnd:split.bodyEnd};
        }
      }
    }
  }

  const rawStart=scopeEl.getAttribute('data-source-start'),rawEnd=scopeEl.getAttribute('data-source-end');
  if(rawStart===null||rawEnd===null)return null;
  const targetStart=Number(rawStart),targetEnd=Number(rawEnd);
  if(!Number.isFinite(targetStart)||!Number.isFinite(targetEnd))return null;

  let matched:any=null;
  visit(tree,(node:any)=>{
    if(!node.position||!Array.isArray(node.children)||node.position.start.offset!==targetStart||node.position.end.offset!==targetEnd)return;
    if(scopeEl.tagName==='LI'&&node.type==='listItem')matched=node;
    else if(scopeEl.tagName!=='LI'&&['paragraph','heading','tableCell'].includes(node.type))matched=node;
    else if(!matched)matched=node;
  });
  if(!matched)return null;
  const target=matched.type==='listItem'?matched.children.find((c:any)=>c.type==='paragraph'):matched;
  if(!target?.position)return null;
  const [scopeStart,scopeEnd]=computeContentBoundsForNode(target,source);
  return {children:target.children,scopeStart,scopeEnd};
}

function measureDomRangeInScope(scopeEl:HTMLElement,range:Range):DomRangeStream|null{
  let stream='',mathOrdinal=0,skipTaskCheckboxSpace=false,hitLiBlockChild=false;
  let start:DomBoundaryHit|null=null,end:DomBoundaryHit|null=null;
  const isLiBlockChild=(el:Element):boolean=>scopeEl.tagName==='LI'&&el!==scopeEl&&el.matches('ul,ol,blockquote,pre,details,table');

  const isExcludedElement=(el:Element):boolean=>{
    if(el.matches('button,input,select,textarea,script,style,svg,hr,.live-block-edit,.image-edit-tools,.katex-mathml,.math-equation-extra-anchor,[data-frontmatter-properties],.document-properties')){
      if(el.tagName==='INPUT'&&(el as HTMLInputElement).type==='checkbox')skipTaskCheckboxSpace=true;
      return true;
    }
    if(isLiBlockChild(el)){hitLiBlockChild=true;return true;}
    return false;
  };
  const isAtomicImageSpan=(el:Element):boolean=>
    el.matches('[data-note-image-source],.note-image,.remote-image-card,.image-error')||
    (el.classList.contains('image-loading')&&!el.closest('[data-note-image-source]'))||
    (el.tagName==='IMG'&&!el.closest('[data-note-image-source],.note-image,.remote-image-card,.image-error'));

  const walk=(node:Node):void=>{
    if(node.nodeType===Node.TEXT_NODE){
      const data=(node as Text).data,skipPrefix=skipTaskCheckboxSpace&&data.startsWith(' ')?1:0;
      skipTaskCheckboxSpace=false;
      let effective=hitLiBlockChild&&node.parentNode===scopeEl?'':skipPrefix?data.slice(skipPrefix):data;
      if(effective&&node.parentNode===scopeEl&&node.nextSibling instanceof Element&&isLiBlockChild(node.nextSibling))effective=effective.replace(/\r?\n$/,'');
      if(range.startContainer===node){
        const local=Math.max(0,Math.min(effective.length,range.startOffset-skipPrefix));
        start={unit:stream.length+local,preferPrevEnd:local>0&&local===effective.length,mathOrdinal:null};
      }
      if(range.endContainer===node){
        const local=Math.max(0,Math.min(effective.length,range.endOffset-skipPrefix));
        end={unit:stream.length+local,preferPrevEnd:local>0&&local===effective.length,mathOrdinal:null};
      }
      stream+=effective;return;
    }
    if(!(node instanceof Element))return;
    if(isExcludedElement(node)){
      if(node.contains(range.startContainer)&&start===null)start={unit:stream.length,preferPrevEnd:false,mathOrdinal:null};
      if(node.contains(range.endContainer)&&end===null)end={unit:stream.length,preferPrevEnd:false,mathOrdinal:null};
      return;
    }
    skipTaskCheckboxSpace=false;
    const emitAtomic=(contained:boolean,atStart:boolean,atEnd:boolean,ch:string,ord:number|null)=>{
      if(atStart)start={unit:stream.length,preferPrevEnd:false,mathOrdinal:ord};
      stream+=ch;
      if(atEnd)end={unit:range.collapsed?stream.length-1:stream.length,preferPrevEnd:false,mathOrdinal:ord};
      return contained;
    };
    if(node.classList.contains('katex')||node.classList.contains('katex-error')||node.hasAttribute('data-math-inline')){
      emitAtomic(true,node.contains(range.startContainer),node.contains(range.endContainer),'\uFFFC',mathOrdinal++);return;
    }
    if(node.tagName==='BR'){emitAtomic(true,range.startContainer===node,range.endContainer===node,'\n',null);return;}
    if((node.tagName==='SUP'&&node.querySelector('a[data-footnote-ref]'))||isAtomicImageSpan(node)){
      emitAtomic(true,node.contains(range.startContainer),node.contains(range.endContainer),'\uFFFC',null);return;
    }
    const children=node.childNodes;
    for(let i=0;i<=children.length;i++){
      if(range.startContainer===node&&range.startOffset===i&&start===null)start={unit:stream.length,preferPrevEnd:i===children.length&&stream.length>0,mathOrdinal:null};
      if(range.endContainer===node&&range.endOffset===i&&end===null)end={unit:stream.length,preferPrevEnd:stream.length>0,mathOrdinal:null};
      if(i<children.length)walk(children[i]);
    }
  };
  walk(scopeEl);
  return start&&end?{text:stream,start,end}:null;
}

function measurePlainTextOffsetInPre(preEl:HTMLElement,container:Node,offset:number):number|null{
  let count=0,found:number|null=null;
  const walk=(node:Node):void=>{
    if(found!==null)return;
    if(node.nodeType===Node.TEXT_NODE){const len=(node as Text).data.length;if(container===node)found=count+Math.max(0,Math.min(len,offset));else count+=len;return;}
    for(let i=0;i<=node.childNodes.length;i++){if(container===node&&offset===i){found=count;return;}if(i<node.childNodes.length)walk(node.childNodes[i]);}
  };
  walk(preEl);return found;
}
function resolvePreBodyBounds(preEl:HTMLElement,renderedSource:string,renderedBlockStart:number,renderedBlockEnd:number):[number,number]|null{
  const rawPreStart=preEl.getAttribute('data-source-start'),rawPreEnd=preEl.getAttribute('data-source-end');
  if(rawPreStart!==null&&rawPreEnd!==null){const pStart=Number(rawPreStart),pEnd=Number(rawPreEnd);if(Number.isFinite(pStart)&&Number.isFinite(pEnd)&&pEnd>=pStart)return [pStart,pEnd];}
  const pyCell=preEl.closest<HTMLElement>('.python-cell[data-source-start][data-source-end]');
  if(pyCell&&preEl.classList.contains('python-source')){
    const cStart=Number(pyCell.dataset.sourceStart),cEnd=Number(pyCell.dataset.sourceEnd);
    if(Number.isFinite(cStart)&&Number.isFinite(cEnd)&&cStart>=renderedBlockStart&&cEnd<=renderedBlockEnd){const nl=renderedSource.indexOf('\n',cStart);return [nl>=0&&nl<cEnd?nl+1:cStart,cEnd];}
  }
  return null;
}
const resolveAnalysisTree=(renderedSource:string,s?:SourceDocumentAnalysis|Root):Root=>
  s&&'type' in s&&s.type==='root'?s:s&&'source' in s&&s.source===renderedSource?s.analysis.tree:analyzeDocument(renderedSource).tree;

function mapScopeRangeToRenderedSource(scopeEl:HTMLElement,blockEl:HTMLElement,range:Range,renderedSource:string,renderedBlockStart:number,renderedBlockEnd:number,sourceAnalysisOrTree?:SourceDocumentAnalysis|Root):MappedRenderedSpan|null{
  if(scopeEl.tagName==='SUMMARY'&&scopeEl.closest('.code-disclosure'))return null;
  if(scopeEl.tagName==='PRE'){
    const preBounds=resolvePreBodyBounds(scopeEl,renderedSource,renderedBlockStart,renderedBlockEnd),domFrom=preBounds?measurePlainTextOffsetInPre(scopeEl,range.startContainer,range.startOffset):null;
    if(!preBounds||domFrom===null)return null;
    if(range.collapsed)return {kind:'caret',offset:Math.min(preBounds[1],preBounds[0]+domFrom)};
    const domTo=measurePlainTextOffsetInPre(scopeEl,range.endContainer,range.endOffset);
    return domTo!==null&&domTo>domFrom?{kind:'range',from:Math.min(preBounds[1],preBounds[0]+domFrom),to:Math.min(preBounds[1],preBounds[0]+domTo)}:null;
  }
  const resolvedScope=resolveScopeMdastChildren(scopeEl,blockEl,renderedSource,resolveAnalysisTree(renderedSource,sourceAnalysisOrTree));
  if(!resolvedScope)return null;
  if(resolvedScope.synthesizedCalloutTitle)return range.collapsed?{kind:'caret',offset:resolvedScope.scopeStart}:null;
  const domStream=measureDomRangeInScope(scopeEl,range);
  if(!domStream)return null;
  const units:SourceUnit[]=[],wrappers:InlineWrapperBounds[]=[],mathWrappers:InlineWrapperBounds[]=[];
  collectMdastInlineStream(resolvedScope.children,renderedSource,resolvedScope.scopeStart,resolvedScope.scopeEnd,units,wrappers,mathWrappers);
  if(range.collapsed){
    if(units.length!==domStream.text.length)return null;
    if(!units.length)return {kind:'caret',offset:resolvedScope.scopeStart};
    if(domStream.start.unit<=0)return {kind:'caret',offset:units[0].from};
    if(domStream.start.unit>=units.length)return {kind:'caret',offset:units[units.length-1].to};
    return {kind:'caret',offset:domStream.start.preferPrevEnd?units[domStream.start.unit-1].to:units[domStream.start.unit].from};
  }
  if(domStream.start.unit>=domStream.end.unit)return null;
  if(domStream.start.mathOrdinal!==null&&domStream.start.mathOrdinal===domStream.end.mathOrdinal&&mathWrappers[domStream.start.mathOrdinal]){
    return {kind:'range',from:mathWrappers[domStream.start.mathOrdinal].innerStart,to:mathWrappers[domStream.start.mathOrdinal].innerEnd};
  }
  if(units.length!==domStream.text.length||domStream.end.unit>units.length)return null;
  let rawFrom=units[domStream.start.unit].from,rawTo=units[domStream.end.unit-1].to;
  for(const w of wrappers){
    if(rawFrom===w.innerStart&&rawTo>w.outerEnd)rawFrom=Math.min(rawFrom,w.outerStart);
    if(rawTo===w.innerEnd&&rawFrom<w.outerStart)rawTo=Math.max(rawTo,w.outerEnd);
  }
  return {kind:'range',from:rawFrom,to:rawTo};
}

export function mapLiveRenderedSelectionToSourceRange(
  selection:Selection|null,rootEl:HTMLElement|null,renderedSource:string,
  sourceAnalysis?:SourceDocumentAnalysis,editing:LiveEditingSpanContext|null=null,activeDoc:string=renderedSource,
):LiveRenderedSelectionRange|null{
  if(!selection||!rootEl||selection.rangeCount===0||selection.isCollapsed)return null;
  const range=selection.getRangeAt(0);
  if(range.collapsed)return null;
  const startEl=elementAt(range.startContainer),endEl=elementAt(range.endContainer),commonEl=elementAt(range.commonAncestorContainer);
  if(!startEl||!endEl||!commonEl||startEl.closest(EXCLUDED_SELECTION_CONTAINER_SELECTOR)||endEl.closest(EXCLUDED_SELECTION_CONTAINER_SELECTOR)||commonEl.closest(EXCLUDED_SELECTION_CONTAINER_SELECTOR))return null;
  const startBlock=startEl.closest<HTMLElement>('.live-block'),endBlock=endEl.closest<HTMLElement>('.live-block');
  if(!startBlock||!endBlock||startBlock!==endBlock||!rootEl.contains(startBlock))return null;
  const renderedBlockStart=Number(startBlock.dataset.sourceStart),renderedBlockEnd=Number(startBlock.dataset.sourceEnd);
  if(!Number.isFinite(renderedBlockStart)||!Number.isFinite(renderedBlockEnd)||renderedBlockStart<0||renderedBlockEnd<renderedBlockStart||renderedBlockEnd>renderedSource.length)return null;
  const startLeaf=closestLeafInBlock(startEl,startBlock),endLeaf=closestLeafInBlock(endEl,startBlock);
  if(startLeaf!==endLeaf)return null;
  const mapped=mapScopeRangeToRenderedSource(startLeaf??startBlock,startBlock,range,renderedSource,renderedBlockStart,renderedBlockEnd,sourceAnalysis);
  if(!mapped||mapped.kind!=='range'||mapped.from<renderedBlockStart||mapped.to>renderedBlockEnd||mapped.from>=mapped.to)return null;
  const [blockStart,blockEnd]=translateLiveRenderedRange(renderedBlockStart,renderedBlockEnd,editing,activeDoc);
  const [from,to]=translateLiveRenderedRange(mapped.from,mapped.to,editing,activeDoc);
  return from<blockStart||to>blockEnd||from>=to||blockEnd>activeDoc.length?null:{blockElement:startBlock,renderedBlockStart,renderedBlockEnd,renderedFrom:mapped.from,renderedTo:mapped.to,blockStart,blockEnd,from,to,reversed:isSelectionBackward(selection)};
}

/** Plans a Markdown format toggle bounded to `[blockStart, blockEnd]` while guarding protected code/math/image spans. */
export function planGuardedLiveFormat(
  doc:string,from:number,to:number,reversed:boolean,blockStart:number,blockEnd:number,action:FormatAction,sourceAnalysis?:SourceDocumentAnalysis,
):PlannedLiveFormat|null{
  if(blockStart<0||blockEnd<blockStart||blockEnd>doc.length||from<blockStart||to>blockEnd||from>to)return null;
  const analysis=sourceAnalysis?.source===doc?sourceAnalysis.analysis:analyzeDocument(doc);
  if(analysis.frontmatter&&from<analysis.frontmatter.end)return null;
  if(analysis.tree.children.some(n=>['code','math','html','definition'].includes(n.type)&&typeof n.position?.start?.offset==='number'&&typeof n.position?.end?.offset==='number'&&n.position.start.offset>=blockStart&&n.position.end.offset<=blockEnd))return null;
  const wrappers:InlineWrapperBounds[]=[],isLineAction=action==='heading'||action==='list'||action==='quote';
  let blocked=false;
  visit(analysis.tree,(node:any)=>{
    if(blocked||!node.position)return;
    const nStart=node.position.start.offset,nEnd=node.position.end.offset;
    if(typeof nStart!=='number'||typeof nEnd!=='number')return;
    const overlaps=from===to?from>=nStart&&from<=nEnd:nStart<to&&nEnd>from;
    if(['code','math','definition'].includes(node.type)&&overlaps){blocked=true;return;}
    if(['paragraph','heading','tableCell'].includes(node.type)&&overlaps){
      const [sStart,sEnd]=computeContentBoundsForNode(node,doc);
      collectMdastInlineStream(node.children??[],doc,sStart,sEnd,[],wrappers,[]);
    }
  });
  if(blocked)return null;
  let effFrom=from,effTo=to,expectedUnwrap:[number,number]|null=null;
  if(!isLineAction){
    for(const w of wrappers){
      if(!(from===to?from>w.outerStart&&from<w.outerEnd:w.outerStart<to&&w.outerEnd>from))continue;
      const enclosesWithExtra=from<=w.outerStart&&to>=w.outerEnd&&(from<w.outerStart||to>w.outerEnd);
      if(['equationRef','footnoteReference','image','imageReference'].includes(w.kind)){
        if(enclosesWithExtra&&action!=='inline_math'&&action!=='inline_code')continue;
        return null;
      }
      if(w.kind==='inlineCode'||w.kind==='inlineMath'){
        if((from>w.outerStart&&from<w.outerEnd&&to>w.outerEnd)||(to>w.outerStart&&to<w.outerEnd&&from<w.outerStart))return null;
        if(enclosesWithExtra){if(action==='inline_math'||(w.kind==='inlineCode'&&action==='inline_code'))return null;continue;}
        const matchCode=w.kind==='inlineCode'&&action==='inline_code'&&from<to&&((from===w.innerStart&&to===w.innerEnd)||(from===w.outerStart&&to===w.outerEnd));
        const matchMath=w.kind==='inlineMath'&&action==='inline_math'&&from<to&&w.innerStart===w.outerStart+1&&w.innerEnd===w.outerEnd-1&&((from===w.innerStart&&to===w.innerEnd)||(from===w.outerStart&&to===w.outerEnd));
        if(!matchCode&&!matchMath)return null;
        effFrom=w.outerStart;effTo=w.outerEnd;expectedUnwrap=[w.outerStart,w.outerEnd];
      }
    }
  }
  const result=toggleMarkdownFormat(doc,[reversed?{anchor:effTo,head:effFrom}:{anchor:effFrom,head:effTo}],action,0);
  if(!result.changes.length||result.doc===doc||!result.changes.every(ch=>ch.from>=blockStart&&ch.to<=blockEnd))return null;
  if(expectedUnwrap&&(result.changes.length!==1||result.changes[0].from!==expectedUnwrap[0]||result.changes[0].to!==expectedUnwrap[1]))return null;
  if(isLineAction&&wrappers.some(w=>['inlineCode','inlineMath','equationRef','image','imageReference'].includes(w.kind)&&result.changes.some(ch=>ch.from>w.outerStart&&ch.from<w.outerEnd)))return null;
  const nextBlockText=result.doc.slice(blockStart,blockEnd+result.doc.length-doc.length),r0=result.ranges[0];
  const nextStart=Math.max(0,Math.min(nextBlockText.length,Math.min(r0.anchor,r0.head)-blockStart));
  const nextEnd=Math.max(nextStart,Math.min(nextBlockText.length,Math.max(r0.anchor,r0.head)-blockStart));
  const nextDirection:SelectionDirection=r0.anchor>r0.head&&nextStart<nextEnd?'backward':nextStart<nextEnd?'forward':'none';
  return {doc:result.doc,nextBlockText,nextStart,nextEnd,nextDirection};
}

/** Resolves a double-click inside `.live-block` to a verified collapsed DOM caret `Range`. */
export function resolveDoubleClickCaretRange(blockEl:HTMLElement,target:EventTarget|null,clientX:number,clientY:number):Range|null{
  const targetEl=target instanceof Element?target:target instanceof Node?target.parentElement:null;
  if(targetEl?.closest(NON_TEXT_DOUBLE_CLICK_TARGET_SELECTOR))return null;
  const doc=blockEl.ownerDocument,pointRange=caretRangeAtPoint(doc,clientX,clientY);
  if(pointRange?.collapsed&&blockEl.contains(pointRange.startContainer)&&!elementAt(pointRange.startContainer)?.closest(NON_TEXT_CARET_CONTAINER_SELECTOR))return pointRange;
  const hasCaretApi=typeof (doc as Partial<Document>).caretPositionFromPoint==='function'||typeof (doc as {caretRangeFromPoint?:unknown}).caretRangeFromPoint==='function';
  const sel=!hasCaretApi?doc.defaultView?.getSelection():null;
  const raw=sel&&sel.rangeCount>0&&sel.isCollapsed?sel.getRangeAt(0):null;
  return raw?.collapsed&&blockEl.contains(raw.startContainer)&&!elementAt(raw.startContainer)?.closest(NON_TEXT_CARET_CONTAINER_SELECTOR)?raw.cloneRange():null;
}

/** Click wrapper over the shared rendered-to-source mapper, accepting only a verified collapsed caret `Range`. */
export function resolveLiveCaretOffset(
  blockEl:HTMLElement|null,caretRange:Range|null|undefined,renderedSource:string,
  renderedStart:number,renderedEnd:number,sourceAnalysisOrTree?:SourceDocumentAnalysis|Root,
):number|null{
  if(!blockEl||!caretRange||caretRange.collapsed!==true||!blockEl.contains(caretRange.startContainer))return null;
  if(!Number.isFinite(renderedStart)||!Number.isFinite(renderedEnd)||renderedStart<0||renderedEnd<renderedStart)return null;
  const blockStart=Math.max(0,Math.min(renderedStart,renderedSource.length)),blockEnd=Math.max(blockStart,Math.min(renderedEnd,renderedSource.length));
  const startEl=elementAt(caretRange.startContainer);
  if(!startEl||startEl.closest(NON_TEXT_CARET_CONTAINER_SELECTOR))return null;
  const scopeEl=closestLeafInBlock(startEl,blockEl);
  if(!scopeEl){
    if(caretRange.startContainer instanceof Element){
      const children=caretRange.startContainer.childNodes,idx=Math.max(0,Math.min(children.length,caretRange.startOffset));
      const nextStart=idx<children.length&&children[idx] instanceof HTMLElement?Number((children[idx] as HTMLElement).dataset.sourceStart):NaN;
      if(Number.isFinite(nextStart)&&nextStart>=blockStart&&nextStart<=blockEnd)return nextStart-blockStart;
      const prevEnd=idx>0&&children[idx-1] instanceof HTMLElement?Number((children[idx-1] as HTMLElement).dataset.sourceEnd):NaN;
      if(Number.isFinite(prevEnd)&&prevEnd>=blockStart&&prevEnd<=blockEnd)return prevEnd-blockStart;
    }
    return null;
  }
  const mapped=mapScopeRangeToRenderedSource(scopeEl,blockEl,caretRange,renderedSource,blockStart,blockEnd,sourceAnalysisOrTree);
  return mapped?.kind==='caret'&&mapped.offset>=blockStart&&mapped.offset<=blockEnd?Math.max(0,Math.min(blockEnd-blockStart,mapped.offset-blockStart)):null;
}
