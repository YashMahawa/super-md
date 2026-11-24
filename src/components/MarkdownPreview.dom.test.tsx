// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const { loadAsset, toJsxRuntimeSpy } = vi.hoisted(() => ({
  loadAsset: vi.fn(async (command: string, _args: unknown) => command === "fetch_resource" ? {body:"data:image/png;base64,iVBORw0KGgo="} : "data:image/png;base64,iVBORw0KGgo="),
  toJsxRuntimeSpy: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: loadAsset }));
vi.mock("hast-util-to-jsx-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("hast-util-to-jsx-runtime")>();
  return {
    ...actual,
    toJsxRuntime: (...args: Parameters<typeof actual.toJsxRuntime>) => {
      toJsxRuntimeSpy(...args);
      return actual.toJsxRuntime(...args);
    },
  };
});
import MarkdownPreview from "./MarkdownPreview";

// React's act() uses this flag to flush effects and async state updates in jsdom.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | null = null;
afterEach(() => { if (root) { act(() => root?.unmount()); root = null; } document.body.innerHTML = ""; loadAsset.mockClear(); toJsxRuntimeSpy.mockClear(); });

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

  it("keeps unchanged list images, charts, links, checkboxes, and Python cells mounted across split edits without extra IPC", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    const buildNote = (heading: string) => [
      heading,
      "",
      "- [ ] Review lecture",
      "- ![List figure](images/list-figure.png)",
      "",
      "Jump to [Details](#details).",
      "",
      "```smd-chart",
      '{"title":"Wave","series":[{"expression":"sin(x)"}]}',
      "```",
      "",
      "```python",
      "print(42)",
      "```",
      "",
      "## Details",
    ].join("\n");

    let latestChange = vi.fn();
    const initial = buildNote("# Split heading");
    await act(async () => {
      root?.render(<MarkdownPreview markdown={initial} documentPath="/notes/split.md" python="python3" dark onChange={(next) => latestChange(next)} />);
    });

    const checkbox = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    const imageItem = host.querySelectorAll("li")[1]!;
    const image = host.querySelector<HTMLImageElement>("img")!;
    const link = host.querySelector<HTMLAnchorElement>('a[href="#details"]')!;
    const chartSvg = host.querySelector<SVGSVGElement>(".interactive-chart svg")!;
    const pythonCell = host.querySelector<HTMLElement>(".python-cell")!;
    expect(checkbox).not.toBeNull();
    expect(image.getAttribute("src")).toMatch(/^data:image\/png;base64,/);
    expect(chartSvg).not.toBeNull();
    expect(pythonCell).not.toBeNull();
    expect(loadAsset.mock.calls.some(([cmd]) => cmd === "resolve_reader_asset")).toBe(true);
    expect(loadAsset.mock.calls.some(([cmd]) => cmd === "load_asset")).toBe(true);
    expect(loadAsset.mock.calls.some(([cmd]) => cmd === "load_python_output")).toBe(true);
    loadAsset.mockClear();

    const edited = buildNote("# Split heading with extra prose that shifts every downstream offset");
    latestChange = vi.fn();
    await act(async () => {
      root?.render(<MarkdownPreview markdown={edited} documentPath="/notes/split.md" python="python3" dark onChange={(next) => latestChange(next)} />);
    });

    expect(loadAsset).not.toHaveBeenCalled();
    expect(host.querySelector('input[type="checkbox"]')).toBe(checkbox);
    expect(host.querySelectorAll("li")[1]).toBe(imageItem);
    expect(host.querySelector("img")).toBe(image);
    expect(host.querySelector('a[href="#details"]')).toBe(link);
    expect(host.querySelector(".interactive-chart svg")).toBe(chartSvg);
    expect(host.querySelector(".python-cell")).toBe(pythonCell);

    await act(async () => checkbox.click());
    expect(latestChange).toHaveBeenCalledWith(edited.replace("- [ ] Review lecture", "- [x] Review lecture"));
  });

  it("preserves mounted DeferredMarkdown subtrees in windowed notes across re-renders without redundant IPC", async () => {
    class VisibleIntersectionObserver {
      static instances: VisibleIntersectionObserver[] = [];
      readonly targets = new Set<Element>();
      constructor(readonly callback: IntersectionObserverCallback) { VisibleIntersectionObserver.instances.push(this); }
      observe(target: Element) { this.targets.add(target); }
      unobserve(target: Element) { this.targets.delete(target); }
      disconnect() { this.targets.clear(); }
      revealAll() {
        this.callback(
          Array.from(this.targets, (target) => ({ target, isIntersecting: true } as IntersectionObserverEntry)),
          this as unknown as IntersectionObserver,
        );
      }
    }
    class FakeResizeObserver { constructor(_callback: ResizeObserverCallback) {} observe() {} disconnect() {} }
    vi.stubGlobal("IntersectionObserver", VisibleIntersectionObserver);
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    try {
      const host = document.createElement("div");
      document.body.append(host);
      root = createRoot(host);
      const filler = "Windowed filler paragraph text. ".repeat(2_600);
      const makeMarkdown = (title: string) => `${title}\n\n- ![Windowed image](images/win.png)\n\n\`\`\`python\nprint("windowed")\n\`\`\`\n\n${filler}`;
      const initialWindowed = makeMarkdown("# Windowed title");
      await act(async () => {
        root?.render(<MarkdownPreview markdown={initialWindowed} documentPath="/notes/windowed.md" python="python3" dark onChange={() => {}} />);
      });
      await act(async () => {
        VisibleIntersectionObserver.instances.forEach((io) => io.revealAll());
      });
      expect(host.querySelectorAll("[data-windowed-block]").length).toBeGreaterThan(0);
      const image = host.querySelector("img")!;
      const pythonCell = host.querySelector(".python-cell")!;
      expect(image).not.toBeNull();
      expect(pythonCell).not.toBeNull();
      expect(toJsxRuntimeSpy).toHaveBeenCalled();
      loadAsset.mockClear();
      toJsxRuntimeSpy.mockClear();

      // Re-render with identical source but fresh callback (tests memoized DeferredMarkdown skipping work)
      await act(async () => {
        root?.render(<MarkdownPreview markdown={initialWindowed} documentPath="/notes/windowed.md" python="python3" dark onChange={() => {}} />);
      });
      expect(toJsxRuntimeSpy).not.toHaveBeenCalled();
      expect(loadAsset).not.toHaveBeenCalled();
      expect(host.querySelector("img")).toBe(image);
      expect(host.querySelector(".python-cell")).toBe(pythonCell);

      // Re-render with edited upstream heading (tests stable MARKDOWN_COMPONENTS & WindowedBlock keys)
      await act(async () => {
        root?.render(<MarkdownPreview markdown={makeMarkdown("# Windowed title updated with longer text")} documentPath="/notes/windowed.md" python="python3" dark onChange={() => {}} />);
      });
      expect(loadAsset).not.toHaveBeenCalled();
      expect(host.querySelector("img")).toBe(image);
      expect(host.querySelector(".python-cell")).toBe(pythonCell);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("synchronizes reused checkbox DOM state across check, undo, and redo without remounting", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    const unchecked = "# Tasks\n\n- [ ] Keep my place\n- [ ] Another task";
    const checked = "# Tasks\n\n- [x] Keep my place\n- [ ] Another task";
    let emitted = "";
    const renderNote = async (markdown: string) => {
      await act(async () => {
        root?.render(<MarkdownPreview markdown={markdown} documentPath={null} python="" dark onChange={(next) => { emitted = next; }} />);
      });
    };

    await renderNote(unchecked);
    const checkbox = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(checkbox.checked).toBe(false);

    await act(async () => checkbox.click());
    expect(emitted).toBe(checked);
    await renderNote(checked);
    expect(host.querySelector('input[type="checkbox"]')).toBe(checkbox);
    expect(checkbox.checked).toBe(true);

    // Undo back to unchecked: the reused <input> must clear .checked and check again on next click
    await renderNote(unchecked);
    expect(host.querySelector('input[type="checkbox"]')).toBe(checkbox);
    expect(checkbox.checked).toBe(false);

    emitted = "";
    await act(async () => checkbox.click());
    expect(emitted).toBe(checked);
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
