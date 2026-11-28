import { visit } from "unist-util-visit";
import { analyzeDocument } from "./documentAnalysis";
import { safeParseUrl } from "./documentMedia";
import { parseFrontmatter } from "./frontmatter";
import { maskCode } from "./markdownSource";

export const FORMAT_ACTIONS = [
  "bold",
  "italic",
  "inline_code",
  "link",
  "heading",
  "list",
  "quote",
  "inline_math",
] as const;

export type FormatAction = (typeof FORMAT_ACTIONS)[number];

export interface SelectionRange {
  anchor: number;
  head: number;
}

export interface TextChangeSpec {
  from: number;
  to: number;
  insert: string;
}

export interface MarkdownEditResult {
  doc: string;
  changes: TextChangeSpec[];
  ranges: SelectionRange[];
  mainIndex: number;
}

export function notifyHistoryBoundary(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("supermd-history-boundary"));
  }
}

export function normalizeFormatAction(raw: unknown): FormatAction | null {
  if (typeof raw !== "string") return null;
  const key = raw.trim().toLowerCase().replace(/-/g, "_");
  if (key === "code") return "inline_code";
  if (key === "math") return "inline_math";
  return (FORMAT_ACTIONS as readonly string[]).includes(key) ? (key as FormatAction) : null;
}

/**
 * Matches fixed default Markdown formatting shortcuts on non-Qt hosts.
 * Inside the Qt desktop host, QML Shortcut items own configurable bindings.
 */
export function formatActionFromKeyEvent(event: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}): FormatAction | null {
  const mod = event.ctrlKey || event.metaKey;
  if (!mod) return null;
  const key = event.key.toLowerCase();
  if (!event.shiftKey && !event.altKey) {
    if (key === "b") return "bold";
    if (key === "i") return "italic";
    if (key === "e" || event.key === "`") return "inline_code";
    if (key === "k") return "link";
    return null;
  }
  if (event.shiftKey && !event.altKey) {
    if (key === "h") return "heading";
    if (key === "l") return "list";
    if (key === "q") return "quote";
    if (key === "m") return "inline_math";
    return null;
  }
  if (!event.shiftKey && event.altKey && key === "q") {
    return "quote";
  }
  return null;
}

export function parseStandaloneHttpUrl(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || /[\s\r\n]/.test(trimmed) || !/^https?:\/\/\S+$/i.test(trimmed)) return null;
  const parsed = safeParseUrl(trimmed);
  return parsed && (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.hostname ? trimmed : null;
}

function escapeLinkLabel(label: string): string {
  return label.replace(/(?<!\\)([[\]])/g, "\\$1");
}

function escapeLinkDestination(url: string): string {
  return url.replace(/\(/g, "%28").replace(/\)/g, "%29");
}

function countCharsLeft(doc: string, pos: number, ch: string, max = 6): number {
  let count = 0;
  while (count < max && pos - 1 - count >= 0 && doc[pos - 1 - count] === ch) count++;
  return count;
}

function countCharsRight(doc: string, pos: number, ch: string, max = 6): number {
  let count = 0;
  while (count < max && pos + count < doc.length && doc[pos + count] === ch) count++;
  return count;
}

function countLeadingChars(text: string, ch: string, max = 6): number {
  let count = 0;
  while (count < max && count < text.length && text[count] === ch) count++;
  return count;
}

function countTrailingChars(text: string, ch: string, max = 6): number {
  let count = 0;
  while (count < max && count < text.length && text[text.length - 1 - count] === ch) count++;
  return count;
}

interface RangePlan {
  from: number;
  to: number;
  insert: string;
  selStartOffset: number;
  selEndOffset: number;
  reversed: boolean;
}

