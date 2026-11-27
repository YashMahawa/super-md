import { visit } from "unist-util-visit";
import { remarkCallouts } from "./components/MarkdownPreview";
import { analyzeDocument, type SourceDocumentAnalysis } from "./documentAnalysis";
import { toggleMarkdownFormat, type FormatAction, type MarkdownEditResult } from "./markdownFormatting";
import { normalizeMarkdownSource } from "./markdownSource";
import { parseOriginalWikilinkSlice } from "./workspaceLinks";

export interface LiveEditingSpanContext {
  baseMarkdown: string;
  baseSplitEnd: number;
}

export type InlineSpanKind =
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
  | "superscript"
  | "inline";

export interface InlineSpanBounds {
  kind: InlineSpanKind;
  outerStart: number;
  innerStart: number;
  innerEnd: number;
  outerEnd: number;
}

export type LiveRenderedScopeKind =
  | "paragraph"
  | "heading"
  | "listItem"
  | "tableCell"
  | "calloutTitle"
  | "calloutBody"
  | "pre";

export interface LiveRenderedSelectionRange {
  blockElement: HTMLElement;
  renderedBlockStart: number;
  renderedBlockEnd: number;
  renderedFrom: number;
  renderedTo: number;
  blockStart: number;
  blockEnd: number;
  from: number;
  to: number;
  reversed: boolean;
  protectedBlock: boolean;
  scopeKind: LiveRenderedScopeKind;
  spans: InlineSpanBounds[];
}

const EXCLUDED_SELECTION_CONTAINER_SELECTOR =
  "textarea,input,select,button,.cm-editor,.live-active-block,.live-block-edit,.code-toolbar,.cell-toolbar,.cell-output,[data-frontmatter-properties],.document-properties,.reading-search,.image-viewer,.media-dialog,.math-repair-panel,[data-windowed-mounted=\"false\"]";

const LEAF_BLOCK_SELECTOR = "p,h1,h2,h3,h4,h5,h6,li,summary,td,th,pre";

const NESTED_LI_BLOCK_SELECTOR =
  "ul,ol,blockquote,pre,details,table,.code-container,.python-cell,.katex-display,section.step-cards";

