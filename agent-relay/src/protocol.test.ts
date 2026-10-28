import test from "node:test";
import assert from "node:assert/strict";
import { validateRpcRequest } from "./protocol.js";

test("device RPC schema rejects unknown fields, oversized ranges and stale-write omissions", () => {
  const base = { requestId: "request_1", action: "read_tab", tabId: "tab:device:window:1" };
  assert.equal(validateRpcRequest(base).action, "read_tab");
  assert.throws(() => validateRpcRequest({ ...base, arbitraryCode: "not allowed" }), /Unknown RPC field/);
  assert.throws(() => validateRpcRequest({ ...base, limit: 12_001 }), /too large/);
  assert.throws(() => validateRpcRequest({ ...base, width: 1601 }), /1600/);
  assert.throws(() => validateRpcRequest({ requestId: "r2", action: "patch_tab", tabId: "tab:1" }), /expectedRevision/);
  assert.throws(() => validateRpcRequest({ requestId: "r3", action: "document_action", documentAction: "shell" }), /Unsupported document/);
  assert.equal(validateRpcRequest({ requestId: "r4", action: "get_diagram", tabId: "tab:1", diagramId: "diagram:0", expectedRevision: "a".repeat(64) }).diagramId, "diagram:0");
  assert.throws(() => validateRpcRequest({ requestId: "r5", action: "get_diagram", tabId: "tab:1", diagramId: "diagram:0" }), /diagram requests need/);
  assert.equal(validateRpcRequest({ requestId: "r6", action: "document_action", documentAction: "job_status", jobId: "job-1" }).jobId, "job-1");
  assert.throws(() => validateRpcRequest({ requestId: "r7", action: "replace_tab_asset", tabId: "tab:1", assetName: "image.png", assetPath: "a".repeat(4097), expectedRevision: "a".repeat(64) }), /asset path/);
  const assetRequest = {requestId:"asset",action:"replace_tab_asset",tabId:"tab:1",assetPath:"/Downloads/new.png",expectedRevision:"a".repeat(64)};
  assert.equal(validateRpcRequest({...assetRequest,assetName:"assets/current.png"}).assetName,"assets/current.png");
  assert.equal(validateRpcRequest({...assetRequest,assetName:"b".repeat(64)}).assetName,"b".repeat(64));
  for(const assetName of ["../secret.png","assets/../secret.png","assets/a/b.png","assets/..","/secret.png"])
    assert.throws(()=>validateRpcRequest({...assetRequest,assetName}),/asset name/);
  const inline = {requestId:"media",action:"asset_action",tabId:"tab:1",assetAction:"attach",assetName:"assets/model.png",mimeType:"image/png",body:"iVBORw0KGgo=",expectedRevision:"b".repeat(64)};
  assert.equal(validateRpcRequest(inline).assetAction,"attach");
  assert.throws(()=>validateRpcRequest({...inline,body:"A".repeat(1_400_001)}),/Media body is too large/);
  assert.throws(()=>validateRpcRequest({...inline,mimeType:"text/html"}),/Unsupported image type/);
  assert.throws(()=>validateRpcRequest({...inline,assetName:"assets/../model.png"}),/Invalid asset name/);
  assert.throws(()=>validateRpcRequest({...inline,assetAction:"source",assetName:undefined,body:undefined}),/source requires assetName/);
});
