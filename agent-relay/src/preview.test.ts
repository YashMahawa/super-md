import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { makeJpegPreview, MAX_PREVIEW_OUTPUT_BYTES, MAX_ACTIVE_PREVIEWS, MAX_QUEUED_PREVIEWS, normalizeReadingContext, previewQueueState, viewportContexts } from "./preview.js";

test("reading context restores full-source pagination from the authoritative code-point length", () => {
  const legacy = {
    sourceLength: 1_431_884,
    visibleSource: { text: "a猫🙂", start: 1_019_045, end: 1_019_048, total_chars: 1_019_048, next_offset: null, truncated: false },
    selection: { text: "🙂" },
  };
  const normalized = normalizeReadingContext(legacy)!;
  assert.deepEqual(normalized.visibleSource, { text: "a猫🙂", start: 1_019_045, end: 1_019_048, total_chars: 1_431_884, next_offset: 1_019_048, truncated: true });
  assert.equal(normalized.selection, legacy.selection, "selection is preserved exactly");
  assert.equal((normalized.visibleSource as Record<string, unknown>).text, legacy.visibleSource.text, "Unicode source text is untouched");

  const atEof = normalizeReadingContext({ sourceLength: 3, visibleSource: { text: "猫🙂", start: 1, end: 3, total_chars: 3, next_offset: 3, truncated: true } })!;
  assert.deepEqual(atEof.visibleSource, { text: "猫🙂", start: 1, end: 3, total_chars: 3, next_offset: null, truncated: false });
  const unknownLength = { visibleSource: { text: "x", start: 0, end: 1, total_chars: 1, next_offset: null, truncated: false } };
  assert.equal(normalizeReadingContext(unknownLength), unknownLength, "pagination is not guessed when sourceLength is absent");
  const invalidLength = { sourceLength: Number.MAX_SAFE_INTEGER + 1, visibleSource: { text: "x", start: 0, end: 1, total_chars: 1, next_offset: null, truncated: false } };
  assert.equal(normalizeReadingContext(invalidLength), invalidLength, "unsafe source lengths are not used");
  const inconsistentRange = { sourceLength: 4, visibleSource: { text: "x", start: 0, end: 5, total_chars: 5, next_offset: null, truncated: false } };
  assert.equal(normalizeReadingContext(inconsistentRange), inconsistentRange, "inconsistent ranges are left intact rather than invented");
});

test("JPEG previews downscale to the requested longest edge without upscaling", async () => {
  const png = await sharp({ create: { width: 1600, height: 900, channels: 3, background: { r: 20, g: 90, b: 170 } } }).png().toBuffer();
  const preview = await makeJpegPreview(png, 800);
  assert.equal(preview.width, 800);
  assert.equal(preview.height, 450);
  assert.equal(preview.sourceMimeType, "image/png");
  assert.ok(preview.data.length > 4 && preview.data.length <= MAX_PREVIEW_OUTPUT_BYTES);
  assert.deepEqual([...preview.data.subarray(0, 2)], [0xff, 0xd8]);

  const smallPng = await sharp({ create: { width: 320, height: 200, channels: 3, background: { r: 170, g: 90, b: 20 } } }).png().toBuffer();
  const small = await makeJpegPreview(smallPng, 1000);
  assert.equal(small.width, 320);
  assert.equal(small.height, 200);

  const jpeg = await sharp(png).resize({ width: 800, height: 800, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 90, mozjpeg: false, chromaSubsampling: "4:4:4" }).toBuffer();
  const preserved = await makeJpegPreview(jpeg, 800, "image/jpeg", { width: 800, height: 450 });
  assert.deepEqual(preserved.data, jpeg, "an in-bounds native JPEG is passed through without a second lossy encode");
  const smaller = await makeJpegPreview(jpeg, 400, "image/jpeg", { width: 800, height: 450 });
  assert.equal(smaller.width, 400);
  assert.equal(smaller.height, 225);
  await assert.rejects(makeJpegPreview(png, 800, "image/jpeg"), /MIME type does not match/);
  await assert.rejects(makeJpegPreview(jpeg, 800, "image/jpeg", { width: 799, height: 450 }), /dimensions do not match/);
});

test("JPEG preview rejects invalid headers and unsupported output bounds", async () => {
  await assert.rejects(makeJpegPreview(Buffer.from("not a PNG"), 800), /MIME type does not match/);
  await assert.rejects(makeJpegPreview(Buffer.from("not a PNG"), 63), /between 64 and 1600/);
});

