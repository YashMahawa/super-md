import {expect,test} from '@playwright/test';

const tableMarkdown=String.raw`| Test | Assumptions | Statistic | Degrees of freedom | Decision |
|---|---|---|---|---|
| Goodness-of-Fit (Counts) | $k$ categories, claimed $p_i$, all $E_i\ge5$ | $\chi^2=\sum\frac{(O_i-E_i)^2}{E_i}$ | $\chi^2_{k-1-m}$ | Right-tailed rejection only ($\chi^2>\chi^2_{df,1-\alpha}$) |
| **Independence (Contingency)** | $r\times c$ table, $E_{ij}=\frac{\text{Row}\times\text{Col}}{N}$ | $\chi^2=\sum\sum\dfrac{(O_{ij}-E_{ij})^2}{E_{ij}}$ | $\chi^2_{(r-1)(c-1)}$ | Right-tailed rejection only ($\chi^2>\chi^2_{df,1-\alpha}$) |`;

for(const mode of ['reader','live'] as const)for(const width of [375,520])test(`long labels and math stay inside their table cells in ${mode} at ${width}px`,async({page})=>{
  await page.setViewportSize({width,height:900});
  await page.addInitScript(()=>{window.SuperMD={post:()=>{}};});
  await page.goto('/android-reader.html');
  await page.waitForFunction(()=>typeof window.supermdLoad==='function');
  await page.evaluate(({mode,content})=>window.supermdLoad?.({id:`table-overlap-${mode}`,path:null,content,mode,dark:false,fullscreen:false,colors:{},font:'Manrope',size:16,zoom:100}),{mode,content:tableMarkdown});
  const table=page.locator('.markdown-body table');await expect(table).toBeVisible();
  await expect(table.locator('.katex')).toHaveCount(11);
  const overlaps=await table.evaluate(node=>{
    const offenders:{cell:string;text:string;spill:number}[]=[];
    for(const cell of Array.from(node.querySelectorAll('th,td'))){
      const box=cell.getBoundingClientRect(),walker=document.createTreeWalker(cell,NodeFilter.SHOW_TEXT);let text:Node|null;
      while((text=walker.nextNode())){
        if(text.parentElement?.closest('.katex-mathml'))continue;
        const range=document.createRange();range.selectNodeContents(text);
        for(const rect of Array.from(range.getClientRects()))if(rect.width>1&&rect.right>box.right+1)offenders.push({cell:cell.textContent?.trim()||'',text:text.textContent||'',spill:rect.right-box.right});
      }
    }
    return offenders;
  });
  expect(overlaps).toEqual([]);
});

function countDistinctPixels(a: Buffer, b: Buffer): number {
  const len = Math.min(a.length, b.length);
  let diff = 0;
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) diff++;
  }
  return diff + Math.abs(a.length - b.length);
}

