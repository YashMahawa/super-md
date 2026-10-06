# Desktop graphics and portable installers

## Automatic recovery

Super MD 0.5.1 checks a real Qt frame in an isolated startup process before opening the editor. Qt graphics initialization can abort the process instead of raising an exception; a crashing/timed-out probe cannot acquire the note session, preferences or single-instance socket. It has an eight-second parent timeout and no core dump. Healthy graphics settings are preserved, including the chosen platform/RHI backend. A failed probe enables `QT_QUICK_BACKEND=software` and adds `--disable-gpu` to `QTWEBENGINE_CHROMIUM_FLAGS`, without disabling the browser sandbox. The native controls and WebEngine document are both tested for actual painted pixels.

This follows Qt's documented [WebEngine software-rendering options](https://doc.qt.io/qt-6.10/qtwebengine-features.html#hardware-acceleration). The [Qt Quick software adaptation](https://doc.qt.io/qt-6.8/qtquick-visualcanvas-adaptations-software.html) can render without a hardware graphics API, but some effects/optimizations differ. Software fallback is a compatibility path, not a claim of identical GPU performance or a replacement for updating a broken driver.

For an explicit safe launch:

```sh
super-md --safe-graphics
./Super-MD_0.5.1_amd64.AppImage --safe-graphics
```

No persistent user preference or system-driver setting is changed. Removing that argument lets the next launch probe accelerated graphics again. CLI queries and Python cells bypass the graphics probe.

## FUSE is a separate layer

If an AppImage cannot mount because FUSE is unavailable, use its standard extraction mode:

```sh
APPIMAGE_EXTRACT_AND_RUN=1 ./Super-MD_0.5.1_amd64.AppImage
```

A FUSE mounting failure happens before the application starts. It is not evidence of an OpenGL failure. If Qt later reports EGL/RHI initialization failure, the graphics recovery path applies after extraction too.

## Linux runtime requirements

Linux x86-64 packages are built on Ubuntu 22.04 and require glibc 2.35 or newer. They include Python/Qt/application resources, not arbitrary host GPU drivers. A normal desktop still supplies EGL/GL loader libraries, NSS, ALSA, DBus, GBM, fonts and a working Wayland/X11 session. The DEB declares its dependencies, including `libasound2 | libasound2t64`. The RPM uses `.so` capability dependencies rather than assuming Debian package names exist on Fedora/openSUSE.

Release containers start with no developer Python/Qt environment, no host GPU, and a fresh non-root user. AppImage extraction and installed DEB/RPM launches must render a note, process an embedded SVG portable file and export LaTeX to a real PDF. A headless Wayland compositor plus unavailable EGL client integration reproduces the original fatal path; the packaged editor must recover automatically. The container tests do not claim every GPU/compositor/remote-desktop configuration has been tested.

The disposable CI containers permit Chromium's internal sandbox namespaces
(`SYS_ADMIN`, following [Chromium browser-container guidance](https://pptr.dev/guides/docker))
and provide 1 GiB of shared-memory capacity. They do not pass `--no-sandbox`,
mount host GPU devices, user files or credentials. These are container test
settings, not changes to the laptop or application security policy.

Windows checks exercise the installed EXE and its built-in Python; macOS checks launch from the actual mounted DMG and run its built-in Python on Apple Silicon/Intel. Packages are not a promise of support for operating systems older than their bundled Qt/Python runtimes. macOS ad-hoc signing is not Apple notarization, and Windows installers are not Authenticode signed; OS trust prompts remain possible.

## Regression checks

`desktop/test_graphics_runtime.py` covers healthy, aborted, timed-out and explicitly software startup. `desktop/check_packaged.py` checks the actual packaged executable, report-based painted pixels, native PDF and portable embedded assets. `scripts/check-linux-container.sh` is for disposable CI distro containers only: do not run it directly on your laptop, because it installs packages and creates a test user in the container.

Checkbox position regressions are covered in the shared browser renderer's desktop/mobile paths. Android API 35/36 emulator suites and APK signature/source/alignment checks remain mandatory publication gates. No physical phone access is required.
