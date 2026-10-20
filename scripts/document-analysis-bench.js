import { createDocumentAnalysisFixtures, DOCUMENT_ANALYSIS_FIXTURE_LIMIT_BYTES } from "/scripts/document-analysis-fixtures.mjs";

const MAX_AST_NODES = 50_000;
const MAX_CACHE_FILLERS = 16;

function countAstNodes(tree) {
  let count = 0;
  const pending = [tree];
  while (pending.length) {
    const node = pending.pop();
    if (!node || typeof node !== "object") continue;
    count++;
    if (Array.isArray(node.children)) pending.push(...node.children);
    if (count > MAX_AST_NODES) throw new Error(`Fixture exceeded the ${MAX_AST_NODES} AST-node safety limit`);
  }
  return count;
}

function frameMonitor(run) {
  const intervals = [];
  let previous = performance.now();
  let collecting = true;
  const tick = () => {
    if (!collecting) return;
    const now = performance.now();
    intervals.push(now - previous);
    previous = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return new Promise((resolve, reject) => {
    setTimeout(async () => {
      let value;
      try { value = await run(); }
      catch (error) { collecting = false; reject(error); return; }
      setTimeout(() => {
        collecting = false;
        resolve({
          value,
          frameSamples: intervals.length,
          maxRafGapMs: intervals.length ? Math.max(...intervals) : null,
          rafGapsOver50ms: intervals.filter(interval => interval > 50).length,
        });
      }, 100);
    }, 60);
  });
}

function createWorker() {
  return new Worker("/scripts/document-analysis.worker.js", { type: "module" });
}

function workerRequest(worker, source, id) {
  return new Promise((resolve, reject) => {
    const onMessage = event => {
      if (event.data.id !== id) return;
      cleanup();
      resolve(event.data);
    };
    const onError = event => { cleanup(); reject(new Error(event.message || "Analysis worker failed")); };
    const cleanup = () => {
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
    };
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
    worker.postMessage({ id, source });
  });
}

function stableJson(value) {
  return JSON.stringify(value);
}

async function measureOne(fixture, repetition) {
  // Each dynamic module instance owns a fresh analysis LRU, so repetitions
  // measure a true cold source without changing fixture bytes or semantics.
  const moduleQuery = encodeURIComponent(`${fixture.name}-${repetition}`);
  const { analyzeDocument } = await import(`/src/documentAnalysis.ts?benchmark=${moduleQuery}`);
  const source = fixture.source;
  let worker;
  const idPrefix = `${fixture.name}-${repetition}`;
  try {
    const syncObservation = await frameMonitor(() => {
      const started = performance.now();
      const analysis = analyzeDocument(source);
      const parsedAt = performance.now();
      const clone = structuredClone(analysis);
      const finished = performance.now();
      return { analysis, clone, parseMs: parsedAt - started, cloneMs: finished - parsedAt, totalMs: finished - started };
    });

    const workerObservation = await frameMonitor(async () => {
      const started = performance.now();
      worker = createWorker();
      const response = await workerRequest(worker, source, `${idPrefix}-cold`);
      return { response, startupAndRoundTripMs: performance.now() - started };
    });
    const syncResult = syncObservation.value;
    const workerResult = workerObservation.value.response;
    const parity = stableJson(syncResult.analysis) === stableJson(workerResult.analysis);
    if (!parity) throw new Error(`Synchronous and worker AST/projections differ for ${fixture.name}`);
    const astNodeCount = countAstNodes(syncResult.analysis.tree);

    const syncWarmStarted = performance.now();
    analyzeDocument(source);
    const syncWarmMs = performance.now() - syncWarmStarted;
    const workerWarmStarted = performance.now();
    const workerWarm = await workerRequest(worker, source, `${idPrefix}-warm`);
    const workerWarmRoundTripMs = performance.now() - workerWarmStarted;
    if (stableJson(syncResult.analysis) !== stableJson(workerWarm.analysis)) throw new Error(`Warm worker AST differs for ${fixture.name}`);

    // 16 distinct small inputs exceed the current analysis LRU entry limit,
    // without constructing a large filler corpus or exceeding the cache byte cap.
    for (let index = 0; index < MAX_CACHE_FILLERS; index++) {
      const filler = `# Cache eviction filler ${fixture.name} ${repetition} ${index}\n\nFiller ${index}.`;
      analyzeDocument(filler);
      await workerRequest(worker, filler, `${idPrefix}-filler-${index}`);
    }
    const syncEvictedStarted = performance.now();
    analyzeDocument(source);
    const syncEvictedMs = performance.now() - syncEvictedStarted;
    const workerEvictedStarted = performance.now();
    const workerEvicted = await workerRequest(worker, source, `${idPrefix}-evicted`);
    const workerEvictedRoundTripMs = performance.now() - workerEvictedStarted;
    if (stableJson(syncResult.analysis) !== stableJson(workerEvicted.analysis)) throw new Error(`Evicted worker AST differs for ${fixture.name}`);

    return {
      fixture: fixture.name,
      repetition,
      sourceBytes: new TextEncoder().encode(source).byteLength,
      astNodeCount,
      exactAstAndProjectionParity: parity,
      syncCold: {
        parseMs: syncResult.parseMs,
        structuredCloneMs: syncResult.cloneMs,
        parsePlusCloneMs: syncResult.totalMs,
        maxRafGapMs: syncObservation.maxRafGapMs,
        rafGapsOver50ms: syncObservation.rafGapsOver50ms,
      },
      workerCold: {
        workerParseMs: workerResult.parseMs,
        startupAndRoundTripMs: workerObservation.value.startupAndRoundTripMs,
        maxRafGapMs: workerObservation.maxRafGapMs,
        rafGapsOver50ms: workerObservation.rafGapsOver50ms,
      },
      warmCache: { syncMs: syncWarmMs, workerParseMs: workerWarm.parseMs, workerRoundTripMs: workerWarmRoundTripMs },
      after16EntryEvictions: { syncParseMs: syncEvictedMs, workerParseMs: workerEvicted.parseMs, workerRoundTripMs: workerEvictedRoundTripMs },
    };
  } finally {
    worker?.terminate();
  }
}

window.runDocumentAnalysisSample = async ({ fixtureName, repetition }) => {
  if (!Number.isInteger(repetition) || repetition < 1 || repetition > 10) throw new RangeError("Repetition must be between 1 and 10");
  const fixture = createDocumentAnalysisFixtures().find(candidate => candidate.name === fixtureName);
  if (!fixture) throw new Error(`Unknown fixture: ${fixtureName}`);
  if (fixture.sourceBytes > DOCUMENT_ANALYSIS_FIXTURE_LIMIT_BYTES) throw new Error(`${fixture.name} exceeds the fixture byte limit`);
  return measureOne(fixture, repetition);
};
