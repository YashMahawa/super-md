/** Persistent offline personal dictionary shared across Source and Live editing. */
export const PERSONAL_DICTIONARY_KEY = "supermd.personal-dictionary.v1";
export const MAX_PERSONAL_WORDS = 1000;
const CHANGE_EVENT = "supermd-personal-dictionary";

let fallbackWords: string[] = [];
const listeners = new Set<() => void>();

export function normalizeDictionaryWord(raw: string): string {
  if (typeof raw !== "string") return "";
  const normalized = raw
    .trim()
    .replace(/[’‘]/g, "'")
    .replace(/^['-]+|['-]+$/g, "")
    .toLowerCase();
  return /^[a-z][a-z0-9'-]{0,79}$/.test(normalized) ? normalized : "";
}

function sanitizeWordList(entries: unknown): string[] {
  if (!Array.isArray(entries)) return [];
  const seen = new Set<string>();
  const valid: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== "string") continue;
    const word = normalizeDictionaryWord(entry);
    if (!word || seen.has(word)) continue;
    seen.add(word);
    valid.push(word);
    if (valid.length >= MAX_PERSONAL_WORDS) break;
  }
  return valid;
}

export function loadPersonalWords(): string[] {
  if (typeof localStorage === "undefined") return [...fallbackWords];
  try {
    const raw = localStorage.getItem(PERSONAL_DICTIONARY_KEY);
    if (raw === null) {
      fallbackWords = [];
      return [];
    }
    try {
      const parsed = sanitizeWordList(JSON.parse(raw));
      fallbackWords = parsed;
      return [...parsed];
    } catch {
      fallbackWords = [];
      return [];
    }
  } catch {
    return [...fallbackWords];
  }
}

function notifyDictionaryChanged(word: string): void {
  for (const listener of [...listeners]) listener();
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
    try {
      window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: word }));
    } catch { /* Non-DOM environments ignore window events. */ }
  }
}

export function addPersonalWord(raw: string): boolean {
  const word = normalizeDictionaryWord(raw);
  if (!word) return false;
  const current = loadPersonalWords();
  const next = [word, ...current.filter(existing => existing !== word)].slice(0, MAX_PERSONAL_WORDS);
  fallbackWords = next;
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.setItem(PERSONAL_DICTIONARY_KEY, JSON.stringify(next));
    } catch { /* Unavailable or quota-full browser storage must never block editing. */ }
  }
  notifyDictionaryChanged(word);
  return true;
}

export function hasPersonalWord(raw: string, dictionary?: ReadonlySet<string>): boolean {
  const word = normalizeDictionaryWord(raw);
  if (!word) return false;
  const stem = word.endsWith("'s") ? word.slice(0, -2) : word;
  const lookup = dictionary ?? new Set(loadPersonalWords());
  return lookup.has(word) || (stem.length > 0 && lookup.has(stem));
}

export function subscribePersonalDictionary(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === PERSONAL_DICTIONARY_KEY) listener();
  };
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("storage", onStorage);
  }
  return () => {
    listeners.delete(listener);
    if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
      window.removeEventListener("storage", onStorage);
    }
  };
}

export function resetPersonalDictionaryMemoryForTests(): void {
  fallbackWords = [];
}
