// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(async () => null),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import Editor, {
  editorFindRange,
  editorSelectedText,
  exportEditorSession,
  formatEditorSession,
} from "./components/Editor";
import LiveEditor from "./components/LiveEditor";
import MarkdownPreview from "./components/MarkdownPreview";
import { toggleMarkdownFormat } from "./markdownFormatting";
import { setTypewriterScroll } from "./typewriterScroll";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect ??= () => new DOMRect(0, 0, 0, 0);

function querySourceInsertionPoint(): { from: number; to: number } | undefined {
  const detail: { point?: { from: number; to: number } } = {};
  window.dispatchEvent(new CustomEvent("supermd-insertion-point", { detail }));
  return detail.point;
}

describe("quoted-block heading and list prefix toggling (unit)", () => {
  it.each([
    ["> Quoted line", "heading", "> ## Quoted line"],
    ["> Quoted line", "list", "> - Quoted line"],
    ["> > Nested quote", "heading", "> > ## Nested quote"],
    ["> > Nested quote", "list", "> > - Nested quote"],
    [">> Compact nested", "heading", ">> ## Compact nested"],
    [">> Compact nested", "list", ">> - Compact nested"],
    ["> > > Triple nested", "heading", "> > > ## Triple nested"],
    ["> > > Triple nested", "list", "> > > - Triple nested"],
    ["  >   > Indented nested", "heading", "  >   > ## Indented nested"],
    ["  >   > Indented nested", "list", "  >   > - Indented nested"],
    [">\tTabbed quote", "heading", ">\t## Tabbed quote"],
    [">\tTabbed quote", "list", ">\t- Tabbed quote"],
  ] as const)(
    "applies %s inside %j, preserves exact quote markers on toggle-back, and round-trips selection offsets",
    (initial, action, expectedOnce) => {
      const words = initial.trim().split(/\s+/);
      const targetWord = words[words.length - 1]!;
      const from = initial.lastIndexOf(targetWord);
      const to = from + targetWord.length;

      const applied = toggleMarkdownFormat(initial, [{ anchor: from, head: to }], action);
      expect(applied.doc).toBe(expectedOnce);
      expect(applied.doc.slice(applied.ranges[0]!.anchor, applied.ranges[0]!.head)).toBe(targetWord);

      const reverted = toggleMarkdownFormat(applied.doc, applied.ranges, action);
      expect(reverted.doc).toBe(initial);
      expect(reverted.ranges).toEqual([{ anchor: from, head: to }]);
    },
  );

  it("preserves reversed selection direction (anchor > head) across quoted and nested-quoted toggles", () => {
    const initial = "> > Signal analysis";
    const start = initial.indexOf("Signal");
    const end = start + "Signal".length;

    const headingOn = toggleMarkdownFormat(initial, [{ anchor: end, head: start }], "heading");
    expect(headingOn.doc).toBe("> > ## Signal analysis");
    expect(headingOn.ranges).toEqual([{ anchor: end + 3, head: start + 3 }]);

    const headingOff = toggleMarkdownFormat(headingOn.doc, headingOn.ranges, "heading");
    expect(headingOff.doc).toBe(initial);
    expect(headingOff.ranges).toEqual([{ anchor: end, head: start }]);
  });

  it("strips H1-H6 headings and converts/strips bullet and ordered lists inside single and nested quotes", () => {
    expect(toggleMarkdownFormat("> # Top heading", [{ anchor: 4, head: 7 }], "heading")).toMatchObject({
      doc: "> Top heading",
      ranges: [{ anchor: 2, head: 5 }],
    });
    expect(toggleMarkdownFormat("> > #### Deep heading", [{ anchor: 9, head: 13 }], "heading")).toMatchObject({
      doc: "> > Deep heading",
      ranges: [{ anchor: 4, head: 8 }],
    });

    expect(toggleMarkdownFormat("> * Star item", [{ anchor: 4, head: 8 }], "list")).toMatchObject({
      doc: "> Star item",
      ranges: [{ anchor: 2, head: 6 }],
    });
    expect(toggleMarkdownFormat("> > + Plus item", [{ anchor: 6, head: 10 }], "list")).toMatchObject({
      doc: "> > Plus item",
      ranges: [{ anchor: 4, head: 8 }],
    });

    const orderedNested = "> > 12. Ordered nested";
    const ordStart = orderedNested.indexOf("Ordered");
    const ordEnd = ordStart + "Ordered".length;
    const toBullet = toggleMarkdownFormat(orderedNested, [{ anchor: ordStart, head: ordEnd }], "list");
    expect(toBullet.doc).toBe("> > - Ordered nested");
    expect(toBullet.doc.slice(toBullet.ranges[0]!.anchor, toBullet.ranges[0]!.head)).toBe("Ordered");

    const toPlain = toggleMarkdownFormat(toBullet.doc, toBullet.ranges, "list");
    expect(toPlain.doc).toBe("> > Ordered nested");
    expect(toPlain.doc.slice(toPlain.ranges[0]!.anchor, toPlain.ranges[0]!.head)).toBe("Ordered");
  });

  it("handles tight quote markers without trailing spaces, empty quoted lines, thematic breaks, and CRLF", () => {
    const tight = ">>Tight quote";
    const tightHeading = toggleMarkdownFormat(tight, [{ anchor: 2, head: 7 }], "heading");
    expect(tightHeading.doc).toBe(">> ## Tight quote");
    expect(tightHeading.ranges).toEqual([{ anchor: 6, head: 11 }]);

    const emptyQuoted = "> ";
    const emptyHeading = toggleMarkdownFormat(emptyQuoted, [{ anchor: 2, head: 2 }], "heading");
    expect(emptyHeading.doc).toBe("> ## ");
    expect(emptyHeading.ranges).toEqual([{ anchor: 5, head: 5 }]);
    expect(toggleMarkdownFormat(emptyHeading.doc, emptyHeading.ranges, "heading")).toMatchObject({
      doc: "> ",
      ranges: [{ anchor: 2, head: 2 }],
    });

    const bareAngle = ">";
    const bareList = toggleMarkdownFormat(bareAngle, [{ anchor: 1, head: 1 }], "list");
    expect(bareList.doc).toBe("> - ");
    expect(bareList.ranges).toEqual([{ anchor: 4, head: 4 }]);
    expect(toggleMarkdownFormat(bareList.doc, bareList.ranges, "list")).toMatchObject({
      doc: "> ",
      ranges: [{ anchor: 2, head: 2 }],
    });

    // Quoted thematic breaks are preserved across single and repeated list toggles
    for (const quotedRule of ["> - - -", "> ---", "> ***", "> ___", "> > * * *", ">>___", ">\t- - -", ">    - - -"]) {
      const ruleRange = [{ anchor: Math.min(2, quotedRule.length), head: quotedRule.length }];
      const once = toggleMarkdownFormat(quotedRule, ruleRange, "list");
      expect(once).toMatchObject({ doc: quotedRule, changes: [], ranges: ruleRange });
      const twice = toggleMarkdownFormat(once.doc, once.ranges, "list");
      expect(twice).toMatchObject({ doc: quotedRule, changes: [], ranges: ruleRange });
    }

    // Selection with an ordinary quoted line next to a quoted thematic break skips the rule when choosing and applying list toggle
    const lineBeforeRule = "> Ordinary quoted line\n> - - -";
    const beforeRange = [{ anchor: 2, head: lineBeforeRule.length }];
    const beforeOn = toggleMarkdownFormat(lineBeforeRule, beforeRange, "list");
    expect(beforeOn.doc).toBe("> - Ordinary quoted line\n> - - -");
    expect(beforeOn.ranges).toEqual([{ anchor: 4, head: beforeOn.doc.length }]);
    const beforeOff = toggleMarkdownFormat(beforeOn.doc, beforeOn.ranges, "list");
    expect(beforeOff.doc).toBe(lineBeforeRule);
    expect(beforeOff.ranges).toEqual(beforeRange);

    const ruleBeforeLine = "> - - -\n> Ordinary quoted line";
    const afterRange = [{ anchor: 2, head: ruleBeforeLine.length }];
    const afterOn = toggleMarkdownFormat(ruleBeforeLine, afterRange, "list");
    expect(afterOn.doc).toBe("> - - -\n> - Ordinary quoted line");
    expect(afterOn.ranges).toEqual([{ anchor: 2, head: afterOn.doc.length }]);
    const afterOff = toggleMarkdownFormat(afterOn.doc, afterOn.ranges, "list");
    expect(afterOff.doc).toBe(ruleBeforeLine);
    expect(afterOff.ranges).toEqual(afterRange);

    // CRLF line endings stay intact
    const crlf = "> First\r\n> > Second";
    const crlfApplied = toggleMarkdownFormat(crlf, [{ anchor: 2, head: crlf.length }], "list");
    expect(crlfApplied.doc).toBe("> - First\r\n> > - Second");
    expect(toggleMarkdownFormat(crlfApplied.doc, crlfApplied.ranges, "list").doc).toBe(crlf);
  });

  it("preserves blank quoted separator lines across multi-line selections and supports Source multi-cursor", () => {
    const multiParaQuote = "> First point\n>\n> > Second nested point";
    const selStart = multiParaQuote.indexOf("First");
    const selEnd = multiParaQuote.indexOf("nested") + "nested".length;

    const listed = toggleMarkdownFormat(multiParaQuote, [{ anchor: selStart, head: selEnd }], "list");
    expect(listed.doc).toBe("> - First point\n>\n> > - Second nested point");
    expect(listed.doc.slice(listed.ranges[0]!.anchor, listed.ranges[0]!.head)).toBe(
      "First point\n>\n> > - Second nested",
    );

    const unlisted = toggleMarkdownFormat(listed.doc, listed.ranges, "list");
    expect(unlisted.doc).toBe(multiParaQuote);
    expect(unlisted.ranges).toEqual([{ anchor: selStart, head: selEnd }]);

    // Multi-cursor across outer and nested quotes
    const multiCursorDoc = "> Alpha item\n\n> > Beta item";
    const alphaFrom = multiCursorDoc.indexOf("Alpha");
    const betaFrom = multiCursorDoc.indexOf("Beta");
    const ranges = [
      { anchor: alphaFrom, head: alphaFrom + 5 },
      { anchor: betaFrom, head: betaFrom + 4 },
    ];
    const headed = toggleMarkdownFormat(multiCursorDoc, ranges, "heading", 1);
    expect(headed.doc).toBe("> ## Alpha item\n\n> > ## Beta item");
    expect(headed.doc.slice(headed.ranges[0]!.anchor, headed.ranges[0]!.head)).toBe("Alpha");
    expect(headed.doc.slice(headed.ranges[1]!.anchor, headed.ranges[1]!.head)).toBe("Beta");
    expect(headed.mainIndex).toBe(1);

    const unheaded = toggleMarkdownFormat(headed.doc, headed.ranges, "heading", headed.mainIndex);
    expect(unheaded.doc).toBe(multiCursorDoc);
    expect(unheaded.ranges).toEqual(ranges);
  });

  it("aligns partially formatted quoted selections and maps carets positioned before or inside quote markers", () => {
    const partial = "> ## Outer heading\n> > Plain nested\nPlain outside";
    const fullRange = [{ anchor: 0, head: partial.length }];

    const aligned = toggleMarkdownFormat(partial, fullRange, "heading");
    expect(aligned.doc).toBe("> ## Outer heading\n> > ## Plain nested\n## Plain outside");
    expect(aligned.ranges).toEqual([{ anchor: 0, head: aligned.doc.length }]);

    const cleared = toggleMarkdownFormat(aligned.doc, aligned.ranges, "heading");
    expect(cleared.doc).toBe("> Outer heading\n> > Plain nested\nPlain outside");
    expect(cleared.ranges).toEqual([{ anchor: 0, head: cleared.doc.length }]);

    // Caret before quote markers (`|> > Note`, offset 0) stays at 0; caret right after quote markers (`> > |Note`, offset 4) advances past inserted prefix and returns to 4
    const nestedLine = "> > Note";
    const beforeMarkerOn = toggleMarkdownFormat(nestedLine, [{ anchor: 0, head: 0 }], "list");
    expect(beforeMarkerOn).toMatchObject({ doc: "> > - Note", ranges: [{ anchor: 0, head: 0 }] });
    expect(toggleMarkdownFormat(beforeMarkerOn.doc, beforeMarkerOn.ranges, "list")).toMatchObject({
      doc: nestedLine,
      ranges: [{ anchor: 0, head: 0 }],
    });

    const afterMarkerOn = toggleMarkdownFormat(nestedLine, [{ anchor: 4, head: 4 }], "list");
    expect(afterMarkerOn).toMatchObject({ doc: "> > - Note", ranges: [{ anchor: 6, head: 6 }] });
    expect(toggleMarkdownFormat(afterMarkerOn.doc, afterMarkerOn.ranges, "list")).toMatchObject({
      doc: nestedLine,
      ranges: [{ anchor: 4, head: 4 }],
    });
  });
});

