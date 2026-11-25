import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import MarkdownPreview, { normalizeCallouts } from "./MarkdownPreview";
import { analyzeDocument } from "../documentAnalysis";

describe("Obsidian callouts", () => {
  it('keeps rich inline title formatting in the title rather than moving it into the body',()=>{
    const html=renderToStaticMarkup(<MarkdownPreview markdown={'> [!tip] **Useful** $x^2$ [reference](https://example.com)\n> Body stays below.'} documentPath={null} python="" dark/>);
    const title=html.match(/class="callout-title"[^>]*>([\s\S]*?)<\/p>/)?.[1]||'';
    expect(title).toMatch(/<strong[^>]*>Useful<\/strong>/);expect(title).toContain('class="katex"');expect(title).toContain('reference');
    expect(title).not.toContain('Body stays below.');expect(html.match(/Body stays below\./g)).toHaveLength(1);
  });
  it("renders a tip with its title and body", () => {
    const html = renderToStaticMarkup(
      <MarkdownPreview
        markdown={"> [!tip] How to read this in the morning\n> On the first pass, read normally and pause."}
        documentPath={null}
        python=""
        dark
      />
    );
    expect(html).toContain('class="callout callout-tip"');
    expect(html).toContain('class="callout-title"');
    expect(html).toContain("How to read this in the morning");
    expect(html).toContain("On the first pass, read normally and pause.");
    expect(html).not.toContain("[!tip]");
  });

  it("keeps portable callout content", () => {
    const html = renderToStaticMarkup(
      <MarkdownPreview
        markdown={':::callout warning "No silent code execution"\nPython runs only on click.\n:::'}
        documentPath={null}
        python=""
        dark
      />
    );
    expect(html).toContain('class="callout callout-warning"');
    expect(html).toContain("No silent code execution");
    expect(html).toContain("Python runs only on click.");
  });
});

describe("supplied source analysis rendering", () => {
  it("preserves math, headings, tasks, references, footnotes, and Python blocks", () => {
    const markdown = [
      "# Supplied analysis heading",
      "",
      "A reference [source][destination] and a footnote[^note].",
      "",
      "[destination]: https://example.org/reference",
      "[^note]: Generated footnote detail.",
      "",
      "- [ ] A task with $x^2$",
      "",
      "```python",
      "print('unchanged')",
      "```",
    ].join("\n");
    const sourceAnalysis = { source: markdown, analysis: analyzeDocument(markdown) };
    const props = { markdown, documentPath: null, python: "", dark: false };
    const withoutSupplied = renderToStaticMarkup(<MarkdownPreview {...props} />);
    const withSupplied = renderToStaticMarkup(<MarkdownPreview {...props} sourceAnalysis={sourceAnalysis} />);

    expect(withSupplied).toBe(withoutSupplied);
    expect(withSupplied).toContain('id="supplied-analysis-heading"');
    expect(withSupplied).toContain('class="katex"');
    expect(withSupplied).toContain('type="checkbox"');
    expect(withSupplied).toContain('href="https://example.org/reference"');
    expect(withSupplied).toContain("Generated footnote detail.");
    expect(withSupplied).toContain('class="python-cell"');
    expect(withSupplied).toContain("unchanged");
  });
});

describe("image references", () => {
  it("encodes spaces in Obsidian image embeds", () => {
    expect(normalizeCallouts("![[DM Images/proof-method-guide.png]]"))
      .toBe("![DM Images/proof-method-guide.png](DM%20Images/proof-method-guide.png)");
  });
});

describe("executable Python cells", () => {
  it('server rendering never drops large-note content when IntersectionObserver exists',()=>{
    const previous=globalThis.IntersectionObserver;
    Object.assign(globalThis,{IntersectionObserver:class {}});
    try {
      const markdown=Array.from({length:500},(_,i)=>`## Chapter ${i}\n\n${'Full note text. '.repeat(12)} $x_${i}^2$\n\n`).join('');
      const html=renderToStaticMarkup(<MarkdownPreview markdown={markdown} documentPath={null} python="" dark={false}/>);
      expect(html.match(/class="katex"/g)).toHaveLength(500);expect(html).toContain('Chapter 499');expect(html).not.toContain('data-windowed-block');
    } finally {Object.assign(globalThis,{IntersectionObserver:previous});}
  }, 15_000); // 500 complete KaTeX trees on the shared Intel macOS runner.
  it("preserves syntax highlighting without changing the executable source", () => {
    const html = renderToStaticMarkup(<MarkdownPreview markdown={"```python\nimport numpy as np\nprint('hello')\n```"} documentPath={null} python="python3" dark={false} />);
    expect(html).toContain('class="hljs-keyword"');
    expect(html).toContain('class="hljs-string"');
    expect(html).toContain('class="python-cell"');
    expect(html).toContain("Run");
  });

  it("renders smd-chart point arrays, NumPy [[1, 2]] cells, and inline/fenced Obsidian examples without mutating code", () => {
    const markdown = [
      "Documenting `[[Project Notes]]` and `![[diagram.png]]` alongside [[Note|real prose]].",
      "",
      "```smd-chart",
      '{"title":"Sample curve","series":[{"points":[[0,1],[1,2]]}]}',
      "```",
      "",
      "```python",
      "arr = [[1, 2]]",
      "```",
      "",
      "```markdown",
      ":::callout tip Example",
      ":::",
      "```",
    ].join("\n");
    const html = renderToStaticMarkup(<MarkdownPreview markdown={markdown} documentPath={null} python="python3" dark={false} />);
    expect(html).not.toContain("chart-warning");
    expect(html).not.toContain("render-error");
    expect(html).toContain("Sample curve");
    expect(html).toContain("<code>[[Project Notes]]</code>");
    expect(html).toContain("<code>![[diagram.png]]</code>");
    expect(html).toContain('href="Note.md"');
    expect(html).toContain('arr = [[<span class="hljs-number">1</span>, <span class="hljs-number">2</span>]]');
    expect(html).toContain(":::callout tip Example");
  });
});

