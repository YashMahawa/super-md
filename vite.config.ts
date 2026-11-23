import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import {fileURLToPath} from "node:url";

export const nativeReaderEntries = { reader: "android-reader.html", qtReader: "qt-reader.html" } as const;

export function buildHtmlEntries(mode: string) {
  return mode === "native"
    ? nativeReaderEntries
    : { app: "index.html", ...nativeReaderEntries };
}

export default defineConfig(({mode}) => ({
  base: "./",
  plugins: [react()],
  // These imports are reached only through the lazy writing and document-analysis
  // workers. Discover them before serving a page so first use cannot trigger an
  // optimizer reload or per-worker module waterfall in dev mode.
  optimizeDeps: {include: ["nspell", "retext-english", "retext-repeated-words", "retext-indefinite-article", "vfile", "unified", "remark-parse", "remark-gfm", "remark-math", "unist-util-visit"]},
  // The package's browser default allocates a DOM element at import time.
  // Its equivalent table decoder also works in the offline writing worker.
  resolve: {alias:{"decode-named-character-reference":fileURLToPath(new URL("./node_modules/decode-named-character-reference/index.js",import.meta.url))}},
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  envPrefix: ["VITE_", "TAURI_"]
  ,build: { rollupOptions: { input: buildHtmlEntries(mode) } }
}));
