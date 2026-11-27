export interface DisclosureDescriptor {
  key: string;
  kind: "callout" | "code";
  offset: number;
  endOffset: number;
  defaultOpen: boolean;
}

const SPECIAL_CODE_LANGUAGES = new Set([
  "smd-tree",
  "smd-diagram",
  "smd-steps",
  "smd-chart",
  "svg",
  "mermaid",
  "python",
  "py",
]);

const MAX_NOTES = 64;
const MAX_DISCLOSURES_PER_NOTE = 1000;
const MAX_KEY_LENGTH = 256;

const noteDisclosures = new Map<string, Map<string, boolean>>();

export function hashDisclosureSignature(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const combined = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return combined.toString(36);
}

function normalizeCalloutSignatureSlice(raw: string): string {
  return raw.replace(/^([ \t>]*[-+*]|[ \t>]*\d+[.)])([ \t]+\[)[xX](\])/gm, "$1$2 $3");
}

export function isCollapsibleCallout(type: string, fold: string): boolean {
  return Boolean(fold) || type === "answer" || type === "solution";
}

export function defaultCalloutOpen(fold: string): boolean {
  return fold === "+";
}

export function isFoldedCodeLanguage(lang: string | undefined): boolean {
  return !SPECIAL_CODE_LANGUAGES.has(lang || "");
}

export function defaultCodeDisclosureOpen(code: string): boolean {
  return code.split("\n").length <= 12;
}

export function calloutDisclosureBaseKey(fold: string, type: string, rawSlice: string): string {
  const normalized = normalizeCalloutSignatureSlice(rawSlice);
  return `callout:${fold}:${type}:${normalized.length}:${hashDisclosureSignature(normalized)}`;
}

export function codeDisclosureBaseKey(lang: string, code: string): string {
  const lines = code.split("\n").length;
  return `code:${lang}:${lines}:${code.length}:${hashDisclosureSignature(code)}`;
}

export function scopedDisclosureKey(scope: string | undefined, key: string): string {
  return scope ? `${scope}/${key}` : key;
}

const CALLOUT_KEY_RE = /^(?:step:[a-z0-9]+:[a-z0-9]+\/)*callout:([+-]?):[\w-]+:\d+:[a-z0-9]+#\d+$/i;
const CODE_KEY_RE = /^(?:step:[a-z0-9]+:[a-z0-9]+\/)*code:[\w-]*:(\d+):\d+:[a-z0-9]+#\d+$/i;

export function inferDisclosureDefaultOpen(key: string): boolean | undefined {
  if (key.length > MAX_KEY_LENGTH) return undefined;
  const callout = CALLOUT_KEY_RE.exec(key);
  if (callout) return callout[1] === "+";
  const code = CODE_KEY_RE.exec(key);
  if (code) return Number(code[1]) <= 12;
  return undefined;
}

export function getNoteDisclosure(
  noteId: string | undefined,
  key: string | undefined,
  defaultOpen: boolean,
): boolean {
  if (!noteId || !key) return defaultOpen;
  const stored = noteDisclosures.get(noteId)?.get(key);
  return typeof stored === "boolean" ? stored : defaultOpen;
}

export function setNoteDisclosure(
  noteId: string | undefined,
  key: string | undefined,
  open: boolean,
  defaultOpen: boolean,
): boolean {
  if (!noteId || !key || key.length > MAX_KEY_LENGTH) return false;
  let perNote = noteDisclosures.get(noteId);
  if (open === defaultOpen) {
    if (!perNote || !perNote.has(key)) return false;
    perNote.delete(key);
    if (perNote.size === 0) noteDisclosures.delete(noteId);
    return true;
  }
  if (perNote) {
    noteDisclosures.delete(noteId);
    noteDisclosures.set(noteId, perNote);
  } else {
    perNote = new Map();
    noteDisclosures.set(noteId, perNote);
    while (noteDisclosures.size > MAX_NOTES) {
      noteDisclosures.delete(noteDisclosures.keys().next().value!);
    }
  }
  if (perNote.get(key) === open) return false;
  perNote.delete(key);
  perNote.set(key, open);
  while (perNote.size > MAX_DISCLOSURES_PER_NOTE) {
    perNote.delete(perNote.keys().next().value!);
  }
  return true;
}

export function hasNoteDisclosureOverrides(noteId: string | undefined): boolean {
  return Boolean(noteId && (noteDisclosures.get(noteId)?.size ?? 0) > 0);
}

export function syncMountedNoteDisclosures(noteId: string | undefined): void {
  if (!noteId || typeof document === "undefined") return;
  for (const article of document.querySelectorAll<HTMLElement>(".markdown-body[data-note-id]")) {
    if (article.getAttribute("data-note-id") !== noteId) continue;
    for (const details of article.querySelectorAll<HTMLDetailsElement>("details[data-disclosure-key]")) {
      const key = details.getAttribute("data-disclosure-key");
      if (!key) continue;
      const defaultOpen = details.getAttribute("data-disclosure-default") === "true";
      setNoteDisclosure(noteId, key, details.open, defaultOpen);
    }
  }
}

export function exportNoteDisclosuresForMap(
  noteId: string | undefined,
  validDefaults?: ReadonlyMap<string, boolean>,
): [string, boolean][] {
  if (!noteId) return [];
  syncMountedNoteDisclosures(noteId);
  const perNote = noteDisclosures.get(noteId);
  if (!perNote || perNote.size === 0) return [];
  const exported: [string, boolean][] = [];
  for (const [key, open] of perNote) {
    const def = validDefaults ? validDefaults.get(key) : inferDisclosureDefaultOpen(key);
    if (def !== undefined && open !== def) exported.push([key, open]);
  }
  return exported;
}

export function importNoteDisclosuresForMap(
  noteId: string | undefined,
  pairs: unknown,
  validDefaults?: ReadonlyMap<string, boolean>,
): void {
  if (!noteId || !Array.isArray(pairs)) return;
  noteDisclosures.delete(noteId);
  for (const pair of pairs.slice(0, MAX_DISCLOSURES_PER_NOTE)) {
    if (!Array.isArray(pair) || typeof pair[0] !== "string" || typeof pair[1] !== "boolean") continue;
    const def = validDefaults ? validDefaults.get(pair[0]) : inferDisclosureDefaultOpen(pair[0]);
    if (def !== undefined) setNoteDisclosure(noteId, pair[0], pair[1], def);
  }
}

export function clearNoteDisclosures(noteIds?: Iterable<string>): void {
  if (!noteIds) {
    noteDisclosures.clear();
    return;
  }
  for (const id of noteIds) noteDisclosures.delete(id);
}

export function retainNoteDisclosures(activeNoteIds: Iterable<string>): void {
  const keep = new Set(activeNoteIds);
  for (const id of [...noteDisclosures.keys()]) {
    if (!keep.has(id)) noteDisclosures.delete(id);
  }
}
