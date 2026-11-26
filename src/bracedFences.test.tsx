// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const { pythonOutput, renderMermaid, cachedMermaid, invoke, inspectCachedPythonOutput } = vi.hoisted(() => ({
  pythonOutput: vi.fn(),
  renderMermaid: vi.fn(),
  cachedMermaid: vi.fn(),
  invoke: vi.fn(),
  inspectCachedPythonOutput: vi.fn(),
}));

vi.mock("./renderedOutputs", async importOriginal => {
  const actual = await importOriginal<typeof import("./renderedOutputs")>();
  return {
    ...actual,
    pythonOutput,
    inspectCachedPythonOutput,
  };
});
vi.mock("./mermaidRenderer", () => ({ renderMermaid, cachedMermaid }));
vi.mock("./nativeBridge", () => ({ invoke }));

import MarkdownPreview from "./components/MarkdownPreview";
import { analyzeDocument } from "./documentAnalysis";
import { normalizeFenceInfoLanguage, parseBracedFenceInfoLanguage, parseBracedFenceLanguage } from "./fenceLanguage";
import { preparePdf } from "./preparePdf";
import { compatibleMarkdown } from "./compatibleMarkdown";
import { prepareMarkdownExport } from "./markdownExport";
import { agentDiagrams } from "./agentView";
import { agentSearch } from "./agentOperations";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  pythonOutput.mockReset();
  renderMermaid.mockReset();
  cachedMermaid.mockReset();
  invoke.mockReset();
  inspectCachedPythonOutput.mockReset();
  document.body.innerHTML = "";
});

