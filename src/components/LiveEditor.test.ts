import { describe, expect, it } from "vitest";
import LiveEditor,{ formatActiveLiveBlock, replayActiveLiveBlockHistory, splitMarkdownBlocks } from "./LiveEditor";
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import MarkdownPreview from './MarkdownPreview';
import { editableBlockSpans, indentMarkdownSelection, isFirstLineCursor, isLastLineCursor } from "../liveBlockFlow";
import {
  BLOCK_TYPING_COALESCE_MS,
  MAX_BLOCK_HISTORY,
  createBlockHistoryState,
  diffTextSpan,
  popBlockHistorySnapshot,
  pushBlockUndoSnapshot,
  pushDiscreteSelectionStep,
  reconcileBlockKeys,
  recordCoalescedBlockTypingSnapshot,
  resolveReanchoredHistoryTarget,
  setActiveLiveBlockHandlers,
  translateRenderedRange,
  type BlockKeyState,
  type EditSpan,
  type EditingSession,
} from "../liveBlockHistory";
import { resolveDoubleClickCaretRange, resolveLiveCaretOffset } from "../liveInsertionPoint";

describe("live Markdown blocks", () => {
  it("keeps fenced code and callouts intact across blank lines", () => {
    const note = "# Heading\n\n```python\na = 1\n\nprint(a)\n```\n\n:::callout tip\nOne\n\nTwo\n:::\n\nEnd";
    const blocks = splitMarkdownBlocks(note);
    expect(blocks).toHaveLength(4);
    expect(blocks[1].text).toContain("\n\nprint(a)");
    expect(blocks[2].text).toContain("One\n\nTwo");
    expect(blocks.map((block) => block.text).join("")).toBe(note);
  });
  it('keeps loose and nested list items in one semantic editable block',()=>{
    const note='1. One\n\n2. Two\n\n   - Nested\n\n3. Three\n\nAfter';
    const blocks=splitMarkdownBlocks(note);
    expect(blocks).toHaveLength(2);expect(blocks[0].text).toContain('3. Three');
    expect(blocks.map(block=>block.text).join('')).toBe(note);
  });
  it('renders references, footnotes and duplicate heading IDs with document-wide context',()=>{
    const markdown='# Topic\n\nRead [the documentation][ref]. A result[^1].\n\n# Topic\n\nAnother result[^2].\n\n[ref]: https://example.com\n\n[^1]: First source.\n\n[^2]: Second source.';
    const props={markdown,documentPath:null,python:'',dark:false};
    const read=renderToStaticMarkup(createElement(MarkdownPreview,props));
    const live=renderToStaticMarkup(createElement(LiveEditor,{...props,onChange:()=>{}}));
    expect(live).toContain('href="https://example.com"');
    expect(live.match(/data-footnote-ref=/g)).toHaveLength(2);
    expect(live.match(/data-footnotes=/g)).toHaveLength(1);
    expect(live).toContain('id="topic"');expect(live).toContain('id="topic-1"');
    expect((live.match(/href=/g)||[]).length).toBe((read.match(/href=/g)||[]).length);
    expect(live).toContain('First source.');expect(live).toContain('Second source.');
  });
  it('excludes YAML frontmatter from splitMarkdownBlocks across delimiter variations',()=>{
    const prefix='\uFEFF---  \ntitle: Isolated\ntags: [one]\n...\n\n';
    const body='# First Heading\n\nParagraph text.';
    const source=prefix+body;
    const blocks=splitMarkdownBlocks(source);
    expect(blocks[0].start).toBe(prefix.length);
    expect(blocks[0].text).toBe('# First Heading\n\n');
    expect(blocks[0].text).not.toContain('Isolated');
    expect(source.slice(0,blocks[0].start)+blocks.map(b=>b.text).join('')).toBe(source);
  });
});

