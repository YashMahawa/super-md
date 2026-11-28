import { parseFrontmatter, type ParsedFrontmatter } from "./frontmatter";

export type SourceRange = { from: number; to: number };

const MAX_SOURCE_INDEX_HOSTS = 8;
export const SOURCE_CANDIDATE_SELECTOR = ".live-block,[data-windowed-block],[data-source-start],.code-container";
const SOURCE_INDEX_ATTR_FILTER = ["data-source-start", "data-source-end", "data-windowed-mounted", "data-windowed-block", "class"];

export interface SourceIndexEntry {
  el: HTMLElement;
  start: number;
  end: number;
  domOrder: number;
  subtreeEndDomOrder: number;
  isTopBlock: boolean;
  isOwnerCandidate: boolean;
  hasSourceStartAttr: boolean;
  prefixMaxEnd: number;
  maxAttrDomEl: HTMLElement | null;
}

export interface CachedOwnerSpans {
  visible: { start: number; end: number } | null;
  hidden: SourceRange[] | null;
}

export interface SourceRangeIndex {
  host: Element;
  entries: SourceIndexEntry[];
  byElement: WeakMap<HTMLElement, SourceIndexEntry>;
  ownerSpans: WeakMap<HTMLElement, CachedOwnerSpans>;
  lastContent: string | undefined;
  needsContentBounds: boolean;
  dirty: boolean;
  buildVersion: number;
  observer: MutationObserver | null;
  windowTarget: Element;
  onWindowChange: () => void;
  dispose: () => void;
}

const sourceRangeIndexCache = new Map<Element, SourceRangeIndex>();
let cachedFmContent: string | null = null, cachedFmResult: ParsedFrontmatter | null = null;

export function getParsedFrontmatter(content: string): ParsedFrontmatter | null {
  if (cachedFmContent !== content) { cachedFmContent = content; cachedFmResult = parseFrontmatter(content, { includeSpans: true }); }
  return cachedFmResult;
}

export function sourceBounds(el: Element, content?: string): { start: number; end: number } | null {
  if (!(el instanceof HTMLElement) || el.tagName === "TEXTAREA") return null;
  const attrStart = el.getAttribute("data-source-start"), attrEnd = el.getAttribute("data-source-end");
  if (attrStart !== null && attrEnd !== null) {
    const start = Number(attrStart), end = Number(attrEnd);
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) return { start, end };
  }
  if (content !== undefined && el.classList.contains("code-container")) {
    let regionStart = 0, ordinal = 0, regionEnd = content.length;
    for (let prev = el.previousElementSibling; prev; prev = prev.previousElementSibling) {
      const prevEnd = prev instanceof HTMLElement ? prev.getAttribute("data-source-end") : null;
      if (prevEnd !== null && Number.isFinite(Number(prevEnd))) { regionStart = Number(prevEnd); break; }
      if (prev instanceof HTMLElement && prev.classList.contains("code-container")) ordinal++;
    }
    if (regionStart === 0) { const fm = getParsedFrontmatter(content); if (fm) regionStart = fm.end; }
    for (let next = el.nextElementSibling; next; next = next.nextElementSibling) {
      const nextStart = next instanceof HTMLElement ? next.getAttribute("data-source-start") : null;
      if (nextStart !== null && Number.isFinite(Number(nextStart))) { regionEnd = Number(nextStart); break; }
    }
    if (regionEnd >= regionStart) {
      const slice = content.slice(regionStart, regionEnd), fencePattern = /^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n[ \t]*\1[ \t]*(?=\r?\n|$)/gm;
      let match: RegExpExecArray | null, seen = 0;
      while ((match = fencePattern.exec(slice))) {
        if (seen === ordinal) return { start: regionStart + match.index, end: regionStart + match.index + match[0].length };
        seen++;
      }
      return { start: regionStart, end: regionEnd };
    }
  }
  return null;
}

