/** Source offsets survive switching between reflowed reading and source views. */
import {caretRangeAtPoint} from "./caretPoint";
import {refreshDocumentExtent} from "./documentZoom";
import {revealWindowed} from "./windowedSearch";

const INLINE_SOURCE_TAG=/^(?:A|EM|STRONG|CODE|DEL|SPAN|MARK|SUB|SUP|KBD|U|INPUT|IMG|BR)$/i;
const CONTAINER_ONLY_SELECTOR="ul,ol,table,thead,tbody,tr,.live-block,[data-windowed-block]";

function visibleTopGap(root:HTMLElement):number {
  const visibleChrome=Number.parseFloat(getComputedStyle(root.ownerDocument.documentElement).getPropertyValue("--native-visible-chrome-inset"));
  return 16+(Number.isFinite(visibleChrome)?Math.max(0,Math.min(480,visibleChrome)):0);
}

function activeTextareaOffset(area:HTMLTextAreaElement,probeY:number):number {
  const base=Number(area.dataset.sourceStart)||0;
  const rect=area.getBoundingClientRect();
  if(rect.height<=0||!area.value.length)return base;
  const styles=getComputedStyle(area);
  const padTop=Number.parseFloat(styles.paddingTop)||16;
  const padBottom=Number.parseFloat(styles.paddingBottom)||16;
  const innerHeight=Math.max(1,rect.height-padTop-padBottom);
  const lines=area.value.split("\n");
  const ratio=Math.max(0,Math.min(0.999999,(probeY-(rect.top+padTop))/innerHeight));
  const lineIndex=Math.min(lines.length-1,Math.max(0,Math.floor(ratio*lines.length)));
  let rel=0;
  for(let i=0;i<lineIndex;i++)rel+=lines[i].length+1;
  rel+=lines[lineIndex]?.match(/^[ \t]*/)?.[0].length??0;
  return base+rel;
}

function activeTextareaLineOffsetPx(area:HTMLTextAreaElement,relativeOffset:number):number {
  const rect=area.getBoundingClientRect();
  if(rect.height<=0||relativeOffset<=0||!area.value.length)return 0;
  const styles=getComputedStyle(area);
  const padTop=Number.parseFloat(styles.paddingTop)||16;
  const padBottom=Number.parseFloat(styles.paddingBottom)||16;
  const innerHeight=Math.max(1,rect.height-padTop-padBottom);
  const lines=area.value.split("\n");
  const clamped=Math.min(area.value.length,Math.max(0,relativeOffset));
  let lineIndex=0,cursor=0;
  for(let i=0;i<lines.length;i++){
    const next=cursor+lines[i].length+1;
    if(clamped<next){lineIndex=i;break;}
    cursor=next;
    lineIndex=i;
  }
  return padTop+(lineIndex/Math.max(1,lines.length))*innerHeight;
}

export function readingCaretOffset(root:HTMLElement):number|undefined {
  const area=root.querySelector<HTMLTextAreaElement>(".live-active-block textarea[data-source-start]");
  if(!area)return undefined;
  const isFocused=root.ownerDocument.activeElement===area;
  if(!isFocused&&area.selectionStart<=0)return undefined;
  const bounds=root.getBoundingClientRect(),rect=area.getBoundingClientRect();
  if(bounds.height>0&&rect.height>0&&(rect.bottom<=bounds.top||rect.top>=bounds.bottom))return undefined;
  return (Number(area.dataset.sourceStart)||0)+area.selectionStart;
}

function closestSourceBlock(node:Element|null,root:HTMLElement):HTMLElement|null {
  let current=node?.closest<HTMLElement>("[data-source-start],.live-block")??null;
  while(current&&root.contains(current)&&INLINE_SOURCE_TAG.test(current.tagName)){
    current=current.parentElement?.closest<HTMLElement>("[data-source-start],.live-block")??null;
  }
  return current&&root.contains(current)?current:null;
}

