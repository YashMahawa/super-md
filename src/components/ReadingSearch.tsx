import { useEffect, useRef, useState } from "react";
import { setReaderOverlay } from "../readerOverlays";
import { ArrowUpIcon, ArrowDownIcon, XIcon, TextAaIcon, TextboxIcon, AsteriskIcon, ArrowsClockwiseIcon } from "@phosphor-icons/react";
import { editorFindQuery, editorFindRange } from "./Editor";
import { windowedMatches, compileSearchPattern, type WindowedMatch, type SearchMatchConfig, type SearchMatchOptions } from "../windowedSearch";
import {
  areWindowedMatchesLive, cancelSettlingHeading, deepestSourceOwner, findContainingBlock, findMatchingSourceRangeIndex, findReadingHost,
  firstSourceRangeFrom, getSearchDomVersion, insertDomRangeInOrder, invalidateSourceRangeIndex, isLiveMatchRange, nextSearchIndex, openDisclosuresFor,
  rangeStartElement, readingMatches, replaceSourceMatches, resolveActiveHighlightRange, resolveSourceBlock, resolveSourceHighlightRange,
  revealMountedBlock, scrollTargetIntoView, sourceMatches, syncSearchHighlights, translateRenderedIndexToSource, translateSourceIndexToRendered, type SourceRange,
} from "../readingSearchDom";
export type { SearchMatchConfig, SearchMatchOptions } from "../readingSearchDom";
export { nextSearchIndex, readingMatches, replaceSourceMatches, resolveSourceBlock, resolveSourceHighlightRange, sourceMatches };

const MANUAL_SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);
const SEARCH_SETTLE_WINDOW_MS = 800;
const UNICODE_SEARCH_FOLDS = new Map<number, string>([
  [0xdf, "ss"], [0x1e9e, "ss"], [0x130, "i\u0307"], [0x149, "\u02bcn"], [0x1f0, "j\u030c"], [0x390, "\u03b9\u0308\u0301"], [0x3b0, "\u03c5\u0308\u0301"], [0x3c2, "\u03c3"],
  [0xb5, "\u03bc"], [0x345, "\u03b9"], [0x587, "\u0565\u0582"], [0x1e96, "h\u0331"], [0x1e97, "t\u0308"], [0x1e98, "w\u030a"], [0x1e99, "y\u030a"], [0x1e9a, "a\u02be"],
  [0xfb00, "ff"], [0xfb01, "fi"], [0xfb02, "fl"], [0xfb03, "ffi"], [0xfb04, "ffl"], [0xfb05, "st"], [0xfb06, "st"], [0xfb13, "\u0574\u0576"], [0xfb14, "\u0574\u0565"], [0xfb15, "\u0574\u056b"], [0xfb16, "\u057e\u0576"], [0xfb17, "\u0574\u056d"],
]);

export interface ReadingSearchSeed { query: string; caseSensitive?: boolean; sourceStart?: number; sourceEnd?: number; matchText?: string; nonce: number }

function extractSeedRange(seed?: ReadingSearchSeed | null): SourceRange | null {
  if (!seed) return null;
  const { sourceStart, sourceEnd } = seed;
  return typeof sourceStart === "number" && typeof sourceEnd === "number" && Number.isInteger(sourceStart) && Number.isInteger(sourceEnd) && sourceStart >= 0 && sourceEnd >= sourceStart ? { from: sourceStart, to: sourceEnd } : null;
}

const extractSeedMatchText = (seed?: ReadingSearchSeed | null): string | undefined => typeof seed?.matchText === "string" && seed.matchText.length > 0 ? seed.matchText : undefined;

export function foldUnicodeForSearch(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; ) { const cp = text.codePointAt(i)!; out += UNICODE_SEARCH_FOLDS.get(cp) ?? String.fromCodePoint(cp).toLowerCase(); i += cp > 0xffff ? 2 : 1; }
  return out;
}

function isSplitUtf16Surrogate(text: string, index: number): boolean {
  if (index <= 0 || index >= text.length) return false;
  const prev = text.charCodeAt(index - 1), curr = text.charCodeAt(index);
  return prev >= 0xd800 && prev <= 0xdbff && curr >= 0xdc00 && curr <= 0xdfff;
}

export function isValidSeedOccurrence(content: string, seedRange: SourceRange, query: string, caseSensitive: boolean, expectedMatchText?: string): boolean {
  if (!query || seedRange.from < 0 || seedRange.to <= seedRange.from || seedRange.to > content.length) return false;
  if (isSplitUtf16Surrogate(content, seedRange.from) || isSplitUtf16Surrogate(content, seedRange.to)) return false;
  const slice = content.slice(seedRange.from, seedRange.to);
  if (expectedMatchText !== undefined && slice !== expectedMatchText) return false;
  return caseSensitive ? slice === query : foldUnicodeForSearch(slice) === foldUnicodeForSearch(query);
}

