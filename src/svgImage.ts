const DISALLOWED_SVG_URL = /url\(\s*(?:'(?!#|data:)[^']*'|"(?!#|data:)[^"]*"|(?!['"]?(?:#|data:)|\s*\))[^)]+)/i;
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const NEUTRAL = /^(?:none|transparent|currentcolor|inherit|initial|unset)$/i;
const PAINT_ATTRIBUTE = /^(?:fill|stroke|color|(?:stop|flood|lighting|solid)-color)$/i;
const PAINT_DECLARATION = /(?:^|[\s;{-])(?:fill|stroke|color)\s*:\s*([^;"'}]+)/gi;

export type SvgBackdrop = "#222026" | "#fdfdfc";
export type SvgPresentation = { svg: string; mode: "mono" | "own-background" | "color" };
export type ValidatedSvg = {
  readonly root: Element;
  readonly nodes: Element[];
  readonly backing: SvgBackdrop;
  readonly checkSerializedLength: boolean;
  serialized?: string;
};

function withSvgNamespace(source: string): string {
  let i = 0;
  while (i < source.length) {
    while (i < source.length && /\s/.test(source[i])) i++;
    if (source.startsWith("<?", i)) {
      const end = source.indexOf("?>", i + 2);
      if (end < 0) return source;
      i = end + 2;
    } else if (source.startsWith("<!--", i)) {
      const end = source.indexOf("-->", i + 4);
      if (end < 0) return source;
      i = end + 3;
    } else if (/^<!DOCTYPE\b/i.test(source.slice(i, i + 10))) {
      let quote = "", bracket = 0;
      for (i += 9; i < source.length; i++) {
        if (!quote && source.startsWith("<!--", i)) {
          const end = source.indexOf("-->", i + 4);
          if (end < 0) return source;
          i = end + 2;
          continue;
        }
        const ch = source[i];
        if (quote) { if (ch === quote) quote = ""; }
        else if (ch === '"' || ch === "'") quote = ch;
        else if (ch === "[") bracket++;
        else if (ch === "]" && bracket > 0) bracket--;
        else if (ch === ">" && bracket === 0) { i++; break; }
      }
    } else break;
  }
  if (!/^<svg(?=[\s/>])/.test(source.slice(i, i + 5))) return source;
  let quote = "", hasXmlns = false;
  for (let j = i + 4; j < source.length; j++) {
    const ch = source[j];
    if (quote) { if (ch === quote) quote = ""; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === ">") {
      if (hasXmlns) return source;
      const at = source[j - 1] === "/" ? j - 1 : j;
      return `${source.slice(0, at)} xmlns="${SVG_NAMESPACE}"${source.slice(at)}`;
    }
    if (/\s/.test(source[j - 1]) && source.startsWith("xmlns", j)) {
      let k = j + 5;
      while (k < source.length && /\s/.test(source[k])) k++;
      if (source[k] === "=") hasXmlns = true;
    }
  }
  return source;
}

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

function contrastBackdropForRoot(root: Element, nodes: readonly Element[]): SvgBackdrop {
  const paints: string[] = [];
  let budget = 0;
  for (const node of [root, ...nodes]) {
    for (const attribute of Array.from(node.attributes)) {
      budget += attribute.value.length;
      if (budget > 1_000_000) return "#fdfdfc";
      if (PAINT_ATTRIBUTE.test(attribute.name)) {
        const value = attribute.value.trim();
        if (value) paints.push(value);
      } else if (/^style$/i.test(attribute.name)) {
        for (const match of attribute.value.matchAll(PAINT_DECLARATION)) {
          const value = match[1].trim();
          if (value) paints.push(value);
        }
      }
    }
    if (node.localName === "style" && node.textContent) {
      budget += node.textContent.length;
      if (budget > 1_000_000) return "#fdfdfc";
      for (const match of node.textContent.matchAll(PAINT_DECLARATION)) {
        const value = match[1].trim();
        if (value) paints.push(value);
      }
    }
  }
  const levels = paints.filter(p => !NEUTRAL.test(p)).map(luminance);
  return levels.length && levels.every(v => v !== null && v > .75) ? "#222026" : "#fdfdfc";
}

export function serializeSvgRoot(root: Element): string {
  return new XMLSerializer().serializeToString(root);
}

export function serializeValidatedSvg(validated: ValidatedSvg): string {
  validated.serialized ??= serializeSvgRoot(validated.root);
  return validated.serialized;
}

/** Parse and validate an SVG document once so adaptation and contrast checks reuse the tree. */
export function parseValidatedSvg(source: string): ValidatedSvg {
  const markup = withSvgNamespace(source);
  const document = new DOMParser().parseFromString(markup, "image/svg+xml");
  const root = document.documentElement;
  if (document.querySelector("parsererror") || root.localName !== "svg" || root.namespaceURI !== SVG_NAMESPACE) {
    throw new Error("This SVG is not valid XML.");
  }
  if (root.querySelector("script,foreignObject,iframe,object,embed")) throw new Error("SVG must be a self-contained image, without scripts or embedded HTML.");
  const nodes = Array.from(root.querySelectorAll("*"));
  for (const node of [root, ...nodes]) {
    if (/^(?:animate|set|animatemotion|animatetransform)$/i.test(node.localName) && /^(?:href|xlink:href|on\w+)$/i.test((node.getAttribute("attributeName") || "").trim())) {
      throw new Error("SVG animations may not target links or event handlers.");
    }
    for (const attribute of Array.from(node.attributes)) {
      if (/^on/i.test(attribute.name)) throw new Error("SVG event handlers are not allowed.");
      if (/^(?:href|xlink:href)$/i.test(attribute.name) && !/^(?:#|data:image\/(?!svg\+xml))/i.test(attribute.value.trim())) throw new Error("External SVG resources must be embedded first.");
      if (DISALLOWED_SVG_URL.test(attribute.value)) throw new Error("External SVG resources must be embedded first.");
    }
  }
  if (Array.from(root.querySelectorAll("style")).some(style => DISALLOWED_SVG_URL.test(style.textContent || "") || /@import/i.test(style.textContent || ""))) throw new Error("External SVG styles are not allowed.");
  if (!root.hasAttribute("xmlns")) root.setAttribute("xmlns", SVG_NAMESPACE);
  const serialized = markup.length > 950_000 || markup.includes("<!ENTITY") ? serializeSvgRoot(root) : undefined;
  return {
    root,
    nodes,
    backing: serialized && serialized.length > 1_000_000 ? "#fdfdfc" : contrastBackdropForRoot(root, nodes),
    checkSerializedLength: markup.length > 160_000 || serialized !== undefined,
    serialized,
  };
}

/** Render SVG as an image, never as executable inline HTML. */
export function svgImage(source: string): string {
  return serializeValidatedSvg(parseValidatedSvg(source));
}

/** A transparent white drawing needs a dark card, not a contrast filter.
 * Inspect only bounded SVG paint metadata; do not rasterize full-size artwork. */
export function svgContrastBackdrop(source:string):string {
  if(source.length>1_000_000)return '#fdfdfc';
  const xml=new DOMParser().parseFromString(withSvgNamespace(source),'image/svg+xml');
  const root=xml.documentElement;
  if(xml.querySelector('parsererror')||root.localName!=='svg'||root.namespaceURI!==SVG_NAMESPACE)return '#fdfdfc';
  return contrastBackdropForRoot(root,Array.from(root.querySelectorAll('*')));
}

export function svgDataBackdrop(uri:string):string|undefined {
  if(!/^data:image\/svg\+xml(?:[;,]|$)/i.test(uri)||uri.length>1_400_000)return undefined;
  try {
    const comma=uri.indexOf(',');if(comma<0)return undefined;
    const header=uri.slice(0,comma),body=uri.slice(comma+1);
    return svgContrastBackdrop(/;base64(?:;|$)/i.test(header)?new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(atob(body),ch=>ch.charCodeAt(0))):decodeURIComponent(body));
  }catch{return undefined;}
}

/** Monochrome line art adopts the reading text color so it stays readable in
 * dark and light themes; colored artwork keeps its colors on a white card,
 * and an SVG that paints its own background is shown as authored. */
export function presentValidatedSvg(validated: ValidatedSvg, ink: string, options?: { clone?: boolean }): SvgPresentation {
  const { root, nodes } = validated;
  const paints: string[] = [];
  const inspect = (node: Element) => {
    for (const name of ["fill", "stroke", "color", "stop-color"]) { const value = node.getAttribute(name); if (value) paints.push(value); }
    for (const match of (node.getAttribute("style") || "").matchAll(/(?:^|;)\s*(?:fill|stroke|color|stop-color)\s*:\s*([^;]+)/gi)) paints.push(match[1]);
  };
  for (const node of [root, ...nodes]) inspect(node);
  for (const match of (root.querySelector("style")?.textContent || "").matchAll(/(?:fill|stroke|color|stop-color)\s*:\s*([^;}]+)/gi)) paints.push(match[1]);
  const box = root.getAttribute("viewBox")?.split(/[\s,]+/).map(Number);
  const backdrop = Array.from(root.children).find(child => child.localName === "rect");
  const covers = backdrop && (["100%", String(box?.[2])].includes(backdrop.getAttribute("width") || "") && ["100%", String(box?.[3])].includes(backdrop.getAttribute("height") || ""));
  if (covers || /background/i.test(root.getAttribute("style") || "")) return { svg: serializeValidatedSvg(validated), mode: "own-background" };
  const solid = paints.map(paint => paint.trim()).filter(paint => paint && !NEUTRAL.test(paint) && !/^url\(/i.test(paint));
  const levels = solid.map(luminance);
  const mono = !root.querySelector("image,linearGradient,radialGradient,pattern") && levels.every(level => level !== null && level >= 0 && (level < .35 || level > .92));
  if (!mono) return { svg: serializeValidatedSvg(validated), mode: "color" };
  // Dark marks become the ink color; white highlights become transparent knockouts.
  const targetRoot = options?.clone === false ? root : (root.cloneNode(true) as Element);
  const targetNodes = targetRoot === root ? nodes : Array.from(targetRoot.querySelectorAll("*"));
  const recolor = (value: string) => { const level = luminance(value); return level !== null && level >= 0 && level < .35 ? ink : level !== null && level > .92 ? "none" : value; };
  for (const node of [targetRoot, ...targetNodes]) {
    for (const name of ["fill", "stroke", "color"]) { const value = node.getAttribute(name); if (value && !NEUTRAL.test(value) && !/^url\(/i.test(value)) node.setAttribute(name, recolor(value)); }
    const style = node.getAttribute("style");
    if (style) node.setAttribute("style", style.replace(/((?:^|;)\s*(?:fill|stroke|color)\s*:\s*)([^;]+)/gi, (_all, prefix: string, value: string) => prefix + (NEUTRAL.test(value.trim()) ? value : recolor(value))));
  }
  const style = targetRoot.querySelector("style");
  if (style?.textContent) style.textContent = style.textContent.replace(/((?:fill|stroke|color)\s*:\s*)([^;}]+)/gi, (_all, prefix: string, value: string) => prefix + (NEUTRAL.test(value.trim()) ? value : recolor(value)));
  // Unpainted shapes default to black fill; currentColor resolves to black in an <img>.
  if (!targetRoot.getAttribute("fill")) targetRoot.setAttribute("fill", ink);
  targetRoot.setAttribute("color", ink);
  return { svg: serializeSvgRoot(targetRoot), mode: "mono" };
}

export function presentSvg(source: string, ink: string): SvgPresentation {
  return presentValidatedSvg(parseValidatedSvg(source), ink, { clone: false });
}
