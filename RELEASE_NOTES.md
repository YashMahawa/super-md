# Super MD 0.6.6

## PDF compatibility and export filenames

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
