# Verification

## Android comfort, selection, navigation and updates — 2026-10-03

- 88 frontend unit tests and all 27 browser workflows pass locally, including
  distant links at 200%, selection hit testing at 175%, two-axis native panning,
  Source undo across modes and complete offscreen Python output export.
- 55 Qt/Python tests pass, including streamed download size/hash checks and
  rejection of drafts, prereleases, malformed versions and untrusted asset URLs.
  Software-rendered native tests retain the same geometry/color assertions.
- 16 Rust typesetter tests and two real CLI process tests pass, including 6 pt
  PDF text, explicit paragraph spacing, multipage tables and full math.
- 18 local Android API 36 instrumentation tests pass. The new test injects a
  native long press into the magnified WebView and requires exactly “Bravo”,
  then follows a link across 600 chapters and checks its final alignment. JVM
  tests and release lint pass. This is not a physical Vivo installer check.
- Native desktop presented-pixel smoke tests pass for fonts, menus, fullscreen
  icon size, theme controls, resizing and PDF. Update UI is included in settings;
  update parser/checksum tests use offline fixtures, not a forced new release.
- API 35/36 CI and all installers still gate publication. No running user window
  is replaced, no unsigned/debug APK is distributed, and no power action occurs.

## Windowed large notes and memory maintenance — 2026-10-03

- Reproducible 2,000-formula headless-browser comparison: DOM nodes 217,003 to
  5,090; JS heap about 193 MB to 61 MB; first equation/font readiness 3,555 ms to
  972 ms. See `LARGE-NOTE-PERFORMANCE.md` for the fixture, method and limits.
- Full browser regressions cover offscreen heading/search, focal zoom, Live
  editing, source copying and PDF reload of disk-backed Python figures after RAM
  eviction without rerunning code. Large-note server rendering stays complete.
- 51 native Qt/Python checks pass, including opposite-side fullscreen controls,
  atomic streamed recovery and derived output disk storage.
- 15 native PDF typesetter tests and two CLI process tests pass. Long tables,
  formulas, semantic callouts and all selectable paper/font options remain covered.
- 17 local API 36 Android instrumentation tests pass, including real painting,
  Python/Matplotlib/PDF, large-note heading/search, streamed recovery and derived
  figure storage. Release lint and JVM tests pass. This is emulator evidence, not
  verification of the user's Vivo installer or physical-phone responsiveness.
- Final tagged source must additionally pass the Android 15/16 and all desktop
  CI/release gates before publishing installers. Do not treat these local results
  as evidence of an already published release.

## Reader, installer and memory maintenance — 2026-10-03

- 74 frontend tests and all 17 browser workflows passed locally, including stable
  wrapping/focal magnification, distinct 3D drag vs two-finger pan, slider-free
  image viewing, checkbox source preservation and bounded derived image caches.
- 45 native Qt tests passed, including zoom-only bridge messages, remembered
  reading mode, heading-derived names and sidebar outline data.
- Presented-pixel checks caught Qt Material's stock highlighted-label override;
  selected controls now retain their contrast-validated foreground. A real QML
  test checks the rendered control label rather than only the palette tokens.
- 13 native typesetter tests passed. The unchanged local SNS note reproduced the
  old inner-product failure and now exports a 17-page PDF. Its repair suggestions
  were separately checked: zero changes to the original valid document.
- The prior public ARM64 release installed and launched in the API 36 emulator.
  Its GitHub size/hash matched the local APK. This does not reproduce or verify
  the Vivo Android 15 installer failure. The new packaging follows the smaller
  compressed, multi-signature route used in CaptivePortalAutoLogin.
- Memory changes bound optional caches; they are not claims of a measured battery
  improvement or whole-document virtualization. Current visible Python output is
  retained separately so cache eviction cannot omit visible figures from PDF.
- A local headless Chromium profile of 1,000 equations / 103,006 DOM nodes used
  about 73 MiB JS heap. The 30-step zoom median fell from 222 ms to approximately
  25 ms after isolating Source font scaling and removing per-frame React/root-CSS
  work. These are local measurements, not physical phone or battery benchmarks.
- The compressed, multi-signed candidate installed twice and launched on the API
  36 emulator (upgrade preserved). Its app-process PSS was about 95 MiB for the
  welcome screen; the separate WebView process is not included in this number.

## Native tabs and aligned Android design — 2026-10-02

- 37 real Python/Qt tests pass, including native DropArea events, stable
  auto-hiding scrollbar hit areas, portable draft ownership, stale/busy/closed
  destinations, final edit flushing and recovery exactly once after transfer.
- 40 frontend unit tests and 10 browser workflows pass. Browser tests include
  cross-window Source undo/caret serialization, gutter visibility without width
  changes, independent plot/text zoom and full-document Obsidian math parsing.
- The native desktop's real presented-pixel smoke check passed for the heavier
  fullscreen icon, tint, menus/gutters, narrow layout and actual typeset PDF.
  The clean installed bundle passed those same checks and the native PDF engine.
