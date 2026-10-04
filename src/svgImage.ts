/** Render SVG as an image, never as executable inline HTML. */
export function svgImage(source: string): string {
  const document = new DOMParser().parseFromString(source, "image/svg+xml");
  const root = document.documentElement;
  if (document.querySelector("parsererror") || root.localName !== "svg") throw new Error("This SVG is not valid XML.");
  if (root.querySelector("script,foreignObject,iframe,object,embed")) throw new Error("SVG must be a self-contained image, without scripts or embedded HTML.");
  for (const node of [root, ...Array.from(root.querySelectorAll("*"))]) for (const attribute of Array.from(node.attributes)) {
    if (/^on/i.test(attribute.name)) throw new Error("SVG event handlers are not allowed.");
    if (/^(?:href|xlink:href)$/i.test(attribute.name) && !/^(?:#|data:image\/)/.test(attribute.value)) throw new Error("External SVG resources must be embedded first.");
    if (/url\(\s*['"]?(?:https?:|\/\/|file:)/i.test(attribute.value)) throw new Error("External SVG resources must be embedded first.");
  }
  if (/url\(\s*['"]?(?:https?:|\/\/|file:)|@import/i.test(root.querySelector("style")?.textContent || "")) throw new Error("External SVG styles are not allowed.");
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
