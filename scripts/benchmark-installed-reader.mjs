#!/usr/bin/env node
// Reproducible installed Qt reader benchmark. It launches only the supplied
// executable with isolated test state and synthetic Markdown; it never opens
// or edits a user's notes or the normal Super MD instance.
import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const DEFAULTS = {
  repetitions: 3,
  warmCycles: 2,
  frameSamples: 120,
  quitAfterMs: 120_000,
  startupTimeoutMs: 45_000,
  oneMbBytes: 1_000_000,
  manyBlockCount: 1_500,
  hugeBlockBytes: 256 * 1024,
  mathCount: 80,
};
const FIXTURE_NAMES = ['small', 'math-heavy', '1mb', 'many-blocks', 'huge-single-block'];
const OPTIONAL_FIXTURE_NAMES = ['image-heavy'];
export const IMAGE_FIXTURE_MAX_PIXELS = 32_000_000;
export const IMAGE_FIXTURE_MAX_EDGE = 8192;
export const IMAGE_FIXTURE_MAX_SOURCE_BYTES = 2_000_000;
const IMAGE_HEAVY_DIMENSIONS = [
  { width: 2800, height: 2800 },
  { width: 2800, height: 2800 },
  { width: 2800, height: 2800 },
  { width: 2800, height: 2800 },
];

export function validateImageFixtureDimensions(dimensions, maximumPixels = IMAGE_FIXTURE_MAX_PIXELS) {
  if (!Array.isArray(dimensions) || !dimensions.length) throw new Error('Image fixture must contain at least one image');
  if (!Number.isSafeInteger(maximumPixels) || maximumPixels < 1) throw new Error('Image fixture pixel limit must be a positive safe integer');
  let totalPixels = 0;
  for (const [index, dimension] of dimensions.entries()) {
    const { width, height } = dimension ?? {};
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > IMAGE_FIXTURE_MAX_EDGE || height > IMAGE_FIXTURE_MAX_EDGE) {
      throw new Error(`Image ${index + 1} dimensions must be positive safe integers no greater than ${IMAGE_FIXTURE_MAX_EDGE}`);
    }
    const pixels = width * height;
    if (!Number.isSafeInteger(pixels) || totalPixels + pixels > maximumPixels) {
      throw new Error(`Image fixture exceeds the ${maximumPixels}-pixel bound`);
    }
    totalPixels += pixels;
  }
  return totalPixels;
}

export function pngDimensions(png) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!Buffer.isBuffer(png) || png.length < 24 || !png.subarray(0, 8).equals(signature) || png.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error('Invalid PNG header');
  }
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type, 'ascii');
  const chunk = Buffer.allocUnsafe(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  name.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
  return chunk;
}

function syntheticPng(width, height, seed) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 6; // 8-bit RGBA, standard compression/filter, no interlace.
  const rowBytes = width * 4 + 1;
  const raw = Buffer.allocUnsafe(rowBytes * height);
  const rowData = Buffer.alloc(rowBytes);
  for (let x = 0; x < width; x++) {
    const pixel = 1 + x * 4;
    rowData[pixel] = (seed * 43) & 0xff;
    rowData[pixel + 1] = (seed * 71) & 0xff;
    rowData[pixel + 2] = (seed * 29) & 0xff;
    rowData[pixel + 3] = 255;
  }
  for (let y = 0; y < height; y++) rowData.copy(raw, y * rowBytes);
  const compressed = deflateSync(raw, { level: 1 });
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header), pngChunk('IDAT', compressed), pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

export function createImageHeavyFixture(dimensions = IMAGE_HEAVY_DIMENSIONS) {
  const decodedPixels = validateImageFixtureDimensions(dimensions);
  const images = dimensions.map((size, index) => {
    const png = syntheticPng(size.width, size.height, index + 1);
    const parsed = pngDimensions(png);
    if (parsed.width !== size.width || parsed.height !== size.height) throw new Error('Generated PNG dimensions did not match the fixture plan');
    return {
      ...size,
      pngBytes: png.length,
      source: `data:image/png;base64,${png.toString('base64')}`,
    };
  });
  const imageMarkdown = images.map((image, index) => `### Synthetic image ${index + 1} (${image.width} × ${image.height})\n\n![Generated benchmark image ${index + 1}](${image.source})`).join('\n\n');
  const content = `# Image-heavy synthetic note\n\nAn equation keeps the common readiness probe active: $E=mc^2$.\n\n${imageMarkdown}\n`;
  const sourceBytes = Buffer.byteLength(content);
  if (sourceBytes > IMAGE_FIXTURE_MAX_SOURCE_BYTES) throw new Error(`Image fixture source exceeds the ${IMAGE_FIXTURE_MAX_SOURCE_BYTES}-byte budget`);
  return {
    name: 'image-heavy', content, title: 'Image-heavy synthetic note',
    sourceBytes, synthetic: true, hasEquation: true,
    blockCount: content.split(/\n\s*\n/).filter(Boolean).length,
    images: images.map(({ width, height, pngBytes }) => ({ width, height, pngBytes })),
    decodedPixels, decodedMegapixels: decodedPixels / 1_000_000,
  };
}

