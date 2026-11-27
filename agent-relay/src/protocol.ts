import { z } from "zod";
import {
  assetIdSchema, assetListLimitSchema, assetListOffsetSchema, assetMimeTypeSchema, assetOffsetSchema, createSaveFormatSchema,
  deviceIdSchema, diagramIdSchema, diagramListLimitSchema, documentContentField, documentViewSchema, exportFormatSchema,
  headingIndexField, imageFormatSchema, isValidCompatPortableAssetName, isValidPortableAssetName, jobIdSchema,
  MAX_ASSET_BASE64_CHARS, MAX_ASSET_BYTES, MAX_HEADING_BYTES, MAX_RELAY_OPTIONS_BYTES, MAX_RPC_QUERY_BYTES, MAX_TEXT_BYTES,
  patchOperationsField, repairIndicesSchema, requestIdSchema, REVISION_RE, rpcViewportWidthSchema, SEARCH_BOOLEAN_FLAGS,
  searchContextSchema, searchLimitSchema, tabIdField, textLimitSchema, textOffsetSchema, windowIdSchema, wireRevisionSchema,
} from "./schemas.js";

export { isValidCompatPortableAssetName, isValidPortableAssetName, MAX_TEXT_BYTES };
export const ACTIONS = new Set(["list_devices", "list_tabs", "read_tab", "search_tab", "patch_tab", "render_tab", "list_diagrams", "get_diagram", "get_diagram_image", "replace_tab_asset", "asset_action", "document_action"]);
export const DOCUMENT_ACTIONS = new Set(["create", "export", "export_chunk", "outline", "latexfix", "latex_review", "latex_apply", "open", "activate", "close", "save", "snapshot", "job_status", "get_context"]);
export const MAX_FRAME_BYTES = 5 * 1024 * 1024;
export const MAX_PENDING = 8;
export const REQUEST_TIMEOUT_MS = 20_000;

export type RpcRequest = {
  requestId: string; action: string; deviceId?: string; tabId?: string; offset?: number; limit?: number;
  query?: string; context?: number; caseSensitive?: boolean; wholeWord?: boolean; regex?: boolean; excludeDiagrams?: boolean;
  expectedRevision?: string; operations?: unknown[]; width?: number; imageFormat?: "png" | "jpeg"; documentAction?: string;
  content?: string; options?: Record<string, unknown>; diagramId?: string; format?: string; repairIndices?: number[];
  jobId?: string; heading?: string | number; filename?: string; windowId?: string; assetId?: string; mimeType?: string;
  body?: string; assetName?: string; assetPath?: string; assetAction?: "list" | "source" | "attach"; view?: "source" | "prose";
};

const RPC_ALLOWED_KEYS = new Set([
  "requestId", "action", "deviceId", "tabId", "offset", "limit", "query", "context", "expectedRevision", "operations",
  "width", "imageFormat", "documentAction", "content", "options", "diagramId", "format", "repairIndices", "jobId",
  "heading", "filename", "windowId", "assetId", "mimeType", "body", "assetName", "assetPath", "assetAction", "view",
  ...SEARCH_BOOLEAN_FLAGS,
]);
const nonNegativeInt = z.number().int().min(0);
const exportChunkOffsetSchema = z.number().int().min(0).max(128 * 1024 * 1024);
const exportChunkLimitSchema = z.number().int().min(1).max(524_288);
const rpcHeadingSchema = z.union([headingIndexField.refine(Number.isSafeInteger), z.string().refine((s) => Buffer.byteLength(s) <= MAX_HEADING_BYTES)]);
const rpcFilenameSchema = z.string().refine((s) => Buffer.byteLength(s) <= 256 && !/[\\/\0]/.test(s));
const rpcAssetPathSchema = z.string().min(1).refine((s) => Buffer.byteLength(s) <= 4096 && !s.includes("\0"));
const base64BodySchema = z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/).refine((s) => s.length % 4 === 0);

function check<T>(schema: z.ZodType<T>, value: unknown, message: string): void {
  if (value !== undefined && !schema.safeParse(value).success) throw new Error(message);
}

