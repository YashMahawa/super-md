import test from "node:test";
import assert from "node:assert/strict";
import { createDocumentAnalysisFixtures, DOCUMENT_ANALYSIS_FIXTURE_LIMIT_BYTES } from "./document-analysis-fixtures.mjs";
import { parseArgs } from "./benchmark-document-analysis.mjs";

test("analysis benchmark fixtures are synthetic, bounded and cover the planned stress shapes", () => {
  const fixtures = createDocumentAnalysisFixtures();
  assert.deepEqual(fixtures.map(fixture => fixture.name), [
    "small", "semantic-edge-cases", "math-heavy", "many-blocks", "1mb-many-paragraphs", "4mb-single-paragraph",
  ]);
  for (const fixture of fixtures) {
    assert.equal(fixture.sourceBytes, Buffer.byteLength(fixture.source));
    assert.ok(fixture.sourceBytes <= DOCUMENT_ANALYSIS_FIXTURE_LIMIT_BYTES);
    assert.ok(fixture.source.includes("synthetic") || fixture.source.includes("Synthetic"));
  }
  const semantic = fixtures.find(fixture => fixture.name === "semantic-edge-cases").source;
  for (const marker of ["[source]:", "[^one]:", "- Nested item", ":::callout", "café", "```python", "$\\alpha$"]) {
    assert.ok(semantic.includes(marker), `missing semantic marker ${marker}`);
  }
  assert.equal(fixtures.find(fixture => fixture.name === "1mb-many-paragraphs").sourceBytes, 1_000_000);
  assert.equal(fixtures.find(fixture => fixture.name === "4mb-single-paragraph").sourceBytes, 4_000_000);
});

test("benchmark CLI rejects fewer than three cold repetitions and unknown fixtures", () => {
  assert.throws(() => parseArgs(["--repetitions", "2"]), /between 3 and 10/);
  assert.throws(() => parseArgs(["--fixtures", "private-notes"]), /unknown fixture/);
  assert.equal(parseArgs(["--repetitions", "3", "--fixtures", "small"]).fixtures[0], "small");
});
