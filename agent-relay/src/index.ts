import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { realpathSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { createMcpHandler, ResourceTemplate } from "@modelcontextprotocol/server";
import { SSEServerTransport } from "@modelcontextprotocol/server-legacy/sse";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { MAX_FRAME_BYTES, MAX_PENDING, REQUEST_TIMEOUT_MS, validateRpcRequest, validReply, type RpcRequest } from "./protocol.js";
import { ExportDownloads, attachmentHeader, waitForDownloadDrain } from "./downloads.js";
import { REVISION_RE, TOOL_INPUT_SCHEMAS, UUID_RE } from "./schemas.js";
import { buildServer, chooseDevice, onlineDevices, type Device, type Group, type JpegCaptureRequest, type RelayTransportDeps } from "./tools.js";

export { buildServer, TOOL_INPUT_SCHEMAS };

const GROUP_ID_RE = /^[a-f0-9]{32}$/;
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
const exportsAvailable = new ExportDownloads();
const downloadOrigin = (/^(localhost|127\.0\.0\.1)(:|$)/.test(expectedHost) ? "http://" : "https://") + expectedHost;
const completedExportTemplate = new ResourceTemplate(downloadOrigin + "/download/{token}", { list: undefined });

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
function rpc(group: Group, partial: Omit<RpcRequest, "requestId">): Promise<{ result?: unknown; error?: string }> {
  const started = performance.now();
  const chosen = chooseDevice(group, partial.deviceId, partial.action === "patch_tab" || partial.action === "document_action" || partial.action === "replace_tab_asset" || (partial.action === "asset_action" && partial.assetAction === "attach"));
  const device = chosen.device;
  if (!device) return Promise.resolve({ error: chosen.error });
  if (!device.socket || device.socket.readyState !== WebSocket.OPEN) return Promise.resolve({ error: "The selected Super MD device is offline." });
  if (device.pending.size >= MAX_PENDING) return Promise.resolve({ error: "The selected device already has the maximum number of requests in progress." });
  const requestId = randomUUID();
  const request = validateRpcRequest({ requestId, deviceId: device.deviceId, ...partial });
  return new Promise((resolve) => {
    const complete = (reply: { result?: unknown; error?: string }) => {
      const value = reply.result;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        resolve({ ...reply, result: { ...value, serverMs: Math.round(performance.now() - started) } });
      } else resolve(reply);
    };
    const timer = setTimeout(() => { device.pending.delete(requestId); resolve({ error: "The app did not answer before the request timed out." }); }, requestTimeout);
    device.pending.set(requestId, { resolve: complete, timer });
    try { sendJson(device.socket!, { type: "request", ...request }); }
    catch (error) { clearTimeout(timer); device.pending.delete(requestId); resolve({ error: error instanceof Error ? error.message : "Could not send the request to the app." }); }
  });
}
function jpegCaptureRpc(group: Group, partial: JpegCaptureRequest) {
  const chosen = chooseDevice(group, partial.deviceId);
  const imageFormat = chosen.device?.jpegPreview ? "jpeg" as const : undefined;
  return rpc(group, { ...partial, ...(imageFormat ? { imageFormat } : {}) });
}
function parseSocketText(raw: RawData): unknown {
  const text = raw.toString();
  if (Buffer.byteLength(text) > MAX_FRAME_BYTES) throw new Error("Relay frame exceeds its limit");
  return JSON.parse(text) as unknown;
}

const relayDeps: RelayTransportDeps = { groups, exportsAvailable, downloadOrigin, completedExportTemplate, rpc, jpegCaptureRpc };
const modernHandler = createMcpHandler((ctx) => {
  const path = new URL(ctx.requestInfo!.url).pathname.split("/");
  const group = path[2] && path[3] ? authenticatedGroup(path[2], path[3]) : null;
  return buildServer(group ?? undefined, relayDeps);
});
const modernNodeHandler = toNodeHandler(modernHandler, { maxRequestBodySize: 2 * 1024 * 1024 });

app.disable("x-powered-by");
app.get("/download/:token", async (req, res) => {
  // A file link is an explicit short-lived capability, not ambient cookie
  // authorization. Permit clients on other origins to fetch their own link.
  if ((req.headers.host ?? "").toLowerCase() !== expectedHost) { res.status(403).end(); return; }
  res.set({ "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", "Access-Control-Expose-Headers": "Content-Disposition, Content-Length, ETag", "X-Content-Type-Options": "nosniff", "X-Robots-Tag": "noindex, nofollow", "Referrer-Policy": "no-referrer" });
  const token = param(req.params.token), lease = exportsAvailable.get(token);
  if (!lease || !groups.get(lease.groupId)?.devices.has(lease.deviceId)) { res.status(404).json({ error: "This export download expired or was revoked." }); return; }
  let aborted = false; res.on("close", () => { aborted = true; });
  const deadline = setTimeout(() => { aborted = true; res.destroy(); }, 180_000);
  try {
    let headers = false;
    for await (const chunk of exportsAvailable.stream(token, async (info, offset, limit) => {
      const group = groups.get(info.groupId); if (!group || !group.devices.has(info.deviceId)) return { error: "Device access was revoked." };
      return rpc(group, { action: "document_action", documentAction: "export_chunk", deviceId: info.deviceId, jobId: info.jobId, offset, limit });
    }, () => aborted)) {
      if (!headers) {
        res.set({ "Content-Type": lease.mimeType, "Content-Length": String(lease.bytes), "Content-Disposition": attachmentHeader(lease.filename), "ETag": '"' + lease.sha256 + '"' }); headers = true;
      }
      if (!res.write(chunk)) await waitForDownloadDrain(res);
    }
    if (!headers) res.set({ "Content-Type": lease.mimeType, "Content-Length": "0", "Content-Disposition": attachmentHeader(lease.filename) });
    res.end();
  } catch {
    if (res.headersSent) res.destroy(); else res.status(409).json({ error: "The export is unavailable, changed, or another download is active. Check job_status and retry." });
  } finally { clearTimeout(deadline); }
});
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
  void buildServer(group, relayDeps).connect(transport).catch(() => { sseTransports.delete(transport.sessionId); res.end(); });
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
  const { groupId, pairingKey, deviceId } = req.body ?? {};
  if (typeof groupId !== "string" || !GROUP_ID_RE.test(groupId) || !validToken(pairingKey) || typeof deviceId !== "string" || !UUID_RE.test(deviceId)) { res.status(400).json({ error: "Invalid revocation request" }); return; }
  const group = groups.get(groupId);
  if (group && !equalSecret(group.pairingHash, digest(pairingKey))) { res.status(401).json({ error: "Invalid pairing authorization" }); return; }
  const device = group?.devices.get(deviceId);
  if (device) {
    rejectPending(device, "This device's access was revoked.");
    device.socket?.close(4003, "Device access revoked");
    group!.devices.delete(deviceId);
  }
  res.status(200).json({ revoked: true, groupId });
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
  if (url.pathname !== "/device" || host !== expectedHost || !originOk || !GROUP_ID_RE.test(groupId) || !UUID_RE.test(deviceId) || !validToken(deviceKey) || typeof connectorHash !== "string" || !REVISION_RE.test(connectorHash) || !group || !equalSecret(connectorHash, group.connectorHash) || !device || !equalSecret(device.deviceKeyHash, keyHash)) {
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
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = fileURLToPath(import.meta.url);
  try { return realpathSync(entry) === realpathSync(self); }
  catch { return resolvePath(entry) === self; }
}
if (isMainModule()) {
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
}
