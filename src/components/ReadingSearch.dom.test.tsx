// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import LiveEditor from "./LiveEditor";
import ReadingSearch, { resolveSourceBlock, resolveSourceHighlightRange, sourceMatches } from "./ReadingSearch";
import { registerWindowedText } from "../windowedSearch";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("ReadingSearch DOM behavior", () => {
  it("hides Replace controls when onChange is omitted in Read mode and resets replacing if switched to Read", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const onChange = vi.fn();

    await act(async () => {
      root.render(
        <div className="android-document">
          <ReadingSearch content="alpha beta alpha" close={() => {}} />
          <section className="android-reading"><div className="markdown-body"><p>alpha beta alpha</p></div></section>
        </div>
      );
    });
    expect(host.querySelector('button[aria-label="Replace in source"]')).toBeNull();
    expect(host.querySelector(".search-replace")).toBeNull();

    await act(async () => {
      root.render(
        <div className="android-document">
          <ReadingSearch content="alpha beta alpha" close={() => {}} onChange={onChange} />
          <section className="android-reading"><div className="markdown-body"><p>alpha beta alpha</p></div></section>
        </div>
      );
    });
    const toggle = host.querySelector<HTMLButtonElement>('button[aria-label="Replace in source"]')!;
    expect(toggle).not.toBeNull();
    act(() => toggle.click());
    expect(host.querySelector(".search-replace")).not.toBeNull();

    await act(async () => {
      root.render(
        <div className="android-document">
          <ReadingSearch content="alpha beta alpha" close={() => {}} />
          <section className="android-reading"><div className="markdown-body"><p>alpha beta alpha</p></div></section>
        </div>
      );
    });
    expect(host.querySelector('button[aria-label="Replace in source"]')).toBeNull();
    expect(host.querySelector(".search-replace")).toBeNull();

    act(() => root.unmount());
    host.remove();
  });

  it("wraps Previous from 0/N to N/N, preserves selection across Replace toggle, and gates Replace buttons", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    let current = "# Notes\n\nAlpha first.\n\n> [!NOTE]- Folded\n> Alpha second.\n\nAlpha third.";
    const changes: string[] = [];

    const renderApp = async () => {
      await act(async () => {
        root.render(
          <div className="android-document">
            <ReadingSearch content={current} close={() => {}} onChange={(next) => { current = next; changes.push(next); }} />
            <section className="android-reading">
              <LiveEditor markdown={current} onChange={(next) => { current = next; }} documentPath={null} python="" dark={false} />
            </section>
          </div>
        );
      });
      await act(async () => {
        await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
      });
    };

    await renderApp();
    const searchInput = host.querySelector<HTMLInputElement>('input[aria-label="Find in note"]')!;
    const replaceToggle = host.querySelector<HTMLButtonElement>('button[aria-label="Replace in source"]')!;
    act(() => replaceToggle.click());

    const buttons = () => Array.from(host.querySelectorAll<HTMLButtonElement>(".search-replace button"));
    expect(buttons()[0].disabled).toBe(true);
    expect(buttons()[1].disabled).toBe(true);

    act(() => setInputValue(searchInput, "missing-token"));
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))); });
    expect(host.querySelector("output")?.textContent).toBe("No matches");
    expect(buttons()[0].disabled).toBe(true);
    expect(buttons()[1].disabled).toBe(true);

    act(() => replaceToggle.click());
    act(() => setInputValue(searchInput, "Alpha"));
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))); });
    expect(host.querySelector("output")?.textContent).toBe("0 / 3");

    const prevButton = host.querySelector<HTMLButtonElement>('button[aria-label="Previous match"]')!;
    act(() => prevButton.click());
    expect(host.querySelector("output")?.textContent).toBe("3 / 3");

    act(() => prevButton.click());
    expect(host.querySelector("output")?.textContent).toBe("2 / 3");
    expect(host.querySelector("details.callout")?.hasAttribute("open")).toBe(true);

    // Toggling Replace on preserves the active 2 / 3 match selection.
    act(() => replaceToggle.click());
    expect(host.querySelector("output")?.textContent).toBe("2 / 3");
    expect(buttons()[0].disabled).toBe(false);
    expect(buttons()[1].disabled).toBe(false);

    const replaceInput = host.querySelector<HTMLInputElement>('input[aria-label="Replacement text"]')!;
    act(() => setInputValue(replaceInput, "Beta"));
    act(() => buttons()[0].click());
    expect(changes.at(-1)).toContain("Alpha first.");
    expect(changes.at(-1)).toContain("Beta second.");
    expect(changes.at(-1)).toContain("Alpha third.");

    act(() => root.unmount());
    host.remove();
  });

  it("maps body matches accurately across YAML frontmatter when toggling Replace in source", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    let current = "---\ntitle: Alpha Study\n---\n\n# Heading\n\nAlpha body.";
    const changes: string[] = [];

    await act(async () => {
      root.render(
        <div className="android-document">
          <ReadingSearch content={current} close={() => {}} onChange={(next) => { current = next; changes.push(next); }} />
          <section className="android-reading">
            <LiveEditor markdown={current} onChange={(next) => { current = next; }} documentPath={null} python="" dark={false} />
          </section>
        </div>
      );
    });
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))); });

    const searchInput = host.querySelector<HTMLInputElement>('input[aria-label="Find in note"]')!;
    act(() => setInputValue(searchInput, "Alpha"));
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))); });

    // Body search ignores rendered YAML properties, counting only the 1 body match.
    expect(host.querySelector("output")?.textContent).toBe("0 / 1");
    const nextButton = host.querySelector<HTMLButtonElement>('button[aria-label="Next match"]')!;
    act(() => nextButton.click());
    expect(host.querySelector("output")?.textContent).toBe("1 / 1");

    // Toggling Replace in source maps that active body match to source match 2 / 2 (after frontmatter title).
    const replaceToggle = host.querySelector<HTMLButtonElement>('button[aria-label="Replace in source"]')!;
    act(() => replaceToggle.click());
    expect(host.querySelector("output")?.textContent).toBe("2 / 2");

    const replaceInput = host.querySelector<HTMLInputElement>('input[aria-label="Replacement text"]')!;
    const buttons = Array.from(host.querySelectorAll<HTMLButtonElement>(".search-replace button"));
    act(() => setInputValue(replaceInput, "Beta"));
    act(() => buttons[0].click());
    expect(changes.at(-1)).toBe("---\ntitle: Alpha Study\n---\n\n# Heading\n\nBeta body.");

    act(() => root.unmount());
    host.remove();
  });

  it("resolves block-mapped highlight ranges across hidden URLs, inline HTML tags, study syntax, and fenced code", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const markdown = [
      "# Heading",
      "",
      "Check [link](https://example.com/mark) and <mark>mark</mark> and ==mark==.",
      "",
      "```ts",
      "const mark = 1;",
      "```",
      "",
      "After fence.",
    ].join("\n");

    await act(async () => {
      root.render(
        <section className="android-reading">
          <LiveEditor markdown={markdown} onChange={() => {}} documentPath={null} python="" dark={false} spellCheck grammarCheck />
        </section>
      );
    });
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))); });

    const ranges = sourceMatches(markdown, "mark", true);
    // Ranges in source:
    // 0: URL https://example.com/mark (hidden)
    // 1: opening <mark> tag (hidden)
    // 2: visible text inside <mark>mark</mark>
    // 3: closing </mark> tag (hidden)
    // 4: visible text inside ==mark==
    // 5: visible code inside fenced block
    expect(ranges).toHaveLength(6);
    expect(resolveSourceHighlightRange(host, markdown, ranges, 0, "mark", true)).toBeNull();
    expect(resolveSourceHighlightRange(host, markdown, ranges, 1, "mark", true)).toBeNull();
    const htmlVisible = resolveSourceHighlightRange(host, markdown, ranges, 2, "mark", true);
    expect(htmlVisible?.toString()).toBe("mark");
    expect(htmlVisible?.startContainer.parentElement?.tagName).toBe("MARK");
    expect(resolveSourceHighlightRange(host, markdown, ranges, 3, "mark", true)).toBeNull();
    const studyVisible = resolveSourceHighlightRange(host, markdown, ranges, 4, "mark", true);
    expect(studyVisible?.toString()).toBe("mark");
    expect(studyVisible?.startContainer.parentElement?.tagName).toBe("MARK");
    expect(studyVisible?.startContainer).not.toBe(htmlVisible?.startContainer);

    const codeOwner = resolveSourceBlock(host, ranges[5], markdown);
    expect(codeOwner?.matches(".code-container,pre")).toBe(true);
    const codeRange = resolveSourceHighlightRange(host, markdown, ranges, 5, "mark", true);
    expect(codeRange?.toString()).toBe("mark");
    expect(codeRange?.startContainer.parentElement?.closest("pre")).not.toBeNull();

    act(() => root.unmount());
    host.remove();
  });

  it("advances sequentially across single replacements, respects search seeds, and closes active Live block drafts", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    let current = "Alpha one.\n\nAlpha two.\n\nAlpha three.";

    const mountView = (seedNonce = 1) => {
      root.render(
        <div className="android-document">
          <ReadingSearch
            content={current}
            close={() => {}}
            seed={{ query: "Alpha", caseSensitive: true, nonce: seedNonce }}
            onChange={(next) => { current = next; mountView(seedNonce); }}
          />
          <section className="android-reading">
            <LiveEditor
              markdown={current}
              onChange={(next) => { current = next; mountView(seedNonce); }}
              documentPath={null}
              python=""
              dark={false}
              spellCheck
              grammarCheck
            />
          </section>
        </div>
      );
    };

    await act(async () => { mountView(1); });
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))); });
    // Seed auto-selects 1 / 3 immediately.
    expect(host.querySelector("output")?.textContent).toBe("1 / 3");

    // Focus a Live block to reveal its accessible Edit button, open the draft, then toggle Replace in source.
    const liveBlocks = host.querySelectorAll<HTMLElement>(".live-block");
    expect(liveBlocks.length).toBe(3);
    act(() => liveBlocks[2].focus());
    const editBtn = liveBlocks[2].querySelector<HTMLButtonElement>(".live-block-edit")!;
    expect(editBtn).not.toBeNull();
    act(() => editBtn.click());
    expect(host.querySelector('textarea[aria-label="Edit Markdown block"]')).not.toBeNull();

    const replaceToggle = host.querySelector<HTMLButtonElement>('button[aria-label="Replace in source"]')!;
    act(() => replaceToggle.click());
    expect(host.querySelector("output")?.textContent).toBe("1 / 3");

    const replaceInput = host.querySelector<HTMLInputElement>('input[aria-label="Replacement text"]')!;
    act(() => setInputValue(replaceInput, "Beta"));
    const replaceBtn = () => host.querySelectorAll<HTMLButtonElement>(".search-replace button")[0];

    // Replacing 1 / 3 updates source, closes stale active block editor, and advances selection to 1 / 2 ("Alpha two.").
    await act(async () => { replaceBtn().click(); });
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))); });
    expect(current).toBe("Beta one.\n\nAlpha two.\n\nAlpha three.");
    expect(host.querySelector('textarea[aria-label="Edit Markdown block"]')).toBeNull();
    expect(host.querySelector("output")?.textContent).toBe("1 / 2");

    // Replacing again advances to 1 / 1 ("Alpha three.").
    await act(async () => { replaceBtn().click(); });
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))); });
    expect(current).toBe("Beta one.\n\nBeta two.\n\nAlpha three.");
    expect(host.querySelector("output")?.textContent).toBe("1 / 1");

    act(() => root.unmount());
    host.remove();
  });

  it("reveals the selected folder-search occurrence across repeated matches, Unicode offsets, disclosures, and windowed blocks", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const scrolled: Element[] = [];
    const origScroll = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function () { scrolled.push(this); };

    const markdown = [
      "# İstanbul 📓 Field Notes",
      "",
      "First AuroraSignal after 📓 emoji.",
      "",
      "> [!NOTE]- Folded Lab 📓",
      "> İstanbul 📓 precedes second AuroraSignal inside closed callout.",
      "",
      "Check [reference](https://example.com/AuroraSignal) before third AuroraSignal and Straße.",
    ].join("\n");

    const allAurora = sourceMatches(markdown, "AuroraSignal", true);
    // 0: visible paragraph 1
    // 1: visible inside closed callout after İstanbul 📓
    // 2: hidden inside link URL (https://example.com/AuroraSignal)
    // 3: visible after hidden link URL
    expect(allAurora).toHaveLength(4);

    try {
      const renderSeeded = async (seed: { query: string; caseSensitive?: boolean; sourceStart?: number; sourceEnd?: number; nonce: number }) => {
        await act(async () => {
          root.render(
            <div className="android-document">
              <ReadingSearch content={markdown} close={() => {}} seed={seed} />
              <section className="android-reading">
                <LiveEditor markdown={markdown} onChange={() => {}} documentPath={null} python="" dark={false} />
              </section>
            </div>
          );
        });
        await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))); });
      };

      // 1. Un-targeted seeded Find preserves existing 1 / 3 behavior.
      await renderSeeded({ query: "AuroraSignal", caseSensitive: true, nonce: 1 });
      expect(host.querySelector("output")?.textContent).toBe("1 / 3");
      expect(host.querySelector("details.callout")?.hasAttribute("open")).toBe(false);

      // 2. Selecting occurrence #2 (after Unicode surrogate 📓 + İstanbul inside closed callout) opens disclosure and lands on 2 / 3.
      await renderSeeded({
        query: "AuroraSignal",
        caseSensitive: true,
        sourceStart: allAurora[1].from,
        sourceEnd: allAurora[1].to,
        nonce: 2,
      });
      expect(host.querySelector("details.callout")?.hasAttribute("open")).toBe(true);
      expect(host.querySelector("output")?.textContent).toBe("2 / 3");

      // Next match continues cleanly from 2 / 3 -> 3 / 3.
      const nextBtn = host.querySelector<HTMLButtonElement>('button[aria-label="Next match"]')!;
      act(() => nextBtn.click());
      expect(host.querySelector("output")?.textContent).toBe("3 / 3");

      // 3. Selecting source occurrence #4 (index 3, after hidden link URL at index 2) maps via shared source mapper to visible 3 / 3.
      await renderSeeded({
        query: "AuroraSignal",
        caseSensitive: true,
        sourceStart: allAurora[3].from,
        sourceEnd: allAurora[3].to,
        nonce: 3,
      });
      expect(host.querySelector("output")?.textContent).toBe("3 / 3");

      // 4. Full Unicode case-fold expansion ("strasse" -> "Straße" after astral 📓 offsets) reveals and highlights "Straße".
      const strasseFrom = markdown.indexOf("Straße");
      expect(strasseFrom).toBeGreaterThan(0);
      await renderSeeded({
        query: "strasse",
        caseSensitive: false,
        sourceStart: strasseFrom,
        sourceEnd: strasseFrom + "Straße".length,
        nonce: 4,
      });
      expect(host.querySelector("output")?.textContent).toBe("1 / 1");
      expect(scrolled.length).toBeGreaterThan(0);
    } finally {
      Element.prototype.scrollIntoView = origScroll;
      act(() => root.unmount());
      host.remove();
    }
  });

  it("treats hidden source hits separately without falsely selecting visible matches or mutating Read mode", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const scrolled: Element[] = [];
    const origScroll = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function () { scrolled.push(this); };

    let markdown = [
      "---",
      "title: HiddenFrontmatterToken and SharedNeedle",
      "---",
      "",
      "First visible SharedNeedle paragraph.",
      "",
      "Middle paragraph with [portal](https://example.com/SharedNeedle) and [spec](https://example.com/OnlyInHiddenUrl).",
      "",
      "Last visible SharedNeedle paragraph.",
    ].join("\n");

    const sharedRanges = sourceMatches(markdown, "SharedNeedle", true);
    // 0: YAML frontmatter (hidden)
    // 1: First visible paragraph (rendered 1 / 2)
    // 2: Link URL https://example.com/SharedNeedle (hidden)
    // 3: Last visible paragraph (rendered 2 / 2)
    expect(sharedRanges).toHaveLength(4);
    const urlOnlyRanges = sourceMatches(markdown, "OnlyInHiddenUrl", true);
    expect(urlOnlyRanges).toHaveLength(1);

    try {
      // Read mode (onChange omitted): selecting hidden URL hit scrolls to link owner, shows "In source · 0 / 2",
      // keeps Replace controls absent, and steps forward to 2 / 2 (not backward to 1 / 2) on Next.
      await act(async () => {
        root.render(
          <div className="android-document">
            <ReadingSearch
              content={markdown}
              close={() => {}}
              seed={{
                query: "SharedNeedle",
                caseSensitive: true,
                sourceStart: sharedRanges[2].from,
                sourceEnd: sharedRanges[2].to,
                nonce: 10,
              }}
            />
            <section className="android-reading">
              <LiveEditor markdown={markdown} onChange={() => {}} documentPath={null} python="" dark={false} />
            </section>
          </div>
        );
      });
      await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))); });

      expect(host.querySelector('button[aria-label="Replace in source"]')).toBeNull();
      expect(host.querySelector("output")?.textContent).toBe("In source · 0 / 2");
      expect(scrolled.some(el => el.tagName === "A" || el.textContent?.includes("portal"))).toBe(true);

      const nextBtn = host.querySelector<HTMLButtonElement>('button[aria-label="Next match"]')!;
      act(() => nextBtn.click());
      expect(host.querySelector("output")?.textContent).toBe("2 / 2");

      // Hidden-only URL match shows "In Markdown source" rather than misleading "No matches".
      await act(async () => {
        root.render(
          <div className="android-document">
            <ReadingSearch
              content={markdown}
              close={() => {}}
              seed={{
                query: "OnlyInHiddenUrl",
                caseSensitive: true,
                sourceStart: urlOnlyRanges[0].from,
                sourceEnd: urlOnlyRanges[0].to,
                nonce: 11,
              }}
            />
            <section className="android-reading">
              <LiveEditor markdown={markdown} onChange={() => {}} documentPath={null} python="" dark={false} />
            </section>
          </div>
        );
      });
      await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))); });
      expect(host.querySelector("output")?.textContent).toBe("In Markdown source");

      // Live mode (onChange provided): toggling Replace in source from a hidden URL hit targets that exact hidden source occurrence (3 / 4).
      await act(async () => {
        root.render(
          <div className="android-document">
            <ReadingSearch
              content={markdown}
              close={() => {}}
              onChange={(next) => { markdown = next; }}
              seed={{
                query: "SharedNeedle",
                caseSensitive: true,
                sourceStart: sharedRanges[2].from,
                sourceEnd: sharedRanges[2].to,
                nonce: 12,
              }}
            />
            <section className="android-reading">
              <LiveEditor markdown={markdown} onChange={(next) => { markdown = next; }} documentPath={null} python="" dark={false} />
            </section>
          </div>
        );
      });
      await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))); });
      expect(host.querySelector("output")?.textContent).toBe("In source · 0 / 2");

      const replaceToggle = host.querySelector<HTMLButtonElement>('button[aria-label="Replace in source"]')!;
      act(() => replaceToggle.click());
      expect(host.querySelector("output")?.textContent).toBe("3 / 4");

      const replaceInput = host.querySelector<HTMLInputElement>('input[aria-label="Replacement text"]')!;
      const replaceBtn = host.querySelectorAll<HTMLButtonElement>(".search-replace button")[0];
      act(() => setInputValue(replaceInput, "UpdatedSlug"));
      act(() => replaceBtn.click());
      expect(markdown).toContain("[portal](https://example.com/UpdatedSlug)");
      expect(markdown).toContain("First visible SharedNeedle paragraph.");
      expect(markdown).toContain("Last visible SharedNeedle paragraph.");
    } finally {
      Element.prototype.scrollIntoView = origScroll;
      act(() => root.unmount());
      host.remove();
    }
  });

  it("falls back to ordinary seeded Find on stale offsets from same-offset replacement or prior insertion while keeping valid Unicode-folded and hidden-source hits", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const origHighlight = (window as typeof window & { Highlight?: unknown }).Highlight;
    const origCss = (globalThis as typeof globalThis & { CSS?: unknown }).CSS;

    class MockHighlight {
      ranges: Range[];
      constructor(...ranges: Range[]) {
        this.ranges = ranges;
      }
    }
    const highlightMap = new Map<string, MockHighlight>();
    Object.defineProperty(window, "Highlight", { value: MockHighlight, configurable: true, writable: true });
    Object.defineProperty(globalThis, "CSS", { value: { highlights: highlightMap }, configurable: true, writable: true });

    try {
      const renderNote = async (
        markdown: string,
        seed: { query: string; caseSensitive?: boolean; sourceStart?: number; sourceEnd?: number; matchText?: string; nonce: number },
        sourceSession?: string,
      ) => {
        highlightMap.clear();
        await act(async () => {
          root.render(
            <div className="android-document">
              <ReadingSearch content={markdown} close={() => {}} seed={seed} sourceSession={sourceSession} />
              <section className="android-reading">
                <LiveEditor markdown={markdown} onChange={() => {}} documentPath={null} python="" dark={false} />
              </section>
            </div>
          );
        });
        await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))); });
      };

      const scannedNote = [
        "First AuroraSignal in intro.",
        "",
        "Second AuroraSignal in body and [hidden](https://example.com/AuroraSignal).",
      ].join("\n");
      const scannedHits = sourceMatches(scannedNote, "AuroraSignal", false);
      expect(scannedHits).toHaveLength(3);

      // 1. Replacement at the exact same offsets (2nd occurrence replaced by equal-length "OtherContent"):
      //    Must NOT highlight "OtherContent" or claim "In source"; falls back to ordinary seeded Find (1 / 1 on first hit, plus hidden URL ignored in rendered count).
      const replacedSecondSameOffsets =
        scannedNote.slice(0, scannedHits[1].from) +
        "OtherContent" +
        scannedNote.slice(scannedHits[1].to);
      expect(replacedSecondSameOffsets.length).toBe(scannedNote.length);
      await renderNote(replacedSecondSameOffsets, {
        query: "aurorasignal",
        caseSensitive: false,
        sourceStart: scannedHits[1].from,
        sourceEnd: scannedHits[1].to,
        matchText: "AuroraSignal",
        nonce: 101,
      });
      expect(host.querySelector("output")?.textContent).toBe("1 / 1");
      expect(highlightMap.get("smd-search-current")?.ranges[0]?.toString()).toBe("AuroraSignal");
      expect(highlightMap.get("smd-search")?.ranges.map(r => r.toString())).toEqual(["AuroraSignal"]);

      // 1b. Replacement at the same offsets when NO matches remain anywhere in the note (including inside a hidden URL):
      //     Must report "No matches" and highlight nothing, NOT "In Markdown source" or the replacement slice.
      const replacedAllSameOffsets = scannedNote.replaceAll("AuroraSignal", "OtherContent");
      expect(replacedAllSameOffsets.length).toBe(scannedNote.length);
      await renderNote(replacedAllSameOffsets, {
        query: "AuroraSignal",
        caseSensitive: false,
        sourceStart: scannedHits[2].from,
        sourceEnd: scannedHits[2].to,
        matchText: "AuroraSignal",
        nonce: 102,
      });
      expect(host.querySelector("output")?.textContent).toBe("No matches");
      expect(highlightMap.get("smd-search-current")).toBeUndefined();
      expect(highlightMap.get("smd-search")?.ranges ?? []).toHaveLength(0);

      // 1c. Source/Split session with stale replacement at same offsets also falls back to ordinary seeded Find without highlighting unrelated slice.
      await renderNote(
        replacedSecondSameOffsets,
        {
          query: "AuroraSignal",
          caseSensitive: false,
          sourceStart: scannedHits[1].from,
          sourceEnd: scannedHits[1].to,
          matchText: "AuroraSignal",
          nonce: 103,
        },
        "source-session-stale",
      );
      expect(host.querySelector("output")?.textContent).toBe("1 / 2");

      // 2. Insertion before the old offset (both non-overlapping and partially overlapping shifted offsets):
      //    Must NOT highlight the unrelated shifted slice or fuzzy-match the neighbor; falls back to ordinary seeded Find (1 / 2).
      const insertedPrefixNote = "Inserted preface — " + scannedNote;
      await renderNote(insertedPrefixNote, {
        query: "AuroraSignal",
        caseSensitive: false,
        sourceStart: scannedHits[1].from,
        sourceEnd: scannedHits[1].to,
        matchText: "AuroraSignal",
        nonce: 104,
      });
      expect(host.querySelector("output")?.textContent).toBe("1 / 2");
      expect(highlightMap.get("smd-search-current")?.ranges[0]?.toString()).toBe("AuroraSignal");

      // Partially overlapping 3-char insertion before old offset (shifts "AuroraSignal" by +3 so old [from, to) overlaps new [from+3, to+3)):
      const overlappingInsertNote = "Hi " + scannedNote;
      await renderNote(overlappingInsertNote, {
        query: "AuroraSignal",
        caseSensitive: false,
        sourceStart: scannedHits[1].from,
        sourceEnd: scannedHits[1].to,
        nonce: 105,
      });
      expect(host.querySelector("output")?.textContent).toBe("1 / 2");
      expect(highlightMap.get("smd-search-current")?.ranges[0]?.toString()).toBe("AuroraSignal");

      // 2b. Insertion that shifts a differently-cased variant onto the exact old offsets when matchText identity was captured:
      //     Scanned "AURORASIGNAL" at [0, 12), then "aurorasignal " was prepended so [0, 12) now holds "aurorasignal".
      const caseIdentityNote = "aurorasignal and AURORASIGNAL";
      await renderNote(caseIdentityNote, {
        query: "aurorasignal",
        caseSensitive: false,
        sourceStart: 17,
        sourceEnd: 29,
        matchText: "AuroraSignal", // mismatched identity -> falls back to ordinary seeded Find (1 / 2) instead of 2 / 2
        nonce: 106,
      });
      expect(host.querySelector("output")?.textContent).toBe("1 / 2");

      // 2c. Shortened note where old seedRange extends past EOF (previously clamped to content.length):
      await renderNote("Short AuroraSignal.", {
        query: "AuroraSignal",
        caseSensitive: false,
        sourceStart: 12,
        sourceEnd: 500,
        matchText: "AuroraSignal",
        nonce: 107,
      });
      expect(host.querySelector("output")?.textContent).toBe("1 / 1");
      expect(highlightMap.get("smd-search-current")?.ranges[0]?.toString()).toBe("AuroraSignal");

      // 3. Valid Unicode case-folding ("strasse" -> "Straße", "istanbul" -> "İstanbul") and deliberate hidden-source hits still validate and reveal!
      const unicodeAndHidden = "İstanbul Café on Große Straße with [doc](https://example.com/Straße).";
      const visibleStrasseFrom = unicodeAndHidden.indexOf("Straße");
      const hiddenStrasseFrom = unicodeAndHidden.lastIndexOf("Straße");
      await renderNote(unicodeAndHidden, {
        query: "strasse",
        caseSensitive: false,
        sourceStart: visibleStrasseFrom,
        sourceEnd: visibleStrasseFrom + "Straße".length,
        matchText: "Straße",
        nonce: 108,
      });
      expect(host.querySelector("output")?.textContent).toBe("1 / 1");
      expect(highlightMap.get("smd-search-current")?.ranges[0]?.toString()).toBe("Straße");

      await renderNote(unicodeAndHidden, {
        query: "strasse",
        caseSensitive: false,
        sourceStart: hiddenStrasseFrom,
        sourceEnd: hiddenStrasseFrom + "Straße".length,
        matchText: "Straße",
        nonce: 109,
      });
      expect(host.querySelector("output")?.textContent).toBe("In Markdown source");
      expect(highlightMap.get("smd-search-current")).toBeUndefined();
    } finally {
      Object.defineProperty(window, "Highlight", { value: origHighlight, configurable: true, writable: true });
      Object.defineProperty(globalThis, "CSS", { value: origCss, configurable: true, writable: true });
      act(() => root.unmount());
      host.remove();
    }
  });

  it("composes exact-occurrence and stale-range checks with #83 shared regex/whole-word, native shortcuts, windowed blocks, and source mapping", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const origHighlight = (window as typeof window & { Highlight?: unknown }).Highlight;
    const origCss = (globalThis as typeof globalThis & { CSS?: unknown }).CSS;

    class MockHighlight {
      ranges: Range[];
      constructor(...ranges: Range[]) {
        this.ranges = ranges;
      }
    }
    const highlightMap = new Map<string, MockHighlight>();
    Object.defineProperty(window, "Highlight", { value: MockHighlight, configurable: true, writable: true });
    Object.defineProperty(globalThis, "CSS", { value: { highlights: highlightMap }, configurable: true, writable: true });

    try {
      let markdown = [
        "---",
        "title: a+b_header and SharedNeedle",
        "---",
        "",
        "First a+b_one and SharedNeedle intro.",
        "",
        "Check [portal](https://example.com/SharedNeedle) before second A+B_two and SharedNeedle outro.",
      ].join("\n");

      const renderLive = async (
        seed: { query: string; caseSensitive?: boolean; sourceStart?: number; sourceEnd?: number; matchText?: string; nonce: number } | null,
        initialReplace = false,
      ) => {
        await act(async () => {
          root.render(
            <div className="android-document">
              <ReadingSearch
                content={markdown}
                close={() => {}}
                onChange={(next) => { markdown = next; }}
                seed={seed}
                initialReplace={initialReplace}
              />
              <section className="android-reading">
                <LiveEditor markdown={markdown} onChange={(next) => { markdown = next; }} documentPath={null} python="" dark={false} />
              </section>
            </div>
          );
        });
        await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))); });
      };

      // 1. Turn ON #83's Match whole word + Regular expression (even with an invalid regex), then deliver a targeted
      //    folder-search occurrence for "a+b" inside "A+B_two" (2nd body match, non-whole-word + regex metacharacter).
      await renderLive(null);
      const searchInput = host.querySelector<HTMLInputElement>('input[aria-label="Find in note"]')!;
      const wholeWordBtn = host.querySelector<HTMLButtonElement>('button[aria-label="Match whole word"]')!;
      const regexBtn = host.querySelector<HTMLButtonElement>('button[aria-label="Regular expression"]')!;
      act(() => {
        wholeWordBtn.click();
        regexBtn.click();
        setInputValue(searchInput, "([unclosed");
      });
      await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))); });
      expect(host.querySelector("output")?.textContent).toBe("Invalid regular expression");

      const abHits = sourceMatches(markdown, "a+b", false);
      expect(abHits).toHaveLength(3); // 0: frontmatter, 1: a+b_one, 2: A+B_two
      await renderLive({
        query: "a+b",
        caseSensitive: false,
        sourceStart: abHits[2].from,
        sourceEnd: abHits[2].to,
        matchText: "A+B",
        nonce: 201,
      });
      expect(wholeWordBtn.getAttribute("aria-pressed")).toBe("false");
      expect(regexBtn.getAttribute("aria-pressed")).toBe("false");
      expect(host.querySelector("output")?.textContent).toBe("2 / 2");
      expect(highlightMap.get("smd-search-current")?.ranges[0]?.toString()).toBe("A+B");

      // 2. Native shortcuts (F3 / Shift+F3 via supermd-find-step, and Ctrl+H via supermd-find-focus { replace: true })
      //    compose cleanly with hidden-source anchors and YAML frontmatter source mapping.
      const sharedHits = sourceMatches(markdown, "SharedNeedle", true);
      expect(sharedHits).toHaveLength(4); // 0: frontmatter, 1: intro (rendered 1/2), 2: hidden link URL, 3: outro (rendered 2/2)
      await renderLive({
        query: "SharedNeedle",
        caseSensitive: true,
        sourceStart: sharedHits[2].from,
        sourceEnd: sharedHits[2].to,
        matchText: "SharedNeedle",
        nonce: 202,
      });
      expect(host.querySelector("output")?.textContent).toBe("In source · 0 / 2");

      // Shift+F3 from hidden URL steps backward to preceding visible match 1 / 2.
      act(() => { window.dispatchEvent(new CustomEvent("supermd-find-step", { detail: -1 })); });
      expect(host.querySelector("output")?.textContent).toBe("1 / 2");

      // Re-seed hidden URL and press F3 -> steps forward to following visible match 2 / 2.
      await renderLive({
        query: "SharedNeedle",
        caseSensitive: true,
        sourceStart: sharedHits[2].from,
        sourceEnd: sharedHits[2].to,
        matchText: "SharedNeedle",
        nonce: 203,
      });
      expect(host.querySelector("output")?.textContent).toBe("In source · 0 / 2");
      act(() => { window.dispatchEvent(new CustomEvent("supermd-find-step", { detail: 1 })); });
      expect(host.querySelector("output")?.textContent).toBe("2 / 2");

      // Re-seed hidden URL and press Ctrl+H (supermd-find-focus { replace: true }) -> opens Replace mapped to source 3 / 4!
      await renderLive({
        query: "SharedNeedle",
        caseSensitive: true,
        sourceStart: sharedHits[2].from,
        sourceEnd: sharedHits[2].to,
        matchText: "SharedNeedle",
        nonce: 204,
      });
      act(() => { window.dispatchEvent(new CustomEvent("supermd-find-focus", { detail: { replace: true } })); });
      expect(host.querySelector(".search-replace")).not.toBeNull();
      expect(host.querySelector("output")?.textContent).toBe("3 / 4");

      // Stale folder-search range arriving while wholeWord + regexp + Replace are active resets filters and falls back to 1 / 4.
      act(() => {
        wholeWordBtn.click();
        regexBtn.click();
      });
      await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))); });
      await renderLive({
        query: "SharedNeedle",
        caseSensitive: true,
        sourceStart: sharedHits[2].from + 2,
        sourceEnd: sharedHits[2].to + 2,
        matchText: "SharedNeedle",
        nonce: 205,
      }, true);
      expect(wholeWordBtn.getAttribute("aria-pressed")).toBe("false");
      expect(regexBtn.getAttribute("aria-pressed")).toBe("false");
      expect(host.querySelector("output")?.textContent).toBe("1 / 4");

      // 3. Unmounted windowed block occurrence handoff mounts the block, selects exact occurrence, and maps Ctrl+H to source.
      const block0 = "Intro AuroraToken paragraph.";
      const block1 = "Unmounted first AuroraToken and targeted second AuroraToken in windowed block.";
      const windowedDoc = `${block0}\n\n${block1}`;
      const block1Start = block0.length + 2;
      const winHits = sourceMatches(windowedDoc, "AuroraToken", true);
      expect(winHits).toHaveLength(3);

      const renderWindowed = (
        seed: { query: string; caseSensitive?: boolean; sourceStart?: number; sourceEnd?: number; matchText?: string; nonce: number } | null,
      ) =>
        act(async () => {
          root.render(
            <div className="android-document">
              <ReadingSearch
                content={windowedDoc}
                close={() => {}}
                onChange={() => {}}
                seed={seed}
              />
              <section className="android-reading">
                <div className="markdown-body">
                  <div id="win-block-1" data-windowed-block="" data-windowed-mounted="true" data-source-start="0" data-source-end={String(block0.length)}>
                    <p data-source-start="0" data-source-end={String(block0.length)}>{block0}</p>
                  </div>
                  <div id="win-block-2" data-windowed-block="" data-windowed-mounted="false" data-source-start={String(block1Start)} data-source-end={String(windowedDoc.length)} />
                </div>
              </section>
            </div>
          );
        });

      let unregisterWindowed0: (() => void) | null = null;
      let unregisterWindowed1: (() => void) | null = null;
      await renderWindowed(null);
      const winEl0 = host.querySelector<HTMLElement>("#win-block-1")!;
      const winEl = host.querySelector<HTMLElement>("#win-block-2")!;
      unregisterWindowed0 = registerWindowedText(winEl0, block0);
      unregisterWindowed1 = registerWindowedText(winEl, block1);
      winEl.addEventListener("supermd-reveal-window", () => {
        winEl.setAttribute("data-windowed-mounted", "true");
        winEl.innerHTML = `<p data-source-start="${block1Start}" data-source-end="${windowedDoc.length}">${block1}</p>`;
      });
      try {
        await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))); });
        await renderWindowed({
          query: "AuroraToken",
          caseSensitive: true,
          sourceStart: winHits[2].from,
          sourceEnd: winHits[2].to,
          matchText: "AuroraToken",
          nonce: 206,
        });
        await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))); });
        expect(winEl.getAttribute("data-windowed-mounted")).toBe("true");
        expect(host.querySelector("output")?.textContent).toBe("3 / 3");
        expect(highlightMap.get("smd-search-current")?.ranges[0]?.startOffset).toBe(block1.lastIndexOf("AuroraToken"));

        // Ctrl+H preserves 3 / 3 across windowed -> source Replace mode.
        act(() => { window.dispatchEvent(new CustomEvent("supermd-find-focus", { detail: { replace: true } })); });
        expect(host.querySelector("output")?.textContent).toBe("3 / 3");
      } finally {
        unregisterWindowed0?.();
        unregisterWindowed1?.();
      }
    } finally {
      Object.defineProperty(window, "Highlight", { value: origHighlight, configurable: true, writable: true });
      Object.defineProperty(globalThis, "CSS", { value: origCss, configurable: true, writable: true });
      act(() => root.unmount());
      host.remove();
    }
  });
});
