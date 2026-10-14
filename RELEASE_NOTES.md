# Super MD 0.5.2

## Reliable reading and document handling

- Opening, dragging or panning an image or SVG no longer re-imports it or appends a broken block. Genuine external image drops still work.
- Scrolling in fullscreen hides controls but never reveals them. Deliberate taps and desktop top-edge hover remain available.
- Optional, separate image and SVG appearance controls: original, dark-theme inversion, theme adaptation and contrast adjustment. Original is the default; these viewing choices do not alter source assets or PDF output.
- Recent documents can be pinned. Pins appear first and are protected from eviction; the list holds at most ten documents.
- Reading positions persist across restarts by default, with an option to disable restoration. A heading jump or manual gesture takes priority over delayed position restoration.
- Welcome appears only on first use. Startup restores prior tabs by default, or opens a blank note when chosen; unsaved drafts remain recoverable.
- SMD and legacy FMD envelopes are recognized by their format marker, even when a sharing provider changes or omits the filename extension.

## Efficient updates and large notes

- Native filesystem/provider notifications update open-folder listings, renamed tabs and recent filenames without a polling loop.
- Deleted notes leave recents and close their tabs with a notice. The last deleted tab becomes a blank note without closing the window; dirty deleted content is retained for recovery.
- Palette-only changes no longer reserialize an unchanged large note or rebuild the whole rendered Markdown/math tree. The native controls and reader update without remeasuring page geometry or rewinding scrolling.
- Delayed viewport anchors stop when newer user input arrives. Image-edit guards no longer retain obsolete full-note strings after the operation ends.
- Desktop shutdown ignores late worker callbacks, prevents duplicate overlapping close prompts and flushes pending preferences and reading positions.

## Packaging and release verification

- Linux explicitly bundles Qt's X11 helper libraries, including `libxcb-icccm.so.4`, whose absence caused the AppImage catalog's clean-machine launch test to fail. Driver-owned GL/EGL and C++/unwind runtimes remain on the host.
- Clean-distribution checks launch the AppImage **before** installing DEB/RPM dependencies, so native package installation cannot mask missing portable dependencies.
- Publication requires passing desktop, browser, native PDF, Android unit/lint and Android API 35/36 emulator checks. Packaged installers must paint real reader pixels and produce portable notes and math PDFs; the Android release APK must pass certificate, alignment and non-debuggable checks.

Notification limits: desktop renames can be followed within watched directories; moves to an unrelated, unobserved directory cannot always be found. Android providers must expose stable identifiers and notifications. Failed or denied metadata queries are not treated as deletion. The exact pair of Fedora dialogs reported by a user has not been independently reproduced; the verified shutdown race and overlapping prompts are fixed.

Custom theme-file support is deliberately reserved for a separate subsequent release. Version 0.5.1 remains available for rollback. macOS packages remain ad-hoc signed rather than notarized, and Windows installers are not code-signed.
