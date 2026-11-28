import { visit } from "unist-util-visit";
import { findStandaloneEquationBlocks } from "./markdownSource";
import { tableMathPipeInsertions } from "./tableMath";

/** Obsidian permits TeX on the opening/closing $$ lines, and academic Markdown
 * permits standalone \begin{equation}...\end{equation} blocks without $$.
 * Normalize parser input only, never saved source. */
export function displayMathInsertions(source: string): Array<{ at: number; text: string }> {
  const edits: Array<{ at: number; text: string }> = [];
  let offset = 0, math = false, fence = "", fenceLength = 0;
  for (const line of source.split("\n")) {
    const prefix = line.match(/^([ \t]*(?:>[ \t]*)*)/)![0];
    const body = line.slice(prefix.length);
    const code = body.match(/^(`{3,}|~{3,})/);
    if (!math && code) {
      if (!fence) { fence = code[1][0]; fenceLength = code[1].length; }
      else if (code[1][0] === fence && code[1].length >= fenceLength) fence = "";
    } else if (!fence && (math || (prefix.length < 4 && body.startsWith("$$") && body[2] !== "$"))) {
      let from = 0;
      if (!math) {
        math = true; from = 2;
        if (body.slice(2).trim()) edits.push({ at: offset + prefix.length + 2, text: "\n" + prefix });
      }
      for (let i = body.indexOf("$$", from); i >= 0; i = body.indexOf("$$", i + 2)) {
        let slashes = 0; for (let j = i - 1; j >= 0 && body[j] === "\\"; j--) slashes++;
        if (slashes % 2 || body[i - 1] === "$" || body[i + 2] === "$") continue;
        if (body.slice(from, i).trim()) edits.push({ at: offset + prefix.length + i, text: "\n" + prefix });
        if (body.slice(i + 2).trim()) edits.push({ at: offset + prefix.length + i + 2, text: "\n" + prefix });
        math = false; break;
      }
    }
    offset += line.length + 1;
  }
  for (const block of findStandaloneEquationBlocks(source)) {
    edits.push(
      { at: block.start, text: "$$\n" + block.openPrefix },
      { at: block.end, text: "\n" + block.closePrefix + "$$" },
    );
  }
  return edits.sort((a, b) => a.at - b.at);
}

export function normalizedDisplayMath(source: string): string {
  const edits = displayMathInsertions(source); let result = source;
  for (const edit of edits.reverse()) result = result.slice(0, edit.at) + edit.text + result.slice(edit.at);
  return result;
}

/** Wrap remark's parser so all consumers (preview, PDF, portable media edits)
 * agree, while AST offsets still address the original editable Markdown. */
export function remarkObsidianMath(this: any) {
  const parser = this.parser;
  this.parser = (source: string, file: any) => {
    const bareBlocks = findStandaloneEquationBlocks(source);
    const bareStarts = new Set(bareBlocks.map((block) => block.start));
    const pipeEdits=tableMathPipeInsertions(source);
    const edits = [...displayMathInsertions(source),...pipeEdits].sort((a,b)=>a.at-b.at);
    if (!edits.length) return parser(source, file);
    let added = 0, previous = 0; const chunks: string[] = [];
    const mapping = edits.map((edit) => {
      chunks.push(source.slice(previous, edit.at), edit.text); previous = edit.at;
      const start = edit.at + added; added += edit.text.length;
      return { start, end: edit.at + added, original: edit.at, added };
    });
    chunks.push(source.slice(previous));
    const tree = parser(chunks.join(""), file);
    const lines = [0]; for (let i = 0; i < source.length; i++) if (source[i] === "\n") lines.push(i + 1);
    const upperBound = (values: number[], value: number) => { let lo = 0, hi = values.length; while (lo < hi) { const mid = (lo + hi) >>> 1; if (values[mid] <= value) lo = mid + 1; else hi = mid; } return lo; };
    const starts = mapping.map((entry) => entry.start);
    const originalPoint = (point: any) => {
      const entry = mapping[upperBound(starts, point.offset) - 1];
      const offset = !entry ? point.offset : point.offset <= entry.end ? entry.original : point.offset - entry.added;
      const line = upperBound(lines, offset);
      return { offset, line, column: offset - lines[line - 1] + 1 };
    };
    visit(tree, (node: any) => {
      if(node.position)node.position={start:originalPoint(node.position.start),end:originalPoint(node.position.end)};
      if (node.type === "math" && node.position && bareStarts.has(node.position.start.offset)) {
        node.data = {
          ...node.data,
          bareMath: true,
          hProperties: {
            ...node.data?.hProperties,
            "data-math-source": String(node.value || ""),
            "data-math-bare": "true",
          },
        };
      }
      if(node.type==="inlineMath"&&pipeEdits.some(edit=>edit.at>=node.position.start.offset&&edit.at<node.position.end.offset)){
        // remark-math preserves GFM's escape as TeX \| (a double bar). Restore
        // the original formula, not a global replacement of genuine TeX norms.
        node.value=source.slice(node.position.start.offset,node.position.end.offset).replace(/^\$+|\$+$/g,"").trim();
        if(typeof node.data?.hChildren?.[0]?.value==="string")node.data.hChildren[0].value=node.value;
        if(node.data?.hChildren?.[0]?.children?.[0])node.data.hChildren[0].children[0].value=node.value;
      }
    });
    return tree;
  };
}