function buildResultFromRangePlans(
  doc: string,
  plans: RangePlan[],
  mainIndex: number,
): MarkdownEditResult {
  const indexed = plans.map((plan, index) => ({ plan, index })).sort((a, b) => a.plan.from - b.plan.from || a.plan.to - b.plan.to);
  const changes: TextChangeSpec[] = [];
  const nextRanges: SelectionRange[] = new Array(plans.length);
  let cursor = 0;
  let delta = 0;
  let out = "";

  for (const { plan, index } of indexed) {
    if (plan.from < cursor) {
      // Overlapping multi-cursor edge case: keep current cursor position safely.
      const mapped = cursor + delta;
      nextRanges[index] = { anchor: mapped, head: mapped };
      continue;
    }
    out += doc.slice(cursor, plan.from) + plan.insert;
    changes.push({ from: plan.from, to: plan.to, insert: plan.insert });
    const base = plan.from + delta;
    const start = base + plan.selStartOffset;
    const end = base + plan.selEndOffset;
    nextRanges[index] = plan.reversed ? { anchor: end, head: start } : { anchor: start, head: end };
    delta += plan.insert.length - (plan.to - plan.from);
    cursor = plan.to;
  }
  out += doc.slice(cursor);
  return {
    doc: out,
    changes: changes.filter((c) => c.from !== c.to || c.insert.length > 0),
    ranges: nextRanges,
    mainIndex: Math.min(Math.max(0, mainIndex), Math.max(0, nextRanges.length - 1)),
  };
}

type SymmetricInlineAction = "bold" | "italic" | "inline_code" | "inline_math";

interface SymmetricInlineDescriptor {
  readonly delimiters: readonly string[];
  unwrapCount(runLength: number): number;
  unwrapInner?(inner: string, count: number): string;
  wrap(selected: string): readonly [open: string, close: string];
}

const SYMMETRIC_INLINE_DESCRIPTORS: Record<SymmetricInlineAction, SymmetricInlineDescriptor> = {
  bold: {
    delimiters: ["*", "_"],
    unwrapCount: (n) => (n >= 2 ? 2 : 0),
    wrap: () => ["**", "**"],
  },
  italic: {
    delimiters: ["*", "_"],
    unwrapCount: (n) => (n === 1 || n === 3 ? 1 : 0),
    wrap: () => ["*", "*"],
  },
  inline_code: {
    delimiters: ["`"],
    unwrapCount: (n) => (n === 1 || n === 2 ? n : 0),
    unwrapInner: (inner, count) =>
      count === 2 && inner.startsWith(" ") && inner.endsWith(" ") && inner.length >= 2
        ? inner.slice(1, -1)
        : inner,
    wrap: (selected) => (selected.includes("`") ? ["`` ", " ``"] : ["`", "`"]),
  },
  inline_math: {
    delimiters: ["$"],
    unwrapCount: (n) => (n === 1 ? 1 : 0),
    wrap: () => ["$", "$"],
  },
};

function planSymmetricInlineToggle(
  doc: string,
  range: SelectionRange,
  action: SymmetricInlineAction,
): RangePlan {
  const from = Math.min(range.anchor, range.head);
  const to = Math.max(range.anchor, range.head);
  const reversed = range.anchor > range.head;
  const selected = doc.slice(from, to);
  const descriptor = SYMMETRIC_INLINE_DESCRIPTORS[action];

  for (const ch of descriptor.delimiters) {
    const outerRun = Math.min(countCharsLeft(doc, from, ch, 3), countCharsRight(doc, to, ch, 3));
    const outerUnwrap = descriptor.unwrapCount(outerRun);
    if (outerUnwrap > 0) {
      return {
        from: from - outerUnwrap,
        to: to + outerUnwrap,
        insert: selected,
        selStartOffset: 0,
        selEndOffset: selected.length,
        reversed,
      };
    }
  }

  if (selected.length >= 2) {
    for (const ch of descriptor.delimiters) {
      const innerRun = Math.min(countLeadingChars(selected, ch, 3), countTrailingChars(selected, ch, 3));
      const innerUnwrap = descriptor.unwrapCount(innerRun);
      if (innerUnwrap > 0 && selected.length >= innerUnwrap * 2) {
        const rawInner = selected.slice(innerUnwrap, selected.length - innerUnwrap);
        const inner = descriptor.unwrapInner ? descriptor.unwrapInner(rawInner, innerUnwrap) : rawInner;
        return {
          from,
          to,
          insert: inner,
          selStartOffset: 0,
          selEndOffset: inner.length,
          reversed,
        };
      }
    }
  }

  const [open, close] = descriptor.wrap(selected);
  return {
    from,
    to,
    insert: `${open}${selected}${close}`,
    selStartOffset: open.length,
    selEndOffset: open.length + selected.length,
    reversed,
  };
}

