import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import express, { type NextFunction, type Request, type Response } from "express";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { SSEServerTransport } from "@modelcontextprotocol/server-legacy/sse";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { z } from "zod";
import { MAX_FRAME_BYTES, MAX_PENDING, REQUEST_TIMEOUT_MS, validateRpcRequest, validReply, type RpcRequest } from "./protocol.js";
import { decodeViewportBase64, makeJpegPreview, normalizeReadingContext, viewportContexts } from "./preview.js";

type Pending = { resolve: (value: { result?: unknown; error?: string }) => void; timer: NodeJS.Timeout };
type Device = {
  deviceId: string; displayName: string; platform: "android" | "desktop"; deviceKeyHash: string;
  socket: WebSocket | null; pending: Map<string, Pending>; lastSeen: number; jpegPreview: boolean;
};
type Group = { groupId: string; connectorHash: string; pairingHash: string; devices: Map<string, Device> };

const GROUP_ID_RE = /^[a-f0-9]{32}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN_RE = /^[A-Za-z0-9_-]{40,128}$/;
const MAX_GROUPS = boundedEnv("MAX_GROUPS", 1000, 1, 10_000);
const MAX_DEVICES_PER_GROUP = boundedEnv("MAX_DEVICES_PER_GROUP", 32, 1, 128);
const port = boundedEnv("PORT", 8787, 1, 65535);
const requestTimeout = boundedEnv("DEVICE_REQUEST_TIMEOUT_MS", REQUEST_TIMEOUT_MS, 1000, 120_000);
const publicHost = process.env.PUBLIC_HOST?.trim().toLowerCase();
const expectedHost = publicHost ?? `127.0.0.1:${port}`;
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
const groups = new Map<string, Group>();
const sseTransports = new Map<string, { transport: SSEServerTransport; group: Group }>();

function boundedEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} is outside the allowed range`);
  return value;
}
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function groupIdFor(pairingKey: string, connectorHash: string): string {
  return createHash("sha256").update(`supermd-group-v1\0${pairingKey}\0${connectorHash}`).digest("hex").slice(0, 32);
}
function equalSecret(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8"), right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}
function param(value: string | string[] | undefined): string { return typeof value === "string" ? value : ""; }
function validToken(value: unknown): value is string { return typeof value === "string" && TOKEN_RE.test(value); }
function hostAllowed(req: Request): boolean {
  if ((req.headers.host ?? "").toLowerCase() !== expectedHost) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host.toLowerCase() === expectedHost; } catch { return false; }
}
function hostGuard(req: Request, res: Response, next: NextFunction): void {
  if (!hostAllowed(req)) { res.status(403).send("Host or Origin not allowed"); return; }
  next();
}
function sendJson(ws: WebSocket, value: unknown): void {
  const data = JSON.stringify(value);
  if (Buffer.byteLength(data) > MAX_FRAME_BYTES) throw new Error("Relay frame exceeds its limit");
  ws.send(data);
}
function rejectPending(device: Device, message: string): void {
  for (const [id, pending] of device.pending) {
    clearTimeout(pending.timer); pending.resolve({ error: message }); device.pending.delete(id);
  }
}
function authenticatedGroup(groupId: string, connectorKey: string): Group | null {
  const group = groups.get(groupId);
  return group && equalSecret(group.connectorHash, digest(connectorKey)) ? group : null;
}
function isCapability(req: Request): boolean {
  const groupId = param(req.params.groupId), key = param(req.params.connectorKey);
  return GROUP_ID_RE.test(groupId) && validToken(key);
}
function onlineDevices(group: Group): Device[] { return [...group.devices.values()].filter((d) => d.socket?.readyState === WebSocket.OPEN); }
function chooseDevice(group: Group, requestedId: string | undefined, mutation = false): { device?: Device; error?: string } {
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
function rpc(group: Group, partial: Omit<RpcRequest, "requestId">): Promise<{ result?: unknown; error?: string }> {
  const chosen = chooseDevice(group, partial.deviceId, partial.action === "patch_tab" || partial.action === "document_action" || partial.action === "replace_tab_asset" || (partial.action === "asset_action" && partial.assetAction === "attach"));
  const device = chosen.device;
  if (!device) return Promise.resolve({ error: chosen.error });
  if (!device.socket || device.socket.readyState !== WebSocket.OPEN) return Promise.resolve({ error: "The selected Super MD device is offline." });
  if (device.pending.size >= MAX_PENDING) return Promise.resolve({ error: "The selected device already has the maximum number of requests in progress." });
  const requestId = randomUUID();
  const request = validateRpcRequest({ requestId, deviceId: device.deviceId, ...partial });
  return new Promise((resolve) => {
    const timer = setTimeout(() => { device.pending.delete(requestId); resolve({ error: "The app did not answer before the request timed out." }); }, requestTimeout);
    device.pending.set(requestId, { resolve, timer });
    try { sendJson(device.socket!, { type: "request", ...request }); }
    catch (error) { clearTimeout(timer); device.pending.delete(requestId); resolve({ error: error instanceof Error ? error.message : "Could not send the request to the app." }); }
  });
}
function jpegCaptureRpc(group: Group, partial: Omit<RpcRequest, "requestId" | "action" | "tabId" | "width"> & { action: "render_tab" | "get_diagram_image"; tabId: string; width: number }) {
  const chosen = chooseDevice(group, partial.deviceId);
  const device = chosen.device;
  const imageFormat = device?.jpegPreview ? "jpeg" as const : undefined;
  return rpc(group, { ...partial, ...(imageFormat ? { imageFormat } : {}) });
}
function parseSocketText(raw: RawData): unknown {
  const text = raw.toString();
  if (Buffer.byteLength(text) > MAX_FRAME_BYTES) throw new Error("Relay frame exceeds its limit");
  return JSON.parse(text) as unknown;
}
function textResult(value: unknown, isError = false) {
  const text = JSON.stringify(value ?? null);
  return { content: [{ type: "text" as const, text: Buffer.byteLength(text) <= 64 * 1024 ? text : JSON.stringify({ error: "The app response exceeds the text result limit." }) }], ...(isError ? { isError: true } : {}) };
}
function toolResponse(response: { result?: unknown; error?: string }) { return response.error ? textResult({ error: response.error }, true) : textResult(response.result); }
function imageResult(response: { result?: unknown; error?: string }) {
  if (response.error) return textResult({ error: response.error }, true);
  const image = response.result as Record<string, unknown> | undefined;
  if (!image || image.mime_type !== "image/png" || typeof image.data !== "string" || !Number.isInteger(image.width) || !Number.isInteger(image.height) || typeof image.revision !== "string") return textResult({ error: "The app returned an invalid image response." }, true);
  const bytes = Buffer.from(image.data, "base64");
  if (bytes.length < 8 || bytes.length > 4 * 1024 * 1024 || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return textResult({ error: "The app image is not a bounded PNG." }, true);
  const metadata = image.metadata && typeof image.metadata === "object" && Buffer.byteLength(JSON.stringify(image.metadata)) <= 12_000 ? image.metadata : undefined;
  return { content: [{ type: "image" as const, data: bytes.toString("base64"), mimeType: "image/png" }, { type: "text" as const, text: JSON.stringify({ width: image.width, height: image.height, revision: image.revision, metadata }) }] };
}
async function jpegImageResult(response: { result?: unknown; error?: string }, width: number) {
  if (response.error) return textResult({ error: response.error }, true);
  const image = response.result as Record<string, unknown> | undefined;
  if (!image || typeof image.revision !== "string" || (image.mime_type !== "image/png" && image.mime_type !== "image/jpeg")) return textResult({ error: "The app returned an invalid viewport image response." }, true);
  try {
    const preview = await makeJpegPreview(decodeViewportBase64(image.data), width, image.mime_type, { width: image.width, height: image.height });
    return { content: [
      { type: "image" as const, data: preview.data.toString("base64"), mimeType: "image/jpeg" },
      { type: "text" as const, text: JSON.stringify({ mimeType: "image/jpeg", width: preview.width, height: preview.height, revision: image.revision, previewOnly: true }) },
    ] };
  } catch (error) {
    return textResult({ error: error instanceof Error ? error.message : "Could not create the bounded JPEG viewport preview." }, true);
  }
}
function assetSourceResult(response: { result?: unknown; error?: string }, offset = 0, limit = 12_000) {
  if (response.error) return textResult({ error: response.error }, true);
  const value = response.result as Record<string, unknown> | undefined;
  if (!value || typeof value.assetName !== "string" || typeof value.mimeType !== "string" || typeof value.body !== "string" || typeof value.sha256 !== "string") return textResult({ error: "The app returned an invalid original asset." }, true);
  const bytes = Buffer.from(value.body, "base64");
  if (bytes.length < 1 || bytes.length > 1024 * 1024 || bytes.toString("base64") !== value.body) return textResult({ error: "The original asset is not valid bounded base64." }, true);
  const mimeType = value.mimeType;
  if (mimeType === "image/svg+xml") {
    const text = bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(bytes)) return textResult({ error: "The original SVG is not valid UTF-8." }, true);
    // Source offsets count Unicode characters, as in the document tools.
    // Never split an emoji/surrogate pair at a chunk boundary.
    const source = Array.from(text);
    const end = Math.min(source.length, offset + limit);
    return { content: [{ type: "text" as const, text: JSON.stringify({ assetName: value.assetName, mimeType, bytes: bytes.length, sha256: value.sha256, revision: value.revision, source: source.slice(offset, end).join(""), offset, totalChars: source.length, nextOffset: end < source.length ? end : null }) }] };
  }
  if (offset !== 0) return textResult({ error: "Offsets are supported for SVG source only." }, true);
  if (!["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"].includes(mimeType)) return textResult({ error: "The app returned an unsupported original image type." }, true);
  return { content: [{ type: "image" as const, data: bytes.toString("base64"), mimeType }, { type: "text" as const, text: JSON.stringify({ assetName: value.assetName, mimeType, bytes: bytes.length, sha256: value.sha256, revision: value.revision }) }] };
}
function registerTools(server: McpServer, group: Group): void {
  const deviceId = z.string().regex(UUID_RE).optional();
  const tabId = z.string().min(1).max(512);
  const pageSize = z.enum(["a3","a4","a5","a6","iso-b4","iso-b5","iso-b6","letter","legal","tabloid","executive"]);
  const exportOptions = z.object({
    pageSize: pageSize.optional(), margin: z.number().min(4).max(60).optional(), fontSize: z.number().min(5).max(24).optional(),
    lineHeight: z.number().min(0.9).max(2.2).optional(), paragraphSpacing: z.number().min(0).max(3).optional(),
    fontFamily: z.string().max(128).optional(), pageNumbers: z.boolean().optional(), themed: z.boolean().optional(),
  });
  server.registerTool("list_devices", { description: "List devices paired with this Super MD workspace and their live/last-seen state. Includes current open tabs for connected devices.", inputSchema: {} }, async () => {
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
  server.registerTool("list_tabs", { description: "List open tabs on a connected device. Supply deviceId when the workspace has multiple connected devices.", inputSchema: { deviceId } }, async ({ deviceId: selected }) => toolResponse(await rpc(group, { action: "list_tabs", deviceId: selected })));
  server.registerTool("read_tab", { description: "Read a bounded source or rendered-prose range from an open tab, including its SHA-256 revision.", inputSchema: { deviceId, tabId, view: z.enum(["source","prose"]).optional(), offset: z.number().int().min(0).max(20_000_000).optional(), limit: z.number().int().min(1).max(12_000).optional() } }, async ({ deviceId: selected, tabId: tab, view, offset, limit }) => toolResponse(await rpc(group, { action: "read_tab", deviceId: selected, tabId: tab, view, offset, limit })));
  server.registerTool("search_tab", { description: "Search an open tab and return bounded matches with line context.", inputSchema: { deviceId, tabId, query: z.string().min(1).max(2048), limit: z.number().int().min(1).max(25).optional(), context: z.number().int().min(0).max(500).optional() } }, async ({ deviceId: selected, tabId: tab, query, limit, context }) => toolResponse(await rpc(group, { action: "search_tab", deviceId: selected, tabId: tab, query, limit, context })));
  server.registerTool("patch_tab", { description: "Edit an open tab using bounded source operations. Requires an unchanged SHA-256 revision; stale edits are rejected. With multiple devices connected, deviceId is required.", inputSchema: { deviceId, tabId, expectedRevision: z.string().regex(/^[a-f0-9]{64}$/i), operations: z.array(z.record(z.string(), z.unknown())).min(1).max(100) } }, async ({ deviceId: selected, tabId: tab, expectedRevision, operations }) => toolResponse(await rpc(group, { action: "patch_tab", deviceId: selected, tabId: tab, expectedRevision, operations })));
  server.registerTool("render_tab", { description: "Render the current reading/editor viewport as an MCP image. Standard quality returns a compact JPEG preview; high quality returns the lossless PNG. Supply deviceId when ambiguous.", inputSchema: { deviceId, tabId, width: z.number().int().min(64).max(1600).optional(), quality: z.enum(["standard", "high"]).optional() } }, async ({ deviceId: selected, tabId: tab, width, quality }) => {
    const selectedQuality = quality ?? "standard";
    const edge = width ?? (selectedQuality === "high" ? 1600 : 1000);
    const request = { action: "render_tab" as const, deviceId: selected, tabId: tab, width: edge };
    return selectedQuality === "high" ? imageResult(await rpc(group, request)) : jpegImageResult(await jpegCaptureRpc(group, request), edge);
  });
  server.registerTool("view_current", {
    description: "Use FIRST for the current Super MD page or selected/highlighted text. Returns the exact selection, surrounding Markdown, reading position and visible diagram references in one call, with an optional matching image. Set includeImage:false for selection/text-only questions.",
    inputSchema: { deviceId, tabId: tabId.optional(), width: z.number().int().min(64).max(1600).optional(), quality: z.enum(["standard", "high"]).optional(), includeImage: z.boolean().optional() },
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
    if (!context || typeof context.tabId !== "string" || !context.tabId || typeof context.revision !== "string" || !/^[a-f0-9]{64}$/i.test(context.revision)) return textResult({ error: "The app returned invalid reading context for the selected tab." }, true);
    const normalizedContext = normalizeReadingContext(context) ?? context;
    const readingContext = normalizedContext.tabId === tab ? normalizedContext : { ...normalizedContext, tabId: tab, nativeTabId: normalizedContext.tabId };

    let previewInfo: { mimeType: "image/jpeg" | "image/png"; width: number; height: number; previewOnly: boolean } | undefined;
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
      previewInfo = { mimeType, width: Number(checkedInfo.width), height: Number(checkedInfo.height), previewOnly: selectedQuality === "standard" };
      const capture = viewportContexts(image, tab, context.revision);
      captureContext = capture.captureContext;
      if (capture.capturedReadingContext) {
        finalReadingContext = capture.capturedReadingContext;
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
      deviceId: chosenDeviceId,
      tabId: tab,
      revision: context.revision,
      quality: selectedQuality,
      readingContext: finalReadingContext,
      readingContextSource,
      ...(readingContextAlignedWithCapture !== undefined ? { readingContextAlignedWithCapture } : {}),
      ...(captureContext ? { captureContext } : {}),
      ...(previewInfo ? { imagePreview: previewInfo } : {}),
    };
    const text = JSON.stringify(result);
    if (Buffer.byteLength(text) > 48 * 1024) return textResult({ error: "The current reading context exceeds the bounded response size." }, true);
    return { content: [...(previewContent ? [previewContent] : []), { type: "text" as const, text }] };
  });
  server.registerTool("diagram_action", { description: "List diagrams, read their source, or capture a diagram image. Standard image quality returns a compact JPEG; high quality returns lossless PNG.", inputSchema: { deviceId, tabId, diagramAction: z.enum(["list","source","image"]), diagramId: z.string().min(1).max(128).optional(), expectedRevision: z.string().regex(/^[a-f0-9]{64}$/i), offset: z.number().int().min(0).max(20_000_000).optional(), limit: z.number().int().min(1).max(12_000).optional(), width: z.number().int().min(64).max(1600).optional(), quality: z.enum(["standard", "high"]).optional() } }, async ({ deviceId: selected, tabId: tab, diagramAction, diagramId, expectedRevision, offset, limit, width, quality }) => {
    const action = diagramAction === "list" ? "list_diagrams" : diagramAction === "source" ? "get_diagram" : "get_diagram_image";
    if (diagramAction === "image") {
      const selectedQuality = quality ?? "standard";
      const edge = width ?? (selectedQuality === "high" ? 1600 : 1000);
      const request = { action: "get_diagram_image" as const, deviceId: selected, tabId: tab, diagramId, expectedRevision, width: edge };
      return selectedQuality === "high" ? imageResult(await rpc(group, request)) : jpegImageResult(await jpegCaptureRpc(group, request), edge);
    }
    if (quality !== undefined) return textResult({ error: "quality is only supported for diagramAction image." }, true);
    const response = await rpc(group, { action, deviceId: selected, tabId: tab, diagramId, expectedRevision, offset, limit, width });
    return toolResponse(response);
  });
  server.registerTool("replace_tab_asset", { description: "Replace a linked asset using a path available to the selected Super MD device. The device restricts reads to its configured asset roots; the relay never reads or stores the file.", inputSchema: { deviceId, tabId, assetName: z.string().min(1).max(256), assetPath: z.string().min(1).max(4096), expectedRevision: z.string().regex(/^[a-f0-9]{64}$/i) } }, async ({ deviceId: selected, tabId: tab, assetName, assetPath, expectedRevision }) => toolResponse(await rpc(group, { action: "replace_tab_asset", deviceId: selected, tabId: tab, assetName, assetPath, expectedRevision })));
  server.registerTool("asset_action", { description: "List embedded assets, retrieve an original image/SVG (SVG source is returned in bounded chunks), or attach model-supplied bytes to a saved portable .smd note. Attachments are limited to 1 MiB and require the note's current source revision; the relay does not read files or fetch URLs.", inputSchema: { deviceId, tabId, assetAction: z.enum(["list", "source", "attach"]), assetName: z.string().min(1).max(256).optional(), mimeType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/svg+xml"]).optional(), body: z.string().max(1_400_000).optional(), offset: z.number().int().min(0).max(1_048_576).optional(), limit: z.number().int().min(1).max(12_000).optional(), expectedRevision: z.string().regex(/^[a-f0-9]{64}$/i) } }, async ({ deviceId: selected, tabId: tab, assetAction, assetName, mimeType, body, offset, limit, expectedRevision }) => {
    const response = await rpc(group, { action: "asset_action", deviceId: selected, tabId: tab, assetAction, assetName, mimeType, body, offset, limit, expectedRevision });
    if (response.error) return toolResponse(response);
    if (assetAction === "source") return assetSourceResult(response, offset, limit);
    return toolResponse(response);
  });
  server.registerTool("document_action", { description: "Read exact reading context, create, export, repair LaTeX, open, save, check an export job, or snapshot through Super MD's native UI. Snapshot defaults to JPEG at 1000 pixels; set options.quality to high for lossless PNG at 1600 pixels. options.width overrides the edge from 64 to 1600 pixels. No shell or code execution. PDF options match app controls; choose deviceId when ambiguous.", inputSchema: { deviceId, documentAction: z.enum(["get_context","create","export","latexfix","open","save","snapshot","job_status"]), tabId: tabId.optional(), expectedRevision: z.string().regex(/^[a-f0-9]{64}$/i).optional(), operations: z.array(z.record(z.string(), z.unknown())).max(100).optional(), content: z.string().max(60_000).optional(), options: exportOptions.extend({format:z.enum(["pdf","smd","md"]).optional(),repairIndices:z.array(z.number().int().min(0)).max(40).optional(),filename:z.string().max(256).optional(),jobId:z.string().max(128).optional(),limit:z.number().int().min(1).max(500).optional(),width:z.number().int().min(64).max(1600).optional(),quality:z.enum(["standard","high"]).optional()}).optional() } }, async ({ deviceId: selected, documentAction, tabId: tab, expectedRevision, operations, content, options }) => {
    const jobId = options?.jobId;
    if (documentAction === "snapshot") {
      if (!tab) return textResult({ error: "tabId is required for snapshot." }, true);
      const quality = options?.quality ?? "standard";
      const width = options?.width ?? (quality === "high" ? 1600 : 1000);
      const request = { action: "render_tab" as const, deviceId: selected, tabId: tab, expectedRevision, width };
      return quality === "high" ? imageResult(await rpc(group, request)) : jpegImageResult(await jpegCaptureRpc(group, request), width);
    }
    if (options?.quality !== undefined || options?.width !== undefined) return textResult({ error: "Snapshot width and quality options are only supported for documentAction snapshot." }, true);
    const response = await rpc(group, { action: "document_action", deviceId: selected, documentAction, tabId: tab, expectedRevision, operations, content, jobId, options });
    if (documentAction === "get_context" && !response.error) {
      return toolResponse({ ...response, result: normalizeReadingContext(response.result) ?? response.result });
    }
    return toolResponse(response);
  });
}
function buildServer(group: Group): McpServer { const mcp = new McpServer({ name: "super-md-live", version: "0.2.1" }); registerTools(mcp, group); return mcp; }

const modernHandler = createMcpHandler((ctx) => {
  const path = new URL(ctx.requestInfo!.url).pathname.split("/");
  const group = path[2] && path[3] ? authenticatedGroup(path[2], path[3]) : null;
  return buildServer(group ?? { groupId: "", connectorHash: "", pairingHash: "", devices: new Map() });
});
const modernNodeHandler = toNodeHandler(modernHandler, { maxRequestBodySize: 2 * 1024 * 1024 });

app.disable("x-powered-by");
app.get("/health", (_req, res) => res.status(200).json({ status: "ok", activeGroups: groups.size, connectedDevices: [...groups.values()].reduce((n, g) => n + onlineDevices(g).length, 0) }));
app.post("/device/enroll", hostGuard, express.json({ limit: "8kb", strict: true }), (req, res) => {
  const body = req.body as Record<string, unknown>;
  const groupId = body.groupId, pairingKey = body.pairingKey, connectorKey = body.connectorKey;
  const deviceId = body.deviceId, deviceKey = body.deviceKey;
  const displayName = typeof body.displayName === "string" ? body.displayName.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 80) : "";
  const platform = body.platform;
  if (typeof groupId !== "string" || !GROUP_ID_RE.test(groupId) || !validToken(pairingKey) || !validToken(connectorKey) || !validToken(deviceKey) || typeof deviceId !== "string" || !UUID_RE.test(deviceId) || !displayName || (platform !== "android" && platform !== "desktop")) { res.status(400).json({ error: "Invalid pairing or device registration" }); return; }
  const connectorHash = digest(connectorKey);
  const pairingHash = digest(pairingKey);
  if (!equalSecret(groupId, groupIdFor(pairingKey, connectorHash))) { res.status(401).json({ error: "Pairing file authentication failed" }); return; }
  let group = groups.get(groupId);
  if (!group) {
    if (groups.size >= MAX_GROUPS) { res.status(503).json({ error: "Relay group capacity reached" }); return; }
    group = { groupId, connectorHash, pairingHash, devices: new Map() };
    groups.set(groupId, group);
  } else if (!equalSecret(group.connectorHash, connectorHash) || !equalSecret(group.pairingHash, pairingHash)) {
    res.status(401).json({ error: "Pairing credentials do not match this group" }); return;
  }
  const previous = group.devices.get(deviceId);
  if (!previous && group.devices.size >= MAX_DEVICES_PER_GROUP) { res.status(503).json({ error: "Device capacity reached" }); return; }
  const deviceKeyHash = digest(deviceKey);
  if (previous && !equalSecret(previous.deviceKeyHash, deviceKeyHash)) {
    rejectPending(previous, "The device credentials were replaced by the pairing owner.");
    previous.socket?.close(4003, "Device credentials replaced");
    group.devices.set(deviceId, { deviceId, displayName, platform, deviceKeyHash, socket: null, pending: new Map(), lastSeen: Date.now(), jpegPreview: false });
  } else if (previous) {
    previous.displayName = displayName;
    previous.platform = platform;
    previous.lastSeen = Date.now();
  } else {
    group.devices.set(deviceId, { deviceId, displayName, platform, deviceKeyHash, socket: null, pending: new Map(), lastSeen: Date.now(), jpegPreview: false });
  }
  res.status(200).json({ groupId });
});

app.get("/mcp/:groupId/:connectorKey", hostGuard, (req, res) => {
  if (!isCapability(req)) { res.status(401).send("Invalid MCP capability"); return; }
  const group = authenticatedGroup(param(req.params.groupId), param(req.params.connectorKey));
  if (!group) { res.status(401).send("Invalid MCP capability"); return; }
  const path = req.originalUrl.split("?")[0]!;
  const transport = new SSEServerTransport(`${path}/messages`, res);
  sseTransports.set(transport.sessionId, { transport, group });
  transport.onclose = () => sseTransports.delete(transport.sessionId);
  void buildServer(group).connect(transport).catch(() => { sseTransports.delete(transport.sessionId); res.end(); });
});
app.post("/mcp/:groupId/:connectorKey/messages", hostGuard, express.json({ limit: "2mb", strict: true }), async (req, res) => {
  if (!isCapability(req)) { res.status(401).send("Invalid MCP capability"); return; }
  const group = authenticatedGroup(param(req.params.groupId), param(req.params.connectorKey));
  const sessionId = req.query.sessionId;
  const route = typeof sessionId === "string" ? sseTransports.get(sessionId) : undefined;
  if (!group || route?.group !== group) { res.status(404).send("MCP session not found"); return; }
  try { await route.transport.handlePostMessage(req, res, req.body); }
  catch { if (!res.headersSent) res.status(400).send("Invalid MCP message"); }
});
app.all("/mcp/:groupId/:connectorKey", hostGuard, (req, res, next) => {
  if (!isCapability(req)) { res.status(401).send("Invalid MCP capability"); return; }
  if (req.method === "HEAD") { res.sendStatus(authenticatedGroup(param(req.params.groupId), param(req.params.connectorKey)) ? 200 : 401); return; }
  if (req.method === "OPTIONS") { if (!authenticatedGroup(param(req.params.groupId), param(req.params.connectorKey))) { res.sendStatus(401); return; } res.setHeader("Allow", "GET, HEAD, OPTIONS, POST"); res.sendStatus(204); return; }
  if (req.method === "GET") { next(); return; }
  if (!authenticatedGroup(param(req.params.groupId), param(req.params.connectorKey))) { res.status(401).send("Invalid MCP capability"); return; }
  void modernNodeHandler(req, res).catch(() => { if (!res.headersSent) res.status(500).send("MCP request failed"); });
});
app.post("/device/revoke", hostGuard, express.json({ limit: "8kb", strict: true }), (req, res) => {
  const {groupId, pairingKey, deviceId} = req.body ?? {};
  if (typeof groupId !== "string" || !GROUP_ID_RE.test(groupId) || !validToken(pairingKey) || typeof deviceId !== "string" || !UUID_RE.test(deviceId)) { res.status(400).json({error:"Invalid revocation request"}); return; }
  const group = groups.get(groupId);
  if (group && !equalSecret(group.pairingHash, digest(pairingKey))) { res.status(401).json({error:"Invalid pairing authorization"}); return; }
  const device = group?.devices.get(deviceId);
  if (device) {
    rejectPending(device, "This device's access was revoked.");
    device.socket?.close(4003, "Device access revoked");
    group!.devices.delete(deviceId);
  }
  res.status(200).json({revoked:true,groupId});
});
app.use((_req, res) => res.status(404).send("Not found"));

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "invalid"}`);
  const groupId = url.searchParams.get("groupId") ?? "";
  const deviceId = url.searchParams.get("deviceId") ?? "";
  const authorization = req.headers.authorization ?? "";
  const deviceKey = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  const group = groups.get(groupId);
  const connectorHash = req.headers["x-supermd-connector-hash"];
  const host = (req.headers.host ?? "").toLowerCase();
  const origin = req.headers.origin;
  let originOk = !origin;
  if (origin) { try { originOk = new URL(origin).host.toLowerCase() === expectedHost; } catch { originOk = false; } }
  const device = group?.devices.get(deviceId);
  const keyHash = digest(deviceKey);
  if (url.pathname !== "/device" || host !== expectedHost || !originOk || !GROUP_ID_RE.test(groupId) || !UUID_RE.test(deviceId) || !validToken(deviceKey) || typeof connectorHash !== "string" || !/^[a-f0-9]{64}$/.test(connectorHash) || !group || !equalSecret(connectorHash, group.connectorHash) || !device || !equalSecret(device.deviceKeyHash, keyHash)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n"); socket.destroy(); return;
  }
  const displayName = safeHeader(req.headers["x-supermd-display-name"], 80) || "Super MD device";
  const platformHeader = req.headers["x-supermd-platform"];
  const platform = platformHeader === "android" ? "android" : "desktop";
  device.displayName = displayName;
  device.platform = platform;
  group.devices.set(deviceId, device);
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req, groupId, deviceId));
});
function safeHeader(value: string | string[] | undefined, max: number): string {
  const text = Array.isArray(value) ? value[0] ?? "" : value ?? "";
  return text.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);
}
wss.on("connection", (ws: WebSocket, req: IncomingMessage, groupId: string, deviceId: string) => {
  const group = groups.get(groupId), device = group?.devices.get(deviceId);
  if (!group || !device) { ws.close(1008, "Device registration expired"); return; }
  if (device.socket && device.socket !== ws) device.socket.close(4001, "Reconnected elsewhere");
  device.socket = ws;
  const previewFormats = safeHeader(req.headers["x-supermd-preview-formats"], 64).split(",").map((value) => value.trim().toLowerCase());
  device.jpegPreview = previewFormats.includes("jpeg");
  device.lastSeen = Date.now();
  ws.on("message", (raw: RawData) => {
    try {
      const message = parseSocketText(raw) as Record<string, unknown>;
      if (message.type !== "reply" || typeof message.requestId !== "string") throw new Error("Unexpected app message");
      const pending = device.pending.get(message.requestId);
      if (!pending) return;
      const response = validReply(message, message.requestId);
      clearTimeout(pending.timer); device.pending.delete(message.requestId); pending.resolve(response); device.lastSeen = Date.now();
    } catch { ws.close(1008, "Invalid device message"); }
  });
  ws.on("close", () => {
    if (device.socket === ws) {
      device.socket = null;
      device.jpegPreview = false;
      device.lastSeen = Date.now();
      rejectPending(device, "The app disconnected before replying.");
    }
  });
  ws.on("error", () => { /* close handler clears pending requests */ });
  sendJson(ws, { type: "registered", groupId, deviceId });
});
setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [groupId, group] of groups) {
    for (const [deviceId, device] of group.devices) if (!device.socket && device.lastSeen < cutoff) group.devices.delete(deviceId);
    if (group.devices.size === 0) {
      groups.delete(groupId);
      for (const [id, route] of sseTransports) if (route.group === group) { void route.transport.close(); sseTransports.delete(id); }
    }
  }
}, 60 * 60 * 1000).unref();
server.listen(port, process.env.HOST ?? (publicHost ? "0.0.0.0" : "127.0.0.1"), () => {
  console.info(`Super MD relay listening on ${process.env.HOST ?? (publicHost ? "0.0.0.0" : "127.0.0.1")}:${port}`);
});
