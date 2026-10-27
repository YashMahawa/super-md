import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { Client, StreamableHTTPClientTransport, SSEClientTransport } from "@modelcontextprotocol/client";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=", "base64");
const token = () => randomBytes(32).toString("base64url");
const sha = (v: string) => createHash("sha256").update(v).digest("hex");
const revision = "b".repeat(64);

test("relay auth, bounded device RPC, Streamable HTTP, legacy SSE and disconnected replies", async (t) => {
  const port = 18000 + Math.floor(Math.random() * 15000);
  const host = "127.0.0.1:" + port;
  const base = "http://" + host;
  const child = spawn(process.execPath, [fileURLToPath(new URL("../dist/index.js", import.meta.url))], {
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", PUBLIC_HOST: host }, stdio: "ignore",
  });
  t.after(() => child.kill("SIGTERM"));
  let healthy = false;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error("Relay child exited before health check");
    try { healthy = (await fetch(base + "/health")).ok; if (healthy) break; } catch { /* starting */ }
    await delay(50);
  }
  assert.equal(healthy, true);
  const pairingKey = token(), connectorKey = token(), deviceKey = token(), deviceId = randomUUID();
  const connectorHash = sha(connectorKey);
  const groupId = createHash("sha256").update("supermd-group-v1\0" + pairingKey + "\0" + connectorHash).digest("hex").slice(0, 32);
  const enroll = (pairing = pairingKey, connector = connectorKey, gid = groupId, did = deviceId, dkey = deviceKey, name = "Test Android", platform = "android") => fetch(base + "/device/enroll", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ groupId: gid, pairingKey: pairing, connectorKey: connector, deviceId: did, deviceKey: dkey, displayName: name, platform }),
  });
  assert.equal((await enroll(token())).status, 401);
  assert.equal((await enroll(pairingKey, token())).status, 401);
  assert.equal((await enroll()).status, 200);
  const wrongDevice = new WebSocket("ws://" + host + "/device?groupId=" + groupId + "&deviceId=" + deviceId, {
    headers: { authorization: "Bearer " + token(), "x-supermd-connector-hash": connectorHash },
  });
  const denied = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("device authentication timeout")), 2000);
    wrongDevice.on("unexpected-response", (_request, response) => { clearTimeout(timer); resolve(response.statusCode ?? 0); });
    wrongDevice.on("error", () => undefined);
  });
  assert.equal(denied, 401, "unpaired device keys cannot register through the WebSocket route");

  const ws = new WebSocket("ws://" + host + "/device?groupId=" + groupId + "&deviceId=" + deviceId, {
    headers: { authorization: "Bearer " + deviceKey, "x-supermd-connector-hash": connectorHash,
      "x-supermd-display-name": "Test Android", "x-supermd-platform": "android" },
  });
  const firstRegistered = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("registration timeout")), 2000);
    ws.once("message", (raw) => { clearTimeout(timer); try { const m = JSON.parse(raw.toString()); assert.equal(m.type, "registered"); resolve(); } catch (e) { reject(e); } });
  });
  await once(ws, "open");
  await firstRegistered;
  let dropNext = false;
  ws.on("message", (raw) => {
    const request = JSON.parse(raw.toString()) as Record<string, unknown>;
    if (request.type !== "request") return;
    if (dropNext) { dropNext = false; ws.close(); return; }
    const tabId = "tab:" + deviceId + ":main:1";
    let result: unknown;
    if (request.action === "list_tabs") result = { tabs: [{ id: tabId, name: "Untitled.md", revision, saved: false }] };
    else if (request.action === "read_tab") result = { tabId, text: "# Live\\ncontent", revision, offset: 0 };
    else if (request.action === "render_tab") result = { mime_type: "image/png", data: png.toString("base64"), width: 1, height: 1, revision, metadata: {reading:{offset:123,heading:"Current section"}} };
    else if (request.action === "patch_tab") { ws.send(JSON.stringify({ type: "reply", requestId: request.requestId, error: "Revision conflict: tab changed." })); return; }
    else result = { accepted: true };
    ws.send(JSON.stringify({ type: "reply", requestId: request.requestId, result }));
  });

  const url = new URL(base + "/mcp/" + groupId + "/" + connectorKey);
  const http = new Client({ name: "relay-http-test", version: "1.0.0" });
  const httpTransport = new StreamableHTTPClientTransport(url);
  await http.connect(httpTransport);
  t.after(async () => { await http.close().catch(() => undefined); await httpTransport.close().catch(() => undefined); });
  const list = await http.listTools();
  assert.deepEqual(list.tools.map((x) => x.name).sort(), ["diagram_action", "document_action", "list_devices", "list_tabs", "patch_tab", "read_tab", "render_tab", "replace_tab_asset", "search_tab"].sort());
  const devices = await http.callTool({ name: "list_devices", arguments: {} });
  assert.match(String(devices.content?.[0]?.type === "text" ? devices.content[0].text : ""), /Test Android/);
  assert.match(String(devices.content?.[0]?.type === "text" ? devices.content[0].text : ""), /Untitled\.md/);
  const diagram = await http.callTool({ name: "diagram_action", arguments: { deviceId, tabId: "tab:" + deviceId + ":main:1", diagramAction: "source", diagramId: "diagram:0", expectedRevision: revision, offset: 0, limit: 100 } });
  assert.equal(diagram.isError, undefined);
  const read = await http.callTool({ name: "read_tab", arguments: { deviceId, tabId: "tab:" + deviceId + ":main:1", limit: 100 } });
  assert.match(String(read.content?.[0]?.type === "text" ? read.content[0].text : ""), /Live/);
  const image = await http.callTool({ name: "render_tab", arguments: { deviceId, tabId: "tab:" + deviceId + ":main:1", width: 500 } });
  assert.equal(image.content?.[0]?.type, "image");
  assert.match(String(image.content?.[1]?.type === "text" ? image.content[1].text : ""), /Current section/);
  const stale = await http.callTool({ name: "patch_tab", arguments: { deviceId, tabId: "tab:" + deviceId + ":main:1", expectedRevision: revision, operations: [{ type: "replace", old: "Live", new: "New" }] } });
  assert.equal(stale.isError, true);

  const secondId = randomUUID(), secondKey = token();
  assert.equal((await enroll(pairingKey, connectorKey, groupId, secondId, secondKey, "Test Desktop", "desktop")).status, 200);
  const second = new WebSocket("ws://" + host + "/device?groupId=" + groupId + "&deviceId=" + secondId, {
    headers: { authorization: "Bearer " + secondKey, "x-supermd-connector-hash": connectorHash,
      "x-supermd-display-name": "Test Desktop", "x-supermd-platform": "desktop" },
  });
  const secondRegistered = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("second device registration timeout")), 2000);
    second.once("message", (raw) => { clearTimeout(timer); try { assert.equal(JSON.parse(raw.toString()).deviceId, secondId); resolve(); } catch (e) { reject(e); } });
  });
  await once(second, "open");
  await secondRegistered;
  second.on("message", (raw) => {
    const request = JSON.parse(raw.toString()) as Record<string, unknown>;
    if (request.type === "request") second.send(JSON.stringify({ type: "reply", requestId: request.requestId, result: [{ deviceId: secondId, tabId: "tab:second", revision }] }));
  });
  t.after(() => second.close());
  const ambiguousWrite = await http.callTool({ name: "patch_tab", arguments: { tabId: "tab:one", expectedRevision: revision, operations: [{ type: "replace", old: "x", new: "y" }] } });
  assert.equal(ambiguousWrite.isError, true, "writes require a selected device when multiple devices are connected");
  const ambiguousRead = await http.callTool({ name: "list_tabs", arguments: {} });
  assert.equal(ambiguousRead.isError, true, "tab reads report device ambiguity instead of guessing");
  const revoke = (key: string) => fetch(base + "/device/revoke", {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({groupId,pairingKey:key,deviceId:secondId})});
  assert.equal((await revoke(token())).status,401,"only the pairing authority may revoke a device");
  const closed = once(second,"close");
  assert.deepEqual(await (await revoke(pairingKey)).json(),{revoked:true,groupId});
  await closed;
  assert.equal((await revoke(pairingKey)).status,200,"revocation is idempotent");
  const stolen = new WebSocket("ws://" + host + "/device?groupId=" + groupId + "&deviceId=" + secondId, {headers:{authorization:"Bearer " + secondKey,"x-supermd-connector-hash":connectorHash}});
  const revokedStatus = await new Promise<number>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error("revocation timeout")),2000);stolen.on("unexpected-response",(_request,response)=>{clearTimeout(timer);resolve(response.statusCode??0);});stolen.on("error",()=>undefined);});
  assert.equal(revokedStatus,401,"a copied device key cannot reconnect after revocation");

  const sse = new Client({ name: "relay-sse-test", version: "1.0.0" });
  const sseTransport = new SSEClientTransport(url);
  await sse.connect(sseTransport);
  t.after(async () => { await sse.close().catch(() => undefined); await sseTransport.close().catch(() => undefined); });
  assert((await sse.listTools()).tools.some((x) => x.name === "list_devices"));
  assert.equal((await sse.callTool({ name: "list_tabs", arguments: { deviceId } })).isError, undefined);
  dropNext = true;
  assert.equal((await sse.callTool({ name: "read_tab", arguments: { deviceId, tabId: "tab:" + deviceId + ":main:1" } })).isError, true);
  assert.equal((await fetch(base + "/mcp/" + groupId + "/" + token(), { method: "HEAD" })).status, 401);

  const offlinePair = token(), offlineConnector = token();
  const offlineId = createHash("sha256").update("supermd-group-v1\0" + offlinePair + "\0" + sha(offlineConnector)).digest("hex").slice(0, 32);
  assert.equal((await enroll(offlinePair, offlineConnector, offlineId)).status, 200);
  const offline = new Client({ name: "relay-offline-test", version: "1.0.0" });
  const offlineTransport = new StreamableHTTPClientTransport(new URL(base + "/mcp/" + offlineId + "/" + offlineConnector));
  await offline.connect(offlineTransport);
  assert.equal((await offline.callTool({ name: "list_tabs", arguments: {} })).isError, true, "offline device failures are explicit and MCP-safe");
  await offline.close(); await offlineTransport.close();
});