test('compact tables shrink-wrap without empty width while preserving semantics and wide-table overflow across Read, Live, and Split', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 860 });
  await page.addInitScript(() => {
    window.SuperMD = {
      post: (id: string) => {
        window.supermdReply?.(id, true, null);
      },
    };
  });
  await page.goto('/android-reader.html');
  await page.waitForFunction(() => typeof window.supermdLoad === 'function');

  const compactTable = [
    '| Key | Value |',
    '| --- | --- |',
    '| alpha | 1 |',
    '| beta | 2 |',
  ].join('\n');

  const wrappingProseTable = [
    '| Concept | Detailed Study Explanation |',
    '| --- | --- |',
    '| Conditional probability | Updates the plausible weight of an event after observing new experimental evidence across repeated trials in the sample space. |',
  ].join('\n');

  const mediumSplitOverflowTable = [
    '| Metric_A | Metric_B | Metric_C | Metric_D | Metric_E | Metric_F |',
    '| --- | --- | --- | --- | --- | --- |',
    '| 10.42 | 20.18 | 30.77 | 40.91 | 50.05 | 60.64 |',
  ].join('\n');

  const wideTable = [
    '| ' + Array.from({ length: 12 }, (_, i) => `Column_${i + 1}_Header`).join(' | ') + ' |',
    '| ' + Array.from({ length: 12 }, () => '---').join(' | ') + ' |',
    '| ' + Array.from({ length: 12 }, (_, i) => `wide_cell_payload_${i + 1}`).join(' | ') + ' |',
  ].join('\n');

  const content = [
    '# Table Width & Semantics Check',
    '',
    compactTable,
    '',
    wrappingProseTable,
    '',
    mediumSplitOverflowTable,
    '',
    wideTable,
  ].join('\n');

  for (const mode of ['reader', 'live', 'split'] as const) {
    await page.evaluate(
      ({ mode, content }) =>
        window.supermdLoad?.({
          id: 'table-width-modes',
          path: null,
          content,
          mode,
          dark: false,
          fullscreen: false,
          centerLock: true,
          colors: {},
          font: 'Manrope',
          size: 16,
          zoom: 100,
          widthPercent: 85,
          motion: false,
        }),
      { mode, content },
    );

    const tables = page.locator('.android-reading .markdown-body table');
    await expect(tables).toHaveCount(4);

    // Native HTML table semantics remain intact across all modes.
    await expect(page.locator('.android-reading').getByRole('table')).toHaveCount(4);
    const firstSemanticTable = page.locator('.android-reading').getByRole('table').first();
    await expect(firstSemanticTable.getByRole('columnheader')).toHaveCount(2);
    await expect(firstSemanticTable.getByRole('row')).toHaveCount(3);
    await expect(firstSemanticTable.getByRole('cell')).toHaveCount(4);

    const metrics = await page.evaluate(() => {
      const reading = document.querySelector<HTMLElement>('.android-reading')!;
      const allTables = Array.from(reading.querySelectorAll<HTMLElement>('.markdown-body table'));
      return {
        readingOverflowX: reading.scrollWidth - reading.clientWidth,
        items: allTables.map(tb => {
          const body = tb.closest<HTMLElement>('.markdown-body')!;
          const rect = tb.getBoundingClientRect();
          const bodyRect = body.getBoundingClientRect();
          const lastHeader = tb.querySelector<HTMLElement>('thead tr th:last-child')!;
          const lastHeaderRect = lastHeader.getBoundingClientRect();
          return {
            width: rect.width,
            bodyWidth: bodyRect.width,
            rightGap: Math.abs(rect.right - lastHeaderRect.right),
            overflowX: tb.scrollWidth - tb.clientWidth,
          };
        }),
      };
    });

    const [compact, prose, medium, wide] = metrics.items;
    // 1. Compact 2-column table shrinks tightly to its cells without empty trailing width.
    expect(compact.width).toBeLessThan(compact.bodyWidth * 0.55);
    expect(compact.rightGap).toBeLessThanOrEqual(2);
    expect(compact.overflowX).toBeLessThanOrEqual(1);

    // 2. Long prose table clamps to max-width: 100% and wraps cleanly instead of overflowing.
    expect(prose.width).toBeLessThanOrEqual(prose.bodyWidth + 1);
    expect(prose.width).toBeGreaterThan(prose.bodyWidth * 0.85);
    expect(prose.overflowX).toBeLessThanOrEqual(1);

    // 3. 6-column table fits in full-width Read/Live, then visibly overflows horizontally in narrower Split preview.
    if (mode === 'split') {
      expect(medium.overflowX).toBeGreaterThan(40);
    } else {
      expect(medium.overflowX).toBeLessThanOrEqual(1);
      expect(medium.rightGap).toBeLessThanOrEqual(2);
    }

    // 4. Wide 12-column table overflows horizontally inside the table container without breaking outer centerLock.
    expect(wide.overflowX).toBeGreaterThan(150);
    expect(metrics.readingOverflowX).toBeLessThanOrEqual(1);
  }
});

