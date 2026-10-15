# Custom themes

Super MD themes are small, editable JSON files. A single file styles native desktop and Android controls and the reading pane: light/dark palettes, typography, code blocks, callouts, corners and background patterns. You can write one yourself or give this guide and an exported template to an AI.

Themes never change a note, its images, or its portable assets. Reading font, text size, width, zoom and PDF layout remain normal user settings. Themes do not execute CSS, JavaScript, Python or QML, and cannot fetch fonts, pictures or other network resources.

Image appearance remains a separate, opt-in viewing setting. **Auto adapt** recolours every photo and SVG with the active accent and page colours, including imported themes; it preserves shading and alpha and guards the foreground/background contrast. **Separate from theme** preserves original image pixels and adds a legible backing and edge instead of boosting image contrast. Both can be set independently for images and SVGs; Original is the default. These adjustments do not rewrite assets or apply to PDF exports.

The lock immediately after the fullscreen button keeps the document horizontally centered while scrolling and zooming. It starts enabled, is remembered across launches, and can be unlocked for free horizontal movement. It does not lock graph or image-viewer cameras. Pinned recent notes use a small indicator only; pin/unpin via right-click on desktop or long press on Android.

## Start with a template

1. Open Settings → Custom theme → Export template. When a custom theme is active this exports that theme instead.
2. Edit the JSON in any text editor, or ask an AI to edit it using this reference.
3. Choose Import theme and select the edited `.json` file.
4. Change the workspace/fullscreen appearance to preview its light, dark and pure-black variants.

Example files are in [`public/themes`](../public/themes). File extensions are descriptive; the required format marker is authoritative. UTF-8 with or without a BOM is accepted. Files are limited to 64 KiB. Unknown properties, invalid colors, unsupported versions and out-of-range values are rejected, rather than silently ignored.

```json
{
  "format": "supermd-theme",
  "version": 1,
  "name": "Copper grid",
  "accent": "amber",
  "variants": {
    "light": {
      "colors": {
        "surface": "#eadfd1",
        "surface-low": "#e0d0bb",
        "surface-high": "#ceb79a",
        "text": "#30251b",
        "heading": "#56351e",
        "link": "#6f3d1e"
      },
      "background": {
        "pattern": "grid",
        "color": "#794d2b",
        "opacity": 0.045,
        "spacing": 28,
        "angle": 0
      }
    }
  },
  "metrics": {
    "controlRadius": 18,
    "contentRadius": 12,
    "paragraphSpacing": 1.25,
    "codePadding": 18,
    "headingWeight": 750,
    "headingTracking": -0.02,
    "textTracking": 0,
    "tableBorderWidth": 1
  }
}
```

## Root fields

| Field | Meaning |
|---|---|
| `format` | Required: exactly `supermd-theme`. |
| `version` | Required: integer `1`. |
| `name` | Required: 1–80 printable characters; no control characters or `<`/`>` brackets. Plain text, not markup. |
| `accent` | Optional base palette: `blue` (default), `violet`, `rose`, or `amber`. |
| `variants` | Optional object containing any of `light`, `dark`, `black`. |
| `metrics` | Optional layout/style values from the table below. |

The base palette supplies every unspecified role. Workspace and fullscreen settings still choose the appearance mode. System mode selects the variant using the OS's light/dark preference. An omitted `black` variant retains the built-in neutral pure-black palette, not the dark variant. Your manual/system accent preference is remembered but an imported theme's `accent` takes priority until Reset to built-in.

Each variant accepts only `colors` and `background`. Colors must be opaque six-digit `#RRGGBB` strings. No named colors, alpha channels, CSS expressions, selectors, imports or URLs are supported.

## Color roles

| Roles | Scope |
|---|---|
| `primary`, `on-primary` | Native selected controls, actions and their text; reader accent. |
| `primary-container`, `on-primary-container` | Native tonal/selected containers. |
| `surface`, `surface-low`, `surface-high` | Reading paper, surrounding chrome/sidebar, raised controls. |
| `text`, `muted`, `outline` | Shared foreground, secondary text and separators. |
| `heading`, `link` | Reading headings and links. Visited links remain visually distinct. |
| `code-bg`, `code-text`, `code-border` | Rendered code blocks. Source syntax highlighting keeps the editor's normal theme. |
| `callout-tip`, `callout-warning`, `callout-danger`, `callout-info`, `callout-example` | Reader callout accents. Related types share each family: success/check; caution; error/failure; question; abstract/summary. |

Core native text pairs are corrected to readable contrast. If supplied paper/chrome colors are so far apart that no common readable foreground exists, chrome surfaces are aligned with the paper. Reader heading/link/callout and code text also receive contrast safeguards. Choose coherent surfaces yourself for the most faithful result. Patterns should be subtle enough not to compete with equations and text.

