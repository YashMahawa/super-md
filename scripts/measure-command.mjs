#!/usr/bin/env node
// Measures one explicitly supplied command. It records no environment values
// or raw arguments and only signals the detached process group it created.
import { spawn as nodeSpawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { aggregateProcessTree } from './benchmark-installed-reader.mjs';

export const SAMPLE_INTERVAL_MS = 2_000;
const TERMINATE_GRACE_MS = 1_500;

export function summarizeMeasurement({ command, args = [], startedAtMs, finishedAtMs, exitCode, signal = null, interrupted = false, samples = [], sampleErrors = 0, spawnErrorCode = null, platform = process.platform }) {
  const peak = field => {
    const values = samples.map(sample => sample[field]).filter(Number.isFinite);
    return values.length ? values.reduce((largest, value) => Math.max(largest, value), -Infinity) : null;
  };
  return {
    schemaVersion: 1,
    generatedAt: new Date(finishedAtMs ?? Date.now()).toISOString(),
    command: {
      executable: path.basename(command).slice(0, 128),
      argumentCount: args.length,
    },
    privacy: { environmentIncluded: false, rawArgumentsIncluded: false },
    platform,
    host: os.platform(),
    startedAt: Number.isFinite(startedAtMs) ? new Date(startedAtMs).toISOString() : null,
    wallTimeMs: Number.isFinite(startedAtMs) && Number.isFinite(finishedAtMs)
      ? Math.max(0, finishedAtMs - startedAtMs) : null,
    exitCode: Number.isInteger(exitCode) ? exitCode : null,
    spawnErrorCode,
    signal,
    interrupted,
    memory: {
      source: platform === 'linux' ? 'Linux /proc descendant process tree' : 'unavailable on this platform',
      unit: 'KiB',
      sampleIntervalMs: SAMPLE_INTERVAL_MS,
      sampleCount: samples.length,
      sampleErrors,
      peakSampledRssKb: platform === 'linux' ? peak('rssKb') : null,
      peakSampledPssKb: platform === 'linux' ? peak('pssKb') : null,
      samples,
    },
  };
}

export function parseArgs(argv) {
  const separator = argv.indexOf('--');
  const options = separator < 0 ? argv : argv.slice(0, separator);
  const commandLine = separator < 0 ? [] : argv.slice(separator + 1);
  let output;
  let help = false;
  for (let index = 0; index < options.length; index++) {
    const key = options[index];
    if (key === '--help' || key === '-h') help = true;
    else if (key === '--output') {
      if (!options[index + 1] || options[index + 1].startsWith('--')) throw new Error('Missing value for --output');
      output = options[++index];
    } else throw new Error(`Unknown option: ${key}`);
  }
  if (help) return { help: true };
  if (!output) throw new Error('Specify an explicit report path with --output PATH');
  if (!commandLine.length || !commandLine[0]) throw new Error('Supply a command after --');
  return { output: path.resolve(output), command: commandLine[0], args: commandLine.slice(1) };
}

function signalOwnedGroup(pid, signal, platform) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    if (platform !== 'win32') process.kill(-pid, signal);
    else process.kill(pid, signal);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

async function cleanupOwnedGroup(pid, platform) {
  if (platform === 'win32' || !Number.isInteger(pid) || pid <= 0) return;
  if (!signalOwnedGroup(pid, 'SIGTERM', platform)) return;
  await new Promise(resolve => setTimeout(resolve, TERMINATE_GRACE_MS));
  signalOwnedGroup(pid, 'SIGKILL', platform);
}

export async function measureCommand({
  command,
  args = [],
  output,
  platform = process.platform,
  sampleIntervalMs = SAMPLE_INTERVAL_MS,
  sampler = aggregateProcessTree,
  spawn = nodeSpawn,
  now = Date.now,
}) {
  if (!command || !output) throw new Error('Both command and explicit output path are required');
  if (sampleIntervalMs !== SAMPLE_INTERVAL_MS) throw new Error(`Sampling interval is fixed at ${SAMPLE_INTERVAL_MS} ms`);

  let child;
  let startedAtMs = null;
  let finishedAtMs = null;
  let exitCode = null;
  let exitSignal = null;
  let spawnErrorCode = null;
  let interrupted = false;
  let sampleErrors = 0;
  let sampling = false;
  let interval = null;
  let killTimer = null;
  const samples = [];
  let resolveClose;
  let rejectClose;
  const closed = new Promise((resolve, reject) => { resolveClose = resolve; rejectClose = reject; });

  const onInterrupt = () => {
    if (interrupted) {
      if (child?.pid) signalOwnedGroup(child.pid, 'SIGKILL', platform);
      return;
    }
    interrupted = true;
    if (!child?.pid) return;
    signalOwnedGroup(child.pid, 'SIGTERM', platform);
    killTimer = setTimeout(() => signalOwnedGroup(child.pid, 'SIGKILL', platform), TERMINATE_GRACE_MS);
  };
  process.on('SIGINT', onInterrupt);

  const sample = async () => {
    if (platform !== 'linux' || !child?.pid || sampling) return;
    sampling = true;
    try {
      const memory = await sampler(child.pid);
      samples.push({
        elapsedMs: Number.isFinite(startedAtMs) ? Math.max(0, now() - startedAtMs) : 0,
        processCount: memory.processCount,
        rssKb: memory.rssKb,
        pssKb: memory.pssKb,
      });
    } catch {
      sampleErrors++;
    } finally {
      sampling = false;
    }
  };

  try {
    child = spawn(command, args, {
      stdio: 'inherit',
      detached: platform !== 'win32',
    });
    child.once('spawn', () => {
      startedAtMs = now();
      void sample();
      interval = setInterval(() => { void sample(); }, SAMPLE_INTERVAL_MS);
    });
    child.once('error', error => {
      finishedAtMs = now();
      spawnErrorCode = safeErrorCode(error);
      rejectClose(error);
    });
    child.once('close', (code, signal) => {
      finishedAtMs = now();
      exitCode = code;
      exitSignal = signal;
      resolveClose();
    });
    await closed;
    if (sampling) {
      while (sampling) await new Promise(resolve => setTimeout(resolve, 5));
    }
  } catch (error) {
    if (!finishedAtMs) finishedAtMs = now();
    spawnErrorCode ??= safeErrorCode(error);
  } finally {
    process.removeListener('SIGINT', onInterrupt);
    if (interval) clearInterval(interval);
    if (killTimer) clearTimeout(killTimer);
    await cleanupOwnedGroup(child?.pid, platform).catch(() => {});
  }

  const report = summarizeMeasurement({
    command, args, startedAtMs, finishedAtMs, exitCode,
    signal: exitSignal, interrupted, samples, sampleErrors, spawnErrorCode, platform,
  });
  await writeFile(path.resolve(output), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return report;
}

function safeErrorCode(error) {
  return typeof error?.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(error.code) ? error.code : 'UNKNOWN';
}

function usage() {
  return `Usage: node scripts/measure-command.mjs --output REPORT.json -- COMMAND [ARGS...]\n\nRuns one command with inherited stdout/stderr, samples its Linux descendant RSS/PSS every 2 seconds, and writes a bounded metadata report. Environment values and raw arguments are never recorded. SIGINT only signals the command's owned process group.\n`;
}

async function main() {
  let options;
  try { options = parseArgs(process.argv.slice(2)); }
  catch (error) { console.error(`${error.message}\nUse --help for usage.`); process.exitCode = 2; return; }
  if (options.help) { console.log(usage()); return; }
  try {
    const report = await measureCommand(options);
    process.exitCode = report.interrupted ? 130 : (report.exitCode ?? 1);
  } catch (error) {
    console.error(error.stack ?? String(error));
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) void main();
