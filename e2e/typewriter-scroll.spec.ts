import { expect, test } from "@playwright/test";

test("typewriter scroll centers active line during typing, respects custom line heights, and allows manual wheel scrolling", async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).nativeEvents = [];
    window.SuperMD = {
      post: (id: string, command: string, args: string) => {
        (window as any).nativeEvents.push({ command, args: JSON.parse(args) });
        queueMicrotask(() => window.supermdReply?.(id, true, null));
      },
    };
  });
  await page.setViewportSize({ width: 1100, height: 680 });
  await page.goto("/android-reader.html");
  await page.waitForFunction(() => typeof window.supermdLoad === "function");

  const lines = Array.from({ length: 90 }, (_, i) => `Line ${i + 1}: Focused study writing in Markdown paragraph ${i + 1}.`).join("\n");
  const baseState = {
    id: "tw-e2e",
    content: lines,
    path: null,
    mode: "editor" as const,
    dark: false,
    fullscreen: false,
    colors: {},
    font: "Manrope",
    size: 18,
    zoom: 100,
    typewriterScroll: false,
  };

  await page.evaluate((s) => window.supermdLoad?.(s), baseState);
  const toggleBtn = page.getByRole("button", { name: "Typewriter", exact: true });
  await expect(toggleBtn).toHaveAttribute("aria-pressed", "false");

  // Enable typewriter mode via status bar button and verify native bridge sync.
  await toggleBtn.click();
  await expect(toggleBtn).toHaveAttribute("aria-pressed", "true");
  expect(await page.evaluate(() => (window as any).nativeEvents.find((e: any) => e.command === "typewriter_scroll")?.args)).toEqual({ enabled: true });

  // Focus editor and type at Line 1: even the very first line should center thanks to half-viewport padding.
  await page.locator(".cm-content").click({ position: { x: 40, y: 12 } });
  await page.keyboard.type("Start: ");
  await page.waitForTimeout(80);

  const measureCenterError = () =>
    page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>(".cm-scroller")!;
      const active = document.querySelector<HTMLElement>(".cm-activeLine")!;
      const sRect = scroller.getBoundingClientRect();
      const aRect = active.getBoundingClientRect();
      const scrollerCenter = sRect.top + sRect.height / 2;
      const lineCenter = aRect.top + aRect.height / 2;
      return { error: Math.abs(lineCenter - scrollerCenter), lineHeight: aRect.height, scrollTop: scroller.scrollTop };
    });

  const topLineMetrics = await measureCenterError();
  expect(topLineMetrics.error).toBeLessThan(28);

  // Jump to end of document and type new lines: active line stays centered in viewport.
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Appended centered line at bottom");
  await page.waitForTimeout(80);
  const bottomMetrics = await measureCenterError();
  expect(bottomMetrics.error).toBeLessThan(28);

  // Guardrail 2: Apply custom theme line-height (--editor-leading: 2.2, --editor-size: 22px) and verify centering.
  await page.evaluate(() => {
    document.documentElement.style.setProperty("--editor-size", "22px");
    document.documentElement.style.setProperty("--editor-leading", "2.2");
  });
  await page.keyboard.press("Enter");
  await page.keyboard.type("Custom tall leading line");
  await page.waitForTimeout(80);
  const customLeadingMetrics = await measureCenterError();
  expect(customLeadingMetrics.lineHeight).toBeGreaterThan(42);
  expect(customLeadingMetrics.error).toBeLessThan(34);

  // Guardrail 1: Manual wheel scroll must move viewport freely without snap-back interference.
  const scrollerBox = (await page.locator(".cm-scroller").boundingBox())!;
  await page.mouse.move(scrollerBox.x + scrollerBox.width / 2, scrollerBox.y + scrollerBox.height / 2);
  const beforeWheelScrollTop = await page.locator(".cm-scroller").evaluate((el) => el.scrollTop);
  await page.mouse.wheel(0, -320);
  await page.waitForTimeout(180);
  const afterWheelScrollTop = await page.locator(".cm-scroller").evaluate((el) => el.scrollTop);
  expect(beforeWheelScrollTop - afterWheelScrollTop).toBeGreaterThan(200);

  // Keyboard shortcut Ctrl+Alt+T toggles typewriter mode off and back on.
  await page.locator(".cm-content").focus();
  await page.keyboard.press("Control+Alt+t");
  await expect(toggleBtn).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("Control+Alt+t");
  await expect(toggleBtn).toHaveAttribute("aria-pressed", "true");
});

test("status bar Typewriter toggle in web workspace immediately controls LiveEditor smooth block centering", async ({ page }) => {
  const blocks = Array.from({ length: 30 }, (_, i) => `## Topic ${i + 1}\n\nParagraph content for block ${i + 1} with study notes.`).join("\n\n");
  await page.addInitScript((initialContent) => {
    localStorage.setItem("setup.complete", "true");
    localStorage.setItem(
      "workspace.tabs.browser",
      JSON.stringify({
        activeId: "tab-1",
        tabs: [{ id: "tab-1", name: "Notes.md", path: null, content: initialContent, savedContent: initialContent }],
        recentlyClosed: [],
      })
    );
  }, blocks);

  await page.setViewportSize({ width: 1200, height: 720 });
  await page.goto("/");

  // Switch to Source view and click the status bar Typewriter button.
  await page.getByRole("button", { name: "editor view" }).click();
  const statusToggle = page.getByRole("button", { name: "Typewriter", exact: true });
  await expect(statusToggle).toHaveAttribute("aria-pressed", "false");
  await statusToggle.click();
  await expect(statusToggle).toHaveAttribute("aria-pressed", "true");

  // Switch to Live view and double-click a block near the bottom of the viewport: it smoothly centers!
  await page.getByRole("button", { name: "live view" }).click();
  await expect(page.locator(".live-document")).toHaveAttribute("data-typewriter", "true");

  const targetParagraph = page.getByText("Paragraph content for block 5 with study notes.", { exact: true });
  await targetParagraph.scrollIntoViewIfNeeded();
  // Position block near the lower portion of the viewport before double-clicking.
  await page.locator(".live-pane .reading-scroll").evaluate((el) => {
    el.scrollTop = Math.max(0, el.scrollTop - 160);
  });
  await targetParagraph.dblclick();

  const textarea = page.getByRole("textbox", { name: "Edit Markdown block" });
  await expect(textarea).toBeFocused();
  await page.waitForTimeout(450);

  const liveCenterError = await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>(".live-pane .reading-scroll")!;
    const area = document.querySelector<HTMLElement>(".live-active-block textarea")!;
    const sRect = scroller.getBoundingClientRect();
    const aRect = area.getBoundingClientRect();
    return Math.abs((aRect.top + aRect.height / 2) - (sRect.top + sRect.height / 2));
  });
  expect(liveCenterError).toBeLessThan(24);

  // Settings switch reflects and controls the same typewriter state.
  await textarea.press("Escape");
  await page.getByRole("button", { name: "Settings" }).click();
  const settingsDialog = page.getByRole("dialog", { name: "Settings" });
  await expect(settingsDialog).toBeVisible();
  const switchControl = settingsDialog.getByRole("switch", { name: "Typewriter scrolling" });
  await expect(switchControl).toBeChecked();
  await switchControl.click();
  await expect(switchControl).not.toBeChecked();
  await page.keyboard.press("Escape");
  await expect(page.locator(".live-document")).not.toHaveAttribute("data-typewriter", "true");
});
