import { describe, expect, it } from "vitest";
import LiveEditor,{ splitMarkdownBlocks } from "./LiveEditor";
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import MarkdownPreview from './MarkdownPreview';
import { editableBlockSpans, indentMarkdownSelection, isFirstLineCursor, isLastLineCursor } from "../liveBlockFlow";

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
  });
});
