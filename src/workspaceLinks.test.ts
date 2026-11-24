import { describe, expect, it } from "vitest";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { normalizeCallouts, remarkSourceSyntax } from "./markdownSource";
import { resolveHeadingOffset } from "./documentNavigation";
import { preparePdf } from "./preparePdf";
import {
  classifyRenderedLink,
  encodeMarkdownDestination,
  findSourceLinkAtOffset,
  formatWikilinkMarkdown,
  parseWikilinkParts,
} from "./workspaceLinks";

describe("workspaceLinks helpers", () => {
  it("parses wikilinks with aliases, fragments, extensions, and table-escaped pipes", () => {
    expect(parseWikilinkParts("Concept Note")).toEqual({
      target: "Concept Note",
      fragment: "",
      label: "Concept Note",
      sameNote: false,
    });
    expect(parseWikilinkParts("Folder/My Note.smd#Results|See Results")).toEqual({
      target: "Folder/My Note.smd",
      fragment: "Results",
      label: "See Results",
      sameNote: false,
    });
    expect(parseWikilinkParts("Table Note\\|Escaped Alias")).toEqual({
      target: "Table Note",
      fragment: "",
      label: "Escaped Alias",
      sameNote: false,
    });
    expect(parseWikilinkParts("#Overview|Jump up")).toEqual({
      target: "",
      fragment: "Overview",
      label: "Jump up",
      sameNote: true,
    });
  });

  it("formats encoded destinations for CommonMark while keeping unencoded mode compatible", () => {
    expect(formatWikilinkMarkdown("My Note#Deep Dive|Read this", false)).toBe(
      "[Read this](My Note.md#Deep Dive)",
    );
    expect(formatWikilinkMarkdown("My Note#Deep Dive|Read this", true)).toBe(
      "[Read this](My%20Note.md#deep-dive)",
    );
    expect(formatWikilinkMarkdown("Bundle.smd#Part 1", true)).toBe(
      "[Bundle.smd#Part 1](Bundle.smd#part-1)",
    );
    expect(formatWikilinkMarkdown("Portable.fmd", true)).toBe(
      "[Portable.fmd](Portable.fmd)",
    );
    expect(encodeMarkdownDestination("../my specs/api (v2).md#Auth Flow")).toBe(
      "../my%20specs/api%20%28v2%29.md#Auth%20Flow",
    );
  });

  it("classifies local workspace links, same-note anchors, external URLs, and blocked schemes", () => {
    expect(classifyRenderedLink("#section-two")).toEqual({
      kind: "same-note",
      fragment: "section-two",
    });
    expect(classifyRenderedLink("#overview")).toEqual({
      kind: "same-note",
      fragment: "overview",
    });
    expect(
      classifyRenderedLink("../my%20specs/api.md#Auth%20Flow"),
    ).toEqual({
      kind: "workspace",
      target: "../my specs/api.md",
      fragment: "Auth Flow",
      wikilink: false,
    });
    expect(
      classifyRenderedLink("Subfolder%20Note.md#Intro", "Subfolder Note", "Intro"),
    ).toEqual({
      kind: "workspace",
      target: "Subfolder Note",
      fragment: "Intro",
      wikilink: true,
    });
    expect(classifyRenderedLink("https://example.org/docs")).toEqual({
      kind: "external",
      url: "https://example.org/docs",
    });
    expect(classifyRenderedLink("mailto:hello@example.org")).toEqual({
      kind: "external",
      url: "mailto:hello@example.org",
    });
    expect(classifyRenderedLink("javascript:alert(1)")).toEqual({
      kind: "blocked",
      url: "javascript:alert(1)",
    });
    expect(classifyRenderedLink("file:///etc/passwd")).toEqual({
      kind: "blocked",
      url: "file:///etc/passwd",
    });
  });
});

