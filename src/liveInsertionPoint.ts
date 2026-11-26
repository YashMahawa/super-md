import {useEffect,type RefObject} from 'react';
import type {Root} from 'mdast';
import {caretRangeAtPoint} from './caretPoint';
import {analyzeDocument,type SourceDocumentAnalysis} from './documentAnalysis';
import {translateRenderedRange,type EditingSession} from './liveBlockHistory';

const NON_TEXT_DOUBLE_CLICK_TARGET_SELECTOR='a,button,input,select,textarea,img,.note-image,.image-error,.remote-image-card,.image-loading,svg,hr,.live-block-edit,[data-frontmatter-properties],.document-properties';
const NON_TEXT_CARET_CONTAINER_SELECTOR='button,input,select,textarea,img,.note-image,.image-error,.remote-image-card,.image-loading,svg,hr,.live-block-edit,[data-frontmatter-properties],.document-properties';
const IGNORED_PROSE_WALK_TAGS=new Set(['BUTTON','SELECT','TEXTAREA','SVG','SCRIPT','STYLE','TEMPLATE','ANNOTATION','IFRAME','HR']);
const BLOCK_ELEMENT_TAGS=new Set(['P','H1','H2','H3','H4','H5','H6','LI','BLOCKQUOTE','UL','OL','TABLE','THEAD','TBODY','TFOOT','TR','TH','TD','DETAILS','ASIDE','PRE','DIV','SECTION']);
const STRUCTURAL_CONTAINER_TAGS=new Set(['BLOCKQUOTE','ASIDE','DETAILS','UL','OL','TABLE','THEAD','TBODY','TFOOT','TR']);

interface InlineAstSpan {kind:'code'|'math'|'image'|'footnote'|'break';start:number;end:number}

function collectInlineAstSpans(tree:Root,blockStart:number,blockEnd:number):InlineAstSpan[]{
  const spans:InlineAstSpan[]=[];
  const visitNode=(node:any)=>{
    if(!node||typeof node!=='object')return;
    const s=node.position?.start?.offset,e=node.position?.end?.offset;
    if(typeof s==='number'&&typeof e==='number'&&(e<blockStart||s>blockEnd))return;
    if(typeof s==='number'&&typeof e==='number'&&s>=blockStart&&e<=blockEnd){
      if(node.type==='inlineCode'){spans.push({kind:'code',start:s,end:e});return;}
      if(node.type==='inlineMath'){spans.push({kind:'math',start:s,end:e});return;}
      if(node.type==='image'||node.type==='imageReference'){spans.push({kind:'image',start:s,end:e});return;}
      if(node.type==='footnoteReference'){spans.push({kind:'footnote',start:s,end:e});return;}
      if(node.type==='break'){spans.push({kind:'break',start:s,end:e});return;}
    }
    if(Array.isArray(node.children))for(const child of node.children)visitNode(child);
  };
  for(const top of tree.children)visitNode(top);
  return spans;
}

function parseSourceBounds(el:Element,min:number,max:number):[number,number]|null{
  if(!(el instanceof HTMLElement))return null;
  const s=el.dataset.sourceStart!==undefined?Number(el.dataset.sourceStart):NaN;
  const e=el.dataset.sourceEnd!==undefined?Number(el.dataset.sourceEnd):NaN;
  return Number.isInteger(s)&&Number.isInteger(e)&&s>=min&&e<=max&&e>=s?[s,e]:null;
}

function skipStrippedComments(source:string,pos:number,limit:number):number{
  while(pos<limit){
    if(source.startsWith('%%',pos)){
      const close=source.indexOf('%%',pos+2);
      if(close>=0&&close+2<=limit){pos=close+2;continue;}
    }
    if(source.startsWith('<!--',pos)){
      const close=source.indexOf('-->',pos+4);
      if(close>=0&&close+3<=limit){pos=close+3;continue;}
    }
    break;
  }
  return pos;
}

