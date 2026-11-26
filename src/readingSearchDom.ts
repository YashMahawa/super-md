import { flushSync } from "react-dom";
import { windowedMatches, revealWindowed, compileSearchPattern, nextSearchMatch, normalizeSearchOptions, type WindowedMatch, type SearchMatchConfig, type SearchMatchOptions } from "./windowedSearch";
import { cancelHeadingNavigation } from "./documentNavigation";
import { refreshDocumentExtent } from "./documentZoom";
export type { SearchMatchConfig, SearchMatchOptions };

export const cancelSettlingHeading = () => document.querySelectorAll(".android-reading,.reading-scroll,.live-pane").forEach(cancelHeadingNavigation);
export const findReadingHost = () => document.querySelector<HTMLElement>(".android-reading,.reading-scroll,.live-document,.markdown-body");
export type HighlightRegistry = Map<string, unknown>;
export type SourceRange = { from: number; to: number };

const INLINE_HTML_HIDDEN_TOKEN = /<!--[\s\S]*?-->|<\/?(?:br|mark|sub|sup|kbd|u)(?:\s+(?:[^>"']|"[^"]*"|'[^']*')*)?\s*\/?>/gi;
const EXCLUDED_SEARCH_TAGS = new Set(["button", "input", "textarea", "select", "svg", "script", "style", "template", "annotation", "iframe"]);
const EXCLUDED_SEARCH_CLASS_PATTERN = /(?:^|\s)(?:katex-mathml|chart-controls|chart-toolbar|chart-legend|image-edit-tools|image-loading|image-error|remote-image-card|document-properties|is-offstage)(?:\s|$)/;
const SEARCH_BLOCK_TAGS = new Set(["p", "h1", "h2", "h3", "h4", "li", "pre", "td", "summary"]);

function isHiddenOrExcludedSearchElement(el: Element): boolean {
  if (EXCLUDED_SEARCH_TAGS.has(el.localName)) return true;
  if (!el.hasAttributes()) return false;
  const cls = el.className;
  const hasClassString = typeof cls === "string" && cls.length > 0;
  if (hasClassString && EXCLUDED_SEARCH_CLASS_PATTERN.test(cls)) return true;
  if (
    el.getAttribute("data-windowed-mounted") === "false" ||
    el.hasAttribute("hidden") ||
    el.hasAttribute("inert") ||
    el.hasAttribute("data-frontmatter-properties")
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

export function revealMountedBlock(element: Element): void {
  if (!(element instanceof HTMLElement)) return;
  if (element.closest('[data-windowed-mounted="false"]')) flushSync(() => revealWindowed(element));
  else revealWindowed(element);
}

export function scrollTargetIntoView(target: Element | null, host?: Element | null): void {
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
      const fm = content.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/);
      if (fm) regionStart = fm[0].length;
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

export function openDisclosuresFor(target: Element | null, scope?: Element | null, range?: Range | null, sourceRange?: SourceRange): boolean {
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

export function findContainingBlock(host: Element, range: SourceRange, content?: string): HTMLElement | null {
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

export function deepestSourceOwner(block: HTMLElement, range: SourceRange, content?: string): HTMLElement | null {
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

export function mapSourceRangeToDomRange(block: HTMLElement, content: string, ranges: SourceRange[], activeIndex: number, query: string, options: SearchMatchConfig = false): Range | null {
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

export function mapDomRangeToSourceIndex(host: Element, content: string, ranges: SourceRange[], domRange: Range, query: string, options: SearchMatchConfig = false): number {
  const common = domRange.commonAncestorContainer.nodeType === Node.ELEMENT_NODE ? domRange.commonAncestorContainer as Element : domRange.commonAncestorContainer.parentElement;
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
  if (!block) return null;
  return mapSourceRangeToDomRange(block, content, ranges, activeIndex, query, options);
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
        walk(childEl, SEARCH_BLOCK_TAGS.has(childEl.localName) ? childEl : currentBlock);
      }
    }
  };
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
  for (let anc: Element | null = host; anc; anc = anc.parentElement) {
    if (isHiddenOrExcludedSearchElement(anc)) return [];
  }
  const state = { parts: [] as Array<{ node: Text; start: number; end: number }>, text: "", block: null as Element | null };
  collectSearchText(host, host.closest("p,h1,h2,h3,h4,li,pre,td,summary"), state);
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

function visibleBlockSourceIndices(block: HTMLElement, content: string, sourceRanges: SourceRange[], endIndex = sourceRanges.length): number[] {
  const bounds = sourceBounds(block, content);
  if (!bounds) return [];
  const indices: number[] = [];
  for (let i = 0, limit = Math.min(endIndex, sourceRanges.length); i < limit; i++) {
    const sr = sourceRanges[i];
    if (sr.from >= bounds.start && sr.to <= bounds.end && isDirectVisibleMatch(block, content, sr)) indices.push(i);
  }
  return indices;
}

export function translateSourceIndexToRendered(host: Element | null, content: string, sourceRanges: SourceRange[], sourceIdx: number, query: string, options: SearchMatchConfig = false, knownWindowed?: WindowedMatch[] | null, knownMatches?: Range[]): number {
  if (sourceIdx < 0 || !host) return -1;
  const sr = sourceRanges[sourceIdx];
  const block = sr ? findContainingBlock(host, sr, content) : null;
  if (!sr || !block) return -1;
  const liveWindowed = knownWindowed !== undefined ? knownWindowed : windowedMatches(host, query, options);
  if (liveWindowed) {
    if (!liveWindowed.length) return -1;
    if (!block.closest('[data-windowed-mounted="false"]')) {
      const resolved = mapSourceRangeToDomRange(block, content, sourceRanges, sourceIdx, query, options);
      if (!resolved) return -1;
      for (let i = 0; i < liveWindowed.length; i++) {
        const w = liveWindowed[i];
        if (w.element === block || w.element.contains(block) || block.contains(w.element)) {
          const wRange = readingMatches(w.element, query, options)[w.ordinal];
          if (wRange && sameDomRange(wRange, resolved)) return i;
        }
      }
    }
    const owner = deepestSourceOwner(block, sr, content);
    if (owner && !isDirectVisibleMatch(owner, content, sr)) return -1;
    const wBlock = block.closest<HTMLElement>("[data-windowed-block]") ?? block;
    const targetOrdinal = visibleBlockSourceIndices(wBlock, content, sourceRanges, sourceIdx).length;
    const exactIdx = liveWindowed.findIndex(w => w.element === wBlock && w.ordinal === targetOrdinal);
    if (exactIdx >= 0) return exactIdx;
    return liveWindowed.findIndex(w => {
      const b = sourceBounds(w.element, content);
      return b !== null && sr.from >= b.start && sr.to <= b.end;
    });
  }
  const liveMatches = knownMatches !== undefined ? knownMatches : readingMatches(host, query, options);
  if (!liveMatches.length) return -1;
  const resolved = mapSourceRangeToDomRange(block, content, sourceRanges, sourceIdx, query, options);
  return resolved ? liveMatches.findIndex(m => sameDomRange(m, resolved)) : -1;
}

export function translateRenderedIndexToSource(host: Element | null, content: string, sourceRanges: SourceRange[], renderedIdx: number, query: string, options: SearchMatchConfig = false, cachedWindowed?: WindowedMatch[] | null, cachedMatches?: Range[]): number {
  if (renderedIdx < 0 || !sourceRanges.length || !host) return -1;
  const liveWindowed = cachedWindowed && cachedWindowed.every(w => w.element.isConnected && host.contains(w.element))
    ? cachedWindowed
    : windowedMatches(host, query, options);
  if (liveWindowed) {
    const active = liveWindowed[renderedIdx];
    if (!active) return -1;
    if (!active.element.closest('[data-windowed-mounted="false"]')) {
      const domRange = readingMatches(active.element, query, options)[active.ordinal];
      return domRange ? mapDomRangeToSourceIndex(host, content, sourceRanges, domRange, query, options) : -1;
    }
    return visibleBlockSourceIndices(active.element, content, sourceRanges)[active.ordinal] ?? -1;
  }
  const cachedDom = cachedMatches?.[renderedIdx];
  const liveDomRange = cachedDom && cachedDom.startContainer.nodeType === Node.TEXT_NODE && host.contains(cachedDom.startContainer)
    ? cachedDom
    : readingMatches(host, query, options)[renderedIdx];
  return liveDomRange ? mapDomRangeToSourceIndex(host, content, sourceRanges, liveDomRange, query, options) : -1;
}

export function resolveActiveHighlightRange(host: Element | null, activeIndex: number, options: { sourceSearch: boolean; content: string; sourceRanges: SourceRange[]; windowed: WindowedMatch[] | null; matches: Range[]; query: string; filterOptions: SearchMatchConfig }): Range | null {
  if (activeIndex < 0) return null;
  const { sourceSearch, content, sourceRanges, windowed, matches, query, filterOptions } = options;
  if (sourceSearch) return host ? resolveSourceHighlightRange(host, content, sourceRanges, activeIndex, query, filterOptions) : null;
  if (windowed) {
    const match = windowed[activeIndex];
    return match && !match.element.closest('[data-windowed-mounted="false"]') ? (readingMatches(match.element, query, filterOptions)[match.ordinal] ?? null) : null;
  }
  return matches[activeIndex] ?? null;
}

export function syncSearchHighlights(update: { all?: Range[] | (() => Range[]) | null; current?: Range | (() => Range | null) | null }): void {
  const registry = typeof CSS === "undefined" ? undefined : (CSS as typeof CSS & { highlights?: HighlightRegistry }).highlights;
  if (!registry) return;
  const HighlightClass = typeof window === "undefined" ? undefined : (window as typeof window & { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  if (update.all === null) registry.delete("smd-search");
  else if (update.all !== undefined && HighlightClass) {
    const allRanges = typeof update.all === "function" ? update.all() : update.all;
    registry.set("smd-search", new HighlightClass(...allRanges));
  }
  if (update.current === null) registry.delete("smd-search-current");
  else if (update.current !== undefined && HighlightClass) {
    registry.delete("smd-search-current");
    const currentRange = typeof update.current === "function" ? update.current() : update.current;
    if (currentRange) registry.set("smd-search-current", new HighlightClass(currentRange));
  }
}
