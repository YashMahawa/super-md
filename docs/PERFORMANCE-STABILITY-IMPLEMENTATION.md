# Performance and stability implementation

This is the implementation ledger for the performance/stability audit. A checked
item requires supporting tests or measurements, not merely a source change.
No release is ready until the final cross-platform and installer gates pass.

## Preservation contracts

- Preserve original notes, assets, recovery data and Python outputs.
- Never execute a Python cell to recover, open or export saved output.
- Keep Mermaid compatibility, fonts, offline features and all seven installers.
- Preserve existing signing identity and previous working installations.
- Keep full-snapshot and existing asset transport fallbacks during rollout.
- Preserve selection, navigation, zoom, task editing and accessibility semantics.
- Leave the pre-existing unrelated Rust edit unmodified and unstaged.
- Do not publish an unverified version or move an existing published tag.

## Baseline and regression coverage

- [x] Record installed-app cold/warm timing, frame and process-memory baselines (limitations in PERFORMANCE-BASELINE.md; interactive presented frames remain separate).
- [x] Add Live reference/footnote/loose-list regression fixtures (unit and browser).
- [x] Add Python cross-document/context/provenance regressions (native, reader and PDF lookup; legacy and unsaved output labels).
- [x] Add native lifecycle and renderer-failure recovery tests (owned Qt renderer kill passed; Android lifecycle unit coverage, emulator execution remains a release gate).
- [x] Add Unicode/reordering/interruption/flush edit-protocol tests (TypeScript, Qt and Android).
- [x] Add huge-block, image-decode and repeated-cycle memory fixtures (three fresh 31.36 MP image runs and six revisits passed; separate >80 KB single-table/list/Python browser fixtures preserve all rows/items/source and distant search through theme/zoom changes; long-session leak qualification remains separate).
- [x] Verify full-document accessibility strategy with Chromium AX-tree and keyboard navigation tests (distant headings, lists, tables, links, footnotes and code controls; manual TalkBack/NVDA/Orca validation is not claimed).

## Correctness and resilience

- [x] Whole-document context and semantic blocks in Live (shared AST and passing semantic browser regression).
- [x] Document/cell-scoped Python output identity and visible provenance.
- [x] Preserve and label legacy execution results without automatic reruns.
- [x] Process-owned Android WebView timer lifecycle (unit verified; presented lifecycle gate below).
- [x] Android and Qt renderer-process recovery from authoritative native state (API 36 CI and local API 35 recovery passed; packaged Qt renderer termination restores acknowledged text and scroll without Python execution; the complete exact-release platform suites remain mandatory below).
- [x] Reliable disk-backed reopen for huge closed documents (atomic-failure and dirty portable round trips; snapshots are not automatically deleted).

## Reader work and transport

- [x] Shared revision-aware document analysis and coalesced outlines (shared exact-source bounded cache and original offsets).
- [x] Measure and, if justified, move cold parsing behind a worker boundary (large Source outlines only; full-AST worker round trips did not improve total latency and are not shipped).
- [x] Shared visibility observation and stable block metadata (observer ownership/focus tests).
- [x] Owned/cancellable/deduplicated diagram scheduling (cancellation/dedup tests; same-runtime native comparison verified all 12 mixed Pele/fallback diagrams across three fresh processes and six revisits per version; measurements and limitations in PERFORMANCE-BASELINE.md).
- [x] Revisioned UTF-16 edit transport with atomic native apply and fallback.
- [x] Save/close/export/window-transfer acknowledgement barriers (unit/browser checked; native emulator verification remains below).
- [x] Scoped streamed asset URLs on Android and Qt with legacy fallback (capability, ownership, revocation tests and real Qt raster check).
- [x] Evaluate deduplicated/cancellable asset loading and bounded decode scheduling (overlapping native resolutions are deduplicated; stale results are ignored, not physically cancelled; the measured image stress does not justify an additional decode cap).
- [x] Evaluate stable image sizing and non-destructive preview derivatives (natural aspect ratio and full quality retained; cold layout-shift data is confounded and does not justify derivatives or a sizing-policy change).
- [x] Narrow native snapshot/reader notifications and coalesced recovery writes (bounded latest slots, failure/retry and shutdown tests).
- [x] Cancellable phase-based export progress without incomplete final files (owned Qt staging/cancel tests; SAF publication is noncancellable once begun, not claimed crash-atomic).
- [x] Storage and privacy-preserving diagnostics distinguish irreplaceable data (bounded, read-only, fixed category labels).

## Build and package efficiency

- [x] ABI/platform-keyed Python wheel caching and verify actual warm reuse (Ubuntu CI 39521221615 restored the exact key, verified wheel hashes, and completed a real offline cached install; mock-test log messages are not counted as this evidence).
- [x] Gradle dependency/task caching and phase-level Android CI timings (signed task output reuse disabled).
- [x] Evaluate immutable emulator APK reuse while retaining both API suites (existing timings do not isolate assembly cost; producer barriers could lengthen the critical path, so reuse is not adopted without that evidence).
- [x] Bounded incremental local build lane; no unrelated daemon termination.
- [x] Measure two browser CI workers for speed, memory and determinism (initial same-source 68-test pair: 235 s vs 148 s with increased peak memory; subsequent complete 70-test local and CI runs passed at two workers; local default stays one).
- [x] Cache inventory/retention report; no destructive blanket cleanup.
- [x] Reader-entry asset manifest and packaged offline reachability checks (94 fonts retained; every public resource checked).
- [x] Font/dependency inventory and only verified non-feature-removing pruning (no speculative pruning accepted).
- [x] Streaming package checksums and safe reduced-copy staging (streamed hash tests; installer staging retains complete contents).
- [x] Measure selected Rust size/build/runtime profile alternatives (clean snapshot; equal stripping/debug settings; z/8 and s/1 save only 480 and 26,000 bytes, respectively, with no reliable runtime gain; retain s/8).
- [x] Evaluate release artifact promotion only with exact provenance and gates (retain existing exact-tag desktop recovery and Android reverification; no broader reuse or unmeasured speedup claim).

## Explicitly deferred

Wholesale language/framework/parser rewrites, replacement packagers, lite or
on-demand runtime editions, removed features/platforms/fonts/languages, external
telemetry/cache services, incompatible note formats, and automatic deletion of
user content or existing caches are not part of this implementation. Experiments
that show no benefit or cause regression must be rejected, with evidence recorded.

## Final release gates

- [ ] All regression/unit/browser/native tests pass on the exact release source.
- [ ] Android API 35/36 emulator presented-pixel/lifecycle tests pass.
- [ ] Qt software and accelerated checks and all supported desktop builds pass.
- [ ] Compare installed-app measurements with baseline; no accepted UX regression.
- [ ] Signed Android release and all desktop installers pass clean-machine checks.
- [ ] Complete seven-installer/checksum set verified before publication.
- [ ] Verify public downloads and retain a working rollback installation.
