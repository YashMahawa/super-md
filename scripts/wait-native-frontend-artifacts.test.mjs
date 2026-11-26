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

it('retries GitHub HTTP 403 rate-limit responses honoring reset headers while failing closed on permission 403s', async () => {
  let clock = 1_000_000;
  let attempts = 0;
  const sleeps = [];
  const rateLimitedFetch = async input => {
    attempts++;
    if (attempts === 1) {
      return new Response(JSON.stringify({ message: 'API rate limit exceeded for installation ID.' }), {
        status: 403,
        headers: {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(Math.ceil((clock + 25_000) / 1000)),
        },
      });
    }
    if (attempts === 2) {
      return new Response(JSON.stringify({ message: 'You have exceeded a secondary rate limit.' }), {
        status: 403,
        headers: { 'retry-after': '12' },
      });
    }
    const url = new URL(input);
    const body = url.pathname.endsWith('/jobs')
      ? { total_count: 1, jobs: [{ name: 'native_frontend', status: 'completed', conclusion: 'success' }] }
      : url.pathname.endsWith('/artifacts')
        ? { total_count: 2, artifacts: [{ name: names.dist }, { name: names.manifest }] }
        : run;
    return new Response(JSON.stringify(body), { status: 200 });
  };

  const result = await waitForNativeFrontendArtifacts({
    repository,
    runId,
    sourceSha,
    token: 'test-token',
    fetchImpl: rateLimitedFetch,
    sleep: async ms => { sleeps.push(ms); clock += ms; },
    now: () => clock,
    timeoutMs: 120_000,
    pollIntervalMs: 5_000,
  });
  assert.deepEqual(result, names);
  assert.deepEqual(sleeps, [25_000, 12_000]);

  const forbiddenFetch = async () => new Response(
    JSON.stringify({ message: 'Resource not accessible by integration' }),
    { status: 403, headers: { 'x-ratelimit-remaining': '999' } },
  );
  await assert.rejects(waitForNativeFrontendArtifacts({
    repository,
    runId,
    sourceSha,
    token: 'test-token',
    fetchImpl: forbiddenFetch,
    sleep: async () => {},
    now: () => 0,
    timeoutMs: 60_000,
    pollIntervalMs: 5_000,
  }), /GitHub Actions API request failed with HTTP 403/);
});

it('polls only the jobs endpoint while native_frontend is queued or in_progress', async () => {
  let clock = 0;
  let jobsPolls = 0;
  const paths = [];
  const fetchImpl = async input => {
    const url = new URL(input);
    paths.push(url.pathname);
    if (url.pathname.endsWith('/jobs')) {
      jobsPolls++;
      const completed = jobsPolls >= 4;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          total_count: 1,
          jobs: [{
            name: 'native_frontend',
            status: completed ? 'completed' : 'queued',
            conclusion: completed ? 'success' : null,
          }],
        }),
      };
    }
    if (url.pathname.endsWith('/artifacts')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ total_count: 2, artifacts: [{ name: names.dist }, { name: names.manifest }] }),
      };
    }
    return { ok: true, status: 200, json: async () => run };
  };

  const result = await waitForNativeFrontendArtifacts({
    repository,
    runId,
    sourceSha,
    token: 'test-token',
    fetchImpl,
    sleep: async ms => { clock += ms; },
    now: () => clock,
    timeoutMs: 120_000,
  });
  assert.deepEqual(result, names);
  assert.deepEqual(paths, [
    '/repos/example/super-md/actions/runs/1234',
    '/repos/example/super-md/actions/runs/1234/jobs',
    '/repos/example/super-md/actions/runs/1234/jobs',
    '/repos/example/super-md/actions/runs/1234/jobs',
    '/repos/example/super-md/actions/runs/1234/jobs',
    '/repos/example/super-md/actions/runs/1234/artifacts',
  ]);
});
