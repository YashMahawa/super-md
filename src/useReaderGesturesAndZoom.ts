import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { createGapSelection, type GapSelection } from "./gapSelection";
import { FrameScrollQueue, zoomFrameStep } from "./frameMotion";
import { applyChainedNativeScroll, NON_VIEWER_OVERLAY_SELECTOR, resolveNativeWheelScrollOrigin } from "./nativeWheelScroll";
import type { Point } from "./focalZoom";
import { applyDocumentZoom, documentPoint, enforceDocumentCenter, invalidateDocumentZoom, refreshDocumentExtent, settleDocumentZoom } from "./documentZoom";
import { cancelHeadingNavigation, readingKeyboardScrollDelta } from "./documentNavigation";
import { invoke } from "./nativeBridge";
import { captureScrollAnchor, markScrollInput } from "./scrollAnchor";
import { clearProgrammaticAnchorScroll, detectSplitPaneFromTarget, type AnchorViewMode, type SplitAnchorPane } from "./sourceAnchor";
import { rememberWindowedScrollSource } from "./windowedSearch";
import { clampPreviewZoom } from "./zoom";

export interface GesturesReaderState { id: string; content: string; mode: AnchorViewMode; fullscreen: boolean; widthPercent?: number; centerLock?: boolean }
export interface UseReaderGestureControlsOptions { reference: RefObject<GesturesReaderState | null>; splitPane: RefObject<SplitAnchorPane | null> }

