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