export function percentile(values, fraction = 0.95) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index];
}

function summarize(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length ? { count: finite.length, median: percentile(finite, 0.5), p95: percentile(finite, 0.95) } : { count: 0, median: null, p95: null };
}

export function aggregateSamples(samples) {
  const fields = ['firstEquationMs', 'fontReadyMs', 'presentedRafReadyMs', 'frameIntervalP95Ms', 'zoomCallP95Ms', 'jsHeapBytes', 'domElements', 'imageReadyMs', 'imageLayoutShift', 'imageDecodedPixels', 'imageTraversalSteps', 'imagePeakSampledPssKb', 'imagePeakSampledRssKb', 'imagePeakSampledHeapBytes'];
  return Object.fromEntries(fields.map(field => [field, summarize(samples.map(sample => sample[field]))]));
}

export function formatReadinessDiagnostics(snapshot = {}) {
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const mode = ['reader', 'editor', 'live', 'split'].includes(snapshot.mode) ? snapshot.mode : 'unknown';
  return {
    titlePresent: snapshot.titlePresent === true,
    headingCount: count(snapshot.headingCount),
    mathCount: count(snapshot.mathCount),
    mode,
    windowedMounted: count(snapshot.windowedMounted),
    imageCount: count(snapshot.imageCount),
    readerScrollHeight: count(snapshot.readerScrollHeight),
    readerClientHeight: count(snapshot.readerClientHeight),
  };
}

export function parseProcStat(contents) {
  const close = contents.lastIndexOf(')');
  const open = contents.indexOf('(');
  if (open < 0 || close <= open) return null;
  const pid = Number(contents.slice(0, open).trim());
  const fields = contents.slice(close + 1).trim().split(/\s+/);
  const ppid = Number(fields[1]); // remainder starts with state (field 3).
  return Number.isInteger(pid) && pid > 0 && Number.isInteger(ppid) && ppid >= 0 ? { pid, ppid } : null;
}

function procValue(contents, name) {
  const match = contents.match(new RegExp(`^${name}:\\s+(\\d+)\\s+kB$`, 'm'));
  return match ? Number(match[1]) : null;
}

export function parseProcMemory(status, smapsRollup) {
  return { rssKb: procValue(status, 'VmRSS'), pssKb: procValue(smapsRollup, 'Pss') };
}

async function readOptional(file) {
  try { return await readFile(file, 'utf8'); } catch { return ''; }
}

export async function aggregateProcessTree(rootPid, procRoot = '/proc') {
  const names = await readdir(procRoot, { withFileTypes: true });
  const processes = new Map();
  await Promise.all(names.filter(entry => entry.isDirectory() && /^\d+$/.test(entry.name)).map(async entry => {
    const pid = Number(entry.name);
    const parsed = parseProcStat(await readOptional(path.join(procRoot, entry.name, 'stat')));
    if (parsed?.pid === pid) processes.set(pid, parsed);
  }));
  const children = new Map();
  for (const { pid, ppid } of processes.values()) {
    const list = children.get(ppid) ?? [];
    list.push(pid);
    children.set(ppid, list);
  }
  const pids = [], pending = [rootPid], visited = new Set();
  while (pending.length) {
    const pid = pending.pop();
    if (visited.has(pid) || !processes.has(pid)) continue;
    visited.add(pid); pids.push(pid); pending.push(...(children.get(pid) ?? []));
  }
  let rssKb = 0, pssKb = 0, rssProcessCount = 0, pssProcessCount = 0;
  await Promise.all(pids.map(async pid => {
    const folder = path.join(procRoot, String(pid));
    const [status, rollup] = await Promise.all([readOptional(path.join(folder, 'status')), readOptional(path.join(folder, 'smaps_rollup'))]);
    const memory = parseProcMemory(status, rollup);
    if (memory.rssKb !== null) { rssKb += memory.rssKb; rssProcessCount++; }
    if (memory.pssKb !== null) { pssKb += memory.pssKb; pssProcessCount++; }
  }));
  return {
    pids: pids.sort((a, b) => a - b), processCount: pids.length,
    rssKb: rssProcessCount === pids.length && pids.length ? rssKb : null,
    pssKb: pssProcessCount === pids.length && pids.length ? pssKb : null,
    rssProcessCount, pssProcessCount,
  };
}

function paragraph(index, count = 1) {
  return `Synthetic block ${index}: ${'Readable study text with a stable layout. '.repeat(count)} $x_${index}=\\frac{a+b}{c+d}$.`;
}

