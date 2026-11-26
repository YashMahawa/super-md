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

  it("unwraps a caret inside bold text on bold and prevents other inline formats from splitting it", () => {
    const doc = "Observe **Fourier** series";
    const caretInBold = doc.indexOf("Fourier") + 3; // "Observe **Fou|rier** series"

    // Different inline formats at a bare caret inside bold must not split `**Fourier**`
    for (const other of ["italic", "inline_code", "inline_math", "link"] as const) {
      const guarded = toggleMarkdownFormat(doc, [{ anchor: caretInBold, head: caretInBold }], other);
      expect(guarded.doc).toBe(doc);
      expect(guarded.changes).toEqual([]);
      expect(guarded.ranges).toEqual([{ anchor: caretInBold, head: caretInBold }]);
    }

    // Same-format `bold` with a caret inside `**Fou|rier**` unwraps cleanly and preserves the caret offset
    const unwrapped = toggleMarkdownFormat(doc, [{ anchor: caretInBold, head: caretInBold }], "bold");
    expect(unwrapped.doc).toBe("Observe Fourier series");
    const expectedCaret = "Observe Fou".length;
    expect(unwrapped.ranges).toEqual([{ anchor: expectedCaret, head: expectedCaret }]);

    // Nested bold+italic (`***Fou|rier***`): bold unwraps strong leaving `*Fou|rier*`, italic unwraps emphasis leaving `**Fou|rier**`
    const boldItalicDoc = "***Fourier***";
    const nestedCaret = 6; // `***Fou|rier***`
    const afterUnbold = toggleMarkdownFormat(boldItalicDoc, [{ anchor: nestedCaret, head: nestedCaret }], "bold");
    expect(afterUnbold.doc).toBe("*Fourier*");
    expect(afterUnbold.ranges).toEqual([{ anchor: 4, head: 4 }]);

    const afterUnitalic = toggleMarkdownFormat(boldItalicDoc, [{ anchor: nestedCaret, head: nestedCaret }], "italic");
    expect(afterUnitalic.doc).toBe("**Fourier**");
    expect(afterUnitalic.ranges).toEqual([{ anchor: 5, head: 5 }]);

    // Bare caret immediately touching `**Fourier**|` does not merge delimiter runs into `**Fourier******`
    const afterClosingStars = doc.indexOf("** series") + 2;
    expect(toggleMarkdownFormat(doc, [{ anchor: afterClosingStars, head: afterClosingStars }], "bold").doc).toBe(doc);
    expect(toggleMarkdownFormat(doc, [{ anchor: afterClosingStars, head: afterClosingStars }], "italic").doc).toBe(doc);
  });

  it("prevents inline formatting from splitting already-formatted spans on partial or straddling selections", () => {
    // Substring inside bold + bold -> unwraps enclosing bold while keeping the substring selected (never `**hel**lo wo**rld**`)
    const boldSentence = "Start **hello world** end";
    const subFrom = boldSentence.indexOf("lo wo");
    const subTo = subFrom + "lo wo".length;
    const unboldedSub = toggleMarkdownFormat(boldSentence, [{ anchor: subFrom, head: subTo }], "bold");
    expect(unboldedSub.doc).toBe("Start hello world end");
    const expectedSubFrom = unboldedSub.doc.indexOf("lo wo");
    expect(unboldedSub.ranges).toEqual([{ anchor: expectedSubFrom, head: expectedSubFrom + "lo wo".length }]);

    // Selection partially straddling a formatted boundary (`Start **hel[lo world** end]`) -> safe no-op
    const straddleFrom = boldSentence.indexOf("lo world");
    const straddleTo = boldSentence.length;
    for (const action of ["bold", "italic", "inline_code", "inline_math", "link"] as const) {
      const res = toggleMarkdownFormat(boldSentence, [{ anchor: straddleFrom, head: straddleTo }], action);
      expect(res.doc).toBe(boldSentence);
      expect(res.changes).toEqual([]);
    }

    // Selection enclosing an already-bolded word (`[Start **hello world** end]` + bold) -> safe no-op instead of splitting
    const fullOuter = toggleMarkdownFormat(boldSentence, [{ anchor: 0, head: boldSentence.length }], "bold");
    expect(fullOuter.doc).toBe(boldSentence);
    expect(fullOuter.changes).toEqual([]);

    // Caret inside link label: `link` unwraps preserving caret; `bold` does not split
    const linkDoc = "Visit [Super MD](https://example.com) today";
    const linkCaret = linkDoc.indexOf("Super") + 3;
    expect(toggleMarkdownFormat(linkDoc, [{ anchor: linkCaret, head: linkCaret }], "bold").doc).toBe(linkDoc);
    const unwrappedLink = toggleMarkdownFormat(linkDoc, [{ anchor: linkCaret, head: linkCaret }], "link");
    expect(unwrappedLink.doc).toBe("Visit Super MD today");
    expect(unwrappedLink.ranges).toEqual([{ anchor: "Visit Sup".length, head: "Visit Sup".length }]);
  });

  it("prevents inline formatting from splitting protected code or YAML frontmatter while keeping same-span code/math unwrap", () => {
    // YAML frontmatter (caret inside, selection inside, straddling boundary, and block formatting)
    const yamlDoc = "---\ntitle: Protected YAML\ntags: [notes]\n---\n\nBody target text";
    const yamlSelStart = yamlDoc.indexOf("Protected");
    const yamlSelEnd = yamlSelStart + "Protected".length;
    for (const action of FORMAT_ACTIONS) {
      expect(toggleMarkdownFormat(yamlDoc, [{ anchor: yamlSelStart, head: yamlSelEnd }], action).doc).toBe(yamlDoc);
      expect(toggleMarkdownFormat(yamlDoc, [{ anchor: yamlSelStart, head: yamlSelStart }], action).doc).toBe(yamlDoc);
    }
    // Selection straddling YAML frontmatter into body prose -> safe no-op
    const bodyStart = yamlDoc.indexOf("Body");
    expect(toggleMarkdownFormat(yamlDoc, [{ anchor: yamlSelStart, head: bodyStart + 4 }], "bold").doc).toBe(yamlDoc);
    // Body prose formats normally
    expect(toggleMarkdownFormat(yamlDoc, [{ anchor: bodyStart, head: bodyStart + 4 }], "bold").doc).toContain(
      "**Body** target text",
    );

    // Fenced code block (including bare caret, selection, >20KB fence, and unclosed fence)
    const fenced = "```ts\nconst value = 42;\n\n```";
    const valIdx = fenced.indexOf("value");
    const blankInFence = fenced.indexOf("\n\n") + 1;
    for (const action of ["bold", "italic", "inline_code", "inline_math", "link"] as const) {
      expect(toggleMarkdownFormat(fenced, [{ anchor: valIdx, head: valIdx + 5 }], action).doc).toBe(fenced);
      expect(toggleMarkdownFormat(fenced, [{ anchor: valIdx + 2, head: valIdx + 2 }], action).doc).toBe(fenced);
      expect(toggleMarkdownFormat(fenced, [{ anchor: blankInFence, head: blankInFence }], action).doc).toBe(fenced);
    }
    const largeFence = `\`\`\`python\n${"x = 1\n".repeat(3500)}target_var = 2\n\`\`\``;
    const largeIdx = largeFence.indexOf("target_var");
    expect(toggleMarkdownFormat(largeFence, [{ anchor: largeIdx, head: largeIdx + 10 }], "bold").doc).toBe(largeFence);

    // Inline code: blocks bold/italic/link/math, while inline_code unwraps cleanly preserving caret
    const inlineCodeDoc = "Run `cargo test` now";
    const codeCaret = inlineCodeDoc.indexOf("cargo") + 3;
    for (const other of ["bold", "italic", "inline_math", "link"] as const) {
      expect(toggleMarkdownFormat(inlineCodeDoc, [{ anchor: codeCaret, head: codeCaret }], other).doc).toBe(
        inlineCodeDoc,
      );
      expect(toggleMarkdownFormat(inlineCodeDoc, [{ anchor: codeCaret - 3, head: codeCaret + 2 }], other).doc).toBe(
        inlineCodeDoc,
      );
    }
    const unwrappedCode = toggleMarkdownFormat(inlineCodeDoc, [{ anchor: codeCaret, head: codeCaret }], "inline_code");
    expect(unwrappedCode.doc).toBe("Run cargo test now");
    expect(unwrappedCode.ranges).toEqual([{ anchor: "Run car".length, head: "Run car".length }]);

    // Inline math: blocks bold/italic/link/code, while inline_math unwraps cleanly preserving caret
    const inlineMathDoc = "Given $alpha + 1$ in prose";
    const mathCaret = inlineMathDoc.indexOf("alpha") + 2;
    expect(toggleMarkdownFormat(inlineMathDoc, [{ anchor: mathCaret, head: mathCaret }], "bold").doc).toBe(
      inlineMathDoc,
    );
    const unwrappedMath = toggleMarkdownFormat(inlineMathDoc, [{ anchor: mathCaret, head: mathCaret }], "inline_math");
    expect(unwrappedMath.doc).toBe("Given alpha + 1 in prose");
    expect(unwrappedMath.ranges).toEqual([{ anchor: "Given al".length, head: "Given al".length }]);
  });

  it("keeps multi-paragraph and cross-block selections separate from inline formatting", () => {
    const twoParas = "First paragraph.\n\nSecond paragraph.";
    for (const action of ["bold", "italic", "inline_code", "inline_math", "link"] as const) {
      const res = toggleMarkdownFormat(twoParas, [{ anchor: 6, head: 24 }], action);
      expect(res.doc).toBe(twoParas);
      expect(res.changes).toEqual([]);
    }

    const twoListItems = "- First item\n- Second item";
    expect(toggleMarkdownFormat(twoListItems, [{ anchor: 2, head: 21 }], "bold").doc).toBe(twoListItems);

    const acrossTableCells = "| Left | Right |\n| --- | --- |\n| alpha | beta |";
    const alphaIdx = acrossTableCells.indexOf("alpha");
    const betaEnd = acrossTableCells.indexOf("beta") + 4;
    expect(toggleMarkdownFormat(acrossTableCells, [{ anchor: alphaIdx, head: betaEnd }], "bold").doc).toBe(
      acrossTableCells,
    );
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

    const draftFrontmatter = "---\ntitle: \"unclosed quote\nsource: selected\n---";
    const draftFmStart = draftFrontmatter.indexOf("selected");
    expect(applyMarkdownUrlPaste(draftFrontmatter, [{ anchor: draftFmStart, head: draftFmStart + 8 }], url)).toBeNull();

    const thematicBreakBeforeProse = "---\n\nRead selected prose";
    const thematicProseStart = thematicBreakBeforeProse.indexOf("selected");
    expect(
      applyMarkdownUrlPaste(thematicBreakBeforeProse, [{ anchor: thematicProseStart, head: thematicProseStart + 8 }], url)?.doc,
    ).toBe("---\n\nRead [selected](https://example.com/new) prose");
  });

  it("accurately distinguishes fenced code vs prose past the 16KB window boundary", () => {
    const url = "https://example.com/large";
    const largeCodeBody = "const row = 42;\n".repeat(1_300); // > 20 KB
    const doc = `\`\`\`ts\n${largeCodeBody}const targetCode = 1;\n\`\`\`\n\nRead targetProse after fence.`;
    const codeIdx = doc.indexOf("targetCode");
    const proseIdx = doc.indexOf("targetProse");

    expect(applyMarkdownUrlPaste(doc, [{ anchor: codeIdx, head: codeIdx + "targetCode".length }], url)).toBeNull();
    const proseWrapped = applyMarkdownUrlPaste(doc, [{ anchor: proseIdx, head: proseIdx + "targetProse".length }], url);
    expect(proseWrapped).not.toBeNull();
    expect(proseWrapped!.doc).toContain("Read [targetProse](https://example.com/large) after fence.");
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
