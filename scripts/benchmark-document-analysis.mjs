#!/usr/bin/env node
// Isolated, non-shipped benchmark for the current synchronous analysis path
// versus the same implementation in a module worker. Only generated fixtures
// are loaded; the script never starts the Super MD desktop application.
import { createServer } from "vite";
import { chromium } from "playwright";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { createDocumentAnalysisFixtures } from "./document-analysis-fixtures.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function parseArgs(argv) {
  const options = { repetitions: 3, fixtures: null, output: null, help: false };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--repetitions" || argument === "--fixtures" || argument === "--output") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${argument}`);
      if (argument === "--repetitions") options.repetitions = Number(value);
      if (argument === "--fixtures") options.fixtures = value.split(",").map(name => name.trim()).filter(Boolean);
      if (argument === "--output") options.output = value;
    } else throw new Error(`Unknown option: ${argument}`);
  }
  if (!options.help && (!Number.isInteger(options.repetitions) || options.repetitions < 3 || options.repetitions > 10)) {
    throw new Error("--repetitions must be an integer between 3 and 10");
  }
  const valid = new Set(createDocumentAnalysisFixtures().map(fixture => fixture.name));
  if (options.fixtures?.some(name => !valid.has(name))) throw new Error("--fixtures contains an unknown fixture");
  return options;
}

function help() {
  return `Usage: node scripts/benchmark-document-analysis.mjs [options]

Runs a synthetic, isolated browser benchmark against the current synchronous
document analyzer and the same analyzer in a dedicated module worker.

Options:
  --repetitions N   Cold repetitions per fixture (3..10, default 3)
  --fixtures LIST   Comma-separated fixture names (default: all bounded fixtures)
  --output PATH     Save JSON report (default: stdout)
  --help            Show this help
`;
}

async function run(options) {
  const server = await createServer({
    root: REPOSITORY_ROOT,
    configFile: resolve(REPOSITORY_ROOT, "vite.config.ts"),
    mode: "development",
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false, open: false },
  });
  let browser;
  try {
    await server.listen();
    const address = server.httpServer.address();
    if (!address || typeof address === "string") throw new Error("Vite did not expose a local benchmark port");
    browser = await chromium.launch({ headless: true });
    const base = `http://127.0.0.1:${address.port}`;
    const available = createDocumentAnalysisFixtures().map(fixture => fixture.name);
    const fixtureNames = options.fixtures ?? available;
    const samples = [];
    for (const fixtureName of fixtureNames) {
      for (let repetition = 1; repetition <= options.repetitions; repetition++) {
        const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
        page.setDefaultTimeout(600_000);
        const errors = [];
        page.on("pageerror", error => errors.push(error.message));
        try {
          const response = await page.goto(`${base}/scripts/document-analysis-bench.html`, { waitUntil: "networkidle" });
          if (!response?.ok()) throw new Error(`Could not open isolated benchmark harness: ${response?.status() ?? "no response"}`);
          await page.waitForFunction(() => typeof window.runDocumentAnalysisSample === "function");
          const sample = await page.evaluate(input => window.runDocumentAnalysisSample(input), { fixtureName, repetition });
          if (errors.length) throw new Error(`Browser benchmark error: ${errors.join("; ")}`);
          samples.push(sample);
        } finally {
          await page.close();
        }
      }
    }
    const fixtures = createDocumentAnalysisFixtures().filter(fixture => fixtureNames.includes(fixture.name));
    const report = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      methodology: {
        parser: "The current src/documentAnalysis.ts analyzeDocument implementation is called unchanged in the main thread and a dedicated module worker.",
        workerCold: "Measured immediately around worker creation, source postMessage clone, parse, complete AST/projection postMessage clone and reply; workerParseMs is measured around analyzeDocument inside the worker.",
        synchronousCold: "Measures analyzeDocument plus a structuredClone of its result to approximate the existing CachedMarkdown clone; parse and clone durations are reported separately.",
        responsiveness: "Maximum requestAnimationFrame interval observed around each operation in a foreground headless page; this is scheduling responsiveness, not presented pixels.",
        warm: "Same-source second request using each module's existing bounded analysis LRU.",
        evicted: "After 16 unique small sources, exceeding the current 16-entry LRU limit; not a byte-cache stress test.",
        isolation: "Each fixture/repetition runs in a fresh page and closes it before the next sample so module-local analysis LRUs do not accumulate across samples.",
        memory: "No heap or process-tree memory is measured; Chromium may retain shared process allocations. The report makes no worker memory-benefit claim.",
        fixtures: "Generated synthetic Markdown only, maximum 4,000,000 ASCII bytes and AST node guard 50,000; no personal files or app workspace state.",
        limitations: "Worker results are returned as cloned full ASTs. The benchmark does not implement async consumers, renderer integration, revision/staleness handling, app UI or whole-process PSS.",
      },
      configuration: { repetitions: options.repetitions, fixtures: fixtures.map(({ name, sourceBytes }) => ({ name, sourceBytes })) },
      metadata: {
        nodeVersion: process.version,
        browserVersion: browser.version(),
        platform: process.platform,
        architecture: process.arch,
      },
      samples,
    };
    return report;
  } finally {
    await browser?.close().catch(() => {});
    await server.close();
  }
}

async function main() {
  let options;
  try { options = parseArgs(process.argv.slice(2)); }
  catch (error) { console.error(`${error.message}\nUse --help for options.`); process.exitCode = 2; return; }
  if (options.help) { console.log(help()); return; }
  try {
    const report = await run(options);
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    if (options.output) {
      const target = resolve(options.output);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, serialized, "utf8");
    } else process.stdout.write(serialized);
  } catch (error) { console.error(error.stack ?? String(error)); process.exitCode = 1; }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) void main();
