import { expect, test } from "@playwright/test";

const tinyPng =
  "data:image/svg+xml;base64," +
  Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="80"><rect width="240" height="80" rx="12" fill="#4f378b"/><text x="24" y="46" fill="#ffffff" font-size="18">Figure</text></svg>'
  ).toString("base64");

test("Read mode hides Replace, Previous wraps 0/N to N/N in standard and large virtualized notes, and Live Replace scrolls, expands, highlights, and gates replacement", async ({ page }) => {
  let content = [
    "# Research Note",
    "",
    "Needle intro paragraph.",
    "",
    ...Array.from({ length: 24 }, (_, idx) => `Filler section ${idx + 1} with study notes and equations $a_${idx} + b_${idx}$.`),
    "",
    "> [!QUESTION]- Folded callout section\n> Hidden Needle inside callout.",
    "",
    "```ts\n" +
      Array.from({ length: 15 }, (_, idx) => (idx === 13 ? `const codeMarker = "Needle-in-code";` : `const line${idx} = ${idx};`)).join("\n") +
      "\n```",
    "",
    "Final Needle at the bottom of the note.",
  ].join("\n\n");

  await page.exposeFunction("onDocChange", (_id: string, command: string, raw: string) => {
    if (command === "document_changed") content = JSON.parse(raw).content;
  });
  await page.addInitScript(() => {
    window.SuperMD = { post: (id, command, raw) => (window as any).onDocChange(id, command, raw) };
  });
  await page.goto("/android-reader.html");
  await page.waitForFunction(() => typeof window.supermdLoad === "function");

  const baseState = {
    id: "search-spec",
    content,
    path: null,
    mode: "reader" as const,
    dark: false,
    fullscreen: false,
    colors: {},
    font: "Manrope",
    size: 18,
    zoom: 100,
  };
  await page.evaluate((state) => window.supermdLoad?.(state), baseState);
  await page.evaluate(() => window.supermdFind?.());

  // Acceptance Criterion 1: Opening Find in Read mode hides Replace toggle and replacement controls.
  await expect(page.getByRole("button", { name: "Replace in source" })).toHaveCount(0);
  await expect(page.locator(".search-replace")).toHaveCount(0);

  // Acceptance Criterion 2 (standard note): Pressing Previous at 0 / N selects N / N.
  const searchbox = page.getByRole("searchbox", { name: "Find in note" });
  await searchbox.fill("Needle");
  await expect(page.locator(".reading-search output")).toHaveText("0 / 4");
  await page.getByRole("button", { name: "Previous match" }).click();
  await expect(page.locator(".reading-search output")).toHaveText("4 / 4");
  await expect
    .poll(() => page.evaluate(() => document.querySelector<HTMLElement>(".android-reading")!.scrollTop))
    .toBeGreaterThan(200);

  // Switch to Live mode while search is open: Replace toggle appears, and Replace gating holds.
  await page.evaluate((state) => window.supermdLoad?.(state), { ...baseState, mode: "live", content });
  await expect(page.getByRole("button", { name: "Replace in source" })).toBeVisible();
  await page.getByRole("button", { name: "Replace in source" }).click();

  const replaceSingle = page.locator(".search-replace button").nth(0);
  const replaceAll = page.locator(".search-replace button").nth(1);

  // Acceptance Criterion 4: Single-match Replace is disabled at 0 / N, and both are disabled at 0 matches.
  await searchbox.fill("nonexistent-token-xyz");
  await expect(page.locator(".reading-search output")).toHaveText("No matches");
  await expect(replaceSingle).toBeDisabled();
  await expect(replaceAll).toBeDisabled();

  await searchbox.fill("Needle");
  await expect(page.locator(".reading-search output")).toHaveText("0 / 4");
  await expect(replaceSingle).toBeDisabled();
  await expect(replaceAll).toBeEnabled();

  // Acceptance Criterion 3: Navigating matches with Replace open in Live mode scrolls, expands closed callouts & code blocks, and updates CSS highlights.
  await page.evaluate(() => { document.querySelector<HTMLElement>(".android-reading")!.scrollTop = 0; });
  await page.getByRole("button", { name: "Next match" }).click();
  await expect(page.locator(".reading-search output")).toHaveText("1 / 4");
  await expect(replaceSingle).toBeEnabled();

  // Match 2 is inside closed callout: expands <details.callout>, scrolls into view, and aligns smd-search-current.
  await expect(page.locator("details.callout")).not.toHaveAttribute("open", "");
  await page.getByRole("button", { name: "Next match" }).click();
  await expect(page.locator(".reading-search output")).toHaveText("2 / 4");
  await expect(page.locator("details.callout")).toHaveAttribute("open", "");
  const calloutInView = await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>(".android-reading")!.getBoundingClientRect();
    const callout = document.querySelector<HTMLElement>("details.callout")!.getBoundingClientRect();
    const hasCurrent = (CSS as any).highlights?.has("smd-search-current");
    const hasAll = (CSS as any).highlights?.has("smd-search");
    return callout.bottom > scroller.top && callout.top < scroller.bottom && hasCurrent && hasAll;
  });
  expect(calloutInView).toBe(true);

  // Match 3 is inside closed >12-line code disclosure: expands <details.code-disclosure> and scrolls into view.
  await expect(page.locator("details.code-disclosure")).not.toHaveAttribute("open", "");
  await page.getByRole("button", { name: "Next match" }).click();
  await expect(page.locator(".reading-search output")).toHaveText("3 / 4");
  await expect(page.locator("details.code-disclosure")).toHaveAttribute("open", "");

  // Toggling Replace off and back on preserves valid active selection (3 / 4).
  await page.getByRole("button", { name: "Replace in source" }).click();
  await expect(page.locator(".reading-search output")).toHaveText("3 / 4");
  await page.getByRole("button", { name: "Replace in source" }).click();
  await expect(page.locator(".reading-search output")).toHaveText("3 / 4");

  // Single-match Replace mutates only match 3.
  await page.getByRole("textbox", { name: "Replacement text" }).fill("Pin");
  await replaceSingle.click();
  await expect.poll(() => content).toContain('const codeMarker = "Pin-in-code";');
  expect(content).toContain("Hidden Needle inside callout.");
  expect(content).toContain("Final Needle at the bottom of the note.");

  // Acceptance Criterion 2 (large virtualized >80KB note): Previous at 0 / N wraps directly to N / N and mounts offscreen block.
  const hugeNote =
    Array.from(
      { length: 900 },
      (_, idx) => `## Section ${idx}\n\n${idx % 300 === 0 ? "TargetToken " : ""}${"Virtualized paragraph text for windowed rendering. ".repeat(3)}`
    ).join("\n\n") + "\n\n## Tail\n\nTargetToken at very end.";
  await page.evaluate((text) => window.supermdLoad?.({ id: "huge-wrap", content: text, path: null, mode: "reader", dark: false, fullscreen: false, colors: {}, font: "Manrope", size: 18, zoom: 100 }), hugeNote);
  await expect(page.locator('[data-windowed-mounted="false"]')).not.toHaveCount(0);
  await searchbox.fill("TargetToken");
  await expect(page.locator(".reading-search output")).toHaveText("0 / 4");
  await page.getByRole("button", { name: "Previous match" }).click();
  await expect(page.locator(".reading-search output")).toHaveText("4 / 4");
  await expect(page.locator(".markdown-body")).toContainText("TargetToken at very end.");
});

