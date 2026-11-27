const DISALLOWED_SVG_URL = /url\(\s*(?:'(?!#|data:)[^']*'|"(?!#|data:)[^"]*"|(?!['"]?(?:#|data:)|\s*\))[^)]+)/i;

/** Render SVG as an image, never as executable inline HTML. */
export function svgImage(source: string): string {
  const document = new DOMParser().parseFromString(source, "image/svg+xml");
  const root = document.documentElement;
  if (document.querySelector("parsererror") || root.localName !== "svg") throw new Error("This SVG is not valid XML.");
  if (root.querySelector("script,foreignObject,iframe,object,embed")) throw new Error("SVG must be a self-contained image, without scripts or embedded HTML.");
  for (const node of [root, ...Array.from(root.querySelectorAll("*"))]) {
    if (/^(?:animate|set|animatemotion|animatetransform)$/i.test(node.localName) && /^(?:href|xlink:href|on\w+)$/i.test((node.getAttribute("attributeName") || "").trim())) {
      throw new Error("SVG animations may not target links or event handlers.");
    }
    for (const attribute of Array.from(node.attributes)) {
      if (/^on/i.test(attribute.name)) throw new Error("SVG event handlers are not allowed.");
      if (/^(?:href|xlink:href)$/i.test(attribute.name) && !/^(?:#|data:image\/(?!svg\+xml))/i.test(attribute.value.trim())) throw new Error("External SVG resources must be embedded first.");
      if (DISALLOWED_SVG_URL.test(attribute.value)) throw new Error("External SVG resources must be embedded first.");
    }
  }
  if (Array.from(root.querySelectorAll("style")).some(style=>DISALLOWED_SVG_URL.test(style.textContent || "") || /@import/i.test(style.textContent || ""))) throw new Error("External SVG styles are not allowed.");
  root.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  return new XMLSerializer().serializeToString(root);
}

export type SvgPresentation = { svg: string; mode: "mono" | "own-background" | "color" };
const NEUTRAL = /^(?:none|transparent|currentcolor|inherit|initial|unset)$/i;
function luminance(color: string): number | null {
  const probe = color.trim().toLowerCase();
  const named: Record<string, string> = { black: "#000", white: "#fff", gray: "#808080", grey: "#808080" };
  const hex = (named[probe] || probe).match(/^#([\da-f]{3}|[\da-f]{6})$/i)?.[1];
  const rgb = probe.match(/^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/);
  const channels = hex ? (hex.length === 3 ? hex.split("").map(c => parseInt(c + c, 16)) : [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16))) : rgb ? rgb.slice(1, 4).map(Number) : null;
  if (!channels) return null;
  const [r, g, b] = channels;
  return Math.max(r, g, b) - Math.min(r, g, b) > 24 ? -1 : (r + g + b) / 765;
}

/** A transparent white drawing needs a dark card, not a contrast filter.
 * Inspect only bounded SVG paint metadata; do not rasterize full-size artwork. */
export function svgContrastBackdrop(source:string):string {
  if(source.length>1_000_000)return '#fdfdfc';
  const xml=new DOMParser().parseFromString(source,'image/svg+xml');
  if(xml.querySelector('parsererror'))return '#fdfdfc';
  const paints=Array.from(source.matchAll(/(?:fill|stroke|color)\s*(?:=\s*["']|:\s*)([^;"'}]+)/gi),m=>m[1].trim());
  const levels=paints.filter(p=>!NEUTRAL.test(p)).map(luminance);
  return levels.length&&levels.every(v=>v!==null&&v>.75)?'#222026':'#fdfdfc';
}

export function svgDataBackdrop(uri:string):string|undefined {
  if(!/^data:image\/svg\+xml(?:[;,]|$)/i.test(uri)||uri.length>1_400_000)return undefined;
  try {const comma=uri.indexOf(',');if(comma<0)return undefined;return svgContrastBackdrop(uri.slice(0,comma).includes(';base64')?atob(uri.slice(comma+1)):decodeURIComponent(uri.slice(comma+1)));}catch{return undefined;}
}

/** Monochrome line art adopts the reading text color so it stays readable in
 * dark and light themes; colored artwork keeps its colors on a white card,
 * and an SVG that paints its own background is shown as authored. */
export function presentSvg(source: string, ink: string): SvgPresentation {
  const safe = svgImage(source);
  const document = new DOMParser().parseFromString(safe, "image/svg+xml");
  const root = document.documentElement;
  const paints: string[] = [];
  const inspect = (node: Element) => {
    for (const name of ["fill", "stroke", "color", "stop-color"]) { const value = node.getAttribute(name); if (value) paints.push(value); }
    for (const match of (node.getAttribute("style") || "").matchAll(/(?:^|;)\s*(?:fill|stroke|color|stop-color)\s*:\s*([^;]+)/gi)) paints.push(match[1]);
  };
  for (const node of [root, ...Array.from(root.querySelectorAll("*"))]) inspect(node);
  for (const match of (root.querySelector("style")?.textContent || "").matchAll(/(?:fill|stroke|color|stop-color)\s*:\s*([^;}]+)/gi)) paints.push(match[1]);
  const box = root.getAttribute("viewBox")?.split(/[\s,]+/).map(Number);
  const backdrop = Array.from(root.children).find(child => child.localName === "rect");
  const covers = backdrop && (["100%", String(box?.[2])].includes(backdrop.getAttribute("width") || "") && ["100%", String(box?.[3])].includes(backdrop.getAttribute("height") || ""));
  if (covers || /background/i.test(root.getAttribute("style") || "")) return { svg: safe, mode: "own-background" };
  const solid = paints.map(paint => paint.trim()).filter(paint => paint && !NEUTRAL.test(paint) && !/^url\(/i.test(paint));
  const levels = solid.map(luminance);
  const mono = !root.querySelector("image,linearGradient,radialGradient,pattern") && levels.every(level => level !== null && level >= 0 && (level < .35 || level > .92));
  if (!mono) return { svg: safe, mode: "color" };
  // Dark marks become the ink color; white highlights become transparent knockouts.
  const recolor = (value: string) => { const level = luminance(value); return level !== null && level >= 0 && level < .35 ? ink : level !== null && level > .92 ? "none" : value; };
  for (const node of [root, ...Array.from(root.querySelectorAll("*"))]) {
    for (const name of ["fill", "stroke", "color"]) { const value = node.getAttribute(name); if (value && !NEUTRAL.test(value) && !/^url\(/i.test(value)) node.setAttribute(name, recolor(value)); }
    const style = node.getAttribute("style");
    if (style) node.setAttribute("style", style.replace(/((?:^|;)\s*(?:fill|stroke|color)\s*:\s*)([^;]+)/gi, (_all, prefix: string, value: string) => prefix + (NEUTRAL.test(value.trim()) ? value : recolor(value))));
  }
  const style = root.querySelector("style");
  if (style?.textContent) style.textContent = style.textContent.replace(/((?:fill|stroke|color)\s*:\s*)([^;}]+)/gi, (_all, prefix: string, value: string) => prefix + (NEUTRAL.test(value.trim()) ? value : recolor(value)));
  // Unpainted shapes default to black fill; currentColor resolves to black in an <img>.
  if (!root.getAttribute("fill")) root.setAttribute("fill", ink);
  root.setAttribute("color", ink);
  return { svg: new XMLSerializer().serializeToString(root), mode: "mono" };
}

export type SvgDimensions = {
  readonly width: number;
  readonly height: number;
  readonly engine?: "pele" | "mermaid";
};

const SVG_LENGTH_UNITS: Record<string, number> = {
  "": 1,
  px: 1,
  pt: 96 / 72,
  pc: 16,
  in: 96,
  cm: 96 / 2.54,
  mm: 96 / 25.4,
  q: 96 / 101.6,
};

function parseSvgCssPixels(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const match = raw.trim().match(/^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*(px|pt|pc|mm|cm|in|q)?$/i);
  if (!match) return null;
  const value = Number(match[1]) * SVG_LENGTH_UNITS[(match[2] || "").toLowerCase()];
  return Number.isFinite(value) && value > 0 && value <= 100_000 ? value : null;
}

function parseInlineStyleLength(style: string | null, property: "width" | "height"): number | null {
  if (!style) return null;
  let found: number | null = null;
  for (const decl of style.split(";")) {
    const colon = decl.indexOf(":");
    if (colon < 0 || decl.slice(0, colon).trim().toLowerCase() !== property) continue;
    found = parseSvgCssPixels(decl.slice(colon + 1).replace(/!important\s*$/i, "").trim());
  }
  return found;
}

/** Extract intrinsic CSS-pixel dimensions from a parsed <svg> root element. */
export function svgDimensionsFromRoot(root: Element): SvgDimensions | null {
  if (root.localName !== "svg") return null;
  const style = root.getAttribute("style");
  const attrWidth = parseSvgCssPixels(root.getAttribute("width")) ?? parseInlineStyleLength(style, "width");
  const attrHeight = parseSvgCssPixels(root.getAttribute("height")) ?? parseInlineStyleLength(style, "height");
  const rawBox = root.getAttribute("viewBox")?.trim();
  const boxParts = rawBox ? rawBox.split(/[\s,]+/).map(Number) : null;
  const validBox = boxParts && boxParts.length === 4 && boxParts.every(Number.isFinite) && boxParts[2] > 0 && boxParts[3] > 0
    ? { width: boxParts[2], height: boxParts[3] }
    : null;

  let width: number | null = null;
  let height: number | null = null;
  if (attrWidth !== null && attrHeight !== null) {
    width = attrWidth;
    height = attrHeight;
  } else if (attrWidth !== null && validBox) {
    width = attrWidth;
    height = (attrWidth * validBox.height) / validBox.width;
  } else if (attrHeight !== null && validBox) {
    width = (attrHeight * validBox.width) / validBox.height;
    height = attrHeight;
  } else if (validBox) {
    const major = Math.max(validBox.width, validBox.height);
    const scale = major < 64 ? 240 / major : 1;
    width = validBox.width * scale;
    height = validBox.height * scale;
  }
  if (width === null || height === null || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  const rawEngine = root.getAttribute("data-diagram-engine");
  const engine = rawEngine === "pele" || rawEngine === "mermaid" ? rawEngine : undefined;
  return engine ? { width, height, engine } : { width, height };
}

export function svgIntrinsicDimensions(source: string): SvgDimensions | null {
  if (!source || source.length > 1_000_000) return null;
  const xml = new DOMParser().parseFromString(source, "image/svg+xml");
  if (xml.querySelector("parsererror")) return null;
  return svgDimensionsFromRoot(xml.documentElement);
}

export function svgDataDimensions(uri: string): SvgDimensions | null {
  if (!/^data:image\/svg\+xml(?:[;,]|$)/i.test(uri) || uri.length > 1_400_000) return null;
  try {
    const comma = uri.indexOf(",");
    if (comma < 0) return null;
    const header = uri.slice(0, comma), body = uri.slice(comma + 1);
    const decoded = /;base64(?:;|$)/i.test(header)
      ? new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(body), ch => ch.charCodeAt(0)))
      : decodeURIComponent(body);
    return svgIntrinsicDimensions(decoded);
  } catch {
    return null;
  }
}

export function svgSizingStyle(dimensions: SvgDimensions | null | undefined): Record<string, string> | undefined {
  if (!dimensions) return undefined;
  const maxWidth = Math.round(dimensions.width * 100) / 100;
  const aspect = dimensions.width / dimensions.height;
  const panFloor = dimensions.engine || aspect >= 2
    ? Math.max(0, Math.round(Math.min(dimensions.width * 0.8, dimensions.width - 200, dimensions.engine ? Infinity : aspect * 360)))
    : 0;
  return {
    "--svg-width": `${maxWidth}px`,
    "--svg-min-width": `${panFloor}px`,
  };
}

