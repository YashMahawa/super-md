import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

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

export type MermaidSandboxBuildOutput =
  | string
  | {
      script: string;
      inputs?: Iterable<string>;
    };

export function mermaidSandboxPlugin(
  buildSandboxScript?: () => Promise<MermaidSandboxBuildOutput>,
): Plugin {
  const repoRoot = fileURLToPath(new URL(".", import.meta.url));
  const virtualId = "virtual:mermaid-sandbox-url";
  const resolvedId = "\0" + virtualId;
  const devRoute = "/@mermaid-sandbox.html";
  const devScriptRoute = "/@mermaid-sandbox.js";
  let isServe = false;
  let isNative = false;
  let cachedBundlePromise: Promise<{ script: string; html: string }> | null = null;
  let latestBuildId = 0;
  let watchedInputs = new Set<string>();

  const normalizeWatchPath = (filePath: string) => {
    const resolved = path.resolve(repoRoot, filePath);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };

  const runDefaultBuild = async (): Promise<{ script: string; inputs: string[] }> => {
    const esbuild = await import("esbuild");
    const entry = fileURLToPath(new URL("./src/mermaidSandboxEntry.ts", import.meta.url));
    const bundled = await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      metafile: true,
      write: false,
      format: "iife",
      platform: "browser",
      target: "es2020",
      charset: "ascii",
      legalComments: "none",
      minify: true,
      alias: {
        "decode-named-character-reference": fileURLToPath(
          new URL("./node_modules/decode-named-character-reference/index.js", import.meta.url),
        ),
      },
    });
    return {
      script: bundled.outputFiles[0]?.text ?? "",
      inputs: Object.keys(bundled.metafile?.inputs ?? {}),
    };
  };

  const getSandboxBundle = () => {
    if (!cachedBundlePromise) {
      const buildId = ++latestBuildId;
      let buildPromise: Promise<{ script: string; html: string }>;
      buildPromise = (async () => {
        const built = buildSandboxScript
          ? await buildSandboxScript()
          : await runDefaultBuild();
        const script = typeof built === "string" ? built : built.script;
        const inputs = typeof built === "string" ? undefined : built.inputs;
        const html = renderSandboxDocument(script);
        if (buildId === latestBuildId && cachedBundlePromise === buildPromise && inputs) {
          watchedInputs = new Set(Array.from(inputs, normalizeWatchPath));
        }
        return { script, html };
      })().catch((error) => {
        if (buildId === latestBuildId && cachedBundlePromise === buildPromise) {
          cachedBundlePromise = null;
        }
        throw error;
      });
      cachedBundlePromise = buildPromise;
    }
    return cachedBundlePromise;
  };

  return {
    name: "supermd-mermaid-sandbox",
    configResolved(config) {
      isServe = config.command === "serve";
      isNative = config.mode === "native";
    },
    resolveId(id) {
      if (id === virtualId) return resolvedId;
      return null;
    },
    configureServer(server) {
      const invalidateIfSandboxSource = (filePath: string) => {
        if (
          /[\\/]mermaidSandbox/i.test(filePath) ||
          watchedInputs.has(normalizeWatchPath(filePath))
        ) {
          latestBuildId += 1;
          cachedBundlePromise = null;
        }
      };
      server.watcher?.on("change", invalidateIfSandboxSource);
      server.watcher?.on("add", invalidateIfSandboxSource);
      server.watcher?.on("unlink", invalidateIfSandboxSource);
      void getSandboxBundle().catch(() => {});

      server.middlewares.use(async (req, res, next) => {
        const requestPath = req.url?.split("?", 1)[0];
        if (
          (requestPath !== devRoute && requestPath !== devScriptRoute) ||
          (req.method !== "GET" && req.method !== "HEAD")
        ) {
          next();
          return;
        }
        try {
          const bundle = await getSandboxBundle();
          const isScript = requestPath === devScriptRoute;
          res.statusCode = 200;
          res.setHeader(
            "Content-Type",
            isScript ? "application/javascript; charset=utf-8" : "text/html; charset=utf-8",
          );
          res.setHeader("Cache-Control", "no-store");
          res.end(req.method === "HEAD" ? undefined : isScript ? bundle.script : bundle.html);
        } catch (error) {
          next(error);
        }
      });
    },
    async load(id) {
      if (id !== resolvedId) return null;
      if (isServe) {
        return `export const sandboxScriptUrl = ${JSON.stringify(devScriptRoute)}; export default ${JSON.stringify(devRoute)};`;
      }
      const bundle = await getSandboxBundle();
      const refId = this.emitFile({
        type: "asset",
        name: "mermaid-sandbox.html",
        source: bundle.html,
      });
      if (!isNative && !process.env.TAURI_ENV_PLATFORM) {
        const scriptRefId = this.emitFile({
          type: "asset",
          name: "mermaid-sandbox.js",
          source: bundle.script,
        });
        return [
          `export const sandboxScriptUrl = new URL(import.meta.ROLLUP_FILE_URL_${scriptRefId}, import.meta.url).href;`,
          `export default new URL(import.meta.ROLLUP_FILE_URL_${refId}, import.meta.url).href;`,
        ].join("\n");
      }
      return [
        "export const sandboxScriptUrl = undefined;",
        `export default new URL(import.meta.ROLLUP_FILE_URL_${refId}, import.meta.url).href;`,
      ].join("\n");
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
  plugins: [woff2MathFontsPlugin(), react(), mermaidSandboxPlugin(), htmlCspPlugin()],
  // These imports are reached only through the lazy writing worker. Discover
  // them before serving a page so first use cannot trigger an optimizer reload
  // and discard the native reader's in-memory workspace.
  optimizeDeps: {
    include: ["nspell", "retext-english", "retext-repeated-words", "retext-indefinite-article", "vfile", "pele/lazy", "dompurify"],
    exclude: ["mermaid"],
  },
  // The package's browser default allocates a DOM element at import time.
  // Its equivalent table decoder also works in the offline writing worker.
  resolve: {alias:{"decode-named-character-reference":fileURLToPath(new URL("./node_modules/decode-named-character-reference/index.js",import.meta.url))}},
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/dist/**", "**/src-tauri/target/**", "**/smd-core/target/**", "**/android/**/build/**", "**/desktop/.venv/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_"]
  ,build: { rollupOptions: { input: buildHtmlEntries(mode) } }
}));
