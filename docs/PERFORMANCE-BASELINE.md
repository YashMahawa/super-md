# Installed-reader baseline

Measured on the published 0.6.4 Linux installation, 20 October 2026, using
`scripts/benchmark-installed-reader.mjs`. Three fresh processes per synthetic
fixture, two warm revisits and theme cycles each. The environment used Qt's
offscreen software path on an eight-logical-core system with 16 GB RAM.

| Fixture | First equation, median ms | Two-frame layout readiness, median ms | JS heap MB | Process-tree PSS MiB | DOM elements |
|---|---:|---:|---:|---:|---:|
| Small | 22.3 | 40.0 | 7.60 | 399.3 | 155 |
| Math-heavy | 406.6 | 484.1 | 14.31 | 457.7 | 12,512 |
| 1 MB Markdown | 802.6 | 835.2 | 17.11 | 444.9 | 2,565 |
| Many blocks | 349.3 | 392.1 | 13.24 | 426.0 | 2,685 |
| Huge single block | 143.3 | 198.8 | 8.32 | 425.2 | 87 |

These are document-load timings after the application is ready, not end-to-end
launch timings. Two requestAnimationFrame callbacks establish renderer scheduling
and layout readiness, **not** native presented pixels or input-to-display latency.
Idle frame intervals and synchronous zoom-call durations cannot establish smooth
scrolling or zooming; interactive frame measurements and visual checks are separate
release gates. PSS includes native processes; JS heap alone does not describe total
memory use. OS file caches were not flushed. No personal notes were used.

The raw local report contains machine-specific paths and is intentionally not
checked in. Candidate comparisons must use the same harness, fixtures, graphics
mode and repetition count.

## Packaged candidate comparison

A local candidate bundle was measured with the same five fixtures, three fresh
processes per fixture, and two warm/theme cycles. This is an intermediate test
bundle, not a published release or a final installer qualification.

| Fixture | Baseline → candidate first equation, median ms | Baseline → candidate cold JS heap MB | Baseline → candidate cold PSS MiB |
|---|---:|---:|---:|
| Small | 22.3 → 19.2 | 7.60 → 6.93 | 399.3 → 398.0 |
| Math-heavy | 406.6 → 386.6 | 14.31 → 13.77 | 457.7 → 456.9 |
| 1 MB Markdown | 802.6 → 693.1 | 17.11 → 18.77 | 444.9 → 444.8 |
| Many blocks | 349.3 → 346.4 | 13.24 → 14.49 | 426.0 → 425.8 |
| Huge single block | 143.3 → 116.6 | 8.32 → 7.72 | 425.2 → 422.6 |

This sample shows faster cold document readiness, not a universal responsiveness
or memory reduction. Sharing the analysis AST retains additional JS data for
the 1 MB/many-block fixtures while avoiding repeated parsing; total cold process
PSS is nearly unchanged. After warm/theme cycles, the 1 MB candidate's median
PSS is about 2.8 MiB above baseline. Theme-cycle scheduling measurements are
mixed (including slower math/1 MB observations), so repeat and native visual
checks remain required before declaring the final performance gate passed.

## Corrected-harness recheck

After making generated-note navigation explicit, both binaries were rerun with
the same corrected harness (three fresh processes and two revisit/theme cycles
per fixture). These newer observations do **not** establish a passed final gate:

| Fixture | Baseline → candidate first equation, median ms | Baseline → candidate cold process-tree PSS MiB | Baseline → candidate theme readiness, median ms |
|---|---:|---:|---:|
| Small | 40.2 → 37.1 | 391.4 → 407.1 | 33.2 → 33.2 |
| Math-heavy | 440.7 → 435.8 | 451.7 → 464.7 | 70.5 → 70.0 |
| 1 MB Markdown | 786.0 → 874.6 | 434.9 → 452.9 | 78.1 → 66.4 |
| Many blocks | 391.5 → 359.3 | 414.3 → 433.1 | 44.0 → 36.3 |
| Huge single block | 139.2 → 118.2 | 414.1 → 431.3 | 33.4 → 33.1 |

