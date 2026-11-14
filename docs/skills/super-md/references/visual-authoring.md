# Diagram and interaction guide

For visual notes, open the bundled `assets/study-visual-example.svg` with an image viewer (render to PNG first if needed). Reading this paragraph alone does not inspect the image. Use it as a style reference, never as subject evidence. A user-supplied newer reference takes precedence.

## Choose the medium

Use a diagram only when spatial structure, a changing state or a quantitative relationship benefits from it. Use Matplotlib for checked scientific plots; SVG for controlled geometry and publication-quality labels. Use Mermaid for simple conceptual flows when its layout is suitable. Avoid Mermaid for exact binary-tree slots, rotations, B-tree splits, routed arrows or diagrams whose meaning depends on a fixed geometry: automatic layout can straighten/reroute edges or shift subtrees. Use fixed-coordinate SVG or the supported declarative tree renderer instead.

For trees, preserve left/right child slots, parent-child connectivity, object IDs and the mental map across frames. Draw edges behind nodes, terminate arrows at node boundaries, distinguish crossings from junctions, and show the pivot, moved subtree and affected links explicitly. Use clear, substantial action arrows only when they communicate an actual operation (rotation, moved item, traversal or changed link); do not add decorative motion arrows to every frame or confuse them with structural parent–child arrows. Match the clean bundled tree style: generous nodes, large labels, consistent thick edges, restrained highlights and no peripheral fine print. Use separate before/action/after states when a rotation, deletion, recolouring or split would otherwise skip a reasoning step. More steps should expose meaningful changes, not add duplicate pause screens. Always show the finished state and verify the invariant.

## Composition

Keep a consistent palette, readable sans-serif labels, stroke widths and object sizes across a document. Colour is not the only semantic signal: include labels, shapes, +/- or R/B as appropriate. Light/dark themes and white PDF paper must preserve contrast. No white annotation boxes with pale text. No overlap, clipped labels, false connections or stretched plots.

Make the useful drawing fill its viewport. Crop unused canvas; inspect the actual content bounds, not merely the SVG viewBox. For Matplotlib use tight layouts and deliberate plot bounds, with enough padding to retain axis labels. Do not embed a second title, step label, paragraph or tiny bottom legend inside an image if the surrounding note already supplies it. Put essential labels next to the relevant object; use one concise nearby legend only when needed. Avoid tiny captions and ornamental empty panels.

## Contrast and Super MD theme adaptation

Choose a small semantic palette and check every label against its actual local fill, not only the page background. Aim for at least 4.5:1 for ordinary text and 3:1 for meaningful edges/arrowheads; do not use these numbers to excuse small type. Use large, regular-to-medium weight labels and substantial strokes at the final displayed size. A practical SVG starting point is 28–36-unit labels and 4–5-unit main strokes on a roughly 1000-unit canvas, then inspect at the real reading/PDF width. These are starting proportions, not a substitute for checking. Avoid hairline connections, pale annotation text and tiny secondary labels. Simplify, enlarge or split the figure when it would otherwise need small type.

Super MD's **Diagram appearance** is separate from the page theme and from raster **Image appearance**. **Original** is the default and preserves authored colours. **Auto adapt** creates a display-only SVG variant: neutral paper/ink follow the current surface/accent, coloured nodes and series generally retain their hue, low-contrast colours may change lightness, and labels are checked against their local node fill. Arrowheads are adapted too. **Theme monochrome** maps towards theme ink/paper, so never encode categories by colour alone. **Separate from theme** preserves the artwork and adds a contrasting backing/boundary. None of these viewing settings rewrites the embedded asset or guarantees the same appearance in the PDF; export uses its own typesetting and source assets.

Author explicit, self-contained fills/strokes and legible text rather than relying on CSS variables, the host page's currentColor, or adaptation to repair an unreadable original. Keep text as SVG text when practical and labels after their node fills in painter order so local-background detection can work. Avoid unnecessary hard-coded background panels; use a deliberate complete background when the figure's meaning requires one. Retain stable semantic hues across all frames, with shapes, labels or line styles as redundant cues. Inspect Original and Auto adapt on light, dark and pure-black pages, plus the actual white-paper PDF. Auto adapt is bounded and cannot fix tiny text, collisions, missing arrows or ambiguous geometry. If adaptation damages a specific figure, repair its source or explain a suitable viewing mode; never silently change the user's global theme.

## Steps and rich content

For 2–3 visual states, prefer static side-by-side panels. For longer visual processes, use smd-steps when the target supports it. Do not put ordinary paragraphs into sliders merely because they have an order. When a visual explanation benefits from adjacent equations, use the renderer's Markdown/LaTeX step body, keeping notation consistent with the visual.

