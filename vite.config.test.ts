import { expect, it } from 'vitest';
import { buildHtmlEntries } from './vite.config';

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
