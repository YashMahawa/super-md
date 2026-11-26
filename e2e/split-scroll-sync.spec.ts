import { expect, test, type Locator } from "@playwright/test";

function buildSplitSyncNote(): string {
  const sections: string[] = ["# Split Scroll Sync Verification", ""];
  for (let i = 1; i <= 32; i++) {
    sections.push(`## Section ${i}: Architecture Milestone ${i}`);
    sections.push("");
    sections.push(
      `Detailed implementation notes for milestone ${i}, covering source-coordinate mapping, settled alignment, and viewport stability across Split panes. `.repeat(
        4,
      ),
    );
    sections.push("");
    if (i === 8) {
      sections.push("```ts");
      for (let line = 1; line <= 6; line++) {
        sections.push(
          `export const wideDiagnosticBanner_${line} = "${"horizontal-inner-scroller-segment-".repeat(10)}${line}";`,
        );
      }
      sections.push("```");
      sections.push("");
      sections.push(
        `| Metric | ${Array.from({ length: 12 }, (_, col) => `Wide Column Header ${col + 1}`).join(" | ")} |`,
      );
      sections.push(`| --- | ${Array.from({ length: 12 }, () => "---").join(" | ")} |`);
      for (let row = 1; row <= 3; row++) {
        sections.push(
          `| Row ${row} | ${Array.from({ length: 12 }, (_, col) => `Cell payload value ${row}.${col + 1} with extra width`).join(" | ")} |`,
        );
      }
      sections.push("");
    }
  }
  return `${sections.join("\n")}\n`;
}

async function isVisibleNearScrollerTop(item: Locator, scroller: Locator, maxOffsetFromTop = 220): Promise<boolean> {
  const [itemBox, scrollerBox] = await Promise.all([item.boundingBox(), scroller.boundingBox()]);
  if (!itemBox || !scrollerBox) return false;
  const relTop = itemBox.y - scrollerBox.y;
  return relTop >= -24 && relTop <= maxOffsetFromTop;
}

