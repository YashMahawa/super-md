// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readingOffset } from "./readingPosition";
import { commitMediaLayout } from "./mediaLayout";
import * as sourceAnchor from "./sourceAnchor";
import { parseImportedAnchor } from "./useSharedSourceAnchor";
import { commitWindowedLayout } from "./windowedSearch";
import { Reader } from "./androidReader";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
if (typeof Range !== "undefined") {
  Range.prototype.getClientRects ??= () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
}
if (typeof Element !== "undefined") Element.prototype.scrollIntoView ??= () => {};

const SYNC_BRIDGE_GLOBALS = [
  "supermdBeforeNavigate", "supermdChromeInset", "supermdDismiss", "supermdExport", "supermdExportMarkdown",
  "supermdFind", "supermdFindStep", "supermdFlush", "supermdFormat", "supermdHeading", "supermdHistory",
  "supermdLoad", "supermdNativeWheel", "supermdPortable", "supermdRepairMath", "supermdReply",
  "supermdResetZoom", "supermdSavePosition", "supermdSelectedText", "supermdSetZoom",
  "supermdThemeGuide", "supermdToggleTypewriter", "supermdZoomBy",
] as const;

const READER_COMPONENT_GLOBALS = [
  "supermdAgentCompute", "supermdAgentRequest", "supermdBeforeNavigate", "supermdChromeInset", "supermdDismiss",
  "supermdExport", "supermdExportMarkdown", "supermdExportPhase", "supermdFind", "supermdFindStep",
  "supermdFlush", "supermdFormat", "supermdHeading", "supermdHistory", "supermdLoad",
  "supermdNativeWheel", "supermdPortable", "supermdRepairMath", "supermdResetZoom", "supermdSavePosition",
  "supermdSelectedText", "supermdSetZoom", "supermdThemeGuide", "supermdToggleTypewriter", "supermdZoomBy",
] as const;

const BASE_STATE = {
  dark: false, fullscreen: false, colors: {}, font: "Manrope", size: 16, zoom: 100, motion: false, editProtocol: 1, restorePosition: true,
};

function installClampedScroller(el: HTMLElement, clientHeight: number, getScrollHeight: () => number) {
  let internalTop = 0;
  Object.defineProperty(el, "clientHeight", { value: clientHeight, configurable: true });
  Object.defineProperty(el, "scrollHeight", { get: getScrollHeight, configurable: true });
  Object.defineProperty(el, "scrollTop", {
    get: () => internalTop,
    set: (next: number) => {
      const maxTop = Math.max(0, getScrollHeight() - clientHeight);
      internalTop = Math.max(0, Math.min(next, maxTop));
    },
    configurable: true,
  });
}

