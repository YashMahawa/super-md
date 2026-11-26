import { test, expect, type Page } from "@playwright/test";

async function loadLiveNote(page: Page, content: string, mode: "live" | "reader" = "live") {
  await page.addInitScript(() => {
    (window as any).latestContent = null;
    window.SuperMD = {
      post: (id, command, raw) => {
        const args = raw ? JSON.parse(raw) : {};
        if (command === "document_changed") (window as any).latestContent = args.content;
        const result =
          command === "load_asset"
            ? "data:image/svg+xml;base64," +
              btoa(
                '<svg xmlns="http://www.w3.org/2000/svg" width="280" height="120"><rect width="280" height="120" rx="14" fill="#355c7d"/><text x="140" y="68" text-anchor="middle" fill="#ffffff" font-family="sans-serif" font-size="22">Sample Figure</text></svg>',
              )
            : true;
        queueMicrotask(() => window.supermdReply?.(id, result, null));
      },
    };
  });
  await page.goto("/android-reader.html");
  await page.waitForFunction(() => typeof window.supermdLoad === "function");
  await page.evaluate(
    ({ content, mode }) => {
      document.documentElement.dataset.host = "qt";
      document.documentElement.dataset.platform = "desktop";
      window.supermdLoad?.({
        id: "live-flow-note",
        content,
        path: "/notes/flow.md",
        mode,
        dark: false,
        fullscreen: false,
        colors: {},
        font: "Manrope",
        size: 16,
        zoom: 100,
      });
    },
    { content, mode },
  );
}

test("outlines nested CommonMark lists with Tab/Shift+Tab, preserves native undo, and navigates blocks by keyboard", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  const initial = [
    "# Sprint Outline",
    "",
    "1. Parent step",
    "2. Second step",
    "3. [ ] Task step",
    "",
    "> - Quoted parent",
    "> - Quoted child",
    "",
    "Plain closing note",
  ].join("\n");
  await loadLiveNote(page, initial, "live");

  // Idle Live blocks must not show persistent edit buttons.
  await expect(page.locator(".live-block button")).toHaveCount(0);

  // Double-click the ordered list block and indent/outdent items with Tab & Shift+Tab while preserving undo.
  await page.locator(".live-block").nth(1).dblclick();
  const area = page.getByRole("textbox", { name: "Edit Markdown block" });
  await expect(area).toBeFocused();

  // Move to line 2 (`2. Second step`) and press Tab -> aligns at column 3 under `1. Parent step`.
  await area.press("Control+Home");
  await area.press("ArrowDown");
  await area.press("Tab");
  await expect(area).toBeFocused();
  await expect(area).toHaveValue("1. Parent step\n   2. Second step\n3. [ ] Task step");

  // Native textarea undo & redo must remain intact.
  await area.press("Control+z");
  await expect(area).toHaveValue("1. Parent step\n2. Second step\n3. [ ] Task step");
  await area.press("Control+y");
  await expect(area).toHaveValue("1. Parent step\n   2. Second step\n3. [ ] Task step");

  // Indent task item hierarchically: first Tab -> col 3 (sibling), second Tab -> col 6 (nested under 2.), Shift+Tab -> col 3.
  await area.press("ArrowDown");
  await area.press("Tab");
  await expect(area).toHaveValue("1. Parent step\n   2. Second step\n   3. [ ] Task step");
  await area.press("Tab");
  await expect(area).toHaveValue("1. Parent step\n   2. Second step\n      3. [ ] Task step");
  await area.press("Shift+Tab");
  await expect(area).toBeFocused();
  await expect(area).toHaveValue("1. Parent step\n   2. Second step\n   3. [ ] Task step");
  await page.screenshot({ path: "/tmp/live-list-flow.png" });

  // ArrowDown on the last line of the ordered list moves into the blockquote list block!
  await area.press("ArrowDown");
  const quotedArea = page.getByRole("textbox", { name: "Edit Markdown block" });
  await expect(quotedArea).toBeFocused();
  await expect(quotedArea).toHaveValue("> - Quoted parent\n> - Quoted child");
  await quotedArea.press("ArrowDown");
  await quotedArea.press("Tab");
  await expect(quotedArea).toHaveValue("> - Quoted parent\n>   - Quoted child");

  // Ctrl+Enter creates and focuses a new editable block immediately below.
  await quotedArea.press("Control+Enter");
  const inserted = page.getByRole("textbox", { name: "Edit Markdown block" });
  await expect(inserted).toBeFocused();
  await expect(inserted).toHaveValue("");
  await inserted.pressSequentially("Bridge paragraph between list and closing note.");

  // ArrowDown on the last line moves into the next block ("Plain closing note").
  await inserted.press("ArrowDown");
  const lastBlockArea = page.getByRole("textbox", { name: "Edit Markdown block" });
  await expect(lastBlockArea).toBeFocused();
  await expect(lastBlockArea).toHaveValue("Plain closing note");

  // Indent and outdent plain non-list line, plus Shift+Tab at 0 indent never loses focus.
  await lastBlockArea.press("Tab");
  await expect(lastBlockArea).toHaveValue("  Plain closing note");
  await lastBlockArea.press("Shift+Tab");
  await expect(lastBlockArea).toHaveValue("Plain closing note");
  await lastBlockArea.press("Shift+Tab");
  await expect(lastBlockArea).toBeFocused();

  // ArrowUp on the first line moves back to the bridge paragraph.
  await lastBlockArea.press("Home");
  await lastBlockArea.press("ArrowUp");
  await expect(page.getByRole("textbox", { name: "Edit Markdown block" })).toHaveValue(
    "Bridge paragraph between list and closing note.",
  );

  // Escape closes the editor and keeps keyboard focus on that rendered .live-block so Enter/F2 reopens it.
  await page.keyboard.press("Escape");
  await expect(page.locator("textarea")).toHaveCount(0);
  await expect(page.locator(".live-block:focus")).toContainText("Bridge paragraph between list and closing note.");

  await page.keyboard.press("Enter");
  await expect(page.getByRole("textbox", { name: "Edit Markdown block" })).toHaveValue(
    "Bridge paragraph between list and closing note.",
  );
  await page.keyboard.press("Escape");
  await page.keyboard.press("F2");
  await expect(page.getByRole("textbox", { name: "Edit Markdown block" })).toHaveValue(
    "Bridge paragraph between list and closing note.",
  );
});

