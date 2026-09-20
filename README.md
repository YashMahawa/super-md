# Super MD

Super MD is a fast, distraction-free Markdown studio for Linux. It uses a small Rust/Tauri shell and the system WebKit runtime—no Electron and no vault. `.smd` files are plain UTF-8 Markdown with optional portable extensions for interactive charts and executable Python cells.

## What works

- Markdown and Obsidian-flavoured Markdown (`.md`, `.markdown`, `.smd`)
- KaTeX math, GFM tables/tasks, code highlighting, relative images, Mermaid diagrams
- Obsidian callouts and the friendlier `:::callout type Title` syntax
- Native interactive SVG charts with sliders
- Local Python/venv execution and Matplotlib SVG output (only on an explicit **Run** click)
- CodeMirror multicursor editing, search and replace, undo history, and keyboard navigation
- Split, editor, reader, focus, and true F11 fullscreen modes
- Separate normal/fullscreen themes: Caelestia dynamic, Material light, Material dark, and pure black
- Semantic PDF export through Pandoc + Typst; the preview DOM is never printed
- One binary for GUI and CLI export

## Development

Requirements: Node 20+, Rust stable, WebKitGTK 4.1, GTK 3, Pandoc 3+, and Typst. Python and Matplotlib are optional.

```bash
npm install
npm run desktop
```

Build the frontend and test the Rust core:

```bash
npm run build
cd src-tauri && cargo test
```

Create AppImage, Debian, and RPM packages:

```bash
npm run package
```

Release tags also trigger a clean Ubuntu build that creates portable Linux assets on GitHub. On Arch-based build hosts, linuxdeploy may need `NO_STRIP=1` because its bundled strip utility predates RELR sections.

## CLI

The packaged `super-md` binary doubles as the CLI:

```bash
super-md notes.smd
super-md export notes.smd -o notes.pdf --page-size A4 --margin 18
super-md doctor
```

PDF export requires `pandoc` and `typst` on `PATH`. This is deliberate: PDFs are compiled by a real document toolchain rather than screenshots or browser print CSS.

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