function skipElementOpening(el:Element,source:string,pos:number,limit:number):number{
  pos=skipStrippedComments(source,pos,limit);
  const slice=source.slice(pos,limit),tag=el.tagName;
  if(/^H[1-6]$/.test(tag)){
    const m=/^[ \t]*(?:>[ \t]*)*#{1,6}(?:[ \t]+|(?=\r?\n|$))/.exec(slice);
    return m?pos+m[0].length:pos;
  }
  if(tag==='LI'){
    const m=/^[ \t]*(?:>[ \t]*)*(?:[-+*]|\d{1,9}[.)])[ \t]+/.exec(slice);
    return m?pos+m[0].length:pos;
  }
  if(el.matches('aside.callout,details.callout')){
    const fence=/^[ \t]*:::callout\s+[\w-]+[ \t]*/i.exec(slice);
    if(fence)return pos+fence[0].length;
    const bq=/^[ \t]*(?:>[ \t]*)+(?:\[![\w-]+\][+-]?[ \t]*)?/i.exec(slice);
    return bq?pos+bq[0].length:pos;
  }
  if(tag==='BLOCKQUOTE'){
    const m=/^[ \t]*>[ \t]?/.exec(slice);
    return m?pos+m[0].length:pos;
  }
  if(tag==='TH'||tag==='TD'){
    const leadingText=el.textContent??'';
    const m=leadingText.startsWith(' ')?/^[ \t]*\|/.exec(slice):/^[ \t]*\|?[ \t]*/.exec(slice);
    return m?pos+m[0].length:pos;
  }
  if(tag==='EM')return slice[0]==='*'||slice[0]==='_'?pos+1:pos;
  if(tag==='STRONG')return slice.startsWith('**')||slice.startsWith('__')?pos+2:pos;
  if(tag==='DEL')return slice.startsWith('~~')||slice.startsWith('~')?pos+(slice.startsWith('~~')?2:1):pos;
  if(tag==='A'){
    if(slice.startsWith('[[')){
      const end=slice.indexOf(']]'),pipe=slice.indexOf('|');
      if(pipe>=0&&(end<0||pipe<end))return pos+pipe+1;
      return slice.startsWith('[[#')?pos+3:pos+2;
    }
    return slice[0]==='['||slice[0]==='<'?pos+1:pos;
  }
  if(tag==='MARK'){
    if(slice.startsWith('=='))return pos+2;
    const m=/^<mark\b[^>]*>/i.exec(slice);return m?pos+m[0].length:pos;
  }
  if(tag==='SUB'){
    if(slice[0]==='~')return pos+1;
    const m=/^<sub\b[^>]*>/i.exec(slice);return m?pos+m[0].length:pos;
  }
  if(tag==='SUP'){
    if(slice[0]==='^')return pos+1;
    const m=/^<sup\b[^>]*>/i.exec(slice);return m?pos+m[0].length:pos;
  }
  if(tag==='KBD'||tag==='U'){
    const m=new RegExp(`^<${tag.toLowerCase()}\\b[^>]*>`,'i').exec(slice);
    return m?pos+m[0].length:pos;
  }
  if(tag==='P'){
    const m=/^[ \t]+/.exec(slice);
    return m&&!(el.textContent??'').startsWith(' ')?pos+m[0].length:pos;
  }
  return pos;
}

function skipInlineClosing(tag:string,source:string,pos:number,limit:number):number{
  const slice=source.slice(pos,limit);
  if(tag==='MARK'){if(slice.startsWith('=='))return pos+2;const m=/^<\/mark\s*>/i.exec(slice);return m?pos+m[0].length:pos;}
  if(tag==='SUB'){if(slice[0]==='~')return pos+1;const m=/^<\/sub\s*>/i.exec(slice);return m?pos+m[0].length:pos;}
  if(tag==='SUP'){if(slice[0]==='^')return pos+1;const m=/^<\/sup\s*>/i.exec(slice);return m?pos+m[0].length:pos;}
  if(tag==='KBD'||tag==='U'){const m=new RegExp(`^<\\/${tag.toLowerCase()}\\s*>`,'i').exec(slice);return m?pos+m[0].length:pos;}
  return pos;
}

