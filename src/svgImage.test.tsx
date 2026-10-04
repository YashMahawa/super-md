// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { unified } from "unified";
import remarkParse from "remark-parse";
import { presentSvg } from "./svgImage";
import { remarkSvgBlocks } from "./svgBlocks";
import MarkdownPreview from "./components/MarkdownPreview";

const parse = (markdown: string) => remarkSvgBlocks()(unified().use(remarkParse).parse(markdown), { value: markdown });

describe("inline SVG", () => {
  it("lifts raw svg blocks, one-line svg and untagged fences into svg blocks", () => {
    for (const markdown of [
      '<svg viewBox="0 0 10 10">\n<circle cx="5" cy="5" r="4"/>\n</svg>',
      'Before\n\n<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>\n\nAfter',
      '<svg viewBox="0 0 10 10">\n<g>\n\n<circle cx="5" cy="5" r="4"/>\n\n</g>\n</svg>',
      '```\n<svg viewBox="0 0 10 10"><rect width="4" height="4"/></svg>\n```',
      '```xml\n<?xml version="1.0"?>\n<svg viewBox="0 0 10 10"><rect width="4" height="4"/></svg>\n```',
    ]) {
      const blocks = (parse(markdown) as any).children.filter((node: any) => node.type === "code" && node.lang === "svg");
      expect(blocks, markdown).toHaveLength(1);
      expect(blocks[0].value).toMatch(/^<(?:\?xml|svg)[\s\S]*<\/svg>$/);
    }
    expect((parse("Use the `<svg>` element.") as any).children[0].type).toBe("paragraph");
  });
  it("re-inks monochrome drawings and keeps colored ones as authored", () => {
    const mono = presentSvg('<svg viewBox="0 0 10 10"><path d="M0 0h5" stroke="#000"/><circle r="2" fill="white"/></svg>', "#e6e0e9");
    expect(mono.mode).toBe("mono");
    expect(mono.svg).toContain('stroke="#e6e0e9"');
    expect(mono.svg).toContain('fill="none"');
    expect(presentSvg('<svg viewBox="0 0 10 10"><rect width="4" height="4"/></svg>', "#fff").svg).toContain('fill="#fff"');
    expect(presentSvg('<svg viewBox="0 0 10 10"><rect width="4" height="4" fill="#e4572e"/></svg>', "#fff").mode).toBe("color");
    expect(presentSvg('<svg viewBox="0 0 10 10"><rect width="10" height="10" fill="#123"/><circle r="2" fill="#000"/></svg>', "#fff").mode).toBe("own-background");
    expect(() => presentSvg('<svg><script>alert(1)</script></svg>', "#fff")).toThrow();
  });
  it("renders raw svg in notes as an image, not source text", () => {
    const html = renderToStaticMarkup(<MarkdownPreview documentPath={null} python="" dark={false} markdown={'# Shape\n\n<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>'} />);
    expect(html, html).toContain("svg-diagram");
    expect(html).not.toContain("&lt;circle");
  });
});
