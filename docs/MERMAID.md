# Mermaid rendering

Super MD uses [Pele](https://github.com/obsidianmd/pele) 1.7.0 as a lazy-loaded fast path, with Mermaid.js retained for compatibility. Both run entirely offline.

## Routing and fidelity

Plain flowcharts, sequence/state/class/entity diagrams, pie charts and mind maps are eligible for Pele. Authored initialization directives/frontmatter, math or arbitrary HTML labels, interactions, image/icon syntax, advanced shapes and other diagram families stay with Mermaid.js. A Pele error also falls back to Mermaid.js. Syntax is never rewritten or saved back to the note.

The original node direction is retained. Zooming never switches the diagram's direction or reflows its nodes. Colour changes reuse bounded cached vector layouts. The shared Diagram appearance setting covers both renderers; ordinary images remain separate.

Pele's layouts differ from Mermaid.js, and its documentation explicitly notes that Mermaid theme configuration does not apply. This is why configured notes are not silently switched. Its upstream issue tracker also reports differences in math and rich-label handling. See the [compatibility reference](https://pele.run/compatibility).

## Security and printing

All generated SVG passes through the existing sanitizer and is displayed as an inert image, never executable inline HTML. Pele cannot fetch diagram images or execute click callbacks. The app controls renderer options and retains source/output/edge bounds.

Pele normally uses CSS variables. Super MD resolves those variables inside SVG attributes, preserving literal label text, and removes custom-property declarations. This makes the vector self-contained for the native PDF engine and image viewer, without mounting it in the app DOM. Unresolved or cyclic variables trigger compatibility fallback rather than a broken export.

The pinned Pele package's complete MIT and included Lucide ISC notices ship as `DIAGRAM-RENDERER-LICENSES.txt` in the offline reader resources.

## Performance check

A local headless Chromium comparison on 20 October 2026 used nine uncached renders per example, warmed libraries, the same browser, Arial labels, and sanitization/XML serialization on both outputs. Median results from that candidate evaluation:

| Example | Pele pipeline | Mermaid pipeline | Ratio |
|---|---:|---:|---:|
| Plain flowchart | 1.2 ms | 22.1 ms | 18.4× |
| 200-node flowchart | 23.9 ms | 698.6 ms | 29.2× |
| Sequence | 1.1 ms | 13.5 ms | 12.3× |
| Entity table | 1.2 ms | 17.1 ms | 14.3× |
| Pie | 0.9 ms | 7.1 ms | 7.9× |

The private SNS study note was evaluated locally without changing it; its two diagrams rendered around 17–18× faster in that comparison. Their authored configuration still selects the compatibility renderer in the app. These timings exclude initial imports, painting, app work, and the additional variable-resolution pass in the final integration. They are not a universal end-to-end speed claim, and the note is not included in the repository.

Regression tests cover routing, fallback, sanitization, variable resolution, colours/local label contrast, layout-cache eviction, viewer zoom, PDF preparation, actual packaged Qt rendering and Android WebView integration. The original Mermaid path remains covered too.
