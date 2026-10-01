# Super MD

A vault-free Markdown study workspace. `.smd` is ordinary UTF-8 Markdown with opt-in interactive chart and Python blocks. Existing `.md` and Obsidian-style callouts work too.

## Platforms and architecture

- Desktop: Rust/Tauri, the system WebView, React, TypeScript and CodeMirror. No Electron runtime. Linux, macOS and Windows build jobs are included.
- Android: native Kotlin/Jetpack Compose Material 3 Expressive controls around the shared document renderer in the Android system WebView. Not a Tauri Android shell. Android 8+; current release targets ARM64.
- PDF: an embedded Rust Typst + MiTeX engine shared by desktop and Android. No browser print layout, external executable, network connection or Python service is required for PDF typesetting.
- Android Python: bundled Python 3.13, NumPy and Matplotlib in a separate app-owned worker process. Desktop Python uses the interpreter or virtual environment you choose.

## Study and authoring

Recoverable tabs, recent-file history, arbitrary-folder browsing, hideable desktop sidebar, Live / Source / Read modes, and Split mode on desktops and Android windows at least 720 dp wide and 600 dp tall. Phones retain three single-pane modes in landscape too. Click a Live block to edit it—no per-block edit buttons. Desktop provides independent document windows and drag-and-drop opening. Android persists drafts across process recreation and uses the system document picker for saving and folder permissions. The Android files drawer opens deliberately through its menu button, leaving document scroll and pinch gestures uninterrupted.

KaTeX equations, GFM tables/tasks, highlighted code, Mermaid, relative images, callouts, SVG charts with sliders, and explicitly executed Matplotlib cells share one document renderer. Python is **never** automatically executed when opening a note or exporting. Only run code you trust; a worker process is not a security sandbox. Android executions time out after 115 seconds.

System dynamic colors, light/dark/pure-black themes, separate fullscreen appearance, reading fonts and sizes, independent normal/fullscreen content zoom, and an animation switch are available. Android uses dynamic color on Android 12+ and a monochrome adaptive launcher icon on supporting launchers. Phone reading surfaces respect cutouts while their background extends edge-to-edge. Wider Android windows offer split view and separating vertical hinge spacing.

PDF settings include A4/A5/Letter/Legal, margins, font, type size, line spacing, and page numbers on/off. Fonts are bundled so Android does not silently depend on desktop fonts. Tables wrap and paginate with repeated headers; wide equations fit their available width. GUI export includes Mermaid SVGs, the current chart slider values, and figures from cells you've run. PDFs contain static graph snapshots, not interactive sliders.

Images can be dropped, pasted, chosen from a picker or inserted from a public HTTPS URL. Android supports cross-app image drops when the source app provides Android URI grants (especially useful in tablet split screen). Pasted web links offer a readable website/video title and an optional YouTube thumbnail. Offline PDF export includes downloaded images, Mermaid and fenced SVG diagrams; GIF/WebP/AVIF images are converted to a static PNG frame. Remote images require consent for viewing and an explicit PDF/FMD export fetches any still-remote images.

Export **portable `.fmd`** to package Markdown and images into one editable, shareable file without binary data in the Source editor. Ordinary Markdown still uses companion assets. Relative Android images require access to the containing folder through **Open any folder**; Android cannot derive arbitrary sibling-file permission from a single-file picker grant. FMD images need no companion-folder permission. See [FORMAT.md](FORMAT.md) for the format and size bounds. Unsupported LaTeX constructs produce a visible export error rather than a silently incomplete PDF. KaTeX and MiTeX are not a full TeX distribution.

## Development and tests

Node 20+, Rust stable, and desktop system dependencies are required. Linux needs GTK 3 and WebKitGTK 4.1 development packages. No Pandoc/Typst installation is needed.

```sh
npm ci
npm run desktop
npm run build
npm test
npm run test:pdf
npx playwright install chromium
npm run test:browser
npm run package
```

