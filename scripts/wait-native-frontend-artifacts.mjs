#!/usr/bin/env node
import { setTimeout as delay } from 'node:timers/promises';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const API_VERSION = '2022-11-28';
const PRODUCER_JOB_NAME = 'native_frontend';

function assertInputs({ repository, runId, sourceSha, token, apiUrl }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || '')) throw new Error('Invalid repository identity');
  if (!/^[1-9][0-9]*$/.test(String(runId || ''))) throw new Error('Invalid workflow run ID');
  if (!/^[a-f0-9]{40}$/i.test(sourceSha || '')) throw new Error('Expected a full checkout commit SHA');
  if (typeof token !== 'string' || token.length < 1) throw new Error('Missing Actions read token');
  const endpoint = new URL(apiUrl || 'https://api.github.com');
  if (endpoint.protocol !== 'https:' && endpoint.hostname !== 'localhost') throw new Error('GitHub API endpoint must use HTTPS');
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

function inspectProducerReadiness({ repository, runId, run, jobsPage }) {
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
  return { ready: true };
}

export function inspectFrontendArtifactReadiness({ repository, runId, sourceSha, run, jobsPage, artifactsPage }) {
  const producerState = inspectProducerReadiness({ repository, runId, run, jobsPage });
  if (!producerState.ready) return producerState;

  const artifacts = validatePage(artifactsPage, 'workflow artifacts');
  const expected = frontendArtifactNames(sourceSha);
  const byName = new Map(artifacts.map(artifact => [artifact.name, artifact]));
  const dist = byName.get(expected.dist);
  const manifest = byName.get(expected.manifest);
  for (const artifact of [dist, manifest]) {
    if (artifact?.expired) throw new Error('Native frontend artifact has expired; refusing fallback');
  }
  if (!dist || !manifest) return { ready: false, reason: 'exact-SHA artifact pair is not yet listed' };
  return { ready: true, names: expected };
}

function getHeader(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower && value != null) return String(value);
  }
  return null;
}

function parseRetryDelayMs(headers, nowMs) {
  const retryAfter = getHeader(headers, 'retry-after')?.trim();
  if (retryAfter) {
    if (/^\d+(\.\d+)?$/.test(retryAfter)) {
      return Math.ceil(Number(retryAfter) * 1_000);
    }
    const retryDateMs = Date.parse(retryAfter);
    if (Number.isFinite(retryDateMs)) {
      return Math.max(0, retryDateMs - nowMs);
    }
  }
  const remaining = getHeader(headers, 'x-ratelimit-remaining')?.trim();
  const reset = getHeader(headers, 'x-ratelimit-reset')?.trim();
  if (remaining === '0' && reset && /^\d+$/.test(reset)) {
    return Math.max(0, Number(reset) * 1_000 - nowMs + 1_000);
  }
  return null;
}

async function readErrorMessage(response) {
  try {
    if (typeof response.text === 'function') {
      const raw = await response.text();
      if (!raw) return '';
      try {
        const parsed = JSON.parse(raw);
        if (typeof parsed?.message === 'string') return parsed.message.trim();
      } catch {
        // Non-JSON error body
      }
      return raw.trim().slice(0, 300);
    }
    if (typeof response.json === 'function') {
      const parsed = await response.json();
      if (typeof parsed?.message === 'string') return parsed.message.trim();
    }
  } catch {
    // Ignore error-body read failures
  }
  return '';
}

function isRateLimitForbidden(headers, message) {
  if (getHeader(headers, 'retry-after')?.trim()) return true;
  if (getHeader(headers, 'x-ratelimit-remaining')?.trim() === '0') return true;
  return /\brate limit\b/i.test(message);
}

