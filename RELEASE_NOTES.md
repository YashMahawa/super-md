# Super MD 0.6.0

## Portable custom themes

- Import an editable theme JSON file on desktop and Android. One format controls native semantic colors and the reading pane, with independent light, dark and pure-black variants.
- Customize headings, links, code blocks, callout families, component/content corners, paragraph spacing, heading weight/tracking, text tracking and table borders. Reading fonts, sizes, width and zoom stay user-controlled.
- Add subtle dot, grid, diagonal or gradient backgrounds without images, scripts, network requests or animated overlays.
- Export an editable template or the active theme. The authoring guide documents every field, role, limit and platform behavior, including an AI-ready authoring request. Three example themes are bundled.
- Desktop follows source-file edits using filesystem notifications, including atomic saves. Android observes document providers where supported, with manual Reload and resume-time retry otherwise. Invalid/partial edits preserve the last valid theme; Reset to built-in never deletes the original file or notes.
- Desktop and Android share the same bounded native validator. Unknown fields, unsafe color expressions, unsupported versions and oversized files are rejected. Contrast safeguards protect native text and controls.

## Reliability and verification

- Theme palette changes keep the existing large-note rendering/cache path instead of reparsing Markdown/math. Typography updates use reading-anchor restoration. Removing optional reader preferences is now recognized correctly, including theme reset.
- Automatic desktop update checks no longer replace a useful note status with a raw offline network error or cancel a pending close operation. Explicit checks still report a friendly offline status.
- Graph panning no longer drops queued movement when a resize or appearance update renders before the next animation frame. A deterministic regression test covers this input/render race.
- Packaged-app launch checks now import a theme through the real native validator and verify the reader's pattern/typography alongside the existing presented-pixel, Markdown, math, chart, portable-note and PDF assertions.
- Android instrumentation verifies shared validation, native contrast, actual imported-accent pixels and reader styling, invalid-edit preservation and reset. Existing gesture, selection, hyperlink, export and painting assertions remain enabled.
- CI now covers Intel macOS before tagging as well as Apple Silicon, Linux and Windows. Debug/instrumentation sources receive their own lint check; desktop CI and release builds share architecture-isolated dependency caches without skipping tests or packaged launch checks.

Themes are viewing preferences, not embedded in portable notes. PDF layout remains controlled by Export/Share; custom background patterns and reading metrics do not alter PDF output. Native Android component shapes follow Material's platform behavior rather than replacing every control with desktop geometry.

This is deliberately separate from the published [0.5.2 reliability release](https://github.com/YashMahawa/super-md/releases/tag/v0.5.2), which remains available for rollback. All its document-safety, reading-position, recents, provider-notification and graphics-packaging improvements are retained. On Android, use Reset to built-in before considering a version downgrade; normal installers prevent downgrades and uninstalling may remove private recovery data.

macOS packages remain ad-hoc signed rather than notarized. Windows installers are not code-signed.
