import { flushSync } from "react-dom";
import { windowedMatches, revealWindowed, compileSearchPattern, nextSearchMatch, normalizeSearchOptions, type WindowedMatch, type SearchMatchConfig, type SearchMatchOptions } from "./windowedSearch";
import { parseFrontmatter, type FrontmatterVisibleField, type FrontmatterVisibleSpan, type ParsedFrontmatter } from "./frontmatter";
import { cancelHeadingNavigation } from "./documentNavigation";
import { refreshDocumentExtent } from "./documentZoom";
export type { SearchMatchConfig, SearchMatchOptions };

export const cancelSettlingHeading = () => document.querySelectorAll(".android-reading,.reading-scroll,.live-pane").forEach(cancelHeadingNavigation);
export const findReadingHost = () => document.querySelector<HTMLElement>(".android-reading,.reading-scroll,.live-document,.markdown-body");
export type HighlightRegistry = Map<string, unknown>;
export type SourceRange = { from: number; to: number };

const MAX_SEARCH_MATCHES = 5000, MAX_HIDDEN_SCAN_CHARS = 200_000;
const INLINE_HTML_HIDDEN_TOKEN = /<!--[\s\S]*?-->|<\/?(?:br|mark|sub|sup|kbd|u)(?:\s+(?:[^>"']|"[^"]*"|'[^']*')*)?\s*\/?>/gi;
const EXCLUDED_SEARCH_TAGS = new Set(["button", "input", "textarea", "select", "svg", "script", "style", "template", "annotation", "iframe"]);
const EXCLUDED_SEARCH_CLASS_PATTERN = /(?:^|\s)(?:katex-mathml|chart-controls|chart-toolbar|chart-legend|image-edit-tools|image-loading|image-error|remote-image-card|is-offstage)(?:\s|$)/;
const SEARCH_BLOCK_TAGS = new Set(["p", "h1", "h2", "h3", "h4", "li", "pre", "td", "summary"]);
const OBSERVED_SEARCH_ATTRS = ["data-windowed-mounted", "hidden", "inert", "style", "class", "aria-hidden", "data-frontmatter-properties", "data-frontmatter-field", "data-source-start", "data-source-end"];

type DomVersionEntry = { observer: MutationObserver | null; version: number };
type RangeLike = { startContainer: Node; startOffset: number; endContainer: Node; endOffset: number };
const domVersions = new WeakMap<Element, DomVersionEntry>();
const readingMatchesCache = new WeakMap<Element, { root: Element; version: number; key: string; connected: boolean; ranges: Range[] }>();
const sourceHighlightCache = new WeakMap<Element, { root: Element; version: number; connected: boolean; content: string; ranges: SourceRange[]; activeIndex: number; key: string; range: Range | null }>();
const highlightSyncCache = new WeakMap<HighlightRegistry, { allRef?: Range[]; allSnaps?: RangeLike[]; current?: RangeLike | null }>();
let cachedFmContent: string | null = null, cachedFmResult: ParsedFrontmatter | null = null;

function getParsedFrontmatter(content: string): ParsedFrontmatter | null {
  if (cachedFmContent !== content) { cachedFmContent = content; cachedFmResult = parseFrontmatter(content, { includeSpans: true }); }
  return cachedFmResult;
}
const isFrontmatterPropertiesContainer = (el: Element): boolean => el.hasAttribute("data-frontmatter-properties") || el.classList.contains("document-properties");
const isAllowedFrontmatterField = (el: Element): el is HTMLElement => {
  const field = el.getAttribute("data-frontmatter-field");
  return field === "title" || field === "author" || field === "tag";
};

function hasRelevantSearchMutation(records: MutationRecord[]): boolean {
  return records.some(r => {
    if (r.type !== "attributes" || r.attributeName !== "style") return true;
    const style = (r.target as HTMLElement).style, nowHidden = Boolean(style && (style.display === "none" || style.visibility === "hidden"));
    return nowHidden || Boolean(r.oldValue && /(?:none|hidden)/i.test(r.oldValue));
  });
}

export function getSearchDomVersion(el: Element): { root: Element; version: number } {
  const root = el.closest(".android-reading,.reading-scroll") ?? el.closest(".live-document,.markdown-body") ?? el;
  let entry = domVersions.get(root);
  if (!entry) {
    if (typeof MutationObserver === "undefined") return { root, version: NaN };
    const created: DomVersionEntry = { observer: null, version: 0 };
    created.observer = new MutationObserver(records => { if (hasRelevantSearchMutation(records)) created.version++; });
    created.observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true, attributeOldValue: true, attributeFilter: OBSERVED_SEARCH_ATTRS });
    domVersions.set(root, (entry = created));
  } else if (entry.observer) {
    const pending = entry.observer.takeRecords();
    if (pending.length && hasRelevantSearchMutation(pending)) entry.version++;
  }
  return { root, version: entry.version };
}

function searchOptionKey(query: string, options: SearchMatchConfig): string {
  const { caseSensitive, wholeWord, regexp } = normalizeSearchOptions(options);
  return `${query}\0${caseSensitive ? 1 : 0}${wholeWord ? 1 : 0}${regexp ? 1 : 0}`;
}

function firstSourceRangeFrom(ranges: SourceRange[], minFrom: number, end = ranges.length): number {
  let lo = 0, hi = Math.min(end, ranges.length);
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (ranges[mid].from < minFrom) lo = mid + 1; else hi = mid; }
  return lo;
}

