#!/usr/bin/env node
import { setTimeout as delay } from 'node:timers/promises';
import { execFileSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { crc32, inflateRawSync } from 'node:zlib';

const API_VERSION = '2022-11-28';
const PRODUCER_JOB_NAME = 'native_frontend';
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECT_HOPS = 5;

function isAllowedEndpointUrl(endpoint) {
  return endpoint.protocol === 'https:' || endpoint.hostname === 'localhost' || endpoint.hostname === '127.0.0.1';
}

function assertInputs({ repository, runId, sourceSha, token, apiUrl, distDir, manifestDir }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || '')) throw new Error('Invalid repository identity');
  if (!/^[1-9][0-9]*$/.test(String(runId || ''))) throw new Error('Invalid workflow run ID');
  if (!/^[a-f0-9]{40}$/i.test(sourceSha || '')) throw new Error('Expected a full checkout commit SHA');
  if (typeof token !== 'string' || token.length < 1) throw new Error('Missing Actions read token');
  if ((distDir === undefined) !== (manifestDir === undefined)) {
    throw new Error('Specify both distDir and manifestDir when downloading frontend artifacts');
  }
  if (distDir !== undefined && (typeof distDir !== 'string' || !distDir.trim() || typeof manifestDir !== 'string' || !manifestDir.trim())) {
    throw new Error('Artifact destination directories must be non-empty paths');
  }
  const endpoint = new URL(apiUrl || 'https://api.github.com');
  if (!isAllowedEndpointUrl(endpoint)) throw new Error('GitHub API endpoint must use HTTPS');
  return endpoint;
}

export function frontendArtifactNames(sourceSha) {
  if (!/^[a-f0-9]{40}$/i.test(sourceSha || '')) throw new Error('Expected a full checkout commit SHA');
  return {
    dist: `native-frontend-dist-${sourceSha.toLowerCase()}`,
    manifest: `native-frontend-manifest-${sourceSha.toLowerCase()}`,
  };
}

function validatePage(page, label) {
  if (!page || !Array.isArray(page.jobs ?? page.artifacts)) throw new Error(`Invalid ${label} response`);
  const list = page.jobs ?? page.artifacts;
  if (!Number.isInteger(page.total_count) || page.total_count !== list.length) {
    throw new Error(`Incomplete ${label} listing; refusing to consume unverified frontend artifacts`);
  }
  return list;
}

function resolveMatchingArtifacts(artifactsPage, sourceSha, expectedRunId) {
  const artifacts = validatePage(artifactsPage, 'workflow artifacts');
  const expected = frontendArtifactNames(sourceSha);
  const distMatches = artifacts.filter(artifact => artifact.name === expected.dist);
  const manifestMatches = artifacts.filter(artifact => artifact.name === expected.manifest);
  if (distMatches.length > 1 || manifestMatches.length > 1) {
    throw new Error('Ambiguous native frontend artifacts in this workflow run');
  }
  const [dist] = distMatches;
  const [manifest] = manifestMatches;
  for (const artifact of [dist, manifest]) {
    if (artifact?.expired) throw new Error('Native frontend artifact has expired; refusing fallback');
    if (artifact?.workflow_run?.id !== undefined && artifact.workflow_run.id !== expectedRunId) {
      throw new Error('Native frontend artifact belongs to a different workflow run');
    }
  }
  return { expected, dist, manifest };
}

