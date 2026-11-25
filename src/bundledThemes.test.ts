import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUNDLED_THEMES, parseBundledThemeHref } from './bundledThemes';

describe('bundledThemes', () => {
  it('lists all 16 bundled theme presets with matching filenames and display names', () => {
    const dir = resolve(__dirname, '../public/themes');
    const files = readdirSync(dir)
      .filter(file => file.endsWith('.supermd-theme.json'))
      .sort();
    expect(files).toHaveLength(16);
    expect(BUNDLED_THEMES.map(entry => entry.filename).slice().sort()).toEqual(files);
    for (const entry of BUNDLED_THEMES) {
      const parsed = JSON.parse(readFileSync(resolve(dir, entry.filename), 'utf8'));
      expect(parsed.format).toBe('supermd-theme');
      expect(parsed.name).toBe(entry.name);
      expect(entry.filename).toBe(`${entry.id}.supermd-theme.json`);
    }
  });

  it('classifies bundled preset and directory links from the authoring guide', () => {
    expect(parseBundledThemeHref('../public/themes/study-desk.supermd-theme.json')).toEqual({
      kind: 'preset',
      id: 'study-desk',
    });
    expect(parseBundledThemeHref('public/themes/lazy-sunday-cats.supermd-theme.json#top')).toEqual({
      kind: 'preset',
      id: 'lazy-sunday-cats',
    });
    expect(parseBundledThemeHref('themes/plum-linen.supermd-theme.json')).toEqual({
      kind: 'preset',
      id: 'plum-linen',
    });
    expect(parseBundledThemeHref('../public/themes')).toEqual({ kind: 'directory' });
    expect(parseBundledThemeHref('public/themes/')).toEqual({ kind: 'directory' });
    expect(parseBundledThemeHref('themes')).toEqual({ kind: 'directory' });
    expect(parseBundledThemeHref('../public/themes/nonexistent.supermd-theme.json')).toBeNull();
    expect(parseBundledThemeHref('#schema')).toBeNull();
    expect(parseBundledThemeHref('https://example.com/public/themes')).toBeNull();
  });
});
