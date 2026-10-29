# Super MD CLI and MCP interface

For an agent-ready workflow, use [the Super MD skill](skills/super-md/SKILL.md).
Settings → AI agents → **Save setup instructions** includes this skill with the
connection details for that installation, on desktop and Android. Keep that
export private because a configured cloud connector URL grants access.

In Settings → AI agents, enter your own relay server, create a pairing, enable access, then copy the
private MCP connector URL into your AI client's remote MCP configuration.
Import the pairing file on another trusted phone or computer to add it to the
same workspace. `list_devices` tells the agent which devices are online; give
mutations an explicit device ID when more than one is connected. No server or
private connector URL is built into the app. Host the service in `agent-relay/`
or use a compatible server you control. The public origin alone grants no access.
Keep the pairing file and connector URL private. Access is off until enabled.

The agent interface reads and edits notes through one Qt-free Python operation
layer. It supports plain Markdown, legacy text `.smd`, and portable `.smd`
notes. The portable note reader/writer is shared with the desktop app, so
Markdown source and embedded assets are preserved on edits. It does not render
HTML, execute Python, evaluate charts, or return image/SVG payloads in normal
responses.

## Headless CLI

The CLI uses the standard library and `desktop/documents.py`; it does not load
Qt, WebEngine, the browser, or scientific packages. Run it with Python 3.11 or
newer and an explicit allowed root:

```sh
super-md agent --root /path/to/notes inspect chapter.smd
super-md agent --root /path/to/notes read chapter.smd --limit 4000
super-md agent --root /path/to/notes read chapter.smd --heading 2
super-md agent --root /path/to/notes read chapter.smd --heading "7.4"
super-md agent --root /path/to/notes read chapter.smd --view source
super-md agent --root /path/to/notes search chapter.smd "assumption" --limit 25
super-md agent --root /path/to/notes search chapter.smd "assumption" --offset 1400 --whole-word
super-md agent --root /path/to/notes search chapter.smd 'assumpt[a-z]+' --regex --case-sensitive
super-md agent --root /path/to/notes assets chapter.smd
super-md agent --root /path/to/notes replace-asset chapter.smd ASSET_ID 'replacement image.svg' --revision SHA256
super-md agent --root /path/to/notes export chapter.md smd portable.smd
super-md agent --root /path/to/notes export chapter.md pdf print.pdf --options-json '{"pageSize":"letter","margin":18}'
```

`inspect` includes the first bounded outline page. `read --heading` accepts its
0-based index, an exact title or slug, or an unambiguous numbered heading such
as `7.4`. A selected read includes nested headings up to the next heading at
the same or higher level; use its `next_offset` to page through that section.

For a source checkout without the packaged launcher, replace `super-md agent`
with `python desktop/agent_cli.py`.

Success and failure both return one JSON object on stdout. Image extraction
writes to an explicit output file instead of printing binary data. Reads are limited to 12,000 characters
per page and 64 KB per JSON result. Prose reads elide fenced SVG bodies by
default; `--view source` returns the exact source. Both modes keep `start` and
`end` as original source offsets, and prose pages report each omitted SVG's
exact character and line range. When a page overlaps a fenced SVG, its
`next_offset` skips the entire SVG and continues until it has collected up to
the requested amount of ordinary prose (or reaches the heading/document end).
Thus a prose page's consumed `end` can be beyond `start + limit`; use that
returned cursor for the next page. `view=source` always returns exact source
characters and advances by at most `limit`. Search returns short snippets and
line locations and supports case sensitivity, whole words, a safe regex subset,
and excluding fenced diagrams. `totalMatches` counts all matches for the
current query and filters across the document, so it remains the same on every
page. `remainingMatches` counts matches at or after the supplied `offset`;
`truncated` and `nextOffset` describe only that remaining page. The last page
and an exhausted cursor return `nextOffset: null`, even though
`totalMatches` remains nonzero. Pass the returned cursor as `--offset` to
continue; match offsets use Unicode code points.
`inspect` returns the note SHA-256 revision, heading outline,
and bounded asset metadata; assets themselves are returned only by the explicit
extract operation.

Create-only operations never replace a file:

```sh
printf '# Meeting\n\nNotes\n' | super-md agent --root /path/to/notes create meeting.smd --stdin
super-md agent --root /path/to/notes create draft.md --content-file seed.md
```

