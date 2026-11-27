import { renderToStaticMarkup } from "react-dom/server";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { SKIP, visit } from "unist-util-visit";
import InteractiveChart from "./components/InteractiveChart";
import { normalizeCallouts } from "./components/MarkdownPreview";
import { parseFrontmatter } from "./frontmatter";
import { invoke } from "./nativeBridge";
import {
  isMermaidSourcePath,
  loadLocalMermaidSource,
  validateLocalMermaidSourcePath,
} from "./markdownExport";
import {
  isRemoteImageApproved,
  loadedReaderImageData,
  normalizeApprovedImageUrls,
  normalizeTrustedImageHosts,
  remoteImageHost,
  type RemoteImageConsentPolicy,
} from "./remoteImageConsent";
import { renderMermaid } from "./mermaidRenderer";
import { pythonOutput } from "./renderedOutputs";
import { analyzeDocument } from "./documentAnalysis";
import { svgImage } from "./svgImage";
import { remarkObsidianMath } from "./obsidianMath";
import { remarkSvgBlocks } from "./svgBlocks";
import { remarkBracedFences } from "./fenceLanguage";
import { remarkStudySyntax } from "./studySyntax";
import {parseStepDeck} from "./components/StepCards";
import {parseDiagramSource} from "./components/InlineDiagram";
import {parseBinaryTreeSource} from "./components/BinaryTree";
import {stepDiagramSvg} from "./stepPdf";

interface ScannedHtmlTag {
  name: string;
  closing: boolean;
  end: number;
  attrs: Map<string, string>;
}

const HTML_IMAGE_WRAPPERS = new Set(["p", "div", "center", "figure"]);

function decodeHtmlAttr(value: string): string {
  if (!value.includes("&")) return value;
  return value.replace(/&(?:(amp|lt|gt|quot|apos)|#(\d{1,7})|#x([0-9a-f]{1,6}));/gi, (full, named?: string, dec?: string, hex?: string) => {
    if (named) {
      switch (named.toLowerCase()) {
        case "amp": return "&";
        case "lt": return "<";
        case "gt": return ">";
        case "quot": return '"';
        case "apos": return "'";
      }
    }
    const code = dec ? Number.parseInt(dec, 10) : hex ? Number.parseInt(hex, 16) : NaN;
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff)
      ? String.fromCodePoint(code)
      : full;
  });
}

