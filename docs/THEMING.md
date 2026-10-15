# Custom themes

Super MD themes are small, editable JSON files. A single file styles native desktop and Android controls and the reading pane: light/dark palettes, typography, code blocks, callouts, corners and background patterns. You can write one yourself or give this guide and an exported template to an AI.

Themes never change a note, its images, or its portable assets. Reading font, text size, width, zoom and PDF layout remain normal user settings. Themes do not execute CSS, JavaScript, Python or QML, and cannot fetch fonts, pictures or other network resources.

Image appearance remains a separate, opt-in viewing setting. **Auto adapt** adapts neutral ink and paper to the current accent and page while preserving readable colours. For SVG diagrams it checks labels against local node backgrounds and adjusts poorly contrasted coloured marks without flattening their hue. For raster images it adapts near-neutral pixels and retains colourful pixels. **Theme monochrome** keeps the earlier full-image accent duotone effect as a separate choice. **Separate from theme** preserves original pixels and adds a legible backing and edge instead of boosting image contrast. Images and SVGs have independent settings; Original is the default. These are display variants, never rewrites of assets or PDF sources.

The lock immediately after the fullscreen button keeps the document horizontally centered while scrolling and zooming. It starts enabled, is remembered across launches, and can be unlocked for free horizontal movement. It does not lock graph or image-viewer cameras. Pinned recent notes use a small indicator only; pin/unpin via right-click on desktop or long press on Android.

## Start with a template

1. Open Settings → Custom theme → Export template. When a custom theme is active this exports that theme instead.
2. Edit the JSON in any text editor, or ask an AI to edit it using this reference.
3. Choose Import theme and select the edited `.json` file.
4. Change the workspace/fullscreen appearance to preview its light, dark and pure-black variants.

Example files are in [`public/themes`](../public/themes). File extensions are descriptive; the required format marker is authoritative. UTF-8 with or without a BOM is accepted. Files are limited to 2 MiB, including embedded artwork. Unknown properties, invalid colors, unsupported versions and out-of-range values are rejected, rather than silently ignored.

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
| `assets` | Optional reusable embedded SVG/PNG/JPEG/WebP images; up to eight named entries. |

The base palette supplies every unspecified role. Workspace and fullscreen settings still choose the appearance mode. System mode selects the variant using the OS's light/dark preference. An omitted `black` variant retains the built-in neutral pure-black palette, not the dark variant. Your manual/system accent preference is remembered but an imported theme's `accent` takes priority until Reset to built-in.

Each variant accepts `colors`, `background` and `artwork`. Colors must be opaque six-digit `#RRGGBB` strings. No named colors, alpha channels, CSS expressions, selectors, stylesheet imports or remote URLs are supported.

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
| `pattern` | Required: `none`, `dots`, `grid`, `diagonal`, `gradient`, `paws`. |
| `color` | Required: `#RRGGBB`. |
| `opacity` | 0–0.25; default 0.06. Visibility: 0 hides the pattern. Around 0.06–0.12 is usually comfortable for reading. |
| `spacing` | 12–192 logical px; default 24. Distance between repeats, unused for a gradient. For paws try 80–120. |
| `size` | 8–64 logical px; default 24. Paw size, independently adjustable from spacing; capped at 80% of pitch to prevent overlap. Other patterns ignore it. |
| `angle` | 0–360 degrees; default 0. Paw rotation or gradient direction; diagonal uses 45° when 0 is specified. |

Patterns use fixed gradients or a tiny application-owned SVG repeat tile for paws. Theme files cannot supply image URLs, SVG markup, CSS or scripts. There are no animations, overlays that intercept input, or expensive custom shaders. Normal text selection, search, hyperlinks, zoom and touch gestures keep working. Background-only changes do not reparse the note or remeasure its text.

For a cat-paw reading background, use this in either variant and edit its visibility, size and spacing independently:

```json
"background": {"pattern":"paws","color":"#97674b","opacity":0.10,"size":28,"spacing":96,"angle":342}
```

