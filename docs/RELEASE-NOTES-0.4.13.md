# Super MD 0.4.13

- Android reading chrome and system bars hide together, without floating buttons.
  Tap or scroll upward to reveal controls; landscape uses the cutout region.
- Entering fullscreen preserves the current magnification and reading width,
  including an in-progress pinch. User gestures cancel pending heading alignment
  so link jumps cannot pull a focal zoom back to an earlier position.
- Python cells use one source container, with Copy and Run in its toolbar.
- Optional offline English spell check and basic grammar check are available in
  Settings on Android and desktop. Suggestions exclude code, links and LaTeX;
  corrections are explicit and undoable. Grammar checks repeated words and a/an,
  not comprehensive grammar or other languages. Checks run in a bounded worker.
- Interactive 3D graphs have been removed. Matplotlib-generated 3D figures remain
  supported in notes, portable files and native PDF exports. Old interactive 3D
  blocks retain their source and export as code, without blocking the whole PDF.
- Improved Open-with registration for MD, TXT, SMD and legacy FMD. Portable notes
  no longer show Save as Markdown. Added a Material rename icon.
- New diagonal brush-S mark, including fixed, adaptive and themed-icon variants.
  Removed the desktop sidebar icon animation and replaced workspace loading with
  expressive indicators.

Local verification: 95 frontend tests, 32 browser workflows, 62 Qt/Python checks
and 24 Android 15 emulator tests. Native desktop presented-pixel/PDF checks and
real Matplotlib 3D SVG-to-PDF export passed. Exact-source API 35/36 CI, signed
ARM64 release validation and all desktop installer builds gate publication.

Android requires Android 8+ and an ARM64 device. Emulator checks are not a claim
of testing every handset; system Open-with/default selection remains your choice.
