// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EditorSelection, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Editor, {
  editorHistory,
  editorSelectedText,
  editorViewContext,
  exportEditorSession,
} from "./Editor";
import type { SourceChange } from "../readerEdits";
import { setTypewriterScroll } from "../typewriterScroll";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect ??= () => new DOMRect(0, 0, 0, 0);

interface SelectionSpec {
  anchor: number;
  head: number;
}

function rangeForSubstring(
  doc: string,
  target: string,
  options?: { occurrence?: number; reversed?: boolean },
): SelectionSpec {
  const occurrence = options?.occurrence ?? 0;
  let searchFrom = 0;
  let found = -1;
  for (let i = 0; i <= occurrence; i++) {
    found = doc.indexOf(target, searchFrom);
    if (found === -1) {
      throw new Error(`Substring ${JSON.stringify(target)} (occurrence ${occurrence}) not found in document`);
    }
    searchFrom = found + target.length;
  }
  const from = found;
  const to = found + target.length;
  return options?.reversed ? { anchor: to, head: from } : { anchor: from, head: to };
}

function expectedMultiCursorStatus(doc: string, ranges: ReadonlyArray<SelectionSpec>, mainIndex: number): string {
  const main = ranges[mainIndex];
  const prefix = doc.slice(0, main.head);
  const lines = prefix.split("\n");
  const lineNumber = lines.length;
  const colNumber = lines[lines.length - 1].length + 1;
  const selected = ranges.reduce((sum, r) => sum + Math.abs(r.head - r.anchor), 0);
  if (ranges.length > 1) {
    return `Ln ${lineNumber}, Col ${colNumber} · ${ranges.length} cursors`;
  }
  return `Ln ${lineNumber}, Col ${colNumber}${selected ? ` · ${selected} selected` : ""}`;
}

function readInsertionPoint(): { from: number; to: number } | undefined {
  const detail: { point?: { from: number; to: number } } = {};
  window.dispatchEvent(new CustomEvent("supermd-insertion-point", { detail }));
  return detail.point;
}

