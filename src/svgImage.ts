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
