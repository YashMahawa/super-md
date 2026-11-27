import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
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
  let samplerCalls = 0;
  try {
    const report = await measureCommand({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => process.exit(7), 40)'],
      output,
      sampler: async pid => {
        samplerCalls++;
        return { processCount: 1, rssKb: pid > 0 ? 11 : null, pssKb: pid > 0 ? 6 : null };
      },
    });
    const diskReport = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(report.exitCode, 7);
    assert.equal(diskReport.exitCode, 7);
    assert.equal(diskReport.spawnErrorCode, null);
    assert.equal(diskReport.command.argumentCount, 2);
    assert.equal(diskReport.platform, process.platform);
    if (process.platform === 'linux') {
      assert.ok(samplerCalls >= 1);
      assert.equal(diskReport.memory.source, 'Linux /proc descendant process tree');
      assert.equal(diskReport.memory.peakSampledRssKb, 11);
      assert.equal(diskReport.memory.peakSampledPssKb, 6);
    } else {
      assert.equal(samplerCalls, 0);
      assert.equal(diskReport.memory.source, 'unavailable on this platform');
      assert.equal(diskReport.memory.peakSampledRssKb, null);
      assert.equal(diskReport.memory.peakSampledPssKb, null);
      assert.equal(diskReport.memory.sampleCount, 0);
      assert.deepEqual(diskReport.memory.samples, []);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function withSyntheticProcessSignals(syntheticPid, run) {
  const originalKill = process.kill;
  const deliveredSignals = [];
  let childLive = false;
  let onLiveSignal = null;

  const setLiveState = (live, signalHandler = null) => {
    childLive = live;
    onLiveSignal = live ? signalHandler : null;
  };

  process.kill = function interceptedProcessKill(targetPid, signal = 'SIGTERM') {
    if (typeof targetPid === 'number' && Math.abs(targetPid) === syntheticPid) {
      deliveredSignals.push({ pid: targetPid, signal });
      if (!childLive) {
        throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
      }
      onLiveSignal?.(targetPid, signal);
      return true;
    }
    return originalKill.call(process, targetPid, signal);
  };

  return Promise.resolve()
    .then(() => run({ deliveredSignals, setLiveState }))
    .finally(() => {
      childLive = false;
      onLiveSignal = null;
      process.kill = originalKill;
    });
}

test('samples Linux process-tree RSS via injected child and reports unavailable memory on non-Linux hosts', async () => {
  const SYNTHETIC_PID = 4242;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'supermd-measure-command-injected-'));
  try {
    const createInjectedSpawn = (spawnCalls, setLiveState, { exitCode = 7, holdUntilSignal = false } = {}) => (command, args, options) => {
      spawnCalls.push({ command, args, options });
      const child = new EventEmitter();
      child.pid = SYNTHETIC_PID;
      let finished = false;
      const finish = (code, signal) => {
        if (finished) return;
        finished = true;
        setLiveState(false);
        child.emit('close', code, signal);
      };
      setLiveState(true, (_targetPid, signal) => {
        if (signal === 'SIGTERM' || signal === 'SIGKILL') {
          setImmediate(() => finish(null, signal));
        }
      });
      setImmediate(() => {
        if (finished) return;
        child.emit('spawn');
        if (!holdUntilSignal) {
          setImmediate(() => finish(exitCode, null));
        }
      });
      return child;
    };

    const linuxOutput = path.join(directory, 'linux-result.json');
    const linuxSpawns = [];
    const linuxSampledPids = [];
    let clock = 1_000;
    const linuxReport = await withSyntheticProcessSignals(SYNTHETIC_PID, ({ setLiveState }) =>
      measureCommand({
        command: '/usr/bin/node',
        args: ['-e', 'process.exit(7)'],
        output: linuxOutput,
        platform: 'linux',
        spawn: createInjectedSpawn(linuxSpawns, setLiveState),
        sampler: async pid => {
          linuxSampledPids.push(pid);
          return { processCount: 1, rssKb: pid > 0 ? 11 : null, pssKb: pid > 0 ? 6 : null };
        },
        now: () => {
          clock += 20;
          return clock;
        },
      }),
    );
    const linuxDiskReport = JSON.parse(await readFile(linuxOutput, 'utf8'));
    assert.equal(linuxSpawns.length, 1);
    assert.deepEqual(linuxSpawns[0].options, { stdio: 'inherit', detached: true });
    assert.deepEqual(linuxSampledPids, [SYNTHETIC_PID]);
    assert.equal(linuxReport.exitCode, 7);
    assert.equal(linuxDiskReport.exitCode, 7);
    assert.equal(linuxDiskReport.command.argumentCount, 2);
    assert.equal(linuxDiskReport.platform, 'linux');
    assert.equal(linuxDiskReport.memory.source, 'Linux /proc descendant process tree');
    assert.equal(linuxDiskReport.memory.sampleCount, 1);
    assert.equal(linuxDiskReport.memory.peakSampledRssKb, 11);
    assert.equal(linuxDiskReport.memory.peakSampledPssKb, 6);

    for (const nonLinuxPlatform of ['darwin', 'win32']) {
      const nonLinuxOutput = path.join(directory, `${nonLinuxPlatform}-result.json`);
      const nonLinuxSpawns = [];
      let nonLinuxSamples = 0;
      const nonLinuxReport = await withSyntheticProcessSignals(SYNTHETIC_PID, ({ setLiveState }) =>
        measureCommand({
          command: 'node',
          args: ['-e', 'process.exit(7)'],
          output: nonLinuxOutput,
          platform: nonLinuxPlatform,
          spawn: createInjectedSpawn(nonLinuxSpawns, setLiveState),
          sampler: async () => {
            nonLinuxSamples++;
            return { processCount: 1, rssKb: 11, pssKb: 6 };
          },
        }),
      );
      const nonLinuxDiskReport = JSON.parse(await readFile(nonLinuxOutput, 'utf8'));
      assert.equal(nonLinuxSpawns.length, 1);
      assert.deepEqual(nonLinuxSpawns[0].options, {
        stdio: 'inherit',
        detached: nonLinuxPlatform !== 'win32',
      });
      assert.equal(nonLinuxSamples, 0);
      assert.equal(nonLinuxReport.exitCode, 7);
      assert.equal(nonLinuxDiskReport.exitCode, 7);
      assert.equal(nonLinuxDiskReport.command.argumentCount, 2);
      assert.equal(nonLinuxDiskReport.platform, nonLinuxPlatform);
      assert.equal(nonLinuxDiskReport.memory.source, 'unavailable on this platform');
      assert.equal(nonLinuxDiskReport.memory.sampleCount, 0);
      assert.equal(nonLinuxDiskReport.memory.peakSampledRssKb, null);
      assert.equal(nonLinuxDiskReport.memory.peakSampledPssKb, null);
      assert.deepEqual(nonLinuxDiskReport.memory.samples, []);
    }

    const hostKill = process.kill;
    const leakedHostSignals = [];
    process.kill = function outerKillProbe(targetPid, signal) {
      leakedHostSignals.push({ pid: targetPid, signal });
      return hostKill.call(process, targetPid, signal);
    };
    try {
      for (const interruptPlatform of ['linux', 'darwin', 'win32']) {
        const interruptOutput = path.join(directory, `${interruptPlatform}-interrupt.json`);
        const interruptSpawns = [];
        await withSyntheticProcessSignals(SYNTHETIC_PID, async ({ deliveredSignals, setLiveState }) => {
          const baseSpawn = createInjectedSpawn(interruptSpawns, setLiveState, { holdUntilSignal: true });
          const interruptReport = await measureCommand({
            command: 'node',
            args: ['-e', 'setInterval(() => {}, 1000)'],
            output: interruptOutput,
            platform: interruptPlatform,
            spawn: (command, args, options) => {
              const child = baseSpawn(command, args, options);
              child.once('spawn', () => {
                setImmediate(() => process.emit('SIGINT'));
              });
              return child;
            },
            sampler: async pid => ({ processCount: 1, rssKb: pid > 0 ? 11 : null, pssKb: pid > 0 ? 6 : null }),
          });
          assert.equal(interruptReport.interrupted, true);
          assert.equal(interruptReport.signal, 'SIGTERM');
          assert.equal(
            deliveredSignals[0]?.pid,
            interruptPlatform === 'win32' ? SYNTHETIC_PID : -SYNTHETIC_PID,
          );
          assert.equal(deliveredSignals[0]?.signal, 'SIGTERM');
        });
      }
      assert.deepEqual(leakedHostSignals, []);
    } finally {
      process.kill = hostKill;
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