Patch operations require the current SHA-256 revision from `inspect` or `read`.
The JSON array accepts unique exact replacements (`type: "replace"`) and
1-based inclusive line edits (`type: "lines"`). A unique replacement is the
default; `count: "all"` must be explicitly requested to replace repeats.
Revisions are checked while holding a stable inter-process lock, and saved
files use an atomic same-directory replacement. A stale revision fails without
writing anything.

```sh
python desktop/agent_cli.py --root /path/to/notes patch chapter.md \
  --revision 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef \
  --operations-json '[{"type":"replace","old":"old phrase","new":"new phrase"}]'
```

For quick edits, keep only the revision and small outline/search results in the
agent context, then send a narrow patch:

```sh
revision=$(super-md agent --root /path/to/notes inspect chapter.smd | jq -r '.result.revision')
super-md agent --root /path/to/notes patch chapter.smd --revision "$revision" \
  --operations-json '[{"type":"replace","old":"draft phrase","new":"final phrase"}]'
```

Use `--operations-file` for a longer JSON patch. Both note and patch file must
be inside an allowed root. Asset attachment accepts one image path inside an
allowed root and embeds it only in a portable `.smd`; extraction requires the
current note revision and refuses to overwrite an existing output file. Images
are limited to 25 MB each. `assets` is paginated in pages of at most 50 records
and returns a stable ID, name, MIME type, byte count, and SHA-256 only.
`replace-asset` accepts that ID or the exact asset name and keeps the Markdown
and all other assets unchanged. A replacement keeps the existing reference's
MIME type and extension; `attach` adds a new MIME-matching asset reference.
Source image paths may include Unicode and spaces; generated internal names
remain compatible with the portable SMD format.

The `export` command writes a new file inside an allowed root and never replaces
an existing output. PDF export uses the native `smd-engine` and accepts the
desktop page controls: `pageSize`, `margin`, `fontSize`, `lineHeight`,
`paragraphSpacing`, `fontFamily`, `pageNumbers`, `themed`, and `themeAccent`.
Pass `--engine` to select a native engine and `--font-dir` to provide bounded
TTF/OTF font assets. Local images are loaded only from inside the note's
folder. The headless renderer reports Mermaid and `smd-chart` blocks as
unsupported; use the live desktop export action for those renderers.

## MCP server

Install the pinned optional dependency in the Python environment used for the
MCP server. This does not change the desktop application's scientific or GUI
dependencies:

```sh
python -m pip install -r desktop/requirements-agent.txt
```

The MCP server uses the official Python SDK v2 stable Streamable HTTP and stdio
transports. Local desktop hosts should use stdio, with each workspace passed as
an explicit root in the host's MCP server command. On Windows, use the
packaged `super-md-cli.exe` console launcher so MCP can access stdin/stdout;
on Linux and macOS, use `super-md` (inside `Super MD.app/Contents/MacOS` on
macOS). Example command and args:

```json
{
  "command": "/path/to/super-md",
  "args": [
    "agent",
    "mcp",
    "--root", "/path/to/notes",
    "--live-sessions-dir", "/path/to/desktop-data/agent-sessions",
    "--transport", "stdio"
  ]
}
```

In a source checkout, use `python desktop/agent_cli.py mcp ...` and install
`desktop/requirements-agent.txt` into that Python environment.

Omit `--live-sessions-dir` for a filesystem-only server. The directory is
created and protected by the desktop app when Live Agent Access is enabled;
each private discovery record carries a session token. The MCP process reads
those records without printing or returning tokens. `list_sessions` merges the
open tabs from discovered desktop sessions and namespaces targets as
`tab:<session>:<window>:<tab>` so multiple windows can be addressed without
path collisions. Closed or disabled sessions disappear after the next list.

Live outline pages use `offset` and `limit` (maximum 80) and include each
heading's code-point `sectionStart`/`sectionEnd` plus `documentLength`. A live
`document_read` heading can be a 0-based outline index, an exact title or slug,
or an unambiguous numbered heading such as `7.4`; duplicate titles return a
bounded candidate list instead of guessing. Keep the returned `next_offset`
when paging within a selected section. A live `document_action` export accepts
the same selector as `options.section`; it exports that section through the
regular PDF/Markdown/SMD pipeline while guarding against the full document
revision. Omitting `section` exports the whole document as before.

