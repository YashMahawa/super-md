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

test("reconciles native textarea undo with document history, redoes after leaving a Live block, and crosses block boundaries", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  const initial = ["First block.", "", "Second block.", "", "Third block."].join("\n");
  await loadLiveNote(page, initial, "live");
  // Exercise standard hardware-keyboard routing as well as window.supermdHistory.
  await page.evaluate(() => {
    document.documentElement.dataset.host = "android";
  });

  // 1. Edit First block, undo the grouped typing run inside First block, leave First block,
  // and redo from document history after leaving that block!
  await page.locator(".live-block").nth(0).dblclick();
  const area = page.getByRole("textbox", { name: "Edit Markdown block" });
  await expect(area).toBeFocused();
  await area.press("End");
  await area.pressSequentially(" Edited once");
  await expect(area).toHaveValue("First block. Edited once");

  // Undo inside the active Live block via Ctrl+Z (natural grouped native undo, not per-character!).
  await area.press("Control+z");
  await expect(area).toHaveValue("First block.");

  // Leave that Live block with Escape, then redo from document history!
  await area.press("Escape");
  await expect(page.locator("textarea")).toHaveCount(0);
  await expect(page.locator(".live-block").nth(0).locator("p")).toHaveText("First block.");

  await page.keyboard.press("Control+y");
  await expect(page.locator("textarea")).toHaveCount(0);
  await expect(page.locator(".live-block").nth(0).locator("p")).toHaveText("First block. Edited once");

  // 2. Open Second block, edit it, move ArrowDown into Third block, create two native textarea
  // undo steps (by moving the caret between edits), then undo & redo across block boundaries!
  await page.locator(".live-block").nth(1).dblclick();
  const secondArea = page.getByRole("textbox", { name: "Edit Markdown block" });
  await expect(secondArea).toHaveValue("Second block.");
  await secondArea.press("End");
  await secondArea.pressSequentially("!");
  await expect(secondArea).toHaveValue("Second block.!");

  await secondArea.press("ArrowDown");
  const thirdArea = page.getByRole("textbox", { name: "Edit Markdown block" });
  await expect(thirdArea).toBeFocused();
  await expect(thirdArea).toHaveValue("Third block.");
  await thirdArea.press("End");
  await thirdArea.pressSequentially("1");
  await thirdArea.press("ArrowLeft");
  await thirdArea.press("End");
  await thirdArea.pressSequentially("2");
  await expect(thirdArea).toHaveValue("Third block.12");

  // Undo inside Third block (caret move split Blink's TypingCommand into two native steps while
  // NoteHistory coalesces rapid edits, reconciling each native step cleanly).
  await thirdArea.press("Control+z");
  await expect(page.getByRole("textbox", { name: "Edit Markdown block" })).toHaveValue("Third block.1");
  await thirdArea.press("Control+z");
  await expect(page.getByRole("textbox", { name: "Edit Markdown block" })).toHaveValue("Third block.");

  // Next Undo crosses block boundary from Third block into Second block!
  await page.keyboard.press("Control+z");
  await expect(page.getByRole("textbox", { name: "Edit Markdown block" })).toHaveValue("Second block.");
  await expect
    .poll(() => page.evaluate(() => (window as any).latestContent as string))
    .toBe("First block. Edited once\n\nSecond block.\n\nThird block.");

  // Next Undo crosses block boundary from Second block into First block!
  await page.keyboard.press("Control+z");
  await expect(page.getByRole("textbox", { name: "Edit Markdown block" })).toHaveValue("First block.");
  await expect
    .poll(() => page.evaluate(() => (window as any).latestContent as string))
    .toBe(initial);

  // Redo steps forward cleanly across First -> Second -> Third blocks!
  await page.keyboard.press("Control+y");
  await expect(page.getByRole("textbox", { name: "Edit Markdown block" })).toHaveValue("First block. Edited once");
  await page.keyboard.press("Control+Shift+Z");
  await expect(page.getByRole("textbox", { name: "Edit Markdown block" })).toHaveValue("Second block.!");
  await page.keyboard.press("Control+y");
  await expect(page.getByRole("textbox", { name: "Edit Markdown block" })).toHaveValue("Third block.1");
  await page.keyboard.press("Control+y");
  await expect(page.getByRole("textbox", { name: "Edit Markdown block" })).toHaveValue("Third block.12");
  await expect
    .poll(() => page.evaluate(() => (window as any).latestContent as string))
    .toBe("First block. Edited once\n\nSecond block.!\n\nThird block.12");
});

