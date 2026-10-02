import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkMath from "remark-math";
import { visit } from "unist-util-visit";

export interface MathRepair { from: number; to: number; before: string; after: string; reason: string }
/** Conservative suggestions, never an automatic document rewrite. Code/links/math are protected. */
export function suggestMathRepairs(markdown: string): MathRepair[] {
  const protectedRanges: Array<[number, number]> = [];
  const tree = unified().use(remarkParse).use(remarkMath).parse(markdown);
  visit(tree, (node: any) => {
    if (["code", "inlineCode", "math", "inlineMath", "link", "image", "definition", "html"].includes(node.type) && node.position) protectedRanges.push([node.position.start.offset, node.position.end.offset]);
  });
  const changes: MathRepair[] = [];
  const add = (from: number, to: number, after: string, reason: string) => {
    if (protectedRanges.some(([start,end]) => from < end && to > start) || changes.some(change => from < change.to && to > change.from)) return;
    changes.push({ from, to, before: markdown.slice(from,to), after, reason });
  };
  for (const match of markdown.matchAll(/\\\[([\s\S]*?)\\\]|\\\(([^\n]*?)\\\)/g)) {
    if (match.index > 0 && markdown[match.index-1] === "\\") continue;
    add(match.index,match.index+match[0].length,match[1] !== undefined ? `\n$$\n${match[1].trim()}\n$$\n` : `$${match[2].trim()}$`,"Normalize LaTeX delimiters");
  }
  for (const match of markdown.matchAll(/^[ \t]*(\\begin\{(aligned|align\*?|equation\*?|gather\*?|cases|matrix|pmatrix|bmatrix)\}[\s\S]*?\\end\{\2\})[ \t]*$/gm)) add(match.index,match.index+match[0].length,`$$\n${match[1]}\n$$`,"Enclose a standalone LaTeX environment");
  for (const match of markdown.matchAll(/^[ \t]*([^\n]+)[ \t]*$/gm)) {
    const expression = match[1].trim();
    // Missing delimiters can be ambiguous. Prose, bullets, currency and URLs are not guessed.
    if (!/\\(?:frac|sqrt|sum|int|lim|boxed|alpha|beta|theta|pi|sigma|omega|mathbb|mathbf|mathcal|vec)\b/.test(expression) || /[$`]|https?:|^\s*(?:>|#|[-*]\s|\d+\.\s)/.test(expression)) continue;
    const stripped = expression.replace(/\\[A-Za-z]+/g, "").replace(/\{[A-Za-z ]{3,}\}/g, "");
    if (/[A-Za-z]{3,}/.test(stripped)) continue;
    add(match.index,match.index+match[0].length,`$$\n${expression}\n$$`,"Enclose a standalone formula missing dollar signs");
  }
  return changes.sort((a,b)=>a.from-b.from).slice(0,200);
}
export function applyMathRepairs(markdown: string, changes: MathRepair[]): string {
  return [...changes].sort((a,b)=>b.from-a.from).reduce((content,change)=> content.slice(change.from,change.to) === change.before ? content.slice(0,change.from)+change.after+content.slice(change.to) : content,markdown);
}
