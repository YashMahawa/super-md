import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

export const nativeReaderEntries = { reader: "android-reader.html", qtReader: "qt-reader.html" } as const;

export function buildHtmlEntries(mode: string) {
  return mode === "native"
    ? nativeReaderEntries
    : { app: "index.html", ...nativeReaderEntries };
}

export function renderSandboxDocument(iifeScript: string): string {
  const escaped = iifeScript
    .replace(/\r\n?/g, "\n")
    .replace(/\0/g, "\uFFFD")
    .replace(/<\/(script)/gi, "<\\/$1");
  const digest = createHash("sha256").update(escaped, "utf8").digest("base64");
  const csp = [
    "default-src 'none'",
    `script-src 'sha256-${digest}' 'wasm-unsafe-eval'`,
    "style-src 'unsafe-inline'",
    "img-src data:",
    "font-src data:",
    "connect-src 'none'",
    "worker-src 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "object-src 'none'",
    "media-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ");
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"></head><body style="margin:0;padding:0;overflow:hidden"><script>${escaped}</script></body></html>`;
}

function mermaidSandboxPlugin(): Plugin {
  const virtualId = "virtual:mermaid-sandbox-url";
  const resolvedId = "\0" + virtualId;
  const devRoute = "/@mermaid-sandbox.html";
  let isServe = false;
  let cachedHtmlPromise: Promise<string> | null = null;

  const getSandboxHtml = () => {
    if (!cachedHtmlPromise) {
      cachedHtmlPromise = (async () => {
        const esbuild = await import("esbuild");
        const entry = fileURLToPath(new URL("./src/mermaidSandboxEntry.ts", import.meta.url));
        const bundled = await esbuild.build({
          entryPoints: [entry],
          bundle: true,
          write: false,
          format: "iife",
          platform: "browser",
          target: "es2020",
          charset: "ascii",
          minify: true,
          alias: {
            "decode-named-character-reference": fileURLToPath(
              new URL("./node_modules/decode-named-character-reference/index.js", import.meta.url),
            ),
          },
        });
        const script = bundled.outputFiles[0]?.text ?? "";
        return renderSandboxDocument(script);
      })();
    }
    return cachedHtmlPromise;
  };

  return {
    name: "supermd-mermaid-sandbox",
    configResolved(config) {
      isServe = config.command === "serve";
    },
    resolveId(id) {
      if (id === virtualId) return resolvedId;
      return null;
    },
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const requestPath = req.url?.split("?", 1)[0];
        if (requestPath !== devRoute || (req.method !== "GET" && req.method !== "HEAD")) {
          next();
          return;
        }
        try {
          cachedHtmlPromise = null;
          const html = await getSandboxHtml();
          res.statusCode = 200;
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.setHeader("Cache-Control", "no-store");
          res.end(req.method === "HEAD" ? undefined : html);
        } catch (error) {
          next(error);
        }
      });
    },
    async load(id) {
      if (id !== resolvedId) return null;
      if (isServe) {
        return `export default ${JSON.stringify(devRoute)};`;
      }
      const html = await getSandboxHtml();
      const refId = this.emitFile({
        type: "asset",
        name: "mermaid-sandbox.html",
        source: html,
      });
      return `export default new URL(import.meta.ROLLUP_FILE_URL_${refId}, import.meta.url).href;`;
    },
  };
}

export function htmlCspPlugin(): Plugin {
  let isServe = false;
  return {
    name: "supermd-html-csp",
    configResolved(config) {
      isServe = config.command === "serve";
    },
    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        if (process.env.TAURI_ENV_PLATFORM && ctx.filename.replace(/\\/g, "/").endsWith("/index.html")) {
          // Tauri v2 injects its own authoritative CSP meta tag from tauri.conf.json
          // (including runtime IPC script nonces and asset:/customprotocol: sources).
          return html.replace(/\s*<meta\s+http-equiv=["']Content-Security-Policy["'][^>]*>/i, "");
        }
        if (!isServe) {
          return html;
        }
        const inlineHashes: string[] = [];
        const scriptPattern = /<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
        let match: RegExpExecArray | null;
        while ((match = scriptPattern.exec(html)) !== null) {
          const body = match[1] ?? "";
          if (body.trim()) {
            const normalized = body.replace(/\r\n?/g, "\n").replace(/\0/g, "\uFFFD");
            const digest = createHash("sha256").update(normalized, "utf8").digest("base64");
            inlineHashes.push(`'sha256-${digest}'`);
          }
        }
        return html.replace(
          /(<meta\s+http-equiv=["']Content-Security-Policy["']\s+content=(["']))([\s\S]*?)(\2)/i,
          (_full, prefix: string, _quote: string, content: string, suffix: string) => {
            let updated = content;
            if (inlineHashes.length > 0) {
              updated = updated.replace(/script-src\s+([^;]+)/i, (_m, sources: string) =>
                `script-src ${sources.trim()} ${inlineHashes.join(" ")}`,
              );
            }
            updated = updated.replace(/connect-src\s+([^;]+)/i, (_m, sources: string) =>
              `connect-src ${sources.trim()} ws://127.0.0.1:1420 ws://localhost:1420`,
            );
            return `${prefix}${updated}${suffix}`;
          },
        );
      },
    },
  };
}

export default defineConfig(({mode}) => ({
  base: "./",
  plugins: [react(), mermaidSandboxPlugin(), htmlCspPlugin()],
  // These imports are reached only through the lazy writing worker. Discover
  // them before serving a page so first use cannot trigger an optimizer reload
  // and discard the native reader's in-memory workspace.
  optimizeDeps: {include: ["nspell", "retext-english", "retext-repeated-words", "retext-indefinite-article", "vfile"]},
  // The package's browser default allocates a DOM element at import time.
  // Its equivalent table decoder also works in the offline writing worker.
  resolve: {alias:{"decode-named-character-reference":fileURLToPath(new URL("./node_modules/decode-named-character-reference/index.js",import.meta.url))}},
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/target/**", "**/smd-core/target/**", "**/android/**/build/**", "**/desktop/.venv/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_"]
  ,build: { rollupOptions: { input: buildHtmlEntries(mode) } }
}));