export function createFixtures(options = {}) {
  const config = { ...DEFAULTS, ...options };
  const small = `# Small synthetic note\n\nA compact reading fixture with a first equation $E=mc^2$.\n\n${paragraph(1, 3)}\n`;
  const mathHeavy = `# Math-heavy synthetic note\n\n${Array.from({ length: config.mathCount }, (_, i) => `## Equation ${i + 1}\n\n${paragraph(i, 1)}\n\n$$\\int_0^1 x^${i % 5 + 1}\\,dx = \\frac{1}{${i % 5 + 2}}$$`).join('\n\n')}`;
  let oneMb = '# Synthetic 1 MB note\n\nThe bytes below are generated, ASCII-only fixture content. $E=mc^2$.\n';
  let block = 0;
  while (oneMb.length < config.oneMbBytes) {
    const next = `\n\n${paragraph(block++, 10)}\n`;
    const room = config.oneMbBytes - oneMb.length;
    oneMb += next.length <= room ? next : next.slice(0, room);
  }
  const manyBlocks = `# Many-block synthetic note\n\n${Array.from({ length: config.manyBlockCount }, (_, i) => paragraph(i, 1)).join('\n\n')}`;
  const hugePrefix = '# Huge single-block synthetic note\n\nInline equation $E=mc^2$. ';
  const hugeBody = 'A single generated paragraph keeps top-level block count low while source size grows. ';
  const hugeSingleBlock = hugePrefix + hugeBody.repeat(Math.ceil((config.hugeBlockBytes - hugePrefix.length) / hugeBody.length));
  return [
    { name: 'small', content: small },
    { name: 'math-heavy', content: mathHeavy },
    { name: '1mb', content: oneMb },
    { name: 'many-blocks', content: manyBlocks },
    { name: 'huge-single-block', content: hugeSingleBlock },
  ].map(fixture => ({
    ...fixture,
    title: fixture.content.match(/^#\s+(.+)$/m)?.[1] ?? fixture.name,
    sourceBytes: Buffer.byteLength(fixture.content),
    synthetic: true,
    hasEquation: fixture.content.includes('$'),
    blockCount: fixture.content.split(/\n\s*\n/).filter(Boolean).length,
  }));
}

function parseArgs(argv) {
  const args = { ...DEFAULTS, fixtures: [...FIXTURE_NAMES] };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const value = () => {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new Error(`Missing value for ${key}`);
      return argv[++i];
    };
    if (key === '--help' || key === '-h') args.help = true;
    else if (key === '--binary') args.binary = value();
    else if (key === '--entrypoint') args.entrypoint = value();
    else if (key === '--output') args.output = value();
    else if (key === '--label') args.label = value();
    else if (key === '--fixtures') args.fixtures = value().split(',').map(item => item.trim()).filter(Boolean);
    else if (['--repetitions', '--warm-cycles', '--frame-samples', '--quit-after-ms', '--startup-timeout-ms', '--one-mb-bytes', '--many-block-count', '--huge-block-bytes', '--math-count'].includes(key)) {
      const number = Number(value());
      if (!Number.isSafeInteger(number) || number < (key === '--warm-cycles' ? 0 : 1)) throw new Error(`${key} must be a ${key === '--warm-cycles' ? 'nonnegative' : 'positive'} safe integer`);
      const field = ({ '--quit-after-ms': 'quitAfterMs', '--startup-timeout-ms': 'startupTimeoutMs', '--one-mb-bytes': 'oneMbBytes', '--many-block-count': 'manyBlockCount', '--huge-block-bytes': 'hugeBlockBytes', '--math-count': 'mathCount', '--warm-cycles': 'warmCycles', '--frame-samples': 'frameSamples', '--repetitions': 'repetitions' })[key];
      args[field] = number;
    } else throw new Error(`Unknown option: ${key}`);
  }
  if (args.help) return args;
  if (!args.binary) throw new Error('Specify an installed reader with --binary PATH');
  if (args.repetitions < 3) throw new Error('--repetitions must be at least 3 for comparable cold samples');
  if (args.warmCycles > 5) throw new Error('--warm-cycles is bounded to 5');
  if (args.frameSamples < 30 || args.frameSamples > 600) throw new Error('--frame-samples must be between 30 and 600');
  if (args.quitAfterMs < 15_000 || args.quitAfterMs > 600_000) throw new Error('--quit-after-ms must be between 15000 and 600000');
  if (args.startupTimeoutMs < 5_000 || args.startupTimeoutMs > args.quitAfterMs) throw new Error('--startup-timeout-ms must be 5000 or greater and no greater than --quit-after-ms');
  if (args.oneMbBytes < 1_000_000 || args.oneMbBytes > 16_000_000) throw new Error('--one-mb-bytes must be between 1000000 and 16000000');
  if (args.manyBlockCount > 20_000) throw new Error('--many-block-count is bounded to 20000');
  if (args.hugeBlockBytes > 16_000_000) throw new Error('--huge-block-bytes is bounded to 16000000');
  if (args.mathCount > 2_000) throw new Error('--math-count is bounded to 2000');
  const unknownFixtures = args.fixtures.filter(name => ![...FIXTURE_NAMES, ...OPTIONAL_FIXTURE_NAMES].includes(name));
  if (!args.fixtures.length || unknownFixtures.length) throw new Error(`Unknown or empty fixture selection: ${unknownFixtures.join(', ') || '(empty)'}`);
  return args;
}

