// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root as ReactRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import katex from "katex";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { visit } from "unist-util-visit";
import MarkdownPreview, {
  DIAGRAM_PLAIN_TEXT_LANGUAGES,
  PREVIEW_REHYPE_PLUGINS,
  PREVIEW_REMARK_PLUGINS,
} from "./MarkdownPreview";
import CachedMarkdown, {
  cachedMarkdownTree,
  hasCachedBlockOutput,
  previewCacheStats,
} from "./CachedMarkdown";
import { analyzeDocument } from "../documentAnalysis";
import * as documentAnalysisModule from "../documentAnalysis";
import { remarkObsidianMath } from "../obsidianMath";
import { remarkSvgBlocks } from "../svgBlocks";
import { selectedMarkdown } from "../copySource";

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  constructor(readonly callback: IntersectionObserverCallback) {
    FakeIntersectionObserver.instances.push(this);
  }
  observe() {}
  unobserve() {}
  disconnect() {}
  emitMany(targets: Element[], isIntersecting: boolean) {
    this.callback(
      targets.map(target => ({ target, isIntersecting }) as IntersectionObserverEntry),
      this as unknown as IntersectionObserver,
    );
  }
}

class FakeResizeObserver {
  constructor(_callback: ResizeObserverCallback) {}
  observe() {}
  disconnect() {}
}

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: ReactRoot | null = null;
afterEach(() => {
  if (root) {
    act(() => root?.unmount());
    root = null;
  }
  document.body.innerHTML = "";
  FakeIntersectionObserver.instances = [];
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("fast windowed Markdown preview rendering", () => {
  it("mounts 40 to 200 windowed plain prose blocks without math typesetting, grammar setup, or block copying", async () => {
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);

    const proseMarkdown = Array.from(
      { length: 450 },
      (_, i) =>
        `## Prose Chapter ${i}\n\n` +
        `Paragraph ${i} carries **emphasis**, \`inlineCode()\`, and [a link](https://example.org/${i}) without math or fenced code blocks. `.repeat(2),
    ).join("\n\n");
    expect(proseMarkdown.length).toBeGreaterThan(80_000);

    const host = document.createElement("div");
    host.className = "android-reading";
    document.body.append(host);
    root = createRoot(host);

    await act(async () => {
      root?.render(<MarkdownPreview markdown={proseMarkdown} documentPath={null} python="" dark={false} />);
    });

    const blocks = Array.from(host.querySelectorAll<HTMLElement>("[data-windowed-block]"));
    expect(blocks.length).toBeGreaterThanOrEqual(400);

    const cloneSpy = vi.spyOn(globalThis, "structuredClone");
    const katexSpy = vi.spyOn(katex, "renderToString");
    const observer = FakeIntersectionObserver.instances[0]!;

    // Warm one render pass, then time 40 and 200 prose block mounts
    await act(async () => observer.emitMany(blocks.slice(0, 40), true));
    expect(cloneSpy).not.toHaveBeenCalled();
    expect(katexSpy).not.toHaveBeenCalled();
    expect(host.querySelectorAll("[data-windowed-mounted='true']")).toHaveLength(40);
    await act(async () => observer.emitMany(blocks.slice(0, 40), false));

    await act(async () => observer.emitMany(blocks.slice(40, 240), true));

    expect(cloneSpy).not.toHaveBeenCalled();
    expect(katexSpy).not.toHaveBeenCalled();
    expect(host.querySelectorAll("[data-windowed-mounted='true']")).toHaveLength(200);
    expect(host.textContent).toContain("Paragraph 100 carries");
  });

  it("caches rendered math and highlighted code blocks across scroll sweeps without recomputation", async () => {
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);

    const filler = Array.from(
      { length: 420 },
      (_, i) => `## Filler ${i}\n\n${"Windowed prose filler text to exceed the eighty-thousand-character threshold. ".repeat(3)}`,
    ).join("\n\n");
    const markdown = [
      "## Technical Section",
      "",
      "Inline formula $a^2 + b^2 = c^2$ inside prose.",
      "",
      "$$\\int_0^1 x^2 \\, dx = \\frac{1}{3}$$",
      "",
      "```python",
      "def square(value):",
      "    return value * value",
      "```",
      "",
      "```typescript",
      "export const answer: number = 42;",
      "```",
      "",
      filler,
    ].join("\n");
    expect(markdown.length).toBeGreaterThan(80_000);

    const deferredTree = cachedMarkdownTree(markdown, PREVIEW_REMARK_PLUGINS, [], true);
    const elementBlocks = deferredTree.children.filter((n: any) => n.type !== "text" || n.value.trim());

    const host = document.createElement("div");
    host.className = "android-reading";
    document.body.append(host);
    root = createRoot(host);

    await act(async () => {
      root?.render(<MarkdownPreview markdown={markdown} documentPath={null} python="python3" dark={false} />);
    });

    const cloneSpy = vi.spyOn(globalThis, "structuredClone");
    const katexSpy = vi.spyOn(katex, "renderToString");
    const observer = FakeIntersectionObserver.instances[0]!;
    const domBlocks = Array.from(host.querySelectorAll<HTMLElement>("[data-windowed-block]"));
    const technicalBlocks = domBlocks.slice(0, 5);

    // Initial scroll into view computes math and code highlighting once
    await act(async () => observer.emitMany(technicalBlocks, true));
    expect(host.querySelectorAll(".katex").length).toBe(2);
    expect(host.querySelector(".katex-display")).not.toBeNull();
    expect(host.querySelector(".python-cell .hljs-keyword")?.textContent).toBe("def");
    expect(host.querySelector(".code-container .hljs-keyword")?.textContent).toBe("export");
    expect(katexSpy).toHaveBeenCalledTimes(2);
    // Heading is plain prose (0 clones); inline math, display math, python, ts = 4 clones
    expect(cloneSpy).toHaveBeenCalledTimes(4);
    expect(hasCachedBlockOutput(elementBlocks[0])).toBe(false);
    expect(hasCachedBlockOutput(elementBlocks[1])).toBe(true);
    expect(hasCachedBlockOutput(elementBlocks[2])).toBe(true);
    expect(hasCachedBlockOutput(elementBlocks[3])).toBe(true);
    expect(hasCachedBlockOutput(elementBlocks[4])).toBe(true);

    // Scroll out of view: DOM unmounts expanded trees
    await act(async () => observer.emitMany(technicalBlocks, false));
    expect(host.querySelectorAll(".katex")).toHaveLength(0);
    expect(host.querySelector(".python-cell")).toBeNull();
    expect(host.querySelector(".code-container")).toBeNull();

    // Scroll back into view: served from in-memory block cache with zero recomputation
    cloneSpy.mockClear();
    katexSpy.mockClear();
    await act(async () => observer.emitMany(technicalBlocks, true));
    expect(katexSpy).not.toHaveBeenCalled();
    expect(cloneSpy).not.toHaveBeenCalled();
    expect(host.querySelectorAll(".katex").length).toBe(2);
    expect(host.querySelector(".python-cell .hljs-keyword")?.textContent).toBe("def");
    expect(host.querySelector(".code-container .hljs-keyword")?.textContent).toBe("export");
  });

  it("treats SVG, Mermaid, tree, diagram, step, and chart fences as plain text without tokenization while preserving identical output", async () => {
    expect(DIAGRAM_PLAIN_TEXT_LANGUAGES).toEqual([
      "svg",
      "mermaid",
      "smd-tree",
      "smd-diagram",
      "smd-steps",
      "smd-chart",
    ]);

    const diagramNote = [
      "```svg",
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 40"><rect width="80" height="20" fill="#336699"/></svg>',
      "```",
      "",
      "```mermaid",
      "graph LR",
      "  Start --> Finish",
      "```",
      "",
      "```smd-tree",
      '{"title":"Heap tree","values":["50","30","40"]}',
      "```",
      "",
      "```smd-diagram",
      '{"title":"Client Server","width":320,"height":160,"nodes":[{"id":"c","label":"Client","x":80,"y":80},{"id":"s","label":"Server","x":240,"y":80}],"edges":[{"from":"c","to":"s"}]}',
      "```",
      "",
      "```smd-steps",
      '{"title":"Pipeline","steps":[{"label":"Parse","description":"Analyze once."},{"label":"Render","description":"Reuse shared pipeline."}]}',
      "```",
      "",
      "```smd-chart",
      '{"title":"Velocity","series":[{"points":[[0,1],[1,3]]}]}',
      "```",
      "",
      "```python",
      "total = 1 + 2",
      "```",
    ].join("\n");

    const fullTree = cachedMarkdownTree(diagramNote, PREVIEW_REMARK_PLUGINS, PREVIEW_REHYPE_PLUGINS, false);
    const codeNodes: Array<{ classes: string[]; childTypes: string[] }> = [];
    visit(fullTree, "element", (node: any, _index, parent: any) => {
      if (node.tagName === "code" && parent?.tagName === "pre") {
        codeNodes.push({
          classes: Array.isArray(node.properties?.className) ? node.properties.className.map(String) : [],
          childTypes: (node.children || []).map((child: any) => child.type),
        });
      }
    });

    // All 6 diagram fences keep plain text children and never gain hljs classes/spans
    for (const lang of DIAGRAM_PLAIN_TEXT_LANGUAGES) {
      const match = codeNodes.find(entry => entry.classes.includes(`language-${lang}`));
      expect(match, `expected code fence for ${lang}`).toBeDefined();
      expect(match!.classes).not.toContain("hljs");
      expect(match!.childTypes).toEqual(["text"]);
    }
    // Python code fence still receives syntax highlighting
    const pythonNode = codeNodes.find(entry => entry.classes.includes("language-python"));
    expect(pythonNode?.classes).toContain("hljs");
    expect(pythonNode?.childTypes).toContain("element");

    // Static rendered HTML for diagrams matches legacy un-excluded rehypeHighlight output identically
    const nonMermaidDiagrams = diagramNote.replace(/```mermaid[\s\S]*?```\n\n/, "");
    const legacyHtml = renderToStaticMarkup(
      <article className="markdown-body">
        <CachedMarkdown
          remarkPlugins={[remarkGfm, remarkMath, remarkObsidianMath, remarkSvgBlocks, ...PREVIEW_REMARK_PLUGINS]}
          rehypePlugins={[rehypeKatex, rehypeHighlight]}
          components={{}}
        >
          {nonMermaidDiagrams.split("```python")[0]}
        </CachedMarkdown>
      </article>,
    );
    expect(legacyHtml).toContain("language-svg");

    const previewHtml = renderToStaticMarkup(
      <MarkdownPreview markdown={nonMermaidDiagrams} documentPath={null} python="python3" dark={false} />,
    );
    expect(previewHtml).toContain("Heap tree");
    expect(previewHtml).toContain("Pipeline");
    expect(previewHtml).toContain("Velocity");
    expect(previewHtml).toContain("Client");
    expect(previewHtml).toContain('class="hljs-number"');

    // In windowed mode (>80,000 chars), mounting diagram fences skips block cloning and highlighting
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const windowedDiagrams = `${diagramNote.split("```python")[0]}\n\n${"Plain filler paragraph. ".repeat(3_600)}`;
    expect(windowedDiagrams.length).toBeGreaterThan(80_000);

    const host = document.createElement("div");
    host.className = "android-reading";
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(<MarkdownPreview markdown={windowedDiagrams} documentPath={null} python="" dark={false} />);
    });
    const cloneSpy = vi.spyOn(globalThis, "structuredClone");
    const observer = FakeIntersectionObserver.instances[0]!;
    const firstSix = Array.from(host.querySelectorAll<HTMLElement>("[data-windowed-block]")).slice(0, 6);
    await act(async () => observer.emitMany(firstSix, true));
    expect(cloneSpy).not.toHaveBeenCalled();
  });

  it("omits duplicate table, math, and SVG Remark passes in preview while honoring custom pipelines", () => {
    expect(PREVIEW_REMARK_PLUGINS).toHaveLength(4);
    expect(PREVIEW_REMARK_PLUGINS).not.toContain(remarkGfm);
    expect(PREVIEW_REMARK_PLUGINS).not.toContain(remarkMath);
    expect(PREVIEW_REMARK_PLUGINS).not.toContain(remarkObsidianMath);
    expect(PREVIEW_REMARK_PLUGINS).not.toContain(remarkSvgBlocks);

    const analyzeSpy = vi.spyOn(documentAnalysisModule, "analyzeDocument");

    const uncachedNote = [
      "# Uncached Technical Note",
      "",
      "| Metric | Formula |",
      "| --- | --- |",
      "| Norm | $P(|X| > 1)$ |",
      "",
      "$$E = mc^2$$",
      "",
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20">',
      "",
      '<circle cx="10" cy="10" r="5"/>',
      "</svg>",
    ].join("\n");

    const html = renderToStaticMarkup(
      <MarkdownPreview markdown={uncachedNote} documentPath={null} python="" dark={false} />,
    );

    // analyzeDocument ran once to parse tables, math, and SVG blocks, and preview rendered them without repeating those Remark passes
    expect(analyzeSpy).toHaveBeenCalledTimes(1);
    expect(html).toContain("<table ");
    expect(html).toContain('class="katex"');
    expect(html).toContain('class="katex-display"');
    expect(html).toContain("svg-diagram");

    // Custom remark and rehype pipelines on the exact same source are honored without cache collision
    const customRemarkCalls = vi.fn();
    const customRehypeCalls = vi.fn();
    const customRemark = () => {
      customRemarkCalls();
      return (tree: any) => {
        visit(tree, "heading", (node: any) => {
          node.data = { ...node.data, hProperties: { ...node.data?.hProperties, "data-custom-remark": "applied" } };
        });
      };
    };
    const customRehype = () => {
      customRehypeCalls();
      return (tree: any) => {
        visit(tree, "element", (node: any) => {
          if (node.tagName === "table") node.properties = { ...node.properties, "data-custom-rehype": "applied" };
        });
      };
    };

    const customTree = cachedMarkdownTree(uncachedNote, [customRemark], [customRehype], false);
    const secondNote = uncachedNote + "\n\nTrailing paragraph.";
    cachedMarkdownTree(secondNote, [customRemark], [customRehype], false);

    // Custom pipeline attachers initialized once and reused across uncached documents
    expect(customRemarkCalls).toHaveBeenCalledTimes(1);
    expect(customRehypeCalls).toHaveBeenCalledTimes(1);

    const customHeading = customTree.children.find((n: any) => n.type === "element" && n.tagName === "h1") as any;
    const customTable = customTree.children.find((n: any) => n.type === "element" && n.tagName === "table") as any;
    expect(customHeading?.properties?.["data-custom-remark"]).toBe("applied");
    expect(customTable?.properties?.["data-custom-rehype"]).toBe("applied");
  });

  it("isolates shared analysis data and preserves HTML neutralization, URL sanitization, tasks, references, footnotes, copy offsets, and windowing thresholds", async () => {
    const basePng = "data:image/png;base64,iVBORw0KGgo=";
    const baseSvg = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=";
    const richNote = [
      "# Heading Anchor",
      "",
      "## Heading Anchor",
      "",
      "> [!note] Callout Title",
      "> Callout body with [ref][target] and footnote[^fn1].",
      "",
      "- [ ] Toggleable task",
      "- [x] Completed task",
      "",
      `<script>window.pwned = true;</script>`,
      "",
      `![Safe PNG](${basePng})`,
      "",
      `![Safe SVG](${baseSvg})`,
      "",
      `[Blocked JS](javascript:alert(1))`,
      "",
      "```python",
      "x = 10",
      "```",
      "",
      "[target]: https://example.com/safe",
      "[^fn1]: Footnote explanation.",
    ].join("\n");

    const analysis = analyzeDocument(richNote);
    const snapshotBefore = structuredClone(analysis);

    const onChange = vi.fn();
    const host = document.createElement("div");
    host.className = "android-reading";
    document.body.append(host);
    root = createRoot(host);

    await act(async () => {
      root?.render(
        <MarkdownPreview
          markdown={richNote}
          documentPath="/tmp/doc.md"
          python="python3"
          dark={false}
          onChange={onChange}
          sourceAnalysis={{ source: richNote, analysis }}
        />,
      );
    });

    // Shared document analysis remains completely unmutated by preview transforms
    expect(analysis).toEqual(snapshotBefore);

    // Raw HTML converted to harmless text, dangerous URLs stripped, base64 images preserved
    expect(host.querySelector("script")).toBeNull();
    expect(host.textContent).toContain("<script>window.pwned = true;</script>");
    const images = Array.from(host.querySelectorAll("img")).map(img => img.getAttribute("src"));
    expect(images).toContain(basePng);
    expect(images).toContain(baseSvg);
    const blockedLink = Array.from(host.querySelectorAll("a")).find(a => a.textContent === "Blocked JS");
    expect(blockedLink?.getAttribute("href") ?? "").not.toContain("javascript:");

    // Duplicate headings, reference links, footnotes, tasks, and Python cells preserved
    expect(host.querySelector("#heading-anchor")).not.toBeNull();
    expect(host.querySelector("#heading-anchor-1")).not.toBeNull();
    const safeLink = Array.from(host.querySelectorAll("a")).find(a => a.textContent === "ref");
    expect(safeLink?.getAttribute("href")).toBe("https://example.com/safe");
    expect(host.textContent).toContain("Footnote explanation.");
    expect(host.querySelector(".python-cell")).not.toBeNull();

    const checkboxes = host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    expect(checkboxes).toHaveLength(2);
    await act(async () => checkboxes[0].click());
    expect(onChange).toHaveBeenCalledWith(richNote.replace("- [ ] Toggleable task", "- [x] Toggleable task"));

    // Windowing threshold: exactly 80,000 chars renders without windowing; 80,001 chars windows
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const exact80k = `# Exact\n\n${"a".repeat(80_000 - 9)}`;
    expect(exact80k.length).toBe(80_000);
    await act(async () => {
      root?.render(<MarkdownPreview markdown={exact80k} documentPath={null} python="" dark={false} />);
    });
    expect(host.querySelectorAll("[data-windowed-block]")).toHaveLength(0);

    const over80k = `Before\n\n$$y = x^2$$\n\n${"After prose block. ".repeat(4_300)}`;
    expect(over80k.length).toBeGreaterThan(80_000);
    await act(async () => {
      root?.render(<MarkdownPreview markdown={over80k} documentPath={null} python="" dark={false} />);
    });
    const windowedBlocks = Array.from(host.querySelectorAll<HTMLElement>("[data-windowed-block]"));
    expect(windowedBlocks.length).toBeGreaterThan(1);
    // Mount first block, keep math block unmounted, and verify source copy across offscreen block
    await act(async () => FakeIntersectionObserver.instances.at(-1)!.emitMany([windowedBlocks[0]], true));
    const range = document.createRange();
    range.selectNode(windowedBlocks[1]);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    expect(selectedMarkdown(selection, over80k)).toBe("$$y = x^2$$");
    range.setStartBefore(windowedBlocks[0]);
    range.setEndAfter(windowedBlocks[1]);
    selection.removeAllRanges();
    selection.addRange(range);
    expect(selectedMarkdown(selection, over80k)).toContain("Before");
    expect(selectedMarkdown(selection, over80k)).toContain("$$y = x^2$$");
    selection.removeAllRanges();
  });

  it("stays within the 24 MB / 512-entry cap and releases cached block outputs when parent documents evict", async () => {
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);

    const parentDoc = [
      "$$\\sum_{k=1}^{n} k = \\frac{n(n+1)}{2}$$",
      "",
      "```python",
      "value = 123",
      "```",
      "",
      "Windowed padding text. ".repeat(3_600),
    ].join("\n");
    expect(parentDoc.length).toBeGreaterThan(80_000);

    const deferredTree = cachedMarkdownTree(parentDoc, PREVIEW_REMARK_PLUGINS, [], true);
    const parentBlocks = deferredTree.children.filter((n: any) => n.type !== "text" || n.value.trim());

    const host = document.createElement("div");
    host.className = "android-reading";
    document.body.append(host);
    root = createRoot(host);

    await act(async () => {
      root?.render(<MarkdownPreview markdown={parentDoc} documentPath={null} python="" dark={false} />);
    });
    const observer = FakeIntersectionObserver.instances[0]!;
    const domBlocks = Array.from(host.querySelectorAll<HTMLElement>("[data-windowed-block]"));
    await act(async () => observer.emitMany(domBlocks.slice(0, 2), true));

    expect(hasCachedBlockOutput(parentBlocks[0])).toBe(true);
    expect(hasCachedBlockOutput(parentBlocks[1])).toBe(true);
    let stats = previewCacheStats();
    expect(stats.retained).toBeLessThanOrEqual(24_000_000);
    expect(stats.documents + stats.blocks).toBeLessThanOrEqual(512);

    // Unmount active view and exceed the 512-entry cap so parentDoc evicts
    await act(async () => root?.unmount());
    root = null;
    const emptyAnalysis = analyzeDocument("# Minimal");
    for (let i = 0; i < 520; i++) {
      const probe = `# Eviction probe ${i}`;
      cachedMarkdownTree(probe, PREVIEW_REMARK_PLUGINS, PREVIEW_REHYPE_PLUGINS, false, {
        source: probe,
        analysis: emptyAnalysis,
      });
    }

    stats = previewCacheStats();
    expect(stats.documents).toBeLessThanOrEqual(512);
    expect(stats.documents + stats.blocks).toBeLessThanOrEqual(512);
    expect(stats.retained).toBeLessThanOrEqual(24_000_000);
    expect(hasCachedBlockOutput(parentBlocks[0])).toBe(false);
    expect(hasCachedBlockOutput(parentBlocks[1])).toBe(false);

    // Byte-cap eviction (>24 MB) also releases child block outputs automatically
    const byteParent = [
      "$$\\alpha + \\beta = \\gamma$$",
      "",
      "Byte cap windowed padding. ".repeat(3_500),
    ].join("\n");
    const byteTree = cachedMarkdownTree(byteParent, PREVIEW_REMARK_PLUGINS, [], true);
    const byteMathNode = byteTree.children.filter((n: any) => n.type !== "text" || n.value.trim())[0];
    root = createRoot(host);
    await act(async () => {
      root?.render(<MarkdownPreview markdown={byteParent} documentPath={null} python="" dark={false} />);
    });
    await act(async () =>
      FakeIntersectionObserver.instances.at(-1)!.emitMany(
        [host.querySelector<HTMLElement>("[data-windowed-block]")!],
        true,
      ),
    );
    expect(hasCachedBlockOutput(byteMathNode)).toBe(true);
    await act(async () => root?.unmount());
    root = null;

    // Insert 6 large documents (~5 MB weight each) to exceed 24 MB with only 6 entries
    for (let i = 0; i < 6; i++) {
      const largeDoc = `# Large byte eviction ${i}\n\n${"x".repeat(2_500_000)}`;
      cachedMarkdownTree(largeDoc, [], [], true, {
        source: largeDoc,
        analysis: emptyAnalysis,
      });
    }
    stats = previewCacheStats();
    expect(stats.retained).toBeLessThanOrEqual(24_000_000);
    expect(hasCachedBlockOutput(byteMathNode)).toBe(false);
  });

  it("renders unchanged DOM output across real windowed preview blocks with and without supplied source analysis", async () => {
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);

    const safePng = "data:image/png;base64,iVBORw0KGgo=";
    const richWindowedMarkdown = [
      "---",
      "title: Windowed Pipeline Verification",
      "tags: [preview, ast]",
      "---",
      "",
      "# Windowed Pipeline Heading",
      "",
      "> [!tip] **Callout** with $a^2 + b^2 = c^2$",
      "> Study ==highlight==, H~2~O, x^2^, <kbd onclick=\"alert(1)\">Ctrl</kbd>+<mark style=\"color:red\">K</mark><br/>next line.",
      "",
      "| Syntax | Expression |",
      "| :--- | ---: |",
      "| Conditional | $P(A | B)$ |",
      "",
      "- [ ] Task item with [reference][doc-ref] and footnote[^wfn]",
      "",
      "<script>window.unwanted = true;</script>",
      "",
      `![Embedded PNG](${safePng}) and [Blocked](javascript:alert(1))`,
      "",
      "$$\\int_0^1 x^3 \\, dx = \\frac{1}{4}$$",
      "",
      "```{.python}",
      "result = 6 * 7",
      "```",
      "",
      "```smd-steps",
      '{"title":"Transform","steps":[{"label":"Analyze","description":"Parse Markdown once."},{"label":"Render","description":"Transform pre-parsed tree."}]}',
      "```",
      "",
      ...Array.from(
        { length: 420 },
        (_, i) => `## Chapter ${i}\n\n${"Windowed preview paragraph preserving pre-parsed document semantics. ".repeat(3)}`,
      ),
      "",
      "[doc-ref]: https://example.org/windowed",
      "[^wfn]: Windowed footnote body.",
    ].join("\n");
    expect(richWindowedMarkdown.length).toBeGreaterThan(80_000);

    const suppliedAnalysis = {
      source: richWindowedMarkdown,
      analysis: analyzeDocument(richWindowedMarkdown),
    };
    const analyzeSpy = vi.spyOn(documentAnalysisModule, "analyzeDocument");

    const renderWindowed = async (withSuppliedAnalysis: boolean) => {
      const container = document.createElement("div");
      container.className = "android-reading";
      document.body.append(container);
      const localRoot = createRoot(container, { identifierPrefix: "windowed-parity-" });
      await act(async () => {
        localRoot.render(
          <MarkdownPreview
            markdown={richWindowedMarkdown}
            documentPath="/tmp/windowed-note.md"
            python="python3"
            dark={false}
            onChange={() => {}}
            sourceAnalysis={withSuppliedAnalysis ? suppliedAnalysis : undefined}
          />,
        );
      });
      const observer = FakeIntersectionObserver.instances.at(-1)!;
      const blocks = Array.from(container.querySelectorAll<HTMLElement>("[data-windowed-block]"));
      expect(blocks.length).toBeGreaterThan(420);
      // Reveal the rich technical header blocks and the final footnote section
      await act(async () => {
        observer.emitMany([...blocks.slice(0, 12), ...blocks.slice(-3)], true);
      });
      const html = container.innerHTML.replace(/data-step-deck-id="[^"]*"/g, 'data-step-deck-id="deck"');
      act(() => localRoot.unmount());
      container.remove();
      return html;
    };

    const suppliedHtml = await renderWindowed(true);
    expect(analyzeSpy).not.toHaveBeenCalledWith(richWindowedMarkdown);

    const unsuppliedNote = richWindowedMarkdown.replace("result = 6 * 7", "result = 6 * 7 # fresh");
    const freshContainer = document.createElement("div");
    freshContainer.className = "android-reading";
    document.body.append(freshContainer);
    root = createRoot(freshContainer);
    await act(async () => {
      root?.render(
        <MarkdownPreview
          markdown={unsuppliedNote}
          documentPath="/tmp/windowed-note.md"
          python="python3"
          dark={false}
          onChange={() => {}}
        />,
      );
    });
    expect(analyzeSpy).toHaveBeenCalledWith(unsuppliedNote);
    const freshObserver = FakeIntersectionObserver.instances.at(-1)!;
    const freshBlocks = Array.from(freshContainer.querySelectorAll<HTMLElement>("[data-windowed-block]"));
    await act(async () => {
      freshObserver.emitMany([...freshBlocks.slice(0, 12), ...freshBlocks.slice(-3)], true);
    });

    const baselineHtml = await renderWindowed(false);
    expect(suppliedHtml).toBe(baselineHtml);
    expect(suppliedHtml).toContain("Windowed Pipeline Verification");
    expect(suppliedHtml).toContain('id="windowed-pipeline-heading"');
    expect(suppliedHtml).toContain('class="callout callout-tip"');
    expect(suppliedHtml).toContain("<mark>highlight</mark>");
    expect(suppliedHtml).toContain("H<sub>2</sub>O");
    expect(suppliedHtml).toContain("x<sup>2</sup>");
    expect(suppliedHtml).toContain("<kbd>Ctrl</kbd>+<mark>K</mark><br>");
    expect(suppliedHtml).not.toContain("onclick");
    expect(suppliedHtml).not.toContain("color:red");
    expect(suppliedHtml).toContain("<table");
    expect(suppliedHtml).toContain('class="katex-display"');
    expect(suppliedHtml).toContain('class="python-cell"');
    expect(suppliedHtml).toContain("Transform");
    expect(suppliedHtml).toContain('href="https://example.org/windowed"');
    expect(suppliedHtml).toContain("Windowed footnote body.");
    expect(suppliedHtml).toContain(`src="${safePng}"`);
    expect(suppliedHtml).not.toContain("javascript:");
    expect(suppliedHtml).not.toContain("<script");
    expect(suppliedHtml).toContain("&lt;script&gt;window.unwanted = true;&lt;/script&gt;");
    expect(freshContainer.querySelector(".python-cell")?.textContent).toContain("# fresh");
  });
});
