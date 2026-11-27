import bundledThemeCatalog from '../public/themes/index.json';

export interface BundledThemePreset {
  readonly id: string;
  readonly name: string;
  readonly filename: string;
}

export const BUNDLED_THEMES: readonly BundledThemePreset[] = bundledThemeCatalog;

const BUNDLED_THEME_IDS = new Set(BUNDLED_THEMES.map(preset => preset.id));

export type BundledThemeLinkTarget =
  | { kind: 'preset'; id: string }
  | { kind: 'directory' };

export function parseBundledThemeHref(href: string | null | undefined): BundledThemeLinkTarget | null {
  if (!href) return null;
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null;
  const clean = trimmed.split(/[?#]/, 1)[0].replace(/\\/g, '/').replace(/^(?:\.\.?\/)+/, '').replace(/^\/+/, '').replace(/\/+$/, '');
  if (clean === 'public/themes' || clean === 'themes') return { kind: 'directory' };
  const match = clean.match(/^(?:public\/)?themes\/([a-z0-9-]+)\.supermd-theme\.json$/);
  if (match && BUNDLED_THEME_IDS.has(match[1])) return { kind: 'preset', id: match[1] };
  return null;
}
