import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { measureCommand, parseArgs, SAMPLE_INTERVAL_MS, summarizeMeasurement } from './measure-command.mjs';

test('report contains wall time, exit status and peak sampled memory without raw args or environment', () => {
  const report = summarizeMeasurement({
    command: '/private/home/key-material/node',
    args: ['--api-token', 'SECRET_VALUE'],
    startedAtMs: 1_000,
    finishedAtMs: 3_500,
    exitCode: 7,
    samples: [
      { elapsedMs: 0, processCount: 1, rssKb: 100, pssKb: 70 },
      { elapsedMs: 2_000, processCount: 2, rssKb: 450, pssKb: 280 },
    ],
    platform: 'linux',
  });

  assert.equal(report.command.executable, 'node');
  assert.equal(report.command.argumentCount, 2);
  assert.equal(report.wallTimeMs, 2_500);
  assert.equal(report.exitCode, 7);
  assert.equal(report.memory.sampleIntervalMs, SAMPLE_INTERVAL_MS);
  assert.equal(report.memory.peakSampledRssKb, 450);
  assert.equal(report.memory.peakSampledPssKb, 280);
  const serialized = JSON.stringify(report);
  assert.ok(!serialized.includes('SECRET_VALUE'));
  assert.ok(!serialized.includes('/private/home'));
  assert.deepEqual(report.privacy, { environmentIncluded: false, rawArgumentsIncluded: false });
});

test('non-Linux report marks process memory unavailable', () => {
  const report = summarizeMeasurement({
    command: 'example', startedAtMs: 0, finishedAtMs: 1, exitCode: 0,
    samples: [{ elapsedMs: 0, processCount: 1, rssKb: 5, pssKb: 4 }], platform: 'darwin',
  });
  assert.equal(report.memory.peakSampledRssKb, null);
  assert.equal(report.memory.peakSampledPssKb, null);
  assert.equal(report.memory.source, 'unavailable on this platform');
});

test('CLI requires an explicit report path and a command separator', () => {
  assert.throws(() => parseArgs(['--', 'node']), /explicit report path/);
  assert.throws(() => parseArgs(['--output', 'report.json']), /after --/);
  assert.deepEqual(parseArgs(['--output', 'report.json', '--', 'node', '-e', 'process.exit(0)']), {
    output: path.resolve('report.json'), command: 'node', args: ['-e', 'process.exit(0)'],
  });
});

test('runs only the supplied child and writes its status report to the requested path', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'supermd-measure-command-'));
  const output = path.join(directory, 'result.json');
  try {
    const report = await measureCommand({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => process.exit(7), 40)'],
      output,
      sampler: async pid => ({ processCount: 1, rssKb: pid > 0 ? 11 : null, pssKb: pid > 0 ? 6 : null }),
    });
    const diskReport = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(report.exitCode, 7);
    assert.equal(diskReport.exitCode, 7);
    assert.equal(diskReport.memory.peakSampledRssKb, 11);
    assert.equal(diskReport.command.argumentCount, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
