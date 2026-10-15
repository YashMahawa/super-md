# Release sequence

## First release: reliability and everyday reading

Published as [0.5.2](https://github.com/YashMahawa/super-md/releases/tag/v0.5.2) after exact-commit CI and all seven packaged-platform checks passed. Its installers remain intact.

- Opening, dragging and panning images/SVGs must never insert new document blocks.
- Fullscreen scrolling hides controls; it never reveals them. Deliberate taps and desktop top-edge hover remain available.
- Separate optional image/SVG viewing adjustments: original (default), invert in dark themes, adapt to theme, and contrast adjustment. These do not rewrite assets or exported PDFs.
- Ten recent documents maximum, pinned documents first and protected from eviction.
- Remember reading positions by default, with a setting to disable restoration.
- Restore previous tabs by default, or start blank by preference. Recover unsaved drafts regardless; Welcome is first-use only.
- Prevent overlapping close confirmations and callbacks after desktop shutdown. The precise Fedora report still needs independent reproduction; do not describe it as fully verified without that evidence.
- Detect portable SMD and legacy FMD envelopes by content when sharing providers omit or change extensions.
- Use native file/provider notifications for rename, delete and opened-folder updates, not polling. Preserve dirty deleted notes in recovery. Closing the last deleted tab leaves a blank note and an open window.
- Optimize large-file theme changes, scrolling and memory without changing source or degrading content.
- Test native desktop, the shared reader, Android and packaged cross-platform assets before publication.

### Platform limits

Native notifications are bounded to open files, recent files and the opened/expanded folder. Desktop rename reconciliation examines only the affected parent directory, never the entire disk. Moves to an unrelated, unobserved directory cannot always be followed. Android document providers control whether notifications and stable document identifiers are available; failed or denied queries must never be treated as deletion.

## Second release: custom theming

[Version 0.6.1 is published](https://github.com/YashMahawa/super-md/releases/tag/v0.6.1), separately from 0.5.2, with all seven installers and SHA256SUMS. All nine jobs in [release-commit CI](https://github.com/YashMahawa/super-md/actions/runs/38687923705) passed, including Android API 35/36 native emulator tests. [Installer verification and publication](https://github.com/YashMahawa/super-md/actions/runs/38691156297) passed clean-distribution Linux, installed Windows EXE, both mounted macOS DMGs, signed APK and complete-asset checks. See [THEMING.md](THEMING.md) for the supported format and platform limits.

The earlier v0.6.0 candidate was never published. Its tag is retained unchanged; 0.6.1 incorporates the requested accent-aware image rendering, theme-relative separation, subtle pin controls and persistent centre lock before publication.

Custom theming is required work, not an optional future suggestion. Implement it only after the first release passes verification and is published. Provide editable, documented theme files covering native controls and the reading pane, including background patterns and an AI-friendly authoring reference. Do not allow themes to execute code or silently fetch remote resources. Keep the first release and its installers available for rollback; never rewrite a published tag.

## Follow-up stable release: 0.6.2

Published [0.6.2](https://github.com/YashMahawa/super-md/releases/tag/v0.6.2) adds opaque desktop note menus with non-overlapping path hints, dependable recent-note hover states, colour-preserving Auto adaptation and a separate monochrome mode, adjustable paw backgrounds, and portable artwork across reader/sidebar/toolbars. Static SVG, PNG, JPEG and WebP can be reused through embedded assets and shared between Android and desktop. Detailed third-party artwork used for private visual evaluation is not included in the repository or installers.

This is a normal stable update, not an experimental channel. All nine jobs in [exact-source CI](https://github.com/YashMahawa/super-md/actions/runs/38734625586) passed on `bbe9de00757fbec440d9b6a1267e647d4f3d7a01`, including both Android API 35/36 emulator suites. [Installer verification and publication](https://github.com/YashMahawa/super-md/actions/runs/38772509739) passed all seven packages: clean Ubuntu/Debian/Fedora installations, installed Windows EXE, both mounted macOS DMGs, signed release APK and complete-asset/checksum gates. The public stable release includes all seven installers and SHA256SUMS; each public download URL was checked after publication. Earlier published releases remain available for rollback.
