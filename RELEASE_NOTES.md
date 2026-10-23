# Super MD 0.6.9

## Fast scrolling without lazy-layout jumps

- Fixed a second scroll-jump cause in large notes: fast upward wheel/touchpad scrolling could race with lazy block mounting and return the visible text to a later section. Shared reader observer deliveries now commit as one anchored batch before paint, preserving the current source location rather than replaying an earlier scroll position.
- Placeholder expansion anchors an already-rendered neighbouring block instead of the placeholder itself. Paragraph margins use bounded viewport sampling, not a scan through the whole note.
- Offscreen blocks retain their latest fractional height before their rendered children are removed. This avoids both stale ResizeObserver measurements and rounding drift at magnified zoom.
- Previously measured image/diagram blocks keep their known footprint while remounted media load again, then release it on completion or failure. A failed reload does not leave a permanent empty gap.
- Scroll anchors now retain the original text-node identity. A browser Range retargeted to a parent after a loading label disappears can no longer generate a false scroll correction.
- Offscreen unmounting, bounded rendered math, heading navigation, selection, source editing and zoom remain supported. The fix does not keep the entire note rendered or change the Markdown source.
- Added fast alternating-scroll regressions with remounted media for desktop and Android layouts at 40%, 100%, 104%, 180% and 300% zoom, plus failed-reload and Range-retargeting tests. The original regression reproduces hundreds of pixels of unwanted movement on 0.6.8; the new code is checked against a 3-pixel source-anchor limit. The separate delayed-image regression is retained.

The existing Android signing identity and all 0.6.8 fixes are retained. Cross-platform CI and packaged-installer checks remain release gates.

## Retained improvements from 0.6.8

## Stable reading and expressive export

- Fixed a reproduced scroll jump when an image finishes loading above the text being read. Image, SVG and Mermaid size changes now preserve the visible source anchor without polling or image-sized JavaScript buffers.
- Newly opened notes start at their own beginning rather than inheriting another tab's scroll position. Returning to an existing tab still restores its reading position.
- PDF export now shows the house Material 3 Expressive-inspired loading animation alongside useful phase/count information and cancellation. App motion-off and system reduced-motion preferences are respected.
- Auto image adaptation no longer leaves pale outlines around coloured plots on dark paper. A small hue-preserving luminance matrix improves dark-paper contrast while keeping colours distinct; monochrome remains a separate option. Transparent images retain their source alpha, and SVG adaptation no longer invents extra strokes.
- Drawing decode failures report an actionable error instead of leaving a loading placeholder indefinitely.

## Safer edits and faithful documents

- Proofreading suggestions are tied to the exact source/options that were checked. Unrelated edits retire stale suggestions, repeated clicks cannot apply a correction twice, and accepted corrections safely remap remaining non-overlapping ranges.
- LaTeX repair selection resets for a changed document and guards repeated Apply clicks.
- Nested callouts, rich inline callout titles and code fences inside callouts retain their structure in reading and native PDF export.
- Native PDF tables preserve left, centre and right column alignment. Ordered-list copying preserves numbering, and expanding Contents no longer resets the outline's scroll position.
- Searches explicitly indicate the existing 5,000-match display limit rather than presenting the capped list as a complete total.

## Android and export resilience

- Android's JNI PDF loader reads only referenced staged images plus imported fonts, checks per-file and cumulative limits before allocation, and reserves known lengths without repeated buffer growth. Existing supported document/image limits are retained.
- CLI export and packing support validated inline image data; remote images are never downloaded implicitly. Malformed input and invalid export options preserve an existing destination.
- Mermaid cache/theme transitions avoid the typing debounce, retain a valid diagram while the replacement is prepared, and recover correctly after an earlier source error.

This patch retains the existing Android upgrade certificate and the previous release's export filename, updater, graphics fallback, recovery and portable-file fixes. Cross-platform CI and release installer checks remain mandatory; no universal speed or RAM-reduction multiplier is claimed.

## Retained improvements from 0.6.7

## Export, menus, navigation and updates

