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
