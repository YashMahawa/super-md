// @vitest-environment jsdom
import {beforeEach,describe,expect,it,vi} from "vitest";
import {
  MAX_PERSONAL_WORDS,
  PERSONAL_DICTIONARY_KEY,
  addPersonalWord,
  hasPersonalWord,
  loadPersonalWords,
  normalizeDictionaryWord,
  resetPersonalDictionaryMemoryForTests,
  subscribePersonalDictionary
} from "./personalDictionary";

beforeEach(()=>{
  localStorage.clear();
  resetPersonalDictionaryMemoryForTests();
  vi.restoreAllMocks();
});

describe("personalDictionary",()=>{
  it("normalizes case, curly apostrophes and surrounding punctuation",()=>{
    expect(normalizeDictionaryWord("  EigenMode  ")).toBe("eigenmode");
    expect(normalizeDictionaryWord("User’s")).toBe("user's");
    expect(normalizeDictionaryWord("---low-pass---")).toBe("low-pass");
    expect(normalizeDictionaryWord("12345")).toBe("");
    expect(normalizeDictionaryWord("   ")).toBe("");
  });

  it("persists case-insensitively, matches possessives and notifies subscribers",()=>{
    const listener=vi.fn();
    const unsubscribe=subscribePersonalDictionary(listener);
    expect(addPersonalWord("Eigenmode")).toBe(true);
    expect(listener).toHaveBeenCalledOnce();
    expect(loadPersonalWords()).toEqual(["eigenmode"]);
    expect(hasPersonalWord("eigenmode")).toBe(true);
    expect(hasPersonalWord("EIGENMODE")).toBe(true);
    expect(hasPersonalWord("Eigenmode’s")).toBe(true);
    window.dispatchEvent(new StorageEvent("storage",{key:PERSONAL_DICTIONARY_KEY}));
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("caps stored words at MAX_PERSONAL_WORDS and deduplicates recent additions",()=>{
    const initial=Array.from({length:MAX_PERSONAL_WORDS},(_,i)=>`term-${String(i).padStart(4,"0")}`);
    localStorage.setItem(PERSONAL_DICTIONARY_KEY,JSON.stringify(initial));
    addPersonalWord("NewestTerm");
    const saved=loadPersonalWords();
    expect(saved).toHaveLength(MAX_PERSONAL_WORDS);
    expect(saved[0]).toBe("newestterm");
    expect(saved).not.toContain(`term-${String(MAX_PERSONAL_WORDS-1).padStart(4,"0")}`);
  });

  it("recovers from corrupt JSON and handles unavailable localStorage without throwing",()=>{
    localStorage.setItem(PERSONAL_DICTIONARY_KEY,"{not-valid-json");
    expect(loadPersonalWords()).toEqual([]);

    vi.spyOn(Storage.prototype,"getItem").mockImplementation(()=>{throw new Error("SecurityError");});
    vi.spyOn(Storage.prototype,"setItem").mockImplementation(()=>{throw new Error("QuotaExceededError");});
    expect(()=>addPersonalWord("Waveguide")).not.toThrow();
    expect(hasPersonalWord("waveguide")).toBe(true);
    expect(loadPersonalWords()).toEqual(["waveguide"]);
  });
});
