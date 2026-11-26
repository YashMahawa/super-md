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
    changes: changes.filter((c) => c.insert !== doc.slice(c.from, c.to)),
    ranges: nextRanges,
    mainIndex: Math.min(Math.max(0, mainIndex), Math.max(0, nextRanges.length - 1)),
  };
}

function maxConsecutiveChars(text: string, ch: string): number {
  let max = 0;
  let run = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === ch) {
      run++;
      if (run > max) max = run;
    } else {
      run = 0;
    }
  }
  return max;
}

function noopRangePlan(doc: string, range: SelectionRange): RangePlan {
  const from = Math.min(range.anchor, range.head);
  const to = Math.max(range.anchor, range.head);
  const reversed = range.anchor > range.head;
  const selected = doc.slice(from, to);
  return {
    from,
    to,
    insert: selected,
    selStartOffset: 0,
    selEndOffset: selected.length,
    reversed,
  };
}

function planSymmetricInlineToggle(
  doc: string,
  range: SelectionRange,
  action: "bold" | "italic" | "inline_code" | "inline_math",
): RangePlan {
  const from = Math.min(range.anchor, range.head);
  const to = Math.max(range.anchor, range.head);
  const reversed = range.anchor > range.head;
  const selected = doc.slice(from, to);

  if (action === "bold") {
    const outerStars = Math.min(countCharsLeft(doc, from, "*", 3), countCharsRight(doc, to, "*", 3));
    const outerUnderscores = Math.min(countCharsLeft(doc, from, "_", 3), countCharsRight(doc, to, "_", 3));
    if (outerStars >= 2 || outerUnderscores >= 2) {
      return {
        from: from - 2,
        to: to + 2,
        insert: selected,
        selStartOffset: 0,
        selEndOffset: selected.length,
        reversed,
      };
    }
    if (selected.length >= 4) {
      const innerStars = Math.min(countLeadingChars(selected, "*", 3), countTrailingChars(selected, "*", 3));
      const innerUnderscores = Math.min(countLeadingChars(selected, "_", 3), countTrailingChars(selected, "_", 3));
      if (innerStars >= 2 || innerUnderscores >= 2) {
        const inner = selected.slice(2, selected.length - 2);
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
    const wrapped = `**${selected}**`;
    return {
      from,
      to,
      insert: wrapped,
      selStartOffset: 2,
      selEndOffset: 2 + selected.length,
      reversed,
    };
  }

  if (action === "italic") {
    const outerStars = Math.min(countCharsLeft(doc, from, "*", 3), countCharsRight(doc, to, "*", 3));
    const outerUnderscores = Math.min(countCharsLeft(doc, from, "_", 3), countCharsRight(doc, to, "_", 3));
    if (outerStars === 1 || outerStars === 3 || outerUnderscores === 1 || outerUnderscores === 3) {
      return {
        from: from - 1,
        to: to + 1,
        insert: selected,
        selStartOffset: 0,
        selEndOffset: selected.length,
        reversed,
      };
    }
    if (selected.length >= 2) {
      const innerStars = Math.min(countLeadingChars(selected, "*", 3), countTrailingChars(selected, "*", 3));
      const innerUnderscores = Math.min(countLeadingChars(selected, "_", 3), countTrailingChars(selected, "_", 3));
      if (innerStars === 1 || innerStars === 3 || innerUnderscores === 1 || innerUnderscores === 3) {
        const inner = selected.slice(1, selected.length - 1);
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
    const wrapped = `*${selected}*`;
    return {
      from,
      to,
      insert: wrapped,
      selStartOffset: 1,
      selEndOffset: 1 + selected.length,
      reversed,
    };
  }

  if (action === "inline_code") {
    const outerTicks = Math.min(countCharsLeft(doc, from, "`", 6), countCharsRight(doc, to, "`", 6));
    if (outerTicks >= 1) {
      return {
        from: from - outerTicks,
        to: to + outerTicks,
        insert: selected,
        selStartOffset: 0,
        selEndOffset: selected.length,
        reversed,
      };
    }
    if (selected.length >= 2) {
      const innerTicks = Math.min(countLeadingChars(selected, "`", 6), countTrailingChars(selected, "`", 6));
      if (innerTicks >= 1 && selected.length >= innerTicks * 2) {
        let inner = selected.slice(innerTicks, selected.length - innerTicks);
        if (innerTicks >= 2 && inner.startsWith(" ") && inner.endsWith(" ") && inner.length >= 2) {
          inner = inner.slice(1, -1);
        }
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
    if (selected.includes("`")) {
      const fence = "`".repeat(maxConsecutiveChars(selected, "`") + 1);
      const wrapped = `${fence} ${selected} ${fence}`;
      const padLen = fence.length + 1;
      return {
        from,
        to,
        insert: wrapped,
        selStartOffset: padLen,
        selEndOffset: padLen + selected.length,
        reversed,
      };
    }
    const wrapped = `\`${selected}\``;
    return {
      from,
      to,
      insert: wrapped,
      selStartOffset: 1,
      selEndOffset: 1 + selected.length,
      reversed,
    };
  }

  // inline_math ("$")
  const outerDollars = Math.min(countCharsLeft(doc, from, "$", 3), countCharsRight(doc, to, "$", 3));
  if (outerDollars === 1) {
    return {
      from: from - 1,
      to: to + 1,
      insert: selected,
      selStartOffset: 0,
      selEndOffset: selected.length,
      reversed,
    };
  }
  if (selected.length >= 2) {
    const innerDollars = Math.min(countLeadingChars(selected, "$", 3), countTrailingChars(selected, "$", 3));
    if (innerDollars === 1) {
      const inner = selected.slice(1, selected.length - 1);
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
  const wrapped = `$${selected}$`;
  return {
    from,
    to,
    insert: wrapped,
    selStartOffset: 1,
    selEndOffset: 1 + selected.length,
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
      lines.push({ index, from: start, to: doc.length, text: doc.slice(start) });
      break;
    }
    lines.push({ index, from: start, to: nl, text: doc.slice(start, nl) });
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

function hasBlockPrefix(line: string, action: "heading" | "list" | "quote"): boolean {
  if (action === "heading") return /^(\s{0,3})#{1,6}(?:[ \t]+|$)/.test(line);
  if (action === "quote") return /^(\s*)>[ \t]?/.test(line);
  // list: `- item`, `* item`, `+ item`, or an empty list marker `- ` / `-` (not `---` or `**bold**`)
  return /^(\s*)[-*+][ \t]+/.test(line) || /^(\s*)[-*+]$/.test(line);
}

function toggleBlockPrefixOnLine(
  line: DocLine,
  action: "heading" | "list" | "quote",
  remove: boolean,
): TextChangeSpec | null {
  if (action === "heading") {
    const match = line.text.match(/^(\s{0,3})(#{1,6}(?:[ \t]+|$))/);
    if (remove) {
      if (!match) return null;
      const prefixStart = line.from + match[1].length;
      return { from: prefixStart, to: prefixStart + match[2].length, insert: "" };
    }
    const indent = line.text.match(/^(\s{0,3})/)?.[1] ?? "";
    if (match) return null;
    return { from: line.from + indent.length, to: line.from + indent.length, insert: "## " };
  }

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

  // action === "list"
  const bulletMatch = line.text.match(/^(\s*)([-*+][ \t]+|[-*+]$)/);
  if (remove) {
    if (!bulletMatch) return null;
    const prefixStart = line.from + bulletMatch[1].length;
    return { from: prefixStart, to: prefixStart + bulletMatch[2].length, insert: "" };
  }
  if (bulletMatch) return null;
  const orderedMatch = line.text.match(/^(\s*)(\d+\.[ \t]+)/);
  if (orderedMatch) {
    const prefixStart = line.from + orderedMatch[1].length;
    return { from: prefixStart, to: prefixStart + orderedMatch[2].length, insert: "- " };
  }
  const indent = line.text.match(/^(\s*)/)?.[1] ?? "";
  return { from: line.from + indent.length, to: line.from + indent.length, insert: "- " };
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

function getTopOfFileFrontmatterEnd(doc: string): number {
  const parsed = parseFrontmatter(doc);
  if (parsed && parsed.end > 0) return parsed.end;
  const opener = /^(?:\uFEFF)?---[ \t]*\r?\n/.exec(doc);
  if (!opener) return 0;
  let lineStart = opener[0].length;
  let sawMappingKey = false;
  while (lineStart <= doc.length && lineStart <= 65_536) {
    const nl = doc.indexOf("\n", lineStart);
    const lineEnd = nl === -1 ? doc.length : nl;
    const contentEnd = lineEnd > lineStart && doc[lineEnd - 1] === "\r" ? lineEnd - 1 : lineEnd;
    const line = doc.slice(lineStart, contentEnd);
    if (/^(?:---|\.\.\.)[ \t]*$/.test(line)) {
      return sawMappingKey ? (nl === -1 ? doc.length : nl + 1) : 0;
    }
    if (line.trim() === "") return 0;
    if (/^[A-Za-z0-9_.-]+\s*:/.test(line)) sawMappingKey = true;
    if (nl === -1) break;
    lineStart = nl + 1;
  }
  return sawMappingKey ? doc.length : 0;
}

function toggleBlockFormat(
  doc: string,
  ranges: ReadonlyArray<SelectionRange>,
  action: "heading" | "list" | "quote",
  mainIndex: number,
): MarkdownEditResult {
  const frontmatterEnd = getTopOfFileFrontmatterEnd(doc);
  const lines = splitLinesWithOffsets(doc);
  const touchedIndices = new Set<number>();

  for (const range of ranges) {
    const from = Math.min(range.anchor, range.head);
    const to = Math.max(range.anchor, range.head);
    if (frontmatterEnd > 0 && from < frontmatterEnd) continue;
    const startLine = lineIndexAt(lines, from);
    const effectiveEnd = to > from && doc[to - 1] === "\n" ? to - 1 : to;
    const endLine = Math.max(startLine, lineIndexAt(lines, effectiveEnd));
    for (let i = startLine; i <= endLine; i++) touchedIndices.add(i);
  }

  const orderedLines = [...touchedIndices].sort((a, b) => a - b).map((idx) => lines[idx]);
  const nonEmptyLines = orderedLines.filter((line) => line.text.trim().length > 0);
  const checkPool = nonEmptyLines.length > 0 ? nonEmptyLines : orderedLines;
  const shouldRemove = checkPool.length > 0 && checkPool.every((line) => hasBlockPrefix(line.text, action));

  const changes: TextChangeSpec[] = [];
  for (const line of orderedLines) {
    if (!shouldRemove && orderedLines.length > 1 && line.text.trim().length === 0) continue;
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

type InlineSpanKind =
  | "strong"
  | "emphasis"
  | "delete"
  | "inlineCode"
  | "inlineMath"
  | "link"
  | "linkReference"
  | "wikilink"
  | "autolink"
  | "image"
  | "imageReference"
  | "html"
  | "highlight"
  | "subscript"
  | "superscript";

interface InlineSpanBounds {
  kind: InlineSpanKind;
  outerStart: number;
  innerStart: number;
  innerEnd: number;
  outerEnd: number;
  linkDest?: string;
}

interface InlineFormattingContext {
  inProtectedBlock: boolean;
  crossesBlocks: boolean;
  inUnclosedConstruct: boolean;
  spans: InlineSpanBounds[];
}

function computeInlineCodeBounds(doc: string, outerStart: number, outerEnd: number, value: string): [number, number] {
  const raw = doc.slice(outerStart, outerEnd);
  let ticks = 0;
  while (ticks < raw.length && raw[ticks] === "`") ticks++;
  if (ticks === 0 || ticks * 2 > raw.length) return [outerStart, outerEnd];
  const innerRaw = raw.slice(ticks, raw.length - ticks);
  if (
    innerRaw.length === value.length + 2 &&
    innerRaw.startsWith(" ") &&
    innerRaw.endsWith(" ") &&
    innerRaw.slice(1, -1) === value
  ) {
    return [outerStart + ticks + 1, outerEnd - ticks - 1];
  }
  if (innerRaw.length === value.length) {
    return [outerStart + ticks, outerEnd - ticks];
  }
  const idx = raw.indexOf(value, ticks);
  if (idx >= 0) return [outerStart + idx, outerStart + idx + value.length];
  return [outerStart + ticks, Math.max(outerStart + ticks, outerEnd - ticks)];
}

function computeInlineMathBounds(doc: string, outerStart: number, outerEnd: number): [number, number] {
  const raw = doc.slice(outerStart, outerEnd);
  if ((raw.startsWith("\\(") && raw.endsWith("\\)")) || (raw.startsWith("$$") && raw.endsWith("$$"))) {
    return raw.length >= 4 ? [outerStart + 2, outerEnd - 2] : [outerStart, outerEnd];
  }
  if (raw.startsWith("$") && raw.endsWith("$") && raw.length >= 2) {
    return [outerStart + 1, outerEnd - 1];
  }
  return [outerStart, outerEnd];
}

function advanceTextOffset(raw: string, value: string): number {
  if (raw.startsWith(value)) return value.length;
  let r = 0;
  let v = 0;
  while (v < value.length && r < raw.length) {
    const vCh = value[v];
    const rCh = raw[r];
    if (vCh === "\n" && (rCh === "\r" || rCh === "\n")) {
      if (raw[r] === "\r" && raw[r + 1] === "\n") r += 2;
      else r += 1;
      const nextValueChar = v + 1 < value.length ? value[v + 1] : "";
      while (r < raw.length && (raw[r] === " " || raw[r] === "\t" || raw[r] === ">")) {
        if (nextValueChar && raw[r] === nextValueChar && raw.slice(r, r + 4) === value.slice(v + 1, v + 5)) {
          break;
        }
        r++;
      }
      v++;
      continue;
    }
    if (rCh === "\\" && r + 1 < raw.length && raw[r + 1] === vCh) {
      r += 2;
      v++;
      continue;
    }
    if (rCh === "&") {
      const entity = /^&(?:#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/.exec(raw.slice(r));
      if (entity && rCh !== vCh) {
        const cp = value.codePointAt(v) ?? 0;
        r += entity[0].length;
        v += cp > 0xffff ? 2 : 1;
        continue;
      }
    }
    r++;
    v++;
  }
  return r;
}

function collectContainerInlineSpans(
  containerNode: any,
  doc: string,
  windowOffset: number,
  spans: InlineSpanBounds[],
): void {
  const cStart = windowOffset + containerNode.position.start.offset;
  const cEnd = windowOffset + containerNode.position.end.offset;
  let cursor = cStart;
  if (typeof containerNode.children?.[0]?.position?.start?.offset === "number") {
    cursor = windowOffset + containerNode.children[0].position.start.offset;
  } else {
    const raw = doc.slice(cStart, cEnd);
    if (containerNode.type === "heading") {
      const prefix = /^[ \t]{0,3}#{1,6}[ \t]+/.exec(raw);
      if (prefix) cursor = cStart + prefix[0].length;
    } else if (containerNode.type === "tableCell") {
      const lead = /^\|?[ \t]*/.exec(raw);
      if (lead) cursor = cStart + lead[0].length;
    } else if (containerNode.type === "paragraph") {
      const quoteLead = /^[ \t>]+/.exec(raw);
      if (quoteLead) cursor = cStart + quoteLead[0].length;
    }
  }

  const openHtmlStack: Array<{ tag: string; outerStart: number; innerStart: number }> = [];

  const walk = (nodes: any[], limitEnd: number) => {
    for (const node of nodes) {
      if (!node) continue;
      const start = typeof node.position?.start?.offset === "number" ? windowOffset + node.position.start.offset : undefined;
      const end = typeof node.position?.end?.offset === "number" ? windowOffset + node.position.end.offset : undefined;

      if (node.type === "text" && typeof node.value === "string") {
        if (typeof start === "number" && typeof end === "number") {
          cursor = end;
        } else {
          cursor += advanceTextOffset(doc.slice(cursor, limitEnd), node.value);
        }
        continue;
      }

      if (node.type === "inlineCode" && typeof node.value === "string" && typeof start === "number" && typeof end === "number") {
        const [innerStart, innerEnd] = computeInlineCodeBounds(doc, start, end, node.value);
        spans.push({ kind: "inlineCode", outerStart: start, innerStart, innerEnd, outerEnd: end });
        cursor = end;
        continue;
      }

      if (node.type === "inlineMath" && typeof start === "number" && typeof end === "number") {
        const [innerStart, innerEnd] = computeInlineMathBounds(doc, start, end);
        spans.push({ kind: "inlineMath", outerStart: start, innerStart, innerEnd, outerEnd: end });
        cursor = end;
        continue;
      }

      if ((node.type === "image" || node.type === "imageReference") && typeof start === "number" && typeof end === "number") {
        spans.push({ kind: node.type, outerStart: start, innerStart: start, innerEnd: end, outerEnd: end });
        cursor = end;
        continue;
      }

      if (node.type === "html" && typeof node.value === "string" && typeof start === "number" && typeof end === "number") {
        spans.push({ kind: "html", outerStart: start, innerStart: start, innerEnd: end, outerEnd: end });
        const trimmed = node.value.trim();
        const closeMatch = /^<\/\s*([A-Za-z][A-Za-z0-9-]*)\s*>$/.exec(trimmed);
        if (closeMatch) {
          const tag = closeMatch[1].toLowerCase();
          for (let i = openHtmlStack.length - 1; i >= 0; i--) {
            if (openHtmlStack[i].tag === tag) {
              const open = openHtmlStack.splice(i)[0];
              spans.push({
                kind: "html",
                outerStart: open.outerStart,
                innerStart: open.innerStart,
                innerEnd: start,
                outerEnd: end,
              });
              break;
            }
          }
        } else {
          const openMatch = /^<\s*([A-Za-z][A-Za-z0-9-]*)(?:\s[\s\S]*?)?>$/.exec(trimmed);
          if (openMatch && !trimmed.endsWith("/>")) {
            const tag = openMatch[1].toLowerCase();
            if (!VOID_HTML_TAGS.has(tag)) {
              openHtmlStack.push({ tag, outerStart: start, innerStart: end });
            }
          }
        }
        cursor = end;
        continue;
      }

      if (node.type === "link" && typeof start === "number" && typeof end === "number") {
        const raw = doc.slice(start, end);
        if (raw.startsWith("[[") && raw.endsWith("]]") && raw.length >= 4) {
          spans.push({ kind: "wikilink", outerStart: start, innerStart: start + 2, innerEnd: end - 2, outerEnd: end });
          cursor = end;
          continue;
        }
        if (raw.startsWith("<") && raw.endsWith(">")) {
          spans.push({ kind: "autolink", outerStart: start, innerStart: start + 1, innerEnd: end - 1, outerEnd: end });
          cursor = end;
          continue;
        }
        const innerStart = start + 1;
        let lastChildEnd = innerStart;
        if (Array.isArray(node.children)) {
          cursor = innerStart;
          walk(node.children, end);
          lastChildEnd = Math.max(innerStart, cursor);
        }
        const closeBracket = doc.indexOf("](", lastChildEnd);
        const innerEnd = closeBracket >= innerStart && closeBracket < end ? closeBracket : Math.max(innerStart, end - 3);
        const destSlice = closeBracket >= innerStart && end > closeBracket + 2 ? doc.slice(closeBracket + 2, end - 1) : "";
        spans.push({
          kind: "link",
          outerStart: start,
          innerStart,
          innerEnd,
          outerEnd: end,
          linkDest: destSlice,
        });
        cursor = end;
        continue;
      }

      if (node.type === "linkReference" && typeof start === "number" && typeof end === "number") {
        const innerStart = start + 1;
        if (Array.isArray(node.children)) {
          cursor = innerStart;
          walk(node.children, end);
        }
        const closeBracket = doc.indexOf("]", Math.max(innerStart, cursor));
        const innerEnd = closeBracket >= innerStart && closeBracket < end ? closeBracket : end - 1;
        spans.push({ kind: "linkReference", outerStart: start, innerStart, innerEnd, outerEnd: end });
        cursor = end;
        continue;
      }

      if ((node.type === "highlight" || node.type === "subscript" || node.type === "superscript") && Array.isArray(node.children)) {
        const delim = node.type === "highlight" ? "==" : node.type === "subscript" ? "~" : "^";
        if (!doc.startsWith(delim, cursor)) {
          const found = doc.indexOf(delim, cursor);
          if (found >= cursor && found < limitEnd) cursor = found;
        }
        const outerStart = cursor;
        const innerStart = doc.startsWith(delim, cursor) ? cursor + delim.length : cursor;
        cursor = innerStart;
        walk(node.children, limitEnd);
        const innerEnd = cursor;
        const outerEnd = doc.startsWith(delim, innerEnd) ? innerEnd + delim.length : innerEnd;
        cursor = outerEnd;
        spans.push({ kind: node.type, outerStart, innerStart, innerEnd, outerEnd });
        continue;
      }

      if ((node.type === "strong" || node.type === "emphasis" || node.type === "delete") && typeof start === "number" && typeof end === "number") {
        const raw = doc.slice(start, end);
        let delimLen = 1;
        if (node.type === "strong") delimLen = 2;
        else if (node.type === "delete") {
          delimLen = 0;
          while (delimLen < raw.length && raw[delimLen] === "~") delimLen++;
          if (delimLen === 0) delimLen = 2;
        }
        const innerStart = start + delimLen;
        const innerEnd = Math.max(innerStart, end - delimLen);
        cursor = innerStart;
        if (Array.isArray(node.children)) {
          walk(node.children, innerEnd);
        }
        spans.push({ kind: node.type, outerStart: start, innerStart, innerEnd, outerEnd: end });
        cursor = end;
        continue;
      }

      if (Array.isArray(node.children)) {
        walk(node.children, typeof end === "number" ? end : limitEnd);
        if (typeof end === "number") cursor = end;
      }
    }
  };

  if (Array.isArray(containerNode.children)) {
    walk(containerNode.children, cEnd);
  }
}

function inspectInlineFormattingContext(doc: string, from: number, to: number): InlineFormattingContext {
  const radius = 16_384;
  let windowStart = Math.max(0, from - radius);
  const windowEnd = Math.min(doc.length, to + radius);

  if (windowStart > 0 && windowEnd <= 500_000) {
    // Align windowStart to a line outside any earlier fenced/indented code block so slice never starts mid-fence.
    const maskedPrefix = maskCode(doc.slice(0, windowEnd));
    let scan = windowStart;
    let foundUnmaskedLine = false;
    while (scan <= from) {
      const nl = doc.indexOf("\n", scan);
      const end = nl === -1 ? windowEnd : nl;
      if (maskedPrefix.slice(scan, end).replace(/[>\s]/g, "").length > 0) {
        windowStart = scan;
        foundUnmaskedLine = true;
        break;
      }
      if (nl === -1) break;
      scan = nl + 1;
    }
    if (!foundUnmaskedLine) {
      // Every line in [windowStart, from] was blank or masked as code; check if `from` is inside a multi-16KB code block.
      const fullAnalysis = analyzeDocument(doc.slice(0, windowEnd));
      let insideLargeCode = false;
      visit(fullAnalysis.tree, "code", (node: any) => {
        if (insideLargeCode || !node.position) return;
        const start = node.position.start.offset;
        const end = node.position.end.offset;
        if (from === to ? from >= start && from <= end : start < to && end > from) {
          insideLargeCode = true;
        }
      });
      if (insideLargeCode) {
        return { inProtectedBlock: true, crossesBlocks: false, inUnclosedConstruct: false, spans: [] };
      }
    }
  }

  const slice = doc.slice(windowStart, windowEnd);
  const maskedSlice = maskCode(slice);
  const localFrom = from - windowStart;
  const localTo = to - windowStart;

  const isEmptyInlineMathPair =
    localFrom === localTo &&
    countCharsLeft(slice, localFrom, "$", 3) === 1 &&
    countCharsRight(slice, localTo, "$", 3) === 1;

  const analysis = analyzeDocument(slice);
  if (windowStart === 0 && analysis.frontmatter && localFrom < analysis.frontmatter.end) {
    return { inProtectedBlock: true, crossesBlocks: false, inUnclosedConstruct: false, spans: [] };
  }

  let inProtectedBlock = false;
  const overlappingContainers: any[] = [];
  visit(analysis.tree, (node: any) => {
    if (inProtectedBlock || !node.position) return;
    const start = node.position.start.offset;
    const end = node.position.end.offset;
    if (typeof start !== "number" || typeof end !== "number") return;
    if (node.type === "code" || node.type === "definition") {
      if (localFrom === localTo ? localFrom >= start && localFrom <= end : start < localTo && end > localFrom) {
        inProtectedBlock = true;
        return;
      }
    }
    if (node.type === "math") {
      if (isEmptyInlineMathPair && end - start === 2 && start === localFrom - 1 && end === localTo + 1) {
        return;
      }
      if (localFrom === localTo ? localFrom >= start && localFrom <= end : start < localTo && end > localFrom) {
        inProtectedBlock = true;
        return;
      }
    }
    if (node.type === "paragraph" || node.type === "heading" || node.type === "tableCell") {
      const overlaps = localFrom === localTo ? localFrom >= start && localFrom <= end : start < localTo && end > localFrom;
      if (overlaps) overlappingContainers.push(node);
    }
  });

  if (inProtectedBlock) {
    return { inProtectedBlock: true, crossesBlocks: false, inUnclosedConstruct: false, spans: [] };
  }

  // Top-level raw HTML blocks
  for (const child of analysis.tree.children as any[]) {
    if (child?.type === "html" && child.position) {
      const start = child.position.start.offset;
      const end = child.position.end.offset;
      if (localFrom === localTo ? localFrom >= start && localFrom <= end : start < localTo && end > localFrom) {
        return { inProtectedBlock: true, crossesBlocks: false, inUnclosedConstruct: false, spans: [] };
      }
    }
  }

  if (localFrom < localTo) {
    if (overlappingContainers.length > 1) {
      return { inProtectedBlock: false, crossesBlocks: true, inUnclosedConstruct: false, spans: [] };
    }
    if (overlappingContainers.length === 1) {
      const c = overlappingContainers[0];
      const cStart = c.position.start.offset;
      const cEnd = c.position.end.offset;
      if (localFrom < cStart || localTo > cEnd) {
        return { inProtectedBlock: false, crossesBlocks: true, inUnclosedConstruct: false, spans: [] };
      }
    } else if (/[\r\n]/.test(slice.slice(localFrom, localTo))) {
      return { inProtectedBlock: false, crossesBlocks: true, inUnclosedConstruct: false, spans: [] };
    }
  }

  const spans: InlineSpanBounds[] = [];
  for (const container of overlappingContainers) {
    collectContainerInlineSpans(container, doc, windowStart, spans);
  }

  const maskedBefore = maskedSlice.slice(0, localFrom);
  if (((maskedBefore.match(/(?<![\\$])\$\$(?!\$)/g)?.length ?? 0) % 2) === 1) {
    return { inProtectedBlock: true, crossesBlocks: false, inUnclosedConstruct: false, spans };
  }
  if (maskedBefore.lastIndexOf("\\[") > maskedBefore.lastIndexOf("\\]")) {
    return { inProtectedBlock: true, crossesBlocks: false, inUnclosedConstruct: false, spans };
  }

  const before = slice.slice(0, localFrom);
  const lineStart = before.lastIndexOf("\n") + 1;
  const lineBefore = before.slice(lineStart);
  const after = slice.slice(localTo);
  const nextNl = after.indexOf("\n");
  const lineAfter = nextNl === -1 ? after : after.slice(0, nextNl);

  let inUnclosedConstruct = false;
  if (before.lastIndexOf("\\(") > before.lastIndexOf("\\)")) {
    inUnclosedConstruct = true;
  } else if (
    lineBefore.lastIndexOf("<") > lineBefore.lastIndexOf(">") &&
    /^<[A-Za-z!/]/.test(lineBefore.slice(lineBefore.lastIndexOf("<")))
  ) {
    inUnclosedConstruct = true;
  } else if (/!\[[^[\]\r\n]*$/.test(lineBefore)) {
    inUnclosedConstruct = true;
  } else if (/!?\[[^[\]\r\n]*\]\([^)\r\n]*$/.test(lineBefore) && !/^[^)\r\n]*\)/.test(lineAfter)) {
    inUnclosedConstruct = true;
  } else if (lineBefore.lastIndexOf("[[") > lineBefore.lastIndexOf("]]") && !/^[^[\]\r\n]*\]\]/.test(lineAfter)) {
    inUnclosedConstruct = true;
  } else {
    // Check unclosed inline backticks or single `$` when not just an empty `|` or `$|$` placeholder
    const oddTicksBefore = ((lineBefore.match(/`/g)?.length ?? 0) % 2) === 1;
    if (oddTicksBefore && !(localFrom === localTo && lineBefore.endsWith("`") && lineAfter.startsWith("`") && !spans.some((s) => s.kind === "inlineCode" && s.outerStart < from && from < s.outerEnd))) {
      if (!spans.some((s) => s.kind === "inlineCode" && s.outerStart <= from && to <= s.outerEnd)) {
        inUnclosedConstruct = true;
      }
    }
    const oddDollarsBefore = ((lineBefore.match(/(?<![\\$])\$(?!\$)/g)?.length ?? 0) % 2) === 1;
    if (oddDollarsBefore && !(localFrom === localTo && lineBefore.endsWith("$") && lineAfter.startsWith("$") && !spans.some((s) => s.kind === "inlineMath" && s.outerStart < from && from < s.outerEnd))) {
      if (!spans.some((s) => s.kind === "inlineMath" && s.outerStart <= from && to <= s.outerEnd)) {
        inUnclosedConstruct = true;
      }
    }
  }

  return { inProtectedBlock: false, crossesBlocks: false, inUnclosedConstruct, spans };
}

function unwrapSpanPlan(
  doc: string,
  span: InlineSpanBounds,
  from: number,
  to: number,
  reversed: boolean,
): RangePlan {
  const inner = doc.slice(span.innerStart, span.innerEnd);
  const fullSelected =
    (from === span.outerStart && to === span.outerEnd) ||
    (from === span.innerStart && to === span.innerEnd);
  if (fullSelected) {
    return {
      from: span.outerStart,
      to: span.outerEnd,
      insert: inner,
      selStartOffset: 0,
      selEndOffset: inner.length,
      reversed,
    };
  }
  const relStart = Math.max(0, Math.min(inner.length, from - span.innerStart));
  const relEnd = Math.max(relStart, Math.min(inner.length, to - span.innerStart));
  return {
    from: span.outerStart,
    to: span.outerEnd,
    insert: inner,
    selStartOffset: relStart,
    selEndOffset: relEnd,
    reversed,
  };
}

function planInlineFormatToggle(
  doc: string,
  range: SelectionRange,
  action: "bold" | "italic" | "inline_code" | "inline_math" | "link",
): RangePlan {
  const from = Math.min(range.anchor, range.head);
  const to = Math.max(range.anchor, range.head);
  const reversed = range.anchor > range.head;
  const selected = doc.slice(from, to);

  if (from < 0 || to > doc.length) {
    return noopRangePlan(doc, range);
  }

  const frontmatterEnd = getTopOfFileFrontmatterEnd(doc);
  if (frontmatterEnd > 0 && from < frontmatterEnd) {
    return noopRangePlan(doc, range);
  }

  if (from < to && /\r?\n[ \t]*\r?\n/.test(selected)) {
    return noopRangePlan(doc, range);
  }

  const ctx = inspectInlineFormattingContext(doc, from, to);
  if (ctx.inProtectedBlock || ctx.crossesBlocks) {
    return noopRangePlan(doc, range);
  }
  if (
    action !== "inline_math" &&
    from === to &&
    countCharsLeft(doc, from, "$", 3) === 1 &&
    countCharsRight(doc, to, "$", 3) === 1
  ) {
    return noopRangePlan(doc, range);
  }

  const enclosing = ctx.spans
    .filter((s) => (from === to ? s.outerStart < from && from < s.outerEnd : s.outerStart <= from && to <= s.outerEnd))
    .sort((a, b) => (a.outerEnd - a.outerStart) - (b.outerEnd - b.outerStart));

  for (const span of enclosing) {
    if (span.kind === "inlineCode") {
      return action === "inline_code" ? unwrapSpanPlan(doc, span, from, to, reversed) : noopRangePlan(doc, range);
    }
    if (span.kind === "inlineMath") {
      const isSingleDollar =
        span.innerStart - span.outerStart === 1 &&
        doc[span.outerStart] === "$" &&
        doc[span.outerEnd - 1] === "$";
      return action === "inline_math" && isSingleDollar
        ? unwrapSpanPlan(doc, span, from, to, reversed)
        : noopRangePlan(doc, range);
    }
    if (
      span.kind === "html" ||
      span.kind === "image" ||
      span.kind === "imageReference" ||
      span.kind === "wikilink" ||
      span.kind === "autolink"
    ) {
      return noopRangePlan(doc, range);
    }
    if (span.kind === "link") {
      if (action === "link") {
        const label = doc.slice(span.innerStart, span.innerEnd);
        const dest = span.linkDest ?? "";
        const restored = label.length > 0 ? label : dest;
        if (
          label.length > 0 &&
          span.innerStart <= from &&
          to <= span.innerEnd &&
          !(from === span.innerStart && to === span.innerEnd)
        ) {
          return {
            from: span.outerStart,
            to: span.outerEnd,
            insert: restored,
            selStartOffset: from - span.innerStart,
            selEndOffset: to - span.innerStart,
            reversed,
          };
        }
        return {
          from: span.outerStart,
          to: span.outerEnd,
          insert: restored,
          selStartOffset: 0,
          selEndOffset: restored.length,
          reversed: from === span.outerStart && to === span.outerEnd ? reversed : false,
        };
      }
      if (!(span.innerStart <= from && to <= span.innerEnd) || from === to) {
        return noopRangePlan(doc, range);
      }
    }
  }

  if (action === "bold") {
    const targetStrong = enclosing.find((s) => s.kind === "strong");
    if (targetStrong) {
      return unwrapSpanPlan(doc, targetStrong, from, to, reversed);
    }
  }
  if (action === "italic") {
    const targetEmphasis = enclosing.find((s) => s.kind === "emphasis");
    if (targetEmphasis) {
      return unwrapSpanPlan(doc, targetEmphasis, from, to, reversed);
    }
  }

  if (from === to && enclosing.length > 0) {
    // Bare caret inside an already-formatted span (e.g. `**hel|lo**` + italic): never split the span.
    return noopRangePlan(doc, range);
  }

  if (ctx.inUnclosedConstruct) {
    return noopRangePlan(doc, range);
  }

  if (from < to) {
    for (const span of ctx.spans) {
      if (from >= span.outerEnd || to <= span.outerStart) continue;
      if (span.outerStart <= from && to <= span.outerEnd) {
        if (!(span.innerStart <= from && to <= span.innerEnd)) {
          return noopRangePlan(doc, range);
        }
        continue;
      }
      if (!(from <= span.outerStart && span.outerEnd <= to)) {
        // Selection partially straddles a formatted or protected span boundary.
        return noopRangePlan(doc, range);
      }
      if (
        (action === "bold" && span.kind === "strong") ||
        (action === "italic" && span.kind === "emphasis") ||
        (action === "inline_code" && span.kind === "inlineCode") ||
        (action === "inline_math" && (span.kind === "inlineMath" || span.kind === "inlineCode")) ||
        (action === "link" &&
          (span.kind === "link" ||
            span.kind === "linkReference" ||
            span.kind === "wikilink" ||
            span.kind === "autolink" ||
            span.kind === "image" ||
            span.kind === "imageReference"))
      ) {
        return noopRangePlan(doc, range);
      }
    }
  } else {
    // Prevent bare-caret delimiter insertion right against an existing delimiter run of the same marker family.
    if (action === "bold" || action === "italic") {
      const outerStars = Math.min(countCharsLeft(doc, from, "*", 3), countCharsRight(doc, to, "*", 3));
      const outerUnderscores = Math.min(countCharsLeft(doc, from, "_", 3), countCharsRight(doc, to, "_", 3));
      const unwrappingEmptyMarker =
        action === "bold"
          ? outerStars >= 2 || outerUnderscores >= 2
          : outerStars === 1 || outerStars === 3 || outerUnderscores === 1 || outerUnderscores === 3;
      if (
        !unwrappingEmptyMarker &&
        ctx.spans.some(
          (s) => (s.kind === "strong" || s.kind === "emphasis") && (s.outerStart === from || s.outerEnd === from),
        )
      ) {
        return noopRangePlan(doc, range);
      }
    } else if (action === "inline_code") {
      const outerTicks = Math.min(countCharsLeft(doc, from, "`", 6), countCharsRight(doc, to, "`", 6));
      if (
        outerTicks === 0 &&
        ctx.spans.some((s) => s.kind === "inlineCode" && (s.outerStart === from || s.outerEnd === from))
      ) {
        return noopRangePlan(doc, range);
      }
    } else if (action === "inline_math") {
      const outerDollars = Math.min(countCharsLeft(doc, from, "$", 3), countCharsRight(doc, to, "$", 3));
      if (
        outerDollars !== 1 &&
        ctx.spans.some((s) => s.kind === "inlineMath" && (s.outerStart === from || s.outerEnd === from))
      ) {
        return noopRangePlan(doc, range);
      }
    }
  }

  return action === "link"
    ? planLinkToggle(doc, range)
    : planSymmetricInlineToggle(doc, range, action);
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
  const plans = safeRanges.map((range) => planInlineFormatToggle(doc, range, action));
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