- Android window isolation, long-press tab gestures and serialized Python runs
  across two windows passed emulator instrumentation. The new restricted PDF
  Share test initially exposed an offscreen action in the half-open long form.
  Export/Share now open fully with a fixed visible action and scrolling options;
  the actual tap, embedded PDF export, read-only content URI and PDF signature
  checks pass locally. The complete final-SHA CI suite remains a release gate.
  Existing actual-painting assertions remain, and lint errors were corrected
  rather than suppressed.
- Physical phone/foldable hardware and macOS/Windows native drag ergonomics
  remain separate user-device checks. See `PLATFORM-PARITY.md` for explicit
  platform-adapter differences; do not claim blanket 100% parity.

## Media and FMD update — 2026-10-01

- 26 frontend unit tests pass. New tests cover icon-free click-to-edit, safe SVG
  diagrams, YouTube/website title parsing, recent-file ordering, and preserving
  frontmatter/callouts/code while embedding both inline and reference images.
- Three browser workflows pass. The new workflow exercises clipboard link
  insertion, optional video thumbnails, a DOM image-file drop, FMD preparation
  without base64 in Source, and SVG/image PDF preparation through mocked IPC.
- Six desktop Rust unit tests plus two real executable CLI tests pass. A single
  FMD reopens and exports its vector image and equation without companion files.
  `pack` output is tested after removing the original loose image fixture.
- Six native Android emulator tests pass, including the real diagonal touch
  path through Compose/WebView and menu-based drawer opening/dismissal, pinch,
  fullscreen zoom restoration, bundled Matplotlib, and JNI PDF/FMD export.
  FMD streaming decode rejects traversal paths; attachment bytes remain outside
  the editor and workspace snapshot. Android System UI initially put an ANR
  dialog over the screenshots during cold boot; after clearing that emulator
  dialog, the unchanged painting assertions passed. The new large-string FMD
  regression test failed before the counter fix and passes afterward with all
  six tests. It crosses reader buffer boundaries using escaped Unicode Markdown
  and a larger embedded SVG.
- The optimized non-debuggable x86_64 release opens with the three-step setup
  and icon-free Live rendering. Through the actual UI it downloaded a public PNG
  from Google's CDN, inserted a short Markdown reference, and exported a real FMD
  through Android's system destination picker. The resulting file contains one
  embedded image and no base64 in its Markdown. This smoke check caught a missing
  custom FMD MIME type in the Open picker; the type is now included. Reopening
  also exposed a lexical counter capture: stream bytes incremented the asset
  counter. Distinct counters fix the real-file failure, without disabling R8.
  The fixed optimized release reopened the same FMD through the system picker,
  displayed its embedded PNG without a companion-folder grant, and reran local
  Matplotlib. Actual GUI export produced a two-page PDF containing equations,
  callout, table, chart, Mermaid, the Python figure and embedded PNG. Both PDF
  pages were rasterized and visually inspected; extracted text retains diagram
  labels and equations. Source mode contains Markdown, not the FMD envelope.
- Linux 0.3.0 opened its production window with isolated test recovery storage;
  its CLI packed and exported a single-file FMD containing math, callouts, a table
  and SVG. The installed binary was updated, preserving the previous executable
  as `super-md.working-backup-20261001`. ARM64 release packaging is optimized,
  non-debuggable, signed with the existing upgrade certificate and 16 KB aligned.
- Native cross-app drag permission handling is implemented using Android's URI
  grant API. Actual drag behavior from each gallery/files/browser app and physical
  phone gesture latency remain user-device checks, not inferred from DOM drops.

## Previous release — 2026-09-30

Keep native and browser-mocked evidence separate. These checks were run locally;
Physical-phone performance is not implied by emulator or CI results.
GitHub run `36675303204` passed all seven checks, including macOS/Windows/Linux,
browser tests, the ARM64 release build and Android emulator instrumentation.

## Desktop and shared renderer

- 19 frontend unit tests; V8 coverage generated (informational, no invented gate).
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
- The optimized, non-debuggable x86_64 release variant was also exercised directly
  through its UI, not through the in-process debug instrumentation harness. Local
  Matplotlib ran successfully; the real Android destination picker saved a PDF with
  equations, table, slider graph, Mermaid and the executed Python figure. Turning
  page numbers off in the native settings sheet produced an unnumbered PDF.
  The additional white-box release harness was not usable: it referenced library
  classes stripped from the production app. No broad keep rules or disabled
  optimization were added to make that harness pass.

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
- Unhighlighted Python source inherited dark document text on a dark code surface
  in light mode. Code surfaces now specify a readable foreground; a browser check
  prevents that contrast regression. Python cells also retain the renderer's
  already-computed syntax spans, without re-tokenizing code or changing execution.

## Remaining verification boundaries

- Android screenshot/emulator success is not proof of buttery-smooth physical-phone
  performance or battery use. The user declined automated phone access.
- macOS/Windows workflows are configured; their native GUI behavior has not been
  tested on this Linux laptop.
- PDF plots are static snapshots, while the app's plots remain interactive. Supported
  LaTeX is MiTeX/KaTeX math, not an unrestricted TeX installation.
- The local release APK uses the existing installation's signing certificate for
  upgrades. Production distribution needs a separately managed signing key.