For Android install JDK 17, SDK platform 37, build tools 36, NDK 27.1.12297006, a host Python 3.13, and `rustup target add aarch64-linux-android`. The project script locks concurrent builds, allows the available CPU cores, limits concurrent Cargo jobs to four and Gradle workers to two, and caps the Gradle heap at 1536 MB. Set `SUPERMD_BUILD_CPUS` to restrict CPU affinity when desired.

```sh
export ANDROID_HOME=/path/to/android-sdk
export SUPERMD_BUILD_PYTHON=/path/to/python3.13
# Optional distribution signing: SUPERMD_KEYSTORE, SUPERMD_STORE_PASSWORD,
# SUPERMD_KEY_ALIAS and SUPERMD_KEY_PASSWORD. Never commit a keystore.
npm run android:release
```

Output: `android/app/build/outputs/apk/release/`. Without signing variables the build artifact is unsigned and must not be distributed. CI publication requires either the distribution signing secrets or a locally signed release APK attached to the draft. It verifies the upgrade certificate, non-debuggable variant, 16-KB alignment and clean tagged source before publishing. macOS desktop packages are ad-hoc signed, not notarized; Windows packages are not code-signed.

Desktop controls use official [Material Web](https://github.com/material-components/material-web) filled menus, sliders and switches, plus MIT-licensed [Banegasn Material 3 buttons and icon buttons](https://github.com/Banegasn/components). Sliders are styled with current AndroidX dimensions. Material Web itself implements Material 3, not the Android Expressive motion system; desktop spring transitions and icon-shape morphs remain an app layer. Android uses native Compose Material 3 Expressive. Bundled UI-library licenses are in `public/third-party-ui-licenses.txt`.

## CLI

```sh
super-md notes.smd
super-md export notes.smd -o notes.pdf --page-size A4 --margin 18 \
  --font 'Libertinus Serif' --font-size 10.5 --line-height 1.35 --no-page-numbers
super-md doctor
super-md pack notes.md -o notes.fmd
super-md export notes.fmd -o notes.pdf --no-page-numbers
```

CLI export supports Markdown/FMD, math, tables, callouts, local/embedded images and static `smd-chart` snapshots using their declared default values. `pack` embeds local images into one FMD while preserving other source; use GUI portable export to download remote images. Use GUI PDF export for Mermaid, fenced SVG and already-executed Python results; CLI never runs code implicitly. Invalid chart/math/image input fails explicitly instead of producing an apparently successful incomplete PDF.

## Desktop shortcuts

| Shortcut | Action |
|---|---|
| Ctrl/⌘+N | New tab |
| Ctrl/⌘+W | Close tab, recoverable |
| Ctrl/⌘+Shift+T | Reopen closed tab |
| Ctrl/⌘+Tab | Next tab |
| Ctrl/⌘+O / S / Shift+S | Open / Save / Save as |
| Ctrl/⌘+Shift+O | Open folder |
| Ctrl/⌘+B | Toggle folder sidebar |
| Ctrl/⌘+F | Search and replace |
| Ctrl/⌘++ / − / 0 | Content zoom / reset |
| Ctrl/⌘+Shift+N | New window |
| Ctrl/⌘+Shift+W | Close window, preserving drafts |
| F11 | Fullscreen study |
| Alt+click / Ctrl+Alt+↑ or ↓ | Additional cursors |

See [FORMAT.md](FORMAT.md) for examples and [docs/INSIGHTS-REVIEW.md](docs/INSIGHTS-REVIEW.md) for the reviewed Jules solutions.

## Attribution

MetroList's Kotlin/Compose approach inspired the native interaction direction; no GPL code was copied. The taste guide informed restrained color, consistent typography and purposeful motion, not replacing a dense editor with a website layout. MiTeX's MIT-licensed Typst compatibility definitions are vendored under `smd-core/src/mitex` at commit `985d8e725922ceb70ae5459c50c4cb3d733a0ed1`. Noto Sans is bundled under its SIL Open Font License. Other fonts and library licenses remain with their packages.

MIT.