function help() {
  return `Usage: node scripts/benchmark-installed-reader.mjs --binary PATH [options]

Runs synthetic reader fixtures in fresh installed-app processes using --test-state,
--safe-graphics, --quit-after and loopback Qt WebEngine remote debugging.

Options:
  --binary PATH             Installed Super MD executable (required)
  --entrypoint PATH         Optional Python source entrypoint; marks this as a source run
  --output PATH             Write the full JSON report (default: stdout)
  --label TEXT              Human-readable build label, e.g. baseline-0.6.4
  --repetitions N           Fresh app launches per fixture (default: 3, minimum: 3)
  --warm-cycles N           Same-source revisit and theme cycles (default: 2, max: 5)
  --fixtures LIST           Comma-separated names (default: five baseline fixtures; optional: image-heavy)
  --frame-samples N         Animation-frame intervals to collect (default: 120)
  --one-mb-bytes N          1 MB fixture target, at least 1000000 (default: 1000000)
  --many-block-count N      Paragraph blocks (default: 1500)
  --huge-block-bytes N      Single paragraph target (default: 262144)
  --math-count N            Equation sections (default: 80)
  --quit-after-ms N         App's own bounded exit timer (default: 120000)
  --startup-timeout-ms N    CDP/readiness deadline (default: 45000)
`;
}

async function reserveLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function waitForCdp(port, timeoutMs, child) {
  const endpoint = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Installed reader exited before CDP was ready (code ${child.exitCode})`);
    try {
      const response = await fetch(`${endpoint}/json/version`);
      if (response.ok) return { endpoint, version: await response.json() };
    } catch (error) { lastError = String(error); }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for Qt WebEngine CDP at ${endpoint}${lastError ? `: ${lastError}` : ''}`);
}

async function waitForSpawn(child, timeoutMs) {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`Installed reader did not start within ${timeoutMs} ms`)), timeoutMs);
    const finish = error => {
      clearTimeout(timer);
      child.removeListener('spawn', onSpawn);
      child.removeListener('error', onError);
      error ? reject(error) : resolve();
    };
    const onSpawn = () => finish();
    const onError = error => finish(error);
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
}

