# Super MD 0.6.26

## Agent and cloud relay

- Embedded SVG assets can now be inspected by agents as exact paginated UTF-8 XML source, rather than an unsupported SVG image MIME block. Large diagrams support source offsets for safe restyling.
- Previously enabled cloud relay connections automatically reconnect when Super MD starts, using the same saved pairing without requiring manual reconnection or rotating credentials.

## Export and Android reliability

- Export Portable Super MD (`.smd`) from an existing `.smd` note, or export any note as PDF, Markdown, Markdown ZIP, or SMD.
- Fix Android 16 instrumentation timing for the asynchronous editor-mode transition, retaining all real editor-content assertions.

## Verification

- Full CI and all supported platform installers must pass on the exact release commit before publication.
