import { WebSocket } from "ws";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import { ExportDownloads } from "./downloads.js";
import { decodeViewportBase64, makeJpegPreview, normalizeReadingContext, viewportContexts } from "./preview.js";
import { type RpcRequest } from "./protocol.js";
import { MAX_ASSET_BYTES, MAX_TEXT_BYTES, TOOL_INPUT_SCHEMAS, WIRE_REVISION_RE } from "./schemas.js";

export type Pending = { resolve: (value: { result?: unknown; error?: string }) => void; timer: NodeJS.Timeout };
export type Device = {
  deviceId: string; displayName: string; platform: "android" | "desktop"; deviceKeyHash: string;
  socket: WebSocket | null; pending: Map<string, Pending>; lastSeen: number; jpegPreview: boolean;
};
export type Group = { groupId: string; connectorHash: string; pairingHash: string; devices: Map<string, Device> };
export type JpegCaptureRequest = Omit<RpcRequest, "requestId" | "action" | "tabId" | "width"> & { action: "render_tab" | "get_diagram_image"; tabId: string; width: number };
export type RelayTransportDeps = {
  groups: Map<string, Group>; exportsAvailable: ExportDownloads; downloadOrigin: string; completedExportTemplate: ResourceTemplate;
  rpc: (group: Group, partial: Omit<RpcRequest, "requestId">) => Promise<{ result?: unknown; error?: string }>;
  jpegCaptureRpc: (group: Group, partial: JpegCaptureRequest) => Promise<{ result?: unknown; error?: string }>;
};

export function onlineDevices(group: Group): Device[] {
  return [...group.devices.values()].filter((d) => d.socket?.readyState === WebSocket.OPEN);
}

export function chooseDevice(group: Group, requestedId: string | undefined, mutation = false): { device?: Device; error?: string } {
  const online = onlineDevices(group);
  if (requestedId) {
    const device = group.devices.get(requestedId);
    return device ? { device } : { error: "The requested device is not paired with this group." };
  }
  if (mutation && online.length > 1) return { error: "Choose deviceId explicitly before making this change." };
  if (online.length === 1) return { device: online[0] };
  if (online.length === 0) return { error: "No Super MD devices are connected. Open the app and enable Live Agent Access." };
  return { error: "More than one device is connected; choose deviceId." };
}

export function textResult(value: unknown, isError = false) {
  const text = JSON.stringify(value ?? null);
  return { content: [{ type: "text" as const, text: Buffer.byteLength(text) <= MAX_TEXT_BYTES ? text : JSON.stringify({ error: "The app response exceeds the text result limit." }) }], ...(isError ? { isError: true } : {}) };
}

export function toolResponse(response: { result?: unknown; error?: string }) {
  if (!response.error) return textResult(response.result);
  try {
    const detail = JSON.parse(response.error);
    if (detail && typeof detail === "object" && !Array.isArray(detail) && typeof detail.error === "string") return textResult(detail, true);
  } catch { /* Legacy device error. */ }
  return textResult({ error: response.error }, true);
}

