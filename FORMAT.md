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