function scanHtmlTag(input: string, start: number): ScannedHtmlTag | null {
  if (input[start] !== "<") return null;
  let pos = start + 1;
  let closing = false;
  if (input[pos] === "/") {
    closing = true;
    pos++;
  }
  const nameStart = pos;
  if (pos >= input.length || !/[A-Za-z]/.test(input[pos])) return null;
  pos++;
  while (pos < input.length && /[A-Za-z0-9-]/.test(input[pos])) pos++;
  const name = input.slice(nameStart, pos).toLowerCase();
  const attrs = new Map<string, string>();
  if (closing) {
    while (pos < input.length && /\s/.test(input[pos])) pos++;
    return input[pos] === ">" ? { name, closing: true, end: pos + 1, attrs } : null;
  }
  if (pos < input.length && !/[\s/>]/.test(input[pos])) return null;
  while (pos < input.length) {
    while (pos < input.length && /\s/.test(input[pos])) pos++;
    if (pos >= input.length) return null;
    if (input[pos] === ">") return { name, closing: false, end: pos + 1, attrs };
    if (input[pos] === "/" && input[pos + 1] === ">") return { name, closing: false, end: pos + 2, attrs };
    if (input[pos] === "/") { pos++; continue; }
    const attrStart = pos;
    while (pos < input.length && /[A-Za-z0-9_.:-]/.test(input[pos])) pos++;
    if (pos === attrStart || !/[A-Za-z_:]/.test(input[attrStart])) return null;
    const attrName = input.slice(attrStart, pos).toLowerCase();
    while (pos < input.length && /\s/.test(input[pos])) pos++;
    let attrValue = "";
    if (input[pos] === "=") {
      pos++;
      while (pos < input.length && /\s/.test(input[pos])) pos++;
      if (pos >= input.length) return null;
      const quote = input[pos];
      if (quote === '"' || quote === "'") {
        const closeIdx = input.indexOf(quote, pos + 1);
        if (closeIdx < 0) return null;
        attrValue = decodeHtmlAttr(input.slice(pos + 1, closeIdx));
        pos = closeIdx + 1;
      } else {
        const valStart = pos;
        while (pos < input.length && !/[\s"'=<>`]/.test(input[pos]) && !(input[pos] === "/" && input[pos + 1] === ">")) pos++;
        if (pos === valStart) return null;
        attrValue = decodeHtmlAttr(input.slice(valStart, pos));
      }
    }
    if (!attrs.has(attrName)) attrs.set(attrName, attrValue);
  }
  return null;
}

function cssProp(style: string, propName: string): string | undefined {
  let found: string | undefined;
  for (const decl of style.split(";")) {
    const colon = decl.indexOf(":");
    if (colon < 0) continue;
    if (decl.slice(0, colon).trim().toLowerCase() !== propName) continue;
    const clean = decl.slice(colon + 1).trim().replace(/\s*!important\s*$/i, "").trim();
    if (clean) found = clean;
  }
  return found;
}

function isPageBreakTag(tag: ScannedHtmlTag): boolean {
  if (tag.closing) return false;
  const style = tag.attrs.get("style") || "";
  if (
    cssProp(style, "page-break-after")?.toLowerCase() === "always" ||
    cssProp(style, "page-break-before")?.toLowerCase() === "always" ||
    cssProp(style, "break-after")?.toLowerCase() === "page" ||
    cssProp(style, "break-before")?.toLowerCase() === "page"
  ) {
    return true;
  }
  return (tag.attrs.get("class") || "").trim().split(/\s+/).some(c => /^page-?break$/i.test(c));
}

function parseHtmlImgTag(tag: ScannedHtmlTag): { url: string; alt: string; title?: string; attrs: string } | null {
  if (tag.closing || tag.name !== "img") return null;
  const src = (tag.attrs.get("src") || "").replace(/[\t\r\n]+/g, "").replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, "");
  if (!src) return null;
  const alt = (tag.attrs.get("alt") || "").replace(/[\r\n]+/g, " ").trim() || "Image";
  const title = (tag.attrs.get("title") || "").replace(/[\r\n]+/g, " ").trim() || undefined;
  const style = tag.attrs.get("style") || "";
  const styleWidth = cssProp(style, "width");
  const attrWidth = tag.attrs.get("width")?.trim();
  const width = (styleWidth || attrWidth || "").replace(/^['"]|['"]$/g, "").trim();
  const zoom = (cssProp(style, "zoom") || "").replace(/^['"]|['"]$/g, "").trim();
  const parts: string[] = [];
  if (width && /^\d+(?:\.\d+)?(?:%|px|pt|mm|cm|in)?$/i.test(width) && Number.parseFloat(width) > 0) parts.push(`width=${width}`);
  if (zoom && /^\d+(?:\.\d+)?%?$/i.test(zoom) && Number.parseFloat(zoom) > 0) parts.push(`zoom=${zoom}`);
  return { url: src, alt, ...(title ? { title } : {}), attrs: parts.length ? `{${parts.join(" ")}}` : "" };
}

function liftHtmlImages(tree: any): void {
  visit(tree, (parent: any) => {
    if (!Array.isArray(parent.children)) return;
    const blockParent = parent.type === "root" || parent.type === "blockquote" || parent.type === "listItem";
    const nextChildren: any[] = [];
    let changed = false;
    for (const child of parent.children) {
      if (child?.type !== "html" || typeof child.value !== "string" || !/<img(?=[\s/>])/i.test(child.value)) {
        nextChildren.push(child);
        continue;
      }
      const raw = child.value;
      if (blockParent) {
        const imgs: Array<NonNullable<ReturnType<typeof parseHtmlImgTag>>> = [];
        let pos = 0;
        let validBlock = true;
        while (pos < raw.length) {
          while (pos < raw.length && /\s/.test(raw[pos])) pos++;
          if (pos >= raw.length) break;
          if (raw.startsWith("<!--", pos)) {
            const commentEnd = raw.indexOf("-->", pos + 4);
            if (commentEnd < 0) { pos = raw.length; break; }
            pos = commentEnd + 3;
            continue;
          }
          const tag = scanHtmlTag(raw, pos);
          if (!tag || isPageBreakTag(tag)) {
            validBlock = false;
            break;
          }
          if (tag.name === "img" && !tag.closing) {
            const parsed = parseHtmlImgTag(tag);
            if (!parsed) {
              validBlock = false;
              break;
            }
            imgs.push(parsed);
          } else if (!HTML_IMAGE_WRAPPERS.has(tag.name)) {
            validBlock = false;
            break;
          }
          pos = tag.end;
        }
        if (validBlock && imgs.length > 0) {
          changed = true;
          for (const img of imgs) {
            nextChildren.push({
              type: "paragraph",
              children: [
                { type: "image", url: img.url, alt: img.alt, ...(img.title ? { title: img.title } : {}), data: { htmlImage: true } },
                ...(img.attrs ? [{ type: "text", value: img.attrs }] : []),
              ],
            });
          }
          continue;
        }
      } else {
        let pos = 0;
        let singleImg: NonNullable<ReturnType<typeof parseHtmlImgTag>> | null = null;
        let validInline = true;
        while (pos < raw.length) {
          while (pos < raw.length && /\s/.test(raw[pos])) pos++;
          if (pos >= raw.length) break;
          if (raw.startsWith("<!--", pos)) {
            const commentEnd = raw.indexOf("-->", pos + 4);
            if (commentEnd < 0) { pos = raw.length; break; }
            pos = commentEnd + 3;
            continue;
          }
          const tag = scanHtmlTag(raw, pos);
          const parsed = tag ? parseHtmlImgTag(tag) : null;
          if (!tag || !parsed || singleImg) {
            validInline = false;
            break;
          }
          singleImg = parsed;
          pos = tag.end;
        }
        if (validInline && singleImg) {
          changed = true;
          nextChildren.push({ type: "image", url: singleImg.url, alt: singleImg.alt, ...(singleImg.title ? { title: singleImg.title } : {}), data: { htmlImage: true } });
          if (singleImg.attrs) nextChildren.push({ type: "text", value: singleImg.attrs });
          continue;
        }
      }
      nextChildren.push(child);
    }
    if (changed) parent.children = nextChildren;
  });
}

function data(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob); });
}

export type PdfPreparationPhase = "prepare" | "assets+diagrams";
export type PdfPreparationProgress = { phase: PdfPreparationPhase; completed: number; total: number };
export type PreparePdfOptions = RemoteImageConsentPolicy & {
  signal?: AbortSignal;
  onProgress?: (progress: PdfPreparationProgress) => void;
};

function cancelledError(): Error {
  if (typeof DOMException !== "undefined") return new DOMException("PDF preparation was cancelled", "AbortError");
  const error = new Error("PDF preparation was cancelled");
  error.name = "AbortError";
  return error;
}

function raceSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(cancelledError());
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(cancelledError()); };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      value => { signal.removeEventListener("abort", abort); resolve(value); },
      error => { signal.removeEventListener("abort", abort); reject(error); },
    );
  });
}

