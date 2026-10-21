# Performance experiments

These are controlled local observations, not universal speed guarantees. All
fixtures are generated and contain no personal notes. Release gates and the
installed-reader baseline are tracked separately.

## Cold analysis worker

The same existing Markdown analyzer ran on the main thread and in a dedicated
module worker. Each fixture had three fresh-page repetitions, followed by
same-source warm requests and requests after 16 cache-evicting inputs. Full
ASTs and derived outlines, offsets, tasks and Python metadata matched exactly
in all 18 cold comparisons and in the warm/evicted comparisons.

| Synthetic fixture | Main parse + clone, median ms | Worker startup + roundtrip, median ms | Main-path largest rAF gap, median ms | Worker-path largest rAF gap, median ms |
|---|---:|---:|---:|---:|
| Small | 8 | 100 | 17 | 17 |
| Semantic edge cases | 16 | 71 | 19 | 17 |
| Math-heavy | 34 | 87 | 42 | 17 |
| Many blocks | 144 | 199 | 154 | 17 |
| 1 MB, many paragraphs | 996 | 1,006 | 1,009 | 37 |
| 4 MB, one paragraph | 2,050 | 2,052 | 2,064 | 19 |

The worker substantially reduces main-thread scheduling stalls for large
inputs, but does not make total parsing faster and adds overhead on small
notes. These rAF observations are not native presented-pixel measurements.
The harness returns cloned full ASTs; it does not demonstrate a memory saving
or prove that an asynchronous rendering architecture is safe. External
process-tree measurement includes the runner, Vite, Chromium and both paths
together, and cannot attribute a memory difference to either path.

The production experiment is therefore limited to large Source-mode derived
outlines: return compact metadata, retire superseded work, preserve the
synchronous compatibility fallback, and keep ordinary rendering/Live/export
semantics unchanged. Full rendering offload remains measurement- and
integration-gated; the isolated benchmark is not itself a production feature.

The reported worker time starts immediately before worker creation and ends
at its response. It excludes the harness's rAF monitor warmup/cooldown. Earlier
exploratory timing that included those monitor delays is invalid and is not
used in this table.

## Image stress methodology

The optional image fixture keeps encoded Markdown under 2 MB while containing
31.36 megapixels of synthetic raster data. It must traverse the reader's
normal lazy/windowed lifecycle and collect decoded image dimensions over
time, rather than require all images to be mounted together. Sampled memory
peaks and layout shifts are observations, not continuous allocation or
input-to-display traces. The fixture never resizes or replaces user assets.

No decode cap, lossy preview, image rejection or automatic asset deletion is
justified by fixture construction alone. Native capability transport and the
legacy loader must retain equivalent image content.

The packaged candidate completed three fresh launches and six warm revisits
of the 31.36 MP fixture. Every traversal verified all four original 2800×2800
images. Median first equation was 117 ms; all four images were observed decoded
after 373 ms cold and 290 ms warm. Median sampled cold peak process-tree PSS
was 568 MiB, settling to 526 MiB after collection; final post-theme median was
525 MiB. Collected JS heap was 9.39 MB cold and 9.58 MB after revisits/themes.
Two warm cycles do not establish long-session leak freedom. These measurements
use the offscreen software renderer, not interactive presented-frame timings.

The cold layout-shift observation (0.428) includes replacing the startup note
with the fixture and must not be attributed solely to image decoding. Warm
traversals observed zero layout shift. No preview/decode policy change is
accepted from this observation alone.

The harness explicitly disables saved-position restoration for generated
documents, marks its navigation intent, and resets the viewport after commit.
Otherwise an offscreen virtualized heading can invalidate the readiness probe.
The earlier baseline/candidate table predates this harness correction; final
comparisons must rerun both binaries with the same corrected harness.

## TypeScript compiler canary

An isolated comparison used the repository project and its TypeScript build
configuration, with the lockfile's TypeScript 5.9.3 as baseline, official
TypeScript 7.0.2, and the pinned experimental `tsc-ts` 0.0.5 port. Measurements
were made on Node 20.10.0, three cold repetitions and three repeated
repetitions per compiler. The reported time and process-tree proportional set
size (PSS) are medians; PSS includes the compiler process and its descendants.