export function useReaderGestureControls({ reference, splitPane }: UseReaderGestureControlsOptions) {
  const zoomReference = useRef(100), zoomGestureAt = useRef(0), cursor = useRef<Point | undefined>(undefined);
  const zoomFrame = useRef(0), zoomTimer = useRef(0), zoomFocus = useRef<Point | undefined>(undefined), zoomTarget = useRef<number | null>(null);
  const zoomAnchors = useRef<{ focus?: Point; points: Map<HTMLElement, Point | null> }>({ points: new Map() });
  const zoomFrameTime = useRef(0), settleTimer = useRef(0), selectingText = useRef(false), gapSelection = useRef<GapSelection | null>(null);
  const chromeRequestAt = useRef(0), chromeLastAction = useRef<string | undefined>(undefined);
  const requestChrome = (action: "show" | "hide" | "toggle") => {
    if (document.documentElement.dataset.host !== "qt" || !reference.current?.fullscreen) return;
    if (action !== "toggle" && action === chromeLastAction.current && performance.now() - chromeRequestAt.current < 80) return;
    chromeRequestAt.current = performance.now(); chromeLastAction.current = action; void invoke("reader_chrome", { action });
  };
  const nativeScroll = useRef<FrameScrollQueue | null>(null);
  if (!nativeScroll.current) {
    nativeScroll.current = new FrameScrollQueue((scroller, dx, dy) => {
      applyChainedNativeScroll(scroller, dx, dy, {
        centerLock: Boolean(reference.current?.centerLock),
        onReadingScroll: (reading, attemptedDy) => { cancelHeadingNavigation(reading); rememberWindowedScrollSource(reading, attemptedDy); if (Math.abs(attemptedDy) > 2) requestChrome("hide"); },
      });
    });
  }
  const settleSelection = () => {
    window.clearTimeout(settleTimer.current);
    if (document.documentElement.dataset.platform !== "android") return;
    settleTimer.current = window.setTimeout(() => {
      // Touch handles need settled layout geometry at rest. Never change layout
      // geometry mid-drag; desktop selection stays on its compositor geometry.
      if (!selectingText.current) document.querySelectorAll<HTMLElement>(".android-reading").forEach(settleDocumentZoom);
    }, 240);
  };
  const anchors = (focus?: Point) => Array.from(document.querySelectorAll<HTMLElement>(".android-reading,.cm-scroller")).filter(root => { const r = root.getBoundingClientRect(); return !focus || (focus.x >= r.left && focus.x <= r.right && focus.y >= r.top && focus.y <= r.bottom); }).map(root => captureScrollAnchor(root, focus));
  const applyZoomStyle = (focus?: Point, previousFocus = focus, anchorPoints?: Map<HTMLElement, Point | null>) => {
    document.querySelector<HTMLElement>(".android-source")?.style.setProperty("--workspace-scale", String(zoomReference.current / 100));
    document.querySelectorAll<HTMLElement>(".android-reading").forEach(root => applyDocumentZoom(root, zoomReference.current, reference.current?.widthPercent ?? 90, focus, previousFocus, anchorPoints?.get(root), reference.current?.centerLock === true));
  };
  const anchored = (update: () => void) => { const restore = anchors(); update(); requestAnimationFrame(() => restore.forEach(callback => callback())); };
  const cancelZoomGlide = () => { window.clearTimeout(zoomTimer.current); cancelAnimationFrame(zoomFrame.current); zoomFrame.current = 0; zoomTarget.current = null; };
  const clearViewportGestures = () => { nativeScroll.current!.clear(); gapSelection.current?.end(); };

  const zoomBy = (factor: number, focus = cursor.current) => {
    zoomGestureAt.current = Date.now();
    if (document.querySelector(".image-viewer")) { window.dispatchEvent(new CustomEvent("supermd-image-zoom", { detail: { factor, point: focus } })); return; }
    cancelHeadingNavigation(document.querySelector(".android-reading"));
    const target = clampPreviewZoom((zoomTarget.current ?? zoomReference.current) * factor); zoomFocus.current = focus;
    // Keyboard and wheel-notch steps glide to the target; continuous pinch
    // and touchpad deltas are already small and apply directly.
    const glide = Math.abs(Math.log(factor)) > .03 && document.documentElement.dataset.motion !== "off" && !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (glide) {
      if (zoomTarget.current === null || zoomAnchors.current.focus !== focus) zoomAnchors.current = { focus, points: new Map(Array.from(document.querySelectorAll<HTMLElement>(".android-reading"), root => [root, documentPoint(root, focus)])) };
      zoomTarget.current = target;
    } else { zoomTarget.current = null; zoomReference.current = target; }
    const step = (time: number) => {
      const elapsed = time - zoomFrameTime.current; zoomFrameTime.current = time;
      const goal = zoomTarget.current;
      if (goal !== null) { zoomReference.current = zoomFrameStep(zoomReference.current, goal, elapsed); if (zoomReference.current === goal) zoomTarget.current = null; }
      applyZoomStyle(zoomFocus.current, zoomFocus.current, goal !== null ? zoomAnchors.current.points : undefined);
      if (zoomTarget.current !== null) zoomFrame.current = requestAnimationFrame(step); else { zoomFrame.current = 0; settleSelection(); }
    };
    if (!zoomFrame.current) { zoomFrameTime.current = performance.now(); zoomFrame.current = requestAnimationFrame(step); }
    window.clearTimeout(zoomTimer.current); const fullscreen = reference.current?.fullscreen; zoomTimer.current = window.setTimeout(() => void invoke("zoom_changed", { zoom: target, fullscreen }), 220);
  };

  const setZoom = (value: number, requestedAt?: number) => {
    if (requestedAt !== undefined && requestedAt < zoomGestureAt.current) return;
    cancelZoomGlide();
    const next = clampPreviewZoom(value);
    if (Math.abs(next - zoomReference.current) < .01) return;
    cancelHeadingNavigation(document.querySelector(".android-reading"));
    zoomReference.current = next;
    applyZoomStyle();
    settleSelection();
  };

  const resetZoom = () => {
    if (document.querySelector(".image-viewer")) { window.dispatchEvent(new Event("supermd-image-reset")); return; }
    (window.supermdZoomBy ?? zoomBy)(100 / (zoomTarget.current ?? zoomReference.current));
  };

  const handleNativeWheel = (dx: number, dy: number, point: Point, held: boolean, modifier = false) => {
    markScrollInput();
    const noteSplitWheelTarget = (node: Element) => {
      if (reference.current?.mode !== "split") return;
      const pane = detectSplitPaneFromTarget(node);
      if (pane) {
        clearProgrammaticAnchorScroll(pane === "editor" ? document.querySelector(".cm-scroller") : document.querySelector(".android-reading"));
        splitPane.current = pane;
      }
    };
    const target = document.elementFromPoint(point.x, point.y), canvas = target?.closest(".interactive-chart svg,.image-viewer-canvas");
    if (target?.closest(NON_VIEWER_OVERLAY_SELECTOR)) { if (!held) { const origin = resolveNativeWheelScrollOrigin(target); if (origin) nativeScroll.current!.scroll(origin, dx, dy); } return; }
    const editor = target?.closest<HTMLTextAreaElement>("textarea");
    if (editor) { noteSplitWheelTarget(editor); nativeScroll.current!.scroll(editor, dx, dy); return; }
    const slideNotes = target?.closest<HTMLElement>(".step-viewer .step-cards-notes");
    if (slideNotes && !modifier) { const origin = resolveNativeWheelScrollOrigin(target); if (origin) nativeScroll.current!.scroll(origin, dx, dy); return; }
    if (held && !target?.closest("input") && (modifier || canvas || (!selectingText.current && !window.getSelection()?.toString()))) {
      gapSelection.current?.cancelStationary();
      if (canvas?.matches("svg")) canvas.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, ctrlKey: true, deltaY: dy, clientX: point.x, clientY: point.y }));
      else (window.supermdZoomBy ?? zoomBy)(Math.exp(-dy * .002), point);
      return;
    }
    if (canvas) { canvas.dispatchEvent(new CustomEvent("supermd-canvas-pan", { detail: { dx, dy }, cancelable: true })); return; }
    const scroller = resolveNativeWheelScrollOrigin(target);
    if (scroller) { noteSplitWheelTarget(scroller); nativeScroll.current!.scroll(scroller, dx, dy); }
  };

  return {
    refs: { cursor, zoomFrame, zoomTimer, settleTimer, selectingText, gapSelection, nativeScroll, zoomGestureAt, requestChrome },
    zoomReference,
    zoomTarget,
    settleSelection,
    anchors,
    applyZoomStyle,
    anchored,
    cancelZoomGlide,
    clearViewportGestures,
    zoomBy,
    setZoom,
    resetZoom,
    handleNativeWheel,
  };
}

