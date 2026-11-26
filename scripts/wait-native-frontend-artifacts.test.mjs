import { it } from 'node:test';
import assert from 'node:assert/strict';
import {
  frontendArtifactNames,
  inspectFrontendArtifactReadiness,
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

it('retries HTTP 403 rate-limit responses using reset and retry-after headers while failing closed on permission 403s', async () => {
  let clock = 100_000;
  const sleeps = [];
  let resetRateLimited = true;
  const resultAfterReset = await waitForNativeFrontendArtifacts({
    repository,
    runId,
    sourceSha,
    token: 'test-token',
    fetchImpl: async input => {
      if (resetRateLimited) {
        resetRateLimited = false;
        return {
          ok: false,
          status: 403,
          headers: new Headers({
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': '104',
          }),
          text: async () => JSON.stringify({ message: 'API rate limit exceeded for installation ID 1.' }),
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
    timeoutMs: 30_000,
    pollIntervalMs: 10,
  });
  assert.deepEqual(resultAfterReset, names);
  assert.equal(sleeps.length, 1);
  assert.ok(sleeps[0] >= 4_000, `expected backoff until rate-limit reset, got ${sleeps[0]}ms`);

  let secondaryClock = 0;
  const secondarySleeps = [];
  let secondaryRateLimited = true;
  const resultAfterRetryAfter = await waitForNativeFrontendArtifacts({
    repository,
    runId,
    sourceSha,
    token: 'test-token',
    fetchImpl: async input => {
      if (secondaryRateLimited) {
        secondaryRateLimited = false;
        return {
          ok: false,
          status: 403,
          headers: new Headers({
            'retry-after': '2',
            'x-ratelimit-remaining': '450',
          }),
          text: async () => JSON.stringify({ message: 'You have exceeded a secondary rate limit.' }),
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
      secondarySleeps.push(ms);
      secondaryClock += ms;
    },
    now: () => secondaryClock,
    timeoutMs: 10_000,
    pollIntervalMs: 10,
  });
  assert.deepEqual(resultAfterRetryAfter, names);
  assert.deepEqual(secondarySleeps, [2_000]);

  let permissionClock = 0;
  await assert.rejects(waitForNativeFrontendArtifacts({
    repository,
    runId,
    sourceSha,
    token: 'test-token',
    fetchImpl: async () => ({
      ok: false,
      status: 403,
      headers: new Headers({ 'x-ratelimit-remaining': '999' }),
      text: async () => JSON.stringify({ message: 'Resource not accessible by integration' }),
    }),
    sleep: async ms => { permissionClock += ms; },
    now: () => permissionClock,
    timeoutMs: 10_000,
    pollIntervalMs: 10,
  }), /GitHub Actions API request failed with HTTP 403/);
  assert.equal(permissionClock, 0);
});

it('skips artifact and redundant run requests while native_frontend is queued or in progress', async () => {
  let clock = 0;
  const statuses = ['queued', 'in_progress', 'completed'];
  const counts = { run: 0, jobs: 0, artifacts: 0 };
  const result = await waitForNativeFrontendArtifacts({
    repository,
    runId,
    sourceSha,
    token: 'test-token',
    fetchImpl: async input => {
      const url = new URL(input);
      if (url.pathname.endsWith('/jobs')) {
        const status = statuses[Math.min(counts.jobs, statuses.length - 1)];
        counts.jobs++;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            total_count: 1,
            jobs: [{
              name: 'native_frontend',
              status,
              conclusion: status === 'completed' ? 'success' : null,
            }],
          }),
        };
      }
      if (url.pathname.endsWith('/artifacts')) {
        counts.artifacts++;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            total_count: 2,
            artifacts: [{ name: names.dist }, { name: names.manifest }],
          }),
        };
      }
      counts.run++;
      return { ok: true, status: 200, json: async () => run };
    },
    sleep: async ms => { clock += ms; },
    now: () => clock,
    timeoutMs: 100,
    pollIntervalMs: 10,
  });
  assert.deepEqual(result, names);
  assert.deepEqual(counts, { run: 2, jobs: 3, artifacts: 1 });
});
