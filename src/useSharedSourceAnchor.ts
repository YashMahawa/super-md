import { useEffect, useLayoutEffect, type RefObject } from "react";
import type { PortableEditorSession } from "./components/Editor";
import { cancelHeadingNavigation, navigateToHeading, resolveHeadingOffset } from "./documentNavigation";
import { invoke } from "./nativeBridge";
import type { NoteHistory } from "./noteHistory";
import { loadReadingLocation, saveReadingLocation, type ReadingLocation } from "./readingLocations";
import { exportRenderedViews } from "./renderedOutputs";
import { syncMountedNoteDisclosures } from "./disclosureState";
import { markScrollInput, scrollInputVersion } from "./scrollAnchor";
import { applySharedAnchor, captureSharedAnchor, clearProgrammaticAnchorScroll, detectSplitPaneFromTarget, hasExternalAnchorScroll, isProgrammaticAnchorScroll, primeEditorAnchor, revealEditorOffset, snapshotAnchorScroll, type AnchorScrollSnapshot, type AnchorViewMode, type SharedSourceAnchor, type SplitAnchorPane } from "./sourceAnchor";

export interface NoteView { editor?: PortableEditorSession; history?: NoteHistory; top?: number; anchor?: SharedSourceAnchor; rendered?: ReturnType<typeof exportRenderedViews> }
export interface PendingHeadingNavigation { heading: string; token: string }

export function parseImportedAnchor(raw: unknown): SharedSourceAnchor | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const candidate = raw as Record<string, unknown>;
  if (typeof candidate.offset !== "number" || !Number.isFinite(candidate.offset) || candidate.offset < 0) return undefined;
  if (typeof candidate.zoom !== "number" || !Number.isFinite(candidate.zoom) || candidate.zoom <= 0) return undefined;
  if (candidate.mode !== "reader" && candidate.mode !== "live" && candidate.mode !== "editor" && candidate.mode !== "split") return undefined;
  return {
    offset: candidate.offset,
    ...(typeof candidate.caretOffset === "number" && Number.isFinite(candidate.caretOffset) && candidate.caretOffset >= 0 ? { caretOffset: candidate.caretOffset } : {}),
    mode: candidate.mode,
    zoom: candidate.zoom,
    ...(typeof candidate.readingTop === "number" && Number.isFinite(candidate.readingTop) && candidate.readingTop >= 0 ? { readingTop: candidate.readingTop } : {}),
    ...(typeof candidate.editorTop === "number" && Number.isFinite(candidate.editorTop) && candidate.editorTop >= 0 ? { editorTop: candidate.editorTop } : {}),
  };
}

export interface SharedAnchorReaderState {
  id: string;
  content: string;
  path: string | null;
  mode: AnchorViewMode;
  fullscreen?: boolean;
  restorePosition?: boolean;
  readingLocation?: ReadingLocation | null;
  pendingHeading?: PendingHeadingNavigation | null;
}

export interface SharedSourceAnchorRefs {
  noteViews: RefObject<Map<string, NoteView>>;
  savePosition: RefObject<() => void>;
  modeAnchor: RefObject<SharedSourceAnchor | null>;
  splitPane: RefObject<SplitAnchorPane | null>;
  restoringSplit: RefObject<boolean>;
  restoringSplitSeq: RefObject<number>;
  splitScrollTops: RefObject<{ editor: number | null; preview: number | null }>;
  consumedHeadingToken: RefObject<string | null>;
  layoutNavigatedHeadingToken: RefObject<string | null>;
  suppressedRestoreToken: RefObject<string | null>;
  suppressedRestoreKey: RefObject<string | null>;
  suppressRestoreForSeed: RefObject<boolean>;
}

