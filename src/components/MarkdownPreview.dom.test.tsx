// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const { loadAsset } = vi.hoisted(() => ({ loadAsset: vi.fn(async (command: string, _args: unknown) => command === "fetch_resource" ? {body:"data:image/png;base64,iVBORw0KGgo="} : "data:image/png;base64,iVBORw0KGgo=") }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: loadAsset }));
import MarkdownPreview from "./MarkdownPreview";

// React's act() uses this flag to flush effects and async state updates in jsdom.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | null = null;
afterEach(() => { if (root) { act(() => root?.unmount()); root = null; } document.body.innerHTML = ""; loadAsset.mockClear(); });

describe("local image preview", () => {
  it("keeps embedded image data without permitting active links", async () => {
    const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    await act(async () => { root?.render(<MarkdownPreview markdown="![Embedded](data:image/png;base64,iVBORw0KGgo=)\n\n[unsafe](javascript:alert%281%29)" documentPath={null} python="" dark />); });
    expect(host.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,iVBORw0KGgo=");
    expect(host.querySelector("a")?.getAttribute("href")).not.toContain("javascript:");
    expect(loadAsset).not.toHaveBeenCalled();
  });
  it("loads encoded-space paths through the native command and paints the image", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(<MarkdownPreview markdown="![Proof](DM%20Images/proof-method-guide.png)" documentPath="/notes/DM Morning Notes.md" python="" dark />);
    });
    expect(loadAsset).toHaveBeenCalledWith("load_asset", { documentPath: "/notes/DM Morning Notes.md", source: "DM%20Images/proof-method-guide.png" });
    expect(host.querySelector("img")?.getAttribute("src")).toMatch(/^data:image\/png;base64,/);
  });
  it("does not request remote pictures until consent, then paints native-fetched data",async()=>{
    const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    await act(async()=>root?.render(<MarkdownPreview markdown="![Remote](https://example.org/picture.png)" documentPath={null} python="" dark/>));
    expect(loadAsset).not.toHaveBeenCalled();
    expect(host.querySelector("img")).toBeNull();
    await act(async()=>host.querySelector("button")!.dispatchEvent(new MouseEvent("click",{bubbles:true})));
    expect(loadAsset).toHaveBeenCalledWith("fetch_resource",{url:"https://example.org/picture.png",image:true});
    expect(host.querySelector("img")?.getAttribute("src")).toMatch(/^data:image\/png;base64,/);
  });
});
