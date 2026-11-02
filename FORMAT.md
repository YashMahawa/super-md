# Super Markdown features and compatibility

In version 0.4.0, `.md` is plain Markdown and `.smd` is a portable container
holding Markdown and images. Old text `.smd` and portable `.fmd` files remain
readable. New portable files use `"format":"supermd-smd"`; their source editor
shows Markdown only. The complete current guide is
[docs/AUTHORING.md](docs/AUTHORING.md). The Markdown features below work in
plain `.md` and inside portable `.smd` alike.

## Callouts

Obsidian-compatible form:

```markdown
> [!WARNING] Check the assumption
> This approximation fails near the boundary.
```

Super MD form:

```markdown
:::callout warning "Check the assumption"
This approximation fails near the boundary.
:::
```

Common types include `note`, `tip`, `info`, `warning`, `danger`, `example`, and `success`.

## Interactive chart

````markdown
```smd-chart
{
  "title": "Damped oscillation",
  "x": { "min": 0, "max": 12, "label": "time" },
  "series": [
    { "name": "signal", "expression": "a * Math.exp(-d*x) * Math.cos(w*x)" }
  ],
  "sliders": [
    { "name": "a", "label": "Amplitude", "min": 0.2, "max": 3, "step": 0.1, "value": 1 },
    { "name": "d", "label": "Damping", "min": 0, "max": 1, "step": 0.05, "value": 0.2 },
    { "name": "w", "label": "Frequency", "min": 0.5, "max": 6, "step": 0.1, "value": 2 }
  ]
}
```
````

Expressions receive `x`, each slider name, and JavaScript's `Math` object. A series may instead provide literal `points` as `[[x, y], ...]`.

## Step-by-step cards

Use a `smd-steps` fenced block when several diagrams show consecutive stages of
one operation. Super MD shows **one stage at a time** with Previous/Next buttons,
a draggable slider, and Left/Right keys while the card has focus. It is supported
by the shared desktop and Android reader.

````markdown
```smd-steps
{
  "title": "Heap insertion",
  "steps": [
    {"label": "Before", "image": "assets/heap-before.svg", "description": "Start with a valid heap."},
    {"label": "Append", "image": "assets/heap-append.svg", "description": "Insert at the next free leaf."},
    {"label": "Sift up", "image": "assets/heap-after.svg", "description": "Swap until the parent dominates."}
  ]
}
```
````

Each step needs a short `label`, plus an `image`, a `diagram`, a `chart`, or a `description`.
Only one visual (`image`, `diagram`, or `chart`) is allowed per step. `alt` can describe a diagram for screen readers. Images follow normal
relative-asset handling, including embedded `.smd` assets and remote-image
consent rules. A deck supports **2–40 steps**, with no executable HTML/JS.
Existing Mermaid/SVG diagrams and Markdown remain unchanged.

## Inline SVG diagrams and binary trees

For diagrams that change over time, Super MD supports **safe declarative SVG** in
`smd-diagram` blocks. Specify an explicit canvas and nodes with stable `id`,
`label`, `x`, `y`, optional `state` (`normal`, `active`, `visited`, `muted`), plus
edges by node ID. The renderer draws native SVG with no executable HTML/JS.

````markdown
```smd-diagram
{"title":"Graph traversal","width":360,"height":180,
 "nodes":[{"id":"A","label":"A","x":180,"y":45,"state":"active"},
          {"id":"B","label":"B","x":90,"y":140},
          {"id":"C","label":"C","x":270,"y":140}],
 "edges":[{"from":"A","to":"B"},{"from":"A","to":"C"}]}
```
````

### Mixed step cards with interactive 2D graphs

Step decks can display the **same `smd-chart` model** as an inline interactive
2D graph, complete with panning, zoom, numeric probes, grid controls and its
own parameter sliders. Add the graph model as a `chart` object on any step.
The outer Next/Previous/step slider is independent from each graph's controls.
A graph you have visited stays mounted while exploring other steps, retaining
its interactive state. Both original `smd-chart` blocks and mixed decks work
on desktop and Android.

