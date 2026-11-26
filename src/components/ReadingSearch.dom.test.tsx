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

  it("reveals verified StepCards slides (prose, legacy notes, and diagram/chart specs) and standalone diagrams while rejecting stale offsets", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    const stepDeckJson = JSON.stringify({
      title: "Fourier Harmonic Deck",
      steps: [
        { label: "Intro step", markdown: "Harmonic overview on slide one." },
        { label: "Graph structure", diagram: { width: 320, height: 140, nodes: [{ id: "n1", label: "Harmonic node", x: 90, y: 70 }, { id: "n2", label: "Sink", x: 230, y: 70 }], edges: [{ from: "n1", to: "n2" }] } },
        { label: "Deep derivation", markdown: "Slide three **Harmonic** derivation with [ref](https://example.com/Harmonic)." },
        { label: "Legacy summary", image: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", description: "Legacy Harmonic explanation." },
      ],
    });
    const standaloneDiagram = '```smd-diagram\n{"width":360,"height":140,"nodes":[{"id":"a","label":"Standalone Harmonic Diagram","x":110,"y":70},{"id":"b","label":"Out","x":260,"y":70}],"edges":[{"from":"a","to":"b"}]}\n```';
    const standaloneChart = '```smd-chart\n{"title":"Harmonic Spectrum","series":[{"name":"wave","expression":"sin(x) + 0*1"}]}\n```';

    let current = [
      "# Signal Notes",
      "",
      "Intro Harmonic paragraph.",
      "",
      "```smd-steps\n" + stepDeckJson + "\n```",
      "",
      standaloneDiagram,
      "",
      standaloneChart,
      "",
      "Closing Harmonic paragraph.",
    ].join("\n");

    const rangeOf = (needle: string, fromOffset = 0) => {
      const idx = current.indexOf(needle, fromOffset);
      expect(idx).toBeGreaterThanOrEqual(0);
      return { start: idx, end: idx + needle.length };
    };

    const slide3Context = current.indexOf("Slide three **");
    const slide3Hit = rangeOf("Harmonic", slide3Context);
    const slide2Context = current.indexOf('"Harmonic node"');
    const slide2DiagramHit = rangeOf("Harmonic", slide2Context);
    const slide4Context = current.indexOf("Legacy Harmonic");
    const slide4LegacyHit = rangeOf("Harmonic", slide4Context);
    const standaloneDiagContext = current.indexOf("Standalone Harmonic");
    const standaloneDiagHit = rangeOf("Harmonic", standaloneDiagContext);
    const chartTitleContext = current.indexOf("Harmonic Spectrum");
    const chartTitleHit = rangeOf("Harmonic", chartTitleContext);
    const chartExprHit = rangeOf("sin(x)");

    const scrolledTargets: Element[] = [];
    const origScroll = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function () {
      scrolledTargets.push(this);
    };

    try {
      const renderReader = async (seed: { query: string; caseSensitive?: boolean; sourceStart?: number; sourceEnd?: number; matchText?: string; nonce: number }, live = true) => {
        await act(async () => {
          root.render(
            <div className="android-document">
              <ReadingSearch
                content={current}
                close={() => {}}
                seed={seed}
                onChange={live ? (next) => { current = next; } : undefined}
              />
              <section className="android-reading">
                {live ? (
                  <LiveEditor markdown={current} onChange={(next) => { current = next; }} documentPath={null} python="" dark={false} />
                ) : (
                  <div className="markdown-body">
                    <LiveEditor markdown={current} onChange={() => {}} documentPath={null} python="" dark={false} />
                  </div>
                )}
              </section>
            </div>
          );
        });
        await act(async () => {
          await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
        });
      };

      // 1. Verified occurrence on Slide 3 markdown: switches StepCards to slide 3 (index 2) and selects visible match (not confused by nested <p data-source-start="0">).
      await renderReader({
        query: "harmonic",
        caseSensitive: false,
        sourceStart: slide3Hit.start,
        sourceEnd: slide3Hit.end,
        matchText: "Harmonic",
        nonce: 1,
      });
      const stepCard = () => host.querySelector<HTMLElement>(".step-cards")!;
      expect(stepCard().getAttribute("data-step-index")).toBe("2");
      expect(stepCard().querySelector(".step-cards-progress")?.textContent).toBe("3 / 4");
      // Visible matches on active DOM: Intro paragraph (1), deck heading on slide 3 (2), slide 3 markdown (3), chart figcaption (4), closing paragraph (5).
      expect(host.querySelector("output")?.textContent).toBe("3 / 5");
      expect(scrolledTargets.some((el) => stepCard().contains(el))).toBe(true);

      // 2. Verified occurrence on Slide 4 legacy description: switches to slide 4 and opens .step-cards-legacy-note.
      await renderReader({
        query: "Harmonic",
        caseSensitive: true,
        sourceStart: slide4LegacyHit.start,
        sourceEnd: slide4LegacyHit.end,
        matchText: "Harmonic",
        nonce: 2,
      });
      expect(stepCard().getAttribute("data-step-index")).toBe("3");
      expect(stepCard().querySelector<HTMLDetailsElement>(".step-cards-legacy-note")?.open).toBe(true);
      expect(host.querySelector("output")?.textContent).toBe("2 / 4");

      // 3. Verified occurrence inside Slide 2 diagram JSON: switches StepCards to slide 2, reports In source · 0 / N without false prose selection, and hands off to Next match & Replace in source.
      scrolledTargets.length = 0;
      await renderReader({
        query: "Harmonic",
        caseSensitive: true,
        sourceStart: slide2DiagramHit.start,
        sourceEnd: slide2DiagramHit.end,
        matchText: "Harmonic",
        nonce: 3,
      });
      expect(stepCard().getAttribute("data-step-index")).toBe("1");
      expect(stepCard().querySelector(".step-cards-inline-figure svg")).not.toBeNull();
      expect(host.querySelector("output")?.textContent).toBe("In source · 0 / 3");
      expect(scrolledTargets.some((el) => stepCard() === el || stepCard().contains(el))).toBe(true);

      // Toggling Replace in source from the hidden Slide 2 diagram occurrence maps directly to its exact source match!
      const replaceToggle = host.querySelector<HTMLButtonElement>('button[aria-label="Replace in source"]')!;
      act(() => replaceToggle.click());
      const allSourceHarmonic = sourceMatches(current, "Harmonic", true);
      const expectedDiagSourceIdx = allSourceHarmonic.findIndex((r) => r.from === slide2DiagramHit.start);
      expect(expectedDiagSourceIdx).toBeGreaterThanOrEqual(0);
      expect(host.querySelector("output")?.textContent).toBe(`${expectedDiagSourceIdx + 1} / ${allSourceHarmonic.length}`);
      act(() => replaceToggle.click());

      // 4. Verified occurrence inside standalone smd-diagram (Read mode via MarkdownPreview): scrolls diagram into view and reports In source.
      const MarkdownPreview = (await import("./MarkdownPreview")).default;
      scrolledTargets.length = 0;
      await act(async () => {
        root.render(
          <div className="android-document">
            <ReadingSearch
              content={current}
              close={() => {}}
              seed={{
                query: "Harmonic",
                caseSensitive: true,
                sourceStart: standaloneDiagHit.start,
                sourceEnd: standaloneDiagHit.end,
                matchText: "Harmonic",
                nonce: 4,
              }}
            />
            <section className="android-reading">
              <div className="markdown-body">
                <MarkdownPreview markdown={current} documentPath={null} python="" dark={false} />
              </div>
            </section>
          </div>
        );
      });
      await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))); });
      const standaloneInlineDiag = host.querySelectorAll<HTMLElement>(".inline-diagram");
      expect(standaloneInlineDiag.length).toBeGreaterThan(0);
      expect(host.querySelector("output")?.textContent).toMatch(/^In source · 0 \/ \d+$/);
      expect(scrolledTargets.some((el) => el.classList.contains("inline-diagram") || el.querySelector?.(".inline-diagram"))).toBe(true);

      // Stepping Next from hidden standalone diagram occurrence lands on the next visible match (smd-chart figcaption "Harmonic Spectrum") rather than wrapping back to match 1!
      const nextBtn = host.querySelector<HTMLButtonElement>('button[aria-label="Next match"]')!;
      act(() => nextBtn.click());
      const afterDiagText = host.querySelector("output")?.textContent ?? "";
      const [afterNum, afterTotal] = afterDiagText.split(" / ").map(Number);
      expect(afterNum).toBe(afterTotal - 1);

      // 5. Verified occurrence in standalone smd-chart title vs hidden expression:
      await renderReader({
        query: "Harmonic",
        caseSensitive: true,
        sourceStart: chartTitleHit.start,
        sourceEnd: chartTitleHit.end,
        matchText: "Harmonic",
        nonce: 5,
      });
      expect(host.querySelector("output")?.textContent).not.toContain("In source");

      await renderReader({
        query: "sin(x)",
        caseSensitive: true,
        sourceStart: chartExprHit.start,
        sourceEnd: chartExprHit.end,
        matchText: "sin(x)",
        nonce: 6,
      });
      expect(host.querySelector("output")?.textContent).toBe("In Markdown source");

      // 6. Stale sourceStart/sourceEnd or mismatched matchText preserves active slide when mounted and keeps Slide 1 on fresh mount while falling back cleanly to 1 / N.
      current = "Inserted prefix line shifting all offsets!\n\n" + current;
      await renderReader({
        query: "Harmonic",
        caseSensitive: true,
        sourceStart: slide3Hit.start,
        sourceEnd: slide3Hit.end,
        matchText: "Harmonic",
        nonce: 7,
      });
      expect(stepCard().getAttribute("data-step-index")).toBe("1");
      expect(host.querySelector("output")?.textContent).toMatch(/^1 \/ \d+$/);

      const { stepIndices } = await import("../renderedOutputs");
      await act(async () => { root.render(<div />); });
      stepIndices.clear();
      await renderReader({
        query: "Harmonic",
        caseSensitive: true,
        sourceStart: slide3Hit.start,
        sourceEnd: slide3Hit.end,
        matchText: "OtroTexto",
        nonce: 8,
      });
      expect(stepCard().getAttribute("data-step-index")).toBe("0");
      expect(host.querySelector("output")?.textContent).toMatch(/^1 \/ \d+$/);

      // 7. Malformed diagram rendering .render-error still scrolls into view at a verified source occurrence and reports In Markdown source without indexing diagnostic chrome.
      const brokenDoc = "# Intro\n\n```smd-chart\n{\"broken\": \"smd-chart\"}\n```\n";
      const brokenHitStart = brokenDoc.lastIndexOf("smd-chart");
      current = brokenDoc;
      scrolledTargets.length = 0;
      await renderReader({
        query: "smd-chart",
        caseSensitive: true,
        sourceStart: brokenHitStart,
        sourceEnd: brokenHitStart + "smd-chart".length,
        matchText: "smd-chart",
        nonce: 9,
      });
      const renderErr = host.querySelector<HTMLElement>(".render-error");
      expect(renderErr).toBeTruthy();
      expect(host.querySelector("output")?.textContent).toBe("In Markdown source");
      expect(scrolledTargets).toContain(renderErr);
    } finally {
      Element.prototype.scrollIntoView = origScroll;
      act(() => root.unmount());
      host.remove();
    }
  });
});
