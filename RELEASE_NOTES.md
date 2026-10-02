# Super MD 0.4.1

## Reading and editing polish

- Richer accent-tinted light surfaces and separated tonal toolbar/mode bars on
  desktop and Android. Dark/pure-black and reduced-motion settings are preserved.
- Default 80% document width, adjustable in percentages rather than fixed pixels,
  plus independent vertical spacing. Document zoom changes text and reading
  width and preserves the focal word instead of jumping to another paragraph.
- Live blocks now require a double-click to edit. Click outside or press Esc to
  finish. Read/Live search highlights all matches, supports Next/Previous and
  exposes a clear Close action without switching to Source mode.
- Copy rendered text with the original math delimiters; ordinary code and Python
  blocks have separate Copy buttons. Undo/redo works in reading and source flows.
- Compact, bounded Fix LaTeX review cards replace oversized checkboxes. Broken
  diagrams are isolated to their own block; Mermaid SVG output is sanitized.

## Images, plots, fonts and files

- Image viewer controls no longer overlap the native fullscreen exit. Its
  Material slider stays at the bottom; pointer/two-finger zoom follows the focal
  point and images pan independently from text.
- Charts zoom at the pointer/touch focal point, resample expressions over the
  visible domain and offer grid/coordinate inspection. Removed redundant plot
  zoom/reset/rotation controls and hover bouncing. Three-dimensional surfaces
  use colored meshes with gesture/keyboard camera control and bounded sampling.
- Import TTF/OTF fonts on desktop and Android. Private imported fonts and the
  expanded bundled font selection are available to reading and native PDF export.
- Eleven paper sizes, with correctly cased labels, plus font, margins, spacing
  and page-number controls in both Export and Share.
- Default autosave for existing notes, external-edit protection and serialized
  writes across windows. Empty unnamed notes are discarded; rename is accessible
  from the tab actions. Portable SMD keeps assets outside the source editor.
- Tab tear-off now carries a rendered window preview. Closing the last moved
  tab removes the empty original desktop window; drag reordering remains native.

This update adds real CLI process tests, bridge timeout/error tests, Qt drag
preview painting checks and Android native PDF/font instrumentation. Physical
phone testing was not performed. The previous release remains available for
rollback.

## Included application capabilities

Normal desktop window management is restored; study fullscreen now remembers
whether the window was maximized instead of resetting its size on exit.

## Native desktop controls

The desktop window now uses Qt Quick / QML instead of a Tauri host: native tabs,
file navigation, dialogs, Material-themed controls, settings, sliders and
expressive press/shape motion. System, light, dark and pure-black color roles
are contrast checked. Motion can be disabled. The document/editor pane still
uses Qt WebEngine with the shared Markdown renderer; this is not a claim that
the entire renderer is browser-free.

- Clear Open note / Open folder actions, hideable sidebar and Close folder.
- System-native folder selection and file-manager folder opening without changing
  the system's default file manager. Properly sized Google Material fullscreen
  SVG buttons with hover tooltips, F11 and Esc.
- Soft tinted light surfaces, a fallback app accent, and PDF controls available
  directly in both Export and Share, including line spacing and page numbers.
- Safe save-before-close handling with a final editor snapshot, ordered recovery
  writes and a single application process coordinating multiple native windows.
- Independent normal/fullscreen document zoom, slider and editable percentage.
- Compact desktop settings dialog, system font choices and aligned, scrollable
  dropdowns that stay within the settings viewport.
- Larger weight-600 Material SVG toolbar icons and rounded scrollbars with a
  dedicated gutter, so settings controls never sit underneath the thumb. Scroll
  indicators hide while idle and reveal during scrolling or gutter hover.
- Native tab drag-to-reorder, movement between windows and detach-to-new-window,
  with safe draft/asset ownership and bounded Source undo/caret transfer.
- Stronger accent-tinted light paper, without replacing dark/pure-black themes.
- Click images for independent zoom/pan, without changing document text zoom.
- Remote image and video-thumbnail previews use the native consent-gated loader.
- Source mode has a theme-paired editing surface, clearer caret/gutter,
  collapsible code regions, caret position and persistent line-wrap controls.
- Pinch/trackpad zoom over 2D/3D plots affects the plot alone; ordinary swipes
  still scroll the note. PDF snapshots keep the selected plot zoom.

## Notes and interactive learning

`.md` is plain Markdown. Portable `.smd` stores text and images together while
keeping asset payloads out of the Source editor. Older text `.smd` and portable
`.fmd` files remain readable. New exports use `.smd`.

- Collapsible answers/callouts and long code blocks; double-click a Live block to edit.
- Reviewable, conservative Fix LaTeX suggestions instead of rewriting notes silently.
- Internal heading links, local/SVG images, Mermaid and explicit Matplotlib cells.
- Bounded two-dimensional plots and multi-color three-dimensional mesh
  surfaces with parameter sliders, gesture camera controls and finite-value checks.
- AI-ready authoring guide and binary-safe CLI read/inspect/assets/extract/pack commands.

## PDF and Android

The embedded Rust/Typst/MiTeX engine typesets PDF offline on desktop and Android;
it does not print the DOM. Export includes math, images, Mermaid, static graph
snapshots and figures from Python cells you explicitly ran. Tables and long
code paginate; wide equations fit; page numbers can be disabled.

Android uses the same weight-600 Material symbol paths and tinted surface
hierarchy as desktop, with grouped settings and shared PDF configuration in
Settings, Export and Share. Hold and drag tabs to reorder; TalkBack has move
actions too. New window creates an independent Android task and recovery file,
with split/desktop placement controlled by the device. Tablet/foldable layouts
adapt to the current window; phone landscape retains single-pane modes.
Android's system share sheet supports PDF, Markdown and portable SMD using
restricted read-only content URIs. Markdown sharing is text-only; SMD carries
images. Cross-window Android tab dragging is intentionally omitted. The APK is an
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