export function inspectFrontendArtifactReadiness({ repository, runId, sourceSha, run, jobsPage, artifactsPage }) {
  const expectedRunId = Number(runId);
  if (run?.id !== expectedRunId) throw new Error(`GitHub returned workflow run ${run?.id}, expected ${runId}`);
  if (run?.repository?.full_name?.toLowerCase() !== repository.toLowerCase()) {
    throw new Error('GitHub returned a different repository for the requested workflow run');
  }

  const jobs = validatePage(jobsPage, 'workflow jobs');
  const producerJobs = jobs.filter(job => job.name === PRODUCER_JOB_NAME);
  if (producerJobs.length > 1) throw new Error('Ambiguous native frontend producer jobs in this workflow run');
  if (producerJobs.length === 0) {
    if (run.status === 'completed') throw new Error('Native frontend producer is missing from the completed workflow run');
    return { ready: false, reason: 'producer job has not been registered yet' };
  }

  const [producer] = producerJobs;
  if (producer.status === 'completed' && producer.conclusion !== 'success') {
    throw new Error(`Native frontend producer failed (${producer.conclusion || 'unknown'}); refusing fallback`);
  }
  if (producer.status !== 'completed') return { ready: false, reason: `producer job is ${producer.status}` };

  const { expected, dist, manifest } = resolveMatchingArtifacts(artifactsPage, sourceSha, expectedRunId);
  if (!dist || !manifest) return { ready: false, reason: 'exact-SHA artifact pair is not yet listed' };
  return { ready: true, names: expected };
}

function isRetryableNetworkError(error) {
  return error?.name === 'TimeoutError' || error?.name === 'AbortError' || error instanceof TypeError;
}

async function githubJson(url, token, fetchImpl, requestTimeoutMs) {
  let response;
  try {
    response = await fetchImpl(url, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': API_VERSION,
      },
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
  } catch (error) {
    if (isRetryableNetworkError(error)) {
      return { retry: true, status: error.name || 'network-error' };
    }
    throw error;
  }
  if (!response.ok) {
    if (response.status >= 500 || response.status === 429) return { retry: true, status: response.status };
    throw new Error(`GitHub Actions API request failed with HTTP ${response.status}`);
  }
  return { value: await response.json() };
}

function resolveArtifactDownloadUrl(artifact, repository, baseEndpoint) {
  if (!Number.isInteger(artifact?.id) || artifact.id <= 0) {
    throw new Error(`Native frontend artifact ${artifact?.name || 'unknown'} is missing a numeric artifact ID`);
  }
  const canonical = new URL(`repos/${repository}/actions/artifacts/${artifact.id}/zip`, baseEndpoint);
  if (artifact.archive_download_url !== undefined) {
    const advertised = new URL(artifact.archive_download_url);
    if (advertised.origin !== canonical.origin || advertised.pathname.toLowerCase() !== canonical.pathname.toLowerCase()) {
      throw new Error(`Unexpected archive download URL for ${artifact.name}`);
    }
    return advertised;
  }
  return canonical;
}

