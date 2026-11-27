import { z } from "zod";

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const REVISION_RE = /^[0-9a-f]{64}$/;
export const WIRE_REVISION_RE = /^[0-9a-fA-F]{64}$/;
export const REQUEST_ID_RE = /^[a-zA-Z0-9_-]{1,96}$/;
export const DIAGRAM_ID_RE = /^diagram:.{1,120}$/s;
export const PORTABLE_ASSET_NAME_RE = /^(?:assets\/)?[A-Za-z0-9._-]+$/;
export const ASSET_MIME_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/svg+xml"] as const;
export const EXPORT_FORMATS = ["pdf", "smd", "md", "mdzip"] as const;
export const CREATE_SAVE_FORMATS = ["md", "smd"] as const;
export const IMAGE_FORMATS = ["png", "jpeg"] as const;
export const IMAGE_QUALITIES = ["standard", "high"] as const;
export const SEARCH_BOOLEAN_FLAGS = ["caseSensitive", "wholeWord", "regex", "excludeDiagrams"] as const;
export const MAX_TEXT_BYTES = 64 * 1024;
export const MAX_ASSET_BYTES = 1024 * 1024;
export const MAX_ASSET_BASE64_CHARS = 1_400_000;
export const MAX_RELAY_OPTIONS_BYTES = 16 * 1024;
export const MAX_RPC_QUERY_BYTES = 2048;
export const MAX_HEADING_BYTES = 512;

function validPortableAssetBasename(value: string, maxLength: number): boolean {
  if (!PORTABLE_ASSET_NAME_RE.test(value)) return false;
  const basename = value.startsWith("assets/") ? value.slice(7) : value;
  return basename.length >= 1 && basename.length <= maxLength && basename !== "." && basename !== "..";
}

export function isValidPortableAssetName(value: string): boolean {
  return validPortableAssetBasename(value, 150);
}

export function isValidCompatPortableAssetName(value: string): boolean {
  return validPortableAssetBasename(value, 159);
}

export const requestIdSchema = z.string().max(96).regex(REQUEST_ID_RE);
export const deviceIdSchema = z.string().regex(UUID_RE);
export const deviceIdField = deviceIdSchema.optional();
export const tabIdField = z.string().min(1).max(512);
export const optionalTabIdField = tabIdField.optional();
export const expectedRevisionField = z.string().regex(REVISION_RE);
export const optionalExpectedRevisionField = expectedRevisionField.optional();
export const wireRevisionSchema = z.string().regex(WIRE_REVISION_RE);
export const headingIndexField = z.number().int().min(0);
export const headingField = z.union([headingIndexField, z.string().min(1).max(MAX_HEADING_BYTES)]).optional();
export const documentViewSchema = z.enum(["source", "prose"]);
export const documentViewField = documentViewSchema.optional();
export const textOffsetSchema = z.number().int().min(0).max(20_000_000);
export const textOffsetField = textOffsetSchema.optional();
export const assetOffsetSchema = z.number().int().min(0).max(MAX_ASSET_BYTES);
export const assetOffsetField = assetOffsetSchema.optional();
export const textLimitSchema = z.number().int().min(1).max(12_000);
export const textLimitField = textLimitSchema.optional();
export const diagramListLimitSchema = z.number().int().min(1).max(80);
export const assetListOffsetSchema = z.number().int().min(0).max(512);
export const assetListLimitSchema = z.number().int().min(1).max(50);
export const searchQueryField = z.string().min(1).max(500);
export const searchLimitSchema = z.number().int().min(1).max(25);
export const searchLimitField = searchLimitSchema.optional();
export const searchContextSchema = z.number().int().min(0).max(500);
export const searchContextField = searchContextSchema.optional();
export const viewportWidthSchema = z.number().int().min(64).max(1600);
export const viewportWidthField = viewportWidthSchema.optional();
export const rpcViewportWidthSchema = z.number().int().min(1).max(1600);
export const imageFormatSchema = z.enum(IMAGE_FORMATS);
export const imageQualityField = z.enum(IMAGE_QUALITIES).optional();
export const diagramIdSchema = z.string().min(9).max(128).regex(DIAGRAM_ID_RE);
export const diagramIdField = diagramIdSchema.optional();
export const jobIdSchema = z.string().min(1).max(128);
export const windowIdSchema = z.string().min(1).max(128);
export const assetIdSchema = z.string().min(1).max(512);
export const assetNameField = z.string().min(1).max(256);
export const optionalAssetNameField = assetNameField.optional();
export const assetPathField = z.string().min(1).max(4096);
export const assetMimeTypeSchema = z.enum(ASSET_MIME_TYPES);
export const assetMimeTypeField = assetMimeTypeSchema.optional();
export const assetBodyField = z.string().max(MAX_ASSET_BASE64_CHARS).describe("Base64-encoded original bytes, including UTF-8 SVG; not raw SVG text or a data URL").optional();
export const exportFormatSchema = z.enum(EXPORT_FORMATS);
export const exportFormatField = exportFormatSchema.optional();
export const createSaveFormatSchema = z.enum(CREATE_SAVE_FORMATS);
export const repairIndicesSchema = z.array(z.number().int().min(0)).min(1).max(40);
export const documentContentField = z.string().max(60_000).optional();
export const pageSizeSchema = z.enum(["a3", "a4", "a5", "a6", "iso-b4", "iso-b5", "iso-b6", "letter", "legal", "tabloid", "executive"]);
export const exportOptionsSchema = z.object({
  pageSize: pageSizeSchema.optional(), margin: z.number().min(4).max(60).optional(), fontSize: z.number().min(5).max(24).optional(),
  lineHeight: z.number().min(0.9).max(2.2).optional(), paragraphSpacing: z.number().min(0).max(3).optional(),
  fontFamily: z.string().max(128).optional(), pageNumbers: z.boolean().optional(), themed: z.boolean().optional(),
});
export const patchOperationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("replace"), old: z.string().min(1), new: z.string(), count: z.union([z.literal(1), z.literal("all")]).optional(), expectedCount: z.number().int().positive().optional() }).strict(),
  z.object({ type: z.literal("lines"), start_line: z.number().int().positive().describe("First line, 1-based inclusive"), end_line: z.number().int().positive().describe("Last line, 1-based inclusive"), text: z.string() }).strict(),
  z.object({ type: z.literal("insert"), line: z.number().int().positive().describe("Insert before this 1-based line; line count + 1 appends"), text: z.string() }).strict(),
]);
export const patchOperationsField = z.array(patchOperationSchema).min(1).max(100);
export const documentOptionsField = exportOptionsSchema.extend({
  section: headingField, offset: textOffsetField, background: z.boolean().optional(),
  saveAs: z.boolean().optional(), discardChanges: z.boolean().optional(), archive: z.boolean().optional(), title: z.string().max(160).optional(),
  format: exportFormatField, repairIndices: repairIndicesSchema.optional(),
  filename: z.string().max(256).optional(), jobId: jobIdSchema.optional(), limit: textLimitField,
  width: viewportWidthField, quality: imageQualityField,
}).optional();

