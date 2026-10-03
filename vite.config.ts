import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import {fileURLToPath} from "node:url";

export default defineConfig({
  base: "./",
  plugins: [react()],
  // The package's browser default allocates a DOM element at import time.
  // Its equivalent table decoder also works in the offline writing worker.
  resolve: {alias:{"decode-named-character-reference":fileURLToPath(new URL("./node_modules/decode-named-character-reference/index.js",import.meta.url))}},
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  envPrefix: ["VITE_", "TAURI_"]
  ,build: { rollupOptions: { input: { app: "index.html", reader: "android-reader.html", qtReader: "qt-reader.html" } } }
});
