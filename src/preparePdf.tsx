import { renderToStaticMarkup } from "react-dom/server";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { SKIP, visit } from "unist-util-visit";
import InteractiveChart from "./components/InteractiveChart";
import { normalizeCallouts } from "./components/MarkdownPreview";
import { invoke } from "./nativeBridge";
import { renderMermaid } from "./mermaidRenderer";
import { pythonOutput } from "./renderedOutputs";
import { svgImage } from "./svgImage";
import { remarkObsidianMath } from "./obsidianMath";

function data(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob); });
}
export async function preparePdf(markdown: string, documentPath: string | null) {
  const processor = unified().use(remarkParse).use(remarkGfm).use(remarkMath).use(remarkObsidianMath).use(remarkStringify);
  const tree = processor.parse(normalizeCallouts(markdown));
  const work: Array<()=>Promise<void>> = []; const assets: Record<string, string> = {}; let count = 0;
  const chartTitles = new Map<any,string>();
  const add = (url: string, name: string) => { assets[name] = url.slice(url.indexOf(",") + 1); return name; };
  visit(tree, (node: any) => {
    const exportCell = node.type === "code" && ["mermaid", "svg", "smd-chart", "python", "py"].includes(node.lang);
    if (node.type === "image") work.push(async () => {
      let url: string = node.url;
      if (!/^data:/i.test(url)) {
        if (/^https?:/i.test(url)) url = (await invoke<{ body: string }>("fetch_resource", { url, image: true })).body;
        else {
          if (!documentPath && !/^assets\/import-[\w-]+\./.test(url)) throw new Error(`Save your note before exporting relative image ${url}.`);
          url = await invoke<string>("load_asset", { documentPath: documentPath || "", source: url });
        }
      }
      if (!/^data:image\/(?:svg\+xml|png|jpeg);base64,/i.test(url)) url = await rasterImage(url);
      const extension = url.startsWith("data:image/svg") ? "svg" : url.startsWith("data:image/jpeg") ? "jpg" : "png";
      node.url = add(url, `asset-${++count}.${extension}`);
    });
    if (exportCell) work.push(async () => {
      if(node.lang==="smd-chart") {
        // Retired interactive 3D content remains editable and exportable as
        // source. Never turn it into executable Python or block the whole PDF.
        try {if(JSON.parse(node.value)?.mode==="surface3d"){node.lang="json";return;}} catch { /* Normal chart validation below reports malformed input. */ }
      }
      if (["mermaid", "smd-chart", "svg"].includes(node.lang)) {
        const svg = node.lang === "svg" ? svgImage(node.value) : node.lang === "mermaid" ? await renderMermaid(node.value) : (() => {
          const html = renderToStaticMarkup(<InteractiveChart source={node.value} />);
          const parsed = new DOMParser().parseFromString(html, "text/html");
          const warning = parsed.querySelector(".chart-warning, .render-error");
          if (warning) throw new Error(`Chart cannot export: ${warning.textContent}`);
          const graph = parsed.querySelector("svg");
          if (!graph) throw new Error(`Chart cannot export: ${parsed.body.textContent}`);
          graph.setAttribute("xmlns", "http://www.w3.org/2000/svg");
          graph.querySelectorAll(".chart-axis").forEach((axis) => axis.setAttribute("stroke", "#667085"));
          graph.querySelectorAll(".chart-grid").forEach((axis) => axis.setAttribute("stroke", "#d5dbe5"));
          graph.querySelectorAll("text").forEach((text) => { text.setAttribute("fill", "#20252d"); text.setAttribute("font-size", "14"); });
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
            const label=(item.textContent||"").replace(/^\s*●\s*/,"").trim();
            const color=item.querySelector("i")?.getAttribute("style")?.match(/color:\s*(#[a-f\d]{6})/i)?.[1]||"#6750a4";
            const key=parsed.createElementNS("http://www.w3.org/2000/svg","line");
            for(const [name,value] of Object.entries({x1:"20",x2:"36",y1:String(cursor-5),y2:String(cursor-5),stroke:color,"stroke-width":"3"})) key.setAttribute(name,value);
            graph.append(key);
            for(const line of wrap(label)) {svgText(line.trim(),44,cursor);cursor+=18;}
          }
          const plotZoom=Number(parsed.querySelector(".interactive-chart")?.getAttribute("data-plot-zoom")||1);
          const selected=[...Array.from(parsed.querySelectorAll(".chart-controls label")).map(label=>(label.textContent||"").trim()),`Plot zoom: ${Math.round(plotZoom*100)}%`].join(" · ");
          if(selected) for(const line of wrap(selected)) {svgText(line.trim(),20,cursor+4);cursor+=18;}
          graph.setAttribute("viewBox",`${box[0]} ${box[1]} ${box[2]} ${cursor+10}`);
          return new XMLSerializer().serializeToString(graph);
        })();
        const url = await data(new Blob([svg], { type: "image/svg+xml" }));
        // A code block is a flow node. Replacing it with a bare inline image
        // makes remark-stringify treat the entire root as phrasing and join
        // headings, tables and callouts without their blank-line separators.
        node.type = "paragraph";
        node.children = [{ type: "image", url: add(url, `diagram-${++count}.svg`), alt: "Diagram" }];
        delete node.value; delete node.lang; delete node.meta;
      } else {
        const output = await pythonOutput(node.value);
        if (output && !output.ok) throw new Error(`Python cell failed; fix it before exporting:\n${output.stderr}`);
        if (output?.ok) {
          // Keep source code and output together: export should not erase code
          // just because the cell also produced a figure.
          const source = node.value;
          node.type = "blockquote";
          node.children = [{ type: "code", lang: "python", value: source }, ...(output.stdout ? [{ type: "code", lang: "text", value: output.stdout }] : []), ...output.images.map((url) => ({ type: "paragraph", children: [{ type: "image", alt: "Matplotlib figure", url: add(url, `plot-${++count}.${url.startsWith("data:image/svg") ? "svg" : "png"}`) }] }))];
          delete node.value; delete node.lang;
        }
        // Never auto-execute code while exporting. Unrun cells stay source code.
      }
    });
    // A completed Python cell inserts its original code as a child. Do not
    // revisit generated children and recursively prepare that same cell.
    if (exportCell) return SKIP;
  });
  // Limit concurrent native/image requests and yield between heavy SVG jobs.
  // A long note must not queue every decode or monopolize the reader thread.
  let next=0;
  await Promise.all(Array.from({length:Math.min(4,work.length)},async()=>{
    while(next<work.length){await work[next++]();await new Promise(resolve=>setTimeout(resolve,0));}
  }));
  // Insert title paragraphs after all asynchronous replacements settle; parser
  // offsets and concurrent diagram jobs never race over parent array indices.
  visit(tree,(parent:any)=>{
    if(Array.isArray(parent.children)) parent.children=parent.children.flatMap((child:any)=>chartTitles.has(child)?[{type:"paragraph",children:[{type:"strong",children:[{type:"text",value:chartTitles.get(child)}]}]},child]:[child]);
  });
  // The marker is an extension, not a normal bracketed link. Stringify escapes
  // its opening bracket; restore only explicit blockquote callout prefixes.
  const content = processor.stringify(tree).replace(/^([\t ]*>[\t ]*)\\(\[![\w-]+\][+-]?)/gm, "$1$2");
  return { content, assets };
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
