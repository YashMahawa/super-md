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
  it("ignores image syntax inside YAML frontmatter variations while preserving body offsets", async () => {
    native.mockReset().mockResolvedValue("data:image/png;base64,aGVsbG8=");
    const md = '\uFEFF---  \ntitle: "![Fake](missing.png)"\nsummary: "![[also-fake.png]]"\n...\n\n![Real](real.png)';
    const ranges = imageRanges(md);
    expect(ranges).toHaveLength(1);
    expect(md.slice(ranges[0].from, ranges[0].to)).toBe("![Real](real.png)");
    const packed = await prepareFmd(md, "/notes/a.md");
    expect(native).toHaveBeenCalledTimes(1);
    expect(native).toHaveBeenCalledWith("load_asset", { documentPath: "/notes/a.md", source: "real.png" });
    expect(packed.content.startsWith('\uFEFF---  \ntitle: "![Fake](missing.png)"\nsummary: "![[also-fake.png]]"\n...\n\n')).toBe(true);
    native.mockReset();
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
  it("packs image references inside interactive smd-steps and preserves shared slide assets", async () => {
    native.mockReset().mockResolvedValue("data:image/svg+xml;base64,PHN2Zy8+");
    const deck = {title:"Heap steps",steps:[{label:"Before",image:"assets/clean-01.svg"},{label:"After",image:"assets/clean-02.svg"},{label:"Again",image:"assets/clean-01.svg"}]};
    const md = "# Heap\n\n```smd-steps\n"+JSON.stringify(deck,null,2)+"\n```\n";
    const result = await prepareFmd(md,"/notes/heaps.md");
    const match = /```smd-steps\n([\s\S]*?)\n```/.exec(result.content);
    expect(match).not.toBeNull();
    const packed = JSON.parse(match![1]);
    expect(packed.steps[0].image).toBe(packed.steps[2].image);
    expect(packed.steps[0].image).not.toBe(deck.steps[0].image);
    expect(Object.keys(result.assets)).toHaveLength(2);
    expect(packed.steps.every((step:{image:string})=>step.image in result.assets)).toBe(true);
    expect(native).toHaveBeenCalledTimes(2);
  });
  it("embeds reference-style images and preserves adjacent source", async () => {
    native.mockResolvedValue("data:image/png;base64,aGVsbG8=");
    const result = await prepareFmd("# Keep\n\n![Proof][p]\n\n[p]: proof.png \"A title\"\n", "/notes/a.md");
    expect(result.content).toContain("![Proof][p]"); expect(result.content).toMatch(/\[p\]: <assets\/image-.*\.png> "A title"/);
  });
  it("omits unchanged local portable assets without load_asset IPC while packing newly referenced images", async () => {
    native.mockReset().mockImplementation(async (command: string, args?: { source?: string }) => {
      if (command === "load_asset" && args?.source === "diagrams/new-arch.png") {
        return "data:image/png;base64,aGVsbG8=";
      }
      throw new Error(`Unexpected IPC call: ${command} ${JSON.stringify(args)}`);
    });
    const deck = {
      title: "Architecture",
      steps: [
        { label: "Unchanged slide", image: "assets/step-1.png", markdown: "![Nested unchanged](assets/fig-1.png)" },
      ],
    };
    const md = [
      "# Lecture",
      "",
      "![Unchanged](assets/fig-1.png)",
      "![Ref unchanged][r]",
      "",
      "[r]: assets/fig-2.svg \"Diagram\"",
      "",
      '<img src="assets/inline-existing.png" width="240" alt="Existing">',
      "",
      "![[assets/fig-1.png|Wiki local]]",
      "",
      "![Newly added](diagrams/new-arch.png)",
      "",
      "![Inline data](data:image/gif;base64,R0lGODlhAQABAAAAACw=)",
      "",
      "```smd-steps",
      JSON.stringify(deck, null, 2),
      "```",
      "",
    ].join("\n");

    const result = await prepareFmd(md, "content://vault/Lecture.smd", {
      localAssets: ["assets/fig-1.png", "assets/fig-2.svg", "assets/step-1.png", "assets/inline-existing.png"],
      omitLocalAssets: true,
      trustedImageHosts: [],
    });

    expect(native).toHaveBeenCalledTimes(1);
    expect(native).toHaveBeenCalledWith("load_asset", {
      documentPath: "content://vault/Lecture.smd",
      source: "diagrams/new-arch.png",
    });
    expect(result.content).toContain("![Unchanged](assets/fig-1.png)");
    expect(result.content).toContain('[r]: assets/fig-2.svg "Diagram"');
    expect(result.content).toContain('<img src="assets/inline-existing.png" width="240" alt="Existing">');
    expect(result.content).toContain("![Wiki local](<assets/fig-1.png>)");
    expect(result.content).toContain('"image": "assets/step-1.png"');
    expect(Object.keys(result.assets)).toHaveLength(2);
    for (const key of ["assets/fig-1.png", "assets/fig-2.svg", "assets/step-1.png", "assets/inline-existing.png"]) {
      expect(result.assets[key]).toBeUndefined();
    }
    expect(Object.values(result.assets)).toEqual(
      expect.arrayContaining(["data:image/png;base64,aGVsbG8=", "data:image/gif;base64,R0lGODlhAQABAAAAACw="]),
    );
  });
  it("enforces explicit reader consent for remote images across Markdown, wiki, steps, and HTML img tags", async () => {
    const remoteSvg = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=";
    native.mockReset().mockImplementation(async (command: string) => {
      if (command === "fetch_resource") return { body: remoteSvg };
      throw new Error(`Unexpected IPC: ${command}`);
    });

    const unconsentedInputs = [
      "![Blocked](https://untrusted.example/a.svg)",
      "![Blocked][id]\n\n[id]: https://untrusted.example/b.svg",
      "![[https://untrusted.example/c.svg|Blocked wiki]]",
      '<img src="https://untrusted.example/d.svg" alt="Blocked html">',
      '<img src="//untrusted.example/e.svg" alt="Protocol relative">',
      '```smd-steps\n{"title":"Steps","steps":[{"label":"S1","image":"https://untrusted.example/f.svg"}]}\n```',
      '```smd-steps\n{"title":"Steps","steps":[{"label":"S1","markdown":"![Nested](https://untrusted.example/g.svg)"}]}\n```',
    ];
    for (const input of unconsentedInputs) {
      await expect(
        prepareFmd(input, "/notes/consent.smd", { trustedImageHosts: ["images.example"] }),
      ).rejects.toThrow(/consent/i);
    }
    expect(native).not.toHaveBeenCalled();

    // One-time reader consent resolves only the approved URL without invoking fetch_resource.
    const approvedOnce = "https://one-time.example/chart.svg";
    const oncePacked = await prepareFmd(`![Approved](${approvedOnce})`, "/notes/consent.smd", {
      trustedImageHosts: [],
      resolveConsentedRemoteImage: (url) => (url === approvedOnce ? remoteSvg : null),
    });
    expect(Object.values(oncePacked.assets)).toEqual([remoteSvg]);
    expect(native).not.toHaveBeenCalled();

    await expect(
      prepareFmd("![Sibling](https://one-time.example/other.svg)", "/notes/consent.smd", {
        trustedImageHosts: [],
        resolveConsentedRemoteImage: (url) => (url === approvedOnce ? remoteSvg : null),
      }),
    ).rejects.toThrow(/consent/i);
    expect(native).not.toHaveBeenCalled();

    // Explicitly trusted domain fetches via fetch_resource.
    const trustedPacked = await prepareFmd('<img src="https://images.example/diagram.svg" alt="Trusted">', "/notes/consent.smd", {
      trustedImageHosts: ["images.example"],
    });
    expect(native).toHaveBeenCalledTimes(1);
    expect(native).toHaveBeenCalledWith("fetch_resource", { url: "https://images.example/diagram.svg", image: true });
    expect(Object.values(trustedPacked.assets)).toEqual([remoteSvg]);
    expect(trustedPacked.content).toMatch(/<img src="assets\/image-.*\.svg" alt="Trusted">/);
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
