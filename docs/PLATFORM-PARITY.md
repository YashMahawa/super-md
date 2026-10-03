# Shared product, native platform behavior

Super MD uses native Qt Quick/Material controls on desktop and native Jetpack
Compose Material 3 Expressive controls on Android. They share document editing,
math/diagram/plot rendering, portable SMD preparation and the Rust/Typst PDF
engine. Neither platform uses DOM printing for PDF layout.

The toolbar symbols share Google's pinned Material Symbols Rounded paths,
weight 600. Desktop SVGs are converted mechanically into Android vector
drawables by `node scripts/build-android-icons.mjs`; no raster replacement or
runtime download is involved. The Apache-2.0 license ships on both platforms.

## Common interactions

- Ordinary Markdown files and portable SMD files, with legacy FMD read support.
- Live, Source and Read; Split when the window has sufficient tablet space.
- Independent workspace/fullscreen themes, system accent, tinted light paper,
  dark and pure black; motion can be disabled.
- Tabs, draft recovery, open/close folder, recent files, image drops and removal.
- Equations, callouts, collapsible answers/code, Mermaid, SVG, interactive 2D/3D
  plots and local NumPy/Matplotlib execution after explicit Run.
- Content zoom, independent plot/image zoom, links and PDF heading navigation.
- PDF paper size, margins, font, size, line spacing, optional page numbers and
  optional light Material paper. Export and Share remember the same configuration;
  PDF options are not duplicated in the general Settings page.
- Percentage-based reading width (80% by default) and adjustable vertical spacing.
- Private TTF/OTF imports for reading and PDF export; bundled Manrope, Roboto,
  Noto Sans, Noto Serif and JetBrains Mono are shared by both platforms.
- Double-click Live block editing, outside-click/Escape exit, Read/Live search
  with all-match highlighting, Markdown/LaTeX copying and code Copy controls.
- Autosave for existing notes, conflict checks against externally changed files,
  empty-untitled disposal, rename, undo and redo. Android document providers may
  not support atomic replacement; staged writes and separate recovery reduce risk.

## Windows and tabs

Desktop: drag tabs to reorder or between Super MD windows. Release a drag
outside the tab strips to detach, or use a tab's right-click "Move to new
window" command. Escape cancels a drag. Transfers flush the latest edit before
changing ownership, preserve embedded assets and bounded Source undo/caret and
plot view state, and leave the original note untouched if the target closes or
is busy. Transient view metadata is not added to Markdown/SMD or recovery files.
The drag has a native note-preview image. Moving the final tab into another
window retires the empty source window.

Android: hold a tab, then drag to reorder it. TalkBack also exposes move-left and
move-right actions. Normal horizontal swipes still scroll the tab row. "New
window" opens an independent Android task with its own tabs/recovery file.
Switch windows through Android Recents; on supported devices Android can place
the new task adjacent or in a movable desktop window. Window placement and
split-screen availability are controlled by Android/OEM policy, not guaranteed
by the app. Existing main-workspace recovery is preserved. Cross-window Android
tab dragging is intentionally not implemented.

## Honest platform differences

Android supplies an OS share sheet with restricted, read-only FileProvider URIs
for PDF, Markdown and SMD copies. Desktop currently prepares a shareable copy;
a universal native share sheet is not implemented on Linux/Windows/macOS.
Markdown sharing is text-only: use portable SMD to include images in one file.

Desktop can use installed font families and a selected system Python/venv.
Android bundles Python/NumPy/Matplotlib instead. Phone controls use touch-sized
targets and bottom sheets; desktop uses hover tooltips, gutters and dialogs.
This is feature alignment, not a claim that every platform adapter is identical.
