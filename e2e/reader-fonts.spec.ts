import { expect, test } from '@playwright/test';

const FONT_REQUEST_RE = /\.(?:woff2?|ttf|otf|eot)(?:$|[?#])/i;
const LEGACY_FONT_REQUEST_RE = /\.(?:woff|ttf)(?:$|[?#])/i;

const BUILTIN_PRESETS = [
  { preset: 'Manrope', alias: 'sans', family: 'Manrope Variable', hasDedicatedItalicFace: false },
  { preset: 'JetBrains Mono', alias: 'mono', family: 'JetBrains Mono Variable', hasDedicatedItalicFace: true },
  { preset: 'Roboto', alias: 'roboto', family: 'Roboto Variable', hasDedicatedItalicFace: true },
  { preset: 'Noto Serif', alias: 'serif', family: 'Noto Serif Variable', hasDedicatedItalicFace: true },
  { preset: 'Noto Sans', alias: 'noto', family: 'Noto Sans Variable', hasDedicatedItalicFace: true },
] as const;

test.beforeEach(async ({ page }) => {
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith('http://127.0.0.1:1420/') || url.startsWith('data:') || url.startsWith('blob:')) {
      await route.continue();
      return;
    }
    await route.abort();
  });
  await page.addInitScript(() => {
    window.SuperMD = {
      post: (id) => queueMicrotask(() => window.supermdReply?.(id, true, null)),
    };
  });
});

test('default Manrope preset loads only the variable WOFF2 face without duplicate static requests', async ({ page }) => {
  const fontRequests: string[] = [];
  page.on('request', (req) => {
    if (FONT_REQUEST_RE.test(req.url())) fontRequests.push(req.url());
  });

  await page.goto('/android-reader.html');
  await page.waitForFunction(() => typeof window.supermdLoad === 'function');

  await page.evaluate(() => {
    window.supermdLoad?.({
      id: 'default-manrope',
      path: null,
      content: '# Default Typography\n\nOpening a clean note loads only the variable Manrope WOFF2 face with **bold weight** and *slanted emphasis*.',
      mode: 'reader',
      dark: false,
      fullscreen: false,
      colors: {},
      font: 'Manrope',
      size: 16,
      zoom: 100,
    });
  });

  await expect(page.getByRole('heading', { name: 'Default Typography' })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);

  const loadedFaces = await page.evaluate(() =>
    Array.from(document.fonts)
      .filter((face) => face.status === 'loaded')
      .map((face) => ({
        family: face.family.replace(/^["']|["']$/g, ''),
        style: face.style,
        weight: face.weight,
      })),
  );

  expect(loadedFaces).toEqual([
    {
      family: 'Manrope Variable',
      style: 'normal',
      weight: '200 800',
    },
  ]);

  expect(fontRequests.length).toBe(1);
  expect(fontRequests[0]).toMatch(/manrope-latin-wght-normal\.woff2(?:$|\?)/i);
  expect(fontRequests.filter((url) => LEGACY_FONT_REQUEST_RE.test(url))).toEqual([]);

  const bodyFont = await page.locator('.markdown-body').evaluate((el) => getComputedStyle(el).fontFamily);
  expect(bodyFont).toMatch(/^"?Manrope Variable"?/);

  await page.evaluate(() => window.supermdFind?.());
  await expect(page.locator('.reading-search')).toBeVisible();
  const searchFont = await page.locator('.reading-search').evaluate((el) => getComputedStyle(el).fontFamily);
  expect(searchFont).toMatch(/^"?Manrope Variable"?/);
});

test('all built-in native reader presets render normal, bold, and italic text offline via variable WOFF2 fonts', async ({
  context,
  page,
}) => {
  const fontResponses: Array<{ url: string; status: number }> = [];
  page.on('response', (res) => {
    if (FONT_REQUEST_RE.test(res.url())) {
      fontResponses.push({ url: res.url(), status: res.status() });
    }
  });

  await page.goto('/android-reader.html');
  await page.waitForFunction(() => typeof window.supermdLoad === 'function');

  const sampleMarkdown = [
    '# Typography Preset Verification',
    '',
    'Normal body prose with **bold weight** and *italic emphasis*.',
    '',
    '```ts',
    'export const variableFont = "JetBrains Mono Variable";',
    '```',
  ].join('\n');

  for (const { preset, alias, family, hasDedicatedItalicFace } of BUILTIN_PRESETS) {
    for (const selected of [preset, alias]) {
      await page.evaluate(
        ({ id, font, content }) => {
          window.supermdLoad?.({
            id,
            path: null,
            content,
            mode: 'reader',
            dark: false,
            fullscreen: false,
            colors: {},
            font,
            size: 17,
            zoom: 100,
          });
        },
        { id: `preset-${selected}`, font: selected, content: sampleMarkdown },
      );

      await expect(page.locator('.markdown-body strong')).toBeVisible();
      await page.evaluate(() => document.fonts.ready);

      const metrics = await page.evaluate((expectedFamily) => {
        const body = document.querySelector<HTMLElement>('.markdown-body')!;
        const normal = document.querySelector<HTMLElement>('.markdown-body p')!;
        const bold = document.querySelector<HTMLElement>('.markdown-body strong')!;
        const italic = document.querySelector<HTMLElement>('.markdown-body em')!;
        const loaded = Array.from(document.fonts)
          .filter((f) => f.status === 'loaded')
          .map((f) => ({
            family: f.family.replace(/^["']|["']$/g, ''),
            style: f.style,
            weight: f.weight,
          }));
        return {
          computedFamily: getComputedStyle(body).fontFamily,
          normalWeight: getComputedStyle(normal).fontWeight,
          boldWeight: getComputedStyle(bold).fontWeight,
          italicStyle: getComputedStyle(italic).fontStyle,
          normalWidth: normal.getBoundingClientRect().width,
          boldWidth: bold.getBoundingClientRect().width,
          italicWidth: italic.getBoundingClientRect().width,
          checkNormal: document.fonts.check(`400 17px "${expectedFamily}"`),
          checkBold: document.fonts.check(`700 17px "${expectedFamily}"`),
          checkItalic: document.fonts.check(`italic 400 17px "${expectedFamily}"`),
          loaded,
        };
      }, family);

      expect(metrics.computedFamily.replace(/^["']/, '')).toMatch(new RegExp(`^${family}\\b`));
      expect(metrics.normalWeight).toBe('400');
      expect(Number(metrics.boldWeight)).toBeGreaterThanOrEqual(600);
      expect(metrics.italicStyle).toBe('italic');
      expect(metrics.normalWidth).toBeGreaterThan(20);
      expect(metrics.boldWidth).toBeGreaterThan(20);
      expect(metrics.italicWidth).toBeGreaterThan(20);
      expect(metrics.checkNormal).toBe(true);
      expect(metrics.checkBold).toBe(true);
      expect(metrics.checkItalic).toBe(true);
      expect(metrics.loaded.some((face) => face.family === family && face.style === 'normal')).toBe(true);
      if (hasDedicatedItalicFace) {
        expect(metrics.loaded.some((face) => face.family === family && face.style === 'italic')).toBe(true);
      }
    }
  }

  expect(fontResponses.length).toBeGreaterThanOrEqual(9);
  for (const response of fontResponses) {
    expect(response.status).toBe(200);
    expect(response.url).toMatch(/\.woff2(?:$|\?)/i);
    expect(response.url).not.toMatch(LEGACY_FONT_REQUEST_RE);
  }

  await context.setOffline(true);
  try {
    for (const { preset, family } of BUILTIN_PRESETS) {
      await page.evaluate(
        ({ font, content }) => {
          window.supermdLoad?.({
            id: `offline-${font}`,
            path: null,
            content,
            mode: 'reader',
            dark: true,
            fullscreen: false,
            colors: {},
            font,
            size: 17,
            zoom: 100,
          });
        },
        { font: preset, content: sampleMarkdown },
      );
      await page.evaluate(() => document.fonts.ready);
      const offlineCheck = await page.evaluate((expectedFamily) => ({
        online: navigator.onLine,
        family: getComputedStyle(document.querySelector('.markdown-body')!).fontFamily,
        ready: document.fonts.check(`700 17px "${expectedFamily}"`),
      }), family);
      expect(offlineCheck.online).toBe(false);
      expect(offlineCheck.family.replace(/^["']/, '')).toMatch(new RegExp(`^${family}\\b`));
      expect(offlineCheck.ready).toBe(true);
    }
  } finally {
    await context.setOffline(false);
  }
});

test('mathematical expressions render all symbol families offline using .woff2 math fonts without missing-glyph fallbacks', async ({
  context,
  page,
}) => {
  const fontRequests: string[] = [];
  page.on('request', (req) => {
    if (FONT_REQUEST_RE.test(req.url())) fontRequests.push(req.url());
  });

  await page.goto('/android-reader.html');
  await page.waitForFunction(() => typeof window.supermdLoad === 'function');

  const mathMarkdown = [
    '# Mathematical Typography',
    '',
    'Inline Euler identity $e^{i\\pi} + 1 = 0$ and partial derivative $\\frac{\\partial \\mathcal{L}}{\\partial \\theta}$.',
    '',
    '$$\\int_{-\\infty}^{\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi}, \\qquad \\sum_{n=1}^{\\infty} \\frac{1}{n^2} = \\frac{\\pi^2}{6}$$',
    '',
    '$$\\mathbb{R} \\oplus \\mathbb{Z} \\otimes \\hbar, \\quad \\mathcal{F}\\{f(t)\\}, \\quad \\mathfrak{g} \\oplus \\mathfrak{su}(2), \\quad \\mathsf{A}^\\top \\mathsf{x}, \\quad \\mathtt{0xCAFE}, \\quad \\mathscr{H}(\\psi)$$',
    '',
    '$$\\left(\\begin{matrix} \\alpha & \\beta & \\gamma \\\\ \\delta & \\epsilon & \\zeta \\\\ \\eta & \\theta & \\iota \\end{matrix}\\right) \\cdot \\left\\lfloor \\frac{\\left\\lceil \\bigoplus_{k=1}^{N} x_k \\right\\rceil}{2} \\right\\rfloor$$',
  ].join('\n');

  await page.evaluate((content) => {
    window.supermdLoad?.({
      id: 'math-woff2',
      path: null,
      content,
      mode: 'reader',
      dark: false,
      fullscreen: false,
      colors: {},
      font: 'Noto Serif',
      size: 16,
      zoom: 100,
    });
  }, mathMarkdown);

  await expect(page.locator('.katex')).toHaveCount(5);
  await expect(page.locator('.katex-error')).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);

  const mathAudit = await page.evaluate(() => {
    const loadedFamilies = Array.from(
      new Set(
        Array.from(document.fonts)
          .filter((face) => face.status === 'loaded')
          .map((face) => face.family.replace(/^["']|["']$/g, '')),
      ),
    ).sort();
    const errorColoredNodes = Array.from(document.querySelectorAll<HTMLElement>('.katex *')).filter(
      (node) => getComputedStyle(node).color === 'rgb(204, 0, 0)',
    ).length;
    const zeroSizedMath = Array.from(document.querySelectorAll<HTMLElement>('.katex')).filter((node) => {
      const rect = node.getBoundingClientRect();
      return rect.width <= 0 || rect.height <= 0;
    }).length;
    return { loadedFamilies, errorColoredNodes, zeroSizedMath };
  });

  expect(mathAudit.errorColoredNodes).toBe(0);
  expect(mathAudit.zeroSizedMath).toBe(0);
  for (const requiredFamily of [
    'KaTeX_AMS',
    'KaTeX_Caligraphic',
    'KaTeX_Fraktur',
    'KaTeX_Main',
    'KaTeX_Math',
    'KaTeX_SansSerif',
    'KaTeX_Script',
    'KaTeX_Typewriter',
  ]) {
    expect(mathAudit.loadedFamilies).toContain(requiredFamily);
  }
  expect(mathAudit.loadedFamilies.some((family) => family.startsWith('KaTeX_Size'))).toBe(true);

  const katexRequests = fontRequests.filter((url) => /KaTeX_/i.test(url));
  expect(katexRequests.length).toBeGreaterThanOrEqual(8);
  for (const url of fontRequests) {
    expect(url).toMatch(/\.woff2(?:$|\?)/i);
    expect(url).not.toMatch(LEGACY_FONT_REQUEST_RE);
  }

  await context.setOffline(true);
  try {
    await page.evaluate(() => {
      window.supermdLoad?.({
        id: 'math-offline-reload',
        path: null,
        content: '$$\\forall x \\in \\mathbb{R},\\; \\mathcal{N}(x\\mid 0,1) = \\frac{1}{\\sqrt{2\\pi}} e^{-x^2/2}$$',
        mode: 'reader',
        dark: false,
        fullscreen: false,
        colors: {},
        font: 'Noto Serif',
        size: 16,
        zoom: 100,
      });
    });
    await expect(page.locator('.katex')).toHaveCount(1);
    await expect(page.locator('.katex-error')).toHaveCount(0);
  } finally {
    await context.setOffline(false);
  }
});
