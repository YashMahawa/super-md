import { expect, test, type Locator, type Page } from '@playwright/test';

async function loadQtNote(
  page: Page,
  content: string,
  overrides: Record<string, unknown> = {},
) {
  await page.addInitScript(() => {
    window.SuperMD = {
      post: (id: string) => {
        window.supermdReply?.(id, true, null);
      },
    };
  });
  await page.setViewportSize({ width: 1100, height: 760 });
  await page.goto('/android-reader.html');
  await page.waitForFunction(() => typeof window.supermdLoad === 'function');
  await page.evaluate(() => {
    document.documentElement.dataset.host = 'qt';
    document.documentElement.dataset.platform = 'desktop';
  });
  await page.evaluate(
    ({ content, overrides }) => {
      window.supermdLoad?.({
        id: 'qt-touchpad-note',
        content,
        path: null,
        mode: 'reader',
        dark: false,
        fullscreen: false,
        centerLock: true,
        colors: {},
        font: 'Manrope',
        size: 16,
        zoom: 100,
        widthPercent: 80,
        restorePosition: false,
        ...overrides,
      });
    },
    { content, overrides },
  );
  await expect(page.locator('.document-page')).toBeVisible();
}

async function centerOf(locator: Locator) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return { x: box!.x + box!.width / 2, y: box!.y + Math.min(80, box!.height / 2) };
}

test('routes Qt touchpad scroll to innermost code blocks and python cells, then chains at boundaries', async ({ page }) => {
  const wideLine = 'const result = ' + Array.from({ length: 32 }, (_, i) => `segment_${i}_value`).join(' + ') + ';';
  const tallPython = Array.from({ length: 48 }, (_, i) => `total_${i} = ${i} * 2  # ${'detail_'.repeat(14)}`).join('\n');
  const filler = ('Paragraph of prose to make the note taller than the viewport. '.repeat(12) + '\n\n').repeat(24);
  const markdown = [
    '# Touchpad Code & Python Routing',
    '',
    '```ts',
    wideLine,
    '```',
    '',
    '```python {.run}',
    tallPython,
    '```',
    '',
    filler,
  ].join('\n');

  await loadQtNote(page, markdown);
  const reading = page.locator('.android-reading');
  const codePre = page.locator('.markdown-body pre:not(.python-source)').first();
  const pySource = page.locator('.python-cell .python-source').first();

  await expect(codePre).toBeVisible();
  await expect(pySource).toBeVisible();

  // 1. Wide fenced code block: horizontal touchpad swipe scrolls <pre>, vertical swipe chains straight to .android-reading.
  const prePoint = await centerOf(codePre);
  await page.evaluate(
    point => window.supermdNativeWheel?.(140, 90, point, false),
    prePoint,
  );
  await expect.poll(() => codePre.evaluate(el => el.scrollLeft)).toBeGreaterThan(100);
  await expect.poll(() => reading.evaluate(el => el.scrollTop)).toBeGreaterThan(60);
  expect(await reading.evaluate(el => el.scrollLeft)).toBe(0);

  // Reset outer scroll so python cell sits cleanly in view.
  await reading.evaluate(el => { el.scrollTop = 0; });
  const pyPoint = await centerOf(pySource);
  const maxPyTop = await pySource.evaluate(el => el.scrollHeight - el.clientHeight);
  expect(maxPyTop).toBeGreaterThan(80);

  // 2. Interior vertical scroll on .python-source moves ONLY .python-source, not .android-reading.
  await page.evaluate(
    point => window.supermdNativeWheel?.(60, 70, point, false),
    pyPoint,
  );
  await expect.poll(() => pySource.evaluate(el => el.scrollTop)).toBeGreaterThan(50);
  await expect.poll(() => pySource.evaluate(el => el.scrollLeft)).toBeGreaterThan(40);
  expect(await reading.evaluate(el => el.scrollTop)).toBe(0);

  // 3. Scrolling past .python-source's bottom boundary chains the remaining distance to .android-reading.
  const freshPyPoint = await centerOf(pySource);
  await page.evaluate(
    ({ point, distance }) => window.supermdNativeWheel?.(0, distance, point, false),
    { point: freshPyPoint, distance: maxPyTop + 180 },
  );
  await expect.poll(() => pySource.evaluate(el => Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop))).toBeLessThanOrEqual(2);
  await expect.poll(() => reading.evaluate(el => el.scrollTop)).toBeGreaterThan(120);
});