test.describe("native Split view settled bidirectional scroll alignment", () => {
  test("aligns both scroll directions after settle, prevents feedback, and preserves caret, inner scrollers, and tab restoration", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1360, height: 820 });
    await page.addInitScript(() => {
      window.SuperMD = {
        post: (id) => {
          queueMicrotask(() => window.supermdReply?.(id, true, null));
        },
      };
    });

    await page.goto("/android-reader.html");
    await page.waitForFunction(() => typeof window.supermdLoad === "function");

    const noteA = buildSplitSyncNote();
    const noteB = "# Secondary Scratchpad\n\n" + "Short note on second tab.\n\n".repeat(25);
    const common = {
      dark: false,
      fullscreen: false,
      colors: {},
      font: "Manrope",
      size: 16,
      zoom: 100,
      motion: false,
    };

    await page.evaluate(
      ({ content, common }) =>
        window.supermdLoad?.({
          ...common,
          id: "split-tab-a",
          path: "/workspace/split-tab-a.md",
          content,
          mode: "split",
        }),
      { content: noteA, common },
    );

    const cmScroller = page.locator(".cm-scroller");
    const readingRoot = page.locator(".android-reading");
    await expect(cmScroller).toBeVisible();
    await expect(readingRoot).toBeVisible();

    // 1. Place caret & selection in CodeMirror on Section 2 so we can verify Preview -> Source preserves it.
    const section2Line = page.locator(".cm-line", { hasText: "## Section 2: Architecture Milestone 2" });
    await section2Line.click();
    await page.keyboard.press("Home");
    await page.keyboard.down("Shift");
    for (let i = 0; i < 12; i++) await page.keyboard.press("ArrowRight");
    await page.keyboard.up("Shift");

    const initialSelection = await page.evaluate(() => window.supermdSelectedText?.() ?? "");
    expect(initialSelection).toBe("## Section 2");

    // 2. Deliberate scroll Preview -> Source to Section 18:
    // Scroll Preview so Section 18 sits near the top of .android-reading.
    const previewBox = (await readingRoot.boundingBox())!;
    await page.mouse.move(previewBox.x + previewBox.width * 0.5, previewBox.y + previewBox.height * 0.5);
    const section18Preview = page.locator(".android-reading h2", {
      hasText: "Section 18: Architecture Milestone 18",
    });
    const targetPreviewTop = await section18Preview.evaluate((el) => {
      const root = el.closest<HTMLElement>(".android-reading")!;
      return Math.round(root.scrollTop + el.getBoundingClientRect().top - root.getBoundingClientRect().top - 20);
    });
    expect(targetPreviewTop).toBeGreaterThan(1500);

    // Emit realistic multi-step wheel + scroll in Preview, checking Source waits for settle.
    await page.evaluate((top) => {
      const root = document.querySelector<HTMLElement>(".android-reading")!;
      root.dispatchEvent(new WheelEvent("wheel", { deltaY: 240, bubbles: true }));
      root.scrollTop = Math.round(top * 0.5);
      root.dispatchEvent(new Event("scroll"));
    }, targetPreviewTop);
    await page.waitForTimeout(40);
    // Mid-gesture: Source has not synced yet because scrolling has not settled.
    expect(await cmScroller.evaluate((el) => el.scrollTop)).toBeLessThan(100);

    await page.evaluate((top) => {
      const root = document.querySelector<HTMLElement>(".android-reading")!;
      root.dispatchEvent(new WheelEvent("wheel", { deltaY: 240, bubbles: true }));
      root.scrollTop = top;
      root.dispatchEvent(new Event("scroll"));
    }, targetPreviewTop);

    // Once settled (> 120ms), Source aligns to Section 18 without moving selection/caret or bouncing back!
    const section18Source = page.locator(".cm-line", { hasText: "## Section 18: Architecture Milestone 18" });
    await expect.poll(() => isVisibleNearScrollerTop(section18Source, cmScroller)).toBe(true);

    const previewTopAfterSettle = await readingRoot.evaluate((el) => el.scrollTop);
    expect(Math.abs(previewTopAfterSettle - targetPreviewTop)).toBeLessThanOrEqual(2);
    // Wait another 300ms to confirm zero ping-pong feedback between panes.
    await page.waitForTimeout(300);
    expect(Math.abs((await readingRoot.evaluate((el) => el.scrollTop)) - previewTopAfterSettle)).toBeLessThanOrEqual(2);
    expect(await page.evaluate(() => window.supermdSelectedText?.() ?? "")).toBe("## Section 2");

    // 3. Deliberate scroll Source -> Preview back up to Section 8 (which hosts inner <pre> & <table> scrollers):
    const targetSourceOffset = noteA.indexOf("## Section 8: Architecture Milestone 8");
    expect(targetSourceOffset).toBeGreaterThan(800);
    // Scroll .cm-scroller deliberately via wheel + scrollTop to Section 8.
    await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>(".cm-scroller")!;
      scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -400, bubbles: true }));
    });
    // Find pixel scrollTop in CodeMirror that puts Section 8 at top.
    await page.evaluate(( targetText ) => {
      const scroller = document.querySelector<HTMLElement>(".cm-scroller")!;
      scroller.scrollTop = Math.round(scroller.scrollTop * 0.38);
      scroller.dispatchEvent(new Event("scroll"));
      void targetText;
    }, "## Section 8: Architecture Milestone 8");
    await page.waitForTimeout(30);
    const exactEditorTopForSec8 = await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>(".cm-scroller")!;
      const lines = Array.from(scroller.querySelectorAll<HTMLElement>(".cm-line"));
      const hit = lines.find((line) => line.textContent?.includes("## Section 8: Architecture Milestone 8"));
      if (!hit) return scroller.scrollTop;
      return Math.max(
        0,
        Math.round(scroller.scrollTop + hit.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 16),
      );
    });
    await page.evaluate((top) => {
      const scroller = document.querySelector<HTMLElement>(".cm-scroller")!;
      scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true }));
      scroller.scrollTop = top;
      scroller.dispatchEvent(new Event("scroll"));
    }, exactEditorTopForSec8);

    const section8Preview = page.locator(".android-reading h2", {
      hasText: "Section 8: Architecture Milestone 8",
    });
    await expect.poll(() => isVisibleNearScrollerTop(section8Preview, readingRoot)).toBe(true);
    const editorTopAfterSec8 = await cmScroller.evaluate((el) => el.scrollTop);
    await page.waitForTimeout(300);
    // Zero ping-pong feedback back onto Source editor.
    expect(Math.abs((await cmScroller.evaluate((el) => el.scrollTop)) - editorTopAfterSec8)).toBeLessThanOrEqual(2);
    // Caret/selection on Section 2 is STILL untouched!
    expect(await page.evaluate(() => window.supermdSelectedText?.() ?? "")).toBe("## Section 2");

    // 4. Independent inner scrollers (<pre> and <table>) inside Preview:
    const innerPre = page.locator(".android-reading .markdown-body pre").first();
    const innerTable = page.locator(".android-reading .markdown-body table").first();
    await expect(innerPre).toBeVisible();
    await expect(innerTable).toBeVisible();

    const beforeInnerSync = {
      editorTop: await cmScroller.evaluate((el) => el.scrollTop),
      previewTop: await readingRoot.evaluate((el) => el.scrollTop),
    };

    const innerScrolls = await page.evaluate(() => {
      const pre = document.querySelector<HTMLElement>(".android-reading .markdown-body pre")!;
      const table = document.querySelector<HTMLElement>(".android-reading .markdown-body table")!;
      pre.dispatchEvent(new WheelEvent("wheel", { deltaX: 180, deltaY: 0, bubbles: true }));
      pre.scrollLeft = 180;
      pre.dispatchEvent(new Event("scroll"));
      table.dispatchEvent(new WheelEvent("wheel", { deltaX: 220, deltaY: 0, bubbles: true }));
      table.scrollLeft = 220;
      table.dispatchEvent(new Event("scroll"));
      return { preLeft: pre.scrollLeft, tableLeft: table.scrollLeft };
    });
    expect(innerScrolls.preLeft).toBeGreaterThan(100);
    expect(innerScrolls.tableLeft).toBeGreaterThan(100);

    await page.waitForTimeout(260);
    expect(await cmScroller.evaluate((el) => el.scrollTop)).toBe(beforeInnerSync.editorTop);
    expect(await readingRoot.evaluate((el) => el.scrollTop)).toBe(beforeInnerSync.previewTop);
    expect(await innerPre.evaluate((el) => el.scrollLeft)).toBe(innerScrolls.preLeft);
    expect(await innerTable.evaluate((el) => el.scrollLeft)).toBe(innerScrolls.tableLeft);

    // Scrolling Source slightly up to Section 7 aligns Preview vertically while keeping inner scrollLeft intact!
    await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>(".cm-scroller")!;
      scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -260, bubbles: true }));
      scroller.scrollTop = Math.max(0, scroller.scrollTop - 260);
      scroller.dispatchEvent(new Event("scroll"));
    });
    await expect(page.locator(".cm-line", { hasText: "## Section 7: Architecture Milestone 7" })).toBeVisible();
    const sec7EditorTop = await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>(".cm-scroller")!;
      const hit = Array.from(scroller.querySelectorAll<HTMLElement>(".cm-line")).find((line) =>
        line.textContent?.includes("## Section 7: Architecture Milestone 7"),
      )!;
      return Math.max(
        0,
        Math.round(scroller.scrollTop + hit.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 16),
      );
    });
    await page.evaluate((top) => {
      const scroller = document.querySelector<HTMLElement>(".cm-scroller")!;
      scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true }));
      scroller.scrollTop = top;
      scroller.dispatchEvent(new Event("scroll"));
    }, sec7EditorTop);

    const section7Preview = page.locator(".android-reading h2", {
      hasText: "Section 7: Architecture Milestone 7",
    });
    await expect.poll(() => isVisibleNearScrollerTop(section7Preview, readingRoot)).toBe(true);
    expect(await innerPre.evaluate((el) => el.scrollLeft)).toBe(innerScrolls.preLeft);
    expect(await innerTable.evaluate((el) => el.scrollLeft)).toBe(innerScrolls.tableLeft);

    // 5. Tab restoration in Split view preserves exact editorTop and readingTop without post-restore drift:
    const savedSplitTops = {
      editorTop: await cmScroller.evaluate((el) => el.scrollTop),
      previewTop: await readingRoot.evaluate((el) => el.scrollTop),
    };
    expect(savedSplitTops.editorTop).toBeGreaterThan(400);
    expect(savedSplitTops.previewTop).toBeGreaterThan(600);

    await page.evaluate(
      ({ content, common }) =>
        window.supermdLoad?.({
          ...common,
          id: "split-tab-b",
          path: "/workspace/split-tab-b.md",
          content,
          mode: "split",
        }),
      { content: noteB, common },
    );
    await expect.poll(() => cmScroller.evaluate((el) => el.scrollTop)).toBeLessThan(10);
    await expect.poll(() => readingRoot.evaluate((el) => el.scrollTop)).toBeLessThan(10);

    await page.evaluate(
      ({ content, common }) =>
        window.supermdLoad?.({
          ...common,
          id: "split-tab-a",
          path: "/workspace/split-tab-a.md",
          content,
          mode: "split",
        }),
      { content: noteA, common },
    );
    await expect
      .poll(async () => Math.abs((await cmScroller.evaluate((el) => el.scrollTop)) - savedSplitTops.editorTop))
      .toBeLessThan(8);
    await expect
      .poll(async () => Math.abs((await readingRoot.evaluate((el) => el.scrollTop)) - savedSplitTops.previewTop))
      .toBeLessThan(8);

    await page.waitForTimeout(280);
    expect(Math.abs((await cmScroller.evaluate((el) => el.scrollTop)) - savedSplitTops.editorTop)).toBeLessThan(8);
    expect(Math.abs((await readingRoot.evaluate((el) => el.scrollTop)) - savedSplitTops.previewTop)).toBeLessThan(8);
  });
});
