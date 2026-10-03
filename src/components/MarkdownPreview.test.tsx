import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import MarkdownPreview, { normalizeCallouts } from "./MarkdownPreview";

describe("Obsidian callouts", () => {
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
});