One short process title and one short current-state label are enough. Avoid “Watch ... change”, repeated “before the first assignment”, repeated legends and redundant captions. Place substantial reasoning in readable Markdown beside the visual on wide screens; stack it naturally on portrait phones. Never bake it into small text at the bottom of the SVG.

Supported rich step format (verify installed renderer capabilities before authoring):

```json
{"title":"Centroid update","steps":[{"label":"Assigned points","image":"assets/assigned.svg","markdown":"**Cluster 1** contains A and B.\n\n$$\mu_1=\frac{x_A+x_B}{2}$$"},{"label":"Updated centre","image":"assets/updated.svg","markdown":"The centre moves to the mean; the observations stay fixed."}]}
```

The illustrative two-frame schema above is for compatibility documentation; actual two-frame study figures normally use static panels. For plain Obsidian Markdown, provide static figures and ordinary Markdown/LaTeX; do not depend on Super MD-only slider fences. Bundle assets using relative paths. Do not assume a custom slider renders in Obsidian.

## Inspection

Render every new/changed figure, including every frame, at the expected reading width. Inspect desktop/wide and portrait sizes, arrow routing, label collisions, units, state transitions and final invariants. An SVG/XML check alone cannot establish readability. For PDFs, inspect the exported PDF itself: maximum three columns is a limit, not a reason to shrink dense diagrams into unreadable thumbnails. Prefer two columns or full-width rich steps when necessary, avoid splitting a diagram from its essential explanation, and allow the sequence to span pages.

## Mandatory render–inspect–repair loop

After generating a diagram, render and visually inspect every frame. Check text against arrows/edges, arrowheads against nodes, label collisions, clipping, readable type, contrast, consistent positions/colours/scales, and agreement with the calculation and final state. Inspect at the intended display sizes, including portrait and wide layouts, and the actual exported PDF when supplied. Fix any detected defect autonomously within the authorized document scope, rerender the changed figure, and inspect again until it passes. Do not deliver known anomalies or substitute an XML parse, a geometry heuristic, or a statement that verification was done for actually viewing the final render. If an environmental limitation prevents inspection, state that specific limitation rather than claiming it passed.

Finished PDFs must not contain filenames, asset IDs, contact-sheet labels (such as conv-1), debug text or inspection-only captions. Use only meaningful, readable labels required by the explanation. QA contact sheets stay in the working directory and are never delivered as the PDF.

For sharing with readers outside Super MD, export Markdown plus assets as a compatible ZIP: expand slider states into consecutive static figures with their Markdown/LaTeX, render custom diagram/chart blocks to ordinary SVG image references, and retain Obsidian callouts, math and supported Mermaid. Verify that no proprietary presentation fences remain and all relative asset references resolve after extraction. Keep the source SMD unchanged.

### Authoring and checking an interactive slide

Use the native slide format, rather than drawing a fake slideshow UI inside an SVG. Each step has a short `label`, at most one visual (`image`, `diagram` or `chart`), and an optional `markdown` body. The Markdown body supports normal paragraphs, lists and LaTeX. Keep substantial reasoning there; do not bake it into tiny image labels or repeat it as a second caption. Use only supported schema fields; do not invent positioning keys to request a left/right text rail.

On wide screens the renderer reserves a separate scrolling text pane beside the visual. Without a Markdown body, the artwork scales into the available space and the short state label uses a side area; portrait layouts stack naturally. The label belongs in the slide body, never to the left of Previous. The native strip supplies Previous, the range slider, Next and the step count. Do not duplicate those controls, counts or a three-dot image toolbar in the artwork.

Clicking a slider visual opens the whole slide, including its text and navigation. Left/Right changes steps in that enlarged view; Escape closes it while retaining the selected step. Zoom/pan belongs only to the visual pane and must stay clipped at the text boundary. The text remains readable and scrolls independently. Fit restores the visual, and selecting another step starts from its fitted view.

Inspect the actual displayed footprint: a tightly cropped SVG can still appear too small if its intrinsic dimensions cap scaling. The diagram should use its available pane while preserving aspect ratio; never stretch it or crop away essential content merely to fill a portrait screen. Check source canvas padding separately from renderer padding. When useful, put formulas beside the visual as Markdown instead of using an empty image margin for miniature text. Keep a stable viewBox and comparable object sizes across related frames.

Before handing off an interactive note, inspect inline and enlarged views at the intended wide/landscape and portrait sizes. Include a visual-only frame and a frame with text when present. Check that zoomed artwork cannot cover the text or controls, that text overflow scrolls separately, and that Left/Right, Escape and Fit work where those controls are available. Verify all final frame renders for clipped labels, overlapping states, arrows and contrast. Plain Obsidian/PDF delivery must still use the static adaptations described above.