test("keeps #64 workspace link navigation and Live/document undo-redo semantics working together across Live and Source modes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.addInitScript(() => {
    (window as any).workspaceLinkCalls = [];
    (window as any).latestContentById = {};
    window.SuperMD = {
      post: (id, command, raw) => {
        const args = raw ? JSON.parse(raw) : {};
        if (command === "document_changed") {
          (window as any).latestContentById[args.id] = args.content;
        }
        if (command === "open_workspace_link") {
          (window as any).workspaceLinkCalls.push(args);
          queueMicrotask(() => window.supermdReply?.(id, { opened: true }, null));
          return;
        }
        if (command === "document_sync" || command === "document_patch") {
          queueMicrotask(() => window.supermdReply?.(id, { accepted: true, revision: args.revision ?? 0 }, null));
          return;
        }
        queueMicrotask(() => window.supermdReply?.(id, true, null));
      },
    };
  });

  await page.goto("/android-reader.html");
  await page.waitForFunction(() => typeof window.supermdLoad === "function");

  const initialFlow = [
    "Intro paragraph.",
    "",
    "See [[Roadmap#Milestones|Project Milestones]] for details.",
  ].join("\n");

  await page.evaluate((content) => {
    document.documentElement.dataset.host = "android";
    window.supermdLoad?.({
      id: "tab-flow",
      content,
      path: "/vault/Notes/Flow.md",
      mode: "live",
      dark: false,
      fullscreen: false,
      colors: {},
      font: "Manrope",
      size: 16,
      zoom: 100,
    });
  }, initialFlow);

  // Edit first block in Live mode, undo inside the active textarea, leave block, and click #64 wikilink.
  await page.locator(".live-block").nth(0).dblclick();
  const area = page.getByRole("textbox", { name: "Edit Markdown block" });
  await expect(area).toBeFocused();
  await area.press("End");
  await area.pressSequentially(" Drafted");
  await expect(area).toHaveValue("Intro paragraph. Drafted");

  await area.press("Control+z");
  await expect(area).toHaveValue("Intro paragraph.");
  await area.press("Escape");
  await expect(page.locator("textarea")).toHaveCount(0);

  await page.getByRole("link", { name: "Project Milestones" }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).workspaceLinkCalls.length))
    .toBe(1);
  expect(await page.evaluate(() => (window as any).workspaceLinkCalls[0])).toEqual({
    documentPath: "/vault/Notes/Flow.md",
    target: "Roadmap",
    fragment: "Milestones",
    wikilink: true,
  });

  // Simulate host opening target tab and then switching back to tab-flow: redo from preserved NoteHistory still works!
  await page.evaluate(() => {
    window.supermdLoad?.({
      id: "tab-roadmap",
      content: "# Roadmap\n\n## Milestones\n\nShip cleanly.",
      path: "/vault/Roadmap.md",
      mode: "live",
      dark: false,
      fullscreen: false,
      colors: {},
      font: "Manrope",
      size: 16,
      zoom: 100,
      pendingHeading: { heading: "Milestones", token: "jump-1" },
    });
  });
  await expect(page.getByRole("heading", { name: "Milestones" })).toBeVisible();

  await page.evaluate((content) => {
    window.supermdLoad?.({
      id: "tab-flow",
      content,
      path: "/vault/Notes/Flow.md",
      mode: "live",
      dark: false,
      fullscreen: false,
      colors: {},
      font: "Manrope",
      size: 16,
      zoom: 100,
    });
  }, initialFlow);

  await page.keyboard.press("Control+y");
  await expect(page.locator(".live-block").nth(0).locator("p")).toHaveText("Intro paragraph. Drafted");
  await page.keyboard.press("Control+z");
  await expect(page.locator(".live-block").nth(0).locator("p")).toHaveText("Intro paragraph.");

  // Switch tab-flow to Source mode and verify #64 SourceEditor documentPath forwarding on Ctrl+Click!
  await page.evaluate((content) => {
    window.supermdLoad?.({
      id: "tab-flow",
      content,
      path: "/vault/Notes/Flow.md",
      mode: "editor",
      dark: false,
      fullscreen: false,
      colors: {},
      font: "Manrope",
      size: 16,
      zoom: 100,
    });
  }, initialFlow);

  const linkLine = page.locator(".cm-line", { hasText: "[[Roadmap#Milestones|Project Milestones]]" });
  await expect(linkLine).toBeVisible();
  const point = await linkLine.evaluate((el) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let current: Node | null;
    while ((current = walker.nextNode())) {
      const text = current as Text;
      const idx = text.data.indexOf("Roadmap");
      if (idx >= 0) {
        const range = document.createRange();
        range.setStart(text, idx + 2);
        range.setEnd(text, idx + 3);
        const rect = range.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      }
    }
    throw new Error("Target text node not found");
  });
  await page.mouse.move(point.x, point.y);
  await page.keyboard.down("Control");
  await page.mouse.down();
  await page.mouse.up();
  await page.keyboard.up("Control");

  await expect
    .poll(() => page.evaluate(() => (window as any).workspaceLinkCalls.length))
    .toBe(2);
  expect(await page.evaluate(() => (window as any).workspaceLinkCalls[1])).toEqual({
    documentPath: "/vault/Notes/Flow.md",
    target: "Roadmap",
    fragment: "Milestones",
    wikilink: true,
  });
});

