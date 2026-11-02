# Super MD 0.6.22

## Diagram cards that don't clip or overlap

- Step-card figures now measure their loaded image's intrinsic aspect ratio and the available reader width, reserving the correct height with a maximum height. This removes both diagram clipping and large empty bands on narrow/desktop screens.
- Descriptions and navigation controls participate in normal document flow below the image rather than overlapping an absolutely positioned illustration.
- Loaded images remain mounted between slides, with subtle transitions and no unnecessary reload on Back/Next.
- Step cards can now contain full interactive smd-chart 2D plots, including parameter sliders, zoom, pan, roots and graph probes. Charts retain their individual slider state when visiting other slides.
- SVG node/edge diagrams and fixed-slot binary trees are still supported alongside images and 2D graphs, with safe declarative input validation and accessibility labels.
- Browser-tested desktop and phone layouts and navigation; regression tests cover mixed deck types.

## Cross-platform

- Fixed Windows-only storage cleanup regression found by the 0.6.21 CI: protected cleanup now rejects Windows symlinks and junctions while allowing the carefully scoped app-owned temporary directories to be cleaned.
- No changes to MCP transport; other pending agent changes are not included.
