import { describe, expect, it } from "vitest";
import { frontmatterVisibleValueSpans, maskFrontmatter, parseFrontmatter } from "./frontmatter";

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

  it("maps displayed title, author, and tags to exact canonical UTF-16 value spans in display order", () => {
    const source = [
      "\uFEFF---",
      "date: 2026-03-15 # hidden date and comment",
      "tags: [quantum, physics] # inline tag comment",
      "keywords: physics, qft",
      "author:",
      "  - name: Richard Feynman",
      "    affiliation: Caltech",
      "  - given: Emmy",
      "    family: Noether",
      "subtitle: Perturbative Notes",
      'title: "Path Integrals & Symmetries"',
      "aliases: [QFT Notes]",
      "...",
      "# Body Heading",
    ].join("\r\n");

    const parsedWithSpans = parseFrontmatter(source, { includeSpans: true });
    expect(parsedWithSpans).not.toBeNull();
    expect(parsedWithSpans!.properties).toEqual({
      title: "Path Integrals & Symmetries",
      subtitle: "Perturbative Notes",
      authors: ["Richard Feynman", "Emmy Noether"],
      date: "2026-03-15",
      description: undefined,
      tags: ["quantum", "physics", "qft"],
      aliases: ["QFT Notes"],
    });
    expect(parseFrontmatter(source)?.visibleSpans).toBeUndefined();

    const spans = parsedWithSpans!.visibleSpans!;
    expect(frontmatterVisibleValueSpans(source)).toEqual(spans);
    expect(spans.map((s) => ({ field: s.field, fieldOrdinal: s.fieldOrdinal, text: source.slice(s.start, s.end) }))).toEqual([
      { field: "title", fieldOrdinal: 0, text: "Path Integrals & Symmetries" },
      { field: "author", fieldOrdinal: 0, text: "Richard Feynman" },
      { field: "author", fieldOrdinal: 0, text: "Emmy" },
      { field: "author", fieldOrdinal: 0, text: "Noether" },
      { field: "tag", fieldOrdinal: 0, text: "quantum" },
      { field: "tag", fieldOrdinal: 1, text: "physics" },
      { field: "tag", fieldOrdinal: 2, text: "qft" },
    ]);
    expect(frontmatterVisibleValueSpans("# No frontmatter\nBody")).toEqual([]);
  });

  it("extracts values and canonical spans for quoted, folded, literal, flow, and duplicate metadata while excluding hidden fields and malformed headers", () => {
    const complex = [
      "---",
      "title: Initial Overwritten Title",
      "title: >-",
      "  Folded Alpha",
      "  Study",
      "subtitle: Hidden Folded Subtitle",
      "description: |",
      "  Hidden literal description",
      "  with Alpha text",
      "date: '2026-04-01'",
      "aliases: [HiddenAlias, 'Second Alias']",
      "custom_secret: AlphaSecret",
      "author: 'Ada ''Alpha'' Lovelace'",
      "authors:",
      "  - \"Ada 'Alpha' Lovelace\"",
      "  - { given: \"Grace\", family: 'Hopper', role: 'Rear Admiral' }",
      "tags: [",
      "  'flow-one',",
      "  \"flow-two\",",
      "  flow-one",
      "]",
      "keywords: >-",
      "  flow-two, folded-three,",
      "  folded-four",
      "---",
      "Body text.",
    ].join("\n");

    const parsed = parseFrontmatter(complex, { includeSpans: true });
    expect(parsed).not.toBeNull();
    expect(parsed!.properties).toEqual({
      title: "Folded Alpha Study",
      subtitle: "Hidden Folded Subtitle",
      authors: ["Ada 'Alpha' Lovelace", "Grace Hopper"],
      date: "2026-04-01",
      description: "Hidden literal description\nwith Alpha text",
      tags: ["flow-one", "flow-two", "folded-three", "folded-four"],
      aliases: ["HiddenAlias", "Second Alias"],
    });
    expect(parsed!.visibleSpans!.map((s) => ({
      field: s.field,
      fieldOrdinal: s.fieldOrdinal,
      text: complex.slice(s.start, s.end),
    }))).toEqual([
      { field: "title", fieldOrdinal: 0, text: "Folded Alpha" },
      { field: "title", fieldOrdinal: 0, text: "Study" },
      { field: "author", fieldOrdinal: 0, text: "Ada ''Alpha'' Lovelace" },
      { field: "author", fieldOrdinal: 0, text: "Grace" },
      { field: "author", fieldOrdinal: 0, text: "Hopper" },
      { field: "tag", fieldOrdinal: 0, text: "flow-one" },
      { field: "tag", fieldOrdinal: 1, text: "flow-two" },
      { field: "tag", fieldOrdinal: 2, text: "folded-three" },
      { field: "tag", fieldOrdinal: 3, text: "folded-four" },
    ]);

    for (const malformed of [
      "---\ntitle: \"Unclosed quote\n---\nBody",
      "---\ntags: [unclosed, flow\n---\nBody",
      "---\n\ttitle: Leading Tab\n---\nBody",
      "---\n- list_root_not_mapping\n---\nBody",
      "---\ntitle: Missing Closer\nBody",
      "---\n\"title\":CompactValue\n---\n# Body\n",
      "---\n'title':CompactValue\n---\n# Body\n",
      "---\ntitle:\u00a0NoAsciiSpaceAfterColon\n---\n# Body\n",
    ]) {
      expect(parseFrontmatter(malformed, { includeSpans: true })).toBeNull();
      expect(frontmatterVisibleValueSpans(malformed)).toEqual([]);
    }
  });

  it("preserves trimStart Unicode-whitespace compatibility and exact value spans across quoted keys, quoted values, flow maps, and sequence/flow tags", () => {
    const fixtures: Array<{
      name: string;
      source: string;
      expectedEnd?: number;
      expectedBody: string;
      expectedEntries: Record<string, unknown>;
      expectedProperties: {
        title?: string;
        subtitle?: string;
        authors: string[];
        date?: string;
        description?: string;
        tags: string[];
        aliases: string[];
      };
      expectedSpans: Array<{ field: "title" | "author" | "tag"; fieldOrdinal: number; text: string }>;
    }> = [
      {
        name: "#150 double-quoted key followed by U+00A0 before colon",
        source: "---\n\"title\"\u00a0: NBSP Before Colon\n---\n# Body\n",
        expectedEnd: 36,
        expectedBody: "# Body\n",
        expectedEntries: { title: "NBSP Before Colon" },
        expectedProperties: { title: "NBSP Before Colon", authors: [], tags: [], aliases: [] },
        expectedSpans: [{ field: "title", fieldOrdinal: 0, text: "NBSP Before Colon" }],
      },
      {
        name: "#150 single-quoted key followed by U+00A0 before colon",
        source: "---\n'title'\u00a0: NBSP Before Colon\n---\n# Body\n",
        expectedEnd: 36,
        expectedBody: "# Body\n",
        expectedEntries: { title: "NBSP Before Colon" },
        expectedProperties: { title: "NBSP Before Colon", authors: [], tags: [], aliases: [] },
        expectedSpans: [{ field: "title", fieldOrdinal: 0, text: "NBSP Before Colon" }],
      },
      {
        name: "plain key with double-quoted value after colon + U+00A0",
        source: "---\ntitle: \u00a0\"Double Quoted Title\"\n---\n# Body\n",
        expectedBody: "# Body\n",
        expectedEntries: { title: "Double Quoted Title" },
        expectedProperties: { title: "Double Quoted Title", authors: [], tags: [], aliases: [] },
        expectedSpans: [{ field: "title", fieldOrdinal: 0, text: "Double Quoted Title" }],
      },
      {
        name: "plain key with single-quoted value after colon + U+00A0",
        source: "---\ntitle: \u00a0'Single Quoted Title'\n---\n# Body\n",
        expectedBody: "# Body\n",
        expectedEntries: { title: "Single Quoted Title" },
        expectedProperties: { title: "Single Quoted Title", authors: [], tags: [], aliases: [] },
        expectedSpans: [{ field: "title", fieldOrdinal: 0, text: "Single Quoted Title" }],
      },
      {
        name: "double- and single-quoted keys with U+00A0 before and after colon and quoted values",
        source: "---\n\"title\"\u00a0: \u00a0\"Conservation Laws\"\n'author'\u00a0: \u00a0'Emmy Noether'\n---\n# Body\n",
        expectedBody: "# Body\n",
        expectedEntries: { title: "Conservation Laws", author: "Emmy Noether" },
        expectedProperties: { title: "Conservation Laws", authors: ["Emmy Noether"], tags: [], aliases: [] },
        expectedSpans: [
          { field: "title", fieldOrdinal: 0, text: "Conservation Laws" },
          { field: "author", fieldOrdinal: 0, text: "Emmy Noether" },
        ],
      },
      {
        name: "flow tag list after colon + U+00A0 with quoted and plain items",
        source: "---\ntags: \u00a0[\u00a0\"flow-alpha\",\u00a0'flow-beta',\u00a0flow-gamma\u00a0]\n---\n# Body\n",
        expectedBody: "# Body\n",
        expectedEntries: { tags: ["flow-alpha", "flow-beta", "flow-gamma"] },
        expectedProperties: { authors: [], tags: ["flow-alpha", "flow-beta", "flow-gamma"], aliases: [] },
        expectedSpans: [
          { field: "tag", fieldOrdinal: 0, text: "flow-alpha" },
          { field: "tag", fieldOrdinal: 1, text: "flow-beta" },
          { field: "tag", fieldOrdinal: 2, text: "flow-gamma" },
        ],
      },
      {
        name: "sequence tags and sequence inline/flow items with U+00A0 after dash",
        source: [
          "---",
          "tags:",
          "  - \u00a0\"seq-double\"",
          "  - \u00a0'seq-single'",
          "  - \u00a0seq-plain",
          "author:",
          "  - \u00a0\"name\"\u00a0: \u00a0\"Richard Feynman\"",
          "  - \u00a0'literal'\u00a0: \u00a0'Julian Schwinger'",
          "  - \u00a0{ \"given\"\u00a0:\u00a0\"Freeman\", 'family'\u00a0:\u00a0'Dyson' }",
          "---",
          "# Body\n",
        ].join("\n"),
        expectedBody: "# Body\n",
        expectedEntries: {
          tags: ["seq-double", "seq-single", "seq-plain"],
          author: [
            { name: "Richard Feynman" },
            { literal: "Julian Schwinger" },
            { given: "Freeman", family: "Dyson" },
          ],
        },
        expectedProperties: {
          authors: ["Richard Feynman", "Julian Schwinger", "Freeman Dyson"],
          tags: ["seq-double", "seq-single", "seq-plain"],
          aliases: [],
        },
        expectedSpans: [
          { field: "author", fieldOrdinal: 0, text: "Richard Feynman" },
          { field: "author", fieldOrdinal: 0, text: "Julian Schwinger" },
          { field: "author", fieldOrdinal: 0, text: "Freeman" },
          { field: "author", fieldOrdinal: 0, text: "Dyson" },
          { field: "tag", fieldOrdinal: 0, text: "seq-double" },
          { field: "tag", fieldOrdinal: 1, text: "seq-single" },
          { field: "tag", fieldOrdinal: 2, text: "seq-plain" },
        ],
      },
      {
        name: "flow maps with both quote styles, compact U+00A0 colons, and nested flow values",
        source: [
          "---",
          "author: \u00a0[\u00a0{\u00a0\"given\"\u00a0:\u00a0\"Grace\",\u00a0'family'\u00a0:\u00a0'Hopper',\u00a0roles:\u00a0[compilers, cobol]\u00a0}\u00a0]",
          "meta: \u00a0{\u00a0\"nested\"\u00a0:\u00a0[1, 2],\u00a0'inner'\u00a0:\u00a0{\u00a0key:\u00a0'val'\u00a0}\u00a0}",
          "---",
          "# Body\n",
        ].join("\n"),
        expectedBody: "# Body\n",
        expectedEntries: {
          author: [{ given: "Grace", family: "Hopper", roles: ["compilers", "cobol"] }],
          meta: { nested: ["1", "2"], inner: { key: "val" } },
        },
        expectedProperties: {
          authors: ["Grace Hopper"],
          tags: [],
          aliases: [],
        },
        expectedSpans: [
          { field: "author", fieldOrdinal: 0, text: "Grace" },
          { field: "author", fieldOrdinal: 0, text: "Hopper" },
        ],
      },
    ];

    for (const fixture of fixtures) {
      const parsed = parseFrontmatter(fixture.source, { includeSpans: true });
      expect(parsed, fixture.name).not.toBeNull();
      if (fixture.expectedEnd !== undefined) {
        expect(parsed!.end, fixture.name).toBe(fixture.expectedEnd);
      }
      expect(fixture.source.slice(parsed!.end), fixture.name).toBe(fixture.expectedBody);
      expect(parsed!.raw + fixture.expectedBody, fixture.name).toBe(fixture.source);
      expect(parsed!.entries, fixture.name).toEqual(fixture.expectedEntries);
      expect(parsed!.properties, fixture.name).toEqual({
        title: undefined,
        subtitle: undefined,
        date: undefined,
        description: undefined,
        ...fixture.expectedProperties,
      });

      const masked = maskFrontmatter(fixture.source);
      expect(masked.length, fixture.name).toBe(fixture.source.length);
      expect(masked.slice(parsed!.end), fixture.name).toBe(fixture.expectedBody);
      for (let i = 0; i < parsed!.end; i++) {
        const ch = fixture.source[i];
        expect(masked[i], `${fixture.name} at ${i}`).toBe(ch === "\r" || ch === "\n" ? ch : " ");
      }

      const spans = parsed!.visibleSpans!;
      expect(
        spans.map((s) => ({ field: s.field, fieldOrdinal: s.fieldOrdinal, text: fixture.source.slice(s.start, s.end) })),
        fixture.name,
      ).toEqual(fixture.expectedSpans);
    }
  });
});
