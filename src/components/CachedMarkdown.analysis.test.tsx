import { afterEach, describe, expect, it, vi } from "vitest";
import * as documentAnalysis from "../documentAnalysis";
import { cachedMarkdownTree } from "./CachedMarkdown";
import { readerSourceAnalysis } from "../readerSourceAnalysis";

afterEach(() => vi.restoreAllMocks());

describe("CachedMarkdown supplied source analysis", () => {
  it("uses matching oversized analysis instead of parsing the source again", () => {
    const source = `# Oversized synthetic note\n\n${"Readable generated paragraph text. ".repeat(62_000)}`;
    const parse = vi.spyOn(documentAnalysis, "analyzeDocument");
    const sourceAnalysis = readerSourceAnalysis("reader", source);

    expect(sourceAnalysis?.source).toBe(source);
    expect(sourceAnalysis?.analysis.outline[0]?.title).toBe("Oversized synthetic note");
    cachedMarkdownTree(source, [], [], false, sourceAnalysis ?? undefined);

    expect(parse).toHaveBeenCalledOnce();
    expect(parse).toHaveBeenCalledWith(source);
  }, 15_000);

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
