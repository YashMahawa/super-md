# Super MD

A vault-free Markdown study workspace. `.md` is ordinary UTF-8 Markdown with opt-in interactive chart and Python blocks. Portable `.smd` bundles Markdown and images without exposing asset payloads in the editor. Old text `.smd`, portable `.fmd` and Obsidian-style callouts remain readable.

## Platforms and architecture

- Desktop: Python/PySide6, Qt Quick/QML native controls and a Qt WebEngine document pane with React, TypeScript and CodeMirror. No Tauri or Electron desktop host. Linux, macOS and Windows build jobs are included.
- Android: native Kotlin/Jetpack Compose Material 3 Expressive controls around the shared document renderer in the Android system WebView. Not a Tauri Android shell. Android 8+; current release targets ARM64.
- PDF: an embedded Rust Typst + MiTeX engine shared by desktop and Android. No browser print layout, external executable, network connection or Python service is required for PDF typesetting.
- Android Python: bundled Python 3.13, NumPy and Matplotlib in a separate app-owned worker process. Desktop Python uses the interpreter or virtual environment you choose.

## Study and authoring

Recoverable tabs, recent-file history, arbitrary-folder browsing, hideable desktop sidebar, Live / Source / Read modes, and Split mode on desktops and Android windows at least 720 dp wide and 600 dp tall. Phones retain three single-pane modes in landscape too. Click a Live block to edit it—no per-block edit buttons. Desktop provides independent document windows and drag-and-drop opening. Android persists drafts across process recreation and uses the system document picker for saving and folder permissions. The Android files drawer opens deliberately through its menu button, leaving document scroll and pinch gestures uninterrupted.

KaTeX equations, GFM tables/tasks, highlighted code, Mermaid, relative images, callouts, SVG charts with sliders, and explicitly executed Matplotlib cells share one document renderer. Python is **never** automatically executed when opening a note or exporting. Only run code you trust; a worker process is not a security sandbox. Android executions time out after 115 seconds.

System dynamic colors, light/dark/pure-black themes, separate fullscreen appearance, reading fonts and sizes, independent normal/fullscreen content zoom, and an animation switch are available. Android uses dynamic color on Android 12+ and a monochrome adaptive launcher icon on supporting launchers. Phone reading surfaces respect cutouts while their background extends edge-to-edge. Wider Android windows offer split view and separating vertical hinge spacing.

PDF settings include A4/A5/Letter/Legal, margins, font, type size, line spacing, and page numbers on/off. Fonts are bundled so Android does not silently depend on desktop fonts. Tables wrap and paginate with repeated headers; wide equations fit their available width. GUI export includes Mermaid SVGs, the current chart slider values, and figures from cells you've run. PDFs contain static graph snapshots, not interactive sliders.

Images can be dropped, pasted, chosen from a picker or inserted from a public HTTPS URL. Android supports cross-app image drops when the source app provides Android URI grants (especially useful in tablet split screen). Pasted web links offer a readable website/video title and an optional YouTube thumbnail. Offline PDF export includes downloaded images, Mermaid and fenced SVG diagrams; GIF/WebP/AVIF images are converted to a static PNG frame. Remote images require consent for viewing and an explicit PDF/FMD export fetches any still-remote images.

Export **portable `.smd`** to package Markdown and images into one editable, shareable file without binary data in the Source editor. Ordinary Markdown still uses companion assets. Relative Android images require access to the containing folder through **Open folder**; Android cannot derive arbitrary sibling-file permission from a single-file picker grant. Portable images need no companion-folder permission. See [docs/AUTHORING.md](docs/AUTHORING.md) for the current format, features, AI examples and bounds. Unsupported LaTeX constructs produce a visible export error rather than a silently incomplete PDF. KaTeX and MiTeX are not a full TeX distribution.

## Development and tests

Node 20+, Rust stable and Python 3.13 are required. Install the pinned desktop requirements into a virtual environment. Linux needs ordinary Qt display/audio/NSS runtime libraries, not WebKitGTK development packages. No Pandoc/Typst installation is needed.

```sh
npm ci
python -m venv desktop/.venv
desktop/.venv/bin/python -m pip install -r desktop/requirements-build.txt
npm run build
npx vitest run
desktop/.venv/bin/python -m unittest discover -s desktop -p 'test_*.py'
npm run test:pdf
cargo build --locked --release --manifest-path smd-core/Cargo.toml --bin smd-engine
desktop/.venv/bin/python desktop/main.py
desktop/.venv/bin/python desktop/package.py --bundle-only
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

Desktop controls are independently skinned native Qt Quick Controls, using Google's Material Color Utilities for paired semantic colors. Expressive shape/press motion, grouped controls and sliders are app-level implementations, not a claim that stock Qt implements the complete Expressive specification. Android uses native Compose Material 3 Expressive. The document pane retains Material Web components where appropriate. Redistribution notices are in `desktop/NOTICE.md` and `public/third-party-ui-licenses.txt`.

## CLI

```sh
super-md notes.md
super-md doctor
smd-engine read notes.smd --limit 16000
smd-engine inspect notes.smd
smd-engine assets notes.smd
smd-engine pack notes.md notes.smd
smd-engine export notes.smd notes.pdf
```

The binary-safe CLI reads only Markdown by default; images are listed separately and can be extracted to a file. Headless export supports math, tables, callouts and local/embedded images. Use GUI export for prepared graphs, Mermaid, fenced SVG and already-executed Python results; CLI never runs code implicitly. `export-json` accepts prepared text/assets/PDF options over stdin, keeping binary content out of stdout. See [docs/AUTHORING.md](docs/AUTHORING.md) for details.

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

## License and copyright

Copyright © 2026 Yash Mahawar and Super MD contributors.

Super MD's original code is open source under the [MIT License](LICENSE).
Bundled third-party libraries, fonts, and icons retain their own copyright
notices and licenses; see [desktop distribution notices](desktop/NOTICE.md)
and [third-party UI licenses](public/third-party-ui-licenses.txt).
