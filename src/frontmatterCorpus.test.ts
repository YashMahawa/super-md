import { beforeEach, describe, expect, it, vi } from "vitest";
import conformanceJson from "../test-fixtures/frontmatter-conformance.json";
import { compatibleMarkdown } from "./compatibleMarkdown";
import { analyzeDocument } from "./documentAnalysis";
import { imageRanges } from "./documentMedia";
import { frontmatterVisibleValueSpans, maskFrontmatter, parseFrontmatter } from "./frontmatter";
import { prepareMarkdownExport } from "./markdownExport";
import { normalizeMarkdownSource } from "./markdownSource";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock("./nativeBridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./nativeBridge")>();
  return { ...actual, invoke: mockInvoke };
});

const ONE_PIXEL_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";

interface ConformanceCase {
  id: string;
  valid: boolean;
  markdown: string;
  body: string;
}

const cases = (conformanceJson as { cases: ConformanceCase[] }).cases;
const byId = new Map(cases.map((item) => [item.id, item]));

const MASKED_EXPORT_SPECS = [
  {
    id: "folded_clip_indented_delimiters_and_fences",
    bodyImages: ["real.png"],
    maskedExcludes: ["folded-fake.png", "mermaid"],
    bodyProbes: ["# Real Section", "![Real](real.png)"],
  },
  {
    id: "single_quoted_trailing_backslash_and_masked_tokens",
    bodyImages: ["flow-real.png"],
    maskedExcludes: ["missing.png", "wiki-fake.png", "fake.png", "flow-missing.png", "mermaid"],
    bodyProbes: ["# Lecture 1", "![Body](flow-real.png)"],
  },
  {
    id: "crlf_bom_astral_and_mixed_endings",
    bodyImages: ["crlf-real.png"],
    maskedExcludes: ["crlf-fake.png"],
    bodyProbes: ["# CRLF Astral Heading", "- [ ] CRLF Astral Task", "![Real](crlf-real.png)"],
  },
] as const;

describe("Frontmatter companion export, source offset, and divergence regressions", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
  });

  it.each(MASKED_EXPORT_SPECS)(
    "excludes masked frontmatter media/fences from companion exports and preserves body offsets for $id",
    async ({ id, bodyImages, maskedExcludes, bodyProbes }) => {
      const item = byId.get(id)!;
      expect(item?.valid).toBe(true);
      const allowed = new Set<string>(bodyImages);
      mockInvoke.mockImplementation(async (command: string, args?: { source?: string }) => {
        if (command === "load_asset" && args?.source && allowed.has(args.source)) return ONE_PIXEL_PNG;
        throw new Error(`Unexpected native call: ${command} (${args?.source ?? ""})`);
      });

      const parsed = parseFrontmatter(item.markdown)!;
      const masked = maskFrontmatter(item.markdown);
      for (const token of maskedExcludes) expect(masked).not.toContain(token);

      const detected = imageRanges(item.markdown);
      expect(detected.map((img) => img.source)).toEqual(bodyImages);
      for (const img of detected) expect(img.from).toBeGreaterThanOrEqual(parsed.end);

      const plain = await prepareMarkdownExport(item.markdown, "/workspace/note.md");
      expect(plain.content).toBe(item.markdown);
      expect(Object.keys(plain.assets)).toEqual(bodyImages);

      const compat = await prepareMarkdownExport(item.markdown, "/workspace/note.md", { compatible: true });
      expect(compat.content.startsWith(parsed.raw)).toBe(true);
      expect(Object.keys(compat.assets)).toEqual(bodyImages);
      expect((await compatibleMarkdown(item.markdown, null)).startsWith(parsed.raw)).toBe(true);

      const analysis = analyzeDocument(item.markdown);
      expect(analysis.frontmatter?.end).toBe(parsed.end);
      expect(analysis.blocks.map((b) => b.text).join("")).toBe(item.markdown);
      expect(analysis.bodyBlocks[0]?.start ?? 0).toBeGreaterThanOrEqual(parsed.end);

      const normalized = normalizeMarkdownSource(item.markdown, { encodeLinkDestinations: true });
      for (const probe of bodyProbes) {
        const expectedIdx = item.markdown.indexOf(probe, parsed.end);
        expect(expectedIdx).toBeGreaterThanOrEqual(parsed.end);
        expect(masked.indexOf(probe, parsed.end)).toBe(expectedIdx);
        const normIdx = normalized.value.indexOf(probe);
        if (normIdx >= 0) expect(normalized.originalOffset(normIdx)).toBe(expectedIdx);
      }
    },
  );

  it("aligns astral surrogate-pair UTF-16 vs code-point boundaries, task offsets, and visible spans", () => {
    const astral = byId.get("crlf_bom_astral_and_mixed_endings")!;
    const parsed = parseFrontmatter(astral.markdown, { includeSpans: true })!;
    expect(parsed.end).toBe(Array.from(parsed.raw).length + 3);
    expect(parsed.visibleSpans!.map((s) => astral.markdown.slice(s.start, s.end))).toEqual([
      "Rocket \uD83D\uDE80 & Bold \uD835\uDC00",
      "\uD83E\uDDEA",
      "![fake](crlf-fake.png)",
    ]);
    const analysis = analyzeDocument(astral.markdown);
    expect(analysis.tasks).toHaveLength(1);
    expect(analysis.tasks[0]).toBeGreaterThan(parsed.end);
    expect(astral.markdown.slice(analysis.tasks[0] - 3, analysis.tasks[0] + 2)).toBe("- [ ]");
  });

  it("documents the remaining JS vs Python/Rust inner U+FEFF blank-line divergence", async () => {
    mockInvoke.mockRejectedValue(new Error("Unexpected asset load"));
    const innerBom = "---\ntitle: Alpha\n\uFEFF\nauthor: Beta\n---\n# Body\n";
    const parsed = parseFrontmatter(innerBom, { includeSpans: true });
    expect(parsed).not.toBeNull();
    expect(parsed!.end).toBe(36);
    expect(innerBom.slice(parsed!.end)).toBe("# Body\n");
    expect(frontmatterVisibleValueSpans(innerBom).map((s) => innerBom.slice(s.start, s.end))).toEqual([
      "Alpha",
      "Beta",
    ]);
    const companion = await prepareMarkdownExport(innerBom, "/workspace/note.md");
    expect(companion.content).toBe(innerBom);
    expect(companion.assets).toEqual({});
  });
});
