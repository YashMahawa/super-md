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

test("Seeded folder-search handoff reveals exact offscreen windowed occurrences into the viewport and falls back cleanly on stale ranges", async ({ page }) => {
  await page.addInitScript(() => {
    window.SuperMD = { post: () => {} };
  });
  await page.goto("/android-reader.html");
  await page.waitForFunction(() => typeof window.supermdLoad === "function");

  const filler = "Windowed study prose paragraph with context for offscreen scrolling.\n\n".repeat(40);
  const content =
    `# Seeded Handoff\n\nIntro AuroraPin occurrence one.\n\n` +
    Array.from({ length: 50 }, (_, i) => {
      if (i === 18) return `## Section ${i}\n\nMidway AuroraPin occurrence two.\n\n${filler}`;
      if (i === 35) return `## Section ${i}\n\nDeep offscreen AuroraPin occurrence three.\n\n${filler}`;
      if (i === 42) return `## Section ${i}\n\n💡 Unicode Hauptstraße offscreen target.\n\n${filler}`;
      if (i === 46) return `## Section ${i}\n\nHidden [portal link](https://example.org/AuroraHiddenUrl) target.\n\n${filler}`;
      return `## Section ${i}\n\n${filler}`;
    }).join("");
  expect(content.length).toBeGreaterThan(85_000);

  const firstStart = content.indexOf("AuroraPin");
  const secondStart = content.indexOf("AuroraPin", firstStart + 1);
  const thirdStart = content.indexOf("AuroraPin", secondStart + 1);
  const unicodeStart = content.indexOf("straße");
  const hiddenStart = content.indexOf("AuroraHiddenUrl");

  for (const mode of ["reader", "live"] as const) {
    // 1. Fresh load with a #116 shared source anchor on Section 18 + seededFind to the 3rd occurrence -> seededFind wins (3 / 3 in viewport).
    await page.evaluate(
      ({ content, mode, secondStart, thirdStart }) =>
        window.supermdLoad?.({
          id: `seeded-${mode}`,
          content,
          path: null,
          mode,
          dark: false,
          fullscreen: false,
          colors: {},
          font: "Manrope",
          size: 18,
          zoom: 100,
          viewState: {
            top: 4200,
            anchor: { offset: secondStart, mode, zoom: 100, readingTop: 4200 },
          },
          seededFind: {
            query: "AuroraPin",
            caseSensitive: true,
            sourceStart: thirdStart,
            sourceEnd: thirdStart + "AuroraPin".length,
            matchText: "AuroraPin",
          },
        }),
      { content, mode, secondStart, thirdStart }
    );

    await expect(page.locator(".reading-search output")).toHaveText("3 / 3");
    const section35 = page.locator('[data-windowed-mounted="true"]').filter({ hasText: "Deep offscreen AuroraPin occurrence three." });
    await expect(section35).toBeVisible();
    await expect(section35).toBeInViewport();
    expect(await page.evaluate(() => CSS.highlights.has("smd-search-current"))).toBe(true);

    // 2. Unicode casefold + astral emoji UTF-16 offscreen occurrence ("strasse" -> "straße" after 💡) -> mounted & in viewport.
    await page.evaluate(
      ({ unicodeStart }) =>
        window.supermdFind?.("strasse", {
          caseSensitive: false,
          sourceStart: unicodeStart,
          sourceEnd: unicodeStart + "straße".length,
          matchText: "straße",
        }),
      { unicodeStart }
    );
    const section42 = page.locator('[data-windowed-mounted="true"]').filter({ hasText: "💡 Unicode Hauptstraße offscreen target." });
    await expect(section42).toBeVisible();
    await expect(section42).toBeInViewport();
    expect(await page.evaluate(() => CSS.highlights.has("smd-search-current"))).toBe(true);

    // 3. Offscreen hidden Markdown URL hit -> mounts & scrolls enclosing block into viewport with "In Markdown source".
    await page.evaluate(
      ({ hiddenStart }) =>
        window.supermdFind?.("AuroraHiddenUrl", {
          caseSensitive: true,
          sourceStart: hiddenStart,
          sourceEnd: hiddenStart + "AuroraHiddenUrl".length,
          matchText: "AuroraHiddenUrl",
        }),
      { hiddenStart }
    );
    await expect(page.locator(".reading-search output")).toHaveText("In Markdown source");
    const section46 = page.locator('[data-windowed-mounted="true"]').filter({ hasText: "Hidden portal link target." });
    await expect(section46).toBeVisible();
    await expect(section46).toBeInViewport();
    expect(await page.evaluate(() => CSS.highlights.has("smd-search-current"))).toBe(false);

    // 4. #72 pendingHeading link destination followed by same-note supermdLoad seededFind -> neither pendingHeading nor anchored() overrides seeded occurrence.
    await page.evaluate(() => window.supermdDismiss?.());
    await page.evaluate(
      ({ content, mode }) =>
        window.supermdLoad?.({
          id: `seeded-${mode}`,
          content,
          path: null,
          mode,
          dark: false,
          fullscreen: false,
          colors: {},
          font: "Manrope",
          size: 18,
          zoom: 100,
          pendingHeading: { heading: "Section 18", token: `heading-${mode}-1` },
        }),
      { content, mode }
    );
    await page.evaluate(
      ({ content, mode, thirdStart }) =>
        window.supermdLoad?.({
          id: `seeded-${mode}`,
          content,
          path: null,
          mode,
          dark: false,
          fullscreen: false,
          colors: {},
          font: "Manrope",
          size: 18,
          zoom: 100,
          seededFind: {
            query: "AuroraPin",
            caseSensitive: true,
            sourceStart: thirdStart,
            sourceEnd: thirdStart + "AuroraPin".length,
            matchText: "AuroraPin",
          },
        }),
      { content, mode, thirdStart }
    );
    await expect(page.locator(".reading-search output")).toHaveText("3 / 3");
    await expect(section35).toBeInViewport();

    // 5. Stale result after an edit + cross-note anchor restoration:
    //    - Scroll Note A to Section 18, switch to Note B via valid seeded occurrence (3 / 3), then switch back to Note A -> Section 18 anchor restored!
    //    - Edit Note B's 3rd occurrence out, then switch from Note A to Note B with the stale 3rd-occurrence seed ->
    //      Note B restores its cross-note anchor at Section 35 and shows passive "0 / 2" WITHOUT jumping to Occurrence #1!
    const otherNoteContent =
      `# Secondary Note\n\nIntro AuroraPin in note A.\n\n` +
      Array.from({ length: 36 }, (_, i) =>
        i === 18 ? `## Other Section 18\n\nAnchored paragraph in note A.\n\n${filler}` : `## Other Section ${i}\n\n${filler}`,
      ).join("");
    await page.evaluate(() => window.supermdDismiss?.());
    await page.evaluate(
      ({ otherNoteContent, mode }) =>
        window.supermdLoad?.({
          id: `other-note-${mode}`,
          content: otherNoteContent,
          path: null,
          mode,
          dark: false,
          fullscreen: false,
          colors: {},
          font: "Manrope",
          size: 18,
          zoom: 100,
        }),
      { otherNoteContent, mode },
    );
    const otherSection18Offset = otherNoteContent.indexOf("## Other Section 18");
    await page.evaluate(
      ({ otherNoteContent, mode, otherSection18Offset }) =>
        window.supermdLoad?.({
          id: `other-note-${mode}`,
          content: otherNoteContent,
          path: null,
          mode,
          dark: false,
          fullscreen: false,
          colors: {},
          font: "Manrope",
          size: 18,
          zoom: 100,
          pendingHeading: { heading: "Other Section 18", token: `other-heading-${mode}` },
          viewState: { top: 0, anchor: { offset: otherSection18Offset, mode, zoom: 100 } },
        }),
      { otherNoteContent, mode, otherSection18Offset },
    );
    const otherSection18 = page.locator("p", { hasText: "Anchored paragraph in note A." });
    await expect(otherSection18).toBeInViewport();
    await page.evaluate(() => {
      document.querySelector<HTMLElement>(".android-reading")?.dispatchEvent(new Event("scroll", { bubbles: true }));
    });

    // Jump from Note A -> Note B's 3rd occurrence (valid cross-note seededFind).
    await page.evaluate(
      ({ content, mode, thirdStart }) =>
        window.supermdLoad?.({
          id: `seeded-${mode}`,
          content,
          path: null,
          mode,
          dark: false,
          fullscreen: false,
          colors: {},
          font: "Manrope",
          size: 18,
          zoom: 100,
          seededFind: {
            query: "AuroraPin",
            caseSensitive: true,
            sourceStart: thirdStart,
            sourceEnd: thirdStart + "AuroraPin".length,
            matchText: "AuroraPin",
          },
        }),
      { content, mode, thirdStart },
    );
    await expect(page.locator(".reading-search output")).toHaveText("3 / 3");
    await expect(section35).toBeInViewport();

    // Switch back from Note B -> Note A while .reading-search remains open: Note A's cross-note anchor at Other Section 18 is preserved!
    await page.evaluate(
      ({ otherNoteContent, mode }) =>
        window.supermdLoad?.({
          id: `other-note-${mode}`,
          content: otherNoteContent,
          path: null,
          mode,
          dark: false,
          fullscreen: false,
          colors: {},
          font: "Manrope",
          size: 18,
          zoom: 100,
        }),
      { otherNoteContent, mode },
    );
    await expect(otherSection18).toBeInViewport();

    // Edit Note B so the 3rd occurrence is removed, then open the stale 3rd-occurrence result on Note B:
    // Note B restores its cross-note anchor at Section 35 and shows "0 / 2" WITHOUT jumping to Occurrence #1 at the top!
    const editedContent = content.slice(0, thirdStart) + "EditedOut" + content.slice(thirdStart + "AuroraPin".length);
    await page.evaluate(
      ({ editedContent, mode, thirdStart }) =>
        window.supermdLoad?.({
          id: `seeded-${mode}`,
          content: editedContent,
          path: null,
          mode,
          dark: false,
          fullscreen: false,
          colors: {},
          font: "Manrope",
          size: 18,
          zoom: 100,
          seededFind: {
            query: "AuroraPin",
            caseSensitive: true,
            sourceStart: thirdStart,
            sourceEnd: thirdStart + "AuroraPin".length,
            matchText: "AuroraPin",
          },
        }),
      { editedContent, mode, thirdStart },
    );
    await expect(page.locator(".reading-search output")).toHaveText("0 / 2");
    expect(await page.evaluate(() => CSS.highlights.has("smd-search-current"))).toBe(false);
    const editedSection35 = page.locator('[data-windowed-mounted="true"]').filter({ hasText: "Deep offscreen EditedOut occurrence three." });
    await expect(editedSection35).toBeVisible();
    await expect(editedSection35).toBeInViewport();
    const introMatch = page.locator("p").filter({ hasText: "Intro AuroraPin occurrence one." });
    await expect(introMatch).not.toBeInViewport();

    // Same-note stale supermdFind after an insertion before old offsets also stays at Section 35 without jumping to Occurrence #1 or #2.
    const shiftedContent = "Prepended edit line.\n\n" + editedContent;
    await page.evaluate(
      ({ shiftedContent, mode, secondStart }) => {
        window.supermdLoad?.({
          id: `seeded-${mode}`,
          content: shiftedContent,
          path: null,
          mode,
          dark: false,
          fullscreen: false,
          colors: {},
          font: "Manrope",
          size: 18,
          zoom: 100,
        });
        window.supermdFind?.("AuroraPin", {
          caseSensitive: true,
          sourceStart: secondStart,
          sourceEnd: secondStart + "AuroraPin".length,
          matchText: "AuroraPin",
        });
      },
      { shiftedContent, mode, secondStart },
    );
    await expect(page.locator(".reading-search output")).toHaveText("0 / 2");
    expect(await page.evaluate(() => CSS.highlights.has("smd-search-current"))).toBe(false);
    await expect(editedSection35).toBeInViewport();
    await expect(introMatch).not.toBeInViewport();
  }
});

