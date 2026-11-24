// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MediaTools from "./MediaTools";
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
});