describe("CommonMark block flow helpers", () => {
  it("indents and outdents bullet, ordered, and task list items by CommonMark rules", () => {
    const bullet = "- Parent\n- Child";
    const indentedBullet = indentMarkdownSelection(bullet, 11, 11, false);
    expect(indentedBullet.value).toBe("- Parent\n  - Child");
    expect(indentedBullet.selectionStart).toBe(13);
    const outdentedBullet = indentMarkdownSelection(indentedBullet.value, indentedBullet.selectionStart, indentedBullet.selectionEnd, true);
    expect(outdentedBullet.value).toBe(bullet);
    expect(outdentedBullet.selectionStart).toBe(11);

    // Bullet or ordered item nested under `1. ` aligns at column 3; under `10. ` at column 4.
    const ordered = "1. First\n- Subitem";
    const underOrdered = indentMarkdownSelection(ordered, 12, 12, false);
    expect(underOrdered.value).toBe("1. First\n   - Subitem");
    expect(indentMarkdownSelection(underOrdered.value, underOrdered.selectionStart, underOrdered.selectionEnd, true).value).toBe(ordered);

    const doubleDigit = "10. Ten\n11. Eleven";
    const underTen = indentMarkdownSelection(doubleDigit, 12, 12, false);
    expect(underTen.value).toBe("10. Ten\n    11. Eleven");
    expect(indentMarkdownSelection(underTen.value, underTen.selectionStart, underTen.selectionEnd, true).value).toBe(doubleDigit);

    // Task items align by their list marker width (`- ` = 2, `1. ` = 3).
    const task = "- [ ] Parent\n- [x] Subtask";
    const indentedTask = indentMarkdownSelection(task, 20, 20, false);
    expect(indentedTask.value).toBe("- [ ] Parent\n  - [x] Subtask");
    expect(indentMarkdownSelection(indentedTask.value, indentedTask.selectionStart, indentedTask.selectionEnd, true).value).toBe(task);
  });

  it("indents and outdents inside blockquotes and plain text without breaking prefixes", () => {
    const quotedList = "> 1. Quoted parent\n> - Quoted child";
    const indented = indentMarkdownSelection(quotedList, 24, 24, false);
    expect(indented.value).toBe("> 1. Quoted parent\n>    - Quoted child");
    const outdented = indentMarkdownSelection(indented.value, indented.selectionStart, indented.selectionEnd, true);
    expect(outdented.value).toBe(quotedList);

    const quotedPlain = "> Plain quote";
    const indentedPlain = indentMarkdownSelection(quotedPlain, 5, 5, false);
    expect(indentedPlain.value).toBe(">   Plain quote");
    expect(indentMarkdownSelection(indentedPlain.value, indentedPlain.selectionStart, indentedPlain.selectionEnd, true).value).toBe(quotedPlain);

    // Shift+Tab at zero indentation is a safe no-op.
    const zero = indentMarkdownSelection("- Root item", 2, 2, true);
    expect(zero.value).toBe("- Root item");
    expect(zero.selectionStart).toBe(2);

    // Multi-line selection shifts selected items together and preserves selection span.
    const multi = "1. Top\n- A\n  - B";
    const multiIndented = indentMarkdownSelection(multi, 7, multi.length, false);
    expect(multiIndented.value).toBe("1. Top\n   - A\n     - B");
    const multiOutdented = indentMarkdownSelection(multiIndented.value, multiIndented.selectionStart, multiIndented.selectionEnd, true);
    expect(multiOutdented.value).toBe(multi);
  });

  it("detects first/last line cursors and skips non-rendered definition spans", () => {
    const text = "First\nMiddle\nLast";
    expect(isFirstLineCursor(text, 0, 0)).toBe(true);
    expect(isFirstLineCursor(text, 5, 5)).toBe(true);
    expect(isFirstLineCursor(text, 6, 6)).toBe(false);
    expect(isLastLineCursor(text, 6, 6)).toBe(false);
    expect(isLastLineCursor(text, 13, 13)).toBe(true);
    expect(isLastLineCursor(text, text.length, text.length)).toBe(true);

    const doc = "# One\n\n[ref]: https://example.com\n\nParagraph[^1]\n\n[^1]: Note";
    const spans = editableBlockSpans(doc);
    expect(spans).toHaveLength(2);
    expect(doc.slice(spans[0].start, spans[0].end)).toBe("# One");
    expect(doc.slice(spans[1].start, spans[1].end)).toBe("Paragraph[^1]");

    const withFrontmatter = "\uFEFF---  \ntitle: Metadata\n...\n\n# First\n\nSecond";
    const fmSpans = editableBlockSpans(withFrontmatter);
    expect(fmSpans).toHaveLength(2);
    expect(withFrontmatter.slice(fmSpans[0].start, fmSpans[0].end)).toBe("# First");
    expect(withFrontmatter.slice(fmSpans[1].start, fmSpans[1].end)).toBe("Second");
  });
});