async function attachPage(browser, timeoutMs) {
  const contexts = browser.contexts();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pages = contexts.flatMap(context => context.pages());
    const page = pages.find(candidate => /(?:^|\/)qt-reader\.html(?:[?#]|$)/i.test(candidate.url())) ?? pages.find(candidate => candidate.url() !== 'about:blank');
    if (page) {
      // The bridge function is installed before native sends its first note.
      // Do not race that first payload with the synthetic benchmark payload.
      await page.waitForFunction(() => typeof window.supermdLoad === 'function' && !!document.querySelector('.android-reading h1'), undefined, { timeout: Math.max(1, deadline - Date.now()) });
      return page;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Qt WebEngine exposed no qt-reader page through CDP');
}

async function loadAndMeasure(page, fixture, id, dark = false) {
  const result = await page.evaluate(async ({ content, title, id: noteId, dark: themeDark, fixtureImageCount }) => {
    const started = performance.now();
    if (fixtureImageCount > 0) {
      window.__benchmarkMeasureStartedAt = started;
      window.__benchmarkLayoutShiftValue = 0;
      window.__benchmarkSeenImages = new Map();
    }
    if (fixtureImageCount > 0 && typeof PerformanceObserver !== 'undefined' && !window.__benchmarkLayoutObserver) {
      try {
        window.__benchmarkLayoutObserver = new PerformanceObserver(list => {
          for (const entry of list.getEntries()) if (!entry.hadRecentInput) window.__benchmarkLayoutShiftValue += entry.value;
        });
        window.__benchmarkLayoutObserver.observe({ type: 'layout-shift', buffered: false });
      } catch { window.__benchmarkLayoutObserver = null; }
    }
    // These are fresh synthetic documents, not a revisit to a user's saved
    // position. Prevent the native reading-location effect from restoring a
    // previous viewport into the fixture. The native reader's location effect
    // can restore asynchronously, so mark a benchmark-owned navigation intent
    // after commit and put the synthetic viewport at the document origin.
    const state = { id: noteId, content, path: null, mode: 'reader', dark: themeDark, fullscreen: false, colors: {}, font: 'Manrope', size: 18, zoom: 100, motion: false, restorePosition: false };
    window.supermdLoad(state);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const reader = document.querySelector('.android-reading');
    window.supermdNativeWheel?.(0, 0, { x: -1, y: -1 }, false);
    if (reader) reader.scrollTop = 0;
    const waitForFont = (async () => {
      await document.fonts.load('18px Manrope');
      await document.fonts.ready;
      return performance.now() - started;
    })();
    const waitForEquation = new Promise((resolve, reject) => {
      const deadline = performance.now() + 60_000;
      const check = () => {
        const currentReader = document.querySelector('.android-reading');
        if (currentReader?.textContent?.includes(title) && currentReader.querySelector('.katex')) resolve(performance.now() - started);
        else if (performance.now() > deadline) reject(new Error('benchmark:first-equation-timeout'));
        else requestAnimationFrame(check);
      };
      requestAnimationFrame(check);
    });
    let firstEquationMs, fontReadyMs;
    try { [firstEquationMs, fontReadyMs] = await Promise.all([waitForEquation, waitForFont]); }
    catch (error) {
      if (error?.message !== 'benchmark:first-equation-timeout') throw error;
      const reader = document.querySelector('.android-reading');
      return { readinessTimeout: {
        titlePresent: reader?.textContent?.includes(title) === true,
        headingCount: reader?.querySelectorAll('h1,h2,h3,h4,h5,h6').length ?? 0,
        mathCount: reader?.querySelectorAll('.katex').length ?? 0,
        mode: state.mode,
        windowedMounted: reader?.querySelectorAll('[data-windowed-block]').length ?? 0,
        imageCount: reader?.querySelectorAll('img').length ?? 0,
        readerScrollHeight: reader?.scrollHeight ?? null,
        readerClientHeight: reader?.clientHeight ?? null,
      } };
    }
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return { firstEquationMs, fontReadyMs, presentedRafReadyMs: performance.now() - started, theme: document.documentElement.dataset.theme };
  }, { content: fixture.content, title: fixture.title, id, dark, fixtureImageCount: fixture.images?.length ?? 0 });
  if (result.readinessTimeout) {
    throw new Error(`Timed out waiting for first rendered equation; counts=${JSON.stringify(formatReadinessDiagnostics(result.readinessTimeout))}`);
  }
  return result;
}

async function traverseFixtureImages(page, fixture, cdp, rootPid) {
  const expected = fixture.images?.length ?? 0;
  if (!expected) return { imageReadyMs: null, imageDecodedPixels: 0, imageCount: 0, imageLayoutShift: 0, imageTraversalSteps: 0 };
  let peakPssKb = null, peakRssKb = null, peakHeapBytes = null;
  let scrollSteps = 0, bottomStalledAt = null;
  const known = new Set();
  const imageDetails = new Map();
  const startedAt = Date.now();
  while (imageDetails.size < expected || scrollSteps === 0) {
    if (scrollSteps >= 500 || Date.now() - startedAt > 60_000) {
      throw new Error(`Timed out traversing generated images (${imageDetails.size}/${expected} decoded in ${scrollSteps} scroll steps)`);
    }
    const result = await page.evaluate(async () => {
      const reader = document.querySelector('.android-reading');
      if (!reader) throw new Error('Reader scroller is unavailable');
      const rememberLoaded = () => {
        for (const image of reader.querySelectorAll('img[alt^="Generated benchmark image "]')) {
          if (!image.complete || image.naturalWidth < 1 || image.naturalHeight < 1) continue;
          const alt = image.getAttribute('alt') ?? 'generated image';
          if (!window.__benchmarkSeenImages.has(alt)) {
            window.__benchmarkSeenImages.set(alt, {
              alt, width: image.naturalWidth, height: image.naturalHeight,
              decodeMs: performance.now() - window.__benchmarkMeasureStartedAt,
              layoutShiftAtDecode: window.__benchmarkLayoutShiftValue ?? 0,
            });
          }
        }
      };
      rememberLoaded();
      const step = Math.max(400, Math.floor(reader.clientHeight * 0.65));
      const maxScrollTop = Math.max(0, reader.scrollHeight - reader.clientHeight);
      const previousTop = reader.scrollTop;
      reader.scrollTop = Math.min(maxScrollTop, previousTop + step);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 80))));
      rememberLoaded();
      return {
        images: [...window.__benchmarkSeenImages.values()],
        scrollTop: reader.scrollTop, maxScrollTop: Math.max(0, reader.scrollHeight - reader.clientHeight),
        imageLayoutShift: window.__benchmarkLayoutShiftValue ?? 0,
      };
    });
    scrollSteps++;
    for (const image of result.images) {
      if (!known.has(image.alt)) { known.add(image.alt); imageDetails.set(image.alt, image); }
    }
    if (result.scrollTop >= result.maxScrollTop - 1 && imageDetails.size < expected) {
      bottomStalledAt ??= Date.now();
      if (Date.now() - bottomStalledAt > 10_000) throw new Error(`Reader remained at the bottom with only ${imageDetails.size}/${expected} generated images decoded`);
    } else bottomStalledAt = null;

    const processTree = process.platform === 'linux' ? await aggregateProcessTree(rootPid) : null;
    if (processTree?.pssKb !== null && processTree?.pssKb !== undefined) peakPssKb = Math.max(peakPssKb ?? 0, processTree.pssKb);
    if (processTree?.rssKb !== null && processTree?.rssKb !== undefined) peakRssKb = Math.max(peakRssKb ?? 0, processTree.rssKb);
    try {
      const heap = (await cdp.send('Runtime.getHeapUsage')).usedSize;
      if (Number.isFinite(heap)) peakHeapBytes = Math.max(peakHeapBytes ?? 0, heap);
    } catch { /* Process RSS/PSS is still sampled if the heap endpoint is unavailable. */ }
    if (imageDetails.size >= expected && result.scrollTop >= result.maxScrollTop - 1) break;
  }
  const imageDimensions = [...imageDetails.values()];
  return {
    imageReadyMs: Math.max(...imageDimensions.map(image => image.decodeMs)),
    imageDecodedPixels: imageDimensions.reduce((total, image) => total + image.width * image.height, 0),
    imageCount: imageDimensions.length,
    imageDimensions,
    imageLayoutShift: await page.evaluate(() => window.__benchmarkLayoutShiftValue ?? 0),
    imageTraversalSteps: scrollSteps,
    imagePeakSampledPssKb: peakPssKb,
    imagePeakSampledRssKb: peakRssKb,
    imagePeakSampledHeapBytes: peakHeapBytes,
  };
}

