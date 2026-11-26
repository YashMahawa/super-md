// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MediaTools, { STALE_INSERTION_MESSAGE, SWITCHED_NOTE_IMPORT_MESSAGE } from "./MediaTools";
import ImageViewer from "./ImageViewer";
import LiveEditor from "./LiveEditor";
import Editor from "./Editor";
import { EditorView } from "@codemirror/view";
import { importImageFiles } from "../documentMedia";
import { invoke } from "../nativeBridge";
import { dismissReaderOverlay } from "../readerOverlays";

vi.mock("../nativeBridge", () => ({ invoke: vi.fn(async () => true) }));
vi.mock("../documentMedia", async importOriginal => ({
  ...await importOriginal<typeof import("../documentMedia")>(),
  importImageFiles: vi.fn(async () => [{ source: "assets/import-test.svg", alt: "New image" }]),
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root;
let host: HTMLDivElement;
const insert = vi.fn();
const notice = vi.fn();
const file = new File(['<svg xmlns="http://www.w3.org/2000/svg"/>'], "image.svg", { type: "image/svg+xml" });
function drag(target: Element, type: string, files: File[] = []) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { files, types: files.length ? ["Files"] : [] } });
  target.dispatchEvent(event);
  return event;
}
beforeEach(async () => {
  vi.clearAllMocks();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<div className="android-document">
    <MediaTools documentId="note" content="# My original note" documentPath="/notes/note.md" onInsert={insert} onNotice={notice} />
    <ImageViewer />
    <section className="android-reading"><article className="markdown-body">
      <img className="test-raster" src="data:image/png;base64,eA==" alt="Picture" />
      <img className="svg-diagram" src="data:image/svg+xml,%3Csvg/%3E" alt="Drawing" />
      <div className="mermaid"><svg><rect width="10" height="10" /></svg></div>
      <p>Keep this paragraph unchanged.</p>
    </article></section>
  </div>));
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe("viewing images is never an import", () => {
  it.each([".test-raster", ".svg-diagram", ".mermaid rect"])("cancels native dragging of %s before it can become a dropped file", async selector => {
    const image = host.querySelector(selector)!;
    await act(async () => {
      const start = drag(image, "dragstart");
      expect(start.defaultPrevented).toBe(true);
    });
    expect(importImageFiles).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it("does not import internal file-bearing drags from document controls", async () => {
    const paragraph = host.querySelector("p")!;
    await act(async () => { drag(paragraph, "dragstart"); drag(paragraph, "drop", [file]); drag(paragraph, "dragend"); });
    expect(importImageFiles).not.toHaveBeenCalled(); expect(insert).not.toHaveBeenCalled();
  });

  it.each([".test-raster", ".svg-diagram"])("opens and closes %s without an edit", async selector => {
    const image = host.querySelector<HTMLImageElement>(selector)!;
    Object.defineProperty(image, "currentSrc", { value: image.src });
    await act(async () => image.click());
    expect(host.querySelector(".image-viewer")).not.toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>(".image-viewer header button")!.click());
    expect(host.querySelector(".image-viewer")).toBeNull();
    expect(importImageFiles).not.toHaveBeenCalled(); expect(insert).not.toHaveBeenCalled();
  });

  it("cycles Tab and Shift+Tab focus across Close, Fit, Replace, and Remove buttons in the image viewer", async () => {
    const image = host.querySelector<HTMLImageElement>(".test-raster")!;
    image.setAttribute("data-note-image-source", image.src);
    Object.defineProperty(image, "currentSrc", { value: image.src });
    await act(async () => image.click());
    const buttons = Array.from(host.querySelectorAll<HTMLButtonElement>(".image-viewer button"));
    expect(buttons.map(button => button.textContent)).toEqual(["Close", "Fit", "Replace", "Remove"]);
    const [close, fit, replace, remove] = buttons;
    expect(document.activeElement).toBe(close);

    const tab = (shiftKey = false) => {
      const event = new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true });
      document.activeElement!.dispatchEvent(event);
      return event;
    };

    expect(tab(true).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(remove);

    expect(tab(true).defaultPrevented).toBe(false);
    replace.focus();
    expect(tab(true).defaultPrevented).toBe(false);
    fit.focus();
    expect(tab(true).defaultPrevented).toBe(false);

    close.focus();
    expect(tab(false).defaultPrevented).toBe(false);
    fit.focus();
    expect(tab(false).defaultPrevented).toBe(false);
    replace.focus();
    expect(tab(false).defaultPrevented).toBe(false);

    remove.focus();
    expect(tab(false).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(close);
  });

  it("still imports genuine external file drops exactly once", async () => {
    await act(async () => { drag(host.querySelector("p")!, "drop", [file]); });
    expect(importImageFiles).toHaveBeenCalledExactlyOnceWith([file]);
    expect(insert).toHaveBeenCalledExactlyOnceWith("\n\n![New image](<assets/import-test.svg>)\n", undefined);
  });

  it("accepts an external file after a cancelled image drag with no dragend", async () => {
    await act(async () => { drag(host.querySelector(".svg-diagram")!, "dragstart"); });
    await act(async () => { drag(host.querySelector("p")!, "drop", [file]); });
    expect(importImageFiles).toHaveBeenCalledExactlyOnceWith([file]);
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it("does not import files dropped over an image viewer", async () => {
    const image = host.querySelector<HTMLImageElement>(".test-raster")!;
    Object.defineProperty(image, "currentSrc", { value: image.src });
    await act(async () => image.click());
    await act(async () => { drag(host.querySelector(".image-viewer-canvas")!, "drop", [file]); });
    expect(importImageFiles).not.toHaveBeenCalled(); expect(insert).not.toHaveBeenCalled();
  });

  it("does not append blank Markdown for an empty native import result", async () => {
    await act(async () => window.supermdInsertImages?.([]));
    expect(insert).not.toHaveBeenCalled();
  });

  it("does not intercept URL clipboard paste, while keeping image paste and explicit supermdMedia dialog", async () => {
    const paragraph = host.querySelector("p")!;
    await act(async () => {
      const urlPaste = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(urlPaste, "clipboardData", {
        value: {
          files: [],
          getData: (type: string) => (type === "text/plain" ? "https://example.com/article" : ""),
        },
      });
      paragraph.dispatchEvent(urlPaste);
      expect(urlPaste.defaultPrevented).toBe(false);
    });
    expect(host.querySelector('[role="dialog"]')).toBeNull();

    await act(async () => {
      const imgPaste = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(imgPaste, "clipboardData", {
        value: {
          files: [file],
          getData: () => "",
        },
      });
      paragraph.dispatchEvent(imgPaste);
      expect(imgPaste.defaultPrevented).toBe(true);
    });
    expect(importImageFiles).toHaveBeenCalledExactlyOnceWith([file]);

    await act(async () => window.supermdMedia?.());
    expect(host.querySelector('[role="dialog"][aria-label="Insert image or link"]')).not.toBeNull();
  });
});

describe("live cursor offsets, coordinate drops, and overlay registration", () => {
  if (typeof Range !== "undefined") {
    Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
    Range.prototype.getBoundingClientRect ??= () => ({ x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0, toJSON: () => ({}) } as DOMRect);
  }
  function setNativeInputValue(input: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  it("inserts at the blurred LiveEditor selection, registers readerOverlay, and submits on Enter", async () => {
    const onInsertLive = vi.fn();
    const content = "# Title\n\nAlpha beta\n\nClosing";
    await act(async () => root.render(<div className="android-document">
      <MediaTools documentId="live-note" content={content} documentPath="/notes/live.md" onInsert={onInsertLive} onNotice={notice} />
      <LiveEditor markdown={content} documentPath="/notes/live.md" dark={false} python="" onChange={vi.fn()} />
    </div>));

    act(() => host.querySelectorAll("p")[0]!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    const area = host.querySelector("textarea")!;
    act(() => {
      area.focus();
      area.setSelectionRange(5, 5);
      area.dispatchEvent(new Event("select", { bubbles: true }));
      area.blur();
    });
    expect(host.querySelector("textarea")).toBeNull();

    await act(async () => window.supermdMedia?.());
    expect(document.documentElement.dataset.readerOverlay).toBe("true");
    expect(invoke).toHaveBeenCalledWith("reader_overlay_changed", { open: true, image: false });

    const urlInput = host.querySelector<HTMLInputElement>('input[type="url"]')!;
    await act(async () => setNativeInputValue(urlInput, "https://example.com/reference"));
    await act(async () => {
      urlInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });

    expect(onInsertLive).toHaveBeenCalledExactlyOnceWith("[example.com](<https://example.com/reference>)", { from: 14, to: 14 });
    expect(host.querySelector(".media-dialog")).toBeNull();
    expect(document.documentElement.dataset.readerOverlay).toBe("false");
  });

  it("resolves supermdCaptureInsertion(x, y) via .live-block, [data-source-end], and Editor posAtCoords while ignoring active overlays", async () => {
    const dropInsert = vi.fn();
    const content = "# Intro\n\nMiddle paragraph\n\nEnd";
    const originalFromPoint = document.elementFromPoint;

    await act(async () => root.render(<div className="android-document">
      <MediaTools documentId="drop-live" content={content} documentPath="/notes/drop.md" onInsert={dropInsert} onNotice={notice} />
      <ImageViewer />
      <LiveEditor markdown={content} documentPath="/notes/drop.md" dark={false} python="" onChange={vi.fn()} />
    </div>));

    const middleBlock = host.querySelectorAll<HTMLElement>(".live-block")[1]!;
    document.elementFromPoint = vi.fn(() => middleBlock.querySelector("p")!);
    await act(async () => {
      window.supermdCaptureInsertion?.(120, 80);
      window.supermdInsertImages?.([{ source: "assets/live-drop.png", alt: "Live drop" }]);
    });
    expect(dropInsert).toHaveBeenCalledExactlyOnceWith("\n\n![Live drop](<assets/live-drop.png>)\n", {
      from: Number(middleBlock.dataset.sourceEnd),
      to: Number(middleBlock.dataset.sourceEnd),
    });

    dropInsert.mockClear();
    await act(async () => window.supermdMedia?.());
    await act(async () => {
      window.supermdCaptureInsertion?.(120, 80);
      window.supermdInsertImages?.([{ source: "assets/ignored.png", alt: "Ignored" }]);
    });
    expect(dropInsert).not.toHaveBeenCalled();
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    expect(host.querySelector(".media-dialog")).toBeNull();

    const posSpy = vi.spyOn(EditorView.prototype, "posAtCoords").mockReturnValue(9);
    await act(async () => root.render(<div className="android-document">
      <MediaTools documentId="drop-source" content={content} documentPath="/notes/drop.md" onInsert={dropInsert} onNotice={notice} />
      <Editor sessionId="drop-source-session" value={content} onChange={vi.fn()} dark={false} focusMode={false} />
    </div>));
    document.elementFromPoint = vi.fn(() => host.querySelector(".cm-content")!);
    await act(async () => {
      window.supermdCaptureInsertion?.(64, 48);
      window.supermdInsertImages?.([{ source: "assets/cm-drop.png", alt: "CodeMirror drop" }]);
    });
    expect(posSpy).toHaveBeenCalledWith({ x: 64, y: 48 });
    expect(dropInsert).toHaveBeenCalledExactlyOnceWith("\n\n![CodeMirror drop](<assets/cm-drop.png>)\n", { from: 9, to: 9 });

    posSpy.mockRestore();
    document.elementFromPoint = originalFromPoint;
  });

  it("keeps dataset.readerOverlay uninterrupted during ImageViewer Replace handoff and cleans up on backdrop/Escape/unmount", async () => {
    const handoffInsert = vi.fn();
    const content = "# Gallery\n\n![Photo](assets/old.png)\n";
    await act(async () => root.render(<div className="android-document">
      <ImageViewer />
      <MediaTools documentId="handoff" content={content} documentPath="/notes/gallery.md" onInsert={handoffInsert} onNotice={notice} />
      <section className="android-reading"><article className="markdown-body">
        <span className="note-image" data-note-image-source="assets/old.png">
          <img className="handoff-img" src="data:image/png;base64,eA==" alt="Photo" />
        </span>
      </article></section>
    </div>));

    const img = host.querySelector<HTMLImageElement>(".handoff-img")!;
    Object.defineProperty(img, "currentSrc", { value: img.src });
    await act(async () => img.click());
    expect(host.querySelector(".image-viewer")).not.toBeNull();
    expect(document.documentElement.dataset.readerOverlay).toBe("true");

    vi.mocked(invoke).mockClear();
    const overlayStates: Array<string | undefined> = [];
    const observer = new MutationObserver(() => overlayStates.push(document.documentElement.dataset.readerOverlay));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-reader-overlay"] });

    const replaceBtn = Array.from(host.querySelectorAll<HTMLButtonElement>(".image-viewer footer button")).find((b) => b.textContent === "Replace")!;
    await act(async () => replaceBtn.click());
    observer.disconnect();

    expect(host.querySelector(".image-viewer")).toBeNull();
    expect(host.querySelector(".media-dialog h2")?.textContent).toBe("Replace image");
    expect(document.documentElement.dataset.readerOverlay).toBe("true");
    expect(overlayStates).not.toContain("false");
    expect(invoke).not.toHaveBeenCalledWith("reader_overlay_changed", expect.objectContaining({ open: false }));

    await act(async () => host.querySelector<HTMLElement>(".media-scrim")!.click());
    expect(host.querySelector(".media-dialog")).toBeNull();
    expect(document.documentElement.dataset.readerOverlay).toBe("false");

    window.supermdDismiss = dismissReaderOverlay;
    expect(window.supermdDismiss()).toBe(false);
    await act(async () => window.supermdMedia?.());
    expect(document.documentElement.dataset.readerOverlay).toBe("true");
    await act(async () => { expect(window.supermdDismiss?.()).toBe(true); });
    expect(host.querySelector(".media-dialog")).toBeNull();
    expect(document.documentElement.dataset.readerOverlay).toBe("false");

    await act(async () => window.supermdMedia?.());
    expect(document.documentElement.dataset.readerOverlay).toBe("true");
    await act(async () => root.render(<div />));
    expect(document.documentElement.dataset.readerOverlay).toBe("false");
  });

  it("translates Live-mode drop offsets during active block edits, active block drafts, frontmatter, and inter-block gaps", async () => {
    let liveMarkdown = "---\ntitle: Lab\n---\n# Intro\n\nMiddle paragraph\n\nClosing";
    const dropInsert = vi.fn();
    const originalFromPoint = document.elementFromPoint;

    const renderScene = async () => {
      await act(async () => root.render(<div className="android-document">
        <MediaTools documentId="live-active-drop" content={liveMarkdown} documentPath="/notes/live.md" onInsert={dropInsert} onNotice={notice} />
        <section className="android-reading">
          <LiveEditor markdown={liveMarkdown} documentPath="/notes/live.md" dark={false} python="" onChange={(next) => { liveMarkdown = next; }} />
        </section>
      </div>));
    };
    await renderScene();

    // Open the "# Intro" block and lengthen it so downstream rendered blocks hold stale baseMarkdown offsets.
    const introBlock = host.querySelectorAll<HTMLElement>(".live-block")[0]!;
    act(() => introBlock.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    const area = host.querySelector<HTMLTextAreaElement>("textarea")!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(area, "# Intro expanded significantly");
      area.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await renderScene();

    // 1. Dropping on downstream "Middle paragraph" must translate past the expanded active block draft.
    const blocksWhileEditing = host.querySelectorAll<HTMLElement>(".live-block");
    const middleBlock = blocksWhileEditing[1]!;
    expect(Number(middleBlock.dataset.sourceEnd)).not.toBe(liveMarkdown.indexOf("Middle paragraph") + "Middle paragraph".length);
    document.elementFromPoint = vi.fn(() => middleBlock.querySelector("p")!);
    await act(async () => {
      window.supermdCaptureInsertion?.(140, 180);
      window.supermdInsertImages?.([{ source: "assets/translated.png", alt: "Translated" }]);
    });
    const expectedMiddleEnd = liveMarkdown.indexOf("Middle paragraph") + "Middle paragraph".length;
    expect(dropInsert).toHaveBeenCalledExactlyOnceWith("\n\n![Translated](<assets/translated.png>)\n", {
      from: expectedMiddleEnd,
      to: expectedMiddleEnd,
    });

    // 2. Dropping directly onto the active block textarea inserts after the current draft, not stale baseSplitEnd.
    dropInsert.mockClear();
    const activeTextarea = host.querySelector<HTMLTextAreaElement>(".live-active-block textarea")!;
    document.elementFromPoint = vi.fn(() => activeTextarea);
    await act(async () => {
      window.supermdCaptureInsertion?.(100, 90);
      window.supermdInsertImages?.([{ source: "assets/after-active.png", alt: "After active" }]);
    });
    const expectedActiveEnd = liveMarkdown.indexOf("# Intro expanded significantly") + "# Intro expanded significantly".length;
    expect(dropInsert).toHaveBeenCalledExactlyOnceWith("\n\n![After active](<assets/after-active.png>)\n", {
      from: expectedActiveEnd,
      to: expectedActiveEnd,
    });

    // 3. Dropping on YAML frontmatter properties clamps to frontmatter.end rather than inside YAML.
    dropInsert.mockClear();
    const propsPanel = host.querySelector<HTMLElement>("[data-frontmatter-properties],.document-properties")!;
    document.elementFromPoint = vi.fn(() => propsPanel);
    await act(async () => {
      window.supermdCaptureInsertion?.(80, 24);
      window.supermdInsertImages?.([{ source: "assets/after-fm.png", alt: "After frontmatter" }]);
    });
    const expectedFrontmatterEnd = "---\ntitle: Lab\n---\n".length;
    expect(dropInsert).toHaveBeenCalledExactlyOnceWith("\n\n![After frontmatter](<assets/after-fm.png>)\n", {
      from: expectedFrontmatterEnd,
      to: expectedFrontmatterEnd,
    });

    // 4. Dropping in the vertical gap between blocks 0 and 1 resolves to block 0's end instead of EOF.
    dropInsert.mockClear();
    const allLiveBlocks = Array.from(host.querySelectorAll<HTMLElement>(".live-block"));
    allLiveBlocks[0]!.getBoundingClientRect = () => ({ top: 60, bottom: 110, left: 20, right: 620, width: 600, height: 50, x: 20, y: 60, toJSON: () => ({}) } as DOMRect);
    allLiveBlocks[1]!.getBoundingClientRect = () => ({ top: 150, bottom: 200, left: 20, right: 620, width: 600, height: 50, x: 20, y: 150, toJSON: () => ({}) } as DOMRect);
    allLiveBlocks[2]!.getBoundingClientRect = () => ({ top: 240, bottom: 290, left: 20, right: 620, width: 600, height: 50, x: 20, y: 240, toJSON: () => ({}) } as DOMRect);
    const liveContainer = host.querySelector<HTMLElement>(".live-document")!;
    document.elementFromPoint = vi.fn(() => liveContainer);
    await act(async () => {
      window.supermdCaptureInsertion?.(200, 130);
      window.supermdInsertImages?.([{ source: "assets/in-gap.png", alt: "In gap" }]);
    });
    expect(dropInsert).toHaveBeenCalledExactlyOnceWith("\n\n![In gap](<assets/in-gap.png>)\n", {
      from: expectedActiveEnd,
      to: expectedActiveEnd,
    });

    // 5. Dropping onto a frontmatter-only note while editing its standalone ActiveBlockEditor inserts after the draft.
    dropInsert.mockClear();
    liveMarkdown = "---\ntitle: Lab\n---\n";
    await renderScene();
    const emptyBodyBlock = host.querySelector<HTMLElement>(".live-block")!;
    act(() => emptyBodyBlock.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    const standaloneTextarea = host.querySelector<HTMLTextAreaElement>(".live-active-block textarea")!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(standaloneTextarea, "First body draft");
      standaloneTextarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await renderScene();
    document.elementFromPoint = vi.fn(() => host.querySelector<HTMLTextAreaElement>(".live-active-block textarea")!);
    await act(async () => {
      window.supermdCaptureInsertion?.(120, 120);
      window.supermdInsertImages?.([{ source: "assets/after-standalone.png", alt: "After standalone" }]);
    });
    expect(dropInsert).toHaveBeenCalledExactlyOnceWith("\n\n![After standalone](<assets/after-standalone.png>)\n", {
      from: liveMarkdown.length,
      to: liveMarkdown.length,
    });

    document.elementFromPoint = originalFromPoint;
  });

  it("consumes non-image and mixed file drops safely without mutating the note or letting CodeMirror read raw files", async () => {
    const dropInsert = vi.fn();
    const editorChange = vi.fn();
    const content = "# Source Note\n\nKeep clean.";
    await act(async () => root.render(<div className="workspace">
      <MediaTools documentId="safe-drop" content={content} documentPath="/notes/safe.md" onInsert={dropInsert} onNotice={notice} />
      <Editor sessionId="safe-drop-editor" value={content} onChange={editorChange} dark={false} focusMode={false} />
    </div>));

    const cmContent = host.querySelector<HTMLElement>(".cm-content")!;
    const pdfFile = new File(["%PDF-1.7 binary payload"], "handout.pdf", { type: "application/pdf" });
    const bmpFile = new File(["BMunsupported"], "legacy.bmp", { type: "image/bmp" });

    // Non-image dragover & drop on CodeMirror are both prevented and stopped before CodeMirror's file reader runs.
    let reachedBubble = false;
    cmContent.addEventListener("drop", () => { reachedBubble = true; });
    await act(async () => {
      const overEvent = drag(cmContent, "dragover", [pdfFile]);
      expect(overEvent.defaultPrevented).toBe(true);
      const dropEvent = drag(cmContent, "drop", [pdfFile, bmpFile]);
      expect(dropEvent.defaultPrevented).toBe(true);
    });
    expect(reachedBubble).toBe(false);
    expect(importImageFiles).not.toHaveBeenCalled();
    expect(dropInsert).not.toHaveBeenCalled();
    expect(editorChange).not.toHaveBeenCalled();
    expect(notice).toHaveBeenCalledWith("Only supported images (PNG, JPEG, GIF, WebP, AVIF, or SVG) can be dropped into a note.");

    // Mixed drop (supported SVG + unsupported PDF) imports only the supported image and notifies about the skipped file.
    notice.mockClear();
    await act(async () => {
      const mixedDrop = drag(cmContent, "drop", [file, pdfFile]);
      expect(mixedDrop.defaultPrevented).toBe(true);
    });
    expect(importImageFiles).toHaveBeenCalledExactlyOnceWith([file]);
    expect(dropInsert).toHaveBeenCalledTimes(1);
    expect(notice).toHaveBeenCalledWith("Skipped 1 unsupported file; only PNG, JPEG, GIF, WebP, AVIF, and SVG images were imported.");

    // Drops on Text nodes and outside workspace chrome also prevent browser file navigation cleanly.
    vi.mocked(importImageFiles).mockClear();
    dropInsert.mockClear();
    notice.mockClear();
    const outsideShell = document.createElement("header");
    outsideShell.className = "topbar";
    document.body.append(outsideShell);
    try {
      await act(async () => {
        const outsideOver = drag(outsideShell, "dragover", [pdfFile]);
        expect(outsideOver.defaultPrevented).toBe(true);
        const outsideDrop = drag(outsideShell, "drop", [pdfFile]);
        expect(outsideDrop.defaultPrevented).toBe(true);
      });
      expect(importImageFiles).not.toHaveBeenCalled();
      expect(dropInsert).not.toHaveBeenCalled();
      expect(notice).toHaveBeenCalledWith("Drop images inside the note area to insert them.");
    } finally {
      outsideShell.remove();
    }
  });

  it("remaps delayed image imports across preceding edits and cancels with clear feedback on stale ranges or tab switches", async () => {
    let noteId = "note-delay";
    let noteContent = "# Intro\n\nTarget paragraph.\n\nConclusion.";
    const originalFromPoint = document.elementFromPoint;
    vi.mocked(invoke).mockImplementation(async (command) => (command === "load_asset" ? "data:image/svg+xml,%3Csvg/%3E" : true));
    const appliedInsert = vi.fn((text: string, point?: { from: number; to: number }) => {
      const from = point?.from ?? noteContent.length;
      const to = point?.to ?? from;
      noteContent = noteContent.slice(0, from) + text + noteContent.slice(to);
    });

    const renderDelayedScene = async () => {
      await act(async () => root.render(<div className="android-document">
        <MediaTools documentId={noteId} content={noteContent} documentPath="/notes/delay.md" onInsert={appliedInsert} onNotice={notice} />
        <section className="android-reading">
          <LiveEditor key={noteId} markdown={noteContent} documentPath="/notes/delay.md" dark={false} python="" onChange={(next) => { noteContent = next; }} />
        </section>
      </div>));
    };
    await renderDelayedScene();

    // 1. Delayed drop + typing BEFORE the drop point while importImageFiles awaits -> remaps offset and keeps edit intact.
    let resolveFirstImport!: (images: Array<{ source: string; alt: string }>) => void;
    vi.mocked(importImageFiles).mockImplementationOnce(
      () => new Promise((resolve) => { resolveFirstImport = resolve; }),
    );

    const introBlock = host.querySelectorAll<HTMLElement>(".live-block")[0]!;
    act(() => introBlock.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    const targetParagraphEl = host.querySelectorAll<HTMLElement>(".live-block")[1]!.querySelector("p")!;
    await act(async () => {
      const dropEvent = new Event("drop", { bubbles: true, cancelable: true });
      Object.defineProperty(dropEvent, "dataTransfer", { value: { files: [file], types: ["Files"] } });
      Object.defineProperty(dropEvent, "clientX", { value: 140 });
      Object.defineProperty(dropEvent, "clientY", { value: 180 });
      targetParagraphEl.dispatchEvent(dropEvent);
    });
    expect(importImageFiles).toHaveBeenCalledTimes(1);
    expect(appliedInsert).not.toHaveBeenCalled();

    // User continues typing in "# Intro" BEFORE Target paragraph while importImageFiles is in flight.
    const activeArea = host.querySelector<HTMLTextAreaElement>(".live-active-block textarea")!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(activeArea, "# Intro — typed while importing");
      activeArea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await renderDelayedScene();

    const expectedRemappedOffset = noteContent.indexOf("Target paragraph.") + "Target paragraph.".length;
    await act(async () => {
      resolveFirstImport([{ source: "assets/delayed-live.svg", alt: "Delayed live" }]);
    });
    expect(appliedInsert).toHaveBeenCalledExactlyOnceWith("\n\n![Delayed live](<assets/delayed-live.svg>)\n", {
      from: expectedRemappedOffset,
      to: expectedRemappedOffset,
    });
    expect(noteContent).toContain("# Intro — typed while importing\n\nTarget paragraph.\n\n![Delayed live](<assets/delayed-live.svg>)\n\n\nConclusion.");
    expect(notice).not.toHaveBeenCalled();

    // 2. Delayed drop + overwriting across the drop point while importImageFiles awaits -> cancels safely, keeps edit intact.
    appliedInsert.mockClear();
    notice.mockClear();
    await renderDelayedScene();

    let resolveStaleImport!: (images: Array<{ source: string; alt: string }>) => void;
    vi.mocked(importImageFiles).mockImplementationOnce(
      () => new Promise((resolve) => { resolveStaleImport = resolve; }),
    );
    const secondTargetEl = host.querySelectorAll<HTMLElement>(".live-block")[1]!.querySelector("p")!;
    await act(async () => {
      const dropEvent = new Event("drop", { bubbles: true, cancelable: true });
      Object.defineProperty(dropEvent, "dataTransfer", { value: { files: [file], types: ["Files"] } });
      Object.defineProperty(dropEvent, "clientX", { value: 140 });
      Object.defineProperty(dropEvent, "clientY", { value: 180 });
      secondTargetEl.dispatchEvent(dropEvent);
    });

    const overwrittenNote = "# Intro — typed while importing\n\nEntire middle section replaced.\n";
    noteContent = overwrittenNote;
    await renderDelayedScene();

    await act(async () => {
      resolveStaleImport([{ source: "assets/stale.svg", alt: "Stale" }]);
    });
    expect(appliedInsert).not.toHaveBeenCalled();
    expect(noteContent).toBe(overwrittenNote);
    expect(notice).toHaveBeenCalledExactlyOnceWith(STALE_INSERTION_MESSAGE);

    // 3. Delayed drop + switching tabs before importImageFiles completes -> cancels with clear notice, keeps new tab intact.
    appliedInsert.mockClear();
    notice.mockClear();
    let resolveTabSwitchImport!: (images: Array<{ source: string; alt: string }>) => void;
    vi.mocked(importImageFiles).mockImplementationOnce(
      () => new Promise((resolve) => { resolveTabSwitchImport = resolve; }),
    );
    const firstBlockEl = host.querySelectorAll<HTMLElement>(".live-block")[0]!;
    await act(async () => {
      drag(firstBlockEl, "drop", [file]);
    });

    noteId = "second-tab";
    noteContent = "# Second tab stays untouched";
    await renderDelayedScene();

    await act(async () => {
      resolveTabSwitchImport([{ source: "assets/wrong-tab.svg", alt: "Wrong tab" }]);
    });
    expect(appliedInsert).not.toHaveBeenCalled();
    expect(noteContent).toBe("# Second tab stays untouched");
    expect(notice).toHaveBeenCalledExactlyOnceWith(SWITCHED_NOTE_IMPORT_MESSAGE);

    // 4. Native supermdCaptureInsertion -> intervening preceding edit remaps supermdInsertImages; tab switch cancels safely.
    appliedInsert.mockClear();
    notice.mockClear();
    noteId = "native-capture-tab";
    noteContent = "# Native\n\nBody paragraph.\n\nFooter.";
    await renderDelayedScene();

    const bodyBlock = host.querySelectorAll<HTMLElement>(".live-block")[1]!;
    document.elementFromPoint = vi.fn(() => bodyBlock.querySelector("p")!);
    await act(async () => {
      window.supermdCaptureInsertion?.(100, 120);
    });
    noteContent = "Preface.\n\n" + noteContent;
    await renderDelayedScene();
    const expectedNativeOffset = noteContent.indexOf("Body paragraph.") + "Body paragraph.".length;
    await act(async () => {
      window.supermdInsertImages?.([{ source: "assets/native-remapped.png", alt: "Native remapped" }]);
    });
    expect(appliedInsert).toHaveBeenCalledExactlyOnceWith("\n\n![Native remapped](<assets/native-remapped.png>)\n", {
      from: expectedNativeOffset,
      to: expectedNativeOffset,
    });

    appliedInsert.mockClear();
    notice.mockClear();
    await renderDelayedScene();
    document.elementFromPoint = vi.fn(() => host.querySelector<HTMLElement>(".live-block p")!);
    await act(async () => {
      window.supermdCaptureInsertion?.(100, 120);
    });
    noteId = "native-other-tab";
    noteContent = "# Native Other Tab";
    await renderDelayedScene();
    await act(async () => {
      window.supermdInsertImages?.([{ source: "assets/native-cancelled.png", alt: "Native cancelled" }]);
    });
    expect(appliedInsert).not.toHaveBeenCalled();
    expect(noteContent).toBe("# Native Other Tab");
    expect(notice).toHaveBeenCalledExactlyOnceWith(SWITCHED_NOTE_IMPORT_MESSAGE);

    // 5. Source mode (CodeMirror) delayed drop + typing & multi-line deletion before drop point -> remaps cleanly.
    appliedInsert.mockClear();
    notice.mockClear();
    noteId = "source-delay-tab";
    noteContent = "Header line 1\nHeader line 2\n\nBody anchor.\n\nTail.";
    const posSpy = vi.spyOn(EditorView.prototype, "posAtCoords").mockReturnValue(noteContent.indexOf("Body anchor.") + "Body anchor.".length);
    const renderSourceDelayedScene = async () => {
      await act(async () => root.render(<div className="workspace">
        <MediaTools documentId={noteId} content={noteContent} documentPath="/notes/source-delay.md" onInsert={appliedInsert} onNotice={notice} />
        <Editor key={noteId} sessionId={noteId} value={noteContent} onChange={(next) => { noteContent = next; }} dark={false} focusMode={false} />
      </div>));
    };
    await renderSourceDelayedScene();

    let resolveSourceImport!: (images: Array<{ source: string; alt: string }>) => void;
    vi.mocked(importImageFiles).mockImplementationOnce(
      () => new Promise((resolve) => { resolveSourceImport = resolve; }),
    );
    const cmTarget = host.querySelector<HTMLElement>(".cm-content")!;
    await act(async () => {
      const dropEvent = new Event("drop", { bubbles: true, cancelable: true });
      Object.defineProperty(dropEvent, "dataTransfer", { value: { files: [file], types: ["Files"] } });
      Object.defineProperty(dropEvent, "clientX", { value: 90 });
      Object.defineProperty(dropEvent, "clientY", { value: 120 });
      cmTarget.dispatchEvent(dropEvent);
    });

    // Delete "Header line 1\n" and expand "Header line 2" across two steps before importImageFiles resolves.
    noteContent = "Header line 2\n\nBody anchor.\n\nTail.";
    await renderSourceDelayedScene();
    noteContent = "Header line 2 — typed in Source mode\n\nBody anchor.\n\nTail.";
    await renderSourceDelayedScene();

    const expectedSourceRemapped = noteContent.indexOf("Body anchor.") + "Body anchor.".length;
    await act(async () => {
      resolveSourceImport([{ source: "assets/source-delayed.svg", alt: "Source delayed" }]);
    });
    expect(appliedInsert).toHaveBeenCalledExactlyOnceWith("\n\n![Source delayed](<assets/source-delayed.svg>)\n", {
      from: expectedSourceRemapped,
      to: expectedSourceRemapped,
    });
    expect(noteContent).toContain("Header line 2 — typed in Source mode\n\nBody anchor.\n\n![Source delayed](<assets/source-delayed.svg>)\n\n\nTail.");
    expect(notice).not.toHaveBeenCalled();

    posSpy.mockRestore();
    document.elementFromPoint = originalFromPoint;
  });
});