test('scrolls wide Markdown tables horizontally under centerLock and chains vertical or zoomed horizontal overflow', async ({ page }) => {
  const headers = Array.from({ length: 14 }, (_, i) => `Column_${i + 1}_Header_Name`).join(' | ');
  const divider = Array.from({ length: 14 }, () => '---').join(' | ');
  const row = Array.from({ length: 14 }, (_, i) => `cell_value_number_${i + 1}_extended`).join(' | ');
  const filler = ('Supporting study notes below the wide data table. '.repeat(12) + '\n\n').repeat(25);
  const markdown = `# Wide Table Scroll\n\n| ${headers} |\n| ${divider} |\n| ${row} |\n| ${row} |\n\n${filler}`;

  await loadQtNote(page, markdown, { centerLock: true });
  const reading = page.locator('.android-reading');
  const table = page.locator('.markdown-body table').first();
  await expect(table).toBeVisible();

  const maxTableLeft = await table.evaluate(el => el.scrollWidth - el.clientWidth);
  expect(maxTableLeft).toBeGreaterThan(120);

  // Diagonal touchpad swipe over table: horizontal scrolls table even with centerLock=true; vertical chains to note.
  const tablePoint = await centerOf(table);
  await page.evaluate(
    point => window.supermdNativeWheel?.(130, 110, point, false),
    tablePoint,
  );
  await expect.poll(() => table.evaluate(el => el.scrollLeft)).toBeGreaterThan(100);
  await expect.poll(() => reading.evaluate(el => el.scrollTop)).toBeGreaterThan(80);
  expect(await reading.evaluate(el => el.scrollLeft)).toBe(0);

  // At 200% zoom with centerLock=false, overscrolling past the table's right edge chains leftover dx to .android-reading.
  await reading.evaluate(el => { el.scrollTop = 0; });
  await table.evaluate(el => { el.scrollLeft = 0; });
  await page.evaluate(() => {
    window.supermdLoad?.({
      id: 'qt-touchpad-note',
      content: '',
      contentUnchanged: true,
      path: null,
      mode: 'reader',
      dark: false,
      fullscreen: false,
      centerLock: false,
      colors: {},
      font: 'Manrope',
      size: 16,
      zoom: 200,
      widthPercent: 80,
      restorePosition: false,
    } as any);
    window.supermdSetZoom?.(200);
  });
  await expect(page.locator('.document-page')).toHaveAttribute('data-scale', '2');

  const zoomedTablePoint = await centerOf(table);
  const readingLeftBefore = await reading.evaluate(el => el.scrollLeft);
  const zoomedMaxLeft = await table.evaluate(el => el.scrollWidth - el.clientWidth);
  // Send screen delta = zoomedMaxLeft * 2 (consumes full table width at scale=2) + 90px extra to chain to .android-reading.
  await page.evaluate(
    ({ point, dx }) => window.supermdNativeWheel?.(dx, 0, point, false),
    { point: zoomedTablePoint, dx: zoomedMaxLeft * 2 + 90 },
  );
  await expect.poll(() => table.evaluate(el => Math.abs(el.scrollWidth - el.clientWidth - el.scrollLeft))).toBeLessThanOrEqual(2);
  await expect.poll(() => reading.evaluate(el => el.scrollLeft)).toBeGreaterThan(readingLeftBefore + 50);
});

