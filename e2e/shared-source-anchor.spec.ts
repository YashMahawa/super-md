import { expect, test, type Locator } from "@playwright/test";

function buildDeepNestedChecklistNote(prefixTitle = "Engineering Verification Runbook"): string {
  const intro = Array.from(
    { length: 14 },
    (_, idx) =>
      `## Context Section ${idx + 1}\n\n` +
      `Detailed operational background for subsystem ${idx + 1} so the checklist sits well below the initial viewport. `.repeat(6),
  ).join("\n\n");

  const branches: string[] = [`# ${prefixTitle}`, "", intro, "", "## Deep Nested Checklist", ""];
  for (let major = 1; major <= 3; major++) {
    branches.push(`- [ ] ${major}. Root Milestone ${major}`);
    for (let minor = 1; minor <= 3; minor++) {
      branches.push(`  - [ ] ${major}.${minor} Workstream ${major}.${minor}`);
      for (let patch = 1; patch <= 2; patch++) {
        branches.push(`    - [x] ${major}.${minor}.${patch} Component gate ${major}.${minor}.${patch}`);
        for (const sub of ["a", "b"]) {
          branches.push(`      - [ ] ${major}.${minor}.${patch}.${sub} Subcheck ${major}.${minor}.${patch}.${sub}`);
          for (const leaf of ["i", "ii", "iii", "iv"]) {
            const label =
              major === 1 && minor === 2 && patch === 2 && sub === "a" && leaf === "iii"
                ? "1.2.2.a.iii Primary Deep Leaf Target"
                : major === 2 && minor === 3 && patch === 2 && sub === "b" && leaf === "iv"
                  ? "2.3.2.b.iv Secondary Deep Leaf Target"
                  : `${major}.${minor}.${patch}.${sub}.${leaf} Routine verification step`;
            branches.push(`        - [ ] ${label}`);
          }
        }
      }
    }
  }

  const outro = Array.from(
    { length: 14 },
    (_, idx) =>
      `## Appendix ${idx + 1}\n\n` +
      `Post-checklist reference notes and sign-off records for stage ${idx + 1}. `.repeat(6),
  ).join("\n\n");

  return `${branches.join("\n")}\n\n${outro}\n`;
}

async function isVisibleWithinScroller(item: Locator, scroller: Locator): Promise<boolean> {
  const [itemBox, scrollerBox] = await Promise.all([item.boundingBox(), scroller.boundingBox()]);
  if (!itemBox || !scrollerBox) return false;
  const itemTop = itemBox.y;
  const itemBottom = itemBox.y + itemBox.height;
  const scrollerTop = scrollerBox.y;
  const scrollerBottom = scrollerBox.y + scrollerBox.height;
  return itemBottom > scrollerTop + 4 && itemTop < scrollerBottom - 12;
}