export function sourceBoundsForElement(el: Element, content?: string, sharedIndex?: SourceRangeIndex): { start: number; end: number } | null {
  if (el instanceof HTMLElement) {
    const index = sharedIndex ? refreshSourceRangeIndex(sharedIndex, content) : findAncestorSourceIndex(el, content);
    const entry = index?.byElement.get(el);
    if (entry) return { start: entry.start, end: entry.end };
  }
  return sourceBounds(el, content);
}

function upperBoundSourceStart(entries: SourceIndexEntry[], maxStart: number): number {
  let lo = 0, hi = entries.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (entries[mid].start <= maxStart) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

function hasSourceRelevantMutation(records: MutationRecord[]): boolean {
  for (let i = 0; i < records.length; i++) {
    const m = records[i];
    if (m.type === "childList" || m.attributeName !== "class") return true;
    if (!(m.target instanceof HTMLElement)) continue;
    const cur = m.target.getAttribute("class") ?? "", prev = m.oldValue ?? "";
    if (cur.includes("live-block") !== prev.includes("live-block") || cur.includes("code-container") !== prev.includes("code-container")) return true;
  }
  return false;
}

function rebuildSourceRangeIndex(record: SourceRangeIndex, content?: string): void {
  record.observer?.takeRecords();
  const candidates = record.host.querySelectorAll<HTMLElement>(SOURCE_CANDIDATE_SELECTOR);
  const entries: SourceIndexEntry[] = [], byElement = new WeakMap<HTMLElement, SourceIndexEntry>(), stack: SourceIndexEntry[] = [];
  let needsContentBounds = false, monotonic = true, prevStart = -Infinity;
  for (let k = 0; k < candidates.length; k++) {
    const el = candidates[k], hasSourceStartAttr = el.hasAttribute("data-source-start"), isCodeContainer = el.classList.contains("code-container");
    if (isCodeContainer && (!hasSourceStartAttr || !el.hasAttribute("data-source-end"))) needsContentBounds = true;
    const bounds = sourceBounds(el, content);
    if (!bounds) continue;
    const domOrder = entries.length;
    while (stack.length > 0 && !stack[stack.length - 1].el.contains(el)) stack.pop()!.subtreeEndDomOrder = domOrder - 1;
    if (bounds.start < prevStart) monotonic = false;
    prevStart = bounds.start;
    const entry: SourceIndexEntry = {
      el, start: bounds.start, end: bounds.end, domOrder, subtreeEndDomOrder: domOrder,
      isTopBlock: el.classList.contains("live-block") || el.hasAttribute("data-windowed-block"),
      isOwnerCandidate: hasSourceStartAttr || isCodeContainer,
      hasSourceStartAttr, prefixMaxEnd: bounds.end, maxAttrDomEl: null,
    };
    entries.push(entry); byElement.set(el, entry); stack.push(entry);
  }
  const lastDomOrder = entries.length - 1;
  while (stack.length > 0) stack.pop()!.subtreeEndDomOrder = lastDomOrder;
  if (!monotonic) entries.sort((a, b) => (a.start - b.start) || (a.domOrder - b.domOrder));
  let maxEnd = -Infinity, maxAttrOrder = -1, maxAttrEl: HTMLElement | null = null;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.end > maxEnd) maxEnd = e.end;
    e.prefixMaxEnd = maxEnd;
    if (e.hasSourceStartAttr && e.domOrder > maxAttrOrder) { maxAttrOrder = e.domOrder; maxAttrEl = e.el; }
    e.maxAttrDomEl = maxAttrEl;
  }
  record.entries = entries;
  record.byElement = byElement;
  record.ownerSpans = new WeakMap();
  record.lastContent = content;
  record.needsContentBounds = needsContentBounds;
  record.dirty = false;
  record.buildVersion++;
}

