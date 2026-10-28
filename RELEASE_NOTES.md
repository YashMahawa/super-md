# Super MD 0.6.18

## Faster agent previews

- Cloud agent screenshots and diagram previews default to compact JPEG. Ask for `quality: "high"` for a larger, lossless PNG. Original images, SVG/Mermaid source and document exports are unchanged.
- The new `view_current` MCP tool returns visible Markdown, reading position, relevant diagram references and a preview together, avoiding a document-wide diagram search during voice explanations.
- Desktop and Android create JPEG previews before uploading them when connected to a supporting relay. Existing apps and relays remain compatible through authenticated capability negotiation.
- Fixed desktop viewport captures ignoring the requested image size on high-density displays.
- Capture-time context distinguishes a changed reading position from the source read before the screenshot. Revision checks reject changed documents rather than mixing their contents.
- Preview decoding, dimensions, concurrency and queue length are bounded to protect the relay's memory. No document or image database is added.

## Verification and compatibility

- Added real desktop QML/WebEngine checks for PNG and JPEG captures at the requested size, Android JPEG capture coverage, and MCP SDK integration tests for default/high-quality previews and older devices.
- This update retains compressed SMD compatibility and the portable-image PDF export fix from 0.6.17. Android keeps the existing upgrade signing certificate.
