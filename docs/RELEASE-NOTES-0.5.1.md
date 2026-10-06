# Super MD 0.5.1

## Desktop launch reliability

- A failed Wayland/OpenGL/EGL graphics initialization no longer aborts the editor before it opens. An isolated, bounded startup probe checks real Qt rendering; when it fails, Super MD selects software rendering for both Qt Quick and the document pane.
- Healthy systems keep accelerated rendering. `--safe-graphics` is available as an explicit troubleshooting option. This does not disable Chromium's security sandbox or change system drivers.
- The probe checks actual HTML pixels with an off-the-record renderer, not just the native controls. This catches document-only GPU context failures seen on Intel Mac. Installer smoke checks wait for real readiness/presentation within a bounded deadline rather than an arbitrary ten-second startup timer.
- Linux packages use the host C++/unwind runtimes rather than overriding newer Mesa/LLVM drivers with older bundled libraries. Software fallback also avoids X11 GLX initialization, addressing a second clean-Ubuntu-24.04 startup abort caught by the new installer checks.
- Debian dependencies include the XCB cursor integration, GBM, font configuration and both older/newer ALSA package names. RPM dependencies use Linux shared-library capabilities rather than Debian-only package names.
- Both Linux package formats explicitly require Wayland's server library too: Qt links it even in X11 mode. The fresh Fedora check caught this missing dependency before publication.
- Release gates now launch the packaged editor and require actual painted document pixels, portable-image round trips and native LaTeX PDF output. Linux installers are exercised in fresh Ubuntu 22.04/24.04, Debian 12 and Fedora containers without a developer venv or host GPU, including the missing-Wayland-EGL failure path. Windows checks install the EXE; macOS checks launch the app from the mounted DMG on both architectures.

## Checkbox position fix — shared desktop/Android reader

- Checking tasks no longer unnecessarily rebuilds settled zoom geometry. Reading position and magnification stay stable through checking, undo and redo in Read and Live modes.
- Shared-reader browser regressions exercise both Qt and mobile layout paths at normal and enlarged zoom, including long/windowed notes.
- Android API 35/36 emulator suites remain release gates alongside shared-reader checkbox regressions. The updated signed release APK includes the shared-reader fix; signing, alignment and source identity remain publication requirements. No physical phone testing is performed.

Previous 0.5.0 features remain intact, including Python/NumPy/Matplotlib setup, graph probing, fullscreen and reading-position improvements. See [0.5.0 notes](https://github.com/YashMahawa/super-md/releases/tag/v0.5.0).

For graphics troubleshooting and platform boundaries, see [the graphics guide](https://github.com/YashMahawa/super-md/blob/main/docs/GRAPHICS-DIAGNOSTICS.md). FUSE mounting and graphics initialization are separate issues; AppImage extraction mode avoids a FUSE requirement. Software rendering trades GPU acceleration for compatibility only when needed. macOS packages remain ad-hoc signed rather than notarized, and Windows installers are not code-signed.
