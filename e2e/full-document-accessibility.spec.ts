import { expect, test } from '@playwright/test';

test('full-document mode exposes distant semantics in Chromium AX tree and keeps keyboard focus usable', async ({ page }) => {
  await page.addInitScript(() => {
    window.SuperMD = { post: id => queueMicrotask(() => window.supermdReply?.(id, true, null)) };
  });
  await page.goto('/android-reader.html');
  await page.waitForFunction(() => typeof window.supermdLoad === 'function');

  const body = Array.from({ length: 650 }, (_, index) =>
    `## Synthetic chapter ${index}\n\n${`Generated accessibility paragraph ${index} with readable text and stable semantics. `.repeat(3)}\n\n`,
  ).join('');
  const content = `# Full document accessibility synthetic note\n\n${body}
## Distant semantic heading

- First distant list item
- Second distant list item

| Distant column A | Distant column B |
| --- | --- |
| Distant table cell | Accessible table value |

A distant footnote reference[^a11y].

[Distant source link](https://example.org/accessibility)

\`\`\`python
print('keyboard destination')
\`\`\`

[^a11y]: Synthetic full-document footnote body.
`;
  const sourceBytes = Buffer.byteLength(content);
  expect(sourceBytes).toBeGreaterThan(80_000);

  await page.evaluate(content => window.supermdLoad?.({
    id: 'full-document-a11y-synthetic',
    path: null,
    content,
    mode: 'reader',
    dark: false,
    fullscreen: false,
    colors: {},
    font: 'Manrope',
    size: 18,
    zoom: 100,
    fullDocumentAccessibility: true,
  }), content);

  await expect(page.locator('.android-reading')).toHaveAttribute('data-full-document-accessibility', 'true');
  await expect(page.locator('[data-windowed-block]')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Distant semantic heading', exact: true })).toBeAttached();

  const cdp = await page.context().newCDPSession(page);
  const { nodes } = await cdp.send('Accessibility.getFullAXTree');
  const axById = new Map(nodes.map((node: any) => [node.nodeId, node]));
  const accessible = nodes.filter((node: any) => !node.ignored).map((node: any) => ({
    id: node.nodeId,
    childIds: node.childIds ?? [],
    role: node.role?.value,
    name: String(node.name?.value ?? ''),
  }));
  const has = (role: string, name: string) => accessible.some(node => node.role === role && node.name === name);
  const hasDescendantStaticText = (nodeId: string, expected: string) => {
    const pending = [...(axById.get(nodeId)?.childIds ?? [])];
    const visited = new Set<string>();
    while (pending.length) {
      const currentId = pending.pop();
      if (!currentId || visited.has(currentId)) continue;
      visited.add(currentId);
      const current = axById.get(currentId);
      if (!current) continue;
      if (current.role?.value === 'StaticText' && String(current.name?.value ?? '').includes(expected)) return true;
      pending.push(...(current.childIds ?? []));
    }
    return false;
  };
  expect(has('heading', 'Distant semantic heading')).toBe(true);
  expect(has('list', '')).toBe(true);
  expect(accessible.some(node => node.role === 'listitem' && hasDescendantStaticText(node.id, 'First distant list item'))).toBe(true);
  expect(accessible.some(node => node.role === 'table')).toBe(true);
  expect(has('link', 'Distant source link')).toBe(true);
  expect(accessible.some(node => node.name.includes('Synthetic full-document footnote body.'))).toBe(true);
  expect(has('button', 'Run')).toBe(true);

  const link = page.getByRole('link', { name: 'Distant source link', exact: true });
  const copy = page.getByRole('button', { name: 'Copy code', exact: true });
  const run = page.getByRole('button', { name: 'Run', exact: true });
  await link.focus();
  await expect(link).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(copy).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(run).toBeFocused();
  await cdp.detach();
});