describe("braced Python and Mermaid fence parsing", () => {
  it("parses braced Python and Mermaid headers while leaving unsupported or malformed fences untouched", () => {
    expect(parseBracedFenceInfoLanguage("{python}")).toBe("python");
    expect(parseBracedFenceInfoLanguage("{.python}")).toBe("python");
    expect(parseBracedFenceInfoLanguage("{ Python, echo=FALSE, label='wave' }")).toBe("python");
    expect(parseBracedFenceLanguage("{python", "echo=false}")).toBe("python");
    expect(parseBracedFenceLanguage("{.py", "#cell-1 .wide}")).toBe("py");
    expect(parseBracedFenceInfoLanguage("{mermaid}")).toBe("mermaid");
    expect(parseBracedFenceInfoLanguage("{.mermaid}")).toBe("mermaid");
    expect(parseBracedFenceLanguage("{mermaid,", "fig-width=6}")).toBe("mermaid");
    expect(parseBracedFenceLanguage("{Mermaid", "echo=false}")).toBe("mermaid");

    expect(parseBracedFenceInfoLanguage("{python")).toBeNull();
    expect(parseBracedFenceInfoLanguage("{..python}")).toBeNull();
    expect(parseBracedFenceInfoLanguage("{. python}")).toBeNull();
    expect(parseBracedFenceInfoLanguage("{python-repl}")).toBeNull();
    expect(parseBracedFenceInfoLanguage("{r, echo=FALSE}")).toBeNull();
    expect(parseBracedFenceInfoLanguage("{bash}")).toBeNull();

    expect(normalizeFenceInfoLanguage(" {.mermaid, fig-width=6} ")).toBe("mermaid");
    expect(normalizeFenceInfoLanguage(" {r, echo=FALSE} ")).toBe("{r,");
  });

  it("renders braced Python cells and Mermaid diagrams in MarkdownPreview while preserving exact source offsets", async () => {
    await import("./components/MermaidDiagram");
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 50"><text x="10" y="30">FLOW</text></svg>';
    cachedMermaid.mockReturnValue(svg);
    renderMermaid.mockResolvedValue(svg);
    pythonOutput.mockResolvedValue(undefined);

    const markdown = [
      "# Braced Fences",
      "",
      "```{python, echo=false}",
      "def f(x):",
      "    return x + 1",
      "```",
      "",
      "```{.mermaid, fig-width=6}",
      "flowchart LR",
      "  A --> B",
      "```",
      "",
      "```{r, echo=FALSE}",
      "x <- 1",
      "```",
    ].join("\n");

    const analysis = analyzeDocument(markdown);
    expect(analysis.pythonCells).toEqual([
      {
        source: "def f(x):\n    return x + 1",
        ordinal: 0,
        offset: markdown.indexOf("```{python, echo=false}"),
      },
    ]);

    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <MarkdownPreview
          markdown={markdown}
          documentPath="/notes/braced.md"
          python="embedded"
          dark={false}
          fullDocumentAccessibility={true}
        />,
      );
    });
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 30));
    });

    const pythonCell = host.querySelector<HTMLElement>(".python-cell");
    expect(pythonCell).not.toBeNull();
    expect(pythonCell?.querySelectorAll(".hljs-keyword").length).toBeGreaterThan(0);
    const pyStart = Number(pythonCell?.dataset.sourceStart);
    const pyEnd = Number(pythonCell?.dataset.sourceEnd);
    expect(markdown.slice(pyStart, pyEnd)).toBe("```{python, echo=false}\ndef f(x):\n    return x + 1\n```");

    expect(host.querySelector(".mermaid")).not.toBeNull();
    const ordinaryDisclosures = host.querySelectorAll(".code-disclosure");
    expect(ordinaryDisclosures).toHaveLength(1);
    expect(ordinaryDisclosures[0].textContent).toContain("x <- 1");

    await act(async () => {
      root.unmount();
    });
  });

  it("prepares braced Mermaid diagrams and braced Python cells consistently in preparePdf", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><rect width="120" height="40"/></svg>';
    renderMermaid.mockResolvedValue(svg);
    pythonOutput
      .mockResolvedValueOnce({
        ok: true,
        stdout: "wave ready\n",
        stderr: "",
        images: ["data:image/png;base64,AA=="],
        provenance: { verified: true },
      })
      .mockResolvedValueOnce(undefined);

    const markdown = [
      "```{python, echo=FALSE}",
      "print('same')",
      "```",
      "",
      "~~~{.py #second}",
      "print('same')",
      "~~~",
      "",
      "```{.mermaid fig-width=6}",
      "graph TD; A-->B",
      "```",
    ].join("\n");

    const prepared = await preparePdf(markdown, "/notes/braced.md", "python-3.12");
    expect(pythonOutput.mock.calls).toEqual([
      ["print('same')", { document: "/notes/braced.md", cell: "0", interpreter: "python-3.12" }],
      ["print('same')", { document: "/notes/braced.md", cell: "1", interpreter: "python-3.12" }],
    ]);
    expect(renderMermaid).toHaveBeenCalledWith("graph TD; A-->B", false, undefined);
    expect(prepared.content).toContain("wave ready");
    expect(prepared.content).toContain("![Matplotlib figure](plot-");
    expect(prepared.content).toContain("![Diagram](diagram-");
    expect(prepared.content).toContain("```py\nprint('same')\n```");
    expect(prepared.content).not.toContain("#second}");
    expect(invoke).not.toHaveBeenCalledWith("run_python", expect.anything());
  });

  it("flattens braced fences in compatible Markdown export while preserving raw fences in non-compatible export", async () => {
    pythonOutput
      .mockResolvedValueOnce({
        ok: true,
        stdout: "42\n",
        stderr: "",
        images: [],
        provenance: { verified: true },
      })
      .mockResolvedValueOnce(undefined);

    const markdown = [
      "```{python, echo=false}",
      "print(42)",
      "```",
      "",
      "```{.py #raw}",
      "y = 2",
      "```",
      "",
      "```{mermaid, fig-width=6}",
      "flowchart LR",
      "  Start --> Done",
      "```",
    ].join("\n");

    const rawExport = await prepareMarkdownExport(markdown, "/notes/braced.md", { compatible: false });
    expect(rawExport.content).toBe(markdown);

    const compat = await compatibleMarkdown(markdown, "/notes/braced.md", "embedded");
    expect(compat).toContain("> ```python\n> print(42)\n> ```");
    expect(compat).toContain("> ```text\n> 42\n> ```");
    expect(compat).toContain("```py\ny = 2\n```");
    expect(compat).toContain("```mermaid\nflowchart LR\n  Start --> Done\n```");
    expect(compat).not.toContain("{mermaid");
    expect(compat).not.toContain("{.py");
  });

  it("recognizes braced Mermaid and Python figures in agentDiagrams and diagram-excluding search", () => {
    inspectCachedPythonOutput.mockReturnValue({
      ok: true,
      stdout: "",
      stderr: "",
      images: ["data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg=="],
    });
    const source = [
      "Visible needle",
      "```{.mermaid, fig-width=6}",
      "graph TD",
      "  needle --> B",
      "```",
      "```{python, echo=false}",
      "plot_needle()",
      "```",
      "Final needle",
    ].join("\n");

    const diagrams = agentDiagrams(source, { documentPath: "/notes/braced.md", python: "embedded" });
    expect(diagrams.map(d => d.kind)).toEqual(["mermaid", "python-figure"]);

    const hits = agentSearch(source, "needle", 10, 0, { excludeDiagrams: true });
    expect(hits.matches.map(m => m.line)).toEqual([1, 7, 9]);
  });
});
