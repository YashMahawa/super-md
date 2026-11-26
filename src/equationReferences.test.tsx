// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("./nativeBridge", () => ({ invoke }));

import MarkdownPreview from "./components/MarkdownPreview";
import LiveEditor from "./components/LiveEditor";
import { analyzeDocument } from "./documentAnalysis";
import { resolveHeadingOffset } from "./documentNavigation";
import { selectedMarkdown } from "./copySource";
import { preparePdf } from "./preparePdf";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | null = null;
afterEach(() => {
  if (root) {
    act(() => root?.unmount());
    root = null;
  }
  document.body.innerHTML = "";
  invoke.mockReset();
});

describe("explicit equation tags and resolved references", () => {
  it("renders explicit \\tag and \\tag* with \\label and resolves forward/backward/repeated \\eqref and \\ref in prose and math", async () => {
    const markdown = [
      "Forward references: \\eqref{eq:energy}, Theorem \\ref{eq:energy}, starred \\eqref{eq:star} / \\ref{eq:star}, and inline math $x + \\eqref{eq:energy} + \\eqref{eq:star} = \\ref{eq:sub}$.",
      "",
      "$$",
      "E = mc^2 \\tag{1.1}\\label{eq:energy}\\label{eq:einstein}",
      "$$",
      "",
      "$$",
      "\\nabla \\cdot \\mathbf{B} = 0 \\tag*{\\dagger}\\label{eq:star}",
      "$$",
      "",
      "$$",
      "a_n = a_{n-1} + d \\tag{\\text{A.2}}\\label{eq:sub}",
      "$$",
      "",
      "Backward and alias references: \\eqref{eq:einstein}, [Einstein relation](#eq:energy), unresolved \\eqref{eq:missing} and \\ref{eq:missing}, literal `\\eqref{eq:energy}`.",
      "",
      "Untagged labeled equation:",
      "",
      "$$",
      "x^2 + y^2 = r^2 \\label{eq:untagged}",
      "$$",
      "",
      "Reference to untagged equation degrades cleanly: \\eqref{eq:untagged} and \\ref{eq:untagged}.",
    ].join("\n");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const host = document.createElement("div");
      document.body.append(host);
      root = createRoot(host);
      await act(async () => {
        root?.render(
          <div className="reading-scroll">
            <div className="document-page">
              <MarkdownPreview markdown={markdown} documentPath="/notes/physics.md" python="" dark={false} />
            </div>
          </div>,
        );
      });

      const katexWarnings = warnSpy.mock.calls
        .map((args) => args.map(String).join(" "))
        .filter((msg) => /LaTeX-incompatible|unknownSymbol|strict/i.test(msg));
      expect(katexWarnings).toEqual([]);
      expect(host.querySelectorAll(".katex-error")).toHaveLength(0);
      expect(host.querySelectorAll('.katex [style*="cc0000"]')).toHaveLength(0);

      const tags = Array.from(
        host.querySelectorAll<HTMLElement>(".katex-display .katex-tag, .katex-display .tag"),
      ).map((el) => (el.textContent || "").replace(/\s+/g, " ").trim());
      expect(tags).toEqual(["(1.1)", "†", "(A.2)"]);

      const links = Array.from(host.querySelectorAll<HTMLAnchorElement>("a.equation-ref"));
      expect(links.map((a) => a.textContent)).toEqual(["(1.1)", "1.1", "(†)", "†", "(1.1)"]);
      for (const link of links) {
        const id = link.getAttribute("href")!.slice(1);
        expect(host.querySelector(`[id="${id}"]`)).not.toBeNull();
      }

      const inMathLinks = Array.from(host.querySelectorAll<HTMLAnchorElement>(".katex a[href^='#smd-eq-']"));
      expect(inMathLinks.map((a) => (a.textContent || "").trim())).toEqual(["(1.1)", "(†)", "A.2"]);

      const mdLink = Array.from(host.querySelectorAll<HTMLAnchorElement>("a")).find(
        (a) => a.textContent === "Einstein relation",
      );
      expect(mdLink?.getAttribute("href")).toMatch(/^#smd-eq-/);

      const unresolved = Array.from(host.querySelectorAll<HTMLElement>(".equation-ref.is-unresolved")).map(
        (el) => el.textContent,
      );
      expect(unresolved).toEqual(["(??)", "??", "(??)", "??"]);

      const inlineCode = host.querySelector("p code");
      expect(inlineCode?.textContent).toBe("\\eqref{eq:energy}");

      act(() => {
        links[0].dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      });
      expect(links[0].dataset.visited).toBeUndefined();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("preserves original LaTeX \\label, \\eqref, and \\ref when copying rendered selections and editing in LiveEditor", async () => {
    const markdown = [
      "See \\eqref{eq:wave} and $\\ref{eq:wave}$:",
      "",
      "$$",
      "u_{tt} = c^2 u_{xx} \\tag{2}\\label{eq:wave}",
      "$$",
    ].join("\n");

    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(
        <LiveEditor
          markdown={markdown}
          onChange={() => {}}
          documentPath="/notes/wave.md"
          python=""
          dark={false}
        />,
      );
    });

    expect(host.querySelectorAll(".katex-error")).toHaveLength(0);
    const body = host.querySelector(".markdown-body")!;
    const range = document.createRange();
    range.selectNodeContents(body);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    const copied = selectedMarkdown(selection, markdown) || "";
    expect(copied).toContain("\\eqref{eq:wave}");
    expect(copied).toContain("$\\ref{eq:wave}$");
    expect(copied).toContain("\\tag{2}\\label{eq:wave}");
    selection.removeAllRanges();
  });

  it("preserves explicit tags, labels, and prose/math references cleanly through preparePdf", async () => {
    const markdown = [
      "From \\eqref{eq:gauss} and Theorem \\ref{eq:gauss} with $\\eqref{eq:gauss}$:",
      "",
      "$$",
      "\\oint \\mathbf{E} \\cdot d\\mathbf{A} = \\frac{Q}{\\varepsilon_0} \\tag{3.1}\\label{eq:gauss}",
      "$$",
    ].join("\n");

    const prepared = await preparePdf(markdown, "/notes/em.md");
    expect(prepared.content).toContain("\\eqref{eq:gauss}");
    expect(prepared.content).toContain("\\ref{eq:gauss}");
    expect(prepared.content).toContain("\\tag{3.1}\\label{eq:gauss}");
  });

  it("coexists with braced Python fences and native relative-link routing in MarkdownPreview", async () => {
    invoke.mockResolvedValue({ opened: true });
    const markdown = [
      "Compare \\eqref{eq:helmholtz} and $E = \\eqref{eq:helmholtz}$ with [Next lecture](./Lecture2.md#derivations) and [[Appendix#Proof]]:",
      "",
      "$$",
      "(\\nabla^2 + k^2) u = 0 \\tag{4.2}\\label{eq:helmholtz}",
      "$$",
      "",
      "```{python, echo=false}",
      "k = 2 * 3.14159",
      "```",
    ].join("\n");

    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(
        <div className="reading-scroll">
          <div className="document-page">
            <MarkdownPreview markdown={markdown} documentPath="/notes/Lecture1.md" python="" dark={false} />
          </div>
        </div>,
      );
    });

    const eqLink = host.querySelector<HTMLAnchorElement>("a.equation-ref")!;
    const mathEqLink = host.querySelector<HTMLAnchorElement>(".katex a[href^='#smd-eq-']")!;
    expect(eqLink.textContent).toBe("(4.2)");
    expect((mathEqLink.textContent || "").trim()).toBe("(4.2)");
    expect(host.querySelector(".python-cell")).not.toBeNull();

    await act(async () => {
      eqLink.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      mathEqLink.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(invoke).not.toHaveBeenCalledWith("open_workspace_link", expect.anything());

    const relLink = Array.from(host.querySelectorAll<HTMLAnchorElement>("a")).find(
      (a) => a.textContent === "Next lecture",
    )!;
    await act(async () => {
      relLink.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(invoke).toHaveBeenCalledWith("open_workspace_link", {
      documentPath: "/notes/Lecture1.md",
      target: "./Lecture2.md",
      fragment: "derivations",
      wikilink: false,
    });

    const wikiLink = Array.from(host.querySelectorAll<HTMLAnchorElement>("a")).find(
      (a) => a.textContent === "Appendix#Proof",
    )!;
    await act(async () => {
      wikiLink.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(invoke).toHaveBeenCalledWith("open_workspace_link", {
      documentPath: "/notes/Lecture1.md",
      target: "Appendix",
      fragment: "Proof",
      wikilink: true,
    });
  });

  it("numbers standalone \\begin{equation} blocks without surrounding $$, resolves forward references across LiveEditor blocks, and preserves source offsets on copy and links", async () => {
    const markdown = [
      "# Fourier Series",
      "",
      "Forward references: \\eqref{eq:euler}, Identity \\ref{eq:euler}, second \\eqref{eq:parseval}, and inline $1 + \\eqref{eq:parseval} = 3$.",
      "",
      "\\begin{equation}",
      "e^{i\\pi} + 1 = 0 \\label{eq:euler}",
      "\\end{equation}",
      "",
      "\\begin{equation*}",
      "f(x) = \\sum_{n=-\\infty}^{\\infty} c_n e^{inx} \\label{eq:unnumbered-star}",
      "\\end{equation*}",
      "",
      "\\begin{equation}",
      "c_0 = \\frac{1}{2\\pi} \\int_{-\\pi}^{\\pi} f(x)\\,dx \\notag \\label{eq:suppressed}",
      "\\end{equation}",
      "",
      "\\begin{equation}",
      "\\|f\\|_2^2 = 2\\pi \\sum_{n=-\\infty}^{\\infty} |c_n|^2 \\tag{P.1}\\label{eq:custom}",
      "\\end{equation}",
      "",
      "\\begin{equation}",
      "\\sum_{n=1}^{\\infty} \\frac{1}{n^2} = \\frac{\\pi^2}{6} \\label{eq:parseval}",
      "\\end{equation}",
      "",
      "$$",
      "\\begin{align}",
      "a &= b \\label{eq:align-separate}",
      "\\end{align}",
      "$$",
      "",
      "## Closing Links",
      "",
      "After equations: [Next Note](./next.md#bounds), [[RefNote#Lemma]], [Jump Euler](#eq:euler), custom \\eqref{eq:custom}, unnumbered \\eqref{eq:unnumbered-star} / \\eqref{eq:suppressed} / \\eqref{eq:align-separate}.",
    ].join("\n");

    // 1. Verify canonical AST block & heading offsets.
    const analysis = analyzeDocument(markdown);
    const closingOffset = resolveHeadingOffset(markdown, "Closing Links");
    expect(closingOffset).toBe(markdown.indexOf("## Closing Links"));
    for (const block of analysis.blocks) {
      expect(markdown.slice(block.start, block.end)).toBe(block.text);
    }

    // 2. Render in LiveEditor (which renders each block in isolation) to prove equation #2 stays (2), not reset to (1).
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(
        <LiveEditor
          markdown={markdown}
          onChange={() => {}}
          documentPath="/notes/fourier.md"
          python=""
          dark={false}
        />,
      );
    });

    expect(host.querySelectorAll(".katex-error")).toHaveLength(0);
    const tags = Array.from(
      host.querySelectorAll<HTMLElement>(".katex-display .katex-tag, .katex-display .tag"),
    )
      .map((el) => (el.textContent || "").replace(/[\s\u200b]+/g, " ").trim())
      .filter(Boolean);
    expect(tags).toEqual(["(1)", "(P.1)", "(2)"]);

    const refLinks = Array.from(host.querySelectorAll<HTMLAnchorElement>("a.equation-ref"));
    expect(refLinks.map((a) => a.textContent)).toEqual(["(1)", "1", "(2)", "(P.1)"]);

    const inMathLinks = Array.from(host.querySelectorAll<HTMLAnchorElement>(".katex a[href^='#smd-eq-']"));
    expect(inMathLinks.map((a) => (a.textContent || "").trim())).toEqual(["(2)"]);

    const unresolved = Array.from(host.querySelectorAll<HTMLElement>(".equation-ref.is-unresolved")).map(
      (el) => el.textContent,
    );
    expect(unresolved).toEqual(["(??)", "(??)", "(??)"]);

    // 3. Verify every link and bare equation anchor preserves exact canonical source offsets.
    for (const anchor of Array.from(host.querySelectorAll<HTMLElement>("a[data-source-start]"))) {
      const start = Number(anchor.dataset.sourceStart);
      const end = Number(anchor.dataset.sourceEnd);
      expect(end).toBeGreaterThan(start);
      const rawSlice = markdown.slice(start, end);
      if (anchor.classList.contains("equation-ref")) {
        expect(rawSlice).toBe(anchor.getAttribute("data-source-tex"));
      } else if (anchor.textContent === "Next Note") {
        expect(rawSlice).toBe("[Next Note](./next.md#bounds)");
      } else if (anchor.textContent === "RefNote#Lemma") {
        expect(rawSlice).toBe("[[RefNote#Lemma]]");
      } else if (anchor.textContent === "Jump Euler") {
        expect(rawSlice).toBe("[Jump Euler](#eq:euler)");
      }
    }

    // 4. Verify Copy preserves bare \begin{equation}...\end{equation} without adding $$.
    const liveDoc = host.querySelector(".live-document")!;
    const range = document.createRange();
    range.selectNodeContents(liveDoc);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    const copied = selectedMarkdown(selection, markdown) || "";
    expect(copied).toContain("\\begin{equation}\ne^{i\\pi} + 1 = 0 \\label{eq:euler}\n\\end{equation}");
    expect(copied).not.toContain("$$\n\\begin{equation}");
    selection.removeAllRanges();

    // 5. Verify preparePdf preserves standalone equation blocks cleanly for smd-core.
    const prepared = await preparePdf(markdown, "/notes/fourier.md");
    expect(prepared.content).toContain("\\eqref{eq:euler}");
    expect(prepared.content).toContain("\\begin{equation}");
    expect(prepared.content).toContain("\\label{eq:parseval}");
  });
});