describe("Source CodeMirror multi-selection paste across prose, code, and YAML contexts", () => {
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

  async function createPasteHarness() {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    hostContainer = container;
    hostRoot = root;

    const changeBatches: Array<{ value: string; changes: SourceChange[] }> = [];
    let activeState: { sessionId: string; value: string; latexAutofix?: boolean } | null = null;
    let applyState!: (next: { sessionId: string; value: string; latexAutofix?: boolean } | null) => void;

    function Workspace() {
      const [current, setCurrent] = useState<{
        sessionId: string;
        value: string;
        latexAutofix?: boolean;
      } | null>(null);
      applyState = (next) => {
        activeState = next;
        setCurrent(next);
      };
      if (!current) return null;
      return (
        <Editor
          key={current.sessionId}
          sessionId={current.sessionId}
          value={current.value}
          latexAutofix={current.latexAutofix ?? false}
          onChange={(nextValue, changes) => {
            changeBatches.push({ value: nextValue, changes: changes ?? [] });
            setCurrent((prev) => {
              if (!prev || prev.sessionId !== current.sessionId) return prev;
              const updated = { ...prev, value: nextValue };
              activeState = updated;
              return updated;
            });
          }}
          dark={false}
          focusMode={false}
        />
      );
    }

    await act(async () => {
      root.render(<Workspace />);
    });

    const getView = (): EditorView => {
      const cmContent = container.querySelector<HTMLElement>(".cm-content");
      if (!cmContent) throw new Error("Expected mounted .cm-content element");
      const view = EditorView.findFromDOM(cmContent);
      if (!view) throw new Error("Expected EditorView attached to .cm-content");
      return view;
    };

    const setSelections = (ranges: ReadonlyArray<SelectionSpec>, mainIndex = 0) => {
      const view = getView();
      act(() => {
        view.focus();
        view.dispatch({
          selection: EditorSelection.create(
            ranges.map((r) => EditorSelection.range(r.anchor, r.head)),
            mainIndex,
          ),
          annotations: Transaction.addToHistory.of(false),
        });
      });
    };

    const dispatchPaste = (clipboardText: string): { defaultPrevented: boolean; boundaryCount: number } => {
      const cmContent = container.querySelector<HTMLElement>(".cm-content")!;
      let boundaryCount = 0;
      const onBoundary = () => {
        boundaryCount += 1;
      };
      window.addEventListener("supermd-history-boundary", onBoundary);
      const pasteEvent = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(pasteEvent, "clipboardData", {
        value: {
          files: [],
          getData: (type: string) => (type === "text/plain" ? clipboardText : ""),
        },
      });
      try {
        act(() => {
          cmContent.dispatchEvent(pasteEvent);
        });
      } finally {
        window.removeEventListener("supermd-history-boundary", onBoundary);
      }
      return { defaultPrevented: pasteEvent.defaultPrevented, boundaryCount };
    };

    const dispatchUserInsert = (pos: number, insert: string, timestampMs: number) => {
      const view = getView();
      act(() => {
        view.dispatch({
          changes: { from: pos, to: pos, insert },
          selection: { anchor: pos + insert.length },
          userEvent: "input.type",
          annotations: Transaction.time.of(timestampMs),
        });
      });
    };

    const readSelectionState = (sessionId: string) => {
      const view = getView();
      const ranges = view.state.selection.ranges.map((r) => ({ anchor: r.anchor, head: r.head }));
      const mainIndex = view.state.selection.mainIndex;
      const exported = exportEditorSession(sessionId);
      const serializedSelection = (
        exported?.state as { selection?: { ranges: Array<{ anchor: number; head: number }>; main: number } } | undefined
      )?.selection;
      expect(serializedSelection).toEqual({ ranges, main: mainIndex });
      return {
        ranges,
        mainIndex,
        statusText: container.querySelector(".source-position")?.textContent ?? "",
        insertionPoint: readInsertionPoint(),
        selectedText: editorSelectedText(sessionId),
      };
    };

    return {
      container,
      changeBatches,
      mount: async (sessionId: string, value: string, options?: { latexAutofix?: boolean }) => {
        await act(async () => {
          applyState({ sessionId, value, ...options });
        });
      },
      setExternalValue: async (sessionId: string, value: string, options?: { latexAutofix?: boolean }) => {
        await act(async () => {
          applyState({ sessionId, value, ...options });
        });
      },
      getValue: () => activeState?.value ?? "",
      getView,
      setSelections,
      dispatchPaste,
      dispatchUserInsert,
      readSelectionState,
    };
  }

  it("wraps multiple prose selections on standalone URL paste, preserves exact collapsed offsets and mainIndex, and undoes in one isolated transaction", async () => {
    const harness = await createPasteHarness();
    const sessionId = "paste-multi-prose-url";
    const baseDoc = [
      "# Release Guide",
      "",
      "Consult overview first, then review API v2 notes,",
      "- and verify deployment [draft.",
    ].join("\n");
    await harness.mount(sessionId, baseDoc);

    // Perform an earlier user edit so we verify isolateHistory prevents merging with prior typing.
    harness.dispatchUserInsert(baseDoc.length, "\nFooter.", 1_000);
    const docBeforePaste = `${baseDoc}\nFooter.`;
    expect(harness.getValue()).toBe(docBeforePaste);

    const sel0 = rangeForSubstring(docBeforePaste, "overview");
    const sel1 = rangeForSubstring(docBeforePaste, "API v2", { reversed: true });
    const sel2 = rangeForSubstring(docBeforePaste, "deployment [draft");
    const prePasteRanges = [sel0, sel1, sel2];
    const mainIndex = 1;
    harness.setSelections(prePasteRanges, mainIndex);

    const beforeSelState = harness.readSelectionState(sessionId);
    expect(beforeSelState.ranges).toEqual(prePasteRanges);
    expect(beforeSelState.mainIndex).toBe(1);
    expect(beforeSelState.selectedText).toBe("API v2");
    expect(beforeSelState.insertionPoint).toEqual({
      from: Math.min(sel1.anchor, sel1.head),
      to: Math.max(sel1.anchor, sel1.head),
    });
    expect(beforeSelState.statusText).toBe(expectedMultiCursorStatus(docBeforePaste, prePasteRanges, mainIndex));

    const batchCountBefore = harness.changeBatches.length;
    const rawUrl = "https://docs.example.com/spec_(v2)";
    const escapedUrl = "https://docs.example.com/spec_%28v2%29";
    const pasteOutcome = harness.dispatchPaste(rawUrl);

    expect(pasteOutcome.defaultPrevented).toBe(true);
    expect(pasteOutcome.boundaryCount).toBe(2);
    expect(harness.changeBatches.length - batchCountBefore).toBe(1);

    const insert0 = `[overview](${escapedUrl})`;
    const insert1 = `[API v2](${escapedUrl})`;
    const insert2 = `[deployment \\[draft](${escapedUrl})`;
    const expectedDocAfterPaste = [
      "# Release Guide",
      "",
      `Consult ${insert0} first, then review ${insert1} notes,`,
      `- and verify ${insert2}.`,
      "Footer.",
    ].join("\n");

    expect(harness.getValue()).toBe(expectedDocAfterPaste);
    expect(editorViewContext(sessionId)?.visibleText).toBe(expectedDocAfterPaste);
    expect(harness.changeBatches.at(-1)?.changes).toEqual([
      { from: sel0.anchor, to: sel0.head, insert: insert0 },
      { from: Math.min(sel1.anchor, sel1.head), to: Math.max(sel1.anchor, sel1.head), insert: insert1 },
      { from: sel2.anchor, to: sel2.head, insert: insert2 },
    ]);

    const sel0From = sel0.anchor;
    const sel0Len = "overview".length;
    const sel1From = Math.min(sel1.anchor, sel1.head);
    const sel1Len = "API v2".length;
    const sel2From = sel2.anchor;

    const delta0 = insert0.length - sel0Len;
    const delta1 = insert1.length - sel1Len;
    const caret0 = sel0From + insert0.length;
    const caret1 = sel1From + delta0 + insert1.length;
    const caret2 = sel2From + delta0 + delta1 + insert2.length;
    const expectedPostPasteRanges: SelectionSpec[] = [
      { anchor: caret0, head: caret0 },
      { anchor: caret1, head: caret1 },
      { anchor: caret2, head: caret2 },
    ];

    const afterSelState = harness.readSelectionState(sessionId);
    expect(afterSelState.ranges).toEqual(expectedPostPasteRanges);
    expect(afterSelState.mainIndex).toBe(mainIndex);
    expect(afterSelState.selectedText).toBeNull();
    expect(afterSelState.insertionPoint).toEqual({ from: caret1, to: caret1 });
    expect(afterSelState.statusText).toBe(
      expectedMultiCursorStatus(expectedDocAfterPaste, expectedPostPasteRanges, mainIndex),
    );

    // Perform a subsequent edit immediately at the same timestamp to verify post-paste isolation too.
    harness.dispatchUserInsert(expectedDocAfterPaste.length, "!", 1_000);
    expect(harness.getValue()).toBe(`${expectedDocAfterPaste}!`);

    // Undo 1: reverts only the trailing "!" edit.
    await act(async () => {
      expect(editorHistory(sessionId, "undo")).toBe(true);
    });
    expect(harness.getValue()).toBe(expectedDocAfterPaste);

    // Undo 2: single undo transaction reverts all 3 wrapped links at once and restores exact pre-paste selections (including reversed range 1) without undoing "\nFooter.".
    await act(async () => {
      expect(editorHistory(sessionId, "undo")).toBe(true);
    });
    expect(harness.getValue()).toBe(docBeforePaste);
    const undoneSelState = harness.readSelectionState(sessionId);
    expect(undoneSelState.ranges).toEqual(prePasteRanges);
    expect(undoneSelState.mainIndex).toBe(mainIndex);
    expect(undoneSelState.selectedText).toBe("API v2");

    // Redo: single redo transaction re-applies all 3 wrapped links and maps each selection across its re-inserted link.
    await act(async () => {
      expect(editorHistory(sessionId, "redo")).toBe(true);
    });
    expect(harness.getValue()).toBe(expectedDocAfterPaste);
    const redoneSelState = harness.readSelectionState(sessionId);
    expect(redoneSelState.ranges).toEqual([
      { anchor: sel0From, head: caret0 },
      { anchor: caret1, head: sel1From + delta0 },
      { anchor: sel2From + delta0 + delta1, head: caret2 },
    ]);
    expect(redoneSelState.mainIndex).toBe(mainIndex);

    // Undoing the paste and then undoing one more step reverts the earlier "\nFooter." edit cleanly.
    await act(async () => {
      expect(editorHistory(sessionId, "undo")).toBe(true);
      expect(editorHistory(sessionId, "undo")).toBe(true);
    });
    expect(harness.getValue()).toBe(baseDoc);
  });

  it("inserts raw URL across all selections with exact offsets and single undo when multiple selections mix prose with protected code contexts", async () => {
    const harness = await createPasteHarness();
    const sessionId = "paste-multi-prose-and-code-url";
    const initialDoc = [
      "Read primary_docs or run `inline_token` locally.",
      "",
      "```ts",
      'const endpoint = "fenced_token";',
      "```",
      "",
      "    indented_token = true",
    ].join("\n");
    await harness.mount(sessionId, initialDoc);

    // 1. Prose + fenced code block + inline code (3 selections, mainIndex = 2)
    const proseRange = rangeForSubstring(initialDoc, "primary_docs");
    const inlineCodeRange = rangeForSubstring(initialDoc, "inline_token");
    const fencedCodeRange = rangeForSubstring(initialDoc, "fenced_token");
    const mixedCodeRanges = [proseRange, inlineCodeRange, fencedCodeRange];
    harness.setSelections(mixedCodeRanges, 2);

    const url = "https://api.example.com/v1/health";
    const batchBefore = harness.changeBatches.length;
    const outcome = harness.dispatchPaste(url);
    expect(outcome.defaultPrevented).toBe(true);
    expect(outcome.boundaryCount).toBe(2);
    expect(harness.changeBatches.length - batchBefore).toBe(1);

    const expectedMixedCodeDoc = [
      `Read ${url} or run \`${url}\` locally.`,
      "",
      "```ts",
      `const endpoint = "${url}";`,
      "```",
      "",
      "    indented_token = true",
    ].join("\n");
    expect(harness.getValue()).toBe(expectedMixedCodeDoc);
    expect(harness.getValue()).not.toContain("[primary_docs]");
    expect(harness.getValue()).not.toContain("[inline_token]");
    expect(harness.getValue()).not.toContain("[fenced_token]");

    const delta0 = url.length - "primary_docs".length;
    const delta1 = url.length - "inline_token".length;
    const expectedCaret0 = proseRange.anchor + url.length;
    const expectedCaret1 = inlineCodeRange.anchor + delta0 + url.length;
    const expectedCaret2 = fencedCodeRange.anchor + delta0 + delta1 + url.length;
    const expectedPostRanges: SelectionSpec[] = [
      { anchor: expectedCaret0, head: expectedCaret0 },
      { anchor: expectedCaret1, head: expectedCaret1 },
      { anchor: expectedCaret2, head: expectedCaret2 },
    ];

    const postState = harness.readSelectionState(sessionId);
    expect(postState.ranges).toEqual(expectedPostRanges);
    expect(postState.mainIndex).toBe(2);
    expect(postState.insertionPoint).toEqual({ from: expectedCaret2, to: expectedCaret2 });
    expect(postState.statusText).toBe(expectedMultiCursorStatus(expectedMixedCodeDoc, expectedPostRanges, 2));

    // Single undo reverts all 3 selections in prose, inline code, and fenced code simultaneously.
    await act(async () => {
      expect(editorHistory(sessionId, "undo")).toBe(true);
    });
    expect(harness.getValue()).toBe(initialDoc);
    const undoneState = harness.readSelectionState(sessionId);
    expect(undoneState.ranges).toEqual(mixedCodeRanges);
    expect(undoneState.mainIndex).toBe(2);
    expect(editorHistory(sessionId, "undo")).toBe(false);

    // 2. Prose + 4-space indented CodeBlock selection -> raw URL across both selections, single undo
    const indentedRange = rangeForSubstring(initialDoc, "indented_token");
    const indentedMixRanges = [proseRange, indentedRange];
    harness.setSelections(indentedMixRanges, 1);

    const cliUrl = "https://cli.example.com/install";
    harness.dispatchPaste(cliUrl);
    const expectedIndentedMixDoc = [
      `Read ${cliUrl} or run \`inline_token\` locally.`,
      "",
      "```ts",
      'const endpoint = "fenced_token";',
      "```",
      "",
      `    ${cliUrl} = true`,
    ].join("\n");
    expect(harness.getValue()).toBe(expectedIndentedMixDoc);

    const indentedCaret0 = proseRange.anchor + cliUrl.length;
    const indentedCaret1 = indentedRange.anchor + (cliUrl.length - "primary_docs".length) + cliUrl.length;
    expect(harness.readSelectionState(sessionId).ranges).toEqual([
      { anchor: indentedCaret0, head: indentedCaret0 },
      { anchor: indentedCaret1, head: indentedCaret1 },
    ]);

    await act(async () => {
      expect(editorHistory(sessionId, "undo")).toBe(true);
    });
    expect(harness.getValue()).toBe(initialDoc);
    expect(harness.readSelectionState(sessionId).ranges).toEqual(indentedMixRanges);

    // 3. Prose selection + empty bare caret (and prose + Link reference) -> syntaxBlocked, raw URL at all cursors, single undo
    const bareCaretPos = initialDoc.length;
    const proseAndEmptyRanges: SelectionSpec[] = [proseRange, { anchor: bareCaretPos, head: bareCaretPos }];
    harness.setSelections(proseAndEmptyRanges, 0);
    harness.dispatchPaste(cliUrl);
    expect(harness.getValue()).toBe(
      [
        `Read ${cliUrl} or run \`inline_token\` locally.`,
        "",
        "```ts",
        'const endpoint = "fenced_token";',
        "```",
        "",
        `    indented_token = true${cliUrl}`,
      ].join("\n"),
    );
    const barePost0 = proseRange.anchor + cliUrl.length;
    const barePost1 = bareCaretPos + (cliUrl.length - "primary_docs".length) + cliUrl.length;
    expect(harness.readSelectionState(sessionId).ranges).toEqual([
      { anchor: barePost0, head: barePost0 },
      { anchor: barePost1, head: barePost1 },
    ]);
    await act(async () => {
      expect(editorHistory(sessionId, "undo")).toBe(true);
    });
    expect(harness.getValue()).toBe(initialDoc);
    expect(harness.readSelectionState(sessionId).ranges).toEqual(proseAndEmptyRanges);
  });

  it("protects YAML frontmatter in multi-selection URL paste while wrapping multiple prose selections after a thematic break", async () => {
    const harness = await createPasteHarness();
    const sessionId = "paste-multi-yaml-url";
    const yamlDoc = [
      "---",
      "title: Architecture RFC",
      "canonical: yaml_source_slot",
      "mirror: yaml_mirror_slot",
      "---",
      "",
      "Review prose_slot_one and prose_slot_two before publishing.",
    ].join("\n");
    await harness.mount(sessionId, yamlDoc);

    // 1. YAML frontmatter selection + prose selection -> raw URL inserted at both, exact offsets, single undo
    const yamlSlot = rangeForSubstring(yamlDoc, "yaml_source_slot");
    const proseSlotOne = rangeForSubstring(yamlDoc, "prose_slot_one");
    const yamlAndProseRanges = [yamlSlot, proseSlotOne];
    harness.setSelections(yamlAndProseRanges, 1);

    const specUrl = "https://specs.example.org/rfc-12";
    const pasteRes = harness.dispatchPaste(specUrl);
    expect(pasteRes.defaultPrevented).toBe(true);
    expect(pasteRes.boundaryCount).toBe(2);

    const expectedYamlAndProseDoc = [
      "---",
      "title: Architecture RFC",
      `canonical: ${specUrl}`,
      "mirror: yaml_mirror_slot",
      "---",
      "",
      `Review ${specUrl} and prose_slot_two before publishing.`,
    ].join("\n");
    expect(harness.getValue()).toBe(expectedYamlAndProseDoc);
    expect(harness.getValue()).not.toContain("[yaml_source_slot]");
    expect(harness.getValue()).not.toContain("[prose_slot_one]");

    const yamlDelta = specUrl.length - "yaml_source_slot".length;
    const expectedYamlCaret = yamlSlot.anchor + specUrl.length;
    const expectedProseCaret = proseSlotOne.anchor + yamlDelta + specUrl.length;
    const expectedRangesAfterYamlMix: SelectionSpec[] = [
      { anchor: expectedYamlCaret, head: expectedYamlCaret },
      { anchor: expectedProseCaret, head: expectedProseCaret },
    ];

    const stateAfterYamlMix = harness.readSelectionState(sessionId);
    expect(stateAfterYamlMix.ranges).toEqual(expectedRangesAfterYamlMix);
    expect(stateAfterYamlMix.mainIndex).toBe(1);
    expect(stateAfterYamlMix.insertionPoint).toEqual({ from: expectedProseCaret, to: expectedProseCaret });
    expect(stateAfterYamlMix.statusText).toBe(
      expectedMultiCursorStatus(expectedYamlAndProseDoc, expectedRangesAfterYamlMix, 1),
    );

    // Single undo restores both YAML frontmatter and prose selections, and redo re-applies cleanly.
    await act(async () => {
      expect(editorHistory(sessionId, "undo")).toBe(true);
    });
    expect(harness.getValue()).toBe(yamlDoc);
    expect(harness.readSelectionState(sessionId).ranges).toEqual(yamlAndProseRanges);
    expect(harness.readSelectionState(sessionId).mainIndex).toBe(1);

    await act(async () => {
      expect(editorHistory(sessionId, "redo")).toBe(true);
    });
    expect(harness.getValue()).toBe(expectedYamlAndProseDoc);
    expect(harness.readSelectionState(sessionId).ranges).toEqual([
      { anchor: yamlSlot.anchor, head: expectedYamlCaret },
      { anchor: proseSlotOne.anchor + yamlDelta, head: expectedProseCaret },
    ]);

    await act(async () => {
      expect(editorHistory(sessionId, "undo")).toBe(true);
    });
    expect(harness.getValue()).toBe(yamlDoc);

    // 2. Dotted `...` YAML frontmatter and unclosed draft YAML frontmatter also block URL link wrapping across multiple selections
    const dottedYamlDoc = [
      "\uFEFF---",
      "upstream: dotted_yaml_slot",
      "...",
      "",
      "Check dotted_prose_slot.",
    ].join("\n");
    await harness.mount("paste-multi-dotted-yaml", dottedYamlDoc);
    const dottedYamlRange = rangeForSubstring(dottedYamlDoc, "dotted_yaml_slot");
    const dottedProseRange = rangeForSubstring(dottedYamlDoc, "dotted_prose_slot");
    harness.setSelections([dottedYamlRange, dottedProseRange], 0);
    harness.dispatchPaste("https://dotted.example.org");
    expect(harness.getValue()).toBe(
      ["\uFEFF---", "upstream: https://dotted.example.org", "...", "", "Check https://dotted.example.org."].join("\n"),
    );
    await act(async () => {
      expect(editorHistory("paste-multi-dotted-yaml", "undo")).toBe(true);
    });
    expect(harness.getValue()).toBe(dottedYamlDoc);

    const draftYamlDoc = [
      "---",
      'title: "unclosed quote',
      "origin: draft_yaml_slot",
      "---",
    ].join("\n");
    await harness.mount("paste-multi-draft-yaml", draftYamlDoc);
    const draftRange0 = rangeForSubstring(draftYamlDoc, "unclosed");
    const draftRange1 = rangeForSubstring(draftYamlDoc, "draft_yaml_slot");
    harness.setSelections([draftRange0, draftRange1], 1);
    harness.dispatchPaste("https://draft.example.org");
    expect(harness.getValue()).toBe(
      ["---", 'title: "https://draft.example.org quote', "origin: https://draft.example.org", "---"].join("\n"),
    );
    await act(async () => {
      expect(editorHistory("paste-multi-draft-yaml", "undo")).toBe(true);
    });
    expect(harness.getValue()).toBe(draftYamlDoc);

    // 3. Contrast: two prose selections after a horizontal thematic break `---` wrap cleanly as Markdown links
    const thematicDoc = ["---", "", "Read first_topic and second_topic."].join("\n");
    await harness.mount("paste-multi-thematic-break", thematicDoc);
    const topic0 = rangeForSubstring(thematicDoc, "first_topic");
    const topic1 = rangeForSubstring(thematicDoc, "second_topic");
    harness.setSelections([topic0, topic1], 1);
    const topicUrl = "https://topics.example.org";
    harness.dispatchPaste(topicUrl);

    const wrapped0 = `[first_topic](${topicUrl})`;
    const wrapped1 = `[second_topic](${topicUrl})`;
    expect(harness.getValue()).toBe(["---", "", `Read ${wrapped0} and ${wrapped1}.`].join("\n"));
    const c0 = topic0.anchor + wrapped0.length;
    const c1 = topic1.anchor + (wrapped0.length - "first_topic".length) + wrapped1.length;
    expect(harness.readSelectionState("paste-multi-thematic-break").ranges).toEqual([
      { anchor: c0, head: c0 },
      { anchor: c1, head: c1 },
    ]);
    await act(async () => {
      expect(editorHistory("paste-multi-thematic-break", "undo")).toBe(true);
    });
    expect(harness.getValue()).toBe(thematicDoc);
  });

  it("repairs math uniformly across multiple prose selections when latexAutofix is enabled and falls back to raw single-undo paste when mixed with protected code or disabled", async () => {
    const harness = await createPasteHarness();
    const formula = String.raw`\frac{a}{b}`;
    const inlineRepaired = String.raw`$\frac{a}{b}$`;

    // 1. latexAutofix=true across multiple inline prose selections -> uniform $...$ repair, exact offsets, single isolated undo
    const proseMathDoc = [
      "First ratio slot_alpha appears here,",
      "and second ratio slot_beta appears there.",
    ].join("\n");
    await harness.mount("paste-multi-math-prose", proseMathDoc, { latexAutofix: true });
    harness.dispatchUserInsert(proseMathDoc.length, "\nAppendix.", 2_000);
    const proseWithAppendix = `${proseMathDoc}\nAppendix.`;

    const slotAlpha = rangeForSubstring(proseWithAppendix, "slot_alpha");
    const slotBeta = rangeForSubstring(proseWithAppendix, "slot_beta");
    harness.setSelections([slotAlpha, slotBeta], 1);

    const proseMathOutcome = harness.dispatchPaste(formula);
    expect(proseMathOutcome.defaultPrevented).toBe(true);
    expect(proseMathOutcome.boundaryCount).toBe(2);

    const expectedProseMathDoc = [
      `First ratio ${inlineRepaired} appears here,`,
      `and second ratio ${inlineRepaired} appears there.`,
      "Appendix.",
    ].join("\n");
    expect(harness.getValue()).toBe(expectedProseMathDoc);

    const alphaCaret = slotAlpha.anchor + inlineRepaired.length;
    const betaCaret = slotBeta.anchor + (inlineRepaired.length - "slot_alpha".length) + inlineRepaired.length;
    const afterProseMathSel = harness.readSelectionState("paste-multi-math-prose");
    expect(afterProseMathSel.ranges).toEqual([
      { anchor: alphaCaret, head: alphaCaret },
      { anchor: betaCaret, head: betaCaret },
    ]);
    expect(afterProseMathSel.mainIndex).toBe(1);
    expect(afterProseMathSel.insertionPoint).toEqual({ from: betaCaret, to: betaCaret });

    await act(async () => {
      expect(editorHistory("paste-multi-math-prose", "undo")).toBe(true);
    });
    expect(harness.getValue()).toBe(proseWithAppendix);
    expect(harness.readSelectionState("paste-multi-math-prose").ranges).toEqual([slotAlpha, slotBeta]);

    await act(async () => {
      expect(editorHistory("paste-multi-math-prose", "redo")).toBe(true);
    });
    expect(harness.getValue()).toBe(expectedProseMathDoc);

    // 2. latexAutofix=true across multiple standalone blank-line cursors -> uniform display $$...$$ repair, exact offsets, single undo
    const standaloneDoc = "Intro\n\n\n\nMiddle\n\n\n\nOutro";
    await harness.mount("paste-multi-math-standalone", standaloneDoc, { latexAutofix: true });
    const blankCursor0 = "Intro\n\n".length;
    const blankCursor1 = "Intro\n\n\n\nMiddle\n\n".length;
    harness.setSelections(
      [
        { anchor: blankCursor0, head: blankCursor0 },
        { anchor: blankCursor1, head: blankCursor1 },
      ],
      0,
    );
    const displayRepaired = `$$\n${formula}\n$$`;
    const standaloneOutcome = harness.dispatchPaste(String.raw`\[${formula}\]`);
    expect(standaloneOutcome.defaultPrevented).toBe(true);
    expect(harness.getValue()).toBe(`Intro\n\n${displayRepaired}\n\nMiddle\n\n${displayRepaired}\n\nOutro`);
    expect(harness.readSelectionState("paste-multi-math-standalone").ranges).toEqual([
      { anchor: blankCursor0 + displayRepaired.length, head: blankCursor0 + displayRepaired.length },
      {
        anchor: blankCursor1 + displayRepaired.length * 2,
        head: blankCursor1 + displayRepaired.length * 2,
      },
    ]);
    await act(async () => {
      expect(editorHistory("paste-multi-math-standalone", "undo")).toBe(true);
    });
    expect(harness.getValue()).toBe(standaloneDoc);

    // 3. latexAutofix=true mixing prose selection with protected fenced code and inline code -> raw paste at all selections, single undo
    const mixedMathCodeDoc = [
      "Compute ratio prose_expr or inspect `inline_expr`.",
      "",
      "```python",
      'raw_tex = "fenced_expr"',
      "```",
    ].join("\n");
    await harness.mount("paste-multi-math-code-guard", mixedMathCodeDoc, { latexAutofix: true });
    harness.dispatchUserInsert(0, "# Sheet\n\n", 1_000);
    const guardedBaseDoc = `# Sheet\n\n${mixedMathCodeDoc}`;

    const proseExpr = rangeForSubstring(guardedBaseDoc, "prose_expr");
    const inlineExpr = rangeForSubstring(guardedBaseDoc, "inline_expr");
    const fencedExpr = rangeForSubstring(guardedBaseDoc, "fenced_expr");
    const guardedRanges = [proseExpr, inlineExpr, fencedExpr];
    harness.setSelections(guardedRanges, 2);

    const guardedOutcome = harness.dispatchPaste(formula);
    // Custom math handler declines (0 history boundaries) so CodeMirror's built-in multi-selection paste inserts raw formula everywhere.
    expect(guardedOutcome.defaultPrevented).toBe(true);
    expect(guardedOutcome.boundaryCount).toBe(0);

    const expectedGuardedDoc = [
      "# Sheet",
      "",
      `Compute ratio ${formula} or inspect \`${formula}\`.`,
      "",
      "```python",
      `raw_tex = "${formula}"`,
      "```",
    ].join("\n");
    expect(harness.getValue()).toBe(expectedGuardedDoc);
    expect(harness.getValue()).not.toContain(`$${formula}$`);

    const d0 = formula.length - "prose_expr".length;
    const d1 = formula.length - "inline_expr".length;
    const gCaret0 = proseExpr.anchor + formula.length;
    const gCaret1 = inlineExpr.anchor + d0 + formula.length;
    const gCaret2 = fencedExpr.anchor + d0 + d1 + formula.length;
    const guardedAfter = harness.readSelectionState("paste-multi-math-code-guard");
    expect(guardedAfter.ranges).toEqual([
      { anchor: gCaret0, head: gCaret0 },
      { anchor: gCaret1, head: gCaret1 },
      { anchor: gCaret2, head: gCaret2 },
    ]);
    expect(guardedAfter.mainIndex).toBe(2);

    // Single undo reverts all 3 raw math insertions without touching the earlier "# Sheet\n\n" insertion.
    await act(async () => {
      expect(editorHistory("paste-multi-math-code-guard", "undo")).toBe(true);
    });
    expect(harness.getValue()).toBe(guardedBaseDoc);
    expect(harness.readSelectionState("paste-multi-math-code-guard").ranges).toEqual(guardedRanges);
    expect(harness.readSelectionState("paste-multi-math-code-guard").mainIndex).toBe(2);

    // 4. latexAutofix=true when standalone line and inline prose disagree on display vs inline delimiters -> raw paste at both, single undo
    const mixedContextMathDoc = "Standalone above:\n\n\n\nInline slot_inline here.";
    await harness.mount("paste-multi-math-disagree", mixedContextMathDoc, { latexAutofix: true });
    const standaloneCaret = "Standalone above:\n\n".length;
    const inlineSlot = rangeForSubstring(mixedContextMathDoc, "slot_inline");
    harness.setSelections([{ anchor: standaloneCaret, head: standaloneCaret }, inlineSlot], 1);
    const disagreeOutcome = harness.dispatchPaste(formula);
    expect(disagreeOutcome.boundaryCount).toBe(0);
    expect(harness.getValue()).toBe(`Standalone above:\n\n${formula}\n\nInline ${formula} here.`);
    const disagreeCaret0 = standaloneCaret + formula.length;
    const disagreeCaret1 = inlineSlot.anchor + formula.length + formula.length;
    expect(harness.readSelectionState("paste-multi-math-disagree").ranges).toEqual([
      { anchor: disagreeCaret0, head: disagreeCaret0 },
      { anchor: disagreeCaret1, head: disagreeCaret1 },
    ]);
    await act(async () => {
      expect(editorHistory("paste-multi-math-disagree", "undo")).toBe(true);
    });
    expect(harness.getValue()).toBe(mixedContextMathDoc);

    // 5. latexAutofix=true with non-math dollar currency and latexAutofix=false (default) -> raw paste with exact offsets and single undo
    await harness.mount("paste-multi-math-currency", proseMathDoc, { latexAutofix: true });
    const currAlpha = rangeForSubstring(proseMathDoc, "slot_alpha");
    const currBeta = rangeForSubstring(proseMathDoc, "slot_beta");
    harness.setSelections([currAlpha, currBeta], 0);
    const currencyText = "$5 to $10";
    expect(harness.dispatchPaste(currencyText).boundaryCount).toBe(0);
    expect(harness.getValue()).toBe(
      [`First ratio ${currencyText} appears here,`, `and second ratio ${currencyText} appears there.`].join("\n"),
    );
    await act(async () => {
      expect(editorHistory("paste-multi-math-currency", "undo")).toBe(true);
    });
    expect(harness.getValue()).toBe(proseMathDoc);

    await harness.mount("paste-multi-math-disabled", proseMathDoc, { latexAutofix: false });
    const rawAlpha = rangeForSubstring(proseMathDoc, "slot_alpha");
    const rawBeta = rangeForSubstring(proseMathDoc, "slot_beta");
    harness.setSelections([rawAlpha, rawBeta], 0);
    const disabledOutcome = harness.dispatchPaste(formula);
    expect(disabledOutcome.defaultPrevented).toBe(true);
    expect(disabledOutcome.boundaryCount).toBe(0);
    expect(harness.getValue()).toBe(
      [`First ratio ${formula} appears here,`, `and second ratio ${formula} appears there.`].join("\n"),
    );
    await act(async () => {
      expect(editorHistory("paste-multi-math-disabled", "undo")).toBe(true);
    });
    expect(harness.getValue()).toBe(proseMathDoc);
    // 6. Selecting entire `inline_code` spans (including backticks) replaces them wholesale with repaired inline math in one undo step
    const wholeInlineCodeDoc = "Replace `old_code_a` and `old_code_b` with math.";
    await harness.mount("paste-multi-math-whole-inline-code", wholeInlineCodeDoc, { latexAutofix: true });
    const wholeCode0 = rangeForSubstring(wholeInlineCodeDoc, "`old_code_a`");
    const wholeCode1 = rangeForSubstring(wholeInlineCodeDoc, "`old_code_b`");
    // Place ranges starting inside or encompassing the full InlineCode node `[node.from, node.to]`
    harness.setSelections([wholeCode0, wholeCode1], 1);
    const wholeCodeOutcome = harness.dispatchPaste(formula);
    expect(wholeCodeOutcome.boundaryCount).toBe(2);
    expect(harness.getValue()).toBe(`Replace ${inlineRepaired} and ${inlineRepaired} with math.`);
    await act(async () => {
      expect(editorHistory("paste-multi-math-whole-inline-code", "undo")).toBe(true);
    });
    expect(harness.getValue()).toBe(wholeInlineCodeDoc);
    expect(harness.readSelectionState("paste-multi-math-whole-inline-code").ranges).toEqual([wholeCode0, wholeCode1]);

    // 7. Pre-prevented paste events leave selections untouched, and file-bearing clipboards skip URL link wrapping
    const cmContent = harness.container.querySelector<HTMLElement>(".cm-content")!;
    const preventedPasteEvent = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(preventedPasteEvent, "clipboardData", {
      value: {
        files: [new File(["img"], "shot.png", { type: "image/png" })],
        getData: (type: string) => (type === "text/plain" ? "https://cdn.example.com/shot.png" : ""),
      },
    });
    preventedPasteEvent.preventDefault();
    act(() => {
      cmContent.dispatchEvent(preventedPasteEvent);
    });
    expect(harness.getValue()).toBe(wholeInlineCodeDoc);
    expect(harness.readSelectionState("paste-multi-math-whole-inline-code").ranges).toEqual([wholeCode0, wholeCode1]);

    // Unprevented clipboard carrying image file skips Editor's custom paste pipeline (0 history boundaries)
    const proseForFileSkip = "Check alpha_word and beta_word.";
    await harness.mount("paste-multi-file-skip", proseForFileSkip);
    harness.setSelections(
      [
        { anchor: 0, head: 0 },
        { anchor: 6, head: 6 },
      ],
      0,
    );
    let fileBoundaries = 0;
    const countBoundary = () => {
      fileBoundaries += 1;
    };
    window.addEventListener("supermd-history-boundary", countBoundary);
    const fileOnlyEvent = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(fileOnlyEvent, "clipboardData", {
      value: {
        files: [new File(["img"], "shot.png", { type: "image/png" })],
        getData: () => "",
      },
    });
    try {
      act(() => {
        harness.container.querySelector<HTMLElement>(".cm-content")!.dispatchEvent(fileOnlyEvent);
      });
    } finally {
      window.removeEventListener("supermd-history-boundary", countBoundary);
    }
    expect(fileBoundaries).toBe(0);
    expect(harness.getValue()).toBe(proseForFileSkip);

    // Empty text/plain at multiple empty carets is a no-op
    await harness.mount("paste-multi-empty-text", proseForFileSkip);
    harness.setSelections(
      [
        { anchor: 0, head: 0 },
        { anchor: 6, head: 6 },
      ],
      1,
    );
    expect(harness.dispatchPaste("").boundaryCount).toBe(0);
    expect(harness.getValue()).toBe(proseForFileSkip);
  });

  it("handles plain-text broadcast and N-line per-selection paste across YAML frontmatter, prose, and fenced code with exact offsets and single undo", async () => {
    const harness = await createPasteHarness();
    const sessionId = "paste-multi-plain-and-multiline";
    const doc = [
      "---",
      "module: yaml_target",
      "---",
      "",
      "Documenting prose_target in detail.",
      "",
      "```rust",
      'const NAME: &str = "code_target";',
      "```",
    ].join("\n");
    await harness.mount(sessionId, doc);

    const yamlRange = rangeForSubstring(doc, "yaml_target");
    const proseRange = rangeForSubstring(doc, "prose_target");
    const codeRange = rangeForSubstring(doc, "code_target");
    const initialRanges = [yamlRange, proseRange, codeRange];

    // 1. Single-line plain text broadcasts identically across YAML, prose, and fenced code in one undoable transaction
    harness.setSelections(initialRanges, 2);
    const sharedToken = "smd_parser_v2";
    const broadcastBatchBefore = harness.changeBatches.length;
    harness.dispatchPaste(sharedToken);
    expect(harness.changeBatches.length - broadcastBatchBefore).toBe(1);

    const expectedBroadcastDoc = [
      "---",
      `module: ${sharedToken}`,
      "---",
      "",
      `Documenting ${sharedToken} in detail.`,
      "",
      "```rust",
      `const NAME: &str = "${sharedToken}";`,
      "```",
    ].join("\n");
    expect(harness.getValue()).toBe(expectedBroadcastDoc);

    const bd0 = sharedToken.length - "yaml_target".length;
    const bd1 = sharedToken.length - "prose_target".length;
    const bCaret0 = yamlRange.anchor + sharedToken.length;
    const bCaret1 = proseRange.anchor + bd0 + sharedToken.length;
    const bCaret2 = codeRange.anchor + bd0 + bd1 + sharedToken.length;
    const broadcastPostRanges: SelectionSpec[] = [
      { anchor: bCaret0, head: bCaret0 },
      { anchor: bCaret1, head: bCaret1 },
      { anchor: bCaret2, head: bCaret2 },
    ];
    const broadcastSel = harness.readSelectionState(sessionId);
    expect(broadcastSel.ranges).toEqual(broadcastPostRanges);
    expect(broadcastSel.mainIndex).toBe(2);
    expect(broadcastSel.statusText).toBe(expectedMultiCursorStatus(expectedBroadcastDoc, broadcastPostRanges, 2));

    // Source undo reverts the broadcast paste in a single transaction and restores all 3 ranges.
    await act(async () => {
      expect(editorHistory(sessionId, "undo")).toBe(true);
    });
    expect(harness.getValue()).toBe(doc);
    expect(harness.readSelectionState(sessionId).ranges).toEqual(initialRanges);
    expect(harness.readSelectionState(sessionId).mainIndex).toBe(2);

    const expectedBroadcastRedoRanges: SelectionSpec[] = [
      { anchor: yamlRange.anchor, head: bCaret0 },
      { anchor: proseRange.anchor + bd0, head: bCaret1 },
      { anchor: codeRange.anchor + bd0 + bd1, head: bCaret2 },
    ];
    await act(async () => {
      expect(editorHistory(sessionId, "redo")).toBe(true);
    });
    expect(harness.getValue()).toBe(expectedBroadcastDoc);
    expect(harness.readSelectionState(sessionId).ranges).toEqual(expectedBroadcastRedoRanges);

    // Host-driven rollback/rollforward via external value prop also restores the latest recorded multi-selection transition cleanly.
    await harness.setExternalValue(sessionId, doc);
    expect(harness.readSelectionState(sessionId).ranges).toEqual(initialRanges);
    expect(harness.readSelectionState(sessionId).mainIndex).toBe(2);

    await harness.setExternalValue(sessionId, expectedBroadcastDoc);
    expect(harness.readSelectionState(sessionId).ranges).toEqual(expectedBroadcastRedoRanges);
    expect(harness.readSelectionState(sessionId).mainIndex).toBe(2);

    // Reset clean session before part 2 (3-line per-selection paste).
    const byLineSessionId = "paste-multi-byline";
    await harness.mount(byLineSessionId, doc);

    // 2. 3-line clipboard text into 3 selections distributes line i to selection i across YAML, prose, and fenced code
    const line0 = "frontmatter_mod";
    const line1 = "inline prose phrase";
    const line2 = "rust_ident";
    harness.setSelections(initialRanges, 1);
    harness.dispatchPaste(`${line0}\n${line1}\n${line2}`);

    const expectedByLineDoc = [
      "---",
      `module: ${line0}`,
      "---",
      "",
      `Documenting ${line1} in detail.`,
      "",
      "```rust",
      `const NAME: &str = "${line2}";`,
      "```",
    ].join("\n");
    expect(harness.getValue()).toBe(expectedByLineDoc);

    const ld0 = line0.length - "yaml_target".length;
    const ld1 = line1.length - "prose_target".length;
    const lCaret0 = yamlRange.anchor + line0.length;
    const lCaret1 = proseRange.anchor + ld0 + line1.length;
    const lCaret2 = codeRange.anchor + ld0 + ld1 + line2.length;
    const byLinePostRanges: SelectionSpec[] = [
      { anchor: lCaret0, head: lCaret0 },
      { anchor: lCaret1, head: lCaret1 },
      { anchor: lCaret2, head: lCaret2 },
    ];
    const byLineSel = harness.readSelectionState(byLineSessionId);
    expect(byLineSel.ranges).toEqual(byLinePostRanges);
    expect(byLineSel.mainIndex).toBe(1);
    expect(byLineSel.insertionPoint).toEqual({ from: lCaret1, to: lCaret1 });

    // Single undo transaction reverts all 3 distributed lines at once and restores original selections.
    await act(async () => {
      expect(editorHistory(byLineSessionId, "undo")).toBe(true);
    });
    expect(harness.getValue()).toBe(doc);
    expect(harness.readSelectionState(byLineSessionId).ranges).toEqual(initialRanges);
    expect(harness.readSelectionState(byLineSessionId).mainIndex).toBe(1);

    await act(async () => {
      expect(editorHistory(byLineSessionId, "redo")).toBe(true);
    });
    expect(harness.getValue()).toBe(expectedByLineDoc);
    expect(harness.readSelectionState(byLineSessionId).ranges).toEqual([
      { anchor: yamlRange.anchor, head: lCaret0 },
      { anchor: proseRange.anchor + ld0, head: lCaret1 },
      { anchor: codeRange.anchor + ld0 + ld1, head: lCaret2 },
    ]);
  });
});