export function handoffSharedSourceAnchorOnLoad(options: {
  old: SharedAnchorReaderState | null;
  next: SharedAnchorReaderState;
  zoom: number;
  hasActiveSeedNavigation?: boolean;
  refs: Pick<SharedSourceAnchorRefs, "consumedHeadingToken" | "suppressedRestoreToken" | "savePosition" | "modeAnchor" | "splitPane">;
  onHistoryBoundary?: () => void;
}): { hasNewPendingHeading: boolean; unconsumedOldHeadingOffset: number | null } {
  const { old, next, zoom, hasActiveSeedNavigation = false, refs: { consumedHeadingToken, suppressedRestoreToken, savePosition, modeAnchor, splitPane }, onHistoryBoundary } = options;
  if (old?.id === next.id) next.readingLocation = old.readingLocation;
  if (hasActiveSeedNavigation && !next.pendingHeading && old?.id === next.id && old.pendingHeading?.token) {
    suppressedRestoreToken.current = old.pendingHeading.token;
    consumedHeadingToken.current = old.pendingHeading.token;
    document.querySelectorAll(".android-reading").forEach(cancelHeadingNavigation);
  }
  if (old?.id === next.id && !next.pendingHeading && old.pendingHeading && !hasActiveSeedNavigation) next.pendingHeading = old.pendingHeading;
  const hasNewPendingHeading = Boolean(next.pendingHeading?.token && next.pendingHeading.token !== old?.pendingHeading?.token);
  let unconsumedOldHeadingOffset: number | null = null;
  if (old && (old.id !== next.id || (old.mode !== next.mode && !hasActiveSeedNavigation)) && !hasNewPendingHeading && old.pendingHeading?.token && old.pendingHeading.token !== consumedHeadingToken.current) {
    consumedHeadingToken.current = old.pendingHeading.token;
    unconsumedOldHeadingOffset = resolveHeadingOffset(old.content, old.pendingHeading.heading);
    if (old.mode !== "editor") {
      const oldHost = document.querySelector<HTMLElement>(".android-reading");
      if (oldHost) navigateToHeading(oldHost, old.pendingHeading.heading);
    }
    if ((old.mode === "editor" || old.mode === "split") && unconsumedOldHeadingOffset !== null) {
      revealEditorOffset(old.id, unconsumedOldHeadingOffset, { caretOffset: unconsumedOldHeadingOffset });
    }
  }
  if (old && (old.id !== next.id || old.mode !== next.mode || old.fullscreen !== next.fullscreen)) {
    document.querySelectorAll(".android-reading").forEach(cancelHeadingNavigation);
  }
  if (old && (old.id !== next.id || old.mode !== next.mode)) onHistoryBoundary?.();
  if (old && old.id === next.id && old.mode !== next.mode) {
    if (hasNewPendingHeading) {
      modeAnchor.current = null; splitPane.current = null; primeEditorAnchor(next.id, null);
    } else {
      savePosition.current();
      const readingRoot = document.querySelector<HTMLElement>(".android-reading");
      const captured = captureSharedAnchor({ id: old.id, mode: old.mode, zoom, readingRoot, preferredSplitPane: splitPane.current });
      if (unconsumedOldHeadingOffset !== null && unconsumedOldHeadingOffset > 0 && captured.offset === 0) captured.offset = unconsumedOldHeadingOffset;
      modeAnchor.current = captured;
      splitPane.current = null;
      if (next.mode === "editor" || next.mode === "split") primeEditorAnchor(next.id, { offset: captured.offset, caretOffset: captured.caretOffset });
      else primeEditorAnchor(next.id, null);
    }
  }
  return { hasNewPendingHeading, unconsumedOldHeadingOffset };
}

export function snapshotOutgoingTabOrPathAnchor(options: {
  old: SharedAnchorReaderState | null;
  next: SharedAnchorReaderState;
  zoom: number;
  unconsumedOldHeadingOffset: number | null;
  refs: Pick<SharedSourceAnchorRefs, "noteViews" | "savePosition" | "modeAnchor" | "splitPane" | "suppressedRestoreKey">;
  onOutgoingTabSwitch?: () => void;
}): void {
  const { old, next, zoom, unconsumedOldHeadingOffset, refs: { noteViews, savePosition, modeAnchor, splitPane, suppressedRestoreKey }, onOutgoingTabSwitch } = options;
  if (old && old.id === next.id && old.mode !== next.mode) syncMountedNoteDisclosures(old.id);
  if (old && old.id !== next.id) {
    savePosition.current();
    const readingRoot = document.querySelector<HTMLElement>(".android-reading");
    const outgoingAnchor = captureSharedAnchor({ id: old.id, mode: old.mode, zoom, readingRoot, preferredSplitPane: splitPane.current });
    if (unconsumedOldHeadingOffset !== null && unconsumedOldHeadingOffset > 0 && outgoingAnchor.offset === 0) outgoingAnchor.offset = unconsumedOldHeadingOffset;
    noteViews.current.set(old.id, { top: outgoingAnchor.readingTop ?? 0, anchor: outgoingAnchor, rendered: exportRenderedViews(old.content, old.id) });
    if (noteViews.current.size > 40) noteViews.current.delete(noteViews.current.keys().next().value!);
    if (suppressedRestoreKey.current?.startsWith(`${old.id}:`)) suppressedRestoreKey.current = null;
    onOutgoingTabSwitch?.();
    modeAnchor.current = null; splitPane.current = null;
  }
  if (old && old.id === next.id && old.path !== next.path && next.restorePosition !== false) {
    savePosition.current();
    const oldPath = old.path === old.id ? null : old.path, nextPath = next.path === next.id ? null : next.path;
    if (nextPath) {
      const snap = captureSharedAnchor({ id: old.id, mode: old.mode, zoom, readingRoot: document.querySelector<HTMLElement>(".android-reading"), preferredSplitPane: splitPane.current });
      const location = loadReadingLocation(oldPath) ?? { top: old.mode === "editor" ? (snap.editorTop ?? 0) : (snap.readingTop ?? 0), offset: snap.offset, zoom, mode: old.mode };
      saveReadingLocation(nextPath, location);
      void invoke("reading_position", { id: next.id, location }).catch(() => {});
    }
  }
}