The server exposes at most nine focused tools: `list_sessions`,
`document_inspect`, `document_read`, `document_search`, `document_action`,
`document_patch`, `document_assets`, `document_attach_asset`, and
`document_view`. `document_action` handles filesystem create/export, live tab
create/open/save/activate/close/export, reading context, LaTeX review/apply,
device listing, diagram-source listing/chunks, and asynchronous job status. Disk exports require a new `output_path`
inside an allowed root. Live-tab exports let the app choose a safe unique
destination and accept the desktop PDF options; poll the returned `jobId` with
`action="job_status"`. Live `create_document` opens a new unsaved tab; its
`filename` is a naming hint and it never writes to disk. `background=true` on
create or open preserves the current tab. `save_document` requires the current
tab revision and stays at its existing path unless `save_as=true` or a filename
is supplied. Save-as creates a new unique target and returns `pathChanged`,
`oldPath`, and `newPath`. `open_document` can activate an open tab or ask the
desktop to open a file under its approved note roots; a new file returns a
`jobId` while loading, then job status contains its tab metadata. Use
`activate_document` to select a tab, and `close_document` with the current
revision to close it; dirty tabs require `discard_changes=true`, and closed-note
recovery may return `closing` while it finishes. In that case, refresh the
tab/session list until the target is gone before depending on the new active
tab; do not repeat the close request. LaTeX fixes are proposed first, then selected indices are applied
against the review revision as one desktop edit. `get_context` reports the
current selection, visible source range, and revision-bound diagram references;
`list_diagrams` pages diagram metadata with `offset` and `limit` (default 80,
maximum 80); `get_diagram` fetches exact Markdown source in bounded chunks.
`document_view` returns a viewport image or a specifically requested rendered
diagram image. A live desktop bridge adds
currently open and unsaved tabs to
`list_sessions`. Use a returned `tab:<id>` target for tab inspection, bounded
source reads/searches, revision-checked edits, and rendered viewport images.
Live-tab edits go through the app bridge so its editor state and rendered view
update immediately. `read`, `search`, and source patches can target inactive
tabs. The bridge flushes the current editor draft before a mutation, so you can
patch or save another tab without switching focus. The server must never resolve a `tab:<id>` through a
filesystem root. Image extraction uses `document_assets` with
`action="extract"` and the exact asset name; MCP returns an image content block,
not base64 text. `action="replace"` accepts the stable asset ID or exact name,
replacement path, and current revision. Create calls are create-only. Patch and asset mutations require
`expected_revision`; after a revision conflict, inspect again and rebuild the
edit from current text.

The optional live adapter passed to `build_mcp_server(roots, live_client=...)`
is synchronous so the SDK can run filesystem and bridge calls in its worker
pool. Its methods are `list_tabs()`, `read_tab(tab_id, offset=0, limit=...)`,
`search_tab(tab_id, query=..., limit=..., context=..., offset=...,
case_sensitive=..., whole_word=..., regex=..., exclude_diagrams=...)`,
`patch_tab(tab_id, expected_revision=..., operations=...)`, and
`render_tab(tab_id, width=...)`. Read responses include the current revision;
patch receives the caller's unchanged revision and operation list. Render
returns raw `data: bytes` plus `mime_type`; the MCP layer accepts only verified
PNG/JPEG bytes up to 8 MB. Optional `get_tab_image(tab_id, asset_name=...,
expected_revision=...)` can provide explicitly requested image assets, and
`attach_tab(tab_id, asset_path=..., expected_revision=..., name=...)` can add a
bounded file through the app's editor operation. Its `document_action` dispatch
supports `get_context`, `latex_review`, `latex_apply`, `export_document`,
`list_diagrams`, `get_diagram`, and `get_diagram_image`; `list_devices` returns
host/device metadata. The adapter owns app-specific
thread marshaling and must return an error rather than fall back to disk when
the tab is missing or stale.

For an HTTP endpoint on the same machine, generate a random token in a protected
file, then bind only to loopback:

```sh
umask 077
python -c 'import secrets; print(secrets.token_urlsafe(48))' > "$HOME/.config/supermd-mcp-token"
python desktop/mcp_server.py --root /path/to/notes --transport streamable-http \
  --host 127.0.0.1 --port 8765 --token-file "$HOME/.config/supermd-mcp-token"
```

The endpoint is `http://127.0.0.1:8765/mcp` and all HTTP requests require that
file's token as a bearer token. The SDK enforces its localhost Host/Origin
DNS-rebinding checks; request bodies are capped at 2 MB and the server uses one
worker. Token contents are never accepted on the command line or printed.

## Remote and cloud use

