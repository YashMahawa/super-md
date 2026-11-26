import { describe, expect, it } from "vitest";
import corpus from "../test-fixtures/frontmatter-corpus.json";
import { compatibleMarkdown } from "./compatibleMarkdown";
import { analyzeDocument } from "./documentAnalysis";
import { imageRanges } from "./documentMedia";
import { maskFrontmatter, parseFrontmatter, type DocumentMetadata, type YamlValue } from "./frontmatter";
import { normalizeMarkdownSource } from "./markdownSource";

const REQUIRED_CATEGORIES = [
  "quoted-scalars",
  "flow-collections",
  "folded-scalars",
  "crlf",
  "unicode-separators",
] as const;

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

  it("covers quoted scalars, flow collections, folded scalars, CRLF, and Unicode separators with unique case IDs", () => {
    expect(corpus.version).toBe(1);
    const ids = new Set<string>();
    for (const entry of [...sharedCases, ...divergences]) {
      expect(ids.has(entry.id), `duplicate corpus ID: ${entry.id}`).toBe(false);
      ids.add(entry.id);
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
  });

  it.each(sharedCases)(
    "verifies recognition, masking, and source/body boundaries for shared case $id ($category)",
    async (item) => {
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
    "records current TypeScript behavior for cross-parser divergence $id ($category)",
    (entry) => {
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
    },
  );
});