export function imageResult(response: { result?: unknown; error?: string }) {
  if (response.error) return textResult({ error: response.error }, true);
  const image = response.result as Record<string, unknown> | undefined;
  if (!image || image.mime_type !== "image/png" || typeof image.data !== "string" || !Number.isInteger(image.width) || !Number.isInteger(image.height) || typeof image.revision !== "string") return textResult({ error: "The app returned an invalid image response." }, true);
  const bytes = Buffer.from(image.data, "base64");
  if (bytes.length < 8 || bytes.length > 4 * 1024 * 1024 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return textResult({ error: "The app image is not a bounded PNG." }, true);
  const metadata = image.metadata && typeof image.metadata === "object" && Buffer.byteLength(JSON.stringify(image.metadata)) <= 12_000 ? image.metadata : undefined;
  return { content: [{ type: "image" as const, data: bytes.toString("base64"), mimeType: "image/png" }, { type: "text" as const, text: JSON.stringify({ mimeType: "image/png", byteLength: bytes.length, width: image.width, height: image.height, revision: image.revision, serverMs: image.serverMs, metadata }) }] };
}

export async function jpegImageResult(response: { result?: unknown; error?: string }, width: number) {
  if (response.error) return textResult({ error: response.error }, true);
  const image = response.result as Record<string, unknown> | undefined;
  if (!image || typeof image.revision !== "string" || (image.mime_type !== "image/png" && image.mime_type !== "image/jpeg")) return textResult({ error: "The app returned an invalid viewport image response." }, true);
  try {
    const preview = await makeJpegPreview(decodeViewportBase64(image.data), width, image.mime_type, { width: image.width, height: image.height });
    return { content: [{ type: "image" as const, data: preview.data.toString("base64"), mimeType: "image/jpeg" }, { type: "text" as const, text: JSON.stringify({ mimeType: "image/jpeg", byteLength: preview.data.length, width: preview.width, height: preview.height, revision: image.revision, serverMs: image.serverMs, previewOnly: true }) }] };
  } catch (error) {
    return textResult({ error: error instanceof Error ? error.message : "Could not create the bounded JPEG viewport preview." }, true);
  }
}

export function assetSourceResult(response: { result?: unknown; error?: string }, offset = 0, limit = 12_000) {
  if (response.error) return textResult({ error: response.error }, true);
  const value = response.result as Record<string, unknown> | undefined;
  if (!value || typeof value.assetName !== "string" || typeof value.mimeType !== "string" || typeof value.body !== "string" || typeof value.sha256 !== "string") return textResult({ error: "The app returned an invalid original asset." }, true);
  const bytes = Buffer.from(value.body, "base64");
  if (bytes.length < 1 || bytes.length > MAX_ASSET_BYTES || bytes.toString("base64") !== value.body) return textResult({ error: "The original asset is not valid bounded base64." }, true);
  const mimeType = value.mimeType;
  if (mimeType === "image/svg+xml") {
    const text = bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(bytes)) return textResult({ error: "The original SVG is not valid UTF-8." }, true);
    const source = Array.from(text);
    const end = Math.min(source.length, offset + limit);
    return { content: [{ type: "text" as const, text: JSON.stringify({ assetName: value.assetName, mimeType, bytes: bytes.length, sha256: value.sha256, revision: value.revision, source: source.slice(offset, end).join(""), offset, totalChars: source.length, nextOffset: end < source.length ? end : null }) }] };
  }
  if (offset !== 0) return textResult({ error: "Offsets are supported for SVG source only." }, true);
  if (!["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"].includes(mimeType)) return textResult({ error: "The app returned an unsupported original image type." }, true);
  return { content: [{ type: "image" as const, data: bytes.toString("base64"), mimeType }, { type: "text" as const, text: JSON.stringify({ assetName: value.assetName, mimeType, bytes: bytes.length, sha256: value.sha256, revision: value.revision }) }] };
}

export async function readTarget(deps: RelayTransportDeps, group: Group, selected?: string, tab?: string): Promise<{ deviceId?: string; tabId?: string; error?: string }> {
  const chosen = chooseDevice(group, selected);
  if (!chosen.device) return { error: chosen.error };
  if (tab) return { deviceId: chosen.device.deviceId, tabId: tab };
  const listing = await deps.rpc(group, { action: "list_tabs", deviceId: chosen.device.deviceId });
  if (listing.error) return { error: listing.error };
  const value = listing.result as { tabs?: Array<Record<string, unknown>> } | undefined;
  const tabs = Array.isArray(value?.tabs) ? value.tabs : [];
  const active = tabs.filter((item) => item.active === true);
  const row = active.length === 1 ? active[0] : tabs.length === 1 ? tabs[0] : null;
  const id = row && (typeof row.tabId === "string" ? row.tabId : typeof row.id === "string" ? row.id : null);
  return id ? { deviceId: chosen.device.deviceId, tabId: id } : { error: "Choose tabId from list_tabs; several windows or no active document are available." };
}

