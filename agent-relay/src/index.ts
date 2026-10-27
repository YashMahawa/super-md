import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import express, { type NextFunction, type Request, type Response } from "express";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { SSEServerTransport } from "@modelcontextprotocol/server-legacy/sse";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { z } from "zod";
import { MAX_FRAME_BYTES, MAX_PENDING, REQUEST_TIMEOUT_MS, validateRpcRequest, validReply, type RpcRequest } from "./protocol.js";

type Pending = { resolve: (value: { result?: unknown; error?: string }) => void; timer: NodeJS.Timeout };
type Device = {
  deviceId: string; displayName: string; platform: "android" | "desktop"; deviceKeyHash: string;
  socket: WebSocket | null; pending: Map<string, Pending>; lastSeen: number;
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
  const chosen = chooseDevice(group, partial.deviceId, partial.action === "patch_tab" || partial.action === "document_action" || partial.action === "replace_tab_asset");
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
  return { content: [{ type: "image" as const, data: bytes.toString("base64"), mimeType: "image/png" }, { type: "text" as const, text: JSON.stringify({ width: image.width, height: image.height, revision: image.revision }) }] };
}
function registerTools(server: McpServer, group: Group): void {
  const deviceId = z.string().regex(UUID_RE).optional();
  const tabId = z.string().min(1).max(512);
  const pageSize = z.enum(["a3","a4","a5","a6","iso-b4","iso-b5","iso-b6","letter","legal","tabloid","executive"]);
  const exportOptions = z.object({
    pageSize: pageSize.optional(), margin: z.number().min(0).max(50).optional(), fontSize: z.number().min(5).max(24).optional(),
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
  server.registerTool("render_tab", { description: "Render the current reading/editor viewport as an actual bounded PNG MCP image. Supply deviceId when ambiguous.", inputSchema: { deviceId, tabId, width: z.number().int().min(1).max(1600).optional() } }, async ({ deviceId: selected, tabId: tab, width }) => imageResult(await rpc(group, { action: "render_tab", deviceId: selected, tabId: tab, width })));
  server.registerTool("diagram_action", { description: "List diagrams in an open note, read a diagram's source, or capture a diagram image, guarded by the note's current revision.", inputSchema: { deviceId, tabId, diagramAction: z.enum(["list","source","image"]), diagramId: z.string().min(1).max(128).optional(), expectedRevision: z.string().regex(/^[a-f0-9]{64}$/i), offset: z.number().int().min(0).max(20_000_000).optional(), limit: z.number().int().min(1).max(12_000).optional(), width: z.number().int().min(1).max(1600).optional() } }, async ({ deviceId: selected, tabId: tab, diagramAction, diagramId, expectedRevision, offset, limit, width }) => {
    const action = diagramAction === "list" ? "list_diagrams" : diagramAction === "source" ? "get_diagram" : "get_diagram_image";
    const response = await rpc(group, { action, deviceId: selected, tabId: tab, diagramId, expectedRevision, offset, limit, width });
    return diagramAction === "image" ? imageResult(response) : toolResponse(response);
  });
  server.registerTool("replace_tab_asset", { description: "Replace a linked asset using a path available to the selected Super MD device. The device restricts reads to its configured asset roots; the relay never reads or stores the file.", inputSchema: { deviceId, tabId, assetName: z.string().min(1).max(256), assetPath: z.string().min(1).max(4096), expectedRevision: z.string().regex(/^[a-f0-9]{64}$/i) } }, async ({ deviceId: selected, tabId: tab, assetName, assetPath, expectedRevision }) => toolResponse(await rpc(group, { action: "replace_tab_asset", deviceId: selected, tabId: tab, assetName, assetPath, expectedRevision })));
  server.registerTool("document_action", { description: "Read exact reading context, create, export, repair LaTeX, open, save, check an export job, or snapshot through Super MD's native UI. No shell or code execution. PDF options match app controls; choose deviceId when ambiguous.", inputSchema: { deviceId, documentAction: z.enum(["get_context","create","export","latexfix","open","save","snapshot","job_status"]), tabId: tabId.optional(), expectedRevision: z.string().regex(/^[a-f0-9]{64}$/i).optional(), operations: z.array(z.record(z.string(), z.unknown())).max(100).optional(), content: z.string().max(60_000).optional(), options: exportOptions.extend({format:z.enum(["pdf","smd","md"]).optional(),repairIndices:z.array(z.number().int().min(0)).max(40).optional(),filename:z.string().max(256).optional(),jobId:z.string().max(128).optional(),limit:z.number().int().min(1).max(500).optional()}).optional() } }, async ({ deviceId: selected, documentAction, tabId: tab, expectedRevision, operations, content, options }) => {
    const jobId = options?.jobId;
    const response = await rpc(group, { action: "document_action", deviceId: selected, documentAction, tabId: tab, expectedRevision, operations, content, jobId, options });
    return documentAction === "snapshot" ? imageResult(response) : toolResponse(response);
  });
}
function buildServer(group: Group): McpServer { const mcp = new McpServer({ name: "super-md-live", version: "0.1.0" }); registerTools(mcp, group); return mcp; }

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
    group.devices.set(deviceId, { deviceId, displayName, platform, deviceKeyHash, socket: null, pending: new Map(), lastSeen: Date.now() });
  } else if (previous) {
    previous.displayName = displayName;
    previous.platform = platform;
    previous.lastSeen = Date.now();
  } else {
    group.devices.set(deviceId, { deviceId, displayName, platform, deviceKeyHash, socket: null, pending: new Map(), lastSeen: Date.now() });
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
wss.on("connection", (ws: WebSocket, _req: IncomingMessage, groupId: string, deviceId: string) => {
  const group = groups.get(groupId), device = group?.devices.get(deviceId);
  if (!group || !device) { ws.close(1008, "Device registration expired"); return; }
  if (device.socket && device.socket !== ws) device.socket.close(4001, "Reconnected elsewhere");
  device.socket = ws;
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
    if (device.socket === ws) { device.socket = null; device.lastSeen = Date.now(); rejectPending(device, "The app disconnected before replying."); }
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