describe("markdownSource offset preservation and syntax protection", () => {
  it("preserves exact original source offsets across wikilinks and spaced Markdown links", () => {
    const source = [
      "# Workspace Links",
      "",
      "Intro with [[My Spaced Note#Section Two|alias]] and [API Spec](../my specs/api doc.md#Auth Flow).",
      "",
      "- [ ] First task after spaced links",
      "- [x] Second task with [[Portable.smd]]",
      "",
      "```python",
      "# Do not touch [[Code Wikilink]] or [Code Link](my folder/code.md)",
      "```",
      "",
      "Inline `[[Literal]]` and math $a + [[x]] = b$.",
      "",
      "Final paragraph to edit in Live mode.",
    ].join("\n");

    const tree = unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(remarkMath)
      .use(remarkSourceSyntax)
      .parse(source) as unknown as {
      children: Array<{ type: string; position?: { start: { offset?: number }; end: { offset?: number } } }>;
    };

    const lastBlock = tree.children.at(-1)!;
    const start = lastBlock.position!.start.offset!;
    const end = lastBlock.position!.end.offset!;
    expect(source.slice(start, end)).toBe("Final paragraph to edit in Live mode.");

    const normalized = normalizeCallouts(source);
    expect(normalized).toContain("[[Code Wikilink]]");
    expect(normalized).toContain("`[[Literal]]`");
    expect(normalized).toContain("$a + [[x]] = b$");
    expect(normalized).toContain("[alias](My%20Spaced%20Note.md#section-two)");
    expect(normalized).toContain("[API Spec](../my%20specs/api%20doc.md#Auth%20Flow)");
  });

  it("resolves heading offsets including duplicate slugs and encoded fragments", () => {
    const doc = [
      "# Top Title",
      "",
      "## Architecture Overview",
      "",
      "### Milestones",
      "First milestone body.",
      "",
      "### Milestones",
      "Second milestone body.",
    ].join("\n");

    expect(resolveHeadingOffset(doc, "Architecture Overview")).toBe(doc.indexOf("## Architecture Overview"));
    expect(resolveHeadingOffset(doc, "Architecture%20Overview")).toBe(doc.indexOf("## Architecture Overview"));
    expect(resolveHeadingOffset(doc, "#architecture-overview")).toBe(doc.indexOf("## Architecture Overview"));
    expect(resolveHeadingOffset(doc, "milestones")).toBe(doc.indexOf("### Milestones"));
    expect(resolveHeadingOffset(doc, "milestones-1")).toBe(doc.lastIndexOf("### Milestones"));
    expect(resolveHeadingOffset(doc, "Missing Section")).toBeNull();
  });

  it("finds wikilinks and Markdown links at a column offset while ignoring embeds and escaped brackets", () => {
    const line =
      "See ![[diagram.png]], \\[[escaped]], [[Subfolder Note#Deep Dive|Alias]], [Spec](../my specs/api.md#Auth), and [[#Top]].";

    expect(findSourceLinkAtOffset(line, line.indexOf("diagram.png"))).toBeNull();
    expect(findSourceLinkAtOffset(line, line.indexOf("escaped"))).toBeNull();
    expect(findSourceLinkAtOffset(line, line.indexOf("Subfolder Note"))).toEqual({
      kind: "workspace",
      target: "Subfolder Note",
      fragment: "Deep Dive",
      wikilink: true,
    });
    expect(findSourceLinkAtOffset(line, line.indexOf("../my specs/api.md"))).toEqual({
      kind: "workspace",
      target: "../my specs/api.md",
      fragment: "Auth",
      wikilink: false,
    });
    expect(findSourceLinkAtOffset(line, line.indexOf("#Top"))).toEqual({
      kind: "same-note",
      fragment: "Top",
    });
  });

  it("normalizes spaced wikilinks and Markdown links in preparePdf so smd-core parses and unwraps them cleanly", async () => {
    const markdown = [
      "# Exported Note",
      "",
      "Cross-note: [[Project Plan#Milestones|Q3 Plan]] and [API Spec](../my specs/api.md#Auth Flow).",
      "",
      "Keep: [Website](https://example.org/docs), [Email](mailto:team@example.org), and [[#Exported Note|Top]].",
    ].join("\n");

    const prepared = await preparePdf(markdown, "/vault/Index.md");
    expect(prepared.content).toContain("[Q3 Plan](Project%20Plan.md#milestones)");
    expect(prepared.content).toContain("[API Spec](../my%20specs/api.md#Auth%20Flow)");
    expect(prepared.content).toContain("[Website](https://example.org/docs)");
    expect(prepared.content).toContain("[Email](mailto:team@example.org)");
    expect(prepared.content).toContain("[Top](#exported-note)");
  });
});
