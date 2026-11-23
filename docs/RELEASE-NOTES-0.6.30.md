# Super MD 0.6.30

## Compact, responsive step cards

- Image-only sequences devote the card to the diagram, with a thin control strip and optional explanations. Redundant title banners and visible “Choose step” text are removed.
- Rich steps support a `markdown` body with normal Markdown and LaTeX. Wide layouts put it beside the visual; portrait layouts stack it below. Content is bounded by the window height and scrolls independently of the controls.
- Left/Right keys navigate while hovering or focusing a card, without stealing text-editor cursor keys. Existing step images, charts and tree diagrams remain supported.
- Fixed inherited reader padding that created a large blank area beneath rich step text on Android.

## More readable PDF exports

- Rich visual/Markdown pairs retain formulas and formatting in PDF. Longer image sequences use two larger columns, with a maximum of three columns for short sequences.
- New export defaults use 14 mm margins, 1.4 line height, 0.65 em paragraph spacing and Manrope. Existing saved export settings are preserved.
- Callout icons stay inline with their titles, and standalone bold labels stay with the following content.

## Complete study-note skill

- The public skill now includes source coverage, concise teaching, tutorial question/solution formatting and visual-authoring guidance, plus a compact tree reference image.
- Native builds include the complete `super-md-skill.zip` and unpacked package, rather than only an entrypoint whose reference files were absent.
- Personal profiles and connection credentials are excluded from the public package.

The complete study-note skill now documents contrast, theme adaptation, large labels and substantial action arrows. Standalone agent setup exports preserve their installable skill header and full connection instructions.
