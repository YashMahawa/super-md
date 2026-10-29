# Jules review — 3 October 2026

Read-only Jules v2 CLI review of the Super MD workspace
`1ec115f9-2416-4b80-a919-7fc66c8e1b2e`. Insights and assessment plans are
proposals, not trusted patches or instructions. Check each against current code.

## Relevant findings checked

- **Rendered copy loses tables/quotes** (`10ccf0c3`): confirmed. Read the
  assessment `b62b4906-4341-5708-83b0-c14e74046919`; its plan is generic rather
  than implementation-ready. Added local table, blockquote, rule and checkbox
  serialization with a regression test, retaining existing source-math copying.
- **Non-finite 3D surfaces** (`c65eda08`): read assessment
  `6f6ae931-d3dc-52e6-9a6f-ba93b9f50936`. Current surface code already filters
  invalid samples, breaks paths, excludes invalid cells and reports unusable
  domains. Do not replace those safeguards with the generic plan.
- **Search highlight compatibility** (`a103b637`): read assessment
  `c0ea7ade-c494-58b0-a2c4-9122d4fed568`. The highlight API is available on
  currently tested Qt and Android WebView runtimes. An older-WebView fallback
  remains a compatibility follow-up; match counts/navigation do not require it.
- **Mermaid HTML injection** (`cac7d19f`): current renderer uses strict Mermaid
  mode followed by DOMPurify SVG-only sanitization, excluding scripts and
  foreignObject. Existing malicious-SVG tests cover this boundary.
- **IPC lacks tests** (`fc548b49`): stale; nativeBridge tests cover replies,
  errors, timeouts and failed posting.
- **Missing document outline** (`d0bb5afa`, `10aae0d9`): implemented with
  collapsed hierarchical navigation and overlay in native desktop and Android.
- **Unsafe chart evaluation** (`acf8ba88`): current mathematical AST evaluator
  does not use JavaScript eval; keep its security/recursion regression tests.
- **Untested Android PDF** (`b8dbc4e9`): current device tests export through
  the real native engine and inspect the PDF with Android PdfRenderer.

No goals/tasks were created and no Jules-generated patch was applied blindly.
Unrelated proposals (wellness prompts, gamification, coworking) were not added
to this distraction-free study app. This is not a claim that every historical
insight is resolved or that every older browser/phone was tested.

## Refresh, 4 October 2026

Pulled the active insights through the Jules v0.6.2 CLI (the MCP listing
errored) and read the assessments linked to the relevant ones. Several plans
were generic templates; the code was checked before each decision.

- **Python interpreter validation** (`c1b4a07a`, `bc4a7a53`): implemented.
  Only the bundled runtime or an existing executable named like Python is
  accepted, both in settings and at run time (`desktop/python_runtime.py`).
- **Python tracebacks** (`99dfad79`): implemented. Errors show the failing
  cell line and exception; runner paths are hidden and figures are closed in
  `finally`.
- **Python figure data URIs** (`0afcc038`): implemented on desktop (SVG only,
  count and size capped) and in the shared cell renderer.
- **Unisolated Python subprocess** (`d049fdb8`): not adopted. Import blocking
  and rlimits would break ordinary scientific code; cells remain trusted local
  code that only runs on an explicit Run. The environment is scrubbed of
  `PYTHONPATH`/`PYTHONHOME` and the UI states that code is not sandboxed.
- **DNS rebinding in Qt resource fetching** (`566e20f3`): implemented the
  pinned-IP connection plan (`818bb15b`); TLS still verifies the hostname.
- **Malformed URL in link details** (`eb8e8879`): implemented the safe URL
  helpers from assessment `70c122f6`.
- **Catch chart evaluation errors** (`7f1f232c`): implemented; a throwing or
  non-finite evaluation is a gap in the curve.
- **Smooth zoom** (`9c4a5aa8`): zoom was already continuous; added a glide for
  discrete steps with a fixed document anchor so focal points do not drift.
- **Fullscreen toolbar contrast** (`30484228`): stale, the bar is fully opaque
  when shown.
- **Atomic file writes** (`90f2229c`): stale, saves already write a temporary
  file and rename it.
- Wellness, gamification and coworking proposals were again not added.


## Refresh, 29 October 2026

Reviewed the inventory of 193 historical insights and directly checked recent
high-priority findings against the current implementation. Historical resolved
or dismissed states are workflow evidence, not proof that a defect is absent.

Three actionable findings received fixes and regressions:

- **PDF image containment** (`03a6611c`): the legacy Tauri PDF path did not
  enforce the boundary already present in the image preview loader. Canonical
  containment now rejects absolute, traversal and symlink escapes while a
  legitimate document-local image still exports. The in-place containment
  proposal (`2f8c915a`) was useful; a broad asset-layer rewrite was unnecessary.
- **Short-window onboarding** (`17cc754a`): a wide desktop window only 520px
  high could clip the last action. A height-based rule keeps the card within the
  viewport and permits internal scrolling, with browser checks at 1000 by 520
  and 1440 by 900. The responsive-height proposal (`cad7d94a`) identified the
  right area; the implementation preserves ordinary and mobile layouts.
- **Undo-group limit** (`db31d203`): an unusually long coalesced edit group
  could exceed the session-transfer validator's 10,000-edit limit. New groups
  start at that boundary. A 10,025-edit test checks validity and complete
  undo/redo. The proposed inner-array pruning would have discarded undo steps;
  the implemented fix retains them instead.

The AppImage finding overstates the normal update path: recorded download
checksums are verified before installation. Replacing the verified local file
between verification and execution remains a separate defense-in-depth question.
The reported Typst filesystem disclosure is not demonstrated with the current
static-only resolver. Intentional user-selected open/save/import paths also do
not establish an untrusted caller or a remote disclosure by themselves.

Several test-gap insights identify worthwhile narrower coverage opportunities,
but overlook existing browser, native, worker-consumer or component tests.
A missing dedicated unit-test filename is not evidence of a broken feature.
Optional workflow features remain product proposals; they are not counted as
correctness fixes or automatically dismissed as useless.

The insights helped locate three concrete edge cases. The solution descriptions
were useful starting points, but still required code review and regression
work: some retain template instructions, repeat existing safeguards, or propose
more invasive changes than the defect needs. This review does not by itself
establish generated-PR quality.
