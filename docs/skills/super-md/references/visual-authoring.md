# Diagram and interaction guide

For visual notes, open the bundled `assets/study-visual-example.svg` with an image viewer (render to PNG first if needed). Reading this paragraph alone does not inspect the image. Use it as a style reference, never as subject evidence. A user-supplied newer reference takes precedence.

## Choose the medium

Use a diagram only when spatial structure, a changing state or a quantitative relationship benefits from it. Use Matplotlib for checked scientific plots; SVG for controlled geometry and publication-quality labels. Use Mermaid for simple conceptual flows when its layout is suitable. Avoid Mermaid for exact binary-tree slots, rotations, B-tree splits, routed arrows or diagrams whose meaning depends on a fixed geometry: automatic layout can straighten/reroute edges or shift subtrees. Use fixed-coordinate SVG or the supported declarative tree renderer instead.

For trees, preserve left/right child slots, parent-child connectivity, object IDs and the mental map across frames. Draw edges behind nodes, terminate arrows at node boundaries, distinguish crossings from junctions, and show the pivot, moved subtree and affected links explicitly. Use separate before/action/after states when a rotation, deletion, recolouring or split would otherwise skip a reasoning step. More steps should expose meaningful changes, not add duplicate pause screens. Always show the finished state and verify the invariant.

## Composition

Keep a consistent palette, readable sans-serif labels, stroke widths and object sizes across a document. Colour is not the only semantic signal: include labels, shapes, +/- or R/B as appropriate. Light/dark themes and white PDF paper must preserve contrast. No white annotation boxes with pale text. No overlap, clipped labels, false connections or stretched plots.

Make the useful drawing fill its viewport. Crop unused canvas; inspect the actual content bounds, not merely the SVG viewBox. For Matplotlib use tight layouts and deliberate plot bounds, with enough padding to retain axis labels. Do not embed a second title, step label, paragraph or tiny bottom legend inside an image if the surrounding note already supplies it. Put essential labels next to the relevant object; use one concise nearby legend only when needed. Avoid tiny captions and ornamental empty panels.

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