async function githubArtifactZip(url, endpoint, token, fetchImpl, requestTimeoutMs) {
  let currentUrl = new URL(url);
  let response;
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    const sameOrigin = currentUrl.origin === endpoint.origin;
    try {
      response = await fetchImpl(currentUrl, {
        redirect: 'manual',
        headers: sameOrigin
          ? {
            accept: 'application/vnd.github+json',
            authorization: `Bearer ${token}`,
            'x-github-api-version': API_VERSION,
          }
          : {},
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch (error) {
      if (isRetryableNetworkError(error)) return { retry: true, status: error.name || 'network-error' };
      throw error;
    }
    if (!REDIRECT_STATUSES.has(response.status)) break;
    if (hop === MAX_REDIRECT_HOPS) throw new Error('Too many redirects while downloading native frontend artifact');
    const location = response.headers?.get?.('location');
    if (!location) throw new Error('Artifact download redirect is missing Location header');
    currentUrl = new URL(location, currentUrl);
    if (!isAllowedEndpointUrl(currentUrl)) throw new Error('Artifact storage redirect must use HTTPS');
  }

  if (!response.ok) {
    // Retry 404 in addition to 429/5xx to absorb read-replica propagation lag
    // immediately after actions/upload-artifact finalizes cross-job artifacts.
    if (response.status === 404 || response.status === 429 || response.status >= 500) {
      return { retry: true, status: response.status };
    }
    throw new Error(`Artifact archive download failed with HTTP ${response.status}`);
  }
  return { value: Buffer.from(await response.arrayBuffer()) };
}

function readZip64Fields(extra, rawUncompressed, rawCompressed, rawOffset) {
  let pos = 0;
  while (pos + 4 <= extra.length) {
    const headerId = extra.readUInt16LE(pos);
    const dataSize = extra.readUInt16LE(pos + 2);
    pos += 4;
    if (pos + dataSize > extra.length) break;
    if (headerId === 0x0001) {
      let cursor = pos;
      const uncompressedSize = rawUncompressed === 0xffffffff ? Number(extra.readBigUInt64LE(cursor)) : rawUncompressed;
      if (rawUncompressed === 0xffffffff) cursor += 8;
      const compressedSize = rawCompressed === 0xffffffff ? Number(extra.readBigUInt64LE(cursor)) : rawCompressed;
      if (rawCompressed === 0xffffffff) cursor += 8;
      const localHeaderOffset = rawOffset === 0xffffffff ? Number(extra.readBigUInt64LE(cursor)) : rawOffset;
      return { uncompressedSize, compressedSize, localHeaderOffset };
    }
    pos += dataSize;
  }
  throw new Error('Missing ZIP64 extended information field in frontend artifact archive');
}

export function decodeZipArchive(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) {
    throw new Error('Invalid ZIP archive for native frontend artifact');
  }
  const minEocdOffset = Math.max(0, buffer.length - 65_557);
  let eocdOffset = -1;
  for (let offset = buffer.length - 22; offset >= minEocdOffset; offset--) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      const commentLength = buffer.readUInt16LE(offset + 20);
      if (offset + 22 + commentLength === buffer.length) {
        eocdOffset = offset;
        break;
      }
    }
  }
  if (eocdOffset < 0) throw new Error('Missing End of Central Directory in frontend artifact archive');

  let entryCount = buffer.readUInt16LE(eocdOffset + 10);
  let cdSize = buffer.readUInt32LE(eocdOffset + 12);
  let cdOffset = buffer.readUInt32LE(eocdOffset + 16);
  if (eocdOffset >= 20 && buffer.readUInt32LE(eocdOffset - 20) === 0x07064b50) {
    const zip64EocdOffset = Number(buffer.readBigUInt64LE(eocdOffset - 12));
    if (zip64EocdOffset < 0 || zip64EocdOffset + 56 > buffer.length || buffer.readUInt32LE(zip64EocdOffset) !== 0x06064b50) {
      throw new Error('Invalid ZIP64 End of Central Directory in frontend artifact archive');
    }
    entryCount = Number(buffer.readBigUInt64LE(zip64EocdOffset + 32));
    cdSize = Number(buffer.readBigUInt64LE(zip64EocdOffset + 40));
    cdOffset = Number(buffer.readBigUInt64LE(zip64EocdOffset + 48));
  } else if (entryCount === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new Error('Truncated ZIP64 directory in frontend artifact archive');
  }

  if (cdOffset < 0 || cdOffset + cdSize > buffer.length) {
    throw new Error('Out-of-bounds Central Directory in frontend artifact archive');
  }

  const files = [];
  let cursor = cdOffset;
  for (let i = 0; i < entryCount; i++) {
    if (cursor + 46 > cdOffset + cdSize || buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error('Corrupt Central Directory entry in frontend artifact archive');
    }
    const method = buffer.readUInt16LE(cursor + 10);
    const expectedCrc = buffer.readUInt32LE(cursor + 16);
    const rawCompressed = buffer.readUInt32LE(cursor + 20);
    const rawUncompressed = buffer.readUInt32LE(cursor + 24);
    const nameLen = buffer.readUInt16LE(cursor + 28);
    const extraLen = buffer.readUInt16LE(cursor + 30);
    const commentLen = buffer.readUInt16LE(cursor + 32);
    const externalAttrs = buffer.readUInt32LE(cursor + 38);
    const rawOffset = buffer.readUInt32LE(cursor + 42);
    const headerEnd = cursor + 46 + nameLen + extraLen + commentLen;
    if (headerEnd > cdOffset + cdSize) {
      throw new Error('Truncated Central Directory entry in frontend artifact archive');
    }
    const rawName = buffer.subarray(cursor + 46, cursor + 46 + nameLen).toString('utf8');
    const extra = buffer.subarray(cursor + 46 + nameLen, cursor + 46 + nameLen + extraLen);
    cursor = headerEnd;

    const unixMode = (externalAttrs >>> 16) & 0o170000;
    if (unixMode === 0o120000) {
      throw new Error(`Unexpected symbolic link in frontend artifact archive: ${rawName}`);
    }
    if (rawName.includes('\0') || rawName.includes('\\') || rawName.startsWith('/')) {
      throw new Error(`Unsafe frontend artifact archive entry: ${rawName}`);
    }
    const isDirectory = rawName.endsWith('/') || unixMode === 0o040000;
    const segments = isDirectory && rawName.endsWith('/') ? rawName.slice(0, -1).split('/') : rawName.split('/');
    if (segments.length === 0 || segments.some(segment => !segment || segment === '.' || segment === '..' || segment.includes(':'))) {
      throw new Error(`Unsafe frontend artifact archive entry: ${rawName}`);
    }
    if (isDirectory) continue;

    const { uncompressedSize, compressedSize, localHeaderOffset } =
      rawUncompressed === 0xffffffff || rawCompressed === 0xffffffff || rawOffset === 0xffffffff
        ? readZip64Fields(extra, rawUncompressed, rawCompressed, rawOffset)
        : { uncompressedSize: rawUncompressed, compressedSize: rawCompressed, localHeaderOffset: rawOffset };

    if (localHeaderOffset < 0 || localHeaderOffset + 30 > buffer.length || buffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
      throw new Error(`Invalid local file header in frontend artifact archive: ${rawName}`);
    }
    const localNameLen = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + compressedSize;
    if (dataStart < 0 || dataEnd > buffer.length) {
      throw new Error(`Truncated compressed payload in frontend artifact archive: ${rawName}`);
    }
    const payload = buffer.subarray(dataStart, dataEnd);
    let content;
    if (method === 0) {
      content = Buffer.from(payload);
    } else if (method === 8) {
      content = inflateRawSync(payload);
    } else {
      throw new Error(`Unsupported ZIP compression method ${method} for ${rawName}`);
    }
    if (content.length !== uncompressedSize) {
      throw new Error(`Uncompressed size mismatch in frontend artifact archive: ${rawName}`);
    }
    if ((crc32(content) >>> 0) !== expectedCrc) {
      throw new Error(`CRC32 checksum mismatch in frontend artifact archive: ${rawName}`);
    }
    files.push({ segments, relativePath: segments.join('/'), content });
  }
  if (files.length === 0) throw new Error('Frontend artifact archive contained no files');
  return files;
}

