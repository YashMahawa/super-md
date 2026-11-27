import {useEffect,type RefObject} from 'react';
import type {SourceDocumentAnalysis} from './documentAnalysis';
import {translateRenderedRange,type EditingSession} from './liveBlockHistory';

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
export {resolveDoubleClickCaretRange,resolveLiveCaretOffset} from './liveSelectionRange';
