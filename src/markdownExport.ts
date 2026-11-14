/** Prepare a portable Markdown copy without changing the note in the editor. */
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { visit } from "unist-util-visit";
import { invoke } from "./nativeBridge";
import { remarkObsidianMath } from "./obsidianMath";

type ImageRef = { source: string; start: number; end: number; image: boolean; definition?: { start: number; end: number } };
const APP_GENERATED = /^assets\/(?:import|image)-[a-z0-9-]+\.(?:png|jpe?g|svg|gif|webp|avif)$/i;
const MIME_EXT: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/svg+xml": "svg", "image/gif": "gif",
  "image/webp": "webp", "image/avif": "avif",
};

function refs(markdown: string): ImageRef[] {
  const tree = unified().use(remarkParse).use(remarkGfm).use(remarkMath).use(remarkObsidianMath).parse(markdown);
  const definitions = new Map<string, any>();
  const result: ImageRef[] = [];
  visit(tree, "definition", (node: any) => { definitions.set(node.identifier, node); });
  visit(tree, (node: any) => {
    if (!node.position) return;
    if (node.type === "image") result.push({ source: node.url, start: node.position.start.offset, end: node.position.end.offset, image: true });
    if (node.type === "imageReference") {
      const definition = definitions.get(node.identifier);
      if (definition?.position) {
        result.push({ source: definition.url, start: node.position.start.offset, end: node.position.end.offset, image: true,
          definition: { start: definition.position.start.offset, end: definition.position.end.offset } });
      }
    }
    if (node.type === "link" && /\.(?:svg|mmd|mermaid)(?:[?#]|$)/i.test(node.url))
      result.push({ source: node.url, start: node.position.start.offset, end: node.position.end.offset, image: false });
    if (node.type === "linkReference") {
      const definition = definitions.get(node.identifier);
      if (definition?.position && /\.(?:svg|mmd|mermaid)(?:[?#]|$)/i.test(definition.url))
        result.push({ source: definition.url, start: node.position.start.offset, end: node.position.end.offset, image: false,
          definition: { start: definition.position.start.offset, end: definition.position.end.offset } });
    }
    if (node.type === "text") {
      const raw = markdown.slice(node.position.start.offset, node.position.end.offset);
      for (const match of raw.matchAll(/!\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g)) {
        result.push({ source: encodeURI(match[1]), start: node.position.start.offset + match.index!, end: node.position.start.offset + match.index! + match[0].length, image: true });
      }
    }
  });
  return result.sort((a, b) => a.start - b.start);
}

function decodeDataUrl(value: string): { mime: string; dataUrl: string; text?: string } | null {
  const match = /^data:(image\/(?:png|jpeg|svg\+xml|gif|webp|avif));base64,([A-Za-z0-9+/=\r\n]+)$/i.exec(value);
  if (!match) return null;
  const mime = match[1].toLowerCase();
  const dataUrl = `data:${mime};base64,${match[2].replace(/[\r\n]/g, "")}`;
  let text: string | undefined;
  if (mime === "image/svg+xml") {
    try {
      const binary = atob(match[2]);
      text = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, char => char.charCodeAt(0)));
    } catch { return null; }
  } else {
    try { atob(match[2]); } catch { return null; }
  }
  return { mime, dataUrl, text };
}

function cleanRelativePath(source: string): string | null {
  if (!source || source.startsWith("/") || source.startsWith("\\") || /^[a-z][a-z\d+.-]*:/i.test(source) || source.startsWith("//")) return null;
  let decoded: string;
  try { decoded = decodeURIComponent(source.split(/[?#]/, 1)[0]); } catch { return null; }
  if (decoded.includes("\\") || decoded.includes("\0")) return null;
  const parts = decoded.split("/").filter(part => part && part !== ".");
  if (!parts.length || parts.some(part => part === ".." || /[<>:"|?*\x00-\x1f]/.test(part)
      || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) return null;
  return parts.join("/");
}

function sourceFence(source: string, language: "svg" | "mermaid"): string {
  const runs = [...source.matchAll(/`+/g)].map(match => match[0].length);
  const fence = "`".repeat(Math.max(3, ...runs.map(length => length + 1)));
  return `${fence}${language}\n${source.replace(/\s+$/, "")}\n${fence}`;
}
function sourceFenceBlock(source: string, language: "svg" | "mermaid"): string {
  return `\n\n${sourceFence(source, language)}\n\n`;
}

/**
 * Resolve only already-local/embedded references. The returned assets are
 * written beside the exported Markdown by the native host; remote URLs remain
 * untouched and are never fetched as a side effect of export.
 */
export async function prepareMarkdownExport(markdown: string, documentPath: string | null, options: {compatible?:boolean} = {}) {
  if(options.compatible){
    const {compatibleMarkdown}=await import('./compatibleMarkdown');
    markdown=await compatibleMarkdown(markdown,documentPath);
  }
  const assets: Record<string, string> = {};
  const edits: Array<{ start: number; end: number; value: string }> = [];
  const shared = new Map<string, Promise<{ mime: string; dataUrl: string; text?: string } | { mermaid: string }>>();
  const references = refs(markdown);
  const definitionsToRemove = new Map<number, { start: number; end: number }>();
  const reservedPaths = new Set(references.flatMap(({ source }) => {
    const path = cleanRelativePath(source);
    return path && !APP_GENERATED.test(path) && (!/\.(?:svg|mmd|mermaid)$/i.test(path)||options.compatible&&/\.svg$/i.test(path)) ? [path] : [];
  }));
  const generatedPaths = new Map<string, string>();
  const usedPaths = new Set(reservedPaths);
  let generatedIndex = 0;
  const allocateGeneratedPath = (source: string, extension: string) => {
    const existing = generatedPaths.get(source);
    if (existing) return existing;
    let candidate: string;
    do { candidate = `image${++generatedIndex}.${extension}`; }
    while (usedPaths.has(candidate));
    usedPaths.add(candidate);
    generatedPaths.set(source, candidate);
    return candidate;
  };
  for (const ref of references) {
    if (/^https?:|^\/\//i.test(ref.source)) continue;
    if (!shared.has(ref.source)) shared.set(ref.source, (async () => {
      if (/\.(?:mmd|mermaid)(?:[?#]|$)/i.test(ref.source)) {
        if (ref.source.startsWith("data:")) throw Error("Mermaid source must be a local .mmd or .mermaid file");
        const relative = cleanRelativePath(ref.source);
        if (!relative) throw Error(`Cannot safely resolve Mermaid source ${ref.source}`);
        const loaded = await invoke<string | { text: string }>("load_text_asset", { documentPath: documentPath || "", source: ref.source });
        const text = typeof loaded === "string" ? loaded : loaded?.text;
        if (typeof text !== "string" || text.length > 2_000_000) throw Error(`Mermaid source is unavailable or too large: ${ref.source}`);
        return { mermaid: text };
      }
      if (ref.source.startsWith("data:")) {
        const decoded = decodeDataUrl(ref.source);
        if (!decoded) throw Error("Markdown export contains an unsupported or invalid embedded image");
        return decoded;
      }
      const path = cleanRelativePath(ref.source);
      if (!path) throw Error(`Cannot safely resolve image ${ref.source}`);
      const value = await invoke<string>("load_asset", { documentPath: documentPath || "", source: ref.source });
      const decoded = decodeDataUrl(value);
      if (!decoded) throw Error(`Image is unavailable or unsupported: ${ref.source}`);
      return decoded;
    })());
    const resolved = await shared.get(ref.source)!;
    if ("mermaid" in resolved) {
      edits.push({ start: ref.start, end: ref.end, value: sourceFenceBlock(resolved.mermaid, "mermaid") });
      if (ref.definition) definitionsToRemove.set(ref.definition.start, ref.definition);
      continue;
    }
    if (!MIME_EXT[resolved.mime]) throw Error(`Image format is not supported for Markdown export: ${ref.source}`);
    if (!options.compatible && resolved.mime === "image/svg+xml" && resolved.text !== undefined) {
      edits.push({ start: ref.start, end: ref.end, value: sourceFenceBlock(resolved.text, "svg") });
      if (ref.definition) definitionsToRemove.set(ref.definition.start, ref.definition);
      continue;
    }
    const relative = cleanRelativePath(ref.source);
    const generatedKey = relative ?? ref.source;
    const path = ref.source.startsWith("data:") || !relative || APP_GENERATED.test(relative)
      ? allocateGeneratedPath(generatedKey, MIME_EXT[resolved.mime]) : relative;
    if (assets[path] && assets[path] !== resolved.dataUrl) throw Error(`Markdown asset path collision: ${path}`);
    if (!assets[path]) assets[path] = resolved.dataUrl;
    if ((ref.image && path !== ref.source) || options.compatible && !ref.image && resolved.mime === "image/svg+xml") {
      const label = ref.source.startsWith("data:") ? "Image" : ref.source.split("/").pop() || "Image";
      const altMatch = markdown.slice(ref.start, ref.end).match(/^!\[([^\]]*)\]/);
      const alt = (altMatch?.[1] || label).replace(/[\[\]\\]/g, "\\$&").replace(/[\r\n]+/g, " ");
      edits.push({ start: ref.start, end: ref.end, value: `![${alt}](<${path}>)` });
    }
  }
  for (const definition of definitionsToRemove.values()) {
    const lineStart = markdown.lastIndexOf("\n", definition.start - 1) + 1;
    const lineEnd = markdown.indexOf("\n", definition.end);
    edits.push({ start: lineStart, end: lineEnd < 0 ? markdown.length : lineEnd + 1, value: "" });
  }
  let content = markdown;
  for (const edit of edits.sort((a, b) => b.start - a.start)) content = content.slice(0, edit.start) + edit.value + content.slice(edit.end);
  return { content, assets };
}
