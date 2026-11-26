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

  it("preserves windowed DOM-order navigation and unmounted source-range mapping when toggling Replace in source", async () => {
    const { registerWindowedText } = await import("../windowedSearch");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

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

    // Step to 3 / 3 (still unmounted sections[2] until revealed or mapped), or toggle Replace at 2 / 3 and replace only second match.
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

    // Also verify #83 regex + capture-group replacement across the remaining unmounted block in DOM order.
    await act(async () => { renderWindowed(); });
    const regexBtn = host.querySelector<HTMLButtonElement>('button[aria-label="Regular expression"]')!;
    const wholeWordBtn = host.querySelector<HTMLButtonElement>('button[aria-label="Match whole word"]')!;
    act(() => regexBtn.click());
    act(() => wholeWordBtn.click());
    act(() => setInputValue(searchInput, "Target (\\w+)"));
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))); });
    expect(host.querySelector("output")?.textContent).toBe("0 / 2");
    const prevBtn = host.querySelector<HTMLButtonElement>('button[aria-label="Previous match"]')!;
    act(() => prevBtn.click());
    expect(host.querySelector("output")?.textContent).toBe("2 / 2");
    act(() => setInputValue(replaceInput, "Rewritten-$1"));
    act(() => replaceSingle().click());
    expect(changes.at(-1)).toBe("## First\n\nTarget alpha.\n\n## Second\n\nUpdated beta.\n\n## Third\n\nRewritten-gamma.");

    cleanups.forEach((fn) => fn());
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
      act(() => nextBtn.click());
      scrollTargets.length = 0;
      act(() => nextBtn.click());
      expect(host.querySelector("output")?.textContent).toBe("2 / 3");
      expect(sections()[1].getAttribute("data-windowed-mounted")).toBe("true");
      expect(scrollTargets.length).toBeGreaterThanOrEqual(1);

      for (let i = 0; i < 5; i++) {
        await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))); });
      }
      scrollTargets.length = 0;
      simulatedScrollHeight = 11100;
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

      // Single Replace on 2 / 3 advances to 2 / 2 (Tail / token-45) and settles across window changes.
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

      // Direct manual scrollTop change + scroll event cancels active settle.
      act(() => nextBtn.click());
      for (let i = 0; i < 5; i++) {
        await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))); });
      }
      scrollTargets.length = 0;
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