| Compiler | Cold median | Cold aggregate PSS | Repeated median | Repeated aggregate PSS |
|---|---:|---:|---:|---:|
| TypeScript 5.9.3 | 4,639 ms | 532 MiB | 4,498 ms | 528 MiB |
| TypeScript 7.0.2 | 690 ms | 484 MiB | 672 ms | 465 MiB |
| `tsc-ts` 0.0.5 | 491 ms | 413 MiB | 431 ms | 400 MiB |

The repeated runs are not incremental warm-build measurements: `tsc -b` with
`noEmit` leaves no `src/App.js`, so the project is checked again. A negative
fixture produced the same TS2322 and TS2307 diagnostics across all three
compilers, though process exit codes differ. After adding Vite's standard
`/// <reference types="vite/client" />` declaration, the unmodified project
build configuration passed under both newer compilers. This is a local sample,
not evidence of 2–4x speedup on every runner or a compatibility guarantee.

Keep TypeScript 5.9 as the authoritative check and local Node 20 build path for
now. CI runs the pinned experimental compiler as a non-gating canary on all
four desktop OS/architecture runners under Node 24, matching the declared
engine requirement of its `@scriptc/threads` dependency. Promotion requires
successful platform coverage and compatibility review; do not infer support
from the Linux benchmark alone.

## Same-run native frontend artifact reuse

CI and release workflows build the native reader bundle once per workflow run
and bind the uploaded dist inventory to the producer's actual checked-out commit
SHA and `package-lock.json` digest. Desktop and Android consumers start their
platform-specific setup in parallel with the producer, then use a bounded
waiter to find the exact-SHA artifact pair in that same workflow run. Consumers
verify the complete file inventory and hashes before packaging. The waiter
fails closed on a failed or missing producer, incomplete API listings, wrong
repository/run, absent artifacts or timeout; it never falls back to an older
run or locally generated unverified bundle. This avoids serializing Python,
Rust and Android setup behind the frontend build while retaining exact-source
provenance. Release `publish_only` recovery continues to verify Android rather
than reusing its APKs.

The lockfile digest is over raw bytes; `.gitattributes` pins its checkout to
LF so Windows `core.autocrlf` cannot cause a false cross-platform manifest
mismatch. Lockfile content changes still change the digest, and every built
frontend file remains checked by its exact byte count and SHA-256.

## Android APK reuse and release recovery assessment

Read-only workflow and Actions history review found a plausible but unproven
opportunity to build the debug app/test APK pair once and reuse it across the
API 35 and 36 emulator jobs. In successful CI run `39435946194` (commit
`6494f0f38af108b8ac5202333769cde7d754bba3`), the API 35 job took 10m14s and
API 36 took 12m15s. Their emulator-runner steps took 8m38s and 10m36s,
respectively; setup through the start of that step took about 1m30s. This
shows where the wall time sits, but the runner step combines emulator startup,
Gradle `connectedDebugAndroidTest` assembly/install, and instrumentation. It
does not reveal how much time is APK compilation versus emulator/tests. Both
API jobs already run concurrently, so a producer barrier could shift work onto
the critical path. Do not introduce APK promotion/reuse until step-level data
isolates assembly cost and a same-source APK-pair prototype proves install,
signing-pair integrity and all actual-pixel assertions on both APIs. All
existing emulator suites remain required.

The release workflow's `publish_only` route is a different, already-gated
recovery optimization: it requires a successful prior release build on the
exact tag commit and reuses only its verified desktop installer outputs. It
still rebuilds or retrieves and re-verifies the signed Android APK. In the
successful release run `39432369823`, regular build jobs took about 15m10s for
Ubuntu desktop and 12m31s for Android; these are observed job durations, not a
measured `publish_only` saving. Preserve the current source/run checks and
Android reverification; do not broaden reuse based on these timings alone.

## Rust release-profile experiment gate

The current `smd-core` release profile uses `opt-level = "s"`,
`codegen-units = 8`, with debug info disabled and stripping enabled. Recent
successful CI logs show cached host release engine build steps of only a few
seconds, but those runs cannot estimate a clean compile or compare profiles.
Changing optimization level or codegen units could affect engine size,
compile time and runtime behavior (including PDF rendering); no benefit is
established by the present evidence. Keep the profile unchanged. If measured,
compare isolated clean target directories for the current profile and a
separately selected alternative, recording compile wall time, binary size,
runtime/PDF correctness, and Android integration tests. Do not run a profile
experiment against or rewrite a developer's dirty Rust source tree.
