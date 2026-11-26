import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, expect, it } from 'vitest';
import {
  buildHtmlEntries,
  htmlCspPlugin,
  mermaidSandboxPlugin,
  renderSandboxDocument,
  stripLegacyMathFontFallbacks,
  woff2MathFontsPlugin,
} from './vite.config';

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

it('strips legacy .woff and .ttf fallback sources from KaTeX @font-face rules while preserving .woff2', () => {
  const katexCss = readFileSync(new URL('./node_modules/katex/dist/katex.min.css', import.meta.url), 'utf8');
  const pruned = stripLegacyMathFontFallbacks(katexCss);
  const faces = pruned.match(/@font-face\s*\{[^}]*\}/g) ?? [];
  expect(faces.length).toBe(20);
  for (const face of faces) {
    expect(face).toMatch(/\.woff2(?=[?#"'\s)]|$)/);
    expect(face).not.toMatch(/\.(?:woff|ttf)(?=[?#"'\s)]|$)/);
  }
  const plugin = woff2MathFontsPlugin();
  const transform = typeof plugin.transform === 'function' ? plugin.transform : plugin.transform?.handler;
  expect(transform?.call({} as never, katexCss, '/app/node_modules/katex/dist/katex.min.css')).toEqual({
    code: pruned,
    map: null,
  });
  expect(transform?.call({} as never, katexCss, '/app/src/styles.css')).toBeNull();
});

it('caches the Mermaid sandbox bundle across dev-server requests and invalidates on sandbox source changes', async () => {
  let buildCount = 0;
  const plugin = mermaidSandboxPlugin(async () => `window.__sandboxGen = ${++buildCount};`);
  const watcherHandlers = new Map<string, Array<(filePath: string) => void>>();
  let middleware: ((req: { url?: string; method?: string }, res: Record<string, unknown>, next: (err?: unknown) => void) => Promise<void>) | null = null;

  const configureServer = typeof plugin.configureServer === 'function' ? plugin.configureServer : plugin.configureServer?.handler;
  configureServer?.call(
    {} as never,
    {
      watcher: {
        on(event: string, cb: (filePath: string) => void) {
          watcherHandlers.set(event, [...(watcherHandlers.get(event) ?? []), cb]);
        },
      },
      middlewares: {
        use(fn: typeof middleware) {
          middleware = fn;
        },
      },
    } as never,
  );

  const requestRoute = async (url: string) => {
    let body = '';
    const headers = new Map<string, string>();
    await middleware!(
      { url, method: 'GET' },
      {
        statusCode: 0,
        setHeader(k: string, v: string) {
          headers.set(k, v);
        },
        end(chunk?: string) {
          body = chunk ?? '';
        },
      },
      (err) => {
        if (err) throw err;
      },
    );
    return { body, contentType: headers.get('Content-Type') };
  };

  const firstHtml = await requestRoute('/@mermaid-sandbox.html');
  const secondScript = await requestRoute('/@mermaid-sandbox.js');
  expect(buildCount).toBe(1);
  expect(firstHtml.contentType).toContain('text/html');
  expect(firstHtml.body).toContain('window.__sandboxGen = 1;');
  expect(secondScript.contentType).toContain('application/javascript');
  expect(secondScript.body).toBe('window.__sandboxGen = 1;');

  // Unrelated file edits keep the cached Mermaid sandbox bundle warm.
  for (const cb of watcherHandlers.get('change') ?? []) {
    cb('/repo/src/components/PythonCell.tsx');
  }
  const thirdScript = await requestRoute('/@mermaid-sandbox.js');
  expect(buildCount).toBe(1);
  expect(thirdScript.body).toBe('window.__sandboxGen = 1;');

  // Editing a mermaidSandbox source file invalidates the cache on next request.
  for (const cb of watcherHandlers.get('change') ?? []) {
    cb('/repo/src/mermaidSandboxWorker.ts');
  }
  const fourthScript = await requestRoute('/@mermaid-sandbox.js');
  expect(buildCount).toBe(2);
  expect(fourthScript.body).toBe('window.__sandboxGen = 2;');
});
