import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as documentAnalysis from "../documentAnalysis";
import { cachedMarkdownTree } from "./CachedMarkdown";
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
});
