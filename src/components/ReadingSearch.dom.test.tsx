// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import LiveEditor from "./LiveEditor";
import ReadingSearch, { resolveSourceBlock, resolveSourceHighlightRange, sourceMatches } from "./ReadingSearch";

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
              <pre><code>{tallLines.join("\n")}</code></pre>
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

      // Unmounting ReadingSearch removes temporary top clearance cleanly.
      act(() => root.unmount());
      expect(scroller.style.paddingTop).toBe("");
    } finally {
      Range.prototype.getClientRects = origGetClientRects;
      Range.prototype.getBoundingClientRect = origGetBoundingRect;
      host.remove();
    }
  });
});
