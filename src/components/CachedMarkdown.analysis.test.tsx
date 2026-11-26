import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as documentAnalysis from "../documentAnalysis";
import { cachedMarkdownTree } from "./CachedMarkdown";
import MarkdownPreview, { PREVIEW_REHYPE_PLUGINS, PREVIEW_REMARK_PLUGINS } from "./MarkdownPreview";
import { readerSourceAnalysis } from "../readerSourceAnalysis";

afterEach(() => vi.restoreAllMocks());

describe("CachedMarkdown supplied source analysis", () => {
  let source: string;
  let sourceAnalysis: ReturnType<typeof readerSourceAnalysis>;

  beforeAll(() => {
    source = `# Oversized synthetic note\n\n${"Readable generated paragraph text. ".repeat(62_000)}`;
    sourceAnalysis = readerSourceAnalysis("reader", source);
  }, 30_000);

  it("uses matching oversized analysis without a second parse in headless tree construction", () => {
    const parse = vi.spyOn(documentAnalysis, "analyzeDocument");

    expect(sourceAnalysis?.source).toBe(source);
    expect(sourceAnalysis?.analysis.outline[0]?.title).toBe("Oversized synthetic note");
    const tree = cachedMarkdownTree(source, [], [], false, sourceAnalysis ?? undefined);

    expect(parse).not.toHaveBeenCalled();
    expect(tree.children.find((node:any)=>node.type==="element"&&node.tagName==="h1")).toBeDefined();
    const paragraph=tree.children.find((node:any)=>node.type==="element"&&node.tagName==="p") as any;
    expect(paragraph).toBeDefined();
    const expectedText=source.slice(source.indexOf("Readable generated paragraph text.")),renderedText=paragraph.children.map((node:any)=>node.value??"").join("");
    expect(renderedText.length).toBe(expectedText.trimEnd().length);
    expect(renderedText.startsWith("Readable generated paragraph text.")).toBe(true);
    expect(renderedText.endsWith("Readable generated paragraph text.")).toBe(true);
  });

  it("does not create a main-thread analysis for Live or Source modes", () => {
    const parse = vi.spyOn(documentAnalysis, "analyzeDocument");

    expect(readerSourceAnalysis("live", "# Live source")).toBeNull();
    expect(readerSourceAnalysis("editor", "# Editor source")).toBeNull();
    expect(parse).not.toHaveBeenCalled();
  });

  it("shares the exact Split source and outline without a second parse", () => {
    const source = "# Split analysis handoff\n\n## Current heading\n\n- [ ] Retain task offsets.\n";
    const parse = vi.spyOn(documentAnalysis, "analyzeDocument");
    const sourceAnalysis = readerSourceAnalysis("split", source);

    expect(sourceAnalysis?.source).toBe(source);
    expect(sourceAnalysis?.analysis.outline.map(entry => entry.title)).toEqual(["Split analysis handoff", "Current heading"]);
    cachedMarkdownTree(source, [], [], false, sourceAnalysis ?? undefined);
    expect(parse).toHaveBeenCalledOnce();
    expect(sourceAnalysis?.analysis.tasks).toEqual([source.indexOf("[ ]") + 1]);
  });

  it("falls back to analysis when the supplied source does not match", () => {
    const source = "# Supplied-source mismatch fallback 2026";
    const staleSourceAnalysis = {
      source: "# Different stale source 2026",
      analysis: documentAnalysis.analyzeDocument("# Different stale source 2026"),
    };
    const parse = vi.spyOn(documentAnalysis, "analyzeDocument");

    cachedMarkdownTree(source, [], [], false, staleSourceAnalysis);

    expect(parse).toHaveBeenCalledOnce();
    expect(parse).toHaveBeenCalledWith(source);
  });

  it("renders identical preview output from supplied source analysis without invoking source parsing in CachedMarkdown", () => {
    const richSource = [
      "---",
      "title: Supplied Source Parity",
      "---",
      "",
      "# Analysis Heading",
      "",
      "> [!note] Callout with $x^2 + y^2 = z^2$",
      "> Highlight ==term==, H~2~O, 10^3^, and <kbd onclick=\"alert(1)\">Esc</kbd><br/>line two.",
      "",
      "| Col | Math |",
      "| --- | --- |",
      "| Val | $P(X | Y)$ |",
      "",
      "- [ ] Task with [ref][target] and footnote[^n1]",
      "",
      "<script>alert('xss')</script>",
      "",
      "![Dot](data:image/png;base64,iVBORw0KGgo=) ![Vector](data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=) ![HtmlImg](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
      "",
      "[Relative](./notes/chapter-2.md#summary) [Anchor](#analysis-heading) [Mail](mailto:reader@example.org) [Unsafe](javascript:alert(1)) [UnsafeVb](vbscript:msgbox(1)) [UnsafeData](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
      "",
      "```python",
      "total = 40 + 2",
      "```",
      "",
      "[target]: https://example.org/parity",
      "[^n1]: Footnote from pre-parsed tree.",
    ].join("\n");

    const supplied = readerSourceAnalysis("reader", richSource)!;
    const parse = vi.spyOn(documentAnalysis, "analyzeDocument");

    let registeredParser: unknown = "unset";
    const inspectProcessor = function (this: { parser?: unknown }) {
      registeredParser = this.parser;
    };

    const treeFromSupplied = cachedMarkdownTree(
      richSource,
      [inspectProcessor, ...PREVIEW_REMARK_PLUGINS],
      PREVIEW_REHYPE_PLUGINS,
      false,
      supplied,
    );
    expect(registeredParser).toBeUndefined();
    expect(parse).not.toHaveBeenCalled();

    const htmlFromSupplied = renderToStaticMarkup(
      <MarkdownPreview
        markdown={richSource}
        documentPath={null}
        python="python3"
        dark={false}
        sourceAnalysis={supplied}
      />,
    );
    expect(parse).not.toHaveBeenCalled();

    const freshVariant = richSource.replace("Supplied Source Parity", "Fresh Source Parity");
    const htmlFreshWithSupplied = renderToStaticMarkup(
      <MarkdownPreview
        markdown={freshVariant}
        documentPath={null}
        python="python3"
        dark={false}
        sourceAnalysis={readerSourceAnalysis("split", freshVariant) ?? undefined}
      />,
    );
    expect(parse).toHaveBeenCalledOnce();

    const htmlWithoutSupplied = renderToStaticMarkup(
      <MarkdownPreview
        markdown={richSource}
        documentPath={null}
        python="python3"
        dark={false}
      />,
    );
    expect(htmlFromSupplied).toBe(htmlWithoutSupplied);
    expect(treeFromSupplied.children.length).toBeGreaterThan(0);
    expect(htmlFromSupplied).toContain("Supplied Source Parity");
    expect(htmlFreshWithSupplied).toContain("Fresh Source Parity");
    expect(htmlFromSupplied).toContain('class="callout callout-note"');
    expect(htmlFromSupplied).toContain("<mark>term</mark>");
    expect(htmlFromSupplied).toContain("<kbd>Esc</kbd><br/>line two.");
    expect(htmlFromSupplied).not.toContain("onclick");
    expect(htmlFromSupplied).not.toContain("javascript:");
    expect(htmlFromSupplied).not.toContain("vbscript:");
    expect(htmlFromSupplied).not.toContain("data:text/html");
    expect(htmlFromSupplied).not.toContain("<script");
    expect(htmlFromSupplied).toContain('src="data:image/png;base64,iVBORw0KGgo="');
    expect(htmlFromSupplied).toContain('src="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4="');
    expect(htmlFromSupplied).toContain('href="./notes/chapter-2.md#summary"');
    expect(htmlFromSupplied).toContain('href="#analysis-heading"');
    expect(htmlFromSupplied).toContain('href="mailto:reader@example.org"');
    expect(htmlFromSupplied).toContain('href="https://example.org/parity"');
    expect(htmlFromSupplied).toContain("Footnote from pre-parsed tree.");
    expect(htmlFromSupplied).toContain('class="python-cell"');
  });
});
