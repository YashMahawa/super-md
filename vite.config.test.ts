import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, expect, it } from 'vitest';
import { buildHtmlEntries, htmlCspPlugin, renderSandboxDocument } from './vite.config';

const originalTauriPlatform = process.env.TAURI_ENV_PLATFORM;

afterEach(() => {
  if (originalTauriPlatform === undefined) {
    delete process.env.TAURI_ENV_PLATFORM;
  } else {
    process.env.TAURI_ENV_PLATFORM = originalTauriPlatform;
  }
});

function runHtmlCspTransform(html: string, filename: string, command: 'build' | 'serve') {
  const plugin = htmlCspPlugin();
  const configResolved = plugin.configResolved;
  if (typeof configResolved === 'function') {
    configResolved.call({} as never, { command } as never);
  }
  const hook = plugin.transformIndexHtml;
  if (!hook || typeof hook === 'function') {
    throw new Error('Expected object transformIndexHtml hook');
  }
  return hook.handler.call({} as never, html, { filename, path: filename } as never);
}

it('keeps native Vite builds limited to the Android and Qt reader entrypoints', () => {
  expect(buildHtmlEntries('native')).toEqual({
    reader: 'android-reader.html',
    qtReader: 'qt-reader.html',
  });
});

it('preserves the existing app, Android and Qt entrypoints in the default build', () => {
  expect(buildHtmlEntries('production')).toEqual({
    app: 'index.html',
    reader: 'android-reader.html',
    qtReader: 'qt-reader.html',
  });
  expect(buildHtmlEntries('development')).toEqual(buildHtmlEntries('production'));
});

it('embeds an HTML5-normalized SHA-256 CSP digest for the Mermaid sandbox bundle', () => {
  const doc = renderSandboxDocument('const tag = "</script>";\r\nconsole.log(tag);\0');
  const scriptBody = doc.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';
  expect(scriptBody).not.toContain('\r');
  expect(scriptBody).not.toContain('\0');
  expect(scriptBody).toContain('<\\/script>');
  const expectedDigest = createHash('sha256').update(scriptBody, 'utf8').digest('base64');
  expect(doc).toContain(`script-src 'sha256-${expectedDigest}' 'wasm-unsafe-eval'`);
});

it('strips duplicate meta CSP only from index.html during Tauri platform builds', () => {
  const indexHtml = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  const qtHtml = readFileSync(new URL('./qt-reader.html', import.meta.url), 'utf8');
  const androidHtml = readFileSync(new URL('./android-reader.html', import.meta.url), 'utf8');

  delete process.env.TAURI_ENV_PLATFORM;
  expect(runHtmlCspTransform(indexHtml, '/repo/index.html', 'build')).toContain(
    'http-equiv="Content-Security-Policy"',
  );

  process.env.TAURI_ENV_PLATFORM = 'windows';
  expect(runHtmlCspTransform(indexHtml, 'C:\\repo\\index.html', 'build')).not.toContain(
    'Content-Security-Policy',
  );
  expect(runHtmlCspTransform(qtHtml, 'C:\\repo\\qt-reader.html', 'build')).toContain(
    'http-equiv="Content-Security-Policy"',
  );
  expect(runHtmlCspTransform(androidHtml, 'C:\\repo\\android-reader.html', 'build')).toContain(
    'http-equiv="Content-Security-Policy"',
  );
});

it('hashes CRLF inline preamble scripts with HTML5 LF normalization during vite serve', () => {
  delete process.env.TAURI_ENV_PLATFORM;
  const sample = [
    '<!doctype html><html><head>',
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; connect-src \'self\'">',
    '<script type="module">window.__vite_plugin_react_preamble_installed__ = true;\r\n</script>',
    '</head><body></body></html>',
  ].join('\r\n');

  const transformed = String(runHtmlCspTransform(sample, '/repo/index.html', 'serve'));
  const expectedDigest = createHash('sha256')
    .update('window.__vite_plugin_react_preamble_installed__ = true;\n', 'utf8')
    .digest('base64');
  expect(transformed).toContain(`'sha256-${expectedDigest}'`);
  expect(transformed).toContain('ws://127.0.0.1:1420 ws://localhost:1420');
});
