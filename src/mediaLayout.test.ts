// @vitest-environment jsdom
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LiveEditor from './components/LiveEditor';
import MarkdownPreview from './components/MarkdownPreview';
import { selectedMarkdown } from './copySource';
import { applyDocumentZoom, invalidateDocumentZoom, refreshDocumentExtent } from './documentZoom';
import { commitMediaLayout } from './mediaLayout';
import { markScrollInput } from './scrollAnchor';
import { rememberWindowedScrollSource } from './windowedSearch';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const BODE_PNG_DATA =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAIAAADwyuo0AAAADklEQVR42mNk+M/AQAQAAR8BAf3i8wAAAABJRU5ErkJggg==';
const STEP_WEBP_DATA =
  'data:image/webp;base64,UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAfQ//73v/+BiOh/AAA=';
const NYQUIST_SVG_DATA =
  'data:image/svg+xml;base64,' +
  btoa(
    '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180"><circle cx="160" cy="90" r="70" stroke="#2563eb" fill="none"/></svg>',
  );

const STEP_RESPONSE_ENCODED_SRC = 'Lab%20Figures/step-response.webp';

const STUDY_NOTE_LINES = [
  '# Feedback Control & Loop Shaping (Δφ ≥ 45°)',
  '',
  'Closed-loop transfer $T(s) = \\frac{L(s)}{1 + L(s)}$ with stability margin check[^margin] and inline code decoy `![[do-not-rewrite.png|999x999]]` plus `![inline-decoy](assets/noop.png)`.',
  '',
  '$$',
  '\\int_{-\\infty}^{\\infty} \\ln\\left|S(j\\omega)\\right|\\,d\\omega = \\pi \\sum_{k} \\operatorname{Re}(p_k)',
  '$$',
  '',
  '> [!WARNING] Measurement invariant ($\\|S\\|_\\infty \\le 1.6$)',
  '> Keep `[[#Feedback Control & Loop Shaping (Δφ ≥ 45°)]]` literal in code while preserving table pipes.',
  '',
  '| Signal | Gain \\| Phase | Bound |',
  '| :-- | :--: | --: |',
  '| Loop $L(j\\omega)$ | $-3.2\\text{ dB} \\| -132^\\circ$ | `<= 0 dB` |',
  '| Sensitivity $S(j\\omega)$ | $+4.1\\text{ dB} \\| +28^\\circ$ | `< 6 dB` |',
  '',
  '![Transfer (H_2)](<assets/image-bode-plot.png> "Magnitude & Phase")',
  '',
  '![[Lab Figures/step-response.webp|Measured step response (τ = 12.5 ms)]]',
  '',
  '![Nyquist contour][nyquist-ref]',
  '',
  '```svg',
  '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120" viewBox="0 0 240 120"><path d="M12 96 C 80 16, 160 16, 228 96" fill="none" stroke="#0f766e" stroke-width="3"/></svg>',
  '```',
  '',
  '```markdown',
  '![decoy-in-fence](assets/image-decoy.png)',
  '![[Fence Decoy.webp|320x200]]',
  ':::callout tip "Quoted fence decoy"',
  'Must remain literal fenced Markdown.',
  ':::',
  '```',
  '',
  '- [ ] Confirm phase margin on bench rig #2',
  '- [x] Archive baseline Bode sweep',
  '',
  'Surviving prose anchor below all media blocks: steady-state error $e_{ss} = 0$ under step disturbance.',
  '',
  '[nyquist-ref]: <' + NYQUIST_SVG_DATA + '> "Nyquist locus"',
  '[^margin]: Verified at crossover $\\omega_c = 142\\text{ rad/s}$.',
];

const COMPLEX_NOTE_LF = STUDY_NOTE_LINES.join('\n');
const COMPLEX_NOTE_CRLF = STUDY_NOTE_LINES.join('\r\n');

const LARGE_WINDOWED_APPENDIX =
  '\n\n## Appendix: Extended Telemetry Log\n\n' +
  'Sampled loop gain telemetry remains bounded across operating regimes without altering authored media references. '.repeat(
    760,
  );
const WINDOWED_COMPLEX_NOTE_LF = COMPLEX_NOTE_LF + LARGE_WINDOWED_APPENDIX;

async function flushMicrotasks(ticks = 8) {
  for (let i = 0; i < ticks; i += 1) {
    await Promise.resolve();
  }
}

