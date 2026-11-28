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
      await expect(page.locator('.image-edit-tools')).toHaveCount(0);
      const box = (await image.boundingBox())!;
      await page.mouse.move(box.x + 30, box.y + 30); await page.mouse.down();
      await page.mouse.move(box.x + 120, box.y + 60, { steps: 12 }); await page.mouse.up();
      // Browsers may synthesize a click after a non-native drag; dismiss only
      // the image viewer if that happened (including after Live mode's 180ms
      // single-click deferral), never mutate or reload the note.
      if (mode === 'live') {
        await page.evaluate(() => new Promise<void>(resolve => window.setTimeout(() => window.setTimeout(resolve, 32), 200)));
      }
      if (await page.locator('.image-viewer').count()) {
        await page.keyboard.press('Escape');
        await expect(page.locator('.image-viewer')).toHaveCount(0);
      }
      expect(await page.evaluate(() => (window as any).mediaCommands)).toEqual([]);
      await expect(page.locator('.image-error,.render-error')).toHaveCount(0);
      await expect(page.getByText('The final paragraph must stay final.', { exact: true })).toBeVisible();
    }
  }
});

// A focused source image used to reveal Replace/Remove after viewer cleanup.
test('viewer close restores focus without opening image edit tools, including slider frames', async ({page})=>{
  await page.addInitScript(()=>{window.SuperMD={post:(id,command)=>queueMicrotask(()=>window.supermdReply?.(id,command==='load_asset'?'data:image/svg+xml;base64,'+btoa('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="100"><rect width="240" height="100" fill="#6486b2"/></svg>'):true,null))};});
  await page.goto('/android-reader.html');
  await page.waitForFunction(()=>!!window.supermdLoad);
  const steps={title:'Sequence',steps:Array.from({length:5},(_,i)=>({label:`Frame ${i+1}`,image:'assets/frame.svg'}))};
  const content='![Photo](assets/frame.svg)\n\n```smd-steps\n'+JSON.stringify(steps)+'\n```';
  await page.evaluate(content=>window.supermdLoad?.({id:'focus-regression',content,path:'/notes/a.smd',mode:'reader',dark:false,colors:{},font:'Manrope',size:15,zoom:100}),content);
  for(const selector of ['.media-paragraph .note-image','.step-cards-figure.is-current .note-image']){
    const owner=page.locator(selector);
    await expect(owner.locator('img')).toBeVisible();
    // Keyboard navigation and programmatic focus are both non-editing actions.
    await owner.focus();
    await expect(page.locator('.image-edit-tools')).toHaveCount(0);
    for(const escape of [false,true]){
      await owner.locator('img').click();
      await expect(page.locator('.image-viewer')).toBeVisible();
      if(escape)await page.keyboard.press('Escape');
      else await page.getByRole('button',{name:/Close (image|slide) viewer/}).click();
      await expect(page.locator('.image-viewer')).toHaveCount(0);
      await expect(page.locator('.image-edit-tools')).toHaveCount(0);
    }
    await expect(owner.getByRole('button',{name:/Image options/})).toHaveCount(0);
  }
});

