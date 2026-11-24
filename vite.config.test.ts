import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { buildHtmlEntries, stripLegacyMathFontFallbacks, woff2MathFontsPlugin } from './vite.config';

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
