export interface BundledThemePreset {
  readonly id: string;
  readonly name: string;
  readonly filename: string;
}

export const BUNDLED_THEMES: readonly BundledThemePreset[] = [
  { id: 'apricot-glow', name: 'Apricot glow', filename: 'apricot-glow.supermd-theme.json' },
  { id: 'avengers-assembly', name: 'Avengers Assembly', filename: 'avengers-assembly.supermd-theme.json' },
  { id: 'avengers-ink', name: 'Avengers Ink', filename: 'avengers-ink.supermd-theme.json' },
  { id: 'blueprint', name: 'Blueprint', filename: 'blueprint.supermd-theme.json' },
  { id: 'catnap-paws', name: 'Catnap paws', filename: 'catnap-paws.supermd-theme.json' },
  { id: 'copper-grid', name: 'Copper grid', filename: 'copper-grid.supermd-theme.json' },
  { id: 'doctor-doom', name: 'Doctor Doom', filename: 'doctor-doom.supermd-theme.json' },
  { id: 'gotham-midnight', name: 'Gotham Midnight', filename: 'gotham-midnight.supermd-theme.json' },
  { id: 'ink-dots', name: 'Ink dots', filename: 'ink-dots.supermd-theme.json' },
  { id: 'iron-man-reactor', name: 'Iron Man Reactor', filename: 'iron-man-reactor.supermd-theme.json' },
  { id: 'lazy-sunday-cats', name: 'Lazy Sunday cats', filename: 'lazy-sunday-cats.supermd-theme.json' },
  { id: 'midnight-paws', name: 'Midnight paws', filename: 'midnight-paws.supermd-theme.json' },
  { id: 'plum-linen', name: 'Plum linen', filename: 'plum-linen.supermd-theme.json' },
  { id: 'rose-paper', name: 'Rose paper', filename: 'rose-paper.supermd-theme.json' },
  { id: 'spider-city', name: 'Spider City', filename: 'spider-city.supermd-theme.json' },
  { id: 'study-desk', name: 'Study desk', filename: 'study-desk.supermd-theme.json' },
];

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
