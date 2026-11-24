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
  it("keeps large notes windowed by default and mounts the complete semantic tree when opted in",async()=>{
    class FakeIntersectionObserver { constructor(_callback:IntersectionObserverCallback){} observe(){} unobserve(){} disconnect(){} }
    class FakeResizeObserver { constructor(_callback:ResizeObserverCallback){} observe(){} disconnect(){} }
    vi.stubGlobal("IntersectionObserver",FakeIntersectionObserver);
    vi.stubGlobal("ResizeObserver",FakeResizeObserver);
    const host=document.createElement("div");document.body.append(host);root=createRoot(host);
    const markdown=`## Chapter\n\n${"Full note content. ".repeat(4_300)}`;
    await act(async()=>root?.render(<MarkdownPreview markdown={markdown} documentPath={null} python="" dark/>));
    expect(host.querySelectorAll("[data-windowed-block]").length).toBeGreaterThan(0);
    expect(host.querySelector(".windowed-md-block p")).toBeNull();
    await act(async()=>root?.render(<MarkdownPreview markdown={markdown} documentPath={null} python="" dark fullDocumentAccessibility/>));
    expect(host.querySelector("[data-windowed-block]")).toBeNull();
    expect(host.querySelector(".windowed-md-block")).toBeNull();
    expect(host.querySelector(".markdown-body p")?.textContent?.match(/Full note content\./g)).toHaveLength(4_300);
  });


  it("toggles a task marker without changing frontmatter, code or neighboring source",async()=>{
    const host=document.createElement('div');document.body.append(host);root=createRoot(host);
    const markdown='---\ntitle: Tasks\n---\n# Tasks\n\n- [ ] Read $E=mc^2$ 😊\n- [x] Done\n\n```md\n- [ ] Literal example\n```';
    const change=vi.fn();
    await act(async()=>root?.render(<MarkdownPreview markdown={markdown} onChange={change} documentPath={null} python="" dark/>));
    const boxes=host.querySelectorAll<HTMLInputElement>('input[type=checkbox]');
    expect(boxes).toHaveLength(2);expect(boxes[0].disabled).toBe(false);
    await act(async()=>boxes[0].click());
    expect(change).toHaveBeenCalledWith(markdown.replace('- [ ] Read','- [x] Read'));
  });
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

  it("renders zero raw YAML lines across BOM, empty blocks, trailing spaces, dot closers, and EOF closers", async () => {
    const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    const variations = [
      "\uFEFF---\ntitle: BOM Note\nauthor: Ada Lovelace\ndate: 2026-03-15\ntags: [math, engines]\n---\n\n# Analytical Engine",
      "---   \ntitle: Dot Closer\ndescription: Clean metadata\n...  \n\nBody paragraph.",
      "---\n---\n\nBody after empty dashes.",
      "---\n...\n\nBody after empty dots.",
      "---\ntitle: Metadata Only\ntags:\n  - solo\n---",
    ];
    for (const sample of variations) {
      await act(async () => root?.render(<MarkdownPreview markdown={sample} documentPath={null} python="" dark />));
      expect(host.querySelectorAll("hr")).toHaveLength(0);
      expect(host.textContent).not.toContain("---");
      expect(host.textContent).not.toContain("title:");
      expect(host.textContent).not.toContain("tags:");
    }
  });

  it("renders a read-only properties header only when recognized metadata exists and falls back safely on malformed YAML", async () => {
    const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    const rich = "\uFEFF---\ntitle: Electrodynamics\nauthor:\n  - name: James Clerk Maxwell\ndate: 2026-04-01\ndescription: Field equations\ntags: [physics, fields]\naliases: [EM Notes]\n...\n\n# Gauss's Law";
    await act(async () => root?.render(<MarkdownPreview markdown={rich} documentPath={null} python="" dark />));
    const header = host.querySelector('[data-frontmatter-properties="true"]');
    expect(header).not.toBeNull();
    expect(header?.textContent).toContain("Electrodynamics");
    expect(header?.textContent).toContain("James Clerk Maxwell");
    expect(header?.textContent).toContain("2026-04-01");
    expect(header?.textContent).toContain("Field equations");
    expect(header?.textContent).toContain("physics");
    expect(header?.textContent).toContain("EM Notes");

    await act(async () => root?.render(<MarkdownPreview markdown={"---\ncssclasses: [wide]\n---\n\n# Plain"} documentPath={null} python="" dark />));
    expect(host.querySelector('[data-frontmatter-properties="true"]')).toBeNull();
    expect(host.querySelector("h1")?.textContent).toBe("Plain");

    await act(async () => root?.render(<MarkdownPreview markdown={"---\ntitle: \"Unclosed quote\n---\n\n# Fallback"} documentPath={null} python="" dark />));
    expect(host.querySelector('[data-frontmatter-properties="true"]')).toBeNull();
    expect(host.querySelector("h1")?.textContent).toBe("Fallback");
  });

  it("preserves exact task checkbox source offsets across BOM, dot closer, and CRLF frontmatter", async () => {
    const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    const markdown = "\uFEFF---  \r\ntitle: \"Checklist\"\r\ntags: [ops]\r\n...\r\n\r\n- [ ] Verify BOM + dot closer\r\n- [x] Done\r\n";
    const change = vi.fn();
    await act(async () => root?.render(<MarkdownPreview markdown={markdown} onChange={change} documentPath={null} python="" dark />));
    const boxes = host.querySelectorAll<HTMLInputElement>("input[type=checkbox]");
    expect(boxes).toHaveLength(2);
    await act(async () => boxes[0].click());
    expect(change).toHaveBeenCalledWith(markdown.replace("- [ ] Verify", "- [x] Verify"));
  });
});