export function exportJobResult(deps: RelayTransportDeps, group: Group, selected: string | undefined, jobId: string | undefined, response: { result?: unknown; error?: string }) {
  if (response.error || !jobId) return toolResponse(response);
  const device = chooseDevice(group, selected).device;
  if (!device) return toolResponse(response);
  const lease = deps.exportsAvailable.issue(group.groupId, device.deviceId, jobId, response.result);
  if (!lease) return toolResponse(response);
  const uri = deps.downloadOrigin + "/download/" + lease.token;
  const metadata = { ...(response.result as Record<string, unknown>), download: { url: uri, expiresAt: new Date(lease.expiresAt).toISOString(), mimeType: lease.mimeType, bytes: lease.bytes, sha256: lease.sha256 } };
  return { content: [{ type: "resource_link" as const, uri, name: lease.filename, mimeType: lease.mimeType, size: lease.bytes, description: "Private exported file; expires in ten minutes. The Super MD device must remain connected." }, ...textResult(metadata).content] };
}

const DEFAULT_ORIGIN = "http://127.0.0.1:8787";
const NO_DEVICES_ERR = { error: "No Super MD devices are connected. Open the app and enable Live Agent Access." };
const DEFAULT_DEPS: RelayTransportDeps = {
  groups: new Map(), exportsAvailable: new ExportDownloads(), downloadOrigin: DEFAULT_ORIGIN,
  completedExportTemplate: new ResourceTemplate(DEFAULT_ORIGIN + "/download/{token}", { list: undefined }),
  rpc: async () => NO_DEVICES_ERR, jpegCaptureRpc: async () => NO_DEVICES_ERR,
};

