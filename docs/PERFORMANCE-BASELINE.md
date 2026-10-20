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
mode and repetition count. No improvement is claimed until that comparison runs.
