# Native desktop UI

The Qt/QML desktop migration lives in `desktop/`. Version 0.4.0 packages this
native desktop host using a self-contained one-directory PyInstaller build.
The installer retains application data separately; local per-user installs keep
the previous launcher and binary available for rollback. Published releases are
gated on CI and all platform installers, including the signed Android APK.

## Architecture

- PySide6 / Qt Quick provides native window management, tabs, file navigation,
  toolbars, settings, dialogs, sliders and keyboard shortcuts.
- The shared React/CodeMirror/KaTeX/Mermaid renderer remains inside a Qt WebEngine
  **document pane**. The application chrome is not HTML or a Tauri window. This
  is not a claim that the entire document renderer is browser-free.
- Rust `smd-engine` / Typst typesets PDFs; export does not print the DOM.
- Google's Material Color Utilities (maintained Python bindings) generates paired
  light and dark semantic roles. System mode accepts Qt/OS appearance events and
  optional local Material palette providers, with contrast checks. No specific
  desktop shell is required or branded in the app.
- Slow file, network, PDF and Python work runs off the UI thread. Saves and draft
  recovery have one ordered write queue shared by windows. Zoom-only updates
  reuse the unchanged parsed document. Motion can be disabled.

## Design references and licensing

Material 3 Expressive's shape changes, grouped choices, substantial slider handles
and motion are the reference, not a blanket promise that Qt's stock Material
style implements the entire Expressive specification:

- https://m3.material.io/
- https://doc.qt.io/qt-6/qtquickcontrols-material.html
- https://github.com/AvengeMedia/dank-qml-common (MIT; design reference)

The user's local Qt/QML desktop shell was inspected for visual behavior and
semantic color pairing. Its GPL source was **not copied** into these controls.
The skins in this project are independently implemented on native Qt Controls,
retaining keyboard input and accessibility behavior. The desktop icons are
Google's official Material Symbols Rounded SVGs at weight 600, imported by
`scripts/build-qt-icons.mjs` (Apache-2.0, pinned source and license bundled).
Qt/PySide redistribution needs the applicable Qt/PySide and bundled component
license notices and compliance checks when building installers.

## Development and verification

Use a project-local virtual environment and `desktop/requirements.txt`. Build the
shared document assets with `npm run build`, and build `smd-engine` using
`cargo build --manifest-path smd-core/Cargo.toml --bin smd-engine`.

```
desktop/.venv/bin/python desktop/main.py
desktop/.venv/bin/python -m unittest discover -s desktop -p 'test_*.py'
desktop/.venv/bin/python desktop/main.py --visual-smoke
```

Visual smoke uses isolated preferences and draft recovery. It checks the real
renderer, verifies the zoom field's height, and captures the application's own
presented pixels in system/light/dark/black, settings, font popup and narrow
window states. On a multi-monitor Wayland desktop, apply a compositor rule for
`dev.supermd.studio-test` to the laptop panel without stealing initial focus.
The entry point also prefers the laptop's Qt screen before showing the window.

## System integration

Super MD opens as an ordinary resizable window. Tiling/floating placement belongs
to the desktop compositor; do not install a forced-floating application rule.
Study fullscreen is explicit (Fullscreen / F11), Esc exits, and a maximized
window returns maximized. The default file manager remains unchanged.

Linux uses Qt's bundled XDG desktop portal theme for system file/folder pickers.
Folder selection checks for FileChooser portal v3+ asynchronously and reports
an unavailable system picker instead of opening an in-app folder browser.
Windows/macOS use the native Qt platform picker. The desktop entry supports
`inode/directory`; passing a local directory to `super-md` opens its sidebar.
Windows installs an Open folder with Super MD context-menu action. macOS handles
native file-open events and declares folder support to Launch Services.
Reference: https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.FileChooser.html

Tabs use native drag-and-drop for reorder, cross-window moves and detaching.
Window ownership is transferred only after the renderer's final edit snapshot;
Source undo/caret and bounded plot view metadata travel with the note. Shared
recovery has one owner per dirty note. Closed windows release their QML engine.
Rounded scroll indicators keep a fixed gutter and reveal only during scrolling
or gutter hover. See `docs/PLATFORM-PARITY.md` for Android interactions and the
remaining OS-adapter differences.

Remaining work includes complete OS sharing adapters and wider
interactive-feature regression coverage. The current
feature/agent format guide is `docs/AUTHORING.md`. Keep the
working published release available for rollback.
