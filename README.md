# Super MD

Super MD is a fast, distraction-free Markdown studio for Linux, macOS, and Windows. It uses a small Rust/Tauri shell and the system webview—no Electron and no vault. `.smd` files are plain UTF-8 Markdown with optional portable extensions for interactive charts and executable Python cells.

## What works

- Markdown and Obsidian-flavoured Markdown (`.md`, `.markdown`, `.smd`)
- KaTeX math, GFM tables/tasks, code highlighting, relative images, Mermaid diagrams
- Obsidian callouts and the friendlier `:::callout type Title` syntax
- Native interactive SVG charts with sliders
- Local Python/venv execution and Matplotlib SVG output (only on an explicit **Run** click)
- CodeMirror multicursor editing, search and replace, undo history, and keyboard navigation
- Split, editor, reader, focus, and true F11 fullscreen modes
- Separate normal/fullscreen themes: Caelestia dynamic, Material light, Material dark, and pure black
- Separate reading and PDF fonts, plus adjustable type size, line spacing, and reading width
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

Pull requests and `main` pushes run frontend and Rust tests on Linux, macOS, and Windows. Release tags create draft GitHub releases with AppImage/Debian/RPM, macOS DMGs for Apple Silicon and Intel, and Windows NSIS installers. macOS builds are ad-hoc signed, not notarized; Windows builds are not code-signed. On Arch-based build hosts, linuxdeploy may need `NO_STRIP=1` because its bundled strip utility predates RELR sections.

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
| `Ctrl+Shift+S` | Save as |
| `Ctrl+O` | Open |
| `Ctrl+F` | Search/replace panel |
| `F11` | Pure fullscreen |
| `Alt+click` | Add cursor |
| `Ctrl+Alt+↑/↓` | Add cursor above/below |

See [FORMAT.md](FORMAT.md) for the `.smd` extensions.

## Design references

The product direction borrows proven ideas—not code—from MarkText’s distraction-free authoring, Zettlr’s publication workflow, and Quarto’s executable technical documents. Super MD’s differentiators are a vault-free file model, a lightweight native shell, Caelestia palette integration, and a non-DOM Typst PDF pipeline.

## License

MIT
