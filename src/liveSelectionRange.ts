import { visit } from "unist-util-visit";
import { analyzeDocument, type SourceDocumentAnalysis } from "./documentAnalysis";

export interface LiveEditingSpanContext {
  baseMarkdown: string;
  baseSplitEnd: number;
}

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
}

const EXCLUDED_SELECTION_CONTAINER_SELECTOR =
  "textarea,input,select,button,.cm-editor,.live-active-block,.live-block-edit,.code-toolbar,.cell-toolbar,.cell-output,[data-frontmatter-properties],.document-properties,.reading-search,.image-viewer,.media-dialog,.math-repair-panel,[data-windowed-mounted=\"false\"]";

const LEAF_BLOCK_SELECTOR = "p,h1,h2,h3,h4,h5,h6,li,summary,td,th,pre";

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

interface InlineWrapperBounds {
  kind: string;
  outerStart: number;
  innerStart: number;
  innerEnd: number;
  outerEnd: number;
}

function findPercentCommentClose(raw: string, openIndex: number): number {
  for (let i = openIndex + 2; i + 1 < raw.length; i++) {
    if (raw[i] === "%" && raw[i + 1] === "%" && raw[i - 1] !== "\\") {
      return i + 2;
    }
  }
  return -1;
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

  const out: SourceUnit[] = [];
  let r = 0;
  let v = 0;
  while (v < value.length && r < raw.length) {
    if (
      raw[r] === "%" &&
      raw[r + 1] === "%" &&
      (r === 0 || raw[r - 1] !== "\\") &&
      !(value[v] === "%" && value[v + 1] === "%")
    ) {
      const commentEnd = findPercentCommentClose(raw, r);
      if (commentEnd > r) {
        r = commentEnd;
        continue;
      }
    }

    const vCh = value[v];
    const rCh = raw[r];

    if (vCh === "\n" && (rCh === "\r" || rCh === "\n")) {
      const nlStart = r;
      if (raw[r] === "\r" && raw[r + 1] === "\n") r += 2;
      else r += 1;
      const nextValueChar = v + 1 < value.length ? value[v + 1] : "";
      while (r < raw.length && (raw[r] === " " || raw[r] === "\t" || raw[r] === ">")) {
        if (nextValueChar && raw[r] === nextValueChar && raw.slice(r, r + 4) === value.slice(v + 1, v + 5)) {
          break;
        }
        r++;
      }
      out.push({ from: baseOffset + nlStart, to: baseOffset + r, char: "\n" });
      v++;
      continue;
    }

    if (rCh === "\\" && r + 1 < raw.length && raw[r + 1] === vCh) {
      out.push({ from: baseOffset + r, to: baseOffset + r + 2, char: vCh });
      r += 2;
      v++;
      continue;
    }

    if (rCh === "&") {
      const entity = /^&(?:#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/.exec(raw.slice(r));
      if (entity && (rCh !== vCh || !raw.slice(r, r + value.length - v).startsWith(value.slice(v, v + entity[0].length)))) {
        const cp = value.codePointAt(v) ?? 0;
        const unitLen = cp > 0xffff ? 2 : 1;
        for (let k = 0; k < unitLen && v + k < value.length; k++) {
          out.push({
            from: baseOffset + (k === 0 ? r : r + entity[0].length),
            to: baseOffset + r + entity[0].length,
            char: value[v + k],
          });
        }
        r += entity[0].length;
        v += unitLen;
        continue;
      }
    }

    out.push({ from: baseOffset + r, to: baseOffset + r + 1, char: vCh });
    r++;
    v++;
  }

  while (v < value.length) {
    const clamped = baseOffset + Math.min(r, raw.length);
    out.push({ from: clamped, to: clamped, char: value[v] });
    v++;
  }

  return { units: out, consumedRaw: r };
}

function mapTextNodeUnits(raw: string, value: string, baseOffset: number): SourceUnit[] {
  return consumeTextUnits(raw, value, baseOffset).units;
}

function inlineMathInnerBounds(source: string, start: number, end: number): [number, number] {
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

function inlineCodeInnerBounds(source: string, start: number, end: number, value: string): [number, number] {
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

function flattenInlineText(nodes: any[]): string {
  let out = "";
  for (const node of nodes) {
    if (!node) continue;
    if (typeof node.value === "string") out += node.value;
    else if (Array.isArray(node.children)) out += flattenInlineText(node.children);
  }
  return out;
}

function studyDelimiterForType(type: string): string | null {
  if (type === "highlight") return "==";
  if (type === "subscript") return "~";
  if (type === "superscript") return "^";
  return null;
}

function skipLeadingIgnoredComments(source: string, cursor: number, limitEnd: number): number {
  let pos = cursor;
  while (pos + 1 < limitEnd && source[pos] === "%" && source[pos + 1] === "%" && (pos === 0 || source[pos - 1] !== "\\")) {
    const close = findPercentCommentClose(source.slice(pos, limitEnd), 0);
    if (close < 0) break;
    pos += close;
  }
  return pos;
}

function collectMdastInlineStream(
  children: any[],
  source: string,
  scopeStart: number,
  scopeEnd: number,
  units: SourceUnit[],
  wrappers: InlineWrapperBounds[],
  mathWrappers: InlineWrapperBounds[],
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
        wrappers.push({ kind: "inlineCode", outerStart: start, innerStart, innerEnd, outerEnd: end });
        for (let i = 0; i < node.value.length; i++) {
          const pos = Math.min(innerEnd, innerStart + i);
          units.push({ from: pos, to: Math.min(innerEnd, pos + 1), char: node.value[i] });
        }
        cursor = end;
        continue;
      }

      if (node.type === "inlineMath" && typeof start === "number" && typeof end === "number") {
        const [innerStart, innerEnd] = inlineMathInnerBounds(source, start, end);
        const entry: InlineWrapperBounds = { kind: "inlineMath", outerStart: start, innerStart, innerEnd, outerEnd: end };
        wrappers.push(entry);
        mathWrappers.push(entry);
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
        wrappers.push({ kind: node.type, outerStart: start, innerStart: start, innerEnd: end, outerEnd: end });
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
              wrappers.push({
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
        if (rawLink.startsWith("[[") && rawLink.endsWith("]]") && rawLink.length >= 4) {
          const innerSlice = rawLink.slice(2, -2);
          const pipeIdx = innerSlice.indexOf("|");
          let innerStart = start + 2;
          const innerEnd = end - 2;
          if (pipeIdx >= 0) {
            innerStart = start + 2 + pipeIdx + 1;
          } else if (innerSlice.startsWith("#")) {
            innerStart = start + 3;
          }
          const visible = flattenInlineText(node.children ?? []);
          units.push(...mapTextNodeUnits(source.slice(innerStart, innerEnd), visible, innerStart));
          wrappers.push({
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

      const studyDelim = studyDelimiterForType(String(node.type || ""));
      if (studyDelim && Array.isArray(node.children) && (typeof start !== "number" || typeof end !== "number")) {
        cursor = skipLeadingIgnoredComments(source, cursor, limitEnd);
        if (!source.startsWith(studyDelim, cursor)) {
          const nextDelim = source.indexOf(studyDelim, cursor);
          if (nextDelim >= cursor && nextDelim < limitEnd) {
            cursor = nextDelim;
          }
        }
        const outerStart = cursor;
        const innerStart = source.startsWith(studyDelim, cursor) ? cursor + studyDelim.length : cursor;
        cursor = innerStart;
        const beforeUnit = units.length;
        walkList(node.children, limitEnd);
        const afterUnit = units.length;
        cursor = skipLeadingIgnoredComments(source, cursor, limitEnd);
        const resolvedInnerEnd = afterUnit > beforeUnit ? units[afterUnit - 1].to : cursor;
        const closePos = Math.max(cursor, resolvedInnerEnd);
        const outerEnd = source.startsWith(studyDelim, closePos) ? closePos + studyDelim.length : closePos;
        cursor = outerEnd;
        wrappers.push({
          kind: String(node.type),
          outerStart,
          innerStart: afterUnit > beforeUnit ? units[beforeUnit].from : innerStart,
          innerEnd: resolvedInnerEnd,
          outerEnd,
        });
        continue;
      }

      if (Array.isArray(node.children)) {
        const beforeUnit = units.length;
        if (typeof start === "number") {
          const rawNode = source.slice(start, typeof end === "number" ? end : limitEnd);
          let childLead = 0;
          if (node.type === "strong" && (rawNode.startsWith("**") || rawNode.startsWith("__"))) childLead = 2;
          else if (node.type === "emphasis" && (rawNode.startsWith("*") || rawNode.startsWith("_"))) childLead = 1;
          else if (node.type === "delete") {
            while (childLead < rawNode.length && rawNode[childLead] === "~") childLead++;
          } else if (node.type === "link" && rawNode.startsWith("[")) {
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
            wrappers.push({
              kind: String(node.type || "inline"),
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

function splitCalloutParagraphChildren(
  paragraph: any,
  source: string,
): {
  title: any[];
  body: any[];
  hadExplicitTitle: boolean;
  titleStart: number;
  titleEnd: number;
  bodyStart: number;
  bodyEnd: number;
} | null {
  const paraStart: number | undefined = paragraph?.position?.start?.offset;
  const paraEnd: number | undefined = paragraph?.position?.end?.offset;
  if (typeof paraStart !== "number" || typeof paraEnd !== "number") return null;

  const first = paragraph?.children?.[0];
  if (first?.type !== "text" || typeof first.value !== "string") return null;
  const match = /^\[!([\w-]+)\]([+-]?)[ \t]*/i.exec(first.value);
  if (!match) return null;

  const firstStart: number = typeof first.position?.start?.offset === "number" ? first.position.start.offset : paraStart;
  const rawFromFirst = source.slice(firstStart, paraEnd);
  const rawMatch = /^\[!([\w-]+)\]([+-]?)[ \t]*/i.exec(rawFromFirst);
  const rawPrefixLen = rawMatch ? rawMatch[0].length : match[0].length;
  const titleStart = firstStart + rawPrefixLen;

  const firstEnd: number | undefined = first.position?.end?.offset;
  const trimmedFirst = {
    ...first,
    value: first.value.slice(match[0].length),
    ...(typeof firstEnd === "number"
      ? {
          position: {
            start: { offset: titleStart },
            end: { offset: firstEnd },
          },
        }
      : {}),
  };
  const inputChildren = [trimmedFirst, ...paragraph.children.slice(1)];

  let computedTitleEnd = paraEnd;
  let computedBodyStart = paraEnd;

  const splitNodes = (nodes: any[]): { title: any[]; body: any[]; ended: boolean } => {
    const title: any[] = [];
    const body: any[] = [];
    let ended = false;
    for (const child of nodes) {
      if (ended) {
        body.push(child);
        continue;
      }
      if (child.type === "break") {
        if (typeof child.position?.start?.offset === "number") computedTitleEnd = child.position.start.offset;
        if (typeof child.position?.end?.offset === "number") computedBodyStart = child.position.end.offset;
        ended = true;
        continue;
      }
      if (child.type === "text" && typeof child.value === "string") {
        const at = child.value.indexOf("\n");
        if (at >= 0) {
          const cStart: number | undefined = child.position?.start?.offset;
          const cEnd: number | undefined = child.position?.end?.offset;
          let titleEndOffset: number | undefined;
          let bodyStartOffset: number | undefined;
          if (typeof cStart === "number" && typeof cEnd === "number") {
            const units = mapTextNodeUnits(source.slice(cStart, cEnd), child.value, cStart);
            titleEndOffset = at > 0 ? units[at - 1].to : cStart;
            bodyStartOffset = units[at]?.to ?? cEnd;
            computedTitleEnd = titleEndOffset;
            computedBodyStart = bodyStartOffset;
          }
          if (at > 0) {
            title.push({
              ...child,
              value: child.value.slice(0, at),
              ...(typeof cStart === "number" && typeof titleEndOffset === "number"
                ? { position: { start: { offset: cStart }, end: { offset: titleEndOffset } } }
                : { position: undefined }),
            });
          }
          if (child.value.length > at + 1) {
            body.push({
              ...child,
              value: child.value.slice(at + 1),
              ...(typeof bodyStartOffset === "number" && typeof cEnd === "number"
                ? { position: { start: { offset: bodyStartOffset }, end: { offset: cEnd } } }
                : { position: undefined }),
            });
          }
          ended = true;
        } else if (child.value.length > 0) {
          title.push(child);
        }
      } else if (Array.isArray(child.children)) {
        const parts = splitNodes(child.children);
        if (parts.title.length) title.push({ ...child, children: parts.title });
        if (parts.body.length) body.push({ ...child, children: parts.body });
        ended = parts.ended;
      } else {
        title.push(child);
      }
    }
    return { title, body, ended };
  };

  const split = splitNodes(inputChildren);
  if (computedBodyStart === paraEnd && split.body.length > 0) {
    const rawAfterTitle = source.slice(titleStart, paraEnd);
    const nlMatch = /\r?\n[ \t>]*/.exec(rawAfterTitle);
    if (nlMatch) {
      computedTitleEnd = titleStart + nlMatch.index;
      computedBodyStart = titleStart + nlMatch.index + nlMatch[0].length;
    }
  }
  const hadExplicitTitle = split.title.some((child: any) => child.type !== "text" || child.value.trim().length > 0);
  return {
    title: split.title,
    body: split.body,
    hadExplicitTitle,
    titleStart,
    titleEnd: computedTitleEnd,
    bodyStart: computedBodyStart,
    bodyEnd: paraEnd,
  };
}

interface ResolvedScopeStream {
  children: any[];
  scopeStart: number;
  scopeEnd: number;
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
    const bStart = Number(blockEl.dataset.sourceStart);
    const bEnd = Number(blockEl.dataset.sourceEnd);
    let blockquoteNode: any = null;
    visit(tree, "blockquote", (node: any) => {
      if (blockquoteNode || !node.position) return;
      const nStart = node.position.start.offset;
      const nEnd = node.position.end.offset;
      if (nStart >= bStart && nEnd <= bEnd) {
        blockquoteNode = node;
      }
    });
    const firstPara = blockquoteNode?.children?.[0];
    if (firstPara?.type === "paragraph") {
      const split = splitCalloutParagraphChildren(firstPara, source);
      if (split) {
        if (scopeEl.classList.contains("callout-title")) {
          return split.hadExplicitTitle
            ? { children: split.title, scopeStart: split.titleStart, scopeEnd: split.titleEnd }
            : null;
        }
        const scopeStart = Number(scopeEl.dataset.sourceStart);
        const scopeEnd = Number(scopeEl.dataset.sourceEnd);
        if (
          scopeStart === firstPara.position?.start?.offset &&
          scopeEnd === firstPara.position?.end?.offset
        ) {
          return { children: split.body, scopeStart: split.bodyStart, scopeEnd: split.bodyEnd };
        }
      }
    }
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
    return { children: directPara.children, scopeStart, scopeEnd };
  }
  const [scopeStart, scopeEnd] = computeContentBoundsForNode(matched, source);
  return { children: matched.children, scopeStart, scopeEnd };
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

  let startUnit: number | null = null;
  let endUnit: number | null = null;
  let startMathOrdinal: number | null = null;
  let endMathOrdinal: number | null = null;

  const isExcludedElement = (el: Element): boolean => {
    if (
      el.matches(
        "button,input,select,textarea,script,style,.live-block-edit,.katex-mathml,[data-frontmatter-properties],.document-properties",
      )
    ) {
      if (el.tagName === "INPUT" && (el as HTMLInputElement).type === "checkbox") {
        skipTaskCheckboxSpace = true;
      }
      return true;
    }
    if (scopeEl.tagName === "LI" && el !== scopeEl && el.matches("ul,ol,blockquote,pre,details,table")) {
      return true;
    }
    return false;
  };

  const isAtomicImageSpan = (el: Element): boolean =>
    el.matches("[data-note-image-source]") ||
    (el.classList.contains("image-loading") && !el.closest("[data-note-image-source]"));

  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const data = (node as Text).data;
      let skipPrefix = 0;
      if (skipTaskCheckboxSpace) {
        skipTaskCheckboxSpace = false;
        if (data.startsWith(" ")) skipPrefix = 1;
      }
      const effective = skipPrefix ? data.slice(skipPrefix) : data;
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
    if (isExcludedElement(node)) {
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
      }
    }
  };

  walk(scopeEl);

  if (startUnit === null || endUnit === null || startUnit >= endUnit) return null;
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
 * Maps a rendered DOM selection inside `.live-document` to its current source
 * range. Multi-block and multi-paragraph selections return `null` so
 * multi-paragraph transformations stay separate.
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

  const reversed = isSelectionBackward(selection);

  let renderedFrom: number | null = null;
  let renderedTo: number | null = null;

  if (scopeEl.tagName === "PRE") {
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
    const analysis =
      sourceAnalysis?.source === renderedSource ? sourceAnalysis.analysis : analyzeDocument(renderedSource);
    const resolvedScope = resolveScopeMdastChildren(scopeEl, startBlock, renderedSource, analysis.tree);
    const domStream = measureDomSelectionUnits(scopeEl, range);

    if (resolvedScope && domStream) {
      const units: SourceUnit[] = [];
      const wrappers: InlineWrapperBounds[] = [];
      const mathWrappers: InlineWrapperBounds[] = [];
      collectMdastInlineStream(
        resolvedScope.children,
        renderedSource,
        resolvedScope.scopeStart,
        resolvedScope.scopeEnd,
        units,
        wrappers,
        mathWrappers,
      );

      if (
        domStream.startMathOrdinal !== null &&
        domStream.startMathOrdinal === domStream.endMathOrdinal &&
        mathWrappers[domStream.startMathOrdinal]
      ) {
        const targetMath = mathWrappers[domStream.startMathOrdinal];
        renderedFrom = targetMath.innerStart;
        renderedTo = targetMath.innerEnd;
      } else if (units.length === domStream.text.length && domStream.endUnit <= units.length) {
        let rawFrom = units[domStream.startUnit].from;
        let rawTo = units[domStream.endUnit - 1].to;

        for (const wrapper of wrappers) {
          if (rawFrom === wrapper.innerStart && rawTo > wrapper.outerEnd) {
            rawFrom = Math.min(rawFrom, wrapper.outerStart);
          }
          if (rawTo === wrapper.innerEnd && rawFrom < wrapper.outerStart) {
            rawTo = Math.max(rawTo, wrapper.outerEnd);
          }
        }

        renderedFrom = rawFrom;
        renderedTo = rawTo;
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
  };
}