describe("useSharedSourceAnchor", () => {
  let host: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    if (root) { act(() => root!.unmount()); root = null; }
    host?.remove(); host = null;
    delete (window as unknown as { SuperMD?: unknown }).SuperMD;
    localStorage.clear();
  });

  it("cancels settle passes on user/external movement inside the same tall rendered block and syncs split preview snapshot/restore", () => {
    vi.useFakeTimers();
    const savedPositions: Record<string, { top: number; offset: number; mode: string; zoom: number }> = {};
    window.SuperMD = {
      post(id, command, raw) {
        const args = JSON.parse(raw);
        if (command === "reading_position") savedPositions[args.id] = args.location;
        window.supermdReply?.(id, command === "document_sync" ? { accepted: true, revision: 0 } : true, null);
      },
    };
    const intro = "# Architecture\n\nIntro paragraph.\n\n";
    const tallBlock = "## Tall Specification\n\n" + "Single tall rendered paragraph line with identical source start offset. ".repeat(80);
    const markdown = `${intro}${tallBlock}\n`;
    const tallParagraphOffset = markdown.indexOf("Single tall rendered paragraph");

    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => { root!.render(<Reader />); });

    act(() => {
      window.supermdLoad?.({ ...BASE_STATE, id: "tab-tall", path: "/notes/Tall.md", content: markdown, mode: "editor" });
    });
    sourceAnchor.revealEditorOffset("tab-tall", tallParagraphOffset, { caretOffset: tallParagraphOffset });

    act(() => {
      window.supermdLoad?.({ ...BASE_STATE, id: "tab-tall", path: "/notes/Tall.md", content: markdown, mode: "split" });
    });

    const reading = host.querySelector<HTMLElement>(".android-reading")!;
    Object.defineProperty(reading, "clientHeight", { value: 400, configurable: true });
    Object.defineProperty(reading, "scrollHeight", { value: 3200, configurable: true });
    reading.getBoundingClientRect = () => ({ top: 0, bottom: 400, left: 0, right: 640, width: 640, height: 400, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
    const blocks = Array.from(reading.querySelectorAll<HTMLElement>("[data-source-start]"));
    blocks.forEach(block => {
      const start = Number(block.dataset.sourceStart);
      const ownTop = start < tallParagraphOffset ? (start === 0 ? 20 : 120) : 656;
      const ownBottom = start < tallParagraphOffset ? ownTop + 60 : 2456;
      block.getBoundingClientRect = () => ({
        top: ownTop - reading.scrollTop, bottom: ownBottom - reading.scrollTop,
        left: 16, right: 620, width: 604, height: ownBottom - ownTop, x: 16, y: ownTop - reading.scrollTop, toJSON: () => ({}),
      } as DOMRect);
    });

    // Advance initial rAF settle so modeAnchor aligns to the start of the tall paragraph (~640 px).
    act(() => { vi.advanceTimersByTime(40); });
    const settledStartTop = reading.scrollTop;
    expect(Math.abs(settledStartTop - 640)).toBeLessThanOrEqual(2);
    expect(readingOffset(reading)).toBe(tallParagraphOffset);

    // Move deeper INSIDE the exact same tall rendered block (same mapped readingOffset!) before [120, 320, 700] ms timers fire.
    reading.scrollTop = 1180;
    expect(readingOffset(reading)).toBe(tallParagraphOffset);
    act(() => {
      reading.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    expect(sourceAnchor.isProgrammaticAnchorScroll(reading)).toBe(false);

    // Advance past all [120, 320, 700] ms settle passes: 1180 must never rewind to 640.
    act(() => { vi.advanceTimersByTime(750); });
    expect(reading.scrollTop).toBe(1180);

    // Switch away and back: split preview sync ensures 1180 is captured in the outgoing snapshot and restored across 700 ms.
    act(() => {
      window.supermdLoad?.({ ...BASE_STATE, id: "tab-other", path: "/notes/Other.md", content: "# Other\n", mode: "split" });
    });
    expect(savedPositions["tab-tall"]?.top).toBe(1180);
    expect(savedPositions["tab-tall"]?.offset).toBe(tallParagraphOffset);

    act(() => {
      window.supermdLoad?.({ ...BASE_STATE, id: "tab-tall", path: "/notes/Tall.md", content: markdown, mode: "split", readingLocation: savedPositions["tab-tall"] as never });
    });
    const reopened = host.querySelector<HTMLElement>(".android-reading")!;
    Object.defineProperty(reopened, "clientHeight", { value: 400, configurable: true });
    Object.defineProperty(reopened, "scrollHeight", { value: 3200, configurable: true });
    act(() => { vi.advanceTimersByTime(750); });
    expect(reopened.scrollTop).toBe(1180);
  });

  it("distinguishes legitimate layout clamping toward requestedTop from an independent upward scroll while clamped", () => {
    vi.useFakeTimers();
    // 1. Direct snapshot/clamp contract checks.
    const probe = document.createElement("div");
    let probeScrollHeight = 1620;
    installClampedScroller(probe, 820, () => probeScrollHeight);
    document.body.appendChild(probe);
    probe.scrollTop = 2500; // Clamped to maxScrollTop = 800.
    expect(probe.scrollTop).toBe(800);
    const clampedSnap = sourceAnchor.snapshotAnchorScroll(probe, 2500);
    expect(sourceAnchor.hasExternalAnchorScroll(clampedSnap)).toBe(false);

    // Independent upward scroll from 800 -> 500 while maxScrollTop is still 800 MUST be detected as external.
    probe.scrollTop = 500;
    expect(sourceAnchor.hasExternalAnchorScroll(clampedSnap)).toBe(true);

    // Legitimate layout-driven progress along Math.min(2500, currentMaxTop) returns false.
    probe.scrollTop = 800;
    const growthSnap = sourceAnchor.snapshotAnchorScroll(probe, 2500);
    probeScrollHeight = 2220; // maxScrollTop grows 800 -> 1400.
    probe.scrollTop = 1400;
    expect(sourceAnchor.hasExternalAnchorScroll(growthSnap)).toBe(false);

    // Clamp-then-expand race during data-navigating="true": windowed mount shrinks maxTop (clamping scrollTop 4973 -> 3888),
    // then async SVG media expands maxTop (3888 -> 4405) before the queued scroll event runs.
    probe.className = "android-reading";
    probe.dataset.navigating = "true";
    probeScrollHeight = 4973 + 820;
    probe.scrollTop = 4973;
    const navSnap = sourceAnchor.snapshotAnchorScroll(probe);
    commitWindowedLayout(probe, () => {
      probeScrollHeight = 3888 + 820;
      probe.scrollTop = probe.scrollTop; // Trigger synchronous browser scrollTop clamp to 3888.
    });
    expect(probe.scrollTop).toBe(3888);
    commitMediaLayout(probe, () => { probeScrollHeight = 4405 + 820; });
    expect(sourceAnchor.hasExternalAnchorScroll(navSnap)).toBe(false);
    probe.scrollTop = 3500;
    expect(sourceAnchor.hasExternalAnchorScroll(navSnap)).toBe(true);
    probe.remove();

    // 2. Full <Reader /> settle loop: legitimate layout expansion settles to 2500, while upward scroll to 500 survives 700 ms.
    window.SuperMD = { post: (id, cmd) => window.supermdReply?.(id, cmd === "document_sync" ? { accepted: true, revision: 0 } : true, null) };
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => { root!.render(<Reader />); });

    let liveScrollHeight = 1620; // maxScrollTop = 800 initially.
    act(() => {
      window.supermdLoad?.({ ...BASE_STATE, id: "tab-boot", path: null, content: "# Boot\n", mode: "live", restorePosition: false });
    });
    const sharedReading = host.querySelector<HTMLElement>(".android-reading")!;
    installClampedScroller(sharedReading, 820, () => liveScrollHeight);

    act(() => {
      window.supermdLoad?.({
        ...BASE_STATE, id: "tab-clamp-grow", path: "/notes/Grow.md", content: "# Grow\n\nBody.\n", mode: "live",
        readingLocation: { top: 2500, offset: 0, zoom: 100, mode: "live" },
      });
    });
    expect(sharedReading.scrollTop).toBe(800);
    // Trigger rAF pass while clamped at 800, then grow layout across [120, 320, 700] ms passes.
    act(() => { vi.advanceTimersByTime(40); });
    expect(sharedReading.scrollTop).toBe(800);
    liveScrollHeight = 2220; // maxScrollTop = 1400 at 120 ms.
    act(() => { vi.advanceTimersByTime(100); });
    expect(sharedReading.scrollTop).toBe(1400);
    liveScrollHeight = 3820; // maxScrollTop = 3000 at 320 ms & 700 ms -> settles at 2500.
    act(() => { vi.advanceTimersByTime(650); });
    expect(sharedReading.scrollTop).toBe(2500);

    // Now test independent upward scroll (800 -> 500) while clamped before remaining settle timers fire.
    liveScrollHeight = 1620;
    act(() => {
      window.supermdLoad?.({
        ...BASE_STATE, id: "tab-clamp-upward", path: "/notes/Upward.md", content: "# Upward\n\nBody.\n", mode: "live",
        readingLocation: { top: 2500, offset: 0, zoom: 100, mode: "live" },
      });
    });
    expect(sharedReading.scrollTop).toBe(800);
    act(() => { vi.advanceTimersByTime(40); });
    expect(sharedReading.scrollTop).toBe(800);

    sharedReading.scrollTop = 500;
    act(() => { sharedReading.dispatchEvent(new Event("scroll", { bubbles: true })); });
    liveScrollHeight = 3820; // Even after layout finishes expanding, settle passes must NOT overwrite 500!
    act(() => { vi.advanceTimersByTime(750); });
    expect(sharedReading.scrollTop).toBe(500);
  });

  it("unifies allowExactTop and firstPass updateSelection across modeAnchor and resolvedAnchor and cancels on wheel input", () => {
    vi.useFakeTimers();
    expect(parseImportedAnchor(null)).toBeUndefined();
    expect(parseImportedAnchor({ offset: -1, zoom: 100, mode: "live" })).toBeUndefined();
    expect(parseImportedAnchor({ offset: 42, caretOffset: 48, zoom: 125, mode: "split", readingTop: 310, editorTop: 280 })).toEqual({
      offset: 42, caretOffset: 48, zoom: 125, mode: "split", readingTop: 310, editorTop: 280,
    });

    const spy = vi.spyOn(sourceAnchor, "applySharedAnchor");
    window.SuperMD = { post: (id, cmd) => window.supermdReply?.(id, cmd === "document_sync" ? { accepted: true, revision: 0 } : true, null) };
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => { root!.render(<Reader />); });

    // resolvedAnchor path (allowExactTop: true, firstPass updateSelection: true -> false, cancelled on wheel).
    act(() => {
      window.supermdLoad?.({
        ...BASE_STATE, id: "tab-u1", path: "/notes/U1.md", content: "# U1\n\nText\n", mode: "live",
        readingLocation: { top: 180, offset: 6, zoom: 100, mode: "live" },
      });
    });
    expect(spy.mock.calls[0]?.[0]).toMatchObject({ allowExactTop: true, updateSelection: true });
    act(() => { vi.advanceTimersByTime(40); });
    expect(spy.mock.calls.slice(1).every(call => call[0].allowExactTop === true && call[0].updateSelection === false)).toBe(true);

    const callsBeforeWheel = spy.mock.calls.length;
    act(() => { window.dispatchEvent(new WheelEvent("wheel", { deltaY: 12, bubbles: true })); vi.advanceTimersByTime(750); });
    expect(spy.mock.calls.length).toBe(callsBeforeWheel);

    // modeAnchor path (allowExactTop: false, firstPass updateSelection: true -> false).
    spy.mockClear();
    act(() => {
      window.supermdLoad?.({ ...BASE_STATE, id: "tab-u1", path: "/notes/U1.md", content: "# U1\n\nText\n", mode: "reader" });
    });
    expect(spy.mock.calls[0]?.[0]).toMatchObject({ allowExactTop: false, updateSelection: true });
    act(() => { vi.advanceTimersByTime(750); });
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(5);
    expect(spy.mock.calls.slice(1).every(call => call[0].allowExactTop === false && call[0].updateSelection === false)).toBe(true);
  });

  it("registers synchronous bridge globals before reader_ready and exposes all 25 component globals", () => {
    let syncAtReaderReady: string[] = [];
    window.SuperMD = {
      post(id, command) {
        if (command === "reader_ready") {
          syncAtReaderReady = SYNC_BRIDGE_GLOBALS.filter(key => typeof (window as unknown as Record<string, unknown>)[key] === "function");
        }
        window.supermdReply?.(id, true, null);
      },
    };
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => { root!.render(<Reader />); });

    expect(syncAtReaderReady).toEqual([...SYNC_BRIDGE_GLOBALS]);
    const mountedGlobals = READER_COMPONENT_GLOBALS.filter(key => typeof (window as unknown as Record<string, unknown>)[key] === "function");
    expect(mountedGlobals).toEqual([...READER_COMPONENT_GLOBALS]);
    expect(mountedGlobals).toHaveLength(25);

    act(() => { root!.unmount(); });
    root = null;
    expect(window.supermdLoad).toBeUndefined();
    expect(window.supermdSavePosition).toBeUndefined();
  });

  it("prioritizes verified seededFind occurrence over saved restore while falling back to semantic/saved restore on stale seed or windowed unmounted blocks", () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(sourceAnchor, "applySharedAnchor");
    window.SuperMD = { post: (id, cmd) => window.supermdReply?.(id, cmd === "document_sync" ? { accepted: true, revision: 0 } : true, null) };
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => { root!.render(<Reader />); });

    const content = "# Intro\n\nAlpha token here.\n\n## Deep\n\nTargetMatch inside deep section.\n";
    const matchStart = content.indexOf("TargetMatch");
    const matchEnd = matchStart + "TargetMatch".length;

    // 1. Valid seededFind occurrence suppresses saved readingLocation restoration.
    act(() => {
      window.supermdLoad?.({
        ...BASE_STATE, id: "tab-seed-valid", path: "/notes/SeedValid.md", content, mode: "reader",
        readingLocation: { top: 420, offset: 9, zoom: 100, mode: "reader" },
        seededFind: { query: "TargetMatch", sourceStart: matchStart, sourceEnd: matchEnd, matchText: "TargetMatch" },
      });
    });
    act(() => { vi.advanceTimersByTime(40); });
    expect(spy).not.toHaveBeenCalled();

    // 2. Stale seededFind range falls back to saved readingLocation across settle passes even with .reading-search open at load.
    spy.mockClear();
    act(() => {
      window.supermdLoad?.({
        ...BASE_STATE, id: "tab-seed-stale", path: "/notes/SeedStale.md", content, mode: "reader",
        readingLocation: { top: 420, offset: 9, zoom: 100, mode: "reader" },
        seededFind: { query: "TargetMatch", sourceStart: 9999, sourceEnd: 10010, matchText: "TargetMatch" },
      });
    });
    expect(host.querySelector(".reading-search")).not.toBeNull();
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(1);
    const reading = host.querySelector<HTMLElement>(".android-reading")!;
    const placeholder = document.createElement("div");
    placeholder.dataset.windowedMounted = "false";
    reading.appendChild(placeholder);
    act(() => { vi.advanceTimersByTime(150); });
    // Once an unmounted windowed block is present with anchor.offset > 0, settle passes switch allowExactTop -> false.
    expect(spy.mock.calls.at(-1)?.[0]).toMatchObject({ allowExactTop: false });
  });
});
