# Super MD maintenance and releases

- Preserve existing user notes, recovery state and working installed binaries.
- The user's release handoff includes a **published GitHub Release**, not just
  pushed commits, an open PR, local downloads or Actions artifacts. Remember this
  for future updates: include the signed Android release APK and Linux, Windows
  and both macOS architecture installers, with useful release notes.
- Only distribute optimized, non-debuggable **release** APKs. Preserve Android's
  existing upgrade certificate; do not silently switch signing keys or upload
  private keystores to GitHub. CI signing uses repository secrets. When those are
  absent, attach the locally signed release APK to the draft before publishing.
- Keep the release draft until relevant CI, all platform builds and the complete
  asset checks pass. Verify the public release and its download URLs afterward.
- Synchronize package, Tauri/Rust and Android versions before tagging. Never move
  or overwrite an existing published version tag to hide a regression.
- Native Android tests run on an emulator unless the user grants phone testing.
  Render calibration tests must be isolated from app startup and wait for real
  presented pixels; never remove painting assertions merely to turn CI green.
- Serialize local heavy builds with resource limits. Do not shut down the laptop
  or kill unrelated processes. Preserve the previous working release for rollback.
