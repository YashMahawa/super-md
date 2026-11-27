import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatRateLimitDiagnostics,
  frontendArtifactNames,
  inspectFrontendArtifactReadiness,
  sanitizeRateLimitHeaders,
  waitForNativeFrontendArtifacts,
} from './wait-native-frontend-artifacts.mjs';

const repository = 'example/super-md';
const runId = '1234';
const sourceSha = 'a'.repeat(40);
const names = frontendArtifactNames(sourceSha);
const run = { id: Number(runId), repository: { full_name: repository } };

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

it('does not burn active artifact timeout while the producer job is queued for a runner', async () => {
  let clock = 0;
  const fetchImpl = async input => {
    const url = new URL(input);
    const jobs = clock < 50_000
      ? []
      : clock < 800_000
        ? [{ name: 'native_frontend', status: 'queued', conclusion: null }]
        : clock < 870_000
          ? [{ name: 'native_frontend', status: 'in_progress', conclusion: null }]
          : [{ name: 'native_frontend', status: 'completed', conclusion: 'success' }];
    const artifacts = clock >= 870_000
      ? [{ name: names.dist }, { name: names.manifest }]
      : [];
    const body = url.pathname.endsWith('/jobs')
      ? { total_count: jobs.length, jobs }
      : url.pathname.endsWith('/artifacts')
        ? { total_count: artifacts.length, artifacts }
        : { ...run, status: clock >= 870_000 ? 'in_progress' : 'queued' };
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
    pollIntervalMs: 50_000,
  });
  assert.deepEqual(result, names);
  assert.equal(clock, 900_000);
});

it('still fails closed when the producer stays queued past queueTimeoutMs or stalls after starting', async () => {
  let queuedClock = 0;
  await assert.rejects(waitForNativeFrontendArtifacts({
    repository,
    runId,
    sourceSha,
    token: 'test-token',
    fetchImpl: async input => {
      const url = new URL(input);
      const body = url.pathname.endsWith('/jobs')
        ? { total_count: 1, jobs: [{ name: 'native_frontend', status: 'queued', conclusion: null }] }
        : url.pathname.endsWith('/artifacts')
          ? { total_count: 0, artifacts: [] }
          : { ...run, status: 'queued' };
      return { ok: true, status: 200, json: async () => body };
    },
    sleep: async ms => { queuedClock += ms; },
    now: () => queuedClock,
    timeoutMs: 40,
    queueTimeoutMs: 120,
    pollIntervalMs: 20,
  }), /Timed out waiting.*producer job is queued/);
  assert.equal(queuedClock, 120);

  let stalledClock = 0;
  await assert.rejects(waitForNativeFrontendArtifacts({
    repository,
    runId,
    sourceSha,
    token: 'test-token',
    fetchImpl: async input => {
      const url = new URL(input);
      const status = stalledClock < 60 ? 'queued' : 'in_progress';
      const body = url.pathname.endsWith('/jobs')
        ? { total_count: 1, jobs: [{ name: 'native_frontend', status, conclusion: null }] }
        : url.pathname.endsWith('/artifacts')
          ? { total_count: 0, artifacts: [] }
          : { ...run, status: 'in_progress' };
      return { ok: true, status: 200, json: async () => body };
    },
    sleep: async ms => { stalledClock += ms; },
    now: () => stalledClock,
    timeoutMs: 40,
    queueTimeoutMs: 200,
    pollIntervalMs: 20,
  }), /Timed out waiting.*producer job is in_progress/);
  assert.equal(stalledClock, 100);
});