const RAW_HTML_TOKEN =
  /(<!--[\s\S]*?-->|<\/?(?:br|mark|sub|sup|kbd|u)(?:\s+(?:[^>"']|"[^"]*"|'[^']*')*)?\s*\/?>)/gi;
const BR_HTML_TAG = /^<br(?:\s+(?:[^>"']|"[^"]*"|'[^']*')*)?\s*\/?>$/i;
const OPEN_HTML_TAG = /^<(mark|sub|sup|kbd|u)(?:\s+(?:[^>"']|"[^"]*"|'[^']*')*)?>$/i;
const CLOSE_HTML_TAG = /^<\/(mark|sub|sup|kbd|u)\s*>$/i;
const IMAGE_ATTR_PREFIX = /^\{[^}\r\n]*\b(?:width|zoom)\s*=\s*[^}\r\n]+\}/i;

function elementAt(node: Node | null): Element | null {
  if (!node) return null;
  return node instanceof Element ? node : node.parentElement;
}

export function translateLiveRenderedRange(
  start: number,
  end: number,
  editing: LiveEditingSpanContext | null,
  activeDoc: string,
): [number, number] {
  if (!editing || end <= editing.baseSplitEnd) return [start, end];
  const delta = activeDoc.length - editing.baseMarkdown.length;
  return [start >= editing.baseSplitEnd ? start + delta : start, end + delta];
}

export function inlineMathInnerBounds(source: string, start: number, end: number): [number, number] {
  const raw = source.slice(start, end);
  if (raw.startsWith("\\(") && raw.endsWith("\\)") && raw.length >= 4) {
    return [start + 2, end - 2];
  }
  if (raw.startsWith("$$") && raw.endsWith("$$") && raw.length >= 4) {
    return [start + 2, end - 2];
  }
  if (raw.startsWith("$") && raw.endsWith("$") && raw.length >= 2) {
    return [start + 1, end - 1];
  }
  return [start, end];
}

export function inlineCodeInnerBounds(source: string, start: number, end: number, value: string): [number, number] {
  const raw = source.slice(start, end);
  let ticks = 0;
  while (ticks < raw.length && raw[ticks] === "`") ticks++;
  if (ticks === 0 || ticks * 2 > raw.length) return [start, end];
  const innerRaw = raw.slice(ticks, raw.length - ticks);
  if (
    innerRaw.length === value.length + 2 &&
    innerRaw.startsWith(" ") &&
    innerRaw.endsWith(" ") &&
    innerRaw.slice(1, -1) === value
  ) {
    return [start + ticks + 1, end - ticks - 1];
  }
  if (innerRaw.length === value.length) {
    return [start + ticks, end - ticks];
  }
  const idx = raw.indexOf(value, ticks);
  if (idx >= 0) return [start + idx, start + idx + value.length];
  return [start + ticks, Math.max(start + ticks, end - ticks)];
}

function isSelectionBackward(selection: Selection): boolean {
  const { anchorNode, anchorOffset, focusNode, focusOffset } = selection;
  if (!anchorNode || !focusNode) return false;
  if (anchorNode === focusNode) return anchorOffset > focusOffset;
  try {
    const anchorRange = anchorNode.ownerDocument?.createRange();
    const focusRange = focusNode.ownerDocument?.createRange();
    if (!anchorRange || !focusRange) return false;
    anchorRange.setStart(anchorNode, anchorOffset);
    anchorRange.collapse(true);
    focusRange.setStart(focusNode, focusOffset);
    focusRange.collapse(true);
    return anchorRange.compareBoundaryPoints(Range.START_TO_START, focusRange) > 0;
  } catch {
    return false;
  }
}

interface SourceUnit {
  from: number;
  to: number;
  char: string;
}

/**
 * Reuses `normalizeMarkdownSource` to strip unmasked `%%...%%` comments while
 * preserving exact UTF-16 character offsets back into `raw`.
 */
function stripCommentsWithSourceMap(raw: string): { value: string; origIndex: (idx: number) => number } {
  if (!raw.includes("%%")) {
    return { value: raw, origIndex: (idx) => idx };
  }
  const safeInput = "\n" + raw.replace(/\[\[/g, "\0\0").replace(/:::callout/gi, "\0\0\0callout");
  const normalized = normalizeMarkdownSource(safeInput);
  const len = Math.max(0, normalized.value.length - 1);
  const origIndices = new Array<number>(len);
  let stripped = "";
  for (let k = 0; k < len; k++) {
    const orig = normalized.originalOffset(k + 1) - 1;
    origIndices[k] = orig;
    stripped += raw[orig] ?? "";
  }
  return {
    value: stripped,
    origIndex: (idx) => (idx < len ? origIndices[idx] : raw.length),
  };
}

function skipLeadingIgnoredComments(source: string, cursor: number, limitEnd: number): number {
  if (cursor >= limitEnd || !source.startsWith("%%", cursor)) return cursor;
  const slice = source.slice(cursor, limitEnd);
  return cursor + stripCommentsWithSourceMap(slice).origIndex(0);
}

function consumeTextUnits(
  raw: string,
  value: string,
  baseOffset: number,
): { units: SourceUnit[]; consumedRaw: number } {
  if (raw === value) {
    const out: SourceUnit[] = new Array(value.length);
    for (let i = 0; i < value.length; i++) {
      out[i] = { from: baseOffset + i, to: baseOffset + i + 1, char: value[i] };
    }
    return { units: out, consumedRaw: value.length };
  }

  const { value: cleanRaw, origIndex } = stripCommentsWithSourceMap(raw);
  const out: SourceUnit[] = [];
  let r = 0;
  let v = 0;

  while (v < value.length && r < cleanRaw.length) {
    const vCh = value[v];
    const rCh = cleanRaw[r];

    if (vCh === "\n" && (rCh === "\r" || rCh === "\n")) {
      const nlStart = origIndex(r);
      if (cleanRaw[r] === "\r" && cleanRaw[r + 1] === "\n") r += 2;
      else r += 1;
      const nextValueChar = v + 1 < value.length ? value[v + 1] : "";
      while (r < cleanRaw.length && (cleanRaw[r] === " " || cleanRaw[r] === "\t" || cleanRaw[r] === ">")) {
        if (nextValueChar && cleanRaw[r] === nextValueChar && cleanRaw.slice(r, r + 4) === value.slice(v + 1, v + 5)) {
          break;
        }
        r++;
      }
      const nlEnd = origIndex(r - 1) + 1;
      out.push({ from: baseOffset + nlStart, to: baseOffset + nlEnd, char: "\n" });
      v++;
      continue;
    }

    if (rCh === "\\" && r + 1 < cleanRaw.length && cleanRaw[r + 1] === vCh) {
      out.push({
        from: baseOffset + origIndex(r),
        to: baseOffset + origIndex(r + 1) + 1,
        char: vCh,
      });
      r += 2;
      v++;
      continue;
    }

    if (rCh === "&") {
      const entity = /^&(?:#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/.exec(cleanRaw.slice(r));
      if (
        entity &&
        (rCh !== vCh || !cleanRaw.slice(r, r + value.length - v).startsWith(value.slice(v, v + entity[0].length)))
      ) {
        const entStart = origIndex(r);
        const entEnd = origIndex(r + entity[0].length - 1) + 1;
        const cp = value.codePointAt(v) ?? 0;
        const unitLen = cp > 0xffff ? 2 : 1;
        for (let k = 0; k < unitLen && v + k < value.length; k++) {
          out.push({
            from: baseOffset + (k === 0 ? entStart : entEnd),
            to: baseOffset + entEnd,
            char: value[v + k],
          });
        }
        r += entity[0].length;
        v += unitLen;
        continue;
      }
    }

    const chStart = origIndex(r);
    out.push({ from: baseOffset + chStart, to: baseOffset + chStart + 1, char: vCh });
    r++;
    v++;
  }

  const consumedRaw = r > 0 ? origIndex(r - 1) + 1 : 0;
  while (v < value.length) {
    const clamped = baseOffset + Math.min(consumedRaw, raw.length);
    out.push({ from: clamped, to: clamped, char: value[v] });
    v++;
  }

  return { units: out, consumedRaw };
}

function mapTextNodeUnits(raw: string, value: string, baseOffset: number): SourceUnit[] {
  return consumeTextUnits(raw, value, baseOffset).units;
}

function flattenInlineText(nodes: any[]): string {
  let out = "";
  for (const node of nodes) {
    if (!node) continue;
    if (typeof node.value === "string") out += node.value;
    else if (Array.isArray(node.children)) out += flattenInlineText(node.children);
  }
  return out;
}

function studyDelimiterForType(type: string): { delim: string; kind: InlineSpanKind } | null {
  if (type === "highlight") return { delim: "==", kind: "highlight" };
  if (type === "subscript") return { delim: "~", kind: "subscript" };
  if (type === "superscript") return { delim: "^", kind: "superscript" };
  return null;
}

function normalizeContainerSpanKind(type: string, rawNode: string): InlineSpanKind {
  if (type === "strong") return "strong";
  if (type === "emphasis") return "emphasis";
  if (type === "delete") return "delete";
  if (type === "link") {
    if (rawNode.startsWith("<") && rawNode.endsWith(">")) return "autolink";
    return "link";
  }
  if (type === "linkReference") return "linkReference";
  if (type === "highlight") return "highlight";
  if (type === "subscript") return "subscript";
  if (type === "superscript") return "superscript";
  return "inline";
}

function collectMdastInlineStream(
  children: any[],
  source: string,
  scopeStart: number,
  scopeEnd: number,
  units: SourceUnit[],
  spans: InlineSpanBounds[],
  mathSpans: InlineSpanBounds[],
): void {
  const htmlStack: Array<{ tag: string; outerStart: number; innerStartUnit: number }> = [];
  let cursor = scopeStart;
  let prevWasImage = false;

  const walkList = (nodes: any[], limitEnd: number) => {
    for (const node of nodes) {
      if (!node) continue;
      const start: number | undefined = node.position?.start?.offset;
      const end: number | undefined = node.position?.end?.offset;
      const followedImage = prevWasImage;
      prevWasImage = false;

      if (node.type === "text" && typeof node.value === "string") {
        if (typeof start === "number" && typeof end === "number") {
          let effectiveStart = start;
          if (followedImage && end > start) {
            const rawSlice = source.slice(start, end);
            const attrMatch = IMAGE_ATTR_PREFIX.exec(rawSlice);
            if (attrMatch && rawSlice.length - attrMatch[0].length >= node.value.length) {
              effectiveStart = start + attrMatch[0].length;
            }
          }
          const raw = source.slice(effectiveStart, end);
          units.push(...mapTextNodeUnits(raw, node.value, effectiveStart));
          cursor = end;
        } else {
          cursor = skipLeadingIgnoredComments(source, cursor, limitEnd);
          if (followedImage) {
            const attrMatch = IMAGE_ATTR_PREFIX.exec(source.slice(cursor, limitEnd));
            if (attrMatch) cursor += attrMatch[0].length;
          }
          const raw = source.slice(cursor, limitEnd);
          const consumed = consumeTextUnits(raw, node.value, cursor);
          units.push(...consumed.units);
          cursor += consumed.consumedRaw;
        }
        continue;
      }

      if (node.type === "inlineCode" && typeof node.value === "string" && typeof start === "number" && typeof end === "number") {
        const [innerStart, innerEnd] = inlineCodeInnerBounds(source, start, end, node.value);
        spans.push({ kind: "inlineCode", outerStart: start, innerStart, innerEnd, outerEnd: end });
        for (let i = 0; i < node.value.length; i++) {
          const pos = Math.min(innerEnd, innerStart + i);
          units.push({ from: pos, to: Math.min(innerEnd, pos + 1), char: node.value[i] });
        }
        cursor = end;
        continue;
      }

      if (node.type === "inlineMath" && typeof start === "number" && typeof end === "number") {
        const [innerStart, innerEnd] = inlineMathInnerBounds(source, start, end);
        const entry: InlineSpanBounds = { kind: "inlineMath", outerStart: start, innerStart, innerEnd, outerEnd: end };
        spans.push(entry);
        mathSpans.push(entry);
        units.push({ from: start, to: end, char: "\uFFFC" });
        cursor = end;
        continue;
      }

      if (node.type === "break" && typeof start === "number" && typeof end === "number") {
        units.push({ from: start, to: end, char: "\n" });
        cursor = end;
        continue;
      }

      if ((node.type === "image" || node.type === "imageReference") && typeof start === "number" && typeof end === "number") {
        spans.push({ kind: node.type, outerStart: start, innerStart: start, innerEnd: end, outerEnd: end });
        units.push({ from: start, to: end, char: "\uFFFC" });
        cursor = end;
        prevWasImage = true;
        continue;
      }

      if (node.type === "html" && typeof node.value === "string" && typeof start === "number") {
        const raw = node.value;
        const parts = raw.split(RAW_HTML_TOKEN);
        let htmlCursor = start;
        for (const part of parts) {
          if (!part) continue;
          const partStart = htmlCursor;
          const partEnd = htmlCursor + part.length;
          htmlCursor = partEnd;
          if (part.startsWith("<!--") && part.endsWith("-->")) continue;
          if (BR_HTML_TAG.test(part)) {
            units.push({ from: partStart, to: partEnd, char: "\n" });
            continue;
          }
          const open = OPEN_HTML_TAG.exec(part);
          if (open && !part.slice(0, -1).trimEnd().endsWith("/")) {
            htmlStack.push({ tag: open[1].toLowerCase(), outerStart: partStart, innerStartUnit: units.length });
            continue;
          }
          const close = CLOSE_HTML_TAG.exec(part);
          if (close) {
            const tag = close[1].toLowerCase();
            let matchIdx = -1;
            for (let s = htmlStack.length - 1; s >= 0; s--) {
              if (htmlStack[s].tag === tag) {
                matchIdx = s;
                break;
              }
            }
            if (matchIdx >= 0) {
              const paired = htmlStack.splice(matchIdx)[0];
              const innerStart = units[paired.innerStartUnit]?.from ?? partStart;
              const innerEnd = units.length > paired.innerStartUnit ? units[units.length - 1].to : innerStart;
              spans.push({
                kind: "html",
                outerStart: paired.outerStart,
                innerStart,
                innerEnd,
                outerEnd: partEnd,
              });
              continue;
            }
          }
          for (let i = 0; i < part.length; i++) {
            units.push({ from: partStart + i, to: partStart + i + 1, char: part[i] });
          }
        }
        cursor = typeof end === "number" ? end : htmlCursor;
        continue;
      }

      if (node.type === "link" && typeof start === "number" && typeof end === "number") {
        const rawLink = source.slice(start, end);
        const parsedWiki = parseOriginalWikilinkSlice(rawLink);
        if (parsedWiki) {
          const innerSlice = rawLink.slice(2, -2);
          const pipeIdx = innerSlice.indexOf("|");
          let innerStart = start + 2;
          let innerEnd = end - 2;
          if (pipeIdx >= 0 && innerSlice.slice(pipeIdx + 1).trim().length > 0) {
            const aliasSlice = innerSlice.slice(pipeIdx + 1);
            const leadWs = aliasSlice.length - aliasSlice.trimStart().length;
            const trailWs = aliasSlice.length - aliasSlice.trimEnd().length;
            innerStart = start + 2 + pipeIdx + 1 + leadWs;
            innerEnd = Math.max(innerStart, end - 2 - trailWs);
          } else if (parsedWiki.sameNote) {
            const hashIdx = innerSlice.indexOf("#");
            const afterHash = hashIdx >= 0 ? innerSlice.slice(hashIdx + 1) : innerSlice;
            const leadWs = afterHash.length - afterHash.trimStart().length;
            const trailWs = afterHash.length - afterHash.trimEnd().length;
            innerStart = start + 2 + (hashIdx >= 0 ? hashIdx + 1 : 0) + leadWs;
            innerEnd = Math.max(innerStart, end - 2 - trailWs);
          }
          const visible = flattenInlineText(node.children ?? []);
          units.push(...mapTextNodeUnits(source.slice(innerStart, innerEnd), visible, innerStart));
          spans.push({
            kind: "wikilink",
            outerStart: start,
            innerStart,
            innerEnd,
            outerEnd: end,
          });
          cursor = end;
          continue;
        }
      }

      const studySpec = studyDelimiterForType(String(node.type || ""));
      if (studySpec && Array.isArray(node.children) && (typeof start !== "number" || typeof end !== "number")) {
        cursor = skipLeadingIgnoredComments(source, cursor, limitEnd);
        if (!source.startsWith(studySpec.delim, cursor)) {
          const nextDelim = source.indexOf(studySpec.delim, cursor);
          if (nextDelim >= cursor && nextDelim < limitEnd) {
            cursor = nextDelim;
          }
        }
        const outerStart = cursor;
        const innerStart = source.startsWith(studySpec.delim, cursor) ? cursor + studySpec.delim.length : cursor;
        cursor = innerStart;
        const beforeUnit = units.length;
        walkList(node.children, limitEnd);
        const afterUnit = units.length;
        cursor = skipLeadingIgnoredComments(source, cursor, limitEnd);
        const resolvedInnerEnd = afterUnit > beforeUnit ? units[afterUnit - 1].to : cursor;
        const closePos = Math.max(cursor, resolvedInnerEnd);
        const outerEnd = source.startsWith(studySpec.delim, closePos) ? closePos + studySpec.delim.length : closePos;
        cursor = outerEnd;
        spans.push({
          kind: studySpec.kind,
          outerStart,
          innerStart: afterUnit > beforeUnit ? units[beforeUnit].from : innerStart,
          innerEnd: resolvedInnerEnd,
          outerEnd,
        });
        continue;
      }

      if (Array.isArray(node.children)) {
        const beforeUnit = units.length;
        const rawNode =
          typeof start === "number" ? source.slice(start, typeof end === "number" ? end : limitEnd) : "";
        if (typeof start === "number") {
          let childLead = 0;
          if (node.type === "strong" && (rawNode.startsWith("**") || rawNode.startsWith("__"))) childLead = 2;
          else if (node.type === "emphasis" && (rawNode.startsWith("*") || rawNode.startsWith("_"))) childLead = 1;
          else if (node.type === "delete") {
            while (childLead < rawNode.length && rawNode[childLead] === "~") childLead++;
          } else if ((node.type === "link" || node.type === "linkReference") && rawNode.startsWith("[")) {
            childLead = 1;
          }
          cursor = start + childLead;
        }
        walkList(node.children, typeof end === "number" ? end : limitEnd);
        const afterUnit = units.length;
        if (typeof start === "number" && typeof end === "number") {
          if (afterUnit > beforeUnit) {
            const innerStart = units[beforeUnit].from;
            const innerEnd = units[afterUnit - 1].to;
            spans.push({
              kind: normalizeContainerSpanKind(String(node.type || ""), rawNode),
              outerStart: start,
              innerStart,
              innerEnd,
              outerEnd: end,
            });
          }
          cursor = end;
        }
      }
    }
  };

  walkList(children, scopeEnd);
}

interface ResolvedScopeStream {
  children: any[];
  scopeStart: number;
  scopeEnd: number;
  scopeKind: LiveRenderedScopeKind;
}

function stripAstPositions(nodes: any[]): void {
  for (const node of nodes) {
    if (!node) continue;
    delete node.position;
    if (Array.isArray(node.children)) {
      stripAstPositions(node.children);
    }
  }
}

function clampSplitTextOffsets(nodes: any[], minOff: number, maxOff: number): void {
  for (const node of nodes) {
    if (!node) continue;
    if (!Array.isArray(node.children)) {
      const s = node.position?.start?.offset;
      const e = node.position?.end?.offset;
      if (typeof s === "number" && typeof e === "number") {
        const cs = Math.max(minOff, Math.min(maxOff, s));
        const ce = Math.max(cs, Math.min(maxOff, e));
        node.position = {
          start: { ...node.position.start, offset: cs },
          end: { ...node.position.end, offset: ce },
        };
      }
    } else {
      clampSplitTextOffsets(node.children, minOff, maxOff);
    }
  }
}

function hasExplicitCalloutTitleInAst(firstParaChildren: any[], markerLen: number): boolean {
  if (!firstParaChildren.length) return false;
  const first = firstParaChildren[0];
  const trimmedFirst = { ...first, value: String(first.value ?? "").slice(markerLen) };
  const check = (nodes: any[]): { found: boolean; ended: boolean } => {
    for (const child of nodes) {
      if (!child) continue;
      if (child.type === "break") return { found: false, ended: true };
      if (child.type === "text" && typeof child.value === "string") {
        const nl = child.value.indexOf("\n");
        if (nl >= 0) {
          return { found: child.value.slice(0, nl).trim().length > 0, ended: true };
        }
        if (child.value.trim().length > 0) return { found: true, ended: false };
      } else if (Array.isArray(child.children)) {
        const inner = check(child.children);
        if (inner.found) return { found: true, ended: inner.ended };
        if (inner.ended) return { found: false, ended: true };
      } else {
        return { found: true, ended: false };
      }
    }
    return { found: false, ended: false };
  };
  return check([trimmedFirst, ...firstParaChildren.slice(1)]).found;
}

function resolveCalloutScopeStream(
  scopeEl: HTMLElement,
  calloutEl: HTMLElement,
  blockEl: HTMLElement,
  source: string,
  tree: any,
): ResolvedScopeStream | "fallthrough" | null {
  const cStartAttr = calloutEl.getAttribute("data-source-start");
  const cEndAttr = calloutEl.getAttribute("data-source-end");
  const targetStart = cStartAttr !== null ? Number(cStartAttr) : Number(blockEl.dataset.sourceStart);
  const targetEnd = cEndAttr !== null ? Number(cEndAttr) : Number(blockEl.dataset.sourceEnd);

  let blockquoteNode: any = null;
  visit(tree, "blockquote", (node: any) => {
    if (!node.position) return;
    const nStart = node.position.start.offset;
    const nEnd = node.position.end.offset;
    if (cStartAttr !== null && cEndAttr !== null) {
      if (nStart === targetStart && nEnd === targetEnd) blockquoteNode = node;
    } else if (!blockquoteNode && nStart >= targetStart && nEnd <= targetEnd) {
      blockquoteNode = node;
    }
  });

  const firstPara = blockquoteNode?.children?.[0];
  const firstText = firstPara?.children?.[0];
  const paraStart: number | undefined = firstPara?.position?.start?.offset;
  const paraEnd: number | undefined = firstPara?.position?.end?.offset;
  if (
    firstPara?.type !== "paragraph" ||
    firstText?.type !== "text" ||
    typeof firstText.value !== "string" ||
    typeof paraStart !== "number" ||
    typeof paraEnd !== "number"
  ) {
    return "fallthrough";
  }

  const markerMatch = /^\[!([\w-]+)\]([+-]?)[ \t]*/i.exec(firstText.value);
  if (!markerMatch) return "fallthrough";

  const isTitle = scopeEl.classList.contains("callout-title");
  const isSplitBodyPara =
    !isTitle &&
    Number(scopeEl.dataset.sourceStart) === paraStart &&
    Number(scopeEl.dataset.sourceEnd) === paraEnd;

  if (!isTitle && !isSplitBodyPara) {
    return "fallthrough";
  }

  const line1Start = source.lastIndexOf("\n", Math.max(0, paraStart - 1)) + 1;
  const rawFromLine1 = source.slice(line1Start, paraEnd);
  const nlMatch = /\r?\n/.exec(rawFromLine1);
  const line1EndInRaw = nlMatch ? nlMatch.index : rawFromLine1.length;
  const rawLine1 = rawFromLine1.slice(0, line1EndInRaw);

  let titleStart = line1Start;
  let titleEnd = line1Start + line1EndInRaw;
  let hadExplicitTitle = hasExplicitCalloutTitleInAst(firstPara.children, markerMatch[0].length);

  const rawQuotePrefix = /^[ \t>]*\[!([\w-]+)\]([+-]?)[ \t]*/i.exec(rawLine1);
  const rawDirectivePrefix = /^[ \t]*:::callout[ \t]+[\w-]+([ \t]*)/i.exec(rawLine1);
  if (rawQuotePrefix) {
    titleStart = line1Start + rawQuotePrefix[0].length;
  } else if (rawDirectivePrefix) {
    const rest = rawLine1.slice(rawDirectivePrefix[0].length);
    if (!rest.trim()) {
      hadExplicitTitle = false;
    }
    let leadQuote = 0;
    let trailQuote = 0;
    if (
      (rest.startsWith('"') && rest.endsWith('"') && rest.length >= 2) ||
      (rest.startsWith("'") && rest.endsWith("'") && rest.length >= 2)
    ) {
      leadQuote = 1;
      trailQuote = 1;
    }
    titleStart = line1Start + rawDirectivePrefix[0].length + leadQuote;
    titleEnd = Math.max(titleStart, titleEnd - trailQuote);
  }

  if (titleEnd > titleStart && source[titleEnd - 1] === "\\") {
    titleEnd -= 1;
  }

  let bodyStart = paraEnd;
  let bodyEnd = paraEnd;
  if (nlMatch) {
    let afterNl = nlMatch.index + nlMatch[0].length;
    const contLead = /^[ \t>]*/.exec(rawFromLine1.slice(afterNl));
    if (contLead) afterNl += contLead[0].length;
    bodyStart = Math.min(paraEnd, line1Start + afterNl);
    const closingDirective = /\r?\n[ \t]*:::[ \t]*$/.exec(source.slice(bodyStart, paraEnd));
    if (closingDirective) {
      bodyEnd = bodyStart + closingDirective.index;
    }
  }

  const cloned: any = structuredClone(blockquoteNode);
  remarkCallouts()({ type: "root", children: [cloned] });

  if (isTitle) {
    if (!hadExplicitTitle) return null;
    const titleNode = cloned.children?.[0];
    if (!titleNode || !Array.isArray(titleNode.children)) return null;
    if (rawDirectivePrefix) {
      stripAstPositions(titleNode.children);
    } else {
      clampSplitTextOffsets(titleNode.children, titleStart, titleEnd);
    }
    return {
      children: titleNode.children,
      scopeStart: titleStart,
      scopeEnd: titleEnd,
      scopeKind: "calloutTitle",
    };
  }

  const bodyNode = cloned.children?.[1];
  if (!bodyNode || bodyNode.type !== "paragraph" || !Array.isArray(bodyNode.children)) return null;
  clampSplitTextOffsets(bodyNode.children, bodyStart, bodyEnd);
  return {
    children: bodyNode.children,
    scopeStart: bodyStart,
    scopeEnd: bodyEnd,
    scopeKind: "calloutBody",
  };
}

function computeContentBoundsForNode(node: any, source: string): [number, number] {
  const start: number = node.position.start.offset;
  const end: number = node.position.end.offset;
  const firstChildStart: number | undefined = node.children?.[0]?.position?.start?.offset;
  if (typeof firstChildStart === "number") {
    return [firstChildStart, end];
  }
  const raw = source.slice(start, end);
  if (node.type === "heading") {
    const prefix = /^[ \t]{0,3}#{1,6}[ \t]+/.exec(raw);
    const suffix = /[ \t]+#+[ \t]*$/.exec(raw);
    const cStart = prefix ? start + prefix[0].length : start;
    const cEnd = suffix && end - suffix[0].length >= cStart ? end - suffix[0].length : end;
    return [cStart, cEnd];
  }
  if (node.type === "tableCell") {
    const lead = /^\|?[ \t]*/.exec(raw);
    const trail = /[ \t]*\|?$/.exec(raw);
    const cStart = lead ? start + lead[0].length : start;
    const cEnd = trail && end - trail[0].length >= cStart ? end - trail[0].length : end;
    return [cStart, cEnd];
  }
  if (node.type === "paragraph") {
    const quoteLead = /^[ \t>]+/.exec(raw);
    if (quoteLead && raw[quoteLead[0].length] !== undefined) {
      return [start + quoteLead[0].length, end];
    }
  }
  return [start, end];
}

function resolveScopeMdastChildren(
  scopeEl: HTMLElement,
  blockEl: HTMLElement,
  source: string,
  tree: any,
): ResolvedScopeStream | null {
  const calloutEl = scopeEl.closest<HTMLElement>("details.callout,aside.callout");
  if (calloutEl && blockEl.contains(calloutEl)) {
    const calloutResolved = resolveCalloutScopeStream(scopeEl, calloutEl, blockEl, source, tree);
    if (calloutResolved !== "fallthrough") return calloutResolved;
  }

  const rawStart = scopeEl.getAttribute("data-source-start");
  const rawEnd = scopeEl.getAttribute("data-source-end");
  if (rawStart === null || rawEnd === null) return null;
  const targetStart = Number(rawStart);
  const targetEnd = Number(rawEnd);
  if (!Number.isFinite(targetStart) || !Number.isFinite(targetEnd)) return null;

  let matched: any = null;
  visit(tree, (node: any) => {
    if (!node.position || !Array.isArray(node.children)) return;
    if (node.position.start.offset === targetStart && node.position.end.offset === targetEnd) {
      if (scopeEl.tagName === "LI" && node.type === "listItem") {
        matched = node;
      } else if (scopeEl.tagName !== "LI" && ["paragraph", "heading", "tableCell"].includes(node.type)) {
        matched = node;
      } else if (!matched) {
        matched = node;
      }
    }
  });
  if (!matched) return null;

  if (matched.type === "listItem") {
    const directPara = matched.children.find((child: any) => child.type === "paragraph");
    if (!directPara?.position) return null;
    const [scopeStart, scopeEnd] = computeContentBoundsForNode(directPara, source);
    return { children: directPara.children, scopeStart, scopeEnd, scopeKind: "listItem" };
  }
  const [scopeStart, scopeEnd] = computeContentBoundsForNode(matched, source);
  const scopeKind: LiveRenderedScopeKind =
    matched.type === "heading"
      ? "heading"
      : matched.type === "tableCell"
        ? "tableCell"
        : scopeEl.closest("li")
          ? "listItem"
          : "paragraph";
  return { children: matched.children, scopeStart, scopeEnd, scopeKind };
}

interface DomStreamMapping {
  text: string;
  startUnit: number;
  endUnit: number;
  startMathOrdinal: number | null;
  endMathOrdinal: number | null;
}

function measureDomSelectionUnits(scopeEl: HTMLElement, range: Range): DomStreamMapping | null {
  let stream = "";
  let mathOrdinal = 0;
  let skipTaskCheckboxSpace = false;
  let sawNestedLiBlock = false;
  let invalid = false;

  let startUnit: number | null = null;
  let endUnit: number | null = null;
  let startMathOrdinal: number | null = null;
  let endMathOrdinal: number | null = null;

  const isDirectTextBeforeNestedLiBlock = (textNode: Node): boolean => {
    if (scopeEl.tagName !== "LI" || textNode.parentNode !== scopeEl) return false;
    let sib = textNode.nextSibling;
    while (sib && sib.nodeType === Node.TEXT_NODE && (sib as Text).data.length === 0) {
      sib = sib.nextSibling;
    }
    return sib instanceof Element && sib.matches(NESTED_LI_BLOCK_SELECTOR);
  };

  const isExcludedElement = (el: Element): "ui" | "nestedBlock" | false => {
    if (
      el.matches(
        "button,input,select,textarea,script,style,.live-block-edit,.katex-mathml,[data-frontmatter-properties],.document-properties",
      )
    ) {
      if (el.tagName === "INPUT" && (el as HTMLInputElement).type === "checkbox") {
        skipTaskCheckboxSpace = true;
      }
      return "ui";
    }
    if (scopeEl.tagName === "LI" && el !== scopeEl && el.matches(NESTED_LI_BLOCK_SELECTOR)) {
      return "nestedBlock";
    }
    return false;
  };

  const isAtomicImageSpan = (el: Element): boolean =>
    el.matches("[data-note-image-source]") ||
    (el.classList.contains("image-loading") && !el.closest("[data-note-image-source]"));

  const walk = (node: Node): void => {
    if (invalid) return;

    if (node.nodeType === Node.TEXT_NODE) {
      const data = (node as Text).data;
      let skipPrefix = 0;
      if (skipTaskCheckboxSpace) {
        skipTaskCheckboxSpace = false;
        if (data.startsWith(" ")) skipPrefix = 1;
      }
      let effective = skipPrefix ? data.slice(skipPrefix) : data;
      if (scopeEl.tagName === "LI" && node.parentNode === scopeEl) {
        if (sawNestedLiBlock && /^[\r\n]+$/.test(effective)) {
          effective = "";
        } else if (isDirectTextBeforeNestedLiBlock(node)) {
          effective = effective.replace(/\r?\n$/, "");
        }
      }
      if (range.startContainer === node) {
        startUnit = stream.length + Math.max(0, Math.min(effective.length, range.startOffset - skipPrefix));
      }
      if (range.endContainer === node) {
        endUnit = stream.length + Math.max(0, Math.min(effective.length, range.endOffset - skipPrefix));
      }
      stream += effective;
      return;
    }

    if (!(node instanceof Element)) return;
    const excluded = isExcludedElement(node);
    if (excluded) {
      if (excluded === "nestedBlock") {
        sawNestedLiBlock = true;
        if (
          node.contains(range.startContainer) ||
          node.contains(range.endContainer) ||
          (startUnit !== null && endUnit === null)
        ) {
          invalid = true;
        }
        return;
      }
      if (node.contains(range.startContainer) && startUnit === null) startUnit = stream.length;
      if (node.contains(range.endContainer) && endUnit === null) endUnit = stream.length;
      return;
    }

    skipTaskCheckboxSpace = false;

    if (node.classList.contains("katex")) {
      const currentOrdinal = mathOrdinal++;
      const containsStart = node.contains(range.startContainer);
      const containsEnd = node.contains(range.endContainer);
      if (containsStart) {
        startUnit = stream.length;
        startMathOrdinal = currentOrdinal;
      }
      stream += "\uFFFC";
      if (containsEnd) {
        endUnit = stream.length;
        endMathOrdinal = currentOrdinal;
      }
      return;
    }

    if (node.tagName === "BR") {
      if (range.startContainer === node) startUnit = stream.length;
      stream += "\n";
      if (range.endContainer === node) endUnit = stream.length;
      return;
    }

    if (isAtomicImageSpan(node)) {
      if (node.contains(range.startContainer)) startUnit = stream.length;
      stream += "\uFFFC";
      if (node.contains(range.endContainer)) endUnit = stream.length;
      return;
    }

    const children = node.childNodes;
    for (let i = 0; i <= children.length; i++) {
      if (range.startContainer === node && range.startOffset === i && startUnit === null) {
        startUnit = stream.length;
      }
      if (range.endContainer === node && range.endOffset === i && endUnit === null) {
        endUnit = stream.length;
      }
      if (i < children.length) {
        walk(children[i]);
        if (invalid) return;
      }
    }
  };

  walk(scopeEl);

  if (invalid || startUnit === null || endUnit === null || startUnit >= endUnit) return null;
  return { text: stream, startUnit, endUnit, startMathOrdinal, endMathOrdinal };
}

function measurePlainTextOffsetInPre(preEl: HTMLElement, container: Node, offset: number): number | null {
  let count = 0;
  let found: number | null = null;

  const walk = (node: Node): void => {
    if (found !== null) return;
    if (node.nodeType === Node.TEXT_NODE) {
      const len = (node as Text).data.length;
      if (container === node) {
        found = count + Math.max(0, Math.min(len, offset));
        return;
      }
      count += len;
      return;
    }
    const children = node.childNodes;
    for (let i = 0; i <= children.length; i++) {
      if (container === node && offset === i) {
        found = count;
        return;
      }
      if (i < children.length) {
        walk(children[i]);
        if (found !== null) return;
      }
    }
  };

  walk(preEl);
  return found;
}

function resolvePreBodyBounds(
  preEl: HTMLElement,
  renderedSource: string,
  renderedBlockStart: number,
  renderedBlockEnd: number,
): [number, number] | null {
  const rawPreStart = preEl.getAttribute("data-source-start");
  const rawPreEnd = preEl.getAttribute("data-source-end");
  if (rawPreStart !== null && rawPreEnd !== null) {
    const preStart = Number(rawPreStart);
    const preEnd = Number(rawPreEnd);
    if (Number.isFinite(preStart) && Number.isFinite(preEnd) && preEnd >= preStart) {
      return [preStart, preEnd];
    }
  }
  const pyCell = preEl.closest<HTMLElement>(".python-cell[data-source-start][data-source-end]");
  if (pyCell && preEl.classList.contains("python-source")) {
    const cellStart = Number(pyCell.dataset.sourceStart);
    const cellEnd = Number(pyCell.dataset.sourceEnd);
    if (
      Number.isFinite(cellStart) &&
      Number.isFinite(cellEnd) &&
      cellStart >= renderedBlockStart &&
      cellEnd <= renderedBlockEnd
    ) {
      const nl = renderedSource.indexOf("\n", cellStart);
      const bodyStart = nl >= 0 && nl < cellEnd ? nl + 1 : cellStart;
      return [bodyStart, cellEnd];
    }
  }
  return null;
}

/**
 * Maps a single-block rendered DOM selection inside `.live-document` to its
 * current source range and inline span bounds. Multi-block, cross-list-item,
 * cross-cell, and multi-paragraph selections return `null`.
 */
export function mapLiveRenderedSelectionToSourceRange(
  selection: Selection | null,
  rootEl: HTMLElement | null,
  renderedSource: string,
  sourceAnalysis?: SourceDocumentAnalysis,
  editing: LiveEditingSpanContext | null = null,
  activeDoc: string = renderedSource,
): LiveRenderedSelectionRange | null {
  if (!selection || !rootEl || selection.rangeCount === 0 || selection.isCollapsed) return null;

  const range = selection.getRangeAt(0);
  const startEl = elementAt(range.startContainer);
  const endEl = elementAt(range.endContainer);
  const commonEl = elementAt(range.commonAncestorContainer);
  if (!startEl || !endEl || !commonEl) return null;

  if (
    startEl.closest(EXCLUDED_SELECTION_CONTAINER_SELECTOR) ||
    endEl.closest(EXCLUDED_SELECTION_CONTAINER_SELECTOR) ||
    commonEl.closest(EXCLUDED_SELECTION_CONTAINER_SELECTOR)
  ) {
    return null;
  }

  const startBlock = startEl.closest<HTMLElement>(".live-block");
  const endBlock = endEl.closest<HTMLElement>(".live-block");
  if (!startBlock || !endBlock || startBlock !== endBlock || !rootEl.contains(startBlock)) {
    return null;
  }

  const renderedBlockStart = Number(startBlock.dataset.sourceStart);
  const renderedBlockEnd = Number(startBlock.dataset.sourceEnd);
  if (
    !Number.isFinite(renderedBlockStart) ||
    !Number.isFinite(renderedBlockEnd) ||
    renderedBlockStart < 0 ||
    renderedBlockEnd < renderedBlockStart ||
    renderedBlockEnd > renderedSource.length
  ) {
    return null;
  }

  const closestLeafInBlock = (el: Element): HTMLElement | null => {
    const leaf = el.closest<HTMLElement>(LEAF_BLOCK_SELECTOR);
    return leaf && startBlock.contains(leaf) ? leaf : null;
  };
  const startLeaf = closestLeafInBlock(startEl);
  const endLeaf = closestLeafInBlock(endEl);
  if (startLeaf !== endLeaf) {
    return null;
  }

  const scopeEl = startLeaf ?? startBlock;
  if (scopeEl.tagName === "SUMMARY" && scopeEl.closest(".code-disclosure")) {
    return null;
  }

  const analysis =
    sourceAnalysis?.source === renderedSource ? sourceAnalysis.analysis : analyzeDocument(renderedSource);
  const topLevelProtected = analysis.tree.children.some(
    (node: any) =>
      ["code", "math", "html", "definition"].includes(node.type) &&
      (node.position?.start?.offset ?? -1) >= renderedBlockStart &&
      (node.position?.end?.offset ?? Infinity) <= renderedBlockEnd,
  );
  const inProtectedContainer = Boolean(
    scopeEl.tagName === "PRE" ||
      startEl.closest(".code-container,.python-cell,.katex-display") ||
      endEl.closest(".code-container,.python-cell,.katex-display"),
  );
  const protectedBlock = topLevelProtected || inProtectedContainer;

  const reversed = isSelectionBackward(selection);

  let renderedFrom: number | null = null;
  let renderedTo: number | null = null;
  let scopeKind: LiveRenderedScopeKind = "paragraph";
  const renderedSpans: InlineSpanBounds[] = [];

  if (scopeEl.tagName === "PRE") {
    scopeKind = "pre";
    const preBounds = resolvePreBodyBounds(scopeEl, renderedSource, renderedBlockStart, renderedBlockEnd);
    if (preBounds) {
      const [preStart, preEnd] = preBounds;
      const domFrom = measurePlainTextOffsetInPre(scopeEl, range.startContainer, range.startOffset);
      const domTo = measurePlainTextOffsetInPre(scopeEl, range.endContainer, range.endOffset);
      if (domFrom !== null && domTo !== null && domTo > domFrom) {
        renderedFrom = Math.min(preEnd, preStart + domFrom);
        renderedTo = Math.min(preEnd, preStart + domTo);
      }
    }
  } else {
    const resolvedScope = resolveScopeMdastChildren(scopeEl, startBlock, renderedSource, analysis.tree);
    const domStream = measureDomSelectionUnits(scopeEl, range);

    if (resolvedScope && domStream) {
      scopeKind = resolvedScope.scopeKind;
      const units: SourceUnit[] = [];
      const mathSpans: InlineSpanBounds[] = [];
      collectMdastInlineStream(
        resolvedScope.children,
        renderedSource,
        resolvedScope.scopeStart,
        resolvedScope.scopeEnd,
        units,
        renderedSpans,
        mathSpans,
      );

      if (
        domStream.startMathOrdinal !== null &&
        domStream.startMathOrdinal === domStream.endMathOrdinal &&
        mathSpans[domStream.startMathOrdinal]
      ) {
        const targetMath = mathSpans[domStream.startMathOrdinal];
        renderedFrom = targetMath.innerStart;
        renderedTo = targetMath.innerEnd;
      } else if (units.length === domStream.text.length && domStream.endUnit <= units.length) {
        const singleUnit = domStream.endUnit === domStream.startUnit + 1 ? units[domStream.startUnit] : null;
        const singleMath = singleUnit
          ? mathSpans.find((m) => m.outerStart === singleUnit.from && m.outerEnd === singleUnit.to)
          : undefined;
        if (singleMath) {
          renderedFrom = singleMath.innerStart;
          renderedTo = singleMath.innerEnd;
        } else {
          let rawFrom = units[domStream.startUnit].from;
          let rawTo = units[domStream.endUnit - 1].to;

          for (const span of renderedSpans) {
            if (rawFrom >= span.outerStart && rawFrom <= span.innerStart && rawTo > span.outerEnd) {
              rawFrom = Math.min(rawFrom, span.outerStart);
            }
            if (rawTo <= span.outerEnd && rawTo >= span.innerEnd && rawFrom < span.outerStart) {
              rawTo = Math.max(rawTo, span.outerEnd);
            }
          }

          renderedFrom = rawFrom;
          renderedTo = rawTo;
        }
      }
    }
  }

  if (
    renderedFrom === null ||
    renderedTo === null ||
    renderedFrom < renderedBlockStart ||
    renderedTo > renderedBlockEnd ||
    renderedFrom >= renderedTo
  ) {
    return null;
  }

  const [blockStart, blockEnd] = translateLiveRenderedRange(renderedBlockStart, renderedBlockEnd, editing, activeDoc);
  const [from, to] = translateLiveRenderedRange(renderedFrom, renderedTo, editing, activeDoc);
  if (from < blockStart || to > blockEnd || from >= to || blockEnd > activeDoc.length) {
    return null;
  }

  const spans: InlineSpanBounds[] = renderedSpans.map((span) => {
    const [outerStart, outerEnd] = translateLiveRenderedRange(span.outerStart, span.outerEnd, editing, activeDoc);
    const [innerStart, innerEnd] = translateLiveRenderedRange(span.innerStart, span.innerEnd, editing, activeDoc);
    return { kind: span.kind, outerStart, innerStart, innerEnd, outerEnd };
  });

  return {
    blockElement: startBlock,
    renderedBlockStart,
    renderedBlockEnd,
    renderedFrom,
    renderedTo,
    blockStart,
    blockEnd,
    from,
    to,
    reversed,
    protectedBlock,
    scopeKind,
    spans,
  };
}

function buildPreservedSubrangeResult(
  result: MarkdownEditResult,
  relStart: number,
  relEnd: number,
  reversed: boolean,
): MarkdownEditResult {
  const baseRange = result.ranges[0];
  const unwrappedStart = Math.min(baseRange.anchor, baseRange.head);
  const unwrappedEnd = Math.max(baseRange.anchor, baseRange.head);
  const selStart = Math.min(unwrappedEnd, unwrappedStart + Math.max(0, relStart));
  const selEnd = Math.min(unwrappedEnd, Math.max(selStart, unwrappedStart + Math.max(0, relEnd)));
  return {
    ...result,
    ranges: [reversed ? { anchor: selEnd, head: selStart } : { anchor: selStart, head: selEnd }],
  };
}

/**
 * Resolves a single-block Markdown format edit for a mapped Live rendered
 * selection, delegating symmetric/link/block edits to `toggleMarkdownFormat`
 * while guarding protected blocks, inline code/math, and partial spans.
 */
export function resolveLiveRenderedFormatEdit(
  activeDoc: string,
  mapped: LiveRenderedSelectionRange,
  action: FormatAction,
): MarkdownEditResult | null {
  if (mapped.protectedBlock) return null;

  const { from, to, reversed, blockStart, blockEnd, scopeKind, spans } = mapped;
  if (from < blockStart || to > blockEnd || from >= to) return null;

  const docRange = reversed ? { anchor: to, head: from } : { anchor: from, head: to };

  const validateResult = (res: MarkdownEditResult): MarkdownEditResult | null => {
    if (
      res.changes.length === 0 ||
      res.doc === activeDoc ||
      !res.changes.every((ch) => ch.from >= blockStart && ch.to <= blockEnd)
    ) {
      return null;
    }
    return res;
  };

  if (action === "heading" || action === "list" || action === "quote") {
    if (scopeKind === "tableCell") return null;
    return validateResult(toggleMarkdownFormat(activeDoc, [docRange], action, 0));
  }

  const enclosing = spans
    .filter((s) => s.outerStart <= from && to <= s.outerEnd)
    .sort((a, b) => a.outerEnd - a.outerStart - (b.outerEnd - b.outerStart));

  for (const span of enclosing) {
    if (span.kind === "inlineCode") {
      if (action !== "inline_code") return null;
      const relStart = from <= span.innerStart && to >= span.innerEnd ? 0 : Math.max(0, from - span.innerStart);
      const relEnd =
        from <= span.innerStart && to >= span.innerEnd
          ? span.innerEnd - span.innerStart
          : Math.max(relStart, to - span.innerStart);
      const outerRange = reversed
        ? { anchor: span.outerEnd, head: span.outerStart }
        : { anchor: span.outerStart, head: span.outerEnd };
      let unwrapped = toggleMarkdownFormat(activeDoc, [outerRange], "inline_code", 0);
      if (unwrapped.doc.length >= activeDoc.length) {
        const inner = activeDoc.slice(span.innerStart, span.innerEnd);
        const nextDoc = activeDoc.slice(0, span.outerStart) + inner + activeDoc.slice(span.outerEnd);
        unwrapped = {
          doc: nextDoc,
          changes: [{ from: span.outerStart, to: span.outerEnd, insert: inner }],
          ranges: [{ anchor: span.outerStart, head: span.outerStart + inner.length }],
          mainIndex: 0,
        };
      }
      const checked = validateResult(unwrapped);
      return checked ? buildPreservedSubrangeResult(checked, relStart, relEnd, reversed) : null;
    }

    if (span.kind === "inlineMath") {
      if (action !== "inline_math") return null;
      const isSingleDollar =
        span.innerStart === span.outerStart + 1 &&
        span.outerEnd === span.innerEnd + 1 &&
        activeDoc[span.outerStart] === "$" &&
        activeDoc[span.outerEnd - 1] === "$";
      if (!isSingleDollar) return null;
      const relStart = from <= span.innerStart && to >= span.innerEnd ? 0 : Math.max(0, from - span.innerStart);
      const relEnd =
        from <= span.innerStart && to >= span.innerEnd
          ? span.innerEnd - span.innerStart
          : Math.max(relStart, to - span.innerStart);
      const innerRange = reversed
        ? { anchor: span.innerEnd, head: span.innerStart }
        : { anchor: span.innerStart, head: span.innerEnd };
      const unwrapped = toggleMarkdownFormat(activeDoc, [innerRange], "inline_math", 0);
      if (unwrapped.doc.length >= activeDoc.length) return null;
      const checked = validateResult(unwrapped);
      return checked ? buildPreservedSubrangeResult(checked, relStart, relEnd, reversed) : null;
    }

    if (
      span.kind === "html" ||
      span.kind === "image" ||
      span.kind === "imageReference" ||
      span.kind === "wikilink" ||
      span.kind === "autolink" ||
      span.kind === "linkReference"
    ) {
      return null;
    }

    if (span.kind === "link") {
      if (action === "link") {
        const relStart = from <= span.innerStart && to >= span.innerEnd ? 0 : Math.max(0, from - span.innerStart);
        const relEnd =
          from <= span.innerStart && to >= span.innerEnd
            ? span.innerEnd - span.innerStart
            : Math.max(relStart, to - span.innerStart);
        const innerRange = reversed
          ? { anchor: span.innerEnd, head: span.innerStart }
          : { anchor: span.innerStart, head: span.innerEnd };
        const unwrapped = toggleMarkdownFormat(activeDoc, [innerRange], "link", 0);
        if (unwrapped.doc.length >= activeDoc.length) return null;
        const checked = validateResult(unwrapped);
        return checked ? buildPreservedSubrangeResult(checked, relStart, relEnd, reversed) : null;
      }
      if (from < span.innerStart || to > span.innerEnd) return null;
    }
  }

  const sameFormatSpan = enclosing.find(
    (s) => (action === "bold" && s.kind === "strong") || (action === "italic" && s.kind === "emphasis"),
  );
  if (sameFormatSpan) {
    const relStart =
      from <= sameFormatSpan.innerStart && to >= sameFormatSpan.innerEnd
        ? 0
        : Math.max(0, from - sameFormatSpan.innerStart);
    const relEnd =
      from <= sameFormatSpan.innerStart && to >= sameFormatSpan.innerEnd
        ? sameFormatSpan.innerEnd - sameFormatSpan.innerStart
        : Math.max(relStart, to - sameFormatSpan.innerStart);
    const innerRange = reversed
      ? { anchor: sameFormatSpan.innerEnd, head: sameFormatSpan.innerStart }
      : { anchor: sameFormatSpan.innerStart, head: sameFormatSpan.innerEnd };
    const unwrapped = toggleMarkdownFormat(activeDoc, [innerRange], action, 0);
    if (unwrapped.doc.length >= activeDoc.length) return null;
    const checked = validateResult(unwrapped);
    return checked ? buildPreservedSubrangeResult(checked, relStart, relEnd, reversed) : null;
  }

  for (const span of spans) {
    if (from >= span.outerEnd || to <= span.outerStart) continue;
    if (span.outerStart <= from && to <= span.outerEnd) {
      if (from < span.innerStart || to > span.innerEnd) return null;
      continue;
    }
    if (!(from <= span.outerStart && span.outerEnd <= to)) {
      return null;
    }
    if (
      (action === "bold" && span.kind === "strong") ||
      (action === "italic" && span.kind === "emphasis") ||
      (action === "inline_code" && span.kind === "inlineCode") ||
      (action === "inline_math" && (span.kind === "inlineMath" || span.kind === "inlineCode")) ||
      (action === "link" &&
        ["link", "linkReference", "wikilink", "autolink", "image", "imageReference"].includes(span.kind))
    ) {
      return null;
    }
  }

  return validateResult(toggleMarkdownFormat(activeDoc, [docRange], action, 0));
}
