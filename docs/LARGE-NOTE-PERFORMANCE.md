# Large-note memory and zoom

The shared desktop/Android reader switches to windowed rendering above 80,000
source characters. It retains a lightweight full-document syntax/text index for
references, headings and search, while mounting expensive rendered blocks near
the visible viewport (900 CSS pixels of overscan). Offscreen measured placeholders
retain scroll geometry. Selected or focused blocks are not discarded mid-action.

KaTeX/highlighting expansion, image components and chart meshes leave the mounted
tree with their blocks. Syntax-tree cache size is bounded at 24 MB; optional
Python redisplay cache at 16 MB. Executed Python outputs are preserved in private
native disk storage, so an offscreen cell or PDF can reload figures after RAM
eviction without rerunning code. If storage fails, its output block stays mounted
instead of silently losing its figures. Camera/slider metadata is separately
bounded by volume rather than a 60-graph count. Images remain outside portable SMD's source editor.
Full-note PDF preparation uses the entire source independently of windowing;
server-rendered content is never truncated to the viewport.
Preparation limits native/image concurrency to four jobs and yields between
heavy diagram jobs, instead of queuing all decodes or monopolizing input.

Focal zoom caches geometry instead of measuring the entire document after every
transform. Layout/font/viewport changes invalidate that cache. Input is coalesced
to presentation frames, and native percentage updates are debounced. A pending
gesture owns its focal point even when a resize notification is queued.

Cross-mode undo uses changed ranges. In a four-million-character typing test,
100 appended characters retain less than 4 KB of undo data, rather than retaining
100 document strings. Source also retains CodeMirror's persistent history for
legacy view transfers; controlled undo updates do not create duplicate undo events. Android
workspace JSON is streamed; clean saved text shares the content string, and large
snapshots are no longer silently ignored. Desktop recovery serialization runs in
the ordered save worker and streams JSON to an atomic temporary file.

## Reproducible local comparison — 2026-10-03

Start `npm run dev`, then run `node scripts/benchmark-large-note.mjs`. The script
creates isolated headless Chromium contexts and a 238,780-byte generated note
with 1,000 headings and 2,000 formulas. It compares the same current renderer with
windowing disabled/enabled; it does not read personal notes or installed state.

| Measurement | Whole rendered tree | Windowed tree |
|---|---:|---:|
| DOM nodes after GC | 217,003 | 5,090 |
| JavaScript heap after GC | 192,611,796 bytes | 61,421,072 bytes |
| Mounted formulas at sampling | 2,000 | 7 |
| Load to first equation/font readiness | 3,555 ms | 972 ms |
| Zoom function call p95, 60 steps | 3.4 ms | 0.4 ms |

These are one local synthetic-browser run, not total native process RAM, GPU
memory, frame-presentation latency, a physical Vivo benchmark or battery evidence.
Overscan content continues to mount after the first visible equation. Results vary
with viewport, hardware and note structure.

## Verification and remaining boundaries

- Browser regressions check bounded mounted math/DOM, whole-note references,
  offscreen search, heading jumps, Live editing and focal magnification.
- Unit checks require full large-note server output even when a browser-like
  IntersectionObserver exists, source-preserving copy across hidden blocks,
  reversible compact undo and no per-frame full-document measurements.
- Native Android instrumentation covers offscreen math/search/headings and streamed
  recovery round trips alongside the existing actual painting/PDF/Matplotlib tests.

Raw source and a lightweight parsed index still scale with text size: total app
memory is not constant. An exceptionally large *single* table, list or code block
still needs its complete block while visible. Full PDF typesetting necessarily
processes the full document. This change does not claim streamed/infinite-size
editing or unrestricted document sizes; normal format safety limits still apply.
Physical phone performance and cross-app image decode behavior remain user-device
checks. No image downsampling or note-content deletion is used to save memory.