test.describe("shared source anchor across Split, Source, Live and unsaved draft tabs", () => {
  test("native reader preserves deep nested checklist anchors and unsaved draft edits across Live, Split and Source", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 820 });
    await page.addInitScript(() => {
      let currentContent = "";
      (window as any).__latestDraftContent = () => currentContent;
      window.SuperMD = {
        post: (id, command, raw) => {
          if (command === "document_changed") {
            currentContent = JSON.parse(raw).content;
          }
          queueMicrotask(() => window.supermdReply?.(id, true, null));
        },
      };
    });

    await page.goto("/android-reader.html");
    await page.waitForFunction(() => typeof window.supermdLoad === "function");

    const initialContent = buildDeepNestedChecklistNote();
    const baseState = {
      id: "draft-checklist-note",
      path: null as string | null,
      content: initialContent,
      dark: false,
      fullscreen: false,
      colors: {},
      font: "Manrope",
      size: 17,
      zoom: 100,
      motion: false,
    };

    // 1. Open in Live mode and scroll to a 5-level deep nested checklist leaf item.
    await page.evaluate((state) => window.supermdLoad?.({ ...state, mode: "live" }), baseState);
    const readingRoot = page.locator(".android-reading");
    await expect(page.locator(".live-document")).toBeVisible();

    const primaryLeafInLive = page.locator("li", { hasText: "1.2.2.a.iii Primary Deep Leaf Target" }).last();
    const rootMilestoneInLive = page.locator("li", { hasText: "1. Root Milestone 1" }).first();
    await primaryLeafInLive.evaluate((el) => el.scrollIntoView({ block: "start" }));
    await page.evaluate(() => {
      document.querySelector<HTMLElement>(".android-reading")!.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await expect.poll(() => readingRoot.evaluate((el) => el.scrollTop)).toBeGreaterThan(1500);
    await expect.poll(() => isVisibleWithinScroller(primaryLeafInLive, readingRoot)).toBe(true);
    // Ensure the outer checklist root is far above the viewport so collapsing to the outer list would fail.
    expect((await rootMilestoneInLive.boundingBox())!.y).toBeLessThan(-300);

    // 2. Transition Live -> Split: both Source and Preview panes align to the deep nested checklist item.
    await page.evaluate((state) => window.supermdLoad?.({ ...state, mode: "split" }), baseState);
    const cmScroller = page.locator(".cm-scroller");
    await expect(cmScroller).toBeVisible();
    await expect(readingRoot).toBeVisible();
    await expect.poll(() => cmScroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(800);
    await expect.poll(() => readingRoot.evaluate((el) => el.scrollTop)).toBeGreaterThan(1200);
    await expect
      .poll(() => isVisibleWithinScroller(page.locator(".cm-line", { hasText: "1.2.2.a.iii Primary Deep Leaf Target" }), cmScroller))
      .toBe(true);
    await expect
      .poll(() => isVisibleWithinScroller(page.locator(".android-reading li", { hasText: "1.2.2.a.iii Primary Deep Leaf Target" }).last(), readingRoot))
      .toBe(true);

    // 3. Scroll the Split preview pane deeper to a second 5-level leaf item, then transition Split -> Source.
    const secondaryLeafInSplit = page.locator(".android-reading li", { hasText: "2.3.2.b.iv Secondary Deep Leaf Target" }).last();
    await secondaryLeafInSplit.evaluate((el) => el.scrollIntoView({ block: "start" }));
    await page.evaluate(() => {
      const root = document.querySelector<HTMLElement>(".android-reading")!;
      root.dispatchEvent(new WheelEvent("wheel", { deltaY: 4, bubbles: true }));
      root.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await page.waitForTimeout(80);

    await page.evaluate((state) => window.supermdLoad?.({ ...state, mode: "editor" }), baseState);
    await expect(page.locator(".android-reading")).toHaveCount(0);
    const secondaryLineInEditor = page.locator(".cm-line", { hasText: "2.3.2.b.iv Secondary Deep Leaf Target" });
    await expect.poll(() => isVisibleWithinScroller(secondaryLineInEditor, cmScroller)).toBe(true);

    // 4. Edit an unsaved draft directly on that deep nested checklist item in Source, then transition Source -> Live.
    await secondaryLineInEditor.click();
    await page.keyboard.press("End");
    await page.keyboard.type(" [unsaved-draft-verified]");
    await expect.poll(() => page.evaluate(() => (window as any).__latestDraftContent())).toContain(
      "2.3.2.b.iv Secondary Deep Leaf Target [unsaved-draft-verified]",
    );
    const updatedDraft = await page.evaluate(() => (window as any).__latestDraftContent() as string);

    await page.evaluate(
      ({ state, content }) => window.supermdLoad?.({ ...state, content, mode: "live" }),
      { state: baseState, content: updatedDraft },
    );
    const updatedLeafInLive = page
      .locator(".live-document li", { hasText: "2.3.2.b.iv Secondary Deep Leaf Target [unsaved-draft-verified]" })
      .last();
    await expect.poll(() => isVisibleWithinScroller(updatedLeafInLive, readingRoot)).toBe(true);
    expect((await page.locator(".live-document li", { hasText: "1. Root Milestone 1" }).first().boundingBox())!.y).toBeLessThan(-600);
  });

  test("native reader preserves unsaved draft positions across tab switches and cross-tab mode changes", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 820 });
    await page.addInitScript(() => {
      const drafts: Record<string, string> = {};
      (window as any).__getTabDraft = (id: string) => drafts[id];
      window.SuperMD = {
        post: (id, command, raw) => {
          if (command === "document_changed") {
            const parsed = JSON.parse(raw);
            drafts[parsed.id] = parsed.content;
          }
          queueMicrotask(() => window.supermdReply?.(id, true, null));
        },
      };
    });

    await page.goto("/android-reader.html");
    await page.waitForFunction(() => typeof window.supermdLoad === "function");

    const draftAContent = buildDeepNestedChecklistNote("Untitled Draft Alpha");
    const draftBContent = "# Fresh Scratchpad\n\n" + "Short paragraph on tab B.\n\n".repeat(40);
    const common = { dark: false, fullscreen: false, colors: {}, font: "Manrope", size: 17, zoom: 100, motion: false };

    // Open unsaved Draft A (path: null) in Source mode, scroll to the deep nested item, and type an unsaved edit.
    await page.evaluate(
      ({ content, common }) => window.supermdLoad?.({ ...common, id: "unsaved-tab-a", path: null, content, mode: "editor" }),
      { content: draftAContent, common },
    );
    const cmScroller = page.locator(".cm-scroller");
    const targetOffset = draftAContent.indexOf("- [ ] 2.3.2.b.iv Secondary Deep Leaf Target");
    expect(targetOffset).toBeGreaterThan(1000);
    await page.evaluate((offset) => window.dispatchEvent(new CustomEvent("supermd-goto-offset", { detail: offset })), targetOffset);
    const targetLine = page.locator(".cm-line", { hasText: "2.3.2.b.iv Secondary Deep Leaf Target" });
    await expect.poll(() => isVisibleWithinScroller(targetLine, cmScroller)).toBe(true);
    await targetLine.click();
    await page.keyboard.press("End");
    await page.keyboard.type(" (draft-alpha)");
    await expect.poll(() => page.evaluate(() => (window as any).__getTabDraft("unsaved-tab-a"))).toContain("(draft-alpha)");
    const savedEditorTop = await cmScroller.evaluate((el) => el.scrollTop);
    expect(savedEditorTop).toBeGreaterThan(1000);
    const latestDraftA = await page.evaluate(() => (window as any).__getTabDraft("unsaved-tab-a") as string);

    // Switch to brand-new unsaved Draft B in Source mode -> starts at top (0), not Draft A's scroll offset.
    await page.evaluate(
      ({ content, common }) => window.supermdLoad?.({ ...common, id: "unsaved-tab-b", path: null, content, mode: "editor" }),
      { content: draftBContent, common },
    );
    await expect.poll(() => cmScroller.evaluate((el) => el.scrollTop)).toBeLessThan(10);

    // Switch back to unsaved Draft A in Source mode -> exact scroll position & edited checklist line restored.
    await page.evaluate(
      ({ content, common }) => window.supermdLoad?.({ ...common, id: "unsaved-tab-a", path: null, content, mode: "editor" }),
      { content: latestDraftA, common },
    );
    await expect.poll(async () => Math.abs((await cmScroller.evaluate((el) => el.scrollTop)) - savedEditorTop)).toBeLessThan(8);
    await expect.poll(() => isVisibleWithinScroller(page.locator(".cm-line", { hasText: "(draft-alpha)" }), cmScroller)).toBe(true);

    // Switch back to Draft B, change global mode on Draft B (editor -> live -> split), then return to Draft A in Split and Live!
    await page.evaluate(
      ({ content, common }) => window.supermdLoad?.({ ...common, id: "unsaved-tab-b", path: null, content, mode: "editor" }),
      { content: draftBContent, common },
    );
    await page.evaluate(
      ({ content, common }) => window.supermdLoad?.({ ...common, id: "unsaved-tab-b", path: null, content, mode: "live" }),
      { content: draftBContent, common },
    );
    await page.evaluate(
      ({ content, common }) => window.supermdLoad?.({ ...common, id: "unsaved-tab-b", path: null, content, mode: "split" }),
      { content: draftBContent, common },
    );

    // Returning to Draft A while global mode is now Split aligns BOTH panes to Draft A's deep nested checklist item.
    await page.evaluate(
      ({ content, common }) => window.supermdLoad?.({ ...common, id: "unsaved-tab-a", path: null, content, mode: "split" }),
      { content: latestDraftA, common },
    );
    const readingRoot = page.locator(".android-reading");
    await expect.poll(() => isVisibleWithinScroller(page.locator(".cm-line", { hasText: "(draft-alpha)" }), cmScroller)).toBe(true);
    await expect
      .poll(() => isVisibleWithinScroller(page.locator(".android-reading li", { hasText: "(draft-alpha)" }).last(), readingRoot))
      .toBe(true);

    // Transitioning to Live on Draft A keeps the same deep nested checklist item anchored.
    await page.evaluate(
      ({ content, common }) => window.supermdLoad?.({ ...common, id: "unsaved-tab-a", path: null, content, mode: "live" }),
      { content: latestDraftA, common },
    );
    await expect
      .poll(() => isVisibleWithinScroller(page.locator(".live-document li", { hasText: "(draft-alpha)" }).last(), readingRoot))
      .toBe(true);
  });

  test("web studio shares source anchors across Split, Source, Live and unsaved draft tab switches", async ({ page }) => {
    const checklistDraft = buildDeepNestedChecklistNote("Studio Draft Checklist");
    await page.setViewportSize({ width: 1360, height: 860 });
    await page.addInitScript((markdown) => {
      localStorage.setItem("setup.complete", "true");
      localStorage.setItem("motion.reduce", "true");
      localStorage.setItem("view.mode", "split");
      localStorage.setItem(
        "workspace.tabs.browser",
        JSON.stringify({
          activeId: "draft-1",
          tabs: [
            {
              id: "draft-1",
              name: "Studio Draft Checklist",
              path: null,
              content: markdown,
              savedContent: "",
            },
          ],
          recentlyClosed: [],
        }),
      );
    }, checklistDraft);

    await page.goto("/");
    const previewScroller = page.locator(".preview-pane .reading-scroll");
    const cmScroller = page.locator(".cm-scroller");
    await expect(previewScroller).toBeVisible();
    await expect(cmScroller).toBeVisible();

    // Scroll the Split preview pane to the deep nested checklist leaf item.
    const deepLeafInPreview = page.locator(".preview-pane li", { hasText: "2.3.2.b.iv Secondary Deep Leaf Target" }).last();
    await deepLeafInPreview.evaluate((el) => el.scrollIntoView({ block: "start" }));
    await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>(".preview-pane .reading-scroll")!;
      scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: 4, bubbles: true }));
      scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await expect.poll(() => previewScroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(1500);

    // Switch Split -> Source: CodeMirror lands on the exact nested checklist item.
    await page.getByRole("button", { name: "editor view", exact: true }).click();
    const deepLineInSource = page.locator(".cm-line", { hasText: "2.3.2.b.iv Secondary Deep Leaf Target" });
    await expect.poll(() => isVisibleWithinScroller(deepLineInSource, cmScroller)).toBe(true);

    // Make an unsaved draft edit in Source, then switch Source -> Live.
    await deepLineInSource.click();
    await page.keyboard.press("End");
    await page.keyboard.type(" [studio-unsaved]");
    await page.getByRole("button", { name: "live view", exact: true }).click();

    const liveScroller = page.locator(".live-pane .reading-scroll");
    const deepLeafInLive = page.locator(".live-pane li", { hasText: "2.3.2.b.iv Secondary Deep Leaf Target [studio-unsaved]" }).last();
    await expect.poll(() => isVisibleWithinScroller(deepLeafInLive, liveScroller)).toBe(true);
    expect(await liveScroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(1500);

    // Open a new unsaved tab -> starts at top (scrollTop === 0).
    await page.getByRole("button", { name: "New tab", exact: true }).click();
    await expect.poll(() => liveScroller.evaluate((el) => el.scrollTop)).toBe(0);

    // Switch global mode to Split while on Tab 2, then switch back to Tab 1 -> both Split panes restore Tab 1's deep draft position.
    await page.getByRole("button", { name: "split view", exact: true }).click();
    await page.getByRole("tab", { name: /Studio Draft Checklist/ }).click();
    await expect
      .poll(() => isVisibleWithinScroller(page.locator(".cm-line", { hasText: "[studio-unsaved]" }), page.locator(".cm-scroller")))
      .toBe(true);
    await expect
      .poll(() =>
        isVisibleWithinScroller(
          page.locator(".preview-pane li", { hasText: "[studio-unsaved]" }).last(),
          page.locator(".preview-pane .reading-scroll"),
        ),
      )
      .toBe(true);
  });
});
