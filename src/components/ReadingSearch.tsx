import { useEffect, useRef, useState } from "react";
import { setReaderOverlay } from "../readerOverlays";
import { ArrowUpIcon, ArrowDownIcon, XIcon, TextAaIcon, TextboxIcon, AsteriskIcon, ArrowsClockwiseIcon } from "@phosphor-icons/react";
import { editorFindQuery, editorFindRange } from "./Editor";
import { windowedMatches, compileSearchPattern, type WindowedMatch, type SearchMatchOptions } from "../windowedSearch";
import {
  cancelSettlingHeading,
  deepestSourceOwner,
  findContainingBlock,
  findReadingHost,
  getSearchDomVersion,
  nextSearchIndex,
  openDisclosuresFor,
  readingMatches,
  replaceSourceMatches,
  resolveActiveHighlightRange,
  resolveSourceBlock,
  resolveSourceHighlightRange,
  revealMountedBlock,
  scrollTargetIntoView,
  sourceMatches,
  syncSearchHighlights,
  translateRenderedIndexToSource,
  translateSourceIndexToRendered,
  type SourceRange,
} from "../readingSearchDom";
export type { SearchMatchConfig, SearchMatchOptions } from "../readingSearchDom";
export { nextSearchIndex, readingMatches, replaceSourceMatches, resolveSourceBlock, resolveSourceHighlightRange, sourceMatches };

