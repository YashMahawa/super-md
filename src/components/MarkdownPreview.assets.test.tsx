// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../nativeBridge", () => ({ invoke }));
import MarkdownPreview from "./MarkdownPreview";
import { DocumentAppearance } from "../documentAppearance";
import { prepareFmd } from "../documentMedia";
import { NoteRemoteImageConsentStore } from "../remoteImageConsent";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | null = null;
afterEach(() => {
  if (root) { act(() => root?.unmount()); root = null; }
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  invoke.mockReset();
});

async function render(markdown: string) {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<MarkdownPreview markdown={markdown} documentPath="/notes/a.md" python="" dark />);
  });
  return host;
}

async function rerender(host: HTMLElement, markdown: string) {
  await act(async () => {
    root?.render(<MarkdownPreview markdown={markdown} documentPath="/notes/a.md" python="" dark />);
  });
  return host;
}

describe("MarkdownPreview streamed local assets", () => {
  it("refreshes replaced asset pixels without clearing the current image or editing Markdown", async () => {
    const before=`https://appassets.androidplatform.net/reader-assets/${"1".repeat(32)}?v=${"a".repeat(64)}`;
    const after=`https://appassets.androidplatform.net/reader-assets/${"2".repeat(32)}?v=${"b".repeat(64)}`;
    invoke.mockResolvedValueOnce({url:before,mime:"image/png"});
    const host=await render("![Raster](assets/a.png)");const image=host.querySelector("img");
    let finish!:(value:unknown)=>void;invoke.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
    await act(async()=>window.dispatchEvent(new Event("supermd-assets-changed")));
    expect(image?.getAttribute("src")).toBe(before);
    await act(async()=>finish({url:after,mime:"image/png"}));
    expect(host.querySelector("img")).toBe(image);expect(image?.getAttribute("src")).toBe(after);
    expect(invoke.mock.calls.every(([command])=>command==="resolve_reader_asset")).toBe(true);
  });
  it("renders the scoped native raster URL without materializing base64", async () => {
    const url = `https://appassets.androidplatform.net/reader-assets/${"1".repeat(32)}?v=${"a".repeat(64)}`;
    invoke.mockResolvedValueOnce({ url, mime: "image/png" });
    const host = await render("![Raster](images/a.png)");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("resolve_reader_asset", { documentPath: "/notes/a.md", source: "images/a.png" });
    expect(host.querySelector("img")?.getAttribute("src")).toBe(url);
  });

  it("preserves the legacy SVG data loader without invoking resolve_reader_asset", async () => {
    const svg = "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=";
    invoke.mockResolvedValueOnce(svg);
    const host = await render("![Vector](images/a.svg)");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("load_asset", { documentPath: "/notes/a.md", source: "images/a.svg" });
    expect(invoke).not.toHaveBeenCalledWith("resolve_reader_asset", expect.anything());
    expect(host.querySelector("img")?.getAttribute("src")).toBe(svg);
  });

  it("adapts linked SVG assets to reader theme without calling resolve_reader_asset", async () => {
    const rawSvg = '<svg viewBox="0 0 10 10"><path d="M0 0h5" stroke="#000"/><circle r="2" fill="white"/></svg>';
    const svgData = `data:image/svg+xml;base64,${Buffer.from(rawSvg, "utf8").toString("base64")}`;
    invoke.mockResolvedValueOnce(svgData);
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(
        <DocumentAppearance.Provider value={{ dark: true, svgAppearance: "auto", ink: "#e6e0e9", text: "#e6e0e9" }}>
          <MarkdownPreview markdown="![Diagram](diagrams/flow.SVG?mode=auto)" documentPath="/notes/a.md" python="" dark />
        </DocumentAppearance.Provider>,
      );
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("load_asset", { documentPath: "/notes/a.md", source: "diagrams/flow.SVG?mode=auto" });
    expect(invoke).not.toHaveBeenCalledWith("resolve_reader_asset", expect.anything());
    const wrapper = host.querySelector<HTMLElement>(".note-image");
    const img = host.querySelector<HTMLImageElement>("img");
    expect(wrapper?.classList.contains("note-image--diagram")).toBe(true);
    expect(img?.getAttribute("data-media-kind")).toBe("svg");
    expect(img?.getAttribute("data-media-adapted")).toBe("true");
    expect(decodeURIComponent(img?.getAttribute("src") ?? "")).not.toContain('stroke="#000"');
  });

  it("falls back if a native response is malformed or outside the approved origin", async () => {
    invoke.mockResolvedValueOnce({ url: "https://example.org/a.png", mime: "image/png" });
    invoke.mockResolvedValueOnce("data:image/png;base64,iVBORw0KGgo=");
    const host = await render("![Raster](images/a.png)");
    expect(invoke).toHaveBeenNthCalledWith(2, "load_asset", { documentPath: "/notes/a.md", source: "images/a.png" });
    expect(host.querySelector("img")?.getAttribute("src")).toMatch(/^data:image\/png;base64,/);
  });

  it("retries only the matching failed asset after its folder access is restored", async () => {
    const loads:string[]=[];
    invoke.mockImplementation(async (command: string,args:any) => {
      if(command==="resolve_reader_asset")throw new Error("Asset access is required");
      if(command==="load_asset"){
        loads.push(args.source);
        if(args.source==="images/photo.png"&&loads.filter(source=>source===args.source).length===1)throw new Error("Choose the note folder permission");
        return "data:image/png;base64,iVBORw0KGgo=";
      }
      return undefined;
    });
    const host=await render("![Photo](images/photo.png)\n\n![Other](images/other.png)");
    expect(host.querySelector(".image-error")?.textContent).toContain("Choose the note folder permission");
    expect(loads).toEqual(["images/photo.png","images/other.png"]);
    await act(async()=>window.dispatchEvent(new CustomEvent("supermd-asset-access-restored",{detail:{documentPath:"/notes/a.md",source:"images/other.png"}})));
    expect(loads).toEqual(["images/photo.png","images/other.png"]);
    await act(async()=>window.dispatchEvent(new CustomEvent("supermd-asset-access-restored",{detail:{documentPath:"/notes/a.md",source:"images/photo.png"}})));
    expect(loads).toEqual(["images/photo.png","images/other.png","images/photo.png"]);
    expect(host.querySelector(".image-error")).toBeNull();
    expect(host.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,iVBORw0KGgo=");
  });

  it("does not carry one-time remote consent to a changed image source", async () => {
    invoke.mockResolvedValue({ body: "data:image/png;base64,iVBORw0KGgo=" });
    const first = "https://images.example/a.png";
    const second = "https://images.example/b.png";
    const host = await render(`![Remote](${first})`);
    expect(host.querySelector(".remote-image-card")).not.toBeNull();

    await act(async () => host.querySelector<HTMLButtonElement>(".remote-image-actions button")?.click());
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("fetch_resource", { url: first, image: true });

    await rerender(host, `![Remote](${second})`);
    expect(host.querySelector(".remote-image-card")).not.toBeNull();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).not.toHaveBeenCalledWith("fetch_resource", { url: second, image: true });
  });

  it("continues to allow explicitly trusted remote image hosts", async () => {
    invoke.mockResolvedValue({ body: "data:image/png;base64,iVBORw0KGgo=" });
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(<MarkdownPreview markdown="![Remote](https://images.example/a.png)" documentPath="/notes/a.md" python="" dark trustedImageHosts={["images.example"]} />);
    });
    expect(invoke).toHaveBeenCalledWith("fetch_resource", { url: "https://images.example/a.png", image: true });
  });

  it("reuses reader-loaded remote consent offline and skips unvisited nested slides on in-place portable save", async () => {
    const localSvg = "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=";
    const remotePng = "data:image/png;base64,iVBORw0KGgo=";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected global fetch"));
    invoke.mockImplementation(async (command: string, args: any) => {
      if (command === "load_asset") return localSvg;
      if (command === "fetch_resource") return { body: remotePng };
      return undefined;
    });

    const deck = {
      title: "Nested study deck",
      steps: [
        {
          label: "Step 1",
          image: "https://once.example/slide0.png",
          markdown: "Approved ![Inline](https://once.example/slide0-md.png)",
        },
        { label: "Step 2", markdown: "Unvisited ![S2](https://blocked.example/slide1-md.png)" },
        { label: "Step 3", image: "https://blocked.example/slide2-nearby.png" },
        { label: "Step 4", description: "Plain" },
        {
          label: "Step 5",
          image: "https://blocked.example/slide4-unvisited.png",
          markdown: "Deep unvisited ![S5](https://blocked.example/slide4-md.png)",
        },
      ],
    };
    const markdown = [
      "![Local](images/local.svg)",
      "",
      "![Blocked Prose](https://blocked.example/prose.png)",
      "",
      "```smd-steps",
      JSON.stringify(deck, null, 2),
      "```",
    ].join("\n");

    const consentStore = new NoteRemoteImageConsentStore();
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    const renderWithPolicy = async () => {
      await act(async () => {
        root?.render(
          <MarkdownPreview
            noteId="tab-1"
            markdown={markdown}
            documentPath="/notes/study.smd"
            python=""
            dark
            approvedImageUrls={consentStore.approvedUrls("tab-1")}
            onApproveImageUrl={(noteId, url) => {
              if (noteId) consentStore.approve(noteId, url);
            }}
            onRemoteImageLoaded={(noteId, url, data) => {
              if (noteId) consentStore.recordLoaded(noteId, url, data);
            }}
          />,
        );
      });
    };
    await renderWithPolicy();

    // Unvisited Slide 5 is not even mounted; Slide 1's two remote cards are blocked until approved.
    expect(invoke).not.toHaveBeenCalledWith("fetch_resource", expect.anything());
    expect(host.querySelector('[data-note-image-source="https://blocked.example/slide4-unvisited.png"]')).toBeNull();

    // Approve only Slide 1's figure and Slide 1's nested markdown image.
    const approveSource = async (source: string) => {
      const button = host.querySelector<HTMLButtonElement>(`.remote-image-card[data-note-image-source="${source}"] .remote-image-actions button`);
      expect(button).not.toBeNull();
      await act(async () => button?.click());
    };
    await approveSource("https://once.example/slide0.png");
    await approveSource("https://once.example/slide0-md.png");

    expect(invoke.mock.calls.filter(([cmd]) => cmd === "fetch_resource").map(([, args]) => args.url).sort()).toEqual([
      "https://once.example/slide0-md.png",
      "https://once.example/slide0.png",
    ]);

    // Simulate switching to Source mode (unmounting preview) and saving the portable note in place:
    // approved images pack from cached reader data with zero network calls, and unapproved/unvisited URLs stay intact.
    act(() => { root?.unmount(); root = null; });
    invoke.mockClear();

    const saved = await prepareFmd(markdown, "/notes/study.smd", consentStore.policy("tab-1", []));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalledWith("fetch_resource", expect.anything());
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("load_asset", { documentPath: "/notes/study.smd", source: "images/local.svg" });

    expect(Object.keys(saved.assets)).toHaveLength(3);
    expect(saved.content).toContain("![Blocked Prose](https://blocked.example/prose.png)");
    const savedDeck = JSON.parse(/```smd-steps\n([\s\S]*?)\n```/.exec(saved.content)![1]);
    expect(savedDeck.steps[0].image).toMatch(/^assets\/image-.*\.png$/);
    expect(savedDeck.steps[0].markdown).toMatch(/!\[Inline\]\(<assets\/image-.*\.png>\)/);
    expect(savedDeck.steps[1].markdown).toBe("Unvisited ![S2](https://blocked.example/slide1-md.png)");
    expect(savedDeck.steps[2].image).toBe("https://blocked.example/slide2-nearby.png");
    expect(savedDeck.steps[4].image).toBe("https://blocked.example/slide4-unvisited.png");
    expect(savedDeck.steps[4].markdown).toBe("Deep unvisited ![S5](https://blocked.example/slide4-md.png)");
  });

  it("attributes in-flight remote image loads and approvals to the originating note when switching notes before resolution", async () => {
    const remotePng = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a44kAAAAASUVORK5CYII=";
    let resolveInflight!: (value: { body: string }) => void;
    invoke.mockImplementation((command: string) => {
      if (command === "fetch_resource") {
        return new Promise<{ body: string }>((resolve) => {
          resolveInflight = resolve;
        });
      }
      return Promise.resolve(undefined);
    });

    const sharedUrl = "https://once.example/shared-inflight.png";
    const noteAMarkdown = `# Note A\n\n![Shared](${sharedUrl})\n`;
    const noteBMarkdown = `# Note B\n\n![Shared](${sharedUrl})\n`;
    const consentStore = new NoteRemoteImageConsentStore();
    const approvalCalls: Array<[string | undefined, string]> = [];
    const loadedCalls: Array<[string | undefined, string, string]> = [];

    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    const renderNote = async (noteId: string, markdown: string, documentPath: string) => {
      await act(async () => {
        root?.render(
          <MarkdownPreview
            noteId={noteId}
            markdown={markdown}
            documentPath={documentPath}
            python=""
            dark={false}
            approvedImageUrls={consentStore.approvedUrls(noteId)}
            onApproveImageUrl={(originId, url) => {
              approvalCalls.push([originId, url]);
              if (originId) consentStore.approve(originId, url);
            }}
            onRemoteImageLoaded={(originId, url, data) => {
              loadedCalls.push([originId, url, data]);
              if (originId) consentStore.recordLoaded(originId, url, data);
            }}
          />,
        );
      });
    };

    await renderNote("note-a", noteAMarkdown, "/notes/note-a.smd");
    const loadButton = host.querySelector<HTMLButtonElement>('.remote-image-card[data-note-id="note-a"] .remote-image-actions button');
    expect(loadButton).not.toBeNull();

    // Start loading in Note A, then switch the preview to Note B BEFORE fetch_resource resolves.
    await act(async () => {
      loadButton?.click();
    });
    expect(approvalCalls).toEqual([["note-a", sharedUrl]]);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("fetch_resource", { url: sharedUrl, image: true });

    await renderNote("note-b", noteBMarkdown, "/notes/note-b.smd");
    // Note B must stay blocked and never inherit Note A's local allowedOnce state.
    expect(host.querySelector('.remote-image-card[data-note-id="note-b"]')).not.toBeNull();
    expect(host.querySelector("img")).toBeNull();
    expect(invoke).toHaveBeenCalledTimes(1);

    // Resolve the in-flight image fetch after switching to Note B.
    await act(async () => {
      resolveInflight({ body: remotePng });
      await Promise.resolve();
    });

    expect(loadedCalls).toEqual([["note-a", sharedUrl, remotePng]]);
    expect(consentStore.approvedUrls("note-a")).toEqual([sharedUrl]);
    expect(consentStore.approvedUrls("note-b")).toEqual([]);
    expect(host.querySelector('.remote-image-card[data-note-id="note-b"]')).not.toBeNull();
    expect(host.querySelector("img")).toBeNull();

    // Saving Note B leaves the unapproved URL untouched; saving Note A packs the resolved bytes offline.
    invoke.mockClear();
    const savedB = await prepareFmd(noteBMarkdown, "/notes/note-b.smd", consentStore.policy("note-b", []));
    expect(savedB.content).toBe(noteBMarkdown);
    expect(savedB.assets).toEqual({});
    expect(invoke).not.toHaveBeenCalled();

    const savedA = await prepareFmd(noteAMarkdown, "/notes/note-a.smd", consentStore.policy("note-a", []));
    expect(Object.values(savedA.assets)).toEqual([remotePng]);
    expect(savedA.content).not.toContain(sharedUrl);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("passes whole-document duplicate ordinals and interpreter context to runs", async () => {
    invoke.mockImplementation(async (command: string, args: any) => {
      if (command === "run_python") return { ok: true, stdout: "42", stderr: "", images: [], provenance: { verified: true, ...args.context, interpreter: "python-3.13" } };
      return undefined;
    });
    const host = await render("```python\nprint(42)\n```\n\n```py\nprint(42)\n```");
    const buttons = [...host.querySelectorAll<HTMLButtonElement>(".python-run")];
    expect(buttons).toHaveLength(2);
    await act(async () => buttons[0].click());
    await act(async () => buttons[1].click());
    const runs = invoke.mock.calls.filter(([command]) => command === "run_python");
    expect(runs.map(([, args]) => args.context)).toEqual([
      { document: "/notes/a.md", cell: "0", interpreter: "embedded" },
      { document: "/notes/a.md", cell: "1", interpreter: "embedded" },
    ]);
  });

  it("shows legacy saved output as unverified and never auto-runs it", async () => {
    invoke.mockImplementation(async (command: string, args: any) => {
      if (command === "load_python_output") return { result: { ok: true, stdout: "legacy output", stderr: "", images: [] }, provenance: { verified: false, reason: "Legacy saved output" } };
      if (command === "run_python") return { ok: true, stdout: "new", stderr: "", images: [], provenance: { verified: true, document: args.context.document, cell: args.context.cell, interpreter: "python-3.13" } };
      return undefined;
    });
    const host = await render("```python\nprint('legacy')\n```");
    expect(host.textContent).toContain("Unverified saved output");
    expect(host.textContent).toContain("legacy output");
    expect(invoke).not.toHaveBeenCalledWith("run_python", expect.anything());
    await act(async () => host.querySelector<HTMLButtonElement>(".python-run")?.click());
    expect(invoke).toHaveBeenCalledWith("run_python", expect.objectContaining({ context: { document: "/notes/a.md", cell: "0", interpreter: "embedded" } }));
  });

  it("keeps a fresh result and figures pinned when native persistence fails", async () => {
    const image = "data:image/png;base64,iVBORw0KGgo=";
    invoke.mockImplementation(async (command: string, args: any) => {
      if (command === "run_python") return { ok: true, stdout: "fresh output", stderr: "", images: [image], provenance: { verified: false, unsaved: true, document: args.context.document, cell: args.context.cell, interpreter: "python-3.13", reason: "Could not save execution output" } };
      if (command === "cache_python_output") throw new Error("native retry rejected");
      return undefined;
    });
    const host = await render("```python\nprint('fresh')\n```");
    await act(async () => host.querySelector<HTMLButtonElement>(".python-run")?.click());
    expect(invoke).toHaveBeenCalledWith("cache_python_output", expect.objectContaining({
      source: "print('fresh')",
      context: { document: "/notes/a.md", cell: "0", interpreter: "embedded" },
      result: { ok: true, stdout: "fresh output", stderr: "", images: [image] },
    }));
    const cell = host.querySelector<HTMLElement>(".python-cell");
    expect(cell?.textContent).toContain("Output not saved");
    expect(cell?.textContent).not.toContain("Unverified saved output");
    expect(cell?.textContent).toContain("fresh output");
    expect(cell?.querySelector("img")?.getAttribute("src")).toBe(image);
    expect(cell?.getAttribute("data-output-pinned")).toBe("true");
  });

  it("yields editable note-image context menu actions when document text is selected", async () => {
    const url = `https://appassets.androidplatform.net/reader-assets/${"1".repeat(32)}?v=${"a".repeat(64)}`;
    invoke.mockResolvedValue({ url, mime: "image/png" });
    const host = document.createElement("div");
    host.className = "workspace";
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(<MarkdownPreview markdown={"Paragraph text to select\n\n![Photo](images/a.png)"} documentPath="/notes/a.md" python="" dark onChange={vi.fn()} />);
    });
    const para = host.querySelector("p")!;
    const img = host.querySelector<HTMLImageElement>(".note-image img")!;
    const originalFromPoint = document.elementFromPoint;
    document.elementFromPoint = vi.fn(() => img);
    try {
      const range = document.createRange();
      range.selectNodeContents(para);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);

      let event!: MouseEvent;
      await act(async () => {
        event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 30 });
        img.dispatchEvent(event);
      });
      expect(event.defaultPrevented).toBe(false);
      expect(document.querySelector(".media-save-menu")).toBeNull();

      selection.removeAllRanges();
      await act(async () => {
        event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 30 });
        img.dispatchEvent(event);
      });
      expect(event.defaultPrevented).toBe(true);
      const menuItems = Array.from(document.querySelectorAll(".media-save-menu [role='menuitem']")).map(el => el.textContent);
      expect(menuItems).toEqual(["Copy image", "Save as PNG", "Save original image", "Replace image", "Remove image"]);
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    } finally {
      document.elementFromPoint = originalFromPoint;
    }
  });
});