describe("quoted-block heading and list toggling in mounted Source and Live editors", () => {
  let hostRoot: Root | null = null;
  let hostContainer: HTMLDivElement | null = null;

  beforeEach(() => {
    localStorage.clear();
    setTypewriterScroll(false, { persist: false });
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    if (hostRoot) {
      act(() => hostRoot!.unmount());
      hostRoot = null;
    }
    hostContainer?.remove();
    hostContainer = null;
    document.body.replaceChildren();
    setTypewriterScroll(false, { persist: false });
    vi.restoreAllMocks();
  });

  it("toggles heading and list inside single and nested quotes in Source mode while preserving markers and source selection offsets", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    hostContainer = container;
    hostRoot = root;

    const sessionId = "quoted-source-session";
    const initialDoc = "# Field Notes\n\n> Outer insight\n> > Nested theorem\n\nClosing remarks.";
    let latestDoc = initialDoc;

    function SourceHarness() {
      const [value, setValue] = useState(initialDoc);
      return (
        <Editor
          sessionId={sessionId}
          value={value}
          onChange={(next) => {
            latestDoc = next;
            setValue(next);
          }}
          dark={false}
          focusMode={false}
        />
      );
    }

    await act(async () => {
      root.render(<SourceHarness />);
    });

    // 1. Select "theorem" inside the nested quote (`> > Nested theorem`)
    const theoremFrom = initialDoc.indexOf("theorem");
    const theoremTo = theoremFrom + "theorem".length;
    act(() => {
      editorFindRange(sessionId, theoremFrom, theoremTo);
    });
    expect(editorSelectedText(sessionId)).toBe("theorem");
    expect(querySourceInsertionPoint()).toEqual({ from: theoremFrom, to: theoremTo });

    // Toggle heading ON inside nested quote (`> > ## Nested theorem`)
    act(() => {
      expect(formatEditorSession(sessionId, "heading")).toBe(true);
    });
    expect(latestDoc).toBe("# Field Notes\n\n> Outer insight\n> > ## Nested theorem\n\nClosing remarks.");
    expect(editorSelectedText(sessionId)).toBe("theorem");
    expect(querySourceInsertionPoint()).toEqual({ from: theoremFrom + 3, to: theoremTo + 3 });
    expect(container.querySelector(".source-position")?.textContent).toBe("Ln 4, Col 22 · 7 selected");

    // Toggle heading BACK OFF -> restores exact `> > Nested theorem` and original source selection offsets
    act(() => {
      expect(formatEditorSession(sessionId, "heading")).toBe(true);
    });
    expect(latestDoc).toBe(initialDoc);
    expect(editorSelectedText(sessionId)).toBe("theorem");
    expect(querySourceInsertionPoint()).toEqual({ from: theoremFrom, to: theoremTo });
    expect(container.querySelector(".source-position")?.textContent).toBe("Ln 4, Col 19 · 7 selected");

    // 2. Select across both quoted levels (`Outer insight\n> > Nested`) and toggle list ON & OFF
    const outerFrom = initialDoc.indexOf("Outer");
    const nestedWordEnd = initialDoc.indexOf("Nested") + "Nested".length;
    act(() => {
      editorFindRange(sessionId, outerFrom, nestedWordEnd);
    });
    expect(querySourceInsertionPoint()).toEqual({ from: outerFrom, to: nestedWordEnd });

    act(() => {
      expect(formatEditorSession(sessionId, "list")).toBe(true);
    });
    expect(latestDoc).toBe("# Field Notes\n\n> - Outer insight\n> > - Nested theorem\n\nClosing remarks.");
    expect(querySourceInsertionPoint()).toEqual({ from: outerFrom + 2, to: nestedWordEnd + 4 });
    expect(editorSelectedText(sessionId)).toBe("Outer insight\n> > - Nested");

    const portableAfterList = exportEditorSession(sessionId);
    expect((portableAfterList?.state as { selection?: { ranges?: Array<{ anchor: number; head: number }> } })?.selection?.ranges).toEqual([
      { anchor: outerFrom + 2, head: nestedWordEnd + 4 },
    ]);

    act(() => {
      expect(formatEditorSession(sessionId, "list")).toBe(true);
    });
    expect(latestDoc).toBe(initialDoc);
    expect(querySourceInsertionPoint()).toEqual({ from: outerFrom, to: nestedWordEnd });
    expect(editorSelectedText(sessionId)).toBe("Outer insight\n> > Nested");
  });

  it("toggles heading and list inside single and nested quotes in Live mode while preserving markers and full-document source selection offsets", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    hostContainer = container;
    hostRoot = root;

    const initialDoc = "# Field Notes\n\n> Outer insight\n> > Nested theorem\n\nClosing remarks.";
    const quoteBlockOffset = initialDoc.indexOf("> Outer insight");
    let latestDoc = initialDoc;

    function LiveHarness() {
      const [markdown, setMarkdown] = useState(initialDoc);
      return (
        <LiveEditor
          markdown={markdown}
          documentPath={null}
          dark={false}
          python=""
          onChange={(next) => {
            latestDoc = next;
            setMarkdown(next);
          }}
        />
      );
    }

    await act(async () => {
      root.render(<LiveHarness />);
    });

    // Double-click the rendered blockquote to open the Live block editor
    const blockquote = container.querySelector("blockquote")!;
    expect(blockquote).not.toBeNull();
    act(() => {
      blockquote.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });

    const area = container.querySelector<HTMLTextAreaElement>("textarea")!;
    expect(area).not.toBeNull();
    expect(area.value).toBe("> Outer insight\n> > Nested theorem");

    // 1. Select "theorem" inside the nested quote (`> > Nested theorem`) with backward direction
    const localTheoremFrom = area.value.indexOf("theorem");
    const localTheoremTo = localTheoremFrom + "theorem".length;
    const docTheoremFrom = quoteBlockOffset + localTheoremFrom;
    const docTheoremTo = quoteBlockOffset + localTheoremTo;

    act(() => {
      area.focus();
      area.setSelectionRange(localTheoremFrom, localTheoremTo, "backward");
    });
    expect(querySourceInsertionPoint()).toEqual({ from: docTheoremFrom, to: docTheoremTo });

    // Toggle heading ON via Ctrl+Shift+H
    act(() => {
      area.dispatchEvent(
        new KeyboardEvent("keydown", { key: "H", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }),
      );
    });
    expect(area.value).toBe("> Outer insight\n> > ## Nested theorem");
    expect(latestDoc).toBe("# Field Notes\n\n> Outer insight\n> > ## Nested theorem\n\nClosing remarks.");
    expect([area.selectionStart, area.selectionEnd, area.selectionDirection]).toEqual([
      localTheoremFrom + 3,
      localTheoremTo + 3,
      "backward",
    ]);
    expect(area.value.slice(area.selectionStart, area.selectionEnd)).toBe("theorem");
    expect(querySourceInsertionPoint()).toEqual({ from: docTheoremFrom + 3, to: docTheoremTo + 3 });
    expect(latestDoc.slice(docTheoremFrom + 3, docTheoremTo + 3)).toBe("theorem");

    // Toggle heading BACK OFF -> preserves `> > ` markers and restores exact local + source selection offsets
    act(() => {
      area.dispatchEvent(
        new KeyboardEvent("keydown", { key: "H", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }),
      );
    });
    expect(area.value).toBe("> Outer insight\n> > Nested theorem");
    expect(latestDoc).toBe(initialDoc);
    expect([area.selectionStart, area.selectionEnd, area.selectionDirection]).toEqual([
      localTheoremFrom,
      localTheoremTo,
      "backward",
    ]);
    expect(querySourceInsertionPoint()).toEqual({ from: docTheoremFrom, to: docTheoremTo });

    // 2. Select across outer + nested quoted lines and toggle list ON and OFF via supermd-format
    const localOuterFrom = area.value.indexOf("Outer");
    const localNestedEnd = area.value.indexOf("Nested") + "Nested".length;
    const docOuterFrom = quoteBlockOffset + localOuterFrom;
    const docNestedEnd = quoteBlockOffset + localNestedEnd;

    act(() => {
      area.setSelectionRange(localOuterFrom, localNestedEnd, "forward");
      window.dispatchEvent(new CustomEvent("supermd-format", { detail: { action: "list" } }));
    });
    expect(area.value).toBe("> - Outer insight\n> > - Nested theorem");
    expect(latestDoc).toBe("# Field Notes\n\n> - Outer insight\n> > - Nested theorem\n\nClosing remarks.");
    expect([area.selectionStart, area.selectionEnd]).toEqual([localOuterFrom + 2, localNestedEnd + 4]);
    expect(querySourceInsertionPoint()).toEqual({ from: docOuterFrom + 2, to: docNestedEnd + 4 });
    expect(latestDoc.slice(docOuterFrom + 2, docNestedEnd + 4)).toBe("Outer insight\n> > - Nested");

    // Toggle list OFF on only the outer quoted line (`> - Outer insight`) -> preserves `> ` and leaves nested list intact
    act(() => {
      area.setSelectionRange(localOuterFrom + 2, localOuterFrom + 7);
      area.dispatchEvent(
        new KeyboardEvent("keydown", { key: "L", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }),
      );
    });
    expect(area.value).toBe("> Outer insight\n> > - Nested theorem");
    expect([area.selectionStart, area.selectionEnd]).toEqual([localOuterFrom, localOuterFrom + 5]);
    expect(querySourceInsertionPoint()).toEqual({ from: docOuterFrom, to: docOuterFrom + 5 });

    // Toggle heading ON on outer quoted line (`> ## Outer insight`) then close Live block and verify rendered structure
    act(() => {
      window.dispatchEvent(new CustomEvent("supermd-format", { detail: { action: "heading" } }));
    });
    expect(area.value).toBe("> ## Outer insight\n> > - Nested theorem");
    expect(querySourceInsertionPoint()).toEqual({ from: docOuterFrom + 3, to: docOuterFrom + 8 });

    act(() => {
      area.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.querySelector("blockquote > h2")?.textContent).toBe("Outer insight");
    expect(container.querySelector("blockquote blockquote ul li")?.textContent).toBe("Nested theorem");
  });

  it("preserves quoted thematic breaks and renders list + thematic break cleanly when toggling an ordinary quoted line next to the rule", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    hostContainer = container;
    hostRoot = root;

    const sessionId = "quoted-rule-split-session";
    const initialDoc = "# Axioms\n\n> Ordinary quoted line\n> - - -\n\nClosing note.";
    let latestDoc = initialDoc;

    function SplitHarness() {
      const [value, setValue] = useState(initialDoc);
      return (
        <div>
          <Editor
            sessionId={sessionId}
            value={value}
            onChange={(next) => {
              latestDoc = next;
              setValue(next);
            }}
            dark={false}
            focusMode={false}
          />
          <MarkdownPreview markdown={value} documentPath={null} python="" dark={false} />
        </div>
      );
    }

    await act(async () => {
      root.render(<SplitHarness />);
    });

    expect(container.querySelector(".markdown-body blockquote > p")?.textContent).toBe("Ordinary quoted line");
    expect(container.querySelectorAll(".markdown-body blockquote > hr")).toHaveLength(1);
    expect(container.querySelectorAll(".markdown-body blockquote ul")).toHaveLength(0);

    // 1. Selecting only `> - - -` and toggling list twice preserves the source and rendered `<hr>` without creating a list or adding hyphens
    const ruleStart = initialDoc.indexOf("> - - -") + 2;
    const ruleEnd = initialDoc.indexOf("> - - -") + "> - - -".length;
    act(() => {
      editorFindRange(sessionId, ruleStart, ruleEnd);
    });
    await act(async () => {
      expect(formatEditorSession(sessionId, "list")).toBe(true);
      expect(formatEditorSession(sessionId, "list")).toBe(true);
    });
    expect(latestDoc).toBe(initialDoc);
    expect(querySourceInsertionPoint()).toEqual({ from: ruleStart, to: ruleEnd });
    expect(container.querySelectorAll(".markdown-body blockquote > hr")).toHaveLength(1);
    expect(container.querySelectorAll(".markdown-body blockquote ul")).toHaveLength(0);

    // 2. Selecting the ordinary quoted line together with `> - - -` toggles only the ordinary line into a list and back
    const ordinaryStart = initialDoc.indexOf("Ordinary");
    act(() => {
      editorFindRange(sessionId, ordinaryStart, ruleEnd);
    });
    await act(async () => {
      expect(formatEditorSession(sessionId, "list")).toBe(true);
    });
    expect(latestDoc).toBe("# Axioms\n\n> - Ordinary quoted line\n> - - -\n\nClosing note.");
    expect(querySourceInsertionPoint()).toEqual({ from: ordinaryStart + 2, to: ruleEnd + 2 });
    expect(container.querySelector(".markdown-body blockquote > ul > li")?.textContent).toBe("Ordinary quoted line");
    expect(container.querySelectorAll(".markdown-body blockquote > hr")).toHaveLength(1);

    await act(async () => {
      expect(formatEditorSession(sessionId, "list")).toBe(true);
    });
    expect(latestDoc).toBe(initialDoc);
    expect(querySourceInsertionPoint()).toEqual({ from: ordinaryStart, to: ruleEnd });
    expect(container.querySelector(".markdown-body blockquote > p")?.textContent).toBe("Ordinary quoted line");
    expect(container.querySelectorAll(".markdown-body blockquote > hr")).toHaveLength(1);
    expect(container.querySelectorAll(".markdown-body blockquote ul")).toHaveLength(0);

    // 3. Verify the same rendered regression in Live mode when editing the blockquote directly
    function LiveRuleHarness() {
      const [markdown, setMarkdown] = useState(initialDoc);
      return (
        <LiveEditor
          markdown={markdown}
          documentPath={null}
          dark={false}
          python=""
          onChange={(next) => {
            latestDoc = next;
            setMarkdown(next);
          }}
        />
      );
    }

    await act(async () => {
      root.render(<LiveRuleHarness />);
    });

    const openBlockquote = () => {
      const blockquote = container.querySelector("blockquote")!;
      expect(blockquote).not.toBeNull();
      act(() => {
        blockquote.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      });
      return container.querySelector<HTMLTextAreaElement>("textarea")!;
    };

    let area = openBlockquote();
    expect(area.value).toBe("> Ordinary quoted line\n> - - -");

    act(() => {
      area.focus();
      area.setSelectionRange(2, area.value.length, "forward");
      window.dispatchEvent(new CustomEvent("supermd-format", { detail: { action: "list" } }));
    });
    expect(area.value).toBe("> - Ordinary quoted line\n> - - -");
    expect([area.selectionStart, area.selectionEnd]).toEqual([4, area.value.length]);

    act(() => {
      area.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(container.querySelector("blockquote > ul > li")?.textContent).toBe("Ordinary quoted line");
    expect(container.querySelectorAll("blockquote > hr")).toHaveLength(1);

    area = openBlockquote();
    act(() => {
      area.focus();
      area.setSelectionRange(4, area.value.length, "forward");
      window.dispatchEvent(new CustomEvent("supermd-format", { detail: { action: "list" } }));
      area.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(latestDoc).toBe(initialDoc);
    expect(container.querySelector("blockquote > p")?.textContent).toBe("Ordinary quoted line");
    expect(container.querySelectorAll("blockquote > hr")).toHaveLength(1);
    expect(container.querySelectorAll("blockquote ul")).toHaveLength(0);
  });
});
