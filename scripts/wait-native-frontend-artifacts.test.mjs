import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import {
  createNativeFrontendManifest,
  verifyNativeFrontendManifest,
} from './native-frontend-artifact.mjs';
import {
  decodeZipArchive,
  frontendArtifactNames,
  inspectFrontendArtifactReadiness,
  parseCliArgs,
  waitForNativeFrontendArtifacts,
} from './wait-native-frontend-artifacts.mjs';

const repository = 'example/super-md';
const runId = '1234';
const sourceSha = 'a'.repeat(40);
const names = frontendArtifactNames(sourceSha);
const run = { id: Number(runId), repository: { full_name: repository } };

function buildZipBuffer(entries, { useZip64 = false } = {}) {
  const localChunks = [];
  const centralChunks = [];
  let localOffset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? '', 'utf8');
    const isDir = Boolean(entry.directory) || entry.name.endsWith('/');
    const method = isDir ? 0 : (entry.method ?? 8);
    const compressed = isDir ? Buffer.alloc(0) : (method === 8 ? deflateRawSync(raw) : Buffer.from(raw));
    const checksum = isDir ? 0 : (crc32(raw) >>> 0);
    const unixMode = entry.unixMode ?? (isDir ? 0o040755 : 0o100644);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(useZip64 ? 45 : 20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt32LE(0, 10);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(raw.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localChunks.push(localHeader, nameBuf, compressed);

    let extra = Buffer.alloc(0);
    if (useZip64) {
      extra = Buffer.alloc(28);
      extra.writeUInt16LE(0x0001, 0);
      extra.writeUInt16LE(24, 2);
      extra.writeBigUInt64LE(BigInt(raw.length), 4);
      extra.writeBigUInt64LE(BigInt(compressed.length), 12);
      extra.writeBigUInt64LE(BigInt(localOffset), 20);
    }

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE((3 << 8) | (useZip64 ? 45 : 20), 4);
    centralHeader.writeUInt16LE(useZip64 ? 45 : 20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt32LE(0, 12);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(useZip64 ? 0xffffffff : compressed.length, 20);
    centralHeader.writeUInt32LE(useZip64 ? 0xffffffff : raw.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(extra.length, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE((unixMode << 16) >>> 0, 38);
    centralHeader.writeUInt32LE(useZip64 ? 0xffffffff : localOffset, 42);
    centralChunks.push(centralHeader, nameBuf, extra);

    localOffset += localHeader.length + nameBuf.length + compressed.length;
  }

  const centralDir = Buffer.concat(centralChunks);
  const tailChunks = [];
  if (useZip64) {
    const zip64EocdOffset = localOffset + centralDir.length;
    const zip64Eocd = Buffer.alloc(56);
    zip64Eocd.writeUInt32LE(0x06064b50, 0);
    zip64Eocd.writeBigUInt64LE(44n, 4);
    zip64Eocd.writeUInt16LE(45, 12);
    zip64Eocd.writeUInt16LE(45, 14);
    zip64Eocd.writeUInt32LE(0, 16);
    zip64Eocd.writeUInt32LE(0, 20);
    zip64Eocd.writeBigUInt64LE(BigInt(entries.length), 24);
    zip64Eocd.writeBigUInt64LE(BigInt(entries.length), 32);
    zip64Eocd.writeBigUInt64LE(BigInt(centralDir.length), 40);
    zip64Eocd.writeBigUInt64LE(BigInt(localOffset), 48);

    const zip64Locator = Buffer.alloc(20);
    zip64Locator.writeUInt32LE(0x07064b50, 0);
    zip64Locator.writeUInt32LE(0, 4);
    zip64Locator.writeBigUInt64LE(BigInt(zip64EocdOffset), 8);
    zip64Locator.writeUInt32LE(1, 16);
    tailChunks.push(zip64Eocd, zip64Locator);
  }

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(useZip64 ? 0xffff : entries.length, 8);
  eocd.writeUInt16LE(useZip64 ? 0xffff : entries.length, 10);
  eocd.writeUInt32LE(useZip64 ? 0xffffffff : centralDir.length, 12);
  eocd.writeUInt32LE(useZip64 ? 0xffffffff : localOffset, 16);
  eocd.writeUInt16LE(0, 20);
  tailChunks.push(eocd);

  return Buffer.concat([...localChunks, centralDir, ...tailChunks]);
}

function pages({ jobs = [{ name: 'native_frontend', status: 'completed', conclusion: 'success' }], artifacts = [] } = {}) {
  return {
    jobsPage: { total_count: jobs.length, jobs },
    artifactsPage: { total_count: artifacts.length, artifacts },
  };
}

it('accepts only a ready pair for the exact source SHA and current workflow run', () => {
  const { jobsPage, artifactsPage } = pages({ artifacts: [{ name: names.dist }, { name: names.manifest }] });
  const state = inspectFrontendArtifactReadiness({ repository, runId, sourceSha, run, jobsPage, artifactsPage });
  assert.deepEqual(state, { ready: true, names });
});

it('fails immediately when the producer failed and rejects incomplete job or artifact listings', () => {
  const failed = pages({ jobs: [{ name: 'native_frontend', status: 'completed', conclusion: 'failure' }] });
  assert.throws(() => inspectFrontendArtifactReadiness({ repository, runId, sourceSha, run, ...failed }), /producer failed/);

  const { jobsPage, artifactsPage } = pages({ jobs: [{ name: 'native_frontend', status: 'completed', conclusion: 'success' }] });
  jobsPage.total_count++;
  assert.throws(() => inspectFrontendArtifactReadiness({ repository, runId, sourceSha, run, jobsPage, artifactsPage }), /Incomplete workflow jobs listing/);

  const completeJobs = pages({ jobs: [{ name: 'native_frontend', status: 'completed', conclusion: 'success' }] });
  completeJobs.artifactsPage.total_count = 1;
  assert.throws(() => inspectFrontendArtifactReadiness({ repository, runId, sourceSha, run, ...completeJobs }), /Incomplete workflow artifacts listing/);
});

it('rejects a different run or repository before considering artifact names', () => {
  const { jobsPage, artifactsPage } = pages({ artifacts: [{ name: names.dist }, { name: names.manifest }] });
  assert.throws(() => inspectFrontendArtifactReadiness({ repository, runId, sourceSha, run: { ...run, id: 7 }, jobsPage, artifactsPage }), /expected 1234/);
  assert.throws(() => inspectFrontendArtifactReadiness({ repository, runId, sourceSha, run: { ...run, repository: { full_name: 'other/repo' } }, jobsPage, artifactsPage }), /different repository/);
});

it('fails closed when a completed run has no native frontend producer job', () => {
  const { jobsPage, artifactsPage } = pages({ jobs: [], artifacts: [{ name: names.dist }, { name: names.manifest }] });
  assert.throws(() => inspectFrontendArtifactReadiness({
    repository,
    runId,
    sourceSha,
    run: { ...run, status: 'completed' },
    jobsPage,
    artifactsPage,
  }), /producer is missing/);
});

it('waits for the matching artifacts then succeeds, and never substitutes artifacts from another SHA', async () => {
  const wrongNames = frontendArtifactNames('b'.repeat(40));
  let clock = 0;
  let polls = 0;
  const fetchImpl = async input => {
    const url = new URL(input);
    assert.match(url.pathname, /\/repos\/example\/super-md\/actions\/runs\/1234/);
    polls++;
    const body = url.pathname.endsWith('/jobs')
      ? { total_count: 1, jobs: [{ name: 'native_frontend', status: 'completed', conclusion: 'success' }] }
      : url.pathname.endsWith('/artifacts')
        ? { total_count: 2, artifacts: polls < 6
          ? [{ name: wrongNames.dist }, { name: wrongNames.manifest }]
          : [{ name: names.dist }, { name: names.manifest }] }
        : run;
    return { ok: true, status: 200, json: async () => body };
  };
  const result = await waitForNativeFrontendArtifacts({
    repository,
    runId,
    sourceSha,
    token: 'test-token',
    fetchImpl,
    sleep: async ms => { clock += ms; },
    now: () => clock,
    timeoutMs: 100,
    pollIntervalMs: 10,
  });
  assert.deepEqual(result, names);
  assert.equal(polls, 6);
});

it('times out rather than accepting an incomplete artifact pair', async () => {
  let clock = 0;
  const fetchImpl = async input => {
    const url = new URL(input);
    const body = url.pathname.endsWith('/jobs')
      ? { total_count: 1, jobs: [{ name: 'native_frontend', status: 'completed', conclusion: 'success' }] }
      : url.pathname.endsWith('/artifacts')
        ? { total_count: 1, artifacts: [{ name: names.dist }] }
        : run;
    return { ok: true, status: 200, json: async () => body };
  };
  await assert.rejects(waitForNativeFrontendArtifacts({
    repository,
    runId,
    sourceSha,
    token: 'test-token',
    fetchImpl,
    sleep: async ms => { clock += ms; },
    now: () => clock,
    timeoutMs: 25,
    pollIntervalMs: 10,
  }), /Timed out waiting/);
});

it('retries post-upload 404/503 download lag, strips Authorization across redirect origins, and extracts verified artifacts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'supermd-wait-download-'));
  try {
    const producerDist = path.join(root, 'producer-dist');
    const producerTemp = path.join(root, 'producer-temp');
    const consumerDist = path.join(root, 'consumer-dist');
    const consumerTemp = path.join(root, 'consumer-temp');
    const lockfilePath = path.join(root, 'package-lock.json');
    await mkdir(path.join(producerDist, 'assets'), { recursive: true });
    await mkdir(producerTemp, { recursive: true });
    await mkdir(consumerDist, { recursive: true });
    await mkdir(consumerTemp, { recursive: true });
    await writeFile(lockfilePath, '{"name":"super-md","lockfileVersion":3}\n');
    await writeFile(path.join(producerDist, 'android-reader.html'), '<!doctype html><script src="./assets/index.js"></script>');
    await writeFile(path.join(producerDist, 'qt-reader.html'), '<!doctype html><script src="./assets/index.js"></script>');
    await writeFile(path.join(producerDist, 'assets', 'index.js'), 'console.log("super-md-reader");\n');
    // Simulate stale local dist file (must be cleaned) and pre-existing runner temp inventory (must be preserved).
    await writeFile(path.join(consumerDist, 'stale.txt'), 'remove-me');
    await writeFile(path.join(consumerTemp, 'python-wheel-inventory.json'), '{"wheelCount":4}\n');

    const manifestPath = path.join(producerTemp, 'native-frontend-manifest.json');
    const manifest = await createNativeFrontendManifest({
      distRoot: producerDist,
      packageLockPath: lockfilePath,
      sourceSha,
    });
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const distZip = buildZipBuffer([
      { name: 'assets/', directory: true },
      { name: 'android-reader.html', data: await readFile(path.join(producerDist, 'android-reader.html')), method: 0 },
      { name: 'qt-reader.html', data: await readFile(path.join(producerDist, 'qt-reader.html')), method: 8 },
      { name: 'assets/index.js', data: await readFile(path.join(producerDist, 'assets', 'index.js')), method: 8 },
    ]);
    const manifestZip = buildZipBuffer([
      { name: 'native-frontend-manifest.json', data: await readFile(manifestPath), method: 8 },
    ], { useZip64: true });

    const seenDownloadRequests = [];
    let distAttempts = 0;
    let manifestAttempts = 0;
    let clock = 0;

    const fetchImpl = async (input, options = {}) => {
      const url = new URL(input);
      if (url.origin === 'https://api.github.com' && url.pathname.endsWith('/actions/runs/1234')) {
        return { ok: true, status: 200, json: async () => run };
      }
      if (url.origin === 'https://api.github.com' && url.pathname.endsWith('/jobs')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ total_count: 1, jobs: [{ name: 'native_frontend', status: 'completed', conclusion: 'success' }] }),
        };
      }
      if (url.origin === 'https://api.github.com' && url.pathname.endsWith('/artifacts')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            total_count: 2,
            artifacts: [
              {
                id: 9001,
                name: names.dist,
                expired: false,
                workflow_run: { id: Number(runId) },
                archive_download_url: 'https://api.github.com/repos/example/super-md/actions/artifacts/9001/zip',
              },
              {
                id: 9002,
                name: names.manifest,
                expired: false,
                workflow_run: { id: Number(runId) },
                archive_download_url: 'https://api.github.com/repos/example/super-md/actions/artifacts/9002/zip',
              },
            ],
          }),
        };
      }
      if (url.origin === 'https://api.github.com' && url.pathname.endsWith('/actions/artifacts/9001/zip')) {
        seenDownloadRequests.push({ url: url.href, auth: options.headers?.authorization ?? null });
        distAttempts++;
        // Reproduce the exact Windows CI failure: artifact is listed in /artifacts,
        // but the initial download lookup hits a lagging read replica (404).
        if (distAttempts === 1) return { ok: false, status: 404 };
        return {
          ok: false,
          status: 302,
          headers: new Headers({ location: 'https://blob.actions.example.test/container/dist.zip?sig=1' }),
        };
      }
      if (url.origin === 'https://api.github.com' && url.pathname.endsWith('/actions/artifacts/9002/zip')) {
        seenDownloadRequests.push({ url: url.href, auth: options.headers?.authorization ?? null });
        manifestAttempts++;
        if (manifestAttempts === 1) return { ok: false, status: 503 };
        return {
          ok: false,
          status: 302,
          headers: new Headers({ location: 'https://blob.actions.example.test/container/manifest.zip?sig=2' }),
        };
      }
      if (url.origin === 'https://blob.actions.example.test') {
        seenDownloadRequests.push({ url: url.href, auth: options.headers?.authorization ?? null });
        const payload = url.pathname.endsWith('/dist.zip') ? distZip : manifestZip;
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength),
        };
      }
      throw new Error(`Unexpected URL: ${url.href}`);
    };

    const result = await waitForNativeFrontendArtifacts({
      repository,
      runId,
      sourceSha,
      token: 'secret-actions-token',
      distDir: consumerDist,
      manifestDir: consumerTemp,
      fetchImpl,
      sleep: async ms => { clock += ms; },
      now: () => clock,
      timeoutMs: 200,
      pollIntervalMs: 10,
    });

    assert.deepEqual(result, names);
    assert.equal(distAttempts, 2);
    assert.equal(manifestAttempts, 2);

    const apiCalls = seenDownloadRequests.filter(entry => entry.url.startsWith('https://api.github.com/'));
    const blobCalls = seenDownloadRequests.filter(entry => entry.url.startsWith('https://blob.actions.example.test/'));
    assert.ok(apiCalls.length >= 4);
    assert.ok(blobCalls.length === 2);
    assert.ok(apiCalls.every(entry => entry.auth === 'Bearer secret-actions-token'));
    assert.ok(blobCalls.every(entry => entry.auth === null));

    await assert.rejects(readFile(path.join(consumerDist, 'stale.txt')), /ENOENT/);
    assert.equal(await readFile(path.join(consumerTemp, 'python-wheel-inventory.json'), 'utf8'), '{"wheelCount":4}\n');

    const verified = await verifyNativeFrontendManifest({
      distRoot: consumerDist,
      packageLockPath: lockfilePath,
      manifestPath: path.join(consumerTemp, 'native-frontend-manifest.json'),
      expectedSourceSha: sourceSha,
    });
    assert.equal(verified.fileCount, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('rejects unsafe paths, symlinks, CRC corruption, and mismatched CLI options', () => {
  assert.throws(() => parseCliArgs([sourceSha, '--dist-dir']), /Missing value for --dist-dir/);
  assert.throws(() => parseCliArgs([sourceSha, '--manifest-dir', '--dist-dir']), /Missing value for --manifest-dir/);
  assert.deepEqual(
    parseCliArgs([sourceSha, '--dist-dir', 'dist', '--manifest-dir', '/tmp/runner']),
    { sourceSha, distDir: 'dist', manifestDir: '/tmp/runner' },
  );

  const traversalZip = buildZipBuffer([{ name: '../evil.js', data: 'boom' }]);
  assert.throws(() => decodeZipArchive(traversalZip), /Unsafe frontend artifact archive entry/);

  const symlinkZip = buildZipBuffer([{ name: 'index.html', data: 'target', unixMode: 0o120777 }]);
  assert.throws(() => decodeZipArchive(symlinkZip), /symbolic link/);

  const corruptZip = buildZipBuffer([{ name: 'index.html', data: 'valid-body', method: 0 }]);
  corruptZip[corruptZip.indexOf(Buffer.from('valid-body'))] ^= 0xff;
  assert.throws(() => decodeZipArchive(corruptZip), /CRC32 checksum mismatch/);
});
