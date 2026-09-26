# Super MD

Super MD is a fast, distraction-free Markdown studio for Linux, macOS, and Windows. It uses a small Rust/Tauri shell and the system webview—no Electron and no vault. `.smd` files are plain UTF-8 Markdown with optional portable extensions for interactive charts and executable Python cells.

## What works

- Markdown and Obsidian-flavoured Markdown (`.md`, `.markdown`, `.smd`)
- KaTeX math, GFM tables/tasks, code highlighting, relative images, Mermaid diagrams
- Obsidian callouts and the friendlier `:::callout type Title` syntax
- Native interactive SVG charts with sliders
- Local Python/venv execution and Matplotlib SVG output (only on an explicit **Run** click)
- CodeMirror multicursor editing, search and replace, undo history, and keyboard navigation
- Recoverable document tabs, Live block editing, split, source, reader, focus, and true F11 fullscreen modes
- Separate normal/fullscreen themes: system colors, Material light, Material dark, and pure black
- First-run welcome setup for theme, reading font, and expressive motion; the motion switch honours OS reduced-motion settings
- Independent normal/fullscreen workspace zoom: pinch or Ctrl/⌘ zooms editor and preview content while toolbars keep their size; long lines reflow instead of clipping
- Frame-paced split resizing, drag-and-drop document opening, and independent document windows (`Ctrl/⌘+Shift+N`)
- Separate reading and PDF fonts, plus adjustable type size, line spacing, and reading width
- Untitled draft and recently closed tab recovery; local images resolve relative to the document on desktop, while remote images load only after consent
- Semantic PDF export through Pandoc + Typst; the preview DOM is never printed
- One binary for GUI and CLI export

## Development

Requirements: Node 20+, Rust stable, Pandoc 3+, and Typst. Linux builds additionally require WebKitGTK 4.1 and GTK 3 development packages. Python and Matplotlib are optional.

```bash
npm install
npm run desktop
```

Build the frontend and test the Rust core:

```bash
npm run build
cd src-tauri && cargo test
```

Create native packages for the current OS:

```bash
npm run package
```

Pull requests and `main` pushes run frontend and Rust tests on Linux, macOS, and Windows. Release tags create draft GitHub releases with AppImage/Debian/RPM, macOS DMGs for Apple Silicon and Intel, and Windows NSIS installers. macOS builds are ad-hoc signed, not notarized; Windows builds are not code-signed. The AppImage job runs on Ubuntu: Arch's `linuxdeploy` GTK plugin assumes Debian-style `/usr/lib/gdk-pixbuf-2.0` and cannot package an AppImage locally without a compatible build container.

## Native Android work in progress

The new `android-native/` project uses Kotlin and Jetpack Compose, not Tauri or a WebView shell. Android 12+ can use the phone's dynamic Material colors, and Android 13+ launchers can tint its monochrome adaptive icon. It has Live, Source, and Read modes on phones, an additional resizable Split mode on wide screens, system-inset-aware fullscreen, recoverable tabs, search and replace, and a native Canvas-based PDF exporter with A4/Letter, margin, and text-scale choices. Relative image paths work after granting access to the note's containing folder; the `.md`/`.smd` text is not rewritten. CI builds a debug APK from this project.

To build locally, install the Android SDK platform 36 and JDK 17. The Gradle settings limit memory to 1.5 GiB, two workers, and in-process Kotlin compilation. Stop any older Gradle build before starting another:

```bash
cd android-native
./gradlew --stop
./gradlew :app:assembleDebug --max-workers=2 --no-daemon
```

This rewrite is **not yet desktop feature parity**. The native PDF renderer does not yet typeset LaTeX equations; it refuses such exports with an explicit error rather than silently emitting broken math. Complete Markdown inline formatting, executable Python/Matplotlib cells, and physical phone/foldable QA are also pending. The desktop Pandoc/Typst exporter remains the high-fidelity path for technical notes until these gaps close. The APK is debug-signed, not a Play Store release.

## CLI

The packaged `super-md` binary doubles as the CLI:

```bash
super-md notes.smd
super-md export notes.smd -o notes.pdf --page-size A4 --margin 18 --font "New Computer Modern"
super-md doctor
```

PDF export requires `pandoc` and `typst` on `PATH`. Additional PDF font choices use fonts installed on the host operating system; the default is New Computer Modern. PDFs are compiled by a real document toolchain rather than screenshots or browser print CSS.

## Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+S` | Save |
| `Ctrl+N` | New tab |
| `Ctrl+W` | Close tab (recoverable) |
| `Ctrl+Shift+T` | Reopen closed tab |
| `Ctrl+Tab` | Next tab |
| `Ctrl+Shift+S` | Save as |
| `Ctrl+O` | Open |
| `Ctrl+F` | Search/replace panel |
| `Ctrl/⌘++`, `Ctrl/⌘+-`, `Ctrl/⌘+0` | Zoom workspace in/out/reset |
| `Ctrl/⌘+Shift+N` | New document window |
| `F11` | Pure fullscreen |
| `Alt+click` | Add cursor |
| `Ctrl+Alt+↑/↓` | Add cursor above/below |

See [FORMAT.md](FORMAT.md) for the `.smd` extensions.

## Design references

The product direction borrows proven ideas—not code—from MarkText’s distraction-free authoring, Zettlr’s publication workflow, Quarto’s executable technical documents, and MetroList’s restrained spring-driven Material Expressive motion. Super MD’s differentiators are a vault-free file model, a lightweight native shell, system palette integration on supported desktops, and a non-DOM Typst PDF pipeline.

## License

MIT
