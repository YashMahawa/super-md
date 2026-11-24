import { analyzeDocument, type DocumentAnalysis } from "./documentAnalysis";

export interface IndentationResult {
  value: string;
  selectionStart: number;
  selectionEnd: number;
  lineStart: number;
  blockEnd: number;
  replacement: string;
}

export interface EditableBlockSpan {
  blockStart: number;
  start: number;
  end: number;
}

const QUOTE_PREFIX_RE = /^(?: {0,3}> ?)+/;
const THEMATIC_BREAK_RE = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const LIST_ITEM_RE = /^([ \t]*)([-+*]|\d{1,9}[.)])(?:([ \t]+)(.*)|())$/;
const NON_EDITABLE_NODE_TYPES = new Set(["definition", "footnoteDefinition", "html"]);

interface ParsedLine {
  quote: string;
  quoteDepth: number;
  rest: string;
  isList: boolean;
  indentStr: string;
  indentCols: number;
  ownMarkerWidth: number;
  contentCols: number;
}

function columnWidth(indent: string): number {
  let cols = 0;
  for (let i = 0; i < indent.length; i++) {
    cols = indent[i] === "\t" ? cols + 4 - (cols % 4) : cols + 1;
  }
  return cols;
}

function parseMarkdownLine(line: string): ParsedLine {
  const quoteMatch = line.match(QUOTE_PREFIX_RE);
  const quote = quoteMatch ? quoteMatch[0] : "";
  const quoteDepth = quote ? (quote.match(/>/g)?.length ?? 0) : 0;
  const rest = line.slice(quote.length);
  if (!THEMATIC_BREAK_RE.test(rest)) {
    const listMatch = rest.match(LIST_ITEM_RE);
    if (listMatch) {
      const indentStr = listMatch[1] ?? "";
      const marker = listMatch[2];
      const space = listMatch[3] ?? "";
      const indentCols = columnWidth(indentStr);
      const ownMarkerWidth = marker.length + (space ? Math.max(1, columnWidth(space)) : 1);
      return {
        quote,
        quoteDepth,
        rest,
        isList: true,
        indentStr,
        indentCols,
        ownMarkerWidth,
        contentCols: indentCols + ownMarkerWidth,
      };
    }
  }
  const leading = rest.match(/^[ \t]*/)?.[0] ?? "";
  const indentCols = columnWidth(leading);
  return {
    quote,
    quoteDepth,
    rest,
    isList: false,
    indentStr: leading,
    indentCols,
    ownMarkerWidth: 2,
    contentCols: indentCols,
  };
}

function collectPrecedingListItems(lines: ParsedLine[], beforeIndex: number, quoteDepth: number): ParsedLine[] {
  const items: ParsedLine[] = [];
  for (let i = beforeIndex - 1; i >= 0; i--) {
    const entry = lines[i];
    if (entry.quoteDepth < quoteDepth) break;
    if (entry.quoteDepth > quoteDepth) continue;
    if (!entry.rest.trim()) continue;
    if (entry.isList) {
      items.push(entry);
    } else if (entry.indentCols === 0) {
      break;
    }
  }
  return items;
}

function removeIndentPrefix(str: string, maxSpaces: number): number {
  if (!str || maxSpaces <= 0) return 0;
  if (str[0] === "\t") return 1;
  let removed = 0;
  while (removed < str.length && removed < maxSpaces && str[removed] === " ") {
    removed++;
  }
  return removed;
}

