// Bounded public synthetic corpus shared by the isolated analysis benchmark
// and its lightweight fixture tests. Nothing here reads a user's documents.
const MAX_BYTES = 4_000_000;

function exactAsciiText(prefix, pattern, byteLength) {
  const remaining = byteLength - prefix.length;
  if (remaining < 0) throw new RangeError("Fixture prefix exceeds its byte budget");
  return prefix + pattern.repeat(Math.ceil(remaining / pattern.length)).slice(0, remaining);
}

function repeatedBlock(index, targetLength) {
  const prefix = `Synthetic block ${index}: `;
  const body = "Readable generated study text with stable punctuation and spacing. ";
  return exactAsciiText(prefix, body, targetLength);
}

export function createDocumentAnalysisFixtures() {
  const semantic = [
    "---\ntitle: Synthetic semantics\n---",
    "# Repeated heading café",
    "# Repeated heading café",
    "Read [the reference][source] and follow [[#Repeated heading café|the Unicode link]].",
    "",
    "A note with a citation[^one].",
    "",
    "[source]: https://example.invalid/reference",
    "[^one]: Synthetic footnote detail.",
    "",
    "1. First loose item",
    "",
    "2. Second loose item",
    "   - Nested item",
    "",
    ":::callout tip 'Synthetic callout'",
    "A callout paragraph with a task:",
    "- [ ] Keep this original source offset.",
    ":::",
    "",
    "| Input | Value |",
    "| --- | --- |",
    "| $\\alpha$ | math |",
    "",
    "```python",
    "print('synthetic')",
    "```",
    "",
    "```mermaid",
    "graph TD; A-->B",
    "```",
  ].join("\n");

  const mathHeavy = ["# Math-heavy synthetic note", ...Array.from({ length: 80 }, (_, index) => [
    `## Equation ${index + 1}`,
    `Paragraph ${index} with equation $x_${index}=\\frac{a+b}{c+d}$.`,
    `$$\\int_0^1 x^${index % 5 + 1}\\,dx = \\frac{1}{${index % 5 + 2}}$$`,
  ].join("\n\n"))].join("\n\n");

  const manyBlocks = ["# Many-block synthetic note", ...Array.from({ length: 1_500 }, (_, index) => repeatedBlock(index, 84))].join("\n\n");
  const oneMbPrefix = "# One-megabyte generated synthetic note\n\n";
  const oneMb = exactAsciiText(oneMbPrefix, "paragraph text with generated content and stable boundaries.\n\n", 1_000_000);
  const fourMbPrefix = "# Four-megabyte single-block generated note\n\n";
  const fourMb = exactAsciiText(fourMbPrefix, "A bounded synthetic paragraph exercises cold parsing without creating many AST nodes. ", MAX_BYTES);

  return [
    { name: "small", source: "# Small synthetic note\n\nOne equation $E=mc^2$.\n" },
    { name: "semantic-edge-cases", source: semantic },
    { name: "math-heavy", source: mathHeavy },
    { name: "many-blocks", source: manyBlocks },
    { name: "1mb-many-paragraphs", source: oneMb },
    { name: "4mb-single-paragraph", source: fourMb },
  ].map(fixture => ({ ...fixture, sourceBytes: new TextEncoder().encode(fixture.source).byteLength }));
}

export const DOCUMENT_ANALYSIS_FIXTURE_LIMIT_BYTES = MAX_BYTES;