function isHiddenOrExcludedSearchElement(el: Element): boolean {
  if (EXCLUDED_SEARCH_TAGS.has(el.localName) || !el.hasAttributes()) return EXCLUDED_SEARCH_TAGS.has(el.localName);
  const cls = el.className;
  if (typeof cls === "string" && cls.length > 0 && EXCLUDED_SEARCH_CLASS_PATTERN.test(cls)) return true;
  if (el.getAttribute("data-windowed-mounted") === "false" || el.hasAttribute("hidden") || el.hasAttribute("inert")) return true;
  if (el.getAttribute("aria-hidden") === "true" && !el.classList.contains("katex-html")) return true;
  const inlineStyle = el.getAttribute("style");
  if (inlineStyle && (inlineStyle.includes("none") || inlineStyle.includes("hidden"))) {
    const style = (el as HTMLElement).style;
    if (style && (style.display === "none" || style.visibility === "hidden")) return true;
  }
  return false;
}

export const nextSearchIndex = (index: number, direction: number, count: number): number =>
  count <= 0 ? -1 : index < 0 ? (direction < 0 ? count - 1 : 0) : ((index + direction) % count + count) % count;

export function revealMountedBlock(element: Element): void {
  if (!(element instanceof HTMLElement)) return;
  const w = element.closest<HTMLElement>("[data-windowed-block]");
  if (w?.getAttribute("data-windowed-mounted") === "true") return;
  if (w?.getAttribute("data-windowed-mounted") === "false") flushSync(() => revealWindowed(element));
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
      const two = Number(digits), one = Number(digits[0]);
      if (digits.length === 2 && two > 0 && two < match.length) return match[two] ?? "";
      return one > 0 && one < match.length ? (match[one] ?? "") + digits.slice(1) : token;
    }
    return groupName !== undefined && match.groups ? (Object.prototype.hasOwnProperty.call(match.groups, groupName) ? (match.groups[groupName] ?? "") : "") : token;
  });
}

function markdownBracketEnd(raw: string, openIndex = 0): number {
  if (raw[openIndex] !== "[") return raw.length;
  for (let i = openIndex, depth = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "\\") { i++; continue; }
    if (ch === "`") {
      let ticks = 1;
      while (raw[i + ticks] === "`") ticks++;
      const close = raw.indexOf("`".repeat(ticks), i + ticks);
      if (close >= 0) { i = close + ticks - 1; continue; }
    }
    if (ch === "[") depth++;
    else if (ch === "]" && --depth === 0) return i;
  }
  return raw.length;
}

