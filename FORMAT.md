# Super Markdown (`.smd`) format

`.smd` is Markdown, not a binary container. Any text editor can open it and any Markdown tool can render the standard parts. Super MD adds fenced blocks that degrade to readable code blocks elsewhere.

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

There are no vault-relative links, attachment databases, or proprietary metadata.
