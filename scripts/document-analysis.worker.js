import { analyzeDocument } from "/src/documentAnalysis.ts";

self.onmessage = ({ data }) => {
  const started = performance.now();
  const analysis = analyzeDocument(data.source);
  self.postMessage({
    id: data.id,
    parseMs: performance.now() - started,
    analysis,
  });
};
