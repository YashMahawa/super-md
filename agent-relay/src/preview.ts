import sharp from "sharp";

export const MAX_PREVIEW_INPUT_BYTES = 4 * 1024 * 1024;
export const MAX_PREVIEW_OUTPUT_BYTES = 3 * 1024 * 1024;
export const MAX_PREVIEW_PIXELS = 16_000_000;
export const MAX_ACTIVE_PREVIEWS = 2;
export const MAX_QUEUED_PREVIEWS = 4;

export type JpegPreview = { data: Buffer; width: number; height: number; sourceMimeType: "image/png" | "image/jpeg" };
export type ViewportContexts = {
  captureContext: Record<string, unknown>;
  capturedReadingContext?: Record<string, unknown>;
  hasCoherentCapturedSource: boolean;
};

let activePreviews = 0;
const previewQueue: Array<() => void> = [];

function acquirePreviewSlot(): Promise<() => void> {
  if (activePreviews < MAX_ACTIVE_PREVIEWS) {
    activePreviews++;
    return Promise.resolve(releasePreviewSlot);
  }
  if (previewQueue.length >= MAX_QUEUED_PREVIEWS) throw new Error("Viewport preview service is busy; retry shortly.");
  return new Promise((resolve) => previewQueue.push(() => resolve(releasePreviewSlot)));
}

function releasePreviewSlot(): void {
  const next = previewQueue.shift();
  if (next) next();
  else activePreviews--;
}

/** Read-only queue state, also useful for confirming bounded work under load. */
export function previewQueueState(): { active: number; queued: number } {
  return { active: activePreviews, queued: previewQueue.length };
}

export function decodeViewportBase64(value: unknown): Buffer {
  if (typeof value !== "string" || value.length < 4 || value.length > Math.ceil(MAX_PREVIEW_INPUT_BYTES * 4 / 3) + 4 || value.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("The viewport image is not bounded canonical base64.");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length < 8 || decoded.length > MAX_PREVIEW_INPUT_BYTES || decoded.toString("base64") !== value) throw new Error("The viewport image is not bounded canonical base64.");
  return decoded;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Repair old clients' prefix-relative pagination using their authoritative code-point sourceLength. */
export function normalizeReadingContext(value: unknown): Record<string, unknown> | undefined {
  const context = record(value);
  if (!context) return undefined;
  const sourceLength = context.sourceLength;
  const visibleSource = record(context.visibleSource);
  if (!Number.isSafeInteger(sourceLength) || (sourceLength as number) < 0 || !visibleSource) return context;
  const start = visibleSource.start;
  const end = visibleSource.end;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || (start as number) < 0 || (end as number) < (start as number) || (end as number) > (sourceLength as number)) return context;
  return {
    ...context,
    visibleSource: {
      ...visibleSource,
      total_chars: sourceLength,
      next_offset: (end as number) < (sourceLength as number) ? end : null,
      truncated: (end as number) < (sourceLength as number),
    },
  };
}

function textField(value: unknown, limit: number): string | undefined {
  return typeof value === "string" ? value.slice(0, limit) : undefined;
}

function boundedReading(value: unknown): Record<string, unknown> | undefined {
  const source = record(value);
  if (!source) return undefined;
  const result: Record<string, unknown> = {};
  for (const key of ["offset", "scrollFraction"]) if (typeof source[key] === "number" && Number.isFinite(source[key])) result[key] = source[key];
  for (const key of ["heading", "visibleText"]) {
    const text = textField(source[key], key === "heading" ? 300 : 2000);
    if (text !== undefined) result[key] = text;
  }
  return result;
}

function boundedSelection(value: unknown): Record<string, unknown> | undefined {
  const source = record(value);
  if (!source) return undefined;
  const text = textField(source.text, 2000);
  return text === undefined ? {} : { text };
}

function boundedViewport(value: unknown): Record<string, unknown> | undefined {
  const source = record(value);
  if (!source) return undefined;
  const result: Record<string, unknown> = {};
  for (const key of ["x", "y", "width", "height", "viewportWidth", "viewportHeight", "devicePixelRatio"]) {
    if (typeof source[key] === "number" && Number.isFinite(source[key])) result[key] = source[key];
  }
  return result;
}