describe("liveBlockHistory helpers", () => {
  it("computes minimal changed text spans across insertions, deletions, and shared boundaries", () => {
    expect(diffTextSpan("same text", "same text")).toEqual({ start: 9, oldEnd: 9, newEnd: 9 });
    expect(diffTextSpan("- [ ] First\n- [ ] Second", "- [x] First\n- [ ] Second")).toEqual({ start: 3, oldEnd: 4, newEnd: 4 });
    expect(diffTextSpan("# Heading\n\nTail", "# Heading expanded\n\nTail")).toEqual({ start: 9, oldEnd: 9, newEnd: 18 });
    expect(diffTextSpan("aaaa", "aa")).toEqual({ start: 2, oldEnd: 4, newEnd: 2 });
  });

  it("caps discrete and coalesced block undo stacks at 60 entries and replays undo/redo cleanly", () => {
    const history = createBlockHistoryState();
    for (let i = 0; i < MAX_BLOCK_HISTORY + 5; i++) {
      pushBlockUndoSnapshot(history, { text: `step-${i}`, start: i, end: i, direction: "none" });
    }
    expect(history.undo).toHaveLength(MAX_BLOCK_HISTORY);
    expect(history.undo[0].text).toBe("step-5");
    expect(history.undo.at(-1)?.text).toBe("step-64");

    const typing = createBlockHistoryState();
    recordCoalescedBlockTypingSnapshot(typing, { text: "a", start: 1, end: 1, direction: "none" }, "ab", 1_000);
    recordCoalescedBlockTypingSnapshot(typing, { text: "ab", start: 2, end: 2, direction: "none" }, "abc", 1_000 + BLOCK_TYPING_COALESCE_MS - 10);
    expect(typing.undo).toHaveLength(1);
    recordCoalescedBlockTypingSnapshot(typing, { text: "abc", start: 3, end: 3, direction: "none" }, "abcd", 2_000 + BLOCK_TYPING_COALESCE_MS);
    expect(typing.undo).toHaveLength(2);
    recordCoalescedBlockTypingSnapshot(typing, { text: "abcd", start: 4, end: 4, direction: "none" }, "abcd pasted", 2_010 + BLOCK_TYPING_COALESCE_MS);
    expect(typing.undo).toHaveLength(3);

    const undone = popBlockHistorySnapshot(typing, "undo", { text: "abcd pasted", start: 11, end: 11, direction: "none" });
    expect(undone?.text).toBe("abcd");
    expect(typing.redo).toHaveLength(1);
    const redone = popBlockHistorySnapshot(typing, "redo", undone!);
    expect(redone?.text).toBe("abcd pasted");
    pushBlockUndoSnapshot(typing, redone!);
    expect(typing.redo).toHaveLength(0);
  });

  it("translates rendered ranges and preserves upstream/downstream block keys across edits", () => {
    const base = "# Intro\n\nBody\n\nTail";
    const synced = "# Intro longer\n\nBody\n\nTail";
    const session: EditingSession = {
      session: 1, prefix: "", suffix: "\n\nBody\n\nTail", baseMarkdown: base, baseSplitEnd: 7, protectedBlock: false,
    };
    expect(translateRenderedRange(0, 7, session, synced)).toEqual([0, 7]);
    expect(translateRenderedRange(9, 13, session, synced)).toEqual([16, 20]);

    const state: BlockKeyState = { source: "", keys: new Map(), seq: 0 };
    const spanRef: { current: EditSpan | null } = { current: null };
    const initialKeys = new Map(reconcileBlockKeys(state, base, splitMarkdownBlocks(base), spanRef));
    const edited = "# Intro\n\nBody updated\n\nSecond mid\n\nTail";
    spanRef.current = { baseSource: base, start: 9, oldEnd: 13, newEnd: 33 };
    const nextBlocks = splitMarkdownBlocks(edited);
    const nextKeys = reconcileBlockKeys(state, edited, nextBlocks, spanRef);
    expect(spanRef.current).toBeNull();
    expect(nextKeys.get(0)).toBe(initialKeys.get(0));
    expect(nextKeys.get(nextBlocks.at(-1)!.start)).toBe(initialKeys.get(15));

    expect(formatActiveLiveBlock("bold")).toBe(false);
    expect(replayActiveLiveBlockHistory("undo")).toBe(false);
    const clear = setActiveLiveBlockHandlers((action) => action === "bold", (dir) => dir === "undo");
    expect(formatActiveLiveBlock("bold")).toBe(true);
    expect(formatActiveLiveBlock("unknown")).toBe(false);
    expect(replayActiveLiveBlockHistory("undo")).toBe(true);
    clear();
    expect(formatActiveLiveBlock("bold")).toBe(false);
  });

  it("caps discrete selection steps and resolves reanchored history targets across blocks and frontmatter", () => {
    const history = createBlockHistoryState();
    for (let i = 0; i < MAX_BLOCK_HISTORY + 3; i++) {
      pushDiscreteSelectionStep(history, {
        beforeText: `b-${i}`, beforeStart: 0, beforeEnd: 0, beforeDirection: "none",
        afterText: `a-${i}`, afterStart: 3, afterEnd: 3, afterDirection: "none",
      });
    }
    expect(history.discreteUndo).toHaveLength(MAX_BLOCK_HISTORY);
    expect(history.discreteUndo[0].beforeText).toBe("b-3");
    history.discreteRedo.push(history.discreteUndo[0]);
    recordCoalescedBlockTypingSnapshot(history, { text: "x", start: 1, end: 1, direction: "none" }, "xy", 5_000);
    expect(history.discreteRedo).toHaveLength(0);

    const prev = "---\ntitle: One\n---\n\nFirst block\n\nSecond block edited";
    const next = "---\ntitle: One\n---\n\nFirst block\n\nSecond block";
    expect(resolveReanchoredHistoryTarget(prev, next)).toEqual({
      start: 33,
      end: 45,
      caretOffset: 12,
    });
    const nextFm = "---\ntitle: Two\n---\n\nFirst block\n\nSecond block";
    expect(resolveReanchoredHistoryTarget(next, nextFm)).toBeNull();
  });

  it("guards invalid block and range inputs in live caret resolution helpers", () => {
    expect(resolveLiveCaretOffset(null, null, "# Heading", 0, 9)).toBeNull();
    expect(resolveLiveCaretOffset({ contains: () => false } as unknown as HTMLElement, {} as Range, "# Heading", 0, 9)).toBeNull();
    expect(resolveLiveCaretOffset({ contains: () => true } as unknown as HTMLElement, {} as Range, "# Heading", 9, 3)).toBeNull();
    expect(typeof resolveDoubleClickCaretRange).toBe("function");
  });
});
