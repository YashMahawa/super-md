// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Editor, {
  cachedEditorHistory,
  editorFindRange,
  editorHistory,
  editorScrollTop,
  editorSelectedText,
  editorViewContext,
  exportEditorSession,
  formatEditorSession,
  importEditorSession,
  type PortableEditorSession,
} from "./Editor";
import { setTypewriterScroll } from "../typewriterScroll";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect ??= () => new DOMRect(0, 0, 0, 0);

function buildLargeMarkdown(targetLength: number, label: string): string {
  const prefix = `# ${label}\n\nFocus token ${label} in opening paragraph.\n\n\`\`\`\n`;
  const suffix = "\n```";
  if (targetLength <= prefix.length + suffix.length) return prefix.slice(0, targetLength);
  const bodyBudget = targetLength - prefix.length - suffix.length;
  const line = `${"x".repeat(8_191)}\n`;
  const fullLines = Math.floor(bodyBudget / line.length);
  const remainder = bodyBudget % line.length;
  return prefix + line.repeat(fullLines) + (remainder > 0 ? "x".repeat(remainder) : "") + suffix;
}

describe("Source editor warm session restoration, cache eviction, and portable session limits", () => {
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

  async function createWorkspaceHarness() {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    hostContainer = container;
    hostRoot = root;

    let activeState: { sessionId: string; value: string; dark?: boolean; focusMode?: boolean } | null = null;
    let applyState!: (next: { sessionId: string; value: string; dark?: boolean; focusMode?: boolean } | null) => void;

    function Workspace() {
      const [current, setCurrent] = useState<{
        sessionId: string;
        value: string;
        dark?: boolean;
        focusMode?: boolean;
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
          onChange={(nextValue) => {
            setCurrent((prev) => {
              if (!prev || prev.sessionId !== current.sessionId) return prev;
              const updated = { ...prev, value: nextValue };
              activeState = updated;
              return updated;
            });
          }}
          dark={current.dark ?? false}
          focusMode={current.focusMode ?? false}
        />
      );
    }

    await act(async () => {
      root.render(<Workspace />);
    });

    return {
      container,
      mount: async (sessionId: string, value: string, options?: { dark?: boolean; focusMode?: boolean }) => {
        await act(async () => {
          applyState({ sessionId, value, ...options });
        });
      },
      unmountEditor: async () => {
        await act(async () => {
          applyState(null);
        });
      },
      getValue: () => activeState?.value ?? "",
    };
  }

  it("restores warm session document, selection, scroll offset, line wrapping, and undo/redo history after remount", async () => {
    const harness = await createWorkspaceHarness();
    const sessionId = "warm-remount-primary";
    const initialDoc = "# Warm Session\n\nAlpha beta gamma delta.\nSecond line for selection.";
    await harness.mount(sessionId, initialDoc);

    const alphaStart = initialDoc.indexOf("beta");
    act(() => {
      editorFindRange(sessionId, alphaStart, alphaStart + "beta".length);
      expect(formatEditorSession(sessionId, "bold")).toBe(true);
    });
    const editedDoc = "# Warm Session\n\nAlpha **beta** gamma delta.\nSecond line for selection.";
    expect(harness.getValue()).toBe(editedDoc);
    expect(editorSelectedText(sessionId)).toBe("beta");

    const phrase = "line for selection";
    const selFrom = editedDoc.indexOf(phrase);
    const selTo = selFrom + phrase.length;
    act(() => {
      editorFindRange(sessionId, selFrom, selTo);
    });
    expect(editorSelectedText(sessionId)).toBe(phrase);
    expect(editorViewContext(sessionId)?.selectionText).toBe(phrase);
    expect(harness.container.querySelector(".source-position")?.textContent).toBe(
      `Ln 4, Col ${2 + "Second ".length + phrase.length - 1} · ${phrase.length} selected`,
    );

    const wrapButton = harness.container.querySelector<HTMLButtonElement>('button[title="Toggle line wrapping"]')!;
    expect(wrapButton.getAttribute("aria-pressed")).toBe("true");
    await act(async () => {
      wrapButton.click();
    });
    expect(wrapButton.getAttribute("aria-pressed")).toBe("false");

    editorViewContext(sessionId)!.scroller.scrollTop = 164;
    expect(editorScrollTop(sessionId)).toBe(164);

    await harness.unmountEditor();

    // While unmounted, visible-only queries return empty while warm-session APIs retain state.
    expect(editorSelectedText(sessionId)).toBeNull();
    expect(editorViewContext(sessionId)).toBeUndefined();
    expect(editorScrollTop(sessionId)).toBe(164);
    expect(exportEditorSession(sessionId)).toMatchObject({ top: 164, wrapped: false });

    // Remount with the same authoritative document text and verify warm restoration.
    await harness.mount(sessionId, editedDoc);
    expect(harness.container.querySelector(".cm-content")?.textContent).toContain("Alpha **beta** gamma delta.");
    expect(editorSelectedText(sessionId)).toBe(phrase);
    expect(editorViewContext(sessionId)?.selectionText).toBe(phrase);
    expect(harness.container.querySelector(".source-position")?.textContent).toContain(`${phrase.length} selected`);
    expect(editorScrollTop(sessionId)).toBe(164);
    expect(
      harness.container
        .querySelector<HTMLButtonElement>('button[title="Toggle line wrapping"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("false");

    // Warm EditorState preserves pre-unmount undo/redo history across remount.
    await act(async () => {
      expect(editorHistory(sessionId, "undo")).toBe(true);
    });
    expect(harness.getValue()).toBe(initialDoc);
    expect(editorSelectedText(sessionId)).toBe("beta");

    await act(async () => {
      expect(editorHistory(sessionId, "redo")).toBe(true);
    });
    expect(harness.getValue()).toBe(editedDoc);
    expect(editorSelectedText(sessionId)).toBe("beta");
  }, 15_000);

  it("supports cachedEditorHistory while unmounted and discards stale warm state when external value diverges", async () => {
    const harness = await createWorkspaceHarness();
    const sessionId = "warm-unmounted-history-and-divergence";
    const baseDoc = "Heading line\n\nOriginal paragraph.";
    await harness.mount(sessionId, baseDoc);

    const target = "Original";
    const from = baseDoc.indexOf(target);
    act(() => {
      editorFindRange(sessionId, from, from + target.length);
      expect(formatEditorSession(sessionId, "italic")).toBe(true);
    });
    const italicDoc = "Heading line\n\n*Original* paragraph.";
    expect(harness.getValue()).toBe(italicDoc);
    await harness.unmountEditor();

    // Cached history mutates warm state only when the caller passes matching authoritative content.
    expect(cachedEditorHistory(sessionId, "undo", "mismatched content")).toBeUndefined();
    expect(cachedEditorHistory(sessionId, "undo", italicDoc)).toBe(baseDoc);

    await harness.mount(sessionId, baseDoc);
    expect(harness.getValue()).toBe(baseDoc);
    await act(async () => {
      expect(editorHistory(sessionId, "redo")).toBe(true);
    });
    expect(harness.getValue()).toBe(italicDoc);
    await harness.unmountEditor();

    // Remounting with externally replaced text must not resurrect the stale warm document or undo stack.
    const externalDoc = "# Replaced Externally\n\nFresh content from disk.";
    await harness.mount(sessionId, externalDoc);
    expect(editorViewContext(sessionId)?.visibleText).toBe(externalDoc);
    expect(editorSelectedText(sessionId)).toBeNull();
    expect(harness.container.querySelector(".source-position")?.textContent).toBe("Ln 1, Col 1");
    expect(editorHistory(sessionId, "undo")).toBe(false);
  }, 15_000);

  it("round-trips portable sessions through exportEditorSession and importEditorSession", async () => {
    const harness = await createWorkspaceHarness();
    const sourceId = "portable-source";
    const targetId = "portable-target";
    const initial = "# Portable Session\n\nCarry undo, selection, scroll, wrapping, and typewriter.";
    await harness.mount(sourceId, initial);

    const word = "selection";
    const wordStart = initial.indexOf(word);
    act(() => {
      editorFindRange(sourceId, wordStart, wordStart + word.length);
      expect(formatEditorSession(sourceId, "bold")).toBe(true);
    });
    const edited = harness.getValue();
    expect(edited).toContain("**selection**");

    const selectPhrase = "wrapping, and typewriter";
    const selectStart = edited.indexOf(selectPhrase);
    act(() => {
      editorFindRange(sourceId, selectStart, selectStart + selectPhrase.length);
    });
    await act(async () => {
      harness.container.querySelector<HTMLButtonElement>('button[title="Toggle line wrapping"]')!.click();
    });
    editorViewContext(sourceId)!.scroller.scrollTop = 195;

    const mountedExport = exportEditorSession(sourceId);
    expect(mountedExport).toBeDefined();
    expect(mountedExport).toMatchObject({ top: 195, typewriter: false });
    await harness.unmountEditor();

    const portable = exportEditorSession(sourceId);
    expect(portable).toBeDefined();
    expect(portable).toMatchObject({ top: 195, wrapped: false, typewriter: false });
    expect(JSON.stringify(portable).length).toBeLessThanOrEqual(2_000_000);

    importEditorSession(targetId, portable);
    await harness.mount(targetId, edited);
    expect(harness.getValue()).toBe(edited);
    expect(editorSelectedText(targetId)).toBe(selectPhrase);
    expect(harness.container.querySelector(".source-position")?.textContent).toContain(`${selectPhrase.length} selected`);
    expect(editorScrollTop(targetId)).toBe(195);
    expect(
      harness.container
        .querySelector<HTMLButtonElement>('button[title="Toggle line wrapping"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("false");

    await act(async () => {
      expect(editorHistory(targetId, "undo")).toBe(true);
    });
    expect(harness.getValue()).toBe(initial);
    await act(async () => {
      expect(editorHistory(targetId, "redo")).toBe(true);
    });
    expect(harness.getValue()).toBe(edited);
    await harness.unmountEditor();

    // Typewriter state also restores from a portable session when imported into a fresh session.
    importEditorSession("portable-typewriter-target", { ...portable!, top: 0, typewriter: true });
    await harness.mount("portable-typewriter-target", edited);
    expect(
      harness.container
        .querySelector<HTMLButtonElement>('button[title="Toggle typewriter scrolling (Ctrl+Alt+T)"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
    await harness.unmountEditor();

    // Imported portable session whose document diverges from authoritative value falls back safely to value.
    const divergedDoc = "# Diverged Document\n\nAuthoritative text wins.";
    importEditorSession("portable-diverged-target", portable);
    await harness.mount("portable-diverged-target", divergedDoc);
    expect(editorViewContext("portable-diverged-target")?.visibleText).toBe(divergedDoc);
    expect(editorSelectedText("portable-diverged-target")).toBeNull();
  }, 15_000);

  it("enforces the 2,000,000-character portable session size limit on export and import and bounds queued incoming sessions", async () => {
    const harness = await createWorkspaceHarness();

    // Under the 2,000,000 serialized JSON character limit, exportEditorSession succeeds.
    const underLimitDoc = buildLargeMarkdown(1_900_000, "portable-under-limit");
    await harness.mount("portable-under", underLimitDoc);
    const underExport = exportEditorSession("portable-under");
    expect(underExport).toBeDefined();
    expect(JSON.stringify(underExport).length).toBeLessThanOrEqual(2_000_000);
    await harness.unmountEditor();

    // Over the 2,000,000 serialized JSON character limit, exportEditorSession returns undefined
    // (both mounted and warm-cached), while the in-memory warm session (<= 4,000,000 chars) still remounts cleanly.
    const overLimitDoc = buildLargeMarkdown(2_050_000, "portable-over-limit");
    await harness.mount("portable-over", overLimitDoc);
    const overToken = "Focus token portable-over-limit";
    const overTokenStart = overLimitDoc.indexOf(overToken);
    act(() => {
      editorFindRange("portable-over", overTokenStart, overTokenStart + overToken.length);
    });
    editorViewContext("portable-over")!.scroller.scrollTop = 275;
    expect(exportEditorSession("portable-over")).toBeUndefined();
    await harness.unmountEditor();
    expect(exportEditorSession("portable-over")).toBeUndefined();
    expect(editorScrollTop("portable-over")).toBe(275);

    await harness.mount("portable-over", overLimitDoc);
    expect(editorSelectedText("portable-over")).toBe(overToken);
    expect(editorScrollTop("portable-over")).toBe(275);
    await harness.unmountEditor();

    // importEditorSession rejects > 2,000,000-character payloads without clobbering an existing warm session
    // and without blocking fresh mounts.
    const smallNote = "# Small Note\n\nKeep authoritative text intact.";
    await harness.mount("portable-seed-small", smallNote);
    const smallExport = exportEditorSession("portable-seed-small")!;
    await harness.unmountEditor();

    const oversizedPayload: PortableEditorSession = {
      state: {
        ...(smallExport.state as Record<string, unknown>),
        oversizedPadding: "z".repeat(2_000_050),
      },
      top: 999,
      wrapped: false,
      typewriter: true,
    };
    expect(JSON.stringify(oversizedPayload).length).toBeGreaterThan(2_000_000);

    importEditorSession("portable-over", oversizedPayload);
    expect(editorScrollTop("portable-over")).toBe(275);

    const freshRejectedId = "portable-oversized-rejected";
    importEditorSession(freshRejectedId, oversizedPayload);
    await harness.mount(freshRejectedId, smallNote);
    expect(harness.getValue()).toBe(smallNote);
    expect(editorSelectedText(freshRejectedId)).toBeNull();
    expect(harness.container.querySelector(".source-position")?.textContent).toBe("Ln 1, Col 1");
    expect(editorScrollTop(freshRejectedId)).toBe(0);
    expect(
      harness.container
        .querySelector<HTMLButtonElement>('button[title="Toggle line wrapping"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
    await harness.unmountEditor();

    // Queued incoming portable sessions also evict oldest entries once retained serialized bytes exceed 4,000,000.
    importEditorSession("incoming-bound-a", { state: underExport!.state, top: 111, wrapped: false });
    importEditorSession("incoming-bound-b", { state: underExport!.state, top: 222, wrapped: false });
    // 1.9M + 1.9M + 1.9M = 5.7M > 4.0M: incoming-bound-a is evicted while incoming-bound-b and incoming-bound-c remain queued.
    importEditorSession("incoming-bound-c", { state: underExport!.state, top: 333, wrapped: false });

    await harness.mount("incoming-bound-a", underLimitDoc);
    expect(editorScrollTop("incoming-bound-a")).toBe(0);
    expect(
      harness.container
        .querySelector<HTMLButtonElement>('button[title="Toggle line wrapping"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("true");

    await harness.mount("incoming-bound-c", underLimitDoc);
    expect(editorScrollTop("incoming-bound-c")).toBe(333);
    expect(
      harness.container
        .querySelector<HTMLButtonElement>('button[title="Toggle line wrapping"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("false");
    await harness.unmountEditor();

    // Queued incoming portable sessions also evict oldest entries past the 40-session count bound.
    for (let i = 0; i < 41; i++) {
      importEditorSession(`incoming-count-${i}`, { state: smallExport.state, top: 100 + i, wrapped: false });
    }
    await harness.mount("incoming-count-0", smallNote);
    expect(editorScrollTop("incoming-count-0")).toBe(0);
    await harness.mount("incoming-count-40", smallNote);
    expect(editorScrollTop("incoming-count-40")).toBe(140);
  }, 20_000);

  it("evicts older warm sessions when retained text exceeds 4,000,000 characters while keeping at least the active most recent session", async () => {
    const harness = await createWorkspaceHarness();
    const docA = buildLargeMarkdown(1_600_000, "volume-alpha");
    const docB = buildLargeMarkdown(1_600_000, "volume-beta");
    const docC = buildLargeMarkdown(1_200_000, "volume-gamma");

    const stageWarmSession = async (id: string, doc: string, token: string, top: number) => {
      await harness.mount(id, doc);
      const start = doc.indexOf(token);
      act(() => {
        editorFindRange(id, start, start + token.length);
      });
      editorViewContext(id)!.scroller.scrollTop = top;
      await harness.unmountEditor();
    };

    await stageWarmSession("bound-vol-a", docA, "Focus token volume-alpha", 120);
    await stageWarmSession("bound-vol-b", docB, "Focus token volume-beta", 240);

    // 1.6M + 1.6M = 3.2M <= 4.0M: both large warm sessions remain cached.
    expect(editorScrollTop("bound-vol-a")).toBe(120);
    expect(editorScrollTop("bound-vol-b")).toBe(240);

    // Adding 1.2M pushes retained characters to 4.4M > 4.0M, evicting bound-vol-a while keeping bound-vol-b and bound-vol-c.
    await stageWarmSession("bound-vol-c", docC, "Focus token volume-gamma", 360);

    expect(editorScrollTop("bound-vol-a")).toBeUndefined();
    expect(editorScrollTop("bound-vol-b")).toBe(240);
    expect(editorScrollTop("bound-vol-c")).toBe(360);

    // Kept warm session B restores selection and scrollTop on remount.
    await harness.mount("bound-vol-b", docB);
    expect(editorSelectedText("bound-vol-b")).toBe("Focus token volume-beta");
    expect(editorScrollTop("bound-vol-b")).toBe(240);
    await harness.unmountEditor();

    // Evicted session A mounts cleanly from its authoritative document value with default selection and scrollTop.
    await harness.mount("bound-vol-a", docA);
    expect(editorViewContext("bound-vol-a")?.visibleText.startsWith("# volume-alpha")).toBe(true);
    expect(editorSelectedText("bound-vol-a")).toBeNull();
    expect(editorScrollTop("bound-vol-a")).toBe(0);
    await harness.unmountEditor();

    // Even when a single note exceeds 4,000,000 characters, sessions.size <= 1 retains that most recent warm session.
    const singleHugeDoc = buildLargeMarkdown(4_050_000, "volume-single-huge");
    await stageWarmSession("bound-vol-huge", singleHugeDoc, "Focus token volume-single-huge", 512);
    expect(editorScrollTop("bound-vol-a")).toBeUndefined();
    expect(editorScrollTop("bound-vol-b")).toBeUndefined();
    expect(editorScrollTop("bound-vol-c")).toBeUndefined();
    expect(editorScrollTop("bound-vol-huge")).toBe(512);

    await harness.mount("bound-vol-huge", singleHugeDoc);
    expect(editorSelectedText("bound-vol-huge")).toBe("Focus token volume-single-huge");
    expect(editorScrollTop("bound-vol-huge")).toBe(512);
    await harness.unmountEditor();
  }, 20_000);

  it("evicts the oldest warm session past the 40-session cache bound while keeping revisited and newer sessions warm", async () => {
    const harness = await createWorkspaceHarness();
    const docs = new Map<string, { initial: string; edited: string; selected: string; top: number; wrapped: boolean }>();

    for (let i = 0; i < 40; i++) {
      const id = `bound-count-${i}`;
      const token = `item_${i}`;
      const initial = `# Note ${i}\n\nSelect ${token} and keep warm.`;
      await harness.mount(id, initial);
      const keepWord = "keep warm";

      if (i < 2) {
        const tokenOffset = initial.indexOf(token);
        act(() => {
          editorFindRange(id, tokenOffset, tokenOffset + token.length);
          expect(formatEditorSession(id, "inline_code")).toBe(true);
        });
        const edited = harness.getValue();
        const keepOffset = edited.indexOf(keepWord);
        act(() => {
          editorFindRange(id, keepOffset, keepOffset + keepWord.length);
        });
        await act(async () => {
          harness.container.querySelector<HTMLButtonElement>('button[title="Toggle line wrapping"]')!.click();
        });
        const top = 40 + i;
        editorViewContext(id)!.scroller.scrollTop = top;
        docs.set(id, { initial, edited, selected: keepWord, top, wrapped: false });
      } else {
        if (i === 2 || i === 39) {
          const keepOffset = initial.indexOf(keepWord);
          act(() => {
            editorFindRange(id, keepOffset, keepOffset + keepWord.length);
          });
        }
        const top = 40 + i;
        editorViewContext(id)!.scroller.scrollTop = top;
        docs.set(id, { initial, edited: initial, selected: keepWord, top, wrapped: true });
      }
    }
    await harness.unmountEditor();

    // All 40 sessions fit within the 40-tab cache bound.
    expect(exportEditorSession("bound-count-0")).toMatchObject({ top: 40, wrapped: false });
    expect(exportEditorSession("bound-count-1")).toMatchObject({ top: 41, wrapped: false });
    expect(exportEditorSession("bound-count-39")).toMatchObject({ top: 79, wrapped: true });

    // Remounting and unmounting session 0 refreshes its recency so session 1 becomes the oldest warm entry.
    await harness.mount("bound-count-0", docs.get("bound-count-0")!.edited);
    expect(editorSelectedText("bound-count-0")).toBe("keep warm");
    await harness.unmountEditor();

    // Unmounting a 41st distinct session evicts bound-count-1 while retaining bound-count-0 and bound-count-40.
    await harness.mount("bound-count-40", "# Note 40\n\nForty-first session.");
    const fortyFirstTarget = "Forty-first";
    const fortyFirstStart = "# Note 40\n\n".length;
    act(() => {
      editorFindRange("bound-count-40", fortyFirstStart, fortyFirstStart + fortyFirstTarget.length);
    });
    editorViewContext("bound-count-40")!.scroller.scrollTop = 210;
    await harness.unmountEditor();

    expect(exportEditorSession("bound-count-1")).toBeUndefined();
    expect(editorScrollTop("bound-count-1")).toBeUndefined();
    expect(cachedEditorHistory("bound-count-1", "undo", docs.get("bound-count-1")!.edited)).toBeUndefined();

    expect(exportEditorSession("bound-count-0")).toMatchObject({ top: 40, wrapped: false });
    expect(exportEditorSession("bound-count-2")).toMatchObject({ top: 42, wrapped: true });
    expect(exportEditorSession("bound-count-40")).toMatchObject({ top: 210, wrapped: true });

    // Remounting the evicted session preserves authoritative text while resetting transient view state.
    const evictedMeta = docs.get("bound-count-1")!;
    await harness.mount("bound-count-1", evictedMeta.edited);
    expect(editorViewContext("bound-count-1")?.visibleText).toBe(evictedMeta.edited);
    expect(editorSelectedText("bound-count-1")).toBeNull();
    expect(harness.container.querySelector(".source-position")?.textContent).toBe("Ln 1, Col 1");
    expect(editorScrollTop("bound-count-1")).toBe(0);
    expect(
      harness.container
        .querySelector<HTMLButtonElement>('button[title="Toggle line wrapping"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
    expect(editorHistory("bound-count-1", "undo")).toBe(false);

    // Switching to the kept revisited session restores its selection, scrollTop, wrapping, and undo history.
    const keptMeta = docs.get("bound-count-0")!;
    await harness.mount("bound-count-0", keptMeta.edited);
    expect(editorSelectedText("bound-count-0")).toBe(keptMeta.selected);
    expect(editorScrollTop("bound-count-0")).toBe(keptMeta.top);
    expect(
      harness.container
        .querySelector<HTMLButtonElement>('button[title="Toggle line wrapping"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("false");
    await act(async () => {
      expect(editorHistory("bound-count-0", "undo")).toBe(true);
    });
    expect(harness.getValue()).toBe(keptMeta.initial);
  }, 30_000);
});
