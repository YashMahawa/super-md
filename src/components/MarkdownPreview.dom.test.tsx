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
});

describe("relative note navigation", () => {
  it("omits target=_blank on local anchors and routes relative note clicks through open_relative_note", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    const markdown = [
      "[External](https://example.org/docs)",
      "[Section](#overview)",
      "[Lecture 2](lecture-2.md)",
      "[Deck](study.smd)",
      "[[Task Note]]",
      "[[Lecture 2#Bayes Law|Bayes]]",
    ].join("\n\n");
    await act(async () => {
      root?.render(<MarkdownPreview markdown={markdown} documentPath="/notes/index.md" python="" dark={false} fullDocumentAccessibility />);
    });
    const links = Array.from(host.querySelectorAll("a"));
    expect(links).toHaveLength(6);
    expect(links[0].getAttribute("target")).toBe("_blank");
    for (const localLink of links.slice(1)) {
      expect(localLink.hasAttribute("target")).toBe(false);
    }

    for (const [index, expected] of [
      [2, { documentPath: "/notes/index.md", target: "lecture-2.md" }],
      [3, { documentPath: "/notes/index.md", target: "study.smd" }],
      [4, { documentPath: "/notes/index.md", target: "Task%20Note.md" }],
      [5, { documentPath: "/notes/index.md", target: "Lecture%202.md", heading: "bayes-law" }],
    ] as const) {
      loadAsset.mockClear();
      const click = new MouseEvent("click", { bubbles: true, cancelable: true });
      await act(async () => {
        links[index].dispatchEvent(click);
      });
      expect(click.defaultPrevented).toBe(true);
      expect(loadAsset).toHaveBeenCalledWith("open_relative_note", expected);
    }
  });

  it("surfaces an in-app status notice when clicking a relative note link in an unsaved note", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    const notices: string[] = [];
    await act(async () => {
      root?.render(<MarkdownPreview markdown="Open [[Task Note]]" documentPath={null} onNotice={msg => notices.push(msg)} python="" dark={false} fullDocumentAccessibility />);
    });
    const anchor = host.querySelector("a")!;
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    await act(async () => {
      anchor.dispatchEvent(click);
    });
    expect(click.defaultPrevented).toBe(true);
    expect(loadAsset).not.toHaveBeenCalledWith("open_relative_note", expect.anything());
    expect(host.querySelector('[role="status"].reader-link-notice')?.textContent).toContain("Save this note before opening linked notes.");
    expect(notices).toEqual(["Save this note before opening linked notes."]);
  });

  it("surfaces a safe status notice when native open_relative_note blocks an escaped path", async () => {
    loadAsset.mockImplementationOnce(async (command: string) => {
      if (command === "open_relative_note") throw new Error("Linked note is outside the authorized folder.");
      return true as never;
    });
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(<MarkdownPreview markdown="[Secret](../outside.md)" documentPath="/notes/index.md" python="" dark={false} fullDocumentAccessibility />);
    });
    const anchor = host.querySelector("a")!;
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    await act(async () => {
      anchor.dispatchEvent(click);
    });
    expect(click.defaultPrevented).toBe(true);
    expect(loadAsset).toHaveBeenCalledWith("open_relative_note", { documentPath: "/notes/index.md", target: "../outside.md" });
    expect(host.querySelector('[role="status"].reader-link-notice')?.textContent).toContain("Linked note is outside the authorized folder.");
  });
});