async function sampleFrames(page, count) {
  const intervals = await page.evaluate(async sampleCount => {
    const values = [];
    await new Promise(resolve => requestAnimationFrame(resolve));
    let previous = performance.now();
    for (let i = 0; i < sampleCount; i++) {
      await new Promise(resolve => requestAnimationFrame(resolve));
      const now = performance.now(); values.push(now - previous); previous = now;
    }
    return values;
  }, count);
  return { samples: intervals.length, medianMs: percentile(intervals, 0.5), p95Ms: percentile(intervals, 0.95), p99Ms: percentile(intervals, 0.99), over50ms: intervals.filter(value => value > 50).length };
}

async function sampleZoomCall(page) {
  const values = await page.evaluate(() => {
    const times = [];
    for (let i = 0; i < 60; i++) {
      const zoom = i % 2 ? 100.35 : 100;
      const started = performance.now(); window.supermdSetZoom?.(zoom, Date.now()); times.push(performance.now() - started);
    }
    window.supermdSetZoom?.(100, Date.now());
    return times;
  });
  return { samples: values.length, medianMs: percentile(values, 0.5), p95Ms: percentile(values, 0.95), maxMs: Math.max(...values) };
}

async function samplePageMemory(page, cdp) {
  let collectedGarbage = false;
  try { await cdp.send('HeapProfiler.collectGarbage'); collectedGarbage = true; }
  catch { /* Keep reporting DOM/process metrics if this CDP command is unavailable. */ }
  let jsHeapBytes = null;
  try { jsHeapBytes = (await cdp.send('Runtime.getHeapUsage')).usedSize; }
  catch {
    try {
      await cdp.send('Performance.enable');
      const metrics = await cdp.send('Performance.getMetrics');
      jsHeapBytes = metrics.metrics.find(metric => metric.name === 'JSHeapUsedSize')?.value ?? null;
    } catch { /* Older embedded Chromium may not expose Runtime heap usage. */ }
  }
  const domElements = await page.evaluate(() => document.querySelectorAll('*').length);
  return { jsHeapBytes, jsHeapAfterGarbageCollection: collectedGarbage, domElements };
}

async function waitForTheme(page, expected) {
  await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, expected, { timeout: 10_000 });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

function captureStderr(child) {
  let contents = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { contents = (contents + chunk).slice(-16_384); });
  return () => contents;
}

async function waitExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    new Promise(resolve => setTimeout(resolve, timeoutMs)),
  ]);
}

async function stopOwnedProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM');
    else child.kill('SIGTERM');
  } catch { /* It may have exited between the status check and signal. */ }
  await waitExit(child, 2_000);
  if (child.exitCode === null && child.signalCode === null) {
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch { /* It may have exited between checks. */ }
    await waitExit(child, 1_000);
  }
}

async function hardwareMetadata() {
  const cpuInfo = process.platform === 'linux' ? await readOptional('/proc/cpuinfo') : '';
  const cpuModel = cpuInfo.match(/^model name\s*:\s*(.+)$/m)?.[1]?.trim() ?? os.cpus()[0]?.model ?? null;
  let playwrightVersion = null;
  try { playwrightVersion = JSON.parse(await readFile(new URL('../node_modules/playwright/package.json', import.meta.url), 'utf8')).version; }
  catch { /* Playwright may be provided through a nonstandard module path. */ }
  return {
    os: { platform: process.platform, release: os.release(), architecture: os.arch() },
    cpu: { model: cpuModel, logicalCores: os.cpus().length },
    totalMemoryBytes: os.totalmem(),
    nodeVersion: process.version,
    playwrightVersion,
  };
}