export function registerTools(server: McpServer, group: Group, deps: RelayTransportDeps = DEFAULT_DEPS): void {
  const { rpc, jpegCaptureRpc, exportsAvailable, completedExportTemplate, groups } = deps;
  server.registerResource("completed-export", completedExportTemplate, {
    title: "Completed Super MD export", description: "Private MD, SMD or PDF export. Small files support MCP resource reads; large files stream over the same HTTPS URL.",
  }, async (uri, variables) => {
    const token = variables.token;
    if (typeof token !== "string") throw Error("Invalid export resource");
    const lease = exportsAvailable.get(token);
    if (!lease || lease.groupId !== group.groupId || groups.get(group.groupId) !== group || !group.devices.has(lease.deviceId)) throw Error("This export resource expired or was revoked.");
    if (lease.bytes > 3 * 1024 * 1024) throw Error("Use the private HTTPS download for exports over 3 MiB; it streams without loading the file into model context.");
    const chunks: Buffer[] = [];
    for await (const chunk of exportsAvailable.stream(token, (info, offset, limit) => rpc(group, { action: "document_action", documentAction: "export_chunk", deviceId: info.deviceId, jobId: info.jobId, offset, limit }))) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    if (lease.format === "md" && !Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes)) throw Error("This Markdown export is not valid UTF-8; download the original bytes over HTTPS.");
    return { contents: [lease.format === "md" ? { uri: uri.href, mimeType: lease.mimeType, text: bytes.toString("utf8") } : { uri: uri.href, mimeType: lease.mimeType, blob: bytes.toString("base64") }] };
  });
  server.registerTool("list_devices", { description: "List devices paired with this Super MD workspace and their live/last-seen state. Includes current open tabs for connected devices.", inputSchema: TOOL_INPUT_SCHEMAS.list_devices }, async () => {
    const devices = await Promise.all([...group.devices.values()].map(async (device) => {
      const online = device.socket?.readyState === WebSocket.OPEN;
      let tabs: unknown[] = [];
      if (online) {
        const tabsResponse = await rpc(group, { action: "list_tabs", deviceId: device.deviceId });
        if (!tabsResponse.error) {
          const value = tabsResponse.result as { tabs?: unknown[] } | unknown[] | undefined;
          tabs = (Array.isArray(value) ? value : Array.isArray(value?.tabs) ? value.tabs : []).slice(0, 100);
        }
      }
      return { deviceId: device.deviceId, displayName: device.displayName, platform: device.platform, status: online ? "connected" : "offline", lastSeen: new Date(device.lastSeen).toISOString(), tabs };
    }));
    return textResult({ devices });
  });
  server.registerTool("list_tabs", { description: "List open tabs on a connected device. Supply deviceId when the workspace has multiple connected devices.", inputSchema: TOOL_INPUT_SCHEMAS.list_tabs }, async ({ deviceId: selected }) => toolResponse(await rpc(group, { action: "list_tabs", deviceId: selected })));
  server.registerTool("read_tab", { description: "Read only the needed Markdown/prose page. Omit tabId for the current document. heading accepts an outline index, exact title, slug, or numbered prefix such as 7.4; returns that section and nested subsections, bounded by limit. Follow the cursor within sectionEnd. Use view:source for exact editable source; prose skips SVG bodies. Whole-file PDF/MD/SMD is available through export followed by job_status and its private resource link.", inputSchema: TOOL_INPUT_SCHEMAS.read_tab }, async ({ deviceId: selected, tabId: tab, heading, view, offset, limit }) => {
    const target = await readTarget(deps, group, selected, tab);
    if (target.error) return textResult({ error: target.error }, true);
    return toolResponse(await rpc(group, { action: "read_tab", deviceId: target.deviceId, tabId: target.tabId, heading, view, offset, limit }));
  });
  server.registerTool("search_tab", { description: "Search source with paged code-point offsets. Follow nextOffset for more matches. Regex accepts only safe fixed-width literals, dot, character classes and anchors; no groups, alternation or quantifiers.", inputSchema: TOOL_INPUT_SCHEMAS.search_tab }, async ({ deviceId: selected, tabId: tab, query, offset, limit, context, caseSensitive, wholeWord, regex, excludeDiagrams }) => toolResponse(await rpc(group, { action: "search_tab", deviceId: selected, tabId: tab, query, offset, limit, context, caseSensitive, wholeWord, regex, excludeDiagrams })));
  server.registerTool("patch_tab", { description: "Atomically edit an open tab, including inactive tabs without changing focus. Operations run sequentially; applied counts completed operations. Exact replace defaults to one unique match; count:'all' replaces all. expectedCount asserts the match count (if greater than one, omitted count means all). Writes require the latest SHA-256 expectedRevision; never guess it.", inputSchema: TOOL_INPUT_SCHEMAS.patch_tab }, async ({ deviceId: selected, tabId: tab, expectedRevision, operations }) => toolResponse(await rpc(group, { action: "patch_tab", deviceId: selected, tabId: tab, expectedRevision, operations })));
  server.registerTool("render_tab", { description: "Render the current reading/editor viewport as an MCP image. Standard quality returns a compact JPEG preview; high quality returns the lossless PNG. Supply deviceId when ambiguous.", inputSchema: TOOL_INPUT_SCHEMAS.render_tab }, async ({ deviceId: selected, tabId: tab, width, quality }) => {
    const selectedQuality = quality ?? "standard";
    const edge = width ?? (selectedQuality === "high" ? 1600 : 1000);
    const request = { action: "render_tab" as const, deviceId: selected, tabId: tab, width: edge };
    return selectedQuality === "high" ? imageResult(await rpc(group, request)) : jpegImageResult(await jpegCaptureRpc(group, request), edge);
  });
  server.registerTool("view_current", {
    description: "Use FIRST for the current Super MD page or selected/highlighted text. Returns the exact selection, surrounding Markdown, reading position and visible diagram references in one call, with an optional matching image. Set includeImage:false for selection/text-only questions.",
    inputSchema: TOOL_INPUT_SCHEMAS.view_current,
  }, async ({ deviceId: selected, tabId: requestedTab, width, quality, includeImage }) => {
    const chosen = chooseDevice(group, selected);
    if (!chosen.device) return textResult({ error: chosen.error }, true);
    if (!chosen.device.socket || chosen.device.socket.readyState !== WebSocket.OPEN) return textResult({ error: "The selected Super MD device is offline." }, true);
    const chosenDeviceId = chosen.device.deviceId;
    const selectedQuality = quality ?? "standard";
    let tab = requestedTab;
    if (!tab) {
      const listed = await rpc(group, { action: "list_tabs", deviceId: chosenDeviceId });
      if (listed.error) return toolResponse(listed);
      const value = listed.result as { tabs?: unknown } | unknown[] | undefined;
      const tabs = Array.isArray(value) ? value : value && Array.isArray(value.tabs) ? value.tabs : [];
      const validTabs = tabs.filter((item): item is { id: string; active?: boolean } => !!item && typeof item === "object" && typeof (item as Record<string, unknown>).id === "string");
      const active = validTabs.filter((item) => item.active === true);
      const target = active.length === 1 ? active[0] : active.length === 0 && validTabs.length === 1 ? validTabs[0] : undefined;
      if (!target) return textResult({ error: active.length > 1 || validTabs.length > 1 ? "Could not choose a tab safely: provide tabId when multiple tabs are open or active." : "No open tab was returned by the selected device." }, true);
      tab = target.id;
    }
    const contextResponse = await rpc(group, { action: "document_action", documentAction: "get_context", deviceId: chosenDeviceId, tabId: tab, options: { limit: 4000 } });
    if (contextResponse.error) return toolResponse(contextResponse);
    const context = contextResponse.result as Record<string, unknown> | undefined;
    if (!context || typeof context.tabId !== "string" || !context.tabId || typeof context.revision !== "string" || !WIRE_REVISION_RE.test(context.revision)) return textResult({ error: "The app returned invalid reading context for the selected tab." }, true);
    const normalizedContext = normalizeReadingContext(context) ?? context;
    const readingContext = normalizedContext.tabId === tab ? normalizedContext : { ...normalizedContext, tabId: tab, nativeTabId: normalizedContext.tabId };

    let previewInfo: { mimeType: "image/jpeg" | "image/png"; byteLength: number; width: number; height: number; serverMs?: number; previewOnly: boolean } | undefined;
    let previewContent: { type: "image"; data: string; mimeType: string } | undefined;
    let captureContext: Record<string, unknown> | undefined;
    let finalReadingContext = readingContext;
    let readingContextSource: "context_read" | "viewport_capture" = "context_read";
    let readingContextAlignedWithCapture: boolean | undefined;
    if (includeImage !== false) {
      const edge = width ?? (selectedQuality === "high" ? 1600 : 1000);
      const request = { action: "render_tab" as const, deviceId: chosenDeviceId, tabId: tab, expectedRevision: context.revision, width: edge };
      const rendered = selectedQuality === "high" ? await rpc(group, request) : await jpegCaptureRpc(group, request);
      if (rendered.error) return toolResponse(rendered);
      const image = rendered.result as Record<string, unknown> | undefined;
      if (!image || image.revision !== context.revision) return textResult({ error: "The reading tab changed while its viewport was being captured; request the current view again." }, true);
      const checked = selectedQuality === "high" ? imageResult(rendered) : await jpegImageResult(rendered, edge);
      if ("isError" in checked && checked.isError) return checked;
      previewContent = checked.content.find((item) => item.type === "image") as { type: "image"; data: string; mimeType: string } | undefined;
      if (!previewContent) return textResult({ error: "The app returned an invalid viewport image response." }, true);
      const mimeType = selectedQuality === "high" ? "image/png" as const : "image/jpeg" as const;
      const checkedInfo = JSON.parse(String(checked.content.find((item) => item.type === "text")?.text ?? "{}")) as Record<string, unknown>;
      previewInfo = { mimeType, byteLength: Number(checkedInfo.byteLength), width: Number(checkedInfo.width), height: Number(checkedInfo.height), ...(typeof checkedInfo.serverMs === "number" ? { serverMs: checkedInfo.serverMs } : {}), previewOnly: selectedQuality === "standard" };
      const capture = viewportContexts(image, tab, context.revision);
      captureContext = capture.captureContext;
      if (capture.capturedReadingContext) {
        finalReadingContext = readingContext.properties && !capture.capturedReadingContext.properties
          ? { ...capture.capturedReadingContext, properties: readingContext.properties }
          : capture.capturedReadingContext;
        readingContextSource = "viewport_capture";
        readingContextAlignedWithCapture = true;
      } else {
        const initialReading = readingContext.reading as Record<string, unknown> | undefined;
        const capturedReading = capture.captureContext.reading as Record<string, unknown> | undefined;
        if (typeof initialReading?.offset === "number" && typeof capturedReading?.offset === "number") {
          readingContextAlignedWithCapture = capture.captureContext.contextRevisionMatches === true && initialReading.offset === capturedReading.offset;
        }
      }
    }
    const result = {
      deviceId: chosenDeviceId, tabId: tab, revision: context.revision, quality: selectedQuality, readingContext: finalReadingContext, readingContextSource,
      ...(readingContextAlignedWithCapture !== undefined ? { readingContextAlignedWithCapture } : {}),
      ...(captureContext ? { captureContext } : {}), ...(previewInfo ? { imagePreview: previewInfo } : {}),
    };
    const text = JSON.stringify(result);
    if (Buffer.byteLength(text) > 48 * 1024) return textResult({ error: "The current reading context exceeds the bounded response size." }, true);
    return { content: [...(previewContent ? [previewContent] : []), { type: "text" as const, text }] };
  });
  server.registerTool("diagram_action", { description: "List diagrams, read their source, or capture a diagram image. Standard image quality returns a compact JPEG; high quality returns lossless PNG.", inputSchema: TOOL_INPUT_SCHEMAS.diagram_action }, async ({ deviceId: selected, tabId: tab, diagramAction, diagramId, expectedRevision, offset, limit, width, quality }) => {
    if (diagramAction !== "list" && !expectedRevision) return textResult({ error: "Diagram source/image needs expectedRevision from the inventory or reading context." }, true);
    if (diagramAction === "list" && limit !== undefined && limit > 80) return textResult({ error: "Diagram list limit must be between 1 and 80." }, true);
    const action = diagramAction === "list" ? "list_diagrams" : diagramAction === "source" ? "get_diagram" : "get_diagram_image";
    if (diagramAction === "image") {
      const selectedQuality = quality ?? "standard";
      const edge = width ?? (selectedQuality === "high" ? 1600 : 1000);
      const request = { action: "get_diagram_image" as const, deviceId: selected, tabId: tab, diagramId, expectedRevision, width: edge };
      return selectedQuality === "high" ? imageResult(await rpc(group, request)) : jpegImageResult(await jpegCaptureRpc(group, request), edge);
    }
    if (quality !== undefined) return textResult({ error: "quality is only supported for diagramAction image." }, true);
    return toolResponse(await rpc(group, { action, deviceId: selected, tabId: tab, diagramId, expectedRevision, offset, limit, width }));
  });
  server.registerTool("replace_tab_asset", { description: "Replace a linked asset using a path available to the selected Super MD device. The device restricts reads to its configured asset roots; the relay never reads or stores the file.", inputSchema: TOOL_INPUT_SCHEMAS.replace_tab_asset }, async ({ deviceId: selected, tabId: tab, assetName, assetPath, expectedRevision }) => toolResponse(await rpc(group, { action: "replace_tab_asset", deviceId: selected, tabId: tab, assetName, assetPath, expectedRevision })));
  server.registerTool("asset_action", { description: "List embedded assets, retrieve an original image/SVG (SVG source is returned in bounded chunks), or attach model-supplied bytes to a saved portable .smd note. Attachments are limited to 1 MiB and require the note's current source revision; the relay does not read files or fetch URLs.", inputSchema: TOOL_INPUT_SCHEMAS.asset_action }, async ({ deviceId: selected, tabId: tab, assetAction, assetName, mimeType, body, offset, limit, expectedRevision }) => {
    const response = await rpc(group, { action: "asset_action", deviceId: selected, tabId: tab, assetAction, assetName, mimeType, body, offset, limit, expectedRevision });
    return !response.error && assetAction === "source" ? assetSourceResult(response, offset, limit) : toolResponse(response);
  });
  server.registerTool("document_action", { description: "Read exact reading context, create, export, repair LaTeX, open, save, check an export job, or snapshot through Super MD's native UI. Snapshot defaults to JPEG at 1000 pixels; set options.quality to high for lossless PNG at 1600 pixels. options.width overrides the edge from 64 to 1600 pixels. Create/open support options.background. Save preserves the existing path and format; options.saveAs is explicit. Close requires expectedRevision and refuses dirty drafts unless options.discardChanges is true. latex_review proposes indexed repairs; latex_apply applies chosen repairIndices against that revision. Poll job_status after asynchronous open/export. No shell or code execution. For a whole document export use format md, mdzip, smd or pdf; options.section exports only a chosen heading and its descendants. Completed export job_status returns a private expiring download resource link, so file bytes do not consume model tokens. Use outline with options.offset/limit for bounded heading discovery. Android agent exports use the configured folder or Downloads. PDF options match app controls; choose deviceId when ambiguous.", inputSchema: TOOL_INPUT_SCHEMAS.document_action }, async ({ deviceId: selected, documentAction, tabId: tab, expectedRevision, content, options }) => {
    const jobId = options?.jobId;
    if (documentAction === "snapshot") {
      if (!tab) return textResult({ error: "tabId is required for snapshot." }, true);
      const quality = options?.quality ?? "standard";
      const width = options?.width ?? (quality === "high" ? 1600 : 1000);
      const request = { action: "render_tab" as const, deviceId: selected, tabId: tab, expectedRevision, width };
      return quality === "high" ? imageResult(await rpc(group, request)) : jpegImageResult(await jpegCaptureRpc(group, request), width);
    }
    if (options?.quality !== undefined || options?.width !== undefined) return textResult({ error: "Snapshot width and quality options are only supported for documentAction snapshot." }, true);
    let target = { deviceId: selected, tabId: tab };
    if ((documentAction === "get_context" || documentAction === "outline") && !tab) {
      const resolved = await readTarget(deps, group, selected);
      if (resolved.error) return textResult({ error: resolved.error }, true);
      target = { deviceId: resolved.deviceId, tabId: resolved.tabId };
    }
    const response = await rpc(group, { action: "document_action", ...target, documentAction, expectedRevision, content, jobId, options });
    if (documentAction === "job_status") return exportJobResult(deps, group, selected, jobId, response);
    if (documentAction === "get_context" && !response.error) return toolResponse({ ...response, result: normalizeReadingContext(response.result) ?? response.result });
    return toolResponse(response);
  });
}

export function buildServer(group: Group = { groupId: "", connectorHash: "", pairingHash: "", devices: new Map() }, deps: RelayTransportDeps = DEFAULT_DEPS): McpServer {
  const mcp = new McpServer({ name: "super-md-live", version: "0.3.0" });
  registerTools(mcp, group, deps);
  return mcp;
}
