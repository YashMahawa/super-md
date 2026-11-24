export const READER_FONT_STACKS: Record<string, string> = {
  sans: "'Manrope Variable', sans-serif",
  serif: "'Noto Serif Variable', Georgia, serif",
  mono: "'JetBrains Mono Variable', monospace",
  Manrope: "'Manrope Variable', sans-serif",
  "JetBrains Mono": "'JetBrains Mono Variable', monospace",
  "Noto Sans": "'Noto Sans Variable', sans-serif",
  "Noto Serif": "'Noto Serif Variable', serif",
  Roboto: "'Roboto Variable', sans-serif",
  roboto: "'Roboto Variable', sans-serif",
  noto: "'Noto Sans Variable', sans-serif",
  system: "system-ui, sans-serif",
};

export function isBuiltinReaderFont(font: string): boolean {
  return Object.prototype.hasOwnProperty.call(READER_FONT_STACKS, font);
}

export function resolveReaderFontStack(font: string): string {
  return isBuiltinReaderFont(font)
    ? READER_FONT_STACKS[font]
    : `${JSON.stringify(font)}, sans-serif`;
}
