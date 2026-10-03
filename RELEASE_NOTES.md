# Super MD 0.4.11

- Desktop tabs and their icon-only “+” share a vertical centre. The top New note
  button and logo are removed; Open folder has a direct icon and the sidebar
  button morphs when toggled, respecting disabled motion.
- Linux captionless desktops get visible, themed minimize/maximize/close controls
  in the existing toolbar. macOS/Windows retain real native caption buttons, with
  a tinted expanded caption and a reserved safe area; no frameless-window hack.
- Zoom is 40–300%. Native snapshots no longer overwrite newer reader gestures;
  Android gesture acknowledgements are not echoed as fresh zoom commands. Desktop
  Ctrl-wheel/native pinch is intercepted before browser zoom can flash a stale scale.
- Lazy content extent updates no longer replay zoom during scrolling. Android
  chrome waits for a single-finger gesture to end before resizing the reader;
  two-finger gestures and Live editors retain their viewport while interacting.
  A stale reveal/hide callback cannot resize the reader during a newer gesture.
- Manual Android accents replace the full Material color scheme, not only primary
  roles. Icon foregrounds inherit a proper Surface content color; system-wallpaper
  secondary/surface roles no longer leak into manually chosen dark palettes.
- Android keeps new note only beside the tabs, simplifies its overflow/drawer,
  replaces the collapsed-chrome down arrow with Contents, removes the green accent
  choice and uses rounded, selected-aware recent-note rows. Multiwindow remains
  available in More actions and keyboard tab shortcuts remain supported.
- Long Live editor boxes scroll internally, and desktop font search closes when
  Settings closes. All previous Unicode recovery, PDF, asset and update fixes remain.

## This release

- Android reading starts at 15 px for new users; reading sizes down to 6 px and
  PDF sizes down to 5 pt are available. PDF defaults use 10 pt text, slightly
  more line spacing and explicit paragraph spacing, adjustable in Export/Share.
  Existing preferences are retained.
- Android light surfaces and tonal controls have contrast-checked foregrounds.
  Reading chrome hides on downward swipes and returns on upward swipes or the
  overlay control. Fullscreen has a direct icon with a long-press tooltip, duplicate
  menu Undo/Redo actions are removed, and loading uses Material 3 Expressive's
  morphing indicator (static when motion is disabled).
- Android commits compositor zoom to layout zoom while idle so native text
  selection handles and hit testing agree with the magnified page. Distant heading
  links align inside the reader and are rechecked as offscreen blocks mount.
- Settings show the installed version, manual update checks, startup checks and
  optional automatic downloads. Only published releases from the official repo
  are used; downloads require exact checksums and sizes. Android also checks
  package ID, non-debuggable status, newer version code and the existing signing
  certificate before opening the system installer. No silent Android install or
  forced closing of desktop windows. Linux downloads a portable AppImage; system
  package installs can use DEB/RPM release assets.
- Large notes release offscreen rendered blocks: expanded math, highlighted code,
  image components and interactive plots are mounted near the viewport instead
  of retaining the entire rendered document. Full-note text search, heading
  jumps, reference links, Live editing and copying across hidden blocks remain
  available. PDF preparation still covers the complete source, not the viewport.
- Focal zoom uses cached geometry and one visual update per frame, with native
  zoom notifications debounced. Resize callbacks no longer steal a pinch's focal
  point. Plain text selection remains available.
- Cross-mode undo stores reversible changed ranges rather than full-note
  copies. A large replacement remains undoable, and Source edits remain undoable
  after switching to Read without a second full-text snapshot history.
- Android recovery streams JSON, shares unchanged saved text and no longer
  silently skips larger workspace snapshots. Desktop recovery serialization
  moves off the UI thread and avoids a full-workspace UTF-8 payload copy.
- Executed Matplotlib output is disk-backed, so offscreen figure data can leave
  RAM and still reopen/export without rerunning Python. Small graph-state caches
  retain larger notes' camera and slider choices without retaining their meshes.
- Contents stays beside Folder in normal mode; the duplicate mode-toolbar button
  is removed. Fullscreen Contents is on the left and Exit is on the right, with
  idle hiding and overlay behavior on desktop and Android.
- See `docs/LARGE-NOTE-PERFORMANCE.md` for reproducible local measurements and
  explicit limits; these are not claims of physical-phone or battery benchmarks.

## Included from the preceding maintenance update

- Android device tests exercise fullscreen pinch zoom rather than a removed
  toolbar button, retaining real painted-pixel and PDF verification.
- Copying rendered tables, blockquotes, separators and checkboxes retains
  Markdown structure rather than flattening it into unformatted text.

- PDF, portable SMD and Save dialogs preserve spaces, Unicode and literal percent
  signs in filenames. Typed file URLs prevent double-encoding at the Qt boundary.
- Math containing absolute-value or conditional-probability bars stays inside
  its Markdown table cell on every platform. Original source offsets are retained.