function planLinkToggle(doc: string, range: SelectionRange): RangePlan {
  const from = Math.min(range.anchor, range.head);
  const to = Math.max(range.anchor, range.head);
  const reversed = range.anchor > range.head;
  const selected = doc.slice(from, to);

  // 1. Entire selection is a Markdown link [label](dest)
  const fullMatch = selected.match(/^\[((?:\\.|[^[\]\r\n])*)\]\(([^)\r\n]*)\)$/);
  if (fullMatch) {
    const restored = fullMatch[1].length > 0 ? fullMatch[1] : fullMatch[2];
    return {
      from,
      to,
      insert: restored,
      selStartOffset: 0,
      selEndOffset: restored.length,
      reversed,
    };
  }

  // 2. Selection/caret is immediately inside [label](dest) brackets: ...[ <from..to> ](dest)...
  if (from > 0 && doc[from - 1] === "[" && (from < 2 || doc[from - 2] !== "!")) {
    const tailMatch = doc.slice(to).match(/^\]\(([^)\r\n]*)\)/);
    if (tailMatch) {
      const restored = selected.length > 0 ? selected : tailMatch[1];
      return {
        from: from - 1,
        to: to + tailMatch[0].length,
        insert: restored,
        selStartOffset: 0,
        selEndOffset: restored.length,
        reversed,
      };
    }
  }

  // 3. Selection/caret is on a single line inside an existing [label](dest) span (e.g. caret in `()` right after pressing Link)
  const lineStart = doc.lastIndexOf("\n", Math.max(0, from - 1)) + 1;
  const nextNewline = doc.indexOf("\n", to);
  const lineEnd = nextNewline === -1 ? doc.length : nextNewline;
  if (from >= lineStart && to <= lineEnd) {
    const line = doc.slice(lineStart, lineEnd);
    const linkPattern = /(?<!\!)\[((?:\\.|[^[\]\r\n])*)\]\(([^)\r\n]*)\)/g;
    for (const match of line.matchAll(linkPattern)) {
      const linkStart = lineStart + match.index!;
      const linkEnd = linkStart + match[0].length;
      if (from >= linkStart && to <= linkEnd) {
        const restored = match[1].length > 0 ? match[1] : match[2];
        return {
          from: linkStart,
          to: linkEnd,
          insert: restored,
          selStartOffset: 0,
          selEndOffset: restored.length,
          reversed: false,
        };
      }
    }
  }

  // 4. Selected text is a standalone HTTP/HTTPS URL -> [](url) with caret inside []
  const asUrl = parseStandaloneHttpUrl(selected);
  if (asUrl) {
    const escaped = escapeLinkDestination(asUrl);
    const insert = `[](${escaped})`;
    return {
      from,
      to,
      insert,
      selStartOffset: 1,
      selEndOffset: 1,
      reversed: false,
    };
  }

  // 5. Bare cursor -> []() with caret inside []
  if (from === to) {
    return {
      from,
      to,
      insert: "[]()",
      selStartOffset: 1,
      selEndOffset: 1,
      reversed: false,
    };
  }

  // 6. Selected text -> [selected]() with caret inside ()
  const insert = `[${selected}]()`;
  return {
    from,
    to,
    insert,
    selStartOffset: selected.length + 3,
    selEndOffset: selected.length + 3,
    reversed: false,
  };
}

interface DocLine {
  index: number;
  from: number;
  to: number;
  text: string;
}

function splitLinesWithOffsets(doc: string): DocLine[] {
  const lines: DocLine[] = [];
  let start = 0;
  let index = 0;
  while (start <= doc.length) {
    const nl = doc.indexOf("\n", start);
    if (nl === -1) {
      const end = doc.length > start && doc[doc.length - 1] === "\r" ? doc.length - 1 : doc.length;
      lines.push({ index, from: start, to: end, text: doc.slice(start, end) });
      break;
    }
    const end = nl > start && doc[nl - 1] === "\r" ? nl - 1 : nl;
    lines.push({ index, from: start, to: end, text: doc.slice(start, end) });
    start = nl + 1;
    index++;
  }
  return lines;
}

function lineIndexAt(lines: DocLine[], offset: number): number {
  let low = 0;
  let high = lines.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >>> 1;
    if (lines[mid].from <= offset) low = mid;
    else high = mid - 1;
  }
  return low;
}

interface LeadingQuotePrefix {
  depth: number;
  raw: string;
  col: number;
  baseCol: number;
}

