// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("hast-util-to-jsx-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("hast-util-to-jsx-runtime")>();
  return {
    ...actual,
    toJsxRuntime: (tree: unknown, options: Record<string, unknown>) =>
      actual.toJsxRuntime(tree as never, { ...options, filePath: undefined } as never),
  };
});

import LiveEditor from "./components/LiveEditor";
import { analyzeDocument } from "./documentAnalysis";
import {
  resolveDoubleClickCaretRange as reexportedDoubleClickCaretRange,
  resolveLiveCaretOffset as reexportedLiveCaretOffset,
} from "./liveInsertionPoint";
import {
  inlineCodeInnerBounds,
  inlineMathInnerBounds,
  mapLiveRenderedSelectionToSourceRange,
  resolveDoubleClickCaretRange,
  resolveLiveCaretOffset,
  resolveLiveRenderedFormatEdit,
  translateLiveRenderedRange,
} from "./liveSelectionRange";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function findVisibleTextPositions(container: Element) {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const nodes: Array<{ node: Text; start: number; end: number }> = [];
  let full = "";
  while (walker.nextNode()) {
    const textNode = walker.currentNode as Text;
    if (textNode.parentElement?.closest(".katex-mathml,.image-loading,.remote-image-card,.image-error")) continue;
    const start = full.length;
    full += textNode.data;
    nodes.push({ node: textNode, start, end: full.length });
  }
  return { full, nodes };
}

function selectDomTextRange(container: Element, targetSubstring: string, reversed = false): Selection {
  const { full, nodes } = findVisibleTextPositions(container);
  const idx = full.indexOf(targetSubstring);
  if (idx < 0) throw new Error(`Could not find "${targetSubstring}" inside "${full}"`);
  const endIdx = idx + targetSubstring.length;
  const startEntry = nodes.find((n) => idx >= n.start && idx <= n.end)!;
  const endEntry = nodes.find((n) => endIdx >= n.start && endIdx <= n.end)!;

  const selection = window.getSelection()!;
  selection.removeAllRanges();
  if (reversed && typeof selection.setBaseAndExtent === "function") {
    selection.setBaseAndExtent(endEntry.node, endIdx - endEntry.start, startEntry.node, idx - startEntry.start);
  } else {
    const range = document.createRange();
    range.setStart(startEntry.node, idx - startEntry.start);
    range.setEnd(endEntry.node, endIdx - endEntry.start);
    selection.addRange(range);
  }
  return selection;
}

function selectKatexElement(katexEl: Element, insideKatex = true, reversed = false): Selection {
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  const htmlRoot = katexEl.querySelector(".katex-html") ?? katexEl;
  if (insideKatex && htmlRoot.firstChild) {
    const walker = document.createTreeWalker(htmlRoot, NodeFilter.SHOW_TEXT);
    const first = walker.nextNode() as Text | null;
    let last = first;
    let next: Node | null;
    while ((next = walker.nextNode())) last = next as Text;
    if (first && last) {
      if (reversed && typeof selection.setBaseAndExtent === "function") {
        selection.setBaseAndExtent(last, last.data.length, first, 0);
      } else {
        const range = document.createRange();
        range.setStart(first, 0);
        range.setEnd(last, last.data.length);
        selection.addRange(range);
      }
      return selection;
    }
  }
  const range = document.createRange();
  range.selectNode(katexEl);
  selection.addRange(range);
  return selection;
}

function collapsedCaretAt(container: Element, targetSubstring: string, innerOffset = 0): Range {
  const { full, nodes } = findVisibleTextPositions(container);
  const idx = full.indexOf(targetSubstring);
  if (idx < 0) throw new Error(`Could not find "${targetSubstring}" inside "${full}"`);
  const pos = idx + innerOffset;
  const entry = nodes.find((n) => pos >= n.start && pos < n.end) ?? nodes.find((n) => pos >= n.start && pos <= n.end)!;
  const range = document.createRange();
  range.setStart(entry.node, pos - entry.start);
  range.collapse(true);
  return range;
}

