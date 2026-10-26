import { test, expect } from '@playwright/test';

const viewports = [
  { width: 1366, height: 768 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
];

test('reader popups stay within compact bounds at laptop, monitor, and high-DPI sizes', async ({ browser }) => {
  for (const viewport of viewports) {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 2 });
    const page = await context.newPage();
    await page.addInitScript(() => {
      window.SuperMD = { post: (id, command) => {
        if (command === 'export_pdf_native') return;
        queueMicrotask(() => window.supermdReply?.(id, command === 'load_python_output' ? null : true, null));
      } };
    });
    await page.goto('/android-reader.html');
    await page.waitForFunction(() => typeof window.supermdLoad === 'function');
    await page.evaluate(() => {
      document.documentElement.dataset.host = 'qt';
      document.documentElement.dataset.platform = 'desktop';
      window.supermdLoad?.({
        id: 'popup-sizing', path: null,
        content: '# Popup sizing\n\nA note with \(x^2\) and readable text.',
        mode: 'reader', dark: false, fullscreen: false, colors: {}, font: 'Manrope', size: 16, zoom: 100,
      });
    });
    await expect.poll(() => page.evaluate(() => window.devicePixelRatio)).toBe(2);

    await page.evaluate(() => window.supermdFind?.());
    const search = page.getByRole('search', { name: 'Find in note' });
    await expect(search).toBeVisible();
    const searchBox = (await search.boundingBox())!;
    expect(searchBox.width).toBeLessThanOrEqual(962);
    expect(searchBox.x).toBeGreaterThanOrEqual(0);
    expect(searchBox.x + searchBox.width).toBeLessThanOrEqual(viewport.width);
    await page.screenshot({ path: `/tmp/supermd-search-${viewport.width}x${viewport.height}-dpr2.png` });
    await page.keyboard.press('Escape');
    await expect(search).toHaveCount(0);

    await page.evaluate(() => window.supermdThemeGuide?.());
    const guide = page.getByRole('dialog', { name: 'Theme styling guide' });
    await expect(guide).toBeVisible();
    const guideBox = (await guide.boundingBox())!;
    expect(guideBox.width).toBeLessThanOrEqual(922);
    expect(guideBox.height).toBeLessThanOrEqual(Math.min(762, viewport.height * .8 + 2));
    expect(guideBox.x).toBeGreaterThanOrEqual(0);
    expect(guideBox.x + guideBox.width).toBeLessThanOrEqual(viewport.width);
    await page.screenshot({ path: `/tmp/supermd-guide-${viewport.width}x${viewport.height}-dpr2.png` });
    await page.keyboard.press('Escape');
    await expect(guide).toHaveCount(0);

    await page.evaluate(() => window.supermdRepairMath?.());
    const repair = page.getByRole('dialog', { name: 'Review LaTeX repairs' });
    await expect(repair).toBeVisible();
    const repairBox = (await repair.boundingBox())!;
    expect(repairBox.width).toBeLessThanOrEqual(642);
    expect(repairBox.height).toBeLessThanOrEqual(Math.min(682, viewport.height - 30));
    expect(repairBox.x).toBeGreaterThanOrEqual(0);
    expect(repairBox.x + repairBox.width).toBeLessThanOrEqual(viewport.width);
    await page.screenshot({ path: `/tmp/supermd-repair-${viewport.width}x${viewport.height}-dpr2.png` });
    await page.keyboard.press('Escape');
    await expect(repair).toHaveCount(0);

    await page.evaluate(() => void window.supermdExport?.({ pageSize: 'a4', margin: 18, fontSize: 10, lineHeight: 1.45, fontFamily: 'Manrope', pageNumbers: true }));
    const exportProgress = page.getByRole('dialog', { name: 'Exporting PDF' });
    await expect(exportProgress).toBeVisible();
    const exportBox = (await exportProgress.boundingBox())!;
    expect(exportBox.width).toBeLessThanOrEqual(422);
    expect(exportBox.height).toBeLessThanOrEqual(270);
    expect(exportBox.width / exportBox.height).toBeGreaterThan(1.5);
    expect(exportBox.x).toBeGreaterThanOrEqual(0);
    expect(exportBox.x + exportBox.width).toBeLessThanOrEqual(viewport.width);
    await page.screenshot({ path: `/tmp/supermd-export-${viewport.width}x${viewport.height}-dpr2.png` });
    await context.close();
  }
});
