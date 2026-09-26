import { describe, expect, it } from "vitest";
import { splitMarkdownBlocks } from "./LiveEditor";

describe("live Markdown blocks", () => {
  it("keeps fenced code and callouts intact across blank lines", () => {
    const note = "# Heading\n\n```python\na = 1\n\nprint(a)\n```\n\n:::callout tip\nOne\n\nTwo\n:::\n\nEnd";
    const blocks = splitMarkdownBlocks(note);
    expect(blocks).toHaveLength(4);
    expect(blocks[1].text).toContain("\n\nprint(a)");
    expect(blocks[2].text).toContain("One\n\nTwo");
    expect(blocks.map((block) => block.text).join("")).toBe(note);
  });
});