const ANCHOR_SETTLE_INPUTS = ["wheel", "touchstart", "keydown", "pointerdown", "supermd-goto-offset"] as const;
const ANCHOR_SETTLE_DELAYS = [120, 320, 700] as const;

export interface SettleSharedSourceAnchorOptions {
  id: string;
  targetMode: AnchorViewMode;
  getTargetZoom: () => number;
  anchor: SharedSourceAnchor;
  allowExactTop: boolean;
  readingSelector: string;
  getReadingRoot: () => HTMLElement | null;
  shouldStop: () => boolean;
  onExternalScroll?: (target: HTMLElement) => void;
  runApplyPass?: (execute: () => AnchorScrollSnapshot | null) => void;
  onSecondFrameSettled?: () => void;
  onCleanup?: () => void;
  delays?: readonly number[];
}

// Views settle over several frames (editor mount, zoom geometry, lazy math and
// fonts). Re-apply the shared source anchor until stable, and stop immediately
// when the person scrolls, types or opens search/live edit.
export function settleSharedSourceAnchor({
  id, targetMode, getTargetZoom, anchor, allowExactTop, readingSelector, getReadingRoot,
  shouldStop, onExternalScroll, runApplyPass, onSecondFrameSettled, onCleanup, delays = ANCHOR_SETTLE_DELAYS,
}: SettleSharedSourceAnchorOptions): () => void {
  let stopped = false, applying = false;
  const stop = () => { stopped = true; };
  let readingSnapshot: AnchorScrollSnapshot | null = null;
  const commitExternalScroll = (target: HTMLElement) => {
    clearProgrammaticAnchorScroll(target);
    stopped = true;
    onExternalScroll?.(target);
  };
  const onScroll = (event: Event) => {
    const target = event.target;
    if (!applying && target instanceof HTMLElement && target.matches(readingSelector) && target === readingSnapshot?.element && hasExternalAnchorScroll(readingSnapshot)) {
      commitExternalScroll(target);
    }
  };
  ANCHOR_SETTLE_INPUTS.forEach(name => window.addEventListener(name, stop, { capture: true, passive: true }));
  window.addEventListener("scroll", onScroll, { capture: true, passive: true });
  let firstPass = true;
  const apply = () => {
    if (stopped) return;
    if (readingSnapshot && hasExternalAnchorScroll(readingSnapshot)) { commitExternalScroll(readingSnapshot.element); return; }
    if (shouldStop()) { stopped = true; return; }
    const updateSelection = firstPass; firstPass = false; applying = true;
    const execute = () => {
      const readingRoot = getReadingRoot();
      const targetZoom = getTargetZoom();
      const effectiveAllowExactTop = allowExactTop && !(Boolean(readingRoot?.querySelector('[data-windowed-mounted="false"]')) && anchor.offset > 0);
      applySharedAnchor({ id, targetMode, targetZoom, anchor, readingRoot, allowExactTop: effectiveAllowExactTop, updateSelection });
      const requestedReadingTop = effectiveAllowExactTop && anchor.mode === targetMode && Math.abs(anchor.zoom - targetZoom) < 1 ? anchor.readingTop : undefined;
      readingSnapshot = snapshotAnchorScroll(readingRoot, requestedReadingTop);
      return readingSnapshot;
    };
    try {
      if (runApplyPass) runApplyPass(execute);
      else execute();
    } finally { applying = false; }
  };
  apply();
  let innerFrame = 0;
  const outerFrame = requestAnimationFrame(() => {
    apply();
    innerFrame = requestAnimationFrame(() => {
      apply();
      if (onSecondFrameSettled && !stopped && !shouldStop()) onSecondFrameSettled();
    });
  });
  const timers = delays.map(delay => window.setTimeout(apply, delay));
  return () => {
    stopped = true;
    onCleanup?.();
    cancelAnimationFrame(outerFrame); cancelAnimationFrame(innerFrame); timers.forEach(window.clearTimeout);
    ANCHOR_SETTLE_INPUTS.forEach(name => window.removeEventListener(name, stop, { capture: true }));
    window.removeEventListener("scroll", onScroll, { capture: true });
  };
}