function boundedSource(value: unknown): { value?: Record<string, unknown>; range?: Record<string, unknown> } {
  const source = record(value);
  if (!source || typeof source.text !== "string") return {};
  const characters = Array.from(source.text);
  const returned = characters.slice(0, 12_000);
  const previewTruncated = characters.length > returned.length;
  const result: Record<string, unknown> = { text: returned.join("") };
  const range: Record<string, unknown> = {};
  if (previewTruncated) { result.previewTruncated = true; range.previewTruncated = true; }
  const start = typeof source.start === "number" && Number.isSafeInteger(source.start) ? source.start : undefined;
  for (const [target, key] of [["start", "start"], ["end", "end"], ["total_chars", "total_chars"], ["next_offset", "next_offset"], ["truncated", "truncated"], ["view", "view"]] as const) {
    const alternate = target === "total_chars" ? source.totalChars : target === "next_offset" ? source.nextOffset : undefined;
    const field = Object.hasOwn(source, key) ? source[key] : alternate;
    if (target === "end" && previewTruncated) {
      if (start !== undefined) { result.end = start + returned.length; range.end = result.end; }
    } else if (target === "next_offset" && previewTruncated) {
      if (start !== undefined) { result.next_offset = start + returned.length; range.next_offset = result.next_offset; }
    } else if (target === "truncated" && previewTruncated) {
      result.truncated = true;
      range.truncated = true;
    } else if ((typeof field === "number" && Number.isSafeInteger(field)) || typeof field === "boolean" || (target === "next_offset" && field === null) || (target === "view" && typeof field === "string")) {
      result[target] = field;
      range[target] = field;
    }
  }
  return { value: result, range: Object.keys(range).length ? range : undefined };
}

function boundedDiagrams(value: unknown): unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.slice(0, 30).flatMap((item) => {
    const source = record(item);
    if (!source) return [];
    const result: Record<string, unknown> = {};
    for (const key of ["id", "kind"]) {
      const text = textField(source[key], 128);
      if (text !== undefined) result[key] = text;
    }
    for (const key of ["sourceStart", "sourceEnd", "sourceChars"]) {
      if (typeof source[key] === "number" && Number.isSafeInteger(source[key])) result[key] = source[key];
    }
    const preview = textField(source.preview, 160);
    if (preview !== undefined) result.preview = preview;
    const assetReference = textField(source.assetReference, 512);
    if (assetReference !== undefined && !/^data:/i.test(assetReference) && !/base64,/i.test(assetReference)) result.assetReference = assetReference;
    return [result];
  });
}

/** Extract bounded image-time context. Desktop captures can include source; Android metadata includes position only. */
export function viewportContexts(image: Record<string, unknown>, requestedTab: string, expectedRevision: string): ViewportContexts {
  const nested = record(image.context);
  const metadata = record(image.metadata);
  const source = nested ?? image;
  const rawTabId = typeof source.tabId === "string" && source.tabId ? source.tabId : typeof metadata?.tabId === "string" ? metadata.tabId : undefined;
  const revisionMatches = typeof source.revision !== "string" || source.revision === expectedRevision;
  const mode = textField(source.mode ?? metadata?.mode, 64);
  const zoomValue = source.zoom ?? metadata?.zoom;
  const zoom = typeof zoomValue === "number" && Number.isFinite(zoomValue) ? zoomValue : undefined;
  const reading = boundedReading(source.reading ?? metadata?.reading);
  const selection = boundedSelection(source.selection ?? metadata?.selection);
  const viewport = boundedViewport(source.viewport ?? metadata?.viewport);
  const sourceLength = Number.isSafeInteger(source.sourceLength) && (source.sourceLength as number) >= 0 ? source.sourceLength as number : undefined;
  const normalizedSource = sourceLength === undefined ? source.visibleSource : normalizeReadingContext({ sourceLength, visibleSource: source.visibleSource })?.visibleSource;
  const { value: visibleSource, range: sourceRange } = boundedSource(normalizedSource);
  const diagrams = boundedDiagrams(source.diagrams);
  const captureContext: Record<string, unknown> = { tabId: requestedTab, revision: expectedRevision };
  if (rawTabId && rawTabId !== requestedTab) captureContext.nativeTabId = rawTabId;
  captureContext.contextRevisionMatches = revisionMatches;
  if (typeof source.revision === "string" && source.revision !== expectedRevision) captureContext.contextRevision = source.revision;
  if (mode !== undefined) captureContext.mode = mode;
  if (zoom !== undefined) captureContext.zoom = zoom;
  if (reading) captureContext.reading = reading;
  if (selection) captureContext.selection = selection;
  if (viewport) captureContext.viewport = viewport;
  if (sourceRange) captureContext.sourceRange = sourceRange;
  const hasCoherentCapturedSource = revisionMatches && !!visibleSource && visibleSource.previewTruncated !== true && typeof source.revision === "string" && source.revision === expectedRevision;
  let capturedReadingContext: Record<string, unknown> | undefined;
  if (hasCoherentCapturedSource) {
    capturedReadingContext = { ...captureContext, visibleSource };
    if (sourceLength !== undefined) capturedReadingContext.sourceLength = sourceLength;
    if (diagrams) capturedReadingContext.diagrams = diagrams;
  }
  return { captureContext, capturedReadingContext, hasCoherentCapturedSource };
}