export function resolveDoubleClickCaretRange(blockEl:HTMLElement,target:EventTarget|null,clientX:number,clientY:number):Range|null{
  const targetEl=target instanceof Element?target:target instanceof Node?target.parentElement:null;
  if(targetEl?.closest(NON_TEXT_DOUBLE_CLICK_TARGET_SELECTOR))return null;
  const doc=blockEl.ownerDocument;
  const pointRange=caretRangeAtPoint(doc,clientX,clientY);
  if(pointRange&&blockEl.contains(pointRange.startContainer)){
    const containerEl=pointRange.startContainer instanceof Element?pointRange.startContainer:pointRange.startContainer.parentElement;
    if(!containerEl?.closest(NON_TEXT_CARET_CONTAINER_SELECTOR))return pointRange;
  }
  const hasCaretApi=typeof (doc as Partial<Document>).caretPositionFromPoint==='function'||typeof (doc as {caretRangeFromPoint?:unknown}).caretRangeFromPoint==='function';
  if(!hasCaretApi){
    const sel=doc.defaultView?.getSelection();
    if(sel&&sel.rangeCount>0){
      const raw=sel.getRangeAt(0);
      if(blockEl.contains(raw.startContainer)){
        const containerEl=raw.startContainer instanceof Element?raw.startContainer:raw.startContainer.parentElement;
        if(!containerEl?.closest(NON_TEXT_CARET_CONTAINER_SELECTOR)){
          const collapsed=raw.cloneRange();collapsed.collapse(true);return collapsed;
        }
      }
    }
  }
  return null;
}