test("Live mode Edit block works via mouse, keyboard, and touch on media, diagrams, charts, standalone links, and collapsed blocks while stays unscaled under zoom", async ({ browser }) => {
  const context = await browser.newContext({ hasTouch: true, viewport: { width: 900, height: 760 } });
  const page = await context.newPage();
  const note = [
    "# Visual Blocks",
    "",
    `![Diagram preview](${tinyPng})`,
    "",
    "```svg\n<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"200\" height=\"60\"><rect width=\"200\" height=\"60\" fill=\"#264653\"/><circle cx=\"40\" cy=\"30\" r=\"18\" fill=\"#e9c46a\"/></svg>\n```",
    "",
    '```smd-chart\n{"title":"Harmonic","x":{"min":0,"max":6.28},"series":[{"name":"sin","expression":"Math.sin(x)"}]}\n```',
    "",
    "[Reference Link](#visual-blocks)",
    "",
    "> [!TIP]- Collapsed Summary\n> Inside collapsed callout",
  ].join("\n\n");

  await page.addInitScript(() => { window.SuperMD = { post: () => {} }; });
  await page.goto("/android-reader.html");
  await page.waitForFunction(() => typeof window.supermdLoad === "function");
  await page.evaluate((content) => window.supermdLoad?.({ id: "live-blocks", content, path: null, mode: "live", dark: false, fullscreen: false, colors: {}, font: "Manrope", size: 18, zoom: 100 }), note);

  // 1. Image block: single click opens ImageViewer; Edit block opens Markdown source; Escape closes ImageViewer before editor/search.
  const imageBlock = page.locator(".live-block").nth(1);
  await imageBlock.locator("img").click();
  await expect(page.getByRole("dialog", { name: "Image viewer" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Image viewer" })).toHaveCount(0);

  await imageBlock.hover();
  const editAt100 = await imageBlock.getByRole("button", { name: "Edit block" }).boundingBox();
  expect(editAt100).not.toBeNull();
  await imageBlock.getByRole("button", { name: "Edit block" }).click();
  await expect(page.getByRole("textbox", { name: "Edit Markdown block" })).toHaveValue(`![Diagram preview](${tinyPng})`);
  await page.keyboard.press("Escape");

  // 2. Zoom to 180%: Edit block button remains unscaled and edit does not reset zoom.
  await page.evaluate(() => window.supermdSetZoom?.(180));
  const svgBlock = page.locator(".live-block").nth(2);
  await svgBlock.hover();
  const editAt180 = await svgBlock.getByRole("button", { name: "Edit block" }).boundingBox();
  expect(editAt180).not.toBeNull();
  expect(Math.abs(editAt180!.height - editAt100!.height)).toBeLessThan(2.5);
  expect(Math.abs(editAt180!.width - editAt100!.width)).toBeLessThan(2.5);
  await svgBlock.getByRole("button", { name: "Edit block" }).click();
  await expect(page.getByRole("textbox", { name: "Edit Markdown block" })).toContainText("```svg");
  await page.keyboard.press("Escape");
  expect(await page.evaluate(() => document.querySelector<HTMLElement>(".document-page")?.dataset.scale)).toBe("1.8");

  // 3. Chart block via keyboard focus + Edit block button.
  const chartBlock = page.locator(".live-block").nth(3);
  await chartBlock.focus();
  await expect(chartBlock.getByRole("button", { name: "Edit block" })).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(chartBlock.getByRole("button", { name: "Edit block" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("textbox", { name: "Edit Markdown block" })).toContainText("smd-chart");
  await page.keyboard.press("Escape");

  // 4. Standalone link: single click navigates without opening editor; Edit block opens source.
  const linkBlock = page.locator(".live-block").nth(4);
  await linkBlock.locator("a").click();
  await expect(page.getByRole("textbox", { name: "Edit Markdown block" })).toHaveCount(0);
  await linkBlock.hover();
  await linkBlock.getByRole("button", { name: "Edit block" }).click();
  await expect(page.getByRole("textbox", { name: "Edit Markdown block" })).toHaveValue("[Reference Link](#visual-blocks)");
  await page.keyboard.press("Escape");

  // 5. Collapsed callout via touch tap: single tap toggles summary disclosure AND reveals Edit block.
  const calloutBlock = page.locator(".live-block").nth(5);
  await expect(calloutBlock.locator("details.callout")).not.toHaveAttribute("open", "");
  await calloutBlock.locator("summary").tap();
  await expect(calloutBlock.locator("details.callout")).toHaveAttribute("open", "");
  await expect(calloutBlock.getByRole("button", { name: "Edit block" })).toBeVisible();
  await calloutBlock.getByRole("button", { name: "Edit block" }).tap();
  await expect(page.getByRole("textbox", { name: "Edit Markdown block" })).toContainText("[!TIP]- Collapsed Summary");
  await page.keyboard.press("Escape");

  await context.close();
});

test("Changing a block's line count in Live mode and clicking a checkbox, link, or button below activates on the first click without jumping scroll position", async ({ page }) => {
  let content = [
    ...Array.from({ length: 24 }, (_, idx) => `Lead paragraph ${idx + 1} above the target editing region with study prose to establish deep scroll offset.`),
    "## Editable Section\n\nShort text.",
    "- [ ] Lower task item",
    "[External Resource](https://example.com/study)",
    "```ts\nconst answer = 42;\n```",
    ...Array.from({ length: 24 }, (_, idx) => `Trailing paragraph ${idx + 1} keeping the page scrollable below the target controls.`),
  ].join("\n\n");

  let copiedText = "";
  await page.exposeFunction("saveContent", (_id: string, command: string, raw: string) => {
    if (command === "document_changed") content = JSON.parse(raw).content;
    if (command === "copy_text") copiedText = JSON.parse(raw).text;
  });
  await page.addInitScript(() => {
    window.SuperMD = {
      post: (id, command, raw) => {
        void (window as any).saveContent(id, command, raw);
        queueMicrotask(() => window.supermdReply?.(id, true, null));
      },
    };
  });
  await page.goto("/android-reader.html");
  await page.waitForFunction(() => typeof window.supermdLoad === "function");
  await page.evaluate((text) => window.supermdLoad?.({ id: "stable-close", content: text, path: null, mode: "live", dark: false, fullscreen: false, colors: {}, font: "Manrope", size: 18, zoom: 100 }), content);

  const editableHeading = page.getByRole("heading", { name: "Editable Section" });
  await editableHeading.scrollIntoViewIfNeeded();

  // Case 1: Expand block by 10 paragraphs, scroll checkbox into view, and single-click the checkbox below.
  await editableHeading.dblclick();
  const editor = page.getByRole("textbox", { name: "Edit Markdown block" });
  await editor.fill("## Editable Section\n\n" + Array.from({ length: 10 }, (_, i) => `Added paragraph ${i + 1} with extra vertical height.`).join("\n\n"));

  const checkbox = page.locator('.live-block input[type="checkbox"]');
  await checkbox.scrollIntoViewIfNeeded();
  const beforeCheckTop = (await checkbox.boundingBox())!.y;
  await checkbox.click();
  await expect(editor).toHaveCount(0);
  await expect(checkbox).toBeChecked();
  await expect.poll(() => content).toContain("- [x] Lower task item");
  const afterCheckTop = (await checkbox.boundingBox())!.y;
  expect(Math.abs(afterCheckTop - beforeCheckTop)).toBeLessThan(6);

  // Case 2: Shrink multi-paragraph section back down, then single-click the link below.
  await page.getByRole("heading", { name: "Editable Section" }).scrollIntoViewIfNeeded();
  await page.getByRole("heading", { name: "Editable Section" }).dblclick();
  await editor.fill("## Editable Section");
  const link = page.getByRole("link", { name: "External Resource" });
  await link.scrollIntoViewIfNeeded();
  await page.evaluate(() => {
    (window as any).__linkClicks = 0;
    document.querySelector('a[href="https://example.com/study"]')!.addEventListener("click", (e) => {
      e.preventDefault();
      (window as any).__linkClicks++;
    });
  });
  const beforeLinkTop = (await link.boundingBox())!.y;
  await link.click();
  await expect(editor).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__linkClicks)).toBe(1);
  const afterLinkTop = (await link.boundingBox())!.y;
  expect(Math.abs(afterLinkTop - beforeLinkTop)).toBeLessThan(6);

  // Case 3: Expand heading block into 8 paragraphs again, then single-click the Copy button on the code block below.
  await page.getByRole("heading", { name: "Editable Section" }).scrollIntoViewIfNeeded();
  await page.getByRole("heading", { name: "Editable Section" }).dblclick();
  await editor.fill("## Editable Section\n\n" + Array.from({ length: 8 }, (_, i) => `Expanded paragraph ${i + 1} adding significant vertical height.`).join("\n\n"));
  const copyButton = page.locator("button.code-copy");
  await copyButton.scrollIntoViewIfNeeded();
  const beforeButtonTop = (await copyButton.boundingBox())!.y;
  await copyButton.click();
  await expect(editor).toHaveCount(0);
  await expect(copyButton).toHaveText("Copied");
  await expect.poll(() => copiedText).toBe("const answer = 42;");
  const afterButtonTop = (await copyButton.boundingBox())!.y;
  expect(Math.abs(afterButtonTop - beforeButtonTop)).toBeLessThan(6);
});

test("Desktop workspace (App.tsx) hides Replace in Read view, wraps Previous 0/N to N/N, and supports Live Replace and Edit block", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript((img) => {
    localStorage.setItem("setup.complete", "true");
    localStorage.setItem(
      "workspace.tabs.browser",
      JSON.stringify({
        activeId: "desk-1",
        recentlyClosed: [],
        tabs: [
          {
            id: "desk-1",
            name: "Study.md",
            path: null,
            savedContent: "",
            content: `# Desktop Note\n\nAlpha token one.\n\n![Chart figure](${img})\n\n> [!NOTE]- Collapsed desktop note\n> Alpha token two.`,
          },
        ],
      })
    );
  }, tinyPng);
  await page.goto("/");

  await page.getByRole("button", { name: "reader view" }).click();
  await page.getByRole("button", { name: "Find and replace" }).click();
  await expect(page.getByRole("button", { name: "Replace in source" })).toHaveCount(0);

  const searchbox = page.getByRole("searchbox", { name: "Find in note" });
  await searchbox.fill("Alpha");
  await expect(page.locator(".reading-search output")).toHaveText("0 / 2");
  await page.getByRole("button", { name: "Previous match" }).click();
  await expect(page.locator(".reading-search output")).toHaveText("2 / 2");
  await expect(page.locator("details.callout")).toHaveAttribute("open", "");

  await page.getByRole("button", { name: "live view" }).click();
  await expect(page.getByRole("button", { name: "Replace in source" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".reading-search")).toHaveCount(0);

  const imgBlock = page.locator(".live-block").nth(2);
  await imgBlock.locator("img").click();
  await expect(page.getByRole("dialog", { name: "Image viewer" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Image viewer" })).toHaveCount(0);

  await imgBlock.hover();
  await imgBlock.getByRole("button", { name: "Edit block" }).click();
  await expect(page.getByRole("textbox", { name: "Edit Markdown block" })).toHaveValue(`![Chart figure](${tinyPng})`);
});

test("Seeded source occurrences reveal matching offscreen StepCards slides and standalone diagrams while stale offsets fall back cleanly", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 760 });
  const deckJson = JSON.stringify({
    title: " Eigenvalue Walkthrough",
    steps: [
      { label: "Matrix setup", markdown: "Start with symmetric matrix $A$ and initial vector." },
      { label: " Krylov graph", diagram: { width: 340, height: 150, nodes: [{ id: "k1", label: "Lanczos Krylov Pivot", x: 100, y: 75 }, { id: "k2", label: "Residual", x: 250, y: 75 }], edges: [{ from: "k1", to: "k2" }] } },
      { label: "Rayleigh quotient", markdown: "Converges rapidly to the dominant **Rayleigh Spectrum** eigenvalue." },
    ],
  });
  const filler = Array.from(
    { length: 45 },
    (_, idx) => `## Background Section ${idx + 1}\n\n${"Detailed numerical linear algebra background paragraph for virtualized windowing coverage. ".repeat(22)}`
  ).join("\n\n");
  const standaloneDiagram = '```smd-diagram\n{"width":360,"height":150,"nodes":[{"id":"d1","label":"Householder Tridiagonal Core","x":110,"y":75},{"id":"d2","label":"QR Step","x":260,"y":75}],"edges":[{"from":"d1","to":"d2"}]}\n```';
  const note = [
    "# Numerical Methods",
    "",
    "Introductory Rayleigh Spectrum mention near the top.",
    "",
    filler,
    "",
    "```smd-steps\n" + deckJson + "\n```",
    "",
    filler,
    "",
    standaloneDiagram,
  ].join("\n\n");

  const slide3Text = "Rayleigh Spectrum";
  const slide3Start = note.indexOf(slide3Text, note.indexOf("```smd-steps"));
  const slide3End = slide3Start + slide3Text.length;

  const slide2DiagramText = "Lanczos Krylov Pivot";
  const slide2Start = note.indexOf(slide2DiagramText);
  const slide2End = slide2Start + slide2DiagramText.length;

  const diagText = "Householder Tridiagonal Core";
  const diagStart = note.indexOf(diagText);
  const diagEnd = diagStart + diagText.length;

  await page.addInitScript(() => { window.SuperMD = { post: () => {} }; });
  await page.goto("/android-reader.html");
  await page.waitForFunction(() => typeof window.supermdLoad === "function");
  await page.evaluate(
    (content) =>
      window.supermdLoad?.({
        id: "step-diagram-seed",
        content,
        path: null,
        mode: "reader",
        dark: false,
        fullscreen: false,
        colors: {},
        font: "Manrope",
        size: 18,
        zoom: 100,
      }),
    note
  );
  await expect(page.locator('[data-windowed-mounted="false"]')).not.toHaveCount(0);

  // 1. Seeded verified occurrence on offscreen StepCards Slide 3 prose: mounts block, switches to 3 / 3, scrolls into viewport, and highlights match.
  await page.evaluate(
    ({ start, end, text }) =>
      window.supermdFind?.(text, {
        caseSensitive: true,
        sourceStart: start,
        sourceEnd: end,
        matchText: text,
      }),
    { start: slide3Start, end: slide3End, text: slide3Text }
  );
  const stepCards = page.locator(".step-cards");
  await expect(stepCards).toBeVisible();
  await expect(stepCards).toHaveAttribute("data-step-index", "2");
  await expect(stepCards.locator(".step-cards-progress")).toHaveText("3 / 3");
  await expect(stepCards.locator(".step-cards-description")).toBeInViewport();
  await expect(page.locator(".reading-search output")).toHaveText("2 / 2");

  // 2. Seeded verified occurrence inside Slide 2's diagram JSON: switches StepCards to 2 / 3 and keeps diagram stage in viewport with source-only status.
  await page.evaluate(
    ({ start, end, text }) =>
      window.supermdFind?.(text, {
        caseSensitive: true,
        sourceStart: start,
        sourceEnd: end,
        matchText: text,
      }),
    { start: slide2Start, end: slide2End, text: slide2DiagramText }
  );
  await expect(stepCards).toHaveAttribute("data-step-index", "1");
  await expect(stepCards.locator(".step-cards-progress")).toHaveText("2 / 3");
  await expect(stepCards.locator(".step-cards-inline-figure svg")).toBeInViewport();
  await expect(page.locator(".reading-search output")).toContainText("In source");

  // 3. Seeded verified occurrence inside offscreen standalone smd-diagram: mounts block and scrolls diagram into viewport.
  await page.evaluate(
    ({ start, end, text }) =>
      window.supermdFind?.(text, {
        caseSensitive: true,
        sourceStart: start,
        sourceEnd: end,
        matchText: text,
      }),
    { start: diagStart, end: diagEnd, text: diagText }
  );
  const lastDiagram = page.locator(".inline-diagram").last();
  await expect(lastDiagram).toBeInViewport();
  await expect(page.locator(".reading-search output")).toContainText("In source");

  // 4. Stale source offsets after note edit keep a fresh StepCards deck on Slide 1 and fall back to ordinary Find (1 / 2).
  const editedNote = "Prepended paragraph shifting every character offset in the note.\n\n" + note.replace("Eigenvalue Walkthrough", "Shifted Eigenvalue Walkthrough");
  await page.evaluate(
    ({ content, start, end, text }) => {
      window.supermdLoad?.({
        id: "step-diagram-stale",
        content,
        path: null,
        mode: "reader",
        dark: false,
        fullscreen: false,
        colors: {},
        font: "Manrope",
        size: 18,
        zoom: 100,
        seededFind: {
          query: text,
          caseSensitive: true,
          sourceStart: start,
          sourceEnd: end,
          matchText: text,
        },
      });
    },
    { content: editedNote, start: slide3Start, end: slide3End, text: slide3Text }
  );
  await expect(page.locator(".reading-search output")).toHaveText("1 / 2");
  await expect(page.locator("p", { hasText: "Introductory Rayleigh Spectrum mention near the top." })).toBeInViewport();
});
