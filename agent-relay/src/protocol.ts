export const ACTIONS = new Set(["list_devices", "list_tabs", "read_tab", "search_tab", "patch_tab", "render_tab", "list_diagrams", "get_diagram", "get_diagram_image", "replace_tab_asset", "asset_action", "document_action"]);
export const DOCUMENT_ACTIONS = new Set(["create", "export", "latexfix", "open", "save", "snapshot", "job_status", "get_context"]);
export const MAX_FRAME_BYTES = 5 * 1024 * 1024;
export const MAX_TEXT_BYTES = 64 * 1024;
export const MAX_PENDING = 8;
export const REQUEST_TIMEOUT_MS = 20_000;

export type RpcRequest = {
  requestId: string;
  action: string;
  deviceId?: string;
  tabId?: string;
  offset?: number;
  limit?: number;
  query?: string;
  context?: number;
  expectedRevision?: string;
  operations?: unknown[];
  width?: number;
  imageFormat?: "png" | "jpeg";
  documentAction?: string;
  content?: string;
  options?: Record<string, unknown>;
  diagramId?: string;
  format?: string;
  repairIndices?: number[];
  jobId?: string;
  heading?: string;
  filename?: string;
  windowId?: string;
  assetId?: string;
  mimeType?: string;
  body?: string;
  assetName?: string;
  assetPath?: string;
  assetAction?: "list" | "source" | "attach";
  view?: "source" | "prose";
};

