import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isBuiltinReaderFont, READER_FONT_STACKS, resolveReaderFontStack } from "./readerFonts";

describe("native reader variable font stacks", () => {
  it("maps every built-in preset directly to its unified variable WOFF2 family without static prefixes", () => {
    expect(resolveReaderFontStack("Manrope")).toBe("'Manrope Variable', sans-serif");
    expect(resolveReaderFontStack("sans")).toBe("'Manrope Variable', sans-serif");
    expect(resolveReaderFontStack("JetBrains Mono")).toBe("'JetBrains Mono Variable', monospace");
    expect(resolveReaderFontStack("mono")).toBe("'JetBrains Mono Variable', monospace");
    expect(resolveReaderFontStack("Roboto")).toBe("'Roboto Variable', sans-serif");
    expect(resolveReaderFontStack("roboto")).toBe("'Roboto Variable', sans-serif");
    expect(resolveReaderFontStack("Noto Serif")).toBe("'Noto Serif Variable', serif");
    expect(resolveReaderFontStack("serif")).toBe("'Noto Serif Variable', Georgia, serif");
    expect(resolveReaderFontStack("Noto Sans")).toBe("'Noto Sans Variable', sans-serif");
    expect(resolveReaderFontStack("noto")).toBe("'Noto Sans Variable', sans-serif");
    expect(resolveReaderFontStack("system")).toBe("system-ui, sans-serif");

    for (const [preset, stack] of Object.entries(READER_FONT_STACKS)) {
      if (preset === "system") continue;
      const primary = stack.split(",")[0].trim().replace(/^['"]|['"]$/g, "");
      expect(primary.endsWith(" Variable")).toBe(true);
    }
  });

  it("preserves custom user-imported font families and guards Object.prototype keys", () => {
    expect(isBuiltinReaderFont("Manrope")).toBe(true);
    expect(isBuiltinReaderFont("Inter Custom")).toBe(false);
    expect(isBuiltinReaderFont("toString")).toBe(false);
    expect(resolveReaderFontStack("Inter Custom")).toBe('"Inter Custom", sans-serif');
    expect(resolveReaderFontStack("toString")).toBe('"toString", sans-serif');
  });

  it("keeps reader stylesheets free of static /fonts/*.ttf declarations and non-variable Manrope UI overrides", () => {
    const androidCss = readFileSync(new URL("./androidReader.css", import.meta.url), "utf8");
    const stylesCss = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
    const themeGuideCss = readFileSync(new URL("./components/ThemeGuideDialog.css", import.meta.url), "utf8");

    expect(androidCss).not.toMatch(/@font-face/i);
    expect(androidCss).not.toMatch(/\/fonts\/[^)]+\.ttf/i);
    for (const stylesheet of [androidCss, stylesCss, themeGuideCss]) {
      expect(stylesheet).not.toMatch(/["']Manrope["']\s*,/);
    }
  });
});