export const TOOL_INPUT_SCHEMAS = Object.freeze({
  list_devices: z.object({}),
  list_tabs: z.object({ deviceId: deviceIdField }),
  read_tab: z.object({ deviceId: deviceIdField, tabId: optionalTabIdField, heading: headingField, view: documentViewField, offset: textOffsetField, limit: textLimitField }),
  search_tab: z.object({ deviceId: deviceIdField, tabId: tabIdField, query: searchQueryField, offset: textOffsetField, limit: searchLimitField, context: searchContextField, caseSensitive: z.boolean().optional(), wholeWord: z.boolean().optional(), regex: z.boolean().optional(), excludeDiagrams: z.boolean().optional() }),
  patch_tab: z.object({ deviceId: deviceIdField, tabId: tabIdField, expectedRevision: expectedRevisionField, operations: patchOperationsField }),
  render_tab: z.object({ deviceId: deviceIdField, tabId: tabIdField, width: viewportWidthField, quality: imageQualityField }),
  view_current: z.object({ deviceId: deviceIdField, tabId: optionalTabIdField, width: viewportWidthField, quality: imageQualityField, includeImage: z.boolean().optional() }),
  diagram_action: z.object({ deviceId: deviceIdField, tabId: tabIdField, diagramAction: z.enum(["list", "source", "image"]), diagramId: diagramIdField, expectedRevision: optionalExpectedRevisionField, offset: textOffsetField, limit: textLimitField, width: viewportWidthField, quality: imageQualityField }),
  replace_tab_asset: z.object({ deviceId: deviceIdField, tabId: tabIdField, assetName: assetNameField, assetPath: assetPathField, expectedRevision: expectedRevisionField }),
  asset_action: z.object({ deviceId: deviceIdField, tabId: tabIdField, assetAction: z.enum(["list", "source", "attach"]), assetName: optionalAssetNameField, mimeType: assetMimeTypeField, body: assetBodyField, offset: assetOffsetField, limit: textLimitField, expectedRevision: expectedRevisionField }),
  document_action: z.object({ deviceId: deviceIdField, documentAction: z.enum(["get_context", "outline", "create", "export", "latexfix", "latex_review", "latex_apply", "open", "activate", "close", "save", "snapshot", "job_status"]), tabId: optionalTabIdField, expectedRevision: optionalExpectedRevisionField, content: documentContentField, options: documentOptionsField }),
});
