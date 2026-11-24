import { expect, test } from "@playwright/test";

test("renders properties header, hides YAML variations, isolates live first-block edits, excludes header on copy, and preserves checkbox offsets across hosts", async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).__lastChangedContent = null;
    window.SuperMD = {
      post: (id, command, raw) => {
        if (command === "document_changed") {
          (window as any).__lastChangedContent = JSON.parse(raw).content;
        }
        queueMicrotask(() => window.supermdReply?.(id, true, null));
      },
    };
  });

  await page.goto("/android-reader.html");
  await page.waitForFunction(() => typeof window.supermdLoad === "function");

  const richNote = [
    "\uFEFF---   ",
    'title: "Path Integrals & Symmetries"',
    "subtitle: Graduate Lecture Notes",
    "author:",
    "  - name: Richard Feynman",
    "  - given: Emmy",
    "    family: Noether",
    "date: 2026-03-15",
    "description: Action principles, propagators, and conservation laws.",
    "tags: [quantum, physics,quarto]",
    "aliases: [QFT Notes]",
    "...  ",
    "",
    "# Propagator Kernel",
    "",
    "Transition amplitude between boundary states:",
    "",
    "- [ ] Derive stationary phase approximation",
    "- [x] Verify unitarity",
  ].join("\n");

  for (const host of ["qt", "android"] as const) {
    await page.evaluate((h) => {
      document.documentElement.dataset.host = h;
      document.documentElement.dataset.platform = h === "android" ? "android" : "desktop";
    }, host);

    await page.evaluate((content) => {
      window.supermdLoad?.({
        id: "fm-note",
        content,
        path: null,
        mode: "reader",
        dark: false,
        fullscreen: false,
        colors: {},
        font: "Manrope",
        size: 18,
        zoom: 100,
        motion: false,
      });
    }, richNote);

    const header = page.getByRole("region", { name: "Document properties" });
    await expect(header).toBeVisible();
    await expect(header).toContainText("Path Integrals & Symmetries");
    await expect(header).toContainText("Richard Feynman, Emmy Noether");
    await expect(header).toContainText("2026-03-15");
    await expect(header).toContainText("Action principles, propagators, and conservation laws.");
    await expect(header).toContainText("quantum");
    await expect(header).toContainText("QFT Notes");
    await expect(page.locator(".markdown-body hr")).toHaveCount(0);

    // Selecting from properties header through body excludes header labels and badges on copy.
    const copied = await page.evaluate(() => {
      const article = document.querySelector(".markdown-body")!;
      const range = document.createRange();
      range.selectNodeContents(article);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
      let captured = "";
      const dt = {
        setData: (_type: string, val: string) => { captured = val; },
      };
      const evt = new Event("copy", { bubbles: true, cancelable: true });
      Object.defineProperty(evt, "clipboardData", { value: dt });
      article.dispatchEvent(evt);
      sel.removeAllRanges();
      return captured;
    });
    expect(copied).toContain("# Propagator Kernel");
    expect(copied).not.toContain("Path Integrals & Symmetries");
    expect(copied).not.toContain("Author");
    expect(copied).not.toContain("QFT Notes");

    // Task checkbox toggle updates exact source offset without modifying frontmatter.
    const firstCheckbox = page.getByRole("checkbox").first();
    await firstCheckbox.click();
    await expect(firstCheckbox).toBeChecked();
    expect(await page.evaluate(() => (window as any).__lastChangedContent)).toBe(
      richNote.replace("- [ ] Derive", "- [x] Derive"),
    );

    // Live mode isolates YAML frontmatter when double-clicking the first visible block.
    await page.evaluate((content) => {
      window.supermdLoad?.({
        id: "fm-live",
        content,
        path: null,
        mode: "live",
        dark: false,
        fullscreen: false,
        colors: {},
        font: "Manrope",
        size: 18,
        zoom: 100,
        motion: false,
      });
    }, richNote);

    await expect(page.getByRole("region", { name: "Document properties" })).toBeVisible();
    await page.getByRole("heading", { name: "Propagator Kernel", exact: true }).dblclick();
    const editor = page.getByRole("textbox", { name: "Edit Markdown block" });
    await expect(editor).toHaveValue("# Propagator Kernel");
    await editor.fill("# Updated Propagator Kernel");
    await editor.press("Escape");
    expect(await page.evaluate(() => (window as any).__lastChangedContent)).toBe(
      richNote.replace("# Propagator Kernel", "# Updated Propagator Kernel"),
    );
  }

  // Empty blocks and EOF closers render zero raw YAML lines.
  for (const variant of [
    "---\n---\n\n# Clean Empty Block",
    "---\n...\n\n# Clean Dot Empty Block",
    "---\ntitle: EOF Metadata\n---",
  ]) {
    await page.evaluate((content) => {
      window.supermdLoad?.({
        id: "fm-variant",
        content,
        path: null,
        mode: "reader",
        dark: false,
        fullscreen: false,
        colors: {},
        font: "Manrope",
        size: 18,
        zoom: 100,
        motion: false,
      });
    }, variant);
    await expect(page.locator(".markdown-body hr")).toHaveCount(0);
    await expect(page.locator(".markdown-body")).not.toContainText("---");
    await expect(page.locator(".markdown-body")).not.toContainText("title:");
  }
});
