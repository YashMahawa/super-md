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

  it("maps Find and Replace offsets accurately across U+00A0 frontmatter keys, quoted values, flow maps, and sequence/flow tags", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    let current = [
      "---",
      "description: \u00a0\"Hidden Symmetry Description\"",
      "\"tags\"\u00a0:",
      "  - \u00a0'symmetry-seq'",
      "keywords: \u00a0[\u00a0\"symmetry-flow\"\u00a0]",
      "'author'\u00a0: \u00a0[\u00a0{\u00a0\"given\"\u00a0:\u00a0\"Emmy\",\u00a0'family'\u00a0:\u00a0'Symmetry'\u00a0}\u00a0]",
      "\"title\"\u00a0: \u00a0\"Symmetry Kernel\"",
      "---",
      "",
      "Body Symmetry note.",
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

    // Displayed title omits surrounding quotes and displayed tags render as individual badges (not a raw "[...]" string).
    expect(host.querySelector('[data-frontmatter-field="title"]')?.textContent).toBe("Symmetry Kernel");
    expect(host.querySelector('[data-frontmatter-field="author"]')?.textContent).toBe("Emmy Symmetry");
    expect(Array.from(host.querySelectorAll('[data-frontmatter-field="tag"]')).map((el) => el.textContent)).toEqual([
      "symmetry-seq",
      "symmetry-flow",
    ]);

    const searchInput = host.querySelector<HTMLInputElement>('input[aria-label="Find in note"]')!;
    act(() => setInputValue(searchInput, "Symmetry"));
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))); });

    // 5 rendered matches (title, author, seq tag, flow tag, body), excluding hidden description.
    expect(host.querySelector("output")?.textContent).toBe("0 / 5");
    const nextButton = host.querySelector<HTMLButtonElement>('button[aria-label="Next match"]')!;
    const replaceToggle = host.querySelector<HTMLButtonElement>('button[aria-label="Replace in source"]')!;

    // Match 1 / 5 (displayed title "Symmetry Kernel") maps to source match 5 / 6 (after description, seq tag, flow tag, author).
    act(() => nextButton.click());
    expect(host.querySelector("output")?.textContent).toBe("1 / 5");
    act(() => replaceToggle.click());
    expect(host.querySelector("output")?.textContent).toBe("5 / 6");

    const replaceInput = host.querySelector<HTMLInputElement>('input[aria-label="Replacement text"]')!;
    const replaceButtons = () => Array.from(host.querySelectorAll<HTMLButtonElement>(".search-replace button"));
    act(() => setInputValue(replaceInput, "Invariant"));
    act(() => replaceButtons()[0].click());
    expect(changes.at(-1)).toContain("\"title\"\u00a0: \u00a0\"Invariant Kernel\"");

    // Re-render updated content and verify Replace offset mapping on sequence and flow tags.
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

    // Toggle Replace off, step to flow tag ("symmetry-flow" — rendered match 3 / 4: author, seq tag, flow tag, body) -> source match 3 / 5.
    act(() => replaceToggle.click());
    expect(host.querySelector("output")?.textContent).toBe("4 / 4");
    act(() => nextButton.click()); // 1 / 4 (author: Emmy Symmetry)
    act(() => nextButton.click()); // 2 / 4 (seq tag: symmetry-seq)
    act(() => nextButton.click()); // 3 / 4 (flow tag: symmetry-flow)
    expect(host.querySelector("output")?.textContent).toBe("3 / 4");
    act(() => replaceToggle.click());
    expect(host.querySelector("output")?.textContent).toBe("3 / 5");
    const nextReplaceInput = host.querySelector<HTMLInputElement>('input[aria-label="Replacement text"]')!;
    act(() => setInputValue(nextReplaceInput, "invariant"));
    act(() => replaceButtons()[0].click());
    expect(changes.at(-1)).toContain("keywords: \u00a0[\u00a0\"invariant-flow\"\u00a0]");
    expect(changes.at(-1)).toContain("  - \u00a0'symmetry-seq'");
    expect(changes.at(-1)).toContain("description: \u00a0\"Hidden Symmetry Description\"");

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

  it("falls back passively on stale offsets from same-offset replacement or prior insertion without jumping to a different occurrence while keeping valid Unicode-folded and hidden-source hits", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const origHighlight = (window as typeof window & { Highlight?: unknown }).Highlight;
    const origCss = (globalThis as typeof globalThis & { CSS?: unknown }).CSS;
    const scrolled: Element[] = [];
    const origScroll = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function () { scrolled.push(this); };

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
        scrolled.length = 0;
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
      expect(host.querySelector("output")?.textContent).toBe("0 / 1");
      expect(highlightMap.get("smd-search-current")).toBeUndefined();
      expect(highlightMap.get("smd-search")?.ranges.map(r => r.toString())).toEqual(["AuroraSignal"]);
      expect(scrolled).toHaveLength(0);

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
      expect(scrolled).toHaveLength(0);

      // 1c. Source/Split session with stale replacement at same offsets stays passive at 0 / 2 without jumping to occurrence 1.
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
      expect(host.querySelector("output")?.textContent).toBe("0 / 2");
      expect(highlightMap.get("smd-search-current")).toBeUndefined();
      expect(scrolled).toHaveLength(0);

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
      expect(host.querySelector("output")?.textContent).toBe("0 / 2");
      expect(highlightMap.get("smd-search-current")).toBeUndefined();
      expect(highlightMap.get("smd-search")?.ranges.map(r => r.toString())).toEqual(["AuroraSignal", "AuroraSignal"]);
      expect(scrolled).toHaveLength(0);

      // Partially overlapping 3-char insertion before old offset (shifts "AuroraSignal" by +3 so old [from, to) overlaps new [from+3, to+3)):
      const overlappingInsertNote = "Hi " + scannedNote;
      await renderNote(overlappingInsertNote, {
        query: "AuroraSignal",
        caseSensitive: false,
        sourceStart: scannedHits[1].from,
        sourceEnd: scannedHits[1].to,
        nonce: 105,
      });
      expect(host.querySelector("output")?.textContent).toBe("0 / 2");
      expect(highlightMap.get("smd-search-current")).toBeUndefined();
      expect(scrolled).toHaveLength(0);

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
      expect(host.querySelector("output")?.textContent).toBe("0 / 2");
      expect(highlightMap.get("smd-search-current")).toBeUndefined();
      expect(scrolled).toHaveLength(0);

      // 2c. Shortened note where old seedRange extends past EOF (previously clamped to content.length):
      await renderNote("Short AuroraSignal.", {
        query: "AuroraSignal",
        caseSensitive: false,
        sourceStart: 12,
        sourceEnd: 500,
        matchText: "AuroraSignal",
        nonce: 107,
      });
      expect(host.querySelector("output")?.textContent).toBe("0 / 1");
      expect(highlightMap.get("smd-search-current")).toBeUndefined();
      expect(scrolled).toHaveLength(0);

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
      Element.prototype.scrollIntoView = origScroll;
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

      // Stale folder-search range arriving while wholeWord + regexp + Replace are active resets filters and stays passive at 0 / 4 without jumping.
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
      expect(host.querySelector("output")?.textContent).toBe("0 / 4");
      expect(highlightMap.get("smd-search-current")).toBeUndefined();

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

  it("scrolls precise Range coordinates into the unobstructed band below .reading-search in tall blocks and top lines", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    const tallLines = Array.from({ length: 120 }, (_, i) => (i === 0 ? "Line 0 TopToken" : i === 115 ? "Line 115 DeepToken" : `Line ${i} filler`));
    const content = `# TopToken Heading\n\n\`\`\`txt\n${tallLines.join("\n")}\n\`\`\``;

    await act(async () => {
      root.render(
        <div className="android-document">
          <ReadingSearch content={content} close={() => {}} onChange={() => {}} />
          <section className="android-reading">
            <div className="markdown-body">
              <h1 data-source-start="0" data-source-end="18">TopToken Heading</h1>
              <pre data-source-start="20" data-source-end={String(content.length)}><code>{tallLines.join("\n")}</code></pre>
            </div>
          </section>
        </div>,
      );
    });

    const scroller = host.querySelector<HTMLElement>(".android-reading")!;
    const searchBar = host.querySelector<HTMLElement>(".reading-search")!;
    const heading = host.querySelector<HTMLElement>("h1")!;
    const codeEl = host.querySelector<HTMLElement>("code")!;

    let barHeight = 76;
    const getClearance = () => parseFloat(scroller.style.paddingTop || "0") || 0;
    searchBar.getBoundingClientRect = () => new DOMRect(24, 12, 720, barHeight);
    scroller.getBoundingClientRect = () => new DOMRect(0, 0, 800, 600);
    heading.getBoundingClientRect = () => new DOMRect(40, 24 + getClearance() - scroller.scrollTop, 400, 32);
    // Code block is 2,400px tall; centering the element would leave line 0 and line 115 offscreen.
    codeEl.getBoundingClientRect = () => new DOMRect(40, 100 + getClearance() - scroller.scrollTop, 600, 2400);

    const origGetClientRects = Range.prototype.getClientRects;
    const origGetBoundingRect = Range.prototype.getBoundingClientRect;
    const computeRangeRect = (range: Range): DOMRect => {
      const text = range.startContainer.textContent || "";
      if (heading.contains(range.startContainer)) {
        return new DOMRect(40, 24 + getClearance() - scroller.scrollTop, 90, 28);
      }
      const lineIdx = text.slice(0, range.startOffset).split("\n").length - 1;
      return new DOMRect(40, 100 + getClearance() + lineIdx * 20 - scroller.scrollTop, 110, 20);
    };
    Range.prototype.getBoundingClientRect = function () { return computeRangeRect(this); };
    Range.prototype.getClientRects = function () {
      const r = computeRangeRect(this);
      return Object.assign([r], { item: (idx: number) => (idx === 0 ? r : null) }) as unknown as DOMRectList;
    };

    try {
      const searchInput = host.querySelector<HTMLInputElement>('input[aria-label="Find in note"]')!;
      act(() => setInputValue(searchInput, "DeepToken"));
      await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))); });

      const nextBtn = host.querySelector<HTMLButtonElement>('button[aria-label="Next match"]')!;
      act(() => nextBtn.click());
      expect(host.querySelector("output")?.textContent).toBe("1 / 1");

      // Line 115 sits at document y = 100 + 2300 = 2400px; precise Range scroll brings it into [100, 584], not element center (1300px).
      const deepRectY = 100 + getClearance() + 115 * 20 - scroller.scrollTop;
      expect(deepRectY).toBeGreaterThanOrEqual(12 + barHeight + 12);
      expect(deepRectY + 20).toBeLessThanOrEqual(600 - 16);

      // Now search TopToken at the very top of the note (y = 24px < searchBar.bottom = 88px).
      act(() => setInputValue(searchInput, "TopToken"));
      await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))); });
      act(() => nextBtn.click());
      expect(host.querySelector("output")?.textContent).toBe("1 / 2");

      const topMatchY = 24 + getClearance() - scroller.scrollTop;
      expect(topMatchY).toBeGreaterThanOrEqual(12 + barHeight + 12);

      // Expanding Replace increases .reading-search height and keeps the selected top match unobstructed.
      barHeight = 148;
      const replaceToggle = host.querySelector<HTMLButtonElement>('button[aria-label="Replace in source"]')!;
      act(() => replaceToggle.click());
      const expandedTopMatchY = 24 + getClearance() - scroller.scrollTop;
      expect(expandedTopMatchY).toBeGreaterThanOrEqual(12 + barHeight + 12);

      // Stepping to the second TopToken match deeper in the code block (if deeper than visibleTop) or searching DeepToken releases temporary top clearance automatically.
      act(() => setInputValue(searchInput, "DeepToken"));
      await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))); });
      act(() => nextBtn.click());
      expect(scroller.style.paddingTop).toBe("");

      // Unmounting ReadingSearch leaves scroller clean.
      act(() => root.unmount());
      expect(scroller.style.paddingTop).toBe("");
    } finally {
      Range.prototype.getClientRects = origGetClientRects;
      Range.prototype.getBoundingClientRect = origGetBoundingRect;
      host.remove();
    }
  });

  it("scrolls nested scrollable Python source containers and isolates .android-reading clearance onto .reader-chrome-spacer", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    const pyLines = Array.from({ length: 100 }, (_, i) => (i === 99 ? "print('PYTHON-END-99')" : `x_${i} = ${i}`));
    const content = `# TopHeader\n\n\`\`\`python\n${pyLines.join("\n")}\n\`\`\``;

    await act(async () => {
      root.render(
        <div className="android-document">
          <ReadingSearch content={content} close={() => {}} onChange={() => {}} />
          <section className="android-reading">
            <div className="reader-chrome-spacer" aria-hidden="true" />
            <div className="document-page-space">
              <div className="document-page">
                <div className="markdown-body">
                  <h1>TopHeader</h1>
                  <pre className="python-source" aria-label="Python source" style={{ overflowY: "auto" }}>
                    {pyLines.join("\n")}
                  </pre>
                </div>
              </div>
            </div>
          </section>
        </div>,
      );
    });

    const scroller = host.querySelector<HTMLElement>(".android-reading")!;
    const spacer = host.querySelector<HTMLElement>(".reader-chrome-spacer")!;
    const searchBar = host.querySelector<HTMLElement>(".reading-search")!;
    const heading = host.querySelector<HTMLElement>("h1")!;
    const pySource = host.querySelector<HTMLElement>("pre.python-source")!;

    Object.defineProperty(pySource, "clientHeight", { configurable: true, value: 240 });
    Object.defineProperty(pySource, "scrollHeight", { configurable: true, value: 2000 });

    const getSpacerMargin = () => parseFloat(spacer.style.marginBottom || "0") || 0;
    searchBar.getBoundingClientRect = () => new DOMRect(24, 12, 720, 76);
    scroller.getBoundingClientRect = () => new DOMRect(0, 0, 800, 600);
    heading.getBoundingClientRect = () => new DOMRect(40, 24 + getSpacerMargin() - scroller.scrollTop, 400, 32);
    pySource.getBoundingClientRect = () => new DOMRect(40, 500 + getSpacerMargin() - scroller.scrollTop, 600, 240);

    const origGetClientRects = Range.prototype.getClientRects;
    const origGetBoundingRect = Range.prototype.getBoundingClientRect;
    const computeRangeRect = (range: Range): DOMRect => {
      if (heading.contains(range.startContainer)) {
        return new DOMRect(40, 24 + getSpacerMargin() - scroller.scrollTop, 120, 28);
      }
      const text = range.startContainer.textContent || "";
      const lineIdx = text.slice(0, range.startOffset).split("\n").length - 1;
      const pyTop = 500 + getSpacerMargin() - scroller.scrollTop;
      return new DOMRect(48, pyTop + lineIdx * 20 - pySource.scrollTop, 160, 20);
    };
    Range.prototype.getBoundingClientRect = function () { return computeRangeRect(this); };
    Range.prototype.getClientRects = function () {
      const r = computeRangeRect(this);
      return Object.assign([r], { item: (idx: number) => (idx === 0 ? r : null) }) as unknown as DOMRectList;
    };

    try {
      const searchInput = host.querySelector<HTMLInputElement>('input[aria-label="Find in note"]')!;
      const nextBtn = host.querySelector<HTMLButtonElement>('button[aria-label="Next match"]')!;

      // Top match uses .reader-chrome-spacer margin-bottom without mutating .android-reading paddingTop.
      act(() => setInputValue(searchInput, "TopHeader"));
      await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))); });
      act(() => nextBtn.click());
      expect(scroller.style.paddingTop).toBe("");
      expect(getSpacerMargin()).toBeGreaterThan(0);

      // Stepping to nested Python source match releases spacer clearance and scrolls BOTH pre.python-source and .android-reading.
      act(() => setInputValue(searchInput, "PYTHON-END-99"));
      await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))); });
      act(() => nextBtn.click());
      expect(getSpacerMargin()).toBe(0);
      expect(pySource.scrollTop).toBeGreaterThan(0);
      expect(scroller.scrollTop).toBeGreaterThan(0);

      const finalRect = computeRangeRect(
        (() => {
          const r = document.createRange();
          const tn = pySource.firstChild!;
          const idx = (tn.textContent || "").indexOf("PYTHON-END-99");
          r.setStart(tn, idx);
          r.setEnd(tn, idx + 13);
          return r;
        })(),
      );
      expect(finalRect.top).toBeGreaterThanOrEqual(12 + 76 + 12);
      expect(finalRect.bottom).toBeLessThanOrEqual(600 - 16);

      act(() => root.unmount());
    } finally {
      Range.prototype.getClientRects = origGetClientRects;
      Range.prototype.getBoundingClientRect = origGetBoundingRect;
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

  it("keeps rendered Range inside .reading-scroll unobstructed viewport when adjacent WindowedBlocks shrink after initial frames", async () => {
    const { default: WindowedBlock } = await import("./WindowedBlock");
    class TestIntersectionObserver {
      static instances: TestIntersectionObserver[] = [];
      constructor(readonly callback: IntersectionObserverCallback) { TestIntersectionObserver.instances.push(this); }
      observe() {}
      unobserve() {}
      disconnect() {}
      emitBatch(entries: Array<{ target: Element; isIntersecting: boolean }>) {
        this.callback(entries as unknown as IntersectionObserverEntry[], this as unknown as IntersectionObserver);
      }
    }
    class NoopResizeObserver {
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal("IntersectionObserver", TestIntersectionObserver);
    vi.stubGlobal("ResizeObserver", NoopResizeObserver);

    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    const blocks = Array.from({ length: 12 }, (_, idx) =>
      idx === 0
        ? "## Intro\n\ntoken-01 intro."
        : idx === 8
          ? "## Section 25\n\ntoken-25 target."
          : idx === 11
            ? "## Section 45\n\ntoken-45 tail."
            : `## Filler ${idx}\n\nParagraph ${idx}.`,
    );
    const content = blocks.join("\n\n");
    const offsets: Array<{ start: number; end: number }> = [];
    let cursor = 0;
    for (const chunk of blocks) {
      offsets.push({ start: cursor, end: cursor + chunk.length });
      cursor += chunk.length + 2;
    }

    const origGetClientRects = Range.prototype.getClientRects;
    const origGetBoundingRect = Range.prototype.getBoundingClientRect;

    try {
      await act(async () => {
        root.render(
          <div className="workspace">
            <ReadingSearch content={content} close={() => {}} initialReplace onChange={() => {}} />
            <div className="reading-scroll">
              <div className="live-document">
                <div className="markdown-body">
                  {blocks.map((chunk, idx) => (
                    <WindowedBlock
                      key={idx}
                      enabled
                      estimate={120}
                      text={chunk}
                      data-source-start={offsets[idx].start}
                      data-source-end={offsets[idx].end}
                    >
                      <p>{chunk.split("\n\n")[1]}</p>
                    </WindowedBlock>
                  ))}
                </div>
              </div>
            </div>
          </div>,
        );
      });

      const scroller = host.querySelector<HTMLElement>(".reading-scroll")!;
      const searchBar = host.querySelector<HTMLElement>(".reading-search")!;
      const getBlocks = () => Array.from(host.querySelectorAll<HTMLElement>("[data-windowed-block]"));
      const blockHeight = (el: HTMLElement) => (el.getAttribute("data-windowed-mounted") === "true" ? 44 : 120);
      const blockTopDoc = (targetIdx: number) => {
        const list = getBlocks();
        let y = 0;
        for (let i = 0; i < targetIdx; i++) y += blockHeight(list[i]);
        return y;
      };
      const totalDocHeight = () => getBlocks().reduce((sum, el) => sum + blockHeight(el), 0);

      let simulatedScrollTop = 0;
      Object.defineProperty(scroller, "scrollTop", {
        configurable: true,
        get: () => simulatedScrollTop,
        set: (v: number) => { simulatedScrollTop = Math.max(0, v); },
      });
      Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => totalDocHeight() });
      searchBar.getBoundingClientRect = () => new DOMRect(24, 12, 720, 88);
      scroller.getBoundingClientRect = () => new DOMRect(0, 0, 800, 600);
      getBlocks().forEach((el, idx) => {
        el.getBoundingClientRect = () => {
          const top = blockTopDoc(idx) - scroller.scrollTop;
          return new DOMRect(40, top, 680, blockHeight(el));
        };
      });

      const computeRangeRect = (range: Range): DOMRect => {
        const list = getBlocks();
        const ownerIdx = list.findIndex((el) => el.contains(range.startContainer));
        const top = (ownerIdx >= 0 ? blockTopDoc(ownerIdx) : 0) + 12 - scroller.scrollTop;
        return new DOMRect(48, top, 100, 20);
      };
      Range.prototype.getBoundingClientRect = function () { return computeRangeRect(this); };
      Range.prototype.getClientRects = function () {
        const r = computeRangeRect(this);
        return Object.assign([r], { item: (i: number) => (i === 0 ? r : null) }) as unknown as DOMRectList;
      };

      // Mount block 0 initially.
      await act(async () => {
        TestIntersectionObserver.instances[0]?.emitBatch([{ target: getBlocks()[0], isIntersecting: true }]);
      });

      const searchInput = host.querySelector<HTMLInputElement>('input[aria-label="Find in note"]')!;
      const regexBtn = host.querySelector<HTMLButtonElement>('button[aria-label="Regular expression"]')!;
      const nextBtn = host.querySelector<HTMLButtonElement>('button[aria-label="Next match"]')!;
      act(() => regexBtn.click());
      act(() => setInputValue(searchInput, "token-\\d+"));
      await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))); });
      expect(host.querySelector("output")?.textContent).toBe("0 / 3");

      // Step to 1 / 3 (token-01), then 2 / 3 (offscreen token-25 in block 8).
      act(() => nextBtn.click());
      act(() => nextBtn.click());
      expect(host.querySelector("output")?.textContent).toBe("2 / 3");
      expect(getBlocks()[8].getAttribute("data-windowed-mounted")).toBe("true");

      // Drain initial 4 rAF passes while blocks 1..7 above block 8 are still 120px placeholders.
      for (let i = 0; i < 6; i++) {
        await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))); });
      }

      // Now IntersectionObserver mounts blocks 1..7 in .reading-scroll, shrinking height above block 8 by 7 * 76 = 532px
      // (which would pull token-25 above the viewport without .reading-scroll supermd-window-change settling).
      await act(async () => {
        TestIntersectionObserver.instances[0]?.emitBatch(
          getBlocks().slice(1, 8).map((target) => ({ target, isIntersecting: true })),
        );
      });
      await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))); });

      const settledTop = blockTopDoc(8) + 12 - scroller.scrollTop;
      expect(settledTop).toBeGreaterThanOrEqual(12 + 88 + 12);
      expect(settledTop + 20).toBeLessThanOrEqual(600 - 16);
    } finally {
      Range.prototype.getClientRects = origGetClientRects;
      Range.prototype.getBoundingClientRect = origGetBoundingRect;
      vi.unstubAllGlobals();
      act(() => root.unmount());
      host.remove();
    }
  });

  it("composes #96 seeded exact occurrences, Unicode case-folded ranges, and passive stale-offset fallback with #110 unobstructed search-bar scrolling", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    const tallLines = Array.from({ length: 90 }, (_, i) =>
      i === 2 ? "Early BeaconHit in code" : i === 85 ? "Late BeaconHit in code" : `Line ${i} filler`,
    );
    const headingText = "Hauptstraße BeaconHit Top";
    const content = `# ${headingText}\n\n\`\`\`txt\n${tallLines.join("\n")}\n\`\`\``;
    const h1End = 2 + headingText.length;
    const codeStart = h1End + 2;

    const origHighlight = (window as unknown as { Highlight?: unknown }).Highlight;
    const origCss = globalThis.CSS;
    const highlightMap = new Map<string, { ranges: Range[] }>();
    class MockHighlight {
      ranges: Range[];
      constructor(...ranges: Range[]) { this.ranges = ranges; }
    }
    Object.defineProperty(window, "Highlight", { value: MockHighlight, configurable: true, writable: true });
    Object.defineProperty(globalThis, "CSS", { value: { ...(origCss ?? {}), highlights: highlightMap }, configurable: true, writable: true });

    const origGetClientRects = Range.prototype.getClientRects;
    const origGetBoundingRect = Range.prototype.getBoundingClientRect;

    const renderWithSeed = (seed: { query: string; caseSensitive?: boolean; sourceStart?: number; sourceEnd?: number; matchText?: string; nonce: number } | null) =>
      act(async () => {
        root.render(
          <div className="android-document">
            <ReadingSearch content={content} close={() => {}} onChange={() => {}} seed={seed} />
            <section className="android-reading">
              <div className="reader-chrome-spacer" aria-hidden="true" />
              <div className="document-page-space">
                <div className="document-page">
                  <div className="markdown-body">
                    <h1 data-source-start="0" data-source-end={String(h1End)}>{headingText}</h1>
                    <pre data-source-start={String(codeStart)} data-source-end={String(content.length)}><code>{tallLines.join("\n")}</code></pre>
                  </div>
                </div>
              </div>
            </section>
          </div>,
        );
      });

    try {
      await renderWithSeed(null);
      const scroller = host.querySelector<HTMLElement>(".android-reading")!;
      const spacer = host.querySelector<HTMLElement>(".reader-chrome-spacer")!;
      const searchBar = host.querySelector<HTMLElement>(".reading-search")!;
      const heading = host.querySelector<HTMLElement>("h1")!;
      const codeEl = host.querySelector<HTMLElement>("code")!;

      const getSpacerMargin = () => parseFloat(spacer.style.marginBottom || "0") || 0;
      searchBar.getBoundingClientRect = () => new DOMRect(24, 12, 720, 76);
      scroller.getBoundingClientRect = () => new DOMRect(0, 0, 800, 600);
      heading.getBoundingClientRect = () => new DOMRect(40, 24 + getSpacerMargin() - scroller.scrollTop, 420, 32);
      codeEl.getBoundingClientRect = () => new DOMRect(40, 100 + getSpacerMargin() - scroller.scrollTop, 600, 1800);

      const computeRangeRect = (range: Range): DOMRect => {
        if (heading.contains(range.startContainer)) {
          return new DOMRect(40, 24 + getSpacerMargin() - scroller.scrollTop, 100, 28);
        }
        const text = range.startContainer.textContent || "";
        const lineIdx = text.slice(0, range.startOffset).split("\n").length - 1;
        return new DOMRect(40, 100 + getSpacerMargin() + lineIdx * 20 - scroller.scrollTop, 110, 20);
      };
      Range.prototype.getBoundingClientRect = function () { return computeRangeRect(this); };
      Range.prototype.getClientRects = function () {
        const r = computeRangeRect(this);
        return Object.assign([r], { item: (idx: number) => (idx === 0 ? r : null) }) as unknown as DOMRectList;
      };

      // 1. Seeded 3rd occurrence ("Late BeaconHit" at line 85 of tall block) scrolls exact Range into unobstructed band.
      const hits = sourceMatches(content, "BeaconHit", true);
      expect(hits).toHaveLength(3);
      await renderWithSeed({
        query: "BeaconHit",
        caseSensitive: true,
        sourceStart: hits[2].from,
        sourceEnd: hits[2].to,
        matchText: "BeaconHit",
        nonce: 301,
      });
      await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))); });
      expect(host.querySelector("output")?.textContent).toBe("3 / 3");
      const lateRect = computeRangeRect(highlightMap.get("smd-search-current")!.ranges[0]);
      expect(lateRect.top).toBeGreaterThanOrEqual(12 + 76 + 12);
      expect(lateRect.bottom).toBeLessThanOrEqual(600 - 16);

      // 2. Stale seeded occurrence preserves current scroll position and passive 0 / 3 without scrolling to occurrence 1.
      const savedScrollTop = scroller.scrollTop;
      await renderWithSeed({
        query: "BeaconHit",
        caseSensitive: true,
        sourceStart: hits[2].from + 5,
        sourceEnd: hits[2].to + 5,
        matchText: "BeaconHit",
        nonce: 302,
      });
      await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))); });
      expect(host.querySelector("output")?.textContent).toBe("0 / 3");
      expect(scroller.scrollTop).toBe(savedScrollTop);
      expect(highlightMap.get("smd-search-current")).toBeUndefined();

      // 3. Seeded Unicode case-folded "strasse" -> "straße" on line 1 applies .reader-chrome-spacer clearance below .reading-search.
      const unicodeStart = content.indexOf("straße");
      await renderWithSeed({
        query: "strasse",
        caseSensitive: false,
        sourceStart: unicodeStart,
        sourceEnd: unicodeStart + "straße".length,
        matchText: "straße",
        nonce: 303,
      });
      await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))); });
      const unicodeRange = highlightMap.get("smd-search-current")?.ranges[0];
      expect(unicodeRange?.toString()).toBe("straße");
      const unicodeRect = computeRangeRect(unicodeRange!);
      expect(unicodeRect.top).toBeGreaterThanOrEqual(12 + 76 + 12);
      expect(getSpacerMargin()).toBeGreaterThan(0);
    } finally {
      Range.prototype.getClientRects = origGetClientRects;
      Range.prototype.getBoundingClientRect = origGetBoundingRect;
      Object.defineProperty(window, "Highlight", { value: origHighlight, configurable: true, writable: true });
      Object.defineProperty(globalThis, "CSS", { value: origCss, configurable: true, writable: true });
      act(() => root.unmount());
      host.remove();
    }
  });

  it("verifies rendered Range inside .android-reading after multi-wave WindowedBlock settling without rogue preserveWindowedScroll cancellation", async () => {
    const { default: WindowedBlock } = await import("./WindowedBlock");
    class TestIntersectionObserver {
      static instances: TestIntersectionObserver[] = [];
      constructor(readonly callback: IntersectionObserverCallback) { TestIntersectionObserver.instances.push(this); }
      observe() {}
      unobserve() {}
      disconnect() {}
      emitBatch(entries: Array<{ target: Element; isIntersecting: boolean }>) {
        this.callback(entries as unknown as IntersectionObserverEntry[], this as unknown as IntersectionObserver);
      }
    }
    class NoopResizeObserver {
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal("IntersectionObserver", TestIntersectionObserver);
    vi.stubGlobal("ResizeObserver", NoopResizeObserver);

    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    const makeBlocks = (replaced25: boolean) =>
      Array.from({ length: 24 }, (_, idx) =>
        idx === 0
          ? "Read [Docs](https://example.org/token-00) and token-01."
          : idx === 12
            ? replaced25
              ? "Offscreen item-25 match."
              : "Offscreen token-25 match."
            : idx === 20
              ? "Distant token-45 match."
              : `Readable windowed study paragraph ${idx}.`,
      );

    let currentContent = makeBlocks(false).join("\n\n");
    const computeOffsets = (chunks: string[]) => {
      const list: Array<{ start: number; end: number }> = [];
      let cur = 0;
      for (const chunk of chunks) {
        list.push({ start: cur, end: cur + chunk.length });
        cur += chunk.length + 2;
      }
      return list;
    };

    const origHighlight = (window as unknown as { Highlight?: unknown }).Highlight;
    const origCss = globalThis.CSS;
    const highlightMap = new Map<string, { ranges: Range[] }>();
    class MockHighlight {
      ranges: Range[];
      constructor(...ranges: Range[]) { this.ranges = ranges; }
    }
    Object.defineProperty(window, "Highlight", { value: MockHighlight, configurable: true, writable: true });
    Object.defineProperty(globalThis, "CSS", { value: { ...(origCss ?? {}), highlights: highlightMap }, configurable: true, writable: true });

    const origGetClientRects = Range.prototype.getClientRects;
    const origGetBoundingRect = Range.prototype.getBoundingClientRect;
    const origElementFromPoint = document.elementFromPoint;

    let silentUpperDriftPx = 0;
    let simulatedScrollTop = 0;

    const renderScene = (text: string) => {
      const chunks = text.split("\n\n");
      const offsets = computeOffsets(chunks);
      root.render(
        <div className="android-document">
          <ReadingSearch
            content={text}
            close={() => {}}
            initialReplace
            onChange={(next) => {
              currentContent = next;
              renderScene(next);
            }}
          />
          <section className="android-reading">
            <div className="reader-chrome-spacer" aria-hidden="true" />
            <div className="document-page-space">
              <div className="document-page">
                <div className="markdown-body">
                  {chunks.map((chunk, idx) => (
                    <WindowedBlock
                      key={idx}
                      enabled
                      estimate={120}
                      text={chunk}
                      data-source-start={offsets[idx].start}
                      data-source-end={offsets[idx].end}
                    >
                      <p>{chunk.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")}</p>
                    </WindowedBlock>
                  ))}
                </div>
              </div>
            </div>
          </section>
        </div>,
      );
    };

    try {
      await act(async () => { renderScene(currentContent); });
      const scroller = host.querySelector<HTMLElement>(".android-reading")!;
      const spacer = host.querySelector<HTMLElement>(".reader-chrome-spacer")!;
      const searchBar = host.querySelector<HTMLElement>(".reading-search")!;
      const getSpacerMargin = () => parseFloat(spacer.style.marginBottom || "0") || 0;
      const getBlocks = () => Array.from(host.querySelectorAll<HTMLElement>("[data-windowed-block]"));
      const blockHeight = (el: HTMLElement) => (el.getAttribute("data-windowed-mounted") === "true" ? 48 : 120);
      const blockTopDoc = (targetIdx: number) => {
        const list = getBlocks();
        let y = getSpacerMargin() + (targetIdx > 0 ? silentUpperDriftPx : 0);
        for (let i = 0; i < targetIdx; i++) y += blockHeight(list[i]);
        return y;
      };
      const totalDocHeight = () =>
        Math.max(600, getSpacerMargin() + getBlocks().reduce((sum, el) => sum + blockHeight(el), 0) + silentUpperDriftPx);

      Object.defineProperty(scroller, "scrollTop", {
        configurable: true,
        get: () => simulatedScrollTop,
        set: (v: number) => {
          const next = Math.max(0, v);
          if (next !== simulatedScrollTop) {
            simulatedScrollTop = next;
            queueMicrotask(() => scroller.dispatchEvent(new Event("scroll")));
          }
        },
      });
      Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => totalDocHeight() });
      searchBar.getBoundingClientRect = () => new DOMRect(24, 12, 720, 88);
      scroller.getBoundingClientRect = () => new DOMRect(0, 0, 800, 600);
      const bindBlockRects = () => {
        getBlocks().forEach((el, idx) => {
          el.getBoundingClientRect = () => new DOMRect(40, blockTopDoc(idx) - scroller.scrollTop, 680, blockHeight(el));
        });
      };
      bindBlockRects();

      // Simulate elementFromPoint hitting an upper placeholder block (e.g. y=160) when scrolled deep,
      // which would arm preserveWindowedScroll if revealMountedBlock fired supermd-reveal-window unguarded.
      document.elementFromPoint = (_x: number, y: number) => {
        const list = getBlocks();
        for (let i = 0; i < list.length; i++) {
          const top = blockTopDoc(i) - scroller.scrollTop;
          if (y >= top && y <= top + blockHeight(list[i])) return list[i];
        }
        return scroller;
      };

      const computeRangeRect = (range: Range): DOMRect => {
        const list = getBlocks();
        const ownerIdx = list.findIndex((el) => el.contains(range.startContainer));
        const top = (ownerIdx >= 0 ? blockTopDoc(ownerIdx) : getSpacerMargin()) + 10 - scroller.scrollTop;
        return new DOMRect(48, top, 110, 20);
      };
      Range.prototype.getBoundingClientRect = function () { return computeRangeRect(this); };
      Range.prototype.getClientRects = function () {
        const r = computeRangeRect(this);
        return Object.assign([r], { item: (i: number) => (i === 0 ? r : null) }) as unknown as DOMRectList;
      };

      await act(async () => {
        TestIntersectionObserver.instances[0]?.emitBatch([{ target: getBlocks()[0], isIntersecting: true }]);
      });

      const searchInput = host.querySelector<HTMLInputElement>('input[aria-label="Find in note"]')!;
      const wholeWordBtn = host.querySelector<HTMLButtonElement>('button[aria-label="Match whole word"]')!;
      const regexBtn = host.querySelector<HTMLButtonElement>('button[aria-label="Regular expression"]')!;
      const nextBtn = host.querySelector<HTMLButtonElement>('button[aria-label="Next match"]')!;
      act(() => wholeWordBtn.click());
      act(() => regexBtn.click());
      act(() => setInputValue(searchInput, "(token)-(\\d+)"));
      await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))); });
      expect(host.querySelector("output")?.textContent).toBe("0 / 4");

      // Advance 1 / 4 (URL) -> 2 / 4 (token-01) -> 3 / 4 (offscreen token-25 in block 12).
      act(() => nextBtn.click());
      act(() => nextBtn.click());
      act(() => nextBtn.click());
      expect(host.querySelector("output")?.textContent).toBe("3 / 4");
      expect(getBlocks()[12].getAttribute("data-windowed-mounted")).toBe("true");

      // Wave 1 after 2 frames, Wave 2 after 2 more frames, plus silent post-wave margin drift on verification frame.
      await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))); });
      await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))); });
      await act(async () => {
        TestIntersectionObserver.instances[0]?.emitBatch(
          getBlocks().slice(6, 12).map((target) => ({ target, isIntersecting: true })),
        );
      });
      await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))); });
      await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))); });
      await act(async () => {
        TestIntersectionObserver.instances[0]?.emitBatch(
          getBlocks().slice(1, 6).map((target) => ({ target, isIntersecting: true })),
        );
      });
      // Drain active layout pass so next queued frame is verifyOnly, then shift geometry above block 12 without events.
      await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))); });
      silentUpperDriftPx = -240;
      await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))); });
      await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))); });

      expect(scroller.scrollTop).toBeGreaterThan(0);
      const current25 = highlightMap.get("smd-search-current")?.ranges[0];
      expect(current25?.toString()).toBe("token-25");
      const rect25 = computeRangeRect(current25!);
      expect(rect25.top).toBeGreaterThanOrEqual(12 + 88 + 12 - 1);
      expect(rect25.bottom).toBeLessThanOrEqual(600 - 16 + 1);

      // Single Replace expands $2 -> item-25 and advances to 3 / 3 (token-45 in block 20), keeping it in band.
      const replaceInput = host.querySelector<HTMLInputElement>('input[aria-label="Replacement text"]')!;
      act(() => setInputValue(replaceInput, "item-$2"));
      const replaceSingle = host.querySelectorAll<HTMLButtonElement>(".search-replace button")[0];
      await act(async () => { replaceSingle.click(); });
      bindBlockRects();
      await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))); });
      expect(currentContent).toContain("Offscreen item-25 match.");
      expect(host.querySelector("output")?.textContent).toBe("3 / 3");
      expect(getBlocks()[20].getAttribute("data-windowed-mounted")).toBe("true");

      await act(async () => {
        TestIntersectionObserver.instances[0]?.emitBatch(
          getBlocks().slice(13, 17).map((target) => ({ target, isIntersecting: true })),
        );
      });
      await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))); });
      await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))); });

      const current45 = highlightMap.get("smd-search-current")?.ranges[0];
      expect(current45?.toString()).toBe("token-45");
      const rect45 = computeRangeRect(current45!);
      expect(rect45.top).toBeGreaterThanOrEqual(12 + 88 + 12 - 1);
      expect(rect45.bottom).toBeLessThanOrEqual(600 - 16 + 1);

      // Manual scroll cancels any remaining verification/settle passes so subsequent block mounts do not snap scrollTop back.
      scroller.scrollTop = 180;
      await act(async () => {
        await Promise.resolve();
        TestIntersectionObserver.instances[0]?.emitBatch(
          getBlocks().slice(17, 20).map((target) => ({ target, isIntersecting: true })),
        );
      });
      await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))); });
      expect(scroller.scrollTop).toBe(180);
    } finally {
      document.elementFromPoint = origElementFromPoint;
      Range.prototype.getClientRects = origGetClientRects;
      Range.prototype.getBoundingClientRect = origGetBoundingRect;
      Object.defineProperty(window, "Highlight", { value: origHighlight, configurable: true, writable: true });
      Object.defineProperty(globalThis, "CSS", { value: origCss, configurable: true, writable: true });
      vi.unstubAllGlobals();
      act(() => root.unmount());
      host.remove();
    }
  });
});