export interface UseSharedSourceAnchorOptions {
  state: SharedAnchorReaderState | null;
  reference: RefObject<SharedAnchorReaderState | null>;
  zoomReference: RefObject<number>;
  refs: SharedSourceAnchorRefs;
}

export function useSharedSourceAnchor({ state, reference, zoomReference, refs }: UseSharedSourceAnchorOptions): void {
  const {
    noteViews, savePosition, modeAnchor, splitPane, restoringSplit, restoringSplitSeq,
    splitScrollTops, consumedHeadingToken, layoutNavigatedHeadingToken, suppressedRestoreToken, suppressedRestoreKey, suppressRestoreForSeed,
  } = refs;

  useEffect(() => {
    const trackInput = (event: Event) => {
      if (reference.current?.mode !== "split") return;
      const pane = detectSplitPaneFromTarget(event.target);
      if (pane) {
        clearProgrammaticAnchorScroll(pane === "editor" ? document.querySelector(".cm-scroller") : document.querySelector(".android-reading"));
        splitPane.current = pane;
      }
    };
    const trackScroll = (event: Event) => {
      if (reference.current?.mode !== "split" || restoringSplit.current) return;
      const pane = detectSplitPaneFromTarget(event.target);
      if (!pane || !(event.target instanceof HTMLElement) || isProgrammaticAnchorScroll(event.target)) return;
      const recorded = splitScrollTops.current[pane];
      if (recorded !== null && Math.abs(event.target.scrollTop - recorded) <= 2) return;
      splitScrollTops.current[pane] = event.target.scrollTop;
      splitPane.current = pane;
    };
    const inputEvents = ["wheel", "pointerdown", "touchstart", "keydown", "focusin"] as const;
    inputEvents.forEach(name => document.addEventListener(name, trackInput, { capture: true, passive: true }));
    document.addEventListener("scroll", trackScroll, { capture: true, passive: true });
    return () => {
      inputEvents.forEach(name => document.removeEventListener(name, trackInput, true));
      document.removeEventListener("scroll", trackScroll, true);
    };
  }, []);

  useLayoutEffect(() => {
    if (!state) return;
    if (state.pendingHeading?.token && state.pendingHeading.token !== suppressedRestoreToken.current) {
      suppressedRestoreToken.current = state.pendingHeading.token;
      suppressedRestoreKey.current = `${state.id}:${state.mode}`;
      noteViews.current.delete(state.id);
      modeAnchor.current = null;
      if (state.mode === "editor" || state.mode === "split") {
        const headingOffset = resolveHeadingOffset(state.content, state.pendingHeading.heading);
        if (headingOffset !== null) {
          if (state.mode === "split") splitPane.current = "preview";
          primeEditorAnchor(state.id, { offset: headingOffset, caretOffset: headingOffset });
        } else primeEditorAnchor(state.id, null);
      } else primeEditorAnchor(state.id, null);
      markScrollInput();
      const host = state.mode !== "editor" ? document.querySelector<HTMLElement>(".android-reading") : null;
      if (host && !host.querySelector('[data-windowed-mounted="false"]')) {
        navigateToHeading(host, state.pendingHeading.heading);
        layoutNavigatedHeadingToken.current = state.pendingHeading.token;
      }
      return;
    }
    const startingInput = scrollInputVersion(), initialContent = state.content;
    const hadSearchOverlayAtStart = Boolean(document.querySelector(".reading-search,.cm-search"));
    const hasDocumentSelection = () => {
      const sel = window.getSelection();
      if (!sel || !sel.toString()) return false;
      const active = document.activeElement;
      if (active instanceof Element && active.closest(".reading-search,.cm-search")) return false;
      const anchorEl = sel.anchorNode instanceof Element ? sel.anchorNode : sel.anchorNode?.parentElement;
      if (anchorEl?.closest(".reading-search,.cm-search")) return false;
      return true;
    };
    const shouldStop = () =>
      reference.current?.id !== state.id || reference.current?.mode !== state.mode || reference.current?.content !== initialContent ||
      scrollInputVersion() !== startingInput || hasDocumentSelection() ||
      Boolean(document.querySelector(".live-active-block")) ||
      (!hadSearchOverlayAtStart && Boolean(document.querySelector(".reading-search,.cm-search")));
    const runGuarded = (execute: () => AnchorScrollSnapshot | null) => {
      if (state.mode === "split") {
        const seq = ++restoringSplitSeq.current;
        restoringSplit.current = true;
        const snapshot = execute();
        splitScrollTops.current = {
          editor: document.querySelector<HTMLElement>(".cm-scroller")?.scrollTop ?? null,
          preview: snapshot?.top ?? null,
        };
        requestAnimationFrame(() => { if (restoringSplitSeq.current === seq) restoringSplit.current = false; });
      } else {
        splitScrollTops.current = { editor: null, preview: null };
        execute();
      }
    };
    const settleAnchor = (anchor: SharedSourceAnchor, allowExactTop: boolean) =>
      settleSharedSourceAnchor({
        id: state.id,
        targetMode: state.mode,
        getTargetZoom: () => zoomReference.current,
        anchor,
        allowExactTop,
        readingSelector: ".android-reading",
        getReadingRoot: () => document.querySelector<HTMLElement>(".android-reading"),
        shouldStop,
        onExternalScroll: (target) => {
          if (reference.current?.mode === "split") {
            restoringSplit.current = false;
            splitScrollTops.current.preview = target.scrollTop;
            splitPane.current = "preview";
          }
        },
        runApplyPass: runGuarded,
      });
    if (modeAnchor.current !== null) {
      suppressedRestoreKey.current = null;
      const anchor = modeAnchor.current; modeAnchor.current = null;
      if (state.mode === "editor" || state.mode === "split") primeEditorAnchor(state.id, { offset: anchor.offset, caretOffset: anchor.caretOffset });
      else primeEditorAnchor(state.id, null);
      return settleAnchor(anchor, false);
    }
    if (suppressRestoreForSeed.current) {
      suppressRestoreForSeed.current = false;
      suppressedRestoreKey.current = null;
      primeEditorAnchor(state.id, null);
      return;
    }
    if (suppressedRestoreKey.current === `${state.id}:${state.mode}`) return;
    suppressedRestoreKey.current = null;
    const cachedView = noteViews.current.get(state.id);
    const saved = state.restorePosition !== false ? (state.readingLocation ?? loadReadingLocation(state.path === state.id ? null : state.path)) : undefined;
    const savedMode: AnchorViewMode = saved?.mode === "editor" || saved?.mode === "live" || saved?.mode === "split" ? saved.mode : "reader";
    const resolvedAnchor: SharedSourceAnchor | undefined = cachedView?.anchor
      ?? (cachedView?.top !== undefined ? { offset: 0, mode: state.mode, zoom: zoomReference.current, readingTop: cachedView.top } : undefined)
      ?? (saved ? { offset: saved.offset, mode: savedMode, zoom: saved.zoom, ...(savedMode === "editor" ? { editorTop: saved.top } : { readingTop: saved.top }) } : undefined);
    if (!resolvedAnchor) {
      primeEditorAnchor(state.id, null);
      const host = document.querySelector<HTMLElement>(".android-reading");
      if (host) host.scrollTop = 0;
      return;
    }
    if (state.mode === "editor" || state.mode === "split") {
      const sameGeometry = resolvedAnchor.mode === state.mode && Math.abs(resolvedAnchor.zoom - zoomReference.current) < 1;
      if (sameGeometry && resolvedAnchor.editorTop !== undefined) primeEditorAnchor(state.id, { offset: resolvedAnchor.offset, top: resolvedAnchor.editorTop });
      else primeEditorAnchor(state.id, { offset: resolvedAnchor.offset, caretOffset: resolvedAnchor.caretOffset });
    } else primeEditorAnchor(state.id, null);
    return settleAnchor(resolvedAnchor, true);
  }, [state?.id, state?.mode, state?.pendingHeading?.token]);

  useEffect(() => {
    if (!state?.pendingHeading?.token || state.pendingHeading.token === consumedHeadingToken.current) return;
    consumedHeadingToken.current = state.pendingHeading.token;
    const startingInput = scrollInputVersion(), targetHeading = state.pendingHeading.heading;
    const offset = state.mode === "editor" || state.mode === "split" ? resolveHeadingOffset(state.content, targetHeading) : null;
    let stopped = false;
    const stop = () => { stopped = true; };
    ANCHOR_SETTLE_INPUTS.forEach(name => window.addEventListener(name, stop, { capture: true, passive: true }));
    const applyEditorJump = (focusEditor: boolean) => {
      if (stopped || scrollInputVersion() !== startingInput || offset === null) return;
      if (state.mode === "split") { splitPane.current = "preview"; revealEditorOffset(state.id, offset, { caretOffset: offset }); }
      else revealEditorOffset(state.id, offset, { caretOffset: offset, focus: focusEditor });
    };
    let innerFrame = 0, outerFrame = 0;
    if (state.mode === "editor" || state.mode === "split") {
      applyEditorJump(state.mode === "editor");
      outerFrame = requestAnimationFrame(() => { applyEditorJump(false); innerFrame = requestAnimationFrame(() => applyEditorJump(false)); });
    }
    const host = state.mode !== "editor" ? document.querySelector<HTMLElement>(".android-reading") : null;
    if (host && layoutNavigatedHeadingToken.current !== state.pendingHeading.token) navigateToHeading(host, targetHeading);
    const timers = (state.mode === "editor" || state.mode === "split") ? [120, 320].map(delay => window.setTimeout(() => applyEditorJump(false), delay)) : [];
    const cleanupTimer = window.setTimeout(() => ANCHOR_SETTLE_INPUTS.forEach(name => window.removeEventListener(name, stop, { capture: true })), 400);
    return () => {
      stopped = true; cancelAnimationFrame(outerFrame); cancelAnimationFrame(innerFrame);
      timers.forEach(window.clearTimeout); window.clearTimeout(cleanupTimer);
      ANCHOR_SETTLE_INPUTS.forEach(name => window.removeEventListener(name, stop, { capture: true }));
    };
  }, [state?.id, state?.mode, state?.pendingHeading?.token]);

  useEffect(() => {
    if (!state || state.restorePosition === false) return;
    const path = state.path === state.id ? null : state.path; if (!path) return;
    const roots = Array.from(document.querySelectorAll<HTMLElement>(".android-reading,.cm-scroller"));
    if (!roots.length) return;
    let timer = 0;
    const save = () => {
      if (reference.current?.id !== state.id || reference.current?.mode !== state.mode) return;
      if (!roots.some(node => node.isConnected)) return;
      const snap = captureSharedAnchor({ id: state.id, mode: state.mode, zoom: zoomReference.current, readingRoot: document.querySelector<HTMLElement>(".android-reading"), preferredSplitPane: splitPane.current });
      const location: ReadingLocation = { top: Math.max(0, state.mode === "editor" ? (snap.editorTop ?? 0) : (snap.readingTop ?? 0)), offset: snap.offset, zoom: zoomReference.current, mode: state.mode };
      saveReadingLocation(path, location);
      void invoke("reading_position", { id: state.id, location }).catch(() => {});
    };
    const scroll = () => { window.clearTimeout(timer); timer = window.setTimeout(save, 900); };
    savePosition.current = save;
    roots.forEach(node => node.addEventListener("scroll", scroll, { passive: true }));
    window.addEventListener("pagehide", save); document.addEventListener("visibilitychange", save);
    scroll();
    return () => {
      window.clearTimeout(timer); save();
      roots.forEach(node => node.removeEventListener("scroll", scroll));
      window.removeEventListener("pagehide", save); document.removeEventListener("visibilitychange", save);
      savePosition.current = () => {};
    };
  }, [state?.id, state?.mode, state?.path, state?.restorePosition]);
}
