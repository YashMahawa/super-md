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

  it("maps displayed metadata and body matches accurately across YAML frontmatter when toggling Replace in source", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    let current = "---\ntags: [alpha-tag, beta-tag]\nauthor: Dr. Alpha\ndescription: Hidden Alpha Note\ntitle: Alpha Study\n---\n\n# Heading\n\nAlpha body.";
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

    // Rendered search includes displayed title, author, and tags (3 matches) + 1 body match = 4, excluding description.
    expect(host.querySelector("output")?.textContent).toBe("0 / 4");
    const nextButton = host.querySelector<HTMLButtonElement>('button[aria-label="Next match"]')!;
    // Match 1 in DOM order is displayed title ("Alpha Study"), which is source match 4 / 5 in YAML key order!
    act(() => nextButton.click());
    expect(host.querySelector("output")?.textContent).toBe("1 / 4");
    const replaceToggle = host.querySelector<HTMLButtonElement>('button[aria-label="Replace in source"]')!;
    act(() => replaceToggle.click());
    expect(host.querySelector("output")?.textContent).toBe("4 / 5");
    // Toggle Replace back off -> returns to 1 / 4!
    act(() => replaceToggle.click());
    expect(host.querySelector("output")?.textContent).toBe("1 / 4");

    // Step to match 4 / 4 (Alpha body.) and toggle Replace in source -> maps to source match 5 / 5!
    act(() => nextButton.click()); // 2 / 4 (author: Dr. Alpha)
    act(() => nextButton.click()); // 3 / 4 (tag: alpha-tag)
    act(() => nextButton.click()); // 4 / 4 (Alpha body.)
    expect(host.querySelector("output")?.textContent).toBe("4 / 4");
    act(() => replaceToggle.click());
    expect(host.querySelector("output")?.textContent).toBe("5 / 5");

    const replaceInput = host.querySelector<HTMLInputElement>('input[aria-label="Replacement text"]')!;
    const buttons = Array.from(host.querySelectorAll<HTMLButtonElement>(".search-replace button"));
    act(() => setInputValue(replaceInput, "Beta"));
    act(() => buttons[0].click());
    expect(changes.at(-1)).toBe("---\ntags: [alpha-tag, beta-tag]\nauthor: Dr. Alpha\ndescription: Hidden Alpha Note\ntitle: Alpha Study\n---\n\n# Heading\n\nBeta body.");

    act(() => root.unmount());
    host.remove();
  });

  it("maps quoted, folded, flow, and duplicate frontmatter values across Replace in source while redacting hidden fields", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    let current = [
      "---",
      "subtitle: Hidden Orbit Subtitle",
      "tags: ['orbit-one', \"orbit-two\", orbit-one]",
      "author:",
      "  - { given: \"Ada\", family: \"Orbit\" }",
      "  - \"Ada Orbit\"",
      "  - 'Grace Orbit'",
      "description: >",
      "  Hidden Orbit description",
      "title: >-",
      "  Folded Orbit",
      "  Atlas",
      "aliases: [OrbitAlias]",
      "---",
      "",
      "Body Orbit conclusion.",
    ].join("\n");
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
    act(() => setInputValue(searchInput, "Orbit"));
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))); });

    // Rendered matches:
    // 1: title ("Folded Orbit Atlas")
    // 2: author #1 ("Ada Orbit", deduplicated)
    // 3: author #2 ("Grace Orbit")
    // 4: tag #1 ('orbit-one', deduplicated)
    // 5: tag #2 ("orbit-two")
    // 6: body ("Body Orbit conclusion.")
    // Excluded from rendered Find: subtitle, duplicate tag 'orbit-one', duplicate author "Ada Orbit", description, aliases.
    expect(host.querySelector("output")?.textContent).toBe("0 / 6");

    const nextButton = host.querySelector<HTMLButtonElement>('button[aria-label="Next match"]')!;
    const replaceToggle = host.querySelector<HTMLButtonElement>('button[aria-label="Replace in source"]')!;

    // Step to match 3 / 6 ("Grace Orbit" — second author in the single <dd data-frontmatter-field="author">)
    act(() => nextButton.click()); // 1 / 6: folded title
    act(() => nextButton.click()); // 2 / 6: flow author Ada Orbit
    act(() => nextButton.click()); // 3 / 6: quoted author Grace Orbit
    expect(host.querySelector("output")?.textContent).toBe("3 / 6");

    // Source matches for "Orbit" (11 total):
    // 0: subtitle, 1: 'orbit-one', 2: "orbit-two", 3: duplicate orbit-one,
    // 4: { family: "Orbit" }, 5: duplicate "Ada Orbit", 6: 'Grace Orbit',
    // 7: description, 8: folded title, 9: OrbitAlias, 10: Body Orbit
    // Match 3 / 6 ('Grace Orbit') maps to source index 6 -> "7 / 11"!
    act(() => replaceToggle.click());
    expect(host.querySelector("output")?.textContent).toBe("7 / 11");
    act(() => replaceToggle.click());
    expect(host.querySelector("output")?.textContent).toBe("3 / 6");

    // Step to match 5 / 6 ("orbit-two" tag after deduplicated 'orbit-one') -> source index 2 -> "3 / 11"!
    act(() => nextButton.click()); // 4 / 6: 'orbit-one'
    act(() => nextButton.click()); // 5 / 6: "orbit-two"
    expect(host.querySelector("output")?.textContent).toBe("5 / 6");
    act(() => replaceToggle.click());
    expect(host.querySelector("output")?.textContent).toBe("3 / 11");

    const replaceInput = host.querySelector<HTMLInputElement>('input[aria-label="Replacement text"]')!;
    const buttons = Array.from(host.querySelectorAll<HTMLButtonElement>(".search-replace button"));
    act(() => setInputValue(replaceInput, "phase"));
    act(() => buttons[0].click());
    expect(changes.at(-1)).toContain('tags: [\'orbit-one\', "phase-two", orbit-one]');

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
      "description: HiddenFrontmatterToken and SharedNeedle",
      "---",
      "",
      "First visible SharedNeedle paragraph.",
      "",
      "Middle paragraph with [portal](https://example.com/SharedNeedle) and [spec](https://example.com/OnlyInHiddenUrl).",
      "",
      "Last visible SharedNeedle paragraph.",
    ].join("\n");

    const sharedRanges = sourceMatches(markdown, "SharedNeedle", true);
    // 0: YAML hidden frontmatter description (hidden)
    // 1: First visible paragraph (rendered 1 / 2)
    // 2: Link URL https://example.com/SharedNeedle (hidden)
    // 3: Last visible paragraph (rendered 2 / 2)
    expect(sharedRanges).toHaveLength(4);
    const hiddenFmOnlyRanges = sourceMatches(markdown, "HiddenFrontmatterToken", true);
    expect(hiddenFmOnlyRanges).toHaveLength(1);
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

      // Hidden-only URL match and hidden frontmatter description match show "In Markdown source" rather than misleading "No matches".
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

      await act(async () => {
        root.render(
          <div className="android-document">
            <ReadingSearch
              content={markdown}
              close={() => {}}
              seed={{
                query: "HiddenFrontmatterToken",
                caseSensitive: true,
                sourceStart: hiddenFmOnlyRanges[0].from,
                sourceEnd: hiddenFmOnlyRanges[0].to,
                nonce: 115,
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

      // Displayed frontmatter fields (#119: title, author, tags) select their rendered DOM match directly,
      // while hidden frontmatter fields (description) surface "In source · 0 / N" and step into visible matches!
      const mixedFrontmatter = [
        "---",
        "tags: [SharedTag]",
        "description: Hidden SharedTag note",
        "title: SharedTag Große Straße",
        "---",
        "",
        "Body SharedTag conclusion.",
      ].join("\n");
      const tagHits = sourceMatches(mixedFrontmatter, "SharedTag", true);
      // Source order: 0 = tags (rendered 2/3), 1 = description (hidden), 2 = title (rendered 1/3), 3 = body (rendered 3/3)
      expect(tagHits).toHaveLength(4);
      await act(async () => {
        root.render(
          <div className="android-document">
            <ReadingSearch
              content={mixedFrontmatter}
              close={() => {}}
              seed={{
                query: "SharedTag",
                caseSensitive: true,
                sourceStart: tagHits[0].from,
                sourceEnd: tagHits[0].to,
                matchText: "SharedTag",
                nonce: 116,
              }}
            />
            <section className="android-reading">
              <LiveEditor markdown={mixedFrontmatter} onChange={() => {}} documentPath={null} python="" dark={false} />
            </section>
          </div>
        );
      });
      await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))); });
      expect(host.querySelector("output")?.textContent).toBe("2 / 3");

      await act(async () => {
        root.render(
          <div className="android-document">
            <ReadingSearch
              content={mixedFrontmatter}
              close={() => {}}
              seed={{
                query: "SharedTag",
                caseSensitive: true,
                sourceStart: tagHits[1].from,
                sourceEnd: tagHits[1].to,
                matchText: "SharedTag",
                nonce: 117,
              }}
            />
            <section className="android-reading">
              <LiveEditor markdown={mixedFrontmatter} onChange={() => {}} documentPath={null} python="" dark={false} />
            </section>
          </div>
        );
      });
      await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))); });
      expect(host.querySelector("output")?.textContent).toBe("In source · 0 / 3");

      const titleStrasseFrom = mixedFrontmatter.indexOf("Straße");
      await act(async () => {
        root.render(
          <div className="android-document">
            <ReadingSearch
              content={mixedFrontmatter}
              close={() => {}}
              seed={{
                query: "strasse",
                caseSensitive: false,
                sourceStart: titleStrasseFrom,
                sourceEnd: titleStrasseFrom + "Straße".length,
                matchText: "Straße",
                nonce: 118,
              }}
            />
            <section className="android-reading">
              <LiveEditor markdown={mixedFrontmatter} onChange={() => {}} documentPath={null} python="" dark={false} />
            </section>
          </div>
        );
      });
      await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))); });
      expect(host.querySelector("output")?.textContent).toBe("1 / 1");

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
        "description: a+b_header and SharedNeedle",
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

  it("preserves windowed DOM-order navigation and unmounted source-range mapping when toggling Replace in source", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const scrolled: Element[] = [];
    const origScroll = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function () { scrolled.push(this); };

    const part0 = "## First\n\nTarget alpha.";
    const part1 = "## Second\n\nTarget beta.";
    const part2 = "## Third\n\nTarget gamma.";
    let current = `${part0}\n\n${part1}\n\n${part2}`;
    const start0 = 0, end0 = part0.length;
    const start1 = end0 + 2, end1 = start1 + part1.length;
    const start2 = end1 + 2, end2 = start2 + part2.length;
    const changes: string[] = [];

    const renderWindowed = () => {
      root.render(
        <div className="android-document">
          <ReadingSearch content={current} close={() => {}} onChange={(next) => { current = next; changes.push(next); }} />
          <section className="android-reading">
            <div className="markdown-body">
              <section data-windowed-block="" data-windowed-mounted="true" data-source-start={start0} data-source-end={end0}>
                <h2>First</h2><p>Target alpha.</p>
              </section>
              <section data-windowed-block="" data-windowed-mounted="false" data-source-start={start1} data-source-end={end1}>
                <span aria-hidden="true" />
              </section>
              <section data-windowed-block="" data-windowed-mounted="false" data-source-start={start2} data-source-end={end2}>
                <span aria-hidden="true" />
              </section>
            </div>
          </section>
        </div>
      );
    };

    try {
      await act(async () => { renderWindowed(); });
      const sections = Array.from(host.querySelectorAll<HTMLElement>("[data-windowed-block]"));
      // Register out of DOM order (`sections[2]`, `sections[1]`, then `sections[0]`) to simulate Live block edits.
      const cleanups = [
        registerWindowedText(sections[2], "Third\nTarget gamma.\n"),
        registerWindowedText(sections[1], "Second\nTarget beta.\n"),
        registerWindowedText(sections[0], "First\nTarget alpha.\n"),
      ];
      let revealedSection: HTMLElement | null = null;
      sections[1].addEventListener("supermd-reveal-window", () => {
        revealedSection = sections[1];
        sections[1].setAttribute("data-windowed-mounted", "true");
        sections[1].innerHTML = "<h2>Second</h2><p>Target beta.</p>";
      });
      sections[2].addEventListener("supermd-reveal-window", () => {
        sections[2].setAttribute("data-windowed-mounted", "true");
        sections[2].innerHTML = `<h2 data-source-start="${start2}" data-source-end="${start2 + 8}">Third</h2><p data-source-start="${start2 + 10}" data-source-end="${end2}">Target gamma.</p>`;
      });

      const searchInput = host.querySelector<HTMLInputElement>('input[aria-label="Find in note"]')!;
      act(() => setInputValue(searchInput, "Target"));
      await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))); });
      expect(host.querySelector("output")?.textContent).toBe("0 / 3");

      // Step forward twice: 1 / 3 is sections[0], 2 / 3 reveals unmounted sections[1] in DOM order (not registration order).
      const nextBtn = host.querySelector<HTMLButtonElement>('button[aria-label="Next match"]')!;
      act(() => nextBtn.click());
      expect(host.querySelector("output")?.textContent).toBe("1 / 3");
      expect(revealedSection).toBeNull();

      act(() => nextBtn.click());
      expect(host.querySelector("output")?.textContent).toBe("2 / 3");
      expect(revealedSection).toBe(sections[1]);

      // Toggle Replace at 2 / 3 and replace only second match.
      const replaceToggle = host.querySelector<HTMLButtonElement>('button[aria-label="Replace in source"]')!;
      act(() => replaceToggle.click());
      expect(host.querySelector("output")?.textContent).toBe("2 / 3");

      // Toggling Replace off and back on preserves 2 / 3 synchronously.
      act(() => replaceToggle.click());
      expect(host.querySelector("output")?.textContent).toBe("2 / 3");
      act(() => replaceToggle.click());
      expect(host.querySelector("output")?.textContent).toBe("2 / 3");

      const replaceInput = host.querySelector<HTMLInputElement>('input[aria-label="Replacement text"]')!;
      const replaceSingle = () => host.querySelectorAll<HTMLButtonElement>(".search-replace button")[0];
      act(() => setInputValue(replaceInput, "Updated"));
      act(() => replaceSingle().click());
      expect(changes.at(-1)).toBe("## First\n\nTarget alpha.\n\n## Second\n\nUpdated beta.\n\n## Third\n\nTarget gamma.");

      // Also verify #83 regex + capture-group replacement across the remaining unmounted block in DOM order,
      // including 2-rAF settle re-scrolling when unmounted sections[2] mounts.
      await act(async () => { renderWindowed(); });
      const regexBtn = host.querySelector<HTMLButtonElement>('button[aria-label="Regular expression"]')!;
      const wholeWordBtn = host.querySelector<HTMLButtonElement>('button[aria-label="Match whole word"]')!;
      act(() => regexBtn.click());
      act(() => wholeWordBtn.click());
      act(() => setInputValue(searchInput, "Target (\\w+)"));
      await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))); });
      expect(host.querySelector("output")?.textContent).toBe("0 / 2");
      sections[2].setAttribute("data-windowed-mounted", "false");
      sections[2].innerHTML = '<span aria-hidden="true" />';
      scrolled.length = 0;
      const prevBtn = host.querySelector<HTMLButtonElement>('button[aria-label="Previous match"]')!;
      act(() => prevBtn.click());
      expect(host.querySelector("output")?.textContent).toBe("2 / 2");
      expect(sections[2].getAttribute("data-windowed-mounted")).toBe("true");
      const syncScrollCount = scrolled.length;
      expect(syncScrollCount).toBeGreaterThanOrEqual(1);
      await act(async () => {
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(undefined))));
      });
      expect(scrolled.length).toBeGreaterThan(syncScrollCount);
      act(() => setInputValue(replaceInput, "Rewritten-$1"));
      act(() => replaceSingle().click());
      expect(changes.at(-1)).toBe("## First\n\nTarget alpha.\n\n## Second\n\nUpdated beta.\n\n## Third\n\nRewritten-gamma.");

      cleanups.forEach((fn) => fn());
    } finally {
      Element.prototype.scrollIntoView = origScroll;
      act(() => root.unmount());
      host.remove();
    }
  });

  it("re-aligns offscreen source reveals across multi-wave window layout changes and cancels on newer selection or manual scroll", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    const part0 = "## Intro\n\ntoken-01 start.";
    const part1 = "## Middle\n\ntoken-25 middle.";
    const part2 = "## Tail\n\ntoken-45 tail.";
    let current = `${part0}\n\n${part1}\n\n${part2}`;
    const computeOffsets = (text: string) => {
      const blocks = text.split("\n\n## ").map((chunk, idx) => (idx === 0 ? chunk : `## ${chunk}`));
      const starts: number[] = [];
      const ends: number[] = [];
      let cursor = 0;
      for (const b of blocks) {
        starts.push(cursor);
        ends.push(cursor + b.length);
        cursor += b.length + 2;
      }
      return { starts, ends };
    };

    const scrollTargets: Element[] = [];
    const origScrollIntoView = Element.prototype.scrollIntoView;
    let simulatedScrollHeight = 12000;
    let simulatedScrollTop = 0;

    const renderScene = () => {
      const { starts, ends } = computeOffsets(current);
      root.render(
        <div className="android-document">
          <ReadingSearch
            content={current}
            close={() => {}}
            initialReplace
            onChange={(next) => {
              current = next;
              renderScene();
            }}
          />
          <section className="android-reading">
            <div className="document-page">
              <div className="markdown-body">
                <section data-windowed-block="" data-windowed-mounted="true" data-source-start={starts[0]} data-source-end={ends[0]}>
                  <h2>Intro</h2><p>{current.slice(starts[0], ends[0]).split("\n\n")[1]}</p>
                </section>
                <section data-windowed-block="" data-windowed-mounted="false" data-source-start={starts[1]} data-source-end={ends[1]}>
                  <span aria-hidden="true" />
                </section>
                <section data-windowed-block="" data-windowed-mounted="false" data-source-start={starts[2]} data-source-end={ends[2]}>
                  <span aria-hidden="true" />
                </section>
              </div>
            </div>
          </section>
        </div>
      );
    };

    try {
      await act(async () => { renderScene(); });
      const scroller = host.querySelector<HTMLElement>(".android-reading")!;
      Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => simulatedScrollHeight });
      Object.defineProperty(scroller, "scrollTop", {
        configurable: true,
        get: () => simulatedScrollTop,
        set: (v: number) => { simulatedScrollTop = v; },
      });
      Element.prototype.scrollIntoView = function () {
        scrollTargets.push(this);
        simulatedScrollTop = 5000;
      };

      const sections = () => Array.from(host.querySelectorAll<HTMLElement>("[data-windowed-block]"));
      const attachReveal = (idx: number, heading: string, bodyFn: () => string) => {
        const el = sections()[idx];
        el.addEventListener("supermd-reveal-window", () => {
          el.setAttribute("data-windowed-mounted", "true");
          el.innerHTML = `<h2>${heading}</h2><p>${bodyFn()}</p>`;
        });
      };
      attachReveal(1, "Middle", () => "token-25 middle.");
      attachReveal(2, "Tail", () => "token-45 tail.");

      const searchInput = host.querySelector<HTMLInputElement>('input[aria-label="Find in note"]')!;
      act(() => setInputValue(searchInput, "token-\\d+"));
      const regexBtn = host.querySelector<HTMLButtonElement>('button[aria-label="Regular expression"]')!;
      act(() => regexBtn.click());
      await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))); });
      expect(host.querySelector("output")?.textContent).toBe("0 / 3");

      const nextBtn = host.querySelector<HTMLButtonElement>('button[aria-label="Next match"]')!;
      // Step to 1 / 3 (Intro), then 2 / 3 (offscreen Middle / token-25).
      act(() => nextBtn.click());
      scrollTargets.length = 0;
      act(() => nextBtn.click());
      expect(host.querySelector("output")?.textContent).toBe("2 / 3");
      expect(sections()[1].getAttribute("data-windowed-mounted")).toBe("true");
      expect(scrollTargets.length).toBeGreaterThanOrEqual(1);

      // Drain initial RAF chain, then simulate delayed multi-wave WindowedBlock shrinkage.
      for (let i = 0; i < 5; i++) {
        await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))); });
      }
      scrollTargets.length = 0;
      simulatedScrollHeight = 11100;
      act(() => { scroller.dispatchEvent(new Event("supermd-window-change")); });
      await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))); });
      expect(scrollTargets.length).toBe(1);
      expect(scrollTargets[0].textContent).toContain("token-25");

      // Wave 2 shrinkage also re-aligns token-25.
      scrollTargets.length = 0;
      simulatedScrollHeight = 10400;
      act(() => { scroller.dispatchEvent(new Event("supermd-window-change")); });
      await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))); });
      expect(scrollTargets.length).toBe(1);
      expect(scrollTargets[0].textContent).toContain("token-25");

      // Manual wheel scroll cancels further settle passes immediately.
      scrollTargets.length = 0;
      act(() => { scroller.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 120 })); });
      simulatedScrollHeight = 9900;
      act(() => { scroller.dispatchEvent(new Event("supermd-window-change")); });
      await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))); });
      expect(scrollTargets.length).toBe(0);

      // Single Replace on 2 / 3 advances to 2 / 2 (Tail / token-45), settles across window changes,
      // and cancels if the user manually scrolls scroller.scrollTop.
      const replaceInput = host.querySelector<HTMLInputElement>('input[aria-label="Replacement text"]')!;
      act(() => setInputValue(replaceInput, "item-done"));
      const replaceSingle = host.querySelectorAll<HTMLButtonElement>(".search-replace button")[0];
      await act(async () => { replaceSingle.click(); });
      attachReveal(2, "Tail", () => "token-45 tail.");
      await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))); });
      expect(host.querySelector("output")?.textContent).toBe("2 / 2");
      expect(sections()[2].getAttribute("data-windowed-mounted")).toBe("true");

      for (let i = 0; i < 5; i++) {
        await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))); });
      }
      scrollTargets.length = 0;
      simulatedScrollHeight = 9200;
      act(() => { scroller.dispatchEvent(new Event("supermd-window-change")); });
      await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))); });
      expect(scrollTargets.length).toBe(1);
      expect(scrollTargets[0].textContent).toContain("token-45");

      // Newer selection (stepping to 1 / 2) cancels Tail settling and switches target to Intro.
      act(() => nextBtn.click());
      expect(host.querySelector("output")?.textContent).toBe("1 / 2");
      for (let i = 0; i < 5; i++) {
        await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))); });
      }
      scrollTargets.length = 0;
      // Direct manual scrollTop change + scroll event cancels active Intro settle.
      simulatedScrollTop = 1234;
      act(() => { scroller.dispatchEvent(new Event("scroll")); });
      simulatedScrollHeight = 8800;
      act(() => { scroller.dispatchEvent(new Event("supermd-window-change")); });
      await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))); });
      expect(scrollTargets.length).toBe(0);
    } finally {
      Element.prototype.scrollIntoView = origScrollIntoView;
      act(() => root.unmount());
      host.remove();
    }
  });
});
