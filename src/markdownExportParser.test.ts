// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

const { native } = vi.hoisted(() => ({ native: vi.fn() }));
vi.mock("./nativeBridge", () => ({ invoke: native }));

import { compatibleMarkdown } from "./compatibleMarkdown";
import { imageRanges, prepareFmd } from "./documentMedia";
import { prepareMarkdownExport } from "./markdownExport";
import { markdownExportParser, parseMaskedMarkdown } from "./markdownExportParser";

afterEach(() => {
  native.mockReset();
});

describe("shared frozen parse-only Markdown export processor", () => {
  it("freezes one parse-only processor and preserves frontmatter masking and exact UTF-16 source positions across repeated parses", () => {
    expect(() => (markdownExportParser as any).use(() => {})).toThrow(/frozen/i);
    expect(() => (markdownExportParser as any).stringify({ type: "root", children: [] })).toThrow(/stringify/i);

    const source = [
      "\uFEFF---",
      'title: "😀 ![Frontmatter Fake](ignored.png)"',
      'summary: "[hero]: ignored-frontmatter.png"',
      "---",
      "",
      "$$a = 1 + 2",
      "= 3$$",
      "",
      "Keep ~single~ tilde text and ~~struck~~ text.",
      "",
      "![Inline Around Frontmatter](assets/import-inline.png)",
      "",
      "```{.mermaid, fig-width=6}",
      "flowchart LR",
      '  A["![Fence Fake](ignored-in-fence.png)"] --> B',
      "```",
      "",
      "![Referenced Around Braced Fence][hero]",
      "",
      '[hero]: media/hero.svg "Hero diagram"',
      "",
    ].join("\n");

    const first = parseMaskedMarkdown(source);
    const second = parseMaskedMarkdown(source);
    expect(first.tree).not.toBe(second.tree);
    expect(first.masked).toHaveLength(source.length);

    const inlineText = "![Inline Around Frontmatter](assets/import-inline.png)";
    const bracedFenceText = [
      "```{.mermaid, fig-width=6}",
      "flowchart LR",
      '  A["![Fence Fake](ignored-in-fence.png)"] --> B',
      "```",
    ].join("\n");
    const refImageText = "![Referenced Around Braced Fence][hero]";
    const definitionText = '[hero]: media/hero.svg "Hero diagram"';

    const nodes = first.tree.children as any[];
    const inlinePara = nodes.find(
      node => node.type === "paragraph" && node.children?.[0]?.type === "image",
    );
    const bracedCode = nodes.find(node => node.type === "code");
    const refPara = nodes.find(
      node => node.type === "paragraph" && node.children?.[0]?.type === "imageReference",
    );
    const defNode = nodes.find(node => node.type === "definition");

    expect(inlinePara?.children[0]?.position.start.offset).toBe(source.indexOf(inlineText));
    expect(inlinePara?.children[0]?.position.end.offset).toBe(source.indexOf(inlineText) + inlineText.length);
    expect(bracedCode?.position.start.offset).toBe(source.indexOf(bracedFenceText));
    expect(bracedCode?.position.end.offset).toBe(source.indexOf(bracedFenceText) + bracedFenceText.length);
    expect(refPara?.children[0]?.position.start.offset).toBe(source.indexOf(refImageText));
    expect(refPara?.children[0]?.position.end.offset).toBe(source.indexOf(refImageText) + refImageText.length);
    expect(defNode?.position.start.offset).toBe(source.indexOf(definitionText));
    expect(defNode?.position.end.offset).toBe(source.indexOf(definitionText) + definitionText.length);
  });

  it("covers an inline image and a referenced image around frontmatter and a braced fence while preserving consent and rewrite behavior across exports", async () => {
    const inlinePng = `data:image/png;base64,${btoa("inline-png")}`;
    const refSvg = `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/></svg>')}`;
    const trustedPng = `data:image/png;base64,${btoa("trusted-remote-png")}`;

    native.mockImplementation(async (command: string, args: { source?: string; url?: string }) => {
      if (command === "load_asset" && args.source === "assets/import-inline.png") return inlinePng;
      if (command === "load_asset" && args.source === "assets/image-ref.svg") return refSvg;
      if (command === "fetch_resource" && args.url === "https://trusted.example/approved.png") {
        return { body: trustedPng };
      }
      if (command === "load_python_output") return null;
      throw new Error(`Unexpected native call: ${command} ${JSON.stringify(args)}`);
    });

    const frontmatter = [
      "---",
      'title: "😀 Study Export"',
      'hero: "![Frontmatter Fake](../secret.png)"',
      'notes: "[ref-fig]: ../frontmatter-def.svg"',
      "---",
    ].join("\n");

    const bracedMermaid = [
      "```{.mermaid, fig-width=6}",
      "flowchart LR",
      '  Start["![Fence Fake](../fence-secret.png)"] --> Finish["[ref-fig]: ../fence-def.svg"]',
      "```",
    ].join("\n");

    const bracedPython = [
      "```{python, echo=false}",
      'banner = "![Py Fake](../py-secret.png)"',
      "```",
    ].join("\n");

    const markdown = [
      frontmatter,
      "",
      "$$x = 1",
      "+ 2$$",
      "",
      "Before fence ~approx~ ![Inline Figure](assets/import-inline.png) and unapproved ![Blocked](https://untrusted.example/blocked.png).",
      "",
      bracedMermaid,
      "",
      bracedPython,
      "",
      "After braced fence ![Referenced Figure][ref-fig] and ![Approved Remote](https://trusted.example/approved.png).",
      "",
      '[ref-fig]: assets/image-ref.svg "Vector caption"',
      "",
    ].join("\n");

    const parseSpy = vi.spyOn(markdownExportParser, "parse");

    // 1. Editable image ranges: exact source slices around frontmatter and braced fences, ignoring frontmatter/fence literals.
    const ranges = imageRanges(markdown);
    expect(ranges.map(r => ({ source: r.source, slice: markdown.slice(r.from, r.to) }))).toEqual([
      { source: "assets/import-inline.png", slice: "![Inline Figure](assets/import-inline.png)" },
      { source: "https://untrusted.example/blocked.png", slice: "![Blocked](https://untrusted.example/blocked.png)" },
      { source: "assets/image-ref.svg", slice: "![Referenced Figure][ref-fig]" },
      { source: "https://trusted.example/approved.png", slice: "![Approved Remote](https://trusted.example/approved.png)" },
    ]);

    // 2. Plain companion Markdown export: never fetches remote URLs, keeps braced fences verbatim, rewrites generated inline + referenced images.
    const plain = await prepareMarkdownExport(markdown, "/notes/lecture.md", { compatible: false });
    expect(plain.content.startsWith(`${frontmatter}\n\n`)).toBe(true);
    expect(plain.content).toContain("Before fence ~approx~ ![Inline Figure](<image1.png>) and unapproved ![Blocked](https://untrusted.example/blocked.png).");
    expect(plain.content).toContain(bracedMermaid);
    expect(plain.content).toContain(bracedPython);
    expect(plain.content).toContain("After braced fence ![Referenced Figure](<image2.svg>) and ![Approved Remote](https://trusted.example/approved.png).");
    expect(plain.content).not.toContain("[ref-fig]: assets/image-ref.svg");
    expect(plain.assets).toEqual({
      "image1.png": inlinePng,
      "image2.svg": refSvg,
    });
    expect(native).not.toHaveBeenCalledWith("fetch_resource", expect.anything());

    // 3. Compatible Markdown export: flattens #113 braced Mermaid and Python fences while keeping frontmatter, exact slices, and unfetched remotes.
    native.mockClear();
    const compatible = await prepareMarkdownExport(markdown, "/notes/lecture.md", { compatible: true });
    expect(compatible.content.startsWith(`${frontmatter}\n\n`)).toBe(true);
    expect(compatible.content).toContain("Before fence ~approx~ ![Inline Figure](<image1.png>) and unapproved ![Blocked](https://untrusted.example/blocked.png).");
    expect(compatible.content).toContain(
      [
        "```mermaid",
        "flowchart LR",
        '  Start["![Fence Fake](../fence-secret.png)"] --> Finish["[ref-fig]: ../fence-def.svg"]',
        "```",
      ].join("\n"),
    );
    expect(compatible.content).toContain(
      [
        "```python",
        'banner = "![Py Fake](../py-secret.png)"',
        "```",
      ].join("\n"),
    );
    expect(compatible.content).not.toContain("{.mermaid");
    expect(compatible.content).not.toContain("{python");
    expect(compatible.content).toContain("After braced fence ![Referenced Figure](<image2.svg>) and ![Approved Remote](https://trusted.example/approved.png).");
    expect(compatible.assets).toEqual({
      "image1.png": inlinePng,
      "image2.svg": refSvg,
    });
    expect(native).not.toHaveBeenCalledWith("fetch_resource", expect.anything());

    const flattenedOnly = await compatibleMarkdown(markdown, "/notes/lecture.md");
    expect(flattenedOnly.startsWith(`${frontmatter}\n\n`)).toBe(true);

    // 4. Portable .smd/.fmd packaging: enforces remote-image consent, keeps braced fences and frontmatter intact, and rewrites inline + definition targets in place.
    native.mockClear();
    const portable = await prepareFmd(markdown, "/notes/lecture.md", {
      trustedImageHosts: ["trusted.example"],
    });
    expect(portable.content.startsWith(`${frontmatter}\n\n`)).toBe(true);
    expect(portable.content).toContain(bracedMermaid);
    expect(portable.content).toContain(bracedPython);
    expect(portable.content).toContain("![Inline Figure](<assets/import-inline.png>)");
    expect(portable.content).toContain("![Blocked](https://untrusted.example/blocked.png)");
    expect(portable.content).toContain("![Referenced Figure][ref-fig]");
    expect(portable.content).toMatch(/!\[Approved Remote\]\(<assets\/image-[a-z0-9-]+\.png>\)/i);
    expect(portable.content).toMatch(/\[ref-fig\]: <assets\/image-[a-z0-9-]+\.svg> "Vector caption"/i);
    expect(native.mock.calls.filter(([cmd]) => cmd === "fetch_resource")).toEqual([
      ["fetch_resource", { url: "https://trusted.example/approved.png", image: true }],
    ]);
    expect(Object.values(portable.assets).sort()).toEqual([inlinePng, refSvg, trustedPng].sort());

    // Confirm all four export paths reused the single frozen markdownExportParser instance.
    expect(parseSpy.mock.calls.length).toBeGreaterThanOrEqual(5);
    parseSpy.mockRestore();
  });

  it("handles a referenced image between frontmatter and a braced fence followed by a named inline image after the braced fence", async () => {
    const namedInlineSvg = `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 20"><rect width="40" height="20"/></svg>')}`;
    const generatedRefPng = `data:image/png;base64,${btoa("ref-before-fence")}`;

    native.mockImplementation(async (command: string, args: { source?: string }) => {
      if (command === "load_asset" && args.source === "assets/import-before-fence.png") return generatedRefPng;
      if (command === "load_asset" && args.source === "diagrams/after-fence.svg") return namedInlineSvg;
      if (command === "load_python_output") return null;
      throw new Error(`Unexpected native call: ${command} ${JSON.stringify(args)}`);
    });

    const markdown = [
      "---",
      "title: Reverse Layout",
      "tags: [export, parser]",
      "...",
      "",
      "![Lead Referenced Figure][lead-fig]",
      "",
      "```{.py}",
      'x = "![Ignored Inside Braced Py](assets/ignored.png)"',
      "```",
      "",
      "![Named Inline SVG](diagrams/after-fence.svg)",
      "",
      "[lead-fig]: assets/import-before-fence.png",
      "",
    ].join("\n");

    expect(imageRanges(markdown).map(r => ({ source: r.source, slice: markdown.slice(r.from, r.to) }))).toEqual([
      { source: "assets/import-before-fence.png", slice: "![Lead Referenced Figure][lead-fig]" },
      { source: "diagrams/after-fence.svg", slice: "![Named Inline SVG](diagrams/after-fence.svg)" },
    ]);

    const plain = await prepareMarkdownExport(markdown, "/notes/reverse.md", { compatible: false });
    expect(plain.content).toContain("![Lead Referenced Figure](<image1.png>)");
    expect(plain.content).toContain("```{.py}\nx = \"![Ignored Inside Braced Py](assets/ignored.png)\"\n```");
    expect(plain.content).toContain("![Named Inline SVG](diagrams/after-fence.svg)");
    expect(plain.content).not.toContain("[lead-fig]:");
    expect(plain.assets).toEqual({
      "image1.png": generatedRefPng,
      "diagrams/after-fence.svg": namedInlineSvg,
    });

    const compatible = await prepareMarkdownExport(markdown, "/notes/reverse.md", { compatible: true });
    expect(compatible.content).toContain("![Lead Referenced Figure](<image1.png>)");
    expect(compatible.content).toContain("```py\nx = \"![Ignored Inside Braced Py](assets/ignored.png)\"\n```");
    expect(compatible.content).toContain("![Named Inline SVG](diagrams/after-fence.svg)");

    const portable = await prepareFmd(markdown, "/notes/reverse.md");
    expect(portable.content).toContain("[lead-fig]: <assets/import-before-fence.png>");
    expect(portable.content).toMatch(/!\[Named Inline SVG\]\(<assets\/image-[a-z0-9-]+\.svg>\)/i);
  });
});
