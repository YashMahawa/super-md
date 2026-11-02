# Super MD 0.6.23

## Interactive notes

- Step-by-step cards keep loaded diagrams in place while navigating, dynamically fit SVG height, and prevent diagram/explanation overlap.
- Interactive two-dimensional charts now work inside cards with independent zoom, panning, parameter sliders and state retention.
- Native inline SVG graphs and fixed binary-tree left/right child layout remain available on desktop **and Android**.

## Android and desktop Settings

- Android Storage offers a confirmation-based cleanup action for generated Python previews, protecting notes, recovery, exports and verified update APKs.
- Android Updates & about now provides **Open latest release on GitHub**.
- Desktop Updates and Storage are separate sections; Storage also offers constrained temporary-data cleanup.

## Verification and packaging

- Increased Intel macOS native test-suite watchdog without disabling any individual mouse, selection or gesture assertions.
- Corrected Windows app-owned temporary storage cleanup safety handling.
- Release publication remains gated on tagged-source desktop, Android and CI verification. Release APKs retain the existing upgrade certificate and are verified as signed, aligned, non-debuggable arm64 builds.

## Scope

The separate unfinished MCP changes are **not** part of this release.
