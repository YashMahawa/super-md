# Agent interface audit

The 0.6.20 update addresses the verified document-integrity and navigation issues
found during a large-note MCP stress test. See [the interface guide](AGENT-INTERFACE.md)
for the supported operations and wire parameters.

## Changes

- Existing documents save in place, retaining their format and portable assets.
  Save-as is explicit and reports path changes. Writes check revisions and disk
  changes; a failed patch batch does not partially edit a note.
- Background creation/opening, activation, guarded closing and asynchronous open
  jobs let an agent work with several tabs without silently taking focus.
- Read, search and source-edit operations work on inactive documents. Pixel,
  reading-context, export and LaTeX operations that require the active reader
  ask for explicit activation rather than silently changing it.
- Patch schemas describe exact replacement, inclusive line replacement and
  insertion. Unknown fields are rejected. Results report completed operation
  counts and code-point ranges.
- Search returns continuation offsets, a stable document-wide `totalMatches`,
  and page-specific `remainingMatches`, with case/word controls and diagram
  filtering. `truncated`/`nextOffset` describe only matches from the requested
  cursor onward, so the final page has no next cursor while `totalMatches`
  remains stable. Regex is a bounded fixed-width subset, avoiding
  unrestricted backtracking on large documents.
- Prose pagination skips SVG bodies and reports actual returned text length.
  Diagram inventories page correctly. Source offsets count Unicode code points;
  diagram IDs locate their opening source reference/fence. Diagram source pages
  use offsets relative to that diagram and retain document source bounds.
- The cloud API exposes LaTeX review separately from application. Export control
  fields are separated from PDF typography settings. Image metadata states MIME
  type and byte size beside the actual MCP image block.

## Intentional safeguards and compatibility

The stress test's earlier metadata-only image symptom did not reproduce in the
subsequent image tests. Real image content blocks were verified separately; this
is not treated as a confirmed image transport defect.

Writes continue to require a real expected revision. The proposed special
`expectedRevision: "current"` shortcut would permit stale changes and is not
supported. Diagram source/image references also retain revision guards so a
source offset cannot silently identify a different diagram after editing.
Inventory reads may omit the revision; supplied revisions are still checked.

Legacy response aliases remain available for existing clients. Prefer `text`
for source pages and follow the returned cursor rather than adding the displayed
text length. An omission marker is not a literal source substring. The full
source is available with `view: "source"`.

Remote image fetching still requires the app's normal consent/loading workflow.
The agent interface does not bypass this through server-side URL fetching.

`serverMs` is elapsed time from the relay starting a device request until it
receives the device response. It includes device work and relay-to-device network
latency. It excludes the agent's planning, client transport, image conversion
following that response, and voice generation. It is not a device CPU benchmark.