Android retains native Material component behavior and platform-specific control shapes. Desktop exposes action-button/segmented-control corners; Android's shape system applies corner preferences to components that use its theme shapes. A theme is not an arbitrary replacement for either platform's layout or gesture model.

## Metrics

All are optional finite numbers. Pixels are logical CSS px in the reader and native logical units for controls, so they adapt to screen density.

| Field | Range | Purpose |
|---|---|---|
| `controlRadius` | 0–28 | Native themed component corners. |
| `contentRadius` | 0–32 | Reader code, callout, image and chart corners, px. |
| `paragraphSpacing` | 0.5–2.5 | Paragraph margins, em. |
| `codePadding` | 8–32 | Code-block padding, px. |
| `headingWeight` | 400–900 | Heading font weight. |
| `headingTracking` | −0.05–0.1 | Heading letter spacing, em. |
| `textTracking` | −0.03–0.1 | Reading text letter spacing, em. |
| `tableBorderWidth` | 0–3 | Table cell border width, px. |

Reading fonts and sizes are deliberately not overridden by theme files; import/select fonts in normal reading settings. PDF font and spacing choices remain in Export/Share.

## Background patterns

`background` belongs to a variant and affects the reading area's background, not images, native toolbars or export output.

Omit it or set it to `null` to leave the paper undecorated. Unspecified colors and metrics keep their normal app styling.

| Field | Allowed values |
|---|---|
| `pattern` | Required: `none`, `dots`, `grid`, `diagonal`, `gradient`. |
| `color` | Required: `#RRGGBB`. |
| `opacity` | 0–0.15; default 0.06. |
| `spacing` | 12–96 logical px; default 24. Pattern pitch, unused for a gradient. |
| `angle` | 0–360 degrees; default 0. Gradient direction; diagonal uses 45° when 0 is specified. |

Only a few fixed CSS gradient primitives are generated. There are no remote or embedded image backgrounds, animations, filters, overlays that intercept input, or expensive custom shaders. Normal text selection, search, hyperlinks, zoom and touch gestures keep working.

## Editing, persistence and recovery

Desktop watches the selected source file and its parent using filesystem notifications, with a short debounce for editor saves. Atomic-save editors are supported. Changes are validated off the UI thread. Malformed/partial edits leave the last valid appearance active. The app retains a private validated copy across restarts, including when the original file is temporarily missing. Edit theme file opens the original source in its associated editor; Reload retries it.

Android keeps the validated theme in private preferences and remembers the selected document provider URI where permission permits. Providers supporting notifications can reload edits automatically. Others can use Reload file or re-import the updated file. The app also retries on resume; unavailable/denied sources do not discard the last valid theme. A theme is shared across the app's windows.

Reset to built-in removes the app's theme selection and private cached copy/preferences. It does not delete the original theme file, exported templates, notes, fonts or assets. Palette-only edits update CSS variables/native colors without reparsing Markdown or replacing cached math trees. Typography changes necessarily remeasure text and use the existing reading-anchor restoration.

## PDF and portable notes

Themes are viewing preferences, not part of SMD/legacy FMD documents. An exported SMD does not change another person's app theme. PDF remains controlled by the Export/Share options: normal PDFs keep their standard typeset appearance; themed PDF uses its existing accent option, not custom patterns, UI corners or reading metrics. No browser DOM screenshot/print path is introduced.

## AI authoring request

Give an AI this guide plus a template, then describe your desired palette and pattern. For example:

> Produce one valid Super MD version-1 theme JSON file, with no commentary or code fences. Use only the documented fields, color roles and ranges. Make coherent light and dark palettes with readable controls, a subtle background pattern, restrained heading typography, and a neutral pure-black mode by omitting its variant. Keep reading fonts and sizes under the user's control. Do not add CSS, scripts, URLs or unsupported fields.

Validation errors identify the unsupported field/range. Fix the file and retry; there is no need to alter the application or a document. Developers can validate without launching the GUI:

```sh
smd-engine validate-theme < "My theme.supermd-theme.json"
```

The result contains either `theme` (canonical, default-filled JSON) or `error`. Both desktop and Android use this same native validator.

## Release separation

Theme support is delivered separately from the [0.5.2 reliability release](https://github.com/YashMahawa/super-md/releases/tag/v0.5.2), whose tested installers remain available. Use Reset to built-in first if a theme feels wrong. Android normally prevents installing an older version over a newer one; do not uninstall to experiment with rollback unless your notes and recovery data are safely backed up.
