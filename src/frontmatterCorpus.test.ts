import { beforeEach, describe, expect, it, vi } from "vitest";
import corpus from "../test-fixtures/frontmatter-corpus.json";
import { compatibleMarkdown } from "./compatibleMarkdown";
import { analyzeDocument } from "./documentAnalysis";
import { imageRanges } from "./documentMedia";
import { maskFrontmatter, parseFrontmatter, type DocumentMetadata, type YamlValue } from "./frontmatter";
import { prepareMarkdownExport } from "./markdownExport";
import { normalizeMarkdownSource } from "./markdownSource";

const { mockInvoke } = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
}));

vi.mock("./nativeBridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./nativeBridge")>();
  return {
    ...actual,
    invoke: mockInvoke,
  };
});

const REQUIRED_CATEGORIES = [
  "quoted-scalars",
  "flow-collections",
  "folded-scalars",
  "crlf",
  "unicode-separators",
] as const;

const ONE_PIXEL_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";

const frontmatterFixtureModules = import.meta.glob("../test-fixtures/frontmatter-*.json", {
  eager: true,
  import: "default",
}) as Record<string, unknown>;

interface SharedCorpusCase {
  id: string;
  category: (typeof REQUIRED_CATEGORIES)[number];
  description: string;
  source: string;
  recognized: boolean;
  frontmatterRaw: string;
  body: string;
  endOffset: { utf16: number; codePoints: number };
  maskedExcludes?: string[];
  bodyProbes?: string[];
  bodyImages?: string[];
  unsupportedDiagrams?: boolean;
  typescriptEntries?: Record<string, YamlValue>;
  typescriptProperties?: Partial<DocumentMetadata>;
}

interface DivergenceCorpusCase {
  id: string;
  category: (typeof REQUIRED_CATEGORIES)[number];
  description: string;
  reason: string;
  alignedInPr186: boolean;
  conformanceCaseId?: string;
  source: string;
  typescript: {
    recognized: boolean;
    frontmatterRaw: string;
    body: string;
    endUtf16: number;
  };
  desktop: {
    recognized: boolean;
    frontmatterRaw: string;
    body: string;
    endCodePoints: number;
  };
}

interface CompanionConformanceSuite {
  version: number;
  cases: Array<{
    id: string;
    valid: boolean;
    markdown: string;
    body: string;
  }>;
}

function assertMaskInvariants(source: string, masked: string, endUtf16: number, expectedBody: string): void {
  expect(masked.length).toBe(source.length);
  for (let i = 0; i < source.length; i++) {
    expect(masked[i] === "\r", `CR mismatch at UTF-16 index ${i}`).toBe(source[i] === "\r");
    expect(masked[i] === "\n", `LF mismatch at UTF-16 index ${i}`).toBe(source[i] === "\n");
    if (i < endUtf16 && source[i] !== "\r" && source[i] !== "\n") {
      expect(masked[i], `unmasked frontmatter char at UTF-16 index ${i}`).toBe(" ");
    }
  }
  expect(masked.slice(endUtf16)).toBe(expectedBody);
}

