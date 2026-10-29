# Super MD 0.6.20

## Reliable agent editing across devices

- Saving an existing note now keeps its path and format. Creating a copy requires an explicit save-as request. Portable SMD saves preserve embedded assets and guard against external changes.
- Added background create/open, explicit tab activation and guarded tab closing. Read, search and edit inactive notes without silently changing the reader's focus.
- Android activation and active-tab closing now wait for the selected reader's acknowledgement before reporting completion, keeping immediate follow-up actions on the correct document.
- Newly opened desktop files return an asynchronous job ID. Polling it returns the completed tab identifier and revision without blocking the interface.
- Patch tools publish strict operation schemas, reject misspelled fields, identify the failed operation, and report completed edits accurately. Exact replacement, asserted multiple replacements, line edits and insertion work in atomic batches.
- Search supports continuation offsets, total counts, case matching, whole words, diagram filtering and a bounded regex subset.
- Prose reads skip large SVG bodies in one page instead of repeatedly returning the same omission. Context pagination reports the complete document length. Diagram inventories respect pagination and use consistent Unicode offsets.
- LaTeX review and apply are separate discoverable actions. Writes still require the current revision; stale writes never overwrite newer content.
- PDF export separates filename/format controls from typography options. Image responses include explicit media type and byte size alongside the actual image block.

## Focused retrieval and file delivery

- Read a section by heading index, title, slug or numbered prefix, with stable section bounds and continuation cursors. Paginated outlines help agents discover headings without fetching a whole note.
- Export the whole note or just one section as Markdown, portable SMD or PDF. Section exports retain supporting image/link definitions without modifying the source note.
- Completed cloud exports provide private, expiring download links and MCP resources. File bytes stream in bounded chunks with SHA-256 verification instead of filling the model's text context with base64. The CLI also supports verified, create-only downloads.
- PDF export now prepares reference-style images through the same asset pipeline as inline images.
- Heading jumps retain their target when a neighbouring diagram finishes sizing late, while user scrolling and zooming immediately take control.

## Selection and desktop settings

- Partial selections in Source and Split now stay visible: the active-line background no longer covers the selected characters. Native mouse tests check both the selected text and the painted highlight.
- The Qt reader now declares its desktop platform before shared-reader startup, enabling the intended desktop selection alignment.
- Keyboard shortcuts have their own Settings category with inline key recording, conflict validation and reset controls.
- Onboarding actions remain reachable in short desktop windows.
- Long uninterrupted typing sessions split undo groups before reaching the session-transfer limit, preserving undo and redo when restoring a view.
- The legacy PDF export path now rejects image paths that escape the document or export folders, including symlink escapes.

## Android settings

- Settings now opens a category home with separate pages for appearance, reading/media, files/startup, writing/shortcuts, agent connections, storage and updates. Back returns to the category list before closing settings.

## Compatibility

- Existing Markdown and compressed/uncompressed SMD files remain readable. The compact JPEG agent preview default and optional lossless PNG previews are retained; original diagrams and export assets are unchanged.
- Android retains its existing upgrade signing certificate. Desktop installers are supplied for Linux, Windows and both Mac architectures.
