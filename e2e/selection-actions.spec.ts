import { test, expect } from '@playwright/test';

test('source-aware selection extraction matches Copy across reader, live, and split modes and yields media menus while text is selected', async ({ page }) => {
  await page.addInitScript(() => {
    window.SuperMD = {
      post: (id, command) => {
        const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="100"><rect width="240" height="100" fill="#4f7cac"/></svg>';
        const result = command === 'load_asset' ? 'data:image/svg+xml;base64,' + btoa(svg) : true;
        queueMicrotask(() => window.supermdReply?.(id, result, null));
      },
    };
  });

  await page.goto('/android-reader.html');
  await page.waitForFunction(() => typeof window.supermdLoad === 'function');

  const content = [
    '# Probability & Norms',
    '',
    'Conditional law $P(A|B) = \\frac{P(A \\cap B)}{P(B)}$ and norm $|x|$.',
    '',
    '| Form | Bound | Code | Literal |',
    '| --- | --- | --- | --- |',
    '| $P(A|B)$ | $|x| + |y|$ | `a \\| b` | Heads \\| tails |',
    '| $\\alpha_1$ | $|z|$ | `c \\| d` | Left \\| right |',
    '',
    '![Sample](assets/sample.svg)',
    '',
    '```svg',
    '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="140" viewBox="0 0 320 140"><rect width="320" height="140" fill="#1688dd"/></svg>',
    '```',
    '',
  ].join('\n');

  const loadMode = async (mode: 'reader' | 'live' | 'split') => {
    await page.evaluate(({ mode, content }) => {
      window.supermdLoad?.({
        id: `sel-${mode}`,
        path: '/notes/prob.md',
        content,
        mode,
        dark: false,
        fullscreen: false,
        colors: {},
        font: 'Manrope',
        size: 16,
        zoom: 100,
        restorePosition: false,
      });
    }, { mode, content });
    await expect(page.locator(`.android-document.mode-${mode}`)).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
  };

  const mediaMenu = page.getByRole('menu', { name: 'Save image or diagram' });

  // 1. Reader mode: math extraction (no duplicated KaTeX glyphs) + full & partial table serialization
  await loadMode('reader');
  const diagram = page.locator('.mode-reader .svg-diagram');
  await expect(diagram).toBeVisible();
  await expect(page.locator('.mode-reader .note-image:not(.image-loading) img')).toBeVisible();

  const mathSelected = await page.evaluate(() => {
    const p = document.querySelector('.mode-reader .markdown-body p')!;
    const r = document.createRange();
    r.selectNodeContents(p);
    const s = window.getSelection()!;
    s.removeAllRanges();
    s.addRange(r);
    let copied = '';
    const onCopy = (e: ClipboardEvent) => {
      copied = e.clipboardData?.getData('text/plain') || '';
    };
    document.addEventListener('copy', onCopy, { once: true });
    const dt = new DataTransfer();
    p.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: dt }));
    copied = dt.getData('text/plain');
    return { extracted: window.supermdSelectedText?.(), copied };
  });
  expect(mathSelected.extracted).toBe('Conditional law $P(A|B) = \\frac{P(A \\cap B)}{P(B)}$ and norm $|x|$.');
  expect(mathSelected.extracted).toBe(mathSelected.copied);

  // While text is selected, right-clicking diagram yields media save menu and preserves selection
  await diagram.scrollIntoViewIfNeeded();
  const dbox = (await diagram.boundingBox())!;
  expect(await page.evaluate(({ x, y }) => window.supermdMediaMenuAt?.(x, y), { x: dbox.x + dbox.width / 2, y: dbox.y + dbox.height / 2 })).toBe(false);
  await diagram.click({ button: 'right' });
  await expect(mediaMenu).toHaveCount(0);
  expect(await page.evaluate(() => window.supermdSelectedText?.())).toBe('Conditional law $P(A|B) = \\frac{P(A \\cap B)}{P(B)}$ and norm $|x|$.');

  // Partial table selection (first body row only) preserves math & code pipes and escapes literal pipe
  const partialRow = await page.evaluate(() => {
    const firstBodyRow = document.querySelector('.mode-reader .markdown-body tbody tr')!;
    const r = document.createRange();
    r.selectNodeContents(firstBodyRow);
    const s = window.getSelection()!;
    s.removeAllRanges();
    s.addRange(r);
    return window.supermdSelectedText?.();
  });
  expect(partialRow).toBe('| $P(A|B)$ | $|x| + |y|$ | `a | b` | Heads \\| tails |\n| --- | --- | --- | --- |');

  // Clear selection -> right-clicking diagram now opens media save menu
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await diagram.click({ button: 'right' });
  await expect(mediaMenu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(mediaMenu).toHaveCount(0);

  // 2. Live mode: rendered selection + yielding .note-image inline tools, plus raw <textarea> block selection
  await loadMode('live');
  const liveImage = page.locator('.mode-live .live-document .note-image');
  await expect(page.locator('.mode-live .live-document .note-image:not(.image-loading) img')).toBeVisible();
  await expect(page.locator('.mode-live .live-document p').first()).toBeVisible();
  await page.evaluate(() => {
    const p = document.querySelector('.mode-live .live-document p')!;
    const r = document.createRange();
    r.selectNodeContents(p);
    const s = window.getSelection()!;
    s.removeAllRanges();
    s.addRange(r);
  });
  await liveImage.click({ button: 'right' });
  await expect(mediaMenu).toHaveCount(0);
  await expect(page.locator('.image-edit-tools')).toHaveCount(0);
  expect(await page.evaluate(() => window.supermdSelectedText?.())).toBe('Conditional law $P(A|B) = \\frac{P(A \\cap B)}{P(B)}$ and norm $|x|$.');

  // Clearing selection allows right-clicking .note-image in live mode to open the media menu
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await liveImage.click({ button: 'right' });
  await expect(mediaMenu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(mediaMenu).toHaveCount(0);

  // Double-clicking a rendered paragraph in live mode activates its raw <textarea>; selecting inside it extracts raw source
  await page.locator('.mode-live .live-block p').first().dblclick();
  const textarea = page.getByRole('textbox', { name: 'Edit Markdown block' });
  await expect(textarea).toBeVisible();
  const liveRaw = await textarea.evaluate((el: HTMLTextAreaElement) => {
    el.focus();
    const start = el.value.indexOf('$P(A|B)');
    el.setSelectionRange(start, el.value.length);
    return window.supermdSelectedText?.();
  });
  expect(liveRaw).toBe('$P(A|B) = \\frac{P(A \\cap B)}{P(B)}$ and norm $|x|$.');

  // 3. Split mode: preview selection AND CodeMirror .cm-editor selection
  await loadMode('split');
  await expect(page.locator('.mode-split .cm-editor')).toBeVisible();
  await expect(page.locator('.mode-split .markdown-body p').first()).toBeVisible();
  await expect(page.locator('.mode-split .note-image:not(.image-loading) img')).toBeVisible();

  const splitPreview = await page.evaluate(() => {
    const p = document.querySelector('.mode-split .markdown-body p')!;
    const r = document.createRange();
    r.selectNodeContents(p);
    const s = window.getSelection()!;
    s.removeAllRanges();
    s.addRange(r);
    return window.supermdSelectedText?.();
  });
  expect(splitPreview).toBe('Conditional law $P(A|B) = \\frac{P(A \\cap B)}{P(B)}$ and norm $|x|$.');

  // Select text inside CodeMirror editor via keyboard after focusing .cm-content
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await page.locator('.mode-split .cm-line').first().click();
  await expect(page.locator('.mode-split .cm-content')).toBeFocused();
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+End');
  const cmSelected = await page.evaluate(() => window.supermdSelectedText?.());
  expect(cmSelected).toBe('# Probability & Norms');
});