function markdownLinkTailEnd(raw: string, afterBracket: number): number {
  if (raw[afterBracket] === "(") {
    for (let i = afterBracket, depth = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (ch === "\\") { i++; continue; }
      if (ch === "(") depth++;
      else if (ch === ")" && --depth === 0) return i + 1;
    }
    return raw.length;
  }
  if (raw[afterBracket] === "[") { const end = markdownBracketEnd(raw, afterBracket); return end < raw.length ? end + 1 : raw.length; }
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
      if (htmlMatch && htmlMatch.index === i) { const end = i + htmlMatch[0].length; hidden.push({ from: offset + i, to: offset + end }); i = Math.max(i, end - 1); continue; }
    }
    if (ch === "!" && raw[i + 1] === "[") {
      const close = markdownBracketEnd(raw, i + 1);
      if (close < raw.length) { const end = markdownLinkTailEnd(raw, close + 1); hidden.push({ from: offset + i, to: offset + end }); i = Math.max(i, end - 1); continue; }
    }
    if (ch === "[") {
      const close = markdownBracketEnd(raw, i), end = close < raw.length ? markdownLinkTailEnd(raw, close + 1) : 0;
      if (end > close + 1) { hidden.push({ from: offset + close, to: offset + end }); i = Math.max(i, end - 1); }
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
    let regionStart = 0, ordinal = 0, regionEnd = content.length;
    for (let prev = el.previousElementSibling; prev; prev = prev.previousElementSibling) {
      const prevEnd = prev instanceof HTMLElement ? prev.getAttribute("data-source-end") : null;
      if (prevEnd !== null && Number.isFinite(Number(prevEnd))) { regionStart = Number(prevEnd); break; }
      if (prev instanceof HTMLElement && prev.classList.contains("code-container")) ordinal++;
    }
    if (regionStart === 0) { const fm = getParsedFrontmatter(content); if (fm) regionStart = fm.end; }
    for (let next = el.nextElementSibling; next; next = next.nextElementSibling) {
      const nextStart = next instanceof HTMLElement ? next.getAttribute("data-source-start") : null;
      if (nextStart !== null && Number.isFinite(Number(nextStart))) { regionEnd = Number(nextStart); break; }
    }
    if (regionEnd >= regionStart) {
      const slice = content.slice(regionStart, regionEnd), fencePattern = /^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n[ \t]*\1[ \t]*(?=\r?\n|$)/gm;
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
    for (let owner = anchor?.closest("details") || null; owner; owner = owner.parentElement?.closest("details") || null) if (!owner.open) { owner.open = true; opened = true; }
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
  const { start, end } = bounds, raw = content.slice(start, end);
  if (owner.tagName === "A" && raw.startsWith("[")) { const close = markdownBracketEnd(raw, 0); return close < raw.length ? { start: start + 1, end: start + close } : bounds; }
  if (owner.matches("details.callout,aside.callout")) { const marker = raw.match(/^\s*(?:>[ \t]*)?\[![\w-]+\][+-]?[ \t]*/i); if (marker) return { start: start + marker[0].length, end }; }
  if (owner.matches(".code-container,.python-cell")) {
    const firstBreak = raw.indexOf("\n");
    if (firstBreak < 0) return { start: end, end };
    const trimmed = raw.replace(/\s+$/, ""), lastBreak = trimmed.lastIndexOf("\n");
    const bodyEnd = lastBreak >= firstBreak && /^\s*(?:`{3,}|~{3,})\s*$/.test(trimmed.slice(lastBreak + 1)) ? start + lastBreak : end;
    return { start: Math.min(start + firstBreak + 1, bodyEnd), end: bodyEnd };
  }
  return bounds;
}

const ownerDomScope = (owner: HTMLElement): Element => owner.matches(".code-container,.python-cell") ? (owner.querySelector("pre.python-source,pre") ?? owner) : owner;

export function findContainingBlock(host: Element, range: SourceRange, content?: string): HTMLElement | null {
  let best: HTMLElement | null = null, bestLen = Infinity, overlapping: HTMLElement | null = null, overlappingLen = Infinity;
  for (const el of host.querySelectorAll<HTMLElement>(".live-block,[data-windowed-block],[data-source-start],.code-container")) {
    const bounds = sourceBounds(el, content);
    if (!bounds) continue;
    const len = bounds.end - bounds.start, isTopBlock = el.classList.contains("live-block") || el.hasAttribute("data-windowed-block");
    if (bounds.start <= range.from && range.to <= bounds.end) {
      if (isTopBlock ? (!best || (!best.classList.contains("live-block") && !best.hasAttribute("data-windowed-block")) || len < bestLen) : (!best && len <= bestLen)) { best = el; bestLen = len; }
    } else if (bounds.start <= range.from && range.from < bounds.end && len <= overlappingLen) { overlapping = el; overlappingLen = len; }
  }
  return best ?? overlapping;
}

export function deepestSourceOwner(block: HTMLElement, range: SourceRange, content?: string): HTMLElement | null {
  let owner: HTMLElement | null = null, ownerLen = Infinity;
  const blockBounds = sourceBounds(block, content);
  if (blockBounds && blockBounds.start <= range.from && range.from <= blockBounds.end) { owner = block; ownerLen = blockBounds.end - blockBounds.start; }
  for (const el of block.querySelectorAll<HTMLElement>("[data-source-start],.code-container")) {
    const bounds = sourceBounds(el, content);
    if (bounds && bounds.start <= range.from && range.to <= bounds.end && bounds.end - bounds.start <= ownerLen) { owner = el; ownerLen = bounds.end - bounds.start; }
  }
  return owner;
}

const ownerHiddenSpans = (owner: HTMLElement, content: string, visible: { start: number; end: number }): SourceRange[] =>
  !owner.closest("pre,code,.code-container,.python-cell") && visible.end - visible.start <= MAX_HIDDEN_SCAN_CHARS
    ? hiddenSpansInSlice(content.slice(visible.start, visible.end), visible.start) : [];

function isDirectVisibleMatch(owner: HTMLElement, content: string, candidate: SourceRange, visible = visibleSourceSpan(owner, content), hidden?: SourceRange[]): boolean {
  if (!visible || candidate.from < visible.start || candidate.to > visible.end) return false;
  return deepestSourceOwner(owner, candidate, content) === owner && !(hidden ?? ownerHiddenSpans(owner, content, visible)).some(h => candidate.from >= h.from && candidate.to <= h.to);
}

function directOwnerDomRanges(owner: HTMLElement, query: string, options: SearchMatchConfig): Range[] {
  return readingMatches(ownerDomScope(owner), query, options).filter(r => {
    if (owner.matches(".code-container,.python-cell") && r.startContainer.parentElement?.closest("summary")) return false;
    const common = r.commonAncestorContainer.nodeType === Node.ELEMENT_NODE ? r.commonAncestorContainer as Element : r.commonAncestorContainer.parentElement;
    const closestOwner = common?.closest("[data-source-start],.code-container");
    return !closestOwner || closestOwner === owner || !owner.contains(closestOwner);
  });
}

export function mapSourceRangeToDomRange(block: HTMLElement, content: string, ranges: SourceRange[], activeIndex: number, query: string, options: SearchMatchConfig = false): Range | null {
  const target = ranges[activeIndex];
  if (!target || block.closest('[data-windowed-mounted="false"]')) return null;
  const owner = deepestSourceOwner(block, target, content), visible = owner ? visibleSourceSpan(owner, content) : null;
  const hidden = owner && visible ? ownerHiddenSpans(owner, content, visible) : undefined;
  if (!owner || !visible || !isDirectVisibleMatch(owner, content, target, visible, hidden)) return null;
  const domRanges = directOwnerDomRanges(owner, query, options);
  if (!domRanges.length) return null;
  const ownerBounds = sourceBounds(owner, content);
  let ordinal = 0;
  for (let i = ownerBounds ? firstSourceRangeFrom(ranges, ownerBounds.start, activeIndex) : 0; i < activeIndex; i++) {
    const candidate = ranges[i];
    if (ownerBounds && candidate.from > ownerBounds.end) break;
    if ((!ownerBounds || candidate.to <= ownerBounds.end) && deepestSourceOwner(block, candidate, content) === owner && isDirectVisibleMatch(owner, content, candidate, visible, hidden)) ordinal++;
  }
  return domRanges[ordinal] ?? null;
}

const sameDomRange = (a: RangeLike, b: RangeLike): boolean =>
  a.startContainer === b.startContainer && a.startOffset === b.startOffset && a.endContainer === b.endContainer && a.endOffset === b.endOffset;

function findFrontmatterFieldElement(host: Element, field: FrontmatterVisibleField, fieldOrdinal: number): HTMLElement | null {
  const header = isFrontmatterPropertiesContainer(host) ? host : host.querySelector("[data-frontmatter-properties],.document-properties");
  return header ? (header.querySelectorAll<HTMLElement>(`[data-frontmatter-field="${field}"]`)[fieldOrdinal] ?? null) : null;
}

function orderedFrontmatterSourceIndices(spans: FrontmatterVisibleSpan[], ranges: SourceRange[], field: FrontmatterVisibleField, fieldOrdinal: number): number[] {
  const indices: number[] = [];
  for (const span of spans) {
    if (span.field !== field || span.fieldOrdinal !== fieldOrdinal) continue;
    for (let i = firstSourceRangeFrom(ranges, span.start); i < ranges.length; i++) {
      const candidate = ranges[i];
      if (candidate.from > span.end) break;
      if (candidate.to <= span.end && !indices.includes(i)) indices.push(i);
    }
  }
  return indices;
}

export function mapFrontmatterSourceRangeToDomRange(host: Element, content: string, ranges: SourceRange[], activeIndex: number, query: string, options: SearchMatchConfig = false): Range | null {
  const target = ranges[activeIndex], spans = target ? getParsedFrontmatter(content)?.visibleSpans : undefined;
  const matchSpan = spans?.find(s => target.from >= s.start && target.to <= s.end);
  const fieldEl = matchSpan ? findFrontmatterFieldElement(host, matchSpan.field, matchSpan.fieldOrdinal) : null;
  if (!fieldEl || !spans || !matchSpan) return null;
  const domRanges = readingMatches(fieldEl, query, options);
  if (!domRanges.length) return null;
  const ordinal = orderedFrontmatterSourceIndices(spans, ranges, matchSpan.field, matchSpan.fieldOrdinal).indexOf(activeIndex);
  return ordinal >= 0 ? (domRanges[ordinal] ?? null) : null;
}

export function mapDomRangeToSourceIndex(host: Element, content: string, ranges: SourceRange[], domRange: Range, query: string, options: SearchMatchConfig = false): number {
  const common = domRange.commonAncestorContainer.nodeType === Node.ELEMENT_NODE ? domRange.commonAncestorContainer as Element : domRange.commonAncestorContainer.parentElement;
  const fmFieldEl = common?.closest<HTMLElement>("[data-frontmatter-field]");
  if (fmFieldEl && isAllowedFrontmatterField(fmFieldEl)) {
    const rawField = fmFieldEl.getAttribute("data-frontmatter-field") as FrontmatterVisibleField;
    const header = fmFieldEl.closest("[data-frontmatter-properties],.document-properties") ?? host;
    const fieldOrdinal = Array.from(header.querySelectorAll<HTMLElement>(`[data-frontmatter-field="${rawField}"]`)).indexOf(fmFieldEl);
    const ordinal = fieldOrdinal >= 0 ? readingMatches(fmFieldEl, query, options).findIndex(r => sameDomRange(r, domRange)) : -1;
    const spans = ordinal >= 0 ? getParsedFrontmatter(content)?.visibleSpans : undefined;
    const mapped = spans?.length ? orderedFrontmatterSourceIndices(spans, ranges, rawField, fieldOrdinal)[ordinal] : undefined;
    if (mapped !== undefined) return mapped;
  }
  const owner = common?.closest<HTMLElement>("[data-source-start],.code-container");
  if (owner) {
    const ordinal = directOwnerDomRanges(owner, query, options).findIndex(r => sameDomRange(r, domRange));
    const visible = ordinal >= 0 ? visibleSourceSpan(owner, content) : null;
    if (ordinal >= 0 && visible) {
      const hidden = ownerHiddenSpans(owner, content, visible), ownerBounds = sourceBounds(owner, content);
      let seen = 0;
      for (let i = ownerBounds ? firstSourceRangeFrom(ranges, ownerBounds.start) : 0; i < ranges.length; i++) {
        const candidate = ranges[i];
        if (ownerBounds && candidate.from > ownerBounds.end) break;
        if (ownerBounds && candidate.to > ownerBounds.end) continue;
        const block = findContainingBlock(host, candidate, content);
        if (block && deepestSourceOwner(block, candidate, content) === owner && isDirectVisibleMatch(owner, content, candidate, visible, hidden)) {
          if (seen++ === ordinal) return i;
        }
      }
    }
  }
  const scopeBlock = common?.closest<HTMLElement>(".live-block,[data-windowed-block],[data-source-start],.code-container");
  const scopeBounds = scopeBlock ? sourceBounds(scopeBlock, content) : null;
  for (let i = scopeBounds ? firstSourceRangeFrom(ranges, scopeBounds.start) : 0; i < ranges.length; i++) {
    const candidate = ranges[i];
    if (scopeBounds && candidate.from > scopeBounds.end) break;
    const block = findContainingBlock(host, candidate, content);
    if (!block || !block.contains(domRange.startContainer)) continue;
    const resolved = mapSourceRangeToDomRange(block, content, ranges, i, query, options);
    if (resolved && sameDomRange(resolved, domRange)) return i;
  }
  return -1;
}

export function resolveSourceBlock(host: Element, range: SourceRange, content?: string): HTMLElement | null {
  const containing = findContainingBlock(host, range, content);
  if (containing) return deepestSourceOwner(containing, range, content) ?? containing;
  let fallback: HTMLElement | null = null;
  for (const el of host.querySelectorAll<HTMLElement>("[data-source-start]")) { const b = sourceBounds(el, content); if (b && b.start <= range.from) fallback = el; }
  return fallback;
}

export function resolveSourceHighlightRange(host: Element, content: string, ranges: SourceRange[], activeIndex: number, query: string, options: SearchMatchConfig = false, knownBlock?: HTMLElement | null): Range | null {
  const target = ranges[activeIndex];
  if (!target) return null;
  const { root, version } = getSearchDomVersion(host), key = searchOptionKey(query, options), cached = sourceHighlightCache.get(host);
  if (cached && cached.root === root && cached.version === version && cached.connected === host.isConnected && cached.content === content && cached.ranges === ranges && cached.activeIndex === activeIndex && cached.key === key) return cached.range;
  const block = knownBlock ?? findContainingBlock(host, target, content);
  const range = block ? mapSourceRangeToDomRange(block, content, ranges, activeIndex, query, options) : mapFrontmatterSourceRangeToDomRange(host, content, ranges, activeIndex, query, options);
  if (!Number.isNaN(version)) sourceHighlightCache.set(host, { root, version, connected: host.isConnected, content, ranges, activeIndex, key, range });
  return range;
}

function collectSearchText(root: Element, initialBlock: Element | null, state: { parts: Array<{ node: Text; start: number; end: number }>; text: string; block: Element | null }): void {
  const walkFrontmatterFields = (container: Element) => {
    for (const fieldEl of container.querySelectorAll("[data-frontmatter-field]")) {
      if (!isAllowedFrontmatterField(fieldEl)) continue;
      let excluded = false;
      for (let anc: Element | null = fieldEl; anc && anc !== container; anc = anc.parentElement) if (isHiddenOrExcludedSearchElement(anc)) { excluded = true; break; }
      if (!excluded) walk(fieldEl, fieldEl);
    }
  };
  const walk = (el: Element, currentBlock: Element | null) => {
    for (let child = el.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === Node.TEXT_NODE) {
        const value = (child as Text).data;
        if (!value) continue;
        if (state.block !== currentBlock) { state.text += "\n"; state.block = currentBlock; }
        const start = state.text.length;
        state.parts.push({ node: child as Text, start, end: start + value.length }); state.text += value;
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const childEl = child as Element;
        if (isHiddenOrExcludedSearchElement(childEl)) continue;
        if (isFrontmatterPropertiesContainer(childEl)) { walkFrontmatterFields(childEl); continue; }
        walk(childEl, isAllowedFrontmatterField(childEl) || SEARCH_BLOCK_TAGS.has(childEl.localName) ? childEl : currentBlock);
      }
    }
  };
  if (isFrontmatterPropertiesContainer(root)) walkFrontmatterFields(root);
  else walk(root, initialBlock);
}

function matchPartsToRanges(parts: Array<{ node: Text; start: number; end: number }>, text: string, pattern: RegExp): Range[] {
  if (!parts.length) return [];
  // Case folding can expand Unicode characters and invalidate DOM offsets.
  // Regex matches retain the original UTF-16 positions instead.
  const ranges: Range[] = [];
  let match: RegExpExecArray | null, firstIndex = 0, lastIndex = 0;
  while ((match = nextSearchMatch(pattern, text)) && ranges.length < MAX_SEARCH_MATCHES) {
    const start = match.index, end = start + match[0].length;
    while (firstIndex < parts.length && parts[firstIndex].end <= start) firstIndex++;
    lastIndex = Math.max(lastIndex, firstIndex);
    while (lastIndex < parts.length && parts[lastIndex].end < end) lastIndex++;
    const first = parts[firstIndex], last = parts[lastIndex];
    if (!first || !last) continue;
    const startOffset = Math.max(0, Math.min(first.node.length, start - first.start)), endOffset = Math.max(0, Math.min(last.node.length, end - last.start));
    if (first.node === last.node && startOffset >= endOffset) continue;
    const range = document.createRange();
    range.setStart(first.node, startOffset); range.setEnd(last.node, endOffset); ranges.push(range);
  }
  return ranges;
}

export function readingMatches(host: Element, query: string, options: SearchMatchConfig = false): Range[] {
  const { pattern } = compileSearchPattern(query, options, false);
  if (!pattern) return [];
  const rawFieldAnc = host.closest("[data-frontmatter-field]"), insideAllowedField = rawFieldAnc && isAllowedFrontmatterField(rawFieldAnc) ? rawFieldAnc : null;
  for (let anc: Element | null = host; anc; anc = anc.parentElement) {
    if (isHiddenOrExcludedSearchElement(anc) || (anc !== host && isFrontmatterPropertiesContainer(anc) && !insideAllowedField)) return [];
  }
  const { root, version } = getSearchDomVersion(host), key = searchOptionKey(query, options), cached = readingMatchesCache.get(host);
  if (cached && cached.root === root && cached.version === version && cached.key === key && cached.connected === host.isConnected) return cached.ranges;
  const state = { parts: [] as Array<{ node: Text; start: number; end: number }>, text: "", block: null as Element | null };
  collectSearchText(host, insideAllowedField ?? host.closest("p,h1,h2,h3,h4,li,pre,td,summary"), state);
  const ranges = matchPartsToRanges(state.parts, state.text, pattern);
  if (!Number.isNaN(version)) readingMatchesCache.set(host, { root, version, key, connected: host.isConnected, ranges });
  return ranges;
}

export function replaceSourceMatches(content: string, query: string, replacement: string, options: SearchMatchConfig = false, index?: number): string {
  const { regexp } = normalizeSearchOptions(options), { pattern } = compileSearchPattern(query, options, true);
  if (!pattern) return content;
  let result = "", cursor = 0, ordinal = 0, match: RegExpExecArray | null;
  while ((match = nextSearchMatch(pattern, content))) {
    const shouldReplace = index === undefined || ordinal === index;
    result += content.slice(cursor, match.index) + (shouldReplace ? (regexp ? expandRegexReplacement(replacement, match, content) : replacement) : match[0]);
    cursor = match.index + match[0].length; ordinal++;
    if (index !== undefined && ordinal > index) break;
  }
  return ordinal === 0 ? content : result + content.slice(cursor);
}

export function sourceMatches(content: string, query: string, options: SearchMatchConfig = false): SourceRange[] {
  const { pattern } = compileSearchPattern(query, options, true);
  if (!pattern) return [];
  const matches: SourceRange[] = [];
  let match: RegExpExecArray | null;
  while ((match = nextSearchMatch(pattern, content)) && matches.length < MAX_SEARCH_MATCHES) matches.push({ from: match.index, to: match.index + match[0].length });
  return matches;
}

function visibleBlockSourceIndices(block: HTMLElement, content: string, sourceRanges: SourceRange[], endIndex = sourceRanges.length): number[] {
  const bounds = sourceBounds(block, content), visible = bounds ? visibleSourceSpan(block, content) : null;
  if (!bounds || !visible) return [];
  const hidden = ownerHiddenSpans(block, content, visible), indices: number[] = [], limit = Math.min(endIndex, sourceRanges.length);
  for (let i = firstSourceRangeFrom(sourceRanges, bounds.start, limit); i < limit; i++) {
    const sr = sourceRanges[i];
    if (sr.from > bounds.end) break;
    if (sr.to <= bounds.end && isDirectVisibleMatch(block, content, sr, visible, hidden)) indices.push(i);
  }
  return indices;
}

export function translateSourceIndexToRendered(host: Element | null, content: string, sourceRanges: SourceRange[], sourceIdx: number, query: string, options: SearchMatchConfig = false, knownWindowed?: WindowedMatch[] | null, knownMatches?: Range[]): number {
  const sr = sourceIdx >= 0 && host ? sourceRanges[sourceIdx] : undefined;
  if (!sr || !host) return -1;
  const block = findContainingBlock(host, sr, content), liveWindowed = knownWindowed !== undefined ? knownWindowed : windowedMatches(host, query, options);
  if (!block) {
    const fmResolved = mapFrontmatterSourceRangeToDomRange(host, content, sourceRanges, sourceIdx, query, options);
    if (!fmResolved) return -1;
    if (liveWindowed) {
      let cachedEl: Element | null = null, cachedRanges: Range[] = [];
      for (let i = 0; i < liveWindowed.length; i++) {
        const w = liveWindowed[i];
        if (w.element.contains(fmResolved.startContainer)) {
          if (cachedEl !== w.element) { cachedEl = w.element; cachedRanges = readingMatches(w.element, query, options); }
          const wRange = cachedRanges[w.ordinal];
          if (wRange && sameDomRange(wRange, fmResolved)) return i;
        }
      }
      return -1;
    }
    return (knownMatches !== undefined ? knownMatches : readingMatches(host, query, options)).findIndex(m => sameDomRange(m, fmResolved));
  }
  if (liveWindowed) {
    if (!liveWindowed.length) return -1;
    const wBlock = block.closest<HTMLElement>("[data-windowed-block]") ?? block;
    if (!block.closest('[data-windowed-mounted="false"]')) {
      const resolved = mapSourceRangeToDomRange(block, content, sourceRanges, sourceIdx, query, options);
      if (!resolved) return -1;
      let cachedEl: Element | null = null, cachedRanges: Range[] = [];
      for (let i = 0; i < liveWindowed.length; i++) {
        const w = liveWindowed[i];
        if (w.element === wBlock || w.element === block || w.element.contains(block) || block.contains(w.element)) {
          if (cachedEl !== w.element) { cachedEl = w.element; cachedRanges = readingMatches(w.element, query, options); }
          const wRange = cachedRanges[w.ordinal];
          if (wRange && sameDomRange(wRange, resolved)) return i;
        }
      }
    }
    const owner = deepestSourceOwner(block, sr, content);
    if (owner && !isDirectVisibleMatch(owner, content, sr)) return -1;
    const targetOrdinal = visibleBlockSourceIndices(wBlock, content, sourceRanges, sourceIdx).length;
    const exactIdx = liveWindowed.findIndex(w => w.element === wBlock && w.ordinal === targetOrdinal);
    return exactIdx >= 0 ? exactIdx : liveWindowed.findIndex(w => { const b = sourceBounds(w.element, content); return b !== null && sr.from >= b.start && sr.to <= b.end; });
  }
  const liveMatches = knownMatches !== undefined ? knownMatches : readingMatches(host, query, options);
  if (!liveMatches.length) return -1;
  const resolved = mapSourceRangeToDomRange(block, content, sourceRanges, sourceIdx, query, options);
  return resolved ? liveMatches.findIndex(m => sameDomRange(m, resolved)) : -1;
}

export function translateRenderedIndexToSource(host: Element | null, content: string, sourceRanges: SourceRange[], renderedIdx: number, query: string, options: SearchMatchConfig = false, cachedWindowed?: WindowedMatch[] | null, cachedMatches?: Range[]): number {
  if (renderedIdx < 0 || !sourceRanges.length || !host) return -1;
  const liveWindowed = cachedWindowed && cachedWindowed.every(w => w.element.isConnected && host.contains(w.element)) ? cachedWindowed : windowedMatches(host, query, options);
  if (liveWindowed) {
    const active = liveWindowed[renderedIdx];
    if (!active) return -1;
    if (active.element.closest('[data-windowed-mounted="false"]')) return visibleBlockSourceIndices(active.element, content, sourceRanges)[active.ordinal] ?? -1;
    const domRange = readingMatches(active.element, query, options)[active.ordinal];
    return domRange ? mapDomRangeToSourceIndex(host, content, sourceRanges, domRange, query, options) : -1;
  }
  const cachedDom = cachedMatches?.[renderedIdx];
  const liveDomRange = cachedDom && cachedDom.startContainer.nodeType === Node.TEXT_NODE && host.contains(cachedDom.startContainer) ? cachedDom : readingMatches(host, query, options)[renderedIdx];
  return liveDomRange ? mapDomRangeToSourceIndex(host, content, sourceRanges, liveDomRange, query, options) : -1;
}

export function resolveActiveHighlightRange(host: Element | null, activeIndex: number, options: { sourceSearch: boolean; content: string; sourceRanges: SourceRange[]; windowed: WindowedMatch[] | null; matches: Range[]; query: string; filterOptions: SearchMatchConfig }): Range | null {
  if (activeIndex < 0) return null;
  const { sourceSearch, content, sourceRanges, windowed, matches, query, filterOptions } = options;
  if (sourceSearch) return host ? resolveSourceHighlightRange(host, content, sourceRanges, activeIndex, query, filterOptions) : null;
  if (!windowed) return matches[activeIndex] ?? null;
  const match = windowed[activeIndex];
  return match && !match.element.closest('[data-windowed-mounted="false"]') ? (readingMatches(match.element, query, filterOptions)[match.ordinal] ?? null) : null;
}
const snapshotRange = (r: Range): RangeLike => ({ startContainer: r.startContainer, startOffset: r.startOffset, endContainer: r.endContainer, endOffset: r.endOffset });
export function syncSearchHighlights(update: { all?: Range[] | (() => Range[]) | null; current?: Range | (() => Range | null) | null }): void {
  const registry = typeof CSS === "undefined" ? undefined : (CSS as typeof CSS & { highlights?: HighlightRegistry }).highlights;
  const HighlightClass = typeof window === "undefined" ? undefined : (window as typeof window & { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  if (!registry) return;
  let state = highlightSyncCache.get(registry);
  if (!state) highlightSyncCache.set(registry, (state = {}));
  if (update.all === null) { registry.delete("smd-search"); state.allRef = undefined; state.allSnaps = undefined; }
  else if (update.all !== undefined && HighlightClass) {
    const allRanges = typeof update.all === "function" ? update.all() : update.all;
    if (!(registry.has("smd-search") && (state.allRef === allRanges || (state.allSnaps?.length === allRanges.length && allRanges.every((r, i) => sameDomRange(state!.allSnaps![i], r)))))) { registry.set("smd-search", new HighlightClass(...allRanges)); state.allSnaps = allRanges.map(snapshotRange); }
    state.allRef = allRanges;
  }
  if (update.current === null) { registry.delete("smd-search-current"); state.current = null; }
  else if (update.current !== undefined && HighlightClass) {
    const currentRange = typeof update.current === "function" ? update.current() : update.current;
    if (!currentRange) { registry.delete("smd-search-current"); state.current = null; }
    else if (!registry.has("smd-search-current") || !state.current || !sameDomRange(state.current, currentRange)) { registry.delete("smd-search-current"); registry.set("smd-search-current", new HighlightClass(currentRange)); state.current = snapshotRange(currentRange); }
  }
}