async function launchAndMeasure(binary, fixture, repetition, options) {
  const port = await reserveLoopbackPort();
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'supermd-installed-reader-benchmark-'));
  const env = {
    ...process.env,
    QT_QPA_PLATFORM: 'offscreen',
    QTWEBENGINE_REMOTE_DEBUGGING: `127.0.0.1:${port}`,
    TMPDIR: tempRoot,
    TEMP: tempRoot,
    TMP: tempRoot,
  };
  const child = spawn(binary, [...(options.entrypoint ? [path.resolve(options.entrypoint)] : []), '--test-state', '--safe-graphics', '--quit-after', String(options.quitAfterMs)], {
    env, stdio: ['ignore', 'ignore', 'pipe'], detached: process.platform !== 'win32',
  });
  const stderr = captureStderr(child);
  let browser;
  const processStartedAt = Date.now();
  try {
    await waitForSpawn(child, options.startupTimeoutMs);
    const cdpInfo = await waitForCdp(port, options.startupTimeoutMs, child);
    browser = await chromium.connectOverCDP(cdpInfo.endpoint, { timeout: options.startupTimeoutMs, noDefaults:true });
    const page = await attachPage(browser, options.startupTimeoutMs);
    const appReadyMs = Date.now() - processStartedAt;
    const cdp = await browser.contexts()[0].newCDPSession(page);
    await cdp.send('Runtime.enable');
    await cdp.send('HeapProfiler.enable');
    const idPrefix = `benchmark-${fixture.name}-${repetition}-${Date.now()}`;
    const coldTiming = await loadAndMeasure(page, fixture, `${idPrefix}-cold`);
    const coldImages = await traverseFixtureImages(page, fixture, cdp, child.pid);
    const cold = { ...coldTiming, ...coldImages };
    const coldPageMemory = await samplePageMemory(page, cdp);
    const coldProcessMemory = process.platform === 'linux' ? await aggregateProcessTree(child.pid) : null;
    const coldFrameIntervals = await sampleFrames(page, options.frameSamples);
    const zoomCall = await sampleZoomCall(page);

    const warmRevisits = [];
    let lastStateId = `${idPrefix}-cold`;
    for (let cycle = 0; cycle < options.warmCycles; cycle++) {
      const id = `${idPrefix}-warm-${cycle + 1}`;
      const timing = await loadAndMeasure(page, fixture, id);
      const imageTraversal = await traverseFixtureImages(page, fixture, cdp, child.pid);
      const warmMemory = fixture.images ? await samplePageMemory(page, cdp) : null;
      const warmProcessMemory = fixture.images && process.platform === 'linux' ? await aggregateProcessTree(child.pid) : null;
      warmRevisits.push({ cycle: cycle + 1, ...timing, ...imageTraversal, ...(warmMemory ?? {}), ...(warmProcessMemory ? { processTree: warmProcessMemory } : {}) });
      lastStateId = id;
    }
    const themeCycles = [];
    for (let cycle = 0; cycle < options.warmCycles; cycle++) {
      const nextDark = cycle % 2 === 0;
      const started = performance.now();
      await page.evaluate(({ content, id, dark }) => window.supermdLoad({ id, content, path: null, mode: 'reader', dark, fullscreen: false, colors: {}, font: 'Manrope', size: 18, zoom: 100, motion: false }), { content: fixture.content, id: lastStateId, dark: nextDark });
      await waitForTheme(page, nextDark ? 'dark' : 'light');
      themeCycles.push({ cycle: cycle + 1, dark: nextDark, readyMs: performance.now() - started });
    }
    const finalPageMemory = await samplePageMemory(page, cdp);
    const finalProcessMemory = process.platform === 'linux' ? await aggregateProcessTree(child.pid) : null;
    await cdp.detach().catch(() => {});
    return {
      fixture: fixture.name, repetition, appReadyMs,
      cold: { ...cold, ...coldPageMemory, frameIntervalP95Ms: coldFrameIntervals.p95Ms, zoomCallP95Ms: zoomCall.p95Ms, frameIntervals: coldFrameIntervals, zoomCall, processTree: coldProcessMemory },
      warmRevisits, themeCycles,
      afterWarmAndTheme: { ...finalPageMemory, processTree: finalProcessMemory },
      runtime: { browserVersion: browser.version(), cdpBrowser: cdpInfo.version.Browser ?? null, pageUrl: page.url() },
    };
  } catch (error) {
    throw new Error(`${fixture.name} repetition ${repetition} failed: ${error.message}${stderr() ? `\nReader stderr tail:\n${stderr()}` : ''}`);
  } finally {
    await browser?.close().catch(() => {});
    await stopOwnedProcess(child);
    await rm(tempRoot, { recursive: true, force: true });
  }
}

