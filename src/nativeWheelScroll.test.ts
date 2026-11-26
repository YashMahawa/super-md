// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyChainedNativeScroll,
  collectNativeWheelScrollChain,
  resolveNativeWheelScrollOrigin,
} from './nativeWheelScroll';

function mockScrollMetrics(
  element: HTMLElement,
  metrics: {
    clientWidth?: number;
    scrollWidth?: number;
    clientHeight?: number;
    scrollHeight?: number;
    scrollLeft?: number;
    scrollTop?: number;
  },
) {
  let left = metrics.scrollLeft ?? 0;
  let top = metrics.scrollTop ?? 0;
  const cw = metrics.clientWidth ?? 400;
  const sw = metrics.scrollWidth ?? cw;
  const ch = metrics.clientHeight ?? 300;
  const sh = metrics.scrollHeight ?? ch;

  Object.defineProperties(element, {
    clientWidth: { configurable: true, get: () => cw },
    scrollWidth: { configurable: true, get: () => sw },
    clientHeight: { configurable: true, get: () => ch },
    scrollHeight: { configurable: true, get: () => sh },
    scrollLeft: {
      configurable: true,
      get: () => left,
      set: (v: number) => {
        left = Math.max(0, Math.min(Math.max(0, sw - cw), v));
      },
    },
    scrollTop: {
      configurable: true,
      get: () => top,
      set: (v: number) => {
        top = Math.max(0, Math.min(Math.max(0, sh - ch), v));
      },
    },
    scrollBy: {
      configurable: true,
      value: (opts: ScrollToOptions | number, y?: number) => {
        const dx = typeof opts === 'number' ? opts : (opts.left ?? 0);
        const dy = typeof opts === 'number' ? (y ?? 0) : (opts.top ?? 0);
        left = Math.max(0, Math.min(Math.max(0, sw - cw), left + dx));
        top = Math.max(0, Math.min(Math.max(0, sh - ch), top + dy));
      },
    },
  });
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('nativeWheelScroll', () => {
  it('routes to the innermost code region (.markdown-body pre and .python-source) and chains remainder at boundaries', () => {
    document.body.innerHTML = `
      <section class="android-reading" style="overflow: auto;">
        <div class="document-page-space">
          <div class="document-page" data-scale="1">
            <article class="markdown-body">
              <div class="python-cell">
                <pre class="python-source" style="overflow: auto;"><code id="py-token">for i in range(100): print(i)</code></pre>
              </div>
            </article>
          </div>
        </div>
      </section>
    `;
    const reading = document.querySelector<HTMLElement>('.android-reading')!;
    const pySource = document.querySelector<HTMLElement>('.python-source')!;
    const token = document.getElementById('py-token')!;

    mockScrollMetrics(reading, { clientWidth: 800, scrollWidth: 800, clientHeight: 600, scrollHeight: 2400 });
    mockScrollMetrics(pySource, { clientWidth: 600, scrollWidth: 1000, clientHeight: 200, scrollHeight: 320 });

    const origin = resolveNativeWheelScrollOrigin(token);
    expect(origin).toBe(pySource);
    expect(collectNativeWheelScrollChain(origin!)).toEqual([pySource, reading]);

    const onReadingScroll = vi.fn();
    // Interior scroll stays inside .python-source without moving .android-reading.
    applyChainedNativeScroll(origin!, 50, 80, { centerLock: true, onReadingScroll });
    expect(pySource.scrollLeft).toBe(50);
    expect(pySource.scrollTop).toBe(80);
    expect(reading.scrollTop).toBe(0);
    expect(onReadingScroll).not.toHaveBeenCalled();

    // Hitting bottom boundary (remaining room = 40px) consumes 40px in .python-source and chains 60px to .android-reading.
    applyChainedNativeScroll(origin!, 0, 100, { centerLock: true, onReadingScroll });
    expect(pySource.scrollTop).toBe(120);
    expect(reading.scrollTop).toBe(60);
    expect(onReadingScroll).toHaveBeenCalledWith(reading, 60);
  });

  it('scrolls wide Markdown tables horizontally while chaining vertical deltas in the same frame even under centerLock', () => {
    document.body.innerHTML = `
      <section class="android-reading" data-center-locked="true" style="overflow-y: auto; overflow-x: hidden;">
        <div class="document-page-space">
          <div class="document-page" data-scale="1">
            <article class="markdown-body">
              <table style="display: block; overflow-x: auto;">
                <tbody><tr><td id="cell">Wide cell</td></tr></tbody>
              </table>
            </article>
          </div>
        </div>
      </section>
    `;
    const reading = document.querySelector<HTMLElement>('.android-reading')!;
    const table = document.querySelector<HTMLElement>('table')!;
    const cell = document.getElementById('cell')!;

    mockScrollMetrics(reading, { clientWidth: 800, scrollWidth: 1200, clientHeight: 600, scrollHeight: 2000 });
    mockScrollMetrics(table, { clientWidth: 500, scrollWidth: 900, clientHeight: 140, scrollHeight: 140 });

    const origin = resolveNativeWheelScrollOrigin(cell)!;
    expect(origin).toBe(table);

    // Diagonal touchpad swipe: dx scrolls the table horizontally; dy chains straight to .android-reading.
    applyChainedNativeScroll(origin, 140, 95, { centerLock: true });
    expect(table.scrollLeft).toBe(140);
    expect(reading.scrollTop).toBe(95);
    expect(reading.scrollLeft).toBe(0);

    // Past horizontal right edge of table: centerLock prevents horizontal bleed onto .android-reading.
    applyChainedNativeScroll(origin, 500, 30, { centerLock: true });
    expect(table.scrollLeft).toBe(400);
    expect(reading.scrollLeft).toBe(0);
    expect(reading.scrollTop).toBe(125);
  });

  it('routes inline study regions (nested code inside .step-cards-notes -> .step-cards-layout -> .android-reading)', () => {
    document.body.innerHTML = `
      <section class="android-reading" style="overflow: auto;">
        <div class="document-page-space">
          <div class="document-page" data-scale="1">
            <article class="markdown-body">
              <section class="step-cards">
                <div class="step-cards-layout" style="overflow-y: auto;">
                  <div class="step-cards-notes" style="overflow-y: auto;">
                    <div class="markdown-body">
                      <pre id="study-code" style="overflow: auto;"><span>x = 42</span></pre>
                    </div>
                  </div>
                </div>
              </section>
            </article>
          </div>
        </div>
      </section>
    `;
    const reading = document.querySelector<HTMLElement>('.android-reading')!;
    const layout = document.querySelector<HTMLElement>('.step-cards-layout')!;
    const notes = document.querySelector<HTMLElement>('.step-cards-notes')!;
    const pre = document.getElementById('study-code')!;

    mockScrollMetrics(reading, { clientHeight: 600, scrollHeight: 2200 });
    mockScrollMetrics(layout, { clientHeight: 400, scrollHeight: 400 }); // not overflowing on desktop width
    mockScrollMetrics(notes, { clientHeight: 240, scrollHeight: 340 }); // 100px vertical room
    mockScrollMetrics(pre, { clientWidth: 220, scrollWidth: 420, clientHeight: 80, scrollHeight: 80 }); // horizontal only

    const origin = resolveNativeWheelScrollOrigin(pre.firstElementChild)!;
    expect(origin).toBe(pre);
    expect(collectNativeWheelScrollChain(origin)).toEqual([pre, notes, layout, reading]);

    // Horizontal scrolls <pre>, vertical skips <pre> (0 vertical room) and scrolls .step-cards-notes first,
    // then chains remaining 45px past .step-cards-layout (0 room) into .android-reading!
    applyChainedNativeScroll(origin, 75, 145, { centerLock: true });
    expect(pre.scrollLeft).toBe(75);
    expect(notes.scrollTop).toBe(100);
    expect(reading.scrollTop).toBe(45);
  });

  it('compensates for .document-page compositor zoom scale when scrolling inner regions and chaining remainder', () => {
    document.body.innerHTML = `
      <section class="android-reading" style="overflow: auto;">
        <div class="document-page-space">
          <div class="document-page" data-scale="2">
            <article class="markdown-body">
              <pre id="zoomed-pre" style="overflow: auto;"><code>wide zoomed code</code></pre>
            </article>
          </div>
        </div>
      </section>
    `;
    const reading = document.querySelector<HTMLElement>('.android-reading')!;
    const pre = document.getElementById('zoomed-pre')!;

    mockScrollMetrics(reading, { clientWidth: 800, scrollWidth: 1600, clientHeight: 600, scrollHeight: 3000 });
    // 50 CSS layout px of horizontal room = 100 screen px at data-scale="2".
    mockScrollMetrics(pre, { clientWidth: 300, scrollWidth: 350, clientHeight: 100, scrollHeight: 100 });

    // 160 screen px horizontal delta -> consumes all 50 layout px (100 screen px) in <pre> and chains 60 screen px to .android-reading.
    applyChainedNativeScroll(pre, 160, 0, { centerLock: false });
    expect(pre.scrollLeft).toBe(50);
    expect(reading.scrollLeft).toBe(60);
  });

  it('contains modal overlays (.step-viewer and .theme-guide-dialog) without leaking scroll into .android-reading', () => {
    document.body.innerHTML = `
      <section class="android-reading" style="overflow: auto;"></section>
      <div class="image-viewer step-viewer" role="dialog">
        <div class="step-cards-notes" style="overflow-y: auto;">
          <div class="markdown-body"><pre id="modal-pre" style="overflow: auto;">code</pre></div>
        </div>
      </div>
      <div class="theme-guide-scrim">
        <section class="theme-guide-dialog" role="dialog">
          <header><h2 id="guide-title">Custom themes</h2></header>
          <div class="theme-guide-body" style="overflow: auto;">
            <div class="markdown-body"><table id="guide-table" style="display: block; overflow-x: auto;"></table></div>
          </div>
        </section>
      </div>
    `;
    const reading = document.querySelector<HTMLElement>('.android-reading')!;
    const modalNotes = document.querySelector<HTMLElement>('.step-viewer .step-cards-notes')!;
    const modalPre = document.getElementById('modal-pre')!;
    const guideTitle = document.getElementById('guide-title')!;
    const guideBody = document.querySelector<HTMLElement>('.theme-guide-body')!;
    const guideTable = document.getElementById('guide-table')!;

    mockScrollMetrics(reading, { clientHeight: 600, scrollHeight: 2400, scrollTop: 320 });
    mockScrollMetrics(modalNotes, { clientHeight: 200, scrollHeight: 250 });
    mockScrollMetrics(modalPre, { clientWidth: 200, scrollWidth: 300, clientHeight: 80, scrollHeight: 80 });
    mockScrollMetrics(guideBody, { clientHeight: 400, scrollHeight: 900 });
    mockScrollMetrics(guideTable, { clientWidth: 400, scrollWidth: 700, clientHeight: 120, scrollHeight: 120 });

    // Fullscreen step-viewer chains from modalPre -> modalNotes and stops at .step-viewer.
    const stepOrigin = resolveNativeWheelScrollOrigin(modalPre)!;
    applyChainedNativeScroll(stepOrigin, 40, 200);
    expect(modalPre.scrollLeft).toBe(40);
    expect(modalNotes.scrollTop).toBe(50);
    expect(reading.scrollTop).toBe(320);

    // Theme guide chains from guideTable -> guideBody and stops at .theme-guide-dialog; header falls back to guideBody.
    const tableOrigin = resolveNativeWheelScrollOrigin(guideTable)!;
    applyChainedNativeScroll(tableOrigin, 90, 180);
    expect(guideTable.scrollLeft).toBe(90);
    expect(guideBody.scrollTop).toBe(180);
    expect(resolveNativeWheelScrollOrigin(guideTitle)).toBe(guideBody);
    expect(reading.scrollTop).toBe(320);
  });
});