- Fixed an update-check failure reproduced in the installed Linux app: its bundled OpenSSL searched build-machine certificate paths that did not exist on the destination, leaving no trusted authorities. Desktop HTTPS now includes a portable Mozilla CA bundle alongside system trust, without disabling certificate or hostname verification. Packaged-runtime tests explicitly remove host CA paths; update errors now identify certificate, connection and service failures.
- Desktop exports now use a fresh native save chooser for each operation, with a captured format, matching filename suffix and filter. Requesting portable SMD no longer gets reset to PDF when the options panel finishes opening.
- Real Linux portal tests exercise consecutive PDF, SMD and Markdown exports, including Unicode, spaces and intentional percent sequences in filenames. Existing backend checks still reject mismatched destination types before writing.
- Replaced the reader's unstyled browser right-click menu with the application's opaque themed context menu. Copy, Select all, available editing actions and link copying remain supported; browser-only page commands are no longer exposed. Tests right-click an actual WebEngine page and verify painted menu pixels and clipboard actions.
- When Contents has a single root heading, it is shown without a disclosure control and its sections are immediately accessible. Nested sections and documents with multiple root headings retain their normal collapsible navigation on desktop and Android.
- Linux updates select the installer matching the current AppImage/portable, Debian or RPM installation, instead of always downloading an AppImage. Verified Windows installers and macOS disk images are handed to the operating system, with actionable handoff failures. Operating-system installation approval remains required where applicable.
- Android verifies that the downloaded APK was actually published in Downloads before reporting success, offers a retry if publication fails, and keeps a verified older installer usable if a newer download fails. Private installation remains available when public storage publication fails.
- Previously downloaded installers and existing application versions remain recoverable on desktop. Android removes only its recorded installer after a successful upgrade.

The following fixes and performance improvements from 0.6.6 are retained.

## PDF compatibility and export filenames

- Opening a document now activates its tab without delayed startup restoration or an older file load stealing selection. Already-open files reuse their tab; background refresh leaves selection alone, and later explicit tab choices are respected.
- Android queues file-opening requests until the reader bridge is ready, retains all requested files, handles new system intents and avoids replaying the initial intent on Activity recreation.
- Fixed proofreading worker idle eviction so cold startup and queued checks are not terminated as if they were idle. Delayed-work and worker-ownership regression tests retain idle memory cleanup without dropping active results.

- Fixed circular convolution (`\circledast`, including indexed forms) failing native PDF export with an “unknown symbol modifier” error. The Markdown source does not need to change.
- Audited all 397 zero-argument symbolic commands in MiTeX's embedded inventory against the shipping typesetter. Updated circled and large operators, dashed arrows, double brackets, Planck's constant, inverted omega and partial derivatives.
- Symbol compatibility now uses math syntax rather than text substitution, preserving literal TeX text and quoted strings. Ordinary equations without legacy identifiers avoid the additional syntax parsing.
- Android share copies preserve Unicode, emoji, spaces and ordinary punctuation. Unsafe path/control characters remain sanitized; long names are bounded by Unicode code points and UTF-8 bytes.
- Export suggestions strip known document suffixes before adding the selected format's canonical suffix. PDF, Markdown and SMD use corresponding filenames and MIME types.
- Newly created Android export destinations are checked before writing. A provider-supplied wrong extension is corrected when supported or reported clearly; existing notes are never renamed by this correction. PDF/SMD file signatures are checked before publishing bytes.
- Portable Android notes now display the PDF/SMD format selector rather than hiding it.
- Desktop export dialogs track the selected format's suffix. Mismatched known extensions are rejected before exporting, and extensionless/custom dotted stems get the proper suffix without silently overwriting an unconfirmed destination.
- Overlapping desktop destination changes are blocked while export is pending. Writers independently reject stale cross-format callbacks before opening a destination, preserving existing files.
- Android provider policy tests cover rename failures, mismatched types and missing filenames. Valid `.smd` destinations also accept a provider reporting the underlying JSON/text representation instead of the custom MIME type.
- Added native JNI symbol checks, Unicode filename/MIME/header share transitions, desktop export/collision regressions and the generated symbol audit.
- Verified the complete supplied SNS note through real PDF preparation, including both Mermaid diagrams, without modifying the note or automatically executing its Python code.