export function refreshSourceRangeIndex(record: SourceRangeIndex, content?: string): SourceRangeIndex {
  const nextWindowTarget = record.host.closest(".android-reading,.reading-scroll") ?? record.host;
  if (record.windowTarget !== nextWindowTarget) {
    record.windowTarget.removeEventListener("supermd-window-change", record.onWindowChange);
    record.windowTarget = nextWindowTarget;
    record.windowTarget.addEventListener("supermd-window-change", record.onWindowChange);
    record.dirty = true;
  }
  const pending = record.observer?.takeRecords();
  if (pending && pending.length > 0 && hasSourceRelevantMutation(pending)) record.dirty = true;
  if (content !== undefined && record.lastContent !== undefined && record.lastContent !== content) record.dirty = true;
  else if (record.needsContentBounds && content !== record.lastContent) record.dirty = true;
  if (record.dirty) rebuildSourceRangeIndex(record, content);
  else if (content !== undefined && record.lastContent === undefined) record.lastContent = content;
  return record;
}

export function findAncestorSourceIndex(el: Element, content?: string): SourceRangeIndex | undefined {
  for (let anc: Element | null = el; anc; anc = anc.parentElement) {
    const hit = sourceRangeIndexCache.get(anc);
    if (hit) return refreshSourceRangeIndex(hit, content);
  }
  return undefined;
}

export function invalidateSourceRangeIndex(host?: Element | null): void {
  if (host) { const rec = sourceRangeIndexCache.get(host); if (rec) rec.dirty = true; return; }
  for (const rec of sourceRangeIndexCache.values()) rec.dirty = true;
}

export function getSourceRangeIndex(host: Element, content?: string): SourceRangeIndex {
  const existing = sourceRangeIndexCache.get(host);
  if (existing) {
    sourceRangeIndexCache.delete(host);
    sourceRangeIndexCache.set(host, existing);
    return refreshSourceRangeIndex(existing, content);
  }
  for (const [cachedHost, cachedRec] of sourceRangeIndexCache) {
    if (!cachedHost.isConnected) { cachedRec.dispose(); sourceRangeIndexCache.delete(cachedHost); }
  }
  while (sourceRangeIndexCache.size >= MAX_SOURCE_INDEX_HOSTS) {
    const oldestKey = sourceRangeIndexCache.keys().next().value as Element | undefined;
    if (!oldestKey) break;
    sourceRangeIndexCache.get(oldestKey)?.dispose();
    sourceRangeIndexCache.delete(oldestKey);
  }
  const windowTarget = host.closest(".android-reading,.reading-scroll") ?? host;
  const created: SourceRangeIndex = {
    host, entries: [], byElement: new WeakMap(), ownerSpans: new WeakMap(),
    lastContent: content, needsContentBounds: false, dirty: true, buildVersion: 0, observer: null, windowTarget,
    onWindowChange: () => { created.dirty = true; },
    dispose: () => { created.observer?.disconnect(); created.windowTarget.removeEventListener("supermd-window-change", created.onWindowChange); },
  };
  if (typeof MutationObserver !== "undefined") {
    created.observer = new MutationObserver(records => { if (hasSourceRelevantMutation(records)) created.dirty = true; });
    created.observer.observe(host, { childList: true, subtree: true, attributes: true, attributeOldValue: true, attributeFilter: SOURCE_INDEX_ATTR_FILTER });
  }
  windowTarget.addEventListener("supermd-window-change", created.onWindowChange);
  rebuildSourceRangeIndex(created, content);
  sourceRangeIndexCache.set(host, created);
  return created;
}