export default function ReadingSearch({ content, close, onChange, sourceSession, seed, initialReplace = false }: { content: string; close: () => void; onChange?: (content: string) => void; sourceSession?: string; seed?: ReadingSearchSeed | null; initialReplace?: boolean }) {
  const canReplace = Boolean(onChange);
  const canReplaceRef = useRef(canReplace); canReplaceRef.current = canReplace;
  const [query, setQuery] = useState(() => seed ? seed.query.slice(0, 200) : window.getSelection()?.toString().slice(0, 200) || "");
  const [matches, setMatches] = useState<Range[]>([]), [index, setIndex] = useState(-1);
  const indexRef = useRef(index); indexRef.current = index;
  const customCurrentRangeRef = useRef<Range | null>(null);
  const customCurrentSourceRef = useRef<{ ranges: SourceRange[]; index: number; query: string; options: SearchMatchConfig } | null>(null);
  const clearCustomCurrent = () => { customCurrentRangeRef.current = null; customCurrentSourceRef.current = null; };
  const updateIndex = (next: number, keepCustomCurrent = false) => {
    if (!keepCustomCurrent) clearCustomCurrent();
    indexRef.current = next; setIndex(next);
  };
  const [caseSensitive, setCaseSensitive] = useState(() => Boolean(seed?.caseSensitive)), [wholeWord, setWholeWord] = useState(false), [regexp, setRegexp] = useState(false);
  const [replacing, setReplacing] = useState(() => Boolean(initialReplace && canReplace)), [replacement, setReplacement] = useState("");
  const [sourceRanges, setSourceRanges] = useState<SourceRange[]>([]);
  const [windowed, setWindowed] = useState<WindowedMatch[] | null>(null);
  const [appliedNonce, setAppliedNonce] = useState<number | null>(seed ? seed.nonce : null);
  const pendingAutoSelect = useRef(Boolean(seed && seed.query)), pendingSeedRange = useRef<SourceRange | null>(extractSeedRange(seed));
  const pendingSeedMatchText = useRef<string | undefined>(extractSeedMatchText(seed));
  const [hiddenSourceHit, setHiddenSourceHit] = useState(false);
  const hiddenSourceAnchorRef = useRef<SourceRange | null>(null), pendingReplaceIndex = useRef<number | null>(null);
  if (seed && appliedNonce !== seed.nonce) {
    setAppliedNonce(seed.nonce);
    pendingAutoSelect.current = Boolean(seed.query);
    pendingSeedRange.current = extractSeedRange(seed);
    pendingSeedMatchText.current = extractSeedMatchText(seed);
    setHiddenSourceHit(false);
    hiddenSourceAnchorRef.current = null; pendingReplaceIndex.current = null; clearCustomCurrent();
    if (index !== -1) updateIndex(-1);
    setQuery(seed.query.slice(0, 200));
    if (seed.caseSensitive !== undefined) setCaseSensitive(Boolean(seed.caseSensitive));
    if (wholeWord) setWholeWord(false);
    if (regexp) setRegexp(false);
  }
  const activeReplacing = canReplace && replacing;
  const replaceComposingRef = useRef(false);
  if (!activeReplacing && replaceComposingRef.current) replaceComposingRef.current = false;
  const filterOptions: SearchMatchOptions = { caseSensitive, wholeWord, regexp };
  const { error: regexError } = compileSearchPattern(query, filterOptions, true);
  const sourceSearch = !!sourceSession || activeReplacing;
  const sourceSearchRef = useRef(sourceSearch); sourceSearchRef.current = sourceSearch;
  const count = regexError ? 0 : sourceSearch ? sourceRanges.length : windowed?.length ?? matches.length;
  const input = useRef<HTMLInputElement>(null);
  const closeRef = useRef(close); closeRef.current = close;
  const prevState = useRef({ query, content, caseSensitive, wholeWord, regexp });
  const settleCleanup = useRef<(() => void) | null>(null);
  const clearSettleFrames = () => { settleCleanup.current?.(); settleCleanup.current = null; };
  const clearPendingSeed = () => {
    clearSettleFrames();
    pendingAutoSelect.current = false; pendingSeedRange.current = null;
    pendingSeedMatchText.current = undefined; clearCustomCurrent();
  };

  const scheduleSearchSettle = (anchorHost: Element | null, step: () => boolean) => {
    clearSettleFrames();
    const scroller = anchorHost?.matches(".android-reading,.reading-scroll")
      ? (anchorHost as HTMLElement)
      : anchorHost?.closest<HTMLElement>(".android-reading,.reading-scroll") ?? document.querySelector<HTMLElement>(".android-reading,.reading-scroll");
    const eventHost = scroller ?? anchorHost;
    if (!eventHost) return;
    let active = true, frame = 0, remainingFrames = 4, layoutMutating = false;
    let recordedScrollTop = scroller?.scrollTop ?? 0, recordedScrollHeight = scroller?.scrollHeight ?? 0;
    const recordScrollerState = () => { if (scroller) { recordedScrollTop = scroller.scrollTop; recordedScrollHeight = scroller.scrollHeight; } };
    const inSearchUi = (target: EventTarget | null) => target instanceof Element && Boolean(target.closest(".reading-search"));
    const stop = () => {
      if (!active) return;
      active = false; cancelAnimationFrame(frame); frame = 0;
      window.clearTimeout(timer); observer?.disconnect();
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
      if (!step()) { stop(); return; }
      recordScrollerState();
      if (remainingFrames > 0) { remainingFrames--; frame = requestAnimationFrame(runPass); }
    };
    const schedulePass = () => { if (active && !frame) frame = requestAnimationFrame(runPass); };
    const onUserGesture = (event: Event) => { if (!inSearchUi(event.target)) stop(); };
    const onKeyDown = (event: KeyboardEvent) => { if (!inSearchUi(event.target) && MANUAL_SCROLL_KEYS.has(event.key)) stop(); };
    const onWindowChange = () => {
      if (!active) return;
      layoutMutating = true;
      queueMicrotask(() => { layoutMutating = false; if (active) recordScrollerState(); });
      schedulePass();
    };
    const onScroll = () => {
      if (!active || !scroller || layoutMutating) return;
      if (scroller.scrollHeight !== recordedScrollHeight) { recordScrollerState(); schedulePass(); return; }
      if (Math.abs(scroller.scrollTop - recordedScrollTop) > 2) stop();
    };
    const page = scroller?.querySelector<HTMLElement>(".document-page,.preview-page,.live-document,.markdown-body") ?? (eventHost instanceof HTMLElement ? eventHost : null);
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

  const sourceCacheRef = useRef<{ content: string; query: string; caseSensitive: boolean; wholeWord: boolean; regexp: boolean; ranges: SourceRange[] } | null>(null);
  const getSourceRanges = (text = content, q = query, opts: SearchMatchOptions = filterOptions): SourceRange[] => {
    const cs = Boolean(opts.caseSensitive), ww = Boolean(opts.wholeWord), rx = Boolean(opts.regexp), cached = sourceCacheRef.current;
    if (cached && cached.content === text && cached.query === q && cached.caseSensitive === cs && cached.wholeWord === ww && cached.regexp === rx) return cached.ranges;
    const computed = sourceMatches(text, q, { caseSensitive: cs, wholeWord: ww, regexp: rx });
    sourceCacheRef.current = { content: text, query: q, caseSensitive: cs, wholeWord: ww, regexp: rx, ranges: computed };
    return computed;
  };

  const exitReplacingToRendered = (revealActiveBlock: boolean) => {
    clearSettleFrames();
    clearCustomCurrent();
    let nextIndex = indexRef.current;
    if (!sourceSession) {
      const activeSourceRanges = regexError ? [] : (sourceRanges.length || !query ? sourceRanges : getSourceRanges());
      const host = findReadingHost();
      if (revealActiveBlock && nextIndex >= 0 && !regexError && host) {
        const sr = activeSourceRanges[nextIndex], block = sr ? findContainingBlock(host, sr, content) : null;
        if (block) revealMountedBlock(block);
      }
      const liveWindowed = host && !regexError ? windowedMatches(host, query, filterOptions) : null;
      const liveMatches = host && !liveWindowed && !regexError ? readingMatches(host, query, filterOptions) : [];
      setWindowed(liveWindowed);
      setMatches(liveMatches);
      if (nextIndex >= 0) {
        nextIndex = regexError ? -1 : translateSourceIndexToRendered(host, content, activeSourceRanges, nextIndex, query, filterOptions, liveWindowed, liveMatches);
      }
    }
    setReplacing(false);
    if (nextIndex < 0) setHiddenSourceHit(false);
    if (nextIndex !== indexRef.current) updateIndex(nextIndex);
  };

  useEffect(() => { if (!canReplace && replacing) exitReplacingToRendered(false); }, [canReplace, replacing]);

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
    const customSliceMatch = matchQuery !== query || matchOptions !== filterOptions;
    const recordCustom = (r: Range | null) => {
      if (!customSliceMatch) return;
      customCurrentRangeRef.current = r;
      customCurrentSourceRef.current = { ranges, index: targetIndex, query: matchQuery, options: matchOptions };
    };
    const allForHost = (targetHost: Element, extra: Range | null) => () => {
      const visible = readingMatches(targetHost, query, filterOptions);
      return customSliceMatch && extra ? [...visible, extra] : visible;
    };
    const initialBlock = findContainingBlock(host, range, sourceText);
    if (!initialBlock) {
      const fmDomRange = resolveSourceHighlightRange(host, sourceText, ranges, targetIndex, matchQuery, matchOptions, null);
      recordCustom(fmDomRange);
      syncSearchHighlights({ all: scroll ? allForHost(host, fmDomRange) : undefined, current: fmDomRange });
      if (scroll) {
        const fallback = rangeStartElement(fmDomRange) ?? host.querySelector("[data-frontmatter-properties],.document-properties") ?? resolveSourceBlock(host, range, sourceText);
        if (fallback) revealMountedBlock(fallback);
        scrollTargetIntoView(fallback, host);
      }
      return;
    }
    const wasUnmounted = !!initialBlock.closest('[data-windowed-mounted="false"]');
    if (scroll) revealMountedBlock(initialBlock);
    const block = findContainingBlock(host, range, sourceText) ?? initialBlock;
    const owner = deepestSourceOwner(block, range, sourceText) ?? block;
    if (scroll) openDisclosuresFor(owner, block, null, range);
    const domRange = resolveSourceHighlightRange(host, sourceText, ranges, targetIndex, matchQuery, matchOptions, block);
    recordCustom(domRange);
    let cachedScrollTarget: Element = (domRange ? rangeStartElement(domRange) : owner) ?? block;
    if (scroll) {
      openDisclosuresFor(owner, block, domRange, range);
      scrollTargetIntoView(cachedScrollTarget, host);
    }
    syncSearchHighlights({ all: wasUnmounted || scroll ? allForHost(host, domRange) : undefined, current: domRange });
    if (scroll) {
      const expectedIndex = indexRef.current;
      let settledHost: Element = host, settledVersion = getSearchDomVersion(host).version, settledBlock: HTMLElement = block;
      scheduleSearchSettle(host, () => {
        if (!sourceSearchRef.current || indexRef.current !== expectedIndex) return false;
        const liveHost = findReadingHost();
        if (!liveHost) return false;
        const nextVersion = getSearchDomVersion(liveHost).version;
        if (liveHost === settledHost && nextVersion === settledVersion && cachedScrollTarget.isConnected && !settledBlock.closest('[data-windowed-mounted="false"]')) {
          scrollTargetIntoView(cachedScrollTarget, liveHost);
          return true;
        }
        const currentBlock = findContainingBlock(liveHost, range, sourceText) ?? resolveSourceBlock(liveHost, range, sourceText);
        if (!currentBlock) return false;
        revealMountedBlock(currentBlock);
        settledBlock = findContainingBlock(liveHost, range, sourceText) ?? currentBlock;
        const settledOwner = deepestSourceOwner(settledBlock, range, sourceText) ?? settledBlock;
        openDisclosuresFor(settledOwner, settledBlock, null, range);
        const settledDomRange = resolveSourceHighlightRange(liveHost, sourceText, ranges, targetIndex, matchQuery, matchOptions, settledBlock);
        recordCustom(settledDomRange);
        openDisclosuresFor(settledOwner, settledBlock, settledDomRange, range);
        cachedScrollTarget = (settledDomRange ? rangeStartElement(settledDomRange) : settledOwner) ?? settledBlock;
        settledHost = liveHost;
        settledVersion = getSearchDomVersion(liveHost).version;
        scrollTargetIntoView(cachedScrollTarget, liveHost);
        syncSearchHighlights({ all: allForHost(liveHost, settledDomRange), current: settledDomRange });
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
    let cachedScrollTarget: Element = (range ? rangeStartElement(range) : match.element) ?? match.element;
    scrollTargetIntoView(cachedScrollTarget, host);
    updateIndex(next);
    const initialRoot = host ?? match.element;
    syncSearchHighlights({ all: () => readingMatches(initialRoot, query, filterOptions), current: range });
    let settledRoot: Element = initialRoot, settledVersion = getSearchDomVersion(initialRoot).version;
    scheduleSearchSettle(initialRoot, () => {
      if (sourceSearchRef.current || indexRef.current !== next || !match.element.isConnected) return false;
      revealMountedBlock(match.element);
      const liveHost = findReadingHost(), targetRoot = liveHost ?? match.element, nextVersion = getSearchDomVersion(targetRoot).version;
      if (targetRoot === settledRoot && nextVersion === settledVersion && cachedScrollTarget.isConnected && !match.element.closest('[data-windowed-mounted="false"]')) {
        scrollTargetIntoView(cachedScrollTarget, liveHost);
        return true;
      }
      openDisclosuresFor(match.element, match.element);
      let liveRange = readingMatches(match.element, query, filterOptions)[match.ordinal] ?? null;
      if (openDisclosuresFor(match.element, match.element, liveRange)) liveRange = readingMatches(match.element, query, filterOptions)[match.ordinal] ?? null;
      cachedScrollTarget = (liveRange ? rangeStartElement(liveRange) : match.element) ?? match.element;
      settledRoot = targetRoot;
      settledVersion = getSearchDomVersion(targetRoot).version;
      scrollTargetIntoView(cachedScrollTarget, liveHost);
      syncSearchHighlights({ all: () => readingMatches(targetRoot, query, filterOptions), current: liveRange });
      return true;
    });
  };

  const selectDomMatch = (next: number, activeMatches: Range[], host: HTMLElement | null) => {
    const range = activeMatches[next];
    if (!range) return;
    clearSettleFrames();
    const element = rangeStartElement(range);
    openDisclosuresFor(element, element?.closest(".code-container,details") ?? element, range);
    scrollTargetIntoView(element, host);
    updateIndex(next);
    syncSearchHighlights({ current: range });
  };

  const toggleReplacing = (nextReplacing = !activeReplacing) => {
    if (!canReplaceRef.current || nextReplacing === activeReplacing) return;
    clearSettleFrames();
    if (!nextReplacing) { exitReplacingToRendered(true); return; }
    const activeSourceRanges = regexError ? [] : getSourceRanges();
    setSourceRanges(activeSourceRanges);
    if (!sourceSession && indexRef.current < 0 && hiddenSourceAnchorRef.current && activeSourceRanges.length) {
      const mappedHidden = findMatchingSourceRangeIndex(activeSourceRanges, hiddenSourceAnchorRef.current);
      if (mappedHidden >= 0) {
        setHiddenSourceHit(false);
        hiddenSourceAnchorRef.current = null;
        setReplacing(true);
        updateIndex(mappedHidden);
        revealAndHighlightSource(mappedHidden, activeSourceRanges, content, true);
        return;
      }
    }
    const nextIndex = !sourceSession && indexRef.current >= 0
      ? (regexError ? -1 : translateRenderedIndexToSource(findReadingHost(), content, activeSourceRanges, indexRef.current, query, filterOptions, windowed, matches))
      : indexRef.current;
    clearCustomCurrent();
    setReplacing(true);
    if (nextIndex !== indexRef.current) updateIndex(nextIndex);
  };
  const toggleReplacingRef = useRef(toggleReplacing); toggleReplacingRef.current = toggleReplacing;

  const move = (direction: number) => {
    // Search is a new deliberate navigation, just like pan/zoom. A briefly
    // observing heading jump must not pull the viewport back after this move.
    cancelSettlingHeading();
    clearPendingSeed();
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
    const activeWindowed = host && windowed && areWindowedMatchesLive(windowed, host) ? windowed : (host ? windowedMatches(host, query, filterOptions) : null);
    const activeMatches = activeWindowed ? [] : (matches.length || !host ? matches : readingMatches(host, query, filterOptions));
    const renderedTotal = activeWindowed ? activeWindowed.length : activeMatches.length;
    if (current < 0 && hiddenAnchor && renderedTotal > 0) {
      const activeSourceRanges = sourceRanges.length ? sourceRanges : getSourceRanges();
      if (activeSourceRanges.length) {
        let anchoredRendered = -1;
        if (direction > 0) {
          for (let i = firstSourceRangeFrom(activeSourceRanges, hiddenAnchor.to); i < activeSourceRanges.length; i++) {
            const mapped = translateSourceIndexToRendered(host, content, activeSourceRanges, i, query, filterOptions, activeWindowed, activeMatches);
            if (mapped >= 0) { anchoredRendered = mapped; break; }
          }
          if (anchoredRendered < 0) anchoredRendered = 0;
        } else {
          for (let i = activeSourceRanges.length - 1; i >= 0; i--) {
            if (activeSourceRanges[i].to > hiddenAnchor.from) continue;
            const mapped = translateSourceIndexToRendered(host, content, activeSourceRanges, i, query, filterOptions, activeWindowed, activeMatches);
            if (mapped >= 0) { anchoredRendered = mapped; break; }
          }
          if (anchoredRendered < 0) anchoredRendered = renderedTotal - 1;
        }
        if (activeWindowed) selectWindowedMatch(anchoredRendered, activeWindowed, host);
        else selectDomMatch(anchoredRendered, activeMatches, host);
        return;
      }
    }
    const next = nextSearchIndex(current, direction, renderedTotal);
    if (next < 0) return;
    if (activeWindowed) selectWindowedMatch(next, activeWindowed, host);
    else selectDomMatch(next, activeMatches, host);
  };
  const moveRef = useRef(move); moveRef.current = move;

  const effectiveIndex = pendingReplaceIndex.current !== null ? pendingReplaceIndex.current : index;
  const criteriaSynced = prevState.current.query === query && prevState.current.caseSensitive === caseSensitive
    && prevState.current.wholeWord === wholeWord && prevState.current.regexp === regexp
    && (prevState.current.content === content || pendingReplaceIndex.current !== null);
  const activeReplaceRanges = activeReplacing && criteriaSynced && query && !regexError
    ? (prevState.current.content === content && sourceRanges.length ? sourceRanges : getSourceRanges()) : [];
  const canSingleReplace = Boolean(activeReplacing && onChange && effectiveIndex >= 0 && effectiveIndex < activeReplaceRanges.length && activeReplaceRanges[effectiveIndex]);

  const handleSingleReplace = () => {
    if (!canSingleReplace || !onChange) return;
    const target = activeReplaceRanges[effectiveIndex];
    if (!target) return;
    const nextContent = replaceSourceMatches(content, query, replacement, filterOptions, effectiveIndex);
    const replacedEnd = target.to + (nextContent.length - content.length);
    const nextRanges = getSourceRanges(nextContent, query, filterOptions);
    const foundNext = nextRanges.findIndex(r => r.from >= replacedEnd);
    const nextIndex = !nextRanges.length ? -1 : (foundNext >= 0 ? foundNext : 0);
    if (nextContent === content) {
      pendingReplaceIndex.current = null;
      updateIndex(nextIndex);
      if (nextIndex >= 0) revealAndHighlightSource(nextIndex, nextRanges, nextContent, true);
      return;
    }
    pendingReplaceIndex.current = nextIndex;
    onChange(nextContent);
  };

  const handleReplaceAll = () => {
    if (!canReplace || !onChange || !query || regexError || !sourceRanges.length) return;
    clearSettleFrames();
    const nextContent = replaceSourceMatches(content, query, replacement, filterOptions);
    if (nextContent === content) { updateIndex(-1); return; }
    pendingReplaceIndex.current = -1;
    onChange(nextContent);
  };

  useEffect(() => {
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
    const step = (event: Event) => moveRef.current((event as CustomEvent<number>).detail < 0 ? -1 : 1);
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
      cancelAnimationFrame(focusFrame);
      clearSettleFrames();
      syncSearchHighlights({ all: null, current: null });
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
    if (contentChanged) invalidateSourceRangeIndex();
    prevState.current = { query, content, caseSensitive, wholeWord, regexp };
    // Only evaluate the source-search pipeline when Source/Split editor search or
    // Replace-in-source is active; rendered Read/Live Find skips scanning raw source.
    const nextSourceRanges = regexError || !sourceSearch ? [] : getSourceRanges();
    setSourceRanges(prevRanges => (prevRanges.length === 0 && nextSourceRanges.length === 0 ? prevRanges : nextSourceRanges));
    if (sourceSession) editorFindQuery(sourceSession, regexError ? "" : query, caseSensitive, { wholeWord, regexp });
    const autoSelect = pendingAutoSelect.current;
    let targetIndex = indexRef.current, shouldScrollReplaced = false;
    if (autoSelect && !regexError) {
      pendingReplaceIndex.current = null;
    } else if (criteriaChanged || regexError) {
      clearPendingSeed();
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
      clearCustomCurrent();
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
        syncSearchHighlights({ all: null, current: null });
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
            updateIndex(-1, true);
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
        if (host) {
          syncSearchHighlights({
            all: () => (activeRanges.length ? readingMatches(host, query, filterOptions) : []),
            current: shouldScrollReplaced && targetIndex >= 0
              ? () => resolveSourceHighlightRange(host, content, activeRanges, targetIndex, query, filterOptions)
              : indexRef.current < 0 ? null : undefined,
          });
        } else {
          syncSearchHighlights({ all: null, current: null });
        }
        return;
      }
      const nextWindowed = host ? windowedMatches(host, query, filterOptions) : null;
      if (runAutoSelect && hasValidSeedRange && seedRange && host) {
        const seedSourceRanges = getSourceRanges();
        const seedSourceIndex = findMatchingSourceRangeIndex(seedSourceRanges, seedRange);
        const targetRange = seedSourceIndex >= 0 ? seedSourceRanges[seedSourceIndex] : seedRange;
        const sliceText = seedSourceIndex < 0 ? content.slice(targetRange.from, targetRange.to) : "";
        const sliceRanges = sliceText ? sourceMatches(content, sliceText, true) : [];
        const sliceIdx = sliceRanges.length ? findMatchingSourceRangeIndex(sliceRanges, targetRange) : -1;
        const initialResult = nextWindowed === null ? readingMatches(host, query, filterOptions) : [];
        const initialBlock = findContainingBlock(host, targetRange, content);
        const wasUnmounted = Boolean(initialBlock?.closest('[data-windowed-mounted="false"]'));
        if (initialBlock && wasUnmounted) revealMountedBlock(initialBlock);
        const block = initialBlock ? (findContainingBlock(host, targetRange, content) ?? initialBlock) : null;
        const owner = block ? (deepestSourceOwner(block, targetRange, content) ?? block) : null;
        const openedDisclosures = block ? openDisclosuresFor(owner, block, null, targetRange) : false;
        const activeWindowed = wasUnmounted || openedDisclosures ? windowedMatches(host, query, filterOptions) : nextWindowed;
        const activeResult = activeWindowed !== null ? [] : (wasUnmounted || openedDisclosures ? readingMatches(host, query, filterOptions) : initialResult);
        setWindowed(activeWindowed);
        setMatches(activeResult);
        const domRange = seedSourceIndex >= 0
          ? resolveSourceHighlightRange(host, content, seedSourceRanges, seedSourceIndex, query, filterOptions, block)
          : (sliceIdx >= 0 ? resolveSourceHighlightRange(host, content, sliceRanges, sliceIdx, sliceText, true, block) : null);
        if (domRange) {
          setHiddenSourceHit(false);
          hiddenSourceAnchorRef.current = null;
          if (seedSourceIndex >= 0) {
            const renderedIdx = translateSourceIndexToRendered(host, content, seedSourceRanges, seedSourceIndex, query, filterOptions, activeWindowed, activeResult);
            if (renderedIdx >= 0) {
              if (activeWindowed) selectWindowedMatch(renderedIdx, activeWindowed, host);
              else { syncSearchHighlights({ all: activeResult }); selectDomMatch(renderedIdx, activeResult, host); }
              return;
            }
          } else if (!activeWindowed) {
            const { ranges: augmented, index: insertAt } = insertDomRangeInOrder(activeResult, domRange);
            if (augmented !== activeResult) setMatches(augmented);
            syncSearchHighlights({ all: augmented });
            selectDomMatch(insertAt, augmented, host);
            return;
          } else {
            clearSettleFrames();
            const scrollEl = rangeStartElement(domRange);
            if (block) openDisclosuresFor(scrollEl, block, domRange, targetRange);
            scrollTargetIntoView(scrollEl ?? owner, host);
            customCurrentRangeRef.current = domRange;
            customCurrentSourceRef.current = sliceIdx >= 0 ? { ranges: sliceRanges, index: sliceIdx, query: sliceText, options: true } : null;
            updateIndex(-1, true);
            syncSearchHighlights({
              all: () => [...(activeWindowed.length ? readingMatches(host, query, filterOptions) : []), domRange],
              current: domRange,
            });
            if (wasUnmounted) {
              scheduleSearchSettle(host, () => {
                if (sourceSearchRef.current || indexRef.current !== -1 || customCurrentRangeRef.current === null) return false;
                const liveHost = findReadingHost();
                const initialLiveBlock = liveHost?.isConnected ? findContainingBlock(liveHost, targetRange, content) : null;
                if (!liveHost || !initialLiveBlock?.isConnected) return false;
                revealMountedBlock(initialLiveBlock);
                const liveBlock = findContainingBlock(liveHost, targetRange, content) ?? initialLiveBlock;
                const liveOwner = deepestSourceOwner(liveBlock, targetRange, content) ?? liveBlock;
                openDisclosuresFor(liveOwner, liveBlock, null, targetRange);
                const liveDomRange = sliceIdx >= 0 ? resolveSourceHighlightRange(liveHost, content, sliceRanges, sliceIdx, sliceText, true, liveBlock) : null;
                const liveScrollEl = (liveDomRange ? rangeStartElement(liveDomRange) : liveOwner) ?? liveOwner;
                openDisclosuresFor(liveScrollEl, liveBlock, liveDomRange, targetRange);
                scrollTargetIntoView(liveScrollEl, liveHost);
                if (liveDomRange) {
                  customCurrentRangeRef.current = liveDomRange;
                  syncSearchHighlights({
                    all: () => [...(activeWindowed.length ? readingMatches(liveHost, query, filterOptions) : []), liveDomRange],
                    current: liveDomRange,
                  });
                }
                return true;
              });
            }
            return;
          }
        }
        clearSettleFrames();
        const fallback = block ? null : (host.querySelector("[data-frontmatter-properties],.document-properties") ?? resolveSourceBlock(host, targetRange, content));
        const fallbackWasUnmounted = Boolean(fallback?.closest('[data-windowed-mounted="false"]'));
        if (block) {
          openDisclosuresFor(owner, block, null, targetRange);
          scrollTargetIntoView(owner ?? block, host);
        } else if (fallback) {
          revealMountedBlock(fallback);
          scrollTargetIntoView(fallback, host);
        }
        updateIndex(-1);
        setHiddenSourceHit(true);
        hiddenSourceAnchorRef.current = targetRange;
        syncSearchHighlights({
          all: activeWindowed !== null ? () => (activeWindowed.length ? readingMatches(host, query, filterOptions) : []) : activeResult,
          current: null,
        });
        if (wasUnmounted || fallbackWasUnmounted) {
          scheduleSearchSettle(host, () => {
            if (sourceSearchRef.current || indexRef.current !== -1 || hiddenSourceAnchorRef.current !== targetRange) return false;
            const liveHost = findReadingHost();
            if (!liveHost?.isConnected) return false;
            const initialLiveBlock = findContainingBlock(liveHost, targetRange, content) ?? resolveSourceBlock(liveHost, targetRange, content);
            if (initialLiveBlock) revealMountedBlock(initialLiveBlock);
            const liveBlock = (initialLiveBlock ? findContainingBlock(liveHost, targetRange, content) : null) ?? initialLiveBlock;
            const liveOwner = liveBlock ? (deepestSourceOwner(liveBlock, targetRange, content) ?? liveBlock) : null;
            if (liveBlock) openDisclosuresFor(liveOwner, liveBlock, null, targetRange);
            scrollTargetIntoView(liveOwner ?? liveBlock ?? owner ?? block ?? fallback, liveHost);
            return true;
          });
        }
        return;
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
        if (host) {
          syncSearchHighlights({
            all: () => (nextWindowed.length ? readingMatches(host, query, filterOptions) : []),
            current: indexRef.current < 0 ? null : undefined,
          });
        }
        return;
      }
      const result = host ? readingMatches(host, query, filterOptions) : [];
      setWindowed(prevWindowed => (prevWindowed === null ? prevWindowed : null));
      setMatches(result);
      if (runAutoSelect) {
        if (!hasStaleSeedRange && result.length) { syncSearchHighlights({ all: result }); selectDomMatch(0, result, host); return; }
        updateIndex(-1);
      } else if (!criteriaChanged && !contentChanged && indexRef.current >= result.length) {
        updateIndex(result.length - 1);
      }
      syncSearchHighlights({ all: result, current: indexRef.current < 0 ? null : undefined });
    });
    return () => {
      cancelAnimationFrame(frame);
      clearSettleFrames();
      if (sourceSession) editorFindQuery(sourceSession, "", false);
    };
  }, [query, content, caseSensitive, wholeWord, regexp, sourceSearch, sourceSession, canReplace, seed?.nonce]);

  useEffect(() => {
    syncSearchHighlights({
      current: regexError ? null : index < 0 ? customCurrentRangeRef.current : () => resolveActiveHighlightRange(findReadingHost(), index, { sourceSearch, content, sourceRanges, windowed, matches, query, filterOptions }),
    });
  }, [index, matches, windowed, sourceRanges, sourceSearch, sourceSession, content, query, caseSensitive, wholeWord, regexp, regexError]);

  useEffect(() => {
    const host = findReadingHost(); if (!host || (!windowed && !sourceSearch) || !query || regexError) return;
    let frame = 0;
    const refresh = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const active = indexRef.current;
        let customCurrent = active < 0 ? customCurrentRangeRef.current : null;
        if (active < 0 && !isLiveMatchRange(customCurrent, host) && customCurrentSourceRef.current) {
          const src = customCurrentSourceRef.current;
          customCurrent = resolveSourceHighlightRange(host, content, src.ranges, src.index, src.query, src.options);
          customCurrentRangeRef.current = customCurrent;
        }
        const liveCustom = isLiveMatchRange(customCurrent, host) ? customCurrent : null;
        syncSearchHighlights({
          all: () => {
            const visible = readingMatches(host, query, filterOptions);
            return liveCustom ? [...visible, liveCustom] : visible;
          },
          current: active < 0 ? liveCustom
            : () => resolveActiveHighlightRange(host, active, { sourceSearch, content, sourceRanges, windowed, matches: [], query, filterOptions }),
        });
      });
    };
    host.addEventListener("supermd-window-change", refresh);
    return () => { cancelAnimationFrame(frame); host.removeEventListener("supermd-window-change", refresh); };
  }, [windowed, sourceSearch, sourceRanges, content, query, caseSensitive, wholeWord, regexp, regexError]);

  const hiddenStatus = !sourceSearch && hiddenSourceHit && index < 0;
  const statusText = regexError ? regexError
    : hiddenStatus ? (count ? `In source · 0 / ${count}${count >= 5000 ? "+" : ""}` : "In Markdown source")
    : count ? `${index < 0 ? 0 : index + 1} / ${count}${count >= 5000 ? "+" : ""}` : query ? "No matches" : "";
  const statusTitle = regexError ? regexError
    : hiddenStatus ? "Selected match is in hidden Markdown syntax (such as a link URL, comment, or frontmatter)."
    : count >= 5000 ? "Showing the first 5,000 matches. Narrow your search to find later results." : undefined;

  return <aside className="reading-search" data-independent-zoom role="search" aria-label="Find in note">
    <input ref={input} aria-label="Find in note" aria-invalid={!!regexError || undefined} role="searchbox" type="text" inputMode="search" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="Find in this note" value={query} onChange={event => { clearPendingSeed(); setQuery(event.target.value); }} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); move(event.shiftKey ? -1 : 1); } }} />
    <output aria-live="polite" className={regexError ? "search-error" : undefined} title={statusTitle}>{statusText}</output>
    <button className="search-icon" aria-label="Previous match" disabled={!count} onClick={() => move(-1)} title="Previous match (Shift+Enter / Shift+F3)"><ArrowUpIcon size={20} weight="bold" /></button>
    <button className="search-icon" aria-label="Next match" disabled={!count} onClick={() => move(1)} title="Next match (Enter / F3)"><ArrowDownIcon size={20} weight="bold" /></button>
    <button className="search-icon" aria-pressed={caseSensitive} onClick={() => { clearPendingSeed(); setCaseSensitive(!caseSensitive); }} title="Match case" aria-label="Match case"><TextAaIcon size={20} weight="bold" /></button>
    <button className="search-icon" aria-pressed={wholeWord} onClick={() => { clearPendingSeed(); setWholeWord(!wholeWord); }} title="Match whole word" aria-label="Match whole word"><TextboxIcon size={20} weight="bold" /></button>
    <button className="search-icon" aria-pressed={regexp} onClick={() => { clearPendingSeed(); setRegexp(!regexp); }} title="Regular expression" aria-label="Regular expression"><AsteriskIcon size={20} weight="bold" /></button>
    {canReplace && <button className="search-icon" aria-pressed={activeReplacing} onClick={() => toggleReplacing()} title="Replace in source (Ctrl+H)" aria-label="Replace in source"><ArrowsClockwiseIcon size={20} weight="bold" /></button>}
    <button className="search-icon" onClick={close} title="Close search (Esc)" aria-label="Close search"><XIcon size={20} weight="bold" /></button>
    {activeReplacing && onChange && <div className="search-replace"><input type="text" aria-label="Replacement text" autoCapitalize="none" autoCorrect="off" autoComplete="off" spellCheck={false} placeholder="Replace with" value={replacement} onChange={e => setReplacement(e.target.value)} onCompositionStart={() => { replaceComposingRef.current = true; }} onCompositionEnd={() => { replaceComposingRef.current = false; }} onBlur={() => { replaceComposingRef.current = false; }} onKeyDown={event => { if (replaceComposingRef.current || event.nativeEvent.isComposing || event.keyCode === 229) return; if (event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return; event.preventDefault(); if (canSingleReplace) handleSingleReplace(); }} /><button disabled={!canSingleReplace} onClick={handleSingleReplace}>Replace</button><button disabled={!query || !!regexError || !count} onClick={handleReplaceAll}>Replace all</button><small>{regexError ? `${regexError}.` : regexp ? "Replaces regex matches in Markdown source ($1, $&, $$ supported)." : "Replaces literal text in Markdown source."}</small></div>}
  </aside>;
}
