# Super MD 0.6.33

## Slides that use the available space

- SVGs and images scale up to fit their slide instead of stopping at their intrinsic pixel dimensions. Image-only cards fit the drawing and window proportions without a large empty frame.
- Step labels sit beside the drawing on wide layouts and in the slide body on portrait screens. The navigation strip contains only Previous, the slider, Next and the step count.
- Removed the three-dot image overlay. Right-click or long-press still provides Copy image and image export.

## Enlarge the whole slide

- Opening a slider image or diagram opens the complete slide, including its Markdown/LaTeX and next/previous controls. Left/Right navigates slides; Escape closes the viewer while preserving the selected step.
- The visual has its own zoom/pan pane. Pinch, wheel and keyboard zoom clip at its boundary, leaving the separate text panel readable and independently scrollable. Fit restores the image; moving to another slide resets its zoom.
- Portrait layouts stack the panels, keep navigation fixed, and use the available viewport. Switching frames no longer crossfades overlapping diagram states.

Validated responsive layouts, enlarged-slide navigation, text scrolling, zoom/pan clipping, image-viewer cleanup and image copy/export with browser tests.