test('context menu and broken-image blocks support Replace and Remove while preserving overlay handoff and supermdDismiss', async ({ page }) => {
  await page.addInitScript(() => {
    const validSvg = 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="100"><rect width="240" height="100" fill="#6486b2"/></svg>');
    window.SuperMD = {
      post: (id, command, args) => {
        const parsed = args ? JSON.parse(args) : {};
        queueMicrotask(() => {
          if (command === 'load_asset') {
            if (parsed.source === 'assets/missing.png') window.supermdReply?.(id, null, 'Asset file not found on disk.');
            else window.supermdReply?.(id, validSvg, null);
            return;
          }
          if (command === 'fetch_resource') {
            window.supermdReply?.(id, { body: parsed.image ? validSvg : '<title>Field Notes</title>' }, null);
            return;
          }
          if (command === 'import_images') {
            window.supermdReply?.(id, [{ source: 'assets/import-replaced.svg', alt: 'Updated diagram' }], null);
            return;
          }
          window.supermdReply?.(id, true, null);
        });
      },
    };
  });
  await page.goto('/android-reader.html');
  await page.waitForFunction(() => typeof window.supermdLoad === 'function');

  const steps = { title: 'Deck', steps: [{ label: 'One', image: 'assets/frame.svg' }, { label: 'Two', image: 'assets/frame.svg' }] };
  const initialContent = `# Lab notebook\n\n![Diagram](assets/pic.svg)\n\n![Broken](assets/missing.png)\n\n\`\`\`smd-steps\n${JSON.stringify(steps)}\n\`\`\`\n`;
  await page.evaluate((content) => {
    window.supermdLoad?.({ id: 'image-workflows', content, path: '/notes/lab.md', mode: 'reader', dark: false, fullscreen: false, colors: {}, font: 'Manrope', size: 15, zoom: 100 });
  }, initialContent);

  const noteImage = page.locator('.media-paragraph .note-image img');
  await expect(noteImage).toBeVisible();
  const brokenCard = page.locator('.image-error[data-note-image-source="assets/missing.png"]');
  await expect(brokenCard).toBeVisible();
  await expect(brokenCard).toHaveAttribute('role', 'group');
  await expect(brokenCard.getByRole('button', { name: 'Replace' })).toBeVisible();
  await expect(brokenCard.getByRole('button', { name: 'Remove' })).toBeVisible();

  // Slider frames keep save/copy items without Replace or Remove.
  await page.locator('.step-cards-figure.is-current .note-image img').click({ button: 'right' });
  const menu = page.getByRole('menu', { name: 'Save image or diagram' });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Copy image' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Replace image' })).toHaveCount(0);
  await expect(menu.getByRole('menuitem', { name: 'Remove image' })).toHaveCount(0);
  expect(await page.evaluate(() => window.supermdDismiss?.())).toBe(true);
  await expect(menu).toHaveCount(0);

  // ImageViewer -> MediaTools Replace handoff keeps dataset.readerOverlay continuously active.
  await noteImage.click();
  await expect(page.getByRole('dialog', { name: 'Image viewer' })).toBeVisible();
  await page.evaluate(() => {
    (window as any).__overlayMutations = [];
    const obs = new MutationObserver(() => (window as any).__overlayMutations.push(document.documentElement.dataset.readerOverlay ?? null));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-reader-overlay'] });
    (window as any).__overlayObserver = obs;
  });
  await page.locator('.image-viewer footer').getByRole('button', { name: 'Replace' }).click();
  await expect(page.getByRole('dialog', { name: 'Insert image or link' })).toBeVisible();
  const overlayHistory = await page.evaluate(() => {
    (window as any).__overlayObserver?.disconnect();
    return { current: document.documentElement.dataset.readerOverlay, mutations: (window as any).__overlayMutations };
  });
  expect(overlayHistory.current).toBe('true');
  expect(overlayHistory.mutations).not.toContain('false');
  expect(overlayHistory.mutations).not.toContain(null);
  expect(await page.evaluate(() => window.supermdDismiss?.())).toBe(true);
  await expect(page.getByRole('dialog', { name: 'Insert image or link' })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.dataset.readerOverlay)).toBe('false');

  // Context menu on editable note image replaces it via Enter submit.
  await noteImage.click({ button: 'right' });
  await expect(menu.getByRole('menuitem', { name: 'Replace image' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Remove image' })).toBeVisible();
  await menu.getByRole('menuitem', { name: 'Replace image' }).click();
  const urlInput = page.getByLabel('Web address');
  await urlInput.fill('https://example.com/updated.svg');
  await urlInput.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Insert image or link' })).toHaveCount(0);
  await expect(page.locator('.media-paragraph .note-image[data-note-image-source="assets/import-replaced.svg"] img')).toBeVisible();

  // Broken image supports both shared media menu and inline Remove/Undo/Replace controls.
  const brokenBox = (await brokenCard.boundingBox())!;
  expect(await page.evaluate(({ x, y }) => window.supermdMediaMenuAt?.(x, y), { x: brokenBox.x + 16, y: brokenBox.y + 16 })).toBe(true);
  await expect(menu.getByRole('menuitem', { name: 'Replace image' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Remove image' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);

  await brokenCard.getByRole('button', { name: 'Remove' }).click();
  await expect(brokenCard).toHaveCount(0);
  await expect(page.locator('.media-undo')).toBeVisible();
  await page.locator('.media-undo').getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(brokenCard).toBeVisible();

  await brokenCard.getByRole('button', { name: 'Replace' }).click();
  await page.getByLabel('Web address').fill('https://example.com/repaired.svg');
  await page.getByLabel('Web address').press('Enter');
  await expect(brokenCard).toHaveCount(0);
  await expect(page.locator('.note-image[data-note-image-source="assets/import-replaced.svg"]')).toHaveCount(2);

  // Live mode preserves blurred textarea cursor offset when native toolbar opens supermdMedia().
  await page.evaluate(() => {
    window.supermdLoad?.({ id: 'live-cursor', content: '# Notes\n\nInsert here please\n\nFinal line', path: '/notes/live.md', mode: 'live', dark: false, fullscreen: false, colors: {}, font: 'Manrope', size: 15, zoom: 100 });
  });
  await page.getByText('Insert here please').dblclick();
  const textarea = page.getByRole('textbox', { name: 'Edit Markdown block' });
  await expect(textarea).toBeVisible();
  await textarea.evaluate((el: HTMLTextAreaElement) => {
    el.setSelectionRange(7, 7);
    el.dispatchEvent(new Event('select', { bubbles: true }));
    el.blur();
  });
  await expect(textarea).toHaveCount(0);
  await page.evaluate(() => window.supermdMedia?.());
  await page.getByLabel('Web address').fill('https://example.com/field-notes');
  await page.getByRole('button', { name: 'Paste plain URL instead' }).click();
  await expect(page.getByText('Insert https://example.com/field-noteshere please')).toBeVisible();
  await expect(page.getByText('Final line', { exact: true })).toBeVisible();
});
