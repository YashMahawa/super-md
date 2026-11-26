import {refreshDocumentExtent} from "./documentZoom";
import {readingCaretOffset,readingOffset,revealReadingOffset} from "./readingPosition";

export type AnchorViewMode = "reader" | "live" | "editor" | "split";
export type SplitAnchorPane = "editor" | "preview";

const programmaticScrollAt=new WeakMap<Element,number>();

export function markProgrammaticAnchorScroll(element:Element|null|undefined):void {
  if(element&&typeof performance!=="undefined")programmaticScrollAt.set(element,performance.now());
}

export function clearProgrammaticAnchorScroll(element:Element|null|undefined):void {
  if(!element)return;
  programmaticScrollAt.delete(element);
  delete (element as HTMLElement&{__anchorScrollAt?:number}).__anchorScrollAt;
}

export function isProgrammaticAnchorScroll(element:Element|null|undefined,windowMs=220):boolean {
  if(!element||typeof performance==="undefined")return false;
  const now=performance.now();
  const stamped=programmaticScrollAt.get(element);
  if(stamped!==undefined&&now-stamped<=windowMs)return true;
  const prop=(element as HTMLElement&{__anchorScrollAt?:number}).__anchorScrollAt;
  return prop!==undefined&&now-prop<=windowMs;
}

export interface ReadingScrollSnapshot {
  element:HTMLElement;
  top:number;
  scrollHeight:number;
  clientHeight:number;
}

export function snapshotReadingScroll(element:HTMLElement|null|undefined):ReadingScrollSnapshot|null {
  if(!element)return null;
  return {
    element,
    top:element.scrollTop,
    scrollHeight:element.scrollHeight,
    clientHeight:element.clientHeight,
  };
}

export function hasExternalReadingScroll(
  previous:ReadingScrollSnapshot|null,
  current:HTMLElement|null|undefined,
):boolean {
  if(!previous||!current||previous.element!==current)return false;
  if(
    Math.abs(current.scrollHeight-previous.scrollHeight)>1||
    Math.abs(current.clientHeight-previous.clientHeight)>1
  ){
    return false;
  }
  return Math.abs(current.scrollTop-previous.top)>2;
}

export interface PendingEditorAnchor {
  offset:number;
  caretOffset?:number;
  top?:number;
  updateSelection?:boolean;
}

export interface EditorAnchorAdapter {
  readingOffset:()=>number|undefined;
  caretOffset:()=>number|undefined;
  scrollTop:()=>number|undefined;
  applyAnchor:(anchor:PendingEditorAnchor,focus?:boolean)=>void;
}

const liveEditorAdapters=new Map<string,EditorAnchorAdapter>();
const cachedEditorScrollTops=new Map<string,number>();
const pendingEditorAnchors=new Map<string,PendingEditorAnchor>();

export function registerEditorAnchorAdapter(id:string,adapter:EditorAnchorAdapter|null,cachedTop?:number):void {
  if(!adapter){
    liveEditorAdapters.delete(id);
    if(cachedTop!==undefined){
      cachedEditorScrollTops.delete(id);
      cachedEditorScrollTops.set(id,cachedTop);
      while(cachedEditorScrollTops.size>40)cachedEditorScrollTops.delete(cachedEditorScrollTops.keys().next().value!);
    }
    return;
  }
  liveEditorAdapters.set(id,adapter);
}

export function consumePendingEditorAnchor(id:string):PendingEditorAnchor|undefined {
  const pending=pendingEditorAnchors.get(id);
  pendingEditorAnchors.delete(id);
  return pending;
}

export function primeEditorAnchor(id:string,anchor:PendingEditorAnchor|null):void {
  if(!anchor){
    pendingEditorAnchors.delete(id);
    return;
  }
  const live=liveEditorAdapters.get(id);
  if(live){
    pendingEditorAnchors.delete(id);
    live.applyAnchor(anchor);
    return;
  }
  pendingEditorAnchors.set(id,anchor);
  while(pendingEditorAnchors.size>40)pendingEditorAnchors.delete(pendingEditorAnchors.keys().next().value!);
}

export function revealEditorOffset(id:string,offset:number,options?:{caretOffset?:number;top?:number;focus?:boolean;updateSelection?:boolean}):boolean {
  const live=liveEditorAdapters.get(id);
  const anchor:PendingEditorAnchor={offset,caretOffset:options?.caretOffset,top:options?.top,updateSelection:options?.updateSelection};
  if(!live){
    primeEditorAnchor(id,anchor);
    return false;
  }
  pendingEditorAnchors.delete(id);
  live.applyAnchor(anchor,options?.focus);
  return true;
}

export interface SharedSourceAnchor {
  offset:number;
  caretOffset?:number;
  mode:AnchorViewMode;
  zoom:number;
  readingTop?:number;
  editorTop?:number;
}

