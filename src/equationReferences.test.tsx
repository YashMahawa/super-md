// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("./nativeBridge", () => ({ invoke }));

import MarkdownPreview from "./components/MarkdownPreview";
import LiveEditor from "./components/LiveEditor";
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
      "Forward references: \\eqref{eq:energy}, Theorem \\ref{eq:energy}, starred \\eqref{eq:star} / \\ref{eq:star}, and inline math $x + \\eqref{eq:energy} = \\ref{eq:sub}$.",
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

    expect(host.querySelectorAll(".katex-error")).toHaveLength(0);
    expect(host.querySelectorAll('.katex [style*="cc0000"]')).toHaveLength(0);

    const tags = Array.from(host.querySelectorAll<HTMLElement>(".katex-display .tag")).map((el) =>
      (el.textContent || "").replace(/\s+/g, " ").trim(),
    );
    expect(tags).toEqual(["(1.1)", "†", "(A.2)"]);

    const links = Array.from(host.querySelectorAll<HTMLAnchorElement>("a.equation-ref"));
    expect(links.map((a) => a.textContent)).toEqual(["(1.1)", "1.1", "(†)", "†", "(1.1)"]);
    for (const link of links) {
      const id = link.getAttribute("href")!.slice(1);
      expect(host.querySelector(`[id="${id}"]`)).not.toBeNull();
    }

    const inMathLinks = Array.from(host.querySelectorAll<HTMLAnchorElement>(".katex a[href^='#smd-eq-']"));
    expect(inMathLinks.map((a) => (a.textContent || "").trim())).toEqual(["(1.1)", "A.2"]);

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
});