export function validateRpcRequest(value: unknown): RpcRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid RPC request");
  const r = value as Record<string, unknown>;
  const allowed = new Set(["requestId", "action", "deviceId", "tabId", "offset", "limit", "query", "context", "expectedRevision", "operations", "width", "imageFormat", "documentAction", "content", "options", "diagramId", "format", "repairIndices", "jobId", "heading", "filename", "windowId", "assetId", "mimeType", "body", "assetName", "assetPath", "assetAction", "view"]);
  if (Object.keys(r).some((key) => !allowed.has(key))) throw new Error("Unknown RPC field");
  if (typeof r.requestId !== "string" || !/^[a-zA-Z0-9_-]{1,96}$/.test(r.requestId)) throw new Error("Invalid request id");
  if (typeof r.action !== "string" || !ACTIONS.has(r.action)) throw new Error("Unsupported action");
  if (r.deviceId !== undefined && (typeof r.deviceId !== "string" || !/^[0-9a-f-]{36}$/i.test(r.deviceId))) throw new Error("Invalid device id");
  if (r.tabId !== undefined && (typeof r.tabId !== "string" || r.tabId.length > 512)) throw new Error("Invalid tab id");
  if (r.query !== undefined && (typeof r.query !== "string" || Buffer.byteLength(r.query) > 2048)) throw new Error("Invalid query");
  if (r.expectedRevision !== undefined && (typeof r.expectedRevision !== "string" || !/^[a-f0-9]{64}$/i.test(r.expectedRevision))) throw new Error("Invalid expected revision");
  if (r.operations !== undefined && (!Array.isArray(r.operations) || r.operations.length > 100 || Buffer.byteLength(JSON.stringify(r.operations)) > MAX_TEXT_BYTES)) throw new Error("Invalid patch operations");
  if (r.content !== undefined && (typeof r.content !== "string" || Buffer.byteLength(r.content) > MAX_TEXT_BYTES)) throw new Error("Invalid document content");
  if (r.options !== undefined && (!r.options || typeof r.options !== "object" || Array.isArray(r.options) || Buffer.byteLength(JSON.stringify(r.options)) > 16 * 1024)) throw new Error("Invalid action options");
  if (r.diagramId !== undefined && (typeof r.diagramId !== "string" || r.diagramId.length > 128)) throw new Error("Invalid diagram id");
  if (r.format !== undefined && (typeof r.format !== "string" || !["pdf", "smd", "md"].includes(r.format))) throw new Error("Invalid export format");
  if (r.repairIndices !== undefined && (!Array.isArray(r.repairIndices) || r.repairIndices.length > 40 || r.repairIndices.some((n) => !Number.isInteger(n) || n < 0))) throw new Error("Invalid repair indices");
  if (r.jobId !== undefined && (typeof r.jobId !== "string" || r.jobId.length > 128)) throw new Error("Invalid job id");
  if (r.heading !== undefined && (typeof r.heading !== "string" || Buffer.byteLength(r.heading) > 512)) throw new Error("Invalid heading");
  if (r.filename !== undefined && (typeof r.filename !== "string" || Buffer.byteLength(r.filename) > 256 || /[\\/\0]/.test(r.filename))) throw new Error("Invalid filename");
  if (r.windowId !== undefined && (typeof r.windowId !== "string" || r.windowId.length > 128)) throw new Error("Invalid window id");
  if (r.assetId !== undefined && (typeof r.assetId !== "string" || r.assetId.length > 512)) throw new Error("Invalid asset id");
  if (r.mimeType !== undefined && (typeof r.mimeType !== "string" || r.mimeType.length > 128)) throw new Error("Invalid media type");
  if (r.body !== undefined && (typeof r.body !== "string" || Buffer.byteLength(r.body) > 1_400_000)) throw new Error("Media body is too large");
  if (r.mimeType !== undefined && !["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/svg+xml"].includes(String(r.mimeType).toLowerCase())) throw new Error("Unsupported image type");
  if (r.assetName !== undefined && (typeof r.assetName !== "string" || Buffer.byteLength(r.assetName) > 256 || !( /^[a-f0-9]{64}$/.test(r.assetName) || /^(?:assets\/)?[A-Za-z0-9._-]{1,150}$/.test(r.assetName) && ![".",".."].includes(r.assetName.split("/").at(-1)!)))) throw new Error("Invalid asset name");
  if (r.assetPath !== undefined && (typeof r.assetPath !== "string" || Buffer.byteLength(r.assetPath) > 4096 || r.assetPath.includes("\0"))) throw new Error("Invalid asset path");
  if (r.view !== undefined && r.view !== "source" && r.view !== "prose") throw new Error("Invalid document view");
  if (r.imageFormat !== undefined && (!(["render_tab", "get_diagram_image"] as string[]).includes(r.action as string) || (r.imageFormat !== "png" && r.imageFormat !== "jpeg"))) throw new Error("imageFormat is only valid as png or jpeg on viewport or diagram image captures");
  for (const key of ["offset", "limit", "context", "width"] as const) {
    const n = r[key];
    if (n !== undefined && (typeof n !== "number" || !Number.isInteger(n) || n < 0)) throw new Error(`Invalid ${key}`);
  }
  if (typeof r.offset === "number" && r.offset > 20_000_000) throw new Error("Offset is too large");
  if (typeof r.limit === "number" && r.limit > 12_000) throw new Error("Limit is too large");
  if (typeof r.context === "number" && r.context > 500) throw new Error("Context is too large");
  if (typeof r.width === "number" && (r.width < 1 || r.width > 1600)) throw new Error("Width must be between 1 and 1600");
  if (r.action === "document_action" && (typeof r.documentAction !== "string" || !DOCUMENT_ACTIONS.has(r.documentAction))) throw new Error("Unsupported document action");
  if (["read_tab", "search_tab", "patch_tab", "render_tab", "list_diagrams", "get_diagram", "get_diagram_image", "replace_tab_asset", "asset_action"].includes(r.action) && typeof r.tabId !== "string") throw new Error("tabId is required");
  if (["get_diagram", "get_diagram_image"].includes(r.action) && (!r.diagramId || !r.expectedRevision)) throw new Error("diagram requests need diagramId and expectedRevision");
  if (["list_diagrams", "replace_tab_asset"].includes(r.action) && !r.expectedRevision) throw new Error("This action needs the current document revision");
  if (r.action === "replace_tab_asset" && (!r.assetName || !r.assetPath)) throw new Error("Asset replacement requires assetName and assetPath");
  if (r.action === "asset_action") {
    if (!r.expectedRevision) throw new Error("Asset actions need the current document revision");
    if (!["list", "source", "attach"].includes(String(r.assetAction))) throw new Error("Unsupported asset action");
    if (r.assetAction === "source" && !r.assetName) throw new Error("Asset source requires assetName");
    if (r.assetAction === "list" && ((r.offset !== undefined && (!Number.isInteger(r.offset) || Number(r.offset) > 512)) || (r.limit !== undefined && (!Number.isInteger(r.limit) || Number(r.limit) < 1 || Number(r.limit) > 50)))) throw new Error("Invalid asset page");
    if (r.assetAction === "attach" && (!r.assetName || !r.mimeType || !r.body)) throw new Error("Attaching an asset requires assetName, mimeType and body");
    if (r.body !== undefined) {
      if (typeof r.body !== "string" || r.body.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(r.body)) throw new Error("Media body must be base64");
      const bytes = Buffer.from(r.body, "base64");
      if (bytes.length < 1 || bytes.length > 1_048_576) throw new Error("Media body must be at most 1 MiB");
    }
    if (r.assetAction === "attach" && (!/^(?:assets\/)?[A-Za-z0-9._-]{1,150}$/.test(String(r.assetName)) || [".", ".."].includes(String(r.assetName).split("/").at(-1)!))) throw new Error("Invalid new asset name");
  }
  if (r.action === "document_action" && ["export", "latexfix", "save", "snapshot", "get_context"].includes(String(r.documentAction)) && typeof r.tabId !== "string") throw new Error("tabId is required for this document action");
  if (r.action === "document_action" && r.documentAction === "job_status" && typeof r.jobId !== "string") throw new Error("job_status requires jobId");
  if (r.action === "patch_tab" && (!r.expectedRevision || !r.operations)) throw new Error("Patch requires expectedRevision and operations");
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