Paw backgrounds require a build with the `paws` pattern extension; older releases reject the unsupported pattern and keep their last valid theme.

After importing, **Settings → Custom theme → Reading background** provides a pattern picker and visibility, paw-size and spacing sliders on desktop and Android. Visibility 0 hides the pattern. **Use theme's background settings** restores the file's original values. These adjustments persist as private preferences and never edit the imported file. Export and Share theme include the adjustments for every supplied light/dark variant; Android Share opens the system share sheet with a portable JSON file. Desktop Share saves that same portable file for sending through your preferred app. Import that file on either platform; no CSS plugins or extra assets are required.

## Scene artwork, not just repeating patterns

Each variant can carry different artwork for the reading pane, sidebar and toolbar. A composed scene is shown once, not stamped repeatedly. Artwork is optional and off in the built-in appearance. The gallery includes original fan-inspired Avengers, Iron Man, Doctor Doom, Spider City and Gotham examples, as well as monochrome line art. These are not official or endorsed franchise assets.

```json
"artwork": {
  "reader": {"image":"data:image/svg+xml;base64,...", "opacity":0.10, "fit":"cover"},
  "sidebar": {"image":"data:image/png;base64,...", "opacity":0.06, "fit":"contain"},
  "toolbar": {"image":"data:image/svg+xml;base64,...", "opacity":0.04, "fit":"cover"}
}
```

Replace the placeholder with the base64-encoded image bytes. Both vector art (static SVG) and raster artwork (PNG, JPEG and WebP) are supported. Each decoded raster image is limited to 512 KiB, four megapixels and 4096 pixels per side. SVG is limited to 128 KiB and 5000 XML nodes. The complete theme is limited to 2 MiB. SVG scripts, events, HTML, text/font loading, links, embedded sub-images, CSS, filters, animation and external resources are rejected. SVG gradients, shapes and local clipping paths are allowed. Animated PNG/WebP and other animated formats are not supported. Image types must match their bytes; renaming an extension is not enough. URLs are not fetched. Unsupported or invalid themes leave the last valid appearance active.

For detailed artwork reused across areas or modes, add an optional top-level `assets` dictionary (up to eight images). The artwork's `image` then references `asset:` followed by the dictionary key:

```json
"assets": {
  "painting": "data:image/jpeg;base64,...",
  "line-art": "data:image/svg+xml;base64,..."
},
"variants": {
  "dark": {
    "artwork": {
      "reader": {"image":"asset:painting", "opacity":0.18, "fit":"contain", "position":"right"},
      "sidebar": {"image":"asset:line-art", "opacity":0.08, "fit":"cover"},
      "toolbar": {"image":"asset:painting", "opacity":0.04, "fit":"cover", "position":"top"}
    }
  }
}
```

Asset keys use 1–64 letters, numbers, hyphens or underscores. Missing references are rejected. Assets are stored once in exported/shared theme files and work offline after importing on either platform. Include only artwork you have permission to redistribute; bundled fan-style vector examples do not grant rights to third-party franchise illustrations.

`fit` is `cover` (fills and crops) or `contain` (fits the whole composition). Optional `position` is `center` (default), `left`, `right`, `top`, `bottom`, `top-left`, `top-right`, `bottom-left` or `bottom-right`. `opacity` is 0–0.25, default 0.06; native sidebar/toolbar artwork is additionally capped at 0.12 to keep controls readable. The reading visibility slider also adjusts reader artwork, independently of native artwork. No SVG markup enters the interactive document DOM. Native drawing commands and small repeat tiles are cached; Android downsamples native raster decorations to at most 1024 pixels on the longest edge and shares a bounded drawing cache across areas. There are no wallpaper timers, full-size note screenshots, or additional WebViews. Background art remains outside portable notes and PDFs but travels with an exported/shared theme file. Artwork/asset extensions require the updated app; older releases reject them safely.

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
