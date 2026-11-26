// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import LiveEditor from "./components/LiveEditor";
import { analyzeDocument } from "./documentAnalysis";
import { mapLiveRenderedSelectionToSourceRange, translateLiveRenderedRange } from "./liveSelectionRange";

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

describe("mapLiveRenderedSelectionToSourceRange", () => {
  afterEach(() => {
    window.getSelection()?.removeAllRanges();
  });

  it("maps rendered selections inside rich inline syntax, study delimiters, wikilinks, tasks, callouts, and tables to exact source ranges", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const markdown = [
      "---",
      "title: Offset Fixture",
      "---",
      "",
      "Review **intro**, [guide](https://example.com/docs), `inline_cmd`, $x + 1$, ==highlighted==, [[VaultNote|wiki alias]], and selected rendered range with \\*escaped\\* &mdash; tail.",
      "",
      "- [x] Complete checklist target item",
      "",
      "> [!note] Callout header target",
      "> Callout body target phrase",
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

    // 1. Rendered prose after bold, link, inline code, KaTeX math, study highlight, and wikilink
    const para = liveRoot.querySelector("p")!;
    const sel1 = selectDomTextRange(para, "selected rendered range");
    const mapped1 = mapLiveRenderedSelectionToSourceRange(sel1, liveRoot, markdown, sourceAnalysis);
    expect(mapped1).not.toBeNull();
    expect(markdown.slice(mapped1!.from, mapped1!.to)).toBe("selected rendered range");
    expect(mapped1!.reversed).toBe(false);

    // 2. Escaped characters and HTML entity alignment on the tail of the same paragraph
    const selTail = selectDomTextRange(para, "tail", true);
    const mappedTail = mapLiveRenderedSelectionToSourceRange(selTail, liveRoot, markdown, sourceAnalysis);
    expect(mappedTail).not.toBeNull();
    expect(markdown.slice(mappedTail!.from, mappedTail!.to)).toBe("tail");
    expect(mappedTail!.reversed).toBe(true);

    // 3. Wikilink alias maps to its exact alias slice inside [[VaultNote|wiki alias]]
    const selWiki = selectDomTextRange(para, "wiki alias");
    const mappedWiki = mapLiveRenderedSelectionToSourceRange(selWiki, liveRoot, markdown, sourceAnalysis);
    expect(mappedWiki).not.toBeNull();
    expect(markdown.slice(mappedWiki!.from, mappedWiki!.to)).toBe("wiki alias");

    // 4. Task list item skips the rendered checkbox + space and maps to exact source offsets
    const li = liveRoot.querySelector("li")!;
    const selTask = selectDomTextRange(li, "checklist target");
    const mappedTask = mapLiveRenderedSelectionToSourceRange(selTask, liveRoot, markdown, sourceAnalysis);
    expect(mappedTask).not.toBeNull();
    expect(markdown.slice(mappedTask!.from, mappedTask!.to)).toBe("checklist target");

    // 5. Callout explicit title and body lines
    const calloutTitle = liveRoot.querySelector(".callout-title")!;
    const selCalloutTitle = selectDomTextRange(calloutTitle, "header target");
    const mappedTitle = mapLiveRenderedSelectionToSourceRange(selCalloutTitle, liveRoot, markdown, sourceAnalysis);
    expect(mappedTitle).not.toBeNull();
    expect(markdown.slice(mappedTitle!.from, mappedTitle!.to)).toBe("header target");

    const calloutBody = liveRoot.querySelector(".callout p:not(.callout-title)")!;
    const selCalloutBody = selectDomTextRange(calloutBody, "body target phrase");
    const mappedBody = mapLiveRenderedSelectionToSourceRange(selCalloutBody, liveRoot, markdown, sourceAnalysis);
    expect(mappedBody).not.toBeNull();
    expect(markdown.slice(mappedBody!.from, mappedBody!.to)).toBe("body target phrase");

    // 6. GFM table cell with escaped pipe \|
    const cells = liveRoot.querySelectorAll("td");
    const selCell = selectDomTextRange(cells[1]!, "cell target");
    const mappedCell = mapLiveRenderedSelectionToSourceRange(selCell, liveRoot, markdown, sourceAnalysis);
    expect(mappedCell).not.toBeNull();
    expect(markdown.slice(mappedCell!.from, mappedCell!.to)).toBe("cell target");

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
