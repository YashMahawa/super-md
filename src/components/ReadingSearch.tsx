import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { setReaderOverlay } from "../readerOverlays";
import { ArrowUpIcon, ArrowDownIcon, XIcon, TextAaIcon, TextboxIcon, AsteriskIcon, ArrowsClockwiseIcon } from "@phosphor-icons/react";
import { editorFindQuery, editorFindRange } from "./Editor";
import { windowedMatches, revealWindowed, compileSearchPattern, nextSearchMatch, normalizeSearchOptions, type WindowedMatch, type SearchMatchConfig, type SearchMatchOptions } from "../windowedSearch";
import { parseFrontmatter, type FrontmatterVisibleField, type FrontmatterVisibleSpan, type ParsedFrontmatter } from "../frontmatter";
import { cancelHeadingNavigation } from "../documentNavigation";
import { refreshDocumentExtent } from "../documentZoom";
export type { SearchMatchConfig, SearchMatchOptions } from "../windowedSearch";

const cancelSettlingHeading = () => document.querySelectorAll(".android-reading,.reading-scroll,.live-pane").forEach(cancelHeadingNavigation);
const findReadingHost = () => document.querySelector<HTMLElement>(".android-reading,.reading-scroll,.live-document,.markdown-body");
const MANUAL_SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);
const SEARCH_SETTLE_WINDOW_MS = 800;
type HighlightRegistry = Map<string, unknown>;
type SourceRange = { from: number; to: number };
const INLINE_HTML_HIDDEN_TOKEN = /<!--[\s\S]*?-->|<\/?(?:br|mark|sub|sup|kbd|u)(?:\s+(?:[^>"']|"[^"]*"|'[^']*')*)?\s*\/?>/gi;
const EXCLUDED_SEARCH_TAGS = new Set(["button", "input", "textarea", "select", "svg", "script", "style", "template", "annotation", "iframe"]);
const EXCLUDED_SEARCH_CLASS_PATTERN = /(?:^|\s)(?:katex-mathml|chart-controls|chart-toolbar|chart-legend|image-edit-tools|image-loading|image-error|remote-image-card|is-offstage)(?:\s|$)/;
const SEARCH_BLOCK_TAGS = new Set(["p", "h1", "h2", "h3", "h4", "li", "pre", "td", "summary"]);

let cachedFrontmatterContent: string | null = null;
let cachedFrontmatterResult: ParsedFrontmatter | null = null;
function getParsedFrontmatter(content: string): ParsedFrontmatter | null {
  if (cachedFrontmatterContent === content) return cachedFrontmatterResult;
  cachedFrontmatterContent = content;
  cachedFrontmatterResult = parseFrontmatter(content, { includeSpans: true });
  return cachedFrontmatterResult;
}

function isFrontmatterPropertiesContainer(el: Element): boolean {
  return el.hasAttribute("data-frontmatter-properties") || el.classList.contains("document-properties");
}

function isAllowedFrontmatterField(el: Element): el is HTMLElement {
  const field = el.getAttribute("data-frontmatter-field");
  return field === "title" || field === "author" || field === "tag";
}

function isHiddenOrExcludedSearchElement(el: Element): boolean {
  if (EXCLUDED_SEARCH_TAGS.has(el.localName)) return true;
  if (!el.hasAttributes()) return false;
  const cls = el.className;
  const hasClassString = typeof cls === "string" && cls.length > 0;
  if (hasClassString && EXCLUDED_SEARCH_CLASS_PATTERN.test(cls)) return true;
  if (
    el.getAttribute("data-windowed-mounted") === "false" ||
    el.hasAttribute("hidden") ||
    el.hasAttribute("inert")
  ) {
    return true;
  }
  if (el.getAttribute("aria-hidden") === "true" && !el.classList.contains("katex-html")) return true;
  const inlineStyle = el.getAttribute("style");
  if (inlineStyle && (inlineStyle.includes("none") || inlineStyle.includes("hidden"))) {
    const style = (el as HTMLElement).style;
    if (style && (style.display === "none" || style.visibility === "hidden")) return true;
  }
  return false;
}

export function nextSearchIndex(index: number, direction: number, count: number): number {
  if (count <= 0) return -1;
  if (index < 0) return direction < 0 ? count - 1 : 0;
  return ((index + direction) % count + count) % count;
}

function revealMountedBlock(element: Element): void {
  if (!(element instanceof HTMLElement)) return;
  if (element.closest('[data-windowed-mounted="false"]')) flushSync(() => revealWindowed(element));
  else revealWindowed(element);
}

function scrollTargetIntoView(target: Element | null, host?: Element | null): void {
  if (!target) return;
  const scroller = target.closest<HTMLElement>(".android-reading,.reading-scroll") ?? (host?.matches(".android-reading,.reading-scroll") ? host as HTMLElement : host?.closest<HTMLElement>(".android-reading,.reading-scroll") ?? null);
  if (scroller) refreshDocumentExtent(scroller);
  target.scrollIntoView?.({ block: "center", behavior: "instant" });
}

function expandRegexReplacement(replacement: string, match: RegExpExecArray, source: string): string {
  return replacement.replace(/\$(?:\$|&|`|'|(\d{1,2})|<([^>]+)>)/g, (token, digits?: string, groupName?: string) => {
    if (token === "$$") return "$";
    if (token === "$&") return match[0];
    if (token === "$`") return source.slice(0, match.index);
    if (token === "$'") return source.slice(match.index + match[0].length);
    if (digits !== undefined) {
      const two = Number(digits);
      if (digits.length === 2 && two > 0 && two < match.length) return match[two] ?? "";
      const one = Number(digits[0]);
      if (one > 0 && one < match.length) return (match[one] ?? "") + digits.slice(1);
      return token;
    }
    if (groupName !== undefined && match.groups) {
      return Object.prototype.hasOwnProperty.call(match.groups, groupName) ? (match.groups[groupName] ?? "") : "";
    }
    return token;
  });
}

function markdownBracketEnd(raw: string, openIndex = 0): number {
  if (raw[openIndex] !== "[") return raw.length;
  let depth = 0;
  for (let i = openIndex; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "\\") { i++; continue; }
    if (ch === "`") {
      let ticks = 1;
      while (raw[i + ticks] === "`") ticks++;
      const close = raw.indexOf("`".repeat(ticks), i + ticks);
      if (close >= 0) { i = close + ticks - 1; continue; }
    }
    if (ch === "[") depth++;
    else if (ch === "]") { depth--; if (depth === 0) return i; }
  }
  return raw.length;
}

function markdownLinkTailEnd(raw: string, afterBracket: number): number {
  if (raw[afterBracket] === "(") {
    let depth = 0;
    for (let i = afterBracket; i < raw.length; i++) {
      const ch = raw[i];
      if (ch === "\\") { i++; continue; }
      if (ch === "(") depth++;
      else if (ch === ")") { depth--; if (depth === 0) return i + 1; }
    }
    return raw.length;
  }
  if (raw[afterBracket] === "[") {
    const end = markdownBracketEnd(raw, afterBracket);
    return end < raw.length ? end + 1 : raw.length;
  }
  return afterBracket;
}

function hiddenSpansInSlice(raw: string, offset: number): SourceRange[] {
  const hidden: SourceRange[] = [];
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "\\") { i++; continue; }
    if (ch === "`") {
      let ticks = 1;
      while (raw[i + ticks] === "`") ticks++;
      const close = raw.indexOf("`".repeat(ticks), i + ticks);
      if (close >= 0) { i = close + ticks - 1; continue; }
    }
    if (ch === "<") {
      INLINE_HTML_HIDDEN_TOKEN.lastIndex = i;
      const htmlMatch = INLINE_HTML_HIDDEN_TOKEN.exec(raw);
      if (htmlMatch && htmlMatch.index === i) {
        const end = i + htmlMatch[0].length;
        hidden.push({ from: offset + i, to: offset + end });
        i = Math.max(i, end - 1);
        continue;
      }
    }
    if (ch === "!" && raw[i + 1] === "[") {
      const close = markdownBracketEnd(raw, i + 1);
      if (close < raw.length) {
        const end = markdownLinkTailEnd(raw, close + 1);
        hidden.push({ from: offset + i, to: offset + end });
        i = Math.max(i, end - 1);
        continue;
      }
    }
    if (ch === "[") {
      const close = markdownBracketEnd(raw, i);
      if (close < raw.length) {
        const end = markdownLinkTailEnd(raw, close + 1);
        if (end > close + 1) {
          hidden.push({ from: offset + close, to: offset + end });
          i = Math.max(i, end - 1);
        }
      }
    }
  }
  return hidden;
}

function sourceBounds(el: Element, content?: string): { start: number; end: number } | null {
  if (!(el instanceof HTMLElement) || el.tagName === "TEXTAREA") return null;
  const attrStart = el.getAttribute("data-source-start"), attrEnd = el.getAttribute("data-source-end");
  if (attrStart !== null && attrEnd !== null) {
    const start = Number(attrStart), end = Number(attrEnd);
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) return { start, end };
  }
  if (content !== undefined && el.classList.contains("code-container")) {
    let regionStart = 0, ordinal = 0;
    for (let prev = el.previousElementSibling; prev; prev = prev.previousElementSibling) {
      const prevEnd = prev instanceof HTMLElement ? prev.getAttribute("data-source-end") : null;
      if (prevEnd !== null && Number.isFinite(Number(prevEnd))) { regionStart = Number(prevEnd); break; }
      if (prev instanceof HTMLElement && prev.classList.contains("code-container")) ordinal++;
    }
    if (regionStart === 0) {
      const fm = getParsedFrontmatter(content);
      if (fm) regionStart = fm.end;
    }
    let regionEnd = content.length;
    for (let next = el.nextElementSibling; next; next = next.nextElementSibling) {
      const nextStart = next instanceof HTMLElement ? next.getAttribute("data-source-start") : null;
      if (nextStart !== null && Number.isFinite(Number(nextStart))) { regionEnd = Number(nextStart); break; }
    }
    if (regionEnd >= regionStart) {
      const slice = content.slice(regionStart, regionEnd);
      const fencePattern = /^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n[ \t]*\1[ \t]*(?=\r?\n|$)/gm;
      let match: RegExpExecArray | null, seen = 0;
      while ((match = fencePattern.exec(slice))) {
        if (seen === ordinal) return { start: regionStart + match.index, end: regionStart + match.index + match[0].length };
        seen++;
      }
      return { start: regionStart, end: regionEnd };
    }
  }
  return null;
}

