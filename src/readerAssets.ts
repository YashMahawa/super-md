import { invoke } from "./nativeBridge";

const READER_ASSET_ORIGIN = "https://appassets.androidplatform.net";
const READER_ASSET_PATH = /^\/reader-assets\/[a-f0-9]{32}$/;
const QT_READER_ASSET_TOKEN = /^[a-f0-9]{32}$/;
const FINGERPRINT = /^[a-f0-9]{64}$/;
const RASTER_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
]);

type NativeReaderAsset = { url: unknown; mime: unknown };
const inFlight = new Map<string, Promise<string | null>>();

/** Accept only scoped, fingerprinted raster capabilities returned by native hosts. */
export function approvedReaderRasterUrl(value: NativeReaderAsset): string | null {
  if (typeof value?.url !== "string" || typeof value?.mime !== "string") return null;
  if (!RASTER_MIMES.has(value.mime.trim().toLowerCase())) return null;

  let url: URL;
  try {
    url = new URL(value.url);
  } catch {
    return null;
  }
  const fingerprints = url.searchParams.getAll("v");
  if (fingerprints.length !== 1 || !FINGERPRINT.test(fingerprints[0]) || [...url.searchParams.keys()].length !== 1) return null;
  if (url.protocol === "supermdasset:") {
    if (!window.SuperMD || !QT_READER_ASSET_TOKEN.test(url.hostname) || url.pathname !== "" ||
        url.username || url.password || url.port || url.hash || url.href !== value.url) return null;
    return url.href;
  }
  if (
    url.origin !== READER_ASSET_ORIGIN ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    !READER_ASSET_PATH.test(url.pathname)
  ) return null;

  if (url.href !== value.url) return null;
  return url.href;
}

/**
 * Resolve a local image to Android's streamed asset endpoint. `null` signals
 * the caller to use the legacy data-URL loader (for SVG and unsupported hosts).
 */
export function resolveReaderRasterAsset(documentPath: string, source: string): Promise<string | null> {
  if (!documentPath || !source) return Promise.resolve(null);
  const key = JSON.stringify([documentPath, source]);
  const existing = inFlight.get(key);
  if (existing) return existing;

  const request = Promise.resolve()
    .then(() => invoke<NativeReaderAsset>("resolve_reader_asset", { documentPath, source }))
    .then(approvedReaderRasterUrl)
    .catch(() => null)
    .finally(() => { if (inFlight.get(key) === request) inFlight.delete(key); });
  inFlight.set(key, request);
  return request;
}
