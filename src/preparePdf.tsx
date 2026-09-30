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
import { pythonResults } from "./renderedOutputs";

function data(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob); });
}
export async function preparePdf(markdown: string, documentPath: string | null) {
  const processor = unified().use(remarkParse).use(remarkGfm).use(remarkMath).use(remarkStringify);
  const tree = processor.parse(normalizeCallouts(markdown));
  const work: Promise<void>[] = []; const assets: Record<string, string> = {}; let count = 0;
  const add = (url: string, name: string) => { assets[name] = url.slice(url.indexOf(",") + 1); return name; };
  visit(tree, (node: any) => {
    const exportCell = node.type === "code" && ["mermaid", "smd-chart", "python", "py"].includes(node.lang);
    if (node.type === "image") work.push((async () => {
      let url: string = node.url;
      if (!/^data:/i.test(url)) {
        if (/^https?:/i.test(url)) throw new Error(`Remote image ${url}: download it into the note's folder before exporting offline.`);
        if (!documentPath) throw new Error(`Save your note before exporting relative image ${url}.`);
        url = await invoke<string>("load_asset", { documentPath, source: url });
      }
      const extension = url.startsWith("data:image/svg") ? "svg" : url.startsWith("data:image/jpeg") ? "jpg" : "png";
      node.url = add(url, `asset-${++count}.${extension}`);
    })());
    if (exportCell) work.push((async () => {
      if (node.lang === "mermaid" || node.lang === "smd-chart") {
        const svg = node.lang === "mermaid" ? await renderMermaid(node.value) : (() => {
          const html = renderToStaticMarkup(<InteractiveChart source={node.value} />);
          const parsed = new DOMParser().parseFromString(html, "text/html");
          const warning = parsed.querySelector(".chart-warning, .render-error");
          if (warning) throw new Error(`Chart cannot export: ${warning.textContent}`);
          const graph = parsed.querySelector("svg");
          if (!graph) throw new Error(`Chart cannot export: ${parsed.body.textContent}`);
          graph.setAttribute("xmlns", "http://www.w3.org/2000/svg");
          graph.querySelectorAll(".chart-axis").forEach((axis) => axis.setAttribute("stroke", "#667085"));
          graph.querySelectorAll("text").forEach((text) => { text.setAttribute("fill", "#20252d"); text.setAttribute("font-size", "14"); });
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
        const output = pythonResults.get(node.value);
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
    })());
    // A completed Python cell inserts its original code as a child. Do not
    // revisit generated children and recursively prepare that same cell.
    if (exportCell) return SKIP;
  });
  await Promise.all(work);
  // The marker is an extension, not a normal bracketed link. Stringify escapes
  // its opening bracket; restore only explicit blockquote callout prefixes.
  const content = processor.stringify(tree).replace(/^([\t ]*>[\t ]*)\\(\[![\w-]+\][+-]?)/gm, "$1$2");
  return { content, assets };
}
