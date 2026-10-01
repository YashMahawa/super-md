import { visit } from "unist-util-visit";

/** Obsidian permits TeX on the opening/closing $$ lines. remark-math's
 * flow grammar instead treats opening-line TeX as metadata and requires a
 * standalone closing fence. Normalize parser input only, never saved source. */
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
  return edits;
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
    const edits = displayMathInsertions(source);
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
    visit(tree, (node: any) => { if (node.position) node.position = { start: originalPoint(node.position.start), end: originalPoint(node.position.end) }; });
    return tree;
  };
}