async function writeDecodedEntries(destinationDir, entries, { clean = false } = {}) {
  const root = path.resolve(destinationDir);
  if (clean) await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  for (const entry of entries) {
    const targetPath = path.resolve(root, ...entry.segments);
    const relative = path.relative(root, targetPath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Frontend artifact entry escapes destination: ${entry.relativePath}`);
    }
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, entry.content);
  }
}

export async function waitForNativeFrontendArtifacts({
  repository,
  runId,
  sourceSha,
  token,
  apiUrl,
  distDir,
  manifestDir,
  fetchImpl = fetch,
  sleep = delay,
  timeoutMs = 600_000,
  pollIntervalMs = 5_000,
  now = Date.now,
}) {
  const endpoint = assertInputs({ repository, runId, sourceSha, token, apiUrl, distDir, manifestDir });
  const baseEndpoint = `${endpoint.href.replace(/\/?$/, '/')}`;
  const runPath = `repos/${repository}/actions/runs/${runId}`;
  const started = now();
  const remainingMs = () => Math.max(1, timeoutMs - (now() - started));
  const pause = async () => {
    const left = timeoutMs - (now() - started);
    if (left > 0) await sleep(Math.min(pollIntervalMs, left));
  };
  const request = url => githubJson(url, token, fetchImpl, Math.min(15_000, remainingMs()));
  const downloadZip = url => githubArtifactZip(url, endpoint, token, fetchImpl, Math.min(60_000, remainingMs()));
  let cachedDist = null;
  let cachedManifest = null;
  while (now() - started < timeoutMs) {
    const runResult = await request(new URL(runPath, baseEndpoint));
    if (runResult.retry) {
      await pause();
      continue;
    }
    const jobsResult = await request(new URL(`${runPath}/jobs?per_page=100`, baseEndpoint));
    if (jobsResult.retry) {
      await pause();
      continue;
    }
    const artifactsResult = await request(new URL(`${runPath}/artifacts?per_page=100`, baseEndpoint));
    if (artifactsResult.retry) {
      await pause();
      continue;
    }
    const state = inspectFrontendArtifactReadiness({
      repository,
      runId,
      sourceSha,
      run: runResult.value,
      jobsPage: jobsResult.value,
      artifactsPage: artifactsResult.value,
    });
    if (!state.ready) {
      await pause();
      continue;
    }
    if (distDir === undefined) return state.names;

    const { dist, manifest } = resolveMatchingArtifacts(artifactsResult.value, sourceSha, Number(runId));
    if (cachedDist?.id !== dist.id) {
      const distUrl = resolveArtifactDownloadUrl(dist, repository, baseEndpoint);
      const distZip = await downloadZip(distUrl);
      if (distZip.retry) {
        await pause();
        continue;
      }
      cachedDist = { id: dist.id, entries: decodeZipArchive(distZip.value) };
    }
    if (cachedManifest?.id !== manifest.id) {
      const manifestUrl = resolveArtifactDownloadUrl(manifest, repository, baseEndpoint);
      const manifestZip = await downloadZip(manifestUrl);
      if (manifestZip.retry) {
        await pause();
        continue;
      }
      const manifestEntries = decodeZipArchive(manifestZip.value);
      if (manifestEntries.length !== 1 || manifestEntries[0].relativePath !== 'native-frontend-manifest.json') {
        throw new Error('Unexpected file layout in native frontend manifest artifact');
      }
      cachedManifest = { id: manifest.id, entries: manifestEntries };
    }
    await writeDecodedEntries(distDir, cachedDist.entries, { clean: true });
    await writeDecodedEntries(manifestDir, cachedManifest.entries, { clean: false });
    return state.names;
  }
  throw new Error(`Timed out waiting for native frontend artifacts for source ${sourceSha} in run ${runId}; no fallback used`);
}

export function parseCliArgs(argv) {
  let sourceSha = '';
  let distDir;
  let manifestDir;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dist-dir') {
      const value = argv[++i];
      if (!value || value.startsWith('-')) throw new Error('Missing value for --dist-dir');
      distDir = value;
    } else if (arg === '--manifest-dir') {
      const value = argv[++i];
      if (!value || value.startsWith('-')) throw new Error('Missing value for --manifest-dir');
      manifestDir = value;
    } else if (!arg.startsWith('-') && !sourceSha) {
      sourceSha = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }
  return { sourceSha, distDir, manifestDir };
}

async function main() {
  const parsed = parseCliArgs(process.argv.slice(2));
  const sourceSha = parsed.sourceSha || execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const names = await waitForNativeFrontendArtifacts({
    repository: process.env.GITHUB_REPOSITORY,
    runId: process.env.GITHUB_RUN_ID,
    sourceSha,
    token: process.env.GH_TOKEN || process.env.ACTIONS_READ_TOKEN,
    apiUrl: process.env.GITHUB_API_URL || 'https://api.github.com',
    distDir: parsed.distDir,
    manifestDir: parsed.manifestDir,
  });
  console.log(`native_frontend_artifacts_ready source=${sourceSha} dist=${names.dist} manifest=${names.manifest}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
