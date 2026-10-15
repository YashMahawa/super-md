# Super MD 0.6.2

## Portable artwork themes

- Use both vector art and detailed images: static SVG, PNG, JPEG and WebP can decorate the reader, sidebar and top bars. Artwork is optional; the built-in appearance stays clean.
- Reuse embedded assets across areas and light/dark variants without copying the same image into every entry. Control placement, cover/contain fit and visibility. Themes work offline and travel as one file between desktop and Android.
- Add cat-paw backgrounds with adjustable visibility, motif size and spacing, alongside dots, grids, diagonal textures and gradients. Settings adjustments are remembered without modifying the original theme file.
- Import, export and share the active theme with its background adjustments. Android opens its native share sheet; desktop saves a portable theme file for sharing.
- The theme authoring guide documents the format, examples, limits and AI-friendly editing workflow. No CSS plugins, scripts or remote asset downloads are required.

## Better image adaptation

- Auto adapt preserves colours while adapting neutral ink and paper to the current accent and page. SVG labels are checked against their local node backgrounds; poorly contrasted marks and arrowheads are adjusted without flattening all colours.
- Theme monochrome is a separate option for the previous full-image accent duotone effect. Original remains the default; theme-relative separation preserves source pixels and adds readable backing/edges.
- Existing images, SVGs, notes and PDF source assets are never rewritten by viewing adjustments. An open image keeps its zoom when the theme changes.

## Desktop polish and navigation

- Note context menus have opaque, bordered surfaces and consistent hit areas. Duplicate path hints are removed and remaining hints disappear while menus are open.
- Recent notes have reliable hover/focus highlights and a bounded Pin/Unpin context menu; lightweight pin indicators appear only on pinned entries.
- Long-document heading jumps now follow late font/layout changes briefly, then yield immediately to deliberate scrolling or zooming instead of snapping back.
- Opening search or choosing a match cancels a preceding heading jump, so quickly searching after a contents/link jump cannot snap back to the old heading.
- Switching tabs or reading modes also retires the previous heading alignment instead of applying it to a different document.
- Artwork and palette changes do not reparse Markdown, replace math nodes or reset reading zoom.

## Bounded rendering and safety

- A theme is limited to 2 MiB, with up to eight reusable images. Rasters are capped at 512 KiB and four megapixels; static SVG is capped at 128 KiB and 5000 XML nodes. Animated and executable content, external resources and missing asset references are rejected.
- Android shares a bounded drawing cache across native areas, downsamples native raster decorations and avoids sending unused sidebar/toolbar images through the reader bridge.
- Fixed-size SVG artwork is fitted to its cached Android viewport instead of appearing as a tiny mark in one corner. The imported file itself is unchanged.
- Regression coverage includes actual native and browser artwork pixels, raster type checks, import/share round trips, document identity/zoom retention, menu opacity and tooltip suppression. Android tests run on emulators, not the user's phone.
- Private detailed-art evaluation samples are not bundled in the repository or release. Only share artwork you have permission to redistribute.

This is a normal stable update. Earlier published installers remain available for rollback. Themes are viewing preferences, not content embedded in SMD notes or PDF wallpaper. Older versions safely reject unsupported theme extensions.

macOS packages remain ad-hoc signed rather than notarized. Windows installers are not code-signed.
