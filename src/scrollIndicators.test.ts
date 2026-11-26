// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installScrollIndicators } from "./scrollIndicators";

interface MockMetrics {
  rect: { left: number; top: number; right: number; bottom: number };
  clientWidth: number;
  scrollWidth: number;
  clientHeight: number;
  scrollHeight: number;
  overflowX?: string;
  overflowY?: string;
}

function mockElementMetrics(element: HTMLElement, metrics: MockMetrics): void {
  const { rect, clientWidth, scrollWidth, clientHeight, scrollHeight } = metrics;
  Object.defineProperty(element, "clientWidth", { configurable: true, get: () => clientWidth });
  Object.defineProperty(element, "scrollWidth", { configurable: true, get: () => scrollWidth });
  Object.defineProperty(element, "clientHeight", { configurable: true, get: () => clientHeight });
  Object.defineProperty(element, "scrollHeight", { configurable: true, get: () => scrollHeight });
  element.style.overflowX = metrics.overflowX ?? "auto";
  element.style.overflowY = metrics.overflowY ?? "auto";
  element.getBoundingClientRect = () =>
    ({
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.right - rect.left,
      height: rect.bottom - rect.top,
      x: rect.left,
      y: rect.top,
      toJSON: () => ({}),
    }) as DOMRect;
}

function dispatchPointerMove(target: EventTarget, clientX: number, clientY: number): void {
  const event = new MouseEvent("pointermove", { bubbles: true, clientX, clientY });
  target.dispatchEvent(event);
}