export type ReaderGestureControls = ReturnType<typeof useReaderGestureControls>;

export function useReaderGesturesAndZoom({ state, reference, controls }: { state: GesturesReaderState | null; reference: RefObject<GesturesReaderState | null>; controls: ReaderGestureControls }): void {
  const { zoomReference, zoomTarget, settleSelection, applyZoomStyle, cancelZoomGlide, zoomBy } = controls;
  const { cursor, settleTimer, selectingText, gapSelection, nativeScroll, zoomGestureAt, requestChrome } = controls.refs;

  useEffect(() => {
    const root = document.querySelector<HTMLElement>(".android-reading");
    if (!root || typeof ResizeObserver === "undefined") return;
    let frame = 0;
    const page = root.querySelector<HTMLElement>(".document-page");
    const observer = new ResizeObserver(() => {
      if (!frame) frame = requestAnimationFrame(() => {
        frame = 0;
        // A scheduled gesture owns its focal point. A resize callback must not
        // consume the pending scale at the default center before that frame runs.
        if (Math.abs(Number(page?.dataset.scale) * 100 - zoomReference.current) < .01 && !refreshDocumentExtent(root)) {
          invalidateDocumentZoom(root); applyZoomStyle(); settleSelection();
        }
      });
    });
    observer.observe(root); if (page) observer.observe(page);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [state?.id, state?.mode]);

  useLayoutEffect(() => { if (state) { applyZoomStyle(); settleSelection(); } }, [state?.centerLock]);
  // A Range must not retain a detached previous note after a tab switch or
  // source replacement, including edits made directly inside this reader.
  useLayoutEffect(() => { document.querySelectorAll<HTMLElement>(".android-reading").forEach(root => rememberWindowedScrollSource(root, 0)); }, [state?.id, state?.content, state?.mode]);

  useEffect(() => {
    const lock = (event: Event) => { const root = event.target; if (root instanceof HTMLElement && root.matches(".android-reading")) enforceDocumentCenter(root); };
    document.addEventListener("scroll", lock, { capture: true, passive: true });
    return () => document.removeEventListener("scroll", lock, true);
  }, []);

  useEffect(() => {
    let tap = 0;
    const click = (event: MouseEvent) => {
      const target = event.target as Element;
      if (document.documentElement.dataset.host !== "qt" || !reference.current?.fullscreen || !target.closest(".android-reading")) return;
      window.clearTimeout(tap);
      if (event.detail > 1 || event.altKey || event.ctrlKey || event.metaKey || target.closest("a,button,input,textarea,summary,img,.note-image,.interactive-chart,[data-independent-zoom]")) return;
      if (window.getSelection()?.toString()) return;
      tap = window.setTimeout(() => { if (!window.getSelection()?.toString() && !document.querySelector(".live-active-block textarea,.reading-search,.media-dialog,.image-viewer,.math-repair-panel")) requestChrome("toggle"); }, 260);
    };
    document.addEventListener("click", click);
    return () => { window.clearTimeout(tap); document.removeEventListener("click", click); };
  }, []);

  useEffect(() => {
    let startDistance = 0, startZoom = 100, pinching = false, frame = 0, mouseHeld = false, focus: Point | undefined, previousFocus: Point | undefined;
    let selectionStart: Point | null = null;
    const gaps = createGapSelection(() => { selectingText.current = true; }); gapSelection.current = gaps;
    const track = (event: PointerEvent) => { cursor.current = { x: event.clientX, y: event.clientY }; if (mouseHeld && selectionStart && Math.hypot(event.clientX - selectionStart.x, event.clientY - selectionStart.y) >= 3) selectingText.current = true; gaps.move(event); };
    const selectionScroll = (event: Event) => { if ((event.target as Element)?.matches?.(".android-reading")) gaps.refresh(); };
    let drag: { root: HTMLElement; point: Point; moved: boolean } | null = null;
    const down = (event: PointerEvent) => {
      if (event.pointerType !== "mouse" || event.button !== 0) return; mouseHeld = true;
      const target = event.target as Element, root = target.closest<HTMLElement>(".android-reading");
      cancelHeadingNavigation(root);
      selectingText.current = false;
      const candidate = !!root && !event.altKey && !target.closest("a,button,input,textarea,summary,img,.note-image,.interactive-chart,[data-independent-zoom]");
      selectionStart = candidate ? { x: event.clientX, y: event.clientY } : null;
      // Freeze the presented geometry before the browser begins selecting.
      // CSS zoom rounds small borders/line boxes differently from transforms;
      // switching here can move the intended line out from under the pointer.
      if (candidate) { window.clearTimeout(settleTimer.current); gaps.start(event, root!); }
      if (root && (reference.current?.mode === "reader" || reference.current?.fullscreen) && event.altKey && !target.closest("a,button,input,textarea,summary,img,.note-image,[data-independent-zoom]")) {
        drag = { root, point: { x: event.clientX, y: event.clientY }, moved: false }; root.setPointerCapture(event.pointerId);
      }
    };
    const pan = (event: PointerEvent) => {
      if (!drag) return;
      const dx = event.clientX - drag.point.x, dy = event.clientY - drag.point.y;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      drag.moved = true; drag.root.classList.add("is-panning"); window.getSelection()?.removeAllRanges();
      rememberWindowedScrollSource(drag.root, -dy);
      if (!reference.current?.centerLock) drag.root.scrollLeft -= dx;
      drag.root.scrollTop -= dy; drag.point = { x: event.clientX, y: event.clientY }; event.preventDefault();
    };
    const up = () => { mouseHeld = false; selectionStart = null; gaps.end(); if (selectingText.current) { selectingText.current = false; settleSelection(); } drag?.root.classList.remove("is-panning"); drag = null; };
    document.addEventListener("scroll", selectionScroll, true);
    document.addEventListener("pointermove", track); document.addEventListener("pointerdown", down); document.addEventListener("pointerup", up); window.addEventListener("blur", up);
    document.addEventListener("pointermove", pan); document.addEventListener("pointercancel", up);
    const distance = (touches: TouchList) => Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
    let touchY: number | undefined;
    const start = (event: TouchEvent) => {
      touchY = event.touches.length === 1 ? event.touches[0].clientY : undefined;
      cancelHeadingNavigation((event.target as Element).closest(".android-reading"));
      if (event.touches.length === 2 && !(event.target as Element).closest("input,textarea,[data-independent-zoom]")) {
        zoomGestureAt.current = Date.now(); cancelZoomGlide(); window.clearTimeout(settleTimer.current);
        startDistance = distance(event.touches); startZoom = zoomReference.current; pinching = true;
        previousFocus = { x: (event.touches[0].clientX + event.touches[1].clientX) / 2, y: (event.touches[0].clientY + event.touches[1].clientY) / 2 };
      }
    };
    const move = (event: TouchEvent) => {
      if (event.touches.length === 1) {
        const target = event.target as Element, root = target.closest<HTMLElement>(".android-reading");
        if (root && touchY !== undefined && !target.closest("textarea,input,[data-independent-zoom]")) rememberWindowedScrollSource(root, touchY - event.touches[0].clientY);
        touchY = event.touches[0].clientY;
      } else touchY = undefined;
      if (event.touches.length === 2 && pinching && startDistance > 0) {
        event.preventDefault(); zoomTarget.current = null; zoomReference.current = clampPreviewZoom((startZoom * distance(event.touches)) / startDistance);
        focus = { x: (event.touches[0].clientX + event.touches[1].clientX) / 2, y: (event.touches[0].clientY + event.touches[1].clientY) / 2 };
        // Coalesce input to one visual update per frame. Parsing Markdown and
        // crossing the native bridge are deliberately excluded from pinch frames.
        if (!frame) frame = requestAnimationFrame(() => { frame = 0; applyZoomStyle(focus, previousFocus); previousFocus = focus; });
      }
    };
    const end = (event: TouchEvent) => {
      if (pinching && event.touches.length < 2) {
        pinching = false;
        if (frame) { cancelAnimationFrame(frame); frame = 0; applyZoomStyle(focus, previousFocus); previousFocus = focus; }
        settleSelection(); void invoke("zoom_changed", { zoom: zoomReference.current, fullscreen: reference.current?.fullscreen });
      }
    };
    document.addEventListener("touchstart", start, { passive: true }); document.addEventListener("touchmove", move, { passive: false }); document.addEventListener("touchend", end); document.addEventListener("touchcancel", end);
    const wheel = (event: WheelEvent) => {
      const target = event.target as Element, root = target.closest(".android-reading"); cancelHeadingNavigation(root);
      const heldPageZoom = (mouseHeld || !!(event.buttons & 1)) && !!root && !selectingText.current && !window.getSelection()?.toString();
      if ((event.ctrlKey || event.metaKey || heldPageZoom) && !target.closest("textarea,input,[data-independent-zoom]")) {
        event.preventDefault(); gaps.cancelStationary(); (window.supermdZoomBy ?? zoomBy)(Math.exp(-event.deltaY * .002), { x: event.clientX, y: event.clientY });
      } else if (root instanceof HTMLElement && !event.ctrlKey && !event.metaKey && !target.closest("textarea,input,.interactive-chart,.note-image,[data-independent-zoom]")) {
        rememberWindowedScrollSource(root, event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? root.clientHeight : 1));
        if (Math.abs(event.deltaY) > 2) requestChrome("hide");
      }
    };
    const scrollKey = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const root = target?.closest<HTMLElement>(".android-reading") || (!target || target === document.body || target === document.documentElement ? document.querySelector<HTMLElement>(".android-reading") : null);
      if (!root) return;
      const delta = readingKeyboardScrollDelta(event, root);
      if (delta === null) return;
      cancelHeadingNavigation(root);
      rememberWindowedScrollSource(root, delta);
    };
    document.addEventListener("wheel", wheel, { passive: false });
    document.addEventListener("keydown", scrollKey);
    return () => {
      gaps.end(); gapSelection.current = null;
      document.removeEventListener("scroll", selectionScroll, true); document.removeEventListener("keydown", scrollKey);
      document.removeEventListener("pointermove", pan); document.removeEventListener("pointercancel", up);
      document.removeEventListener("pointermove", track); document.removeEventListener("pointerdown", down); document.removeEventListener("pointerup", up); window.removeEventListener("blur", up);
      cancelAnimationFrame(frame); document.removeEventListener("wheel", wheel);
      document.removeEventListener("touchstart", start); document.removeEventListener("touchmove", move); document.removeEventListener("touchend", end); document.removeEventListener("touchcancel", end);
    };
  }, []);

  useLayoutEffect(() => () => {
    nativeScroll.current?.clear();
    cancelZoomGlide();
    window.clearTimeout(settleTimer.current);
  }, []);
}