test("Replacement input disables spelling/autocorrections, ignores Enter during inactive/invalid/IME states, and advances the real viewport on Enter", async ({ page }) => {
  const filler = "Windowed study prose paragraph with equations $x_n + y_n$ for offscreen scrolling.\n\n".repeat(36);
  let content =
    `# Replace Enter Spec\n\nIntro ReplaceTarget-01 at top.\n\n` +
    Array.from({ length: 48 }, (_, i) => {
      if (i === 22) return `## Section ${i}\n\nMidway ReplaceTarget-22 offscreen match.\n\n${filler}`;
      if (i === 42) return `## Section ${i}\n\n> [!NOTE]- Folded tail callout\n> Deep ReplaceTarget-42 tail match.\n\n${filler}`;
      return `## Section ${i}\n\n${filler}`;
    }).join("");
  expect(content.length).toBeGreaterThan(85_000);

  await page.exposeFunction("onReplaceEnterChange", (_id: string, command: string, raw: string) => {
    if (command === "document_changed") content = JSON.parse(raw).content;
  });
  await page.addInitScript(() => {
    window.SuperMD = { post: (id, command, raw) => (window as any).onReplaceEnterChange(id, command, raw) };
  });
  await page.goto("/android-reader.html");
  await page.waitForFunction(() => typeof window.supermdLoad === "function");

  await page.evaluate(
    (text) =>
      window.supermdLoad?.({
        id: "replace-enter-live",
        content: text,
        path: null,
        mode: "live",
        dark: false,
        fullscreen: false,
        colors: {},
        font: "Manrope",
        size: 18,
        zoom: 100,
        spellCheck: true,
        grammarCheck: true,
      }),
    content
  );
  await expect(page.locator('[data-windowed-mounted="false"]')).not.toHaveCount(0);

  await page.evaluate(() => window.supermdFind?.(true));
  const searchbox = page.getByRole("searchbox", { name: "Find in note" });
  const replaceInput = page.getByRole("textbox", { name: "Replacement text" });
  await expect(replaceInput).toBeVisible();

  // 1. Replacement input disables spelling and automatic corrections for literal Markdown text.
  await expect(replaceInput).toHaveAttribute("type", "text");
  await expect(replaceInput).toHaveAttribute("spellcheck", "false");
  await expect(replaceInput).toHaveAttribute("autocorrect", "off");
  await expect(replaceInput).toHaveAttribute("autocapitalize", "none");
  await expect(replaceInput).toHaveAttribute("autocomplete", "off");
  expect(await replaceInput.evaluate((el: HTMLInputElement) => el.spellcheck)).toBe(false);

  // Type literal Markdown syntax via real keyboard input.
  await replaceInput.click();
  await page.keyboard.type("`replaced_md`");
  await expect(replaceInput).toHaveValue("`replaced_md`");

  // 2. Inactive at empty query and at passive 0 / 3: Enter in replacement input does not mutate or scroll.
  await page.keyboard.press("Enter");
  expect(content).toContain("ReplaceTarget-01");

  await searchbox.fill("ReplaceTarget-\\d+");
  await page.getByRole("button", { name: "Regular expression" }).click();
  await expect(page.locator(".reading-search output")).toHaveText("0 / 3");
  await replaceInput.focus();
  await page.keyboard.press("Enter");
  expect(content).toContain("ReplaceTarget-01");
  expect(await page.evaluate(() => document.querySelector<HTMLElement>(".android-reading")!.scrollTop)).toBe(0);

  // 3. Invalid regular expression: Enter in replacement input does not mutate or scroll.
  await searchbox.fill("([unclosed");
  await expect(page.locator(".reading-search output")).toHaveText("Invalid regular expression");
  await replaceInput.focus();
  await page.keyboard.press("Enter");
  expect(content).toContain("ReplaceTarget-01");

  // Restore valid regex and step to 1 / 3 at top of note.
  await searchbox.fill("ReplaceTarget-(\\d+)");
  await expect(page.locator(".reading-search output")).toHaveText("0 / 3");
  await replaceInput.fill("`item_$1`");
  await page.getByRole("button", { name: "Next match" }).click();
  await expect(page.locator(".reading-search output")).toHaveText("1 / 3");

  const section22 = page.locator('[data-windowed-mounted="true"]').filter({ hasText: "Midway ReplaceTarget-22 offscreen match." });
  await expect(section22).toHaveCount(0);

  // 4. In-progress IME composition in the real replacement input ignores Enter until composition ends.
  const cdp = await page.context().newCDPSession(page);
  await replaceInput.focus();
  await replaceInput.selectText();
  await cdp.send("Input.imeSetComposition", {
    text: "`item_$1`",
    selectionStart: 9,
    selectionEnd: 9,
  });
  const composingHandled = await replaceInput.evaluate((el) => {
    const ev = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, isComposing: true });
    el.dispatchEvent(ev);
    return ev.defaultPrevented;
  });
  expect(composingHandled).toBe(false);
  expect(content).toContain("ReplaceTarget-01");
  await expect(page.locator(".reading-search output")).toHaveText("1 / 3");
  await cdp.send("Input.insertText", { text: "`item_$1`" });
  await expect(replaceInput).toHaveValue("`item_$1`");

  // 5. Real Enter on valid selected match 1 / 3 replaces match 1, keeps focus in replacement input, and settles offscreen Section 22 in viewport!
  await page.keyboard.press("Enter");
  await expect.poll(() => content).toContain("Intro `item_01` at top.");
  await expect(page.locator(".reading-search output")).toHaveText("1 / 2");
  await expect(replaceInput).toBeFocused();
  await expect(section22).toBeVisible();
  await expect(section22).toBeInViewport();

  // 6. Second consecutive Enter (without refocusing) replaces Section 22 and advances viewport + opens folded callout at Section 42!
  await page.keyboard.press("Enter");
  await expect.poll(() => content).toContain("Midway `item_22` offscreen match.");
  await expect(page.locator(".reading-search output")).toHaveText("1 / 1");
  await expect(replaceInput).toBeFocused();
  const section42Callout = page.locator("details.callout").filter({ hasText: "Deep ReplaceTarget-42 tail match." });
  await expect(section42Callout).toHaveAttribute("open", "");
  await expect(section42Callout).toBeInViewport();

  // 7. Source mode: Enter in replacement input replaces line 1 match and scrolls CodeMirror viewport to distant offscreen match.
  await page.keyboard.press("Escape");
  await expect(page.locator(".reading-search")).toHaveCount(0);
  const sourceNote = [
    "SourceToken-top on line 1.",
    ...Array.from({ length: 140 }, (_, idx) => `Line ${idx + 2} filler prose in Markdown source editor.`),
    "SourceToken-bottom at line 142.",
  ].join("\n");
  await page.evaluate(
    (text) => {
      window.supermdLoad?.({
        id: "replace-enter-source",
        content: text,
        path: null,
        mode: "editor",
        dark: false,
        fullscreen: false,
        colors: {},
        font: "Manrope",
        size: 18,
        zoom: 100,
        spellCheck: true,
      });
      window.supermdFind?.(true);
    },
    sourceNote
  );
  await searchbox.fill("SourceToken-\\w+");
  await page.getByRole("button", { name: "Regular expression" }).click();
  await expect(page.locator(".reading-search output")).toHaveText("0 / 2");
  await page.getByRole("button", { name: "Next match" }).click();
  await expect(page.locator(".reading-search output")).toHaveText("1 / 2");
  expect(await page.evaluate(() => document.querySelector<HTMLElement>(".cm-scroller")!.scrollTop)).toBeLessThan(80);

  await replaceInput.fill("`replaced_source`");
  await replaceInput.focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => content).toContain("`replaced_source` on line 1.");
  await expect(page.locator(".reading-search output")).toHaveText("1 / 1");
  await expect(replaceInput).toBeFocused();
  await expect
    .poll(() => page.evaluate(() => document.querySelector<HTMLElement>(".cm-scroller")!.scrollTop))
    .toBeGreaterThan(500);
  await expect(page.locator(".cm-content")).toContainText("SourceToken-bottom at line 142.");
});