it('backs off on rate-limited HTTP 403/429 responses and distinguishes non-rate-limit HTTP 403', async () => {
  let clock = 1_700_000_000_000;
  const sleeps = [];
  let calls = 0;
  const secretToken = 'ghs_super_secret_token_value';
  const result = await waitForNativeFrontendArtifacts({
    repository,
    runId,
    sourceSha,
    token: secretToken,
    fetchImpl: async input => {
      calls += 1;
      if (calls === 1) {
        return {
          ok: false,
          status: 403,
          headers: new Headers({
            'x-ratelimit-limit': '1000',
            'x-ratelimit-remaining': '0',
            'x-ratelimit-used': '1000',
            'x-ratelimit-reset': String(Math.floor((clock + 12_000) / 1_000)),
            'x-ratelimit-resource': 'core',
          }),
          json: async () => ({ message: 'API rate limit exceeded' }),
        };
      }
      if (calls === 2) {
        return {
          ok: false,
          status: 429,
          headers: new Headers({
            'retry-after': '20',
            'x-ratelimit-resource': 'core',
          }),
          json: async () => ({ message: 'Secondary rate limit' }),
        };
      }
      const url = new URL(input);
      const body = url.pathname.endsWith('/jobs')
        ? { total_count: 1, jobs: [{ name: 'native_frontend', status: 'completed', conclusion: 'success' }] }
        : url.pathname.endsWith('/artifacts')
          ? { total_count: 2, artifacts: [{ name: names.dist }, { name: names.manifest }] }
          : run;
      return { ok: true, status: 200, headers: new Headers(), json: async () => body };
    },
    sleep: async ms => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
    timeoutMs: 120_000,
    pollIntervalMs: 5_000,
    maxBackoffMs: 30_000,
  });
  assert.deepEqual(result, names);
  assert.deepEqual(sleeps, [12_000, 20_000]);

  await assert.rejects(
    async () => {
      try {
        await waitForNativeFrontendArtifacts({
          repository,
          runId,
          sourceSha,
          token: secretToken,
          fetchImpl: async () => ({
            ok: false,
            status: 403,
            headers: new Headers({
              'x-ratelimit-limit': '1000',
              'x-ratelimit-remaining': '994',
              'x-ratelimit-used': '6',
              'x-ratelimit-resource': 'core',
              authorization: `Bearer ${secretToken}`,
            }),
            json: async () => ({ message: `Resource not accessible by integration ${secretToken}` }),
          }),
          sleep: async () => { throw new Error('must not retry non-rate-limited 403'); },
          now: () => 0,
          timeoutMs: 60_000,
        });
      } catch (error) {
        assert.equal(error.message.includes(secretToken), false);
        throw error;
      }
    },
    /forbidden with HTTP 403 \(not rate-limited; remaining=994, limit=1000, used=6, resource=core\)/,
  );

  const sanitized = sanitizeRateLimitHeaders({
    'x-ratelimit-limit': '1000',
    'x-ratelimit-remaining': '0',
    'x-ratelimit-resource': 'core; secret=bad',
    authorization: `Bearer ${secretToken}`,
  });
  assert.equal(sanitized.resource, null);
  assert.equal(formatRateLimitDiagnostics(sanitized), 'remaining=0, limit=1000');
});

function assertNativeFrontendWorkflowWiring(rawCiWorkflow, rawReleaseWorkflow) {
  const ciWorkflow = rawCiWorkflow.replace(/\r\n/g, '\n');
  assert.match(ciWorkflow, /\n  test:\n    needs: native_frontend\n/);
  assert.match(ciWorkflow, /\n  android-device-tests:\n    needs: native_frontend\n/);
  assert.match(ciWorkflow, /\n  release-gate:\n    name: All release tests passed\n    if: always\(\)\n    needs: \[native_frontend, test, browser, android-release, android-device-tests\]\n/);
  assert.equal((ciWorkflow.match(/native-frontend-artifact\.mjs verify dist/g) || []).length, 2);
  assert.equal(ciWorkflow.includes('node scripts/wait-native-frontend-artifacts.mjs'), false);

  const releaseWorkflow = rawReleaseWorkflow.replace(/\r\n/g, '\n');
  assert.match(releaseWorkflow, /\n  desktop:\n    needs: \[prepare, native_frontend\]\n/);
  assert.match(releaseWorkflow, /\n  publish:\n    needs: \[prepare, native_frontend, desktop, android\]\n/);
  assert.equal((releaseWorkflow.match(/native-frontend-artifact\.mjs verify dist/g) || []).length, 1);
  assert.equal(releaseWorkflow.includes('node scripts/wait-native-frontend-artifacts.mjs'), false);
}

it('wires explicit native_frontend job dependencies while keeping source-SHA and manifest checks and release-gate failure', () => {
  const ciWorkflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const releaseWorkflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  assertNativeFrontendWorkflowWiring(ciWorkflow, releaseWorkflow);
  assertNativeFrontendWorkflowWiring(
    ciWorkflow.replace(/\r?\n/g, '\r\n'),
    releaseWorkflow.replace(/\r?\n/g, '\r\n'),
  );
});
