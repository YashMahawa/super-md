import { visit } from "unist-util-visit";
import {analyzeDocument,type OutlineEntry} from './documentAnalysis';
import {headingSlug} from './headingSlug';
export {headingSlug} from './headingSlug';
export type {OutlineEntry} from './documentAnalysis';
import {revealWindowed} from "./windowedSearch";
import {applyDocumentZoom,invalidateDocumentZoom,refreshDocumentExtent} from './documentZoom';
const jumps=new WeakMap<Element,{stop:()=>void}>();
/** A user's zoom/pan wins over the settling frames of a preceding link jump. */
export function cancelHeadingNavigation(root:Element|null):void {
  if(!root)return;
  jumps.get(root)?.stop();jumps.delete(root);delete (root as HTMLElement).dataset.navigating;
}

export function documentOutline(markdown:string):OutlineEntry[] {
  return analyzeDocument(markdown).outline;
}
export function headingText(node: any): string {
  return typeof node.value === "string" ? node.value : (node.children || []).map(headingText).join("");
}
export function remarkHeadingIds() {
  return (tree: unknown) => {
    const counts = new Map<string, number>();
    visit(tree as never, "heading", (node: any) => {
      const slug = headingSlug(headingText(node)), count = counts.get(slug) || 0;
      counts.set(slug, count + 1);
      node.data = { ...node.data, hProperties: { ...node.data?.hProperties, id: slug + (count ? `-${count}` : ""), "data-heading-key": slug } };
    });
  };
}
export function navigateHeading(link: HTMLAnchorElement): boolean {
  const href = link.getAttribute("href"); if (!href?.startsWith("#")) return false;
  let target = href.slice(1); try { target = decodeURIComponent(target); } catch { /* literal fragment */ }
  const root = link.closest(".reading-scroll,.live-pane,.android-reading") || link.closest(".markdown-body")?.parentElement;
  if (!root) return false;
  return navigateToHeading(root,target);
}
export function navigateToHeading(root:Element,target:string):boolean {
  const headings = Array.from(root.querySelectorAll<HTMLElement>("[data-heading-key]"));
  const counts = new Map<string, number>();
  if(!root.querySelector('[data-windowed-block]'))for (const heading of headings) { const key = heading.dataset.headingKey!, count = counts.get(key) || 0; counts.set(key, count + 1); heading.id = key + (count ? `-${count}` : ""); }
  const heading = headings.find(node => node.id === target) || Array.from(root.querySelectorAll<HTMLElement>('[id]')).find(node=>node.id===target) || headings.find(node => node.id === headingSlug(target));
  if (!heading) return true; // Broken local links must not escape into a browser.
  cancelHeadingNavigation(root);
  let observer:ResizeObserver|undefined,timer=0,frame=0;
  const token={stop:()=>{observer?.disconnect();window.clearTimeout(timer);cancelAnimationFrame(frame);}};jumps.set(root,token);
  const host=root as HTMLElement;host.dataset.navigating='true';
  revealWindowed(heading);
  // Native scrollIntoView can clamp against the old magnified spacer, or move
  // a WebView ancestor rather than its reading pane. Lazy blocks also change
  // height after the first frame. Resolve and align within this scroller only.
  const align=(frames:number)=>{
    if(jumps.get(root)!==token || !host.isConnected)return;
    const mounted=Array.from(root.querySelectorAll<HTMLElement>('[id]')).find(node=>node.id===heading.id) || heading;
    if(!host.contains(mounted)){cancelHeadingNavigation(root);return;}
    revealWindowed(mounted);
    const page=host.querySelector<HTMLElement>('.document-page');
    if(page&&!refreshDocumentExtent(host)){invalidateDocumentZoom(host);applyDocumentZoom(host,Number(page.dataset.scale)*100||100,Number.parseFloat(document.documentElement.style.getPropertyValue('--reading-max-width'))||80,undefined,undefined,undefined,host.dataset.centerLocked==='true');}
    // Native toolbars overlay the document rather than resizing its viewport.
    // The host reports only their CURRENT visible occlusion separately from
    // the permanent first-note spacer, so hidden controls add no jump margin.
    const visibleChrome=Number.parseFloat(getComputedStyle(host.ownerDocument.documentElement).getPropertyValue('--native-visible-chrome-inset'));
    const gap=16+(Number.isFinite(visibleChrome)?Math.max(0,Math.min(480,visibleChrome)):0);
    host.scrollTop+=mounted.getBoundingClientRect().top-host.getBoundingClientRect().top-gap;
    mounted.tabIndex=-1;mounted.focus({preventScroll:true});
    if(frames>0)frame=requestAnimationFrame(()=>align(frames-1));
  };
  align(0);
  frame=requestAnimationFrame(()=>align(5));
  const page=host.querySelector<HTMLElement>('.document-page');
  if(page&&typeof ResizeObserver!=='undefined'){
    observer=new ResizeObserver(()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(()=>align(0));});
    observer.observe(page);
  }
  // Fonts and lazy neighbouring blocks may settle after the initial six
  // frames, including delayed diagrams above the target. Keep the observer
  // briefly active so those size changes do not strand the heading offscreen.
  // User zoom/pan cancels this token immediately and wins over the jump.
  timer=window.setTimeout(()=>{if(jumps.get(root)===token)cancelHeadingNavigation(root);},5000);
  return true;
}
