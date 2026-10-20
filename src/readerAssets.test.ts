import { afterEach, describe, expect, it, vi } from "vitest";

const { nativeInvoke } = vi.hoisted(() => ({ nativeInvoke: vi.fn() }));
vi.mock("./nativeBridge", () => ({ invoke: nativeInvoke }));
import { approvedReaderRasterUrl, resolveReaderRasterAsset } from "./readerAssets";

const TOKEN = "0123456789abcdef0123456789abcdef";
const FINGERPRINT = "a".repeat(64);
const URL = `https://appassets.androidplatform.net/reader-assets/${TOKEN}?v=${FINGERPRINT}`;
const QT_URL = `supermdasset://${TOKEN}?v=${FINGERPRINT}`;
const response = (url: unknown = URL, mime: unknown = "image/png") => ({ url, mime });

afterEach(() => { nativeInvoke.mockReset(); vi.unstubAllGlobals(); });

describe("Android streamed reader assets", () => {
  it("accepts only exact, fingerprinted reader capability URLs and raster MIME", () => {
    expect(approvedReaderRasterUrl(response())).toBe(URL);
    expect(approvedReaderRasterUrl(response(URL, "image/SVG+xml"))).toBeNull();
    expect(approvedReaderRasterUrl(response(URL, "text/html"))).toBeNull();
    expect(approvedReaderRasterUrl(response(URL, "image/png; charset=utf-8"))).toBeNull();
    expect(approvedReaderRasterUrl({ url: null, mime: "image/png" })).toBeNull();
  });

  it("accepts Qt capabilities only in the desktop native bridge", () => {
    vi.stubGlobal("window", { SuperMD: { post: vi.fn() } });
    expect(approvedReaderRasterUrl(response(QT_URL))).toBe(QT_URL);
    expect(approvedReaderRasterUrl(response(QT_URL, "image/svg+xml"))).toBeNull();
    expect(approvedReaderRasterUrl(response(`supermdasset://${TOKEN}/file?v=${FINGERPRINT}`))).toBeNull();
    expect(approvedReaderRasterUrl(response(`supermdasset://${TOKEN}?v=${FINGERPRINT}&x=1`))).toBeNull();
    vi.stubGlobal("window", {});
    expect(approvedReaderRasterUrl(response(QT_URL))).toBeNull();
  });

  it.each([
    "http://appassets.androidplatform.net/reader-assets/" + TOKEN + "?v=" + FINGERPRINT,
    "https://evil.example/reader-assets/" + TOKEN + "?v=" + FINGERPRINT,
    "https://appassets.androidplatform.net:8443/reader-assets/" + TOKEN + "?v=" + FINGERPRINT,
    "https://appassets.androidplatform.net/assets/" + TOKEN + "?v=" + FINGERPRINT,
    "https://appassets.androidplatform.net/reader-assets/../assets/" + TOKEN + "?v=" + FINGERPRINT,
    "https://appassets.androidplatform.net/reader-assets/" + TOKEN + "?v=" + FINGERPRINT + "&x=1",
    "https://appassets.androidplatform.net/reader-assets/" + TOKEN + "?v=" + FINGERPRINT + "#fragment",
    "https://user@appassets.androidplatform.net/reader-assets/" + TOKEN + "?v=" + FINGERPRINT,
  ])("rejects an unapproved endpoint: %s", (url) => {
    expect(approvedReaderRasterUrl(response(url))).toBeNull();
  });

  it("deduplicates concurrent native resolution for the same document and source", async () => {
    let finish!: (value: unknown) => void;
    nativeInvoke.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const first = resolveReaderRasterAsset("/notes/a.md", "images/a.png");
    const second = resolveReaderRasterAsset("/notes/a.md", "images/a.png");
    await Promise.resolve();
    expect(nativeInvoke).toHaveBeenCalledTimes(1);
    expect(nativeInvoke).toHaveBeenCalledWith("resolve_reader_asset", { documentPath: "/notes/a.md", source: "images/a.png" });
    finish(response());
    await expect(Promise.all([first, second])).resolves.toEqual([URL, URL]);
  });

  it("keeps document/source scoping distinct", async () => {
    nativeInvoke.mockResolvedValue(response());
    await Promise.all([
      resolveReaderRasterAsset("/notes/a.md", "images/a.png"),
      resolveReaderRasterAsset("/notes/b.md", "images/a.png"),
      resolveReaderRasterAsset("/notes/a.md", "images/b.png"),
    ]);
    expect(nativeInvoke).toHaveBeenCalledTimes(3);
  });

  it("falls back on unsupported, malformed, or unavailable native responses", async () => {
    nativeInvoke.mockResolvedValueOnce(response(URL, "image/svg+xml"));
    nativeInvoke.mockResolvedValueOnce({ url: "https://evil.example/image.png", mime: "image/png" });
    nativeInvoke.mockRejectedValueOnce(new Error("unsupported"));
    await expect(resolveReaderRasterAsset("/notes/a.md", "images/a.svg")).resolves.toBeNull();
    await expect(resolveReaderRasterAsset("/notes/a.md", "images/a.png")).resolves.toBeNull();
    await expect(resolveReaderRasterAsset("/notes/a.md", "images/a.webp")).resolves.toBeNull();
    await expect(resolveReaderRasterAsset("", "assets/import-image.png")).resolves.toBeNull();
    expect(nativeInvoke).toHaveBeenCalledTimes(3);
  });
});
