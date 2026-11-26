import { mediaAt } from "./mediaExport";

export interface RemoteImageConsentPolicy {
  trustedImageHosts?: readonly string[];
  approvedImageUrls?: Iterable<string>;
  loadedImageData?: ReadonlyMap<string, string> | Record<string, string>;
}

export function remoteImageHost(url: string): string | null {
  if (!/^https?:\/\//i.test(url)) return null;
  try {
    const parsed = new URL(url);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      !parsed.username &&
      !parsed.password &&
      parsed.host
      ? parsed.host.toLowerCase()
      : null;
  } catch {
    return null;
  }
}

export function isRemoteOrExplicitScheme(source: string): boolean {
  return /^(?:https?:|\/\/|[a-z][a-z\d+.-]+:)/i.test(source.trim());
}

export function normalizeTrustedImageHosts(hosts?: readonly string[]): Set<string> {
  const result = new Set<string>();
  if (!hosts) return result;
  for (const host of hosts) {
    const normalized = host.trim().toLowerCase();
    if (normalized) result.add(normalized);
  }
  return result;
}

export function normalizeApprovedImageUrls(urls?: Iterable<string>): Set<string> {
  const result = new Set<string>();
  if (!urls) return result;
  for (const url of urls) {
    if (remoteImageHost(url)) result.add(url);
  }
  return result;
}

function cachedNoteImageData(
  source: string,
  loadedImageData?: ReadonlyMap<string, string> | Record<string, string>,
): string | null {
  if (!loadedImageData) return null;
  const value =
    loadedImageData instanceof Map
      ? loadedImageData.get(source)
      : typeof (loadedImageData as ReadonlyMap<string, string>).get === "function"
        ? (loadedImageData as ReadonlyMap<string, string>).get(source)
        : (loadedImageData as Record<string, string>)[source];
  return typeof value === "string" && /^data:image\//i.test(value) ? value : null;
}

export function loadedReaderImageData(
  source: string,
  loadedImageData?: ReadonlyMap<string, string> | Record<string, string>,
  trustedHosts?: ReadonlySet<string>,
  approvedUrls?: ReadonlySet<string>,
): string | null {
  if (/^https?:/i.test(source) && !remoteImageHost(source)) return null;
  if (typeof document !== "undefined") {
    for (const element of document.querySelectorAll<HTMLElement>("[data-note-image-source]")) {
      if (element.dataset.noteImageSource !== source) continue;
      const uri = mediaAt(element.querySelector("img"))?.uri?.();
      if (uri && /^data:image\//i.test(uri)) return uri;
    }
  }
  if (
    loadedImageData &&
    trustedHosts &&
    approvedUrls &&
    isRemoteImageApproved(source, trustedHosts, approvedUrls)
  ) {
    return cachedNoteImageData(source, loadedImageData);
  }
  return null;
}

export function isRemoteImageApproved(
  source: string,
  trustedHosts: ReadonlySet<string>,
  approvedUrls: ReadonlySet<string>,
): boolean {
  const host = remoteImageHost(source);
  return host !== null && (approvedUrls.has(source) || trustedHosts.has(host));
}

interface NoteConsentEntry {
  approvedUrls: Set<string>;
  loadedData: Map<string, string>;
  bytes: number;
}

const EMPTY_APPROVED_URLS: string[] = [];
const MAX_NOTES = 40;
const MAX_URLS_PER_NOTE = 128;
const MAX_CACHED_BYTES = 32_000_000;

export class NoteRemoteImageConsentStore {
  private readonly notes = new Map<string, NoteConsentEntry>();
  private totalBytes = 0;

  private ensure(noteId: string): NoteConsentEntry {
    let entry = this.notes.get(noteId);
    if (entry) {
      this.notes.delete(noteId);
      this.notes.set(noteId, entry);
      return entry;
    }
    entry = { approvedUrls: new Set(), loadedData: new Map(), bytes: 0 };
    this.notes.set(noteId, entry);
    while (this.notes.size > MAX_NOTES) {
      const oldest = this.notes.keys().next().value;
      if (oldest === undefined || oldest === noteId) break;
      this.delete(oldest);
    }
    return entry;
  }

  approve(noteId: string, url: string): boolean {
    if (!noteId || !remoteImageHost(url)) return false;
    const entry = this.ensure(noteId);
    if (entry.approvedUrls.has(url)) return false;
    if (entry.approvedUrls.size >= MAX_URLS_PER_NOTE) {
      const oldest = entry.approvedUrls.values().next().value;
      if (oldest !== undefined) entry.approvedUrls.delete(oldest);
    }
    entry.approvedUrls.add(url);
    return true;
  }

  recordLoaded(noteId: string, url: string, data: string): void {
    if (!noteId || !remoteImageHost(url) || !/^data:image\//i.test(data) || data.length > MAX_CACHED_BYTES) return;
    const entry = this.ensure(noteId);
    const previous = entry.loadedData.get(url);
    if (previous !== undefined) {
      entry.bytes -= previous.length;
      this.totalBytes -= previous.length;
      entry.loadedData.delete(url);
    }
    entry.loadedData.set(url, data);
    entry.bytes += data.length;
    this.totalBytes += data.length;
    while (this.totalBytes > MAX_CACHED_BYTES) {
      let evicted = false;
      for (const [id, candidate] of this.notes) {
        const firstUrl = candidate.loadedData.keys().next().value;
        if (firstUrl === undefined) continue;
        if (id === noteId && firstUrl === url && candidate.loadedData.size === 1) continue;
        const removed = candidate.loadedData.get(firstUrl)!;
        candidate.loadedData.delete(firstUrl);
        candidate.bytes -= removed.length;
        this.totalBytes -= removed.length;
        evicted = true;
        break;
      }
      if (!evicted) break;
    }
  }

  approvedUrls(noteId: string | null | undefined): string[] {
    if (!noteId) return EMPTY_APPROVED_URLS;
    const entry = this.notes.get(noteId);
    return entry && entry.approvedUrls.size > 0 ? Array.from(entry.approvedUrls) : EMPTY_APPROVED_URLS;
  }

  policy(noteId: string | null | undefined, trustedImageHosts: readonly string[]): RemoteImageConsentPolicy {
    const entry = noteId ? this.notes.get(noteId) : undefined;
    return {
      trustedImageHosts,
      ...(entry && entry.approvedUrls.size > 0 ? { approvedImageUrls: Array.from(entry.approvedUrls) } : {}),
      ...(entry && entry.loadedData.size > 0 ? { loadedImageData: new Map(entry.loadedData) } : {}),
    };
  }

  delete(noteId: string): void {
    const entry = this.notes.get(noteId);
    if (!entry) return;
    this.totalBytes -= entry.bytes;
    this.notes.delete(noteId);
  }

  retainOnly(activeIds: Iterable<string>): void {
    const keep = new Set(activeIds);
    for (const id of Array.from(this.notes.keys())) {
      if (!keep.has(id)) this.delete(id);
    }
  }
}
