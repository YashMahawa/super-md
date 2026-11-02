# Super MD 0.6.21

## Smooth interactive notes and diagram layout

- Step cards keep loaded SVGs mounted and preload nearby frames; Previous, Next and slider changes no longer reconstruct previously loaded images.
- New safe smd-diagram blocks draw responsive SVG nodes, edges and highlighted states inline. Step cards can reuse SVG node IDs to animate changes without regenerating image assets.
- New smd-tree blocks reserve genuine left and right child slots from heap-array indexing, eliminating straight-down single-child ambiguity.
- Existing Markdown, Mermaid, embedded SVGs and portable SMD images remain supported.

## Updates and storage

- Separate Updates and Storage settings sections.
- Updates has an Open latest release on GitHub shortcut.
- Confirmed cleanup of app-generated Python preview results and obsolete update state, with notes, recovery snapshots, exports, fonts, managed Python and settings protected.
- Adds UI and storage regression tests.

## Release compatibility

Shared diagram/step-card rendering works in desktop and Android readers. MCP transport is not changed by this release.