export function resolveLiveCaretOffset(
  blockEl:HTMLElement|null,
  caretRange:Range|null|undefined,
  renderedSource:string,
  renderedStart:number,
  renderedEnd:number,
  tree?:Root,
):number|null{
  if(!blockEl||!caretRange||!blockEl.contains(caretRange.startContainer))return null;
  if(!Number.isFinite(renderedStart)||!Number.isFinite(renderedEnd)||renderedEnd<renderedStart)return null;
  const blockStart=Math.max(0,Math.min(renderedStart,renderedSource.length));
  const blockEnd=Math.max(blockStart,Math.min(renderedEnd,renderedSource.length));
  const targetNode=caretRange.startContainer,targetOffset=caretRange.startOffset;
  const startEl=targetNode instanceof Element?targetNode:targetNode.parentElement;
  if(!startEl||startEl.closest(NON_TEXT_CARET_CONTAINER_SELECTOR))return null;

  let owner:HTMLElement=blockEl,ownerStart=blockStart,ownerEnd=blockEnd;
  for(let cur:HTMLElement|null=startEl instanceof HTMLElement?startEl:startEl.parentElement;cur&&blockEl.contains(cur);cur=cur.parentElement){
    if(cur.tagName==='P'&&cur.previousElementSibling?.classList.contains('callout-title'))continue;
    const bounds=parseSourceBounds(cur,blockStart,blockEnd);
    if(bounds){owner=cur;[ownerStart,ownerEnd]=bounds;break;}
    if(cur===blockEl)break;
  }

  const astSpans=collectInlineAstSpans(tree??analyzeDocument(renderedSource).tree,ownerStart,ownerEnd);
  let spanCursor=0;
  const takeSpan=(kind:InlineAstSpan['kind'],from:number,to:number):InlineAstSpan|undefined=>{
    for(let i=spanCursor;i<astSpans.length;i++){
      const s=astSpans[i];
      if(s.end<=from)continue;
      if(s.start>=to)break;
      if(s.kind===kind&&s.end<=to){spanCursor=i+1;return s;}
    }
    return undefined;
  };

  let pos=skipElementOpening(owner,renderedSource,ownerStart,ownerEnd),limit=ownerEnd,found=false;
  const advanceText=(text:string)=>{
    for(let i=0;i<text.length&&pos<limit;i++){
      pos=skipStrippedComments(renderedSource,pos,limit);
      if(pos>=limit)break;
      const ch=text[i];
      if(ch==='\n'){
        const m=/^[ \t]*\r?\n[ \t]*(?:>[ \t]?)*[ \t]*/.exec(renderedSource.slice(pos,limit));
        pos+=m?m[0].length:1;
        continue;
      }
      if(renderedSource[pos]===ch){pos++;continue;}
      if(renderedSource[pos]==='\\'&&pos+1<limit&&renderedSource[pos+1]===ch){pos+=2;continue;}
      if(renderedSource[pos]==='&'){
        const ent=/^&(?:#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]+);/.exec(renderedSource.slice(pos,limit));
        if(ent){
          pos+=ent[0].length;
          const code=ch.charCodeAt(0);
          if(code>=0xd800&&code<=0xdbff&&i+1<text.length)i++;
          continue;
        }
      }
      if((ch===' '||ch==='\t')&&(renderedSource[pos]===' '||renderedSource[pos]==='\t')){pos++;continue;}
      pos++;
    }
  };

  const walk=(node:Node)=>{
    if(found)return;
    if(node===targetNode&&node.nodeType===Node.TEXT_NODE){
      const raw=(node as Text).data;
      advanceText(raw.slice(0,Math.max(0,Math.min(targetOffset,raw.length))));
      found=true;
      return;
    }
    if(node.nodeType===Node.TEXT_NODE){
      const data=(node as Text).data;
      if(!data.trim()){
        const parentTag=node.parentElement?.tagName??'';
        const prev=node.previousSibling,next=node.nextSibling;
        if(STRUCTURAL_CONTAINER_TAGS.has(parentTag)||(prev instanceof Element&&BLOCK_ELEMENT_TAGS.has(prev.tagName))||(next instanceof Element&&BLOCK_ELEMENT_TAGS.has(next.tagName)))return;
      }
      advanceText(data);
      return;
    }
    if(!(node instanceof Element))return;
    if(node!==owner){
      if(IGNORED_PROSE_WALK_TAGS.has(node.tagName)||node.classList.contains('katex-mathml')||node.classList.contains('live-block-edit')||node.classList.contains('image-edit-tools')||node.hasAttribute('data-frontmatter-properties')||node.classList.contains('document-properties'))return;
      if(node.tagName==='INPUT'){
        if(node.getAttribute('type')==='checkbox'){
          const m=/^[ \t]*\[[ xX]\]/.exec(renderedSource.slice(pos,limit));
          if(m){
            pos+=m[0].length;
            const nextText=node.nextSibling?.textContent??'';
            if(!nextText.startsWith(' ')&&!nextText.startsWith('\t')){
              const ws=/^[ \t]+/.exec(renderedSource.slice(pos,limit));
              if(ws)pos+=ws[0].length;
            }
          }
        }
        return;
      }
      if(node.classList.contains('katex')){
        const span=takeSpan('math',pos,limit);
        if(node.contains(targetNode)){if(span)pos=span.start;found=true;return;}
        if(span)pos=span.end;
        return;
      }
      if(node.tagName==='SUP'&&node.querySelector('a[data-footnote-ref]')){
        const span=takeSpan('footnote',pos,limit);
        if(node.contains(targetNode)){if(span)pos=span.start;found=true;return;}
        if(span)pos=span.end;
        return;
      }
      if(node.matches('.note-image,.image-loading,.image-error,.remote-image-card,img')){
        const span=takeSpan('image',pos,limit);
        if(node.contains(targetNode)){if(span)pos=span.start;found=true;return;}
        if(span){
          pos=span.end;
          const attr=/^\{[^}\r\n]*\b(?:width|zoom)\s*=\s*[^}\r\n]+\}/i.exec(renderedSource.slice(pos,limit));
          if(attr)pos+=attr[0].length;
        }
        return;
      }
      if(node.tagName==='BR'){
        const span=takeSpan('break',pos,limit);
        if(span)pos=span.end;
        else{
          const br=/^(?:<br\b[^>]*\/?>|[ \t\\]*\r?\n)/i.exec(renderedSource.slice(pos,limit));
          if(br)pos+=br[0].length;
        }
        const cont=/^[ \t]*(?:>[ \t]?)*[ \t]*/.exec(renderedSource.slice(pos,limit));
        if(cont&&renderedSource[pos-1]==='\n')pos+=cont[0].length;
        return;
      }
      if(node.tagName==='CODE'&&node.parentElement?.tagName!=='PRE'){
        pos=skipStrippedComments(renderedSource,pos,limit);
        const span=takeSpan('code',pos,limit);
        const codeStart=span?span.start:pos,codeEnd=span?span.end:limit;
        if(!node.contains(targetNode)){if(span)pos=span.end;return;}
        let ticks=0;
        while(codeStart+ticks<codeEnd&&renderedSource[codeStart+ticks]==='`')ticks++;
        const rawInner=renderedSource.slice(codeStart+ticks,Math.max(codeStart+ticks,codeEnd-ticks));
        const padded=rawInner.length>=2&&rawInner.startsWith(' ')&&rawInner.endsWith(' ')&&rawInner.trim().length>0?1:0;
        let innerOffset=0;
        if(targetNode.nodeType===Node.TEXT_NODE)innerOffset=Math.max(0,Math.min(targetOffset,(targetNode as Text).data.length));
        else if(targetNode===node&&targetOffset>0)innerOffset=(node.textContent??'').length;
        pos=Math.min(Math.max(codeStart+ticks,codeEnd-ticks-padded),codeStart+ticks+padded+innerOffset);
        found=true;
        return;
      }
      if(node.classList.contains('callout-title')&&node.parentElement===owner){
        const nl=renderedSource.indexOf('\n',ownerStart);
        const line1End=nl>=0&&nl<=limit?(renderedSource[nl-1]==='\r'?nl-1:nl):limit;
        if(!node.contains(targetNode)){pos=Math.max(pos,line1End);return;}
        if(pos>=line1End){pos=line1End;found=true;return;}
        limit=Math.min(limit,line1End);
      }else{
        const isSplitCalloutBody=node.tagName==='P'&&node.previousElementSibling?.classList.contains('callout-title');
        const bounds=isSplitCalloutBody?null:parseSourceBounds(node,pos,limit);
        if(bounds){
          if(!node.contains(targetNode)){pos=bounds[1];return;}
          pos=bounds[0];limit=bounds[1];
          pos=skipElementOpening(node,renderedSource,pos,limit);
        }else{
          if(BLOCK_ELEMENT_TAGS.has(node.tagName)&&(renderedSource[pos]==='\r'||renderedSource[pos]==='\n')){
            const nl=/^\r?\n[ \t]*(?:>[ \t]?)*[ \t]*/.exec(renderedSource.slice(pos,limit));
            if(nl)pos+=nl[0].length;
          }
          pos=skipElementOpening(node,renderedSource,pos,limit);
        }
      }
    }
    const children=node.childNodes;
    const stopIndex=node===targetNode?Math.max(0,Math.min(targetOffset,children.length)):children.length;
    for(let i=0;i<stopIndex&&!found;i++)walk(children[i]);
    if(node===targetNode){found=true;return;}
    if(!found&&node!==owner)pos=skipInlineClosing(node.tagName,renderedSource,pos,limit);
  };

  walk(owner);
  if(!found)return null;
  return Math.max(0,Math.min(blockEnd-blockStart,pos-blockStart));
}

