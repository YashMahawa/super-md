import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  aggregateAllowlistedLibraryMemory, aggregateProcessTree, aggregateSamples, createDiagramHeavyFixture, createFixtures, createImageHeavyFixture, DIAGRAM_READY_TIMEOUT_MS,
  formatReadinessDiagnostics, IMAGE_FIXTURE_MAX_EDGE, IMAGE_FIXTURE_MAX_PIXELS, IMAGE_FIXTURE_MAX_SOURCE_BYTES, parseAllowlistedLibrarySmaps,
  parseArgs, parseProcMemory, parseProcStat, percentile, pngDimensions, validateImageFixtureDimensions,
} from './benchmark-installed-reader.mjs';

test('percentiles and aggregate summaries ignore unavailable values and preserve zeros', () => {
  assert.equal(percentile([9, 1, 5, 3], 0.5), 3);
  assert.deepEqual(aggregateSamples([{ firstEquationMs: 0 }, { firstEquationMs: 10 }, { firstEquationMs: null }]).firstEquationMs,
    { count: 2, median: 0, p95: 10 });
  assert.deepEqual(aggregateSamples([]).jsHeapBytes, { count: 0, median: null, p95: null });
});

test('readiness timeout diagnostics retain only bounded synthetic counts', () => {
  assert.deepEqual(formatReadinessDiagnostics({
    titlePresent: true, headingCount: 4, mathCount: 0, mode: 'reader', windowedMounted: 6,
    imageCount: 3, readerScrollHeight: 2400, readerClientHeight: 800,
    content: 'synthetic base64 payload must not escape', path: '/private/note.md',
  }), {
    titlePresent: true, headingCount: 4, mathCount: 0, mode: 'reader', windowedMounted: 6,
    imageCount: 3, readerScrollHeight: 2400, readerClientHeight: 800,
  });
  assert.deepEqual(formatReadinessDiagnostics({ mode: 'unexpected', headingCount: -1, imageCount: 1.2 }), {
    titlePresent: false, headingCount: null, mathCount: null, mode: 'unknown', windowedMounted: null,
    imageCount: null, readerScrollHeight: null, readerClientHeight: null,
  });
});