describe("installScrollIndicators", () => {
  let dispose: (() => void) | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = "";
    dispose = installScrollIndicators();
  });

  afterEach(() => {
    dispose?.();
    dispose = undefined;
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("activates scroll and hover indicators on overflowing tables and code regions, then fades out after 650ms", () => {
    document.body.innerHTML = `
      <section class="android-reading">
        <div class="document-page" data-scale="1">
          <article class="markdown-body">
            <table id="wide-table"><tbody><tr><td id="wide-cell">Wide</td></tr></tbody></table>
            <div class="code-container"><details class="code-disclosure" open><pre id="wide-pre"><code>const wide = 1;</code></pre></details></div>
            <div class="python-cell">
              <pre id="py-source" class="python-source"><code id="py-code">x = 1</code></pre>
              <div class="cell-output"><pre id="py-out">stdout</pre></div>
            </div>
          </article>
        </div>
      </section>
    `;

    const reading = document.querySelector<HTMLElement>(".android-reading")!;
    const wideTable = document.getElementById("wide-table")!;
    const wideCell = document.getElementById("wide-cell")!;
    const widePre = document.getElementById("wide-pre")!;
    const pySource = document.getElementById("py-source")!;
    const pyCode = document.getElementById("py-code")!;
    const pyOut = document.getElementById("py-out")!;

    mockElementMetrics(reading, {
      rect: { left: 0, top: 0, right: 900, bottom: 700 },
      clientWidth: 900,
      scrollWidth: 900,
      clientHeight: 700,
      scrollHeight: 2400,
      overflowX: "hidden",
      overflowY: "auto",
    });
    mockElementMetrics(wideTable, {
      rect: { left: 60, top: 40, right: 840, bottom: 160 },
      clientWidth: 780,
      scrollWidth: 1520,
      clientHeight: 120,
      scrollHeight: 120,
      overflowX: "auto",
      overflowY: "visible",
    });
    mockElementMetrics(widePre, {
      rect: { left: 60, top: 180, right: 840, bottom: 260 },
      clientWidth: 780,
      scrollWidth: 1320,
      clientHeight: 80,
      scrollHeight: 80,
      overflowX: "auto",
      overflowY: "auto",
    });
    mockElementMetrics(pySource, {
      rect: { left: 60, top: 280, right: 840, bottom: 520 },
      clientWidth: 780,
      scrollWidth: 1180,
      clientHeight: 240,
      scrollHeight: 680,
      overflowX: "auto",
      overflowY: "auto",
    });
    mockElementMetrics(pyOut, {
      rect: { left: 60, top: 530, right: 840, bottom: 600 },
      clientWidth: 780,
      scrollWidth: 1080,
      clientHeight: 70,
      scrollHeight: 70,
      overflowX: "auto",
      overflowY: "auto",
    });

    // Scroll events on overflowing table and code regions toggle .scroll-indicator-active independently.
    wideTable.dispatchEvent(new Event("scroll"));
    widePre.dispatchEvent(new Event("scroll"));
    pySource.dispatchEvent(new Event("scroll"));
    pyOut.dispatchEvent(new Event("scroll"));

    expect(wideTable.classList.contains("scroll-indicator-active")).toBe(true);
    expect(widePre.classList.contains("scroll-indicator-active")).toBe(true);
    expect(pySource.classList.contains("scroll-indicator-active")).toBe(true);
    expect(pyOut.classList.contains("scroll-indicator-active")).toBe(true);

    vi.advanceTimersByTime(649);
    expect(wideTable.classList.contains("scroll-indicator-active")).toBe(true);
    vi.advanceTimersByTime(1);
    expect(wideTable.classList.contains("scroll-indicator-active")).toBe(false);
    expect(widePre.classList.contains("scroll-indicator-active")).toBe(false);
    expect(pySource.classList.contains("scroll-indicator-active")).toBe(false);
    expect(pyOut.classList.contains("scroll-indicator-active")).toBe(false);

    // Bottom horizontal lane on wide table hovers table, whereas middle of table does not.
    dispatchPointerMove(wideCell, 300, 152);
    expect(wideTable.classList.contains("scroll-indicator-hover")).toBe(true);
    expect(reading.classList.contains("scroll-indicator-hover")).toBe(false);

    dispatchPointerMove(wideCell, 300, 90);
    expect(wideTable.classList.contains("scroll-indicator-hover")).toBe(false);

    // Right vertical lane on tall Python source hovers Python source, not outer reading pane.
    dispatchPointerMove(pyCode, 830, 380);
    expect(pySource.classList.contains("scroll-indicator-hover")).toBe(true);
    expect(reading.classList.contains("scroll-indicator-hover")).toBe(false);
  });

  it("ignores non-overflowing compact tables and short code blocks and preserves outer reading lane hover", () => {
    document.body.innerHTML = `
      <section class="android-reading">
        <div class="document-page" data-scale="1">
          <article class="markdown-body">
            <table id="compact-table"><tbody><tr><td id="compact-cell">Key</td></tr></tbody></table>
            <pre id="short-pre"><code id="short-code">x = 1</code></pre>
            <table id="horiz-only-table"><tbody><tr><td id="horiz-cell">Wide row</td></tr></tbody></table>
          </article>
        </div>
      </section>
    `;

    const reading = document.querySelector<HTMLElement>(".android-reading")!;
    const compactTable = document.getElementById("compact-table")!;
    const compactCell = document.getElementById("compact-cell")!;
    const shortPre = document.getElementById("short-pre")!;
    const shortCode = document.getElementById("short-code")!;
    const horizTable = document.getElementById("horiz-only-table")!;
    const horizCell = document.getElementById("horiz-cell")!;

    mockElementMetrics(reading, {
      rect: { left: 0, top: 0, right: 900, bottom: 700 },
      clientWidth: 900,
      scrollWidth: 900,
      clientHeight: 700,
      scrollHeight: 2200,
      overflowX: "hidden",
      overflowY: "auto",
    });
    mockElementMetrics(compactTable, {
      rect: { left: 60, top: 40, right: 260, bottom: 110 },
      clientWidth: 200,
      scrollWidth: 200,
      clientHeight: 70,
      scrollHeight: 70,
      overflowX: "auto",
      overflowY: "visible",
    });
    mockElementMetrics(shortPre, {
      rect: { left: 60, top: 130, right: 892, bottom: 200 },
      clientWidth: 832,
      scrollWidth: 832,
      clientHeight: 70,
      scrollHeight: 70,
      overflowX: "auto",
      overflowY: "auto",
    });
    mockElementMetrics(horizTable, {
      rect: { left: 60, top: 220, right: 892, bottom: 340 },
      clientWidth: 832,
      scrollWidth: 1600,
      clientHeight: 120,
      scrollHeight: 120,
      overflowX: "auto",
      overflowY: "visible",
    });

    compactTable.dispatchEvent(new Event("scroll"));
    shortPre.dispatchEvent(new Event("scroll"));
    expect(compactTable.classList.contains("scroll-indicator-active")).toBe(false);
    expect(shortPre.classList.contains("scroll-indicator-active")).toBe(false);

    // Bottom/right edges of non-overflowing compact table never trigger hover.
    dispatchPointerMove(compactCell, 255, 106);
    expect(compactTable.classList.contains("scroll-indicator-hover")).toBe(false);

    // Moving into .android-reading's right scrollbar lane over a non-overflowing <pre>
    // or over the middle rows of a horizontal-only table falls back to .android-reading!
    dispatchPointerMove(shortCode, 886, 160);
    expect(shortPre.classList.contains("scroll-indicator-hover")).toBe(false);
    expect(reading.classList.contains("scroll-indicator-hover")).toBe(true);

    dispatchPointerMove(horizCell, 886, 260);
    expect(horizTable.classList.contains("scroll-indicator-hover")).toBe(false);
    expect(reading.classList.contains("scroll-indicator-hover")).toBe(true);
  });

  it("scales nested scrollbar lane hit testing when .document-page is magnified", () => {
    document.body.innerHTML = `
      <section class="android-reading">
        <div class="document-page" data-scale="2">
          <article class="markdown-body">
            <table id="zoomed-table"><tbody><tr><td id="zoomed-cell">Wide</td></tr></tbody></table>
          </article>
        </div>
      </section>
    `;

    const zoomedTable = document.getElementById("zoomed-table")!;
    const zoomedCell = document.getElementById("zoomed-cell")!;
    mockElementMetrics(zoomedTable, {
      rect: { left: 40, top: 40, right: 840, bottom: 240 },
      clientWidth: 400,
      scrollWidth: 960,
      clientHeight: 100,
      scrollHeight: 100,
      overflowX: "auto",
      overflowY: "visible",
    });

    // At 200% zoom, the 16px bottom lane spans 32px in viewport coordinates (bottom - 24 is inside).
    dispatchPointerMove(zoomedCell, 300, 216);
    expect(zoomedTable.classList.contains("scroll-indicator-hover")).toBe(true);

    document.dispatchEvent(new MouseEvent("pointerout", { bubbles: true, relatedTarget: null }));
    expect(zoomedTable.classList.contains("scroll-indicator-hover")).toBe(false);
  });
});
