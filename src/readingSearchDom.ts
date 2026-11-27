import { flushSync } from "react-dom";
import { windowedMatches, revealWindowed, compileSearchPattern, nextSearchMatch, normalizeSearchOptions, type WindowedMatch, type SearchMatchConfig, type SearchMatchOptions } from "./windowedSearch";
import { type FrontmatterVisibleField, type FrontmatterVisibleSpan } from "./frontmatter";
import { cancelHeadingNavigation } from "./documentNavigation";
import { refreshDocumentExtent } from "./documentZoom";
import {
  SOURCE_CANDIDATE_SELECTOR, deepestSourceOwner, findContainingBlock, findContainingBlockInIndex,
  getParsedFrontmatter, getSourceRangeIndex, invalidateSourceRangeIndex, isDirectVisibleMatch,
  resolveSourceBlock, sourceBoundsForElement, type SourceRange, type SourceRangeIndex,
} from "./readingSearchSourceIndex";
export type { SearchMatchConfig, SearchMatchOptions, SourceRange };
export { deepestSourceOwner, findContainingBlock, invalidateSourceRangeIndex, resolveSourceBlock };

export const cancelSettlingHeading = () => document.querySelectorAll(".android-reading,.reading-scroll,.live-pane").forEach(cancelHeadingNavigation);
export const findReadingHost = () => document.querySelector<HTMLElement>(".android-reading,.reading-scroll,.live-document,.markdown-body");
export type HighlightRegistry = Map<string, unknown>;

const MAX_SEARCH_MATCHES = 5000;
const EXCLUDED_SEARCH_TAGS = new Set(["button", "input", "textarea", "select", "svg", "script", "style", "template", "annotation", "iframe"]);
const EXCLUDED_SEARCH_CLASS_PATTERN = /(?:^|\s)(?:katex-mathml|chart-controls|chart-toolbar|chart-legend|image-edit-tools|image-loading|image-error|remote-image-card|is-offstage)(?:\s|$)/;
const SEARCH_BLOCK_TAGS = new Set(["p", "h1", "h2", "h3", "h4", "li", "pre", "td", "summary"]);
const OBSERVED_SEARCH_ATTRS = ["data-windowed-mounted", "data-windowed-block", "hidden", "inert", "style", "class", "aria-hidden", "data-frontmatter-properties", "data-frontmatter-field", "data-source-start", "data-source-end"];

type DomVersionEntry = { observer: MutationObserver | null; version: number };
type RangeLike = { startContainer: Node; startOffset: number; endContainer: Node; endOffset: number };
const domVersions = new WeakMap<Element, DomVersionEntry>();
const readingMatchesCache = new WeakMap<Element, { root: Element; version: number; key: string; connected: boolean; ranges: Range[] }>();
const sourceHighlightCache = new WeakMap<Element, {
  root: Element; version: number; indexVersion: number; connected: boolean; content: string;
  ranges: SourceRange[]; activeIndex: number; key: string; knownBlock: HTMLElement | null | undefined; range: Range | null;
}>();
const highlightSyncCache = new WeakMap<HighlightRegistry, { allRef?: Range[]; allSnaps?: RangeLike[]; current?: RangeLike | null }>();

const isFrontmatterPropertiesContainer = (el: Element): boolean => el.hasAttribute("data-frontmatter-properties") || el.classList.contains("document-properties");
const isAllowedFrontmatterField = (el: Element): el is HTMLElement => ["title", "author", "tag"].includes(el.getAttribute("data-frontmatter-field") ?? "");
export const rangeStartElement = (r: Range | null): Element | null => r ? (r.startContainer.nodeType === Node.ELEMENT_NODE ? r.startContainer as Element : r.startContainer.parentElement) : null;
export const isLiveMatchRange = (r: Range | null | undefined, root?: Element): r is Range =>
  Boolean(r && !r.collapsed && (root ? root.contains(r.startContainer) : r.startContainer.isConnected) && !rangeStartElement(r)?.closest('[data-windowed-mounted="false"]'));

