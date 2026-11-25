import { describe, expect, it } from "vitest";
import {
  FORMAT_ACTIONS,
  applyMarkdownUrlPaste,
  formatActionFromKeyEvent,
  isProtectedMarkdownSelection,
  normalizeFormatAction,
  parseStandaloneHttpUrl,
  toggleMarkdownFormat,
  type FormatAction,
} from "./markdownFormatting";

describe("toggleMarkdownFormat", () => {
  it.each<[FormatAction, string, string]>([
    ["bold", "hello world", "hello **world**"],
    ["italic", "hello world", "hello *world*"],
    ["inline_code", "hello world", "hello `world`"],
    ["inline_math", "hello world", "hello $world$"],
    ["link", "hello world", "hello [world]()"],
    ["heading", "hello world", "## hello world"],
    ["list", "hello world", "- hello world"],
    ["quote", "hello world", "> hello world"],
  ])("applies and cleanly removes %s when invoked twice on selected prose", (action, initial, onceExpected) => {
    const initialRange = [{ anchor: 6, head: 11 }];
    const first = toggleMarkdownFormat(initial, initialRange, action);
    expect(first.doc).toBe(onceExpected);

    const second = toggleMarkdownFormat(first.doc, first.ranges, action);
    expect(second.doc).toBe(initial);
    expect(second.ranges).toEqual(initialRange);
  });

  it.each<FormatAction>([...FORMAT_ACTIONS])(
    "applies and removes %s cleanly when invoked twice at a bare cursor",
    (action) => {
      const initial = "";
      const initialRange = [{ anchor: 0, head: 0 }];
      const first = toggleMarkdownFormat(initial, initialRange, action);
      expect(first.doc.length).toBeGreaterThan(0);

      const second = toggleMarkdownFormat(first.doc, first.ranges, action);
      expect(second.doc).toBe(initial);
      expect(second.ranges).toEqual(initialRange);
    },
  );

  it("distinguishes bold (**), italic (*), and bold+italic (***) without corrupting markers", () => {
    const base = "word";
    const bolded = toggleMarkdownFormat(base, [{ anchor: 0, head: 4 }], "bold");
    expect(bolded.doc).toBe("**word**");
    expect(bolded.ranges).toEqual([{ anchor: 2, head: 6 }]);

    const boldItalic = toggleMarkdownFormat(bolded.doc, bolded.ranges, "italic");
    expect(boldItalic.doc).toBe("***word***");
    expect(boldItalic.ranges).toEqual([{ anchor: 3, head: 7 }]);

    const backToBold = toggleMarkdownFormat(boldItalic.doc, boldItalic.ranges, "italic");
    expect(backToBold.doc).toBe("**word**");
    expect(backToBold.ranges).toEqual([{ anchor: 2, head: 6 }]);

    const plain = toggleMarkdownFormat(backToBold.doc, backToBold.ranges, "bold");
    expect(plain.doc).toBe("word");
    expect(plain.ranges).toEqual([{ anchor: 0, head: 4 }]);
  });

  it("unwraps markers even when the user selects the markers themselves", () => {
    expect(toggleMarkdownFormat("**bold**", [{ anchor: 0, head: 8 }], "bold")).toMatchObject({
      doc: "bold",
      ranges: [{ anchor: 0, head: 4 }],
    });
    expect(toggleMarkdownFormat("_italic_", [{ anchor: 0, head: 8 }], "italic")).toMatchObject({
      doc: "italic",
      ranges: [{ anchor: 0, head: 6 }],
    });
    expect(toggleMarkdownFormat("[docs](https://example.com)", [{ anchor: 0, head: 27 }], "link")).toMatchObject({
      doc: "docs",
      ranges: [{ anchor: 0, head: 4 }],
    });
  });

  it("toggles multiple cursors simultaneously in Source mode", () => {
    const initial = "alpha and beta";
    const ranges = [
      { anchor: 0, head: 5 },
      { anchor: 10, head: 14 },
    ];
    const wrapped = toggleMarkdownFormat(initial, ranges, "bold", 1);
    expect(wrapped.doc).toBe("**alpha** and **beta**");
    expect(wrapped.ranges).toEqual([
      { anchor: 2, head: 7 },
      { anchor: 16, head: 20 },
    ]);
    expect(wrapped.mainIndex).toBe(1);

    const unwrapped = toggleMarkdownFormat(wrapped.doc, wrapped.ranges, "bold", wrapped.mainIndex);
    expect(unwrapped.doc).toBe(initial);
    expect(unwrapped.ranges).toEqual(ranges);
  });

  it("toggles block prefixes across multi-line selections without touching trailing unselected line", () => {
    const initial = "first\nsecond\nthird";
    // Selecting "first\nsecond\n" (head at column 0 of "third")
    const firstPass = toggleMarkdownFormat(initial, [{ anchor: 0, head: 13 }], "quote");
    expect(firstPass.doc).toBe("> first\n> second\nthird");

    const secondPass = toggleMarkdownFormat(firstPass.doc, firstPass.ranges, "quote");
    expect(secondPass.doc).toBe(initial);
  });

  it("removes existing H1-H6 prefixes when toggling heading on a heading line", () => {
    const h3 = "### Section title";
    const stripped = toggleMarkdownFormat(h3, [{ anchor: 4, head: 11 }], "heading");
    expect(stripped.doc).toBe("Section title");
    expect(stripped.ranges).toEqual([{ anchor: 0, head: 7 }]);
  });
});

