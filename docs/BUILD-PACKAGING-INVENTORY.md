# Build and package inventory

## Cache policy

Desktop CI and release jobs cache a wheelhouse built from both
`desktop/requirements.txt` and `desktop/requirements-build.txt`. The key
includes runner OS, runner architecture and CPython 3.13 ABI, so compiled wheels
cannot cross macOS architectures or operating systems. A hashed manifest
records requirements identity, interpreter/platform identity and every wheel
digest. A hit is installed offline only after that manifest validates. Missing,
corrupt, mismatched or incomplete cache content triggers a wheel rebuild before
retrying the offline install; CI records the cache-hit value and wheel count.

Android CI and release jobs cache only Gradle module downloads, transforms,
task outputs and the wrapper distribution. The cache key includes the JDK
generation and Android Gradle scripts, wrapper properties, version catalog and
dependency locks. Gradle still validates task inputs before reusing outputs.
Task-output caching is enabled for instrumentation and lint builds. CI disables
it for signed release APK builds so signed outputs cannot be restored from a
cache key that omits signing material. Dependency downloads remain cached.
Signing keystores, passwords, Android user data and daemon state are outside
these paths. Configuration cache is not enabled. Local Android builds retain a
two-worker cap and project lock; the script does not stop other Gradle daemons.

## Browser worker evidence

The local Playwright configuration stays at one worker to keep memory use
predictable on developer machines. CI overrides that setting to two workers
for the browser suite only; coverage and all native/emulator suites remain
unchanged. On the same source with the same 68 browser tests, one worker passed
in 235,377 ms with peak process-tree PSS of 1,768,199 KiB; two workers passed in
148,369 ms with 2,404,082 KiB peak PSS. That single comparison is about 37%
less wall time at about 36% more peak PSS (roughly 1.69 GiB versus 2.29 GiB).
Both runs passed, but this is one observation per setting, not a repeated
determinism/flakiness study. CI is the bounded place to exercise the faster
setting; do not change the local default or reduce browser coverage based on
this measurement.

Android API 35 and API 36 currently build and test in separate matrix jobs.
Reusing an APK pair across hosted jobs would require transferring and verifying
the exact app/test artifacts and proving source, toolchain, lockfile and
integrity identity while still running both emulator suites. No build or timing
evidence currently justifies that provenance change, so both matrix jobs keep
their own source build. Gradle dependency/task caches remain input-keyed, with
task output reuse disabled for signed release APKs; signing material and
daemon/user state are not cached.

Rust release profile changes are also deferred: current settings already favor
size, and no controlled size/compile-memory/PDF-speed comparison is available.
Release artifact promotion is limited to the existing recovery workflow, which
requires a completed run for the exact tagged source and successful desktop
builds, while Android is re-verified rather than reused. This change does not
alter release provenance or skip any exact-source gates.

## Reader asset report

CI uploads a platform-specific build inventory containing the cached Python
wheel filenames, sizes, interpreter and cache-hit evidence, alongside
`reader-assets-report.json`. Run
`npm run build:native` to make a native-only reader build while preserving the
default `npm run build` dev/legacy output; `npm run package:native` builds and
packages the native desktop app locally. Run
`node scripts/report-web-assets.mjs dist --verify-native --public-root public`
for a compact summary or add `--output PATH` to save the full file inventory.
The verifier requires both native HTML entries, generated legal notices and
every file from `public/`. It follows static HTML, JS and CSS references and
lists fonts, bytes, and files the static scan did not reach.

This report is an investigation aid, not a pruning manifest. Runtime-generated
URLs or assets loaded through APIs may not be visible to static tracing. No
assets, fonts, Python dependencies, Qt resources or installer contents are
removed based on the report alone. The build-time checksum path streams each
installer in 1 MiB blocks to avoid allocating the complete installer in RAM.

## Optional document-analysis worker experiment

Run `node scripts/benchmark-document-analysis.mjs --output PATH` to compare the
existing synchronous document analyzer with an isolated worker running the same
implementation. The harness is served only by a temporary Vite development
server and is not a build entry or packaged asset. It uses generated Markdown
only, runs each fixture/repetition in a fresh browser page, checks full AST and
derived-analysis parity, and reports parse/clone/round-trip timings and
requestAnimationFrame gaps. Fixtures are capped at 4 MB and 50,000 AST nodes.
The worker result transfers a cloned full AST; no heap/process PSS measurement
is made, so this experiment cannot establish a worker memory benefit. Its frame
timing is scheduling responsiveness, not presented pixels. Do not adopt an
asynchronous production parser path based on this report alone: consumer
integration, stale-revision handling, memory and semantic gates remain
separate work.