test("Precise selected matches remain visible below the floating in-note search bar across top lines, tall blocks, Replace drawer, and Source/Split modes", async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 540 });
  const tallCodeLines = Array.from({ length: 95 }, (_, idx) => {
    if (idx === 1) return `const earlyMatch = "OrbitBeacon";`;
    if (idx === 92) return `const lateMatch = "OrbitBeacon";`;
    return `const fillerLine${idx} = ${idx * 10};`;
  }).join("\n");
  const note = [
    "# OrbitBeacon Top Heading · Hauptstraße",
    "",
    "Lead paragraph right beneath the top heading.",
    "",
    "```ts\n" + tallCodeLines + "\n```",
    "",
    ...Array.from({ length: 16 }, (_, idx) => `Trailing section ${idx + 1} keeping plenty of scroll range below the tall code block.`),
  ].join("\n\n");

  await page.addInitScript(() => {
    window.SuperMD = { post: () => {} };
  });
  await page.goto("/android-reader.html");
  await page.waitForFunction(() => typeof window.supermdLoad === "function");
  await page.evaluate(
    (content) =>
      window.supermdLoad?.({
        id: "search-visibility-e2e",
        content,
        path: null,
        mode: "live",
        dark: false,
        fullscreen: false,
        colors: {},
        font: "Manrope",
        size: 18,
        zoom: 100,
      }),
    note,
  );
  await page.evaluate(() => window.supermdFind?.("OrbitBeacon", { caseSensitive: true }));

  const assertCurrentRangeUnobstructed = async (expectedText = "OrbitBeacon") => {
    const metrics = await page.evaluate(() => {
      const bar = document.querySelector<HTMLElement>(".reading-search")!.getBoundingClientRect();
      const scroller = document.querySelector<HTMLElement>(".android-reading")!.getBoundingClientRect();
      const highlight = (CSS as any).highlights?.get("smd-search-current");
      const ranges: Range[] = highlight ? Array.from(highlight) : [];
      const rect = ranges[0]?.getBoundingClientRect();
      return rect
        ? {
            barBottom: bar.bottom,
            scrollerBottom: scroller.bottom,
            matchTop: rect.top,
            matchBottom: rect.bottom,
            text: ranges[0].toString(),
          }
        : null;
    });
    expect(metrics).not.toBeNull();
    expect(metrics!.text).toBe(expectedText);
    expect(metrics!.matchTop).toBeGreaterThanOrEqual(metrics!.barBottom + 4);
    expect(metrics!.matchBottom).toBeLessThanOrEqual(metrics!.scrollerBottom - 4);
  };

  // Match 1 / 3: Heading on line 1 stays cleanly below .reading-search, including after opening Replace.
  await expect(page.locator(".reading-search output")).toHaveText("1 / 3");
  await assertCurrentRangeUnobstructed();

  await page.getByRole("button", { name: "Replace in source" }).click();
  await expect(page.locator(".search-replace")).toBeVisible();
  await assertCurrentRangeUnobstructed();

  // Match 2 / 3 (top of 95-line code block) and Match 3 / 3 (bottom of 95-line code block) both scroll precise Range into unobstructed band.
  await page.getByRole("button", { name: "Next match" }).click();
  await expect(page.locator(".reading-search output")).toHaveText("2 / 3");
  await assertCurrentRangeUnobstructed();

  await page.getByRole("button", { name: "Next match" }).click();
  await expect(page.locator(".reading-search output")).toHaveText("3 / 3");
  await assertCurrentRangeUnobstructed();

  // Seeded #96 occurrence handoff into top-line Unicode-folded "straße" also stays unobstructed below .reading-search.
  await page.getByRole("button", { name: "Replace in source" }).click();
  const topUnicodeStart = note.indexOf("straße");
  await page.evaluate(
    (sourceStart) =>
      window.supermdFind?.("strasse", {
        caseSensitive: false,
        sourceStart,
        sourceEnd: sourceStart + "straße".length,
        matchText: "straße",
      }),
    topUnicodeStart,
  );
  await expect.poll(async () => page.evaluate(() => CSS.highlights.has("smd-search-current"))).toBe(true);
  await assertCurrentRangeUnobstructed("straße");

  // Split mode: both CodeMirror (.cm-scroller) and rendered preview (.android-reading) keep line 1 match below .reading-search.
  await page.evaluate(
    (content) =>
      window.supermdLoad?.({
        id: "search-visibility-e2e",
        content,
        path: null,
        mode: "split",
        dark: false,
        fullscreen: false,
        colors: {},
        font: "Manrope",
        size: 18,
        zoom: 100,
      }),
    note,
  );
  await page.evaluate(() => window.supermdFind?.("OrbitBeacon", { caseSensitive: true }));
  await expect(page.locator(".reading-search output")).toHaveText("1 / 3");
  const splitMetrics = await page.evaluate(() => {
    const bar = document.querySelector<HTMLElement>(".reading-search")!.getBoundingClientRect();
    const cmSel = document.querySelector<HTMLElement>(".cm-selectionBackground,.cm-activeLine")!.getBoundingClientRect();
    const cmScroller = document.querySelector<HTMLElement>(".cm-scroller")!.getBoundingClientRect();
    return { barBottom: bar.bottom, cmTop: cmSel.top, cmBottom: cmSel.bottom, scrollerBottom: cmScroller.bottom };
  });
  expect(splitMetrics.cmTop).toBeGreaterThanOrEqual(splitMetrics.barBottom + 4);
  expect(splitMetrics.cmBottom).toBeLessThanOrEqual(splitMetrics.scrollerBottom - 4);
});
