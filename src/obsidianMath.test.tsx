import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkMath from "remark-math";
import { visit } from "unist-util-visit";
import MarkdownPreview from "./components/MarkdownPreview";
import { normalizedDisplayMath, remarkObsidianMath } from "./obsidianMath";

const equation = String.raw`$$\boxed{\begin{aligned}
P(A\cup B\cup C)=&P(A)+P(B)+P(C)\\
&-P(A\cap B)-P(A\cap C)-P(B\cap C)\\
&+P(A\cap B\cap C).
\end{aligned}}$$`;
describe("Obsidian display math compatibility", () => {
  it("does not swallow later headings and callouts", () => {
    const html = renderToStaticMarkup(<MarkdownPreview markdown={equation + "\n\n**Proof:** then explain.\n\n> [!tip] Fast use\n> Preserved body.\n\n## Bounds\n\n$$P(A)\\le1$$"} documentPath={null} python="" dark />);
    expect(html).not.toContain("katex-error"); expect(html).toContain("callout-tip"); expect(html).toContain('<h2 id="bounds" data-heading-key="bounds">Bounds</h2>'); expect(html).toContain("Preserved body.");
  });
  it("supports quote prefixes, existing fences and same-line display math", () => {
    const html = renderToStaticMarkup(<MarkdownPreview markdown={"> [!tip] Math\n> $$x+1$$\n\n$$\ny=2\n$$"} documentPath={null} python="" dark />);
    expect(html).not.toContain("katex-error"); expect(html.match(/class="katex-display"/g)).toHaveLength(2);
  });
  it("leaves code and inline math alone", () => {
    const source = "```tex\n$$x$$\n```\n\n`$$literal$$` and $a+b$ and inline $$c$$.";
    expect(normalizedDisplayMath(source)).toBe(source);
  });
  it("keeps image-edit positions in the original source after normalization", () => {
    const source = equation + "\n\n![α](assets/import-example.png)\n";
    const tree = unified().use(remarkParse).use(remarkMath).use(remarkObsidianMath).parse(source);
    const images: any[] = []; visit(tree, "image", (node) => { images.push(node); });
    expect(images).toHaveLength(1);
    expect(source.slice(images[0].position.start.offset, images[0].position.end.offset)).toBe("![α](assets/import-example.png)");
  });
});
