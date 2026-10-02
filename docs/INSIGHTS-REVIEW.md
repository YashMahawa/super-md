# Jules solution review — 2026-09-30

Read 68 insight titles from the Super MD Jules workspace and fetched the expanded proposed solutions for relevant assessments, not just their summaries. The CLI was used because the connector's workspace listing failed.

| Assessment | Decision implemented |
|---|---|
| `d60af4f8-7b82-55e3-b16b-468857b14a02` | Lazy arbitrary-folder tree, not a vault or recursive preload. |
| `fa2c4862-2bf6-5096-8477-1422ea199dfa` | Share the SVG renderer between viewing and export. Reject the speculative replacement JS parser/typesetter. |
| `bacb094f-c1f3-5a95-b28a-a4f8fdd1c534` | Android ViewModel + lifecycle state; I/O off the UI thread. |
| `74042ec4-4460-571d-baaf-d75530a56519` | CodeMirror compartments and per-tab editor state preserve history/cursors through appearance changes and tab switching. |
| `1979236f-ba65-5b3f-b15a-79254635709f` | Stage Android assets privately before native PDF compilation, then write through SAF. |
| `c6ba3947-45be-5d9e-a4e4-54ac8335de17` | Bundle PDF fonts instead of silently substituting unavailable desktop fonts. |
| `5e327f1a-79f0-55a1-9d18-1e2d99b1e528` | Serialized Mermaid rendering and deterministic temporary-container cleanup. |
| `73a0aea6-d127-57ca-9732-1b3cbea8e509` | Floating-point pinch zoom; independent fullscreen zoom. |
| `d8de50fa-a397-5415-b767-641b576ceff4` | Derive a valid positive slider step when absent. |
| `b2d1f7de-a8b7-5f87-baf6-13020adef6ca` | Surface detailed export failures and prevent silently dropped figures. |
| `331a8087-c5cd-5fac-91af-1183a95710f3` + `9317dc68-a76f-56fc-aa02-eb117b8b6164` | Combine browser workflow tests with real CLI/core PDF tests and Android bridge/engine instrumentation. Do not confuse mocked browser IPC with native verification, or reinstall obsolete external typesetters. |
| `7a52172c-bdec-5366-a083-54e6e8929531` | Non-blocking V8 coverage reports uploaded by CI. Reject arbitrary coverage thresholds until a meaningful baseline is established. |

Also bounded expression size/token count to prevent recursion abuse. Rejected unrelated wellness, mood and engagement features; they would distract from study and enlarge the application. A native handwritten Markdown parser was rejected because the previous attempt lost equations and interactive features. The implementation instead uses native Android controls and the tested shared renderer, plus a shared native typesetter.

This review is not proof of on-phone performance. Host and emulator results are recorded separately; physical-phone testing remains user-controlled.

## Refresh — 2026-10-03

Refreshed the workspace's insight list and all 187 available assessment titles through Jules CLI v0.6.2. Read the expanded solution specs for the following relevant proposals before choosing changes:

| Assessment | Decision |
|---|---|
| `3172e75a-67a7-56ed-ad8c-b6e88238e5e3` | Added real binary integration tests for read, inspect, assets, extract, pack, export, export-json, doctor and errors. Agent output remains binary-free by default. |
| `153c173d-a804-52d4-832a-b45f614353ff` | Added bridge lifecycle tests and immediate timer cleanup when transport posting throws. |
| `19887a7b-1d7d-57b5-9761-063f84cd9160` | Isolated custom code-block render failures; source changes remount the boundary. Tested Mermaid queue recovery and container cleanup. |
| `db993afe-e0d0-5588-9006-53568d7393e8` | Added maintained DOMPurify SVG sanitization after strict Mermaid rendering, shared with PDF preparation. |
| `f5a97a28-741c-5c11-9a80-db618b440b9f` | Did not replace Mermaid SVGs with images: that would lose selectable text and existing export/navigation behavior. Used the preceding sanitizer instead. |
| `fc28483f-07ee-5a72-b98d-c164ab5af20d` | Moved the remaining manual-save SAF display-name query off Android's UI thread. |
| `539226d8-cd91-5b79-8cca-054b734745b4` | Default autosave with serialized captured-content writes and external-edit protection. Empty unnamed notes are discarded. |
| `0916b1af-bbf5-5497-8394-3d4a91410c3b` | Kept the actual shared-session architecture rather than introducing speculative per-process watchers. Writes are serialized across windows; autosave detects changed source. |
| `ccecdb2f-227d-5b63-94fa-4d0e58406877` | Retained bounded expression evaluation and finite projection coordinates; surface sampling is capped and cached, not rerun for every hover. |
| `5385171f-bc01-5f99-aa6c-236eb964f0d1` | Applied tonal chrome/document separation and warmer, richer light surfaces without adding unrelated mood/engagement features. |

These proposals supplement the native painting, PDF and full workflow checks; they do not establish physical-device smoothness by themselves.
