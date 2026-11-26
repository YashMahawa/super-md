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
  mapSourceRangeToDomRange,
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
  const settleFrames = useRef<[number, number]>([0, 0]);
  const clearSettleFrames = () => {
    cancelAnimationFrame(settleFrames.current[0]);
    cancelAnimationFrame(settleFrames.current[1]);
    settleFrames.current = [0, 0];
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
    const domRange = mapSourceRangeToDomRange(block, sourceText, ranges, targetIndex, query, filterOptions);
    if (scroll) {
      openDisclosuresFor(owner, block, domRange, range);
      const scrollEl = domRange ? (domRange.startContainer.nodeType === Node.ELEMENT_NODE ? domRange.startContainer as Element : domRange.startContainer.parentElement) : owner;
      scrollTargetIntoView(scrollEl ?? block, host);
    }
    syncSearchHighlights({
      all: wasUnmounted || scroll ? () => readingMatches(host, query, filterOptions) : undefined,
      current: domRange,
    });
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
    syncSearchHighlights({
      all: () => readingMatches(host ?? match.element, query, filterOptions),
      current: range,
    });
    settleFrames.current[0] = requestAnimationFrame(() => {
      settleFrames.current[1] = requestAnimationFrame(() => {
        settleFrames.current = [0, 0];
        if (indexRef.current !== next || !match.element.isConnected) return;
        const liveHost = findReadingHost();
        const liveRange = readingMatches(match.element, query, filterOptions)[match.ordinal] ?? null;
        openDisclosuresFor(match.element, match.element, liveRange);
        const liveScrollEl = liveRange ? (liveRange.startContainer.nodeType === Node.ELEMENT_NODE ? liveRange.startContainer as Element : liveRange.startContainer.parentElement) : match.element;
        scrollTargetIntoView(liveScrollEl ?? match.element, liveHost);
        syncSearchHighlights({
          all: () => readingMatches(liveHost ?? match.element, query, filterOptions),
          current: liveRange,
        });
      });
    });
  };

  const selectDomMatch = (next: number, activeMatches: Range[], host: HTMLElement | null) => {
    const range = activeMatches[next];
    if (!range) return;
    const element = range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer as Element : range.startContainer.parentElement;
    openDisclosuresFor(element, element?.closest(".code-container,details") ?? element, range);
    scrollTargetIntoView(element, host);
    updateIndex(next);
    syncSearchHighlights({ current: range });
  };

  const toggleReplacing = (nextReplacing = !activeReplacing) => {
    if (!canReplaceRef.current || nextReplacing === activeReplacing) return;
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
      syncSearchHighlights({ all: null, current: null });
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
    <input ref={input} aria-label="Find in note" aria-invalid={!!regexError || undefined} role="searchbox" type="text" inputMode="search" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="Find in this note" value={query} onChange={event => { pendingAutoSelect.current = false; setQuery(event.target.value); }} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); move(event.shiftKey ? -1 : 1); } }} />
    <output aria-live="polite" className={regexError ? "search-error" : undefined} title={regexError ? regexError : count >= 5000 ? "Showing the first 5,000 matches. Narrow your search to find later results." : undefined}>{regexError ? regexError : count ? `${index < 0 ? 0 : index + 1} / ${count}${count >= 5000 ? "+" : ""}` : query ? "No matches" : ""}</output>
    <button className="search-icon" aria-label="Previous match" disabled={!count} onClick={() => move(-1)} title="Previous match (Shift+Enter / Shift+F3)"><ArrowUpIcon size={20} weight="bold" /></button>
    <button className="search-icon" aria-label="Next match" disabled={!count} onClick={() => move(1)} title="Next match (Enter / F3)"><ArrowDownIcon size={20} weight="bold" /></button>
    <button className="search-icon" aria-pressed={caseSensitive} onClick={() => { pendingAutoSelect.current = false; setCaseSensitive(!caseSensitive); }} title="Match case" aria-label="Match case"><TextAaIcon size={20} weight="bold" /></button>
    <button className="search-icon" aria-pressed={wholeWord} onClick={() => { pendingAutoSelect.current = false; setWholeWord(!wholeWord); }} title="Match whole word" aria-label="Match whole word"><TextboxIcon size={20} weight="bold" /></button>
    <button className="search-icon" aria-pressed={regexp} onClick={() => { pendingAutoSelect.current = false; setRegexp(!regexp); }} title="Regular expression" aria-label="Regular expression"><AsteriskIcon size={20} weight="bold" /></button>
    {canReplace && <button className="search-icon" aria-pressed={activeReplacing} onClick={() => toggleReplacing()} title="Replace in source (Ctrl+H)" aria-label="Replace in source"><ArrowsClockwiseIcon size={20} weight="bold" /></button>}
    <button className="search-icon" onClick={close} title="Close search (Esc)" aria-label="Close search"><XIcon size={20} weight="bold" /></button>
    {activeReplacing && onChange && <div className="search-replace"><input aria-label="Replacement text" placeholder="Replace with" value={replacement} onChange={e => setReplacement(e.target.value)} /><button disabled={!query || !!regexError || !count || index < 0} onClick={handleSingleReplace}>Replace</button><button disabled={!query || !!regexError || !count} onClick={handleReplaceAll}>Replace all</button><small>{regexError ? `${regexError}.` : regexp ? "Replaces regex matches in Markdown source ($1, $&, $$ supported)." : "Replaces literal text in Markdown source."}</small></div>}
  </aside>;
}
