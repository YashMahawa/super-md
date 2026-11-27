// @vitest-environment jsdom
import { act, useEffect, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { consumePendingEditorAnchor, registerEditorAnchorAdapter } from "./sourceAnchor";

const { native, editorAnchors, revealedOffsets, mockViewContext, appliedSearchSeeds, readerTree } = vi.hoisted(() => {
  if (typeof document !== "undefined") {
    document.body.innerHTML = '<div id="root"></div>';
  }
  return {
    native: vi.fn(async (_command: string, _args?: unknown): Promise<unknown> => true),
    editorAnchors: new Map<string, { offset: number; caretOffset?: number; top?: number } | null>(),
    revealedOffsets: [] as Array<{ id: string; offset: number; options?: Record<string, unknown> }>,
    mockViewContext: new Map<string, { scroller: HTMLElement; visibleStart: number; visibleEnd: number }>(),
    appliedSearchSeeds: [] as Array<{ sourceSession?: string; seed: unknown; content: string }>,
    readerTree: {
      element: null as ReactNode,
      mountRoot: null as ((container: Element | DocumentFragment) => Root) | null,
    },
  };
});

vi.mock("react-dom/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-dom/client")>();
  readerTree.mountRoot = actual.createRoot;
  return {
    ...actual,
    createRoot: () => ({
      render: (node: ReactNode) => {
        readerTree.element = node;
      },
      unmount: () => {},
    }),
  };
});
vi.mock("./nativeBridge", () => ({ invoke: native }));
vi.mock("./components/Editor", () => ({
  default: ({ sessionId }: { sessionId: string }) => {
    useEffect(() => {
      const applyAnchor = (anchor: { offset: number; caretOffset?: number; top?: number }) => {
        editorAnchors.set(sessionId, anchor);
        revealedOffsets.push({ id: sessionId, offset: anchor.offset, options: anchor as unknown as Record<string, unknown> });
      };
      registerEditorAnchorAdapter(sessionId, {
        readingOffset: () => editorAnchors.get(sessionId)?.offset ?? 0,
        caretOffset: () => editorAnchors.get(sessionId)?.caretOffset,
        scrollTop: () => editorAnchors.get(sessionId)?.top ?? 0,
        applyAnchor,
      });
      const pending = consumePendingEditorAnchor(sessionId);
      if (pending) applyAnchor(pending);
      return () => registerEditorAnchorAdapter(sessionId, null, editorAnchors.get(sessionId)?.top);
    }, [sessionId]);
    return <div className="mock-editor" data-doc-id={sessionId} data-primed-offset={editorAnchors.get(sessionId)?.offset ?? ""} />;
  },
  editorReadingOffset: (id: string) => editorAnchors.get(id)?.offset ?? 0,
  editorSelectedText: () => null,
  editorViewContext: (id: string) => mockViewContext.get(id) ?? ({ editorTop: 240 } as any),
  editorHistory: () => false,
  exportEditorSession: () => undefined,
  importEditorSession: () => {},
  cachedEditorHistory: () => undefined,
  primeEditorAnchor: (id: string, anchor: { offset: number; caretOffset?: number; top?: number } | null) => {
    editorAnchors.set(id, anchor);
  },
  revealEditorOffset: (id: string, offset: number, options?: Record<string, unknown>) => {
    revealedOffsets.push({ id, offset, options });
    return true;
  },
  formatEditorSession: () => false,
}));
vi.mock("./components/LiveEditor", () => ({
  default: ({ markdown }: { markdown: string }) => (
    <div className="live-document">
      <p data-source-start="0" data-source-end={String(markdown.length)}>
        {markdown}
      </p>
    </div>
  ),
  formatActiveLiveBlock: () => false,
  replayActiveLiveBlockHistory: () => false,
}));
vi.mock("./components/MarkdownPreview", () => ({
  default: ({ markdown }: { markdown: string }) => (
    <div className="markdown-body">
      <p data-source-start="0" data-source-end={String(markdown.length)}>
        {markdown}
      </p>
    </div>
  ),
}));
vi.mock("./components/MediaTools", () => ({ default: () => null }));
vi.mock("./components/ImageViewer", () => ({ default: () => null }));
vi.mock("./components/MathRepairPanel", () => ({ default: () => null }));
vi.mock("./components/ThemeGuideDialog", () => ({ default: () => null }));
vi.mock("./components/ReadingSearch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./components/ReadingSearch")>();
  return {
    ...actual,
    default: ({
      content,
      sourceSession,
      seed,
    }: {
      content: string;
      sourceSession?: string;
      seed?: { query: string; caseSensitive?: boolean; sourceStart?: number; sourceEnd?: number; matchText?: string; nonce: number } | null;
    }) => {
      useEffect(() => {
        if (!seed) return;
        appliedSearchSeeds.push({ sourceSession, seed, content });
        if (
          typeof seed.sourceStart === "number" &&
          typeof seed.sourceEnd === "number" &&
          actual.isValidSeedOccurrence(content, { from: seed.sourceStart, to: seed.sourceEnd }, seed.query, Boolean(seed.caseSensitive), seed.matchText) &&
          sourceSession
        ) {
          editorAnchors.set(sourceSession, { offset: seed.sourceStart, caretOffset: seed.sourceEnd, top: 1420 });
          revealedOffsets.push({ id: sourceSession, offset: seed.sourceStart, options: { fromSeed: true } });
        }
      }, [seed?.nonce, sourceSession, content]);
      return <div className="reading-search" data-seed-query={seed?.query ?? ""} />;
    },
  };
});

