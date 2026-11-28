import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OutputAsset, OutputChunk, RollupOutput } from "rollup";
import { build, createServer, type Plugin, type WatchOptions } from "vite";
import { expect, it } from "vitest";
import viteConfigFactory from "./vite.config";

function resolveUserConfig(command: "build" | "serve", mode: string) {
  return typeof viteConfigFactory === "function"
    ? viteConfigFactory({ command, mode, isSsrBuild: false, isPreview: false })
    : viteConfigFactory;
}

async function collectWatcherEvents(ignored: WatchOptions["ignored"]) {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "supermd-vite-watch-"));
  mkdirSync(path.join(workspaceRoot, "src"), { recursive: true });
  writeFileSync(path.join(workspaceRoot, "src", "probe.ts"), "export const v = 1;\n");

  const artifactEvents: string[] = [];
  const sourceEvents: string[] = [];
  const server = await createServer({
    configFile: false,
    root: workspaceRoot,
    logLevel: "silent",
    optimizeDeps: { noDiscovery: true },
    server: {
      middlewareMode: true,
      hmr: false,
      watch: {
        ignored,
        ignoreInitial: true,
      },
    },
  });

  try {
    const record = (kind: string) => (filePath: string) => {
      const rel = path.relative(workspaceRoot, filePath).split(path.sep).join("/");
      if (rel.startsWith("..")) return;
      if (rel === "src/probe.ts") {
        sourceEvents.push(`${kind}:${rel}`);
      } else {
        artifactEvents.push(`${kind}:${rel}`);
      }
    };
    server.watcher.on("add", record("add"));
    server.watcher.on("change", record("change"));

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      server.watcher.once("ready", finish);
      setTimeout(finish, 250);
    });

    mkdirSync(path.join(workspaceRoot, "coverage"), { recursive: true });
    mkdirSync(path.join(workspaceRoot, "playwright-report"), { recursive: true });
    writeFileSync(path.join(workspaceRoot, "coverage", "coverage-final.json"), "{}\n");
    writeFileSync(path.join(workspaceRoot, "playwright-report", "index.html"), "<!doctype html>");
    writeFileSync(path.join(workspaceRoot, "tsconfig.node.tsbuildinfo"), "{}\n");

    await new Promise((resolve) => setTimeout(resolve, 250));

    writeFileSync(path.join(workspaceRoot, "src", "probe.ts"), "export const v = 2;\n");
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline && sourceEvents.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 40));
    }

    return { artifactEvents, sourceEvents };
  } finally {
    await server.close();
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

it("ignores coverage, playwright-report, and tsbuildinfo outputs that otherwise trigger Vite watcher events", async () => {
  const baseline = await collectWatcherEvents([
    "**/dist/**",
    "**/smd-core/target/**",
    "**/android/**/build/**",
    "**/desktop/.venv/**",
  ]);
  expect(baseline.artifactEvents).toEqual(
    expect.arrayContaining([
      "add:coverage/coverage-final.json",
      "add:playwright-report/index.html",
      "add:tsconfig.node.tsbuildinfo",
    ]),
  );
  expect(baseline.sourceEvents.length).toBeGreaterThan(0);

  const userConfig = await resolveUserConfig("serve", "development");
  const configured = await collectWatcherEvents(userConfig.server?.watch?.ignored);
  expect(configured.artifactEvents).toEqual([]);
  expect(configured.sourceEvents.length).toBeGreaterThan(0);
}, 15_000);

it("consolidates pele into one strictly lazy Rollup chunk without hoisting it into app, Android, or Qt HTML entries", async () => {
  const userConfig = await resolveUserConfig("build", "production");
  const rawOutput = userConfig.build?.rollupOptions?.output;
  const outputConfig = Array.isArray(rawOutput) ? rawOutput[0] : rawOutput;
  expect(outputConfig?.manualChunks).toBeTypeOf("function");

  const virtualAppHtml = path.resolve("__probe_index.html");
  const virtualAndroidHtml = path.resolve("__probe_android-reader.html");
  const virtualQtHtml = path.resolve("__probe_qt-reader.html");
  const virtualAppJs = path.resolve("__probe_app.js");
  const virtualAndroidJs = path.resolve("__probe_androidReader.js");
  const virtualQtJs = path.resolve("__probe_qtReader.js");
  const virtualSharedJs = path.resolve("__probe_shared.js");
  const virtualOtherLazyJs = path.resolve("__probe_other_lazy.js");
  const fakePeleLazy = path.resolve("node_modules/pele/__probe_lazy.js");
  const fakePeleFlowchart = path.resolve("node_modules/pele/diagrams/__probe_flowchart.js");
  const fakePeleSequence = path.resolve("node_modules/pele/diagrams/__probe_sequence.js");

  const probePlugin: Plugin = {
    name: "supermd-pele-lazy-chunk-probe",
    resolveId(id) {
      if (id === virtualAppHtml || id.endsWith("__probe_index.html")) return virtualAppHtml;
      if (id === virtualAndroidHtml || id.endsWith("__probe_android-reader.html")) return virtualAndroidHtml;
      if (id === virtualQtHtml || id.endsWith("__probe_qt-reader.html")) return virtualQtHtml;
      if (id === "./__probe_app.js" || id === virtualAppJs) return virtualAppJs;
      if (id === "./__probe_androidReader.js" || id === virtualAndroidJs) return virtualAndroidJs;
      if (id === "./__probe_qtReader.js" || id === virtualQtJs) return virtualQtJs;
      if (id === "./__probe_shared.js" || id === virtualSharedJs) return virtualSharedJs;
      if (id === "./__probe_other_lazy.js" || id === virtualOtherLazyJs) return virtualOtherLazyJs;
      if (id === "pele/lazy" || id === fakePeleLazy) return fakePeleLazy;
      if (id === "./diagrams/__probe_flowchart.js" || id === fakePeleFlowchart) return fakePeleFlowchart;
      if (id === "./diagrams/__probe_sequence.js" || id === fakePeleSequence) return fakePeleSequence;
      return null;
    },
    load(id) {
      if (id === virtualAppHtml) {
        return '<!doctype html><script type="module" src="./__probe_app.js"></script>';
      }
      if (id === virtualAndroidHtml) {
        return '<!doctype html><script type="module" src="./__probe_androidReader.js"></script>';
      }
      if (id === virtualQtHtml) {
        return '<!doctype html><script type="module" src="./__probe_qtReader.js"></script>';
      }
      if (id === virtualAppJs) {
        return 'import { renderDiagram, loadOther } from "./__probe_shared.js"; globalThis.__app = [renderDiagram, loadOther];';
      }
      if (id === virtualAndroidJs) {
        return 'import { renderDiagram, loadOther } from "./__probe_shared.js"; export const boot = [renderDiagram, loadOther]; globalThis.__android = boot;';
      }
      if (id === virtualQtJs) {
        return 'globalThis.__qt = () => import("./__probe_androidReader.js");';
      }
      if (id === virtualSharedJs) {
        return [
          'export const loadOther = () => import("./__probe_other_lazy.js");',
          'export const renderDiagram = (kind) => import("pele/lazy").then((m) => m.renderAsync(kind));',
        ].join("\n");
      }
      if (id === virtualOtherLazyJs) {
        return "export const ok = 1;";
      }
      if (id === fakePeleLazy) {
        return [
          'export async function renderAsync(kind) {',
          '  return kind === "seq" ? import("./diagrams/__probe_sequence.js") : import("./diagrams/__probe_flowchart.js");',
          "}",
        ].join("\n");
      }
      if (id === fakePeleFlowchart) {
        return 'export const diagram = "flowchart";';
      }
      if (id === fakePeleSequence) {
        return 'export const diagram = "sequence";';
      }
      return null;
    },
  };

  const runProbeBuild = async (manualChunks?: NonNullable<typeof outputConfig>["manualChunks"]) => {
    const built = await build({
      configFile: false,
      logLevel: "silent",
      plugins: [probePlugin],
      build: {
        write: false,
        minify: false,
        copyPublicDir: false,
        rollupOptions: {
          input: {
            app: virtualAppHtml,
            reader: virtualAndroidHtml,
            qtReader: virtualQtHtml,
          },
          output: manualChunks ? { manualChunks } : undefined,
        },
      },
    });
    const rollupOutput = (Array.isArray(built) ? built[0] : built) as RollupOutput;
    const chunks = rollupOutput.output.filter((item): item is OutputChunk => item.type === "chunk");
    const htmlAssets = rollupOutput.output.filter(
      (item): item is OutputAsset => item.type === "asset" && item.fileName.endsWith(".html"),
    );
    const peleChunks = chunks.filter((chunk) =>
      Object.keys(chunk.modules).some((moduleId) => /[\\/]node_modules[\\/]pele[\\/]/.test(moduleId)),
    );
    return { chunks, htmlAssets, peleChunks };
  };

  const ungrouped = await runProbeBuild(undefined);
  expect(ungrouped.peleChunks.length).toBeGreaterThan(1);

  const consolidated = await runProbeBuild(outputConfig?.manualChunks);
  expect(consolidated.peleChunks).toHaveLength(1);
  expect(consolidated.htmlAssets).toHaveLength(3);

  const peleFileName = consolidated.peleChunks[0]!.fileName;
  for (const chunk of consolidated.chunks) {
    if (chunk.fileName !== peleFileName) {
      expect(chunk.imports).not.toContain(peleFileName);
    }
  }

  for (const htmlAsset of consolidated.htmlAssets) {
    const htmlSource = String(htmlAsset.source);
    expect(htmlSource).not.toContain(peleFileName);
    expect(htmlSource).not.toMatch(/pele-[^"'<>]+\.js/);
  }
}, 20_000);