function openDisclosuresFor(target: Element | null, scope?: Element | null, range?: Range | null, sourceRange?: SourceRange): boolean {
  let opened = false;
  const startEl = range ? (range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer as Element : range.startContainer.parentElement) : null;
  for (const anchor of [startEl, target, scope]) {
    for (let owner = anchor?.closest("details") || null; owner; owner = owner.parentElement?.closest("details") || null) {
      if (!owner.open) { owner.open = true; opened = true; }
    }
  }
  const container = scope ?? target;
  if (container) {
    if (container instanceof HTMLDetailsElement && !container.open) { container.open = true; opened = true; }
    for (const disclosure of container.querySelectorAll<HTMLDetailsElement>("details")) {
      if (disclosure.open) continue;
      if (range && disclosure.contains(range.startContainer)) { disclosure.open = true; opened = true; continue; }
      if (sourceRange) {
        const bounds = sourceBounds(disclosure.closest("[data-source-start]") || disclosure);
        if (!bounds || (bounds.start <= sourceRange.from && sourceRange.from <= bounds.end)) { disclosure.open = true; opened = true; }
      }
    }
  }
  return opened;
}

function visibleSourceSpan(owner: HTMLElement, content: string): { start: number; end: number } | null {
  const bounds = sourceBounds(owner, content);
  if (!bounds) return null;
  const { start, end } = bounds;
  const raw = content.slice(start, end);
  if (owner.tagName === "A" && raw.startsWith("[")) {
    const close = markdownBracketEnd(raw, 0);
    return close < raw.length ? { start: start + 1, end: start + close } : bounds;
  }
  if (owner.matches("details.callout,aside.callout")) {
    const marker = raw.match(/^\s*(?:>[ \t]*)?\[![\w-]+\][+-]?[ \t]*/i);
    if (marker) return { start: start + marker[0].length, end };
  }
  if (owner.matches(".code-container,.python-cell")) {
    const firstBreak = raw.indexOf("\n");
    if (firstBreak < 0) return { start: end, end };
    let bodyEnd = end;
    const trimmed = raw.replace(/\s+$/, "");
    const lastBreak = trimmed.lastIndexOf("\n");
    if (lastBreak >= firstBreak) {
      const closingLine = trimmed.slice(lastBreak + 1);
      if (/^\s*(?:`{3,}|~{3,})\s*$/.test(closingLine)) bodyEnd = start + lastBreak;
    }
    return { start: Math.min(start + firstBreak + 1, bodyEnd), end: bodyEnd };
  }
  return bounds;
}

function ownerDomScope(owner: HTMLElement): Element {
  if (owner.matches(".code-container,.python-cell")) {
    return owner.querySelector("pre.python-source,pre") ?? owner;
  }
  return owner;
}

function findContainingBlock(host: Element, range: SourceRange, content?: string): HTMLElement | null {
  const candidates = host.querySelectorAll<HTMLElement>(".live-block,[data-windowed-block],[data-source-start],.code-container");
  let best: HTMLElement | null = null, bestLen = Infinity;
  let overlapping: HTMLElement | null = null, overlappingLen = Infinity;
  for (const el of candidates) {
    const bounds = sourceBounds(el, content);
    if (!bounds) continue;
    const len = bounds.end - bounds.start;
    const isTopBlock = el.classList.contains("live-block") || el.hasAttribute("data-windowed-block");
    if (bounds.start <= range.from && range.to <= bounds.end) {
      if (isTopBlock) {
        if (!best || (!best.classList.contains("live-block") && !best.hasAttribute("data-windowed-block")) || len < bestLen) {
          best = el; bestLen = len;
        }
      } else if (!best && len <= bestLen) {
        best = el; bestLen = len;
      }
    } else if (bounds.start <= range.from && range.from < bounds.end && len <= overlappingLen) {
      overlapping = el; overlappingLen = len;
    }
  }
  return best ?? overlapping;
}

function deepestSourceOwner(block: HTMLElement, range: SourceRange, content?: string): HTMLElement | null {
  let owner: HTMLElement | null = null, ownerLen = Infinity;
  const blockBounds = sourceBounds(block, content);
  if (blockBounds && blockBounds.start <= range.from && range.from <= blockBounds.end) {
    owner = block; ownerLen = blockBounds.end - blockBounds.start;
  }
  for (const el of block.querySelectorAll<HTMLElement>("[data-source-start],.code-container")) {
    const bounds = sourceBounds(el, content);
    if (!bounds) continue;
    const len = bounds.end - bounds.start;
    if (bounds.start <= range.from && range.to <= bounds.end && len <= ownerLen) {
      owner = el; ownerLen = len;
    }
  }
  return owner;
}

function isDirectVisibleMatch(owner: HTMLElement, content: string, candidate: SourceRange): boolean {
  const visible = visibleSourceSpan(owner, content);
  if (!visible || candidate.from < visible.start || candidate.to > visible.end) return false;
  if (deepestSourceOwner(owner, candidate, content) !== owner) return false;
  if (!owner.closest("pre,code,.code-container,.python-cell") && visible.end - visible.start <= 200_000) {
    const hidden = hiddenSpansInSlice(content.slice(visible.start, visible.end), visible.start);
    if (hidden.some(h => candidate.from >= h.from && candidate.to <= h.to)) return false;
  }
  return true;
}

function directOwnerDomRanges(owner: HTMLElement, query: string, options: SearchMatchConfig): Range[] {
  const scope = ownerDomScope(owner);
  return readingMatches(scope, query, options).filter(r => {
    if (owner.matches(".code-container,.python-cell") && r.startContainer.parentElement?.closest("summary")) return false;
    const common = r.commonAncestorContainer.nodeType === Node.ELEMENT_NODE ? r.commonAncestorContainer as Element : r.commonAncestorContainer.parentElement;
    const closestOwner = common?.closest("[data-source-start],.code-container");
    return !closestOwner || closestOwner === owner || !owner.contains(closestOwner);
  });
}

function mapSourceRangeToDomRange(block: HTMLElement, content: string, ranges: SourceRange[], activeIndex: number, query: string, options: SearchMatchConfig = false): Range | null {
  const target = ranges[activeIndex];
  if (!target || block.closest('[data-windowed-mounted="false"]')) return null;
  const owner = deepestSourceOwner(block, target, content);
  if (!owner || !isDirectVisibleMatch(owner, content, target)) return null;
  const domRanges = directOwnerDomRanges(owner, query, options);
  if (!domRanges.length) return null;
  const ownerBounds = sourceBounds(owner, content);
  let ordinal = 0;
  for (let i = 0; i < activeIndex; i++) {
    const candidate = ranges[i];
    if (ownerBounds && (candidate.from < ownerBounds.start || candidate.to > ownerBounds.end)) continue;
    if (deepestSourceOwner(block, candidate, content) === owner && isDirectVisibleMatch(owner, content, candidate)) ordinal++;
  }
  return domRanges[ordinal] ?? null;
}

function sameDomRange(a: Range, b: Range): boolean {
  return a.startContainer === b.startContainer && a.startOffset === b.startOffset && a.endContainer === b.endContainer && a.endOffset === b.endOffset;
}

function findFrontmatterFieldElement(host: Element, field: FrontmatterVisibleField, fieldOrdinal: number): HTMLElement | null {
  const header = isFrontmatterPropertiesContainer(host)
    ? host
    : host.querySelector("[data-frontmatter-properties],.document-properties");
  if (!header) return null;
  const list = header.querySelectorAll<HTMLElement>(`[data-frontmatter-field="${field}"]`);
  return list[fieldOrdinal] ?? null;
}

function orderedFrontmatterSourceIndices(
  spans: FrontmatterVisibleSpan[],
  ranges: SourceRange[],
  field: FrontmatterVisibleField,
  fieldOrdinal: number,
): number[] {
  const indices: number[] = [];
  for (const span of spans) {
    if (span.field !== field || span.fieldOrdinal !== fieldOrdinal) continue;
    for (let i = 0; i < ranges.length; i++) {
      const candidate = ranges[i];
      if (candidate.from >= span.start && candidate.to <= span.end && !indices.includes(i)) {
        indices.push(i);
      }
    }
  }
  return indices;
}

function mapFrontmatterSourceRangeToDomRange(
  host: Element,
  content: string,
  ranges: SourceRange[],
  activeIndex: number,
  query: string,
  options: SearchMatchConfig = false,
): Range | null {
  const target = ranges[activeIndex];
  if (!target) return null;
  const spans = getParsedFrontmatter(content)?.visibleSpans;
  if (!spans?.length) return null;
  const matchSpan = spans.find(s => target.from >= s.start && target.to <= s.end);
  if (!matchSpan) return null;
  const fieldEl = findFrontmatterFieldElement(host, matchSpan.field, matchSpan.fieldOrdinal);
  if (!fieldEl) return null;
  const domRanges = readingMatches(fieldEl, query, options);
  if (!domRanges.length) return null;
  const orderedIndices = orderedFrontmatterSourceIndices(spans, ranges, matchSpan.field, matchSpan.fieldOrdinal);
  const ordinal = orderedIndices.indexOf(activeIndex);
  return ordinal >= 0 ? (domRanges[ordinal] ?? null) : null;
}

function mapDomRangeToSourceIndex(host: Element, content: string, ranges: SourceRange[], domRange: Range, query: string, options: SearchMatchConfig = false): number {
  const common = domRange.commonAncestorContainer.nodeType === Node.ELEMENT_NODE ? domRange.commonAncestorContainer as Element : domRange.commonAncestorContainer.parentElement;
  const fmFieldEl = common?.closest<HTMLElement>("[data-frontmatter-field]");
  if (fmFieldEl && isAllowedFrontmatterField(fmFieldEl)) {
    const rawField = fmFieldEl.getAttribute("data-frontmatter-field") as FrontmatterVisibleField;
    const header = fmFieldEl.closest("[data-frontmatter-properties],.document-properties") ?? host;
    const siblings = Array.from(header.querySelectorAll<HTMLElement>(`[data-frontmatter-field="${rawField}"]`));
    const fieldOrdinal = siblings.indexOf(fmFieldEl);
    if (fieldOrdinal >= 0) {
      const domRanges = readingMatches(fmFieldEl, query, options);
      const ordinal = domRanges.findIndex(r => sameDomRange(r, domRange));
      if (ordinal >= 0) {
        const spans = getParsedFrontmatter(content)?.visibleSpans;
        if (spans?.length) {
          const orderedIndices = orderedFrontmatterSourceIndices(spans, ranges, rawField, fieldOrdinal);
          if (orderedIndices[ordinal] !== undefined) return orderedIndices[ordinal];
        }
      }
    }
  }
  const owner = common?.closest<HTMLElement>("[data-source-start],.code-container");
  if (owner) {
    const domRanges = directOwnerDomRanges(owner, query, options);
    const ordinal = domRanges.findIndex(r => sameDomRange(r, domRange));
    if (ordinal >= 0) {
      const ownerBounds = sourceBounds(owner, content);
      let seen = 0;
      for (let i = 0; i < ranges.length; i++) {
        const candidate = ranges[i];
        if (ownerBounds && (candidate.from < ownerBounds.start || candidate.to > ownerBounds.end)) continue;
        const block = findContainingBlock(host, candidate, content);
        if (block && deepestSourceOwner(block, candidate, content) === owner && isDirectVisibleMatch(owner, content, candidate)) {
          if (seen === ordinal) return i;
          seen++;
        }
      }
    }
  }
  for (let i = 0; i < ranges.length; i++) {
    const resolved = resolveSourceHighlightRange(host, content, ranges, i, query, options);
    if (resolved && sameDomRange(resolved, domRange)) return i;
  }
  return -1;
}

export function resolveSourceBlock(host: Element, range: SourceRange, content?: string): HTMLElement | null {
  const containing = findContainingBlock(host, range, content);
  if (containing) return deepestSourceOwner(containing, range, content) ?? containing;
  const elements = host.querySelectorAll<HTMLElement>("[data-source-start]");
  let fallback: HTMLElement | null = null;
  for (const el of elements) {
    const bounds = sourceBounds(el, content);
    if (bounds && bounds.start <= range.from) fallback = el;
  }
  return fallback;
}

export function resolveSourceHighlightRange(host: Element, content: string, ranges: SourceRange[], activeIndex: number, query: string, options: SearchMatchConfig = false): Range | null {
  const target = ranges[activeIndex];
  if (!target) return null;
  const block = findContainingBlock(host, target, content);
  if (block) return mapSourceRangeToDomRange(block, content, ranges, activeIndex, query, options);
  return mapFrontmatterSourceRangeToDomRange(host, content, ranges, activeIndex, query, options);
}

function collectSearchText(
  root: Element,
  initialBlock: Element | null,
  state: { parts: Array<{ node: Text; start: number; end: number }>; text: string; block: Element | null },
): void {
  const walk = (el: Element, currentBlock: Element | null) => {
    for (let child = el.firstChild; child; child = child.nextSibling) {
      const nt = child.nodeType;
      if (nt === Node.TEXT_NODE) {
        const value = (child as Text).data;
        if (!value) continue;
        if (state.block !== currentBlock) {
          state.text += "\n";
          state.block = currentBlock;
        }
        const start = state.text.length;
        state.parts.push({ node: child as Text, start, end: start + value.length });
        state.text += value;
      } else if (nt === Node.ELEMENT_NODE) {
        const childEl = child as Element;
        if (isHiddenOrExcludedSearchElement(childEl)) continue;
        if (isFrontmatterPropertiesContainer(childEl)) {
          walkFrontmatterFields(childEl);
          continue;
        }
        const nextBlock = isAllowedFrontmatterField(childEl) || SEARCH_BLOCK_TAGS.has(childEl.localName)
          ? childEl
          : currentBlock;
        walk(childEl, nextBlock);
      }
    }
  };
  const walkFrontmatterFields = (container: Element) => {
    const fields = container.querySelectorAll("[data-frontmatter-field]");
    for (const fieldEl of fields) {
      if (!isAllowedFrontmatterField(fieldEl)) continue;
      let excluded = false;
      for (let anc: Element | null = fieldEl; anc && anc !== container; anc = anc.parentElement) {
        if (isHiddenOrExcludedSearchElement(anc)) { excluded = true; break; }
      }
      if (!excluded) walk(fieldEl, fieldEl);
    }
  };
  if (isFrontmatterPropertiesContainer(root)) {
    walkFrontmatterFields(root);
    return;
  }
  walk(root, initialBlock);
}

function matchPartsToRanges(
  parts: Array<{ node: Text; start: number; end: number }>,
  text: string,
  pattern: RegExp,
): Range[] {
  if (!parts.length) return [];
  // Case folding can expand Unicode characters and invalidate DOM offsets.
  // Regex matches retain the original UTF-16 positions instead.
  const ranges: Range[] = [];
  let match: RegExpExecArray | null, firstIndex = 0, lastIndex = 0;
  while ((match = nextSearchMatch(pattern, text)) && ranges.length < 5000) {
    const start = match.index, end = start + match[0].length;
    while (firstIndex < parts.length && parts[firstIndex].end <= start) firstIndex++;
    lastIndex = Math.max(lastIndex, firstIndex);
    while (lastIndex < parts.length && parts[lastIndex].end < end) lastIndex++;
    const first = parts[firstIndex], last = parts[lastIndex];
    if (!first || !last) continue;
    const startOffset = Math.max(0, Math.min(first.node.length, start - first.start));
    const endOffset = Math.max(0, Math.min(last.node.length, end - last.start));
    if (first.node === last.node && startOffset >= endOffset) continue;
    const range = document.createRange();
    range.setStart(first.node, startOffset);
    range.setEnd(last.node, endOffset);
    ranges.push(range);
  }
  return ranges;
}

export function readingMatches(host: Element, query: string, options: SearchMatchConfig = false): Range[] {
  const { pattern } = compileSearchPattern(query, options, false);
  if (!pattern) return [];
  const rawFieldAnc = host.closest("[data-frontmatter-field]");
  const insideAllowedField = rawFieldAnc && isAllowedFrontmatterField(rawFieldAnc) ? rawFieldAnc : null;
  for (let anc: Element | null = host; anc; anc = anc.parentElement) {
    if (isHiddenOrExcludedSearchElement(anc)) return [];
    if (anc !== host && isFrontmatterPropertiesContainer(anc) && !insideAllowedField) return [];
  }
  const state = { parts: [] as Array<{ node: Text; start: number; end: number }>, text: "", block: null as Element | null };
  collectSearchText(host, insideAllowedField ?? host.closest("p,h1,h2,h3,h4,li,pre,td,summary"), state);
  return matchPartsToRanges(state.parts, state.text, pattern);
}

export function replaceSourceMatches(content: string, query: string, replacement: string, options: SearchMatchConfig = false, index?: number): string {
  const { regexp } = normalizeSearchOptions(options);
  const { pattern } = compileSearchPattern(query, options, true);
  if (!pattern) return content;
  let result = "", cursor = 0, ordinal = 0, match: RegExpExecArray | null;
  while ((match = nextSearchMatch(pattern, content))) {
    const shouldReplace = index === undefined || ordinal === index;
    const insert = shouldReplace ? (regexp ? expandRegexReplacement(replacement, match, content) : replacement) : match[0];
    result += content.slice(cursor, match.index) + insert;
    cursor = match.index + match[0].length;
    ordinal++;
    if (index !== undefined && ordinal > index) break;
  }
  return ordinal === 0 ? content : result + content.slice(cursor);
}

export function sourceMatches(content: string, query: string, options: SearchMatchConfig = false): SourceRange[] {
  const { pattern } = compileSearchPattern(query, options, true);
  if (!pattern) return [];
  const matches: SourceRange[] = [];
  let match: RegExpExecArray | null;
  while ((match = nextSearchMatch(pattern, content)) && matches.length < 5000) {
    matches.push({ from: match.index, to: match.index + match[0].length });
  }
  return matches;
}

export interface ReadingSearchSeed {
  query: string;
  caseSensitive?: boolean;
  sourceStart?: number;
  sourceEnd?: number;
  matchText?: string;
  nonce: number;
}

function extractSeedRange(seed?: ReadingSearchSeed | null): SourceRange | null {
  if (!seed) return null;
  const { sourceStart, sourceEnd } = seed;
  if (typeof sourceStart === "number" && typeof sourceEnd === "number" && Number.isInteger(sourceStart) && Number.isInteger(sourceEnd) && sourceStart >= 0 && sourceEnd >= sourceStart) {
    return { from: sourceStart, to: sourceEnd };
  }
  return null;
}

function extractSeedMatchText(seed?: ReadingSearchSeed | null): string | undefined {
  return typeof seed?.matchText === "string" && seed.matchText.length > 0 ? seed.matchText : undefined;
}

function foldCodePointForSearch(cp: number): string {
  switch (cp) {
    case 0x00df:
    case 0x1e9e:
      return "ss";
    case 0x0130:
      return "i\u0307";
    case 0x0149:
      return "\u02bcn";
    case 0x01f0:
      return "j\u030c";
    case 0x0390:
      return "\u03b9\u0308\u0301";
    case 0x03b0:
      return "\u03c5\u0308\u0301";
    case 0x03c2:
      return "\u03c3";
    case 0x00b5:
      return "\u03bc";
    case 0x0345:
      return "\u03b9";
    case 0x0587:
      return "\u0565\u0582";
    case 0x1e96:
      return "h\u0331";
    case 0x1e97:
      return "t\u0308";
    case 0x1e98:
      return "w\u030a";
    case 0x1e99:
      return "y\u030a";
    case 0x1e9a:
      return "a\u02be";
    case 0xfb00:
      return "ff";
    case 0xfb01:
      return "fi";
    case 0xfb02:
      return "fl";
    case 0xfb03:
      return "ffi";
    case 0xfb04:
      return "ffl";
    case 0xfb05:
    case 0xfb06:
      return "st";
    case 0xfb13:
      return "\u0574\u0576";
    case 0xfb14:
      return "\u0574\u0565";
    case 0xfb15:
      return "\u0574\u056b";
    case 0xfb16:
      return "\u057e\u0576";
    case 0xfb17:
      return "\u0574\u056d";
    default:
      return String.fromCodePoint(cp).toLowerCase();
  }
}

export function foldUnicodeForSearch(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i)!;
    out += foldCodePointForSearch(cp);
    i += cp > 0xffff ? 2 : 1;
  }
  return out;
}

function isSplitUtf16Surrogate(text: string, index: number): boolean {
  if (index <= 0 || index >= text.length) return false;
  const prev = text.charCodeAt(index - 1);
  const curr = text.charCodeAt(index);
  return prev >= 0xd800 && prev <= 0xdbff && curr >= 0xdc00 && curr <= 0xdfff;
}

export function isValidSeedOccurrence(
  content: string,
  seedRange: SourceRange,
  query: string,
  caseSensitive: boolean,
  expectedMatchText?: string,
): boolean {
  if (!query || seedRange.from < 0 || seedRange.to <= seedRange.from || seedRange.to > content.length) {
    return false;
  }
  if (isSplitUtf16Surrogate(content, seedRange.from) || isSplitUtf16Surrogate(content, seedRange.to)) {
    return false;
  }
  const slice = content.slice(seedRange.from, seedRange.to);
  if (expectedMatchText !== undefined && slice !== expectedMatchText) {
    return false;
  }
  return caseSensitive ? slice === query : foldUnicodeForSearch(slice) === foldUnicodeForSearch(query);
}

function findMatchingSourceRangeIndex(ranges: SourceRange[], target: SourceRange): number {
  return ranges.findIndex(r => r.from === target.from && r.to === target.to);
}

export default function ReadingSearch({ content, close, onChange, sourceSession, seed, initialReplace = false }: { content: string; close: () => void; onChange?: (content: string) => void; sourceSession?: string; seed?: ReadingSearchSeed | null; initialReplace?: boolean }) {
  const canReplace = Boolean(onChange);
  const canReplaceRef = useRef(canReplace); canReplaceRef.current = canReplace;
  const [query, setQuery] = useState(() => seed ? seed.query.slice(0, 200) : window.getSelection()?.toString().slice(0, 200) || "");
  const [matches, setMatches] = useState<Range[]>([]), [index, setIndex] = useState(-1);
  const indexRef = useRef(index); indexRef.current = index;
  const updateIndex = (next: number) => { indexRef.current = next; setIndex(next); };
  const [caseSensitive, setCaseSensitive] = useState(() => Boolean(seed?.caseSensitive)), [wholeWord, setWholeWord] = useState(false), [regexp, setRegexp] = useState(false);
  const [replacing, setReplacing] = useState(() => Boolean(initialReplace && canReplace)), [replacement, setReplacement] = useState("");
  const [sourceRanges, setSourceRanges] = useState<SourceRange[]>([]);
  const [windowed, setWindowed] = useState<WindowedMatch[] | null>(null);
  const [appliedNonce, setAppliedNonce] = useState<number | null>(seed ? seed.nonce : null);
  const pendingAutoSelect = useRef(Boolean(seed && seed.query));
  const pendingSeedRange = useRef<SourceRange | null>(extractSeedRange(seed));
  const pendingSeedMatchText = useRef<string | undefined>(extractSeedMatchText(seed));
  const [hiddenSourceHit, setHiddenSourceHit] = useState(false);
  const hiddenSourceAnchorRef = useRef<SourceRange | null>(null);
  const pendingReplaceIndex = useRef<number | null>(null);
  if (seed && appliedNonce !== seed.nonce) {
    setAppliedNonce(seed.nonce);
    pendingAutoSelect.current = Boolean(seed.query);
    pendingSeedRange.current = extractSeedRange(seed);
    pendingSeedMatchText.current = extractSeedMatchText(seed);
    setHiddenSourceHit(false);
    hiddenSourceAnchorRef.current = null;
    pendingReplaceIndex.current = null;
    if (index !== -1) updateIndex(-1);
    setQuery(seed.query.slice(0, 200));
    if (seed.caseSensitive !== undefined) setCaseSensitive(Boolean(seed.caseSensitive));
    if (wholeWord) setWholeWord(false);
    if (regexp) setRegexp(false);
  }
  const activeReplacing = canReplace && replacing;
  const filterOptions: SearchMatchOptions = { caseSensitive, wholeWord, regexp };
  const { error: regexError } = compileSearchPattern(query, filterOptions, true);
  const sourceSearch = !!sourceSession || activeReplacing;
  const sourceSearchRef = useRef(sourceSearch); sourceSearchRef.current = sourceSearch;
  const count = regexError ? 0 : sourceSearch ? sourceRanges.length : windowed?.length ?? matches.length;
  const input = useRef<HTMLInputElement>(null);
  const closeRef = useRef(close); closeRef.current = close;
  const prevState = useRef({ query, content, caseSensitive, wholeWord, regexp });
  const settleCleanup = useRef<(() => void) | null>(null);
  const clearSettleFrames = () => {
    settleCleanup.current?.();
    settleCleanup.current = null;
  };
  const scheduleSearchSettle = (anchorHost: Element | null, step: () => boolean) => {
    clearSettleFrames();
    const scroller = anchorHost?.matches(".android-reading,.reading-scroll")
      ? (anchorHost as HTMLElement)
      : anchorHost?.closest<HTMLElement>(".android-reading,.reading-scroll")
        ?? document.querySelector<HTMLElement>(".android-reading,.reading-scroll");
    const eventHost = scroller ?? anchorHost;
    if (!eventHost) return;
    let active = true;
    let frame = 0;
    let remainingFrames = 4;
    let layoutMutating = false;
    let recordedScrollTop = scroller?.scrollTop ?? 0;
    let recordedScrollHeight = scroller?.scrollHeight ?? 0;
    const recordScrollerState = () => {
      if (!scroller) return;
      recordedScrollTop = scroller.scrollTop;
      recordedScrollHeight = scroller.scrollHeight;
    };
    const inSearchUi = (target: EventTarget | null) =>
      target instanceof Element && Boolean(target.closest(".reading-search"));
    const stop = () => {
      if (!active) return;
      active = false;
      cancelAnimationFrame(frame);
      frame = 0;
      window.clearTimeout(timer);
      observer?.disconnect();
      eventHost.removeEventListener("supermd-window-change", onWindowChange);
      scroller?.removeEventListener("scroll", onScroll);
      window.removeEventListener("wheel", onUserGesture, { capture: true });
      window.removeEventListener("touchstart", onUserGesture, { capture: true });
      window.removeEventListener("touchmove", onUserGesture, { capture: true });
      window.removeEventListener("pointerdown", onUserGesture, { capture: true });
      window.removeEventListener("keydown", onKeyDown, { capture: true });
      window.removeEventListener("supermd-goto-offset", stop);
      if (settleCleanup.current === stop) settleCleanup.current = null;
    };
    const runPass = () => {
      frame = 0;
      if (!active) return;
      if (!step()) {
        stop();
        return;
      }
      recordScrollerState();
      if (remainingFrames > 0) {
        remainingFrames--;
        frame = requestAnimationFrame(runPass);
      }
    };
    const schedulePass = () => {
      if (!active || frame) return;
      frame = requestAnimationFrame(runPass);
    };
    const onUserGesture = (event: Event) => {
      if (!inSearchUi(event.target)) stop();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (!inSearchUi(event.target) && MANUAL_SCROLL_KEYS.has(event.key)) stop();
    };
    const onWindowChange = () => {
      if (!active) return;
      layoutMutating = true;
      queueMicrotask(() => {
        layoutMutating = false;
        if (active) recordScrollerState();
      });
      schedulePass();
    };
    const onScroll = () => {
      if (!active || !scroller || layoutMutating) return;
      if (scroller.scrollHeight !== recordedScrollHeight) {
        recordScrollerState();
        schedulePass();
        return;
      }
      if (Math.abs(scroller.scrollTop - recordedScrollTop) > 2) stop();
    };
    const page = scroller?.querySelector<HTMLElement>(".document-page,.preview-page,.live-document,.markdown-body")
      ?? (eventHost instanceof HTMLElement ? eventHost : null);
    let lastPageHeight = page?.getBoundingClientRect().height ?? 0;
    const observer = page && typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(entries => {
          if (!active) return;
          const nextHeight = entries[0]?.borderBoxSize?.[0]?.blockSize ?? entries[0]?.contentRect.height ?? page.getBoundingClientRect().height;
          if (Math.abs(nextHeight - lastPageHeight) <= 0.5) return;
          lastPageHeight = nextHeight;
          if (scroller && scroller.scrollHeight !== recordedScrollHeight) recordScrollerState();
          schedulePass();
        })
      : undefined;
    if (page && observer) observer.observe(page);
    eventHost.addEventListener("supermd-window-change", onWindowChange);
    scroller?.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("wheel", onUserGesture, { capture: true, passive: true });
    window.addEventListener("touchstart", onUserGesture, { capture: true, passive: true });
    window.addEventListener("touchmove", onUserGesture, { capture: true, passive: true });
    window.addEventListener("pointerdown", onUserGesture, { capture: true, passive: true });
    window.addEventListener("keydown", onKeyDown, { capture: true, passive: true });
    window.addEventListener("supermd-goto-offset", stop);
    const timer = window.setTimeout(stop, SEARCH_SETTLE_WINDOW_MS);
    settleCleanup.current = stop;
    remainingFrames--;
    frame = requestAnimationFrame(runPass);
  };
  const sourceCacheRef = useRef<{
    content: string;
    query: string;
    caseSensitive: boolean;
    wholeWord: boolean;
    regexp: boolean;
    ranges: SourceRange[];
  } | null>(null);
  const getSourceRanges = (text = content, q = query, opts: SearchMatchOptions = filterOptions): SourceRange[] => {
    const cs = Boolean(opts.caseSensitive), ww = Boolean(opts.wholeWord), rx = Boolean(opts.regexp);
    const cached = sourceCacheRef.current;
    if (cached && cached.content === text && cached.query === q && cached.caseSensitive === cs && cached.wholeWord === ww && cached.regexp === rx) {
      return cached.ranges;
    }
    const computed = sourceMatches(text, q, { caseSensitive: cs, wholeWord: ww, regexp: rx });
    sourceCacheRef.current = { content: text, query: q, caseSensitive: cs, wholeWord: ww, regexp: rx, ranges: computed };
    return computed;
  };
  const registry = typeof CSS === "undefined" ? undefined : (CSS as typeof CSS & { highlights?: HighlightRegistry }).highlights;
  const HighlightClass = (window as typeof window & { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;

  const mapSourceIndexToRendered = (
    sourceIdx: number,
    activeSourceRanges: SourceRange[] = sourceRanges,
    knownWindowed?: WindowedMatch[] | null,
    knownMatches?: Range[],
  ): number => {
    if (sourceIdx < 0 || regexError) return -1;
    const sr = activeSourceRanges[sourceIdx];
    const host = findReadingHost();
    if (!sr || !host) return -1;
    const block = findContainingBlock(host, sr, content);
    const liveWindowed = knownWindowed !== undefined
      ? knownWindowed
      : windowed && windowed.every(w => w.element.isConnected && host.contains(w.element))
        ? windowed
        : windowedMatches(host, query, filterOptions);
    if (!block) {
      const fmResolved = mapFrontmatterSourceRangeToDomRange(host, content, activeSourceRanges, sourceIdx, query, filterOptions);
      if (!fmResolved) return -1;
      if (liveWindowed) {
        for (let i = 0; i < liveWindowed.length; i++) {
          const w = liveWindowed[i];
          if (w.element.contains(fmResolved.startContainer)) {
            const wRange = readingMatches(w.element, query, filterOptions)[w.ordinal];
            if (wRange && sameDomRange(wRange, fmResolved)) return i;
          }
        }
        return -1;
      }
      const liveMatches = knownMatches !== undefined
        ? knownMatches
        : matches.length && matches[0].startContainer.nodeType === Node.TEXT_NODE && host.contains(matches[0].startContainer)
          ? matches
          : readingMatches(host, query, filterOptions);
      return liveMatches.findIndex(m => sameDomRange(m, fmResolved));
    }
    if (liveWindowed) {
      if (!liveWindowed.length) return -1;
      if (!block.closest('[data-windowed-mounted="false"]')) {
        const resolved = mapSourceRangeToDomRange(block, content, activeSourceRanges, sourceIdx, query, filterOptions);
        if (!resolved) return -1;
        for (let i = 0; i < liveWindowed.length; i++) {
          const w = liveWindowed[i];
          if (w.element === block || w.element.contains(block) || block.contains(w.element)) {
            const wRange = readingMatches(w.element, query, filterOptions)[w.ordinal];
            if (wRange && sameDomRange(wRange, resolved)) return i;
          }
        }
      }
      const owner = deepestSourceOwner(block, sr, content);
      if (owner && !isDirectVisibleMatch(owner, content, sr)) return -1;
      const wBlock = block.closest<HTMLElement>("[data-windowed-block]") ?? block;
      const wBounds = sourceBounds(wBlock, content);
      let targetOrdinal = 0;
      if (wBounds) {
        for (let i = 0; i < sourceIdx; i++) {
          const prev = activeSourceRanges[i];
          if (prev.from >= wBounds.start && prev.to <= wBounds.end && isDirectVisibleMatch(wBlock, content, prev)) {
            targetOrdinal++;
          }
        }
      }
      const exactIdx = liveWindowed.findIndex(w => w.element === wBlock && w.ordinal === targetOrdinal);
      if (exactIdx >= 0) return exactIdx;
      return liveWindowed.findIndex(w => {
        const wb = sourceBounds(w.element, content);
        return wb !== null && sr.from >= wb.start && sr.to <= wb.end && w.ordinal === targetOrdinal;
      });
    }
    const liveMatches = knownMatches !== undefined
      ? knownMatches
      : matches.length && matches[0].startContainer.nodeType === Node.TEXT_NODE && host.contains(matches[0].startContainer)
        ? matches
        : readingMatches(host, query, filterOptions);
    if (!liveMatches.length) return -1;
    const resolved = mapSourceRangeToDomRange(block, content, activeSourceRanges, sourceIdx, query, filterOptions);
    return resolved ? liveMatches.findIndex(m => sameDomRange(m, resolved)) : -1;
  };

  useEffect(() => {
    if (!canReplace && replacing) {
      const activeSourceRanges = regexError ? [] : (sourceRanges.length || !query ? sourceRanges : getSourceRanges());
      const host = findReadingHost();
      const liveWindowed = !sourceSession && host && !regexError ? windowedMatches(host, query, filterOptions) : null;
      const liveMatches = !sourceSession && host && !liveWindowed && !regexError ? readingMatches(host, query, filterOptions) : [];
      if (!sourceSession) {
        setWindowed(liveWindowed);
        setMatches(liveMatches);
      }
      const nextIndex = !sourceSession && indexRef.current >= 0
        ? (regexError ? -1 : mapSourceIndexToRendered(indexRef.current, activeSourceRanges, liveWindowed, liveMatches))
        : indexRef.current;
      setReplacing(false);
      if (nextIndex !== indexRef.current) updateIndex(nextIndex);
    }
  }, [canReplace, replacing]);

  const revealAndHighlightSource = (targetIndex: number, ranges: SourceRange[], sourceText: string, scroll: boolean, matchQuery = query, matchOptions: SearchMatchConfig = filterOptions) => {
    const range = ranges[targetIndex];
    if (!range) return;
    if (scroll) clearSettleFrames();
    if (scroll && sourceSession) {
      editorFindRange(sourceSession, range.from, range.to);
      if (!findReadingHost()) return;
    }
    const host = findReadingHost();
    if (!host) return;
    const initialBlock = findContainingBlock(host, range, sourceText);
    const customSliceMatch = matchQuery !== query || matchOptions !== filterOptions;
    if (!initialBlock) {
      const fmDomRange = mapFrontmatterSourceRangeToDomRange(host, sourceText, ranges, targetIndex, matchQuery, matchOptions);
      if (registry && HighlightClass) {
        if (scroll) {
          const visible = readingMatches(host, query, filterOptions);
          registry.set("smd-search", new HighlightClass(...(customSliceMatch && fmDomRange ? [...visible, fmDomRange] : visible)));
        }
        registry.delete("smd-search-current");
        if (fmDomRange) registry.set("smd-search-current", new HighlightClass(fmDomRange));
      }
      if (scroll) {
        const fmTarget = fmDomRange
          ? (fmDomRange.startContainer.nodeType === Node.ELEMENT_NODE ? fmDomRange.startContainer as Element : fmDomRange.startContainer.parentElement)
          : null;
        const fallback = fmTarget ?? host.querySelector("[data-frontmatter-properties],.document-properties") ?? resolveSourceBlock(host, range, sourceText);
        scrollTargetIntoView(fallback, host);
      }
      return;
    }
    const wasUnmounted = !!initialBlock.closest('[data-windowed-mounted="false"]');
    if (scroll) revealMountedBlock(initialBlock);
    const block = findContainingBlock(host, range, sourceText) ?? initialBlock;
    const owner = deepestSourceOwner(block, range, sourceText) ?? block;
    if (scroll) openDisclosuresFor(owner, block, null, range);
    const domRange = mapSourceRangeToDomRange(block, sourceText, ranges, targetIndex, matchQuery, matchOptions);
    if (scroll) {
      openDisclosuresFor(owner, block, domRange, range);
      const scrollEl = domRange ? (domRange.startContainer.nodeType === Node.ELEMENT_NODE ? domRange.startContainer as Element : domRange.startContainer.parentElement) : owner;
      scrollTargetIntoView(scrollEl ?? block, host);
    }
    if (registry && HighlightClass) {
      if (wasUnmounted || scroll) {
        const visible = readingMatches(host, query, filterOptions);
        registry.set("smd-search", new HighlightClass(...(customSliceMatch && domRange ? [...visible, domRange] : visible)));
      }
      registry.delete("smd-search-current");
      if (domRange) registry.set("smd-search-current", new HighlightClass(domRange));
    }
    if (scroll) {
      const expectedIndex = indexRef.current;
      scheduleSearchSettle(host, () => {
        if (!sourceSearchRef.current || indexRef.current !== expectedIndex) return false;
        const liveHost = findReadingHost();
        if (!liveHost) return false;
        const currentBlock = findContainingBlock(liveHost, range, sourceText);
        if (!currentBlock) return false;
        revealMountedBlock(currentBlock);
        const settledBlock = findContainingBlock(liveHost, range, sourceText) ?? currentBlock;
        const settledOwner = deepestSourceOwner(settledBlock, range, sourceText) ?? settledBlock;
        openDisclosuresFor(settledOwner, settledBlock, null, range);
        const settledDomRange = mapSourceRangeToDomRange(settledBlock, sourceText, ranges, targetIndex, matchQuery, matchOptions);
        openDisclosuresFor(settledOwner, settledBlock, settledDomRange, range);
        const settledScrollEl = settledDomRange
          ? (settledDomRange.startContainer.nodeType === Node.ELEMENT_NODE ? settledDomRange.startContainer as Element : settledDomRange.startContainer.parentElement)
          : settledOwner;
        scrollTargetIntoView(settledScrollEl ?? settledBlock, liveHost);
        if (registry && HighlightClass) {
          const visible = readingMatches(liveHost, query, filterOptions);
          registry.set("smd-search", new HighlightClass(...(customSliceMatch && settledDomRange ? [...visible, settledDomRange] : visible)));
          registry.delete("smd-search-current");
          if (settledDomRange) registry.set("smd-search-current", new HighlightClass(settledDomRange));
        }
        return true;
      });
    }
  };

  const selectWindowedMatch = (next: number, activeWindowed: WindowedMatch[], host: HTMLElement | null) => {
    const match = activeWindowed[next];
    if (!match) return;
    clearSettleFrames();
    revealMountedBlock(match.element);
    openDisclosuresFor(match.element, match.element);
    let range = readingMatches(match.element, query, filterOptions)[match.ordinal] ?? null;
    if (openDisclosuresFor(match.element, match.element, range)) range = readingMatches(match.element, query, filterOptions)[match.ordinal] ?? null;
    const scrollEl = range ? (range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer as Element : range.startContainer.parentElement) : match.element;
    scrollTargetIntoView(scrollEl ?? match.element, host);
    updateIndex(next);
    if (registry && HighlightClass) {
      registry.set("smd-search", new HighlightClass(...readingMatches(host ?? match.element, query, filterOptions)));
      registry.delete("smd-search-current");
      if (range) registry.set("smd-search-current", new HighlightClass(range));
    }
    scheduleSearchSettle(host ?? match.element, () => {
      if (sourceSearchRef.current || indexRef.current !== next || !match.element.isConnected) return false;
      revealMountedBlock(match.element);
      const liveHost = findReadingHost();
      openDisclosuresFor(match.element, match.element);
      let liveRange = readingMatches(match.element, query, filterOptions)[match.ordinal] ?? null;
      if (openDisclosuresFor(match.element, match.element, liveRange)) liveRange = readingMatches(match.element, query, filterOptions)[match.ordinal] ?? null;
      const liveScrollEl = liveRange ? (liveRange.startContainer.nodeType === Node.ELEMENT_NODE ? liveRange.startContainer as Element : liveRange.startContainer.parentElement) : match.element;
      scrollTargetIntoView(liveScrollEl ?? match.element, liveHost);
      if (registry && HighlightClass) {
        registry.set("smd-search", new HighlightClass(...readingMatches(liveHost ?? match.element, query, filterOptions)));
        registry.delete("smd-search-current");
        if (liveRange) registry.set("smd-search-current", new HighlightClass(liveRange));
      }
      return true;
    });
  };

  const selectDomMatch = (next: number, activeMatches: Range[], host: HTMLElement | null) => {
    const range = activeMatches[next];
    if (!range) return;
    clearSettleFrames();
    const element = range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer as Element : range.startContainer.parentElement;
    openDisclosuresFor(element, element?.closest(".code-container,details") ?? element, range);
    scrollTargetIntoView(element, host);
    updateIndex(next);
    if (registry && HighlightClass) {
      registry.delete("smd-search-current");
      registry.set("smd-search-current", new HighlightClass(range));
    }
  };

  const toggleReplacing = (nextReplacing = !activeReplacing) => {
    if (!canReplaceRef.current || nextReplacing === activeReplacing) return;
    let nextIndex = indexRef.current;
    if (nextReplacing) {
      const activeSourceRanges = regexError ? [] : getSourceRanges();
      setSourceRanges(activeSourceRanges);
      if (!sourceSession && nextIndex < 0 && hiddenSourceAnchorRef.current && activeSourceRanges.length) {
        const mappedHidden = findMatchingSourceRangeIndex(activeSourceRanges, hiddenSourceAnchorRef.current);
        if (mappedHidden >= 0) {
          nextIndex = mappedHidden;
          setHiddenSourceHit(false);
          hiddenSourceAnchorRef.current = null;
          setReplacing(true);
          updateIndex(nextIndex);
          revealAndHighlightSource(nextIndex, activeSourceRanges, content, true);
          return;
        }
      }
      if (!sourceSession && nextIndex >= 0) {
        const host = findReadingHost();
        const liveWindowed = windowed && windowed.every(w => w.element.isConnected && Boolean(host?.contains(w.element)))
          ? windowed
          : (host && !regexError ? windowedMatches(host, query, filterOptions) : null);
        if (!activeSourceRanges.length || !host || regexError) nextIndex = -1;
        else if (liveWindowed) {
          const active = liveWindowed[nextIndex];
          if (!active) nextIndex = -1;
          else if (!active.element.closest('[data-windowed-mounted="false"]')) {
            const domRange = readingMatches(active.element, query, filterOptions)[active.ordinal];
            const mapped = domRange ? mapDomRangeToSourceIndex(host, content, activeSourceRanges, domRange, query, filterOptions) : -1;
            nextIndex = mapped >= 0 ? mapped : -1;
          } else {
            const bounds = sourceBounds(active.element, content);
            let seen = 0, mapped = -1;
            if (bounds) {
              for (let i = 0; i < activeSourceRanges.length; i++) {
                const sr = activeSourceRanges[i];
                if (sr.from >= bounds.start && sr.to <= bounds.end && isDirectVisibleMatch(active.element, content, sr)) {
                  if (seen === active.ordinal) { mapped = i; break; }
                  seen++;
                }
              }
            }
            nextIndex = mapped >= 0 ? mapped : -1;
          }
        } else {
          const m = matches[nextIndex];
          const liveDomRange = m && m.startContainer.nodeType === Node.TEXT_NODE && host.contains(m.startContainer)
            ? m
            : readingMatches(host, query, filterOptions)[nextIndex];
          const mapped = liveDomRange ? mapDomRangeToSourceIndex(host, content, activeSourceRanges, liveDomRange, query, filterOptions) : -1;
          nextIndex = mapped >= 0 ? mapped : -1;
        }
      }
    } else if (!sourceSession) {
      const activeSourceRanges = regexError ? [] : (sourceRanges.length || !query ? sourceRanges : getSourceRanges());
      const host = findReadingHost();
      if (nextIndex >= 0 && !regexError) {
        const sr = activeSourceRanges[nextIndex];
        const block = sr && host ? findContainingBlock(host, sr, content) : null;
        if (block) revealMountedBlock(block);
      }
      const liveWindowed = host && !regexError ? windowedMatches(host, query, filterOptions) : null;
      const liveMatches = host && !liveWindowed && !regexError ? readingMatches(host, query, filterOptions) : [];
      setWindowed(liveWindowed);
      setMatches(liveMatches);
      if (nextIndex >= 0) nextIndex = regexError ? -1 : mapSourceIndexToRendered(nextIndex, activeSourceRanges, liveWindowed, liveMatches);
    }
    setReplacing(nextReplacing);
    if (!nextReplacing && nextIndex < 0) setHiddenSourceHit(false);
    if (nextIndex !== indexRef.current) updateIndex(nextIndex);
  };
  const toggleReplacingRef = useRef(toggleReplacing); toggleReplacingRef.current = toggleReplacing;

  const move = (direction: number) => {
    // Search is a new deliberate navigation, just like pan/zoom. A briefly
    // observing heading jump must not pull the viewport back after this move.
    cancelSettlingHeading();
    clearSettleFrames();
    pendingAutoSelect.current = false;
    pendingSeedRange.current = null;
    pendingSeedMatchText.current = undefined;
    if (regexError) return;
    if (hiddenSourceHit) setHiddenSourceHit(false);
    const hiddenAnchor = hiddenSourceAnchorRef.current;
    hiddenSourceAnchorRef.current = null;
    const current = indexRef.current;
    if (sourceSearch) {
      const activeSourceRanges = sourceRanges.length || !query ? sourceRanges : getSourceRanges();
      const next = nextSearchIndex(current, direction, activeSourceRanges.length);
      if (next < 0) return;
      updateIndex(next);
      revealAndHighlightSource(next, activeSourceRanges, content, true);
      return;
    }
    const host = findReadingHost();
    const activeWindowed = windowed ?? (host ? windowedMatches(host, query, filterOptions) : null);
    const activeMatches = activeWindowed ? [] : (matches.length || !host ? matches : readingMatches(host, query, filterOptions));
    const renderedTotal = activeWindowed ? activeWindowed.length : activeMatches.length;
    if (current < 0 && hiddenAnchor && renderedTotal > 0) {
      const activeSourceRanges = sourceRanges.length ? sourceRanges : getSourceRanges();
      if (activeSourceRanges.length) {
        let anchoredRendered = -1;
        if (direction > 0) {
          for (let i = 0; i < activeSourceRanges.length; i++) {
            if (activeSourceRanges[i].from < hiddenAnchor.to) continue;
            const mapped = mapSourceIndexToRendered(i, activeSourceRanges, activeWindowed, activeMatches);
            if (mapped >= 0) { anchoredRendered = mapped; break; }
          }
          if (anchoredRendered < 0) anchoredRendered = 0;
        } else {
          for (let i = activeSourceRanges.length - 1; i >= 0; i--) {
            if (activeSourceRanges[i].to > hiddenAnchor.from) continue;
            const mapped = mapSourceIndexToRendered(i, activeSourceRanges, activeWindowed, activeMatches);
            if (mapped >= 0) { anchoredRendered = mapped; break; }
          }
          if (anchoredRendered < 0) anchoredRendered = renderedTotal - 1;
        }
        if (activeWindowed) selectWindowedMatch(anchoredRendered, activeWindowed, host);
        else selectDomMatch(anchoredRendered, activeMatches, host);
        return;
      }
    }
    if (activeWindowed) {
      const next = nextSearchIndex(current, direction, activeWindowed.length);
      if (next < 0) return;
      selectWindowedMatch(next, activeWindowed, host);
      return;
    }
    const next = nextSearchIndex(current, direction, activeMatches.length);
    if (next < 0) return;
    selectDomMatch(next, activeMatches, host);
  };
  const moveRef = useRef(move); moveRef.current = move;

  const handleSingleReplace = () => {
    if (!canReplace || !onChange || !query || regexError || !sourceRanges.length || index < 0) return;
    const target = sourceRanges[index];
    if (!target) return;
    const nextContent = replaceSourceMatches(content, query, replacement, filterOptions, index);
    const replacedEnd = target.to + (nextContent.length - content.length);
    const nextRanges = getSourceRanges(nextContent, query, filterOptions);
    const nextIndex = !nextRanges.length ? -1 : (() => { const found = nextRanges.findIndex(r => r.from >= replacedEnd); return found >= 0 ? found : 0; })();
    if (nextContent === content) {
      updateIndex(nextIndex);
      if (nextIndex >= 0) revealAndHighlightSource(nextIndex, nextRanges, nextContent, true);
      return;
    }
    pendingReplaceIndex.current = nextIndex;
    onChange(nextContent);
  };

  const handleReplaceAll = () => {
    if (!canReplace || !onChange || !query || regexError || !sourceRanges.length) return;
    const nextContent = replaceSourceMatches(content, query, replacement, filterOptions);
    if (nextContent === content) { updateIndex(-1); return; }
    pendingReplaceIndex.current = -1;
    onChange(nextContent);
  };

  useLayoutEffect(() => {
    cancelSettlingHeading();
    setReaderOverlay("search", true);
    let focusFrame = 0;
    const focus = (event?: Event) => {
      const detail = (event as CustomEvent<{ replace?: boolean }> | undefined)?.detail;
      if (detail?.replace && canReplaceRef.current) toggleReplacingRef.current(true);
      let attempts = 0;
      const focusInput = () => {
        focusFrame = 0;
        const field = input.current;
        if (field) { field.focus({ preventScroll: true }); field.select(); }
        // Native menus/toolbars can retain host focus while React mounts this
        // overlay. Reassert focus across the mount frames so the very next key
        // reaches the search field, including when Find is opened repeatedly.
        if (document.activeElement !== field && attempts++ < 4) focusFrame = requestAnimationFrame(focusInput);
      };
      cancelAnimationFrame(focusFrame);
      focusInput();
    };
    const step = (event: Event) => {
      const direction = (event as CustomEvent<number>).detail;
      moveRef.current(direction < 0 ? -1 : 1);
    };
    focus();
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (document.querySelector(".media-save-menu,.image-viewer,.step-viewer,.math-repair-panel,.media-dialog,.theme-guide-dialog")) return;
      event.preventDefault(); event.stopImmediatePropagation(); closeRef.current();
    };
    document.addEventListener("keydown", key, true);
    window.addEventListener("supermd-find-focus", focus);
    window.addEventListener("supermd-find-step", step);
    return () => {
      cancelAnimationFrame(focusFrame);
      clearSettleFrames();
      setReaderOverlay("search", false);
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("supermd-find-focus", focus);
      window.removeEventListener("supermd-find-step", step);
    };
  }, []);

  useEffect(() => {
    clearSettleFrames();
    const prev = prevState.current;
    const criteriaChanged = prev.query !== query || prev.caseSensitive !== caseSensitive || prev.wholeWord !== wholeWord || prev.regexp !== regexp;
    const contentChanged = prev.content !== content;
    prevState.current = { query, content, caseSensitive, wholeWord, regexp };
    // Only evaluate the source-search pipeline when Source/Split editor search or
    // Replace-in-source is active; rendered Read/Live Find skips scanning raw source.
    const nextSourceRanges = regexError || !sourceSearch ? [] : getSourceRanges();
    setSourceRanges(prevRanges => (prevRanges.length === 0 && nextSourceRanges.length === 0 ? prevRanges : nextSourceRanges));
    if (sourceSession) editorFindQuery(sourceSession, regexError ? "" : query, caseSensitive, { wholeWord, regexp });
    const autoSelect = pendingAutoSelect.current;
    let targetIndex = indexRef.current;
    let shouldScrollReplaced = false;
    if (autoSelect && !regexError) {
      pendingReplaceIndex.current = null;
    } else if (criteriaChanged || regexError) {
      pendingAutoSelect.current = false;
      pendingSeedRange.current = null;
      pendingSeedMatchText.current = undefined;
      pendingReplaceIndex.current = null;
      setHiddenSourceHit(false);
      hiddenSourceAnchorRef.current = null;
      targetIndex = -1;
      if (indexRef.current !== -1) updateIndex(-1);
    } else if (pendingReplaceIndex.current !== null) {
      setHiddenSourceHit(false);
      hiddenSourceAnchorRef.current = null;
      targetIndex = pendingReplaceIndex.current;
      pendingReplaceIndex.current = null;
      shouldScrollReplaced = targetIndex >= 0;
      updateIndex(targetIndex);
    } else if (contentChanged) {
      setHiddenSourceHit(false);
      hiddenSourceAnchorRef.current = null;
      targetIndex = -1;
      if (indexRef.current !== -1) updateIndex(-1);
    } else if (sourceSearch && indexRef.current >= nextSourceRanges.length) {
      targetIndex = nextSourceRanges.length - 1;
      updateIndex(targetIndex);
    }
    const frame = requestAnimationFrame(() => {
      const runAutoSelect = pendingAutoSelect.current;
      const seedRange = runAutoSelect ? pendingSeedRange.current : null;
      const seedMatchText = runAutoSelect ? pendingSeedMatchText.current : undefined;
      const hasValidSeedRange = Boolean(seedRange && isValidSeedOccurrence(content, seedRange, query, caseSensitive, seedMatchText));
      const hasStaleSeedRange = Boolean(seedRange && !hasValidSeedRange);
      pendingAutoSelect.current = false;
      pendingSeedRange.current = null;
      pendingSeedMatchText.current = undefined;
      if (sourceSession) editorFindQuery(sourceSession, regexError ? "" : query, caseSensitive, { wholeWord, regexp });
      if (!runAutoSelect && shouldScrollReplaced && targetIndex >= 0 && nextSourceRanges[targetIndex]) {
        revealAndHighlightSource(targetIndex, nextSourceRanges, content, true);
      }
      const host = findReadingHost();
      if (regexError) {
        setWindowed(prevWindowed => (prevWindowed === null ? prevWindowed : null));
        setMatches(prevMatches => (prevMatches.length === 0 ? prevMatches : []));
        registry?.delete("smd-search");
        registry?.delete("smd-search-current");
        return;
      }
      if (sourceSearchRef.current) {
        const activeRanges = nextSourceRanges.length || !query ? nextSourceRanges : getSourceRanges();
        setWindowed(prevWindowed => (prevWindowed === null ? prevWindowed : null));
        setMatches(prevMatches => (prevMatches.length === 0 ? prevMatches : []));
        if (runAutoSelect) {
          setHiddenSourceHit(false);
          hiddenSourceAnchorRef.current = null;
          if (hasValidSeedRange && seedRange) {
            const seedSourceIndex = findMatchingSourceRangeIndex(activeRanges, seedRange);
            if (seedSourceIndex >= 0) {
              updateIndex(seedSourceIndex);
              revealAndHighlightSource(seedSourceIndex, activeRanges, content, true);
              return;
            }
            updateIndex(-1);
            if (sourceSession) editorFindRange(sourceSession, seedRange.from, seedRange.to);
            const sliceText = content.slice(seedRange.from, seedRange.to);
            const sliceRanges = sourceMatches(content, sliceText, true);
            const sliceIdx = findMatchingSourceRangeIndex(sliceRanges, seedRange);
            if (sliceIdx >= 0) revealAndHighlightSource(sliceIdx, sliceRanges, content, true, sliceText, true);
            return;
          }
          if (!hasStaleSeedRange && activeRanges.length) {
            updateIndex(0);
            revealAndHighlightSource(0, activeRanges, content, true);
            return;
          }
          updateIndex(-1);
        }
        if (host && registry && HighlightClass) {
          const visible = activeRanges.length ? readingMatches(host, query, filterOptions) : [];
          registry.set("smd-search", new HighlightClass(...visible));
          if (shouldScrollReplaced && targetIndex >= 0) {
            registry.delete("smd-search-current");
            const domRange = resolveSourceHighlightRange(host, content, activeRanges, targetIndex, query, filterOptions);
            if (domRange) registry.set("smd-search-current", new HighlightClass(domRange));
          } else if (indexRef.current < 0) {
            registry.delete("smd-search-current");
          }
        }
        return;
      }
      const nextWindowed = host ? windowedMatches(host, query, filterOptions) : null;
      if (runAutoSelect && hasValidSeedRange && seedRange && host) {
        const seedSourceRanges = getSourceRanges();
        const seedSourceIndex = findMatchingSourceRangeIndex(seedSourceRanges, seedRange);
        const targetRange = seedSourceIndex >= 0 ? seedSourceRanges[seedSourceIndex] : seedRange;
        const initialResult = nextWindowed === null ? readingMatches(host, query, filterOptions) : [];
        const initialBlock = findContainingBlock(host, targetRange, content);
        if (!initialBlock) {
          setWindowed(nextWindowed);
          setMatches(initialResult);
          let fmDomRange: Range | null = null;
          if (seedSourceIndex >= 0) {
            fmDomRange = mapFrontmatterSourceRangeToDomRange(host, content, seedSourceRanges, seedSourceIndex, query, filterOptions);
          } else {
            const sliceText = content.slice(targetRange.from, targetRange.to);
            const sliceRanges = sliceText ? sourceMatches(content, sliceText, true) : [];
            const sliceIdx = sliceRanges.length ? findMatchingSourceRangeIndex(sliceRanges, targetRange) : -1;
            fmDomRange = sliceIdx >= 0 ? mapFrontmatterSourceRangeToDomRange(host, content, sliceRanges, sliceIdx, sliceText, true) : null;
          }
          if (fmDomRange) {
            setHiddenSourceHit(false);
            hiddenSourceAnchorRef.current = null;
            if (seedSourceIndex >= 0) {
              if (nextWindowed) {
                let wIdx = -1;
                for (let i = 0; i < nextWindowed.length; i++) {
                  const w = nextWindowed[i];
                  if (w.element.contains(fmDomRange.startContainer)) {
                    const wRange = readingMatches(w.element, query, filterOptions)[w.ordinal];
                    if (wRange && sameDomRange(wRange, fmDomRange)) { wIdx = i; break; }
                  }
                }
                if (wIdx >= 0) {
                  selectWindowedMatch(wIdx, nextWindowed, host);
                  return;
                }
              }
              const mIdx = initialResult.findIndex(m => sameDomRange(m, fmDomRange));
              if (mIdx >= 0) {
                if (registry && HighlightClass) registry.set("smd-search", new HighlightClass(...initialResult));
                selectDomMatch(mIdx, initialResult, host);
                return;
              }
            } else if (!nextWindowed) {
              const augmented = [...initialResult];
              let insertAt = augmented.findIndex(m => sameDomRange(m, fmDomRange));
              if (insertAt < 0) {
                insertAt = augmented.findIndex(m => m.compareBoundaryPoints(Range.START_TO_START, fmDomRange) > 0);
                if (insertAt < 0) insertAt = augmented.length;
                augmented.splice(insertAt, 0, fmDomRange);
                setMatches(augmented);
              }
              if (registry && HighlightClass) registry.set("smd-search", new HighlightClass(...augmented));
              selectDomMatch(insertAt, augmented, host);
              return;
            } else {
              clearSettleFrames();
              const scrollEl = fmDomRange.startContainer.nodeType === Node.ELEMENT_NODE ? fmDomRange.startContainer as Element : fmDomRange.startContainer.parentElement;
              scrollTargetIntoView(scrollEl, host);
              updateIndex(-1);
              if (registry && HighlightClass) {
                const visible = nextWindowed.length ? readingMatches(host, query, filterOptions) : [];
                registry.set("smd-search", new HighlightClass(...visible, fmDomRange));
                registry.set("smd-search-current", new HighlightClass(fmDomRange));
              }
              return;
            }
          }
          const fallback = host.querySelector("[data-frontmatter-properties],.document-properties") ?? resolveSourceBlock(host, targetRange, content);
          if (fallback) { revealMountedBlock(fallback); scrollTargetIntoView(fallback, host); }
          updateIndex(-1);
          setHiddenSourceHit(true);
          hiddenSourceAnchorRef.current = targetRange;
          if (registry && HighlightClass) {
            const visible = nextWindowed !== null ? (nextWindowed.length ? readingMatches(host, query, filterOptions) : []) : initialResult;
            registry.set("smd-search", new HighlightClass(...visible));
            registry.delete("smd-search-current");
          }
          return;
        }
        const wasUnmounted = !!initialBlock.closest('[data-windowed-mounted="false"]');
        if (wasUnmounted) revealMountedBlock(initialBlock);
        const block = findContainingBlock(host, targetRange, content) ?? initialBlock;
        const owner = deepestSourceOwner(block, targetRange, content) ?? block;
        const openedDisclosures = openDisclosuresFor(owner, block, null, targetRange);
        const activeWindowed = wasUnmounted || openedDisclosures ? windowedMatches(host, query, filterOptions) : nextWindowed;
        const activeResult = activeWindowed !== null ? [] : (wasUnmounted || openedDisclosures ? readingMatches(host, query, filterOptions) : initialResult);
        setWindowed(activeWindowed);
        setMatches(activeResult);
        let domRange: Range | null = null;
        if (seedSourceIndex >= 0) {
          domRange = mapSourceRangeToDomRange(block, content, seedSourceRanges, seedSourceIndex, query, filterOptions);
        } else {
          const sliceText = content.slice(targetRange.from, targetRange.to);
          const sliceRanges = sliceText ? sourceMatches(content, sliceText, true) : [];
          const sliceIdx = sliceRanges.length ? findMatchingSourceRangeIndex(sliceRanges, targetRange) : -1;
          domRange = sliceIdx >= 0 ? mapSourceRangeToDomRange(block, content, sliceRanges, sliceIdx, sliceText, true) : null;
        }
        if (domRange) {
          setHiddenSourceHit(false);
          hiddenSourceAnchorRef.current = null;
          if (seedSourceIndex >= 0) {
            if (activeWindowed) {
              let wIdx = -1;
              for (let i = 0; i < activeWindowed.length; i++) {
                const w = activeWindowed[i];
                if (w.element === block || w.element.contains(block) || block.contains(w.element)) {
                  const wRange = readingMatches(w.element, query, filterOptions)[w.ordinal];
                  if (wRange && sameDomRange(wRange, domRange)) { wIdx = i; break; }
                }
              }
              if (wIdx >= 0) {
                selectWindowedMatch(wIdx, activeWindowed, host);
                return;
              }
            }
            const mIdx = activeResult.findIndex(m => sameDomRange(m, domRange));
            if (mIdx >= 0) {
              if (registry && HighlightClass) registry.set("smd-search", new HighlightClass(...activeResult));
              selectDomMatch(mIdx, activeResult, host);
              return;
            }
          } else if (!activeWindowed) {
            const augmented = [...activeResult];
            let insertAt = augmented.findIndex(m => sameDomRange(m, domRange));
            if (insertAt < 0) {
              insertAt = augmented.findIndex(m => m.compareBoundaryPoints(Range.START_TO_START, domRange) > 0);
              if (insertAt < 0) insertAt = augmented.length;
              augmented.splice(insertAt, 0, domRange);
              setMatches(augmented);
            }
            if (registry && HighlightClass) registry.set("smd-search", new HighlightClass(...augmented));
            selectDomMatch(insertAt, augmented, host);
            return;
          } else {
            clearSettleFrames();
            const scrollEl = domRange.startContainer.nodeType === Node.ELEMENT_NODE ? domRange.startContainer as Element : domRange.startContainer.parentElement;
            openDisclosuresFor(scrollEl, block, domRange, targetRange);
            scrollTargetIntoView(scrollEl ?? owner, host);
            updateIndex(-1);
            if (registry && HighlightClass) {
              const visible = activeWindowed.length ? readingMatches(host, query, filterOptions) : [];
              registry.set("smd-search", new HighlightClass(...visible, domRange));
              registry.set("smd-search-current", new HighlightClass(domRange));
            }
            if (wasUnmounted) {
              const sliceText = content.slice(targetRange.from, targetRange.to);
              const sliceRanges = sliceText ? sourceMatches(content, sliceText, true) : [];
              const sliceIdx = sliceRanges.length ? findMatchingSourceRangeIndex(sliceRanges, targetRange) : -1;
              scheduleSearchSettle(host, () => {
                if (sourceSearchRef.current || indexRef.current !== -1) return false;
                const liveHost = findReadingHost();
                if (!liveHost || !liveHost.isConnected) return false;
                const initialLiveBlock = findContainingBlock(liveHost, targetRange, content);
                if (!initialLiveBlock || !initialLiveBlock.isConnected) return false;
                revealMountedBlock(initialLiveBlock);
                const liveBlock = findContainingBlock(liveHost, targetRange, content) ?? initialLiveBlock;
                const liveOwner = deepestSourceOwner(liveBlock, targetRange, content) ?? liveBlock;
                openDisclosuresFor(liveOwner, liveBlock, null, targetRange);
                const liveDomRange = sliceIdx >= 0 ? mapSourceRangeToDomRange(liveBlock, content, sliceRanges, sliceIdx, sliceText, true) : null;
                const liveScrollEl = liveDomRange ? (liveDomRange.startContainer.nodeType === Node.ELEMENT_NODE ? liveDomRange.startContainer as Element : liveDomRange.startContainer.parentElement) : liveOwner;
                openDisclosuresFor(liveScrollEl, liveBlock, liveDomRange, targetRange);
                scrollTargetIntoView(liveScrollEl ?? liveOwner, liveHost);
                if (registry && HighlightClass) {
                  const visible = activeWindowed.length ? readingMatches(liveHost, query, filterOptions) : [];
                  if (liveDomRange) {
                    registry.set("smd-search", new HighlightClass(...visible, liveDomRange));
                    registry.set("smd-search-current", new HighlightClass(liveDomRange));
                  }
                }
                return true;
              });
            }
            return;
          }
        } else {
          clearSettleFrames();
          openDisclosuresFor(owner, block, null, targetRange);
          scrollTargetIntoView(owner ?? block, host);
          updateIndex(-1);
          setHiddenSourceHit(true);
          hiddenSourceAnchorRef.current = targetRange;
          if (registry && HighlightClass) {
            const visible = activeWindowed !== null ? (activeWindowed.length ? readingMatches(host, query, filterOptions) : []) : activeResult;
            registry.set("smd-search", new HighlightClass(...visible));
            registry.delete("smd-search-current");
          }
          if (wasUnmounted) {
            scheduleSearchSettle(host, () => {
              if (sourceSearchRef.current || indexRef.current !== -1 || hiddenSourceAnchorRef.current !== targetRange) return false;
              const liveHost = findReadingHost();
              if (!liveHost || !liveHost.isConnected) return false;
              const initialLiveBlock = findContainingBlock(liveHost, targetRange, content);
              if (initialLiveBlock) revealMountedBlock(initialLiveBlock);
              const liveBlock = (initialLiveBlock ? findContainingBlock(liveHost, targetRange, content) : null) ?? initialLiveBlock;
              const liveOwner = liveBlock ? (deepestSourceOwner(liveBlock, targetRange, content) ?? liveBlock) : null;
              if (liveBlock) openDisclosuresFor(liveOwner, liveBlock, null, targetRange);
              scrollTargetIntoView(liveOwner ?? liveBlock ?? owner ?? block, liveHost);
              return true;
            });
          }
          return;
        }
      }
      if (runAutoSelect) {
        setHiddenSourceHit(false);
        hiddenSourceAnchorRef.current = null;
      }
      if (nextWindowed !== null) {
        setWindowed(nextWindowed);
        setMatches(prevMatches => (prevMatches.length === 0 ? prevMatches : []));
        if (runAutoSelect) {
          if (!hasStaleSeedRange && nextWindowed.length) { selectWindowedMatch(0, nextWindowed, host); return; }
          updateIndex(-1);
        } else if (!criteriaChanged && !contentChanged && indexRef.current >= nextWindowed.length) {
          updateIndex(nextWindowed.length - 1);
        }
        if (host && registry && HighlightClass) {
          const visible = nextWindowed.length ? readingMatches(host, query, filterOptions) : [];
          registry.set("smd-search", new HighlightClass(...visible));
          if (indexRef.current < 0) registry.delete("smd-search-current");
        }
        return;
      }
      const result = host ? readingMatches(host, query, filterOptions) : [];
      setWindowed(prevWindowed => (prevWindowed === null ? prevWindowed : null));
      setMatches(result);
      if (runAutoSelect) {
        if (!hasStaleSeedRange && result.length) {
          if (registry && HighlightClass) registry.set("smd-search", new HighlightClass(...result));
          selectDomMatch(0, result, host);
          return;
        }
        updateIndex(-1);
      } else if (!criteriaChanged && !contentChanged && indexRef.current >= result.length) {
        updateIndex(result.length - 1);
      }
      if (registry && HighlightClass) {
        registry.set("smd-search", new HighlightClass(...result));
        if (indexRef.current < 0) registry.delete("smd-search-current");
      }
    });
    return () => {
      cancelAnimationFrame(frame);
      clearSettleFrames();
      registry?.delete("smd-search");
      registry?.delete("smd-search-current");
      if (sourceSession) editorFindQuery(sourceSession, "", false);
    };
  }, [query, content, caseSensitive, wholeWord, regexp, sourceSearch, sourceSession, canReplace, seed?.nonce]);

  useEffect(() => {
    if (!registry || !HighlightClass) return;
    if (regexError || index < 0) { registry.delete("smd-search-current"); return; }
    if (sourceSearch) {
      const host = findReadingHost();
      if (!host) { registry.delete("smd-search-current"); return; }
      registry.delete("smd-search-current");
      const domRange = resolveSourceHighlightRange(host, content, sourceRanges, index, query, filterOptions);
      if (domRange) registry.set("smd-search-current", new HighlightClass(domRange));
      return;
    }
    if (windowed) {
      const match = windowed[index];
      registry.delete("smd-search-current");
      if (match && !match.element.closest('[data-windowed-mounted="false"]')) {
        const domRange = readingMatches(match.element, query, filterOptions)[match.ordinal];
        if (domRange) registry.set("smd-search-current", new HighlightClass(domRange));
      }
      return;
    }
    registry.delete("smd-search-current");
    if (matches[index]) registry.set("smd-search-current", new HighlightClass(matches[index]));
  }, [index, matches, windowed, sourceRanges, sourceSearch, sourceSession, content, query, caseSensitive, wholeWord, regexp, regexError]);

  useEffect(() => {
    const host = findReadingHost(); if (!host || (!windowed && !sourceSearch) || !query || regexError) return;
    let frame = 0;
    const refresh = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (!registry || !HighlightClass) return;
        registry.set("smd-search", new HighlightClass(...readingMatches(host, query, filterOptions)));
        const active = indexRef.current;
        if (active < 0) return;
        registry.delete("smd-search-current");
        if (sourceSearch) {
          const domRange = resolveSourceHighlightRange(host, content, sourceRanges, active, query, filterOptions);
          if (domRange) registry.set("smd-search-current", new HighlightClass(domRange));
        } else if (windowed?.[active] && !windowed[active].element.closest('[data-windowed-mounted="false"]')) {
          const domRange = readingMatches(windowed[active].element, query, filterOptions)[windowed[active].ordinal];
          if (domRange) registry.set("smd-search-current", new HighlightClass(domRange));
        }
      });
    };
    host.addEventListener("supermd-window-change", refresh);
    return () => { cancelAnimationFrame(frame); host.removeEventListener("supermd-window-change", refresh); };
  }, [windowed, sourceSearch, sourceRanges, content, query, caseSensitive, wholeWord, regexp, regexError]);

  return <aside className="reading-search" data-independent-zoom role="search" aria-label="Find in note">
    <input ref={input} aria-label="Find in note" aria-invalid={!!regexError || undefined} role="searchbox" type="text" inputMode="search" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="Find in this note" value={query} onChange={event => { pendingAutoSelect.current = false; pendingSeedRange.current = null; pendingSeedMatchText.current = undefined; setQuery(event.target.value); }} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); move(event.shiftKey ? -1 : 1); } }} />
    <output
      aria-live="polite"
      className={regexError ? "search-error" : undefined}
      title={
        regexError
          ? regexError
          : !sourceSearch && hiddenSourceHit && index < 0
            ? "Selected match is in hidden Markdown syntax (such as a link URL, comment, or frontmatter)."
            : count >= 5000
              ? "Showing the first 5,000 matches. Narrow your search to find later results."
              : undefined
      }
    >
      {regexError
        ? regexError
        : !sourceSearch && hiddenSourceHit && index < 0
          ? (count ? `In source · 0 / ${count}${count >= 5000 ? "+" : ""}` : "In Markdown source")
          : count
            ? `${index < 0 ? 0 : index + 1} / ${count}${count >= 5000 ? "+" : ""}`
            : query
              ? "No matches"
              : ""}
    </output>
    <button className="search-icon" aria-label="Previous match" disabled={!count} onClick={() => move(-1)} title="Previous match (Shift+Enter / Shift+F3)"><ArrowUpIcon size={20} weight="bold" /></button>
    <button className="search-icon" aria-label="Next match" disabled={!count} onClick={() => move(1)} title="Next match (Enter / F3)"><ArrowDownIcon size={20} weight="bold" /></button>
    <button className="search-icon" aria-pressed={caseSensitive} onClick={() => { pendingAutoSelect.current = false; pendingSeedRange.current = null; pendingSeedMatchText.current = undefined; setCaseSensitive(!caseSensitive); }} title="Match case" aria-label="Match case"><TextAaIcon size={20} weight="bold" /></button>
    <button className="search-icon" aria-pressed={wholeWord} onClick={() => { pendingAutoSelect.current = false; pendingSeedRange.current = null; pendingSeedMatchText.current = undefined; setWholeWord(!wholeWord); }} title="Match whole word" aria-label="Match whole word"><TextboxIcon size={20} weight="bold" /></button>
    <button className="search-icon" aria-pressed={regexp} onClick={() => { pendingAutoSelect.current = false; pendingSeedRange.current = null; pendingSeedMatchText.current = undefined; setRegexp(!regexp); }} title="Regular expression" aria-label="Regular expression"><AsteriskIcon size={20} weight="bold" /></button>
    {canReplace && <button className="search-icon" aria-pressed={activeReplacing} onClick={() => toggleReplacing()} title="Replace in source (Ctrl+H)" aria-label="Replace in source"><ArrowsClockwiseIcon size={20} weight="bold" /></button>}
    <button className="search-icon" onClick={close} title="Close search (Esc)" aria-label="Close search"><XIcon size={20} weight="bold" /></button>
    {activeReplacing && onChange && <div className="search-replace"><input aria-label="Replacement text" placeholder="Replace with" value={replacement} onChange={e => setReplacement(e.target.value)} /><button disabled={!query || !!regexError || !count || index < 0} onClick={handleSingleReplace}>Replace</button><button disabled={!query || !!regexError || !count} onClick={handleReplaceAll}>Replace all</button><small>{regexError ? `${regexError}.` : regexp ? "Replaces regex matches in Markdown source ($1, $&, $$ supported)." : "Replaces literal text in Markdown source."}</small></div>}
  </aside>;
}
