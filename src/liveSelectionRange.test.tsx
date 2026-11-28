// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import LiveEditor from "./components/LiveEditor";
import { analyzeDocument } from "./documentAnalysis";
import {
  inlineCodeInnerBounds,
  inlineMathInnerBounds,
  mapLiveRenderedSelectionToSourceRange,
  resolveLiveRenderedFormatEdit,
  translateLiveRenderedRange,
} from "./liveSelectionRange";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function selectDomTextRange(
  container: Element,
  targetSubstring: string,
  reversed = false,
): Selection {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const nodes: Array<{ node: Text; start: number; end: number }> = [];
  let full = "";
  let current: Node | null;
  while ((current = walker.nextNode())) {
    const textNode = current as Text;
    if (textNode.parentElement?.closest(".katex-mathml")) continue;
    const start = full.length;
    full += textNode.data;
    nodes.push({ node: textNode, start, end: full.length });
  }
  const idx = full.indexOf(targetSubstring);
  if (idx < 0) {
    throw new Error(`Could not find "${targetSubstring}" inside "${full}"`);
  }
  const endIdx = idx + targetSubstring.length;
  const startEntry = nodes.find((n) => idx >= n.start && idx <= n.end)!;
  const endEntry = nodes.find((n) => endIdx >= n.start && endIdx <= n.end)!;

  const selection = window.getSelection()!;
  selection.removeAllRanges();
  if (reversed && typeof selection.setBaseAndExtent === "function") {
    selection.setBaseAndExtent(
      endEntry.node,
      endIdx - endEntry.start,
      startEntry.node,
      idx - startEntry.start,
    );
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

describe("mapLiveRenderedSelectionToSourceRange & resolveLiveRenderedFormatEdit", () => {
  afterEach(() => {
    window.getSelection()?.removeAllRanges();
  });

  it("maps rendered selections inside rich inline syntax, comments, study delimiters, wikilinks, tasks, callouts, and tables to exact source ranges", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const markdown = [
      "---",
      "title: Offset Fixture",
      "---",
      "",
      "Review %%hidden note%% **intro**, [guide](https://example.com/docs), `inline_cmd`, $x + 1$, ==highlighted==, ~sub~, ^sup^, [[VaultNote|wiki alias]], and selected rendered range with \\*escaped\\* &mdash; tail.",
      "",
      "- [x] Complete checklist target item",
      "",
      "> [!note] Callout header target",
      "> Callout body target phrase",
      "",
      ":::callout tip Directive header target",
      "Directive body target phrase",
      ":::",
      "",
      "| Metric | Description |",
      "| --- | --- |",
      "| Latency | Fast \\| steady cell target |",
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

    // 1. Rendered prose after comment, bold, link, inline code, KaTeX math, study delimiters, and wikilink
    const para = liveRoot.querySelector("p")!;
    const sel1 = selectDomTextRange(para, "selected rendered range");
    const mapped1 = mapLiveRenderedSelectionToSourceRange(sel1, liveRoot, markdown, sourceAnalysis);
    expect(mapped1).not.toBeNull();
    expect(markdown.slice(mapped1!.from, mapped1!.to)).toBe("selected rendered range");
    expect(mapped1!.reversed).toBe(false);

    // 2. Escaped characters and HTML entity alignment on the tail of the same paragraph (backward selection)
    const selTail = selectDomTextRange(para, "tail", true);
    const mappedTail = mapLiveRenderedSelectionToSourceRange(selTail, liveRoot, markdown, sourceAnalysis);
    expect(mappedTail).not.toBeNull();
    expect(markdown.slice(mappedTail!.from, mappedTail!.to)).toBe("tail");
    expect(mappedTail!.reversed).toBe(true);

    // 3. Wikilink alias maps to its exact alias slice inside [[VaultNote|wiki alias]] and stays protected from splitting
    const selWiki = selectDomTextRange(para, "wiki alias");
    const mappedWiki = mapLiveRenderedSelectionToSourceRange(selWiki, liveRoot, markdown, sourceAnalysis);
    expect(mappedWiki).not.toBeNull();
    expect(markdown.slice(mappedWiki!.from, mappedWiki!.to)).toBe("wiki alias");
    expect(resolveLiveRenderedFormatEdit(markdown, mappedWiki!, "bold")).toBeNull();

    // 4. Task list item skips the rendered checkbox + space and maps to exact source offsets
    const li = liveRoot.querySelector("li")!;
    const selTask = selectDomTextRange(li, "checklist target");
    const mappedTask = mapLiveRenderedSelectionToSourceRange(selTask, liveRoot, markdown, sourceAnalysis);
    expect(mappedTask).not.toBeNull();
    expect(markdown.slice(mappedTask!.from, mappedTask!.to)).toBe("checklist target");

    // 5. Both `> [!note]` and `:::callout` explicit titles and bodies map cleanly, while cross-title-to-body selections reject
    const callouts = liveRoot.querySelectorAll(".callout");
    expect(callouts).toHaveLength(2);
    const quoteCalloutTitle = callouts[0]!.querySelector(".callout-title")!;
    const mappedTitle = mapLiveRenderedSelectionToSourceRange(
      selectDomTextRange(quoteCalloutTitle, "header target"),
      liveRoot,
      markdown,
      sourceAnalysis,
    );
    expect(mappedTitle).not.toBeNull();
    expect(markdown.slice(mappedTitle!.from, mappedTitle!.to)).toBe("header target");

    const quoteCalloutBody = callouts[0]!.querySelector("p:not(.callout-title)")!;
    const mappedBody = mapLiveRenderedSelectionToSourceRange(
      selectDomTextRange(quoteCalloutBody, "body target phrase"),
      liveRoot,
      markdown,
      sourceAnalysis,
    );
    expect(mappedBody).not.toBeNull();
    expect(markdown.slice(mappedBody!.from, mappedBody!.to)).toBe("body target phrase");

    const directiveTitle = callouts[1]!.querySelector(".callout-title")!;
    const mappedDirTitle = mapLiveRenderedSelectionToSourceRange(
      selectDomTextRange(directiveTitle, "Directive header target"),
      liveRoot,
      markdown,
      sourceAnalysis,
    );
    expect(mappedDirTitle).not.toBeNull();
    expect(markdown.slice(mappedDirTitle!.from, mappedDirTitle!.to)).toBe("Directive header target");

    const directiveBody = callouts[1]!.querySelector("p:not(.callout-title)")!;
    const mappedDirBody = mapLiveRenderedSelectionToSourceRange(
      selectDomTextRange(directiveBody, "Directive body target"),
      liveRoot,
      markdown,
      sourceAnalysis,
    );
    expect(mappedDirBody).not.toBeNull();
    expect(markdown.slice(mappedDirBody!.from, mappedDirBody!.to)).toBe("Directive body target");

    const crossCalloutRange = document.createRange();
    crossCalloutRange.setStart(quoteCalloutTitle.firstChild!, 0);
    crossCalloutRange.setEnd(quoteCalloutBody.firstChild!, 7);
    const crossSel = window.getSelection()!;
    crossSel.removeAllRanges();
    crossSel.addRange(crossCalloutRange);
    expect(mapLiveRenderedSelectionToSourceRange(crossSel, liveRoot, markdown, sourceAnalysis)).toBeNull();

    // 6. GFM table cell with escaped pipe \| maps cleanly and rejects block-prefix actions inside table cells
    const cells = liveRoot.querySelectorAll("td");
    const selCell = selectDomTextRange(cells[1]!, "cell target");
    const mappedCell = mapLiveRenderedSelectionToSourceRange(selCell, liveRoot, markdown, sourceAnalysis);
    expect(mappedCell).not.toBeNull();
    expect(markdown.slice(mappedCell!.from, mappedCell!.to)).toBe("cell target");
    expect(resolveLiveRenderedFormatEdit(markdown, mappedCell!, "heading")).toBeNull();
    expect(resolveLiveRenderedFormatEdit(markdown, mappedCell!, "bold")?.doc).toContain("| Fast \\| steady **cell target** |");

    act(() => root.unmount());
    host.remove();
  });

  it("maps tight and loose nested lists (bullet, ordered, and task items) while rejecting cross-item selections", async () => {
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
    const sourceAnalysis = { source: markdown, analysis: analyzeDocument(markdown) };
    const listItems = liveRoot.querySelectorAll("li");
    expect(listItems.length).toBe(6);

    // 1. Tight parent <li> directly preceding a nested <ul> (ignores HAST inter-block newline)
    const selParent = selectDomTextRange(listItems[0]!, "parent target");
    const mappedParent = mapLiveRenderedSelectionToSourceRange(selParent, liveRoot, markdown, sourceAnalysis);
    expect(mappedParent).not.toBeNull();
    expect(markdown.slice(mappedParent!.from, mappedParent!.to)).toBe("parent target");
    expect(resolveLiveRenderedFormatEdit(markdown, mappedParent!, "bold")?.doc).toContain("- Tight **parent target**\n");

    // 2. Tight middle <li> containing inline emphasis, code, and KaTeX math before nested <ol>
    const selMiddle = selectDomTextRange(listItems[1]!, "middle target", true);
    const mappedMiddle = mapLiveRenderedSelectionToSourceRange(selMiddle, liveRoot, markdown, sourceAnalysis);
    expect(mappedMiddle).not.toBeNull();
    expect(markdown.slice(mappedMiddle!.from, mappedMiddle!.to)).toBe("middle target");
    expect(mappedMiddle!.reversed).toBe(true);
    const middleEdit = resolveLiveRenderedFormatEdit(markdown, mappedMiddle!, "italic");
    expect(middleEdit?.doc).toContain("  - Nested *italic* `cmd` $n + 1$ *middle target*\n");
    expect(middleEdit?.ranges[0]!.anchor).toBeGreaterThan(middleEdit?.ranges[0]!.head ?? 0);

    // 3. Deeply nested ordered <ol> item
    const selDeep = selectDomTextRange(listItems[2]!, "ordered target");
    const mappedDeep = mapLiveRenderedSelectionToSourceRange(selDeep, liveRoot, markdown, sourceAnalysis);
    expect(mappedDeep).not.toBeNull();
    expect(markdown.slice(mappedDeep!.from, mappedDeep!.to)).toBe("ordered target");

    // 4. Nested task list item skips checkbox input + space
    const selNestedTask = selectDomTextRange(listItems[3]!, "checkbox target");
    const mappedNestedTask = mapLiveRenderedSelectionToSourceRange(selNestedTask, liveRoot, markdown, sourceAnalysis);
    expect(mappedNestedTask).not.toBeNull();
    expect(markdown.slice(mappedNestedTask!.from, mappedNestedTask!.to)).toBe("checkbox target");

    // 5. Loose nested list items (<p> inside <li>)
    const selLooseOuter = selectDomTextRange(listItems[4]!, "outer item target");
    const mappedLooseOuter = mapLiveRenderedSelectionToSourceRange(selLooseOuter, liveRoot, markdown, sourceAnalysis);
    expect(mappedLooseOuter).not.toBeNull();
    expect(markdown.slice(mappedLooseOuter!.from, mappedLooseOuter!.to)).toBe("outer item target");

    const selLooseChild = selectDomTextRange(listItems[5]!, "nested child target");
    const mappedLooseChild = mapLiveRenderedSelectionToSourceRange(selLooseChild, liveRoot, markdown, sourceAnalysis);
    expect(mappedLooseChild).not.toBeNull();
    expect(markdown.slice(mappedLooseChild!.from, mappedLooseChild!.to)).toBe("nested child target");

    // 6. Cross-item selection from parent <li> into nested <li> returns null
    const crossListRange = document.createRange();
    crossListRange.setStart(listItems[0]!.firstChild!, 2);
    crossListRange.setEnd(listItems[1]!.firstChild!, 6);
    const selCross = window.getSelection()!;
    selCross.removeAllRanges();
    selCross.addRange(crossListRange);
    expect(mapLiveRenderedSelectionToSourceRange(selCross, liveRoot, markdown, sourceAnalysis)).toBeNull();

    // 7. Range on parent <li> whose endOffset extends past the nested <ul> child also returns null
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
      "Compute `flag_name`, `` raw `tick` span ``, and $x^2 + 1$ inline.",
      "",
      "```python",
      "value = 42",
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

    // 1. Substring inside single-backtick inline code: blocked for bold/italic/link, unwraps cleanly for inline_code preserving substring & direction
    const selSubCode = selectDomTextRange(codeEls[0]!, "name", true);
    const mappedSubCode = mapLiveRenderedSelectionToSourceRange(selSubCode, liveRoot, markdown, sourceAnalysis);
    expect(mappedSubCode).not.toBeNull();
    expect(markdown.slice(mappedSubCode!.from, mappedSubCode!.to)).toBe("name");
    expect(resolveLiveRenderedFormatEdit(markdown, mappedSubCode!, "bold")).toBeNull();
    expect(resolveLiveRenderedFormatEdit(markdown, mappedSubCode!, "italic")).toBeNull();
    expect(resolveLiveRenderedFormatEdit(markdown, mappedSubCode!, "link")).toBeNull();

    const unwrappedCode = resolveLiveRenderedFormatEdit(markdown, mappedSubCode!, "inline_code");
    expect(unwrappedCode).not.toBeNull();
    expect(unwrappedCode!.doc).toContain("Compute flag_name, `` raw `tick` span ``");
    const codeRange = unwrappedCode!.ranges[0]!;
    expect(codeRange.anchor).toBeGreaterThan(codeRange.head);
    expect(unwrappedCode!.doc.slice(codeRange.head, codeRange.anchor)).toBe("name");

    // 2. Double-backtick space-padded inline code unwraps cleanly
    const selDoubleCode = selectDomTextRange(codeEls[1]!, "raw `tick` span");
    const mappedDoubleCode = mapLiveRenderedSelectionToSourceRange(selDoubleCode, liveRoot, markdown, sourceAnalysis);
    expect(mappedDoubleCode).not.toBeNull();
    const unwrappedDouble = resolveLiveRenderedFormatEdit(markdown, mappedDoubleCode!, "inline_code");
    expect(unwrappedDouble?.doc).toContain("Compute `flag_name`, raw `tick` span, and");

    // 3. Inline math $x^2 + 1$: both interior text selection and element selection map to x^2 + 1, block bold/italic, and unwrap on inline_math
    const inlineKatex = liveRoot.querySelector("p .katex")!;
    for (const inside of [true, false]) {
      const selMath = selectKatexElement(inlineKatex, inside, inside);
      const mappedMath = mapLiveRenderedSelectionToSourceRange(selMath, liveRoot, markdown, sourceAnalysis);
      expect(mappedMath).not.toBeNull();
      expect(markdown.slice(mappedMath!.from, mappedMath!.to)).toBe("x^2 + 1");
      expect(resolveLiveRenderedFormatEdit(markdown, mappedMath!, "bold")).toBeNull();
      expect(resolveLiveRenderedFormatEdit(markdown, mappedMath!, "inline_code")).toBeNull();
      const unwrappedMath = resolveLiveRenderedFormatEdit(markdown, mappedMath!, "inline_math");
      expect(unwrappedMath).not.toBeNull();
      expect(unwrappedMath!.doc).toContain("and x^2 + 1 inline.");
      if (inside) {
        expect(unwrappedMath!.ranges[0]!.anchor).toBeGreaterThan(unwrappedMath!.ranges[0]!.head);
      }
    }

    // 4. Protected fenced code <pre> maps offsets for copy/inspection with protectedBlock=true and rejects formatting
    const preEl = liveRoot.querySelector("pre")!;
    const selPre = selectDomTextRange(preEl, "value = 42");
    const mappedPre = mapLiveRenderedSelectionToSourceRange(selPre, liveRoot, markdown, sourceAnalysis);
    expect(mappedPre).not.toBeNull();
    expect(mappedPre!.protectedBlock).toBe(true);
    expect(resolveLiveRenderedFormatEdit(markdown, mappedPre!, "bold")).toBeNull();

    // 5. Display math block .katex-display is rejected for inline formatting
    const displayKatex = liveRoot.querySelector(".katex-display .katex")!;
    const selDisplay = selectKatexElement(displayKatex, true);
    const mappedDisplay = mapLiveRenderedSelectionToSourceRange(selDisplay, liveRoot, markdown, sourceAnalysis);
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
    const mappedFullBold = mapLiveRenderedSelectionToSourceRange(
      selectDomTextRange(para, "hello world"),
      liveRoot,
      markdown,
      sourceAnalysis,
    )!;
    expect(resolveLiveRenderedFormatEdit(markdown, mappedFullBold, "bold")?.doc).toBe(
      "Start hello world and *italicized* and ***both*** and [docs link](https://example.com) end.",
    );
    expect(resolveLiveRenderedFormatEdit(markdown, mappedFullBold, "italic")?.doc).toBe(
      "Start ***hello world*** and *italicized* and ***both*** and [docs link](https://example.com) end.",
    );

    // 2. Combined ***both***: bold unwraps to *both*, italic unwraps to **both**
    const mappedBoth = mapLiveRenderedSelectionToSourceRange(
      selectDomTextRange(para, "both"),
      liveRoot,
      markdown,
      sourceAnalysis,
    )!;
    expect(resolveLiveRenderedFormatEdit(markdown, mappedBoth, "bold")?.doc).toContain("and *both* and");
    expect(resolveLiveRenderedFormatEdit(markdown, mappedBoth, "italic")?.doc).toContain("and **both** and");

    // 3. Existing [docs link](https://example.com): link unwraps to docs link, bold formats label to [**docs link**](...)
    const mappedLink = mapLiveRenderedSelectionToSourceRange(
      selectDomTextRange(para, "docs link"),
      liveRoot,
      markdown,
      sourceAnalysis,
    )!;
    expect(resolveLiveRenderedFormatEdit(markdown, mappedLink, "link")?.doc).toContain("and docs link end.");
    expect(resolveLiveRenderedFormatEdit(markdown, mappedLink, "bold")?.doc).toContain(
      "and [**docs link**](https://example.com) end.",
    );

    // 4. Partial selection INSIDE **hello world** ("world" selected backward):
    //    - bold unwraps enclosing **hello world** without splitting and keeps "world" selected backward
    //    - italic wraps only the selected substring: **hello *world***
    const mappedPartialInside = mapLiveRenderedSelectionToSourceRange(
      selectDomTextRange(para, "world", true),
      liveRoot,
      markdown,
      sourceAnalysis,
    )!;
    const unwrappedPartial = resolveLiveRenderedFormatEdit(markdown, mappedPartialInside, "bold")!;
    expect(unwrappedPartial.doc).toBe(
      "Start hello world and *italicized* and ***both*** and [docs link](https://example.com) end.",
    );
    expect(unwrappedPartial.ranges[0]!.anchor).toBeGreaterThan(unwrappedPartial.ranges[0]!.head);
    expect(unwrappedPartial.doc.slice(unwrappedPartial.ranges[0]!.head, unwrappedPartial.ranges[0]!.anchor)).toBe(
      "world",
    );
    expect(resolveLiveRenderedFormatEdit(markdown, mappedPartialInside, "italic")?.doc).toContain(
      "Start **hello *world*** and",
    );

    // 5. Boundary-straddling selection ("lo world and"): rejected for all inline formatting so delimiters never cross
    const mappedStraddle = mapLiveRenderedSelectionToSourceRange(
      selectDomTextRange(para, "lo world and"),
      liveRoot,
      markdown,
      sourceAnalysis,
    )!;
    expect(resolveLiveRenderedFormatEdit(markdown, mappedStraddle, "bold")).toBeNull();
    expect(resolveLiveRenderedFormatEdit(markdown, mappedStraddle, "italic")).toBeNull();
    expect(resolveLiveRenderedFormatEdit(markdown, mappedStraddle, "inline_code")).toBeNull();

    // 6. Plain + existing formatted span ("Start **hello world**"): rejects duplicate bold, allows outer italic
    const mappedEnclosingBold = mapLiveRenderedSelectionToSourceRange(
      selectDomTextRange(para, "Start hello world"),
      liveRoot,
      markdown,
      sourceAnalysis,
    )!;
    expect(markdown.slice(mappedEnclosingBold.from, mappedEnclosingBold.to)).toBe("Start **hello world**");
    expect(resolveLiveRenderedFormatEdit(markdown, mappedEnclosingBold, "bold")).toBeNull();
    expect(resolveLiveRenderedFormatEdit(markdown, mappedEnclosingBold, "italic")?.doc).toContain(
      "*Start **hello world*** and",
    );

    act(() => root.unmount());
    host.remove();
  });

  it("translates rendered selections through active upstream draft edits and rejects multi-paragraph selections", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const baseDoc = "First block\n\nSecond paragraph with rendered selection here.\n\nThird paragraph.";
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
    const sourceAnalysis = { source: baseDoc, analysis: analyzeDocument(baseDoc) };
    const paragraphs = liveRoot.querySelectorAll("p");

    // Simulate an active edit in block 0 ("First block" -> "First block expanded significantly")
    const activeDoc = baseDoc.replace("First block", "First block expanded significantly");
    const editingContext = { baseMarkdown: baseDoc, baseSplitEnd: "First block".length };

    expect(translateLiveRenderedRange(13, 30, editingContext, activeDoc)).toEqual([
      13 + (activeDoc.length - baseDoc.length),
      30 + (activeDoc.length - baseDoc.length),
    ]);

    const selSingle = selectDomTextRange(paragraphs[1]!, "rendered selection");
    const mappedShifted = mapLiveRenderedSelectionToSourceRange(
      selSingle,
      liveRoot,
      baseDoc,
      sourceAnalysis,
      editingContext,
      activeDoc,
    );
    expect(mappedShifted).not.toBeNull();
    expect(baseDoc.slice(mappedShifted!.renderedFrom, mappedShifted!.renderedTo)).toBe("rendered selection");
    expect(activeDoc.slice(mappedShifted!.from, mappedShifted!.to)).toBe("rendered selection");

    // Multi-paragraph selection spanning paragraph 2 -> paragraph 3 returns null
    const multiRange = document.createRange();
    multiRange.setStart(paragraphs[1]!.firstChild!, 0);
    multiRange.setEnd(paragraphs[2]!.firstChild!, 5);
    const selMulti = window.getSelection()!;
    selMulti.removeAllRanges();
    selMulti.addRange(multiRange);
    expect(
      mapLiveRenderedSelectionToSourceRange(selMulti, liveRoot, baseDoc, sourceAnalysis),
    ).toBeNull();

    act(() => root.unmount());
    host.remove();
  });
});
