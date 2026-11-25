import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { setReaderOverlay } from "../readerOverlays";
import { ArrowUpIcon, ArrowDownIcon, XIcon, TextAaIcon, TextboxIcon, AsteriskIcon, ArrowsClockwiseIcon } from "@phosphor-icons/react";
import { editorFindQuery, editorFindRange } from "./Editor";
import { windowedMatches, revealWindowed, compileSearchPattern, nextSearchMatch, normalizeSearchOptions, type WindowedMatch, type SearchMatchConfig, type SearchMatchOptions } from "../windowedSearch";
import { cancelHeadingNavigation } from "../documentNavigation";
import { refreshDocumentExtent } from "../documentZoom";
export type { SearchMatchConfig, SearchMatchOptions } from "../windowedSearch";

const cancelSettlingHeading = () => document.querySelectorAll(".android-reading,.reading-scroll,.live-pane").forEach(cancelHeadingNavigation);
const findReadingHost = () => document.querySelector<HTMLElement>(".android-reading,.reading-scroll,.live-document,.markdown-body");
type HighlightRegistry = Map<string, unknown>;
type SourceRange = { from: number; to: number };

export function nextSearchIndex(index: number, direction: number, count: number): number {
  if (count <= 0) return -1;
  if (index < 0) return direction < 0 ? count - 1 : 0;
  return ((index + direction) % count + count) % count;
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

export function readingMatches(host: Element, query: string, options: SearchMatchConfig = false): Range[] {
  const { pattern } = compileSearchPattern(query, options, false);
  if (!pattern) return [];
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  const parts: Array<{ node: Text; start: number; end: number }> = [];
  let text = "", node: Node | null, block: Element | null = null;
  while ((node = walker.nextNode())) {
    const parent = node.parentElement;
    if (!parent || parent.closest("button,input,textarea,svg,annotation,.katex-mathml,.chart-controls,.chart-toolbar,.chart-legend,.image-edit-tools,.image-loading,.image-error,.remote-image-card,[data-frontmatter-properties],.document-properties")) continue;
    const nextBlock = parent.closest("p,h1,h2,h3,h4,li,pre,td,summary");
    if (block !== nextBlock) { text += "\n"; block = nextBlock; }
    const value = node.textContent || "";
    parts.push({ node: node as Text, start: text.length, end: text.length + value.length }); text += value;
  }
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
    const range = document.createRange(); range.setStart(first.node, Math.max(0, start - first.start)); range.setEnd(last.node, end - last.start); ranges.push(range);
  }
  return ranges;
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

function markdownBracketEnd(raw: string, openIndex = 0): number {
  if (raw[openIndex] !== "[") return raw.length;
  let depth = 0;
  for (let i = openIndex; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "\\") { i++; continue; }
    if (ch === "`") {
      let ticks = 1; while (raw[i + ticks] === "`") ticks++;
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

function hiddenSpansInSlice(raw: string, offset: number): Array<{ start: number; end: number }> {
  const hidden: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "\\") { i++; continue; }
    if (ch === "`") {
      let ticks = 1; while (raw[i + ticks] === "`") ticks++;
      const close = raw.indexOf("`".repeat(ticks), i + ticks);
      if (close >= 0) { i = close + ticks - 1; continue; }
    }
    if (ch === "!" && raw[i + 1] === "[") {
      const close = markdownBracketEnd(raw, i + 1);
      if (close < raw.length) {
        const end = markdownLinkTailEnd(raw, close + 1);
        hidden.push({ start: offset + i, end: offset + end });
        i = Math.max(i, end - 1);
        continue;
      }
    }
    if (ch === "[") {
      const close = markdownBracketEnd(raw, i);
      if (close < raw.length) {
        const end = markdownLinkTailEnd(raw, close + 1);
        if (end > close + 1) {
          hidden.push({ start: offset + close, end: offset + end });
          i = Math.max(i, end - 1);
        }
      }
    }
  }
  return hidden;
}

function sourceBounds(element: Element): { start: number; end: number } | null {
  if (element.tagName === "TEXTAREA") return null;
  const start = Number(element.getAttribute("data-source-start")), end = Number(element.getAttribute("data-source-end"));
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? { start, end } : null;
}

function visibleSourceSpan(owner: HTMLElement, content: string): { start: number; end: number } | null {
  const bounds = sourceBounds(owner); if (!bounds) return null;
  let { start, end } = bounds;
  if (owner.tagName === "A" && content[start] === "[") {
    const close = markdownBracketEnd(content.slice(start, end), 0);
    if (close < end - start) return { start: start + 1, end: start + close };
  }
  if (owner.matches("details.callout,aside.callout")) {
    const marker = content.slice(start, end).match(/^\s*(?:>[ \t]*)?\[![\w-]+\][+-]?[ \t]*/i);
    if (marker) start += marker[0].length;
  }
  if (owner.matches(".code-container,.python-cell")) {
    const raw = content.slice(start, end);
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
  return { start, end };
}

function findContainingBlock(host: Element, from: number, to: number): HTMLElement | null {
  const candidates = host.querySelectorAll<HTMLElement>(".live-block[data-source-start],[data-windowed-block][data-source-start]");
  let best: HTMLElement | null = null, fallback: HTMLElement | null = null;
  const scan = (nodes: Iterable<HTMLElement>) => {
    for (const node of nodes) {
      const bounds = sourceBounds(node); if (!bounds) continue;
      if (bounds.start <= from && to <= bounds.end) { if (!best || bounds.end - bounds.start < sourceBounds(best)!.end - sourceBounds(best)!.start) best = node; }
      else if (bounds.start <= from && from < bounds.end) fallback = node;
    }
  };
  scan(candidates);
  if (!best && !fallback) scan(host.querySelectorAll<HTMLElement>("[data-source-start][data-source-end]"));
  return best || fallback;
}

function openDisclosuresFor(target: Element | null, scope?: Element | null, range?: SourceRange): boolean {
  let opened = false;
  for (let owner = target?.closest("details") || null; owner; owner = owner.parentElement?.closest("details") || null) {
    if (!owner.open) { owner.open = true; opened = true; }
  }
  if (scope && range) {
    for (const details of scope.querySelectorAll<HTMLDetailsElement>("details")) {
      if (details.open) continue;
      const bounds = sourceBounds(details.closest("[data-source-start]") || details);
      if (!bounds || (bounds.start <= range.from && range.from <= bounds.end)) { details.open = true; opened = true; }
    }
  }
  return opened;
}

function deepestSourceOwner(root: Element, from: number, to: number): HTMLElement | null {
  let best: HTMLElement | null = sourceBounds(root) ? root as HTMLElement : null;
  for (const node of root.querySelectorAll<HTMLElement>("[data-source-start][data-source-end]")) {
    const bounds = sourceBounds(node); if (!bounds) continue;
    if (bounds.start <= from && to <= bounds.end) {
      if (!best || best.contains(node) || bounds.end - bounds.start <= sourceBounds(best)!.end - sourceBounds(best)!.start) best = node;
    }
  }
  return best;
}

function sameRange(a: Range, b: Range): boolean {
  return a.startContainer === b.startContainer && a.startOffset === b.startOffset && a.endContainer === b.endContainer && a.endOffset === b.endOffset;
}

function directOwnerMatches(owner: HTMLElement, visible: { start: number; end: number }, allSourceRanges: SourceRange[], content: string, query: string, options: SearchMatchConfig): { directSource: SourceRange[]; directDom: Range[] } {
  const excludedSpans = Array.from(owner.querySelectorAll<HTMLElement>("[data-source-start][data-source-end]")).map(sourceBounds).filter((item): item is { start: number; end: number } => item !== null);
  if (!owner.closest("pre,code,.code-container,.python-cell") && visible.end - visible.start <= 200_000) {
    excludedSpans.push(...hiddenSpansInSlice(content.slice(visible.start, visible.end), visible.start));
  }
  const directSource = allSourceRanges.filter(item => item.from >= visible.start && item.to <= visible.end && !excludedSpans.some(span => span.start <= item.from && item.to <= span.end));
  const directDom = readingMatches(owner, query, options).filter(candidate => {
    if (owner.matches(".code-container,.python-cell") && candidate.startContainer.parentElement?.closest("summary")) return false;
    const candidateOwner = candidate.startContainer.parentElement?.closest<HTMLElement>("[data-source-start][data-source-end]");
    return !candidateOwner || candidateOwner === owner || !owner.contains(candidateOwner);
  });
  return { directSource, directDom };
}

function mapSourceRangeToDomRange(scope: HTMLElement, target: SourceRange, allSourceRanges: SourceRange[], content: string, query: string, options: SearchMatchConfig = false): Range | null {
  if (scope.closest('[data-windowed-mounted="false"]')) return null;
  const owner = deepestSourceOwner(scope, target.from, target.to); if (!owner) return null;
  const visible = visibleSourceSpan(owner, content);
  if (!visible || target.from < visible.start || target.to > visible.end) return null;
  const { directSource, directDom } = directOwnerMatches(owner, visible, allSourceRanges, content, query, options);
  const ordinal = directSource.findIndex(item => item.from === target.from && item.to === target.to);
  return ordinal >= 0 ? directDom[ordinal] ?? null : null;
}

function mapDomRangeToSourceIndex(range: Range, allSourceRanges: SourceRange[], content: string, query: string, options: SearchMatchConfig = false): number {
  const owner = range.startContainer.parentElement?.closest<HTMLElement>("[data-source-start][data-source-end]");
  if (!owner) return -1;
  const visible = visibleSourceSpan(owner, content); if (!visible) return -1;
  const { directSource, directDom } = directOwnerMatches(owner, visible, allSourceRanges, content, query, options);
  const ordinal = directDom.findIndex(candidate => sameRange(candidate, range));
  const target = ordinal >= 0 ? directSource[ordinal] : undefined;
  return target ? allSourceRanges.findIndex(item => item.from === target.from && item.to === target.to) : -1;
}

export function resolveSourceHighlightRange(host: Element, content: string, ranges: SourceRange[], activeIndex: number, query: string, options: SearchMatchConfig = false): Range | null {
  const target = ranges[activeIndex]; if (!target) return null;
  const block = findContainingBlock(host, target.from, target.to); if (!block) return null;
  return mapSourceRangeToDomRange(block, target, ranges, content, query, options);
}

function revealMountedBlock(element: HTMLElement): void {
  if (element.closest('[data-windowed-mounted="false"]')) flushSync(() => revealWindowed(element));
  else revealWindowed(element);
}

export interface ReadingSearchSeed {
  query: string;
  caseSensitive?: boolean;
  nonce: number;
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
  const pendingReplaceIndex = useRef<number | null>(null);
  if (seed && appliedNonce !== seed.nonce) {
    setAppliedNonce(seed.nonce);
    pendingAutoSelect.current = Boolean(seed.query);
    pendingReplaceIndex.current = null;
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
  const current = useRef({ matches, index, sourceRanges, windowed }); current.current = { matches, index, sourceRanges, windowed };
  const closeRef = useRef(close); closeRef.current = close;
  const registry = typeof CSS === "undefined" ? undefined : (CSS as typeof CSS & { highlights?: HighlightRegistry }).highlights;
  const HighlightClass = (window as typeof window & { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;

  const connectedWindowed = (host: HTMLElement | null): WindowedMatch[] | null => {
    if (!host || regexError) return null;
    if (windowed && windowed.every(item => item.element.isConnected && host.contains(item.element))) return windowed;
    return windowedMatches(host, query, filterOptions);
  };

  const mapSourceToRenderedIndex = (sourceIdx: number, host: HTMLElement | null): number => {
    const sourceTarget = sourceRanges[sourceIdx];
    const block = host && sourceTarget ? findContainingBlock(host, sourceTarget.from, sourceTarget.to) : null;
    if (!host || !block || !sourceTarget) return -1;
    revealMountedBlock(block);
    const mapped = mapSourceRangeToDomRange(block, sourceTarget, sourceRanges, content, query, filterOptions);
    if (!mapped) return -1;
    const liveWindowed = connectedWindowed(host);
    if (liveWindowed !== windowed) setWindowed(liveWindowed);
    if (liveWindowed) {
      const windowedElement = block.closest<HTMLElement>("[data-windowed-block]") ?? block;
      const blockRanges = readingMatches(windowedElement, query, filterOptions);
      const ordinal = blockRanges.findIndex(candidate => sameRange(candidate, mapped));
      return ordinal >= 0 ? liveWindowed.findIndex(item => item.element === windowedElement && item.ordinal === ordinal) : -1;
    }
    const fresh = readingMatches(host, query, filterOptions);
    setMatches(fresh);
    return fresh.findIndex(candidate => sameRange(candidate, mapped));
  };

  useEffect(() => {
    if (!canReplace && replacing) {
      if (!sourceSession && indexRef.current >= 0) updateIndex(mapSourceToRenderedIndex(indexRef.current, findReadingHost()));
      setReplacing(false);
    }
    const frame = requestAnimationFrame(() => {
      const host = findReadingHost();
      const win = host && !regexError ? windowedMatches(host, query, filterOptions) : null;
      const result = host && !regexError ? readingMatches(host, query, filterOptions) : [];
      setWindowed(win);
      setMatches(result);
    });
    return () => cancelAnimationFrame(frame);
  }, [canReplace, replacing]);

  const syncHighlights = (host: Element | null, activeRange?: Range | null) => {
    if (!registry || !HighlightClass) return;
    const all = host && !regexError ? readingMatches(host, query, filterOptions) : [];
    registry.set("smd-search", new HighlightClass(...all));
    registry.delete("smd-search-current");
    if (activeRange && !regexError) registry.set("smd-search-current", new HighlightClass(activeRange));
  };

  const activeDomRangeFor = (targetIndex: number, host: Element | null): Range | null => {
    if (targetIndex < 0 || !host || regexError) return null;
    if (!sourceSession && activeReplacing) {
      const target = sourceRanges[targetIndex]; if (!target) return null;
      const block = findContainingBlock(host, target.from, target.to);
      if (!block || block.closest('[data-windowed-mounted="false"]')) return null;
      return mapSourceRangeToDomRange(block, target, sourceRanges, content, query, filterOptions);
    }
    if (windowed) {
      const match = windowed[targetIndex];
      if (!match || match.element.closest('[data-windowed-mounted="false"]')) return null;
      return readingMatches(match.element, query, filterOptions)[match.ordinal] ?? null;
    }
    return matches[targetIndex] ?? null;
  };

  const scrollTargetIntoView = (host: Element | null, range: Range | null, fallback: HTMLElement | null) => {
    const scroller = host?.closest<HTMLElement>(".android-reading") ?? (host?.matches(".android-reading") ? host as HTMLElement : null);
    if (scroller) refreshDocumentExtent(scroller);
    const target = range ? (range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer as HTMLElement : range.startContainer.parentElement) : fallback;
    (target ?? fallback)?.scrollIntoView?.({ block: "center", behavior: "instant" });
  };

  const selectSourceRange = (next: number, ranges: SourceRange[], host: HTMLElement | null) => {
    const range = ranges[next]; if (!range) return;
    if (sourceSession) { editorFindRange(sourceSession, range.from, range.to); updateIndex(next); return; }
    const block = host ? findContainingBlock(host, range.from, range.to) : null;
    if (block) revealMountedBlock(block);
    let domRange = block ? mapSourceRangeToDomRange(block, range, ranges, content, query, filterOptions) : null;
    const opened = openDisclosuresFor(domRange?.startContainer.parentElement ?? block, block, range);
    if (opened && block) domRange = mapSourceRangeToDomRange(block, range, ranges, content, query, filterOptions);
    const frontmatterHeader = !block ? host?.querySelector<HTMLElement>("[data-frontmatter-properties],.document-properties") ?? null : null;
    const fallback = (block ? deepestSourceOwner(block, range.from, range.to) : frontmatterHeader) ?? block;
    scrollTargetIntoView(host, domRange, fallback);
    syncHighlights(host, domRange);
    updateIndex(next);
    requestAnimationFrame(() => {
      if (indexRef.current !== next) return;
      const liveHost = findReadingHost();
      const liveBlock = liveHost ? findContainingBlock(liveHost, range.from, range.to) : null;
      const liveRange = liveBlock ? mapSourceRangeToDomRange(liveBlock, range, ranges, content, query, filterOptions) : null;
      const liveFallback = liveBlock ?? liveHost?.querySelector<HTMLElement>("[data-frontmatter-properties],.document-properties") ?? null;
      scrollTargetIntoView(liveHost, liveRange, liveFallback);
      syncHighlights(liveHost, liveRange);
    });
  };

  const selectWindowedMatch = (next: number, win: WindowedMatch[], host: HTMLElement | null) => {
    const match = win[next]; if (!match) return;
    revealMountedBlock(match.element);
    let range = readingMatches(match.element, query, filterOptions)[match.ordinal] ?? null;
    if (openDisclosuresFor(range?.startContainer.parentElement ?? match.element, match.element)) range = readingMatches(match.element, query, filterOptions)[match.ordinal] ?? null;
    scrollTargetIntoView(host, range, match.element);
    syncHighlights(host, range);
    updateIndex(next);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (indexRef.current !== next) return;
      const liveHost = findReadingHost();
      const liveRange = readingMatches(match.element, query, filterOptions)[match.ordinal] ?? null;
      openDisclosuresFor(liveRange?.startContainer.parentElement ?? match.element, match.element);
      scrollTargetIntoView(liveHost, liveRange, match.element);
      syncHighlights(liveHost, liveRange);
    }));
  };

  const selectDomMatch = (next: number, list: Range[], host: HTMLElement | null) => {
    const range = list[next]; if (!range) return;
    openDisclosuresFor(range.startContainer.parentElement);
    scrollTargetIntoView(host, range, range.startContainer.parentElement);
    syncHighlights(host, range);
    updateIndex(next);
  };

  const toggleReplacing = (requested?: boolean) => {
    const nextReplacing = typeof requested === "boolean" ? requested : !activeReplacing;
    if (!canReplaceRef.current || nextReplacing === activeReplacing) return;
    const host = findReadingHost();
    const activeIdx = indexRef.current;
    if (!sourceSession && activeIdx >= 0 && host) {
      if (nextReplacing) {
        let currentRange: Range | null = null;
        const liveWindowed = connectedWindowed(host);
        if (liveWindowed !== windowed) setWindowed(liveWindowed);
        if (liveWindowed) {
          const item = liveWindowed[activeIdx];
          if (item) { revealMountedBlock(item.element); currentRange = readingMatches(item.element, query, filterOptions)[item.ordinal] ?? null; }
        } else {
          const candidate = matches[activeIdx];
          currentRange = candidate && host.contains(candidate.startContainer) ? candidate : readingMatches(host, query, filterOptions)[activeIdx] ?? null;
        }
        updateIndex(currentRange ? mapDomRangeToSourceIndex(currentRange, sourceRanges, content, query, filterOptions) : -1);
      } else {
        updateIndex(mapSourceToRenderedIndex(activeIdx, host));
      }
    }
    setReplacing(nextReplacing);
  };
  const toggleReplacingRef = useRef(toggleReplacing); toggleReplacingRef.current = toggleReplacing;

  const move = (direction: number) => {
    // Search is a new deliberate navigation, just like pan/zoom. A briefly
    // observing heading jump must not pull the viewport back after this move.
    cancelSettlingHeading();
    if (regexError) return;
    const activeIdx = indexRef.current;
    const { matches, sourceRanges, windowed } = current.current;
    const host = findReadingHost();
    if (sourceSearch) {
      const ranges = sourceRanges.length || !query ? sourceRanges : sourceMatches(content, query, filterOptions);
      if (!ranges.length) return;
      selectSourceRange(nextSearchIndex(activeIdx, direction, ranges.length), ranges, host);
      return;
    }
    const win = windowed ?? (host ? windowedMatches(host, query, filterOptions) : null);
    if (win) {
      if (!win.length) return;
      selectWindowedMatch(nextSearchIndex(activeIdx, direction, win.length), win, host);
      return;
    }
    const domMatches = matches.length || !host ? matches : readingMatches(host, query, filterOptions);
    if (!domMatches.length) return;
    selectDomMatch(nextSearchIndex(activeIdx, direction, domMatches.length), domMatches, host);
  };
  const moveRef = useRef(move); moveRef.current = move;

  const handleSingleReplace = () => {
    if (!canReplace || !onChange || !query || regexError || !sourceRanges.length || index < 0) return;
    const target = sourceRanges[index]; if (!target) return;
    const nextContent = replaceSourceMatches(content, query, replacement, filterOptions, index);
    const replacedEnd = target.to + (nextContent.length - content.length);
    const nextRanges = sourceMatches(nextContent, query, filterOptions);
    const nextIndex = !nextRanges.length ? -1 : (() => { const found = nextRanges.findIndex(item => item.from >= replacedEnd); return found >= 0 ? found : 0; })();
    if (nextContent === content) {
      if (nextIndex >= 0) selectSourceRange(nextIndex, nextRanges, findReadingHost());
      else updateIndex(-1);
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

  useEffect(() => {
    cancelSettlingHeading();
    setReaderOverlay("search", true);
    const focus = (event?: Event) => {
      const detail = (event as CustomEvent<{ replace?: boolean }> | undefined)?.detail;
      if (detail?.replace && canReplaceRef.current) toggleReplacingRef.current(true);
      let attempts = 0;
      const focusInput = () => {
        const field = input.current;
        if (field) { field.focus({ preventScroll: true }); field.select(); }
        // Native menus/toolbars can retain host focus while React mounts this
        // overlay. Reassert focus across the mount frames so the very next key
        // reaches the search field, including when Find is opened repeatedly.
        if (document.activeElement !== field && attempts++ < 4) requestAnimationFrame(focusInput);
      };
      focusInput();
    };
    const step = (event: Event) => {
      const direction = (event as CustomEvent<number>).detail;
      moveRef.current(direction < 0 ? -1 : 1);
    };
    focus();
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (document.querySelector(".media-save-menu,.image-viewer,.math-repair-panel,.media-dialog,.theme-guide-dialog")) return;
      event.preventDefault(); event.stopImmediatePropagation(); closeRef.current();
    };
    document.addEventListener("keydown", key, true);
    window.addEventListener("supermd-find-focus", focus);
    window.addEventListener("supermd-find-step", step);
    return () => {
      setReaderOverlay("search", false);
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("supermd-find-focus", focus);
      window.removeEventListener("supermd-find-step", step);
    };
  }, []);

  useEffect(() => {
    const sources = regexError ? [] : sourceMatches(content, query, filterOptions);
    setSourceRanges(sources);
    if (sourceSession) editorFindQuery(sourceSession, regexError ? "" : query, caseSensitive, { wholeWord, regexp });
    const autoSelect = pendingAutoSelect.current;
    pendingAutoSelect.current = false;
    const replaceNext = pendingReplaceIndex.current;
    pendingReplaceIndex.current = null;
    if (replaceNext !== null && !regexError) {
      updateIndex(replaceNext);
    } else if (!autoSelect || regexError) {
      updateIndex(-1);
    }
    const frame = requestAnimationFrame(() => {
      const host = findReadingHost();
      const win = host && !regexError ? windowedMatches(host, query, filterOptions) : null;
      setWindowed(win);
      const result = host && !regexError ? readingMatches(host, query, filterOptions) : [];
      setMatches(result);
      if (replaceNext !== null && !regexError) {
        if (replaceNext >= 0 && sources[replaceNext]) { selectSourceRange(replaceNext, sources, host); return; }
        syncHighlights(host, null);
        return;
      }
      if (autoSelect && !regexError) {
        if (sourceSearchRef.current && sources.length) { selectSourceRange(0, sources, host); return; }
        if (win && win.length) { selectWindowedMatch(0, win, host); return; }
        if (result.length) { selectDomMatch(0, result, host); return; }
        updateIndex(-1);
      }
      if (indexRef.current < 0 || regexError) {
        if (registry && HighlightClass) {
          registry.set("smd-search", new HighlightClass(...result));
          registry.delete("smd-search-current");
        }
      } else if (registry && HighlightClass) {
        const activeRange = !sourceSession && sourceSearchRef.current
          ? (sources[indexRef.current] ? resolveSourceHighlightRange(host!, content, sources, indexRef.current, query, filterOptions) : null)
          : win ? (win[indexRef.current] && !win[indexRef.current].element.closest('[data-windowed-mounted="false"]') ? readingMatches(win[indexRef.current].element, query, filterOptions)[win[indexRef.current].ordinal] ?? null : null)
          : result[indexRef.current] ?? null;
        registry.set("smd-search", new HighlightClass(...result));
        registry.delete("smd-search-current");
        if (activeRange) registry.set("smd-search-current", new HighlightClass(activeRange));
      }
    });
    return () => {
      cancelAnimationFrame(frame);
      registry?.delete("smd-search");
      registry?.delete("smd-search-current");
      if (sourceSession) editorFindQuery(sourceSession, "", false);
    };
  }, [query, content, caseSensitive, wholeWord, regexp, sourceSession, seed?.nonce]);

  useEffect(() => {
    if (!registry || !HighlightClass) return;
    const host = findReadingHost();
    syncHighlights(host, activeDomRangeFor(index, host));
  }, [index, matches, windowed, activeReplacing, sourceSession]);

  useEffect(() => {
    const host = findReadingHost(); if (!host || (!windowed && !activeReplacing) || !query || regexError) return;
    let frame = 0;
    const refresh = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        syncHighlights(host, activeDomRangeFor(indexRef.current, host));
      });
    };
    host.addEventListener("supermd-window-change", refresh);
    return () => { cancelAnimationFrame(frame); host.removeEventListener("supermd-window-change", refresh); };
  }, [windowed, activeReplacing, query, caseSensitive, wholeWord, regexp, regexError, sourceRanges, content]);

  return <aside className="reading-search" data-independent-zoom role="search" aria-label="Find in note">
    <input ref={input} aria-label="Find in note" aria-invalid={!!regexError || undefined} role="searchbox" type="text" inputMode="search" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="Find in this note" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); move(event.shiftKey ? -1 : 1); } }} />
    <output aria-live="polite" className={regexError ? "search-error" : undefined} title={regexError ? regexError : count >= 5000 ? "Showing the first 5,000 matches. Narrow your search to find later results." : undefined}>{regexError ? regexError : count ? `${index < 0 ? 0 : index + 1} / ${count}${count >= 5000 ? "+" : ""}` : query ? "No matches" : ""}</output>
    <button className="search-icon" aria-label="Previous match" disabled={!count} onClick={() => move(-1)} title="Previous match (Shift+Enter / Shift+F3)"><ArrowUpIcon size={20} weight="bold" /></button>
    <button className="search-icon" aria-label="Next match" disabled={!count} onClick={() => move(1)} title="Next match (Enter / F3)"><ArrowDownIcon size={20} weight="bold" /></button>
    <button className="search-icon" aria-pressed={caseSensitive} onClick={() => setCaseSensitive(!caseSensitive)} title="Match case" aria-label="Match case"><TextAaIcon size={20} weight="bold" /></button>
    <button className="search-icon" aria-pressed={wholeWord} onClick={() => setWholeWord(!wholeWord)} title="Match whole word" aria-label="Match whole word"><TextboxIcon size={20} weight="bold" /></button>
    <button className="search-icon" aria-pressed={regexp} onClick={() => setRegexp(!regexp)} title="Regular expression" aria-label="Regular expression"><AsteriskIcon size={20} weight="bold" /></button>
    {canReplace && <button className="search-icon" aria-pressed={activeReplacing} onClick={() => toggleReplacing()} title="Replace in source (Ctrl+H)" aria-label="Replace in source"><ArrowsClockwiseIcon size={20} weight="bold" /></button>}
    <button className="search-icon" onClick={close} title="Close search (Esc)" aria-label="Close search"><XIcon size={20} weight="bold" /></button>
    {activeReplacing && onChange && <div className="search-replace"><input aria-label="Replacement text" placeholder="Replace with" value={replacement} onChange={e => setReplacement(e.target.value)} /><button disabled={!query || !!regexError || !count || index < 0} onClick={handleSingleReplace}>Replace</button><button disabled={!query || !!regexError || !count} onClick={handleReplaceAll}>Replace all</button><small>{regexError ? `${regexError}.` : regexp ? "Replaces regex matches in Markdown source ($1, $&, $$ supported)." : "Replaces literal text in Markdown source."}</small></div>}
  </aside>;
}