export async function runBenchmark(options) {
  const binary = path.resolve(options.binary);
  await access(binary);
  if (options.entrypoint) await access(path.resolve(options.entrypoint));
  const generatedFixtures = createFixtures(options);
  if (options.fixtures.includes('image-heavy')) generatedFixtures.push(createImageHeavyFixture());
  const fixtures = generatedFixtures.filter(fixture => options.fixtures.includes(fixture.name));
  const samples = [];
  // Each fixture/repetition gets a fresh isolated process, so cold measurements
  // do not inherit the previous fixture's reader/cache state.
  for (const fixture of fixtures) {
    for (let repetition = 1; repetition <= options.repetitions; repetition++) {
      console.error(`[benchmark] ${fixture.name}: isolated launch ${repetition}/${options.repetitions}`);
      samples.push(await launchAndMeasure(binary, fixture, repetition, options));
    }
  }
  const byFixture = Object.fromEntries(fixtures.map(fixture => {
    const group = samples.filter(sample => sample.fixture === fixture.name);
    const cold = group.map(sample => sample.cold);
    const warm = group.flatMap(sample => sample.warmRevisits);
    const themes = group.flatMap(sample => sample.themeCycles.map(cycle => ({ themeReadyMs: cycle.readyMs })));
    return [fixture.name, {
      fixture: {
        sourceBytes: fixture.sourceBytes, blockCount: fixture.blockCount, synthetic: fixture.synthetic,
        imageCount: fixture.images?.length ?? 0,
        imageDimensions: fixture.images?.map(({ width, height }) => ({ width, height })) ?? [],
        decodedPixels: fixture.decodedPixels ?? 0,
        decodedMegapixels: fixture.decodedMegapixels ?? 0,
      },
      cold: aggregateSamples(cold), warmRevisits: aggregateSamples(warm),
      themeReadyMs: aggregateSamples(themes.map(sample => ({ presentedRafReadyMs: sample.themeReadyMs }))).presentedRafReadyMs,
      linuxProcessTree: {
        coldRssKb: summarize(cold.map(sample => sample.processTree?.rssKb)),
        coldPssKb: summarize(cold.map(sample => sample.processTree?.pssKb)),
        afterWarmRssKb: summarize(group.map(sample => sample.afterWarmAndTheme.processTree?.rssKb)),
        afterWarmPssKb: summarize(group.map(sample => sample.afterWarmAndTheme.processTree?.pssKb)),
        warmCycleRssKb: summarize(group.flatMap(sample => sample.warmRevisits.map(revisit => revisit.processTree?.rssKb))),
        warmCyclePssKb: summarize(group.flatMap(sample => sample.warmRevisits.map(revisit => revisit.processTree?.pssKb))),
      },
    }];
  }));
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    label: options.label ?? null,
    metadata: {
      applicationBinary: binary,
      sourceEntrypoint: options.entrypoint ? path.resolve(options.entrypoint) : null,
      appVersion: null,
      appBuildLabel: options.label ?? null,
      ...await hardwareMetadata(),
      qtWebEngineChromium: samples[0]?.runtime ?? null,
      graphics: { qpaPlatform: 'offscreen', requestedMode: 'safe/software graphics' },
    },
    configuration: {
      repetitions: options.repetitions, warmCycles: options.warmCycles, frameSamples: options.frameSamples,
      quitAfterMs: options.quitAfterMs,
      fixtureParameters: {
        oneMbBytes: options.oneMbBytes, manyBlockCount: options.manyBlockCount, hugeBlockBytes: options.hugeBlockBytes,
        mathCount: options.mathCount, imageFixtureMaxPixels: IMAGE_FIXTURE_MAX_PIXELS,
        imageFixtureMaxEdge: IMAGE_FIXTURE_MAX_EDGE, imageFixtureMaxSourceBytes: IMAGE_FIXTURE_MAX_SOURCE_BYTES,
      },
      fixtures: fixtures.map(({ name, sourceBytes, blockCount, images, decodedPixels }) => ({
        name, sourceBytes, blockCount, imageCount: images?.length ?? 0,
        imageDimensions: images?.map(({ width, height }) => ({ width, height })) ?? [], decodedPixels: decodedPixels ?? 0,
      })),
    },
    methodology: {
      cold: 'Each fixture and repetition starts a fresh installed-app process with isolated --test-state. OS file cache is not flushed; cold means process/document cold, not storage-cold.',
      presentedFrame: 'After the first KaTeX equation and Manrope font readiness, wait for two requestAnimationFrame callbacks. This measures Chromium scheduling/layout readiness, not a native captured-pixel or display-scanout timestamp.',
      frameIntervals: 'Intervals between requestAnimationFrame callbacks while the loaded fixture is idle; not an input-to-presented-frame latency.',
      imageReadiness: 'For the optional image-heavy fixture, scrolls the normal reader one viewport step at a time so windowed blocks mount naturally, records each generated PNG natural size/decode observation, samples process-tree memory during traversal, and reports layout-shift observations. These are not input-to-presented-frame latency measurements.',
      zoomCall: 'Synchronous JavaScript call duration for supermdSetZoom; it excludes subsequent layout and painting.',
      jsHeap: 'CDP JavaScript heap used after HeapProfiler.collectGarbage when supported; each sample records whether garbage collection was available. Excludes native and GPU memory.',
      processMemory: process.platform === 'linux' ? 'Linux /proc process-tree RSS is summed (shared mappings may be double-counted); PSS sums smaps_rollup proportional set sizes for the launched reader and descendants only.' : 'Process-tree RSS/PSS collection is Linux-only; values are null on this platform.',
      installedBinary: options.entrypoint ? 'Source run through the supplied interpreter and entrypoint; this does not verify packaging or represent an installed binary.' : 'The supplied executable is launched directly; the harness records its path and optional label but does not independently verify installation provenance.',
      fixtures: 'All note contents are generated in memory, use no personal files, and are never saved or exported.',
    },
    samples,
    aggregates: { byFixture },
  };
}

async function main() {
  let options;
  try { options = parseArgs(process.argv.slice(2)); }
  catch (error) { console.error(`${error.message}\nUse --help for options.`); process.exitCode = 2; return; }
  if (options.help) { console.log(help()); return; }
  try {
    const report = await runBenchmark(options);
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    if (options.output) await writeFile(path.resolve(options.output), serialized, 'utf8');
    else process.stdout.write(serialized);
  } catch (error) { console.error(error.stack ?? String(error)); process.exitCode = 1; }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) void main();
