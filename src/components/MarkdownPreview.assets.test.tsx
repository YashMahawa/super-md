// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../nativeBridge", () => ({ invoke }));
import MarkdownPreview from "./MarkdownPreview";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | null = null;
afterEach(() => {
  if (root) { act(() => root?.unmount()); root = null; }
  document.body.innerHTML = "";
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

  it("preserves the legacy SVG data loader for structural recoloring", async () => {
    const svg = "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=";
    invoke.mockRejectedValueOnce(new Error("SVG images use the safe data loader"));
    invoke.mockResolvedValueOnce(svg);
    const host = await render("![Vector](images/a.svg)");
    expect(invoke).toHaveBeenNthCalledWith(1, "resolve_reader_asset", { documentPath: "/notes/a.md", source: "images/a.svg" });
    expect(invoke).toHaveBeenNthCalledWith(2, "load_asset", { documentPath: "/notes/a.md", source: "images/a.svg" });
    expect(host.querySelector("img")?.getAttribute("src")).toBe(svg);
  });

  it("falls back if a native response is malformed or outside the approved origin", async () => {
    invoke.mockResolvedValueOnce({ url: "https://example.org/a.png", mime: "image/png" });
    invoke.mockResolvedValueOnce("data:image/png;base64,iVBORw0KGgo=");
    const host = await render("![Raster](images/a.png)");
    expect(invoke).toHaveBeenNthCalledWith(2, "load_asset", { documentPath: "/notes/a.md", source: "images/a.png" });
    expect(host.querySelector("img")?.getAttribute("src")).toMatch(/^data:image\/png;base64,/);
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
});
