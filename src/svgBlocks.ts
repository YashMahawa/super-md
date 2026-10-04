import { visit } from "unist-util-visit";

const SVG_START = /^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/i;
const SVG_END = /<\/svg>\s*$/i;
export const looksLikeSvg = (text: string) => SVG_START.test(text) && SVG_END.test(text);

/** Raw `<svg>` markup (an HTML block, an inline paragraph or an untagged/XML
 * code fence) becomes an `svg` block, rendered as a sanitized image instead of
 * showing source or being dropped. */
export function remarkSvgBlocks(this: unknown) {
  return (tree: any, file: { value?: unknown }) => {
    const source = typeof file?.value === "string" ? file.value : "";
    const slice = (first: any, last: any) => first?.position && last?.position && source ? source.slice(first.position.start.offset, last.position.end.offset) : "";
    visit(tree, "code", (node: any) => {
      if ((!node.lang || ["xml", "html", "svg+xml", "image/svg+xml"].includes(String(node.lang).toLowerCase())) && looksLikeSvg(node.value)) node.lang = "svg";
    });
    visit(tree, (node: any) => Array.isArray(node.children), (parent: any) => {
      const children = parent.children;
      for (let index = 0; index < children.length; index++) {
        const node = children[index];
        const text = node.type === "html" ? node.value : node.type === "paragraph" ? slice(node, node) : "";
        if (!text || !/^\s*(?:<\?xml[^>]*\?>\s*)?<svg[\s>]/i.test(text)) continue;
        // An SVG with blank lines splits into several blocks: join until </svg>.
        let end = index;
        while (end < children.length && !SVG_END.test(slice(node, children[end]) || "")) end++;
        if (end >= children.length) continue;
        const value = slice(node, children[end]);
        if (!looksLikeSvg(value)) continue;
        children.splice(index, end - index + 1, { type: "code", lang: "svg", value: value.trim(), position: { start: node.position.start, end: children[end].position.end } });
      }
      return undefined;
    });
    return tree;
  };
}