/** Validate a bounded viewport capture and produce or preserve its compact JPEG model preview. */
export async function makeJpegPreview(
  input: Buffer,
  maxEdge: number,
  sourceMimeType: "image/png" | "image/jpeg" = "image/png",
  reportedDimensions?: { width: unknown; height: unknown },
): Promise<JpegPreview> {
  if (!Number.isInteger(maxEdge) || maxEdge < 64 || maxEdge > 1600) throw new Error("Preview width must be between 64 and 1600 pixels.");
  if (input.length < 8 || input.length > MAX_PREVIEW_INPUT_BYTES) throw new Error("The viewport preview input exceeds its size limit.");
  const pngSignature = input.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpegSignature = input.length >= 3 && input[0] === 0xff && input[1] === 0xd8 && input[2] === 0xff;
  if ((sourceMimeType === "image/png" && !pngSignature) || (sourceMimeType === "image/jpeg" && !jpegSignature)) {
    throw new Error("The viewport preview MIME type does not match its image bytes.");
  }
  const release = await acquirePreviewSlot();
  try {
    const image = sharp(input, { failOn: "error", limitInputPixels: MAX_PREVIEW_PIXELS });
    const metadata = await image.metadata();
    const expectedFormat = sourceMimeType === "image/png" ? "png" : "jpeg";
    if (metadata.format !== expectedFormat || !metadata.width || !metadata.height || metadata.width * metadata.height > MAX_PREVIEW_PIXELS) {
      throw new Error("The viewport capture image has invalid or excessive dimensions.");
    }
    if ((reportedDimensions && (!Number.isInteger(reportedDimensions.width) || !Number.isInteger(reportedDimensions.height) || reportedDimensions.width !== metadata.width || reportedDimensions.height !== metadata.height))) {
      throw new Error("The viewport image dimensions do not match the capture metadata.");
    }
    if (sourceMimeType === "image/jpeg" && Math.max(metadata.width, metadata.height) <= maxEdge && input.length <= MAX_PREVIEW_OUTPUT_BYTES) {
      return { data: input, width: metadata.width, height: metadata.height, sourceMimeType };
    }
    const result = await image
      .resize({ width: maxEdge, height: maxEdge, fit: "inside", withoutEnlargement: true, kernel: "lanczos3" })
      .jpeg({ quality: 90, mozjpeg: false, chromaSubsampling: "4:4:4" })
      .toBuffer({ resolveWithObject: true });
    if (result.data.length < 4 || result.data.length > MAX_PREVIEW_OUTPUT_BYTES || !result.data.subarray(0, 2).equals(Buffer.from([0xff, 0xd8]))) {
      throw new Error("The encoded viewport preview exceeds its size limit or is not a valid JPEG.");
    }
    if (result.info.format !== "jpeg" || result.info.width < 1 || result.info.height < 1 || Math.max(result.info.width, result.info.height) > maxEdge) {
      throw new Error("The encoded viewport preview has invalid dimensions.");
    }
    return { data: result.data, width: result.info.width, height: result.info.height, sourceMimeType };
  } finally {
    release();
  }
}