import "./androidReader";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
class ResizeObserverMock {
  observe() {}
  disconnect() {}
}
Object.assign(globalThis, { ResizeObserver: ResizeObserverMock });

let root: Root | null = null;

const basePayload = {
  dark: false,
  fullscreen: false,
  font: "Manrope",
  size: 18,
  motion: false,
  colors: {},
};

function currentAppliedScale(): string {
  return (
    document.querySelector<HTMLElement>(".document-page")?.dataset.scale ||
    document.querySelector<HTMLElement>(".android-source")?.style.getPropertyValue("--workspace-scale") ||
    ""
  );
}

async function mountReader() {
  const host = document.createElement("div");
  document.body.append(host);
  root = readerTree.mountRoot!(host);
  await act(async () => {
    root?.render(readerTree.element);
  });
}

describe("nativeReader per-note mode and zoom across tab switches", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    native.mockClear();
    native.mockImplementation(async () => true);
    editorAnchors.clear();
    revealedOffsets.length = 0;
    mockViewContext.clear();
    appliedSearchSeeds.length = 0;
    document.body.innerHTML = "";
    localStorage.clear();
  });

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = null;
    vi.useRealTimers();
    document.body.innerHTML = "";
    localStorage.clear();
  });

  it("applies distinct mode and zoom per note (including unsaved drafts) and configured defaults for new notes", async () => {
    await mountReader();

    // Load saved Note A in reader mode at 165% zoom.
    await act(async () => {
      window.supermdLoad?.({
        ...basePayload,
        id: "saved-note-a",
        path: "/notes/a.md",
        content: "# Saved Note A\n\nAlpha content.",
        mode: "reader",
        zoom: 165,
      });
    });
    expect(document.querySelector(".markdown-body")).not.toBeNull();
    expect(document.querySelector(".mock-editor")).toBeNull();
    expect(currentAppliedScale()).toBe("1.65");

    // Switch to unsaved Draft B (path === id) in editor mode at 135% zoom.
    await act(async () => {
      window.supermdLoad?.({
        ...basePayload,
        id: "unsaved-draft-b",
        path: "unsaved-draft-b",
        content: "# Draft B\n\nUnsaved beta draft.",
        mode: "editor",
        zoom: 135,
      });
    });
    expect(document.querySelector(".mock-editor")?.getAttribute("data-doc-id")).toBe("unsaved-draft-b");
    expect(document.querySelector(".markdown-body")).toBeNull();
    expect(currentAppliedScale()).toBe("1.35");

    // Switch to a brand-new Note C using configured defaults (live mode at 110% zoom).
    await act(async () => {
      window.supermdLoad?.({
        ...basePayload,
        id: "new-note-c",
        path: "new-note-c",
        content: "",
        mode: "live",
        zoom: 110,
      });
    });
    expect(document.querySelector(".live-document")).not.toBeNull();
    expect(currentAppliedScale()).toBe("1.1");

    // Switch back to saved Note A -> restores reader mode and 165% zoom.
    await act(async () => {
      window.supermdLoad?.({
        ...basePayload,
        id: "saved-note-a",
        path: "/notes/a.md",
        content: "# Saved Note A\n\nAlpha content.",
        mode: "reader",
        zoom: 165,
      });
    });
    expect(document.querySelector(".markdown-body")).not.toBeNull();
    expect(currentAppliedScale()).toBe("1.65");
  });

  it("flushes pending gesture zoom with the outgoing note id on immediate tab switch without clobbering the incoming tab", async () => {
    await mountReader();

    await act(async () => {
      window.supermdLoad?.({
        ...basePayload,
        id: "draft-a",
        path: "draft-a",
        content: "# Draft A",
        mode: "live",
        zoom: 100,
      });
    });
    expect(currentAppliedScale()).toBe("1");

    // Trigger gesture zoom on Draft A (100 * 1.4 = 140), then switch tabs BEFORE the 220ms debounce fires.
    await act(async () => {
      window.supermdZoomBy?.(1.4, { x: 200, y: 200 });
    });
    expect(native.mock.calls.filter(([cmd]) => cmd === "zoom_changed")).toHaveLength(0);

    await act(async () => {
      window.supermdLoad?.({
        ...basePayload,
        id: "saved-b",
        path: "/notes/b.md",
        content: "# Saved B",
        mode: "split",
        zoom: 125,
      });
    });

    const zoomCalls = native.mock.calls.filter(([cmd]) => cmd === "zoom_changed");
    expect(zoomCalls).toHaveLength(1);
    expect(zoomCalls[0][1]).toEqual({
      id: "draft-a",
      zoom: 140,
      fullscreen: false,
    });
    expect(document.querySelector<HTMLElement>(".document-page")?.dataset.scale).toBe("1.25");
    expect(document.querySelector<HTMLElement>(".android-source")?.style.getPropertyValue("--workspace-scale")).toBe("1.25");

    // Advancing past 220ms must NOT emit a stale zoom_changed for Draft A onto Saved B.
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(native.mock.calls.filter(([cmd]) => cmd === "zoom_changed")).toHaveLength(1);
    expect(currentAppliedScale()).toBe("1.25");
  });

  it("reconciles the Split source pane to the captured source anchor when remounted scaled line heights drift", async () => {
    await mountReader();
    const lines = Array.from({ length: 40 }, (_, idx) => `- [ ] Step ${idx + 1}: checklist verification item`);
    const content = `# Architecture Spec\n\n${lines.join("\n")}\n`;
    const targetOffset = content.indexOf("- [ ] Step 20:");

    await act(async () => {
      window.supermdLoad?.({
        ...basePayload,
        id: "saved-note-a",
        path: "/notes/spec.md",
        content,
        mode: "split",
        zoom: 150,
      });
    });
    editorAnchors.set("saved-note-a", { offset: targetOffset, top: 980 });

    // Switch to Draft B in editor mode at 143%.
    await act(async () => {
      window.supermdLoad?.({
        ...basePayload,
        id: "unsaved-draft-b",
        path: "unsaved-draft-b",
        content: "# Draft B",
        mode: "editor",
        zoom: 143,
      });
    });
    expect(currentAppliedScale()).toBe("1.43");
    revealedOffsets.length = 0;

    // Simulate a remounted 150% EditorView whose unrendered HeightMap placed scrollTop=980 past targetOffset.
    const scroller = document.createElement("div");
    Object.defineProperty(scroller, "clientHeight", { value: 420, configurable: true });
    Object.defineProperty(scroller, "scrollHeight", { value: 3200, configurable: true });
    scroller.scrollTop = 980;
    const driftedStart = content.indexOf("- [ ] Step 25:");
    const driftedEnd = content.indexOf("- [ ] Step 34:");
    mockViewContext.set("saved-note-a", {
      scroller,
      visibleStart: driftedStart,
      visibleEnd: driftedEnd,
    });

    await act(async () => {
      window.supermdLoad?.({
        ...basePayload,
        id: "saved-note-a",
        path: "/notes/spec.md",
        content,
        mode: "split",
        zoom: 150,
      });
    });

    expect(document.querySelector<HTMLElement>(".document-page")?.dataset.scale).toBe("1.5");
    expect(document.querySelector<HTMLElement>(".android-source")?.style.getPropertyValue("--workspace-scale")).toBe("1.5");
    expect(revealedOffsets.some((entry) => entry.id === "saved-note-a" && entry.offset === targetOffset && entry.options?.top === undefined)).toBe(
      true,
    );
  });

  it("keeps selected folder-search occurrence priority only on its owning note and applies per-note restore otherwise", async () => {
    await mountReader();
    const noteAContent =
      "# Spec A\n\nFirst SharedPin intro.\n\n## Previous Anchor\n\nSaved Note A previous viewport line.\n\n## Deep Match\n\nSelected SharedPin target occurrence.\n";
    const previousNoteAOffset = noteAContent.indexOf("Saved Note A previous viewport line.");
    const selectedNoteAStart = noteAContent.lastIndexOf("SharedPin");
    const selectedNoteAEnd = selectedNoteAStart + "SharedPin".length;

    const draftBContent = "# Draft B\n\nIntro SharedPin.\n\n## Draft Section\n\nEdited unsaved draft B anchor [draft-b-view-state].\n";
    const draftBAnchorOffset = draftBContent.indexOf("Edited unsaved draft B anchor");

    // 1. Prime Note A in Split @ 150% at its previous viewport anchor, then switch to Draft B in Editor @ 143% at its edited anchor.
    await act(async () => {
      window.supermdLoad?.({
        ...basePayload,
        id: "saved-note-a",
        path: "/notes/spec-a.md",
        content: noteAContent,
        mode: "split",
        zoom: 150,
      });
    });
    editorAnchors.set("saved-note-a", { offset: previousNoteAOffset, caretOffset: previousNoteAOffset, top: 520 });

    await act(async () => {
      window.supermdLoad?.({
        ...basePayload,
        id: "unsaved-draft-b",
        path: "unsaved-draft-b",
        content: draftBContent,
        mode: "editor",
        zoom: 143,
      });
    });
    editorAnchors.set("unsaved-draft-b", { offset: draftBAnchorOffset, caretOffset: draftBAnchorOffset, top: 680 });
    expect(currentAppliedScale()).toBe("1.43");
    revealedOffsets.length = 0;

    // 2. Select the 2nd folder-search occurrence on Note A: Note A restores Split @ 150% zoom,
    //    suppresses its previous viewport anchor (previousNoteAOffset), and lets seededFind jump to selectedNoteAStart.
    await act(async () => {
      window.supermdLoad?.({
        ...basePayload,
        id: "saved-note-a",
        path: "/notes/spec-a.md",
        content: noteAContent,
        mode: "split",
        zoom: 150,
        seededFind: {
          query: "SharedPin",
          caseSensitive: true,
          sourceStart: selectedNoteAStart,
          sourceEnd: selectedNoteAEnd,
          matchText: "SharedPin",
        },
      });
    });
    expect(document.querySelector<HTMLElement>(".document-page")?.dataset.scale).toBe("1.5");
    expect(document.querySelector<HTMLElement>(".android-source")?.style.getPropertyValue("--workspace-scale")).toBe("1.5");
    expect(revealedOffsets.some((entry) => entry.id === "saved-note-a" && entry.offset === previousNoteAOffset)).toBe(false);
    expect(revealedOffsets.some((entry) => entry.id === "saved-note-a" && entry.offset === selectedNoteAStart && entry.options?.fromSeed === true)).toBe(true);

    // 3. Switch to Draft B while .reading-search stays open (no seededFind on Draft B):
    //    Draft B restores Editor @ 143% zoom and its own draftBAnchorOffset without seed suppression leaking from Note A.
    revealedOffsets.length = 0;
    await act(async () => {
      window.supermdLoad?.({
        ...basePayload,
        id: "unsaved-draft-b",
        path: "unsaved-draft-b",
        content: draftBContent,
        mode: "editor",
        zoom: 143,
      });
    });
    expect(document.querySelector(".android-reading")).toBeNull();
    expect(currentAppliedScale()).toBe("1.43");
    expect(revealedOffsets.some((entry) => entry.id === "unsaved-draft-b" && entry.offset === draftBAnchorOffset)).toBe(true);

    // 4. Switch back to Note A without seededFind (and then with a stale seededFind): per-note restore applies selectedNoteAStart @ 150% Split.
    revealedOffsets.length = 0;
    await act(async () => {
      window.supermdLoad?.({
        ...basePayload,
        id: "saved-note-a",
        path: "/notes/spec-a.md",
        content: noteAContent,
        mode: "split",
        zoom: 150,
      });
    });
    expect(currentAppliedScale()).toBe("1.5");
    expect(revealedOffsets.some((entry) => entry.id === "saved-note-a" && entry.offset === selectedNoteAStart)).toBe(true);

    await act(async () => {
      window.supermdLoad?.({
        ...basePayload,
        id: "unsaved-draft-b",
        path: "unsaved-draft-b",
        content: draftBContent,
        mode: "editor",
        zoom: 143,
      });
    });
    revealedOffsets.length = 0;
    await act(async () => {
      window.supermdLoad?.({
        ...basePayload,
        id: "saved-note-a",
        path: "/notes/spec-a.md",
        content: noteAContent,
        mode: "split",
        zoom: 150,
        seededFind: {
          query: "SharedPin",
          caseSensitive: true,
          sourceStart: 99999,
          sourceEnd: 100008,
          matchText: "SharedPin",
        },
      });
    });
    expect(currentAppliedScale()).toBe("1.5");
    expect(revealedOffsets.some((entry) => entry.id === "saved-note-a" && entry.offset === selectedNoteAStart)).toBe(true);
  });
});
