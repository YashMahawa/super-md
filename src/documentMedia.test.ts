// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
const { native } = vi.hoisted(() => ({ native: vi.fn() }));
vi.mock("./nativeBridge", () => ({ invoke: native }));
import { imageMarkdown, imageRanges, linkDetails, prepareFmd, youtubeUrl } from "./documentMedia";
import { readRecent, rememberFile } from "./recentFiles";
import { svgImage } from "./svgImage";

describe("portable media", () => {
  it("finds distinct editable image ranges after Obsidian math, excluding code", () => {
    const md = '$$\\begin{aligned}\na&=b\\\\\n\\end{aligned}$$\n\n![First](a.png)\n\n![Second](a.png)\n\n![Reference][p]\n\n[p]: proof.svg\n\n![[diagram.svg|Diagram]]\n\n```md\n![Literal](a.png)\n```';
    const ranges = imageRanges(md);
    expect(ranges.map((range) => md.slice(range.from, range.to))).toEqual(["![First](a.png)", "![Second](a.png)", "![Reference][p]", "![[diagram.svg|Diagram]]"]);
    expect(ranges.map((range) => range.source)).toEqual(["a.png", "a.png", "proof.svg", "diagram.svg"]);
  });
  it("preserves source, callouts, frontmatter and interactive code without exposing bytes", async () => {
    native.mockResolvedValue("data:image/svg+xml;base64,PHN2Zy8+");
    const md = '---\ntitle: Keep me\n---\n\n> [!TIP] Learn\n> Keep this.\n\n![Proof](images/proof.svg)\n\n![Again](images/proof.svg)\n\n```mermaid\nA --> B\n```\n\n```python\nprint("![Not an attachment](fake.png)")\n```';
    const result = await prepareFmd(md, "/notes/a.md");
    expect(Object.keys(result.assets)).toHaveLength(1); expect(native).toHaveBeenCalledTimes(1);
    expect(result.content).toContain('---\ntitle: Keep me\n---'); expect(result.content).toContain('> [!TIP] Learn\n> Keep this.');
    expect(result.content).toContain('```mermaid\nA --> B\n```'); expect(result.content).toContain('print("![Not an attachment](fake.png)")'); expect(result.content).not.toContain("base64");
    expect(result.content.match(/assets\/image-/g)).toHaveLength(2);
  });
  it("embeds reference-style images and preserves adjacent source", async () => {
    native.mockResolvedValue("data:image/png;base64,aGVsbG8=");
    const result = await prepareFmd("# Keep\n\n![Proof][p]\n\n[p]: proof.png \"A title\"\n", "/notes/a.md");
    expect(result.content).toContain("![Proof][p]"); expect(result.content).toMatch(/\[p\]: <assets\/image-.*\.png> "A title"/);
  });
  it("recognizes real YouTube hosts and uses oEmbed titles and optional thumbnails", async () => {
    expect(youtubeUrl("https://youtu.be/dQw4w9WgXcQ?t=10")).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(youtubeUrl("https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ")).toBeNull();
    native.mockResolvedValue({ body: JSON.stringify({ title: "A clear explanation", thumbnail_url: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg" }) });
    const details = await linkDetails("https://youtu.be/dQw4w9WgXcQ"); expect(details.title).toBe("A clear explanation"); expect(details.thumbnail).toContain("ytimg.com");
  });
  it("extracts website titles as plain text, never page HTML", async () => {
    native.mockResolvedValue({ body: '<title>A &amp; B</title><script>alert(1)</script>' });
    expect((await linkDetails("https://example.org/notes")).title).toBe("A & B");
    expect(imageMarkdown({ source: "assets/import-a.svg", alt: "[Equation]" })).toBe("![\\[Equation\\]](<assets/import-a.svg>)");
  });
  it("renders vector images and rejects active SVG", () => {
    expect(svgImage('<svg><path d="M0 0L10 10"/></svg>')).toContain('xmlns="http://www.w3.org/2000/svg"');
    for (const svg of ['<svg><script>alert(1)</script></svg>', '<svg onload="x()"/>', '<svg><image href="https://evil.test/x.png"/></svg>', '<svg><foreignObject/></svg>', '<svg>']) expect(() => svgImage(svg)).toThrow();
  });
});
describe("recent files", () => {
  it("deduplicates, preserves recency and caps history", () => {
    let files = rememberFile([], "/notes/a.md", 1); files = rememberFile(files, "/notes/b.md", 2); files = rememberFile(files, "/notes/a.md", 3);
    expect(files.map((f) => f.name)).toEqual(["a.md", "b.md"]); expect(files[0].openedAt).toBe(3);
    for (let i = 0; i < 50; i++) files = rememberFile(files, `/notes/${i}.fmd`, i + 4);
    expect(files).toHaveLength(24); expect(readRecent({ getItem: () => 'broken JSON' })).toEqual([]);
  });
});
