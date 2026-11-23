// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { Compartment, EditorSelection, EditorState, Transaction } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { deleteCharBackward, deleteCharForward, history, isolateHistory, redo, undo } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { editorKeyBindings } from "./components/Editor";
import {
  TYPEWRITER_SHORTCUT,
  TYPEWRITER_STORAGE_KEY,
  getTypewriterScroll,
  isTypewriterShortcutEvent,
  liveEditorCenterDelta,
  setTypewriterScroll,
  shouldCenterTypewriterTransaction,
  subscribeTypewriterScroll,
  syncTypewriterFromStorage,
  toggleTypewriterScroll,
  typewriterScrollExtension,
} from "./typewriterScroll";

if (typeof Range !== "undefined") {
  if (!Range.prototype.getClientRects) {
    Range.prototype.getClientRects = () =>
      ({
        length: 0,
        item: () => null,
        [Symbol.iterator]: function* () {},
      }) as unknown as DOMRectList;
  }
  if (!Range.prototype.getBoundingClientRect) {
    Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 20);
  }
}

describe("typewriterScroll store and shortcuts", () => {
  beforeEach(() => {
    localStorage.clear();
    setTypewriterScroll(false);
  });

  it("defaults to false for both brand-new and existing users, persists opt-in state, and syncs across windows", () => {
    localStorage.clear();
    expect(syncTypewriterFromStorage()).toBe(false);
    expect(getTypewriterScroll()).toBe(false);

    // Simulate an existing user upgrading from an earlier release with populated preferences but no editor.typewriter key.
    localStorage.setItem("setup.complete", "true");
    localStorage.setItem("theme.normal", "dark");
    localStorage.setItem("autosave", "true");
    localStorage.setItem("editor.size", "16");
    localStorage.setItem("reader.font", "serif");
    localStorage.setItem(
      "workspace.tabs.browser",
      JSON.stringify({ activeId: "t1", tabs: [{ id: "t1", name: "Notes.md", path: null, content: "# Existing", savedContent: "# Existing" }], recentlyClosed: [] }),
    );
    expect(syncTypewriterFromStorage()).toBe(false);
    expect(getTypewriterScroll()).toBe(false);

    // Invalid or non-boolean storage strings must never enable typewriter mode.
    for (const invalid of ["yes", "1", "false", ""]) {
      localStorage.setItem(TYPEWRITER_STORAGE_KEY, invalid);
      expect(syncTypewriterFromStorage()).toBe(false);
    }

    const events: boolean[] = [];
    const unsubscribe = subscribeTypewriterScroll(() => events.push(getTypewriterScroll()));

    expect(toggleTypewriterScroll()).toBe(true);
    expect(getTypewriterScroll()).toBe(true);
    expect(localStorage.getItem(TYPEWRITER_STORAGE_KEY)).toBe("true");
    expect(syncTypewriterFromStorage()).toBe(true);
    expect(events).toEqual([true]);

    setTypewriterScroll(false, { persist: false });
    expect(getTypewriterScroll()).toBe(false);
    expect(localStorage.getItem(TYPEWRITER_STORAGE_KEY)).toBe("true");
    expect(events).toEqual([true, false]);

    // Cross-window StorageEvent synchronization.
    window.dispatchEvent(new StorageEvent("storage", { key: TYPEWRITER_STORAGE_KEY, newValue: "true" }));
    expect(getTypewriterScroll()).toBe(true);
    window.dispatchEvent(new StorageEvent("storage", { key: TYPEWRITER_STORAGE_KEY, newValue: "false" }));
    expect(getTypewriterScroll()).toBe(false);
    expect(events).toEqual([true, false, true, false]);

    unsubscribe();
    setTypewriterScroll(true);
    expect(events).toEqual([true, false, true, false]);
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

describe("Document text, cursor, selection, IME composition, and undo/redo exact equivalence", () => {
  it("produces identical document text and selection ranges across typing, multi-range selection, IME composition, and undo/redo with typewriter ON vs OFF", () => {
    const realisticStudyMarkdown = [
      "---",
      "title: Electrodynamics & Unicode Field Notes",
      "tags: [maxwell, 日本語, 中文, עברית, 🧪🔬🚀]",
      "---",
      "",
      "# 1. Maxwell–Faraday Induction & Boundary Conditions",
      "",
      "Consider Cafe\u0301-frame flux linkage through surface $\\Sigma$ bounded by $\\partial\\Sigma$:",
      "",
      "$$",
      "\\oint_{\\partial\\Sigma} \\mathbf{E} \\cdot d\\boldsymbol{\\ell} = -\\frac{d}{dt} \\iint_{\\Sigma} \\mathbf{B} \\cdot d\\mathbf{A}",
      "$$",
      "",
      "| Law | Differential Form | Status |",
      "| :--- | :---: | ---: |",
      "| Gauss | $\\nabla \\cdot \\mathbf{E} = \\rho / \\varepsilon_0$ | Verified 🧪 |",
      "| Ampère–Maxwell | $\\nabla \\times \\mathbf{B} = \\mu_0\\mathbf{J} + \\mu_0\\varepsilon_0\\partial_t\\mathbf{E}$ | Draft 🚀 |",
      "",
      "```python",
      "def energy_density(E: float, B: float, eps0: float = 8.854e-12, mu0: float = 1.2566e-6) -> float:",
      "    return 0.5 * (eps0 * E**2 + (B**2) / mu0)",
      "```",
      "",
      "- [x] Check boundary continuity $\\hat{\\mathbf{n}} \\times (\\mathbf{E}_2 - \\mathbf{E}_1) = \\mathbf{0}$",
      "- [ ] Add relativistic tensor $\\partial_\\mu F^{\\mu\\nu} = \\mu_0 J^\\nu$ notes",
    ].join("\n");

    const offHost = document.createElement("div");
    const onHost = document.createElement("div");
    document.body.append(offHost, onHost);

    const offCompartment = new Compartment();
    const onCompartment = new Compartment();

    const makeView = (parent: HTMLElement, compartment: Compartment, enabled: boolean) =>
      new EditorView({
        parent,
        state: EditorState.create({
          doc: realisticStudyMarkdown,
          extensions: [
            history({ minDepth: 100 }),
            markdown({ base: markdownLanguage }),
            EditorView.lineWrapping,
            EditorState.allowMultipleSelections.of(true),
            keymap.of(editorKeyBindings("browser")),
            compartment.of(typewriterScrollExtension(enabled)),
          ],
        }),
      });

    const offView = makeView(offHost, offCompartment, false);
    const onView = makeView(onHost, onCompartment, true);

    const snapshotRanges = (view: EditorView) =>
      view.state.selection.ranges.map((range) => ({
        anchor: range.anchor,
        head: range.head,
        from: range.from,
        to: range.to,
        assoc: range.assoc,
      }));

    const assertIdentical = (step: string) => {
      expect(onView.state.doc.toString(), `doc mismatch at ${step}`).toBe(offView.state.doc.toString());
      expect(onView.state.selection.toJSON(), `selection JSON mismatch at ${step}`).toEqual(offView.state.selection.toJSON());
      expect(snapshotRanges(onView), `selection ranges mismatch at ${step}`).toEqual(snapshotRanges(offView));
    };

    const runBoth = (step: string, action: (view: EditorView) => void) => {
      action(offView);
      action(onView);
      assertIdentical(step);
    };

    try {
      assertIdentical("initial mount");

      // 1. Type multiline Markdown + inline LaTeX inside prose, then delete backward & forward.
      runBoth("move cursor into prose paragraph", (view) => {
        const target = view.state.doc.toString().indexOf("bounded by $\\partial\\Sigma$:");
        view.dispatch({
          selection: EditorSelection.cursor(target + "bounded by $\\partial\\Sigma$:".length),
          scrollIntoView: true,
          userEvent: "select",
        });
      });

      for (const ch of "\nWhere the induced EMF satisfies $\\mathcal{E} = -N\\,\\Delta\\Phi_B / \\Delta t$!X") {
        runBoth(`type char ${JSON.stringify(ch)}`, (view) => {
          const head = view.state.selection.main.head;
          view.dispatch({
            changes: { from: head, to: head, insert: ch },
            selection: EditorSelection.cursor(head + ch.length),
            userEvent: "input.type",
          });
        });
      }

      runBoth("deleteCharBackward on trailing X", (view) => {
        expect(deleteCharBackward(view)).toBe(true);
      });

      runBoth("step left and deleteCharForward on !", (view) => {
        const head = view.state.selection.main.head;
        view.dispatch({ selection: EditorSelection.cursor(head - 1), scrollIntoView: true, userEvent: "select" });
        expect(deleteCharForward(view)).toBe(true);
      });

      // 2. Forward selection, backward selection (anchor > head), and pointer selection.
      runBoth("forward selection across table formula", (view) => {
        const text = view.state.doc.toString();
        const from = text.indexOf("Draft 🚀");
        view.dispatch({
          selection: EditorSelection.range(from, from + "Draft 🚀".length),
          scrollIntoView: true,
          userEvent: "select",
        });
      });

      runBoth("replace forward selection with Verified", (view) => {
        view.dispatch({
          ...view.state.replaceSelection("Verified 🔬✅"),
          scrollIntoView: true,
          userEvent: "input.type",
        });
      });

      runBoth("backward selection (anchor > head) inside Python block", (view) => {
        const text = view.state.doc.toString();
        const start = text.indexOf("eps0: float = 8.854e-12");
        const end = start + "eps0: float = 8.854e-12".length;
        view.dispatch({
          selection: EditorSelection.range(end, start),
          scrollIntoView: true,
          userEvent: "select",
        });
      });

      runBoth("pointer selection must also preserve identical range", (view) => {
        const text = view.state.doc.toString();
        const start = text.indexOf("0.5 * (eps0 * E**2");
        view.dispatch({
          selection: EditorSelection.range(start + 18, start),
          scrollIntoView: true,
          userEvent: "select.pointer",
        });
      });

      // 3. Multi-cursor selection across 3 distinct regions (YAML, table, task list) + simultaneous edits.
      runBoth("set 3-cursor selection", (view) => {
        const text = view.state.doc.toString();
        const p1 = text.indexOf("maxwell") + "maxwell".length;
        const p2 = text.indexOf("Gauss") + "Gauss".length;
        const p3 = text.indexOf("notes", text.lastIndexOf("- [ ]")) + "notes".length;
        view.dispatch({
          selection: EditorSelection.create(
            [EditorSelection.cursor(p1), EditorSelection.cursor(p2), EditorSelection.cursor(p3)],
            2,
          ),
          scrollIntoView: true,
          userEvent: "select",
        });
      });

      runBoth("simultaneous 3-cursor insert", (view) => {
        view.dispatch({
          ...view.state.changeByRange((range) => ({
            changes: { from: range.from, to: range.to, insert: "_v2" },
            range: EditorSelection.cursor(range.from + 3),
          })),
          scrollIntoView: true,
          userEvent: "input.type",
        });
      });

      runBoth("simultaneous 3-cursor backspace", (view) => {
        expect(deleteCharBackward(view)).toBe(true);
      });

      // 4. Realistic multi-stage IME compositions (Japanese Kana->Kanji, Chinese Pinyin, dead-key accent, cancelled IME, emoji-adjacent replacement).
      const runImeCycle = (label: string, stages: Array<{ text: string; caretOffset?: number }>) => {
        let compStart = -1;
        let prevLen = 0;
        stages.forEach((stage, idx) => {
          runBoth(`${label} stage ${idx + 1}: ${JSON.stringify(stage.text)}`, (view) => {
            const from = idx === 0 ? view.state.selection.main.from : compStart;
            const to = idx === 0 ? view.state.selection.main.to : compStart + prevLen;
            const caret = from + (stage.caretOffset ?? stage.text.length);
            view.dispatch({
              changes: { from, to, insert: stage.text },
              selection: EditorSelection.cursor(caret),
              annotations: idx === 0 ? isolateHistory.of("before") : [],
              scrollIntoView: true,
              userEvent: "input.type.compose",
            });
          });
          if (idx === 0) compStart = offView.state.selection.main.head - (stage.caretOffset ?? stage.text.length);
          prevLen = stage.text.length;
        });
      };

      runBoth("place cursor at end of document for IME", (view) => {
        const end = view.state.doc.length;
        view.dispatch({
          selection: EditorSelection.cursor(end),
          scrollIntoView: true,
          userEvent: "select",
        });
        const nextEnd = view.state.doc.length;
        view.dispatch({
          changes: { from: nextEnd, insert: "\n\n## 2. Multilingual & IME Notes: " },
          selection: EditorSelection.cursor(nextEnd + "\n\n## 2. Multilingual & IME Notes: ".length),
          annotations: isolateHistory.of("before"),
          userEvent: "input.type",
        });
      });

      // Japanese Romaji -> Kana -> clause focus -> Kanji conversion
      runImeCycle("Japanese IME", [
        { text: "d" },
        { text: "でん" },
        { text: "でんじゆうどう", caretOffset: 3 },
        { text: "電磁誘導の法則" },
      ]);

      runBoth("insert separator", (view) => {
        const pos = view.state.selection.main.head;
        view.dispatch({ changes: { from: pos, insert: " · " }, selection: EditorSelection.cursor(pos + 3), userEvent: "input.type" });
      });

      // Chinese Pinyin multi-syllable composition
      runImeCycle("Chinese Pinyin IME", [
        { text: "mai" },
        { text: "maikesuowei" },
        { text: "麦克斯韦方程组" },
      ]);

      // Dead-key accent composition ("´" -> "é")
      runBoth("space before dead-key", (view) => {
        const pos = view.state.selection.main.head;
        view.dispatch({ changes: { from: pos, insert: " Amp" }, selection: EditorSelection.cursor(pos + 4), userEvent: "input.type" });
      });
      runImeCycle("Dead-key accent IME", [{ text: "´" }, { text: "è" }]);
      runBoth("finish Ampère word", (view) => {
        const pos = view.state.selection.main.head;
        view.dispatch({ changes: { from: pos, insert: "re " }, selection: EditorSelection.cursor(pos + 3), userEvent: "input.type" });
      });

      // Cancelled IME composition (preedit inserted then cleared on Escape)
      runImeCycle("Cancelled RTL IME", [{ text: "טיו" }, { text: "טיוטה" }, { text: "" }]);

      // IME composition replacing a backward selection right after surrogate-pair emojis 🧪🔬🚀
      runBoth("select backward adjacent to surrogate-pair emojis", (view) => {
        const text = view.state.doc.toString();
        const emojiIdx = text.indexOf("🧪🔬🚀");
        const afterEmoji = emojiIdx + "🧪🔬🚀".length;
        view.dispatch({
          selection: EditorSelection.range(emojiIdx + "🧪🔬".length, emojiIdx),
          scrollIntoView: true,
          userEvent: "select",
        });
        expect(afterEmoji).toBeGreaterThan(emojiIdx);
      });
      runImeCycle("Emoji-replacing IME", [{ text: "じっけん" }, { text: "実験🧪" }]);

      // 5. Toggle typewriter compartment off and back on mid-session on onView while offView stays off.
      onView.dispatch({ effects: onCompartment.reconfigure(typewriterScrollExtension(false)) });
      assertIdentical("after disabling typewriter compartment mid-session");
      runBoth("type while compartment toggled off", (view) => {
        const pos = view.state.selection.main.head;
        view.dispatch({ changes: { from: pos, insert: " [sync]" }, selection: EditorSelection.cursor(pos + 7), userEvent: "input.type" });
      });
      onView.dispatch({ effects: onCompartment.reconfigure(typewriterScrollExtension(true)) });
      assertIdentical("after re-enabling typewriter compartment mid-session");

      // 6. Exhaustive undo() back to initial document and redo() forward, verifying doc + selection at every step.
      const finalEditedDoc = offView.state.doc.toString();
      expect(finalEditedDoc).not.toBe(realisticStudyMarkdown);

      let undoCount = 0;
      while (true) {
        const offUndid = undo(offView);
        const onUndid = undo(onView);
        expect(onUndid, `undo return value mismatch at step ${undoCount + 1}`).toBe(offUndid);
        assertIdentical(`undo step ${undoCount + 1}`);
        if (!offUndid) break;
        undoCount++;
      }
      expect(undoCount).toBeGreaterThanOrEqual(5);
      expect(onView.state.doc.toString()).toBe(realisticStudyMarkdown);

      let redoCount = 0;
      while (true) {
        const offRedid = redo(offView);
        const onRedid = redo(onView);
        expect(onRedid, `redo return value mismatch at step ${redoCount + 1}`).toBe(offRedid);
        assertIdentical(`redo step ${redoCount + 1}`);
        if (!offRedid) break;
        redoCount++;
      }
      expect(redoCount).toBe(undoCount);
      expect(onView.state.doc.toString()).toBe(finalEditedDoc);
      expect(onView.state.selection.toJSON()).toEqual(offView.state.selection.toJSON());
    } finally {
      offView.destroy();
      onView.destroy();
      offHost.remove();
      onHost.remove();
    }
  });
});

