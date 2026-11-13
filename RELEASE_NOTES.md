# Super MD 0.6.27

## Compact diagram grids in PDF exports

- Interactive step sequences now export every frame as a diagram grid with at most three columns. Short sequences use two or three columns; longer sequences continue in reading order across rows and pages.
- Diagram labels and descriptions stay with their frame. Equal-width cells, narrow gutters, natural image proportions and no slider chrome keep the PDF compact.
- Embedded SVGs, raster images, declarative node diagrams, binary trees and 2D charts are supported through the shared desktop/Android export pipeline. Image and text sequences also work in offline PDF exports.
- The original note keeps its interactive sliders. Invalid or unavailable frames report an export error instead of printing JSON or silently dropping stages.

## Image viewing without accidental editing controls

- Closing an image, SVG or slider-frame viewer no longer reveals Replace/Remove merely because focus returns to the source image.
- Image editing tools open explicitly through Image options or the image context menu. Keyboard focus alone keeps the reading view clean.

## Verification

- Regression checks cover all sequence frames, mixed diagram/chart decks, page-spanning grids, asset discovery and viewer focus restoration.
- Publication requires successful CI, signed Android release verification and all supported platform installer checks on the exact release commit.
