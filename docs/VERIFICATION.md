# Verification — 2026-09-30

Keep native and browser-mocked evidence separate. These checks were run locally;
GitHub CI results and physical-phone performance are not implied by them.

## Desktop and shared renderer

- 18 frontend unit tests; V8 coverage generated (informational, no invented gate).
- Two Playwright workflows: tabs/history/recovery/sidebar, and the Android reader's
  equations/callouts/graphs/diagram/Python-result PDF preparation using mock IPC.
- Seven real native typesetter tests: equations, callouts, embedded SVG, page-number
  toggle, a 150-row table, wide equations and a 180-line code block. On Linux,
  extracted PDF text and bounding boxes check for lost rows and clipping. Code-line
  bounding boxes additionally check that adjacent lines do not overlap.
- Four desktop Rust unit tests and a real executable CLI export/doctor test.
- Linux production build opened without a development server. Independent windows
  and graceful closing were checked with an isolated recovery directory. Existing
  notes and the previous working installed executable were preserved.

## Native Android

- JVM note-state tests and release lint/build checks.
- Four instrumentation tests on an Android 16 x86_64 emulator, not the user's phone.
  Two color-stripe controls distinguish drawing failures from missing semantics.
  Engine tests run actual embedded Python/NumPy/Matplotlib and compile a multi-page
  PDF through JNI. The complete reader test uses the production bridge, preparation
  and typesetter; only the system destination picker is replaced with a private URI.
- Reader assertions cover KaTeX errors, tip boxes, slider graphs, a real Python plot,
  synthetic two-finger zoom, independently restored fullscreen zoom, tab reopening,
  and the PDF settings sheet. Screenshot checks require painted reader pixels and
  an unobscured native toolbar—not merely a DOM or accessibility tree.
- Phone portrait/landscape and a 960 × 1280 dp tablet-width configuration were checked.
  Phone landscape retains Live/Source/Read; the tablet displays working Split panes.
  Actual foldable hinge hardware and physical touch latency remain untested.

## Bugs found during these checks

- Production desktop assets must use Tauri's custom-protocol feature; a plain Cargo
  build otherwise attempts to use the development-server URL.
- Android WebView needs explicit MATCH_PARENT layout parameters for percentage-height
  HTML. A native clipping container confines accelerated drawing to its pane.
  Hardware acceleration stays enabled; no software-rendering fallback is shipped.
- PDF AST replacements must remain block nodes. Bare image nodes joined neighboring
  Markdown blocks and corrupted headings, tables and callouts.
- Mermaid must disable root-level HTML labels for PDF-readable SVG text.
- Markdown's default image URL transform strips base64 images; the renderer now
  explicitly permits only base64 image URLs in image sources.
- A callout marker can span multiple Markdown parser events. Match the whole first
  logical line rather than assuming a single text event.

## Remaining verification boundaries

- Android screenshot/emulator success is not proof of buttery-smooth physical-phone
  performance or battery use. The user declined automated phone access.
- macOS/Windows workflows are configured; their native GUI behavior has not been
  tested on this Linux laptop.
- PDF plots are static snapshots, while the app's plots remain interactive. Supported
  LaTeX is MiTeX/KaTeX math, not an unrestricted TeX installation.
- The local release APK uses the existing installation's signing certificate for
  upgrades. Production distribution needs a separately managed signing key.
