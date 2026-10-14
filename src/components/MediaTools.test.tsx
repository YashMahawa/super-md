// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MediaTools from "./MediaTools";
import ImageViewer from "./ImageViewer";
import { importImageFiles } from "../documentMedia";

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