describe("study Markdown and safe inline HTML", () => {
  it("renders subscript, superscript, highlight, double-tilde strikethrough, comments, and allowlisted inline HTML", () => {
    const markdown = [
      "<!-- block comment",
      "still hidden -->",
      "",
      "Formula H~2~O and x^2^ with ==core concept== and ~~retired~~ %%obsidian hidden%%<!-- inline hidden -->.",
      "",
      'Press <kbd onclick="alert(1)">Ctrl</kbd>+<kbd class="key">K</kbd>, <mark style="color:red">focus</mark>, <u>underlined</u>, H<sub>2</sub>SO<sub>4</sub>, 10<sup>-3</sup>, line one<br/>line two.',
      "",
      "| Term | Notes |",
      "|---|---|",
      "| ==ATP== | First<br>Second |",
    ].join("\n");

    const html = renderToStaticMarkup(<MarkdownPreview markdown={markdown} documentPath={null} python="" dark={false} />);
    expect(html).toMatch(/Formula H<sub>2<\/sub>O and x<sup>2<\/sup> with <mark>core concept<\/mark> and <del[^>]*>retired<\/del> \./);
    expect(html).not.toMatch(/<del[^>]*>2<\/del>/);
    expect(html).not.toContain("obsidian hidden");
    expect(html).not.toContain("inline hidden");
    expect(html).not.toContain("still hidden");
    expect(html).toContain("<kbd>Ctrl</kbd>+<kbd>K</kbd>");
    expect(html).toContain("<mark>focus</mark>");
    expect(html).toContain("<u>underlined</u>");
    expect(html).toContain("H<sub>2</sub>SO<sub>4</sub>");
    expect(html).toContain("10<sup>-3</sup>");
    expect(html).toContain("line one<br/>line two.");
    expect(html).toMatch(/<td[^>]*><mark>ATP<\/mark><\/td><td[^>]*>First<br\/>Second<\/td>/);
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("style=\"color:red\"");
  });

  it("rejects spaces in sub/sup, keeps unmatched markers and non-allowlisted HTML inert, and protects code, math, and URLs", () => {
    const markdown = [
      "Spaced ~not sub~ and ^not sup^, prose if a == b and c == d or a === b, escaped \\~lit\\~ and \\==lit==.",
      "",
      "Side by side: \\==Literal markup==, &#61;=Entity==, and \\\\==After slash== vs ==Real highlight==, H\\~2~O and H\\~2\\~O and \\~lit~ vs H~2~O and ~sub~, x\\^2^ and x\\^2\\^ vs x^2^, \\%%kept\\%% vs %%stripped%%.",
      "",
      "> Quote line one",
      "> \\==Quoted literal== vs ==Quoted highlight==",
      "",
      "Unmatched <mark>open only and stray </kbd> and self-closing <mark/>.",
      "",
      "Inline <script>alert(1)</script> and URL https://example.edu/~alice/notes~1.",
      "",
      "<script>window.pwned = true</script>",
      "",
      "Code `H~2~O ==hi== ^2^ %%keep%% <kbd>x</kbd>` and math $x^2 + y_1$.",
      "",
      "```python",
      "%%timeit value = a == b",
      "```",
    ].join("\n");

    const html = renderToStaticMarkup(<MarkdownPreview markdown={markdown} documentPath={null} python="" dark={false} />);
    expect(html).toContain("Spaced ~not sub~ and ^not sup^, prose if a == b and c == d or a === b, escaped ~lit~ and ==lit==.");
    expect(html).toContain("Side by side: ==Literal markup==, ==Entity==, and \\<mark>After slash</mark> vs <mark>Real highlight</mark>, H~2~O and H~2~O and ~lit~ vs H<sub>2</sub>O and <sub>sub</sub>, x^2^ and x^2^ vs x<sup>2</sup>, %%kept%% vs .");
    expect(html).not.toContain("stripped");
    expect(html).toContain("Quote line one\n==Quoted literal== vs <mark>Quoted highlight</mark>");
    expect(html).toContain("Unmatched &lt;mark&gt;open only and stray &lt;/kbd&gt; and self-closing &lt;mark/&gt;.");
    expect(html).toContain("Inline &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;script&gt;window.pwned = true&lt;/script&gt;");
    expect(html).not.toContain("<script");
    expect(html).toContain('href="https://example.edu/~alice/notes~1"');
    expect(html).toContain(">https://example.edu/~alice/notes~1</a>");
    expect(html).toContain("<code>H~2~O ==hi== ^2^ %%keep%% &lt;kbd&gt;x&lt;/kbd&gt;</code>");
    expect(html).toContain('class="katex"');
    expect(html).toContain("%%timeit");
  });
});
