import { expect, test } from "@playwright/test";

test("numbered LaTeX equation block without surrounding $$ resolves forward references, navigates in real reader, and preserves source offsets on copy and links", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.addInitScript(() => {
    (window as any).__copiedText = "";
    (window as any).__workspaceLinks = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          (window as any).__copiedText = text;
        },
      },
    });
    window.SuperMD = {
      post(id, command, raw) {
        const args = JSON.parse(raw);
        if (command === "copy_text") {
          (window as any).__copiedText = args.text;
        }
        if (command === "open_workspace_link") {
          (window as any).__workspaceLinks.push(args);
          window.supermdReply?.(id, { opened: true }, null);
          return;
        }
        queueMicrotask(() => window.supermdReply?.(id, true, null));
      },
    };
  });

  await page.goto("/android-reader.html");
  await page.waitForFunction(() => typeof window.supermdLoad === "function");

  const fillerParagraphs = Array.from(
    { length: 14 },
    (_, i) =>
      `## Derivation Step ${i + 1}\n\nIntermediate spectral analysis context for section ${i + 1} so the numbered equation block sits well below the initial fold. `.repeat(
        3,
      ),
  ).join("\n\n");

  const markdown = [
    "# Spectral Theorem Notes",
    "",
    "As previewed in \\eqref{eq:parseval} and Equation \\ref{eq:parseval} (inline check $E = \\eqref{eq:parseval}$), see [Next Lecture](./lecture-2.md#fourier) before jumping to the identity.",
    "",
    "```latex",
    "\\begin{equation}",
    "x = 999 \\label{eq:fenced}",
    "\\end{equation}",
    "```",
    "",
    "    \\begin{equation}",
    "    y = 888 \\label{eq:indented}",
    "    \\end{equation}",
    "",
    fillerParagraphs,
    "",
    "## Parseval Identity",
    "",
    "\\begin{equation}",
    "\\sum_{n=-\\infty}^{\\infty} |c_n|^2 = \\frac{1}{2\\pi} \\int_{-\\pi}^{\\pi} |f(x)|^2 \\, dx \\label{eq:parseval}",
    "\\end{equation}",
    "",
    "Follow-up reference in [[Appendix#Bounds]] and [Summary](summary.md) confirming \\eqref{eq:parseval}, while literals \\eqref{eq:fenced} and \\eqref{eq:indented} stay unresolved.",
  ].join("\n");

  await page.evaluate(
    (content) =>
      window.supermdLoad?.({
        id: "bare-equation-reader",
        path: "/notes/spectral.md",
        content,
        mode: "reader",
        dark: false,
        fullscreen: false,
        colors: {},
        font: "Manrope",
        size: 17,
        zoom: 100,
        motion: false,
        restorePosition: false,
      }),
    markdown,
  );

  const scroller = page.locator(".android-reading");
  await expect(scroller).toBeVisible();
  await expect(page.locator(".katex-error")).toHaveCount(0);

  // 1. Verify forward \eqref and \ref resolved to (1) and 1 before the equation block.
  const forwardEqref = page.locator("a.equation-ref").first();
  const forwardRef = page.locator("a.equation-ref").nth(1);
  await expect(forwardEqref).toHaveText("(1)");
  await expect(forwardRef).toHaveText("1");
  await expect(page.locator(".katex a[href='#smd-eq-eq_3a_parseval']")).toHaveText("(1)");

  // 2. Verify rendered equation block has tag (1), fenced/indented literals stay literal, and canonical source offsets hold.
  const eqAnchor = page.locator("#smd-eq-eq_3a_parseval");
  await expect(eqAnchor).toBeAttached();
  await expect(eqAnchor.locator(".katex-tag, .tag")).toContainText("(1)");
  await expect(page.locator("#smd-eq-eq_3a_fenced")).toHaveCount(0);
  await expect(page.locator("#smd-eq-eq_3a_indented")).toHaveCount(0);
  await expect(page.locator("pre code").nth(0)).toContainText("x = 999 \\label{eq:fenced}");
  await expect(page.locator("pre code").nth(1)).toContainText("y = 888 \\label{eq:indented}");
  await expect(page.locator(".equation-ref.is-unresolved")).toHaveText(["(??)", "(??)"]);

  const offsetReport = await page.evaluate((src) => {
    const sliceAt = (selector: string, index = 0) => {
      const el = document.querySelectorAll<HTMLElement>(selector)[index];
      if (!el) return null;
      const start = Number(el.dataset.sourceStart);
      const end = Number(el.dataset.sourceEnd);
      return { start, end, slice: src.slice(start, end) };
    };
    const links = Array.from(document.querySelectorAll<HTMLAnchorElement>(".markdown-body a[data-source-start]")).map(
      (a) => ({
        text: a.textContent,
        slice: src.slice(Number(a.dataset.sourceStart), Number(a.dataset.sourceEnd)),
      }),
    );
    return {
      eqBlock: sliceAt("#smd-eq-eq_3a_parseval"),
      links,
    };
  }, markdown);

  expect(offsetReport.eqBlock?.slice).toBe(
    [
      "\\begin{equation}",
      "\\sum_{n=-\\infty}^{\\infty} |c_n|^2 = \\frac{1}{2\\pi} \\int_{-\\pi}^{\\pi} |f(x)|^2 \\, dx \\label{eq:parseval}",
      "\\end{equation}",
    ].join("\n"),
  );
  expect(offsetReport.links).toEqual([
    { text: "(1)", slice: "\\eqref{eq:parseval}" },
    { text: "1", slice: "\\ref{eq:parseval}" },
    { text: "Next Lecture", slice: "[Next Lecture](./lecture-2.md#fourier)" },
    { text: "Appendix#Bounds", slice: "[[Appendix#Bounds]]" },
    { text: "Summary", slice: "[Summary](summary.md)" },
    { text: "(1)", slice: "\\eqref{eq:parseval}" },
  ]);

  // 3. Clicking the forward equation reference scrolls the real reader to the target equation block.
  expect(await scroller.evaluate((el) => el.scrollTop)).toBe(0);
  await forwardEqref.click();
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(600);
  const visibleInViewport = await page.evaluate(() => {
    const scrollerRect = document.querySelector(".android-reading")!.getBoundingClientRect();
    const targetRect = document.getElementById("smd-eq-eq_3a_parseval")!.getBoundingClientRect();
    return targetRect.top >= scrollerRect.top - 4 && targetRect.bottom <= scrollerRect.bottom + 4;
  });
  expect(visibleInViewport).toBe(true);

  // 4. Relative and wikilink workspace links after the bare equation block still route cleanly.
  await page.getByRole("link", { name: "Appendix#Bounds" }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).__workspaceLinks))
    .toEqual([
      {
        documentPath: "/notes/spectral.md",
        target: "Appendix",
        fragment: "Bounds",
        wikilink: true,
      },
    ]);

  // 5. Copying across the equation block and surrounding paragraphs preserves bare \begin{equation}...\end{equation} without $$.
  const copiedSlice = await page.evaluate(() => {
    const eq = document.getElementById("smd-eq-eq_3a_parseval")!;
    const tail = eq.nextElementSibling!;
    const range = document.createRange();
    range.setStartBefore(eq);
    range.setEndAfter(tail);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    return window.supermdSelectedText?.() || "";
  });
  expect(copiedSlice.replace(/\n{3,}/g, "\n\n")).toBe(
    [
      "\\begin{equation}",
      "\\sum_{n=-\\infty}^{\\infty} |c_n|^2 = \\frac{1}{2\\pi} \\int_{-\\pi}^{\\pi} |f(x)|^2 \\, dx \\label{eq:parseval}",
      "\\end{equation}",
      "",
      "Follow-up reference in [Appendix#Bounds](Appendix.md#bounds) and [Summary](summary.md) confirming \\eqref{eq:parseval}, while literals \\eqref{eq:fenced} and \\eqref{eq:indented} stay unresolved.",
    ].join("\n"),
  );
  expect(copiedSlice).not.toContain("$$");
});
