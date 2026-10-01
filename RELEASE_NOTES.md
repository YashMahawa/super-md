# Super MD 0.3.0

## Reading, editing and portability

- Click a Live block to edit it, without repeated pencil icons.
- Insert or drop images, including SVG, from files or web addresses. Paste a
  YouTube link to insert its title, optionally with its thumbnail.
- Select an image to replace or remove it, with Undo for removal.
- Open recent files or any ordinary folder. Tabs and recoverable drafts remain
  independent of vaults and databases.
- One Export action offers PDF or portable FMD. FMD stores Markdown and images
  in one editable file; Source mode never displays the image payloads.
- Obsidian display equations with TeX on the opening/closing dollar lines render
  without consuming later paragraphs, headings or callouts. Original files are
  not rewritten to accommodate the parser.

## Layout and responsiveness

- Editable content-zoom percentages, with separate normal/fullscreen zoom.
- Material filled menus throughout Settings, export and welcome setup; no native
  browser dropdowns. Official sliders use the current AndroidX handle/track
  dimensions. Community Expressive buttons and icon controls share theme tokens
  and reduced-motion support; tonal toolbars and clean rounded reading surfaces
  replace the dense outlined-panel treatment.
- Native Android Material 3 Expressive controls, wallpaper-derived colours,
  themed launcher icon and immersive study mode.
- Android's closed file drawer no longer steals scrolling and pinch gestures.
  Phones use Live, Source or Read; sufficiently large tablets also offer Split.
- Pinch updates are coalesced to display frames. Desktop file dialogs, document
  I/O, Python and PDF work do not block the window event thread.

## PDF export

- Shared offline Typst/MiTeX typesetting on desktop and Android. No browser/DOM
  printing and no external Pandoc or Typst installation.
- Vector LaTeX, SVG, Mermaid, current interactive-graph values and manually run
  local Matplotlib figures. Python never runs automatically.
- Breakable tables with repeated headers, fitted wide equations and multi-page
  code blocks. Inline math remains inline inside table cells.
- Page size, font, margins, type size, spacing and optional page numbers.

## Downloads

The release includes an optimized, non-debuggable arm64 Android APK plus Linux
AppImage/DEB/RPM, Windows x64 installer and macOS Apple Silicon/Intel DMGs.
SHA256SUMS covers the uploaded packages. Desktop installers are not yet
commercially code-signed/notarized; OS security prompts may appear.

The APK preserves the existing sideload upgrade certificate. This is not a Play
Store signing-key migration. Android requires version 8.0 or later.

Interactive documents remain interactive in Super MD; PDF is a static snapshot.
Python cells must be run explicitly before their figures are included in PDF.
The CLI supports offline typesetting and FMD packing; use the app for preparing
Mermaid and executable Python blocks.