describe("Shared portable YAML frontmatter fixture corpus (TypeScript)", () => {
  const sharedCases = corpus.sharedCases as SharedCorpusCase[];
  const divergences = corpus.divergences as DivergenceCorpusCase[];
  const conformanceSuite = frontmatterFixtureModules["../test-fixtures/frontmatter-conformance.json"] as
    | CompanionConformanceSuite
    | undefined;

  beforeEach(() => {
    mockInvoke.mockReset();
  });

  it("covers quoted scalars, flow collections, folded scalars, CRLF, and Unicode separators and coordinates IDs with #186", () => {
    expect(corpus.version).toBe(1);
    expect(corpus.companionConformanceFixture).toBe("test-fixtures/frontmatter-conformance.json");
    const ids = new Set<string>();
    for (const entry of [...sharedCases, ...divergences]) {
      expect(ids.has(entry.id), `duplicate corpus ID: ${entry.id}`).toBe(false);
      ids.add(entry.id);
    }
    for (const entry of divergences) {
      expect(typeof entry.alignedInPr186).toBe("boolean");
    }
    for (const category of REQUIRED_CATEGORIES) {
      expect(
        sharedCases.some((entry) => entry.category === category && entry.recognized),
        `missing positive shared case for ${category}`,
      ).toBe(true);
      expect(
        sharedCases.some((entry) => entry.category === category && !entry.recognized),
        `missing negative shared case for ${category}`,
      ).toBe(true);
    }
    if (conformanceSuite) {
      expect(conformanceSuite.version).toBe(1);
      const conformanceIds = new Set(conformanceSuite.cases.map((item) => item.id));
      for (const id of ids) {
        expect(conformanceIds.has(id), `overlapping fixture ID with #186: ${id}`).toBe(false);
      }
      for (const entry of divergences) {
        if (entry.conformanceCaseId) {
          expect(conformanceIds.has(entry.conformanceCaseId)).toBe(true);
        }
      }
    }
  });

  it.each(sharedCases)(
    "verifies recognition, masking, companion export preparation, and boundaries for shared case $id ($category)",
    async (item) => {
      const allowedImages = new Set(item.bodyImages ?? []);
      mockInvoke.mockImplementation(async (command: string, args?: { source?: string }) => {
        if (command === "load_asset" && args?.source && allowedImages.has(args.source)) {
          return ONE_PIXEL_PNG;
        }
        throw new Error(`Unexpected native asset call: ${command} (${args?.source ?? ""})`);
      });

      const parsed = parseFrontmatter(item.source);
      const masked = maskFrontmatter(item.source);

      if (!item.recognized) {
        expect(parsed).toBeNull();
        expect(masked).toBe(item.source);
        expect(item.endOffset.utf16).toBe(0);
        expect(item.body).toBe(item.source);
      } else {
        expect(parsed).not.toBeNull();
        expect(parsed!.raw).toBe(item.frontmatterRaw);
        expect(parsed!.end).toBe(item.endOffset.utf16);
        expect(Array.from(parsed!.raw).length).toBe(item.endOffset.codePoints);
        expect(item.source.slice(parsed!.end)).toBe(item.body);
        expect(parsed!.raw + item.body).toBe(item.source);
        assertMaskInvariants(item.source, masked, parsed!.end, item.body);

        for (const forbidden of item.maskedExcludes ?? []) {
          expect(masked).not.toContain(forbidden);
        }

        if (item.typescriptEntries) {
          expect(parsed!.entries).toEqual(item.typescriptEntries);
        }
        if (item.typescriptProperties) {
          expect(parsed!.properties).toMatchObject(item.typescriptProperties);
        }

        const exported = await compatibleMarkdown(item.source, null);
        expect(exported.startsWith(item.frontmatterRaw)).toBe(true);
      }

      const plainCompanion = await prepareMarkdownExport(item.source, "/workspace/note.md");
      expect(plainCompanion.content).toBe(item.source);
      expect(Object.keys(plainCompanion.assets)).toEqual(item.bodyImages ?? []);

      const compatibleCompanion = await prepareMarkdownExport(item.source, "/workspace/note.md", {
        compatible: true,
      });
      if (item.recognized) {
        expect(compatibleCompanion.content.startsWith(item.frontmatterRaw)).toBe(true);
      }
      expect(Object.keys(compatibleCompanion.assets)).toEqual(item.bodyImages ?? []);
      for (const forbidden of item.maskedExcludes ?? []) {
        expect(plainCompanion.assets).not.toHaveProperty(forbidden);
        expect(compatibleCompanion.assets).not.toHaveProperty(forbidden);
      }

      const endUtf16 = parsed?.end ?? 0;
      const analysis = analyzeDocument(item.source);
      expect(analysis.frontmatter?.end ?? 0).toBe(endUtf16);
      expect(analysis.blocks.map((block) => block.text).join("")).toBe(item.source);
      expect(analysis.bodyBlocks[0]?.start ?? 0).toBeGreaterThanOrEqual(endUtf16);
      for (const block of analysis.bodyBlocks) {
        expect(item.source.slice(block.start, block.end)).toBe(block.text);
      }
      for (const taskOffset of analysis.tasks) {
        expect(taskOffset).toBeGreaterThanOrEqual(endUtf16);
        expect([" ", "x", "X"]).toContain(item.source[taskOffset]);
      }

      const normalized = normalizeMarkdownSource(item.source, { encodeLinkDestinations: true });
      for (const probe of item.bodyProbes ?? []) {
        const expectedOffset = item.source.indexOf(probe, endUtf16);
        expect(expectedOffset, `missing body probe ${probe}`).toBeGreaterThanOrEqual(endUtf16);
        expect(masked.indexOf(probe, endUtf16)).toBe(expectedOffset);
        const normalizedOffset = normalized.value.indexOf(probe);
        if (normalizedOffset >= 0) {
          expect(normalized.originalOffset(normalizedOffset)).toBe(expectedOffset);
        }
      }

      if (item.bodyImages !== undefined) {
        const detected = imageRanges(item.source);
        expect(detected.map((img) => img.source)).toEqual(item.bodyImages);
        for (const img of detected) {
          expect(img.from).toBeGreaterThanOrEqual(endUtf16);
          expect(item.source.slice(img.from, img.to)).toContain(img.source);
        }
      }
    },
  );

  it.each(divergences)(
    "records TypeScript behavior and companion export invariants for cross-parser divergence $id ($category)",
    async (entry) => {
      mockInvoke.mockRejectedValue(new Error("Unexpected asset load in divergence case"));
      expect(entry.typescript.recognized).not.toBe(entry.desktop.recognized);
      const parsed = parseFrontmatter(entry.source);
      const masked = maskFrontmatter(entry.source);

      if (!entry.typescript.recognized) {
        expect(parsed).toBeNull();
        expect(masked).toBe(entry.source);
      } else {
        expect(parsed).not.toBeNull();
        expect(parsed!.raw).toBe(entry.typescript.frontmatterRaw);
        expect(parsed!.end).toBe(entry.typescript.endUtf16);
        expect(entry.source.slice(parsed!.end)).toBe(entry.typescript.body);
        assertMaskInvariants(entry.source, masked, parsed!.end, entry.typescript.body);
      }

      const companion = await prepareMarkdownExport(entry.source, "/workspace/note.md");
      expect(companion.content).toBe(entry.source);
      expect(companion.assets).toEqual({});
    },
  );

  it("verifies masking and companion export invariants across #186 conformance vectors when present", async () => {
    const pr186SurrogateGuardActive = parseFrontmatter('---\ntitle: "\\uD800"\n---\nBody') === null;
    if (!conformanceSuite || !pr186SurrogateGuardActive) return;

    mockInvoke.mockRejectedValue(new Error("Unexpected asset load in conformance vector"));
    for (const item of conformanceSuite.cases) {
      const parsed = parseFrontmatter(item.markdown);
      const masked = maskFrontmatter(item.markdown);
      if (!item.valid) {
        expect(parsed, item.id).toBeNull();
        expect(masked, item.id).toBe(item.markdown);
      } else {
        expect(parsed, item.id).not.toBeNull();
        assertMaskInvariants(item.markdown, masked, parsed!.end, item.body);
      }
      const companion = await prepareMarkdownExport(item.markdown, "/workspace/note.md");
      expect(companion.content, item.id).toBe(item.markdown);
      expect(companion.assets, item.id).toEqual({});
    }
  });
});