describe("shared rendered-to-source mapping (liveSelectionRange)", () => {
  afterEach(() => {
    window.getSelection()?.removeAllRanges();
    delete (document as Partial<Document>).caretPositionFromPoint;
  });

  it("maps rendered selections and verified collapsed carets through the same shared inline code, math, comment, study delimiter, wikilink, image, footnote, callout, task, and table spans", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const richPara =
      "Review **intro**, [guide](https://example.com/docs), `` `inline_cmd` ``, $x + 1$, ==highlighted==, ~sub~, ^sup^, [[VaultNote|wiki alias]], %%percent hidden%%<!-- html hidden --> ![diagram](chart.png){width=240} ref[^1] and selected rendered range with \\*escaped\\* &mdash; tail.";
    const listBlock = ["- [x] Parent task", "  - [ ] Nested checklist target item"].join("\n");
    const calloutBlock = ["> [!note] Callout header target", "> Callout body target phrase"].join("\n");
    const defaultCalloutBlock = ["> [!tip]", "> Synthesized header body target"].join("\n");
    const fencedCalloutBlock = [":::callout warning Custom *fence* header", "Fenced callout body target", ":::"].join("\n");
    const tableBlock = ["| Metric | Description |", "| --- | --- |", "| Latency | Fast \\| steady cell target |"].join("\n");
    const footnoteDef = "[^1]: Footnote detail.";
    const markdown = [
      "---",
      "title: Shared Mapping Fixture",
      "---",
      "",
      richPara,
      "",
      listBlock,
      "",
      calloutBlock,
      "",
      defaultCalloutBlock,
      "",
      fencedCalloutBlock,
      "",
      tableBlock,
      "",
      footnoteDef,
    ].join("\n");

    await act(async () => {
      root.render(
        <LiveEditor
          markdown={markdown}
          onChange={() => {}}
          documentPath="/notes/fixture.md"
          python=""
          dark={false}
          fullDocumentAccessibility
        />,
      );
    });

    const liveRoot = host.querySelector<HTMLElement>(".live-document")!;
    const blocks = liveRoot.querySelectorAll<HTMLElement>(".live-block");
    const sourceAnalysis = { source: markdown, analysis: analyzeDocument(markdown) };

    // 1. Prose after bold, link, padded inline code, inline math, study delimiters, wikilink, %% & <!-- --> comments, sized image, and footnote
    const para = blocks[0]!.querySelector("p")!;
    const selProse = selectDomTextRange(para, "selected rendered range");
    const mappedProse = mapLiveRenderedSelectionToSourceRange(selProse, liveRoot, markdown, sourceAnalysis);
    expect(mappedProse).not.toBeNull();
    expect(markdown.slice(mappedProse!.from, mappedProse!.to)).toBe("selected rendered range");
    expect(mappedProse!.reversed).toBe(false);

    const pStart = Number(blocks[0]!.dataset.sourceStart);
    const pEnd = Number(blocks[0]!.dataset.sourceEnd);
    const caretProse = resolveLiveCaretOffset(blocks[0]!, collapsedCaretAt(para, "selected rendered range", 9), markdown, pStart, pEnd, sourceAnalysis);
    expect(caretProse).toBe(richPara.indexOf("rendered range"));

    // 2. Reversed selection on escaped + entity tail, wikilink alias protection, padded inline code caret, and straddling outer-delimiter expansion
    const selTail = selectDomTextRange(para, "tail", true);
    const mappedTail = mapLiveRenderedSelectionToSourceRange(selTail, liveRoot, markdown, sourceAnalysis);
    expect(mappedTail?.reversed).toBe(true);
    expect(markdown.slice(mappedTail!.from, mappedTail!.to)).toBe("tail");

    const selWiki = selectDomTextRange(para, "wiki alias");
    const mappedWiki = mapLiveRenderedSelectionToSourceRange(selWiki, liveRoot, markdown, sourceAnalysis);
    expect(markdown.slice(mappedWiki!.from, mappedWiki!.to)).toBe("wiki alias");
    expect(resolveLiveRenderedFormatEdit(markdown, mappedWiki!, "bold")).toBeNull();

    const caretCode = resolveLiveCaretOffset(blocks[0]!, collapsedCaretAt(para, "`inline_cmd`", 1), markdown, pStart, pEnd, sourceAnalysis);
    expect(caretCode).toBe(richPara.indexOf("inline_cmd"));

    const mappedLeftStraddle = mapLiveRenderedSelectionToSourceRange(selectDomTextRange(para, "intro, "), liveRoot, markdown, sourceAnalysis);
    expect(markdown.slice(mappedLeftStraddle!.from, mappedLeftStraddle!.to)).toBe("**intro**, ");

    const mappedStraddle = mapLiveRenderedSelectionToSourceRange(selectDomTextRange(para, "intro, guide"), liveRoot, markdown, sourceAnalysis);
    expect(markdown.slice(mappedStraddle!.from, mappedStraddle!.to)).toBe("**intro**, [guide](https://example.com/docs)");

    // 3. Callouts: custom > [!note], default synthesized > [!tip], fenced :::callout, and cross-title-to-body rejection
    const calloutTitle = blocks[2]!.querySelector(".callout-title")!;
    const mappedTitle = mapLiveRenderedSelectionToSourceRange(selectDomTextRange(calloutTitle, "header target"), liveRoot, markdown, sourceAnalysis);
    expect(markdown.slice(mappedTitle!.from, mappedTitle!.to)).toBe("header target");

    const calloutBody = blocks[2]!.querySelector(".callout p:not(.callout-title)")!;
    const mappedBody = mapLiveRenderedSelectionToSourceRange(selectDomTextRange(calloutBody, "body target phrase"), liveRoot, markdown, sourceAnalysis);
    expect(markdown.slice(mappedBody!.from, mappedBody!.to)).toBe("body target phrase");

    const crossCalloutRange = document.createRange();
    crossCalloutRange.setStart(calloutTitle.firstChild!, 0);
    crossCalloutRange.setEnd(calloutBody.firstChild!, 7);
    const crossSel = window.getSelection()!;
    crossSel.removeAllRanges();
    crossSel.addRange(crossCalloutRange);
    expect(mapLiveRenderedSelectionToSourceRange(crossSel, liveRoot, markdown, sourceAnalysis)).toBeNull();

    const synthTitle = blocks[3]!.querySelector(".callout-title")!;
    expect(mapLiveRenderedSelectionToSourceRange(selectDomTextRange(synthTitle, "Tip"), liveRoot, markdown, sourceAnalysis)).toBeNull();
    const dStart = Number(blocks[3]!.dataset.sourceStart);
    const dEnd = Number(blocks[3]!.dataset.sourceEnd);
    expect(resolveLiveCaretOffset(blocks[3]!, collapsedCaretAt(blocks[3]!.querySelector(".callout p:not(.callout-title)")!, "body target"), markdown, dStart, dEnd, sourceAnalysis)).toBe(
      markdown.slice(dStart, dEnd).indexOf("body target"),
    );

    const fencedTitle = blocks[4]!.querySelector(".callout-title")!;
    const mappedFencedTitle = mapLiveRenderedSelectionToSourceRange(selectDomTextRange(fencedTitle, "fence header"), liveRoot, markdown, sourceAnalysis);
    expect(markdown.slice(mappedFencedTitle!.from, mappedFencedTitle!.to)).toBe("*fence* header");
    const fStart = Number(blocks[4]!.dataset.sourceStart);
    const fEnd = Number(blocks[4]!.dataset.sourceEnd);
    expect(resolveLiveCaretOffset(blocks[4]!, collapsedCaretAt(blocks[4]!.querySelector(".callout p:not(.callout-title)")!, "body target"), markdown, fStart, fEnd, sourceAnalysis)).toBe(
      markdown.slice(fStart, fEnd).indexOf("body target"),
    );

    // 4. GFM table cell with escaped pipe \| maps both selection and collapsed caret, and rejects block-prefix actions inside table cells
    const cells = blocks[5]!.querySelectorAll("td");
    const mappedCell = mapLiveRenderedSelectionToSourceRange(selectDomTextRange(cells[1]!, "cell target"), liveRoot, markdown, sourceAnalysis);
    expect(markdown.slice(mappedCell!.from, mappedCell!.to)).toBe("cell target");
    expect(resolveLiveRenderedFormatEdit(markdown, mappedCell!, "heading")).toBeNull();
    expect(resolveLiveRenderedFormatEdit(markdown, mappedCell!, "bold")?.doc).toContain("| Fast \\| steady **cell target** |");
    const tStart = Number(blocks[5]!.dataset.sourceStart);
    const tEnd = Number(blocks[5]!.dataset.sourceEnd);
    expect(resolveLiveCaretOffset(blocks[5]!, collapsedCaretAt(cells[1]!, "cell target"), markdown, tStart, tEnd, sourceAnalysis)).toBe(
      markdown.slice(tStart, tEnd).indexOf("cell target"),
    );

    act(() => root.unmount());
    host.remove();
  });

  it("maps tight and loose nested lists (bullet, ordered, and task items) for both selection formatting and collapsed carets while rejecting cross-item selections", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const markdown = [
      "- Tight parent target",
      "  - Nested *italic* `cmd` $n + 1$ middle target",
      "    1. Deeply nested ordered target",
      "  - [ ] Nested task checkbox target",
      "",
      "1. Loose outer item target",
      "",
      "   - Loose nested child target",
    ].join("\n");

    await act(async () => {
      root.render(
        <LiveEditor
          markdown={markdown}
          onChange={() => {}}
          documentPath={null}
          python=""
          dark={false}
          fullDocumentAccessibility
        />,
      );
    });

    const liveRoot = host.querySelector<HTMLElement>(".live-document")!;
    const listBlockEl = liveRoot.querySelector<HTMLElement>(".live-block")!;
    const bStart = Number(listBlockEl.dataset.sourceStart);
    const bEnd = Number(listBlockEl.dataset.sourceEnd);
    const sourceAnalysis = { source: markdown, analysis: analyzeDocument(markdown) };
    const listItems = liveRoot.querySelectorAll("li");
    expect(listItems.length).toBe(6);

    // 1. Tight parent <li> directly preceding a nested <ul> (ignores HAST inter-block newline)
    const mappedParent = mapLiveRenderedSelectionToSourceRange(selectDomTextRange(listItems[0]!, "parent target"), liveRoot, markdown, sourceAnalysis);
    expect(markdown.slice(mappedParent!.from, mappedParent!.to)).toBe("parent target");
    expect(resolveLiveRenderedFormatEdit(markdown, mappedParent!, "bold")?.doc).toContain("- Tight **parent target**\n");
    expect(resolveLiveCaretOffset(listBlockEl, collapsedCaretAt(listItems[0]!, "parent target"), markdown, bStart, bEnd, sourceAnalysis)).toBe(
      markdown.indexOf("parent target"),
    );

    // 2. Tight middle <li> containing inline emphasis, code, and KaTeX math before nested <ol>
    const mappedMiddle = mapLiveRenderedSelectionToSourceRange(selectDomTextRange(listItems[1]!, "middle target", true), liveRoot, markdown, sourceAnalysis);
    expect(markdown.slice(mappedMiddle!.from, mappedMiddle!.to)).toBe("middle target");
    expect(mappedMiddle!.reversed).toBe(true);
    const middleEdit = resolveLiveRenderedFormatEdit(markdown, mappedMiddle!, "italic");
    expect(middleEdit?.doc).toContain("  - Nested *italic* `cmd` $n + 1$ *middle target*\n");
    expect(middleEdit?.ranges[0]!.anchor).toBeGreaterThan(middleEdit?.ranges[0]!.head ?? 0);

    // 3. Deeply nested ordered <ol> item and nested task list item (both selection and collapsed caret)
    const mappedDeep = mapLiveRenderedSelectionToSourceRange(selectDomTextRange(listItems[2]!, "ordered target"), liveRoot, markdown, sourceAnalysis);
    expect(markdown.slice(mappedDeep!.from, mappedDeep!.to)).toBe("ordered target");
    expect(resolveLiveCaretOffset(listBlockEl, collapsedCaretAt(listItems[2]!, "ordered target"), markdown, bStart, bEnd, sourceAnalysis)).toBe(
      markdown.indexOf("ordered target"),
    );

    const mappedNestedTask = mapLiveRenderedSelectionToSourceRange(selectDomTextRange(listItems[3]!, "checkbox target"), liveRoot, markdown, sourceAnalysis);
    expect(markdown.slice(mappedNestedTask!.from, mappedNestedTask!.to)).toBe("checkbox target");
    expect(resolveLiveCaretOffset(listBlockEl, collapsedCaretAt(listItems[3]!, "checkbox target"), markdown, bStart, bEnd, sourceAnalysis)).toBe(
      markdown.indexOf("checkbox target"),
    );

    // 4. Loose nested list items (<p> inside <li>)
    const mappedLooseOuter = mapLiveRenderedSelectionToSourceRange(selectDomTextRange(listItems[4]!, "outer item target"), liveRoot, markdown, sourceAnalysis);
    expect(markdown.slice(mappedLooseOuter!.from, mappedLooseOuter!.to)).toBe("outer item target");
    const mappedLooseChild = mapLiveRenderedSelectionToSourceRange(selectDomTextRange(listItems[5]!, "nested child target"), liveRoot, markdown, sourceAnalysis);
    expect(markdown.slice(mappedLooseChild!.from, mappedLooseChild!.to)).toBe("nested child target");

    // 5. Cross-item selection from parent <li> into nested <li> AND parent <li> range extending past nested <ul> both return null
    const crossListRange = document.createRange();
    crossListRange.setStart(listItems[0]!.firstChild!, 2);
    crossListRange.setEnd(listItems[1]!.firstChild!, 6);
    const selCross = window.getSelection()!;
    selCross.removeAllRanges();
    selCross.addRange(crossListRange);
    expect(mapLiveRenderedSelectionToSourceRange(selCross, liveRoot, markdown, sourceAnalysis)).toBeNull();

    const overNestedRange = document.createRange();
    overNestedRange.setStart(listItems[0]!, 0);
    overNestedRange.setEnd(listItems[0]!, listItems[0]!.childNodes.length);
    selCross.removeAllRanges();
    selCross.addRange(overNestedRange);
    expect(mapLiveRenderedSelectionToSourceRange(selCross, liveRoot, markdown, sourceAnalysis)).toBeNull();

    act(() => root.unmount());
    host.remove();
  });

  it("shares inline code and inline math bounds, unwraps matching code/math toggles, and protects code/math blocks from invalid formatting", async () => {
    expect(inlineCodeInnerBounds("`alpha`", 0, 7, "alpha")).toEqual([1, 6]);
    expect(inlineCodeInnerBounds("`` a `b` c ``", 0, 13, "a `b` c")).toEqual([3, 10]);
    expect(inlineMathInnerBounds("$x + 1$", 0, 7)).toEqual([1, 6]);
    expect(inlineMathInnerBounds("\\(y + 2\\)", 0, 9)).toEqual([2, 7]);
    expect(inlineMathInnerBounds("$$z + 3$$", 0, 9)).toEqual([2, 7]);

    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const markdown = [
      "Compute `flag_name`, `` raw `tick` span ``, and $x^2 + 1$ or $$y + 2$$ inline.",
      "",
      "```ts",
      "const value = 42;",
      "```",
      "",
      "$$",
      "E = mc^2",
      "$$",
    ].join("\n");

    await act(async () => {
      root.render(
        <LiveEditor
          markdown={markdown}
          onChange={() => {}}
          documentPath={null}
          python=""
          dark={false}
          fullDocumentAccessibility
        />,
      );
    });

    const liveRoot = host.querySelector<HTMLElement>(".live-document")!;
    const sourceAnalysis = { source: markdown, analysis: analyzeDocument(markdown) };
    const codeEls = liveRoot.querySelectorAll("p code");
    expect(codeEls).toHaveLength(2);

    // 1. Substring inside single-backtick inline code: blocked for bold/italic/link, unwraps cleanly for inline_code preserving substring & backward direction
    const selSubCode = selectDomTextRange(codeEls[0]!, "name", true);
    const mappedSubCode = mapLiveRenderedSelectionToSourceRange(selSubCode, liveRoot, markdown, sourceAnalysis);
    expect(mappedSubCode).not.toBeNull();
    expect(markdown.slice(mappedSubCode!.from, mappedSubCode!.to)).toBe("name");
    expect(resolveLiveRenderedFormatEdit(markdown, mappedSubCode!, "bold")).toBeNull();
    expect(resolveLiveRenderedFormatEdit(markdown, mappedSubCode!, "italic")).toBeNull();
    expect(resolveLiveRenderedFormatEdit(markdown, mappedSubCode!, "link")).toBeNull();

    const unwrappedCode = resolveLiveRenderedFormatEdit(markdown, mappedSubCode!, "inline_code")!;
    expect(unwrappedCode.doc).toContain("Compute flag_name, `` raw `tick` span ``");
    expect(unwrappedCode.ranges[0]!.anchor).toBeGreaterThan(unwrappedCode.ranges[0]!.head);
    expect(unwrappedCode.doc.slice(unwrappedCode.ranges[0]!.head, unwrappedCode.ranges[0]!.anchor)).toBe("name");

    // 2. Double-backtick space-padded inline code unwraps cleanly
    const mappedDoubleCode = mapLiveRenderedSelectionToSourceRange(selectDomTextRange(codeEls[1]!, "raw `tick` span"), liveRoot, markdown, sourceAnalysis);
    expect(resolveLiveRenderedFormatEdit(markdown, mappedDoubleCode!, "inline_code")?.doc).toContain(
      "Compute `flag_name`, raw `tick` span, and",
    );

    // 3. Inline math $x^2 + 1$: both interior text selection and range.selectNode(katexEl) map to x^2 + 1, block bold/inline_code, and unwrap on inline_math; $$y + 2$$ refuses single-$ unwrap
    const inlineKatexEls = liveRoot.querySelectorAll("p .katex");
    for (const inside of [true, false]) {
      const selMath = selectKatexElement(inlineKatexEls[0]!, inside, inside);
      const mappedMath = mapLiveRenderedSelectionToSourceRange(selMath, liveRoot, markdown, sourceAnalysis);
      expect(mappedMath).not.toBeNull();
      expect(markdown.slice(mappedMath!.from, mappedMath!.to)).toBe("x^2 + 1");
      expect(resolveLiveRenderedFormatEdit(markdown, mappedMath!, "bold")).toBeNull();
      expect(resolveLiveRenderedFormatEdit(markdown, mappedMath!, "inline_code")).toBeNull();
      const unwrappedMath = resolveLiveRenderedFormatEdit(markdown, mappedMath!, "inline_math")!;
      expect(unwrappedMath.doc).toContain("and x^2 + 1 or $$y + 2$$ inline.");
      if (inside) expect(unwrappedMath.ranges[0]!.anchor).toBeGreaterThan(unwrappedMath.ranges[0]!.head);
    }
    const mappedDoubleMath = mapLiveRenderedSelectionToSourceRange(selectKatexElement(inlineKatexEls[1]!, false), liveRoot, markdown, sourceAnalysis);
    expect(markdown.slice(mappedDoubleMath!.from, mappedDoubleMath!.to)).toBe("y + 2");
    expect(resolveLiveRenderedFormatEdit(markdown, mappedDoubleMath!, "inline_math")).toBeNull();

    // 4. Protected fenced code <pre> maps offsets with protectedBlock=true and rejects formatting; .code-disclosure summary and .katex-display reject formatting
    const preEl = liveRoot.querySelector("pre")!;
    const mappedPre = mapLiveRenderedSelectionToSourceRange(selectDomTextRange(preEl, "value = 42"), liveRoot, markdown, sourceAnalysis);
    expect(mappedPre?.protectedBlock).toBe(true);
    expect(resolveLiveRenderedFormatEdit(markdown, mappedPre!, "bold")).toBeNull();
    const codeSummary = liveRoot.querySelector("summary")!;
    expect(mapLiveRenderedSelectionToSourceRange(selectDomTextRange(codeSummary, "ts"), liveRoot, markdown, sourceAnalysis)).toBeNull();

    const displayKatex = liveRoot.querySelector(".katex-display .katex")!;
    const mappedDisplay = mapLiveRenderedSelectionToSourceRange(selectKatexElement(displayKatex, true), liveRoot, markdown, sourceAnalysis);
    expect(mappedDisplay ? resolveLiveRenderedFormatEdit(markdown, mappedDisplay, "inline_math") : null).toBeNull();

    act(() => root.unmount());
    host.remove();
  });

  it("handles existing formatted text and partially formatted selections without splitting or duplicating delimiters", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const markdown =
      "Start **hello world** and *italicized* and ***both*** and [docs link](https://example.com) end.";

    await act(async () => {
      root.render(
        <LiveEditor
          markdown={markdown}
          onChange={() => {}}
          documentPath={null}
          python=""
          dark={false}
          fullDocumentAccessibility
        />,
      );
    });

    const liveRoot = host.querySelector<HTMLElement>(".live-document")!;
    const sourceAnalysis = { source: markdown, analysis: analyzeDocument(markdown) };
    const para = liveRoot.querySelector("p")!;

    // 1. Exact existing **hello world**: bold unwraps, italic nests into ***hello world***
    const mappedFullBold = mapLiveRenderedSelectionToSourceRange(selectDomTextRange(para, "hello world"), liveRoot, markdown, sourceAnalysis)!;
    expect(resolveLiveRenderedFormatEdit(markdown, mappedFullBold, "bold")?.doc).toBe(
      "Start hello world and *italicized* and ***both*** and [docs link](https://example.com) end.",
    );
    expect(resolveLiveRenderedFormatEdit(markdown, mappedFullBold, "italic")?.doc).toBe(
      "Start ***hello world*** and *italicized* and ***both*** and [docs link](https://example.com) end.",
    );

    // 2. Combined ***both***: bold unwraps to *both*, italic unwraps to **both**
    const mappedBoth = mapLiveRenderedSelectionToSourceRange(selectDomTextRange(para, "both"), liveRoot, markdown, sourceAnalysis)!;
    expect(resolveLiveRenderedFormatEdit(markdown, mappedBoth, "bold")?.doc).toContain("and *both* and");
    expect(resolveLiveRenderedFormatEdit(markdown, mappedBoth, "italic")?.doc).toContain("and **both** and");

    // 3. Existing [docs link](https://example.com): link unwraps to docs link, bold formats label to [**docs link**](...)
    const mappedLink = mapLiveRenderedSelectionToSourceRange(selectDomTextRange(para, "docs link"), liveRoot, markdown, sourceAnalysis)!;
    expect(resolveLiveRenderedFormatEdit(markdown, mappedLink, "link")?.doc).toContain("and docs link end.");
    expect(resolveLiveRenderedFormatEdit(markdown, mappedLink, "bold")?.doc).toContain("and [**docs link**](https://example.com) end.");

    // 4. Partial selection INSIDE **hello world** ("world" selected backward): unwraps enclosing **...** on bold preserving "world" backward, wraps **hello *world*** on italic
    const mappedPartialInside = mapLiveRenderedSelectionToSourceRange(selectDomTextRange(para, "world", true), liveRoot, markdown, sourceAnalysis)!;
    const unwrappedPartial = resolveLiveRenderedFormatEdit(markdown, mappedPartialInside, "bold")!;
    expect(unwrappedPartial.doc).toBe(
      "Start hello world and *italicized* and ***both*** and [docs link](https://example.com) end.",
    );
    expect(unwrappedPartial.ranges[0]!.anchor).toBeGreaterThan(unwrappedPartial.ranges[0]!.head);
    expect(unwrappedPartial.doc.slice(unwrappedPartial.ranges[0]!.head, unwrappedPartial.ranges[0]!.anchor)).toBe("world");
    expect(resolveLiveRenderedFormatEdit(markdown, mappedPartialInside, "italic")?.doc).toContain("Start **hello *world*** and");

    // 5. Boundary-straddling selection ("lo world and") rejected for all inline formatting; enclosing "Start **hello world**" rejects duplicate bold while allowing outer italic
    const mappedStraddle = mapLiveRenderedSelectionToSourceRange(selectDomTextRange(para, "lo world and"), liveRoot, markdown, sourceAnalysis)!;
    expect(resolveLiveRenderedFormatEdit(markdown, mappedStraddle, "bold")).toBeNull();
    expect(resolveLiveRenderedFormatEdit(markdown, mappedStraddle, "italic")).toBeNull();
    expect(resolveLiveRenderedFormatEdit(markdown, mappedStraddle, "inline_code")).toBeNull();

    const mappedEnclosingBold = mapLiveRenderedSelectionToSourceRange(selectDomTextRange(para, "Start hello world"), liveRoot, markdown, sourceAnalysis)!;
    expect(markdown.slice(mappedEnclosingBold.from, mappedEnclosingBold.to)).toBe("Start **hello world**");
    expect(resolveLiveRenderedFormatEdit(markdown, mappedEnclosingBold, "bold")).toBeNull();
    expect(resolveLiveRenderedFormatEdit(markdown, mappedEnclosingBold, "italic")?.doc).toContain("*Start **hello world*** and");

    act(() => root.unmount());
    host.remove();
  });

  it("translates rendered selections through upstream draft shifts, rejects multi-paragraph selections, and requires a verified collapsed non-interactive caret in the click wrapper", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const baseDoc = [
      "First block",
      "",
      "Second paragraph with [linked docs](https://example.com) and rendered selection here.",
      "",
      "Third paragraph.",
    ].join("\n");

    await act(async () => {
      root.render(
        <LiveEditor
          markdown={baseDoc}
          onChange={() => {}}
          documentPath={null}
          python=""
          dark={false}
          fullDocumentAccessibility
        />,
      );
    });

    const liveRoot = host.querySelector<HTMLElement>(".live-document")!;
    const blocks = liveRoot.querySelectorAll<HTMLElement>(".live-block");
    const paragraphs = liveRoot.querySelectorAll("p");
    const sourceAnalysis = { source: baseDoc, analysis: analyzeDocument(baseDoc) };

    // 1. Upstream active draft offset shift
    const activeDoc = baseDoc.replace("First block", "First block expanded significantly");
    const editingContext = { baseMarkdown: baseDoc, baseSplitEnd: "First block".length };
    expect(translateLiveRenderedRange(13, 30, editingContext, activeDoc)).toEqual([
      13 + (activeDoc.length - baseDoc.length),
      30 + (activeDoc.length - baseDoc.length),
    ]);

    const selSingle = selectDomTextRange(paragraphs[1]!, "rendered selection");
    const mappedShifted = mapLiveRenderedSelectionToSourceRange(selSingle, liveRoot, baseDoc, sourceAnalysis, editingContext, activeDoc);
    expect(mappedShifted).not.toBeNull();
    expect(baseDoc.slice(mappedShifted!.renderedFrom, mappedShifted!.renderedTo)).toBe("rendered selection");
    expect(activeDoc.slice(mappedShifted!.from, mappedShifted!.to)).toBe("rendered selection");

    // 2. Formatting wrapper rejects collapsed selections and multi-paragraph selections
    const collapsed = collapsedCaretAt(paragraphs[1]!, "rendered selection", 3);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(collapsed);
    expect(mapLiveRenderedSelectionToSourceRange(sel, liveRoot, baseDoc, sourceAnalysis)).toBeNull();

    const multiRange = document.createRange();
    multiRange.setStart(paragraphs[1]!.firstChild!, 0);
    multiRange.setEnd(paragraphs[2]!.firstChild!, 5);
    sel.removeAllRanges();
    sel.addRange(multiRange);
    expect(mapLiveRenderedSelectionToSourceRange(sel, liveRoot, baseDoc, sourceAnalysis)).toBeNull();

    // 3. Click wrapper rejects non-collapsed ranges and interactive link targets, while accepting verified collapsed prose carets
    const b1Start = Number(blocks[1]!.dataset.sourceStart);
    const b1End = Number(blocks[1]!.dataset.sourceEnd);
    const nonCollapsedRange = selectDomTextRange(paragraphs[1]!, "rendered selection").getRangeAt(0);
    expect(resolveLiveCaretOffset(blocks[1]!, nonCollapsedRange, baseDoc, b1Start, b1End, sourceAnalysis)).toBeNull();
    expect(resolveLiveCaretOffset(blocks[1]!, collapsed, baseDoc, b1Start, b1End, sourceAnalysis)).toBe(
      baseDoc.slice(b1Start, b1End).indexOf("rendered selection") + 3,
    );

    const proseNode = collapsed.startContainer;
    delete (document as Partial<Document>).caretPositionFromPoint;
    const nonCollapsedSel = selectDomTextRange(paragraphs[1]!, "rendered selection");
    expect(resolveDoubleClickCaretRange(blocks[1]!, paragraphs[1]!, 80, 40)).toBeNull();

    nonCollapsedSel.removeAllRanges();
    nonCollapsedSel.addRange(collapsed);
    expect(resolveDoubleClickCaretRange(blocks[1]!, paragraphs[1]!, 80, 40)?.collapsed).toBe(true);

    Object.defineProperty(document, "caretPositionFromPoint", {
      configurable: true,
      writable: true,
      value: () => ({ offsetNode: proseNode, offset: collapsed.startOffset }),
    });
    const linkEl = blocks[1]!.querySelector("a")!;
    expect(resolveDoubleClickCaretRange(blocks[1]!, linkEl, 80, 40)).toBeNull();
    expect(resolveDoubleClickCaretRange(blocks[1]!, paragraphs[1]!, 80, 40)?.collapsed).toBe(true);

    // 4. Caller compatibility re-exports on liveInsertionPoint point to the exact unified helpers
    expect(reexportedDoubleClickCaretRange).toBe(resolveDoubleClickCaretRange);
    expect(reexportedLiveCaretOffset).toBe(resolveLiveCaretOffset);

    act(() => root.unmount());
    host.remove();
  });
});