export function validateRpcRequest(value: unknown): RpcRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid RPC request");
  const r = value as Record<string, unknown>;
  for (const key of SEARCH_BOOLEAN_FLAGS) check(z.boolean(), r[key], `Invalid ${key}`);
  if (Object.keys(r).some((key) => !RPC_ALLOWED_KEYS.has(key))) throw new Error("Unknown RPC field");
  if (!requestIdSchema.safeParse(r.requestId).success) throw new Error("Invalid requestId");
  if (typeof r.action !== "string" || !ACTIONS.has(r.action)) throw new Error("Unsupported RPC action");
  check(deviceIdSchema, r.deviceId, "Invalid device id");
  check(tabIdField, r.tabId, "Invalid tab id");
  if (r.query !== undefined && (typeof r.query !== "string" || r.query.length < 1 || Buffer.byteLength(r.query) > MAX_RPC_QUERY_BYTES)) throw new Error("Invalid search query");
  check(wireRevisionSchema, r.expectedRevision, "Invalid expectedRevision");
  if (r.operations !== undefined) {
    if (!Array.isArray(r.operations) || r.operations.length === 0) throw new Error("patch_tab requires non-empty operations");
    if (!patchOperationsField.safeParse(r.operations).success) throw new Error("Invalid patch operations");
    if (Buffer.byteLength(JSON.stringify(r.operations)) > MAX_TEXT_BYTES) throw new Error("Text payload exceeds relay limit");
  }
  if (r.content !== undefined) {
    if (typeof r.content !== "string") throw new Error("Invalid document content");
    if (!documentContentField.safeParse(r.content).success || Buffer.byteLength(r.content) > MAX_TEXT_BYTES) throw new Error("Text payload exceeds relay limit");
  }
  if (r.options !== undefined && (!r.options || typeof r.options !== "object" || Array.isArray(r.options) || Buffer.byteLength(JSON.stringify(r.options)) > MAX_RELAY_OPTIONS_BYTES)) throw new Error("Invalid action options");
  check(diagramIdSchema, r.diagramId, "Invalid diagramId");
  check(exportFormatSchema, r.format, "Invalid export format");
  check(repairIndicesSchema, r.repairIndices, "Invalid repair indices");
  check(jobIdSchema, r.jobId, "Invalid job id");
  check(rpcHeadingSchema, r.heading, "Invalid heading");
  check(rpcFilenameSchema, r.filename, "Invalid filename");
  check(windowIdSchema, r.windowId, "Invalid window id");
  check(assetIdSchema, r.assetId, "Invalid asset id");
  if (r.mimeType !== undefined) {
    if (typeof r.mimeType !== "string" || r.mimeType.length > 128) throw new Error("Invalid media type");
    check(assetMimeTypeSchema, r.mimeType.toLowerCase(), "Unsupported image type");
  }
  if (r.body !== undefined && (typeof r.body !== "string" || Buffer.byteLength(r.body) > MAX_ASSET_BASE64_CHARS)) throw new Error("Media body is too large");
  if (r.assetName !== undefined && (typeof r.assetName !== "string" || Buffer.byteLength(r.assetName) > 256 || !(REVISION_RE.test(r.assetName) || isValidCompatPortableAssetName(r.assetName)))) throw new Error("Invalid asset name");
  check(rpcAssetPathSchema, r.assetPath, "Invalid asset path");
  check(documentViewSchema, r.view, "Invalid document view");
  if (r.imageFormat !== undefined && (!(["render_tab", "get_diagram_image"] as string[]).includes(r.action) || !imageFormatSchema.safeParse(r.imageFormat).success)) throw new Error("imageFormat is only valid as png or jpeg on viewport or diagram image captures");
  for (const key of ["offset", "limit", "context"] as const) check(nonNegativeInt, r[key], `Invalid ${key}`);
  check(rpcViewportWidthSchema, r.width, "Width must be between 1 and 1600");
  const exportChunk = r.action === "document_action" && r.documentAction === "export_chunk";
  check(exportChunk ? exportChunkOffsetSchema : textOffsetSchema, r.offset, "Offset is too large");
  check(exportChunk ? exportChunkLimitSchema : textLimitSchema, r.limit, "Limit is too large");
  check(searchContextSchema, r.context, "Context is too large");
  if (r.action === "document_action") {
    if (typeof r.documentAction !== "string" || !DOCUMENT_ACTIONS.has(r.documentAction)) throw new Error("Unsupported document action");
    const opts = r.options as Record<string, unknown> | undefined;
    if (r.documentAction === "create" || r.documentAction === "save") check(createSaveFormatSchema, r.format ?? opts?.format, "Create/save format must be md or smd");
    if (r.documentAction === "outline") check(diagramListLimitSchema, r.limit ?? opts?.limit, "Outline limit must be between 1 and 80");
  }
  if (["read_tab", "search_tab", "patch_tab", "render_tab", "list_diagrams", "get_diagram", "get_diagram_image", "replace_tab_asset", "asset_action"].includes(r.action) && typeof r.tabId !== "string") throw new Error("tabId is required");
  if (["get_diagram", "get_diagram_image"].includes(r.action) && (!r.diagramId || !r.expectedRevision)) throw new Error("diagram requests need diagramId and expectedRevision");
  if (r.action === "replace_tab_asset") {
    if (!r.expectedRevision) throw new Error("This action needs the current document revision");
    if (!r.assetName || !r.assetPath) throw new Error("Asset replacement requires assetName and assetPath");
  }
  if (r.action === "asset_action") {
    if (!r.expectedRevision) throw new Error("Asset actions need the current document revision");
    if (!["list", "source", "attach"].includes(String(r.assetAction))) throw new Error("Unsupported asset action");
    if (r.assetAction === "source" && !r.assetName) throw new Error("Asset source requires assetName");
    if (r.assetAction === "source") check(assetOffsetSchema, r.offset, "Offset is too large");
    if (r.assetAction === "list") { check(assetListOffsetSchema, r.offset, "Invalid asset page"); check(assetListLimitSchema, r.limit, "Invalid asset page"); }
    if (r.assetAction === "attach" && (!r.assetName || !r.mimeType || !r.body)) throw new Error("Attaching an asset requires assetName, mimeType and body");
    if (r.body !== undefined) {
      check(base64BodySchema, r.body, "Media body must be base64");
      const bytes = Buffer.from(r.body as string, "base64");
      if (bytes.length < 1 || bytes.length > MAX_ASSET_BYTES) throw new Error("Media body must be at most 1 MiB");
    }
    if (r.assetAction === "attach" && (typeof r.assetName !== "string" || !isValidPortableAssetName(r.assetName))) throw new Error("Invalid new asset name");
  }
  if (r.action === "document_action" && ["export", "outline", "latexfix", "latex_review", "latex_apply", "activate", "close", "save", "snapshot", "get_context"].includes(String(r.documentAction)) && typeof r.tabId !== "string") throw new Error("tabId is required for this document action");
  if (r.action === "document_action" && ["job_status", "export_chunk"].includes(String(r.documentAction)) && typeof r.jobId !== "string") throw new Error("This action requires jobId");
  if (r.action === "document_action" && ["save", "close", "export", "latex_apply"].includes(String(r.documentAction)) && !r.expectedRevision) throw new Error("This document action requires expectedRevision");
  if (r.content !== undefined && !(r.action === "document_action" && r.documentAction === "create")) throw new Error("Document content is only accepted for create");
  if (r.operations !== undefined && r.action !== "patch_tab") throw new Error("operations is only accepted for patch_tab");
  if (r.action === "list_diagrams") check(diagramListLimitSchema, r.limit, "Diagram list limit must be between 1 and 80");
  if (r.action === "search_tab") check(searchLimitSchema, r.limit, "Search limit must be between 1 and 25");
  if (r.action === "patch_tab") {
    if (!r.expectedRevision) throw new Error("Patch requires expectedRevision and operations");
    if (!r.operations) throw new Error("patch_tab requires non-empty operations");
  }
  return r as RpcRequest;
}

export function validReply(value: unknown, requestId: string): { result?: unknown; error?: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid device reply");
  const r = value as Record<string, unknown>;
  if (r.requestId !== requestId) throw new Error("Reply request id mismatch");
  if (r.error !== undefined && (typeof r.error !== "string" || Buffer.byteLength(r.error) > 2048)) throw new Error("Invalid device error");
  if (r.result !== undefined && Buffer.byteLength(JSON.stringify(r.result)) > MAX_FRAME_BYTES) throw new Error("Device result is too large");
  return { result: r.result, error: r.error as string | undefined };
}
