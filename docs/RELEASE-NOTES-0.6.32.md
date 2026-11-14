# Super MD 0.6.32

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

Markdown ZIP exports now expand slider states into consecutive static figures with their text and formulas, convert custom diagrams/charts and SVG blocks to linked SVG assets, and retain Obsidian callouts, math, Mermaid and ordinary code. Export never executes Python or changes the source note. Invalid unsupported blocks report a conversion error instead of silently losing content.

Diagram context menus now offer Copy image, using a real PNG clipboard payload on desktop and a shared PNG URI on Android. This includes authored SVGs, images, declarative trees/diagrams and slider frames. Agent diagram listings now include individual slider frames with process title, step label, step index/count and direct asset references; retrieve any frame by its revision-guarded diagram ID without changing slider position.

Sequential agent requests can immediately follow a completed response. PDF callout titles stay with their first body paragraph instead of being stranded at the bottom of a page.

PDF paragraph-spacing controls now produce the requested visible gap instead of being collapsed against line leading. Lecture/section headings have a clearer size hierarchy and space around tables is restored, while keeping print layout more compact than the reading view.

The installed CLI now installs the complete skill, invokes the same named MCP tools, renders real offline-reader PNG previews, and starts/stops the background service. MCP can preview saved notes without an open application window. Background previews preserve unsaved buffers. The tray offers Open, Recent notes and safe Quit; local agent access remains explicit through service mode or settings. GitHub documents installation and configuration commands.
