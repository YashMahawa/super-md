import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { normalizeReadingContext, viewportContexts } from "./preview.js";
import { isValidCompatPortableAssetName, isValidPortableAssetName, validateRpcRequest } from "./protocol.js";
import {
  CREATE_SAVE_FORMATS, DIAGRAM_ID_RE, EXPORT_FORMATS, IMAGE_FORMATS, IMAGE_QUALITIES, MAX_ASSET_BASE64_CHARS,
  MAX_ASSET_BYTES, MAX_HEADING_BYTES, MAX_RELAY_OPTIONS_BYTES, MAX_RPC_QUERY_BYTES, MAX_TEXT_BYTES,
  PORTABLE_ASSET_NAME_RE, REQUEST_ID_RE, REVISION_RE, SEARCH_BOOLEAN_FLAGS, TOOL_INPUT_SCHEMAS, WIRE_REVISION_RE,
} from "./schemas.js";

const contract = JSON.parse(readFileSync(new URL("../../docs/agent-contract.json", import.meta.url), "utf8"));
const rev = "a".repeat(64);
const upperRev = "A".repeat(64);

test("TOOL_INPUT_SCHEMAS and validateRpcRequest conform to docs/agent-contract.json", () => {
  assert.equal(contract.version, 1);
  assert.equal("operations" in TOOL_INPUT_SCHEMAS.document_action.shape, false);
  assert.equal(REVISION_RE.source, contract.revision.lowercaseHexPattern);
  assert.equal(WIRE_REVISION_RE.source, contract.revision.wireHexPattern);
  assert.equal(z.toJSONSchema(TOOL_INPUT_SCHEMAS.patch_tab.shape.expectedRevision).pattern, contract.revision.lowercaseHexPattern);
  assert.equal(TOOL_INPUT_SCHEMAS.patch_tab.shape.expectedRevision.safeParse(rev).success, true);
  assert.equal(TOOL_INPUT_SCHEMAS.patch_tab.shape.expectedRevision.safeParse(upperRev).success, false);
  assert.equal(validateRpcRequest({ requestId: "r1", action: "read_tab", tabId: "t1", expectedRevision: upperRev }).expectedRevision, upperRev);
  assert.throws(() => validateRpcRequest({ requestId: "r1", action: "read_tab", tabId: "t1", expectedRevision: "a".repeat(contract.revision.length - 1) }), /Invalid expectedRevision/);

  assert.equal(REQUEST_ID_RE.source, contract.identifiers.requestIdPattern);
  assert.equal(validateRpcRequest({ requestId: "r".repeat(contract.identifiers.requestIdMax), action: "list_tabs" }).action, "list_tabs");
  assert.throws(() => validateRpcRequest({ requestId: "r".repeat(contract.identifiers.requestIdMax + 1), action: "list_tabs" }), /Invalid requestId/);
  assert.equal(TOOL_INPUT_SCHEMAS.search_tab.shape.tabId.safeParse("t".repeat(contract.identifiers.tabIdMax)).success, true);
  assert.equal(TOOL_INPUT_SCHEMAS.search_tab.shape.tabId.safeParse("t".repeat(contract.identifiers.tabIdMax + 1)).success, false);
  assert.throws(() => validateRpcRequest({ requestId: "r1", action: "read_tab", tabId: "t".repeat(contract.identifiers.tabIdMax + 1) }), /Invalid tab id/);
  assert.equal(validateRpcRequest({ requestId: "r1", action: "document_action", documentAction: "job_status", jobId: "j".repeat(contract.identifiers.jobIdMax) }).jobId?.length, contract.identifiers.jobIdMax);
  assert.throws(() => validateRpcRequest({ requestId: "r1", action: "document_action", documentAction: "job_status", jobId: "j".repeat(contract.identifiers.jobIdMax + 1) }), /Invalid job id/);
  assert.equal(validateRpcRequest({ requestId: "r1", action: "list_tabs", windowId: "w".repeat(contract.identifiers.desktopIdentifierMax) }).windowId?.length, contract.identifiers.desktopIdentifierMax);
  assert.throws(() => validateRpcRequest({ requestId: "r1", action: "list_tabs", windowId: "w".repeat(contract.identifiers.desktopIdentifierMax + 1) }), /Invalid window id/);

  const minDiagramId = contract.identifiers.diagramIdPrefix + "0";
  const maxDiagramId = contract.identifiers.diagramIdPrefix + "x".repeat(contract.identifiers.diagramIdMax - contract.identifiers.diagramIdPrefix.length);
  assert.equal(minDiagramId.length, contract.identifiers.diagramIdMin);
  assert.equal(DIAGRAM_ID_RE.test(minDiagramId), true);
  assert.equal(TOOL_INPUT_SCHEMAS.diagram_action.shape.diagramId.safeParse(minDiagramId).success, true);
  assert.equal(TOOL_INPUT_SCHEMAS.diagram_action.shape.diagramId.safeParse(maxDiagramId).success, true);
  for (const badId of [contract.identifiers.diagramIdPrefix, maxDiagramId + "x", "other:12345"]) {
    assert.equal(TOOL_INPUT_SCHEMAS.diagram_action.shape.diagramId.safeParse(badId).success, false);
    assert.throws(() => validateRpcRequest({ requestId: "r1", action: "get_diagram", tabId: "t1", diagramId: badId, expectedRevision: rev }), /Invalid diagramId/);
  }

  assert.equal(MAX_HEADING_BYTES, contract.heading.relayMaxBytes);
  assert.equal(TOOL_INPUT_SCHEMAS.read_tab.shape.heading.safeParse(contract.heading.minIndex).success, true);
  assert.equal(TOOL_INPUT_SCHEMAS.read_tab.shape.heading.safeParse(contract.heading.minIndex - 1).success, false);
  assert.throws(() => validateRpcRequest({ requestId: "r1", action: "read_tab", tabId: "t1", heading: "猫".repeat(200) }), /Invalid heading/);
  assert.equal(PORTABLE_ASSET_NAME_RE.source, new RegExp(contract.filenames.portableAssetCharsetPattern).source);
  const newMaxName = `assets/${"a".repeat(contract.filenames.portableAssetNewMax - 4)}.png`;
  const compatMaxName = `assets/${"a".repeat(contract.filenames.portableAssetCompatMax - 4)}.png`;
  assert.equal(isValidPortableAssetName(newMaxName), true);
  assert.equal(isValidPortableAssetName(compatMaxName), false);
  assert.equal(isValidCompatPortableAssetName(compatMaxName), true);
  assert.equal(isValidCompatPortableAssetName(`assets/${"a".repeat(contract.filenames.portableAssetCompatMax - 3)}.png`), false);
  for (const bad of contract.filenames.disallowedBasenames as string[]) {
    assert.equal(isValidPortableAssetName(bad), false);
    assert.equal(isValidCompatPortableAssetName(`assets/${bad}`), false);
  }
  assert.equal(TOOL_INPUT_SCHEMAS.document_action.safeParse({ documentAction: "export", options: { title: "t".repeat(contract.filenames.desktopExportFilenameMax), filename: "f".repeat(contract.filenames.relayFilenameMax) } }).success, true);
  assert.equal(TOOL_INPUT_SCHEMAS.document_action.safeParse({ documentAction: "export", options: { title: "t".repeat(contract.filenames.desktopExportFilenameMax + 1) } }).success, false);

  assert.deepEqual([...EXPORT_FORMATS], contract.exportFormats.live);
  assert.deepEqual([...CREATE_SAVE_FORMATS], contract.exportFormats.createAndSave);
  for (const fmt of contract.exportFormats.createAndSave as string[]) assert.equal(validateRpcRequest({ requestId: "r1", action: "document_action", documentAction: "create", format: fmt }).format, fmt);
  assert.throws(() => validateRpcRequest({ requestId: "r1", action: "document_action", documentAction: "create", format: "pdf" }), /md or smd/);
  assert.throws(() => validateRpcRequest({ requestId: "r1", action: "document_action", documentAction: "save", tabId: "t1", expectedRevision: rev, options: { format: "mdzip" } }), /md or smd/);

  assert.equal(TOOL_INPUT_SCHEMAS.read_tab.shape.limit.safeParse(contract.pagination.readPageMaxChars).success, true);
  assert.equal(TOOL_INPUT_SCHEMAS.read_tab.shape.limit.safeParse(contract.pagination.readPageMaxChars + 1).success, false);
  assert.equal(TOOL_INPUT_SCHEMAS.read_tab.shape.offset.safeParse(contract.pagination.textMaxOffset).success, true);
  assert.equal(TOOL_INPUT_SCHEMAS.asset_action.shape.offset.safeParse(contract.pagination.relayAssetSourceMaxOffset).success, true);
  assert.throws(() => validateRpcRequest({ requestId: "r1", action: "document_action", documentAction: "outline", tabId: "t1", limit: contract.pagination.outlineMaxLimit + 1 }), /80/);
  assert.throws(() => validateRpcRequest({ requestId: "r1", action: "list_diagrams", tabId: "t1", limit: contract.pagination.diagramListMaxLimit + 1 }), /80/);
  assert.throws(() => validateRpcRequest({ requestId: "r1", action: "asset_action", tabId: "t1", assetAction: "list", expectedRevision: rev, limit: contract.pagination.assetListMaxLimit + 1 }), /Invalid asset page/);
  assert.throws(() => validateRpcRequest({ requestId: "r1", action: "asset_action", tabId: "t1", assetAction: "list", expectedRevision: rev, offset: contract.pagination.assetListMaxOffset + 1 }), /Invalid asset page/);
  assert.throws(() => validateRpcRequest({ requestId: "r1", action: "document_action", documentAction: "export_chunk", jobId: "j1", limit: contract.pagination.exportChunkMaxBytes + 1 }), /too large/);

  assert.deepEqual([...SEARCH_BOOLEAN_FLAGS], contract.search.booleanFlags);
  assert.equal(MAX_RPC_QUERY_BYTES, contract.search.rpcQueryMaxBytes);
  assert.equal(TOOL_INPUT_SCHEMAS.search_tab.shape.query.safeParse("q".repeat(contract.search.queryMaxChars)).success, true);
  assert.equal(TOOL_INPUT_SCHEMAS.search_tab.shape.query.safeParse("q".repeat(contract.search.queryMaxChars + 1)).success, false);
  assert.throws(() => validateRpcRequest({ requestId: "r1", action: "search_tab", tabId: "t1", query: "q".repeat(contract.search.rpcQueryMaxBytes + 1) }), /Invalid search query/);
  assert.throws(() => validateRpcRequest({ requestId: "r1", action: "search_tab", tabId: "t1", query: "q", limit: contract.search.limitMax + 1 }), /25/);
  assert.throws(() => validateRpcRequest({ requestId: "r1", action: "search_tab", tabId: "t1", query: "q", context: contract.search.contextMax + 1 }), /too large/);

  assert.equal(MAX_TEXT_BYTES, contract.mutations.maxTextBytes);
  assert.equal(MAX_ASSET_BYTES, contract.mutations.maxRelayAssetBytes);
  assert.equal(MAX_ASSET_BASE64_CHARS, contract.mutations.maxRelayAssetBase64Chars);
  assert.equal(MAX_RELAY_OPTIONS_BYTES, contract.mutations.maxRelayOptionsBytes);
  assert.equal(TOOL_INPUT_SCHEMAS.patch_tab.shape.operations.safeParse(Array.from({ length: contract.mutations.maxPatchOperations }, () => ({ type: "insert", line: 1, text: "x" }))).success, true);
  assert.equal(TOOL_INPUT_SCHEMAS.patch_tab.shape.operations.safeParse(Array.from({ length: contract.mutations.maxPatchOperations + 1 }, () => ({ type: "insert", line: 1, text: "x" }))).success, false);
  assert.throws(() => validateRpcRequest({ requestId: "r1", action: "patch_tab", tabId: "t1", expectedRevision: rev, operations: [] }), /non-empty operations/);
  assert.equal(TOOL_INPUT_SCHEMAS.document_action.shape.content.safeParse("c".repeat(contract.mutations.maxContentChars)).success, true);
  assert.throws(() => validateRpcRequest({ requestId: "r1", action: "document_action", documentAction: "create", content: "猫".repeat(22_000) }), /Text payload exceeds relay limit/);
  assert.throws(() => validateRpcRequest({ requestId: "r1", action: "document_action", documentAction: "latex_apply", tabId: "t1", expectedRevision: rev, repairIndices: [] }), /Invalid repair indices/);
  assert.throws(() => validateRpcRequest({ requestId: "r1", action: "document_action", documentAction: "latex_apply", tabId: "t1", expectedRevision: rev, repairIndices: Array.from({ length: contract.mutations.repairIndicesMax + 1 }, (_, i) => i) }), /Invalid repair indices/);

  assert.deepEqual([...IMAGE_FORMATS], contract.viewport.imageFormats);
  assert.deepEqual([...IMAGE_QUALITIES], contract.viewport.qualities);
  assert.equal(TOOL_INPUT_SCHEMAS.render_tab.shape.width.safeParse(contract.viewport.minWidth).success, true);
  assert.equal(TOOL_INPUT_SCHEMAS.render_tab.shape.width.safeParse(contract.viewport.minWidth - 1).success, false);
  assert.equal(TOOL_INPUT_SCHEMAS.render_tab.shape.width.safeParse(contract.viewport.maxWidth).success, true);
  assert.equal(validateRpcRequest({ requestId: "r1", action: "render_tab", tabId: "t1", width: contract.viewport.rpcMinWidth }).width, contract.viewport.rpcMinWidth);
  assert.throws(() => validateRpcRequest({ requestId: "r1", action: "render_tab", tabId: "t1", width: 0 }), /Width must be between 1 and 1600/);
});

test("preview.ts normalizers match viewCurrent.fixtures in docs/agent-contract.json", () => {
  for (const fixture of contract.viewCurrent.fixtures as Array<Record<string, unknown>>) {
    if (fixture.readingContextInput) assert.deepEqual(normalizeReadingContext(fixture.readingContextInput)?.visibleSource, fixture.expectedVisibleSource, String(fixture.name));
    if (fixture.imageInput) {
      const captured = viewportContexts(fixture.imageInput as Record<string, unknown>, String(fixture.requestedTab), String(fixture.expectedRevision));
      assert.equal(captured.hasCoherentCapturedSource, fixture.expectedHasCoherentCapturedSource, String(fixture.name));
      if ("expectedCaptureSourceRange" in fixture) assert.deepEqual(captured.captureContext.sourceRange, fixture.expectedCaptureSourceRange, String(fixture.name));
      if ("expectedNativeTabId" in fixture) assert.equal(captured.captureContext.nativeTabId, fixture.expectedNativeTabId, String(fixture.name));
      if ("expectedContextRevisionMatches" in fixture) assert.equal(captured.captureContext.contextRevisionMatches, fixture.expectedContextRevisionMatches, String(fixture.name));
    }
  }
});
