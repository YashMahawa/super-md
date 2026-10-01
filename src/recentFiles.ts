export interface RecentFile { path: string; name: string; openedAt: number }
export function rememberFile(recent: RecentFile[], path: string, now = Date.now()): RecentFile[] {
  return [{ path, name: path.split(/[\\/]/).pop() || path, openedAt: now }, ...recent.filter((file) => file.path !== path)].slice(0, 24);
}
export function readRecent(storage: Pick<Storage, "getItem">): RecentFile[] {
  try { const list: unknown = JSON.parse(storage.getItem("recent.files") || "[]"); return Array.isArray(list) ? list.filter((item) => typeof item?.path === "string" && typeof item?.name === "string" && typeof item?.openedAt === "number").slice(0, 24) : []; } catch { return []; }
}
export function recordRecent(path: string) { try { localStorage.setItem("recent.files", JSON.stringify(rememberFile(readRecent(localStorage), path))); window.dispatchEvent(new Event("supermd-recents")); } catch { /* A full history store must not make a successful save appear to fail. */ } }
