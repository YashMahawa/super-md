# Super MD 0.6.4

## Faster compatible Mermaid diagrams

- Plain flowcharts, sequence/state/class/entity diagrams, pie charts and mind maps use Obsidian's MIT-licensed Pele renderer, loaded on demand. Compatible diagrams no longer load Mermaid's full runtime and can appear sooner while editing.
- Authored Mermaid configuration, math/HTML labels, advanced interactions and untested diagram families keep Mermaid.js. Fast-path failures also fall back automatically; no source conversion is performed.
- Generated SVG variables are resolved to self-contained values for the image viewer and native PDF export. Diagram colours still follow the shared appearance setting.
- A local comparison including SVG sanitization measured roughly 8–29 times faster rendering on the small test corpus. This is not a claim that the whole app, every diagram or every phone is that much faster.
- Complete Pele and Lucide licence notices are included offline.

## Consistent diagram appearance

- SVGs, Mermaid diagrams, interactive charts and Python SVG figures now share the Diagram appearance setting on desktop and Android. Ordinary images retain their independent setting. Existing preferences carry over.
- Auto adapts neutral paper, text and edges to the current theme and accent, while preserving useful authored colours. Monochrome remains a separate choice. Original, contrast framing and dark-theme inversion are still available.
- Mermaid's animation rules no longer prevent adaptation of otherwise static diagrams. Auto and monochrome remove harsh white edge halos without changing the note.
- HSL colours and implicitly closed entity-table rows adapt correctly. Labels on curved filled areas, including pie slices, are contrasted against their local background; monochrome categories retain distinct tones and matching legends.
- Diagrams open in the image viewer at vector quality. Appearance changes preserve viewer zoom. Authored diagram CSS remains inside an inert image rather than leaking into the app.
- A bounded Mermaid layout cache avoids repeated rendering when changing appearance. Reading adjustments never rewrite source or alter PDF export settings.

## Solid, readable dialogs

- Fixed intermittent transparent dialog bodies and washed-out backgrounds with Qt's software renderer. Rename, Settings, Export and close-confirmation dialogs use one opaque themed surface and a dark scrim.
- Rename prompts survive tab snapshot refreshes without losing their draft filename. Enter accepts and Escape cancels; note-history shortcuts do not intercept typing in modal dialogs.
- Hover hints stay hidden while a modal dialog or context menu is open.

## Verification and compatibility

- Added real software-rendered dialog pixel tests, Mermaid appearance tests across flowchart, sequence, state, entity, pie and mind-map diagrams, and Android WebView integration coverage.
- Releases remain gated on exact-source cross-platform CI, emulator tests, signed Android release validation and complete installer checks.
- macOS packages remain ad-hoc signed rather than notarized. Windows installers are not code-signed.
