// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { Compartment, EditorSelection, EditorState, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  TYPEWRITER_SHORTCUT,
  TYPEWRITER_STORAGE_KEY,
  getTypewriterScroll,
  isTypewriterShortcutEvent,
  liveEditorCenterDelta,
  setTypewriterScroll,
  shouldCenterTypewriterTransaction,
  subscribeTypewriterScroll,
  toggleTypewriterScroll,
  typewriterScrollExtension,
} from "./typewriterScroll";

describe("typewriterScroll store and shortcuts", () => {
  beforeEach(() => {
    localStorage.clear();
    setTypewriterScroll(false);
  });

  it("defaults to false, notifies subscribers, and persists unless persist:false", () => {
    expect(getTypewriterScroll()).toBe(false);
    const events: boolean[] = [];
    const unsubscribe = subscribeTypewriterScroll(() => events.push(getTypewriterScroll()));

    expect(toggleTypewriterScroll()).toBe(true);
    expect(getTypewriterScroll()).toBe(true);
    expect(localStorage.getItem(TYPEWRITER_STORAGE_KEY)).toBe("true");
    expect(events).toEqual([true]);

    setTypewriterScroll(false, { persist: false });
    expect(getTypewriterScroll()).toBe(false);
    expect(localStorage.getItem(TYPEWRITER_STORAGE_KEY)).toBe("true");
    expect(events).toEqual([true, false]);

    unsubscribe();
    setTypewriterScroll(true);
    expect(events).toEqual([true, false]);
  });

  it("recognizes Mod+Alt+T without clashing with Ctrl+Shift+T reopen tab", () => {
    expect(TYPEWRITER_SHORTCUT).toBe("Mod-Alt-t");
    expect(isTypewriterShortcutEvent(new KeyboardEvent("keydown", { key: "t", ctrlKey: true, altKey: true }))).toBe(true);
    expect(isTypewriterShortcutEvent(new KeyboardEvent("keydown", { key: "T", metaKey: true, altKey: true }))).toBe(true);
    expect(isTypewriterShortcutEvent(new KeyboardEvent("keydown", { key: "t", ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isTypewriterShortcutEvent(new KeyboardEvent("keydown", { key: "t", ctrlKey: true, altKey: true, shiftKey: true }))).toBe(false);
    expect(isTypewriterShortcutEvent(new KeyboardEvent("keydown", { key: "t" }))).toBe(false);
  });
});

describe("CodeMirror typewriter compartment and transaction filtering", () => {
  const scrollProbe = EditorView.scrollIntoView(0) as unknown as { type: unknown };

  it("centers keyboard edits and navigation but ignores pointer selection, external syncs, and explicit scrollIntoView", () => {
    const state = EditorState.create({ doc: "Alpha\nBeta\nGamma\nDelta" });

    const typingTr = state.update({
      changes: { from: 5, insert: "!" },
      selection: { anchor: 6 },
      userEvent: "input.type",
    });
    expect(shouldCenterTypewriterTransaction(typingTr)).toBe(true);

    const navTr = state.update({
      selection: { anchor: 8 },
      scrollIntoView: true,
      userEvent: "select",
    });
    expect(shouldCenterTypewriterTransaction(navTr)).toBe(true);

    const pointerTr = state.update({
      selection: { anchor: 2, head: 9 },
      scrollIntoView: true,
      userEvent: "select.pointer",
    });
    expect(shouldCenterTypewriterTransaction(pointerTr)).toBe(false);

    const externalSyncTr = state.update({
      changes: { from: 0, to: 5, insert: "ALPHA" },
      annotations: Transaction.addToHistory.of(false),
    });
    expect(shouldCenterTypewriterTransaction(externalSyncTr)).toBe(false);

    const headingJumpTr = state.update({
      selection: { anchor: 11 },
      effects: EditorView.scrollIntoView(11, { y: "start" }),
    });
    expect(shouldCenterTypewriterTransaction(headingJumpTr)).toBe(false);
  });

  it("attaches y:center scroll effects only when Compartment is enabled", () => {
    const compartment = new Compartment();
    let state = EditorState.create({
      doc: "Line 1\nLine 2\nLine 3",
      extensions: [compartment.of(typewriterScrollExtension(false))],
    });

    const disabledTr = state.update({
      changes: { from: state.doc.length, insert: "\nLine 4" },
      selection: EditorSelection.cursor(state.doc.length + 7),
      userEvent: "input.type",
    });
    expect(disabledTr.effects.some((e) => (e as unknown as { type: unknown }).type === scrollProbe.type)).toBe(false);
    state = disabledTr.state;

    state = state.update({
      effects: compartment.reconfigure(typewriterScrollExtension(true)),
    }).state;

    const enabledTr = state.update({
      changes: { from: state.doc.length, insert: "!" },
      selection: EditorSelection.cursor(state.doc.length + 1),
      userEvent: "input.type",
    });
    const scrollEffects = enabledTr.effects.filter((e) => (e as unknown as { type: unknown }).type === scrollProbe.type);
    expect(scrollEffects).toHaveLength(1);
    expect((scrollEffects[0] as unknown as { value: { y: string } }).value.y).toBe("center");
  });

  it("keeps transaction extender overhead well below 5ms per transaction on large documents", () => {
    const compartment = new Compartment();
    const initialDoc = Array.from({ length: 5000 }, (_, i) => `Line ${i + 1}: markdown paragraph content`).join("\n");
    let state = EditorState.create({
      doc: initialDoc,
      selection: EditorSelection.cursor(Math.floor(initialDoc.length / 2)),
      extensions: [compartment.of(typewriterScrollExtension(true))],
    });

    const iterations = 400;
    const durations: number[] = [];
    for (let i = 0; i < iterations; i++) {
      const pos = state.selection.main.head;
      const start = performance.now();
      const tr = state.update({
        changes: { from: pos, insert: "x" },
        selection: EditorSelection.cursor(pos + 1),
        userEvent: "input.type",
      });
      durations.push(performance.now() - start);
      state = tr.state;
    }

    const averageMs = durations.reduce((sum, d) => sum + d, 0) / durations.length;
    const sorted = [...durations].sort((a, b) => a - b);
    const p95Ms = sorted[Math.floor(sorted.length * 0.95)];
    expect(averageMs).toBeLessThan(5);
    expect(p95Ms).toBeLessThan(5);
  });
});

describe("liveEditorCenterDelta with custom line heights and scaling", () => {
  it("centers compact blocks by block midpoint and multiline caret lines using computed theme line-height", () => {
    const scroller = document.createElement("div");
    Object.defineProperty(scroller, "clientHeight", { value: 600, configurable: true });
    scroller.getBoundingClientRect = () => ({ top: 100, bottom: 700, left: 0, right: 800, width: 800, height: 600, x: 0, y: 100, toJSON: () => ({}) });

    const area = document.createElement("textarea");
    area.style.fontSize = "20px";
    area.style.lineHeight = "40px";
    area.style.paddingTop = "12px";
    area.value = "First\nSecond\nThird\nFourth";
    area.selectionStart = area.selectionEnd = "First\nSecond\nTh".length; // lineIndex = 2 ("Third")
    Object.defineProperty(area, "clientHeight", { value: 200, configurable: true });
    Object.defineProperty(area, "offsetHeight", { value: 200, configurable: true });
    area.getBoundingClientRect = () => ({ top: 450, bottom: 650, left: 40, right: 760, width: 720, height: 200, x: 40, y: 450, toJSON: () => ({}) });
    document.body.append(area);

    // Viewport center = 100 + 600 / 2 = 400.
    // Compact block midpoint (followCaret = false): (450 + 200 / 2) - 400 = 550 - 400 = 150.
    expect(liveEditorCenterDelta(area, scroller, false)).toBe(150);

    // Active caret line (followCaret = true, lineIndex = 2, lineHeight = 40px, paddingTop = 12px):
    // localCenter = 12 + 2.5 * 40 = 112; screenY = 450 + 112 = 562; delta = 562 - 400 = 162.
    expect(liveEditorCenterDelta(area, scroller, true)).toBe(162);

    area.remove();
  });
});
