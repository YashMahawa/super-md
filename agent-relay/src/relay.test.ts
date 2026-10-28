import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { Client, StreamableHTTPClientTransport, SSEClientTransport } from "@modelcontextprotocol/client";
import sharp from "sharp";

const png = await sharp({ create: { width: 1600, height: 900, channels: 3, background: { r: 245, g: 246, b: 248 } } }).png().toBuffer();
const jpeg = await sharp(png).jpeg({ quality: 90, mozjpeg: false, chromaSubsampling: "4:4:4" }).toBuffer();
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
      "x-supermd-display-name": "Test Android", "x-supermd-platform": "android", "x-supermd-preview-formats": "png,jpeg" },
  });
  const firstRegistered = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("registration timeout")), 2000);
    ws.once("message", (raw) => { clearTimeout(timer); try { const m = JSON.parse(raw.toString()); assert.equal(m.type, "registered"); resolve(); } catch (e) { reject(e); } });
  });
  await once(ws, "open");
  await firstRegistered;
  let dropNext = false;
  let fastTabs: unknown[] | undefined;
  let fastContext: Record<string, unknown> | undefined;
  let fastCaptureContext: Record<string, unknown> | undefined;
  let fastImageMetadata: Record<string, unknown> | undefined;
  let fastImageMimeOverride: string | undefined;
  let fastImageDataFormat: "image/png" | "image/jpeg" | undefined;
  let fastSnapshotRevision: string | undefined;
  let fastCaptureError: string | undefined;
  let fastRpcCounts = { list_tabs: 0, get_context: 0, render_tab: 0, list_diagrams: 0 };
  const exportBytes=Buffer.from("%PDF-1.7\n"+"A".repeat(600_000));
  const exportMetadata={downloadable:true,status:"completed",jobId:"export-qa",filename:"Notes with spaces 猫.pdf",format:"pdf",bytes:exportBytes.length,sha256:sha(exportBytes.toString())};
  const fastRequests: Record<string, unknown>[] = [];
  ws.on("message", (raw) => {
    const request = JSON.parse(raw.toString()) as Record<string, unknown>;
    if (request.type !== "request") return;
    fastRequests.push(request);
    if (dropNext) { dropNext = false; ws.close(); return; }
    const tabId = "tab:" + deviceId + ":main:1";
    let result: unknown;
    if (request.action === "list_tabs") { fastRpcCounts.list_tabs++; result = { tabs: fastTabs ?? [{ id: tabId, name: "Untitled.md", revision, saved: false }] }; }
    else if (request.action === "read_tab") result = { tabId, text: "# Live\\ncontent", revision, offset: 0 };
    else if (request.action === "render_tab") {
      fastRpcCounts.render_tab++;
      if (fastCaptureError) { ws.send(JSON.stringify({ type: "reply", requestId: request.requestId, error: fastCaptureError })); return; }
      const useJpeg = request.imageFormat === "jpeg";
      const dataFormat = fastImageDataFormat ?? (useJpeg ? "image/jpeg" : "image/png");
      result = { ...(fastCaptureContext ?? {}), mime_type: fastImageMimeOverride ?? (useJpeg ? "image/jpeg" : "image/png"), data: (dataFormat === "image/jpeg" ? jpeg : png).toString("base64"), width: 1600, height: 900, revision: fastSnapshotRevision ?? revision, metadata: fastImageMetadata ?? { tabId, mode: "reading", reading: { offset: 123, heading: "Current section" }, selection: { text: "" } } };
    }
    else if (request.action === "get_diagram_image") { const useJpeg = request.imageFormat === "jpeg"; result = { mime_type: useJpeg ? "image/jpeg" : "image/png", data: (useJpeg ? jpeg : png).toString("base64"), width: 1600, height: 900, revision }; }
    else if (request.action === "document_action" && request.documentAction === "get_context") {
      fastRpcCounts.get_context++;
      result = fastContext ?? { tabId: request.tabId, revision, mode: "reading", reading: { offset: 123, heading: "Current section", visibleText: "Visible text" }, visibleSource: { text: "# Exact source", start: 120, end: 140 }, diagrams: [{ id: "diagram:124", kind: "mermaid", sourceStart: 124, sourceEnd: 136 }] };
    }
    else if (request.action === "document_action" && request.documentAction === "job_status" && request.jobId === "export-qa") result=exportMetadata;
    else if (request.action === "document_action" && request.documentAction === "export_chunk" && request.jobId === "export-qa") {
      const offset=Number(request.offset),end=Math.min(exportBytes.length,offset+Number(request.limit));
      result={...exportMetadata,offset,nextOffset:end<exportBytes.length?end:null,body:exportBytes.subarray(offset,end).toString("base64")};
    }
    else if (request.action === "list_diagrams") { fastRpcCounts.list_diagrams++; result = { tabId: request.tabId, revision, diagrams: [] }; }
    else if (request.action === "asset_action" && request.assetAction === "list") result = { tabId: request.tabId, revision, assets: [{ name: "assets/original.svg", mimeType: "image/svg+xml", bytes: 32, sha256: "c".repeat(64) }] };
    else if (request.action === "asset_action" && request.assetAction === "source") {
      const bytes = request.assetName === "assets/original.png" ? png : Buffer.from(request.assetName === "assets/unicode.svg" ? "<svg>猫🧭a</svg>" : "<svg xmlns='http://www.w3.org/2000/svg'/>");
      result = { tabId: request.tabId, revision, assetName: request.assetName, mimeType: request.assetName === "assets/original.png" ? "image/png" : "image/svg+xml", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), body: bytes.toString("base64") };
    }
    else if (request.action === "asset_action" && request.assetAction === "attach") result = { tabId: request.tabId, assetName: request.assetName, mimeType: request.mimeType, bytes: Buffer.from(String(request.body), "base64").length, revision, saved: true };
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
  assert.deepEqual(list.tools.map((x) => x.name).sort(), ["asset_action", "diagram_action", "document_action", "list_devices", "list_tabs", "patch_tab", "read_tab", "render_tab", "replace_tab_asset", "search_tab", "view_current"].sort());
  const devices = await http.callTool({ name: "list_devices", arguments: {} });
  assert.match(String(devices.content?.[0]?.type === "text" ? devices.content[0].text : ""), /Test Android/);
  assert.match(String(devices.content?.[0]?.type === "text" ? devices.content[0].text : ""), /Untitled\.md/);
  // The discoverable schema must teach an unfamiliar agent the operation
  // shapes before it edits a note, and typos must never reach a device.
  const patchTool = list.tools.find(item => item.name === "patch_tab")!;
  const operationSchema = JSON.stringify(patchTool.inputSchema);
  for (const key of ["start_line", "end_line", "expectedCount", "insert", "additionalProperties"]) assert.ok(operationSchema.includes(key));
  const beforeInvalidPatch = fastRequests.length;
  const badPatch = await http.callTool({name:"patch_tab",arguments:{deviceId,tabId:"tab:"+deviceId+":main:1",expectedRevision:revision,operations:[{type:"lines",start_line:1,end_line:1,text:"test",startLine:1}]}});
  assert.equal(badPatch.isError,true);
  assert.equal(fastRequests.length,beforeInvalidPatch,"unknown operation fields never reach a device");
  await http.callTool({name:"search_tab",arguments:{deviceId,tabId:"tab:"+deviceId+":main:1",query:"Ward",offset:100,wholeWord:true,excludeDiagrams:true,caseSensitive:true,limit:4}});
  assert.deepEqual(Object.fromEntries(Object.entries(fastRequests.at(-1)!).filter(([key])=>["offset","wholeWord","excludeDiagrams","caseSensitive","limit"].includes(key))),{offset:100,limit:4,caseSensitive:true,wholeWord:true,excludeDiagrams:true});
  await http.callTool({name:"diagram_action",arguments:{deviceId,tabId:"tab:"+deviceId+":main:1",diagramAction:"list",offset:10,limit:5}});
  assert.equal(fastRequests.at(-1)?.offset,10);
  assert.equal(fastRequests.at(-1)?.limit,5);
  assert.equal(fastRequests.at(-1)?.expectedRevision,undefined);
  for(const documentAction of ["activate","latex_review","close"]){
    const response=await http.callTool({name:"document_action",arguments:{deviceId,tabId:"tab:"+deviceId+":main:1",documentAction,...(documentAction==="close"?{expectedRevision:revision}:{}),options:documentAction==="close"?{discardChanges:false}:{}}});
    assert.equal(response.isError,undefined);
    assert.equal(fastRequests.at(-1)?.documentAction,documentAction);
  }
  await http.callTool({name:"document_action",arguments:{deviceId,documentAction:"create",content:"# QA",options:{filename:"QA.smd",background:true}}});
  assert.deepEqual(fastRequests.at(-1)?.options,{filename:"QA.smd",background:true});
  const diagram = await http.callTool({ name: "diagram_action", arguments: { deviceId, tabId: "tab:" + deviceId + ":main:1", diagramAction: "source", diagramId: "diagram:0", expectedRevision: revision, offset: 0, limit: 100 } });
  assert.equal(diagram.isError, undefined);
  const diagramSourceWithQuality = await http.callTool({ name: "diagram_action", arguments: { deviceId, tabId: "tab:" + deviceId + ":main:1", diagramAction: "source", diagramId: "diagram:0", expectedRevision: revision, quality: "high" } });
  assert.equal(diagramSourceWithQuality.isError, true, "quality options are reserved for image actions");
  const diagramImage = await http.callTool({ name: "diagram_action", arguments: { deviceId, tabId: "tab:" + deviceId + ":main:1", diagramAction: "image", diagramId: "diagram:0", expectedRevision: revision } });
  assert.equal(diagramImage.content?.[0]?.type === "image" ? diagramImage.content[0].mimeType : "", "image/jpeg", "diagram images return standard JPEG by default");
  assert.equal(fastRequests.find((request) => request.action === "get_diagram_image")?.imageFormat, "jpeg");
  assert.equal(fastRequests.find((request) => request.action === "get_diagram_image")?.width, 1000);
  const mediaTab = "tab:" + deviceId + ":main:1";
  const assetList = await http.callTool({ name: "asset_action", arguments: { deviceId, tabId: mediaTab, assetAction: "list", expectedRevision: revision } });
  assert.match(String(assetList.content?.[0]?.type === "text" ? assetList.content[0].text : ""), /assets\/original\.svg/);
  const assetSource = await http.callTool({ name: "asset_action", arguments: { deviceId, tabId: mediaTab, assetAction: "source", assetName: "assets/original.svg", expectedRevision: revision } });
  assert.match(String(assetSource.content?.[0]?.type === "text" ? assetSource.content[0].text : ""), /<svg xmlns=/);
  const svgPage = await http.callTool({ name: "asset_action", arguments: { deviceId, tabId: mediaTab, assetAction: "source", assetName: "assets/original.svg", expectedRevision: revision, offset: 0, limit: 8 } });
  assert.match(String(svgPage.content?.[0]?.type === "text" ? svgPage.content[0].text : ""), /"nextOffset":8/);
  const unicodePage = await http.callTool({ name: "asset_action", arguments: { deviceId, tabId: mediaTab, assetAction: "source", assetName: "assets/unicode.svg", expectedRevision: revision, offset: 6, limit: 1 } });
  const unicodeMeta = JSON.parse(String(unicodePage.content?.[0]?.type === "text" ? unicodePage.content[0].text : ""));
  assert.equal(unicodeMeta.source, "🧭");
  assert.equal(unicodeMeta.nextOffset, 7);
  assert.equal(unicodeMeta.revision, revision);
  const originalPng = await http.callTool({ name: "asset_action", arguments: { deviceId, tabId: mediaTab, assetAction: "source", assetName: "assets/original.png", expectedRevision: revision } });
  assert.equal(originalPng.content?.[0]?.type, "image");
  assert.equal(Buffer.from(String(originalPng.content?.[0]?.type === "image" ? originalPng.content[0].data : ""), "base64").compare(png), 0);
  const attached = await http.callTool({ name: "asset_action", arguments: { deviceId, tabId: mediaTab, assetAction: "attach", assetName: "assets/model.png", mimeType: "image/png", body: png.toString("base64"), expectedRevision: revision } });
  assert.match(String(attached.content?.[0]?.type === "text" ? attached.content[0].text : ""), /assets\/model\.png/);
  const read = await http.callTool({ name: "read_tab", arguments: { deviceId, tabId: "tab:" + deviceId + ":main:1", limit: 100 } });
  assert.match(String(read.content?.[0]?.type === "text" ? read.content[0].text : ""), /Live/);
  const sectionRead=await http.callTool({name:"read_tab",arguments:{deviceId,heading:"7.4",limit:2000}});
  assert.equal(sectionRead.isError,undefined);
  assert.equal(fastRequests.at(-1)?.heading,"7.4","section selector is forwarded without a separate model discovery call");
  const outline=await http.callTool({name:"document_action",arguments:{deviceId,documentAction:"outline",options:{offset:10,limit:5}}});
  assert.equal(outline.isError,undefined);
  assert.equal(fastRequests.at(-1)?.documentAction,"outline");
  const exportJob=await http.callTool({name:"document_action",arguments:{deviceId,documentAction:"job_status",options:{jobId:"export-qa"}}});
  const download=exportJob.content?.find(item=>item.type==="resource_link");
  assert.ok(download&&download.type==="resource_link");
  if(!download||download.type!=="resource_link")throw Error("Missing export resource link");
  assert.equal(download.name,"Notes with spaces 猫.pdf");
  assert.ok(!download.uri.includes(connectorKey),"download capabilities never expose the workspace MCP credential");
  const response=await fetch(download.uri,{headers:{Origin:"https://client.example"}});
  assert.equal(response.status,200);
  assert.equal(response.headers.get("content-type"),"application/pdf");
  assert.equal(response.headers.get("cache-control"),"no-store");
  assert.equal(response.headers.get("access-control-allow-origin"),"*","capability downloads work for browser clients without ambient credentials");
  assert.ok(response.headers.get("content-disposition")?.includes("Notes%20with%20spaces%20"));
  assert.ok(Buffer.from(await response.arrayBuffer()).equals(exportBytes));
  assert.equal(fastRequests.filter(item=>item.documentAction==="export_chunk").length,2,"file bytes use bounded internal chunks, never model-visible base64");
  const resource=await http.readResource({uri:download.uri});
  const resourceBytes=resource.contents[0]!;
  assert.ok("blob" in resourceBytes&&Buffer.from(String(resourceBytes.blob),"base64").equals(exportBytes),"MCP resource clients receive the same verified original PDF");
  assert.equal((await fetch(base+"/download/unknown")).status,404);
  const image = await http.callTool({ name: "render_tab", arguments: { deviceId, tabId: "tab:" + deviceId + ":main:1" } });
  assert.equal(image.content?.[0]?.type, "image");
  assert.equal(image.content?.[0]?.type === "image" ? image.content[0].mimeType : "", "image/jpeg", "render_tab returns standard JPEG by default");
  assert.match(String(image.content?.[1]?.type === "text" ? image.content[1].text : ""), /"revision"/);
  assert.equal(fastRequests.filter((request) => request.action === "render_tab").at(-1)?.width, 1000);
  const highImage = await http.callTool({ name: "render_tab", arguments: { deviceId, tabId: mediaTab, quality: "high", width: 640 } });
  assert.equal(highImage.content?.[0]?.type === "image" ? highImage.content[0].mimeType : "", "image/png", "high quality preserves lossless PNG");
  assert.equal(fastRequests.filter((request) => request.action === "render_tab").at(-1)?.imageFormat, undefined, "high quality requests native PNG without imageFormat");
  assert.equal(fastRequests.filter((request) => request.action === "render_tab").at(-1)?.width, 640, "explicit width overrides the high-quality default edge");
  const highDiagramImage = await http.callTool({ name: "diagram_action", arguments: { deviceId, tabId: mediaTab, diagramAction: "image", diagramId: "diagram:0", expectedRevision: revision, quality: "high" } });
  assert.equal(highDiagramImage.content?.[0]?.type === "image" ? highDiagramImage.content[0].mimeType : "", "image/png");
  assert.equal(fastRequests.filter((request) => request.action === "get_diagram_image").at(-1)?.imageFormat, undefined);
  assert.equal(fastRequests.filter((request) => request.action === "get_diagram_image").at(-1)?.width, 1600);
  fastRpcCounts = { list_tabs: 0, get_context: 0, render_tab: 0, list_diagrams: 0 };
  fastRequests.length = 0;
  fastTabs = [{ id: mediaTab, active: true }, { id: "tab:other", active: false }];
  const currentView = await http.callTool({ name: "view_current", arguments: { width: 777 } });
  assert.equal(currentView.isError, undefined);
  assert.equal(currentView.content?.[0]?.type, "image", "view_current returns the MCP viewport image first");
  assert.equal(currentView.content?.[0]?.type === "image" ? currentView.content[0].mimeType : "", "image/jpeg", "view_current returns a compact JPEG preview");
  assert.equal(currentView.content?.[0]?.type === "image" ? Buffer.from(currentView.content[0].data, "base64").subarray(0, 2).toString("hex") : "", "ffd8");
  const currentViewText = JSON.parse(String(currentView.content?.[1]?.type === "text" ? currentView.content[1].text : "{}"));
  assert.equal(currentViewText.deviceId, deviceId);
  assert.equal(currentViewText.tabId, mediaTab);
  assert.equal(currentViewText.revision, revision);
  assert.equal(currentViewText.readingContext.visibleSource.text, "# Exact source");
  assert.equal(currentViewText.readingContext.diagrams[0].id, "diagram:124");
  const { byteLength, serverMs, ...previewDimensions } = currentViewText.imagePreview;
  assert.deepEqual(previewDimensions, { mimeType: "image/jpeg", width: 777, height: 437, previewOnly: true });
  assert.equal(byteLength, Buffer.from(String(currentView.content?.[0]?.type === "image" ? currentView.content[0].data : ""), "base64").length);
  assert.ok(Number.isInteger(serverMs) && serverMs >= 0, "relay timing accompanies real preview bytes");
  assert.equal(currentViewText.readingContext.nativeTabId, undefined, "Android's already-qualified tab id is preserved without native id rewriting");
  assert.equal(currentViewText.readingContextSource, "context_read", "Android capture metadata without source retains the separate context read");
  assert.equal(currentViewText.captureContext.reading.offset, 123, "Android position metadata reports where the PNG was captured");
  assert.equal(currentViewText.captureContext.tabId, mediaTab);
  assert.equal(currentViewText.readingContextAlignedWithCapture, true);
  assert.equal(fastRequests.find((request) => request.documentAction === "get_context")?.options && (fastRequests.find((request) => request.documentAction === "get_context")?.options as Record<string, unknown>).limit, 4000, "native context limit is passed in document options");
  assert.equal(fastRequests.find((request) => request.action === "render_tab")?.imageFormat, "jpeg", "view_current requests client-side JPEG capture");
  assert.deepEqual(fastRpcCounts, { list_tabs: 1, get_context: 1, render_tab: 1, list_diagrams: 0 }, "fast path reads context and screenshot without diagram inventory RPCs");
  assert.equal(fastRequests.find((request) => request.action === "render_tab")?.width, 777);
  assert.equal(fastRequests.find((request) => request.action === "render_tab")?.expectedRevision, revision);
  assert.equal(fastRequests.filter((request) => request.action === "document_action").length, 1);

  fastContext = { tabId: mediaTab, revision, sourceLength: 1_431_884, visibleSource: { text: "a猫🙂", start: 1_019_045, end: 1_019_048, total_chars: 1_019_048, next_offset: null, truncated: false }, selection: { text: "🙂" } };
  const paginatedRead = await http.callTool({ name: "document_action", arguments: { deviceId, tabId: mediaTab, documentAction: "get_context" } });
  const paginatedContext = JSON.parse(String(paginatedRead.content?.[0]?.type === "text" ? paginatedRead.content[0].text : "{}"));
  assert.deepEqual(paginatedContext.visibleSource, { text: "a猫🙂", start: 1_019_045, end: 1_019_048, total_chars: 1_431_884, next_offset: 1_019_048, truncated: true });
  assert.deepEqual(paginatedContext.selection, { text: "🙂" });
  const paginatedView = await http.callTool({ name: "view_current", arguments: { deviceId, tabId: mediaTab, includeImage: false } });
  const paginatedViewText = JSON.parse(String(paginatedView.content?.[0]?.type === "text" ? paginatedView.content[0].text : "{}"));
  assert.equal(paginatedViewText.readingContext.visibleSource.total_chars, 1_431_884);
  assert.equal(paginatedViewText.readingContext.visibleSource.next_offset, 1_019_048);
  assert.equal(paginatedViewText.readingContext.visibleSource.text, "a猫🙂");
  fastContext = undefined;

  const highCurrentView = await http.callTool({ name: "view_current", arguments: { deviceId, tabId: mediaTab, quality: "high" } });
  assert.equal(highCurrentView.isError, undefined);
  assert.equal(highCurrentView.content?.[0]?.type === "image" ? highCurrentView.content[0].mimeType : "", "image/png");
  const highCurrentText = JSON.parse(String(highCurrentView.content?.[1]?.type === "text" ? highCurrentView.content[1].text : "{}"));
  assert.equal(highCurrentText.quality, "high");
  assert.equal(highCurrentText.imagePreview.previewOnly, false);
  assert.equal(fastRequests.filter((request) => request.action === "render_tab").at(-1)?.width, 1600);
  assert.equal(fastRequests.filter((request) => request.action === "render_tab").at(-1)?.imageFormat, undefined);

  const snapshotStandard = await http.callTool({ name: "document_action", arguments: { deviceId, documentAction: "snapshot", tabId: mediaTab } });
  assert.equal(snapshotStandard.content?.[0]?.type === "image" ? snapshotStandard.content[0].mimeType : "", "image/jpeg", "document snapshot defaults to standard JPEG");
  assert.equal(fastRequests.filter((request) => request.action === "render_tab").at(-1)?.width, 1000);
  assert.equal(fastRequests.filter((request) => request.action === "render_tab").at(-1)?.imageFormat, "jpeg");
  const snapshotHigh = await http.callTool({ name: "document_action", arguments: { deviceId, documentAction: "snapshot", tabId: mediaTab, expectedRevision: revision, options: { quality: "high" } } });
  assert.equal(snapshotHigh.content?.[0]?.type === "image" ? snapshotHigh.content[0].mimeType : "", "image/png", "high document snapshot opts into lossless PNG");
  assert.equal(fastRequests.filter((request) => request.action === "render_tab").at(-1)?.width, 1600);
  assert.equal(fastRequests.filter((request) => request.action === "render_tab").at(-1)?.imageFormat, undefined);
  const snapshotHighSized = await http.callTool({ name: "document_action", arguments: { deviceId, documentAction: "snapshot", tabId: mediaTab, options: { quality: "high", width: 900 } } });
  assert.equal(snapshotHighSized.content?.[0]?.type === "image" ? snapshotHighSized.content[0].mimeType : "", "image/png");
  assert.equal(fastRequests.filter((request) => request.action === "render_tab").at(-1)?.width, 900);
  const jobStatus = await http.callTool({ name: "document_action", arguments: { deviceId, documentAction: "job_status", options: { jobId: "job-1" } } });
  assert.equal(jobStatus.isError, undefined, "non-snapshot document actions retain their existing RPC route");
  assert.equal(fastRequests.at(-1)?.action, "document_action");
  assert.equal(fastRequests.at(-1)?.documentAction, "job_status");

  const qualifiedDesktopTab = "window:desktop-window:note-17";
  fastContext = { tabId: "note-17", revision, mode: "reading", reading: { offset: 123 }, visibleSource: { text: "Desktop source", start: 120, end: 140 }, diagrams: [] };
  fastRpcCounts = { list_tabs: 0, get_context: 0, render_tab: 0, list_diagrams: 0 };
  fastRequests.length = 0;
  const desktopView = await http.callTool({ name: "view_current", arguments: { deviceId, tabId: qualifiedDesktopTab } });
  assert.equal(desktopView.isError, undefined, "trusted desktop dispatch may return its native raw tab id");
  const desktopContext = JSON.parse(String(desktopView.content?.[1]?.type === "text" ? desktopView.content[1].text : "{}"));
  assert.equal(desktopContext.tabId, qualifiedDesktopTab);
  assert.equal(desktopContext.readingContext.tabId, qualifiedDesktopTab);
  assert.equal(desktopContext.readingContext.nativeTabId, "note-17");
  assert.equal(fastRequests.filter((request) => request.action === "list_tabs").length, 0, "an explicit qualified tab avoids discovery");
  assert.equal(fastRequests.find((request) => request.action === "render_tab")?.width, 1000, "the omitted width uses the default capture size");
  fastContext = undefined;

  fastContext = { tabId: "note-17", revision, mode: "reading", reading: { offset: 10, heading: "Before scroll" }, visibleSource: { text: "Source from first context read", start: 10, end: 100, total_chars: 1000, next_offset: 100 } };
  fastCaptureContext = { tabId: "note-17", revision, sourceLength: 143_188, mode: "reading", zoom: 125, reading: { offset: 900, heading: "After scroll" }, selection: { text: "selected after scroll" }, viewport: { x: 0, y: 90, width: 800, height: 600 }, visibleSource: { text: "Source captured after scroll", start: 900, end: 1000, total_chars: 1000, next_offset: null }, diagrams: [{ id: "diagram:925", kind: "mermaid", sourceStart: 925, sourceEnd: 950, sourceChars: 25, preview: "graph TD; A-->B" }] };
  const movedView = await http.callTool({ name: "view_current", arguments: { deviceId, tabId: qualifiedDesktopTab } });
  assert.equal(movedView.isError, undefined);
  const movedContext = JSON.parse(String(movedView.content?.[1]?.type === "text" ? movedView.content[1].text : "{}"));
  assert.equal(movedContext.readingContextSource, "viewport_capture", "same-revision captures prefer their own full visible source");
  assert.equal(movedContext.readingContext.reading.offset, 900);
  assert.equal(movedContext.readingContext.visibleSource.text, "Source captured after scroll");
  assert.equal(movedContext.readingContext.sourceLength, 143_188);
  assert.equal(movedContext.readingContext.visibleSource.total_chars, 143_188);
  assert.equal(movedContext.readingContext.visibleSource.next_offset, 1000);
  assert.equal(movedContext.readingContext.visibleSource.truncated, true);
  assert.equal(movedContext.readingContext.diagrams[0].id, "diagram:925");
  assert.equal(movedContext.captureContext.reading.offset, 900);
  assert.equal(movedContext.captureContext.sourceRange.start, 900);
  assert.equal(movedContext.captureContext.nativeTabId, "note-17");
  assert.equal(movedContext.readingContextAlignedWithCapture, true);
  fastContext = undefined;
  fastCaptureContext = undefined;

  fastContext = { tabId: mediaTab, revision, reading: { offset: 123 }, visibleSource: { text: "Before scroll source", start: 123, end: 200 } };
  fastImageMetadata = { tabId: mediaTab, reading: { offset: 456, heading: "Scrolled during capture" }, selection: { text: "" } };
  const androidMovedView = await http.callTool({ name: "view_current", arguments: { deviceId, tabId: mediaTab } });
  assert.equal(androidMovedView.isError, undefined);
  const androidMoved = JSON.parse(String(androidMovedView.content?.[1]?.type === "text" ? androidMovedView.content[1].text : "{}"));
  assert.equal(androidMoved.readingContextSource, "context_read", "Android retains its source response when capture metadata has no source text");
  assert.equal(androidMoved.readingContext.reading.offset, 123);
  assert.equal(androidMoved.captureContext.reading.offset, 456);
  assert.equal(androidMoved.readingContextAlignedWithCapture, false, "same revision does not hide scroll movement between context and capture");
  fastContext = undefined;
  fastImageMetadata = undefined;

  fastRpcCounts = { list_tabs: 0, get_context: 0, render_tab: 0, list_diagrams: 0 };
  fastContext = { tabId: mediaTab, revision: "invalid-revision" };
  const malformedContext = await http.callTool({ name: "view_current", arguments: { deviceId, tabId: mediaTab } });
  assert.equal(malformedContext.isError, true);
  assert.equal(fastRpcCounts.render_tab, 0, "invalid context revisions are rejected before viewport capture");
  fastContext = { revision };
  const missingContextTab = await http.callTool({ name: "view_current", arguments: { deviceId, tabId: mediaTab } });
  assert.equal(missingContextTab.isError, true, "context requires a nonempty native tab id");
  fastContext = undefined;

  fastRpcCounts = { list_tabs: 0, get_context: 0, render_tab: 0, list_diagrams: 0 };
  fastTabs = [{ id: "tab:first", active: true }, { id: "tab:second", active: true }];
  const ambiguousTab = await http.callTool({ name: "view_current", arguments: { deviceId } });
  assert.equal(ambiguousTab.isError, true);
  assert.equal(fastRpcCounts.get_context, 0, "ambiguous active tabs are rejected before context reads");
  assert.equal(fastRpcCounts.render_tab, 0);

  fastTabs = undefined;
  fastSnapshotRevision = "c".repeat(64);
  const staleView = await http.callTool({ name: "view_current", arguments: { deviceId, tabId: mediaTab } });
  assert.equal(staleView.isError, true, "a snapshot from a changed revision is rejected");
  assert.match(String(staleView.content?.[0]?.type === "text" ? staleView.content[0].text : ""), /changed while its viewport/);
  fastSnapshotRevision = undefined;
  fastCaptureError = "Viewport capture failed clearly";
  fastRequests.length = 0;
  const captureFailure = await http.callTool({ name: "view_current", arguments: { deviceId, tabId: mediaTab } });
  assert.equal(captureFailure.isError, true);
  assert.match(String(captureFailure.content?.[0]?.type === "text" ? captureFailure.content[0].text : ""), /Viewport capture failed clearly/);
  assert.equal(fastRequests.filter((request) => request.action === "render_tab").length, 1, "unrelated capture failures are not retried as PNG fallback");
  fastCaptureError = undefined;

  fastImageMimeOverride = "image/jpeg";
  fastImageDataFormat = "image/png";
  const forgedMime = await http.callTool({ name: "view_current", arguments: { deviceId, tabId: mediaTab } });
  assert.equal(forgedMime.isError, true, "a forged JPEG MIME type over PNG bytes is rejected");
  assert.match(String(forgedMime.content?.[0]?.type === "text" ? forgedMime.content[0].text : ""), /MIME type does not match/);
  fastImageMimeOverride = undefined;
  fastImageDataFormat = undefined;

  fastRpcCounts = { list_tabs: 0, get_context: 0, render_tab: 0, list_diagrams: 0 };
  const contextOnly = await http.callTool({ name: "view_current", arguments: { deviceId, tabId: mediaTab, includeImage: false } });
  assert.equal(contextOnly.content?.some((item) => item.type === "image"), false);
  assert.equal(fastRpcCounts.get_context, 1);
  assert.equal(fastRpcCounts.list_tabs, 0, "an explicit tab skips discovery even without an image");
  assert.equal(fastRpcCounts.render_tab, 0, "context-only requests do not issue a PNG capture RPC");
  const stale = await http.callTool({ name: "patch_tab", arguments: { deviceId, tabId: "tab:" + deviceId + ":main:1", expectedRevision: revision, operations: [{ type: "replace", old: "Live", new: "New" }] } });
  assert.equal(stale.isError, true);

  const secondId = randomUUID(), secondKey = token();
  assert.equal((await enroll(pairingKey, connectorKey, groupId, secondId, secondKey, "Test Desktop", "desktop")).status, 200);
  let second!: WebSocket;
  const secondRequests: Record<string, unknown>[] = [];
  const secondTab = "tab:second";
  const attachSecondHandler = (socket: WebSocket) => socket.on("message", (raw) => {
    const request = JSON.parse(raw.toString()) as Record<string, unknown>;
    if (request.type !== "request") return;
    secondRequests.push(request);
    const result = request.action === "list_tabs" ? { tabs: [{ id: secondTab, active: true }] }
      : request.action === "document_action" && request.documentAction === "get_context"
        ? { tabId: request.tabId, revision, mode: "reading", reading: { offset: 1 }, visibleSource: { text: "Legacy source", start: 1, end: 20 } }
        : request.action === "render_tab"
          ? { mime_type: request.imageFormat === "jpeg" ? "image/jpeg" : "image/png", data: (request.imageFormat === "jpeg" ? jpeg : png).toString("base64"), width: 1600, height: 900, revision, metadata: { tabId: request.tabId, reading: { offset: 1 } } }
          : { accepted: true };
    socket.send(JSON.stringify({ type: "reply", requestId: request.requestId, result }));
  });
  const connectSecond = async (previewFormats?: string) => {
    second = new WebSocket("ws://" + host + "/device?groupId=" + groupId + "&deviceId=" + secondId, {
      headers: { authorization: "Bearer " + secondKey, "x-supermd-connector-hash": connectorHash,
        "x-supermd-display-name": "Test Desktop", "x-supermd-platform": "desktop",
        ...(previewFormats ? { "x-supermd-preview-formats": previewFormats } : {}) },
    });
    const registered = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("second device registration timeout")), 2000);
      second.once("message", (raw) => { clearTimeout(timer); try { assert.equal(JSON.parse(raw.toString()).deviceId, secondId); resolve(); } catch (e) { reject(e); } });
    });
    await once(second, "open");
    await registered;
    attachSecondHandler(second);
  };
  await connectSecond();
  t.after(() => second.close());
  const legacyPreview = await http.callTool({ name: "view_current", arguments: { deviceId: secondId, tabId: secondTab } });
  assert.equal(legacyPreview.isError, undefined);
  const legacyRender = secondRequests.find((request) => request.action === "render_tab");
  assert.equal(legacyRender?.imageFormat, undefined, "legacy connections receive no unknown imageFormat field");
  assert.equal(second.readyState, WebSocket.OPEN, "legacy PNG requests do not disconnect the device");
  assert.equal(legacyPreview.content?.[0]?.type === "image" ? legacyPreview.content[0].mimeType : "", "image/jpeg", "legacy PNG capture is converted by the server");
  const legacySocketClosed = once(second, "close");
  second.close(1000, "Reconnect with JPEG capability");
  await legacySocketClosed;
  await connectSecond("png,jpeg");
  secondRequests.length = 0;
  const capablePreview = await http.callTool({ name: "view_current", arguments: { deviceId: secondId, tabId: secondTab } });
  assert.equal(capablePreview.isError, undefined);
  assert.equal(secondRequests.find((request) => request.action === "render_tab")?.imageFormat, "jpeg", "capability is refreshed from the current authenticated connection");
  const beforeAmbiguousView = { ...fastRpcCounts };
  const ambiguousDeviceView = await http.callTool({ name: "view_current", arguments: {} });
  assert.equal(ambiguousDeviceView.isError, true, "view_current requires an explicit device when multiple are online");
  assert.deepEqual(fastRpcCounts, beforeAmbiguousView, "ambiguous device selection stops before any context or capture RPC");
  const unknownDeviceView = await http.callTool({ name: "view_current", arguments: { deviceId: randomUUID(), tabId: "unknown-tab" } });
  assert.equal(unknownDeviceView.isError, true, "unknown devices fail before context reads");
  assert.deepEqual(fastRpcCounts, beforeAmbiguousView);
  const offlineDeviceId = randomUUID();
  assert.equal((await enroll(pairingKey, connectorKey, groupId, offlineDeviceId, token(), "Offline Device", "desktop")).status, 200);
  const offlineView = await http.callTool({ name: "view_current", arguments: { deviceId: offlineDeviceId, tabId: "offline-tab" } });
  assert.equal(offlineView.isError, true);
  assert.match(String(offlineView.content?.[0]?.type === "text" ? offlineView.content[0].text : ""), /device is offline/);
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
