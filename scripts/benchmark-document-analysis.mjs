#!/usr/bin/env node
// Isolated, non-shipped benchmark for the current synchronous analysis path
// versus the same implementation in a module worker. Only generated fixtures
// are loaded; the script never starts the Super MD desktop application.
import { createServer } from "vite";
import { chromium } from "playwright";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { createDocumentAnalysisFixtures } from "./document-analysis-fixtures.mjs";

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
    configFile: resolve("vite.config.ts"),
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
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.setDefaultTimeout(600_000);
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const base = `http://127.0.0.1:${address.port}`;
    const response = await page.goto(`${base}/scripts/document-analysis-bench.html`, { waitUntil: "networkidle" });
    if (!response?.ok()) throw new Error(`Could not open isolated benchmark harness: ${response?.status() ?? "no response"}`);
    await page.waitForFunction(() => typeof window.runDocumentAnalysisBenchmark === "function");
    const report = await page.evaluate(options => window.runDocumentAnalysisBenchmark(options), {
      repetitions: options.repetitions,
      selectedFixtures: options.fixtures,
    });
    if (errors.length) throw new Error(`Browser benchmark error: ${errors.join("; ")}`);
    report.metadata = {
      nodeVersion: process.version,
      browserVersion: browser.version(),
      platform: process.platform,
      architecture: process.arch,
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
      await mkdir(resolve(target, ".."), { recursive: true });
      await writeFile(target, serialized, "utf8");
    } else process.stdout.write(serialized);
  } catch (error) { console.error(error.stack ?? String(error)); process.exitCode = 1; }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) void main();