export function readingOffset(root:HTMLElement):number {
  if(root.clientHeight>0&&root.scrollTop<=1)return 0;
  const bounds=root.getBoundingClientRect();
  const top=bounds.top+visibleTopGap(root)+4;
  const activeArea=root.querySelector<HTMLTextAreaElement>(".live-active-block textarea[data-source-start]");
  if(activeArea){
    const r=activeArea.getBoundingClientRect();
    if(r.height>0&&r.top<=top&&r.bottom>top)return activeTextareaOffset(activeArea,top);
  }
  const probeXs=bounds.width>0?[bounds.left+Math.min(96,bounds.width*.25),bounds.left+bounds.width*.5]:[bounds.left];
  for(const x of probeXs){
    const caret=caretRangeAtPoint(root.ownerDocument,x,top);
    if(!caret||caret.startContainer.nodeType!==Node.TEXT_NODE||!root.contains(caret.startContainer))continue;
    const probe=caret.cloneRange();
    const len=caret.startContainer.textContent?.length??0;
    if(probe.startOffset<len)probe.setEnd(caret.startContainer,probe.startOffset+1);
    else if(probe.startOffset>0)probe.setStart(caret.startContainer,probe.startOffset-1);
    const charRect=probe.getBoundingClientRect();
    if(charRect.height>0&&charRect.bottom>=bounds.top&&charRect.top<=top+36){
      const hit=closestSourceBlock(caret.startContainer.parentElement,root);
      if(hit&&Number.isFinite(Number(hit.dataset.sourceStart)))return Number(hit.dataset.sourceStart)||0;
    }
  }
  const candidates=Array.from(root.querySelectorAll<HTMLElement>(".live-block,[data-source-start]")).filter(node=>{
    if(INLINE_SOURCE_TAG.test(node.tagName))return false;
    if(!Number.isFinite(Number(node.dataset.sourceStart)))return false;
    const r=node.getBoundingClientRect();
    return r.bottom>top&&r.height>0;
  });
  if(!candidates.length)return 0;
  let current=candidates[0];
  let currentStart=Number(current.dataset.sourceStart)||0;
  for(let i=1;i<candidates.length;i++){
    const next=candidates[i];
    if(!current.contains(next))continue;
    const nextRect=next.getBoundingClientRect();
    const nextStart=Number(next.dataset.sourceStart)||0;
    if(nextRect.top<=top+6||nextStart===currentStart||current.matches(CONTAINER_ONLY_SELECTOR)){
      current=next;
      currentStart=nextStart;
    }
  }
  if(current instanceof HTMLTextAreaElement&&current.closest(".live-active-block")){
    return activeTextareaOffset(current,Math.max(top,current.getBoundingClientRect().top+1));
  }
  return currentStart;
}

function findDeepestBlockAtOffset(root:HTMLElement,targetOffset:number):HTMLElement|undefined {
  let windowedTarget:HTMLElement|undefined;
  let windowedStart=-Infinity;
  for(const windowed of root.querySelectorAll<HTMLElement>("[data-windowed-block][data-source-start]")){
    const start=Number(windowed.dataset.sourceStart);
    if(Number.isFinite(start)&&start<=targetOffset&&start>=windowedStart){
      windowedTarget=windowed;
      windowedStart=start;
    }
  }
  if(windowedTarget)revealWindowed(windowedTarget);
  const blocks=root.querySelectorAll<HTMLElement>(".live-block,[data-source-start]");
  let best:HTMLElement|undefined;
  let bestStart=-Infinity;
  for(const block of blocks){
    if(INLINE_SOURCE_TAG.test(block.tagName))continue;
    const start=Number(block.dataset.sourceStart);
    if(!Number.isFinite(start))continue;
    if(start<=targetOffset&&start>=bestStart){
      best=block;
      bestStart=start;
    }
  }
  return best;
}

export function revealReadingOffset(root:HTMLElement,offset:number,caretOffset?:number):void {
  if(typeof performance!=="undefined")(root as HTMLElement&{__anchorScrollAt?:number}).__anchorScrollAt=performance.now();
  const page=root.querySelector<HTMLElement>(".document-page");
  if(page)refreshDocumentExtent(root);
  const scrollable=root.clientHeight>0&&root.scrollHeight>root.clientHeight;
  if(offset<=0){
    root.scrollTop=0;
    if(caretOffset!==undefined&&caretOffset>0&&scrollable){
      const caretTarget=findDeepestBlockAtOffset(root,caretOffset);
      if(!caretTarget)return;
      revealWindowed(caretTarget);
      if(page)refreshDocumentExtent(root);
      const bounds=root.getBoundingClientRect(),gap=visibleTopGap(root),rect=caretTarget.getBoundingClientRect();
      if(caretTarget instanceof HTMLTextAreaElement&&caretTarget.closest(".live-active-block")){
        const lineY=rect.top+activeTextareaLineOffsetPx(caretTarget,caretOffset-(Number(caretTarget.dataset.sourceStart)||0));
        if(lineY+28>bounds.bottom-24)root.scrollTop=Math.max(0,root.scrollTop+(lineY+28)-(bounds.bottom-32));
      }else if(rect.height>0&&rect.bottom>bounds.bottom-24){
        if(rect.height>bounds.height-gap-32)root.scrollTop=Math.max(0,root.scrollTop+rect.top-bounds.top-gap);
        else root.scrollTop=Math.max(0,root.scrollTop+rect.bottom-(bounds.bottom-32));
      }
    }
    return;
  }
  const best=findDeepestBlockAtOffset(root,offset);
  if(!best){
    root.scrollTop=0;
    return;
  }
  revealWindowed(best);
  if(page)refreshDocumentExtent(root);
  if(scrollable){
    const bounds=root.getBoundingClientRect(),gap=visibleTopGap(root),rect=best.getBoundingClientRect();
    if(best instanceof HTMLTextAreaElement&&best.closest(".live-active-block")){
      const lineOffset=activeTextareaLineOffsetPx(best,offset-(Number(best.dataset.sourceStart)||0));
      root.scrollTop=Math.max(0,root.scrollTop+(rect.top+lineOffset)-bounds.top-gap);
    }else{
      root.scrollTop=Math.max(0,root.scrollTop+rect.top-bounds.top-gap);
    }
  }else{
    best.scrollIntoView({block:"start",behavior:"instant"});
  }
}