- LaTeX repair no longer splits valid multiline equations into bogus line fixes.
  Repairs remain reviewed and undoable; ambiguous prose is not guessed.
- Plain PDF exports keep neutral paper, shaded/bold table headers and semantic
  colored callouts with SVG icons, independent of wallpaper accent. Optional
  light Material PDF theming remains available only in Export and Share.
- Folder/Contents sidebar sections, collapsed hierarchical headings, independent
  scroll areas and a floating contents overlay. Fullscreen controls hide when idle.
- Chrome-style tab shortcuts, reopen-closed-tab and polished native path hints.
- Search focuses immediately, closes with Esc and uses up/down match arrows,
  case matching and literal source replacement, including offscreen Source lines.
- Changing reading/source/live modes retains a source-position anchor. External
  plain-note updates refresh clean documents without overwriting unsaved edits.
- Bounded cached Markdown/KaTeX trees avoid repeated conversion when reopening
  tabs or changing appearance. Offscreen blocks skip layout/paint work.
- Ordinary text dragging selects again; Alt-drag is optional desktop page pan.
  Graph probes follow the pointer without rebuilding meshes, and hide on touch-up.
- System or manual Material accent presets on desktop and Android; lighter OEM
  palette correction, stronger selected-mode contrast and synchronized reader colors.
- Shared callout icon geometry, Android contents hierarchy/overlay and hardware
  tab shortcuts. Native Qt, shared-reader, PDF and Android regression checks.

Android downloads are optimized, signed **release** APKs with the existing upgrade
certificate. Physical Vivo installation remains unverified without a device test.

## Previous release (0.4.6)

## This release

- Smaller compressed Android release APK with explicit v1/v2/v3 signatures,
  preserving the upgrade certificate. Android 15 and 16 instrumentation gates.
- Selected modes use the primary color with a contrasting label, not a near-white
  highlight. Searchable native font pickers keep typing separate from selection.
- A real Qt label-color regression check prevents the stock Material highlight
  style from overriding the selected-mode text color.
- Android creates each window's independent workspace before the activity resumes,
  eliminating a startup race found by the Android 15 multiwindow test.
- Optional light Material PDF theme (off by default), only in Export/Share.
- Generated sidebar contents, heading-based untitled names, suggested export
  filenames, and a configurable new-note picker location (Downloads by default).
- Page zoom sends tiny native deltas and uses compositor scaling; wrapping stays
  stable. Mouse dragging pans reading pages; 3D mouse dragging rotates while
  two-finger movement pans without tilting the camera.
- Zoom no longer updates document-wide CSS variables or re-renders the reader on
  each frame. Native Android file/contents rows are created lazily as needed.
- The image viewer uses the available window area without a redundant zoom slider.
- Styled auto-hiding equation scrollbars, editable task checkboxes and visited-link
  styling. Compact valid math fences are left untouched by repair suggestions.
- Fixed the MiTeX/Typst inner-product symbol mismatch behind the SNS PDF error.
- Bounded inactive editor histories, imported reader fonts and derived Matplotlib
  image caches. Visible Python figures remain available to PDF export.
- Bundled Noto Emoji provides PDF glyph fallback without requiring system fonts.

The Vivo-specific installer error still requires a device check. Emulator and
automated results are not a claim of physical-phone verification.

## Previously included improvements (0.4.2)

## This release

- Actual page magnification in Read/Live, without changing line wrapping. Math,
  images and tables scale together; focal zoom and two-finger translation keep
  the same area in view. Native toolbar/tab/sidebar sizes remain unchanged.
- Gestures target the graph canvas, not its title, sliders or surrounding card.
  Drag and two-finger movement pan both 2D and 3D plots. Pinch magnifies without
  tilting the 3D camera. Shift-drag and arrow keys remain available for rotation.
- Qt routes native touchpad pixel deltas separately from ordinary mouse wheel
  notches. Browser-only hosts use a documented wheel-delta fallback. Image viewers
  support independent two-finger pan and focal zoom as well.
- Deeper accent-tinted light paper with stronger control surfaces, outlined tonal
  actions, a visible sidebar divider and separated recent-note/window actions.
  Text contrast is checked instead of letting controls disappear into the paper.
- Manrope defaults for new reading/PDF preferences. Existing choices are retained.
- Visible Undo/Redo controls on desktop and Android, plus Ctrl+Z/Ctrl+Y shortcuts.
- Shared, reviewable LaTeX repairs validate candidates with KaTeX: missing dollar
  signs, padded delimiters, alternate/mismatched enclosing, copied escaped math
  dollars, unfinished display fences, align/equation environments and limited
  missing-brace repairs. No invented fraction arguments, automatic source rewrite,
  arbitrary macros, or changes to code, links, HTML and currency.

Expanded tests cover unchanged wraps/focal zoom, real Android two-finger graph
gestures, native history buttons, camera invariance and repaired formula rendering.
Physical phone testing was not performed; the previous releases remain available.

## Previously included improvements (0.4.1)

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