test('routes inline and fullscreen study step-cards regions and preserves note zoom over code, table, and study blocks', async ({ page }) => {
  const stepNotes = [
    '```py',
    'gradient_step = ' + Array.from({ length: 22 }, (_, i) => `term_${i}`).join(' + '),
    '```',
    '',
    ...Array.from(
      { length: 28 },
      (_, i) => `- Step study bullet ${i + 1}: important derivation context that makes the study notes panel scrollable.`,
    ),
  ].join('\n');
  const deck = {
    title: 'Derivation Walkthrough',
    steps: [
      {
        label: 'Step 1: Setup',
        diagram: {
          width: 240,
          height: 180,
          nodes: [
            { id: 'a', label: 'Input', x: 60, y: 90 },
            { id: 'b', label: 'Update', x: 180, y: 90 },
          ],
          edges: [{ from: 'a', to: 'b', label: 'grad' }],
        },
        markdown: stepNotes,
      },
      {
        label: 'Step 2: Converge',
        diagram: {
          width: 240,
          height: 180,
          nodes: [{ id: 'c', label: 'Optimum', x: 120, y: 90 }],
          edges: [],
        },
        markdown: 'Converged at stationary point.',
      },
    ],
  };
  const filler = ('Additional lecture prose after the interactive study step deck. '.repeat(12) + '\n\n').repeat(24);
  const markdown = [
    '# Study Deck & Note Zoom',
    '',
    '```js',
    'const studyExample = "' + 'long_token_'.repeat(30) + '";',
    '```',
    '',
    '| Metric | ' + Array.from({ length: 10 }, (_, i) => `Series_${i}`).join(' | ') + ' |',
    '| --- | ' + Array.from({ length: 10 }, () => '---').join(' | ') + ' |',
    '| Value | ' + Array.from({ length: 10 }, (_, i) => `measurement_${i}_wide`).join(' | ') + ' |',
    '',
    '```smd-steps',
    JSON.stringify(deck),
    '```',
    '',
    filler,
  ].join('\n');

  await loadQtNote(page, markdown, { mode: 'live' });
  const reading = page.locator('.android-reading');
  const inlineNotes = page.locator('.step-cards .step-cards-notes').first();
  await inlineNotes.scrollIntoViewIfNeeded();
  const baseReadingTop = await reading.evaluate(el => el.scrollTop);
  const maxNotesTop = await inlineNotes.evaluate(el => el.scrollHeight - el.clientHeight);
  expect(maxNotesTop).toBeGreaterThan(60);

  // 1. Touchpad scroll inside inline .step-cards-notes scrolls study notes first without moving .android-reading.
  const notesPoint = await centerOf(inlineNotes);
  await page.evaluate(
    point => window.supermdNativeWheel?.(0, 50, point, false),
    notesPoint,
  );
  await expect.poll(() => inlineNotes.evaluate(el => el.scrollTop)).toBeGreaterThan(35);
  expect(Math.abs((await reading.evaluate(el => el.scrollTop)) - baseReadingTop)).toBeLessThanOrEqual(2);

  // 2. Reaching the bottom of inline .step-cards-notes chains remaining downward movement to .android-reading.
  await page.evaluate(
    ({ point, dy }) => window.supermdNativeWheel?.(0, dy, point, false),
    { point: notesPoint, dy: maxNotesTop + 160 },
  );
  await expect.poll(() => inlineNotes.evaluate(el => Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop))).toBeLessThanOrEqual(2);
  await expect.poll(() => reading.evaluate(el => el.scrollTop)).toBeGreaterThan(baseReadingTop + 90);

  // 3. Fullscreen enlarged .step-viewer routes nested code -> .step-cards-notes and stops at modal boundary.
  await inlineNotes.scrollIntoViewIfNeeded();
  const readingBeforeModal = await reading.evaluate(el => el.scrollTop);
  await page.getByRole('button', { name: 'Enlarge slide' }).click();
  const modalNotes = page.locator('.step-viewer .step-cards-notes');
  const modalPre = modalNotes.locator('pre').first();
  await expect(modalNotes).toBeVisible();
  await expect(modalPre).toBeVisible();
  const modalPrePoint = await centerOf(modalPre);
  await page.evaluate(
    point => window.supermdNativeWheel?.(90, 900, point, false),
    modalPrePoint,
  );
  await expect.poll(() => modalPre.evaluate(el => el.scrollLeft)).toBeGreaterThan(50);
  await expect.poll(() => modalNotes.evaluate(el => el.scrollTop)).toBeGreaterThan(60);
  expect(Math.abs((await reading.evaluate(el => el.scrollTop)) - readingBeforeModal)).toBeLessThanOrEqual(2);
  await page.getByRole('button', { name: 'Close slide viewer' }).click();
  await expect(page.locator('.step-viewer')).toHaveCount(0);

  // 4. Note zoom (Ctrl+wheel and trackpad pinch) over study cards, tables, and code blocks zooms the note without scrolling them!
  await reading.evaluate(el => { el.scrollTop = 0; });
  await inlineNotes.evaluate(el => { el.scrollTop = 0; });
  const codePre = page.locator('.markdown-body pre').first();
  const table = page.locator('.markdown-body table').first();

  const codePoint = await centerOf(codePre);
  await page.evaluate(
    point => window.supermdNativeWheel?.(0, -120, point, true, true),
    codePoint,
  );
  await expect.poll(() => page.locator('.document-page').evaluate(el => Number((el as HTMLElement).dataset.scale))).toBeGreaterThan(1.2);
  expect(await codePre.evaluate(el => el.scrollLeft)).toBe(0);

  const scaleAfterCodeZoom = await page.locator('.document-page').evaluate(el => Number((el as HTMLElement).dataset.scale));
  const tablePoint = await centerOf(table);
  // Native pinch via ReaderGestures passes held=true (4th arg) without modifier.
  await page.evaluate(
    point => window.supermdNativeWheel?.(0, -100, point, true),
    tablePoint,
  );
  await expect.poll(() => page.locator('.document-page').evaluate(el => Number((el as HTMLElement).dataset.scale))).toBeGreaterThan(scaleAfterCodeZoom + 0.15);
  expect(await table.evaluate(el => el.scrollLeft)).toBe(0);

  await inlineNotes.scrollIntoViewIfNeeded();
  const studyZoomPoint = await centerOf(inlineNotes);
  const scaleBeforeStudyZoom = await page.locator('.document-page').evaluate(el => Number((el as HTMLElement).dataset.scale));
  await page.evaluate(
    point => window.supermdNativeWheel?.(0, 140, point, true, true),
    studyZoomPoint,
  );
  await expect.poll(() => page.locator('.document-page').evaluate(el => Number((el as HTMLElement).dataset.scale))).toBeLessThan(scaleBeforeStudyZoom - 0.15);
  expect(await inlineNotes.evaluate(el => el.scrollTop)).toBe(0);
});
