import DOMPurify from "dompurify";
import {canUsePele,resolvePeleSvg} from './peleRenderer';

export function sanitizeDiagram(svg: string): string {
  return DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ["script", "foreignObject"],
  });
}
let queue = Promise.resolve();
let serial = 0;
const cache=new Map<string,string>();
let cacheBytes=0;
export function renderMermaid(source: string, dark = false): Promise<string> {
  const key=JSON.stringify([source,dark]);
  const hit=cache.get(key);
  if(hit){cache.delete(key);cache.set(key,hit);return Promise.resolve(hit);}
  const render = async () => {
    if(cache.has(key))return cache.get(key)!;
    let output:string|undefined;
    if(canUsePele(source))try{
      const {renderAsync}=await import('pele/lazy');
      const result=await renderAsync(source,{fontFamily:'Arial, sans-serif',autoDirection:false,links:false,images:false,outputLimit:1_000_000,maxEdges:2000,idPrefix:`smd-pele-${serial+1}-`});
      output=resolvePeleSvg(sanitizeDiagram(result.svg),dark,`smd-diagram-${++serial}`);
    }catch{/* Keep Mermaid compatibility, including after a fast-path error. */}
    if(!output){
      const { default: mermaid } = await import("mermaid");
      const container = document.createElement("div");
      container.style.cssText = "position:fixed;left:-100000px;top:0;width:1200px;visibility:hidden;pointer-events:none";
      document.body.appendChild(container);
      try {
        mermaid.initialize({ startOnLoad: false, theme: dark ? "dark" : "neutral", securityLevel: "strict", htmlLabels: false, flowchart: { htmlLabels: false }, fontFamily: "Arial, sans-serif" });
        const safe=sanitizeDiagram((await mermaid.render(`smd-diagram-${++serial}`, source, container)).svg);
        const xml=new DOMParser().parseFromString(safe,'image/svg+xml'),root=xml.documentElement;
        // Images need intrinsic dimensions; Mermaid normally uses width=100%
        // because its SVG was designed to live inline in a measured DOM.
        const box=(root.getAttribute('viewBox')||'').split(/[\s,]+/).map(Number);
        if(box.length===4&&box.every(Number.isFinite)&&box[2]>0&&box[3]>0){root.setAttribute('width',String(box[2]));root.setAttribute('height',String(box[3]));}
        root.setAttribute('data-diagram-engine','mermaid');
        output=new XMLSerializer().serializeToString(root);
      } finally { container.remove(); }
    }
    const size=key.length+output.length;
    if(size<=1_000_000){
      while(cache.size>=16||cacheBytes+size>2_000_000){const first=cache.keys().next().value;if(first===undefined)break;cacheBytes-=first.length+cache.get(first)!.length;cache.delete(first);}
      cache.set(key,output);cacheBytes+=size;
    }
    return output;
  };
  const result = queue.then(render); queue = result.then(() => undefined, () => undefined);
  return result;
}
