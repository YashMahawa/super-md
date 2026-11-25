// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
const { native } = vi.hoisted(() => ({ native: vi.fn() }));
vi.mock("./nativeBridge", () => ({ invoke: native }));
import { preparePdf } from "./preparePdf";

describe("preparePdf YAML frontmatter handling", () => {
  it("preserves recognized frontmatter variations for smd-core PDF metadata without resolving YAML literals as assets", async () => {
    native.mockReset();
    const source = [
      "\uFEFF---  ",
      'title: "Statistical Mechanics"',
      'author: "Ludwig Boltzmann"',
      "date: 2026-03-15",
      'description: "Entropy and ![not-an-image](missing.png)"',
      "tags: [thermodynamics, entropy]",
      "...",
      "",
      "# Microstates",
      "",
      "$$S = k_B \\ln \\Omega$$",
    ].join("\n");

    const prepared = await preparePdf(source, "/notes/statmech.md");
    expect(native).not.toHaveBeenCalled();
    expect(prepared.assets).toEqual({});
    expect(prepared.content).toContain('title: "Statistical Mechanics"');
    expect(prepared.content).toContain('author: "Ludwig Boltzmann"');
    expect(prepared.content).toContain("tags: [thermodynamics, entropy]");
    expect(prepared.content).toContain("# Microstates");
  });

  it("falls back safely to ordinary Markdown when YAML frontmatter is unclosed", async () => {
    const unclosed = "---\ntitle: Unclosed block\n\n# Still Exports";
    const prepared = await preparePdf(unclosed, null);
    expect(prepared.content).toContain("# Still Exports");
  });
});
