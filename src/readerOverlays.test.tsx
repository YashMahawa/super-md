// @vitest-environment jsdom
import { EditorView } from "@codemirror/view";
import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Editor from "./components/Editor";
import LiveEditor from "./components/LiveEditor";
import ReadingSearch from "./components/ReadingSearch";
import { invoke } from "./nativeBridge";
import { dismissReaderOverlay, setReaderDismissible, setReaderOverlay } from "./readerOverlays";

vi.mock("./nativeBridge", () => ({
  invoke: vi.fn(async () => true),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

if (typeof Range !== "undefined") {
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () =>
    ({ x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0, toJSON: () => ({}) }) as DOMRect;
}

function setNativeTextareaValue(area: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  setter.call(area, value);
  area.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("Android Back / dismissReaderOverlay for active Live edits and Source search", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    document.documentElement.dataset.platform = "android";
    setReaderOverlay("search", false);
    setReaderDismissible("live-edit", false);
    setReaderDismissible("cm-search", false);
    window.supermdDismiss = () => flushSync(() => dismissReaderOverlay());
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    delete window.supermdDismiss;
    delete document.documentElement.dataset.platform;
    delete document.documentElement.dataset.readerOverlay;
    delete document.documentElement.dataset.readerImageOverlay;
    delete document.documentElement.dataset.readerDismissible;
  });

  it("registers active Live edits as readerDismissible without readerOverlay, preserves mid-composition draft text on Back, and releases on second Back", async () => {
    let latestMarkdown = "# Heading\n\nOriginal paragraph.";
    const onChange = vi.fn((next: string) => {
      latestMarkdown = next;
    });

    const renderLive = async () => {
      await act(async () => {
        root.render(
          <LiveEditor
            markdown={latestMarkdown}
            onChange={onChange}
            documentPath={null}
            python="embedded"
            dark={false}
          />,
        );
      });
    };

    await renderLive();
    expect(document.documentElement.dataset.readerDismissible).toBe("false");
    expect(invoke).not.toHaveBeenCalledWith("reader_dismissible_changed", expect.anything());

    const paragraphBlock = Array.from(host.querySelectorAll<HTMLElement>(".live-block")).find((el) =>
      el.textContent?.includes("Original paragraph."),
    );
    expect(paragraphBlock).toBeTruthy();

    act(() => {
      paragraphBlock!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });

    const textarea = host.querySelector<HTMLTextAreaElement>(".live-active-block textarea");
    expect(textarea).toBeTruthy();
    expect(document.documentElement.dataset.readerDismissible).toBe("true");
    expect(document.documentElement.dataset.readerOverlay).not.toBe("true");
    expect(invoke).toHaveBeenCalledWith("reader_dismissible_changed", { open: true });

    // Simulate typed text followed by uncommitted Android IME composition text in textarea.value.
    act(() => {
      setNativeTextareaValue(textarea!, "Draft typed");
    });
    await renderLive();

    const activeTextarea = host.querySelector<HTMLTextAreaElement>(".live-active-block textarea")!;
    activeTextarea.value = "Draft typed with composing tail";
    activeTextarea.setSelectionRange(activeTextarea.value.length, activeTextarea.value.length);

    // A duplicate supermd-edit-block event on the already-active block must not reset uncommitted textarea text.
    act(() => {
      activeTextarea
        .closest(".live-block")!
        .dispatchEvent(new CustomEvent("supermd-edit-block", { bubbles: true }));
    });
    expect(host.querySelector<HTMLTextAreaElement>(".live-active-block textarea")?.value).toBe(
      "Draft typed with composing tail",
    );

    // First Back dismisses active Live edit synchronously, flushes uncommitted textarea draft, and clears readerDismissible.
    let firstDismissed = false;
    act(() => {
      firstDismissed = window.supermdDismiss!();
      expect(document.documentElement.dataset.readerDismissible).toBe("false");
    });
    expect(firstDismissed).toBe(true);
    expect(host.querySelector(".live-active-block textarea")).toBeNull();
    expect(latestMarkdown).toBe("# Heading\n\nDraft typed with composing tail");
    expect(invoke).toHaveBeenCalledWith("reader_dismissible_changed", { open: false });

    await renderLive();
    expect(host.textContent).toContain("Draft typed with composing tail");

    // Second Back returns false so native Android falls through to fullscreen exit or system Back.
    expect(window.supermdDismiss!()).toBe(false);
    expect(latestMarkdown).toBe("# Heading\n\nDraft typed with composing tail");
  });

  it("does not emit Android-only reader_dismissible_changed bridge command on non-Android hosts", async () => {
    document.documentElement.dataset.platform = "desktop";
    await act(async () => {
      root.render(
        <LiveEditor
          markdown="Desktop paragraph."
          onChange={() => {}}
          documentPath={null}
          python="embedded"
          dark={false}
        />,
      );
    });
    const block = host.querySelector<HTMLElement>(".live-block")!;
    act(() => {
      block.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(document.documentElement.dataset.readerDismissible).toBe("true");
    expect(invoke).not.toHaveBeenCalledWith("reader_dismissible_changed", expect.anything());
  });

  it("dismisses CodeMirror Source search even when unfocused while keeping Source draft text and releasing second Back", async () => {
    const sessionId = `cm-back-${Date.now()}`;
    let sourceText = "# Source Note\n\nAlpha beta gamma.";
    const onChange = vi.fn((next: string) => {
      sourceText = next;
    });

    await act(async () => {
      root.render(
        <div>
          <button type="button" className="outside-btn">
            Outside target
          </button>
          <Editor
            sessionId={sessionId}
            value={sourceText}
            onChange={onChange}
            dark={false}
            focusMode={false}
          />
        </div>,
      );
    });

    expect(document.documentElement.dataset.readerDismissible).toBe("false");

    // Open CodeMirror's inline .cm-search panel.
    act(() => {
      window.dispatchEvent(new Event("supermd-find"));
    });
    expect(host.querySelector(".cm-search")).toBeTruthy();
    expect(document.documentElement.dataset.readerDismissible).toBe("true");
    expect(document.documentElement.dataset.readerOverlay).not.toBe("true");
    expect(invoke).toHaveBeenCalledWith("reader_dismissible_changed", { open: true });

    // Edit Source text while search is open and move DOM focus completely outside CodeMirror.
    const cmView = EditorView.findFromDOM(host.querySelector<HTMLElement>(".cm-editor")!)!;
    act(() => {
      cmView.dispatch({
        changes: { from: cmView.state.doc.length, insert: "\nEdited source line kept across Back." },
      });
    });
    expect(sourceText).toContain("Edited source line kept across Back.");

    const outsideButton = host.querySelector<HTMLButtonElement>(".outside-btn")!;
    outsideButton.focus();
    expect(document.activeElement).toBe(outsideButton);

    // First Back closes .cm-search synchronously despite outside focus and clears readerDismissible.
    let firstDismissed = false;
    act(() => {
      firstDismissed = window.supermdDismiss!();
      expect(document.documentElement.dataset.readerDismissible).toBe("false");
    });
    expect(firstDismissed).toBe(true);
    expect(host.querySelector(".cm-search")).toBeNull();
    expect(cmView.state.doc.toString()).toContain("Edited source line kept across Back.");
    expect(sourceText).toContain("Edited source line kept across Back.");
    expect(invoke).toHaveBeenCalledWith("reader_dismissible_changed", { open: false });

    // Second Back returns false so native Android preserves system Back.
    expect(window.supermdDismiss!()).toBe(false);
  });

  it("dismisses native ReadingSearch in Source mode synchronously while keeping Source draft text and releasing second Back", async () => {
    const sessionId = `source-find-${Date.now()}`;
    let sourceText = "# Source Note\n\nKeep this edited source draft.";
    let open = true;

    const renderHarness = () => {
      root.render(
        <div>
          {open && (
            <ReadingSearch
              content={sourceText}
              sourceSession={sessionId}
              onChange={(next) => {
                sourceText = next;
                renderHarness();
              }}
              close={() => {
                open = false;
                renderHarness();
              }}
            />
          )}
          <Editor
            sessionId={sessionId}
            value={sourceText}
            onChange={(next) => {
              sourceText = next;
            }}
            dark={false}
            focusMode={false}
          />
        </div>,
      );
    };

    await act(async () => renderHarness());
    expect(host.querySelector(".reading-search")).toBeTruthy();
    expect(document.documentElement.dataset.readerOverlay).toBe("true");
    expect(invoke).toHaveBeenCalledWith("reader_overlay_changed", { open: true, image: false });

    const cmView = EditorView.findFromDOM(host.querySelector<HTMLElement>(".cm-editor")!)!;
    act(() => {
      cmView.dispatch({
        changes: { from: cmView.state.doc.length, insert: "\nAppended while Find in note open." },
      });
    });
    expect(sourceText).toContain("Appended while Find in note open.");

    let firstDismissed = false;
    act(() => {
      firstDismissed = window.supermdDismiss!();
      expect(document.documentElement.dataset.readerOverlay).toBe("false");
    });
    expect(firstDismissed).toBe(true);
    expect(host.querySelector(".reading-search")).toBeNull();
    expect(sourceText).toContain("Appended while Find in note open.");
    expect(cmView.state.doc.toString()).toContain("Appended while Find in note open.");

    // Second Back returns false so native Android preserves system Back.
    expect(window.supermdDismiss!()).toBe(false);
  });
});