const MANUAL_SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);
const SEARCH_SETTLE_WINDOW_MS = 800;

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

  const exitReplacingToRendered = (revealActiveBlock: boolean) => {
    clearSettleFrames();
    let nextIndex = indexRef.current;
    if (!sourceSession) {
      const activeSourceRanges = regexError ? [] : (sourceRanges.length || !query ? sourceRanges : getSourceRanges());
      const host = findReadingHost();
      if (revealActiveBlock && nextIndex >= 0 && !regexError) {
        const sr = activeSourceRanges[nextIndex];
        const block = sr && host ? findContainingBlock(host, sr, content) : null;
        if (block) revealMountedBlock(block);
      }
      const liveWindowed = host && !regexError ? windowedMatches(host, query, filterOptions) : null;
      const liveMatches = host && !liveWindowed && !regexError ? readingMatches(host, query, filterOptions) : [];
      setWindowed(liveWindowed);
      setMatches(liveMatches);
      if (nextIndex >= 0) {
        nextIndex = regexError
          ? -1
          : translateSourceIndexToRendered(host, content, activeSourceRanges, nextIndex, query, filterOptions, liveWindowed, liveMatches);
      }
    }
    setReplacing(false);
    if (nextIndex !== indexRef.current) updateIndex(nextIndex);
  };

  useEffect(() => {
    if (!canReplace && replacing) exitReplacingToRendered(false);
  }, [canReplace, replacing]);

  const revealAndHighlightSource = (targetIndex: number, ranges: SourceRange[], sourceText: string, scroll: boolean) => {
    if (scroll) clearSettleFrames();
    const range = ranges[targetIndex];
    if (!range) return;
    if (scroll && sourceSession) {
      editorFindRange(sourceSession, range.from, range.to);
      if (!findReadingHost()) return;
    }
    const host = findReadingHost();
    if (!host) return;
    const initialBlock = findContainingBlock(host, range, sourceText);
    if (!initialBlock) {
      syncSearchHighlights({ current: null });
      if (scroll) {
        const fallback = host.querySelector("[data-frontmatter-properties],.document-properties") ?? resolveSourceBlock(host, range, sourceText);
        scrollTargetIntoView(fallback, host);
      }
      return;
    }
    const wasUnmounted = !!initialBlock.closest('[data-windowed-mounted="false"]');
    if (scroll) revealMountedBlock(initialBlock);
    const block = findContainingBlock(host, range, sourceText) ?? initialBlock;
    const owner = deepestSourceOwner(block, range, sourceText) ?? block;
    if (scroll) openDisclosuresFor(owner, block, null, range);
    const domRange = resolveSourceHighlightRange(host, sourceText, ranges, targetIndex, query, filterOptions, block);
    let cachedScrollTarget: Element = (domRange ? (domRange.startContainer.nodeType === Node.ELEMENT_NODE ? domRange.startContainer as Element : domRange.startContainer.parentElement) : owner) ?? block;
    if (scroll) {
      openDisclosuresFor(owner, block, domRange, range);
      scrollTargetIntoView(cachedScrollTarget, host);
    }
    syncSearchHighlights({
      all: wasUnmounted || scroll ? () => readingMatches(host, query, filterOptions) : undefined,
      current: domRange,
    });
    if (scroll) {
      let settledHost: Element = host;
      let settledVersion = getSearchDomVersion(host).version;
      let settledBlock: HTMLElement = block;
      scheduleSearchSettle(host, () => {
        if (!sourceSearchRef.current || indexRef.current !== targetIndex) return false;
        const liveHost = findReadingHost();
        if (!liveHost) return false;
        const nextVersion = getSearchDomVersion(liveHost).version;
        if (liveHost === settledHost && nextVersion === settledVersion && cachedScrollTarget.isConnected && !settledBlock.closest('[data-windowed-mounted="false"]')) {
          scrollTargetIntoView(cachedScrollTarget, liveHost);
          return true;
        }
        const currentBlock = findContainingBlock(liveHost, range, sourceText);
        if (!currentBlock) return false;
        revealMountedBlock(currentBlock);
        settledBlock = findContainingBlock(liveHost, range, sourceText) ?? currentBlock;
        const settledOwner = deepestSourceOwner(settledBlock, range, sourceText) ?? settledBlock;
        openDisclosuresFor(settledOwner, settledBlock, null, range);
        const settledDomRange = resolveSourceHighlightRange(liveHost, sourceText, ranges, targetIndex, query, filterOptions, settledBlock);
        openDisclosuresFor(settledOwner, settledBlock, settledDomRange, range);
        cachedScrollTarget = (settledDomRange
          ? (settledDomRange.startContainer.nodeType === Node.ELEMENT_NODE ? settledDomRange.startContainer as Element : settledDomRange.startContainer.parentElement)
          : settledOwner) ?? settledBlock;
        settledHost = liveHost;
        settledVersion = getSearchDomVersion(liveHost).version;
        scrollTargetIntoView(cachedScrollTarget, liveHost);
        syncSearchHighlights({
          all: () => readingMatches(liveHost, query, filterOptions),
          current: settledDomRange,
        });
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
    let cachedScrollTarget: Element = (range ? (range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer as Element : range.startContainer.parentElement) : match.element) ?? match.element;
    scrollTargetIntoView(cachedScrollTarget, host);
    updateIndex(next);
    const initialRoot = host ?? match.element;
    syncSearchHighlights({
      all: () => readingMatches(initialRoot, query, filterOptions),
      current: range,
    });
    let settledRoot: Element = initialRoot;
    let settledVersion = getSearchDomVersion(initialRoot).version;
    scheduleSearchSettle(initialRoot, () => {
      if (sourceSearchRef.current || indexRef.current !== next || !match.element.isConnected) return false;
      revealMountedBlock(match.element);
      const liveHost = findReadingHost();
      const targetRoot = liveHost ?? match.element;
      const nextVersion = getSearchDomVersion(targetRoot).version;
      if (targetRoot === settledRoot && nextVersion === settledVersion && cachedScrollTarget.isConnected && !match.element.closest('[data-windowed-mounted="false"]')) {
        scrollTargetIntoView(cachedScrollTarget, liveHost);
        return true;
      }
      openDisclosuresFor(match.element, match.element);
      let liveRange = readingMatches(match.element, query, filterOptions)[match.ordinal] ?? null;
      if (openDisclosuresFor(match.element, match.element, liveRange)) liveRange = readingMatches(match.element, query, filterOptions)[match.ordinal] ?? null;
      cachedScrollTarget = (liveRange ? (liveRange.startContainer.nodeType === Node.ELEMENT_NODE ? liveRange.startContainer as Element : liveRange.startContainer.parentElement) : match.element) ?? match.element;
      settledRoot = targetRoot;
      settledVersion = getSearchDomVersion(targetRoot).version;
      scrollTargetIntoView(cachedScrollTarget, liveHost);
      syncSearchHighlights({
        all: () => readingMatches(targetRoot, query, filterOptions),
        current: liveRange,
      });
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
    syncSearchHighlights({ current: range });
  };

  const toggleReplacing = (nextReplacing = !activeReplacing) => {
    if (!canReplaceRef.current || nextReplacing === activeReplacing) return;
    clearSettleFrames();
    if (!nextReplacing) {
      exitReplacingToRendered(true);
      return;
    }
    const activeSourceRanges = regexError ? [] : getSourceRanges();
    setSourceRanges(activeSourceRanges);
    const nextIndex = !sourceSession && indexRef.current >= 0
      ? (regexError ? -1 : translateRenderedIndexToSource(findReadingHost(), content, activeSourceRanges, indexRef.current, query, filterOptions, windowed, matches))
      : indexRef.current;
    setReplacing(true);
    if (nextIndex !== indexRef.current) updateIndex(nextIndex);
  };
  const toggleReplacingRef = useRef(toggleReplacing); toggleReplacingRef.current = toggleReplacing;

  const move = (direction: number) => {
    // Search is a new deliberate navigation, just like pan/zoom. A briefly
    // observing heading jump must not pull the viewport back after this move.
    cancelSettlingHeading();
    clearSettleFrames();
    pendingAutoSelect.current = false;
    if (regexError) return;
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
    if (activeWindowed) {
      const next = nextSearchIndex(current, direction, activeWindowed.length);
      if (next < 0) return;
      selectWindowedMatch(next, activeWindowed, host);
      return;
    }
    const activeMatches = matches.length || !host ? matches : readingMatches(host, query, filterOptions);
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
      pendingReplaceIndex.current = null;
      targetIndex = -1;
      if (indexRef.current !== -1) updateIndex(-1);
    } else if (pendingReplaceIndex.current !== null) {
      targetIndex = pendingReplaceIndex.current;
      pendingReplaceIndex.current = null;
      shouldScrollReplaced = targetIndex >= 0;
      updateIndex(targetIndex);
    } else if (contentChanged) {
      targetIndex = -1;
      if (indexRef.current !== -1) updateIndex(-1);
    } else if (sourceSearch && indexRef.current >= nextSourceRanges.length) {
      targetIndex = nextSourceRanges.length - 1;
      updateIndex(targetIndex);
    }
    const frame = requestAnimationFrame(() => {
      const runAutoSelect = pendingAutoSelect.current;
      pendingAutoSelect.current = false;
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
          if (activeRanges.length) {
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
      if (nextWindowed !== null) {
        setWindowed(nextWindowed);
        setMatches(prevMatches => (prevMatches.length === 0 ? prevMatches : []));
        if (runAutoSelect) {
          if (nextWindowed.length) { selectWindowedMatch(0, nextWindowed, host); return; }
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
        if (result.length) {
          syncSearchHighlights({ all: result });
          selectDomMatch(0, result, host);
          return;
        }
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
      current: regexError || index < 0
        ? null
        : () => resolveActiveHighlightRange(findReadingHost(), index, { sourceSearch, content, sourceRanges, windowed, matches, query, filterOptions }),
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
        syncSearchHighlights({
          all: () => readingMatches(host, query, filterOptions),
          current: active < 0
            ? undefined
            : () => resolveActiveHighlightRange(host, active, { sourceSearch, content, sourceRanges, windowed, matches: [], query, filterOptions }),
        });
      });
    };
    host.addEventListener("supermd-window-change", refresh);
    return () => { cancelAnimationFrame(frame); host.removeEventListener("supermd-window-change", refresh); };
  }, [windowed, sourceSearch, sourceRanges, content, query, caseSensitive, wholeWord, regexp, regexError]);

  return <aside className="reading-search" data-independent-zoom role="search" aria-label="Find in note">
    <input ref={input} aria-label="Find in note" aria-invalid={!!regexError || undefined} role="searchbox" type="text" inputMode="search" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="Find in this note" value={query} onChange={event => { clearSettleFrames(); pendingAutoSelect.current = false; setQuery(event.target.value); }} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); move(event.shiftKey ? -1 : 1); } }} />
    <output aria-live="polite" className={regexError ? "search-error" : undefined} title={regexError ? regexError : count >= 5000 ? "Showing the first 5,000 matches. Narrow your search to find later results." : undefined}>{regexError ? regexError : count ? `${index < 0 ? 0 : index + 1} / ${count}${count >= 5000 ? "+" : ""}` : query ? "No matches" : ""}</output>
    <button className="search-icon" aria-label="Previous match" disabled={!count} onClick={() => move(-1)} title="Previous match (Shift+Enter / Shift+F3)"><ArrowUpIcon size={20} weight="bold" /></button>
    <button className="search-icon" aria-label="Next match" disabled={!count} onClick={() => move(1)} title="Next match (Enter / F3)"><ArrowDownIcon size={20} weight="bold" /></button>
    <button className="search-icon" aria-pressed={caseSensitive} onClick={() => { clearSettleFrames(); pendingAutoSelect.current = false; setCaseSensitive(!caseSensitive); }} title="Match case" aria-label="Match case"><TextAaIcon size={20} weight="bold" /></button>
    <button className="search-icon" aria-pressed={wholeWord} onClick={() => { clearSettleFrames(); pendingAutoSelect.current = false; setWholeWord(!wholeWord); }} title="Match whole word" aria-label="Match whole word"><TextboxIcon size={20} weight="bold" /></button>
    <button className="search-icon" aria-pressed={regexp} onClick={() => { clearSettleFrames(); pendingAutoSelect.current = false; setRegexp(!regexp); }} title="Regular expression" aria-label="Regular expression"><AsteriskIcon size={20} weight="bold" /></button>
    {canReplace && <button className="search-icon" aria-pressed={activeReplacing} onClick={() => toggleReplacing()} title="Replace in source (Ctrl+H)" aria-label="Replace in source"><ArrowsClockwiseIcon size={20} weight="bold" /></button>}
    <button className="search-icon" onClick={close} title="Close search (Esc)" aria-label="Close search"><XIcon size={20} weight="bold" /></button>
    {activeReplacing && onChange && <div className="search-replace"><input aria-label="Replacement text" placeholder="Replace with" value={replacement} onChange={e => setReplacement(e.target.value)} /><button disabled={!query || !!regexError || !count || index < 0} onClick={handleSingleReplace}>Replace</button><button disabled={!query || !!regexError || !count} onClick={handleReplaceAll}>Replace all</button><small>{regexError ? `${regexError}.` : regexp ? "Replaces regex matches in Markdown source ($1, $&, $$ supported)." : "Replaces literal text in Markdown source."}</small></div>}
  </aside>;
}