describe("applyMarkdownUrlPaste & protected contexts", () => {
  it("parses standalone HTTP/HTTPS URLs and rejects prose or non-web schemes", () => {
    expect(parseStandaloneHttpUrl("https://example.com/path?a=1#frag")).toBe("https://example.com/path?a=1#frag");
    expect(parseStandaloneHttpUrl("  http://localhost:3000/test  ")).toBe("http://localhost:3000/test");
    expect(parseStandaloneHttpUrl("javascript:alert(1)")).toBeNull();
    expect(parseStandaloneHttpUrl("see https://example.com now")).toBeNull();
    expect(parseStandaloneHttpUrl("https://a.com\nhttps://b.com")).toBeNull();
  });

  it("wraps non-empty selected prose in unprotected Markdown as [selected text](url)", () => {
    const doc = "Read selected text today.";
    const result = applyMarkdownUrlPaste(doc, [{ anchor: 5, head: 18 }], "https://example.com/guide");
    expect(result).not.toBeNull();
    expect(result!.doc).toBe("Read [selected text](https://example.com/guide) today.");
    const expectedCaret = "Read [selected text](https://example.com/guide)".length;
    expect(result!.ranges).toEqual([{ anchor: expectedCaret, head: expectedCaret }]);
  });

  it("returns null for bare cursor so plain URL paste occurs", () => {
    const doc = "Paste here: ";
    expect(applyMarkdownUrlPaste(doc, [{ anchor: 12, head: 12 }], "https://example.com")).toBeNull();
  });

  it("returns null inside fenced code, inline code, HTML, math, and existing links/images", () => {
    const url = "https://example.com/new";

    const fenced = "```python\nselected = 1\n```";
    expect(isProtectedMarkdownSelection(fenced, 10, 18)).toBe(true);
    expect(applyMarkdownUrlPaste(fenced, [{ anchor: 10, head: 18 }], url)).toBeNull();

    const unclosedFenced = "```js\nconst selected = true;";
    expect(applyMarkdownUrlPaste(unclosedFenced, [{ anchor: 12, head: 20 }], url)).toBeNull();

    const inlineCode = "Run `selected` command";
    expect(applyMarkdownUrlPaste(inlineCode, [{ anchor: 5, head: 13 }], url)).toBeNull();

    const inlineMath = "Given $selected + 1$ in text";
    expect(applyMarkdownUrlPaste(inlineMath, [{ anchor: 7, head: 15 }], url)).toBeNull();

    const displayMath = "$$\nselected = x^2\n$$";
    expect(applyMarkdownUrlPaste(displayMath, [{ anchor: 3, head: 11 }], url)).toBeNull();

    const htmlBlock = "<div>selected</div>";
    expect(applyMarkdownUrlPaste(htmlBlock, [{ anchor: 5, head: 13 }], url)).toBeNull();

    const inlineHtmlKbd = "Press <kbd>selected</kbd> now";
    const kbdStart = inlineHtmlKbd.indexOf("selected");
    expect(applyMarkdownUrlPaste(inlineHtmlKbd, [{ anchor: kbdStart, head: kbdStart + 8 }], url)).toBeNull();

    const inlineHtmlAnchor = 'Visit <a href="https://old.example">selected</a> link';
    const anchorStart = inlineHtmlAnchor.indexOf("selected");
    expect(applyMarkdownUrlPaste(inlineHtmlAnchor, [{ anchor: anchorStart, head: anchorStart + 8 }], url)).toBeNull();

    const studyHighlight = "Review ==selected== concept";
    const highlightStart = studyHighlight.indexOf("selected");
    expect(applyMarkdownUrlPaste(studyHighlight, [{ anchor: highlightStart, head: highlightStart + 8 }], url)?.doc).toBe(
      "Review ==[selected](https://example.com/new)== concept",
    );

    const existingLinkLabel = "See [selected](https://old.example) here";
    expect(applyMarkdownUrlPaste(existingLinkLabel, [{ anchor: 5, head: 13 }], url)).toBeNull();

    const existingLinkDest = "See [label](https://old.example) here";
    expect(applyMarkdownUrlPaste(existingLinkDest, [{ anchor: 12, head: 31 }], url)).toBeNull();

    const unfinishedLinkDest = "See [label](placeholder";
    expect(applyMarkdownUrlPaste(unfinishedLinkDest, [{ anchor: 12, head: 23 }], url)).toBeNull();

    const imageAlt = "![selected](assets/pic.png)";
    expect(applyMarkdownUrlPaste(imageAlt, [{ anchor: 2, head: 10 }], url)).toBeNull();

    const wikilink = "See [[Note|selected]] in vault";
    expect(applyMarkdownUrlPaste(wikilink, [{ anchor: 11, head: 19 }], url)).toBeNull();

    const frontmatter = "---\ntitle: selected\n---\n\nBody prose";
    expect(applyMarkdownUrlPaste(frontmatter, [{ anchor: 11, head: 19 }], url)).toBeNull();
    expect(applyMarkdownUrlPaste(frontmatter, [{ anchor: 25, head: 29 }], url)?.doc).toBe(
      "---\ntitle: selected\n---\n\n[Body](https://example.com/new) prose",
    );

    const dottedFrontmatter = "\uFEFF---  \ntitle: selected\n...\n\nBody prose";
    const dottedStart = dottedFrontmatter.indexOf("selected");
    const dottedBody = dottedFrontmatter.indexOf("Body");
    expect(applyMarkdownUrlPaste(dottedFrontmatter, [{ anchor: dottedStart, head: dottedStart + 8 }], url)).toBeNull();
    expect(applyMarkdownUrlPaste(dottedFrontmatter, [{ anchor: dottedBody, head: dottedBody + 4 }], url)?.doc).toBe(
      "\uFEFF---  \ntitle: selected\n...\n\n[Body](https://example.com/new) prose",
    );
  });
});

describe("shortcut helpers", () => {
  it("normalizes action names and matches fixed non-Qt key events", () => {
    expect(normalizeFormatAction("bold")).toBe("bold");
    expect(normalizeFormatAction("code")).toBe("inline_code");
    expect(normalizeFormatAction("math")).toBe("inline_math");
    expect(normalizeFormatAction("unknown")).toBeNull();

    expect(formatActionFromKeyEvent({ key: "b", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false })).toBe("bold");
    expect(formatActionFromKeyEvent({ key: "`", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false })).toBe("inline_code");
    expect(formatActionFromKeyEvent({ key: "H", ctrlKey: false, metaKey: true, shiftKey: true, altKey: false })).toBe("heading");
    expect(formatActionFromKeyEvent({ key: "q", ctrlKey: false, metaKey: true, shiftKey: false, altKey: true })).toBe("quote");
  });
});