test("preview conversion bounds active work and queue, then recovers after saturation", async () => {
  const png = await sharp({ create: { width: 1600, height: 900, channels: 3, background: { r: 20, g: 90, b: 170 } } }).png().toBuffer();
  const tasks = Array.from({ length: MAX_ACTIVE_PREVIEWS + MAX_QUEUED_PREVIEWS + 1 }, () => makeJpegPreview(png, 800));
  assert.deepEqual(previewQueueState(), { active: MAX_ACTIVE_PREVIEWS, queued: MAX_QUEUED_PREVIEWS });
  const settled = await Promise.allSettled(tasks);
  assert.equal(settled.filter((result) => result.status === "fulfilled").length, MAX_ACTIVE_PREVIEWS + MAX_QUEUED_PREVIEWS);
  const rejected = settled.find((result) => result.status === "rejected");
  assert.ok(rejected && rejected.status === "rejected");
  assert.match(String(rejected.reason), /service is busy/);
  assert.deepEqual(previewQueueState(), { active: 0, queued: 0 });
  const recovered = await makeJpegPreview(png, 800);
  assert.equal(recovered.width, 800);
  assert.deepEqual(previewQueueState(), { active: 0, queued: 0 });
});

test("capture context is bounded and only replaces reading source at the matching revision", () => {
  const revision = "b".repeat(64);
  const source = { text: "x".repeat(10_000), start: 100, end: 10_100, total_chars: 20_000, next_offset: 10_100 };
  const image = { tabId: "native-note", revision, reading: { offset: 100, visibleText: "v".repeat(10_000) }, selection: { text: "s".repeat(10_000) }, viewport: { x: 1, y: 2, width: 3, height: 4 }, visibleSource: source, diagrams: Array.from({ length: 50 }, (_, i) => ({ id: `diagram:${i}`, kind: "mermaid", sourceStart: i, preview: "p".repeat(1000), assetReference: i === 0 ? "assets/image-".repeat(50) : "data:image/png;base64,hidden" })) };
  const captured = viewportContexts(image, "window:desktop:note", revision);
  assert.equal(captured.hasCoherentCapturedSource, true);
  assert.equal(captured.capturedReadingContext?.visibleSource && (captured.capturedReadingContext.visibleSource as Record<string, unknown>).text, "x".repeat(10_000));
  assert.equal((captured.capturedReadingContext?.diagrams as unknown[]).length, 30);
  const firstDiagram = (captured.capturedReadingContext?.diagrams as Array<Record<string, unknown>>)[0];
  assert.equal(String(firstDiagram?.assetReference).length, 512);
  assert.equal((captured.capturedReadingContext?.diagrams as Array<Record<string, unknown>>)[1]?.assetReference, undefined, "embedded base64 is not copied into preview context");
  assert.equal(captured.captureContext.nativeTabId, "native-note");
  assert.ok(Buffer.byteLength(JSON.stringify(captured.captureContext)) < 12_000);

  const clipped = viewportContexts({ ...image, visibleSource: { ...source, text: "猫".repeat(13_000) } }, "window:desktop:note", revision);
  assert.equal(clipped.hasCoherentCapturedSource, false);
  const clippedSource = clipped.captureContext.sourceRange;
  assert.deepEqual(clippedSource, { previewTruncated: true, start: 100, end: 12_100, total_chars: 20_000, next_offset: 12_100, truncated: true });
  assert.equal(clipped.capturedReadingContext, undefined, "truncated captured text is not mistaken for a coherent exact source window");

  const mismatched = viewportContexts({ ...image, revision: "c".repeat(64) }, "window:desktop:note", revision);
  assert.equal(mismatched.hasCoherentCapturedSource, false);
  assert.equal(mismatched.capturedReadingContext, undefined);
  assert.equal(mismatched.captureContext.contextRevisionMatches, false);
});

test("desktop captured reading context retains sourceLength and corrected pagination", () => {
  const revision = "d".repeat(64);
  const captured = viewportContexts({
    tabId: "note",
    revision,
    sourceLength: 1_431_884,
    visibleSource: { text: "captured", start: 1_019_040, end: 1_019_048, total_chars: 1_019_048, next_offset: null, truncated: false },
  }, "window:desktop:note", revision);
  assert.equal(captured.capturedReadingContext?.sourceLength, 1_431_884);
  assert.deepEqual(captured.capturedReadingContext?.visibleSource, { text: "captured", start: 1_019_040, end: 1_019_048, total_chars: 1_431_884, next_offset: 1_019_048, truncated: true });
  assert.deepEqual(captured.captureContext.sourceRange, { start: 1_019_040, end: 1_019_048, total_chars: 1_431_884, next_offset: 1_019_048, truncated: true });
});
