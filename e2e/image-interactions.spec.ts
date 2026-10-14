import { test, expect } from '@playwright/test';

test('opening, dragging and panning note images never appends Markdown or broken assets', async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).mediaCommands = [];
    window.SuperMD = { post: (id, command, args) => {
      if (['import_images', 'document_changed'].includes(command)) (window as any).mediaCommands.push({ command, args: JSON.parse(args) });
      const result = command === 'load_asset' ? 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="100"><rect width="240" height="100" fill="#6486b2"/></svg>') : true;
      queueMicrotask(() => window.supermdReply?.(id, result, null));
    } };
  });
  await page.goto('/android-reader.html');
  await page.waitForFunction(() => typeof window.supermdLoad === 'function');
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="100"><rect width="240" height="100" fill="#6486b2"/></svg>';
  const content = '# Keep my note\n\n![Image](assets/import-sample.svg)\n\n```svg\n' + svg + '\n```\n\nThe final paragraph must stay final.\n';
  for (const host of ['qt', 'android']) for (const mode of ['reader', 'live'] as const) {
    await page.evaluate(({ host, mode, content }) => {
      document.documentElement.dataset.host = host;
      document.documentElement.dataset.platform = host === 'android' ? 'android' : 'desktop';
      window.supermdLoad?.({ id: `${host}-${mode}`, content, path: null, mode, dark: false, fullscreen: false, colors: {}, font: 'Manrope', size: 15, zoom: 100 });
    }, { host, mode, content });
    for (const selector of ['.note-image img', '.svg-diagram']) {
      const image = page.locator(selector);
      await expect(image).toBeVisible();
      expect(await image.evaluate(el => (el as HTMLImageElement).draggable)).toBe(false);
      await image.click();
      await expect(page.getByRole('dialog', { name: 'Image viewer' })).toBeVisible();
      const canvas = page.locator('.image-viewer-canvas'), bounds = (await canvas.boundingBox())!;
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      await page.mouse.down(); await page.mouse.move(bounds.x + bounds.width / 2 + 80, bounds.y + bounds.height / 2 + 20, { steps: 8 }); await page.mouse.up();
      await page.getByRole('button', { name: 'Close image viewer' }).click();
      await expect(page.getByRole('dialog', { name: 'Image viewer' })).toHaveCount(0);
      const box = (await image.boundingBox())!;
      await page.mouse.move(box.x + 30, box.y + 30); await page.mouse.down();
      await page.mouse.move(box.x + 120, box.y + 60, { steps: 12 }); await page.mouse.up();
      // Browsers may synthesize a click after a non-native drag; dismiss only
      // the image viewer if that happened, never mutate or reload the note.
      if (await page.locator('.image-viewer').count()) await page.keyboard.press('Escape');
      expect(await page.evaluate(() => (window as any).mediaCommands)).toEqual([]);
      await expect(page.locator('.image-error,.render-error')).toHaveCount(0);
      await expect(page.getByText('The final paragraph must stay final.', { exact: true })).toBeVisible();
    }
  }
});