test('synthetic note loads disable saved-position restore and reset viewport before readiness', async () => {
  const source = await readFile(new URL('./benchmark-installed-reader.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('async function loadAndMeasure');
  const end = source.indexOf('async function traverseFixtureImages', start);
  const load = source.slice(start, end);
  const injection = load.indexOf('window.supermdLoad(state)');
  const commitWait = load.indexOf('await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))', injection);
  const navigationIntent = load.indexOf('window.supermdNativeWheel?.(0, 0, { x: -1, y: -1 }, false)', commitWait);
  const reset = load.indexOf('if (reader) reader.scrollTop = 0', navigationIntent);
  const readiness = load.indexOf('const waitForEquation', reset);
  assert.match(load, /restorePosition: false/);
  assert.ok(injection >= 0 && commitWait > injection && navigationIntent > commitWait && reset > navigationIntent && readiness > reset,
    'reset the synthetic viewport after React commit and before checking title/KaTeX readiness');
  assert.match(load, /currentReader\?\.textContent\?\.includes\(title\) && currentReader\.querySelector\('\.katex'\)/,
    'keep both the title and first rendered equation as readiness assertions');
});

test('parses Linux stat records with spaces and parentheses in process names', () => {
  assert.deepEqual(parseProcStat('42 (Qt WebEngine (Renderer)) S 7 0 0 0'), { pid: 42, ppid: 7 });
  assert.equal(parseProcStat('not a proc stat'), null);
  assert.deepEqual(parseProcMemory('Name: test\nVmRSS: 120 kB\n', 'Rss: 100 kB\nPss: 80 kB\n'), { rssKb: 120, pssKb: 80 });
});

test('sums only the launched process tree from proc-style fixtures', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'supermd-proc-tree-'));
  try {
    const addProcess = async (pid, ppid, comm, rss, pss) => {
      const folder = path.join(root, String(pid));
      await mkdir(folder);
      await writeFile(path.join(folder, 'stat'), `${pid} (${comm}) S ${ppid} 0 0 0\n`);
      await writeFile(path.join(folder, 'status'), `Name: ${comm}\nVmRSS: ${rss} kB\n`);
      await writeFile(path.join(folder, 'smaps_rollup'), `Rss: ${rss} kB\nPss: ${pss} kB\n`);
    };
    await addProcess(101, 1, 'Super MD', 100, 70);
    await addProcess(102, 101, 'Qt WebEngine (Renderer)', 300, 180);
    await addProcess(103, 102, 'Qt WebEngine (GPU)', 200, 100);
    await addProcess(201, 1, 'Unrelated process', 900, 800);
    const result = await aggregateProcessTree(101, root);
    assert.deepEqual(result, { pids: [101, 102, 103], processCount: 3, rssKb: 600, pssKb: 350, rssProcessCount: 3, pssProcessCount: 3 });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('parses only allowlisted native library mappings and emits basenames, not paths', () => {
  const parsed = parseAllowlistedLibrarySmaps([
    '1000-2000 r--p 00000000 08:01 1 /candidate/_internal/libicudata.so.78',
    'Size: 100 kB', 'Rss: 24 kB', 'Pss: 12 kB',
    '2000-3000 r--p 00001000 08:01 1 /candidate/_internal/libicudata.so.78 (deleted)',
    'Size: 80 kB', 'Rss: 20 kB', 'Pss: 10 kB',
    '3000-4000 r--p 00000000 08:01 2 /candidate/_internal/libxml2.so.16',
    'Size: 40 kB', 'Rss: 30 kB', 'Pss: 15 kB',
    '4000-5000 r--p 00000000 08:01 3 /private/note-or-user-lib.so',
    'Size: 900 kB', 'Rss: 900 kB', 'Pss: 900 kB',
  ].join('\n'));
  assert.deepEqual(parsed, [
    { library: 'libicudata.so.78', rssKb: 44, pssKb: 22, mappingCount: 2 },
    { library: 'libxml2.so.16', rssKb: 30, pssKb: 15, mappingCount: 1 },
  ]);
  assert.equal(JSON.stringify(parsed).includes('/candidate/'), false);
  assert.equal(JSON.stringify(parsed).includes('/private/'), false);
});

test('aggregates allowlisted smaps only for supplied owned PIDs with bounded metadata', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'supermd-library-smaps-'));
  try {
    const addSmaps = async (pid, content) => {
      const folder = path.join(root, String(pid));
      await mkdir(folder);
      await writeFile(path.join(folder, 'smaps'), content);
    };
    await addSmaps(101, [
      '1000-2000 r--p 00000000 08:01 1 /package/libicuuc.so.78', 'Rss: 80 kB', 'Pss: 40 kB',
    ].join('\n'));
    await addSmaps(102, [
      '2000-3000 r--p 00000000 08:01 1 /package/libicuuc.so.78', 'Rss: 60 kB', 'Pss: 30 kB',
      '3000-4000 r--p 00000000 08:01 2 /package/libopus.so.0', 'Rss: 20 kB', 'Pss: 10 kB',
    ].join('\n'));
    await addSmaps(103, '4000-5000 r--p 00000000 08:01 3 /package/libicudata.so.78\nRss: 999 kB\nPss: 999 kB\n');

    const result = await aggregateAllowlistedLibraryMemory([101, 102], root);
    assert.deepEqual(result, {
      processCount: 2,
      processesSampled: 2,
      processesUnreadable: 0,
      truncated: false,
      libraries: [
        { library: 'libicuuc.so.78', rssKb: 140, pssKb: 70, mappingCount: 2, processCount: 2 },
        { library: 'libopus.so.0', rssKb: 20, pssKb: 10, mappingCount: 1, processCount: 1 },
      ],
    });
    assert.equal(JSON.stringify(result).includes(String(root)), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('generates bounded, reproducible fixtures with an exact 1 MB ASCII note', () => {
  const fixtures = createFixtures({ oneMbBytes: 1_000_000, manyBlockCount: 7, hugeBlockBytes: 4096, mathCount: 3 });
  assert.deepEqual(fixtures.map(fixture => fixture.name), ['small', 'math-heavy', '1mb', 'many-blocks', 'huge-single-block']);
  assert.equal(fixtures.find(fixture => fixture.name === '1mb').sourceBytes, 1_000_000);
  assert.equal(fixtures.find(fixture => fixture.name === 'many-blocks').blockCount, 8);
  assert.ok(fixtures.find(fixture => fixture.name === 'huge-single-block').sourceBytes >= 4096);
  assert.ok(fixtures.every(fixture => fixture.synthetic && fixture.hasEquation));
});

test('diagram-heavy fixture is opt-in and contains 12 unique plain/init flowcharts after the first inline equation', () => {
  const fixture = createDiagramHeavyFixture();
  assert.equal(fixture.name, 'diagram-heavy');
  assert.equal(fixture.diagramCount, 12);
  assert.equal(fixture.peleEligibleDiagramCount, 6);
  assert.equal(fixture.legacyFallbackDiagramCount, 6);
  assert.equal(fixture.synthetic, true);
  assert.equal(fixture.hasEquation, true);
  assert.ok(fixture.content.indexOf('$E=mc^2$') < fixture.content.indexOf('```mermaid'));
  const diagrams = [...fixture.content.matchAll(/```mermaid\n([\s\S]*?)\n```/g)].map(match => match[1]);
  assert.equal(diagrams.length, 12);
  assert.equal(new Set(diagrams).size, 12);
  assert.equal(diagrams.filter(source => source.startsWith('%%{init:')).length, 6);
  assert.ok(diagrams.filter(source => !source.startsWith('%%{init:')).every(source => /^flowchart LR\n/.test(source)));
  assert.deepEqual(createFixtures().map(candidate => candidate.name), ['small', 'math-heavy', '1mb', 'many-blocks', 'huge-single-block']);
  assert.deepEqual(parseArgs(['--binary', '/tmp/reader', '--fixtures', 'diagram-heavy']).fixtures, ['diagram-heavy']);
  assert.equal(DIAGRAM_READY_TIMEOUT_MS, 90_000);
});

test('diagram readiness checks all SVG images from load start, fails explicit render errors, and aggregates cold/warm timings', async () => {
  const source = await readFile(new URL('./benchmark-installed-reader.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('const waitForDiagrams =');
  const end = source.indexOf('let firstEquationMs, fontReadyMs, diagramReadyMs', start);
  const readiness = source.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(readiness, /performance\.now\(\) \+ diagramTimeoutMs/);
  assert.match(readiness, /querySelectorAll\('\.mermaid img'\)/);
  assert.match(readiness, /image\.complete && image\.naturalWidth > 0/);
  assert.match(readiness, /benchmark:mermaid-render-error/);
  assert.match(readiness, /resolve\(performance\.now\(\) - started\)/);
  assert.match(source, /'diagramReadyMs'/);
  assert.match(source, /diagramTimeoutMs: DIAGRAM_READY_TIMEOUT_MS/);
  assert.match(source, /loadAndMeasure\(page, fixture, id\)/, 'warm revisits use the same measured load path');
  assert.deepEqual(aggregateSamples([{ diagramReadyMs: 30 }, { diagramReadyMs: 10 }, { diagramReadyMs: null }]).diagramReadyMs,
    { count: 2, median: 10, p95: 30 });
});

test('keeps image-heavy fixtures opt-in and caps total pixels and edge dimensions', () => {
  assert.deepEqual(createFixtures({ mathCount: 1, manyBlockCount: 1 }).map(fixture => fixture.name),
    ['small', 'math-heavy', '1mb', 'many-blocks', 'huge-single-block']);
  assert.equal(validateImageFixtureDimensions([
    { width: 2800, height: 2800 }, { width: 2800, height: 2800 },
    { width: 2800, height: 2800 }, { width: 2800, height: 2800 },
  ]), 31_360_000);
  assert.throws(() => validateImageFixtureDimensions([{ width: IMAGE_FIXTURE_MAX_PIXELS + 1, height: 1 }]), /dimensions.*no greater/);
  assert.throws(() => validateImageFixtureDimensions([{ width: IMAGE_FIXTURE_MAX_EDGE, height: IMAGE_FIXTURE_MAX_EDGE }, { width: 1, height: 1 }]), /exceeds.*pixel bound/);
  assert.throws(() => validateImageFixtureDimensions([{ width: 0, height: 1 }]), /dimensions/);
});

test('generates valid bounded PNG payloads with matching natural dimensions', () => {
  const fixture = createImageHeavyFixture([{ width: 64, height: 48 }, { width: 33, height: 22 }]);
  assert.equal(fixture.name, 'image-heavy');
  assert.equal(fixture.decodedPixels, 3_798);
  assert.equal(fixture.images.length, 2);
  for (const image of fixture.images) {
    const dataUri = fixture.content.match(new RegExp(`data:image/png;base64,[A-Za-z0-9+/=]+`))?.[0];
    assert.ok(dataUri);
    const png = Buffer.from(dataUri.slice('data:image/png;base64,'.length), 'base64');
    assert.deepEqual(pngDimensions(png), { width: image.width, height: image.height });
    assert.equal(image.pngBytes, png.length);
    assert.ok(png.length < 100_000);
    fixture.content = fixture.content.replace(dataUri, 'data:image/png;base64,');
  }
  assert.ok(fixture.sourceBytes < 1_000_000);
  assert.ok(fixture.content.includes('Synthetic image 2'));
  assert.ok(IMAGE_FIXTURE_MAX_PIXELS <= 32_000_000);
});

test('default 31 MP fixture stays within the encoded Markdown source budget', () => {
  const fixture = createImageHeavyFixture();
  assert.equal(fixture.decodedPixels, 31_360_000);
  assert.ok(fixture.sourceBytes <= IMAGE_FIXTURE_MAX_SOURCE_BYTES);
  assert.equal(fixture.images.length, 4);
  assert.ok(fixture.images.every(image => image.pngBytes > 1_000));
});