````markdown
```smd-steps
{
  "title":"Understanding waves",
  "steps":[
    {"label":"Start with the basic wave", "description":"Notice the peaks and roots.",
      "chart":{"title":"Sine wave","series":[{"name":"Signal","expression":"sin(a*x)"}],
        "x":{"min":-6,"max":6},"sliders":[{"name":"a","min":0.5,"max":3,"value":1,"step":0.1}]}},
    {"label":"See the graph as a diagram", "description":"A few labeled points.",
      "diagram":{"title":"Signal landmarks","width":420,"height":180,
        "nodes":[{"id":"A","label":"0","x":70,"y":90},
                 {"id":"B","label":"peak","x":210,"y":45},
                 {"id":"C","label":"zero","x":350,"y":90}],
        "edges":[{"from":"A","to":"B"},{"from":"B","to":"C"}]}}
  ]
}
```
````

These are built-in safe components, not an arbitrary executable webpage or a
copy of ChatGPT's private UI renderer. Rendering and interaction stay local.

For **binary trees**, use `smd-tree` to preserve left/right slots without
vertical single-child ambiguity. Use `null` for an empty slot. The array uses
0-based heap indices (left child `2*i+1`, right child `2*i+2`), up to 15 slots.

````markdown
```smd-tree
{"title":"Max heap","values":["50","30","40","10","20","35"],"highlight":[5]}
```
````

Both objects can also be supplied as a `diagram` property on any `smd-steps`
slide, alongside its `label` and `description`. All steps then update a single
SVG rather than repeatedly constructing an image; use consistent node IDs for
animated highlighting and position changes.

## Python and Matplotlib

````markdown
```python
import matplotlib.pyplot as plt
plt.plot([1, 2, 3], [1, 4, 9])
```
````

Choose any system Python or virtual-environment interpreter in Settings. Code never runs automatically. Figures are captured as SVG for crisp zooming.

## Images

Use ordinary Markdown paths. Paths are relative to the document:

```markdown
![Free body diagram](images/free-body-diagram.png)
```

There are no vault-relative links or required metadata sidecars. Dropping,
pasting or inserting an image uses a short `assets/import-….svg` (or raster
extension) reference. On Markdown save, the app copies those images into an
ordinary `assets` directory beside the note. On Android, grant access to the
destination folder before saving Markdown with imported images; a single-file
picker cannot grant access to siblings.

SVG files work as Markdown images. A fenced `svg` block also renders as a
diagram and exports as a vector image. Use self-contained SVG: scripts,
embedded HTML and external SVG resources are rejected in fenced diagrams.
Mermaid and `smd-chart` source stays interactive in the app; PDF export captures
static diagrams. Animated images export their decoded first frame.

## Portable Super MD (`.fmd`, version 1)

Choose **Export portable .fmd** to share a note and its images as one file.
Opening `.fmd` shows only its clean Markdown in Source mode. Its embedded images
resolve without a separate folder grant. You can edit and save it normally;
the image bytes never appear in the source editor or recovery snapshot.
Python and diagram source blocks are preserved, and code never runs implicitly.

The file is a UTF-8 JSON envelope, not a renamed Markdown file:

```json
{
  "format": "supermd-fmd",
  "version": 1,
  "markdown": "![Diagram](assets/image-example.svg)",
  "assets": {
    "assets/image-example.svg": "data:image/svg+xml;base64,…"
  }
}
```

Asset names must be a single safe filename under `assets/`. Supported image
types are PNG, JPEG, SVG, GIF, WebP and AVIF. Limits: 20 MB of Markdown, 25 MB
per image, 75 MB total decoded assets, 512 images, and 120 MB total file size.
Remote images are fetched only during an explicit insertion or export; link
previews do not run when opening someone else's document. Export needs network
access only for images which have not already been downloaded or embedded.

The app preserves the Markdown source when preparing `.fmd`, rewriting only
image references (including reference-style images). External hyperlinks remain
links, not archived web pages. Unrun Python source is included; transient cell
outputs are not part of FMD v1. Run trusted cells again after reopening to
include their figures in PDF export.
