# Super MD

A vault-free Markdown study workspace. `.smd` is ordinary UTF-8 Markdown with opt-in interactive chart and Python blocks. Existing `.md` and Obsidian-style callouts work too.

## Platforms and architecture

- Desktop: Rust/Tauri, the system WebView, React, TypeScript and CodeMirror. No Electron runtime. Linux, macOS and Windows build jobs are included.
- Android: native Kotlin/Jetpack Compose Material 3 Expressive controls around the shared document renderer in the Android system WebView. Not a Tauri Android shell. Android 8+; current release targets ARM64.
- PDF: an embedded Rust Typst + MiTeX engine shared by desktop and Android. No browser print layout, external executable, network connection or Python service is required for PDF typesetting.
- Android Python: bundled Python 3.13, NumPy and Matplotlib in a separate app-owned worker process. Desktop Python uses the interpreter or virtual environment you choose.

## Study and authoring

Recoverable tabs, arbitrary-folder browsing, hideable desktop sidebar, Live / Source / Read modes, and Split mode on desktops and Android windows at least 720 dp wide and 600 dp tall. Phones retain three single-pane modes in landscape too. Desktop provides independent document windows and drag-and-drop opening. Android persists drafts across process recreation and uses the system document picker for saving and folder permissions.

KaTeX equations, GFM tables/tasks, highlighted code, Mermaid, relative images, callouts, SVG charts with sliders, and explicitly executed Matplotlib cells share one document renderer. Python is **never** automatically executed when opening a note or exporting. Only run code you trust; a worker process is not a security sandbox. Android executions time out after 115 seconds.

System dynamic colors, light/dark/pure-black themes, separate fullscreen appearance, reading fonts and sizes, independent normal/fullscreen content zoom, and an animation switch are available. Android uses dynamic color on Android 12+ and a monochrome adaptive launcher icon on supporting launchers. Phone reading surfaces respect cutouts while their background extends edge-to-edge. Wider Android windows offer split view and separating vertical hinge spacing.

PDF settings include A4/A5/Letter/Legal, margins, font, type size, line spacing, and page numbers on/off. Fonts are bundled so Android does not silently depend on desktop fonts. Tables wrap and paginate with repeated headers; wide equations fit their available width. GUI export includes Mermaid SVGs, the current chart slider values, and figures from cells you've run. PDFs contain static graph snapshots, not interactive sliders.

Relative Android images require access to the containing folder through **Open any folder**. Android cannot derive arbitrary sibling-file permission from a single-file picker grant. Remote images require consent for viewing; for offline PDF export save them beside your note. Unsupported LaTeX constructs produce a visible export error rather than a silently incomplete PDF. KaTeX and MiTeX are not a full TeX distribution.

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

Output: `android/app/build/outputs/apk/release/`. Without signing variables the release artifact is unsigned. Local upgrade builds can use the existing installation's certificate; that is not a production signing policy. CI never publishes a debug APK. CI release artifacts require your distribution signing secrets for installability. macOS desktop packages are ad-hoc signed, not notarized; Windows packages are not code-signed.

## CLI

```sh
super-md notes.smd
super-md export notes.smd -o notes.pdf --page-size A4 --margin 18 \
  --font 'Libertinus Serif' --font-size 10.5 --line-height 1.35 --no-page-numbers
super-md doctor
```

CLI export supports Markdown, math, tables, callouts, local images and static `smd-chart` snapshots using their declared default values. Use GUI export for Mermaid and already-executed Python results; CLI never runs code implicitly. Invalid chart/math/image input fails explicitly instead of producing an apparently successful incomplete PDF.

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