test("preserves clicked rendered text caret on double-click below inline emphasis and links while keeping keyboard entry and protected blocks intact", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  const proseBlock = [
    "Review *emphasized context*, `npm test`, $x^2 + 1$, %%draft note%% and [the architecture guide](https://example.com/architecture/overview?tab=live) above,",
    "then refine **bold intro** before editing the milestone phrase on this lower line.",
  ].join("\n");
  const calloutBlock = [
    "> [!tip] Quick *check*",
    "> Callout body target.",
  ].join("\n");
  const codeBlock = [
    "```ts",
    "- keep literal newline in code",
    "```",
  ].join("\n");
  const note = ["# Release Notes", "", proseBlock, "", calloutBlock, "", codeBlock].join("\n");

  await loadLiveNote(page, note, "live");

  const getCharPoint = async (blockIndex: number, needle: string, charIndex = 0) =>
    page.locator(".live-block").nth(blockIndex).evaluate(
      (blockEl, { needle, charIndex }) => {
        const walker = document.createTreeWalker(blockEl, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if ((node as Text).parentElement?.closest(".katex-mathml")) continue;
          const textNode = node as Text;
          const start = textNode.data.indexOf(needle);
          if (start < 0) continue;
          const pos = start + charIndex;
          const charRange = document.createRange();
          charRange.setStart(textNode, pos);
          charRange.setEnd(textNode, Math.min(textNode.data.length, pos + 1));
          const rect = charRange.getBoundingClientRect();
          return { x: rect.left + Math.min(1.5, rect.width * 0.2), y: rect.top + rect.height / 2 };
        }
        throw new Error(`Could not locate "${needle}" in block ${blockIndex}`);
      },
      { needle, charIndex },
    );

  // 1. Double-click right at the start of "milestone" on line 2 (below heading, inline *emphasis*, `code`, $math$, %%comment%%, [link](...), newline, and **bold intro**).
  const milestonePoint = await getCharPoint(1, "milestone", 0);
  await page.mouse.dblclick(milestonePoint.x, milestonePoint.y);

  const area = page.getByRole("textbox", { name: "Edit Markdown block" });
  await expect(area).toBeFocused();
  await expect(area).toHaveValue(proseBlock);

  const expectedMilestoneOffset = proseBlock.indexOf("milestone");
  const selection = await area.evaluate((el: HTMLTextAreaElement) => ({
    start: el.selectionStart,
    end: el.selectionEnd,
  }));
  expect(selection).toEqual({ start: expectedMilestoneOffset, end: expectedMilestoneOffset });

  // Type immediately without repositioning cursor: text inserts cleanly at the clicked rendered word!
  await page.keyboard.type("verified ");
  const updatedProseBlock = proseBlock.replace("milestone phrase", "verified milestone phrase");
  await expect(area).toHaveValue(updatedProseBlock);
  await page.screenshot({ path: "/tmp/live-double-click-caret.png" });

  // 2. Close with Escape -> .live-block retains focus, and Enter / F2 keyboard edit entry remain intact.
  await page.keyboard.press("Escape");
  await expect(page.locator("textarea")).toHaveCount(0);
  const proseLocator = page.locator(".live-block").nth(1);
  await expect(proseLocator).toBeFocused();

  await page.keyboard.press("Enter");
  await expect(area).toBeFocused();
  await expect(area).toHaveValue(updatedProseBlock);
  expect(
    await area.evaluate((el: HTMLTextAreaElement) => el.selectionStart === el.selectionEnd),
  ).toBe(true);

  await page.keyboard.press("Escape");
  await expect(proseLocator).toBeFocused();
  await page.keyboard.press("F2");
  await expect(area).toBeFocused();
  await expect(area).toHaveValue(updatedProseBlock);
  await page.keyboard.press("Escape");

  // 3. Double-clicking inside rendered inline emphasis and inline code places collapsed carets at exact source offsets.
  const emphasisPoint = await getCharPoint(1, "context", 0);
  await page.mouse.dblclick(emphasisPoint.x, emphasisPoint.y);
  await expect(area).toBeFocused();
  const expectedContextOffset = updatedProseBlock.indexOf("context");
  expect(
    await area.evaluate((el: HTMLTextAreaElement) => ({ start: el.selectionStart, end: el.selectionEnd })),
  ).toEqual({ start: expectedContextOffset, end: expectedContextOffset });
  await page.keyboard.press("Escape");

  const codeSpanPoint = await getCharPoint(1, "test", 0);
  await page.mouse.dblclick(codeSpanPoint.x, codeSpanPoint.y);
  await expect(area).toBeFocused();
  const expectedCodeOffset = updatedProseBlock.indexOf("test");
  expect(
    await area.evaluate((el: HTMLTextAreaElement) => ({ start: el.selectionStart, end: el.selectionEnd })),
  ).toEqual({ start: expectedCodeOffset, end: expectedCodeOffset });
  await page.keyboard.press("Escape");

  // 4. Double-clicking inside a rendered callout body maps past `[!tip] Quick *check*` to the exact body offset.
  const calloutTargetPoint = await getCharPoint(2, "target", 0);
  await page.mouse.dblclick(calloutTargetPoint.x, calloutTargetPoint.y);
  await expect(area).toBeFocused();
  await expect(area).toHaveValue(calloutBlock);
  const expectedCalloutOffset = calloutBlock.indexOf("target");
  expect(
    await area.evaluate((el: HTMLTextAreaElement) => ({ start: el.selectionStart, end: el.selectionEnd })),
  ).toEqual({ start: expectedCalloutOffset, end: expectedCalloutOffset });
  await page.keyboard.press("Escape");

  // 5. Protected fenced code block double-click preserves protectedBlock behavior (literal Enter, no list marker continuation).
  await page.locator(".live-block").nth(3).dblclick();
  const codeArea = page.getByRole("textbox", { name: "Edit Markdown block" });
  await expect(codeArea).toBeFocused();
  await expect(codeArea).toHaveValue(codeBlock);
  await codeArea.evaluate((el: HTMLTextAreaElement) => {
    const endOfCodeLine = el.value.indexOf("in code") + "in code".length;
    el.setSelectionRange(endOfCodeLine, endOfCodeLine);
  });
  await codeArea.press("Enter");
  await expect(codeArea).toHaveValue("```ts\n- keep literal newline in code\n\n```");
});