function serializeRenderedMarkdown(host: HTMLElement, source: string): string {
  const root = host.querySelector<HTMLElement>('.live-document, .markdown-body')!;
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  const range = document.createRange();
  range.selectNodeContents(root);
  selection.addRange(range);
  const copied = selectedMarkdown(selection, source);
  selection.removeAllRanges();
  return copied ?? '';
}

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  readonly observed = new Set<Element>();
  constructor(readonly callback: IntersectionObserverCallback) {
    FakeIntersectionObserver.instances.push(this);
  }
  observe(target: Element) {
    this.observed.add(target);
  }
  unobserve(target: Element) {
    this.observed.delete(target);
  }
  disconnect() {
    this.observed.clear();
  }
  emit(target: Element, isIntersecting: boolean) {
    this.callback([{ target, isIntersecting } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
  emitVisibleWithoutAppendix() {
    const targets = Array.from(this.observed);
    const visibleTargets = targets.length > 1 ? targets.slice(0, -1) : targets;
    const entries = visibleTargets.map((target) => ({ target, isIntersecting: true }) as IntersectionObserverEntry);
    if (entries.length) {
      this.callback(entries, this as unknown as IntersectionObserver);
    }
  }
}

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  readonly observed = new Set<Element>();
  constructor(readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }
  observe(target: Element) {
    this.observed.add(target);
  }
  unobserve(target: Element) {
    this.observed.delete(target);
  }
  disconnect() {
    this.observed.clear();
  }
  emit(target: Element, height: number, borderBlockSize?: number) {
    const entry = {
      target,
      contentRect: { height, width: 760 } as DOMRectReadOnly,
      borderBoxSize:
        borderBlockSize !== undefined
          ? ([{ blockSize: borderBlockSize, inlineSize: 760 }] as unknown as ReadonlyArray<ResizeObserverSize>)
          : undefined,
    } as ResizeObserverEntry;
    this.callback([entry], this as unknown as ResizeObserver);
  }
}

interface PendingAssetCall {
  id: string;
  command: string;
  args: Record<string, unknown>;
}

function installFakeNativeBridge(autoAssets?: Record<string, string>) {
  const queue: PendingAssetCall[] = [];
  window.SuperMD = {
    post(id: string, command: string, rawArgs: string) {
      const args = JSON.parse(rawArgs) as Record<string, unknown>;
      if (autoAssets && command === 'resolve_reader_asset') {
        queueMicrotask(() => window.supermdReply?.(id, null, null));
        return;
      }
      if (autoAssets && command === 'load_asset') {
        const source = String(args.source ?? '');
        const resolved = autoAssets[source];
        queueMicrotask(() => {
          if (resolved !== undefined) window.supermdReply?.(id, resolved, null);
          else window.supermdReply?.(id, null, `Missing asset: ${source}`);
        });
        return;
      }
      queue.push({ id, command, args });
    },
  };
  return {
    queue,
    reply(predicate: (call: PendingAssetCall) => boolean, value: unknown, error: string | null = null): number {
      let count = 0;
      for (let i = queue.length - 1; i >= 0; i -= 1) {
        if (predicate(queue[i])) {
          const [call] = queue.splice(i, 1);
          window.supermdReply?.(call.id, value, error);
          count += 1;
        }
      }
      return count;
    },
  };
}

const DEFAULT_AUTO_ASSETS: Record<string, string> = {
  'assets/image-bode-plot.png': BODE_PNG_DATA,
  [STEP_RESPONSE_ENCODED_SRC]: STEP_WEBP_DATA,
};

const originalElementFromPoint = Object.getOwnPropertyDescriptor(document, 'elementFromPoint');
const originalCaretRangeFromPoint = Object.getOwnPropertyDescriptor(document, 'caretRangeFromPoint');
const originalRangeGetClientRect = Object.getOwnPropertyDescriptor(Range.prototype, 'getBoundingClientRect');

describe('commitMediaLayout', () => {
  let reactRoot: Root | null = null;
  const zoomedRoots = new Set<HTMLElement>();

  function trackZoomedRoot(root: HTMLElement) {
    zoomedRoots.add(root);
    return root;
  }

  async function mountLiveNote(options: {
    initialMarkdown: string;
    rootClass?: 'android-reading' | 'reading-scroll' | 'live-pane';
    documentPath?: string | null;
    windowed?: boolean;
    mode?: 'live' | 'preview';
  }) {
    const {
      initialMarkdown,
      rootClass = 'android-reading',
      documentPath = '/notes/control-systems.md',
      windowed = false,
      mode = 'live',
    } = options;

    let latestMarkdown = initialMarkdown;
    const changeHistory: string[] = [];

    function Harness() {
      const [markdown, setMarkdown] = useState(initialMarkdown);
      latestMarkdown = markdown;
      const handleChange = (next: string) => {
        changeHistory.push(next);
        setMarkdown(next);
      };
      return createElement(
        'div',
        { className: rootClass },
        createElement(
          'div',
          { className: 'document-space' },
          createElement(
            'div',
            { className: 'document-page' },
            mode === 'live'
              ? createElement(LiveEditor, {
                  markdown,
                  onChange: handleChange,
                  documentPath,
                  python: '',
                  dark: false,
                  fullDocumentAccessibility: !windowed,
                })
              : createElement(MarkdownPreview, {
                  markdown,
                  onChange: handleChange,
                  documentPath,
                  python: '',
                  dark: false,
                  fullDocumentAccessibility: !windowed,
                }),
          ),
        ),
      );
    }

    const host = document.createElement('div');
    document.body.appendChild(host);
    reactRoot = createRoot(host);
    await act(async () => {
      reactRoot?.render(createElement(Harness));
    });

    return {
      host,
      scroller: host.querySelector<HTMLElement>(`.${rootClass}`)!,
      space: host.querySelector<HTMLElement>('.document-space')!,
      page: host.querySelector<HTMLElement>('.document-page')!,
      getMarkdown: () => latestMarkdown,
      changeHistory,
    };
  }

  beforeEach(() => {
    FakeIntersectionObserver.instances = [];
    FakeResizeObserver.instances = [];
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: () => null,
    });
    document.body.replaceChildren();
  });

  afterEach(() => {
    for (const root of zoomedRoots) {
      invalidateDocumentZoom(root);
    }
    zoomedRoots.clear();
    if (reactRoot) {
      act(() => reactRoot?.unmount());
      reactRoot = null;
    }
    delete window.SuperMD;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (originalElementFromPoint) {
      Object.defineProperty(document, 'elementFromPoint', originalElementFromPoint);
    } else {
      Reflect.deleteProperty(document, 'elementFromPoint');
    }
    if (originalCaretRangeFromPoint) {
      Object.defineProperty(document, 'caretRangeFromPoint', originalCaretRangeFromPoint);
    } else {
      Reflect.deleteProperty(document, 'caretRangeFromPoint');
    }
    if (originalRangeGetClientRect) {
      Object.defineProperty(Range.prototype, 'getBoundingClientRect', originalRangeGetClientRect);
    } else {
      Reflect.deleteProperty(Range.prototype, 'getBoundingClientRect');
    }
    document.body.replaceChildren();
  });

  it('handles null targets, unanchored elements, and non-scrolled windowed blocks without mutating note Markdown', async () => {
    installFakeNativeBridge(DEFAULT_AUTO_ASSETS);
    const note = await mountLiveNote({ initialMarkdown: COMPLEX_NOTE_LF, rootClass: 'reading-scroll', mode: 'preview' });
    trackZoomedRoot(note.scroller);

    await act(async () => {
      await flushMicrotasks();
    });

    Object.defineProperty(note.scroller, 'clientWidth', { configurable: true, get: () => 820 });
    Object.defineProperty(note.page, 'offsetHeight', { configurable: true, get: () => 960 });
    applyDocumentZoom(note.scroller, 125, 100);
    note.scroller.scrollTop = 310;
    expect(note.space.style.height).toBe('1200px');

    let nullCommits = 0;
    commitMediaLayout(null, () => {
      nullCommits += 1;
    });
    expect(nullCommits).toBe(1);
    expect(note.scroller.scrollTop).toBe(310);
    expect(note.space.style.height).toBe('1200px');
    expect(note.getMarkdown()).toBe(COMPLEX_NOTE_LF);

    const detachedImg = document.createElement('img');
    let detachedCommits = 0;
    commitMediaLayout(detachedImg, () => {
      detachedCommits += 1;
    });
    expect(detachedCommits).toBe(1);
    expect(note.scroller.scrollTop).toBe(310);
    expect(note.space.style.height).toBe('1200px');
    expect(note.getMarkdown()).toBe(COMPLEX_NOTE_LF);

    const standaloneBlock = document.createElement('section');
    standaloneBlock.setAttribute('data-windowed-block', '');
    const nestedMedia = document.createElement('img');
    standaloneBlock.appendChild(nestedMedia);
    document.body.appendChild(standaloneBlock);

    const events: Array<{ target: EventTarget | null; bubbles: boolean }> = [];
    const outerSpy = vi.fn();
    document.body.addEventListener('supermd-media-layout', outerSpy);
    standaloneBlock.addEventListener('supermd-media-layout', (event) => {
      events.push({ target: event.target, bubbles: event.bubbles });
    });

    commitMediaLayout(nestedMedia, () => {
      nestedMedia.dataset.ready = 'nested';
    });
    commitMediaLayout(standaloneBlock, () => {
      standaloneBlock.dataset.ready = 'self';
    });
    document.body.removeEventListener('supermd-media-layout', outerSpy);

    expect(nestedMedia.dataset.ready).toBe('nested');
    expect(standaloneBlock.dataset.ready).toBe('self');
    expect(events).toEqual([
      { target: standaloneBlock, bubbles: false },
      { target: standaloneBlock, bubbles: false },
    ]);
    expect(outerSpy).not.toHaveBeenCalled();
    expect(note.scroller.scrollTop).toBe(310);
    expect(note.space.style.height).toBe('1200px');
    expect(note.changeHistory).toEqual([]);
    expect(note.getMarkdown()).toBe(COMPLEX_NOTE_LF);
  });

  it.each(['android-reading', 'reading-scroll', 'live-pane'] as const)(
    'flushes React DOM updates synchronously under .%s before extent refresh and scroll restoration while keeping full Markdown',
    async (rootClass) => {
      installFakeNativeBridge(DEFAULT_AUTO_ASSETS);
      const note = await mountLiveNote({
        initialMarkdown: COMPLEX_NOTE_LF,
        rootClass,
        mode: rootClass === 'reading-scroll' ? 'preview' : 'live',
      });
      trackZoomedRoot(note.scroller);

      await act(async () => {
        await flushMicrotasks();
      });

      const svgImg = note.host.querySelector<HTMLImageElement>('figure.svg-figure img.svg-diagram')!;
      expect(svgImg).not.toBeNull();
      expect(note.host.querySelector('figure.svg-figure .image-loading')).not.toBeNull();

      const anchorParagraph = Array.from(note.host.querySelectorAll<HTMLElement>('p')).find((p) =>
        p.textContent?.includes('Surviving prose anchor below all media blocks'),
      )!;
      expect(anchorParagraph).not.toBeNull();

      // Derive layout expansion directly from the React DOM mutation flushed by commitMediaLayout:
      // before flushSync, `.image-loading` is still mounted (unexpanded); once flushSync commits, `.image-loading` is removed!
      const isSvgSizedInDom = () => note.host.querySelector('figure.svg-figure .image-loading') === null;

      Object.defineProperty(note.scroller, 'clientWidth', { configurable: true, get: () => 800 });
      Object.defineProperty(note.scroller, 'clientHeight', { configurable: true, get: () => 600 });
      Object.defineProperty(note.scroller, 'scrollHeight', {
        configurable: true,
        get: () => (isSvgSizedInDom() ? 2160 : 1620),
      });
      Object.defineProperty(note.page, 'offsetHeight', {
        configurable: true,
        get: () => (isSvgSizedInDom() ? 1440 : 1080),
      });
      vi.spyOn(note.scroller, 'getBoundingClientRect').mockReturnValue({
        top: 0,
        left: 0,
        bottom: 600,
        right: 800,
        width: 800,
        height: 600,
      } as DOMRect);
      vi.spyOn(note.page, 'getBoundingClientRect').mockReturnValue({
        top: 0,
        left: 16,
        bottom: 1080,
        right: 784,
        width: 768,
        height: 1080,
      } as DOMRect);
      vi.spyOn(anchorParagraph, 'getBoundingClientRect').mockImplementation(() => {
        const top = (isSvgSizedInDom() ? 1090 : 730) - note.scroller.scrollTop;
        return {
          top,
          bottom: top + 44,
          left: 24,
          right: 760,
          width: 736,
          height: 44,
        } as DOMRect;
      });

      applyDocumentZoom(note.scroller, 150, 100);
      expect(note.space.style.height).toBe('1620px');

      note.scroller.scrollTop = 580;
      const anchorTopBefore = anchorParagraph.getBoundingClientRect().top;
      expect(anchorTopBefore).toBe(150);

      act(() => {
        svgImg.dispatchEvent(new Event('load'));
      });

      expect(isSvgSizedInDom()).toBe(true);
      expect(svgImg.style.visibility).not.toBe('hidden');
      expect(note.space.style.height).toBe('2160px');
      expect(note.scroller.scrollTop).toBe(940);
      expect(anchorParagraph.getBoundingClientRect().top).toBe(anchorTopBefore);

      const observedSteps: string[] = [];
      const enclosingBlock = document.createElement('div');
      enclosingBlock.setAttribute('data-windowed-block', '');
      note.page.appendChild(enclosingBlock);
      const probeTarget = document.createElement('img');
      enclosingBlock.appendChild(probeTarget);
      enclosingBlock.addEventListener('supermd-media-layout', () => {
        observedSteps.push(`event:flushed=${probeTarget.dataset.flushed}:space=${note.space.style.height}`);
      });

      commitMediaLayout(probeTarget, () => {
        probeTarget.dataset.flushed = 'true';
        observedSteps.push('update');
      });
      expect(observedSteps).toEqual(['update', 'event:flushed=true:space=2160px']);
      expect(note.changeHistory).toEqual([]);
      expect(note.getMarkdown()).toBe(COMPLEX_NOTE_LF);
    },
  );

  it('guards invalid, zero, negative, and NaN sizes, scales, and caret rects without corrupting layout or Markdown', async () => {
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    installFakeNativeBridge(DEFAULT_AUTO_ASSETS);

    const note = await mountLiveNote({
      initialMarkdown: WINDOWED_COMPLEX_NOTE_LF,
      rootClass: 'android-reading',
      windowed: true,
      mode: 'live',
    });
    trackZoomedRoot(note.scroller);

    await act(async () => {
      FakeIntersectionObserver.instances.forEach((observer) => observer.emitVisibleWithoutAppendix());
      await flushMicrotasks();
    });

    let currentWidth = 800;
    let currentOffsetHeight = 1000;
    Object.defineProperty(note.scroller, 'clientWidth', { configurable: true, get: () => currentWidth });
    Object.defineProperty(note.scroller, 'clientHeight', { configurable: true, get: () => 0 });
    Object.defineProperty(note.scroller, 'scrollHeight', { configurable: true, get: () => 0 });
    Object.defineProperty(note.page, 'offsetHeight', { configurable: true, get: () => currentOffsetHeight });

    vi.spyOn(note.scroller, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      left: 0,
      bottom: 600,
      right: 800,
      width: 800,
      height: 600,
    } as DOMRect);
    vi.spyOn(note.page, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      left: 16,
      bottom: 1000,
      right: 784,
      width: 768,
      height: 1000,
    } as DOMRect);

    applyDocumentZoom(note.scroller, 100, 100);
    expect(note.space.style.height).toBe('1000px');

    const svgImg = note.host.querySelector<HTMLImageElement>('figure.svg-figure img.svg-diagram')!;
    const svgBlock = svgImg.closest<HTMLElement>('[data-windowed-block]')!;
    expect(svgBlock).not.toBeNull();

    // 1. Invalid, zero, and NaN dataset.scale values fall back safely to scale=1 instead of writing 0px or NaNpx.
    for (const badScale of ['0', 'NaN', 'invalid-scale', '']) {
      note.page.dataset.scale = badScale;
      currentOffsetHeight += 50;
      commitMediaLayout(svgImg, () => {});
      expect(note.space.style.height).toBe(`${currentOffsetHeight}px`);
      expect(note.space.style.height).not.toContain('NaN');
      expect(note.space.style.height).not.toBe('0px');
    }
    note.page.dataset.scale = '1';

    // 2. Zero clientWidth (collapsed/hidden viewport) causes refreshDocumentExtent to bail out cleanly.
    const heightBeforeZeroViewport = note.space.style.height;
    currentWidth = 0;
    currentOffsetHeight = 1400;
    expect(refreshDocumentExtent(note.scroller)).toBe(false);
    commitMediaLayout(svgImg, () => {});
    expect(note.space.style.height).toBe(heightBeforeZeroViewport);
    currentWidth = 800;

    // 3. Zero and NaN caret Range heights are rejected by scrollAnchor & windowedScrollSource; scrollTop never becomes NaN.
    const anchorBlock = Array.from(note.host.querySelectorAll<HTMLElement>('[data-windowed-mounted="true"]')).at(-1)!;
    const textNode = document.createTextNode('Caret anchor sample');
    anchorBlock.appendChild(textNode);
    const badRange = document.createRange();
    badRange.setStart(textNode, 0);
    badRange.setEnd(textNode, 1);

    for (const badHeight of [0, Number.NaN]) {
      Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({ top: Number.NaN, bottom: Number.NaN, left: 0, right: 0, width: 0, height: badHeight }),
      });
      Object.defineProperty(document, 'caretRangeFromPoint', {
        configurable: true,
        value: () => badRange,
      });
      markScrollInput();
      rememberWindowedScrollSource(note.scroller, -60);
      note.scroller.scrollTop = 240;

      const unwindowedTarget = document.createElement('img');
      note.scroller.appendChild(unwindowedTarget);
      commitMediaLayout(unwindowedTarget, () => {});
      unwindowedTarget.remove();
      expect(Number.isNaN(note.scroller.scrollTop)).toBe(false);

      commitMediaLayout(svgImg, () => {});
      expect(Number.isNaN(note.scroller.scrollTop)).toBe(false);
    }
    textNode.remove();

    // 4. WindowedBlock ResizeObserver and offscreen unmount ignore 0, negative, and NaN measurements.
    const resizeObserver = FakeResizeObserver.instances.find((obs) => obs.observed.has(svgBlock))!;
    expect(resizeObserver).toBeDefined();
    act(() => {
      resizeObserver.emit(svgBlock, 384);
      resizeObserver.emit(svgBlock, 0, 0);
      resizeObserver.emit(svgBlock, -48, -48);
      resizeObserver.emit(svgBlock, Number.NaN, Number.NaN);
    });

    for (const invalidRectHeight of [0, -32, Number.NaN]) {
      vi.spyOn(svgBlock, 'getBoundingClientRect').mockReturnValue({
        top: 0,
        bottom: 0,
        left: 0,
        right: 800,
        width: 800,
        height: invalidRectHeight,
      } as DOMRect);
      await act(async () => {
        FakeIntersectionObserver.instances.forEach((obs) => {
          if (obs.observed.has(svgBlock)) obs.emit(svgBlock, false);
        });
      });
      expect(svgBlock.style.height).toBe('384px');
      await act(async () => {
        FakeIntersectionObserver.instances.forEach((obs) => {
          if (obs.observed.has(svgBlock)) obs.emit(svgBlock, true);
        });
      });
    }

    expect(note.changeHistory).toEqual([]);
    expect(note.getMarkdown()).toBe(WINDOWED_COMPLEX_NOTE_LF);
  });

  it('acts as a strict no-op when media geometry and resolved state are unchanged', async () => {
    installFakeNativeBridge(DEFAULT_AUTO_ASSETS);
    const note = await mountLiveNote({ initialMarkdown: COMPLEX_NOTE_LF, rootClass: 'live-pane', mode: 'live' });
    trackZoomedRoot(note.scroller);

    await act(async () => {
      await flushMicrotasks();
    });

    const bodeImg = note.host.querySelector<HTMLImageElement>(
      '[data-note-image-source="assets/image-bode-plot.png"] img',
    )!;
    const svgImg = note.host.querySelector<HTMLImageElement>('figure.svg-figure img.svg-diagram')!;
    const anchorParagraph = Array.from(note.host.querySelectorAll<HTMLElement>('p')).find((p) =>
      p.textContent?.includes('Surviving prose anchor below all media blocks'),
    )!;

    act(() => {
      bodeImg.dispatchEvent(new Event('load'));
      svgImg.dispatchEvent(new Event('load'));
    });

    Object.defineProperty(note.scroller, 'clientWidth', { configurable: true, get: () => 800 });
    Object.defineProperty(note.scroller, 'clientHeight', { configurable: true, get: () => 600 });
    Object.defineProperty(note.scroller, 'scrollHeight', { configurable: true, get: () => 1800 });
    Object.defineProperty(note.page, 'offsetHeight', { configurable: true, get: () => 1200 });
    vi.spyOn(note.scroller, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      left: 0,
      bottom: 600,
      right: 800,
      width: 800,
      height: 600,
    } as DOMRect);
    vi.spyOn(note.page, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      left: 16,
      bottom: 1200,
      right: 784,
      width: 768,
      height: 1200,
    } as DOMRect);
    vi.spyOn(anchorParagraph, 'getBoundingClientRect').mockImplementation(
      () =>
        ({
          top: 640 - note.scroller.scrollTop,
          bottom: 680 - note.scroller.scrollTop,
          left: 24,
          right: 760,
          width: 736,
          height: 40,
        }) as DOMRect,
    );

    applyDocumentZoom(note.scroller, 150, 100);
    note.scroller.scrollTop = 500;
    const heightSnapshot = note.space.style.height;
    const scrollSnapshot = note.scroller.scrollTop;
    const anchorTopSnapshot = anchorParagraph.getBoundingClientRect().top;
    const renderedCopyBefore = serializeRenderedMarkdown(note.host, note.getMarkdown());
    expect(renderedCopyBefore).not.toContain('Loading drawing…');

    const spaceHeightSetter = vi.spyOn(note.space.style, 'height', 'set');

    act(() => {
      commitMediaLayout(bodeImg, () => {});
      bodeImg.dispatchEvent(new Event('load'));
      svgImg.dispatchEvent(new Event('load'));
    });

    expect(spaceHeightSetter).not.toHaveBeenCalled();
    expect(note.space.style.height).toBe(heightSnapshot);
    expect(note.scroller.scrollTop).toBe(scrollSnapshot);
    expect(anchorParagraph.getBoundingClientRect().top).toBe(anchorTopSnapshot);
    expect(serializeRenderedMarkdown(note.host, note.getMarkdown())).toBe(renderedCopyBefore);
    expect(note.changeHistory).toEqual([]);
    expect(note.getMarkdown()).toBe(COMPLEX_NOTE_LF);
  });

  it('is idempotent across repeated commits for the same media layout transition', async () => {
    installFakeNativeBridge(DEFAULT_AUTO_ASSETS);
    const note = await mountLiveNote({ initialMarkdown: COMPLEX_NOTE_LF, rootClass: 'reading-scroll', mode: 'preview' });
    trackZoomedRoot(note.scroller);

    await act(async () => {
      await flushMicrotasks();
    });

    const stepImg = note.host.querySelector<HTMLImageElement>(
      `[data-note-image-source="${STEP_RESPONSE_ENCODED_SRC}"] img`,
    )!;
    expect(stepImg).not.toBeNull();
    const stepWrapper = stepImg.closest<HTMLElement>('[data-note-image-source]')!;
    const anchorParagraph = Array.from(note.host.querySelectorAll<HTMLElement>('p')).find((p) =>
      p.textContent?.includes('Surviving prose anchor below all media blocks'),
    )!;

    const isStepSizedInDom = () => !stepWrapper.classList.contains('image-loading');
    Object.defineProperty(note.scroller, 'clientWidth', { configurable: true, get: () => 800 });
    Object.defineProperty(note.scroller, 'clientHeight', { configurable: true, get: () => 600 });
    Object.defineProperty(note.scroller, 'scrollHeight', {
      configurable: true,
      get: () => (isStepSizedInDom() ? 1950 : 1500),
    });
    Object.defineProperty(note.page, 'offsetHeight', {
      configurable: true,
      get: () => (isStepSizedInDom() ? 1300 : 1000),
    });
    vi.spyOn(note.scroller, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      left: 0,
      bottom: 600,
      right: 800,
      width: 800,
      height: 600,
    } as DOMRect);
    vi.spyOn(note.page, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      left: 16,
      bottom: 1000,
      right: 784,
      width: 768,
      height: 1000,
    } as DOMRect);
    vi.spyOn(anchorParagraph, 'getBoundingClientRect').mockImplementation(
      () =>
        ({
          top: (isStepSizedInDom() ? 1010 : 560) - note.scroller.scrollTop,
          bottom: (isStepSizedInDom() ? 1050 : 600) - note.scroller.scrollTop,
          left: 24,
          right: 760,
          width: 736,
          height: 40,
        }) as DOMRect,
    );

    applyDocumentZoom(note.scroller, 150, 100);
    note.scroller.scrollTop = 410;
    expect(note.space.style.height).toBe('1500px');
    expect(anchorParagraph.getBoundingClientRect().top).toBe(150);
    expect(stepWrapper.classList.contains('image-loading')).toBe(true);

    const copyWhileSizing = serializeRenderedMarkdown(note.host, note.getMarkdown());
    expect(copyWhileSizing).toContain('Loading image…');
    let settledCopySnapshot = '';

    for (let attempt = 0; attempt < 5; attempt += 1) {
      act(() => {
        stepImg.dispatchEvent(new Event('load'));
        commitMediaLayout(stepImg, () => {});
      });

      const currentCopy = serializeRenderedMarkdown(note.host, note.getMarkdown());
      if (attempt === 0) {
        settledCopySnapshot = currentCopy;
        expect(settledCopySnapshot).toBe(
          copyWhileSizing.replace(
            `Loading image…![Measured step response (τ = 12.5 ms)](${STEP_RESPONSE_ENCODED_SRC})`,
            `![Measured step response (τ = 12.5 ms)](${STEP_RESPONSE_ENCODED_SRC})`,
          ),
        );
      } else {
        expect(currentCopy).toBe(settledCopySnapshot);
      }

      expect(stepWrapper.classList.contains('image-loading')).toBe(false);
      expect(note.space.style.height).toBe('1950px');
      expect(note.scroller.scrollTop).toBe(860);
      expect(anchorParagraph.getBoundingClientRect().top).toBe(150);
      expect(note.getMarkdown()).toBe(COMPLEX_NOTE_LF);
    }
    expect(note.changeHistory).toEqual([]);
  });

  it('coordinates several media tokens in one note across out-of-order loads, decode failures, WindowedBlock remounts, and subsequent task edits', async () => {
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    const bridge = installFakeNativeBridge();

    const multiMediaWindowedNote =
      [
        '# Multi-Token Media Note',
        '',
        'Gallery row: ![Bode](<assets/image-bode-plot.png> "Bode") alongside ![[Lab Figures/step-response.webp|Step response]] with inline decoy `![[code-only.png]]`.',
        '',
        '![Nyquist contour][nyquist-ref]',
        '',
        '```svg',
        '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="90" viewBox="0 0 200 90"><rect x="4" y="4" width="192" height="82" fill="none" stroke="#334155"/></svg>',
        '```',
        '',
        '```markdown',
        '![fenced-decoy](assets/fenced-decoy.png)',
        '```',
        '',
        '- [ ] Sign off multi-media layout check',
        '',
        'Anchored conclusion paragraph after four media tokens and math $\\zeta = 0.707$.',
        '',
        '[nyquist-ref]: <' + NYQUIST_SVG_DATA + '> "Nyquist locus"',
      ].join('\n') + LARGE_WINDOWED_APPENDIX;

    const note = await mountLiveNote({
      initialMarkdown: multiMediaWindowedNote,
      rootClass: 'android-reading',
      windowed: true,
      mode: 'live',
    });
    trackZoomedRoot(note.scroller);

    await act(async () => {
      FakeIntersectionObserver.instances.forEach((obs) => obs.emitVisibleWithoutAppendix());
      await flushMicrotasks();
    });

    // Fenced and inline code decoys must never mount AssetImage elements.
    expect(note.host.querySelector('[data-note-image-source="assets/fenced-decoy.png"]')).toBeNull();
    expect(note.host.querySelector('[data-note-image-source="code-only.png"]')).toBeNull();
    expect(note.host.textContent).toContain('![[code-only.png]]');
    expect(note.host.textContent).toContain('![fenced-decoy](assets/fenced-decoy.png)');

    // Resolve raster capability probes first, then resolve assets out of order (second token before first token).
    await act(async () => {
      expect(bridge.reply((call) => call.command === 'resolve_reader_asset', null)).toBe(2);
      await flushMicrotasks();
    });

    await act(async () => {
      expect(
        bridge.reply(
          (call) => call.command === 'load_asset' && call.args.source === STEP_RESPONSE_ENCODED_SRC,
          STEP_WEBP_DATA,
        ),
      ).toBe(1);
      await flushMicrotasks();
    });
    expect(note.getMarkdown()).toBe(multiMediaWindowedNote);

    await act(async () => {
      expect(
        bridge.reply(
          (call) => call.command === 'load_asset' && call.args.source === 'assets/image-bode-plot.png',
          BODE_PNG_DATA,
        ),
      ).toBe(1);
      await flushMicrotasks();
    });
    expect(note.getMarkdown()).toBe(multiMediaWindowedNote);

    const galleryBlock = note.host
      .querySelector<HTMLElement>('[data-note-image-source="assets/image-bode-plot.png"]')!
      .closest<HTMLElement>('[data-windowed-block]')!;
    const conclusionBlock = Array.from(note.host.querySelectorAll<HTMLElement>('[data-windowed-block]')).find((block) =>
      block.textContent?.includes('Anchored conclusion paragraph after four media tokens'),
    )!;
    expect(galleryBlock.querySelectorAll('[data-note-image-source]')).toHaveLength(2);

    // Finish initial sizing of both gallery images, reference SVG image, and fenced SVG diagram.
    act(() => {
      for (const img of Array.from(note.host.querySelectorAll<HTMLImageElement>('img'))) {
        img.dispatchEvent(new Event('load'));
      }
    });
    expect(galleryBlock.querySelectorAll('.image-loading')).toHaveLength(0);
    expect(note.getMarkdown()).toBe(multiMediaWindowedNote);

    // Remount the gallery WindowedBlock after caching its 420px multi-media footprint.
    let remounted = false;
    vi.spyOn(galleryBlock, 'getBoundingClientRect').mockImplementation(() => {
      const h = !remounted || galleryBlock.style.minHeight ? 420 : 190;
      return {
        top: 300 - note.scroller.scrollTop,
        bottom: 300 - note.scroller.scrollTop + h,
        left: 0,
        right: 800,
        width: 800,
        height: h,
      } as DOMRect;
    });
    vi.spyOn(conclusionBlock, 'getBoundingClientRect').mockImplementation(() => {
      const top = (galleryBlock.style.minHeight ? 920 : 690) - note.scroller.scrollTop;
      return {
        top,
        bottom: top + 90,
        left: 0,
        right: 800,
        width: 800,
        height: 90,
      } as DOMRect;
    });
    Object.defineProperty(note.scroller, 'clientWidth', { configurable: true, get: () => 800 });
    Object.defineProperty(note.page, 'offsetHeight', {
      configurable: true,
      get: () => (galleryBlock.style.minHeight ? 1360 : 1130),
    });
    vi.spyOn(note.scroller, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      left: 0,
      bottom: 600,
      right: 800,
      width: 800,
      height: 600,
    } as DOMRect);
    vi.spyOn(note.page, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      left: 16,
      bottom: 1360,
      right: 784,
      width: 768,
      height: 1360,
    } as DOMRect);
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: () => galleryBlock,
    });

    const galleryObserver = FakeIntersectionObserver.instances.find((obs) => obs.observed.has(galleryBlock))!;
    await act(async () => {
      galleryObserver.emit(galleryBlock, false);
    });
    remounted = true;
    await act(async () => {
      galleryObserver.emit(galleryBlock, true);
      await flushMicrotasks();
    });
    expect(galleryBlock.style.minHeight).toBe('420px');
    expect(galleryBlock.querySelectorAll('.image-loading')).toHaveLength(2);

    applyDocumentZoom(note.scroller, 100, 100);
    expect(note.space.style.height).toBe('1360px');
    note.scroller.scrollTop = 440;
    const conclusionTopBefore = conclusionBlock.getBoundingClientRect().top;
    expect(conclusionTopBefore).toBe(480);

    // Resolve both gallery assets again after remount.
    await act(async () => {
      bridge.reply((call) => call.command === 'resolve_reader_asset', null);
      await flushMicrotasks();
    });
    await act(async () => {
      bridge.reply(
        (call) => call.command === 'load_asset' && call.args.source === 'assets/image-bode-plot.png',
        BODE_PNG_DATA,
      );
      bridge.reply(
        (call) => call.command === 'load_asset' && call.args.source === STEP_RESPONSE_ENCODED_SRC,
        STEP_WEBP_DATA,
      );
      await flushMicrotasks();
    });

    const remountedBodeImg = galleryBlock.querySelector<HTMLImageElement>(
      '[data-note-image-source="assets/image-bode-plot.png"] img',
    )!;
    const remountedStepImg = galleryBlock.querySelector<HTMLImageElement>(
      `[data-note-image-source="${STEP_RESPONSE_ENCODED_SRC}"] img`,
    )!;

    // First image loads: reserved minHeight stays 420px because the second image is still loading.
    act(() => {
      remountedBodeImg.dispatchEvent(new Event('load'));
    });
    expect(galleryBlock.style.minHeight).toBe('420px');
    expect(note.space.style.height).toBe('1360px');
    expect(note.getMarkdown()).toBe(multiMediaWindowedNote);

    // Second image fails decoding: commitMediaLayout swaps it to .image-error, clears the final .image-loading,
    // releases minHeight, updates document-space height, and keeps conclusionBlock anchored!
    act(() => {
      remountedStepImg.dispatchEvent(new Event('error'));
    });
    expect(galleryBlock.querySelector('.image-error')?.textContent).toContain('Image unavailable');
    expect(galleryBlock.querySelectorAll('.image-loading')).toHaveLength(0);
    expect(galleryBlock.style.minHeight).toBe('');
    expect(note.space.style.height).toBe('1130px');
    expect(note.scroller.scrollTop).toBe(210);
    expect(conclusionBlock.getBoundingClientRect().top).toBe(conclusionTopBefore);
    expect(note.getMarkdown()).toBe(multiMediaWindowedNote);

    // Toggling the task checkbox afterward edits only `[ ]` -> `[x]` and leaves every media token untouched.
    const checkbox = note.host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    act(() => {
      checkbox.click();
    });
    expect(note.getMarkdown()).toBe(
      multiMediaWindowedNote.replace('- [ ] Sign off multi-media layout check', '- [x] Sign off multi-media layout check'),
    );
  });

  it('preserves exact CRLF line endings and media tokens when committing media layout idle and during Live block editing', async () => {
    installFakeNativeBridge(DEFAULT_AUTO_ASSETS);
    const note = await mountLiveNote({
      initialMarkdown: COMPLEX_NOTE_CRLF,
      rootClass: 'live-pane',
      windowed: false,
      mode: 'live',
    });
    trackZoomedRoot(note.scroller);

    await act(async () => {
      await flushMicrotasks();
    });

    const bodeImg = note.host.querySelector<HTMLImageElement>(
      '[data-note-image-source="assets/image-bode-plot.png"] img',
    )!;
    const stepImg = note.host.querySelector<HTMLImageElement>(
      `[data-note-image-source="${STEP_RESPONSE_ENCODED_SRC}"] img`,
    )!;
    const nyquistImg = note.host.querySelector<HTMLImageElement>(
      `[data-note-image-source="${NYQUIST_SVG_DATA}"] img`,
    )!;
    const svgDiagramImg = note.host.querySelector<HTMLImageElement>('figure.svg-figure img.svg-diagram')!;
    expect(bodeImg).not.toBeNull();
    expect(stepImg).not.toBeNull();
    expect(nyquistImg).not.toBeNull();
    expect(svgDiagramImg).not.toBeNull();

    // Commit first two media tokens while CRLF note is idle.
    act(() => {
      bodeImg.dispatchEvent(new Event('load'));
      nyquistImg.dispatchEvent(new Event('load'));
    });
    expect(note.changeHistory).toEqual([]);
    expect(note.getMarkdown()).toBe(COMPLEX_NOTE_CRLF);

    // Open the Live block editor on the CRLF prose paragraph below all media blocks, then commit remaining media layouts!
    const editableBlocks = Array.from(note.host.querySelectorAll<HTMLElement>('.live-block'));
    const proseBlock = editableBlocks.find((block) =>
      block.textContent?.includes('Surviving prose anchor below all media blocks'),
    )!;
    expect(proseBlock).toBeDefined();

    act(() => {
      proseBlock.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    });
    const textarea = note.host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Edit Markdown block"]')!;
    expect(textarea).not.toBeNull();
    expect(textarea.value).toBe(
      'Surviving prose anchor below all media blocks: steady-state error $e_{ss} = 0$ under step disturbance.',
    );

    // Remaining media tokens finish loading/failing while the CRLF block editor is open.
    act(() => {
      stepImg.dispatchEvent(new Event('error'));
      svgDiagramImg.dispatchEvent(new Event('load'));
    });
    expect(note.getMarkdown()).toBe(COMPLEX_NOTE_CRLF);

    // Edit the open prose block and close it; verify the entire CRLF note matches byte-for-byte with CRLF preserved everywhere.
    const updatedSentence =
      'Surviving prose anchor below all media blocks: steady-state error $e_{ss} = 0$ verified at $T_s = 1\\text{ kHz}$.';
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, updatedSentence);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });

    const expectedAfterEdit = COMPLEX_NOTE_CRLF.replace(
      'Surviving prose anchor below all media blocks: steady-state error $e_{ss} = 0$ under step disturbance.',
      updatedSentence,
    );
    expect(note.getMarkdown()).toBe(expectedAfterEdit);

    // Toggle the first task checkbox in the CRLF note and verify exact full CRLF Markdown again.
    const checkboxes = Array.from(note.host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
    expect(checkboxes).toHaveLength(2);
    act(() => {
      checkboxes[0].click();
    });

    const expectedAfterTask = expectedAfterEdit.replace(
      '- [ ] Confirm phase margin on bench rig #2\r\n',
      '- [x] Confirm phase margin on bench rig #2\r\n',
    );
    expect(note.getMarkdown()).toBe(expectedAfterTask);
    expect(note.getMarkdown().split('\n').slice(0, -1).every((line) => line.endsWith('\r'))).toBe(true);
  });

  it('respects newer user scroll input, active heading navigation, and detached roots during commitMediaLayout', async () => {
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    installFakeNativeBridge(DEFAULT_AUTO_ASSETS);

    const note = await mountLiveNote({
      initialMarkdown: WINDOWED_COMPLEX_NOTE_LF,
      rootClass: 'android-reading',
      windowed: true,
      mode: 'live',
    });
    trackZoomedRoot(note.scroller);

    await act(async () => {
      FakeIntersectionObserver.instances.forEach((obs) => obs.emitVisibleWithoutAppendix());
      await flushMicrotasks();
    });

    let pageHeight = 1000;
    Object.defineProperty(note.scroller, 'clientWidth', { configurable: true, get: () => 800 });
    Object.defineProperty(note.scroller, 'clientHeight', { configurable: true, get: () => 600 });
    Object.defineProperty(note.scroller, 'scrollHeight', { configurable: true, get: () => pageHeight });
    Object.defineProperty(note.page, 'offsetHeight', { configurable: true, get: () => pageHeight });
    vi.spyOn(note.scroller, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      left: 0,
      bottom: 600,
      right: 800,
      width: 800,
      height: 600,
    } as DOMRect);
    vi.spyOn(note.page, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      left: 16,
      bottom: 1000,
      right: 784,
      width: 768,
      height: 1000,
    } as DOMRect);

    applyDocumentZoom(note.scroller, 100, 100);

    const blocks = Array.from(note.host.querySelectorAll<HTMLElement>('[data-windowed-block]'));
    expect(blocks.length).toBeGreaterThan(2);
    const changingBlock = blocks[0];
    const anchorBlock = blocks[1];
    vi.spyOn(anchorBlock, 'getBoundingClientRect').mockImplementation(
      () =>
        ({
          top: pageHeight - 500 - note.scroller.scrollTop,
          bottom: pageHeight - 420 - note.scroller.scrollTop,
          left: 0,
          right: 800,
          width: 800,
          height: 80,
        }) as DOMRect,
    );
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: () => anchorBlock,
    });

    // 1. Active heading navigation (`dataset.navigating`) leaves scrollTop under navigation's control while updating extent.
    note.scroller.scrollTop = 350;
    note.scroller.dataset.navigating = 'true';
    commitMediaLayout(changingBlock, () => {
      pageHeight = 1280;
    });
    expect(note.space.style.height).toBe('1280px');
    expect(note.scroller.scrollTop).toBe(350);
    delete note.scroller.dataset.navigating;

    // 2. Newer user scroll input during non-windowed commitMediaLayout prevents stale anchor restoration.
    const directImg = document.createElement('img');
    note.scroller.appendChild(directImg);
    note.scroller.scrollTop = 420;
    commitMediaLayout(directImg, () => {
      pageHeight = 1480;
      document.dispatchEvent(new WheelEvent('wheel'));
      note.scroller.scrollTop = 610;
    });
    expect(note.space.style.height).toBe('1480px');
    expect(note.scroller.scrollTop).toBe(610);
    directImg.remove();

    // 3. Detaching the scroll root inside update() skips restoration without throwing or mutating Markdown.
    commitMediaLayout(changingBlock, () => {
      pageHeight = 1600;
      note.host.remove();
    });
    expect(note.scroller.isConnected).toBe(false);
    expect(note.scroller.scrollTop).toBe(610);
    expect(note.changeHistory).toEqual([]);
    expect(note.getMarkdown()).toBe(WINDOWED_COMPLEX_NOTE_LF);
  });
});
