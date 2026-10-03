import { visit } from "unist-util-visit";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkMath from "remark-math";
import { remarkObsidianMath } from "./obsidianMath";
import {revealWindowed} from "./windowedSearch";
import {applyDocumentZoom,invalidateDocumentZoom} from './documentZoom';
const jumps=new WeakMap<Element,object>();

export interface OutlineEntry {id:string;title:string;level:number;offset:number}
export function documentOutline(markdown:string):OutlineEntry[] {
  const front=markdown.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/)?.[0].length||0;
  const tree=unified().use(remarkParse).use(remarkMath).use(remarkObsidianMath).parse(markdown.slice(front));
  const result:OutlineEntry[]=[],counts=new Map<string,number>();
  visit(tree,"heading",(node:any)=>{const title=headingText(node),slug=headingSlug(title),count=counts.get(slug)||0;counts.set(slug,count+1);if(result.length<2000)result.push({id:slug+(count?`-${count}`:""),title,level:node.depth,offset:front+(node.position?.start.offset||0)});});
  return result;
}

export function headingSlug(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/<[^>]+>/g, "").replace(/[^\p{L}\p{N}\s_-]/gu, "").trim().replace(/\s/g, "-") || "section";
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
  const heading = headings.find(node => node.id === target) || headings.find(node => node.id === headingSlug(target));
  if (!heading) return true; // Broken local links must not escape into a browser.
  const token={};jumps.set(root,token);
  const host=root as HTMLElement;host.dataset.navigating='true';
  revealWindowed(heading);
  // Native scrollIntoView can clamp against the old magnified spacer, or move
  // a WebView ancestor rather than its reading pane. Lazy blocks also change
  // height after the first frame. Resolve and align within this scroller only.
  const align=(frames:number)=>{
    if(jumps.get(root)!==token || !host.isConnected)return;
    const mounted=Array.from(root.querySelectorAll<HTMLElement>('[data-heading-key]')).find(node=>node.id===heading.id) || heading;
    revealWindowed(mounted);
    const page=host.querySelector<HTMLElement>('.document-page');
    if(page){invalidateDocumentZoom(host);applyDocumentZoom(host,Number(page.dataset.scale)*100||100,Number.parseFloat(document.documentElement.style.getPropertyValue('--reading-max-width'))||80);}
    host.scrollTop+=mounted.getBoundingClientRect().top-host.getBoundingClientRect().top-16;
    mounted.tabIndex=-1;mounted.focus({preventScroll:true});
    if(frames>0)requestAnimationFrame(()=>align(frames-1));
    else delete host.dataset.navigating;
  };
  align(0);
  host.dataset.navigating='true';
  requestAnimationFrame(()=>align(5));
  return true;
}