function scanLeadingQuotePrefix(line: string): LeadingQuotePrefix {
  let pos = 0;
  let col = 0;
  let baseCol = 0;
  let depth = 0;
  while (pos < line.length) {
    let nextPos = pos;
    let nextCol = col;
    while (nextPos < line.length && (line[nextPos] === " " || line[nextPos] === "\t")) {
      const step = line[nextPos] === "\t" ? 4 - (nextCol % 4) : 1;
      if (nextCol + step - baseCol > 3) break;
      nextCol += step;
      nextPos++;
    }
    if (line[nextPos] !== ">") break;
    pos = nextPos + 1;
    col = nextCol + 1;
    depth++;
    if (line[pos] === " ") {
      pos++;
      col++;
      baseCol = col;
    } else if (line[pos] === "\t") {
      baseCol = col + 1;
    } else {
      baseCol = col;
    }
  }
  return { depth, raw: depth > 0 ? line.slice(0, pos) : "", col, baseCol };
}

const THEMATIC_BREAK_BODY = /^(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;

function isThematicBreakAfterQuote(quote: LeadingQuotePrefix, afterQuote: string): boolean {
  let pos = 0;
  let col = quote.col;
  while (pos < afterQuote.length && (afterQuote[pos] === " " || afterQuote[pos] === "\t")) {
    col += afterQuote[pos] === "\t" ? 4 - (col % 4) : 1;
    pos++;
  }
  if (col - quote.baseCol > 3) return false;
  return THEMATIC_BREAK_BODY.test(afterQuote.slice(pos));
}

function isThematicBreakLine(line: string): boolean {
  const quote = scanLeadingQuotePrefix(line);
  return isThematicBreakAfterQuote(quote, line.slice(quote.raw.length));
}

function isBlankForBlockAction(line: string, action: "heading" | "list" | "quote"): boolean {
  if (action === "quote") return line.trim().length === 0;
  const quote = scanLeadingQuotePrefix(line);
  return line.slice(quote.raw.length).trim().length === 0;
}

function hasBlockPrefix(line: string, action: "heading" | "list" | "quote"): boolean {
  if (action === "quote") return /^(\s*)>[ \t]?/.test(line);
  const quote = scanLeadingQuotePrefix(line);
  const afterQuote = line.slice(quote.raw.length);
  if (action === "heading") return /^([ \t]{0,3})#{1,6}(?:[ \t]+|$)/.test(afterQuote);
  if (isThematicBreakAfterQuote(quote, afterQuote)) return false;
  // list: `- item`, `* item`, `+ item`, or an empty list marker `- ` / `-` (not `---` or `**bold**`)
  return /^([ \t]*)[-*+][ \t]+/.test(afterQuote) || /^([ \t]*)[-*+]$/.test(afterQuote);
}

function toggleBlockPrefixOnLine(
  line: DocLine,
  action: "heading" | "list" | "quote",
  remove: boolean,
): TextChangeSpec | null {
  if (action === "quote") {
    const match = line.text.match(/^(\s*)(>[ \t]?)/);
    if (remove) {
      if (!match) return null;
      const prefixStart = line.from + match[1].length;
      return { from: prefixStart, to: prefixStart + match[2].length, insert: "" };
    }
    const indent = line.text.match(/^(\s*)/)?.[1] ?? "";
    return { from: line.from + indent.length, to: line.from + indent.length, insert: "> " };
  }

  const quote = scanLeadingQuotePrefix(line.text);
  const quoteLen = quote.raw.length;
  const afterQuote = line.text.slice(quoteLen);

  if (action === "heading") {
    const match = afterQuote.match(/^([ \t]{0,3})(#{1,6}(?:[ \t]+|$))/);
    if (remove) {
      if (!match) return null;
      const prefixStart = line.from + quoteLen + match[1].length;
      return { from: prefixStart, to: prefixStart + match[2].length, insert: "" };
    }
    if (match) return null;
    const indent = afterQuote.match(/^([ \t]{0,3})/)?.[1] ?? "";
    const insertPos = line.from + quoteLen + indent.length;
    const needsQuoteSpace = quote.depth > 0 && !/[ \t]$/.test(quote.raw + indent);
    return { from: insertPos, to: insertPos, insert: needsQuoteSpace ? " ## " : "## " };
  }

  // action === "list"
  if (isThematicBreakAfterQuote(quote, afterQuote)) return null;
  const bulletMatch = afterQuote.match(/^([ \t]*)([-*+][ \t]+|[-*+]$)/);
  if (remove) {
    if (!bulletMatch) return null;
    const prefixStart = line.from + quoteLen + bulletMatch[1].length;
    return { from: prefixStart, to: prefixStart + bulletMatch[2].length, insert: "" };
  }
  if (bulletMatch) return null;
  const orderedMatch = afterQuote.match(/^([ \t]*)(\d+[.)][ \t]+)/);
  if (orderedMatch) {
    const prefixStart = line.from + quoteLen + orderedMatch[1].length;
    const needsQuoteSpace = quote.depth > 0 && !/[ \t]$/.test(quote.raw + orderedMatch[1]);
    return {
      from: prefixStart,
      to: prefixStart + orderedMatch[2].length,
      insert: needsQuoteSpace ? " - " : "- ",
    };
  }
  const indent = afterQuote.match(/^([ \t]*)/)?.[1] ?? "";
  const insertPos = line.from + quoteLen + indent.length;
  const needsQuoteSpace = quote.depth > 0 && !/[ \t]$/.test(quote.raw + indent);
  return { from: insertPos, to: insertPos, insert: needsQuoteSpace ? " - " : "- " };
}

function mapOffsetThroughChanges(pos: number, changes: TextChangeSpec[]): number {
  let delta = 0;
  for (const change of changes) {
    if (change.from > pos) break;
    if (change.to <= pos) {
      // If an insertion occurred right at `pos` (from === to === pos), move caret after inserted block prefix.
      delta += change.insert.length - (change.to - change.from);
    } else {
      // `pos` was inside a removed/replaced prefix `[change.from, change.to)`.
      return change.from + delta + change.insert.length;
    }
  }
  return pos + delta;
}

function toggleBlockFormat(
  doc: string,
  ranges: ReadonlyArray<SelectionRange>,
  action: "heading" | "list" | "quote",
  mainIndex: number,
): MarkdownEditResult {
  const lines = splitLinesWithOffsets(doc);
  const touchedIndices = new Set<number>();

  for (const range of ranges) {
    const from = Math.min(range.anchor, range.head);
    const to = Math.max(range.anchor, range.head);
    const startLine = lineIndexAt(lines, from);
    const effectiveEnd = to > from && doc[to - 1] === "\n" ? to - 1 : to;
    const endLine = Math.max(startLine, lineIndexAt(lines, effectiveEnd));
    for (let i = startLine; i <= endLine; i++) touchedIndices.add(i);
  }

  const orderedLines = [...touchedIndices].sort((a, b) => a - b).map((idx) => lines[idx]);
  const eligibleLines =
    action === "list" ? orderedLines.filter((line) => !isThematicBreakLine(line.text)) : orderedLines;
  const nonEmptyLines = eligibleLines.filter((line) => !isBlankForBlockAction(line.text, action));
  const checkPool = nonEmptyLines.length > 0 ? nonEmptyLines : eligibleLines;
  const shouldRemove = checkPool.length > 0 && checkPool.every((line) => hasBlockPrefix(line.text, action));

  const changes: TextChangeSpec[] = [];
  for (const line of eligibleLines) {
    if (!shouldRemove && orderedLines.length > 1 && isBlankForBlockAction(line.text, action)) continue;
    const change = toggleBlockPrefixOnLine(line, action, shouldRemove);
    if (change && (change.from !== change.to || change.insert.length > 0)) {
      changes.push(change);
    }
  }

  if (changes.length === 0) {
    return {
      doc,
      changes: [],
      ranges: ranges.map((r) => ({ anchor: r.anchor, head: r.head })),
      mainIndex: Math.min(Math.max(0, mainIndex), Math.max(0, ranges.length - 1)),
    };
  }

  let out = "";
  let cursor = 0;
  for (const change of changes) {
    out += doc.slice(cursor, change.from) + change.insert;
    cursor = change.to;
  }
  out += doc.slice(cursor);

  const nextRanges = ranges.map((range) => ({
    anchor: mapOffsetThroughChanges(range.anchor, changes),
    head: mapOffsetThroughChanges(range.head, changes),
  }));

  return {
    doc: out,
    changes,
    ranges: nextRanges,
    mainIndex: Math.min(Math.max(0, mainIndex), Math.max(0, nextRanges.length - 1)),
  };
}

export function toggleMarkdownFormat(
  doc: string,
  ranges: ReadonlyArray<SelectionRange>,
  action: FormatAction,
  mainIndex = 0,
): MarkdownEditResult {
  const safeRanges = ranges.length > 0 ? ranges : [{ anchor: 0, head: 0 }];
  if (action === "heading" || action === "list" || action === "quote") {
    return toggleBlockFormat(doc, safeRanges, action, mainIndex);
  }
  const plans = safeRanges.map((range) =>
    action === "link"
      ? planLinkToggle(doc, range)
      : planSymmetricInlineToggle(doc, range, action),
  );
  return buildResultFromRangePlans(doc, plans, mainIndex);
}

const PROTECTED_AST_TYPES = new Set([
  "code",
  "inlineCode",
  "html",
  "math",
  "inlineMath",
  "link",
  "linkReference",
  "image",
  "imageReference",
  "definition",
]);

const VOID_HTML_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

function isInsideTopOfFileFrontmatterEnvelope(doc: string, from: number): boolean {
  const parsed = parseFrontmatter(doc);
  if (parsed) return from < parsed.end;
  const opener = /^(?:\uFEFF)?---[ \t]*\r?\n/.exec(doc);
  if (!opener) return false;
  let lineStart = opener[0].length;
  let sawMappingKey = false;
  while (lineStart <= doc.length && lineStart <= from + 16_384) {
    const nl = doc.indexOf("\n", lineStart);
    const lineEnd = nl === -1 ? doc.length : nl;
    const contentEnd = lineEnd > lineStart && doc[lineEnd - 1] === "\r" ? lineEnd - 1 : lineEnd;
    const line = doc.slice(lineStart, contentEnd);
    if (/^(?:---|\.\.\.)[ \t]*$/.test(line)) {
      const blockEnd = nl === -1 ? doc.length : nl + 1;
      return sawMappingKey && from < blockEnd;
    }
    if (line.trim() === "") return false;
    if (/^[A-Za-z0-9_.-]+\s*:/.test(line)) sawMappingKey = true;
    if (nl === -1) break;
    lineStart = nl + 1;
  }
  return sawMappingKey && from >= opener[0].length;
}

export function isProtectedMarkdownSelection(doc: string, from: number, to: number): boolean {
  if (from >= to || from < 0 || to > doc.length) return true;
  const selected = doc.slice(from, to);
  if (!selected.trim() || /[\r\n]/.test(selected) || parseStandaloneHttpUrl(selected) !== null) {
    return true;
  }
  if (isInsideTopOfFileFrontmatterEnvelope(doc, from)) return true;

  // Inspect a bounded window around [from, to] so large notes never trigger full-file reparses.
  const radius = 16_384;
  let windowStart = Math.max(0, from - radius);
  const windowEnd = Math.min(doc.length, to + radius);
  if (windowEnd <= 500_000) {
    const maskedPrefix = maskCode(doc.slice(0, windowEnd));
    if (maskedPrefix.slice(from, to) !== selected) return true;
    if (windowStart > 0) {
      // Align windowStart to a line outside any earlier fenced/indented code block so slice never starts mid-fence.
      let lineStart = windowStart;
      while (lineStart <= from) {
        const nl = doc.indexOf("\n", lineStart);
        const lineEnd = nl === -1 ? windowEnd : nl;
        if (maskedPrefix.slice(lineStart, lineEnd).replace(/[>\s]/g, "").length > 0) {
          windowStart = lineStart;
          break;
        }
        if (nl === -1) break;
        lineStart = nl + 1;
      }
    }
  }
  const slice = doc.slice(windowStart, windowEnd);
  const localFrom = from - windowStart;
  const localTo = to - windowStart;
  if (windowEnd > 500_000 && maskCode(slice).slice(localFrom, localTo) !== selected) return true;
  const analysis = analyzeDocument(slice);
  if (windowStart === 0 && analysis.frontmatter && localFrom < analysis.frontmatter.end) return true;

  let protectedByAst = false;
  const htmlNodes: Array<{ value: string; start: number; end: number }> = [];
  visit(analysis.tree, (node: any) => {
    if (protectedByAst || !node.position) return;
    const start = node.position.start.offset;
    const end = node.position.end.offset;
    if (typeof start !== "number" || typeof end !== "number") return;
    if (PROTECTED_AST_TYPES.has(node.type) && start < localTo && end > localFrom) {
      protectedByAst = true;
      return;
    }
    if (node.type === "html" && typeof node.value === "string") {
      htmlNodes.push({ value: node.value, start, end });
    }
  });
  if (protectedByAst) return true;

  if (htmlNodes.length >= 2) {
    const openBefore: string[] = [];
    for (const item of htmlNodes) {
      if (item.end > localFrom) break;
      const closeMatch = /^<\/\s*([A-Za-z][A-Za-z0-9-]*)\s*>$/.exec(item.value.trim());
      if (closeMatch) {
        const idx = openBefore.lastIndexOf(closeMatch[1].toLowerCase());
        if (idx !== -1) openBefore.length = idx;
        continue;
      }
      const openMatch = /^<\s*([A-Za-z][A-Za-z0-9-]*)(?:\s[\s\S]*?)?>$/.exec(item.value.trim());
      if (openMatch && !item.value.trim().endsWith("/>")) {
        const tag = openMatch[1].toLowerCase();
        if (!VOID_HTML_TAGS.has(tag)) openBefore.push(tag);
      }
    }
    if (openBefore.length > 0) {
      const openSet = new Set(openBefore);
      for (const item of htmlNodes) {
        if (item.start < localTo) continue;
        const closeMatch = /^<\/\s*([A-Za-z][A-Za-z0-9-]*)\s*>$/.exec(item.value.trim());
        if (closeMatch && openSet.has(closeMatch[1].toLowerCase())) return true;
      }
    }
  }

  // Guard unclosed fences, math, inline code, HTML tags, and partial link/image syntax.
  const before = slice.slice(0, localFrom);
  const after = slice.slice(localTo);
  const lineStart = before.lastIndexOf("\n") + 1;
  const lineBefore = before.slice(lineStart);
  const nextNl = after.indexOf("\n");
  const lineAfter = nextNl === -1 ? after : after.slice(0, nextNl);

  // Unclosed display math `$$` or `\[ ... \]` / `\( ... \)`
  if (((before.match(/(?<![\\$])\$\$(?!\$)/g)?.length ?? 0) % 2) === 1) return true;
  if (before.lastIndexOf("\\(") > before.lastIndexOf("\\)") || before.lastIndexOf("\\[") > before.lastIndexOf("\\]")) {
    return true;
  }

  // Odd inline code backticks or inline `$` delimiters on the current line
  if (((lineBefore.match(/`/g)?.length ?? 0) % 2) === 1) return true;
  if (((lineBefore.match(/(?<![\\$])\$(?!\$)/g)?.length ?? 0) % 2) === 1) return true;

  // Inside an unclosed HTML tag `<tag attr="selected"`
  if (lineBefore.lastIndexOf("<") > lineBefore.lastIndexOf(">") && /^<[A-Za-z!/]/.test(lineBefore.slice(lineBefore.lastIndexOf("<")))) {
    return true;
  }

  // Inside link/image destination `[label](selected` or `![alt](selected`
  if (/!?\[[^[\]\r\n]*\]\([^)\r\n]*$/.test(lineBefore)) return true;

  // Already the bracketed label of `[selected](...)` or `![selected...`
  if (lineBefore.endsWith("[") && (lineBefore.endsWith("![") || /^\]\s*[([]/.test(lineAfter))) return true;
  if (/!\[[^[\]\r\n]*$/.test(lineBefore)) return true;

  return false;
}

/**
 * Computes `[selected text](url)` edits when pasting a standalone HTTP/HTTPS URL
 * over non-empty, unprotected Markdown selection(s). Returns `null` when plain
 * URL text should be inserted directly instead.
 */
export function applyMarkdownUrlPaste(
  doc: string,
  ranges: ReadonlyArray<SelectionRange>,
  clipboardText: string,
  mainIndex = 0,
): MarkdownEditResult | null {
  const url = parseStandaloneHttpUrl(clipboardText);
  if (!url || ranges.length === 0) return null;

  for (const range of ranges) {
    const from = Math.min(range.anchor, range.head);
    const to = Math.max(range.anchor, range.head);
    if (from === to || isProtectedMarkdownSelection(doc, from, to)) {
      return null;
    }
  }

  const escapedUrl = escapeLinkDestination(url);
  const plans: RangePlan[] = ranges.map((range) => {
    const from = Math.min(range.anchor, range.head);
    const to = Math.max(range.anchor, range.head);
    const selected = doc.slice(from, to);
    const insert = `[${escapeLinkLabel(selected)}](${escapedUrl})`;
    return {
      from,
      to,
      insert,
      selStartOffset: insert.length,
      selEndOffset: insert.length,
      reversed: false,
    };
  });

  return buildResultFromRangePlans(doc, plans, mainIndex);
}
