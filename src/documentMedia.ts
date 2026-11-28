import { visit } from "unist-util-visit";
import { invoke } from "./nativeBridge";
import { parseMaskedMarkdown } from "./markdownExportParser";
import {
  isRemoteImageApproved,
  isRemoteOrExplicitScheme,
  loadedReaderImageData,
  normalizeApprovedImageUrls,
  normalizeTrustedImageHosts,
  type RemoteImageConsentPolicy,
} from "./remoteImageConsent";

export interface ImportedImage { source: string; alt: string }
export interface LinkDetails { url: string; title: string; thumbnail?: string }
export const attachmentSource = (source: string) => /^assets\/(?:import|image)-[a-zA-Z0-9-]+\.(?:png|jpg|jpeg|svg|gif|webp|avif)$/.test(source) && source.length <= 7 + 150;
const compatPortableAssetSource = (source: string, ext: string) => {
  if (!source.startsWith("assets/")) return false;
  const name = source.slice(7);
  if (!name || name.length > 159 || name === "." || name === ".." || !/^[A-Za-z0-9._-]+$/.test(name)) return false;
  const actualExt = name.split(".").pop()?.toLowerCase();
  return ext === "jpg" ? actualExt === "jpg" || actualExt === "jpeg" : actualExt === ext;
};
export const markdownLabel = (value: string) => value.replace(/[\\[\]]/g, "\\$&").replace(/[\r\n]+/g, " ");
export const imageMarkdown = (image: ImportedImage) => `![${markdownLabel(image.alt)}](<${image.source.replace(/>/g, "%3E")}>)`;
export interface ImageRange { from: number; to: number; source: string }
export function imageRanges(markdown: string): ImageRange[] {
  const { tree } = parseMaskedMarkdown(markdown);
  const definitions = new Map<string, string>(); const result: ImageRange[] = [];
  visit(tree, "definition", (node: any) => { if (!definitions.has(node.identifier)) definitions.set(node.identifier, node.url); });
  visit(tree, (node: any) => {
    const source = node.type === "image" ? node.url : node.type === "imageReference" ? definitions.get(node.identifier) : undefined;
    if (source && node.position) result.push({ source, from: node.position.start.offset, to: node.position.end.offset });
    if (node.type === "text" && node.position) {
      const raw = markdown.slice(node.position.start.offset, node.position.end.offset);
      for (const match of raw.matchAll(/!\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g)) result.push({ source: encodeURI(match[1]), from: node.position.start.offset + match.index!, to: node.position.start.offset + match.index! + match[0].length });
    }
  });
  return result.sort((a, b) => a.from - b.from);
}
/** Malformed pasted links must never throw out of a UI callback. */
export function safeParseUrl(raw: string): URL | null { try { return new URL(raw); } catch { return null; } }
export function safeHostname(raw: string, fallback = raw): string { return safeParseUrl(raw)?.hostname || fallback; }
export function youtubeUrl(raw: string): string | null {
  try { const url = new URL(raw); let id = "";
    if (url.hostname === "youtu.be") id = url.pathname.slice(1).split('/')[0];
    if (["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"].includes(url.hostname)) id = url.searchParams.get("v") || url.pathname.match(/^\/(?:shorts|embed|live)\/([^/]+)/)?.[1] || "";
    return /^[\w-]{11}$/.test(id) ? `https://www.youtube.com/watch?v=${id}` : null;
  } catch { return null; }
}
export async function linkDetails(raw: string): Promise<LinkDetails> {
  const url = safeParseUrl(raw); if (!url || !["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("Use a public web link without login details.");
  const video = youtubeUrl(raw);
  if (video) {
    const resource = await invoke<{ body: string }>("fetch_resource", { url: `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(video)}`, image: false });
    const metadata = JSON.parse(resource.body);
    return { url: url.href, title: String(metadata.title || "YouTube video").slice(0, 300), thumbnail: /^https:\/\/(?:i|img)\.ytimg\.com\//.test(metadata.thumbnail_url || "") ? metadata.thumbnail_url : undefined };
  }
  const resource = await invoke<{ body: string }>("fetch_resource", { url: raw, image: false });
  const html = new DOMParser().parseFromString(resource.body, "text/html");
  return { url: url.href, title: (html.querySelector('meta[property="og:title"]')?.getAttribute("content") || html.querySelector("title")?.textContent || url.hostname).trim().slice(0, 300) };
}
export async function importImageUrl(url: string): Promise<ImportedImage> {
  const result = await invoke<{ body: string }>("fetch_resource", { url, image: true });
  const name = safeParseUrl(url)?.pathname.split('/').pop() || "Image";
  return (await invoke<ImportedImage[]>("import_images", { images: [{ name, data: result.body }] }))[0];
}
export function readImage(file: File): Promise<string> {
  const mimeFromExt =
    /\.png$/i.test(file.name) ? "image/png" :
    /\.jpe?g$/i.test(file.name) ? "image/jpeg" :
    /\.gif$/i.test(file.name) ? "image/gif" :
    /\.webp$/i.test(file.name) ? "image/webp" :
    /\.avif$/i.test(file.name) ? "image/avif" :
    /\.svg$/i.test(file.name) ? "image/svg+xml" : "";
  const normalizedType = file.type.split(";")[0].trim().toLowerCase();
  const effectiveType = /^image\/(png|jpeg|gif|webp|avif|svg\+xml)$/.test(normalizedType)
    ? normalizedType
    : (!normalizedType || normalizedType === "application/octet-stream" || ((normalizedType === "text/xml" || normalizedType === "application/xml") && mimeFromExt === "image/svg+xml"))
      ? mimeFromExt
      : "";
  if (!effectiveType) return Promise.reject(new Error(`Unsupported image: ${file.name}`));
  if (file.size > 25_000_000) return Promise.reject(new Error("Images must be smaller than 25 MB."));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^;]+/, `data:${effectiveType}`));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file.type === effectiveType ? file : new Blob([file], { type: effectiveType }));
  });
}
export async function importImageFiles(files: File[]): Promise<ImportedImage[]> {
  if (files.length > 32 || files.reduce((sum, file) => sum + file.size, 0) > 75_000_000) throw new Error("Insert at most 32 images / 75 MB at a time.");
  const images = await Promise.all(files.map(async (file) => ({ name: file.name, data: await readImage(file) })));
  return invoke<ImportedImage[]>("import_images", { images });
}
const isValidLocalPortableAssetKey = (source: string) => {
  if (!source.startsWith("assets/")) return false;
  const name = source.slice(7);
  if (!name || name.length > 159 || name === "." || name === ".." || !/^[A-Za-z0-9._-]+$/.test(name)) return false;
  return /\.(?:png|jpe?g|svg|gif|webp|avif)$/i.test(name);
};
interface HtmlImgSrcSpan {
  source: string;
  valueStart: number;
  valueEnd: number;
  quoted: boolean;
}
function decodeBasicHtmlEntities(raw: string): string {
  return raw.replace(/&(?:amp|lt|gt|quot|apos|#39|#x27);/gi, (entity) => {
    switch (entity.toLowerCase()) {
      case "&amp;": return "&";
      case "&lt;": return "<";
      case "&gt;": return ">";
      case "&quot;": return '"';
      case "&apos;":
      case "&#39;":
      case "&#x27;": return "'";
      default: return entity;
    }
  });
}
function scanHtmlImgSrcSpans(raw: string, baseOffset: number): HtmlImgSrcSpan[] {
  const spans: HtmlImgSrcSpan[] = [];
  let pos = 0;
  while (pos < raw.length) {
    if (raw.startsWith("<!--", pos)) {
      const endComment = raw.indexOf("-->", pos + 4);
      if (endComment < 0) break;
      pos = endComment + 3;
      continue;
    }
    const lt = raw.indexOf("<", pos);
    if (lt < 0) break;
    let cursor = lt + 1;
    if (!/^img(?=[\s/>])/i.test(raw.slice(cursor))) {
      pos = lt + 1;
      continue;
    }
    cursor += 3;
    while (cursor < raw.length) {
      while (cursor < raw.length && /\s/.test(raw[cursor])) cursor++;
      if (cursor >= raw.length) break;
      if (raw[cursor] === ">") { cursor++; break; }
      if (raw[cursor] === "/" && raw[cursor + 1] === ">") { cursor += 2; break; }
      const attrStart = cursor;
      while (cursor < raw.length && !/[\s"'=<>`/]/.test(raw[cursor])) cursor++;
      if (cursor === attrStart) { cursor++; continue; }
      const attrName = raw.slice(attrStart, cursor).toLowerCase();
      while (cursor < raw.length && /\s/.test(raw[cursor])) cursor++;
      if (raw[cursor] !== "=") continue;
      cursor++;
      while (cursor < raw.length && /\s/.test(raw[cursor])) cursor++;
      if (cursor >= raw.length) break;
      let rawVal = "";
      let valueStart = cursor;
      let valueEnd = cursor;
      let quoted = false;
      const ch = raw[cursor];
      if (ch === '"' || ch === "'") {
        const closeQuote = raw.indexOf(ch, cursor + 1);
        if (closeQuote < 0) { cursor = raw.length; break; }
        quoted = true;
        valueStart = cursor + 1;
        valueEnd = closeQuote;
        rawVal = raw.slice(valueStart, valueEnd);
        cursor = closeQuote + 1;
      } else {
        valueStart = cursor;
        while (cursor < raw.length && !/[\s"'=<>`]/.test(raw[cursor]) && !(raw[cursor] === "/" && raw[cursor + 1] === ">")) cursor++;
        valueEnd = cursor;
        rawVal = raw.slice(valueStart, valueEnd);
      }
      if (attrName === "src") {
        const cleaned = decodeBasicHtmlEntities(rawVal).replace(/[\t\r\n]+/g, "").trim();
        if (cleaned) {
          spans.push({
            source: cleaned,
            valueStart: baseOffset + valueStart,
            valueEnd: baseOffset + valueEnd,
            quoted,
          });
        }
      }
    }
    pos = cursor;
  }
  return spans;
}
// FMD keeps interactive source blocks intact. Only image URLs are rewritten;
// their bytes live in the envelope, never in the displayed Markdown editor.
export type PrepareFmdOptions = RemoteImageConsentPolicy & {
  portable?: boolean;
  localAssets?: Iterable<string>;
  omitLocalAssets?: boolean;
};

interface NormalizedFmdConsent {
  noteId?: string;
  trustedHosts: Set<string>;
  approvedUrls: Set<string>;
  loadedImageData?: ReadonlyMap<string, string> | Record<string, string>;
}

async function prepareFmdInternal(
  markdown: string,
  documentPath: string | null,
  portableDoc: boolean,
  consent: NormalizedFmdConsent,
  localAssetSet: ReadonlySet<string>,
  omitLocalAssets: boolean,
  shared: Map<string, Promise<string | null>>,
  assets: Record<string, string>,
): Promise<string> {
  const { tree } = parseMaskedMarkdown(markdown);
  const work: Promise<void>[] = [];
  const edits: Array<{ start: number; end: number; value: string }> = [];
  const definitions = new Map<string, any>(); const usedDefinitions = new Set<string>();
  visit(tree, "definition", (node: any) => { if (!definitions.has(node.identifier)) definitions.set(node.identifier, node); });
  const collect = (source: string, replace: (name: string) => void) => {
    if (!shared.has(source)) shared.set(source, (async (): Promise<string | null> => {
      if (omitLocalAssets && localAssetSet.has(source)) {
        return source;
      }
      let data: string;
      if (/^data:/i.test(source)) {
        if (!/^data:image\//i.test(source)) throw new Error(`Unsupported image ${source}`);
        data = source;
      } else if (isRemoteOrExplicitScheme(source)) {
        const preloaded = loadedReaderImageData(source, {
          noteId: consent.noteId,
          loadedImageData: consent.loadedImageData,
          trustedHosts: consent.trustedHosts,
          approvedUrls: consent.approvedUrls,
          enforcePolicy: true,
        });
        if (preloaded) {
          data = preloaded;
        } else if (isRemoteImageApproved(source, consent.trustedHosts, consent.approvedUrls)) {
          data = (await invoke<{ body: string }>("fetch_resource", { url: source, image: true })).body;
        } else {
          return null;
        }
      } else {
        data = await invoke<string>("load_asset", { documentPath: documentPath || "", source });
      }
      const type = data.match(/^data:image\/([^;]+);base64,/i)?.[1]?.toLowerCase();
      if (!type) throw new Error(`Unsupported image ${source}`);
      const ext = type === "svg+xml" ? "svg" : type === "jpeg" ? "jpg" : type;
      const name = attachmentSource(source) || ((portableDoc || localAssetSet.has(source)) && compatPortableAssetSource(source, ext)) ? source : `assets/image-${crypto.randomUUID()}.${ext}`;
      assets[name] = data;
      return name;
    })());
    work.push(shared.get(source)!.then((name) => { if (name !== null) replace(name); }));
  };
  visit(tree, (node: any) => {
    if (node.type === "image") collect(node.url, (name) => {
      if (omitLocalAssets && localAssetSet.has(node.url) && name === node.url) return;
      edits.push({ start: node.position.start.offset, end: node.position.end.offset, value: `![${markdownLabel(node.alt || "")}](<${name}>${node.title ? ` "${node.title.replace(/["\\]/g, "\\$&")}"` : ""})` });
    });
    if (node.type === "imageReference" && !usedDefinitions.has(node.identifier)) {
      const definition = definitions.get(node.identifier); if (!definition) return;
      usedDefinitions.add(node.identifier);
      collect(definition.url, (name) => {
        if (omitLocalAssets && localAssetSet.has(definition.url) && name === definition.url) return;
        edits.push({ start: definition.position.start.offset, end: definition.position.end.offset, value: `[${definition.label || definition.identifier}]: <${name}>${definition.title ? ` "${definition.title.replace(/["\\]/g, "\\$&")}"` : ""}` });
      });
    }
    if (node.type === "html" && node.position && typeof node.value === "string" && /<img(?=[\s/>])/i.test(node.value)) {
      const raw = markdown.slice(node.position.start.offset, node.position.end.offset);
      for (const span of scanHtmlImgSrcSpans(raw, node.position.start.offset)) {
        collect(span.source, (name) => {
          if (omitLocalAssets && localAssetSet.has(span.source) && name === span.source) return;
          edits.push({ start: span.valueStart, end: span.valueEnd, value: span.quoted ? name : `"${name}"` });
        });
      }
    }
    // Wiki-image compatibility only in actual prose, never inside fenced or inline code.
    if ((node.type === "paragraph" || node.type === "heading" || node.type === "tableCell") && node.position) {
      const blockStart = node.position.start.offset;
      const blockEnd = node.position.end.offset;
      const chars = markdown.slice(blockStart, blockEnd).split("");
      visit(node, (child: any) => {
        if (
          (child.type === "inlineCode" ||
            child.type === "inlineMath" ||
            child.type === "math" ||
            child.type === "code" ||
            child.type === "image" ||
            child.type === "imageReference" ||
            child.type === "html") &&
          child.position
        ) {
          const from = Math.max(0, child.position.start.offset - blockStart);
          const to = Math.min(chars.length, child.position.end.offset - blockStart);
          for (let i = from; i < to; i++) chars[i] = " ";
        }
      });
      const masked = chars.join("");
      for (const match of masked.matchAll(/!\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g)) {
        const rawTarget = match[1].trim();
        const encodedTarget = /^[a-z][a-z\d+.-]*:/i.test(rawTarget) || rawTarget.startsWith("//") ? rawTarget : encodeURI(rawTarget);
        collect(encodedTarget, (name) => {
          edits.push({ start: blockStart + match.index!, end: blockStart + match.index! + match[0].length, value: imageMarkdown({ source: name, alt: match[2] || match[1] }) });
        });
      }
    }
  });
  // Fenced smd-steps JSON is deliberately opaque to the Markdown AST. Collect
  // its image references separately, and rewrite *inside* the JSON while
  // preserving the interactive deck rather than flattening it into Markdown.
  visit(tree, "code", (node: any) => {
    if (node.lang !== "smd-steps" || !node.position) return;
    const raw = markdown.slice(node.position.start.offset, node.position.end.offset);
    const opening = /^(`{3,}|~{3,})[^\n]*\n/.exec(raw);
    if (!opening) return;
    const payloadStart = node.position.start.offset + opening[0].length;
    const payloadEnd = payloadStart + node.value.length;
    let deck: { steps?: Array<{ image?: unknown; markdown?: unknown }> };
    try { deck = JSON.parse(node.value); } catch { return; }
    if (!Array.isArray(deck.steps)) return;
    const stepSources = new Set(deck.steps.map(step => step?.image).filter((image): image is string => typeof image === "string" && image.length > 0));
    if (!stepSources.size && !deck.steps.some(step=>typeof step.markdown==="string")) return;
    const rewritten = new Map<string, string>();
    let markdownChanged = false;
    const offset = work.length;
    for (const source of stepSources) collect(source, name => { rewritten.set(source, name); });
    for(const step of deck.steps) if(typeof step.markdown==='string') {
      const originalMarkdown = step.markdown;
      work.push(prepareFmdInternal(originalMarkdown, documentPath, portableDoc, consent, localAssetSet, omitLocalAssets, shared, assets).then(prepared => {
        if (prepared !== originalMarkdown) {
          step.markdown = prepared;
          markdownChanged = true;
        }
      }));
    }
    // All corresponding assets must finish loading before serializing this deck.
    const waiting = work.splice(offset);
    work.push(Promise.all(waiting).then(() => {
      let imageChanged = false;
      for (const step of deck.steps!) {
        if (typeof step.image === "string" && rewritten.has(step.image)) {
          const nextImage = rewritten.get(step.image)!;
          if (nextImage !== step.image) {
            step.image = nextImage;
            imageChanged = true;
          }
        }
      }
      if (imageChanged || markdownChanged) {
        edits.push({start: payloadStart, end: payloadEnd, value: JSON.stringify(deck, null, 2)});
      }
    }));
  });
  await Promise.all(work);
  let content = markdown;
  for (const edit of edits.sort((a, b) => b.start - a.start)) content = content.slice(0, edit.start) + edit.value + content.slice(edit.end);
  return content;
}

export async function prepareFmd(markdown: string, documentPath: string | null, options: PrepareFmdOptions = {}) {
  const portableDoc = options.portable ?? /\.(?:smd|fmd)$/i.test(documentPath || "");
  const assets: Record<string, string> = {};
  const shared = new Map<string, Promise<string | null>>();
  const localAssetSet = new Set(Array.from(options.localAssets ?? []).filter(isValidLocalPortableAssetKey));
  const omitLocalAssets = Boolean(options.omitLocalAssets);
  const consent: NormalizedFmdConsent = {
    noteId: options.noteId,
    trustedHosts: normalizeTrustedImageHosts(options.trustedImageHosts),
    approvedUrls: normalizeApprovedImageUrls(options.approvedImageUrls),
    loadedImageData: options.loadedImageData,
  };
  const content = await prepareFmdInternal(markdown, documentPath, portableDoc, consent, localAssetSet, omitLocalAssets, shared, assets);
  return { content, assets };
}