export function findContainingBlockInIndex(index: SourceRangeIndex, range: SourceRange): HTMLElement | null {
  const { entries } = index, hi = upperBoundSourceStart(entries, range.from);
  if (hi < 0) return null;
  let bestTop: HTMLElement | null = null, bestTopLen = Infinity, bestTopOrder = Infinity;
  let bestOther: HTMLElement | null = null, bestOtherOrder = Infinity;
  let overlapping: HTMLElement | null = null, overlappingLen = Infinity, overlappingOrder = -1;
  for (let i = hi; i >= 0; i--) {
    const e = entries[i];
    if (e.prefixMaxEnd < range.to && (bestTop !== null || bestOther !== null || e.prefixMaxEnd <= range.from)) break;
    const len = e.end - e.start;
    if (range.to <= e.end) {
      if (e.isTopBlock) {
        if (len < bestTopLen || (len === bestTopLen && e.domOrder < bestTopOrder)) { bestTop = e.el; bestTopLen = len; bestTopOrder = e.domOrder; }
      } else if (e.domOrder < bestOtherOrder) { bestOther = e.el; bestOtherOrder = e.domOrder; }
    } else if (range.from < e.end && (len < overlappingLen || (len === overlappingLen && e.domOrder > overlappingOrder))) {
      overlapping = e.el; overlappingLen = len; overlappingOrder = e.domOrder;
    }
  }
  return bestTop ?? bestOther ?? overlapping;
}

export function findContainingBlock(host: Element, range: SourceRange, content?: string, sharedIndex?: SourceRangeIndex): HTMLElement | null {
  const index = sharedIndex ? refreshSourceRangeIndex(sharedIndex, content) : getSourceRangeIndex(host, content);
  return findContainingBlockInIndex(index, range);
}

export function deepestSourceOwner(block: HTMLElement, range: SourceRange, content?: string, sharedIndex?: SourceRangeIndex): HTMLElement | null {
  const index = sharedIndex ? refreshSourceRangeIndex(sharedIndex, content) : findAncestorSourceIndex(block, content);
  const blockEntry = index?.byElement.get(block);
  if (index && blockEntry) {
    let owner: HTMLElement | null = null, ownerLen = Infinity, ownerOrder = -1;
    if (blockEntry.start <= range.from && range.from <= blockEntry.end) { owner = block; ownerLen = blockEntry.end - blockEntry.start; ownerOrder = blockEntry.domOrder; }
    if (blockEntry.subtreeEndDomOrder === blockEntry.domOrder) return owner;
    const { entries } = index, hi = upperBoundSourceStart(entries, range.from);
    for (let i = hi; i >= 0; i--) {
      const e = entries[i];
      if (e.prefixMaxEnd < range.to) break;
      if (!e.isOwnerCandidate || e.domOrder <= blockEntry.domOrder || e.domOrder > blockEntry.subtreeEndDomOrder) continue;
      if (range.to <= e.end) {
        const len = e.end - e.start;
        if (len < ownerLen || (len === ownerLen && e.domOrder > ownerOrder)) { owner = e.el; ownerLen = len; ownerOrder = e.domOrder; }
      }
    }
    return owner;
  }
  let owner: HTMLElement | null = null, ownerLen = Infinity;
  const blockBounds = sourceBounds(block, content);
  if (blockBounds && blockBounds.start <= range.from && range.from <= blockBounds.end) { owner = block; ownerLen = blockBounds.end - blockBounds.start; }
  for (const el of block.querySelectorAll<HTMLElement>("[data-source-start],.code-container")) {
    const bounds = sourceBounds(el, content);
    if (bounds && bounds.start <= range.from && range.to <= bounds.end && bounds.end - bounds.start <= ownerLen) { owner = el; ownerLen = bounds.end - bounds.start; }
  }
  return owner;
}

export function resolveSourceBlock(host: Element, range: SourceRange, content?: string): HTMLElement | null {
  const index = getSourceRangeIndex(host, content);
  const containing = findContainingBlockInIndex(index, range);
  if (containing) return deepestSourceOwner(containing, range, content, index) ?? containing;
  const hi = upperBoundSourceStart(index.entries, range.from);
  return hi >= 0 ? index.entries[hi].maxAttrDomEl : null;
}