The local candidate bundle is approximately 39 MiB larger than the installed
baseline. Package/runtime inventory and a counterbalanced timing repeat are
required to distinguish dependency/build-environment drift, measurement variance
and implementation costs. In particular the 1 MB cold slowdown and consistent
native-memory increase must not be hidden behind the earlier faster sample.
No runtime-memory or universal performance improvement is claimed from these
results, and they do not qualify a release.

### Follow-up isolation

Reversing the packaged test order produced 693 ms for the candidate's 1 MB
load versus 767 ms for the baseline (three launches each), so the earlier
single slower batch was not reproducible. The package-memory gap persisted.
An allowlisted `/proc` mapping check found that ICU/libxml2 explained less
than 1 MiB of that gap, despite their substantial on-disk sizes; library file
size alone is not a resident-memory explanation.

For a controlled implementation comparison, both source versions were then
run with the **same Python/Qt environment**, each with its matching reader
assets and three fresh processes. This is not an installed-package test:

| Fixture | Baseline → candidate first equation, median ms | Baseline → candidate cold PSS MiB | Baseline → candidate post-revisit/theme PSS MiB |
|---|---:|---:|---:|
| Small | 31.1 → 39.4 | 415.2 → 415.3 | 415.6 → 415.3 |
| 1 MB Markdown | 768.7 → 691.1 | 460.2 → 461.7 | 466.0 → 469.4 |

The large constant package-memory gap is absent in this controlled source
comparison. The 1 MB candidate retains more analysis data (JS heap 17.10 →
18.78 MB) while avoiding repeated work. This bounded speed/memory tradeoff
is recorded explicitly; final comparable release-package and interactive
checks are still required.

### Oversized single-block follow-up

After exact-source analysis sharing, a generated 4,000,008-byte note (one huge
paragraph plus its heading) was compared against 0.6.4 using the same Python/Qt
runtime and matching frontend assets. Each version had three fresh processes
and six total same-source revisits, with two theme cycles per process.

| Metric | 0.6.4 source | Candidate source |
|---|---:|---:|
| Cold first equation, median | 1,729.5 ms | 1,513.0 ms |
| Two-frame layout readiness, median | 2,453.3 ms | 2,245.8 ms |
| Same-source revisit, median | 265.8 ms | 24.0 ms |
| Collected cold JS heap | 19.54 MB | 18.94 MB |
| Cold process-tree PSS | 702.1 MiB | 704.0 MiB |
| Post-revisit/theme PSS | 721.8 MiB | 724.2 MiB |
| Theme readiness, median | 150.2 ms | 165.8 ms |

This sample supports improved large-source reuse, not universal memory or theme
speed improvements. Candidate cold timings varied (first-equation p95 1,760.7
ms versus baseline 1,743.5 ms); process memory was slightly higher and theme
readiness slower in this batch. The framework scheduling and software-renderer
limitations above still apply. No native 60 Hz smoothness claim follows from
these numbers, and final release-package validation remains required.
The harness deliberately sends the complete synthetic source on each theme
cycle for baseline compatibility, so its theme timing also includes that CDP
payload transfer; it does not isolate the optimized native preference-update
path, which can omit unchanged content.

### Native diagram follow-up

The same-runtime 0.6.4/candidate comparison also exercised 12 unique flowcharts:
six plain Pele-eligible diagrams and six authored-init Mermaid fallbacks. All
12 SVG images had to decode successfully; rendering errors fail the sample.
Three fresh processes and six same-source revisits passed for each version.

| Metric | 0.6.4 source | Candidate source |
|---|---:|---:|
| All diagrams ready, cold median | 954.6 ms | 913.3 ms |
| All diagrams ready, revisit median | 47.6 ms | 47.1 ms |
| Collected cold JS heap | 11.98 MB | 11.34 MB |
| Cold process-tree PSS | 417.4 MiB | 420.9 MiB |
| Post-revisit/theme process-tree PSS | 418.4 MiB | 421.6 MiB |

This small software-rendered sample demonstrates compatibility of both paths,
not a universal diagram speedup or total-memory reduction. The scheduling,
runtime and presented-frame limitations above still apply.
