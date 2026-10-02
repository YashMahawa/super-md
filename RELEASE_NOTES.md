# Super MD 0.4.0

## Native desktop controls

The desktop window now uses Qt Quick / QML instead of a Tauri host: native tabs,
file navigation, dialogs, Material-themed controls, settings, sliders and
expressive press/shape motion. System, light, dark and pure-black color roles
are contrast checked. Motion can be disabled. The document/editor pane still
uses Qt WebEngine with the shared Markdown renderer; this is not a claim that
the entire renderer is browser-free.

- Clear Open note / Open folder actions, hideable sidebar and Close folder.
- Safe save-before-close handling with a final editor snapshot, ordered recovery
  writes and a single application process coordinating multiple native windows.
- Independent normal/fullscreen document zoom, slider and editable percentage.
- Compact desktop settings dialog, system font choices and aligned, scrollable
  dropdowns that stay within the settings viewport.
- Click images for independent zoom/pan, without changing document text zoom.
- Remote image and video-thumbnail previews use the native consent-gated loader.
- Source mode has a theme-paired editing surface, clearer caret/gutter,
  collapsible code regions, caret position and persistent line-wrap controls.

## Notes and interactive learning

`.md` is plain Markdown. Portable `.smd` stores text and images together while
keeping asset payloads out of the Source editor. Older text `.smd` and portable
`.fmd` files remain readable. New exports use `.smd`.

- Collapsible answers/callouts and long code blocks; click a Live block to edit.
- Reviewable, conservative Fix LaTeX suggestions instead of rewriting notes silently.
- Internal heading links, local/SVG images, Mermaid and explicit Matplotlib cells.
- Bounded two-dimensional plots and multi-color three-dimensional wireframe
  surfaces with parameter sliders, camera controls and finite-value checks.
- AI-ready authoring guide and binary-safe CLI read/inspect/assets/extract/pack commands.

## PDF and Android

The embedded Rust/Typst/MiTeX engine typesets PDF offline on desktop and Android;
it does not print the DOM. Export includes math, images, Mermaid, static graph
snapshots and figures from Python cells you explicitly ran. Tables and long
code paginate; wide equations fit; page numbers can be disabled.

Android retains its native Kotlin/Compose Material 3 Expressive UI, with clearer
file actions, dedicated settings, more reading fonts, portable-format
compatibility and the shared image/graph/repair improvements. The APK is an
optimized, non-debuggable arm64 release and preserves the existing upgrade
certificate. No on-device phone testing was performed for this update.

## Downloads and limitations

Linux AppImage/DEB/RPM, Windows x64 installer, macOS Apple Silicon/Intel DMGs and
the signed Android release APK are included with SHA256 checksums. Desktop
packages are not commercially code-signed/notarized; security prompts may appear.
Linux installers are built on Ubuntu 22.04 for modern compatible distributions.

PDFs are static snapshots. Python is trusted local code, never auto-executed or
sandboxed. Desktop Share currently prepares an exported copy, rather than
opening a universal OS share sheet. Headless CLI export does not execute Python
or render Mermaid; use the app to prepare those outputs. Full TeX packages and
arbitrary interactive 3D scenes are not supported.
