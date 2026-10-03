# Updates

Settings → About & updates shows the installed version. Startup checks are enabled
by default; automatic downloads are off by default. Turning checks off keeps the
app fully offline unless you explicitly check. Notes are never uploaded.

Checks use `YashMahawa/super-md`'s latest published, stable GitHub Release. Drafts,
prereleases, older versions, missing assets and untrusted asset URLs are rejected.
Downloads are streamed to temporary files with declared size limits and must
match SHA256SUMS before becoming installable. HTTPS GitHub checksums establish
integrity from that repository; they are not a separate signed-update protocol.

Android also validates the APK package ID, exact version name, newer version
code, non-debuggable application and matching installed signing certificate.
The user grants “install unknown apps” permission and approves the Android
installer. There is no silent installation. Notification permission is requested
when an update is first found; in-app notices still work without that permission.

Desktop opens the verified EXE or architecture-specific DMG. Linux downloads an
AppImage and can launch it alongside the current installation, without replacing
package-managed files or killing running windows. DEB/RPM users can install the
matching release asset through their package manager. Save/close existing windows
before opening an update. The previous managed local install remains available.

Update checks run off the UI thread, use bounded responses/timeouts, and do not
poll continuously in the background. Network failures never block note access.
