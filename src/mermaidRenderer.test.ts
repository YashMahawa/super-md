// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
const engine = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn() }));
const fast = vi.hoisted(() => ({renderAsync:vi.fn().mockRejectedValue(new Error('Use compatibility renderer'))}));
vi.mock("mermaid", () => ({ default: engine }));
vi.mock('pele/lazy',()=>fast);
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
  it('keeps intrinsic vector dimensions and reuses a bounded rendered result without another layout',async()=>{
    engine.render.mockResolvedValueOnce({svg:'<svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 640 240"><text>Cached diagram</text></svg>'});
    const first=await renderMermaid('graph LR; Unique-->Cached');
    expect(first).toContain('width="640"');expect(first).toContain('height="240"');
    const calls=engine.render.mock.calls.length;
    expect(await renderMermaid('graph LR; Unique-->Cached')).toBe(first);
    expect(engine.render.mock.calls.length).toBe(calls);
  });
  it('evicts old layouts instead of retaining every diagram from previously opened notes',async()=>{
    engine.render.mockResolvedValue({svg:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><text>Bounded</text></svg>'});
    for(let i=0;i<18;i++)await renderMermaid(`graph LR; Cache${i}-->Output`);
    const calls=engine.render.mock.calls.length;
    await renderMermaid('graph LR; Cache17-->Output');expect(engine.render.mock.calls.length).toBe(calls);
    await renderMermaid('graph LR; Cache0-->Output');expect(engine.render.mock.calls.length).toBe(calls+1);
    expect(document.body.children.length).toBe(0);
  });
  it('uses a sanitized, self-contained Pele vector without loading Mermaid for compatible diagrams',async()=>{
    fast.renderAsync.mockResolvedValueOnce({svg:'<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50" style="--_fg:var(--pele-fg,#111111)"><path stroke="var(--_fg)" d="M0 0L100 50"/><text>Fast vector</text><script>bad()</script></svg>'});
    const calls=engine.render.mock.calls.length;
    const svg=await renderMermaid('flowchart LR; FastUnique-->Vector',true);
    expect(svg).toContain('data-diagram-engine="pele"');expect(svg).toContain('stroke="#e9e2e8"');expect(svg).not.toMatch(/var\(|<script/);
    expect(engine.render.mock.calls.length).toBe(calls);expect(document.body.children.length).toBe(0);
  });
});