For live desktop and Android notes, open **Settings → AI agents**, create a
pairing on your chosen Super MD relay, enable access, and copy the MCP connector
URL to your AI client. Both Streamable HTTP and legacy SSE use that same URL.
Use the exported pairing file to join another trusted device; its own device
key is generated locally. `list_devices` reports online devices and their open
tabs. Explicitly choose the device ID when several are connected.

For voice and other questions about the current page, start with
`view_current`. It returns visible Markdown, reading position, diagram
references, and optionally a compact viewport image in one MCP response,
without a document-wide diagram search. Use `includeImage:false` when the
visible text is enough; use `includeImage:true` when visual appearance matters.
With one connected device and one active tab it needs no arguments. When
several devices or active windows exist, supply IDs returned by discovery.
`width` controls the image's longest edge (64–1600, default 1000); previews
default to JPEG and `quality:"high"` requests a lossless PNG at the larger
default edge of 1600. Context and capture must have the same source revision. A
moved reading position is reported with the capture so an agent can distinguish
it from the preceding source context.

`document_action(get_context)` provides the visible Markdown and current reading
position. `visibleSource.total_chars` is the full document length in Unicode
code points. Its `next_offset` continues after the returned source range, even
when that range ends at the viewport boundary; a null cursor means actual EOF.
For a current-view question, use that visible range rather than paging through
the remaining note. `selection.text` preserves the exact selection, including
partial words. `diagram_action(list/source/image)` identifies diagrams and
Markdown images, fetches bounded source chunks, or returns a compact JPEG
preview (`quality:"high"` for PNG). Asset references stay compact; image bytes
are not included as base64 text in ordinary reads. `render_tab` returns the
current themed viewport as an image with position metadata.

For a known section, use `read_tab` with its exact title, slug, unambiguous
numbered prefix (for example `heading:"7.4"`), or outline index. `tabId` is
optional when one active tab is unambiguous. A compact prose request can use
`limit:3000`; continue the same heading with the returned `next_offset`. Use
`view:"source"` when exact Markdown is needed. If the heading is not known,
page the active tab's outline with
`document_action(documentAction:"outline", tabId, options:{offset:0, limit:80})`;
the maximum outline page is 80 headings and results include `nextOffset`,
`sectionStart`, `sectionEnd`, and `documentLength`.

