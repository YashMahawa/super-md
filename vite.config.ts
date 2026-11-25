import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import {fileURLToPath} from "node:url";

export const nativeReaderEntries = { reader: "android-reader.html", qtReader: "qt-reader.html" } as const;

const LEGACY_FONT_SOURCE_RE = /\.(?:woff|ttf)(?=[?#"'\s)]|$)/i;

export function stripLegacyMathFontFallbacks(css: string): string {
  return css.replace(/@font-face\s*\{[^}]*\}/g, (block) =>
    block.replace(/(src\s*:\s*)([^;}]+)/g, (full, prefix: string, value: string) => {
      const kept = value
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0 && !LEGACY_FONT_SOURCE_RE.test(entry));
      return kept.length > 0 ? `${prefix}${kept.join(",")}` : full;
    }),
  );
}

export function woff2MathFontsPlugin(): Plugin {
  return {
    name: "supermd-woff2-math-fonts",
    enforce: "pre",
    transform(code, id) {
      if (!/[\\/]katex[\\/].*\.css(?:$|\?)/.test(id)) return null;
      return { code: stripLegacyMathFontFallbacks(code), map: null };
    },
  };
}

export function buildHtmlEntries(mode: string) {
  return mode === "native"
    ? nativeReaderEntries
    : { app: "index.html", ...nativeReaderEntries };
}

export default defineConfig(({mode}) => ({
  base: "./",
  plugins: [woff2MathFontsPlugin(), react()],
  // These imports are reached only through the lazy writing and document-analysis
  // workers. Discover them before serving a page so first use cannot trigger an
  // optimizer reload or per-worker module waterfall and discard in-memory state.
  optimizeDeps: {include: ["nspell", "retext-english", "retext-repeated-words", "retext-indefinite-article", "vfile", "unified", "remark-parse", "remark-gfm", "remark-math", "unist-util-visit"]},
  // The package's browser default allocates a DOM element at import time.
  // Its equivalent table decoder also works in the offline writing worker.
  resolve: {alias:{"decode-named-character-reference":fileURLToPath(new URL("./node_modules/decode-named-character-reference/index.js",import.meta.url))}},
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  envPrefix: ["VITE_", "TAURI_"]
  ,build: { rollupOptions: { input: buildHtmlEntries(mode) } }
}));
