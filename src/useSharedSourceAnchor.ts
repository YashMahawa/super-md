import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import type { PortableEditorSession } from "./components/Editor";
import { navigateToHeading, resolveHeadingOffset } from "./documentNavigation";
import { invoke } from "./nativeBridge";
import type { NoteHistory } from "./noteHistory";
import { loadReadingLocation, saveReadingLocation, type ReadingLocation } from "./readingLocations";
import type { exportRenderedViews } from "./renderedOutputs";
import { markScrollInput, scrollInputVersion } from "./scrollAnchor";
import { applySharedAnchor, captureSharedAnchor, clearProgrammaticAnchorScroll, detectSplitPaneFromTarget, isProgrammaticAnchorScroll, primeEditorAnchor, revealEditorOffset, type AnchorViewMode, type SharedSourceAnchor, type SplitAnchorPane } from "./sourceAnchor";

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

export interface SharedSourceAnchorRefs {
  noteViews: RefObject<Map<string, NoteView>>;
  savePosition: RefObject<() => void>;
  modeAnchor: RefObject<SharedSourceAnchor | null>;
  splitPane: RefObject<SplitAnchorPane | null>;
  suppressedRestoreKey: RefObject<string | null>;
}

export function useSharedSourceAnchorRefs(): SharedSourceAnchorRefs {
  return {
    noteViews: useRef(new Map<string, NoteView>()),
    savePosition: useRef(() => {}),
    modeAnchor: useRef<SharedSourceAnchor | null>(null),
    splitPane: useRef<SplitAnchorPane | null>(null),
    suppressedRestoreKey: useRef<string | null>(null),
  };
}

export interface SharedAnchorReaderState { id: string; content: string; path: string | null; mode: AnchorViewMode; restorePosition?: boolean; readingLocation?: ReadingLocation | null; pendingHeading?: PendingHeadingNavigation | null }
export interface UseSharedSourceAnchorOptions { state: SharedAnchorReaderState | null; reference: RefObject<SharedAnchorReaderState | null>; zoomReference: RefObject<number>; refs: SharedSourceAnchorRefs }

const ANCHOR_SETTLE_INPUTS = ["wheel", "touchstart", "keydown", "pointerdown", "supermd-goto-offset"] as const;
const ANCHOR_SETTLE_DELAYS = [120, 320, 700] as const;

