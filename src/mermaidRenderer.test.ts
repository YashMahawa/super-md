// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
const engine = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn() }));
vi.mock("mermaid", () => ({ default: engine }));
import { renderMermaid, sanitizeDiagram } from "./mermaidRenderer";
describe("isolated SVG diagrams", () => {
  it("retains SVG geometry, text and styles but strips active content", () => {
    const svg = sanitizeDiagram('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 50 50" onload="evil()"><style>.node{fill:red}</style><g class="node" id="a"><path d="M0 0L50 50"/><text>Study</text></g><script>evil()</script><foreignObject><div>evil</div></foreignObject><a href="javascript:evil()">link</a></svg>');
    expect(svg).toContain('viewBox="0 0 50 50"'); expect(svg).toContain('<path'); expect(svg).toContain('Study'); expect(svg).toContain('<style>');
    expect(svg).not.toMatch(/onload|script|foreignObject|javascript/i);
  });
  it("continues the serialized queue after an error and removes temporary containers", async () => {
    engine.render.mockRejectedValueOnce(new Error("Bad syntax")).mockResolvedValueOnce({ svg: '<svg><text>Recovered</text></svg>' });
    const failed = renderMermaid("bad"); const recovered = renderMermaid("graph TD; A-->B");
    await expect(failed).rejects.toThrow("Bad syntax"); await expect(recovered).resolves.toContain("Recovered");
    expect(engine.initialize).toHaveBeenLastCalledWith(expect.objectContaining({ securityLevel: "strict" }));
    expect(document.body.children.length).toBe(0);
  });
});
