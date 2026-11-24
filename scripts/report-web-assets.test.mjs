import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { inventory, MAX_READER_FONT_BYTES, verifyNativeResources, verifyReaderFontBudget } from './report-web-assets.mjs';

test('traces reader entrypoints through local JS and CSS without treating app assets as reachable', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'supermd-assets-'));
  try {
    await mkdir(path.join(root, 'assets'));
    await writeFile(path.join(root, 'android-reader.html'), '<script type="module" src="./assets/reader.js"></script>');
    await writeFile(path.join(root, 'qt-reader.html'), '<link rel="stylesheet" href="./assets/reader.css">');
    await writeFile(path.join(root, 'assets/reader.js'), 'import("./chunk.js"); import "./reader.css";');
    await writeFile(path.join(root, 'assets/chunk.js'), 'new URL("./reader.woff2", import.meta.url);');
    await writeFile(path.join(root, 'assets/reader.css'), 'body{background:url("./image.png")}');
    await writeFile(path.join(root, 'assets/reader.woff2'), 'font');
    await writeFile(path.join(root, 'assets/image.png'), 'image');
    await writeFile(path.join(root, 'index.html'), '<script src="./assets/app.js"></script>');
    await writeFile(path.join(root, 'assets/app.js'), 'console.log("app")');

    const report = await inventory(root);
    assert.equal(report.totals.readerReachableCount, 7);
    assert.equal(report.totals.readerFonts.length, 1);
    assert.equal(report.files.find(file => file.path === 'assets/app.js').readerReachable, false);
    assert.equal(report.unresolvedReferences['android-reader.html'].length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('verifies generated notices and every public help, font, license, and theme resource', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'supermd-native-resources-'));
  try {
    const dist = path.join(root, 'dist');
    const publicRoot = path.join(root, 'public');
    const required = [
      'LICENSE.txt',
      'THEMING.md',
      'super-md-agent-SKILL.md',
      'DIAGRAM-RENDERER-LICENSES.txt',
      'WRITING-ASSISTANCE-LICENSES.txt',
      'fonts/reader.ttf',
      'licenses/font.txt',
      'help/guide.md',
      'themes/reader.json',
    ];
    for (const relative of required) {
      const isPublic = relative.startsWith('fonts/') || relative.startsWith('licenses/') || relative.startsWith('help/') || relative.startsWith('themes/');
      const destination = path.join(isPublic ? publicRoot : dist, relative);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, 'fixture');
      if (isPublic) {
        const packaged = path.join(dist, relative);
        await mkdir(path.dirname(packaged), { recursive: true });
        await writeFile(packaged, 'fixture');
      }
    }

    const result = await verifyNativeResources(dist, publicRoot);
    assert.equal(result.checkedCount, required.length);
    assert.equal(result.publicFileCount, 4);
    await rm(path.join(dist, 'fonts/reader.ttf'));
    await assert.rejects(verifyNativeResources(dist, publicRoot), /fonts\/reader\.ttf/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('enforces .woff2-only font assets and reachable reader font byte budgets', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'supermd-font-budget-'));
  try {
    await mkdir(path.join(root, 'assets'));
    await writeFile(path.join(root, 'android-reader.html'), '<link rel="stylesheet" href="./assets/reader.css">');
    await writeFile(path.join(root, 'qt-reader.html'), '<link rel="stylesheet" href="./assets/reader.css">');
    await writeFile(path.join(root, 'assets/reader.css'), '@font-face{font-family:"Manrope Variable";src:url("./manrope.woff2") format("woff2")}');
    await writeFile(path.join(root, 'assets/manrope.woff2'), 'woff2-binary-payload');

    const cleanReport = await inventory(root);
    const check = verifyReaderFontBudget(cleanReport);
    assert.equal(check.readerFontCount, 1);
    assert.equal(check.readerFontBytes, 20);
    assert.equal(check.maxReaderFontBytes, MAX_READER_FONT_BYTES);

    assert.throws(() => verifyReaderFontBudget(cleanReport, { maxBytes: 10 }), /exceed budget/);

    await writeFile(path.join(root, 'assets/legacy.ttf'), 'ttf');
    const withUnreachedTtf = await inventory(root);
    assert.throws(() => verifyReaderFontBudget(withUnreachedTtf), /forbidden \.ttf\/\.woff font assets.*legacy\.ttf/);
    await rm(path.join(root, 'assets/legacy.ttf'));

    await writeFile(path.join(root, 'assets/legacy-math.woff'), 'woff');
    const withUnreachedWoff = await inventory(root);
    assert.throws(() => verifyReaderFontBudget(withUnreachedWoff), /forbidden \.ttf\/\.woff font assets.*legacy-math\.woff/);
    await rm(path.join(root, 'assets/legacy-math.woff'));

    await writeFile(path.join(root, 'assets/reader.css'), '@font-face{font-family:"Custom";src:url("./custom.otf") format("opentype")}');
    await writeFile(path.join(root, 'assets/custom.otf'), 'otf');
    const withReachableOtf = await inventory(root);
    assert.throws(() => verifyReaderFontBudget(withReachableOtf), /\.woff2 only.*custom\.otf/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
