// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { unified } from "unified";
import remarkParse from "remark-parse";
import { parseValidatedSvg, presentSvg, svgContrastBackdrop, svgDataBackdrop, svgDataDimensions, svgDimensionsFromRoot, svgIntrinsicDimensions, svgSizingStyle } from "./svgImage";
import { remarkSvgBlocks } from "./svgBlocks";
import { DocumentAppearance } from "./documentAppearance";
import MarkdownPreview from "./components/MarkdownPreview";
import SvgDiagram from "./components/SvgDiagram";

const parse = (markdown: string) => remarkSvgBlocks()(unified().use(remarkParse).parse(markdown), { value: markdown });

describe("inline SVG", () => {
  it('keeps white transparent art visible on a dark backing without modifying its paint',()=>{
    expect(svgContrastBackdrop('<svg><path stroke="white" fill="none"/></svg>')).toBe('#222026');
    expect(svgContrastBackdrop('<svg><path stroke="black" fill="none"/></svg>')).toBe('#fdfdfc');
    expect(svgContrastBackdrop('<svg><path style="fill:#fff;stroke:none"/></svg>')).toBe('#222026');
    expect(svgContrastBackdrop('<svg><path fill="&#x23;fff" d="M0 0h4v4z"/><circle cx="8" cy="8" r="2" fill="#fff"/></svg>')).toBe('#222026');
    expect(svgDataBackdrop('data:image/svg+xml;charset=utf-8,'+encodeURIComponent('<svg><path style="fill:&#35;fff;stroke:none"/></svg>'))).toBe('#222026');
  });
  it("lifts raw svg blocks, one-line svg and untagged fences into svg blocks", () => {
    for (const markdown of [
      '<svg viewBox="0 0 10 10">\n<circle cx="5" cy="5" r="4"/>\n</svg>',
      'Before\n\n<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>\n\nAfter',
      '<svg viewBox="0 0 10 10">\n<g>\n\n<circle cx="5" cy="5" r="4"/>\n\n</g>\n</svg>',
      '```\n<svg viewBox="0 0 10 10"><rect width="4" height="4"/></svg>\n```',
      '```xml\n<?xml version="1.0"?>\n<svg viewBox="0 0 10 10"><rect width="4" height="4"/></svg>\n```',
    ]) {
      const blocks = (parse(markdown) as any).children.filter((node: any) => node.type === "code" && node.lang === "svg");
      expect(blocks, markdown).toHaveLength(1);
      expect(blocks[0].value).toMatch(/^<(?:\?xml|svg)[\s\S]*<\/svg>$/);
    }
    expect((parse("Use the `<svg>` element.") as any).children[0].type).toBe("paragraph");
  });
  it("re-inks monochrome drawings and keeps colored ones as authored", () => {
    const mono = presentSvg('<svg viewBox="0 0 10 10"><path d="M0 0h5" stroke="#000"/><circle r="2" fill="white"/></svg>', "#e6e0e9");
    expect(mono.mode).toBe("mono");
    expect(mono.svg).toContain('stroke="#e6e0e9"');
    expect(mono.svg).toContain('fill="none"');
    expect(presentSvg('<svg viewBox="0 0 10 10"><rect width="4" height="4"/></svg>', "#fff").svg).toContain('fill="#fff"');
    expect(presentSvg('<svg viewBox="0 0 10 10"><rect width="4" height="4" fill="#e4572e"/></svg>', "#fff").mode).toBe("color");
    expect(presentSvg('<svg viewBox="0 0 10 10"><rect width="10" height="10" fill="#123"/><circle r="2" fill="#000"/></svg>', "#fff").mode).toBe("own-background");
    expect(() => presentSvg('<svg><script>alert(1)</script></svg>', "#fff")).toThrow();
  });
  it("renders raw svg in notes as an image, not source text", () => {
    const html = renderToStaticMarkup(<MarkdownPreview documentPath={null} python="" dark={false} markdown={'# Shape\n\n<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>'} />);
    expect(html, html).toContain("svg-diagram");
    expect(html).not.toContain("&lt;circle");
  });
  it("rejects SMIL href animations, external CSS url() references, and invalid SVG data URIs in notes", async () => {
    expect(() => presentSvg('<svg><animate attributeName="href" to="https://evil.example"/></svg>', "#fff")).toThrow();
    expect(() => presentSvg('<svg><rect style="fill:url(/local/secret.svg#p)"/></svg>', "#fff")).toThrow();
    expect(() => presentSvg('<svg><style>.a{background:url(supermdasset://token)}</style></svg>', "#fff")).toThrow();
    expect(presentSvg('<svg viewBox="0 0 10 10"><defs><linearGradient id="g"><stop stop-color="#123"/></linearGradient></defs><rect width="4" height="4" fill="url(#g)"/></svg>', "#fff").mode).toBe("color");

    const badUri = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg"><script>evil()</script></svg>');
    const html = renderToStaticMarkup(<MarkdownPreview documentPath={null} python="" dark={false} markdown={`![Malicious](${badUri})`} />);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("evil()");

    const { createRoot } = await import("react-dom/client");
    const { act } = await import("react");
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    const prevBridge = window.SuperMD;
    window.SuperMD = {
      post: (id, command) => {
        queueMicrotask(() => {
          window.supermdReply?.(id, command === "load_asset" ? badUri : null, null);
        });
      },
    };
    const host = document.createElement("div");
    const root = createRoot(host);
    try {
      await act(async () => {
        root.render(<MarkdownPreview documentPath="/tmp/note.md" python="" dark={false} markdown="![Bad local SVG](diagram.svg)" />);
        await new Promise(resolve => setTimeout(resolve, 25));
      });
      expect(host.querySelector(".image-error")?.textContent).toContain("Image unavailable");
      expect(host.querySelector("img")).toBeNull();
    } finally {
      await act(async () => root.unmount());
      window.SuperMD = prevBridge;
    }
  });

  it("extracts intrinsic CSS-pixel dimensions and readable pan floors across authored SVG forms", () => {
    const parsedDoc = new DOMParser().parseFromString('<svg width="140" height="300" viewBox="0 0 140 300"/>', "image/svg+xml");
    expect(svgDimensionsFromRoot(parsedDoc.documentElement)).toEqual({ width: 140, height: 300 });
    expect(svgDimensionsFromRoot(document.createElement("div"))).toBeNull();
    expect(parseValidatedSvg('<svg viewBox="0 0 140 300"/>').dimensions).toEqual({ width: 140, height: 300 });

    // Small portrait explicit and viewBox-only SVGs keep compact dimensions and zero pan floor.
    expect(svgIntrinsicDimensions('<svg width="140" height="300"/>')).toEqual({ width: 140, height: 300 });
    expect(svgIntrinsicDimensions('<svg viewBox="0 0 140 300"/>')).toEqual({ width: 140, height: 300 });
    expect(svgSizingStyle(svgIntrinsicDimensions('<svg viewBox="0 0 140 300"/>'))).toEqual({
      "--svg-width": "140px",
      "--svg-min-width": "0px",
    });

    // Normalized tiny viewBox scales major axis < 64px up to 240px.
    expect(svgIntrinsicDimensions('<svg viewBox="0 0 10 10"/>')).toEqual({ width: 240, height: 240 });
    expect(svgIntrinsicDimensions('<svg viewBox="0 0 20 40"/>')).toEqual({ width: 120, height: 240 });

    // Physical CSS units, inline styles, percentage/auto fallbacks, and single-axis aspect derivation.
    expect(svgIntrinsicDimensions('<svg width="72pt" height="1in"/>')).toEqual({ width: 96, height: 96 });
    expect(svgIntrinsicDimensions('<svg width="25.4mm" height="2.54cm"/>')).toEqual({ width: 96, height: 96 });
    expect(svgIntrinsicDimensions('<svg style="width: 320px; height: 160px !important"/>')).toEqual({ width: 320, height: 160 });
    expect(svgIntrinsicDimensions('<svg width="100%" height="auto" viewBox="0 0 640 240"/>')).toEqual({ width: 640, height: 240 });
    expect(svgIntrinsicDimensions('<svg width="300" viewBox="0 0 150 75"/>')).toEqual({ width: 300, height: 150 });
    expect(svgIntrinsicDimensions('<svg height="200" viewBox="0 0 400 100"/>')).toEqual({ width: 800, height: 200 });

    // Wide sequence Mermaid (pele and fallback mermaid) and wide standalone SVG get readable pan floors, while 4:3 figures shrink cleanly.
    const peleSeq = svgIntrinsicDimensions('<svg width="1284" height="463" data-diagram-engine="pele"/>');
    expect(peleSeq).toEqual({ width: 1284, height: 463, engine: "pele" });
    expect(svgSizingStyle(peleSeq)).toEqual({ "--svg-width": "1284px", "--svg-min-width": "1027px" });

    const fallbackSeq = svgIntrinsicDimensions('<svg width="1100" height="420" data-diagram-engine="mermaid"/>');
    expect(fallbackSeq).toEqual({ width: 1100, height: 420, engine: "mermaid" });
    expect(svgSizingStyle(fallbackSeq)).toEqual({ "--svg-width": "1100px", "--svg-min-width": "880px" });

    expect(svgSizingStyle(svgIntrinsicDimensions('<svg width="1200" height="300"/>'))).toEqual({
      "--svg-width": "1200px",
      "--svg-min-width": "960px",
    });
    expect(svgSizingStyle(svgIntrinsicDimensions('<svg width="800" height="600"/>'))).toEqual({
      "--svg-width": "800px",
      "--svg-min-width": "0px",
    });

    // Data URIs (URL-encoded + UTF-8 base64) and invalid inputs.
    const utf8Svg = '<svg xmlns="http://www.w3.org/2000/svg" width="420" height="180"><text>αβγ</text></svg>';
    const b64Bytes = new TextEncoder().encode(utf8Svg);
    const b64 = btoa(String.fromCharCode(...b64Bytes));
    expect(svgDataDimensions(`data:image/svg+xml;base64,${b64}`)).toEqual({ width: 420, height: 180 });
    expect(svgDataDimensions(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(utf8Svg)}`)).toEqual({ width: 420, height: 180 });
    expect(svgDataDimensions("data:image/png;base64,AAAA")).toBeNull();
    expect(svgDataDimensions("data:image/svg+xml;base64,%%%")).toBeNull();
    expect(svgIntrinsicDimensions('<svg xmlns="http://evil.example/ns" width="140" height="300"/>')).toBeNull();
    expect(svgIntrinsicDimensions("<svg/>")).toBeNull();
    expect(svgSizingStyle(null)).toBeUndefined();
  });

  it("reuses the validated SVG document across SvgDiagram and MarkdownPreview theme variants and intrinsic sizing without reparsing", async () => {
    const { createRoot } = await import("react-dom/client");
    const { act } = await import("react");
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    const syntheticSvg = '<svg viewBox="0 0 300 200"><style>.node{fill:#f8fafc!important;stroke:#374151}.series{fill:none;stroke:#2563eb}.label{fill:#111827}</style><rect class="node" x="50" y="50" width="100" height="60"/><path class="series" d="M20 160L260 40"/><text class="label" x="100" y="80">Root</text></svg>';
    const authoredBytes = syntheticSvg;
    const rawDataUri = `data:image/svg+xml;base64,${btoa(syntheticSvg)}`;
    const darkColors = { surface: "#211d2d", primary: "#dfb1e0", text: "#f2e9f4" };
    const host = document.createElement("div");
    const root = createRoot(host);
    const parseSpy = vi.spyOn(DOMParser.prototype, "parseFromString");
    const serializeSpy = vi.spyOn(XMLSerializer.prototype, "serializeToString");
    try {
      parseSpy.mockClear();
      serializeSpy.mockClear();
      await act(async () => {
        root.render(<SvgDiagram source={syntheticSvg} appearance="auto" colors={darkColors} dark preserveOriginal />);
      });
      expect(parseSpy).toHaveBeenCalledTimes(1);
      expect(serializeSpy).toHaveBeenCalledTimes(1);
      const diagramImg = host.querySelector<HTMLImageElement>("img")!;
      expect(diagramImg.getAttribute("data-svg-sized")).toBe("true");
      expect(diagramImg.style.getPropertyValue("--svg-width")).toBe("300px");
      expect(diagramImg.style.getPropertyValue("--svg-min-width")).toBe("0px");
      const autoDecoded = decodeURIComponent((diagramImg.getAttribute("src") ?? "").split(",")[1]);
      expect(autoDecoded).toContain('xmlns="http://www.w3.org/2000/svg"');
      expect(autoDecoded).toContain('fill="#211d2d"');
      expect(autoDecoded).not.toContain('stroke="#dfb1e0" style="fill: none !important; stroke: rgb(223, 177, 224) !important;"');

      parseSpy.mockClear();
      serializeSpy.mockClear();
      await act(async () => {
        root.render(<SvgDiagram source={syntheticSvg} appearance="monochrome" colors={darkColors} dark preserveOriginal />);
      });
      expect(parseSpy).not.toHaveBeenCalled();
      expect(serializeSpy).toHaveBeenCalledTimes(1);
      const monoDecoded = decodeURIComponent((host.querySelector("img")?.getAttribute("src") ?? "").split(",")[1]);
      expect(monoDecoded).not.toBe(autoDecoded);
      expect(monoDecoded).toContain('stroke="#dfb1e0"');

      parseSpy.mockClear();
      serializeSpy.mockClear();
      await act(async () => {
        root.render(<SvgDiagram source={syntheticSvg} appearance="contrast" colors={darkColors} dark preserveOriginal />);
      });
      expect(parseSpy).not.toHaveBeenCalled();
      expect(serializeSpy).toHaveBeenCalledTimes(1);
      const contrastImg = host.querySelector("img");
      const contrastDecoded = decodeURIComponent((contrastImg?.getAttribute("src") ?? "").split(",")[1]);
      expect(contrastDecoded).toContain('xmlns="http://www.w3.org/2000/svg"');
      expect(contrastDecoded).toContain(".node{fill:#f8fafc!important;stroke:#374151}");
      expect(contrastDecoded).not.toContain('fill="#211d2d"');

      parseSpy.mockClear();
      serializeSpy.mockClear();
      await act(async () => {
        root.render(<SvgDiagram source={syntheticSvg} appearance="original" colors={darkColors} dark preserveOriginal />);
      });
      expect(parseSpy).not.toHaveBeenCalled();
      expect(serializeSpy).not.toHaveBeenCalled();
      expect(decodeURIComponent((host.querySelector("img")?.getAttribute("src") ?? "").split(",")[1])).toBe(contrastDecoded);
      expect(syntheticSvg).toBe(authoredBytes);

      parseSpy.mockClear();
      serializeSpy.mockClear();
      await act(async () => {
        root.render(
          <DocumentAppearance.Provider value={{ dark: true, svgAppearance: "auto", ink: "#dfb1e0", text: "#f2e9f4", colors: darkColors }}>
            <MarkdownPreview documentPath={null} python="" dark markdown={`![Synthetic](${rawDataUri})`} />
          </DocumentAppearance.Provider>,
        );
      });
      expect(parseSpy).toHaveBeenCalledTimes(1);
      expect(serializeSpy).toHaveBeenCalledTimes(1);
      const noteImg = host.querySelector<HTMLImageElement>("img")!;
      expect(noteImg.getAttribute("data-media-adapted")).toBe("true");
      act(() => { noteImg.dispatchEvent(new Event("load")); });
      const noteWrapper = host.querySelector<HTMLElement>(".note-image--diagram")!;
      expect(noteWrapper.getAttribute("data-svg-sized")).toBe("true");
      expect(noteWrapper.style.getPropertyValue("--svg-width")).toBe("300px");
      expect(noteWrapper.style.getPropertyValue("--svg-min-width")).toBe("0px");

      parseSpy.mockClear();
      serializeSpy.mockClear();
      await act(async () => {
        root.render(
          <DocumentAppearance.Provider value={{ dark: true, svgAppearance: "monochrome", ink: "#dfb1e0", text: "#f2e9f4", colors: darkColors }}>
            <MarkdownPreview documentPath={null} python="" dark markdown={`![Synthetic](${rawDataUri})`} />
          </DocumentAppearance.Provider>,
        );
      });
      expect(parseSpy).not.toHaveBeenCalled();
      expect(serializeSpy).toHaveBeenCalledTimes(1);

      parseSpy.mockClear();
      serializeSpy.mockClear();
      await act(async () => {
        root.render(
          <DocumentAppearance.Provider value={{ dark: true, svgAppearance: "contrast", ink: "#dfb1e0", text: "#f2e9f4", colors: darkColors }}>
            <MarkdownPreview documentPath={null} python="" dark markdown={`![Synthetic](${rawDataUri})`} />
          </DocumentAppearance.Provider>,
        );
      });
      expect(parseSpy).not.toHaveBeenCalled();
      expect(serializeSpy).not.toHaveBeenCalled();
      expect(host.querySelector("img")?.getAttribute("src")).toBe(rawDataUri);
    } finally {
      parseSpy.mockRestore();
      serializeSpy.mockRestore();
      await act(async () => root.unmount());
    }
  });

  it("matches plain and XML character-escaped white paint across SvgDiagram and MarkdownPreview in one parse", async () => {
    const { createRoot } = await import("react-dom/client");
    const { act } = await import("react");
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    const plainSvg = '<svg viewBox="0 0 100 100"><path d="M10 10 C 20 0, 30 0, 40 10 Z" fill="#fff"/><circle cx="70" cy="50" r="15" fill="#fff"/></svg>';
    const escapedSvg = '<svg viewBox="0 0 100 100"><path d="M10 10 C 20 0, 30 0, 40 10 Z" fill="&#x23;fff"/><circle cx="70" cy="50" r="15" fill="#fff"/></svg>';
    const lightColors = { surface: "#f0e1d0", primary: "#80502d", text: "#1c2635" };
    const plainHost = document.createElement("div");
    const escapedHost = document.createElement("div");
    const plainRoot = createRoot(plainHost);
    const escapedRoot = createRoot(escapedHost);
    const parseSpy = vi.spyOn(DOMParser.prototype, "parseFromString");
    try {
      parseSpy.mockClear();
      await act(async () => {
        plainRoot.render(<SvgDiagram source={plainSvg} appearance="auto" colors={lightColors} preserveOriginal />);
        escapedRoot.render(<SvgDiagram source={escapedSvg} appearance="auto" colors={lightColors} preserveOriginal />);
      });
      expect(parseSpy).toHaveBeenCalledTimes(2);
      const plainImg = plainHost.querySelector("img")!;
      const escapedImg = escapedHost.querySelector("img")!;
      expect(escapedImg.getAttribute("data-light-ink")).toBe("true");
      expect(escapedImg.getAttribute("src")).toBe(plainImg.getAttribute("src"));

      parseSpy.mockClear();
      await act(async () => {
        plainRoot.render(<SvgDiagram source={plainSvg} appearance="contrast" colors={lightColors} preserveOriginal />);
        escapedRoot.render(<SvgDiagram source={escapedSvg} appearance="contrast" colors={lightColors} preserveOriginal />);
      });
      expect(parseSpy).not.toHaveBeenCalled();
      expect(escapedHost.querySelector("img")!.style.backgroundColor).toBe("rgb(34, 32, 38)");
      expect(escapedHost.querySelector("img")!.getAttribute("src")).toBe(plainHost.querySelector("img")!.getAttribute("src"));

      const plainUri = `data:image/svg+xml;base64,${btoa(plainSvg)}`;
      const escapedUri = `data:image/svg+xml;base64,${btoa(escapedSvg)}`;
      parseSpy.mockClear();
      await act(async () => {
        plainRoot.render(
          <DocumentAppearance.Provider value={{ dark: false, svgAppearance: "auto", ink: "#80502d", text: "#1c2635", colors: lightColors }}>
            <MarkdownPreview documentPath={null} python="" dark={false} markdown={`![Plain](${plainUri})`} />
          </DocumentAppearance.Provider>,
        );
        escapedRoot.render(
          <DocumentAppearance.Provider value={{ dark: false, svgAppearance: "auto", ink: "#80502d", text: "#1c2635", colors: lightColors }}>
            <MarkdownPreview documentPath={null} python="" dark={false} markdown={`![Escaped](${escapedUri})`} />
          </DocumentAppearance.Provider>,
        );
      });
      expect(parseSpy).toHaveBeenCalledTimes(2);
      const plainNoteImg = plainHost.querySelector("img")!;
      const escapedNoteImg = escapedHost.querySelector("img")!;
      expect(escapedNoteImg.getAttribute("data-light-ink")).toBe("true");
      expect(escapedNoteImg.style.getPropertyValue("--svg-contrast-backing")).toBe("#222026");
      expect(escapedNoteImg.getAttribute("src")).toBe(plainNoteImg.getAttribute("src"));
    } finally {
      parseSpy.mockRestore();
      await act(async () => {
        plainRoot.unmount();
        escapedRoot.unmount();
      });
    }
  });
});
