import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { visit } from "unist-util-visit";
import { invoke } from "./nativeBridge";
import { remarkObsidianMath } from "./obsidianMath";

export interface ImportedImage { source: string; alt: string }
export interface LinkDetails { url: string; title: string; thumbnail?: string }
export const attachmentSource = (source: string) => /^assets\/(?:import|image)-[a-zA-Z0-9-]+\.(?:png|jpg|jpeg|svg|gif|webp|avif)$/.test(source);
export const markdownLabel = (value: string) => value.replace(/[\\[\]]/g, "\\$&").replace(/[\r\n]+/g, " ");
export const imageMarkdown = (image: ImportedImage) => `![${markdownLabel(image.alt)}](<${image.source.replace(/>/g, "%3E")}>)`;
export interface ImageRange { from: number; to: number; source: string }
export function imageRanges(markdown: string): ImageRange[] {
  const tree = unified().use(remarkParse).use(remarkGfm).use(remarkMath).use(remarkObsidianMath).parse(markdown);
  const definitions = new Map<string, string>(); const result: ImageRange[] = [];
  visit(tree, "definition", (node: any) => { definitions.set(node.identifier, node.url); });
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
  if (!/^image\/(png|jpeg|gif|webp|avif|svg\+xml)$/.test(file.type) && !/\.svg$/i.test(file.name)) return Promise.reject(new Error(`Unsupported image: ${file.name}`));
  if (file.size > 25_000_000) return Promise.reject(new Error("Images must be smaller than 25 MB."));
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).replace(/^data:application\/octet-stream/, "data:image/svg+xml")); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file.type ? file : new Blob([file], { type: "image/svg+xml" })); });
}
export async function importImageFiles(files: File[]): Promise<ImportedImage[]> {
  if (files.length > 32 || files.reduce((sum, file) => sum + file.size, 0) > 75_000_000) throw new Error("Insert at most 32 images / 75 MB at a time.");
  const images = await Promise.all(files.map(async (file) => ({ name: file.name, data: await readImage(file) })));
  return invoke<ImportedImage[]>("import_images", { images });
}
// FMD keeps interactive source blocks intact. Only image URLs are rewritten;
// their bytes live in the envelope, never in the displayed Markdown editor.
export async function prepareFmd(markdown: string, documentPath: string | null) {
  const processor = unified().use(remarkParse).use(remarkGfm).use(remarkMath).use(remarkObsidianMath);
  const tree = processor.parse(markdown);
  const assets: Record<string, string> = {}; const work: Promise<void>[] = [];
  const shared = new Map<string, Promise<string>>();
  const edits: Array<{ start: number; end: number; value: string }> = [];
  const definitions = new Map<string, any>(); const usedDefinitions = new Set<string>();
  visit(tree, "definition", (node: any) => { definitions.set(node.identifier, node); });
  const collect = (source: string, replace: (name: string) => void) => {
    if (!shared.has(source)) shared.set(source, (async () => {
      const data = /^data:image\//.test(source) ? source : /^https?:/.test(source) ? (await invoke<{ body: string }>("fetch_resource", { url: source, image: true })).body : await invoke<string>("load_asset", { documentPath: documentPath || "", source });
      const type = data.match(/^data:image\/([^;]+);base64,/)?.[1];
      if (!type) throw new Error(`Unsupported image ${source}`);
      const name = attachmentSource(source) ? source : `assets/image-${crypto.randomUUID()}.${type === "svg+xml" ? "svg" : type === "jpeg" ? "jpg" : type}`;
      assets[name] = data;
      return name;
    })());
    work.push(shared.get(source)!.then(replace));
  };
  visit(tree, (node: any) => {
    if (node.type === "image") collect(node.url, (name) => { edits.push({ start: node.position.start.offset, end: node.position.end.offset, value: `![${markdownLabel(node.alt || "")}](<${name}>${node.title ? ` "${node.title.replace(/["\\]/g, "\\$&")}"` : ""})` }); });
    if (node.type === "imageReference" && !usedDefinitions.has(node.identifier)) {
      const definition = definitions.get(node.identifier); if (!definition) return;
      usedDefinitions.add(node.identifier);
      collect(definition.url, (name) => { edits.push({ start: definition.position.start.offset, end: definition.position.end.offset, value: `[${definition.label || definition.identifier}]: <${name}>${definition.title ? ` "${definition.title.replace(/["\\]/g, "\\$&")}"` : ""}` }); });
    }
    // Wiki-image compatibility only in actual prose, never inside fenced code.
    if (node.type === "text" && node.position) {
      const raw = markdown.slice(node.position.start.offset, node.position.end.offset);
      for (const match of raw.matchAll(/!\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g)) collect(encodeURI(match[1]), (name) => { edits.push({ start: node.position.start.offset + match.index!, end: node.position.start.offset + match.index! + match[0].length, value: imageMarkdown({ source: name, alt: match[2] || match[1] }) }); });
    }
  });
  await Promise.all(work);
  let content = markdown;
  for (const edit of edits.sort((a, b) => b.start - a.start)) content = content.slice(0, edit.start) + edit.value + content.slice(edit.end);
  return { content, assets };
}