export function detectSplitPaneFromTarget(target:EventTarget|null):SplitAnchorPane|null {
  const element=target instanceof Element?target:target instanceof Node?target.parentElement:null;
  if(!element)return null;
  if(element.closest(".cm-editor,.cm-scroller,.android-source,.editor-pane"))return "editor";
  if(element.closest(".android-reading,.reading-scroll,.preview-pane,.live-pane"))return "preview";
  return null;
}

export function captureSharedAnchor(options:{
  id:string;
  mode:AnchorViewMode;
  zoom:number;
  readingRoot:HTMLElement|null;
  preferredSplitPane?:SplitAnchorPane|null;
}):SharedSourceAnchor {
  const {id,mode,zoom,readingRoot,preferredSplitPane}=options;
  const captureEditor=()=>{
    const adapter=liveEditorAdapters.get(id);
    return {
      offset:adapter?.readingOffset()??0,
      caretOffset:adapter?.caretOffset(),
      editorTop:adapter?.scrollTop()??cachedEditorScrollTops.get(id)??0,
    };
  };
  const captureReading=()=>({
    offset:readingRoot?readingOffset(readingRoot):0,
    caretOffset:readingRoot?readingCaretOffset(readingRoot):undefined,
    readingTop:readingRoot?.scrollTop??0,
  });
  if(mode==="editor"){
    const ed=captureEditor();
    return {offset:ed.offset,caretOffset:ed.caretOffset,mode,zoom,editorTop:ed.editorTop};
  }
  if(mode==="live"||mode==="reader"){
    const rd=captureReading();
    return {offset:rd.offset,caretOffset:rd.caretOffset,mode,zoom,readingTop:rd.readingTop};
  }
  const ed=captureEditor();
  const rd=captureReading();
  let usePreview:boolean;
  if(preferredSplitPane==="preview")usePreview=true;
  else if(preferredSplitPane==="editor")usePreview=false;
  else if(rd.offset>0&&ed.offset===0)usePreview=true;
  else usePreview=false;
  const chosen=usePreview?rd:ed;
  return {
    offset:chosen.offset,
    caretOffset:chosen.caretOffset,
    mode,
    zoom,
    editorTop:ed.editorTop,
    readingTop:rd.readingTop,
  };
}

export function applySharedAnchor(options:{
  id:string;
  targetMode:AnchorViewMode;
  targetZoom:number;
  anchor:SharedSourceAnchor;
  readingRoot:HTMLElement|null;
  allowExactTop:boolean;
  updateSelection?:boolean;
}):void {
  const {id,targetMode,targetZoom,anchor,readingRoot,allowExactTop,updateSelection=true}=options;
  const sameGeometry=allowExactTop&&anchor.mode===targetMode&&Math.abs(anchor.zoom-targetZoom)<1;
  if(sameGeometry){
    if(targetMode==="editor"){
      if(anchor.editorTop!==undefined)revealEditorOffset(id,anchor.offset,{top:anchor.editorTop,updateSelection:false});
      return;
    }
    if(targetMode==="live"||targetMode==="reader"){
      if(readingRoot){
        if(anchor.readingTop!==undefined){
          markProgrammaticAnchorScroll(readingRoot);
          if(readingRoot.querySelector(".document-page"))refreshDocumentExtent(readingRoot);
          readingRoot.scrollTop=Math.max(0,anchor.readingTop);
        }else revealReadingOffset(readingRoot,anchor.offset,anchor.caretOffset);
      }
      return;
    }
    if(anchor.editorTop!==undefined)revealEditorOffset(id,anchor.offset,{top:anchor.editorTop,updateSelection:false});
    else revealEditorOffset(id,anchor.offset,{caretOffset:anchor.caretOffset,updateSelection});
    if(readingRoot){
      if(anchor.readingTop!==undefined){
        markProgrammaticAnchorScroll(readingRoot);
        if(readingRoot.querySelector(".document-page"))refreshDocumentExtent(readingRoot);
        readingRoot.scrollTop=Math.max(0,anchor.readingTop);
      }else revealReadingOffset(readingRoot,anchor.offset,anchor.caretOffset);
    }
    return;
  }
  if(targetMode==="editor"){
    revealEditorOffset(id,anchor.offset,{caretOffset:anchor.caretOffset,updateSelection});
    return;
  }
  if(targetMode==="live"||targetMode==="reader"){
    primeEditorAnchor(id,null);
    if(readingRoot){
      markProgrammaticAnchorScroll(readingRoot);
      revealReadingOffset(readingRoot,anchor.offset,anchor.caretOffset);
    }
    return;
  }
  revealEditorOffset(id,anchor.offset,{caretOffset:anchor.caretOffset,updateSelection});
  if(readingRoot){
    markProgrammaticAnchorScroll(readingRoot);
    revealReadingOffset(readingRoot,anchor.offset,anchor.caretOffset);
  }
}
