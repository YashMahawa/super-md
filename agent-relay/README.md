# Super MD live cloud relay

This isolated Node service connects MCP clients to live Super MD desktop and
Android instances. It contains no model API client and no document store. It
routes bounded requests to a connected app and returns the app's response in
memory. Notes, edits, rendered images and pairing keys are not written to the
relay's filesystem or a database.

The service uses the official TypeScript MCP SDK v2.4.0 for Streamable HTTP and
the official `@modelcontextprotocol/server-legacy` v2.4.0 SSE transport for
older clients. A Streamable HTTP client uses the group's connector URL directly.
An SSE client opens the same URL with `GET`; its subsequent `POST /messages`
requests use the endpoint returned by the SSE stream. `HEAD` and `OPTIONS` are
supported for connection probes.

## Tools

The MCP server publishes nine focused tools:

- `list_devices` shows paired device display names, platforms, connection
  status, last-seen time and current tabs for connected devices.
- `list_tabs`, `read_tab`, `search_tab`, `patch_tab` and `render_tab` work with
  open, including unsaved, tabs. Mutations must supply the current SHA-256
  revision. The app rejects stale edits.
- `diagram_action` lists diagrams, reads bounded diagram source, or returns a
  diagram image as a real MCP image. Requests include the source revision.
- `replace_tab_asset` asks the selected device to use an image path within its
  own configured asset roots; no asset path is opened by the relay.
- `document_action` requests native create/open/save/export, LaTeX repair,
  export-job status or snapshot. PDF export options use the app's page size,
  margins, type size, line height, paragraph spacing, font, page-number and
  theme controls. There is no shell, Python or arbitrary-code tool.

Tab IDs are globally qualified by the app. If more than one device is online,
reads without a `deviceId` return an ambiguity error; mutations always require
an explicit device in that case. `render_tab`, diagram images and the snapshot
action return actual bounded PNG image content blocks. Desktop window identity
travels in the bounded `windowId` field; Android tabs use their app-instance ID.

## Pairing and secrets

Each workspace has two independent random values: a pairing key for trusted
device enrollment and a connector key for MCP access. The workspace ID is
derived as the first 32 lowercase hex characters of SHA-256 over the UTF-8
bytes for `supermd-group-v1`, a NUL byte, `pairingKey`, a NUL byte, and the
hexadecimal SHA-256 digest of `connectorKey`. The pairing JSON contains
`format`, `version`, `serverOrigin`, `groupId`, `pairingKey`, and
`connectorKey`. Export it through the app's explicit pairing-file action and
share it only with a device the user trusts. Each installation generates its
own device ID and independent device key.

The device sends the pairing file values plus its own device ID, device key,
display name and platform to `POST /device/enroll` over HTTPS, then opens an
outbound WSS connection authenticated by its device key. The relay stores only
hashes of the connector, pairing and device keys in memory.
The MCP connector URL is a bearer capability; it contains the connector key
and must only be given to the intended AI client. Never paste pairing JSON,
device credentials or the connector URL in logs, issue reports or screenshots.

Device enrollment and reconnect after a relay restart are ephemeral. A paired
app re-enrolls from its Keystore-protected credentials. The relay holds the
current group/device directory and in-flight requests only in RAM; disconnected
device entries expire after 24 hours. Restarting or idling a free service may
close active MCP and device connections; reconnecting clients and apps restore
the live bridge without a backup restore. Keep note storage in the Super MD app
or its separately configured sync/storage service.

## Deploy as a separate Render service

Create a new Docker web service using this folder as its root directory and
`Dockerfile` as the build file. Do not point it at another project's service,
Worker, database or secrets. Terminate TLS at Render or a trusted HTTPS proxy.
Set `PUBLIC_HOST` to the exact public Host header, for example
`relay.example.net`. The service binds to `0.0.0.0` when `PUBLIC_HOST` is set,
otherwise it binds only to `127.0.0.1`. `PORT` defaults to `8787`.

The service needs no application secrets, API tokens or persistent disk.
Render's free service may sleep when idle; its first request and app rejoin can
wait for the cold start. No live document requests are queued while an app is
offline; the MCP tool returns an explicit offline error.

Health probe: `GET /health`. It reports only aggregate active-group and
connected-device counts. Request paths, connector keys, pairing keys, device
keys and document contents are never logged. Configure the proxy to preserve
the expected Host header and to allow HTTPS/WSS upgrades to the service port.

## Local development and desktop-only MCP

Install and run the relay from this directory with Node 22 or newer:

```sh
npm ci
npm run build
HOST=127.0.0.1 PUBLIC_HOST=127.0.0.1:8787 PORT=8787 npm start
```

Local relay traffic uses HTTP/WS, so Android intentionally refuses this origin;
use HTTPS/WSS for Android or place the local service behind a trusted TLS
endpoint. For desktop-only access on the same machine, use the app's local MCP
stdio configuration documented in `../docs/AGENT-INTERFACE.md`; it stays on
the desktop and does not require this cloud relay. That local MCP server also
supports optional bearer-token-protected loopback Streamable HTTP. Never expose
its HTTP port publicly without a TLS/authentication proxy.

Run checks with:

```sh
npm test
```

The tests start an isolated local relay and connect with the official MCP
Streamable HTTP and legacy SSE SDK transports. They use synthetic document
responses and do not contact a deployed service.