test("edits diagrams, images, unzoomed charts, and folded blocks via double-click or viewer Edit source, and appends below trailing blocks", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const longCode = Array.from({ length: 14 }, (_, i) => `export const step${i} = ${i};`).join("\n");
  const chartSpec = JSON.stringify({
    title: "Harmonic Oscillator",
    x: { min: -4, max: 4 },
    series: [{ name: "sin(x)", expression: "Math.sin(x)" }],
  });
  const note = [
    "> [!answer]- Collapsible proof",
    "> Hidden derivation.",
    "",
    "```ts",
    longCode,
    "```",
    "",
    "![Architecture](assets/sample.svg)",
    "",
    "```svg",
    '<svg xmlns="http://www.w3.org/2000/svg" width="220" height="80"><rect width="220" height="80" rx="12" fill="#2a9d8f"/><text x="110" y="46" text-anchor="middle" fill="#fff" font-size="18">Vector Box</text></svg>',
    "```",
    "",
    "```smd-chart",
    chartSpec,
    "```",
    "",
    "```mermaid",
    "flowchart LR",
    "  Draft --> Review --> Publish",
    "```",
  ].join("\n");

  await loadLiveNote(page, note, "live");
  await expect(page.locator(".mermaid img.svg-diagram")).toBeVisible();

  // 1. Single-click folded summary toggles <details> without opening editor; double-click opens source.
  const calloutSummary = page.locator("details.callout > summary");
  await calloutSummary.click();
  await expect(page.locator("details.callout")).toHaveAttribute("open", "");
  await expect(page.locator("textarea")).toHaveCount(0);
  await calloutSummary.dblclick();
  await expect(page.getByRole("textbox", { name: "Edit Markdown block" })).toHaveValue(
    "> [!answer]- Collapsible proof\n> Hidden derivation.",
  );
  await page.keyboard.press("Escape");

  // 2. Double-click >12-line folded code disclosure summary opens source.
  await page.locator(".code-disclosure > summary").dblclick();
  await expect(page.getByRole("textbox", { name: "Edit Markdown block" })).toHaveValue(/export const step13 = 13;/);
  await page.keyboard.press("Escape");

  // 3. Double-click image and SVG diagram opens source without leaving ImageViewer open.
  await page.locator(".note-image img").dblclick();
  await expect(page.getByRole("dialog", { name: "Image viewer" })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Edit Markdown block" })).toHaveValue("![Architecture](assets/sample.svg)");
  await page.keyboard.press("Escape");

  await page.locator(".svg-figure img.svg-diagram").first().dblclick();
  await expect(page.getByRole("dialog", { name: "Image viewer" })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Edit Markdown block" })).toHaveValue(/Vector Box/);
  await page.keyboard.press("Escape");

  // 4. Panned/zoomed chart double-click resets viewport; unzoomed chart double-click opens source.
  const chartFigure = page.locator(".interactive-chart");
  const chartSvg = chartFigure.locator("svg");
  await chartSvg.scrollIntoViewIfNeeded();
  const chartBox = (await chartSvg.boundingBox())!;
  await page.mouse.move(chartBox.x + chartBox.width / 2, chartBox.y + chartBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(chartBox.x + chartBox.width / 2 + 80, chartBox.y + chartBox.height / 2 + 20, { steps: 6 });
  await page.mouse.up();
  await expect.poll(() => chartFigure.getAttribute("data-center-x")).not.toBe("0");

  await chartSvg.dblclick();
  await expect(chartFigure).toHaveAttribute("data-center-x", "0");
  await expect(page.locator("textarea")).toHaveCount(0);

  await chartSvg.dblclick();
  await expect(page.getByRole("textbox", { name: "Edit Markdown block" })).toHaveValue(/```smd-chart/);
  await page.keyboard.press("Escape");

  // 5. Single-click Mermaid diagram opens full-screen viewer with Edit source; clicking Edit source opens block editor.
  const mermaidImg = page.locator(".mermaid img.svg-diagram");
  await mermaidImg.scrollIntoViewIfNeeded();
  await mermaidImg.click();
  const viewer = page.getByRole("dialog", { name: "Image viewer" });
  await expect(viewer).toBeVisible();
  const editSourceBtn = viewer.getByRole("button", { name: "Edit source" });
  await expect(editSourceBtn).toBeVisible();
  await page.screenshot({ path: "/tmp/live-viewer-edit-source.png" });

  await editSourceBtn.click();
  await expect(viewer).toHaveCount(0);
  const mermaidEditor = page.getByRole("textbox", { name: "Edit Markdown block" });
  await expect(mermaidEditor).toBeFocused();
  await expect(mermaidEditor).toHaveValue(/flowchart LR/);
  await page.screenshot({ path: "/tmp/live-diagram-edit-handoff.png" });
  await page.keyboard.press("Escape");
  await expect(page.locator(".mermaid img.svg-diagram")).toBeVisible();

  // 6. Double-click blank bottom margin below the trailing Mermaid diagram appends a new editable block.
  const scroller = page.locator(".android-reading");
  await scroller.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  const lastBlockBox = (await page.locator(".live-block").last().boundingBox())!;
  await page.mouse.dblclick(lastBlockBox.x + 80, lastBlockBox.y + lastBlockBox.height + 60);
  const appended = page.getByRole("textbox", { name: "Edit Markdown block" });
  await expect(appended).toBeFocused();
  await appended.pressSequentially("Post-diagram takeaway at the bottom of the note.");
  await expect
    .poll(() => page.evaluate(() => (window as any).latestContent as string))
    .toContain("```\n\nPost-diagram takeaway at the bottom of the note.");

  // 7. Outside Live mode (reader mode), single-clicking opens ImageViewer immediately with no Edit source button.
  await page.evaluate((content) => {
    window.supermdLoad?.({
      id: "reader-mode-check",
      content,
      path: "/notes/flow.md",
      mode: "reader",
      dark: false,
      fullscreen: false,
      colors: {},
      font: "Manrope",
      size: 16,
      zoom: 100,
    });
  }, note);
  const readSvg = page.locator(".svg-figure img.svg-diagram").first();
  await expect(readSvg).toBeVisible();
  const openedImmediately = await readSvg.evaluate(async (el) => {
    (el as HTMLElement).click();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    return Boolean(document.querySelector(".image-viewer"));
  });
  expect(openedImmediately).toBe(true);
  await expect(page.locator(".image-viewer").getByRole("button", { name: "Edit source" })).toHaveCount(0);
});

test("supports StepCards slide viewer Edit source handoff and preserves document-wide references and footnotes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  const stepSvg =
    "data:image/svg+xml;base64," +
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="140" viewBox="0 0 320 140"><rect width="320" height="140" rx="12" fill="#1d3557"/><text x="160" y="78" text-anchor="middle" fill="#fff" font-size="24">Step 1</text></svg>',
    ).toString("base64");
  const deck = {
    title: "Pipeline Walkthrough",
    steps: [
      { label: "Parse", image: stepSvg },
      { label: "Render", image: stepSvg },
    ],
  };
  const note = [
    "# Walkthrough",
    "",
    "See the [design doc][spec] and footnote[^1].",
    "",
    "```smd-steps",
    JSON.stringify(deck),
    "```",
    "",
    "[spec]: https://example.com/spec",
    "",
    "[^1]: Preserved footnote body.",
  ].join("\n");

  await loadLiveNote(page, note, "live");
  const cardImg = page.locator(".step-cards-figure.is-current img");
  await expect(cardImg).toBeVisible();

  // Double-clicking inline step slide opens Markdown block without leaving Slide viewer open.
  await cardImg.dblclick();
  await expect(page.getByRole("dialog", { name: "Slide viewer" })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Edit Markdown block" })).toHaveValue(/Pipeline Walkthrough/);
  await page.keyboard.press("Escape");

  // Single-clicking inline step slide opens Slide viewer with Edit source button.
  await page.locator(".step-cards-figure.is-current img").click();
  const slideViewer = page.getByRole("dialog", { name: "Slide viewer" });
  await expect(slideViewer).toBeVisible();
  const editSource = slideViewer.getByRole("button", { name: "Edit source" });
  await expect(editSource).toBeVisible();
  await editSource.click();
  await expect(slideViewer).toHaveCount(0);
  const deckEditor = page.getByRole("textbox", { name: "Edit Markdown block" });
  await expect(deckEditor).toBeFocused();
  await expect(deckEditor).toHaveValue(/Pipeline Walkthrough/);
  await page.keyboard.press("Escape");

  // Document-wide reference link and footnote resolve accurately across frozen Live blocks.
  await expect(page.locator('a[href="https://example.com/spec"]')).toHaveText("design doc");
  await expect(page.locator(".footnotes")).toContainText("Preserved footnote body.");
});