export interface SavedLiveSelection {from:number;to:number;markdown:string}
export interface InsertionPointDetail {
  point?:{from:number;to:number};x?:number;y?:number;coords?:{x:number;y:number};target?:Element|null;
}
export interface LiveInsertionPointState {
  markdown:string;editing:EditingSession|null;draftText:string;
  frontmatter:SourceDocumentAnalysis['analysis']['frontmatter'];
}

export function resolveLiveInsertionPoint(
  detail:InsertionPointDetail|null|undefined,
  root:HTMLElement|null,
  editor:HTMLTextAreaElement|null,
  state:LiveInsertionPointState,
  syncedMarkdown:string,
  savedSelection:{current:SavedLiveSelection|null},
  rememberSelection:(area:HTMLTextAreaElement|null,current?:EditingSession|null)=>void,
):void{
  if(!detail||detail.point!==undefined)return;
  const x=typeof detail.x==='number'?detail.x:detail.coords?.x;
  const y=typeof detail.y==='number'?detail.y:detail.coords?.y;
  const hasCoords=typeof x==='number'&&typeof y==='number'&&Number.isFinite(x)&&Number.isFinite(y);
  const {markdown:currentMarkdown,editing:currentEditing,draftText:latestDraft,frontmatter:currentFrontmatter}=state;
  const activeDoc=currentEditing?syncedMarkdown:currentMarkdown;
  if(hasCoords||detail.target){
    if(!root||!root.isConnected)return;
    const surface=root.closest<HTMLElement>('.android-reading,.reading-scroll,.live-pane,.live-scroll')??root;
    const rawTarget=detail.target instanceof Element?detail.target:(hasCoords&&typeof document.elementFromPoint==='function'?document.elementFromPoint(x!,y!):null);
    const bounds=surface.getBoundingClientRect();
    const surfaceHasLayout=bounds.width>0&&bounds.height>0;
    if(rawTarget){
      if(!surface.contains(rawTarget)&&!root.contains(rawTarget))return;
    }else if(!hasCoords||!surfaceHasLayout||x!<bounds.left||x!>bounds.right||y!<bounds.top||y!>bounds.bottom){
      return;
    }
    const clampOffset=(offset:number)=>Math.max(0,Math.min(offset,activeDoc.length));
    const resolveBlockSpan=(blockEl:HTMLElement):[number,number]|null=>{
      if(currentEditing&&(blockEl.matches('.live-active-block')||blockEl.querySelector('.live-active-block')||blockEl.closest('.live-active-block'))){
        if(currentEditing.insertAfter!==undefined&&latestDraft===''){
          const pos=clampOffset(currentEditing.baseSplitEnd);
          return [pos,pos];
        }
        const start=clampOffset(currentEditing.prefix.length);
        const end=Math.max(start,clampOffset(currentEditing.prefix.length+latestDraft.length));
        return [start,end];
      }
      const rawStart=blockEl.dataset.sourceStart!==undefined?Number(blockEl.dataset.sourceStart):NaN;
      const rawEnd=blockEl.dataset.sourceEnd!==undefined?Number(blockEl.dataset.sourceEnd):NaN;
      if(!Number.isFinite(rawStart)||!Number.isFinite(rawEnd))return null;
      const [start,end]=translateRenderedRange(rawStart,rawEnd,currentEditing,activeDoc);
      const clampedStart=clampOffset(start);
      return [clampedStart,Math.max(clampedStart,clampOffset(end))];
    };
    if(rawTarget?.closest('[data-frontmatter-properties],.document-properties')){
      const pos=clampOffset(currentFrontmatter?.end??0);
      detail.point={from:pos,to:pos};
      return;
    }
    const hitBlock=rawTarget?.closest<HTMLElement>('.live-block,.live-active-block');
    if(hitBlock&&root.contains(hitBlock)){
      const span=resolveBlockSpan(hitBlock);
      if(span){detail.point={from:span[1],to:span[1]};return;}
    }
    const blockEls=Array.from(root.querySelectorAll<HTMLElement>('.live-block,.live-active-block')).filter(el=>!el.parentElement?.closest('.live-block'));
    const measured=blockEls.map(el=>({el,span:resolveBlockSpan(el),rect:el.getBoundingClientRect()})).filter((entry):entry is {el:HTMLElement;span:[number,number];rect:DOMRect}=>entry.span!==null);
    if(!measured.length){
      const pos=clampOffset(currentFrontmatter?.end??activeDoc.length);
      detail.point={from:pos,to:pos};
      return;
    }
    if(hasCoords&&measured.some(entry=>entry.rect.height>0||entry.rect.top!==0||entry.rect.bottom!==0)){
      if(y!<measured[0].rect.top){
        const pos=clampOffset(currentFrontmatter?.end??measured[0].span[0]);
        detail.point={from:pos,to:pos};
        return;
      }
      let chosen=measured[0];
      for(const entry of measured){
        if(entry.rect.top<=y!)chosen=entry;
        else break;
      }
      detail.point={from:chosen.span[1],to:chosen.span[1]};
      return;
    }
    const lastEnd=measured[measured.length-1].span[1];
    detail.point={from:lastEnd,to:lastEnd};
    return;
  }
  if(editor&&currentEditing)rememberSelection(editor,currentEditing);
  const saved=savedSelection.current;
  if(!saved||saved.markdown!==activeDoc){savedSelection.current=null;return;}
  const from=Math.max(0,Math.min(saved.from,activeDoc.length));
  const to=Math.max(from,Math.min(saved.to,activeDoc.length));
  detail.point={from,to};
}

export function useLiveInsertionPoint(
  rootRef:RefObject<HTMLDivElement|null>,
  editorRef:RefObject<HTMLTextAreaElement|null>,
  latestRef:RefObject<LiveInsertionPointState>,
  syncedMarkdownRef:RefObject<string>,
  savedSelection:RefObject<SavedLiveSelection|null>,
  rememberSelection:(area:HTMLTextAreaElement|null,current?:EditingSession|null)=>void,
):void{
  useEffect(()=>{
    const point=(event:Event)=>resolveLiveInsertionPoint(
      (event as CustomEvent<InsertionPointDetail>).detail,
      rootRef.current,editorRef.current,latestRef.current,syncedMarkdownRef.current,savedSelection,rememberSelection,
    );
    window.addEventListener('supermd-insertion-point',point);
    return()=>window.removeEventListener('supermd-insertion-point',point);
  },[editorRef,latestRef,rememberSelection,rootRef,savedSelection,syncedMarkdownRef]);
}
