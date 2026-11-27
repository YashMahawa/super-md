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
  mapLiveRenderedSelectionToSourceRange,
  planGuardedLiveFormat,
  resolveDoubleClickCaretRange,
  resolveLiveCaretOffset,
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

  it("maps rendered selections and verified collapsed carets through the same shared inline code, math, comment, image, footnote, callout, nested list, and table spans", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const richPara =
      "Review **intro**, [guide](https://example.com/docs), `` `inline_cmd` ``, $x + 1$, ==highlighted==, [[VaultNote|wiki alias]], %%percent hidden%%<!-- html hidden --> ![diagram](chart.png){width=240} ref[^1] and selected rendered range with \\*escaped\\* &mdash; tail.";
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

    // 1. Prose after bold, link, padded inline code, inline math, study highlight, wikilink, %% & <!-- --> comments, sized image, and footnote
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

    // 2. Reversed selection on escaped + entity tail, wikilink alias, padded inline code, straddling bold delimiter expansion, and single inline math inner bounds
    const selTail = selectDomTextRange(para, "tail", true);
    const mappedTail = mapLiveRenderedSelectionToSourceRange(selTail, liveRoot, markdown, sourceAnalysis);
    expect(mappedTail?.reversed).toBe(true);
    expect(markdown.slice(mappedTail!.from, mappedTail!.to)).toBe("tail");

    const selWiki = selectDomTextRange(para, "wiki alias");
    const mappedWiki = mapLiveRenderedSelectionToSourceRange(selWiki, liveRoot, markdown, sourceAnalysis);
    expect(markdown.slice(mappedWiki!.from, mappedWiki!.to)).toBe("wiki alias");

    const caretCode = resolveLiveCaretOffset(blocks[0]!, collapsedCaretAt(para, "`inline_cmd`", 1), markdown, pStart, pEnd, sourceAnalysis);
    expect(caretCode).toBe(richPara.indexOf("inline_cmd"));

    const mappedLeftStraddle = mapLiveRenderedSelectionToSourceRange(selectDomTextRange(para, "intro, "), liveRoot, markdown, sourceAnalysis);
    expect(markdown.slice(mappedLeftStraddle!.from, mappedLeftStraddle!.to)).toBe("**intro**, ");

    const selStraddle = selectDomTextRange(para, "intro, guide");
    const mappedStraddle = mapLiveRenderedSelectionToSourceRange(selStraddle, liveRoot, markdown, sourceAnalysis);
    expect(markdown.slice(mappedStraddle!.from, mappedStraddle!.to)).toBe("**intro**, [guide](https://example.com/docs)");

    const katexEl = para.querySelector(".katex")!;
    const mathRange = document.createRange();
    mathRange.selectNodeContents(katexEl);
    const selMath = window.getSelection()!;
    selMath.removeAllRanges();
    selMath.addRange(mathRange);
    const mappedMath = mapLiveRenderedSelectionToSourceRange(selMath, liveRoot, markdown, sourceAnalysis);
    expect(markdown.slice(mappedMath!.from, mappedMath!.to)).toBe("x + 1");

    // 3. Nested task list item (parent li excluding nested child ul, child li, and cross-item rejection)
    const listItems = blocks[1]!.querySelectorAll("li");
    const mappedParentTask = mapLiveRenderedSelectionToSourceRange(selectDomTextRange(listItems[0]!, "Parent task"), liveRoot, markdown, sourceAnalysis);
    expect(markdown.slice(mappedParentTask!.from, mappedParentTask!.to)).toBe("Parent task");

    const selNestedTask = selectDomTextRange(listItems[1]!, "checklist target");
    const mappedTask = mapLiveRenderedSelectionToSourceRange(selNestedTask, liveRoot, markdown, sourceAnalysis);
    expect(markdown.slice(mappedTask!.from, mappedTask!.to)).toBe("checklist target");

    const parentCaret = collapsedCaretAt(listItems[0]!, "Parent task", 2);
    const childCaret = collapsedCaretAt(listItems[1]!, "checklist target", 4);
    const crossLiRange = document.createRange();
    crossLiRange.setStart(parentCaret.startContainer, parentCaret.startOffset);
    crossLiRange.setEnd(childCaret.startContainer, childCaret.startOffset);
    const crossLiSel = window.getSelection()!;
    crossLiSel.removeAllRanges();
    crossLiSel.addRange(crossLiRange);
    expect(mapLiveRenderedSelectionToSourceRange(crossLiSel, liveRoot, markdown, sourceAnalysis)).toBeNull();

    const lStart = Number(blocks[1]!.dataset.sourceStart);
    const lEnd = Number(blocks[1]!.dataset.sourceEnd);
    expect(resolveLiveCaretOffset(blocks[1]!, collapsedCaretAt(listItems[1]!, "checklist target"), markdown, lStart, lEnd, sourceAnalysis)).toBe(
      markdown.slice(lStart, lEnd).indexOf("checklist target"),
    );

    // 4. Callouts: custom > [!note], default synthesized > [!tip], and fenced :::callout
    const calloutTitle = blocks[2]!.querySelector(".callout-title")!;
    const mappedTitle = mapLiveRenderedSelectionToSourceRange(selectDomTextRange(calloutTitle, "header target"), liveRoot, markdown, sourceAnalysis);
    expect(markdown.slice(mappedTitle!.from, mappedTitle!.to)).toBe("header target");

    const calloutBody = blocks[2]!.querySelector(".callout p:not(.callout-title)")!;
    const mappedBody = mapLiveRenderedSelectionToSourceRange(selectDomTextRange(calloutBody, "body target phrase"), liveRoot, markdown, sourceAnalysis);
    expect(markdown.slice(mappedBody!.from, mappedBody!.to)).toBe("body target phrase");

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

    // 5. GFM table cell with escaped pipe \|
    const cells = blocks[5]!.querySelectorAll("td");
    const mappedCell = mapLiveRenderedSelectionToSourceRange(selectDomTextRange(cells[1]!, "cell target"), liveRoot, markdown, sourceAnalysis);
    expect(markdown.slice(mappedCell!.from, mappedCell!.to)).toBe("cell target");
    const tStart = Number(blocks[5]!.dataset.sourceStart);
    const tEnd = Number(blocks[5]!.dataset.sourceEnd);
    expect(resolveLiveCaretOffset(blocks[5]!, collapsedCaretAt(cells[1]!, "cell target"), markdown, tStart, tEnd, sourceAnalysis)).toBe(
      markdown.slice(tStart, tEnd).indexOf("cell target"),
    );

    act(() => root.unmount());
    host.remove();
  });

  it("retains formatting selection guards and requires a verified collapsed non-interactive caret in the click wrapper", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const baseDoc = [
      "First block",
      "",
      "Second paragraph with [linked docs](https://example.com) and rendered selection here.",
      "",
      "Third paragraph.",
      "",
      "```ts",
      "const value = 42;",
      "```",
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

    // Upstream active draft offset shift
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

    // Formatting wrapper rejects collapsed selections, multi-paragraph selections, and code disclosure summary
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

    const codePre = blocks[3]!.querySelector("pre")!;
    const mappedPre = mapLiveRenderedSelectionToSourceRange(selectDomTextRange(codePre, "value = 42"), liveRoot, baseDoc, sourceAnalysis);
    expect(baseDoc.slice(mappedPre!.from, mappedPre!.to)).toBe("value = 42");
    const codeSummary = blocks[3]!.querySelector("summary")!;
    expect(mapLiveRenderedSelectionToSourceRange(selectDomTextRange(codeSummary, "ts"), liveRoot, baseDoc, sourceAnalysis)).toBeNull();

    // Click wrapper rejects non-collapsed ranges and interactive link targets, while accepting verified collapsed prose carets
    const b1Start = Number(blocks[1]!.dataset.sourceStart);
    const b1End = Number(blocks[1]!.dataset.sourceEnd);
    const nonCollapsedRange = selectDomTextRange(paragraphs[1]!, "rendered selection").getRangeAt(0);
    expect(nonCollapsedRange.collapsed).toBe(false);
    expect(resolveLiveCaretOffset(blocks[1]!, nonCollapsedRange, baseDoc, b1Start, b1End, sourceAnalysis)).toBeNull();
    expect(resolveLiveCaretOffset(blocks[1]!, collapsed, baseDoc, b1Start, b1End, sourceAnalysis)).toBe(
      baseDoc.slice(b1Start, b1End).indexOf("rendered selection") + 3,
    );

    const proseNode = collapsed.startContainer;
    delete (document as Partial<Document>).caretPositionFromPoint;
    const nonCollapsedSel = selectDomTextRange(paragraphs[1]!, "rendered selection");
    expect(nonCollapsedSel.isCollapsed).toBe(false);
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
    const verifiedCaret = resolveDoubleClickCaretRange(blocks[1]!, paragraphs[1]!, 80, 40);
    expect(verifiedCaret?.collapsed).toBe(true);

    // Caller compatibility re-exports on liveInsertionPoint point to the exact unified helpers
    expect(reexportedDoubleClickCaretRange).toBe(resolveDoubleClickCaretRange);
    expect(reexportedLiveCaretOffset).toBe(resolveLiveCaretOffset);

    // planGuardedLiveFormat enforces protected block, inlineCode, and inlineMath guards while allowing matching unwraps
    expect(planGuardedLiveFormat(baseDoc, mappedPre!.from, mappedPre!.to, false, mappedPre!.blockStart, mappedPre!.blockEnd, "bold", sourceAnalysis)).toBeNull();
    const spanDoc = "Run `flag` or `` `pad` `` and $x + 1$ or $$y + 2$$ now.";
    const codeInnerStart = spanDoc.indexOf("flag");
    expect(planGuardedLiveFormat(spanDoc, codeInnerStart, codeInnerStart + 4, false, 0, spanDoc.length, "bold")).toBeNull();
    expect(planGuardedLiveFormat(spanDoc, codeInnerStart, codeInnerStart + 4, false, 0, spanDoc.length, "inline_code")?.doc).toBe(
      "Run flag or `` `pad` `` and $x + 1$ or $$y + 2$$ now.",
    );
    const padInnerStart = spanDoc.indexOf("`pad`");
    expect(planGuardedLiveFormat(spanDoc, padInnerStart, padInnerStart + 5, false, 0, spanDoc.length, "inline_code")?.doc).toBe(
      "Run `flag` or `pad` and $x + 1$ or $$y + 2$$ now.",
    );
    const mathInnerStart = spanDoc.indexOf("x + 1");
    expect(planGuardedLiveFormat(spanDoc, mathInnerStart, mathInnerStart + 5, false, 0, spanDoc.length, "bold")).toBeNull();
    expect(planGuardedLiveFormat(spanDoc, mathInnerStart, mathInnerStart + 5, false, 0, spanDoc.length, "inline_math")?.doc).toBe(
      "Run `flag` or `` `pad` `` and x + 1 or $$y + 2$$ now.",
    );
    const doubleMathStart = spanDoc.indexOf("y + 2");
    expect(planGuardedLiveFormat(spanDoc, doubleMathStart, doubleMathStart + 5, false, 0, spanDoc.length, "inline_math")).toBeNull();
    const outerCodeStart = spanDoc.indexOf("`flag`");
    const padOuterEnd = spanDoc.indexOf("`` and") + 2;
    expect(planGuardedLiveFormat(spanDoc, outerCodeStart, padOuterEnd, false, 0, spanDoc.length, "bold")?.doc).toBe(
      "Run **`flag` or `` `pad` ``** and $x + 1$ or $$y + 2$$ now.",
    );
    expect(planGuardedLiveFormat(spanDoc, outerCodeStart, padOuterEnd, false, 0, spanDoc.length, "inline_code")).toBeNull();

    act(() => root.unmount());
    host.remove();
  });
});
