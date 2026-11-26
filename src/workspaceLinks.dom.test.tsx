// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const { bridgeInvoke } = vi.hoisted(() => ({
  bridgeInvoke: vi.fn(async (_command: string, _args?: unknown) => ({ opened: true })),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: bridgeInvoke }));

import { EditorView } from "@codemirror/view";
import { Reader } from "./androidReader";
import Editor from "./components/Editor";
import { findSourceLinkAtOffset } from "./workspaceLinks";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | null = null;

const postCalls: Array<{ id: string; command: string; args: Record<string, unknown> }> = [];
const postSpy = vi.fn((id: string, command: string, rawArgs: string) => {
  postCalls.push({ id, command, args: JSON.parse(rawArgs || "{}") });
  window.supermdReply?.(id, { opened: true }, null);
});

beforeEach(() => {
  bridgeInvoke.mockClear();
  postCalls.length = 0;
  postSpy.mockClear();
  window.SuperMD = { post: postSpy };
});

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
    root = null;
  }
  document.body.innerHTML = "";
  delete (window as unknown as Record<string, unknown>).SuperMD;
  delete window.supermdBeforeNavigate;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Source mode Ctrl/Cmd+Click workspace link navigation", () => {
  it("parses wikilinks and Markdown links at column offsets while ignoring embeds and escaped brackets", () => {
    const line =
      "See ![[diagram.png]], \\[[escaped]], [[Subfolder Note#Deep Dive|Alias]], [Spec](../my specs/api.md#Auth), and [[#Top]].";
    expect(findSourceLinkAtOffset(line, line.indexOf("diagram.png"))).toBeNull();
    expect(findSourceLinkAtOffset(line, line.indexOf("escaped"))).toBeNull();
    expect(findSourceLinkAtOffset(line, line.indexOf("Subfolder Note"))).toEqual({
      kind: "workspace",
      target: "Subfolder Note",
      fragment: "Deep Dive",
      wikilink: true,
    });
    expect(findSourceLinkAtOffset(line, line.indexOf("../my specs/api.md"))).toEqual({
      kind: "workspace",
      target: "../my specs/api.md",
      fragment: "Auth",
      wikilink: false,
    });
    expect(findSourceLinkAtOffset(line, line.indexOf("#Top"))).toEqual({
      kind: "same-note",
      fragment: "Top",
    });
  });

  it("flushes pending edits via supermdBeforeNavigate and opens cross-note wikilinks from Source mode", async () => {
    if (!Range.prototype.getClientRects) {
      Range.prototype.getClientRects = () => ([] as unknown as DOMRectList);
    }
    if (!Range.prototype.getBoundingClientRect) {
      Range.prototype.getBoundingClientRect = () =>
        ({ top: 0, bottom: 16, left: 0, right: 80, width: 80, height: 16, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    }
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);

    const source = "Draft intro before [[Roadmap#Q4 Goals|Q4 Plan]] and `[[Ignored Code]]` in source mode.";
    await act(async () => {
      root?.render(
        <Editor
          sessionId="source-link-test"
          documentPath="/vault/Notes/Today.md"
          value={source}
          onChange={vi.fn()}
          dark={false}
          focusMode={false}
        />,
      );
    });

    const cmContent = host.querySelector<HTMLElement>(".cm-content")!;
    const view = EditorView.findFromDOM(cmContent)!;
    const posSpy = vi.spyOn(view, "posAtCoords");

    // Inline code wikilinks are ignored on Ctrl+Click
    posSpy.mockReturnValueOnce(source.indexOf("Ignored Code") + 2);
    await act(async () => {
      cmContent.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, ctrlKey: true, clientX: 80, clientY: 24 }),
      );
    });
    expect(postCalls).toHaveLength(0);

    // Prose wikilinks flush pending edits first, then invoke open_workspace_link
    posSpy.mockReturnValueOnce(source.indexOf("Roadmap#Q4 Goals") + 3);
    const events: string[] = [];
    window.supermdBeforeNavigate = vi.fn(async () => {
      events.push("flushed");
    });
    postSpy.mockImplementationOnce((id, cmd, rawArgs) => {
      events.push(cmd);
      postCalls.push({ id, command: cmd, args: JSON.parse(rawArgs || "{}") });
      window.supermdReply?.(id, { opened: true }, null);
    });

    await act(async () => {
      cmContent.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, ctrlKey: true, clientX: 120, clientY: 24 }),
      );
    });

    expect(events).toEqual(["flushed", "open_workspace_link"]);
    expect(postCalls.at(-1)).toMatchObject({
      command: "open_workspace_link",
      args: {
        documentPath: "/vault/Notes/Today.md",
        target: "Roadmap",
        fragment: "Q4 Goals",
        wikilink: true,
      },
    });
    // Same-note [[#...]] wikilink moves selection directly to target heading offset
    const sameNoteSource = "Jump to [[#Q4 Goals]]\n\n## Q4 Goals\n\nBody.";
    await act(async () => {
      root?.render(
        <Editor
          sessionId="source-link-same-note"
          documentPath="/vault/Notes/Today.md"
          value={sameNoteSource}
          onChange={vi.fn()}
          dark={false}
          focusMode={false}
        />,
      );
    });
    const sameCm = host.querySelector<HTMLElement>(".cm-content")!;
    const sameView = EditorView.findFromDOM(sameCm)!;
    vi.spyOn(sameView, "posAtCoords").mockReturnValueOnce(sameNoteSource.indexOf("#Q4 Goals") + 2);
    await act(async () => {
      sameCm.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, ctrlKey: true, clientX: 60, clientY: 16 }),
      );
    });
    expect(sameView.state.selection.main.head).toBe(sameNoteSource.indexOf("## Q4 Goals"));
  }, 15_000);

  it("scrolls to pendingHeading in >80k-char windowed notes and Source mode without saved-scroll override", async () => {
    class FakeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    if (!Range.prototype.getClientRects) {
      Range.prototype.getClientRects = () => ([] as unknown as DOMRectList);
    }
    if (!Range.prototype.getBoundingClientRect) {
      Range.prototype.getBoundingClientRect = () =>
        ({ top: 0, bottom: 16, left: 0, right: 80, width: 80, height: 16, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    }
    vi.stubGlobal("IntersectionObserver", FakeObserver);
    vi.stubGlobal("ResizeObserver", FakeObserver);
    vi.useFakeTimers();

    const readerRootEl = document.createElement("div");
    readerRootEl.id = "root";
    document.body.append(readerRootEl);
    root = createRoot(readerRootEl);
    await act(async () => {
      root?.render(<Reader />);
    });

    const filler = `${"Detailed background paragraph for windowed rendering verification. ".repeat(25)}\n\n`;
    const largeNote = `# Large Handbook\n\n${filler.repeat(55)}## Target Deep Section\n\nTarget body.\n\n${filler.repeat(10)}`;
    expect(largeNote.length).toBeGreaterThan(85_000);
    const expectedOffset = largeNote.indexOf("## Target Deep Section");

    await act(async () => {
      window.supermdLoad?.({
        id: "windowed-reader-note",
        path: "/vault/Large.md",
        content: largeNote,
        mode: "reader",
        dark: false,
        fullscreen: false,
        font: "Manrope",
        size: 15,
        zoom: 100,
        motion: false,
        restorePosition: true,
        readingLocation: { top: 1500, offset: 100, zoom: 100, mode: "reader" },
        pendingHeading: { heading: "Target Deep Section", token: "jump-token-reader" },
        colors: {},
      });
      vi.advanceTimersByTime(400);
    });
    const renderedHeadings = Array.from(readerRootEl.querySelectorAll("h2")).map((el) => el.textContent?.trim());
    expect(renderedHeadings).toContain("Target Deep Section");

    await act(async () => {
      window.supermdLoad?.({
        id: "source-note",
        path: "/vault/Large.md",
        content: largeNote,
        mode: "editor",
        dark: false,
        fullscreen: false,
        font: "Manrope",
        size: 15,
        zoom: 100,
        motion: false,
        restorePosition: true,
        readingLocation: { top: 1500, offset: 100, zoom: 100, mode: "editor" },
        pendingHeading: { heading: "Target Deep Section", token: "jump-token-source" },
        colors: {},
      });
      vi.advanceTimersByTime(400);
    });
    const cmContent = readerRootEl.querySelector<HTMLElement>(".cm-content");
    expect(cmContent).not.toBeNull();
    const editorView = EditorView.findFromDOM(cmContent!)!;
    expect(editorView.state.selection.main.head).toBe(expectedOffset);
  }, 15_000);
});