export function useSharedSourceAnchor({ state, reference, zoomReference, refs }: UseSharedSourceAnchorOptions): void {
  const { noteViews, savePosition, modeAnchor, splitPane, suppressedRestoreKey } = refs;
  const consumedHeadingToken = useRef<string | null>(null);
  const suppressedRestoreToken = useRef<string | null>(null);
  const restoringSplit = useRef(false);
  const restoringSplitSeq = useRef(0);
  const splitScrollTops = useRef<{ editor: number | null; preview: number | null }>({ editor: null, preview: null });

  useEffect(() => {
    const trackInput = (event: Event) => {
      if (reference.current?.mode !== "split") return;
      const pane = detectSplitPaneFromTarget(event.target);
      if (pane) {
        const scroller = pane === "editor" ? document.querySelector(".cm-scroller") : document.querySelector(".android-reading");
        clearProgrammaticAnchorScroll(scroller);
        splitPane.current = pane;
      }
    };
    const trackScroll = (event: Event) => {
      if (reference.current?.mode !== "split" || restoringSplit.current) return;
      const pane = detectSplitPaneFromTarget(event.target);
      if (!pane || !(event.target instanceof HTMLElement)) return;
      if (isProgrammaticAnchorScroll(event.target)) return;
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
        } else {
          primeEditorAnchor(state.id, null);
        }
      } else {
        primeEditorAnchor(state.id, null);
      }
      markScrollInput();
      const host = state.mode !== "editor" ? document.querySelector<HTMLElement>(".android-reading") : null;
      if (host && !host.querySelector('[data-windowed-mounted="false"]')) {
        navigateToHeading(host, state.pendingHeading.heading);
      }
      return;
    }
    const startingInput = scrollInputVersion();
    const initialContent = state.content;
    const shouldStop = () =>
      reference.current?.id !== state.id ||
      reference.current?.mode !== state.mode ||
      reference.current?.content !== initialContent ||
      scrollInputVersion() !== startingInput ||
      Boolean(window.getSelection()?.toString()) ||
      Boolean(document.querySelector(".reading-search,.cm-search,.live-active-block"));
    const runGuarded = (fn: () => void) => {
      if (state.mode === "split") {
        const seq = ++restoringSplitSeq.current;
        restoringSplit.current = true;
        fn();
        splitScrollTops.current = {
          editor: document.querySelector<HTMLElement>(".cm-scroller")?.scrollTop ?? null,
          preview: document.querySelector<HTMLElement>(".android-reading")?.scrollTop ?? null,
        };
        requestAnimationFrame(() => { if (restoringSplitSeq.current === seq) restoringSplit.current = false; });
      } else {
        splitScrollTops.current = { editor: null, preview: null };
        fn();
      }
    };
    // The new view settles over several frames (editor mount, zoom geometry,
    // lazy math and fonts). Re-apply the source anchor until it is stable,
    // and stop as soon as the person scrolls, types or opens search/live edit.
    const settleAnchor = (anchor: SharedSourceAnchor, allowExactTop: boolean) => {
      let stopped = false;
      const stop = () => { stopped = true; };
      ANCHOR_SETTLE_INPUTS.forEach(name => window.addEventListener(name, stop, { capture: true, passive: true }));
      let firstPass = true;
      const apply = () => {
        if (stopped || shouldStop()) return;
        const updateSelection = firstPass;
        firstPass = false;
        runGuarded(() => {
          applySharedAnchor({
            id: state.id,
            targetMode: state.mode,
            targetZoom: zoomReference.current,
            anchor,
            readingRoot: document.querySelector<HTMLElement>(".android-reading"),
            allowExactTop,
            updateSelection,
          });
        });
      };
      apply();
      let innerFrame = 0;
      const outerFrame = requestAnimationFrame(() => { apply(); innerFrame = requestAnimationFrame(apply); });
      const timers = ANCHOR_SETTLE_DELAYS.map(delay => window.setTimeout(apply, delay));
      return () => {
        stopped = true;
        cancelAnimationFrame(outerFrame);
        cancelAnimationFrame(innerFrame);
        timers.forEach(window.clearTimeout);
        ANCHOR_SETTLE_INPUTS.forEach(name => window.removeEventListener(name, stop, { capture: true }));
      };
    };
    if (modeAnchor.current !== null) {
      suppressedRestoreKey.current = null;
      const anchor = modeAnchor.current; modeAnchor.current = null;
      if (state.mode === "editor" || state.mode === "split") {
        primeEditorAnchor(state.id, { offset: anchor.offset, caretOffset: anchor.caretOffset });
      } else {
        primeEditorAnchor(state.id, null);
      }
      return settleAnchor(anchor, false);
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
      if (sameGeometry && resolvedAnchor.editorTop !== undefined) {
        primeEditorAnchor(state.id, { offset: resolvedAnchor.offset, top: resolvedAnchor.editorTop });
      } else {
        primeEditorAnchor(state.id, { offset: resolvedAnchor.offset, caretOffset: resolvedAnchor.caretOffset });
      }
    } else {
      primeEditorAnchor(state.id, null);
    }
    return settleAnchor(resolvedAnchor, true);
  }, [state?.id, state?.mode, state?.pendingHeading?.token]);

  useEffect(() => {
    if (!state?.pendingHeading?.token || state.pendingHeading.token === consumedHeadingToken.current) return;
    consumedHeadingToken.current = state.pendingHeading.token;
    const startingInput = scrollInputVersion();
    const targetHeading = state.pendingHeading.heading;
    const offset = state.mode === "editor" || state.mode === "split" ? resolveHeadingOffset(state.content, targetHeading) : null;
    let stopped = false;
    const stop = () => { stopped = true; };
    ANCHOR_SETTLE_INPUTS.forEach(name => window.addEventListener(name, stop, { capture: true, passive: true }));
    const applyEditorJump = (focusEditor: boolean) => {
      if (stopped || scrollInputVersion() !== startingInput || offset === null) return;
      if (state.mode === "split") {
        splitPane.current = "preview";
        revealEditorOffset(state.id, offset, { caretOffset: offset });
      } else {
        revealEditorOffset(state.id, offset, { caretOffset: offset, focus: focusEditor });
      }
    };
    let innerFrame = 0;
    let outerFrame = 0;
    if (state.mode === "editor" || state.mode === "split") {
      applyEditorJump(state.mode === "editor");
      outerFrame = requestAnimationFrame(() => {
        applyEditorJump(false);
        innerFrame = requestAnimationFrame(() => applyEditorJump(false));
      });
    }
    const host = state.mode !== "editor" ? document.querySelector<HTMLElement>(".android-reading") : null;
    if (host) navigateToHeading(host, targetHeading);
    const timers = (state.mode === "editor" || state.mode === "split")
      ? [120, 320].map(delay => window.setTimeout(() => applyEditorJump(false), delay))
      : [];
    const cleanupTimer = window.setTimeout(() => ANCHOR_SETTLE_INPUTS.forEach(name => window.removeEventListener(name, stop, { capture: true })), 400);
    return () => {
      stopped = true;
      cancelAnimationFrame(outerFrame);
      cancelAnimationFrame(innerFrame);
      timers.forEach(window.clearTimeout);
      window.clearTimeout(cleanupTimer);
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
      if (!roots.some(node => node.isConnected)) return;
      const snap = captureSharedAnchor({
        id: state.id,
        mode: state.mode,
        zoom: zoomReference.current,
        readingRoot: document.querySelector<HTMLElement>(".android-reading"),
        preferredSplitPane: splitPane.current,
      });
      const location: ReadingLocation = {
        top: Math.max(0, state.mode === "editor" ? (snap.editorTop ?? 0) : (snap.readingTop ?? 0)),
        offset: snap.offset,
        zoom: zoomReference.current,
        mode: state.mode,
      };
      saveReadingLocation(path, location);
      void invoke("reading_position", { id: state.id, location }).catch(() => {});
    };
    const scroll = () => { window.clearTimeout(timer); timer = window.setTimeout(save, 900); };
    savePosition.current = save;
    roots.forEach(node => node.addEventListener("scroll", scroll, { passive: true }));
    window.addEventListener("pagehide", save); document.addEventListener("visibilitychange", save);
    // A native/heading jump can finish before this passive effect subscribes.
    // Persist its settled viewport too, even if no later scroll event arrives.
    scroll();
    return () => {
      window.clearTimeout(timer); save();
      roots.forEach(node => node.removeEventListener("scroll", scroll));
      window.removeEventListener("pagehide", save); document.removeEventListener("visibilitychange", save);
      savePosition.current = () => {};
    };
  }, [state?.id, state?.mode, state?.path, state?.restorePosition]);
}
