import { describe, expect, it } from "vitest";
import conformanceJson from "../test-fixtures/frontmatter-conformance.json";
import { maskFrontmatter, parseFrontmatter, type YamlValue } from "./frontmatter";

interface ConformanceCase {
  id: string;
  valid: boolean;
  markdown: string;
  body: string;
  entries?: Record<string, YamlValue>;
  metadata?: {
    title: string | null;
    authors: string[];
    description: string | null;
    keywords: string[];
    tags: string[];
  } | null;
}

const conformance = conformanceJson as { version: number; cases: ConformanceCase[] };

describe("YAML frontmatter parser", () => {
  it("recognizes UTF-8 BOM, trailing spaces, dot closers, empty blocks, CRLF, and EOF closers", () => {
    const variations = [
      { source: "\uFEFF---\ntitle: Android BOM\n---\nBody", body: "Body", title: "Android BOM" },
      { source: "---   \t \ntitle: Trailing Spaces\n...  \t\nBody", body: "Body", title: "Trailing Spaces" },
      { source: "---\r\ntitle: Windows CRLF\r\n...\r\nBody", body: "Body", title: "Windows CRLF" },
      { source: "---\n---\nBody after empty dashes", body: "Body after empty dashes", title: undefined },
      { source: "---\n...\nBody after empty dots", body: "Body after empty dots", title: undefined },
      { source: "---\n# comment only\n---\nBody", body: "Body", title: undefined },
      { source: "---\ntitle: EOF Closer\n---", body: "", title: "EOF Closer" },
      { source: "\uFEFF---\ntitle: BOM Dot EOF\n...", body: "", title: "BOM Dot EOF" },
      { source: "---\n---", body: "", title: undefined },
    ];
    for (const item of variations) {
      const parsed = parseFrontmatter(item.source);
      expect(parsed, item.source).not.toBeNull();
      expect(item.source.slice(parsed!.end)).toBe(item.body);
      expect(parsed!.raw + item.body).toBe(item.source);
      expect(parsed!.properties?.title).toBe(item.title);
    }
  });

  it("extracts Obsidian, Quarto, and Typora document metadata fields", () => {
    const quarto = [
      "---",
      'title: "Quantum Field Notes: Part I"',
      "subtitle: Perturbative Methods",
      "author:",
      "  - name: Richard Feynman",
      "  - given: Julian",
      "    family: Schwinger",
      "  - name:",
      "      given: Sin-Itiro",
      "      family: Tomonaga",
      "date: 2026-03-15",
      "abstract: |-",
      "  Compact lecture notes on path integrals",
      "  and propagator expansions.",
      "keywords: [qft, physics]",
      "tags:",
      "- study",
      "- physics",
      "aliases: [QFT I, Path Integrals]",
      "cssclasses: [academic]",
      "...",
      "# Lecture 1",
    ].join("\n");

    const parsed = parseFrontmatter(quarto);
    expect(parsed).not.toBeNull();
    expect(parsed!.properties).toEqual({
      title: "Quantum Field Notes: Part I",
      subtitle: "Perturbative Methods",
      authors: ["Richard Feynman", "Julian Schwinger", "Sin-Itiro Tomonaga"],
      date: "2026-03-15",
      description: "Compact lecture notes on path integrals\nand propagator expansions.",
      tags: ["study", "physics", "qft"],
      aliases: ["QFT I", "Path Integrals"],
    });

    const typora = [
      "---",
      "creator: Emmy Noether",
      "subject: Conservation Laws",
      "tags: symmetry, invariants, algebra",
      "---",
    ].join("\n");
    expect(parseFrontmatter(typora)?.properties).toEqual({
      title: undefined,
      subtitle: undefined,
      authors: ["Emmy Noether"],
      date: undefined,
      description: "Conservation Laws",
      tags: ["symmetry", "invariants", "algebra"],
      aliases: [],
    });
  });

  it("returns null properties when frontmatter has only unrecognized keys or is empty", () => {
    const obsidianOnly = parseFrontmatter("---\ncssclasses:\n  - wide-page\npublish: false\n---\n# Note");
    expect(obsidianOnly).not.toBeNull();
    expect(obsidianOnly!.properties).toBeNull();
    expect(parseFrontmatter("---\n---\n# Note")?.properties).toBeNull();
  });

  it("rejects malformed, unclosed, non-mapping, and TOML frontmatter safely", () => {
    const nonFrontmatter = [
      "---\ntitle: Unclosed frontmatter\n\n# Heading",
      "+++\ntitle = \"TOML is out of scope\"\n+++\n\n# Heading",
      "---\nThis is an ordinary paragraph between two thematic breaks.\n---\n",
      "---\n- Bullet one\n- Bullet two\n---\n",
      "---\ntitle: \"Unclosed double quote\n---\n# Body",
      "---\ntags: [unclosed, flow\n---\n# Body",
      "---\nauthor:\n\t- Tab indented\n---\n# Body",
      "---\nNote: First line has colon.\nSecond line at root has no colon.\n---\n# Body",
    ];
    for (const sample of nonFrontmatter) {
      expect(parseFrontmatter(sample), sample).toBeNull();
      expect(maskFrontmatter(sample)).toBe(sample);
    }
  });

  it("masks frontmatter while preserving exact UTF-16 length and line break offsets", () => {
    const source = "\uFEFF---  \r\ntitle: \"![Fake](missing.png)\"\r\ntags: [a, b]\r\n...\r\n# Real Heading\r\n\r\n![Real](chart.png)";
    const masked = maskFrontmatter(source);
    expect(masked).toHaveLength(source.length);
    for (let i = 0; i < source.length; i++) {
      if (source[i] === "\r" || source[i] === "\n") expect(masked[i]).toBe(source[i]);
    }
    expect(masked.indexOf("# Real Heading")).toBe(source.indexOf("# Real Heading"));
    expect(masked.indexOf("![Real](chart.png)")).toBe(source.indexOf("![Real](chart.png)"));
    expect(masked).not.toContain("missing.png");
  });

  it("matches shared cross-runtime frontmatter conformance vectors", () => {
    expect(conformance.version).toBe(1);
    expect(conformance.cases.length).toBeGreaterThanOrEqual(20);
    for (const item of conformance.cases) {
      const parsed = parseFrontmatter(item.markdown);
      const masked = maskFrontmatter(item.markdown);
      expect(masked, item.id).toHaveLength(item.markdown.length);
      for (let i = 0; i < item.markdown.length; i++) {
        if (item.markdown[i] === "\r" || item.markdown[i] === "\n") {
          expect(masked[i], item.id).toBe(item.markdown[i]);
        }
      }
      if (!item.valid) {
        expect(parsed, item.id).toBeNull();
        expect(masked, item.id).toBe(item.markdown);
        continue;
      }
      expect(parsed, item.id).not.toBeNull();
      expect(item.markdown.slice(parsed!.end), item.id).toBe(item.body);
      expect(parsed!.raw + item.body, item.id).toBe(item.markdown);
      expect(masked.slice(parsed!.end), item.id).toBe(item.body);
      expect(parsed!.entries, item.id).toEqual(item.entries);
      if (item.metadata === null) {
        expect(parsed!.properties, item.id).toBeNull();
      } else if (item.metadata) {
        expect(parsed!.properties, item.id).not.toBeNull();
        expect(parsed!.properties!.title, item.id).toBe(item.metadata.title ?? undefined);
        expect(parsed!.properties!.authors, item.id).toEqual(item.metadata.authors);
        expect(parsed!.properties!.description, item.id).toBe(item.metadata.description ?? undefined);
        expect(parsed!.properties!.tags, item.id).toEqual(item.metadata.tags);
      }
    }
  });
});
