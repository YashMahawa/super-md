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
    const slice = (first: any, last: any) => {
      if (!first?.position || !last?.position || !source) return "";
      const start = first.position.start.offset;
      const prefix = source.slice(source.lastIndexOf("\n", start - 1) + 1, start);
      const raw = source.slice(start, last.position.end.offset);
      if (!prefix || !/^[ >\t]*>[ >\t]*$/.test(prefix)) return raw;
      const quotePrefix = prefix.replace(/[ \t]+$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return raw.replace(new RegExp(`(\\r?\\n)${quotePrefix}[ \\t]?`, "g"), "$1");
    };
    visit(tree, "code", (node: any) => {
      if ((!node.lang || ["xml", "html", "svg+xml", "image/svg+xml"].includes(String(node.lang).toLowerCase())) && looksLikeSvg(node.value)) node.lang = "svg";
    });
    visit(tree, (node: any) => Array.isArray(node.children), (parent: any) => {
      const children = parent.children;
      for (let index = 0; index < children.length; index++) {
        const node = children[index];
        let svgNode = node;
        let headChildren: any[] | null = null;
        let text = node.type === "html" ? node.value : node.type === "paragraph" ? slice(node, node) : "";
        if (node.type === "paragraph" && text && !/^\s*(?:<\?xml[^>]*\?>\s*)?<svg[\s>]/i.test(text) && /^\[![\w-]+\]/.test(text) && Array.isArray(node.children)) {
          const childIdx = node.children.findIndex((c: any) => c.type === "html" && /^\s*(?:<\?xml[^>]*\?>\s*)?<svg[\s>]/i.test(c.value));
          if (childIdx > 0) {
            svgNode = node.children[childIdx];
            headChildren = node.children.slice(0, childIdx);
            text = slice(svgNode, node);
          }
        }
        if (!text || !/^\s*(?:<\?xml[^>]*\?>\s*)?<svg[\s>]/i.test(text)) continue;
        // An SVG with blank lines splits into several blocks: join until </svg>.
        let end = index;
        while (end < children.length && !SVG_END.test(slice(svgNode, children[end]) || "")) end++;
        if (end >= children.length) continue;
        const value = slice(svgNode, children[end]);
        if (!looksLikeSvg(value)) continue;
        const codeNode = { type: "code", lang: "svg", value: value.trim(), position: { start: svgNode.position.start, end: children[end].position.end } };
        if (headChildren) {
          const lastHead = headChildren[headChildren.length - 1];
          const trimmedHead = lastHead?.type === "text" ? [...headChildren.slice(0, -1), { ...lastHead, value: lastHead.value.replace(/\r?\n[ \t]*$/, "") }] : headChildren;
          children.splice(index, end - index + 1, { ...node, children: trimmedHead, position: { start: node.position.start, end: lastHead.position?.end ?? svgNode.position.start } }, codeNode);
          index++;
        } else {
          children.splice(index, end - index + 1, codeNode);
        }
      }
      return undefined;
    });
    return tree;
  };
}
