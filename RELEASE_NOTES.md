# Super MD 0.6.25

## Interactive diagrams and portable notes

- Portable `.smd` export now embeds images referenced inside interactive `smd-steps` decks, including heap, BFS and DFS illustrations. Shared images are deduplicated and step-by-step interactions remain intact after reopening.
- The compact desktop toolbar menu now uses an opaque, palette-matched background with SVG action icons and suppresses overlapping tooltip bubbles.
- Windows document saving retries brief file-sharing locks from antivirus or indexers without compromising atomic writes.

## Verification

- Adds regressions for embedded step-deck images, small-window native Qt menu painting, and Windows sharing-lock recovery.
- Release publication requires successful CI on the exact release commit, verified Android signing, and all platform installers.