test('extends Qt native scroll indicators to visibly overflowing table and code regions in Read, Live, and Split without altering wheel chaining or zoom', async ({ playwright, baseURL }, testInfo) => {
  const browser = await playwright.chromium.launch({
    ...testInfo.project.use.launchOptions,
    headless: true,
    ignoreDefaultArgs: ['--hide-scrollbars'],
  });
  const context = await browser.newContext({ baseURL, viewport: { width: 1240, height: 860 } });
  const page = await context.newPage();
  try {
    await page.addInitScript(() => {
      window.SuperMD = {
        post: (id: string) => {
          window.supermdReply?.(id, true, null);
        },
      };
    });
    await page.goto('/android-reader.html');
    await page.waitForFunction(() => typeof window.supermdLoad === 'function');
    await page.evaluate(async () => {
      document.documentElement.dataset.host = 'qt';
      document.documentElement.dataset.platform = 'desktop';
      // @ts-expect-error Vite serves this source module directly during E2E runs.
      const { installScrollIndicators } = await import('/src/scrollIndicators.ts');
      installScrollIndicators();
    });

    const compactTable = '| Key | Val |\n| --- | --- |\n| k1 | v1 |';
    const wideHeaders = Array.from({ length: 13 }, (_, i) => `Field_${i + 1}_Label`).join(' | ');
    const wideSep = Array.from({ length: 13 }, () => '---').join(' | ');
    const wideRow = Array.from({ length: 13 }, (_, i) => `record_entry_${i + 1}_wide`).join(' | ');
    const shortCode = 'const ok = true;';
    const wideCode = 'const pipeline = ' + Array.from({ length: 28 }, (_, i) => `stage_${i}_output`).join(' + ') + ';';
    const tallWidePython = Array.from(
      { length: 46 },
      (_, i) => `series_${i} = ${i} * 4  # ${'overflow_check_'.repeat(12)}`,
    ).join('\n');
    const filler = ('Paragraph below nested scroll regions to keep outer reading pane scrollable. '.repeat(10) + '\n\n').repeat(20);

    const markdown = [
      '# Nested Scroll Indicators Across Modes',
      '',
      compactTable,
      '',
      `| ${wideHeaders} |`,
      `| ${wideSep} |`,
      `| ${wideRow} |`,
      `| ${wideRow} |`,
      '',
      '```ts',
      shortCode,
      '```',
      '',
      '```ts',
      wideCode,
      '```',
      '',
      '```python {.run}',
      tallWidePython,
      '```',
      '',
      filler,
    ].join('\n');

    for (const mode of ['reader', 'live', 'split'] as const) {
      await page.mouse.move(10, 10);
      await page.evaluate(
        ({ mode, content }) => {
          window.supermdLoad?.({
            id: `nested-indicators-${mode}`,
            path: null,
            content,
            mode,
            dark: false,
            fullscreen: false,
            centerLock: true,
            colors: {},
            font: 'Manrope',
            size: 16,
            zoom: 100,
            widthPercent: 85,
            restorePosition: false,
            motion: false,
          });
        },
        { mode, content: markdown },
      );

      const reading = page.locator('.android-reading');
      const compactTb = reading.locator('.markdown-body table').nth(0);
      const wideTb = reading.locator('.markdown-body table').nth(1);
      const shortPre = reading.locator('.markdown-body pre:not(.python-source)').nth(0);
      const widePre = reading.locator('.markdown-body pre:not(.python-source)').nth(1);
      const pySource = reading.locator('.python-cell .python-source').first();

      await expect(wideTb).toBeVisible();
      await expect(widePre).toBeVisible();
      await expect(pySource).toBeVisible();

      // Confirm actual visible overflow + 16px custom Qt scrollbar lane on overflowing regions vs zero extra lane on compact regions.
      const dims = await page.evaluate(() => {
        const r = document.querySelector<HTMLElement>('.android-reading')!;
        const [cTb, wTb] = Array.from(r.querySelectorAll<HTMLElement>('.markdown-body table'));
        const [sPre, wPre] = Array.from(r.querySelectorAll<HTMLElement>('.markdown-body pre:not(.python-source)'));
        const py = r.querySelector<HTMLElement>('.python-cell .python-source')!;
        return {
          compactTbOverflow: cTb.scrollWidth - cTb.clientWidth,
          compactTbScrollbarH: cTb.offsetHeight - cTb.clientHeight,
          wideTbOverflow: wTb.scrollWidth - wTb.clientWidth,
          wideTbScrollbarH: wTb.offsetHeight - wTb.clientHeight,
          wideTbClientWidth: wTb.clientWidth,
          shortPreOverflow: sPre.scrollWidth - sPre.clientWidth,
          shortPreScrollbarH: sPre.offsetHeight - sPre.clientHeight,
          widePreOverflow: wPre.scrollWidth - wPre.clientWidth,
          widePreScrollbarH: wPre.offsetHeight - wPre.clientHeight,
          widePreClientHeight: wPre.clientHeight,
          pyOverflowX: py.scrollWidth - py.clientWidth,
          pyOverflowY: py.scrollHeight - py.clientHeight,
          pyScrollbarW: py.offsetWidth - py.clientWidth,
          pyScrollbarH: py.offsetHeight - py.clientHeight,
          pyClientWidth: py.clientWidth,
        };
      });
      expect(dims.compactTbOverflow).toBeLessThanOrEqual(1);
      expect(dims.compactTbScrollbarH).toBe(0);
      expect(dims.shortPreOverflow).toBeLessThanOrEqual(1);
      expect(dims.shortPreScrollbarH).toBe(0);
      expect(dims.wideTbOverflow).toBeGreaterThan(140);
      expect(dims.wideTbScrollbarH).toBe(16);
      expect(dims.widePreOverflow).toBeGreaterThan(140);
      expect(dims.widePreScrollbarH).toBe(16);
      expect(dims.pyOverflowX).toBeGreaterThan(100);
      expect(dims.pyOverflowY).toBeGreaterThan(100);
      expect(dims.pyScrollbarW).toBe(16);
      expect(dims.pyScrollbarH).toBe(16);

      // 1. Wide table: diagonal native wheel scroll routes dx to table & chains dy to .android-reading,
      // reveals the scrollbar thumb while active, and fades back to clean transparent lane when idle.
      await wideTb.scrollIntoViewIfNeeded();
      await expect(wideTb).not.toHaveClass(/scroll-indicator-active|scroll-indicator-hover/);
      const tbInitialBox = (await wideTb.boundingBox())!;
      const readingTopBeforeTb = await reading.evaluate(el => el.scrollTop);
      await page.evaluate(
        point => window.supermdNativeWheel?.(110, 75, point, false),
        { x: tbInitialBox.x + 60, y: tbInitialBox.y + 24 },
      );
      await expect(wideTb).toHaveClass(/scroll-indicator-active/);
      expect(await wideTb.evaluate(el => el.scrollLeft)).toBeGreaterThan(80);
      expect(await reading.evaluate(el => el.scrollTop)).toBeGreaterThan(readingTopBeforeTb + 45);

      await wideTb.scrollIntoViewIfNeeded();
      const tbBox = (await wideTb.boundingBox())!;
      const tbLaneClip = {
        x: Math.round(tbBox.x + 8),
        y: Math.round(tbBox.y + tbBox.height - 14),
        width: Math.max(40, Math.round(tbBox.width - 16)),
        height: 12,
      };
      await wideTb.evaluate(el => { el.scrollLeft = 95; });
      await expect(wideTb).toHaveClass(/scroll-indicator-active/);
      const tbActiveShot = await page.screenshot({ clip: tbLaneClip });

      // Let indicator fade out at the exact same scrollLeft=95 so only the scrollbar thumb changes.
      await expect(wideTb).not.toHaveClass(/scroll-indicator-active/, { timeout: 2000 });
      expect(await wideTb.evaluate(el => el.clientWidth)).toBe(dims.wideTbClientWidth);
      const tbIdleShot = await page.screenshot({ clip: tbLaneClip });
      expect(countDistinctPixels(tbActiveShot, tbIdleShot)).toBeGreaterThan(40);

      // Hovering wide table's bottom lane reveals indicator thumb; moving away hides it.
      await page.mouse.move(tbBox.x + 60, tbBox.y + tbBox.height - 6);
      await expect(wideTb).toHaveClass(/scroll-indicator-hover/);
      const tbHoverShot = await page.screenshot({ clip: tbLaneClip });
      expect(countDistinctPixels(tbHoverShot, tbIdleShot)).toBeGreaterThan(40);
      await page.mouse.move(10, 10);
      await expect(wideTb).not.toHaveClass(/scroll-indicator-hover/);

      // Non-overflowing compact table and short <pre> never activate hover indicators.
      await compactTb.scrollIntoViewIfNeeded();
      const compactBox = (await compactTb.boundingBox())!;
      await page.mouse.move(compactBox.x + 20, compactBox.y + compactBox.height - 4);
      await expect(compactTb).not.toHaveClass(/scroll-indicator-hover|scroll-indicator-active/);

      await shortPre.scrollIntoViewIfNeeded();
      const shortBox = (await shortPre.boundingBox())!;
      await page.mouse.move(shortBox.x + 20, shortBox.y + shortBox.height - 4);
      await expect(shortPre).not.toHaveClass(/scroll-indicator-hover|scroll-indicator-active/);
      await page.mouse.move(10, 10);

      // 2. Wide fenced <pre> inside .code-disclosure: scroll & lane hover reveal horizontal indicator thumb pixels.
      await widePre.scrollIntoViewIfNeeded();
      const preBox = (await widePre.boundingBox())!;
      const preLaneClip = {
        x: Math.round(preBox.x + 12),
        y: Math.round(preBox.y + preBox.height - 14),
        width: Math.max(40, Math.round(preBox.width - 24)),
        height: 12,
      };
      await widePre.evaluate(el => { el.scrollLeft = 120; });
      await expect(widePre).toHaveClass(/scroll-indicator-active/);
      const preActiveShot = await page.screenshot({ clip: preLaneClip });

      await expect(widePre).not.toHaveClass(/scroll-indicator-active/, { timeout: 2000 });
      expect(await widePre.evaluate(el => el.clientHeight)).toBe(dims.widePreClientHeight);
      const preIdleShot = await page.screenshot({ clip: preLaneClip });
      expect(countDistinctPixels(preActiveShot, preIdleShot)).toBeGreaterThan(40);

      await page.mouse.move(preBox.x + 60, preBox.y + preBox.height - 6);
      await expect(widePre).toHaveClass(/scroll-indicator-hover/);
      const preHoverShot = await page.screenshot({ clip: preLaneClip });
      expect(countDistinctPixels(preHoverShot, preIdleShot)).toBeGreaterThan(40);
      await page.mouse.move(10, 10);
      await expect(widePre).not.toHaveClass(/scroll-indicator-hover/);

      // 3. Tall + wide .python-source: interior wheel scroll reveals vertical & horizontal indicators without scrolling outer note.
      await pySource.scrollIntoViewIfNeeded();
      const pyBox = (await pySource.boundingBox())!;
      const pyVertLaneClip = {
        x: Math.round(pyBox.x + pyBox.width - 14),
        y: Math.round(pyBox.y + 8),
        width: 12,
        height: Math.max(40, Math.round(pyBox.height - 24)),
      };
      const readingBeforePy = await reading.evaluate(el => el.scrollTop);
      await page.evaluate(
        point => window.supermdNativeWheel?.(55, 65, point, false),
        { x: pyBox.x + 80, y: pyBox.y + 60 },
      );
      await expect(pySource).toHaveClass(/scroll-indicator-active/);
      expect(await pySource.evaluate(el => el.scrollTop)).toBeGreaterThan(45);
      expect(await pySource.evaluate(el => el.scrollLeft)).toBeGreaterThan(35);
      expect(Math.abs((await reading.evaluate(el => el.scrollTop)) - readingBeforePy)).toBeLessThanOrEqual(2);
      const pyActiveShot = await page.screenshot({ clip: pyVertLaneClip });

      await expect(pySource).not.toHaveClass(/scroll-indicator-active/, { timeout: 2000 });
      expect(await pySource.evaluate(el => el.clientWidth)).toBe(dims.pyClientWidth);
      const pyIdleShot = await page.screenshot({ clip: pyVertLaneClip });
      expect(countDistinctPixels(pyActiveShot, pyIdleShot)).toBeGreaterThan(40);

      // Right vertical lane hover on .python-source reveals indicator.
      await page.mouse.move(pyBox.x + pyBox.width - 8, pyBox.y + 60);
      await expect(pySource).toHaveClass(/scroll-indicator-hover/);
      const pyHoverShot = await page.screenshot({ clip: pyVertLaneClip });
      expect(countDistinctPixels(pyHoverShot, pyIdleShot)).toBeGreaterThan(40);
      await page.mouse.move(10, 10);
      await expect(pySource).not.toHaveClass(/scroll-indicator-hover/);
    }

    // Verify Ctrl+wheel note zoom over wide table and .python-source remains unchanged.
    const wideTb = page.locator('.android-reading .markdown-body table').nth(1);
    await wideTb.scrollIntoViewIfNeeded();
    const tbScrollBeforeZoom = await wideTb.evaluate(el => el.scrollLeft);
    const tbZoomBox = (await wideTb.boundingBox())!;
    await page.evaluate(
      point => window.supermdNativeWheel?.(0, -120, point, true, true),
      { x: tbZoomBox.x + 60, y: tbZoomBox.y + 20 },
    );
    await expect
      .poll(() => page.locator('.document-page').evaluate(el => Number((el as HTMLElement).dataset.scale)))
      .toBeGreaterThan(1.2);
    expect(await wideTb.evaluate(el => el.scrollLeft)).toBe(tbScrollBeforeZoom);
  } finally {
    await browser.close();
  }
});

