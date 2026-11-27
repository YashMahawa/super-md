// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
const { native } = vi.hoisted(() => ({ native: vi.fn() }));
vi.mock("./nativeBridge", () => ({ invoke: native }));
import { imageMarkdown, imageRanges, linkDetails, prepareFmd, youtubeUrl } from "./documentMedia";
import { registerMedia } from "./mediaExport";
import { readRecent, rememberFile } from "./recentFiles";
import { svgImage } from "./svgImage";

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  native.mockReset();
});

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

  it("preserves unapproved remote URLs in prose and unvisited nested slides without network calls while packing local images", async () => {
    const png = "data:image/png;base64,aGVsbG8=";
    const svg = "data:image/svg+xml;base64,PHN2Zy8+";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected global fetch"));
    native.mockImplementation(async (command: string, args: any) => {
      if (command === "load_asset") return String(args.source).endsWith(".svg") ? svg : png;
      if (command === "fetch_resource") throw new Error(`unexpected fetch_resource: ${args?.url}`);
      return null;
    });

    // An unapproved .remote-image-card placeholder in the reader DOM must never grant consent.
    const blockedCard = document.createElement("span");
    blockedCard.className = "remote-image-card";
    blockedCard.dataset.noteImageSource = "https://untrusted.example/prose.png";
    document.body.append(blockedCard);

    const deck = {
      title: "Study sequence",
      steps: [
        {
          label: "Slide 1 (visited)",
          image: "./slide-local.png",
          markdown: "Local ![Sub](./nested-local.svg) and unapproved ![Blocked](https://untrusted.example/slide1-md.png)",
        },
        { label: "Slide 2 (unvisited)", markdown: "Unvisited ![S2](https://untrusted.example/unvisited-2.png)" },
        { label: "Slide 3 (unvisited)", description: "Plain text" },
        { label: "Slide 4 (unvisited)", image: "https://untrusted.example/unvisited-4.png" },
        {
          label: "Slide 5 (unvisited)",
          image: "https://user:pass@trusted.example/credentialed-slide.png",
          markdown: "![[https://untrusted.example/unvisited-wiki.png|Slide Wiki]]",
        },
      ],
    };
    const md = [
      "# Note",
      "",
      "![Local](./diagram.png)",
      "",
      "![Local Ref][ref-local]",
      "",
      "[ref-local]: ./local-ref.svg \"Local Title\"",
      "",
      "![[local-wiki.png|Local Wiki]]",
      "",
      "![Unapproved](https://untrusted.example/prose.png \"Remote Title\")",
      "",
      "![Remote Ref][ref-remote]",
      "",
      "[ref-remote]: https://untrusted.example/ref.png \"Keep Remote\"",
      "",
      "![[https://untrusted.example/wiki.png|Remote Wiki]]",
      "",
      "![Upper](HTTPS://untrusted.example/upper.png)",
      "",
      "![Proto](//untrusted.example/protocol-relative.png)",
      "",
      "![Cred](https://user:pass@trusted.example/cred.png)",
      "",
      '<img src="https://untrusted.example/raw-html.png" width="200">',
      "",
      "```smd-steps",
      JSON.stringify(deck, null, 2),
      "```",
      "",
    ].join("\n");

    const result = await prepareFmd(md, "/notes/study.smd", { trustedImageHosts: ["trusted.example"] });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(native).not.toHaveBeenCalledWith("fetch_resource", expect.anything());
    const loadedSources = native.mock.calls.filter(([cmd]) => cmd === "load_asset").map(([, args]) => args.source);
    expect(loadedSources.sort()).toEqual([
      "./diagram.png",
      "./local-ref.svg",
      "./nested-local.svg",
      "./slide-local.png",
      "local-wiki.png",
    ]);
    expect(Object.keys(result.assets)).toHaveLength(5);

    // Unapproved prose URLs stay intact.
    expect(result.content).toContain('![Unapproved](https://untrusted.example/prose.png "Remote Title")');
    expect(result.content).toContain('[ref-remote]: https://untrusted.example/ref.png "Keep Remote"');
    expect(result.content).toContain("![[https://untrusted.example/wiki.png|Remote Wiki]]");
    expect(result.content).toContain("![Upper](HTTPS://untrusted.example/upper.png)");
    expect(result.content).toContain("![Proto](//untrusted.example/protocol-relative.png)");
    expect(result.content).toContain("![Cred](https://user:pass@trusted.example/cred.png)");
    expect(result.content).toContain('<img src="https://untrusted.example/raw-html.png" width="200">');

    // Unvisited nested slide remote URLs stay intact while local nested images pack.
    const packedDeck = JSON.parse(/```smd-steps\n([\s\S]*?)\n```/.exec(result.content)![1]);
    expect(packedDeck.steps[0].image).toMatch(/^assets\/image-.*\.png$/);
    expect(packedDeck.steps[0].markdown).toMatch(/!\[Sub\]\(<assets\/image-.*\.svg>\)/);
    expect(packedDeck.steps[0].markdown).toContain("![Blocked](https://untrusted.example/slide1-md.png)");
    expect(packedDeck.steps[1].markdown).toBe("Unvisited ![S2](https://untrusted.example/unvisited-2.png)");
    expect(packedDeck.steps[3].image).toBe("https://untrusted.example/unvisited-4.png");
    expect(packedDeck.steps[4].image).toBe("https://user:pass@trusted.example/credentialed-slide.png");
    expect(packedDeck.steps[4].markdown).toBe("![[https://untrusted.example/unvisited-wiki.png|Slide Wiki]]");
  });

  it("packs approved remote images from note consent and trusted hosts, including unvisited nested slides, while scoping loaded reader data to the consenting note", async () => {
    const domPng = "data:image/png;base64,ZG9tLWxvYWRlZA==";
    const leakedDomPng = "data:image/png;base64,bGVha2VkLWRvbQ==";
    const cachedPng = "data:image/png;base64,Y2FjaGVkLW5vdGU=";
    const remotePng = "data:image/png;base64,cmVtb3RlLXBuZw==";
    const remoteSvg = "data:image/svg+xml;base64,PHN2Zy8+";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected global fetch"));
    native.mockImplementation(async (command: string, args: any) => {
      if (command === "fetch_resource") {
        return { body: String(args.url).endsWith(".svg") ? remoteSvg : remotePng };
      }
      throw new Error(`unexpected command: ${command}`);
    });

    // 1. Owned + approved reader DOM media for note-approved.
    const loadedSpan = document.createElement("span");
    loadedSpan.className = "note-image";
    loadedSpan.dataset.noteId = "note-approved";
    loadedSpan.dataset.noteImageSource = "https://once.example/dom-approved.png";
    const loadedImg = document.createElement("img");
    loadedSpan.append(loadedImg);
    document.body.append(loadedSpan);
    const unregisterApproved = registerMedia(loadedImg, { label: "DOM Approved", uri: () => domPng });

    // 2. DOM media belonging to a DIFFERENT note (note-other) must never be reused by note-approved or background saves.
    const otherNoteSpan = document.createElement("span");
    otherNoteSpan.className = "note-image";
    otherNoteSpan.dataset.noteId = "note-other";
    otherNoteSpan.dataset.noteImageSource = "https://once.example/other-note.png";
    const otherNoteImg = document.createElement("img");
    otherNoteSpan.append(otherNoteImg);
    document.body.append(otherNoteSpan);
    const unregisterOtherNote = registerMedia(otherNoteImg, { label: "Other Note", uri: () => leakedDomPng });

    // 3. Even a DOM element carrying note-approved's noteId must NOT be reused if note-approved's policy has not approved that URL.
    const unapprovedDomSpan = document.createElement("span");
    unapprovedDomSpan.className = "note-image";
    unapprovedDomSpan.dataset.noteId = "note-approved";
    unapprovedDomSpan.dataset.noteImageSource = "https://once.example/dom-unapproved.png";
    const unapprovedDomImg = document.createElement("img");
    unapprovedDomSpan.append(unapprovedDomImg);
    document.body.append(unapprovedDomSpan);
    const unregisterUnapproved = registerMedia(unapprovedDomImg, { label: "DOM Unapproved", uri: () => leakedDomPng });

    try {
      const deck = {
        title: "Mixed consent deck",
        steps: [
          { label: "Visited", image: "https://once.example/dom-approved.png" },
          { label: "Unvisited 2", description: "Notes" },
          { label: "Unvisited 3", description: "Notes" },
          {
            label: "Unvisited 4",
            image: "https://cdn.example/unvisited-approved.png",
            markdown: "Approved ![Diagram](https://cdn.example/unvisited-nested.svg) and unapproved ![Other](https://once.example/unapproved-sibling.png)",
          },
        ],
      };
      const md = [
        "![DOM](https://once.example/dom-approved.png)",
        "",
        "![Other Note DOM](https://once.example/other-note.png)",
        "",
        "![Unapproved DOM](https://once.example/dom-unapproved.png)",
        "",
        "![Cached](https://once.example/cached-note.png)",
        "",
        "![Explicit Note URL](https://note-only.example/one.png)",
        "",
        "![Sibling On Same Host](https://note-only.example/two.png)",
        "",
        "```smd-steps",
        JSON.stringify(deck, null, 2),
        "```",
      ].join("\n");

      const result = await prepareFmd(md, "/notes/approved.smd", {
        noteId: "note-approved",
        trustedImageHosts: ["CDN.EXAMPLE"],
        approvedImageUrls: [
          "https://once.example/dom-approved.png",
          "https://once.example/cached-note.png",
          "https://note-only.example/one.png",
        ],
        loadedImageData: {
          "https://once.example/cached-note.png": cachedPng,
          "https://note-only.example/two.png": leakedDomPng,
        },
      });

      expect(fetchSpy).not.toHaveBeenCalled();
      const fetchedUrls = native.mock.calls.filter(([cmd]) => cmd === "fetch_resource").map(([, args]) => args.url);
      // Owned+approved DOM/cache images reuse memory (zero network calls); unapproved or foreign-note images never reuse or fetch.
      expect(fetchedUrls.sort()).toEqual([
        "https://cdn.example/unvisited-approved.png",
        "https://cdn.example/unvisited-nested.svg",
        "https://note-only.example/one.png",
      ]);

      expect(Object.values(result.assets)).toEqual(expect.arrayContaining([domPng, cachedPng, remotePng, remoteSvg]));
      expect(Object.values(result.assets)).not.toContain(leakedDomPng);
      expect(result.content).toContain("![Other Note DOM](https://once.example/other-note.png)");
      expect(result.content).toContain("![Unapproved DOM](https://once.example/dom-unapproved.png)");
      expect(result.content).toContain("![Sibling On Same Host](https://note-only.example/two.png)");
      expect(result.content).not.toContain("https://once.example/dom-approved.png");
      expect(result.content).not.toContain("https://once.example/cached-note.png");
      expect(result.content).not.toContain("https://note-only.example/one.png");

      const packedDeck = JSON.parse(/```smd-steps\n([\s\S]*?)\n```/.exec(result.content)![1]);
      expect(packedDeck.steps[0].image).toMatch(/^assets\/image-.*\.png$/);
      expect(packedDeck.steps[3].image).toMatch(/^assets\/image-.*\.png$/);
      expect(packedDeck.steps[3].markdown).toMatch(/!\[Diagram\]\(<assets\/image-.*\.svg>\)/);
      expect(packedDeck.steps[3].markdown).toContain("![Other](https://once.example/unapproved-sibling.png)");

      // Background save of another note while note-approved's consented image is displayed in the DOM must NOT reuse note-approved's bytes.
      native.mockClear();
      const backgroundMd = "![DOM](https://once.example/dom-approved.png)\n";
      const backgroundSaved = await prepareFmd(backgroundMd, "/notes/background.smd", {
        noteId: "note-background",
        trustedImageHosts: [],
        approvedImageUrls: [],
      });
      expect(native).not.toHaveBeenCalled();
      expect(backgroundSaved.content).toBe(backgroundMd);
      expect(backgroundSaved.assets).toEqual({});
    } finally {
      unregisterApproved();
      unregisterOtherNote();
      unregisterUnapproved();
      loadedSpan.remove();
      otherNoteSpan.remove();
      unapprovedDomSpan.remove();
    }
  });

  it("keeps smd-steps source byte-for-byte intact and avoids network calls when saving unapproved remote slides in place", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected global fetch"));
    const md = '# Deck\n\n```smd-steps\n{\n  "title": "Unapproved",\n  "steps": [\n    { "label": "One", "image": "https://untrusted.example/s1.png" },\n    { "label": "Two", "markdown": "![Two](https://untrusted.example/s2.png)" }\n  ]\n}\n```\n';
    const result = await prepareFmd(md, "/notes/inplace.smd");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(native).not.toHaveBeenCalled();
    expect(result.content).toBe(md);
    expect(result.assets).toEqual({});
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