export async function preparePdf(markdown: string, documentPath: string | null, python = "embedded", options: PreparePdfOptions = {}) {
  let generation = 1;
  const ownerGeneration = generation;
  const { signal, noteId, trustedImageHosts, approvedImageUrls, loadedImageData } = options;
  const hasConsentPolicy =
    noteId !== undefined ||
    trustedImageHosts !== undefined ||
    approvedImageUrls !== undefined ||
    loadedImageData !== undefined;
  const trustedHosts = normalizeTrustedImageHosts(trustedImageHosts);
  const approvedUrls = normalizeApprovedImageUrls(approvedImageUrls);
  const invalidate = () => { generation++; };
  signal?.addEventListener("abort", invalidate, { once: true });
  const checkCurrent = () => {
    if (generation !== ownerGeneration || signal?.aborted) throw cancelledError();
  };
  const report = (progress: PdfPreparationProgress) => {
    checkCurrent();
    try { options.onProgress?.(progress); } catch { /* Progress reporting must not break an export. */ }
  };
  try {
  checkCurrent();
  report({ phase: "prepare", completed: 0, total: 1 });
  const processor = unified().use(remarkParse).use(remarkGfm, { singleTilde: false }).use(remarkMath).use(remarkObsidianMath).use(remarkStudySyntax).use(remarkStringify);
  const front = parseFrontmatter(markdown)?.raw || "";
  const normalized = normalizeCallouts(markdown);
  // parse() runs no transformers: lift raw <svg> markup and braced fences here.
  const tree = remarkBracedFences()(remarkSvgBlocks()(processor.parse(normalized), { value: normalized }));
  liftHtmlImages(tree);
  const work: Array<()=>Promise<void>> = []; const assets: Record<string, string> = {}; let count = 0;
  const referenceDefinitions=new Map<string,any>();
  visit(tree,"definition",(node:any)=>{if(!referenceDefinitions.has(node.identifier))referenceDefinitions.set(node.identifier,node);});
  const chartTitles = new Map<any,string>();
  const mermaidSources = new Map<string,Promise<string>>();
  const pythonCells=analyzeDocument(markdown).pythonCells;
  const pythonOrdinals=new Map<string,number>();
  const add = (url: string, name: string) => { assets[name] = url.slice(url.indexOf(",") + 1); return name; };
  visit(tree, (node: any) => {
    if (node.type === "code" && node.lang === "smd-steps") {
      work.push(async () => {
        const deck = parseStepDeck(node.value);
        if (!deck) throw new Error("Invalid step cards; fix the diagram sequence before exporting.");
        const steps = [];
        for (const step of deck.steps) {
          checkCurrent();
          let image: string | undefined;
          if (step.image || step.diagram || step.chart) {
            const source = step.image
              ? processor.stringify({type:"root",children:[{type:"paragraph",children:[{type:"image",url:step.image,alt:step.alt||step.label}]}]} as any)
              : "```" + (step.diagram ? "svg\n" + stepDiagramSvg(step.diagram) : "smd-chart\n" + step.chart) + "\n```";
            const prepared = await preparePdf(source, documentPath, python, { signal, noteId, trustedImageHosts, approvedImageUrls, loadedImageData });
            checkCurrent();
            const names = new Map<string,string>();
            for (const [name, body] of Object.entries(prepared.assets)) {
              const renamed = `step-${++count}-${name}`;
              assets[renamed] = body; names.set(name, renamed);
            }
            visit(processor.parse(prepared.content), "image", (picture:any) => { if (!image) image = names.get(picture.url); });
            if (!image) throw new Error(`Step cannot export its diagram: ${step.label}`);
          }
          let markdown: string|undefined;
          if(step.markdown){
            const prepared=await preparePdf(step.markdown,documentPath,python,{signal,noteId,trustedImageHosts,approvedImageUrls,loadedImageData});checkCurrent();
            markdown=prepared.content;
            for(const [name,body] of Object.entries(prepared.assets)){
              const renamed=`step-${++count}-${name}`;assets[renamed]=body;
              markdown=markdown.replaceAll(name,renamed);
            }
          }
          steps.push({label:step.label, ...(image?{image}:{}), ...(markdown?{markdown}:step.description?{description:step.description}:{})});
        }
        node.lang = "smd-step-grid"; delete node.meta;
        node.value = JSON.stringify({title:deck.title, steps});
      });
      return SKIP;
    }
    if(node.type==="imageReference"){
      const definition=referenceDefinitions.get(node.identifier);
      if(definition){node.type="image";node.url=definition.url;node.title=definition.title;delete node.identifier;delete node.label;delete node.referenceType;}
    }
    if(node.type==='code'&&['python','py'].includes(String(node.lang||'').toLowerCase()))node.lang=String(node.lang).toLowerCase();
    const exportCell = node.type === "code" && ["mermaid", "svg", "smd-chart", "smd-tree", "smd-diagram", "python", "py"].includes(node.lang);
    let pythonContext: {document:string;cell:string;interpreter:string}|undefined;
    if(node.type==='code'&&['python','py'].includes(String(node.lang||'').toLowerCase())){
      const source=String(node.value||''),ordinal=pythonOrdinals.get(source)||0;pythonOrdinals.set(source,ordinal+1);
      const analyzed=pythonCells.find(cell=>cell.source===source&&cell.ordinal===ordinal);
      if(documentPath)pythonContext={document:documentPath,cell:String(analyzed?.ordinal??ordinal),interpreter:python||'embedded'};
    }
    if (node.type === "image") {
      const fromHtmlImg = Boolean(node.data?.htmlImage);
      const rawUrl = String(node.url || "").trim();
      if (isMermaidSourcePath(rawUrl)) {
        if (/^https?:/i.test(rawUrl) || rawUrl.startsWith("//")) {
          if (!isRemoteImageApproved(rawUrl, trustedHosts, approvedUrls)) {
            const host = remoteImageHost(rawUrl);
            throw new Error(
              host
                ? `Remote image from ${host} requires explicit consent in the reader before exporting PDF.`
                : `Remote image ${rawUrl} requires explicit consent in the reader before exporting PDF.`,
            );
          }
          throw new Error(`Mermaid source must be a local .mmd or .mermaid file: ${rawUrl}`);
        }
        validateLocalMermaidSourcePath(rawUrl);
        if (!documentPath) {
          throw new Error(`Save your note before exporting relative Mermaid diagram ${rawUrl}.`);
        }
        work.push(async () => {
          checkCurrent();
          let pending = mermaidSources.get(rawUrl);
          if (!pending) {
            pending = loadLocalMermaidSource(documentPath, rawUrl);
            pending.catch(() => {});
            mermaidSources.set(rawUrl, pending);
          }
          const mermaidText = await pending;
          checkCurrent();
          if (!mermaidText.trim()) {
            throw new Error(`Mermaid source is empty: ${rawUrl}`);
          }
          let svg: string;
          try {
            svg = await renderMermaid(mermaidText, false, signal);
          } catch (error) {
            if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
            const detail = error instanceof Error ? error.message : String(error);
            throw new Error(`Invalid Mermaid diagram in ${rawUrl}: ${detail}`);
          }
          checkCurrent();
          const url = await data(new Blob([svg], { type: "image/svg+xml" }));
          checkCurrent();
          if (!node.alt) node.alt = "Diagram";
          node.url = add(url, `diagram-${++count}.svg`);
        });
      } else {
        let preloadedHtmlData: string | null = null;
        if (fromHtmlImg) {
          if (/^data:/i.test(rawUrl)) {
            if (!/^data:image\//i.test(rawUrl)) throw new Error("Unsupported PDF image type.");
          } else if (/^https?:\/\//i.test(rawUrl)) {
            preloadedHtmlData = loadedReaderImageData(rawUrl, {
              noteId,
              loadedImageData,
              trustedHosts,
              approvedUrls,
              enforcePolicy: hasConsentPolicy,
            });
            if (!preloadedHtmlData && !isRemoteImageApproved(rawUrl, trustedHosts, approvedUrls)) {
              const host = remoteImageHost(rawUrl);
              throw new Error(`Remote image from ${host || rawUrl} requires explicit consent in the reader before exporting PDF.`);
            }
          } else if (rawUrl.startsWith("//") || /^[a-z][a-z\d+.-]*:/i.test(rawUrl)) {
            throw new Error(`Remote image ${rawUrl} requires explicit consent in the reader before exporting PDF.`);
          }
        }
        work.push(async () => {
          checkCurrent();
          let url: string = preloadedHtmlData ?? node.url;
          if (!/^data:/i.test(url)) {
            if (fromHtmlImg ? /^https?:\/\//i.test(url) : /^https?:/i.test(url)) {
              if (fromHtmlImg && !isRemoteImageApproved(url, trustedHosts, approvedUrls)) {
                const host = remoteImageHost(url);
                throw new Error(`Remote image from ${host || url} requires explicit consent in the reader before exporting PDF.`);
              }
              const fetched = await invoke<{ body: string }>("fetch_resource", { url, image: true });
              checkCurrent();
              url = fetched.body;
            } else {
              if (fromHtmlImg && (url.startsWith("//") || /^[a-z][a-z\d+.-]*:/i.test(url))) {
                throw new Error(`Remote image ${url} requires explicit consent in the reader before exporting PDF.`);
              }
              if (!documentPath && !/^assets\/import-[\w-]+\./.test(url)) throw new Error(`Save your note before exporting relative image ${url}.`);
              url = await invoke<string>("load_asset", { documentPath: documentPath || "", source: url });
              checkCurrent();
            }
          }
          checkCurrent();
          if (!/^data:image\/(?:svg\+xml|png|jpeg);base64,/i.test(url)) { url = await rasterImage(url); checkCurrent(); }
          const extension = url.startsWith("data:image/svg") ? "svg" : url.startsWith("data:image/jpeg") ? "jpg" : "png";
          checkCurrent();
          node.url = add(url, `asset-${++count}.${extension}`);
        });
      }
    }
    if (exportCell) work.push(async () => {
      checkCurrent();
      if(node.lang==="smd-chart") {
        // Retired interactive 3D content remains editable and exportable as
        // source. Never turn it into executable Python or block the whole PDF.
        try {if(JSON.parse(node.value)?.mode==="surface3d"){node.lang="json";return;}} catch { /* Normal chart validation below reports malformed input. */ }
      }
      if (["mermaid", "smd-chart", "svg", "smd-tree", "smd-diagram"].includes(node.lang)) {
        let diagramAlt = "Diagram";
        const svg = node.lang === "svg" ? svgImage(node.value) : node.lang === "mermaid" ? await renderMermaid(node.value, false, signal) : (node.lang === "smd-tree" || node.lang === "smd-diagram") ? (() => {
          const diagram = node.lang === "smd-tree" ? parseBinaryTreeSource(node.value) : parseDiagramSource(node.value);
          if (!diagram) throw new Error("Invalid diagram; fix it before exporting.");
          diagramAlt = diagram.title || "Diagram";
          return svgImage(stepDiagramSvg(diagram));
        })() : (() => {
          const html = renderToStaticMarkup(<InteractiveChart source={node.value} />);
          const parsed = new DOMParser().parseFromString(html, "text/html");
          const warning = parsed.querySelector(".chart-warning, .render-error");
          if (warning) throw new Error(`Chart cannot export: ${warning.textContent}`);
          const graph = parsed.querySelector("svg");
          if (!graph) throw new Error(`Chart cannot export: ${parsed.body.textContent}`);
          graph.querySelectorAll(".chart-axis").forEach((axis) => axis.setAttribute("stroke", "#667085"));
          graph.querySelectorAll(".chart-grid").forEach((axis) => axis.setAttribute("stroke", "#d5dbe5"));
          graph.querySelectorAll("text:not(.chart-curve-label)").forEach((text) => { text.setAttribute("fill", "#20252d"); text.setAttribute("font-size", "14"); });
          graph.querySelectorAll(".graph-probe-marker").forEach((marker) => marker.remove());
          const title = parsed.querySelector("figcaption")?.textContent;
          if(title) chartTitles.set(node,title);
          // The interactive HTML legend/controls aren't inside the plot SVG.
          // Preserve their labels and selected values in the vector snapshot.
          const box=(graph.getAttribute("viewBox")||"").split(/\s+/).map(Number);
          if(box.length!==4 || !box.every(Number.isFinite)) throw new Error("Invalid chart viewport");
          let cursor=box[3]+20;
          const svgText=(text:string,x:number,y:number)=>{
            const element=parsed.createElementNS("http://www.w3.org/2000/svg","text");
            element.setAttribute("x",String(x));element.setAttribute("y",String(y));element.setAttribute("fill","#20252d");element.setAttribute("font-size","14");element.textContent=text;graph.append(element);
          };
          const wrap=(text:string)=>text.match(/.{1,85}(?:\s|$)|.{1,85}/g)||[text];
          for(const item of parsed.querySelectorAll(".chart-legend > span")) {
            const small=item.querySelector("small")?.textContent||"";
            const label=(item.textContent||"").replace(small,small?` (${small})`:"").replace(/^\s*●\s*/,"").trim();
            const color=(item.getAttribute("style")||item.querySelector("i")?.getAttribute("style"))?.match(/color:\s*(#[a-f\d]{6})/i)?.[1]||"#6750a4";
            const key=parsed.createElementNS("http://www.w3.org/2000/svg","line");
            for(const [name,value] of Object.entries({x1:"20",x2:"36",y1:String(cursor-5),y2:String(cursor-5),stroke:color,"stroke-width":"3"})) key.setAttribute(name,value);
            graph.append(key);
            for(const line of wrap(label)) {svgText(line.trim(),44,cursor);cursor+=18;}
          }
          const plotZoom=Number(parsed.querySelector(".interactive-chart")?.getAttribute("data-plot-zoom")||1);
          const selected=[...Array.from(parsed.querySelectorAll(".chart-controls label")).map(label=>{const head=label.querySelector(".chart-slider-head");return head?`${head.firstElementChild?.textContent||""} = ${head.querySelector("output")?.textContent||""}`:(label.textContent||"").trim();}),`Plot zoom: ${Math.round(plotZoom*100)}%`].join(" · ");
          if(selected) for(const line of wrap(selected)) {svgText(line.trim(),20,cursor+4);cursor+=18;}
          graph.setAttribute("viewBox",`${box[0]} ${box[1]} ${box[2]} ${cursor+10}`);
          return new XMLSerializer().serializeToString(graph);
        })();
        checkCurrent();
        const url = await data(new Blob([svg], { type: "image/svg+xml" }));
        checkCurrent();
        // A code block is a flow node. Replacing it with a bare inline image
        // makes remark-stringify treat the entire root as phrasing and join
        // headings, tables and callouts without their blank-line separators.
        node.type = "paragraph";
        node.children = [{ type: "image", url: add(url, `diagram-${++count}.svg`), alt: diagramAlt }];
        delete node.value; delete node.lang; delete node.meta;
      } else {
        const output = await pythonOutput(node.value,pythonContext);
        checkCurrent();
        if (output && !output.ok) throw new Error(`Python cell failed; fix it before exporting:\n${output.stderr}`);
        if (output?.ok) {
          // Keep source code and output together: export should not erase code
          // just because the cell also produced a figure.
          const source = node.value;
          node.type = "blockquote";
          const warning=output.provenance?.unsaved?'Execution output was not saved to the local output store.':!output.provenance?.verified?'Unverified saved output: its document and runtime provenance could not be confirmed.':null;
          node.children = [{ type: "code", lang: "python", value: source }, ...(warning?[{type:'paragraph',children:[{type:'emphasis',children:[{type:'text',value:warning}]}]}]:[]), ...(output.stdout ? [{ type: "code", lang: "text", value: output.stdout }] : []), ...output.images.map((url) => ({ type: "paragraph", children: [{ type: "image", alt: "Matplotlib figure", url: add(url, `plot-${++count}.${url.startsWith("data:image/svg") ? "svg" : "png"}`) }] }))];
          delete node.value; delete node.lang;
        }
        // Never auto-execute code while exporting. Unrun cells stay source code.
      }
    });
    // A completed Python cell inserts its original code as a child. Do not
    // revisit generated children and recursively prepare that same cell.
    if (exportCell) return SKIP;
  });
  checkCurrent();
  report({ phase: "prepare", completed: 1, total: 1 });
  report({ phase: "assets+diagrams", completed: 0, total: work.length });
  // Limit concurrent native/image requests and yield between heavy SVG jobs.
  // A long note must not queue every decode or monopolize the reader thread.
  let next=0, completed=0;
  const workers = Array.from({length:Math.min(4,work.length)},async()=>{
    while(next<work.length){
      checkCurrent();
      const task=work[next++];
      await task();
      checkCurrent();
      report({ phase: "assets+diagrams", completed: ++completed, total: work.length });
      await new Promise(resolve=>setTimeout(resolve,0));
      checkCurrent();
    }
  });
  await raceSignal(Promise.all(workers), signal);
  checkCurrent();
  // Insert title paragraphs after all asynchronous replacements settle; parser
  // offsets and concurrent diagram jobs never race over parent array indices.
  visit(tree,(parent:any)=>{
    if(Array.isArray(parent.children)) parent.children=parent.children.flatMap((child:any)=>chartTitles.has(child)?[{type:"paragraph",children:[{type:"strong",children:[{type:"text",value:chartTitles.get(child)}]}]},child]:[child]);
  });
  checkCurrent();
  // The marker is an extension, not a normal bracketed link. Stringify escapes
  // its opening bracket; restore only explicit blockquote callout prefixes.
  const body = processor.stringify(tree).replace(/^([\t ]*>[\t ]*)\\(\[![\w-]+\][+-]?)/gm, "$1$2");
  const content = front ? (body ? `${front}${front.endsWith("\n") ? "" : "\n"}\n${body}` : front) : body;
  checkCurrent();
  return { content, assets };
  } finally {
    generation++;
    signal?.removeEventListener("abort", invalidate);
  }
}

async function rasterImage(url: string): Promise<string> {
  if (!/^data:image\/(?:gif|webp|avif);base64,/i.test(url)) throw new Error("Unsupported PDF image type.");
  const image = new Image();
  await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error("This image could not be decoded for PDF export.")); image.src = url; });
  if (image.naturalWidth * image.naturalHeight > 20_000_000) throw new Error("This image exceeds the 20-megapixel PDF conversion limit.");
  const canvas = document.createElement("canvas"); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
  canvas.getContext("2d")!.drawImage(image, 0, 0);
  return canvas.toDataURL("image/png");
}