function hasRelevantSearchMutation(records: MutationRecord[]): boolean {
  return records.some(r => {
    if (r.type !== "attributes" || r.attributeName !== "style") return true;
    const s = (r.target as HTMLElement).style;
    return Boolean(s && (s.display === "none" || s.visibility === "hidden")) || Boolean(r.oldValue && /(?:none|hidden)/i.test(r.oldValue));
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
export function firstSourceRangeFrom(ranges: SourceRange[], minFrom: number, end = ranges.length): number {
  let lo = 0, hi = Math.min(end, ranges.length);
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (ranges[mid].from < minFrom) lo = mid + 1; else hi = mid; }
  return lo;
}
export function findMatchingSourceRangeIndex(ranges: SourceRange[], target: SourceRange): number {
  for (let i = firstSourceRangeFrom(ranges, target.from); i < ranges.length && ranges[i].from === target.from; i++) if (ranges[i].to === target.to) return i;
  return ranges.findIndex(r => r.from === target.from && r.to === target.to);
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

export function openDisclosuresFor(target: Element | null, scope?: Element | null, range?: Range | null, sourceRange?: SourceRange): boolean {
  let opened = false;
  for (const anchor of [rangeStartElement(range ?? null), target, scope]) {
    for (let owner = anchor?.closest("details") || null; owner; owner = owner.parentElement?.closest("details") || null) if (!owner.open) { owner.open = true; opened = true; }
  }
  const container = scope ?? target;
  if (container) {
    if (container instanceof HTMLDetailsElement && !container.open) { container.open = true; opened = true; }
    for (const disclosure of container.querySelectorAll<HTMLDetailsElement>("details")) {
      if (disclosure.open) continue;
      if (range && disclosure.contains(range.startContainer)) { disclosure.open = true; opened = true; continue; }
      if (sourceRange) {
        const bounds = sourceBoundsForElement(disclosure.closest("[data-source-start]") || disclosure);
        if (!bounds || (bounds.start <= sourceRange.from && sourceRange.from <= bounds.end)) { disclosure.open = true; opened = true; }
      }
    }
  }
  return opened;
}

const ownerDomScope = (owner: HTMLElement): Element => owner.matches(".code-container,.python-cell") ? (owner.querySelector("pre.python-source,pre") ?? owner) : owner;

function directOwnerDomRanges(owner: HTMLElement, query: string, options: SearchMatchConfig): Range[] {
  return readingMatches(ownerDomScope(owner), query, options).filter(r => {
    if (owner.matches(".code-container,.python-cell") && r.startContainer.parentElement?.closest("summary")) return false;
    const common = r.commonAncestorContainer.nodeType === Node.ELEMENT_NODE ? r.commonAncestorContainer as Element : r.commonAncestorContainer.parentElement;
    const closestOwner = common?.closest("[data-source-start],.code-container");
    return !closestOwner || closestOwner === owner || !owner.contains(closestOwner);
  });
}

export function mapSourceRangeToDomRange(block: HTMLElement, content: string, ranges: SourceRange[], activeIndex: number, query: string, options: SearchMatchConfig = false, sharedIndex?: SourceRangeIndex): Range | null {
  const target = ranges[activeIndex];
  if (!target || block.closest('[data-windowed-mounted="false"]')) return null;
  const owner = deepestSourceOwner(block, target, content, sharedIndex);
  if (!owner || !isDirectVisibleMatch(owner, content, target, sharedIndex)) return null;
  const domRanges = directOwnerDomRanges(owner, query, options);
  if (!domRanges.length) return null;
  const ownerBounds = sourceBoundsForElement(owner, content, sharedIndex);
  let ordinal = 0;
  for (let i = ownerBounds ? firstSourceRangeFrom(ranges, ownerBounds.start, activeIndex) : 0; i < activeIndex; i++) {
    const candidate = ranges[i];
    if (ownerBounds && candidate.from > ownerBounds.end) break;
    if ((!ownerBounds || candidate.to <= ownerBounds.end) && deepestSourceOwner(block, candidate, content, sharedIndex) === owner && isDirectVisibleMatch(owner, content, candidate, sharedIndex)) ordinal++;
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

function resolveSourceHighlightRangeWithIndex(host: Element, content: string, ranges: SourceRange[], activeIndex: number, query: string, options: SearchMatchConfig, index: SourceRangeIndex, knownBlock?: HTMLElement | null): Range | null {
  const target = ranges[activeIndex];
  if (!target) return null;
  const block = knownBlock !== undefined ? knownBlock : findContainingBlockInIndex(index, target);
  return block ? mapSourceRangeToDomRange(block, content, ranges, activeIndex, query, options, index) : mapFrontmatterSourceRangeToDomRange(host, content, ranges, activeIndex, query, options);
}

export function mapDomRangeToSourceIndex(host: Element, content: string, ranges: SourceRange[], domRange: Range, query: string, options: SearchMatchConfig = false, sharedIndex?: SourceRangeIndex): number {
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
  const index = sharedIndex ?? getSourceRangeIndex(host, content);
  const owner = common?.closest<HTMLElement>("[data-source-start],.code-container");
  if (owner) {
    const ordinal = directOwnerDomRanges(owner, query, options).findIndex(r => sameDomRange(r, domRange));
    if (ordinal >= 0) {
      const ownerBounds = sourceBoundsForElement(owner, content, index);
      let seen = 0;
      for (let i = ownerBounds ? firstSourceRangeFrom(ranges, ownerBounds.start) : 0; i < ranges.length; i++) {
        const candidate = ranges[i];
        if (ownerBounds && candidate.from > ownerBounds.end) break;
        if (ownerBounds && candidate.to > ownerBounds.end) continue;
        const block = findContainingBlockInIndex(index, candidate);
        if (block && deepestSourceOwner(block, candidate, content, index) === owner && isDirectVisibleMatch(owner, content, candidate, index)) {
          if (seen++ === ordinal) return i;
        }
      }
    }
  }
  const scopeBlock = common?.closest<HTMLElement>(SOURCE_CANDIDATE_SELECTOR);
  const scopeBounds = scopeBlock ? sourceBoundsForElement(scopeBlock, content, index) : null;
  for (let i = scopeBounds ? firstSourceRangeFrom(ranges, scopeBounds.start) : 0; i < ranges.length; i++) {
    const candidate = ranges[i];
    if (scopeBounds && candidate.from > scopeBounds.end) break;
    const resolved = resolveSourceHighlightRangeWithIndex(host, content, ranges, i, query, options, index);
    if (resolved && sameDomRange(resolved, domRange)) return i;
  }
  return -1;
}

export function resolveSourceHighlightRange(host: Element, content: string, ranges: SourceRange[], activeIndex: number, query: string, options: SearchMatchConfig = false, knownBlock?: HTMLElement | null): Range | null {
  const target = ranges[activeIndex];
  if (!target) return null;
  const index = getSourceRangeIndex(host, content);
  const { root, version } = getSearchDomVersion(host), key = searchOptionKey(query, options), cached = sourceHighlightCache.get(host);
  if (
    cached && cached.root === root && cached.version === version && cached.indexVersion === index.buildVersion &&
    cached.connected === host.isConnected && cached.content === content && cached.ranges === ranges &&
    cached.activeIndex === activeIndex && cached.key === key && cached.knownBlock === knownBlock &&
    (!cached.range || isLiveMatchRange(cached.range, host))
  ) return cached.range;
  const range = resolveSourceHighlightRangeWithIndex(host, content, ranges, activeIndex, query, options, index, knownBlock);
  if (!Number.isNaN(version)) sourceHighlightCache.set(host, { root, version, indexVersion: index.buildVersion, connected: host.isConnected, content, ranges, activeIndex, key, knownBlock, range });
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

export function areWindowedMatchesLive(items: WindowedMatch[], host: Element): boolean {
  let checkedEl: HTMLElement | null = null, checkedParent: Element | null = null;
  for (let i = 0; i < items.length; i++) {
    const el = items[i].element;
    if (el === checkedEl) continue;
    checkedEl = el;
    if (!el.isConnected) return false;
    const parent = el.parentElement;
    if (parent && parent === checkedParent) continue;
    if (!host.contains(el)) return false;
    checkedParent = parent;
  }
  return true;
}

function visibleBlockSourceIndices(block: HTMLElement, content: string, sourceRanges: SourceRange[], endIndex = sourceRanges.length, sharedIndex?: SourceRangeIndex): number[] {
  const bounds = sourceBoundsForElement(block, content, sharedIndex);
  if (!bounds) return [];
  const indices: number[] = [], limit = Math.min(endIndex, sourceRanges.length);
  for (let i = firstSourceRangeFrom(sourceRanges, bounds.start, limit); i < limit; i++) {
    const sr = sourceRanges[i];
    if (sr.from > bounds.end) break;
    if (sr.to > bounds.end) continue;
    const owner = deepestSourceOwner(block, sr, content, sharedIndex) ?? block;
    if (isDirectVisibleMatch(owner, content, sr, sharedIndex)) indices.push(i);
  }
  return indices;
}

export function insertDomRangeInOrder(ranges: Range[], target: Range): { ranges: Range[]; index: number } {
  let index = ranges.findIndex(m => sameDomRange(m, target));
  if (index >= 0) return { ranges, index };
  const augmented = [...ranges], pos = augmented.findIndex(m => m.compareBoundaryPoints(Range.START_TO_START, target) > 0);
  index = pos < 0 ? augmented.length : pos;
  augmented.splice(index, 0, target);
  return { ranges: augmented, index };
}

function findWindowedDomMatch(liveWindowed: WindowedMatch[], domRange: Range, query: string, options: SearchMatchConfig, scope?: Element): number {
  const targetWindowEl = scope?.closest<HTMLElement>("[data-windowed-block]") ?? null;
  let cachedEl: Element | null = null, cachedRanges: Range[] = [], checkedOverlapEl: Element | null = null, checkedOverlaps = false;
  for (let i = 0; i < liveWindowed.length; i++) {
    const w = liveWindowed[i];
    let overlaps: boolean;
    if (targetWindowEl) overlaps = w.element === targetWindowEl;
    else if (!scope) overlaps = w.element.contains(domRange.startContainer);
    else if (w.element === checkedOverlapEl) overlaps = checkedOverlaps;
    else { checkedOverlapEl = w.element; overlaps = checkedOverlaps = w.element === scope || w.element.contains(scope) || scope.contains(w.element); }
    if (!overlaps) continue;
    if (cachedEl !== w.element) { cachedEl = w.element; cachedRanges = readingMatches(w.element, query, options); }
    if (cachedRanges[w.ordinal] && sameDomRange(cachedRanges[w.ordinal], domRange)) return i;
  }
  return -1;
}

export function translateSourceIndexToRendered(host: Element | null, content: string, sourceRanges: SourceRange[], sourceIdx: number, query: string, options: SearchMatchConfig = false, knownWindowed?: WindowedMatch[] | null, knownMatches?: Range[]): number {
  const sr = sourceIdx >= 0 && host ? sourceRanges[sourceIdx] : undefined;
  if (!sr || !host) return -1;
  const index = getSourceRangeIndex(host, content);
  const block = findContainingBlockInIndex(index, sr), liveWindowed = knownWindowed !== undefined ? knownWindowed : windowedMatches(host, query, options);
  if (!block) {
    const fmResolved = mapFrontmatterSourceRangeToDomRange(host, content, sourceRanges, sourceIdx, query, options);
    if (!fmResolved) return -1;
    return liveWindowed ? findWindowedDomMatch(liveWindowed, fmResolved, query, options) : (knownMatches !== undefined ? knownMatches : readingMatches(host, query, options)).findIndex(m => sameDomRange(m, fmResolved));
  }
  if (liveWindowed) {
    if (!liveWindowed.length) return -1;
    const wBlock = block.closest<HTMLElement>("[data-windowed-block]") ?? block;
    if (!block.closest('[data-windowed-mounted="false"]')) {
      const resolved = mapSourceRangeToDomRange(block, content, sourceRanges, sourceIdx, query, options, index);
      if (resolved) {
        const mountedIdx = findWindowedDomMatch(liveWindowed, resolved, query, options, block);
        if (mountedIdx >= 0) return mountedIdx;
      }
    }
    const owner = deepestSourceOwner(block, sr, content, index) ?? block;
    if (!isDirectVisibleMatch(owner, content, sr, index)) return -1;
    const targetOrdinal = visibleBlockSourceIndices(wBlock, content, sourceRanges, sourceIdx, index).length;
    const exactIdx = liveWindowed.findIndex(w => w.element === wBlock && w.ordinal === targetOrdinal);
    return exactIdx >= 0 ? exactIdx : liveWindowed.findIndex(w => { const wb = sourceBoundsForElement(w.element, content, index); return wb !== null && sr.from >= wb.start && sr.to <= wb.end && w.ordinal === targetOrdinal; });
  }
  const liveMatches = knownMatches !== undefined ? knownMatches : readingMatches(host, query, options);
  if (!liveMatches.length) return -1;
  const resolved = mapSourceRangeToDomRange(block, content, sourceRanges, sourceIdx, query, options, index);
  return resolved ? liveMatches.findIndex(m => sameDomRange(m, resolved)) : -1;
}

export function translateRenderedIndexToSource(host: Element | null, content: string, sourceRanges: SourceRange[], renderedIdx: number, query: string, options: SearchMatchConfig = false, cachedWindowed?: WindowedMatch[] | null, cachedMatches?: Range[]): number {
  if (renderedIdx < 0 || !sourceRanges.length || !host) return -1;
  const index = getSourceRangeIndex(host, content);
  const liveWindowed = cachedWindowed && areWindowedMatchesLive(cachedWindowed, host) ? cachedWindowed : windowedMatches(host, query, options);
  if (liveWindowed) {
    const active = liveWindowed[renderedIdx];
    if (!active) return -1;
    if (active.element.closest('[data-windowed-mounted="false"]')) return visibleBlockSourceIndices(active.element, content, sourceRanges, undefined, index)[active.ordinal] ?? -1;
    const domRange = readingMatches(active.element, query, options)[active.ordinal];
    const mapped = domRange ? mapDomRangeToSourceIndex(host, content, sourceRanges, domRange, query, options, index) : -1;
    return mapped >= 0 ? mapped : (visibleBlockSourceIndices(active.element, content, sourceRanges, undefined, index)[active.ordinal] ?? -1);
  }
  const cachedDom = cachedMatches?.[renderedIdx];
  const liveDomRange = cachedDom && cachedDom.startContainer.nodeType === Node.TEXT_NODE && host.contains(cachedDom.startContainer) ? cachedDom : readingMatches(host, query, options)[renderedIdx];
  return liveDomRange ? mapDomRangeToSourceIndex(host, content, sourceRanges, liveDomRange, query, options, index) : -1;
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