Export the whole note or one heading section as Markdown, portable SMD, or PDF
with `document_action(documentAction:"export", tabId,
expectedRevision:REV, options:{format:"smd", section:"7.4"})`. Omit `section`
for a whole-document export. Use the latest revision from the current view or
read result; exports reject a stale revision. Poll
`document_action(documentAction:"job_status", options:{jobId:JOB})` until the
job completes. The completed result includes an MCP `resource_link` and
`download.url` metadata (expiry, MIME type, length, and SHA-256). MCP tool
results can include resource links, and MCP clients can read supported
resources with `resources/read`; see the [MCP tools result specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#resource-links)
and [MCP Resources](https://modelcontextprotocol.io/specification/2025-11-25/server/resources#reading-resources). Client support for binary
PDF/SMD resource blobs varies, so do not assume every voice client can consume
them. For a text-only client, use a Markdown export or read the needed section
with `read_tab`.

For an export no larger than 3 MiB, `resources/read` returns Markdown as text
and PDF/SMD as a binary resource blob. Larger exports must use the returned
HTTPS `download.url`; it streams in 512 KiB chunks, supports at most four active
downloads across the relay, and is capped at 128 MiB. The private URL expires
after ten minutes and works only while the paired Super MD device remains
connected. The relay stores no export contents; it reads bounded chunks from
the device as needed. Do not place base64 export bytes in model text. The
native CLI can instead create and SHA-256-verify a new local file with
`super-md agent live --sessions-dir "$SESSIONS" download JOB_ID OUTPUT`; it
refuses to overwrite an existing destination. Choose SMD when embedded images
must travel with the export. Markdown keeps ordinary asset references. PDF
preparation resolves defined reference-style images through the same asset
pipeline as inline images.

`asset_action(list/source/attach)` provides compact embedded-asset metadata,
original SVG text or raster image content, and direct image attachment without
a device-local source file. Attach passes `assetName`, matching `mimeType` and
base64 `body`, with a current `expectedRevision`. Inline payloads and original
asset retrieval are limited to 1 MiB. SVG source is paginated; binary originals
are MCP image blocks, never a large base64 text response. A saved portable SMD
is required for attachment; the returned asset reference can then be inserted
at the intended source position with `patch_tab`. Ordinary Markdown can receive
fenced SVG/Mermaid blocks directly through a patch.

The desktop live CLI also has `diagrams TAB [--offset N] [--limit N]` for
paginated diagram metadata and `diagram-image TAB ID OUTPUT --revision REV`,
`assets TAB`, `extract TAB ASSET OUTPUT --revision REV`,
`attach TAB IMAGE --revision REV [--name NAME]`, and
`replace-asset TAB ASSET IMAGE --revision REV`. Use `--sessions-dir` as in the
other live commands. Capture and extraction create new files without
overwriting existing files, with extensions matched to their actual content.
The `search` command accepts `--offset`, `--case-sensitive`, `--whole-word`,
`--regex`, and `--exclude-diagrams`. `patch TAB --revision REV` can edit an
inactive tab. `create` and `open FILE` accept `--background`; `activate TAB`
selects an existing tab, and `close TAB --revision REV` closes a clean tab.
`read TAB --heading SELECTOR` accepts a 0-based outline index, exact title,
slug, or numbered heading prefix and pages the selected section using the
returned `next_offset`.
Pass `--discard-changes` to close a dirty tab while retaining its closed-note
recovery snapshot. `save TAB --revision REV` preserves the existing path;
`--save-as` or `--filename NAME` requests a new unique target. Poll the returned
job ID with `job JOB_ID`, including for a newly opened file.
Use `download JOB_ID OUTPUT` to retrieve a completed PDF, Markdown, or SMD
export in verified byte chunks without overwriting an existing destination.

Turning access off disconnects the device. **Revoke access** also asks the relay
to unregister its device key and removes local credentials. If offline, the
app reports that server revocation could not be confirmed. The pairing file is
trusted enrollment authority: create a new workspace and re-pair your devices
to replace that authority or the AI connector URL.

The relay is hosted separately from note storage and retains routing
state only in RAM. Reconnect restores enrollment after a restart. You can
self-host the same service using [agent-relay](../agent-relay/README.md).

### Standalone MCP for files mounted on a cloud machine

`localhost` on a cloud machine is the cloud machine itself; it does not reach a
desktop computer. For a remote agent, run this server on the machine that has
the notes mounted, or use a private network tunnel to that machine. Put TLS and
an authentication proxy in front of any network-exposed endpoint. Use a long
random bearer token from `SUPERMD_MCP_TOKEN` or `--token-file`, and pass exact
`--allow-host` values for the HTTP Host header. For browser clients, add exact
`--allow-origin` values. A non-loopback bind is refused at startup without an
explicit Host allowlist. Do not expose an unauthenticated endpoint or mount the
user's home directory as a root; allow only the note folders that the agent
needs.

Example for an isolated container whose TLS proxy serves `notes.example.net`:

```sh
SUPERMD_MCP_TOKEN_FILE=/run/secrets/supermd-mcp-token
python desktop/mcp_server.py --root /workspace/notes --transport streamable-http \
  --host 0.0.0.0 --port 8765 --token-file "$SUPERMD_MCP_TOKEN_FILE" \
  --allow-host notes.example.net --allow-host notes.example.net:8765
```

Terminate TLS at a trusted reverse proxy, restrict the server port to that
proxy, and configure its forwarded headers only for the proxy address. Use a
private tunnel if you choose to expose this standalone filesystem server. For
live devices, the paired relay above avoids configuring an inbound tunnel.

## Limits and safety

- Disk tools require explicit roots; paths outside them and symlink components are refused. Live tools use the tabs exposed by an enabled app session.
- Existing documents are never replaced by create or extraction operations.
- Source pages: up to 12,000 characters; search: up to 25 matches and 500
  characters of context; assets: up to 50 metadata records per page.
- SMD file size is capped at 120 MB by the shared reader; Markdown and patch
  content at 20 MB; each image asset at 25 MB.
- Patch operations: at most 100 per request. Disk tools do not execute shell
  commands, note code, or network fetches. Live image requests render through
  the app; Python code is never run implicitly. Image bytes are returned as an explicit,
  bounded MCP image content block.
- MCP request bodies are capped at 2 MB by this server, independently of the
  SDK's defaults.
- Atomic writes and SHA-256 guards protect agent-mediated edits from stale
  requests. They do not lock out manual edits made by the desktop editor or
  another program during the tiny interval between the final hash check and
  filesystem replacement.

The optional server targets Python 3.11+. The stdlib CLI and operation layer
remain usable without the MCP package.
