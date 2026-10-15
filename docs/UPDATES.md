# Updates

Settings → About & updates shows the installed version. Startup checks are enabled
by default; automatic downloads are off by default. Turning checks off keeps the
app fully offline unless you explicitly check. Notes are never uploaded.

Checks use this repository's latest published, stable GitHub Release. Drafts,
prereleases, older versions, missing assets and untrusted asset URLs are rejected.
Downloads are streamed to temporary files with declared size limits and must
match SHA256SUMS before becoming installable. HTTPS GitHub checksums establish
integrity from that repository; they are not a separate signed-update protocol.

Android also validates the APK package ID, exact version name, newer version
code, non-debuggable application and matching installed signing certificate.
The user grants “install unknown apps” permission and approves the Android
installer. There is no silent installation. Notification permission is requested
when an update is first found; in-app notices still work without that permission.

Installers are saved in Downloads and their verified ready state is remembered
across app restarts and repeated checks. Restoring a download rechecks its size
and SHA-256 without needing a network connection. Missing or modified installers
are not trusted. Desktop keeps downloaded installers, including after upgrading.

Desktop opens the verified EXE or architecture-specific DMG with normal OS
approval. On portable Linux builds, Install update extracts the verified AppImage
without FUSE into a versioned per-user installation and atomically changes the
stable launcher. It does not start a competing instance, kill windows, or rewrite
notes. Close and reopen Super MD to use the new version. The old installation is
kept for rollback. DEB/RPM installs use the matching release package and the system
package manager; the updater never replaces system-managed files.

### Optional Linux desktop integration

Portable Linux onboarding and Settings offer **Add to Applications
(experimental)**. It starts off. Enabling it creates a per-user launcher,
application entry, icon and Open With associations. It does not change default
apps or overwrite unrelated launchers. AppImage integration creates a managed
local installation, so moving the downloaded AppImage later does not break the
application entry. Turning the setting off stops future automatic registration;
it does not uninstall an existing entry. Package-managed builds do not show this
option because their installer already registers the application.

### Android Downloads and cleanup

Android stages the verified APK in private app storage and publishes a copy to
Downloads → Super MD using the system Downloads provider. Android 8–9 asks for
storage permission for the public copy; refusing it does not prevent a private
verified installation. Modern Android needs no broad storage permission.

The app restores a ready APK after restart. Opening or cancelling the installer
does not delete it. Only after observing the requested version/code installed on
a later launch does it remove its owned installer copies. Unrelated downloads
and user notes are untouched. This automatic deletion applies to Android only.

Update checks run off the UI thread, use bounded responses/timeouts, and do not
poll continuously in the background. Network failures never block note access.