async function githubJson(url, token, fetchImpl, requestTimeoutMs, nowMs) {
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
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError' || error instanceof TypeError) {
      return { retry: true, status: error.name || 'network-error', retryAfterMs: null, rateLimited: false };
    }
    throw error;
  }
  if (!response.ok) {
    const retryAfterMs = parseRetryDelayMs(response.headers, nowMs);
    if (response.status >= 500 || response.status === 429) {
      return {
        retry: true,
        status: response.status,
        retryAfterMs,
        rateLimited: response.status === 429,
      };
    }
    const message = await readErrorMessage(response);
    if (response.status === 403 && isRateLimitForbidden(response.headers, message)) {
      return {
        retry: true,
        status: 403,
        retryAfterMs,
        rateLimited: true,
      };
    }
    const detail = message ? `: ${message}` : '';
    throw new Error(`GitHub Actions API request failed with HTTP ${response.status}${detail}`);
  }
  return { value: await response.json() };
}

export async function waitForNativeFrontendArtifacts({
  repository,
  runId,
  sourceSha,
  token,
  apiUrl,
  fetchImpl = fetch,
  sleep = delay,
  timeoutMs = 900_000,
  pollIntervalMs = 5_000,
  now = Date.now,
}) {
  const endpoint = assertInputs({ repository, runId, sourceSha, token, apiUrl });
  frontendArtifactNames(sourceSha);
  const baseHref = endpoint.href.replace(/\/?$/, '/');
  const runPath = `repos/${repository}/actions/runs/${runId}`;
  const started = now();
  let consecutiveRateLimits = 0;
  let lastTransientStatus = null;
  const remainingMs = () => Math.max(1, timeoutMs - (now() - started));
  const pause = async (requestedDelayMs = pollIntervalMs) => {
    const left = timeoutMs - (now() - started);
    if (left > 0) await sleep(Math.min(Math.max(0, requestedDelayMs), left));
  };
  const pauseForRetry = async result => {
    lastTransientStatus = result.status;
    if (result.rateLimited) {
      consecutiveRateLimits += 1;
    }
    const backoffMs = result.rateLimited
      ? Math.min(60_000, pollIntervalMs * (2 ** Math.min(consecutiveRateLimits - 1, 4)))
      : pollIntervalMs;
    const waitMs = result.retryAfterMs != null
      ? Math.max(pollIntervalMs, result.retryAfterMs)
      : backoffMs;
    await pause(waitMs);
  };
  const request = url => githubJson(url, token, fetchImpl, Math.min(15_000, remainingMs()), now());
  while (now() - started < timeoutMs) {
    const runResult = await request(new URL(runPath, baseHref));
    if (runResult.retry) {
      await pauseForRetry(runResult);
      continue;
    }
    const jobsResult = await request(new URL(`${runPath}/jobs?per_page=100`, baseHref));
    if (jobsResult.retry) {
      await pauseForRetry(jobsResult);
      continue;
    }
    const producerState = inspectProducerReadiness({
      repository,
      runId,
      run: runResult.value,
      jobsPage: jobsResult.value,
    });
    if (!producerState.ready) {
      consecutiveRateLimits = 0;
      await pause();
      continue;
    }
    const artifactsResult = await request(new URL(`${runPath}/artifacts?per_page=100`, baseHref));
    if (artifactsResult.retry) {
      await pauseForRetry(artifactsResult);
      continue;
    }
    consecutiveRateLimits = 0;
    const state = inspectFrontendArtifactReadiness({
      repository,
      runId,
      sourceSha,
      run: runResult.value,
      jobsPage: jobsResult.value,
      artifactsPage: artifactsResult.value,
    });
    if (state.ready) return state.names;
    await pause();
  }
  const transientSuffix = lastTransientStatus != null ? ` (last transient status: ${lastTransientStatus})` : '';
  throw new Error(`Timed out waiting for native frontend artifacts for source ${sourceSha} in run ${runId}${transientSuffix}; no fallback used`);
}

async function main() {
  const sourceSha = process.argv[2] || execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const names = await waitForNativeFrontendArtifacts({
    repository: process.env.GITHUB_REPOSITORY,
    runId: process.env.GITHUB_RUN_ID,
    sourceSha,
    token: process.env.GH_TOKEN || process.env.ACTIONS_READ_TOKEN,
    apiUrl: process.env.GITHUB_API_URL || 'https://api.github.com',
  });
  console.log(`native_frontend_artifacts_ready source=${sourceSha} dist=${names.dist} manifest=${names.manifest}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
