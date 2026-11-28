/** Shared WCAG 2.1 relative luminance and 4.5:1 #111111/#f9f9f9 contrast clamping. */
const DARK_INK = '#111111';
const LIGHT_INK = '#f9f9f9';

export function luminance(color: string): number {
  const rgb = [1, 3, 5]
    .map(i => parseInt(color.slice(i, i + 2), 16) / 255)
    .map(v => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}

export function themeContrast(a: string, b: string): number {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

export function minThemeContrast(color: string, backgrounds: readonly string[]): number {
  return Math.min(...backgrounds.map(bg => themeContrast(color, bg)));
}

export function readableThemeColor(
  color: string,
  backgrounds: string | readonly string[],
  minRatio = 4.5,
): string {
  const list = typeof backgrounds === 'string' ? [backgrounds] : backgrounds;
  if (minThemeContrast(color, list) >= minRatio) return color;
  return minThemeContrast(DARK_INK, list) >= minThemeContrast(LIGHT_INK, list) ? DARK_INK : LIGHT_INK;
}

export function hasReadableThemeInk(backgrounds: readonly string[], minRatio = 4.5): boolean {
  return Math.max(minThemeContrast(DARK_INK, backgrounds), minThemeContrast(LIGHT_INK, backgrounds)) >= minRatio;
}
