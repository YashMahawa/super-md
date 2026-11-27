import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import MarkdownPreview from "./components/MarkdownPreview";
import { analyzeDocument } from "./documentAnalysis";
import { preparePdf } from "./preparePdf";

describe("studySyntax delimiter scanning and parity", () => {
  it("preserves exact rendering for nested spans, astral Unicode boundaries, overlapping markers, and single-equals equations", async () => {
    const markdown = [
      "Nested ==**bold** and *italic* with H~2~O and 10^-3^== plus x~*i*~ and y^**2**^.",
      "",
      "Unicode 🧪==emoji highlight==, ==trailing🧪==, 🧪~2~, x^🧪^, “==smart quotes==”, «==guillemets==», and \u00a0==nbsp open==.",
      "",
      "Overlapping ~a==b~c==, ==outer ==inner==, ==outer ==~inner==, and intraword a~b c~d~e.",
      "",
      "Equations A = L * U, x = 1, a == b, a === b, ~~struck~~, \\==escaped==, &#61;=entity==, and \\\\==after slash==.",
    ].join("\n");

    const html = renderToStaticMarkup(<MarkdownPreview markdown={markdown} documentPath={null} python="" dark={false} />);
    expect(html).toMatch(/<mark><strong[^>]*>bold<\/strong> and <em[^>]*>italic<\/em> with H<sub>2<\/sub>O and 10<sup>-3<\/sup><\/mark>/);
    expect(html).toMatch(/x<sub><em[^>]*>i<\/em><\/sub> and y<sup><strong[^>]*>2<\/strong><\/sup>/);
    expect(html).toContain("🧪<mark>emoji highlight</mark>, <mark>trailing🧪</mark>, 🧪<sub>2</sub>, x<sup>🧪</sup>");
    expect(html).toContain("“<mark>smart quotes</mark>”, «<mark>guillemets</mark>», and \u00a0<mark>nbsp open</mark>.");
    expect(html).toContain("Overlapping <sub>a==b</sub>c==, ==outer <mark>inner</mark>, ==outer <mark>~inner</mark>, and intraword a~b c<sub>d</sub>e.");
    expect(html).toMatch(/Equations A = L \* U, x = 1, a == b, a === b, <del[^>]*>struck<\/del>, ==escaped==, ==entity==, and \\<mark>after slash<\/mark>\./);

    const prepared = await preparePdf(markdown, "/notes/study-parity.md");
    expect(prepared.content).toContain("==**bold** and *italic* with H~2~O and 10^-3^==");
    expect(prepared.content).toContain("🧪==emoji highlight==");
    expect(prepared.content).toContain("a\\~b c~d~e");
    expect(prepared.content).toContain("\\=\\=escaped\\=\\=");
    expect(prepared.content).toContain("\\\\==after slash==");
  });

  it("parses large single-block study notes with dense matched and unmatched delimiters in linear time", () => {
    const lines: string[] = [];
    for (let i = 1; i <= 420; i++) {
      lines.push(
        `Line ${i}: ==Key takeaway ${i}== notes that H~2~O and C~6~H~12~O~6~ scale by 2^10^ (~15 ms latency, if x == y or z = ${i}, ~spaced tilde~ and ^spaced caret^) with 🧪==emoji== and \\~escaped\\~ markers.`,
      );
    }
    const largeSingleBlock = `# Large Study Block\n\n${lines.join("\n")}\n`;

    const start = performance.now();
    const analysis = analyzeDocument(largeSingleBlock);
    const elapsedMs = performance.now() - start;

    // Reverted O(D^2 * N) backtracking + prefix/suffix slicing takes >10,000 ms on 420 lines (~83 KB).
    expect(elapsedMs).toBeLessThan(2500);
    expect(analysis.outline).toHaveLength(1);

    const para: any = analysis.tree.children[1];
    expect(para?.type).toBe("paragraph");
    const highlights = para.children.filter((c: any) => c.type === "highlight");
    const subscripts = para.children.filter((c: any) => c.type === "subscript");
    const superscripts = para.children.filter((c: any) => c.type === "superscript");
    expect(highlights).toHaveLength(840);
    expect(subscripts).toHaveLength(1680);
    expect(superscripts).toHaveLength(420);
  });
});