/** Indents or outdents selected lines using CommonMark list and blockquote rules. */
export function indentMarkdownSelection(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  outdent: boolean,
): IndentationResult {
  const start = Math.max(0, Math.min(selectionStart, value.length));
  const end = Math.max(start, Math.min(selectionEnd, value.length));
  const lineStart = start > 0 ? value.lastIndexOf("\n", start - 1) + 1 : 0;
  const effectiveEnd = end > start && value[end - 1] === "\n" ? end - 1 : end;
  const nextBreak = value.indexOf("\n", effectiveEnd);
  const blockEnd = nextBreak === -1 ? value.length : nextBreak;

  const allLines = value.slice(0, blockEnd).split("\n");
  const firstLineIndex = lineStart > 0 ? value.slice(0, lineStart).split("\n").length - 1 : 0;
  const parsedAll = allLines.map(parseMarkdownLine);
  const firstLine = parsedAll[firstLineIndex];
  const selectedCount = allLines.length - firstLineIndex;

  let listColDelta: number | null = null;
  if (firstLine?.isList) {
    const preceding = collectPrecedingListItems(parsedAll, firstLineIndex, firstLine.quoteDepth);
    if (!outdent) {
      const parent = preceding.find((item) => item.indentCols <= firstLine.indentCols);
      listColDelta = parent
        ? Math.max(0, parent.contentCols - firstLine.indentCols)
        : firstLine.indentCols === 0
          ? firstLine.ownMarkerWidth
          : 0;
    } else {
      const ancestor = preceding.find((item) => item.indentCols < firstLine.indentCols);
      const targetCols = ancestor
        ? firstLine.indentCols > ancestor.contentCols
          ? ancestor.contentCols
          : ancestor.indentCols
        : Math.max(0, firstLine.indentCols - firstLine.ownMarkerWidth);
      listColDelta = targetCols - firstLine.indentCols;
    }
  }

  let lineOffset = lineStart;
  const updatedLines: string[] = [];
  const lineEdits: Array<{ origLen: number; nextLen: number; editCol: number; replaceLen: number; insertLen: number }> = [];

  for (let k = 0; k < selectedCount; k++) {
    const rawLine = allLines[firstLineIndex + k];
    const parsed = parsedAll[firstLineIndex + k];
    let nextLine = rawLine;
    let editCol = parsed.quote.length;
    let replaceLen = 0;
    let insertStr = "";

    if (!outdent) {
      if (listColDelta !== null && (rawLine.trim().length > 0 || selectedCount === 1)) {
        if (parsed.isList) {
          editCol = parsed.quote.length;
          replaceLen = parsed.indentStr.length;
          insertStr = " ".repeat(parsed.indentCols + listColDelta);
          nextLine = parsed.quote + insertStr + parsed.rest.slice(replaceLen);
        } else {
          editCol = parsed.quote.length;
          insertStr = " ".repeat(listColDelta);
          nextLine = parsed.quote + insertStr + parsed.rest;
        }
      } else if (listColDelta === null && (rawLine.trim().length > 0 || selectedCount === 1)) {
        editCol = parsed.quote.length;
        insertStr = "  ";
        nextLine = parsed.quote + insertStr + parsed.rest;
      }
    } else {
      if (parsed.isList) {
        const removeCols =
          listColDelta !== null
            ? Math.min(parsed.indentCols, Math.abs(listColDelta))
            : Math.min(parsed.indentCols, parsed.ownMarkerWidth);
        if (removeCols > 0) {
          editCol = parsed.quote.length;
          replaceLen = parsed.indentStr.length;
          insertStr = " ".repeat(Math.max(0, parsed.indentCols - removeCols));
          nextLine = parsed.quote + insertStr + parsed.rest.slice(replaceLen);
        }
      } else {
        const removeAfterQuote = removeIndentPrefix(
          parsed.rest,
          listColDelta !== null ? Math.abs(listColDelta) : 2,
        );
        if (removeAfterQuote > 0) {
          editCol = parsed.quote.length;
          replaceLen = removeAfterQuote;
          nextLine = parsed.quote + parsed.rest.slice(removeAfterQuote);
        } else if (parsed.quote) {
          const removeBeforeQuote = removeIndentPrefix(parsed.quote, 2);
          if (removeBeforeQuote > 0) {
            editCol = 0;
            replaceLen = removeBeforeQuote;
            nextLine = rawLine.slice(removeBeforeQuote);
          }
        }
      }
    }

    updatedLines.push(nextLine);
    lineEdits.push({
      origLen: rawLine.length,
      nextLen: nextLine.length,
      editCol,
      replaceLen,
      insertLen: insertStr.length,
    });
    lineOffset += rawLine.length + 1;
  }

  const collapsed = start === end;
  const adjustPosition = (pos: number, isEnd: boolean): number => {
    let shifted = pos;
    let origLineStart = lineStart;
    for (let k = 0; k < selectedCount; k++) {
      const { origLen, nextLen, editCol, replaceLen, insertLen } = lineEdits[k];
      const origLineEnd = origLineStart + origLen;
      if (pos < origLineStart) break;
      const delta = nextLen - origLen;
      if (pos <= origLineEnd) {
        if (!collapsed) {
          if (isEnd && k > 0 && pos === origLineStart) break;
          if (!isEnd && k === 0 && pos === origLineStart) break;
        }
        const inLine = pos - origLineStart;
        if (inLine < editCol) {
          // Position is inside blockquote prefix before the edited indent span.
        } else if (inLine <= editCol + replaceLen) {
          const nextInLine =
            inLine === editCol + replaceLen
              ? editCol + insertLen
              : Math.max(editCol, Math.min(editCol + insertLen, inLine + delta));
          shifted += nextInLine - inLine;
        } else {
          shifted += delta;
        }
        break;
      }
      shifted += delta;
      origLineStart = origLineEnd + 1;
    }
    return shifted;
  };

  const nextStart = adjustPosition(start, false);
  const nextEnd = Math.max(nextStart, adjustPosition(end, true));

  const replacement = updatedLines.join("\n");
  const nextValue =
    replacement === value.slice(lineStart, blockEnd)
      ? value
      : value.slice(0, lineStart) + replacement + value.slice(blockEnd);

  return {
    value: nextValue,
    selectionStart: nextStart,
    selectionEnd: nextEnd,
    lineStart,
    blockEnd,
    replacement,
  };
}

export function isFirstLineCursor(value: string, selectionStart: number, selectionEnd: number): boolean {
  return selectionStart === selectionEnd && !value.slice(0, selectionStart).includes("\n");
}

export function isLastLineCursor(value: string, selectionStart: number, selectionEnd: number): boolean {
  return selectionStart === selectionEnd && !value.slice(selectionEnd).includes("\n");
}

/** Returns editable block spans in source order that correspond to rendered `.live-block` elements. */
export function editableBlockSpans(markdown: string, existing?: DocumentAnalysis): EditableBlockSpan[] {
  if (!markdown.trim()) return [];
  const analysis = existing ?? analyzeDocument(markdown);
  const nodes = analysis.tree.children.filter((node) => node.position?.start.offset !== undefined);
  const spans: EditableBlockSpan[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (NON_EDITABLE_NODE_TYPES.has(node.type)) continue;
    const block = analysis.blocks[i];
    if (!block) continue;
    spans.push({
      blockStart: block.start,
      start: block.start,
      end: node.position?.end.offset ?? block.end,
    });
  }
  return spans;
}
