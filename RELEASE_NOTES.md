# Super MD 0.6.17

## Agents in your notes

- Fixed CLI and filesystem MCP PDF export of portable SMD with embedded images. Original image bytes are preserved, and unused assets no longer inflate the PDF request. Packaged regression checks cover both SVG and PNG assets.


- No hosted relay or private connector URL is built into desktop or Android. Enter your own server or import a trusted pairing; existing configurations are preserved.


- Live CLI now saves individual diagram images, extracts original assets, and attaches/replaces images. Local MCP image attachment reaches the app correctly.
- Cloud MCP can attach an image supplied by an agent and retrieve original SVG text or raster bytes. The app preserves the rest of the portable note.
- Desktop and Android setup exports include a self-contained SKILL.md workflow for reading the current viewport, retrieving its Markdown, working with diagrams, and making revision-checked edits.


- Desktop CLI for creating MD/SMD, bounded section reads, exact text and line patches, image asset replacement, and PDF/SMD export. Edits require a current revision and preserve other assets.
- Local MCP access to open desktop tabs, including unsaved changes, and remote MCP access to paired desktop and Android devices. Access is off by default.
- Agents can identify online devices, read the current visible Markdown, fetch diagram source or images, inspect a viewport snapshot, search, edit, review LaTeX repairs, and create/save/export notes. Long exports return a job ID with status polling.
- Settings includes setup instructions and pairing-file import/export. The cloud relay supports Streamable HTTP and legacy SSE, keeps no document database, and authenticates device enrollment separately from MCP access. Explicit revocation unregisters a device and removes its local credentials.
- Large SVG bodies stay out of prose reads, with exact source ranges and pagination that skips the omitted artwork. Source mode remains available when an agent needs the full drawing.

## Smaller portable files and better exports

- New SMD saves use deterministic, lossless gzip compression around the existing portable envelope. Markdown, SVG detail, and embedded image bytes are retained. A 1.51 MB vector-rich viva note becomes about 153 KB.
- Existing uncompressed SMD/FMD files remain readable. **New compressed SMD requires Super MD 0.6.14 or newer.** The extension remains `.smd`.
- Right-click an image, SVG, chart, or Mermaid diagram to save a PNG with a neutral light background, an SVG where available, or its original image/Mermaid source. Android supports touch and hold. Saving a figure leaves the note unchanged.
- Fresh PDF defaults use 10.5 pt text, 1.55 line spacing, and 1.35 paragraph spacing, with clearer heading and list spacing. Existing custom PDF preferences are preserved.

## Settings and quality checks

- Settings is organized into categories. Desktop keyboard shortcuts have a separate popup.
- The export options dialog provides more vertical space within laptop bounds and a capped height on large monitors. Other dialogs and the compact export progress card retain their sizing.
- CI checks the relay transports and authentication, compressed-format compatibility, live agent behavior, and the official MCP client against the packaged executable. Windows includes a separate console launcher for MCP stdio.
- macOS packages include the required WebEngine helper; Intel MCP builds isolate their cryptography runtime from the app's other SSL libraries.

Android uses the existing signing identity and a higher version code for in-place updates.