The performance, recovery and compatibility improvements below are retained from 0.6.5.

## More reliable editing and recovery

- Small edits now use acknowledged, revisioned UTF-16 changes instead of repeatedly transferring an entire large note. Save, close, export and window transfer wait for the edit queue, with a full-snapshot compatibility fallback.
- Conflicting unsent drafts are preserved rather than silently overwriting newer native content. Untouched stale baselines no longer manufacture conflict recovery copies.
- Live mode retains whole-document reference links, footnotes and loose-list semantics, including their numbering and source offsets.
- Heading links avoid currently visible reading controls on Android and in desktop fullscreen. This changes navigation destinations, not the document width or layout; hiding controls does not reflow the page.
- Android and desktop recover a failed document renderer from native-owned state. Already acknowledged changes are restored, reading position is retained where available, and Python is never automatically rerun.
- Closed large notes use recoverable disk-backed snapshots rather than retaining their full bodies in memory or immediately losing reopen availability.
- Recovery writes coalesce obsolete queued snapshots while preserving actual saves and shutdown flushes.

## Large-note work and memory

- Shared exact-source analysis avoids redundant parsing across Read/Split previews and outlines. Live reuses its existing document context without introducing a new whole-note parse on each keystroke.
- Large Source-mode outlines use a cancellable worker returning compact metadata. Stale results are discarded; ordinary rendering and export keep their existing semantics.
- Windowed blocks share visibility observation, and diagram work is owner-scoped, deduplicated and retired when no longer needed.
- Local raster assets can use bounded document-scoped streams instead of base64 JSON copies. Ownership, path validation, remote-image consent and legacy loading fallbacks remain in place; originals are not downscaled or deleted.
- A full-document accessibility setting provides the complete semantic tree when continuous traversal is more important than windowed-rendering memory savings. Automated accessibility-tree and keyboard tests cover distant content; manual screen-reader compatibility is not claimed.

## Python output and PDF export

- Python results are scoped to their document, cell, source and runtime context, preventing identical code in another note from inheriting unrelated output.
- Legacy saved results remain available with an unverified label. Fresh output awaiting durable storage is visibly marked and retained; opening or exporting a note never executes code to reconstruct an image.
- PDF export reports preparation and typesetting progress and supports cancellation before destination publication. A destination write already in progress is allowed to finish safely rather than leaving a deliberately truncated output.
- Removed the redundant Save as Markdown action from Android's overflow menu.

## Builds, diagnostics and compatibility

- Healthy RGB565 Wayland/EGL surfaces no longer trigger software fallback merely because their painted HTML colors are quantized. Missing or broken graphics still use the existing safe fallback.
- CI builds the native frontend once per workflow and verifies its exact source, lockfile and complete file hashes before each platform packages it.
- Verified ABI/platform-specific Python wheel caches avoid repeated source compilation, including macOS Intel. Gradle caching and bounded browser parallelism retain all existing test families.
- Package checksums stream through bounded buffers. Resource inventories retain offline fonts, diagrams, help and licence notices; no speculative dependency or feature removal is included.
- Read-only storage diagnostics distinguish recoverable or irreplaceable data from disposable runtime data. Existing user content and caches are not automatically deleted.
- Vercel's experimental TypeScript compiler is evaluated in isolated cross-platform canaries; it does not replace the authoritative production compiler. Measured Rust alternatives did not justify changing the shipping profile.
- Releases remain gated on exact-source desktop, browser, PDF and Android API 35/36 tests, the existing Android signing identity, and complete installer checks.
- macOS packages remain ad-hoc signed rather than notarized. Windows installers are not code-signed.

Performance observations and their limitations are recorded in `docs/PERFORMANCE-BASELINE.md` and `docs/PERFORMANCE-EXPERIMENTS.md`; they are not universal speed or memory guarantees.
