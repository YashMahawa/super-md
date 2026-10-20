import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  aggregateProcessTree, aggregateSamples, createFixtures, createImageHeavyFixture, IMAGE_FIXTURE_MAX_EDGE,
  IMAGE_FIXTURE_MAX_PIXELS, parseProcMemory, parseProcStat, percentile, pngDimensions, validateImageFixtureDimensions,
} from './benchmark-installed-reader.mjs';

test('percentiles and aggregate summaries ignore unavailable values and preserve zeros', () => {
  assert.equal(percentile([9, 1, 5, 3], 0.5), 3);
  assert.deepEqual(aggregateSamples([{ firstEquationMs: 0 }, { firstEquationMs: 10 }, { firstEquationMs: null }]).firstEquationMs,
    { count: 2, median: 0, p95: 10 });
  assert.deepEqual(aggregateSamples([]).jsHeapBytes, { count: 0, median: null, p95: null });
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

test('generates bounded, reproducible fixtures with an exact 1 MB ASCII note', () => {
  const fixtures = createFixtures({ oneMbBytes: 1_000_000, manyBlockCount: 7, hugeBlockBytes: 4096, mathCount: 3 });
  assert.deepEqual(fixtures.map(fixture => fixture.name), ['small', 'math-heavy', '1mb', 'many-blocks', 'huge-single-block']);
  assert.equal(fixtures.find(fixture => fixture.name === '1mb').sourceBytes, 1_000_000);
  assert.equal(fixtures.find(fixture => fixture.name === 'many-blocks').blockCount, 8);
  assert.ok(fixtures.find(fixture => fixture.name === 'huge-single-block').sourceBytes >= 4096);
  assert.ok(fixtures.every(fixture => fixture.synthetic && fixture.hasEquation));
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
