// @vitest-environment jsdom
import { act, createElement, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WindowedBlock from './components/WindowedBlock';
import { applyDocumentZoom, invalidateDocumentZoom, refreshDocumentExtent } from './documentZoom';
import { commitMediaLayout } from './mediaLayout';
import { captureScrollAnchor } from './scrollAnchor';
import { captureWindowedScrollAnchor } from './windowedSearch';

const originals = vi.hoisted(() => ({
  captureScrollAnchor: undefined as typeof import('./scrollAnchor').captureScrollAnchor | undefined,
  captureWindowedScrollAnchor: undefined as typeof import('./windowedSearch').captureWindowedScrollAnchor | undefined,
  refreshDocumentExtent: undefined as typeof import('./documentZoom').refreshDocumentExtent | undefined,
}));

vi.mock('./scrollAnchor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./scrollAnchor')>();
  originals.captureScrollAnchor = actual.captureScrollAnchor;
  return {
    ...actual,
    captureScrollAnchor: vi.fn(actual.captureScrollAnchor),
  };
});

vi.mock('./windowedSearch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./windowedSearch')>();
  originals.captureWindowedScrollAnchor = actual.captureWindowedScrollAnchor;
  return {
    ...actual,
    captureWindowedScrollAnchor: vi.fn(actual.captureWindowedScrollAnchor),
  };
});

vi.mock('./documentZoom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./documentZoom')>();
  originals.refreshDocumentExtent = actual.refreshDocumentExtent;
  return {
    ...actual,
    refreshDocumentExtent: vi.fn(actual.refreshDocumentExtent),
  };
});

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const originalElementFromPoint = Object.getOwnPropertyDescriptor(document, 'elementFromPoint');

describe('commitMediaLayout', () => {
  let reactRoot: Root | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    if (originals.captureScrollAnchor) {
      vi.mocked(captureScrollAnchor).mockImplementation(originals.captureScrollAnchor);
    }
    if (originals.captureWindowedScrollAnchor) {
      vi.mocked(captureWindowedScrollAnchor).mockImplementation(originals.captureWindowedScrollAnchor);
    }
    if (originals.refreshDocumentExtent) {
      vi.mocked(refreshDocumentExtent).mockImplementation(originals.refreshDocumentExtent);
    }
    document.body.replaceChildren();
  });

  afterEach(() => {
    if (reactRoot) {
      act(() => reactRoot?.unmount());
      reactRoot = null;
    }
    vi.unstubAllGlobals();
    if (originalElementFromPoint) {
      Object.defineProperty(document, 'elementFromPoint', originalElementFromPoint);
    } else {
      Reflect.deleteProperty(document, 'elementFromPoint');
    }
    document.body.replaceChildren();
  });

  it('null target still invokes update without scroll or extent side effects', () => {
    const updateSpy = vi.fn();

    commitMediaLayout(null, updateSpy);

    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(captureScrollAnchor).not.toHaveBeenCalled();
    expect(captureWindowedScrollAnchor).not.toHaveBeenCalled();
    expect(refreshDocumentExtent).not.toHaveBeenCalled();
  });

  it('a target outside scroll roots and windowed blocks only invokes update', () => {
    const wrapper = document.createElement('div');
    const target = document.createElement('img');
    wrapper.appendChild(target);
    document.body.appendChild(wrapper);

    const updateSpy = vi.fn();

    commitMediaLayout(target, updateSpy);

    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(captureScrollAnchor).not.toHaveBeenCalled();
    expect(captureWindowedScrollAnchor).not.toHaveBeenCalled();
    expect(refreshDocumentExtent).not.toHaveBeenCalled();
  });

  it.each(['android-reading', 'reading-scroll', 'live-pane'])(
    'a target under .%s captures and restores its scroll anchor and refreshes extent',
    (rootClass) => {
      const root = document.createElement('div');
      root.className = rootClass;
      const target = document.createElement('img');
      root.appendChild(target);
      document.body.appendChild(root);

      const restoreSpy = vi.fn();
      vi.mocked(captureScrollAnchor).mockReturnValue(restoreSpy);
      const updateSpy = vi.fn();

      commitMediaLayout(target, updateSpy);

      expect(captureScrollAnchor).toHaveBeenCalledTimes(1);
      expect(captureScrollAnchor).toHaveBeenCalledWith(root);
      expect(captureWindowedScrollAnchor).not.toHaveBeenCalled();
      expect(updateSpy).toHaveBeenCalledTimes(1);
      expect(refreshDocumentExtent).toHaveBeenCalledTimes(1);
      expect(refreshDocumentExtent).toHaveBeenCalledWith(root);
      expect(restoreSpy).toHaveBeenCalledTimes(1);
    },
  );

  it('matches when the target element itself is the windowed block inside a scroll root', () => {
    const root = document.createElement('div');
    root.className = 'android-reading';
    const block = document.createElement('section');
    block.setAttribute('data-windowed-block', '');
    root.appendChild(block);
    document.body.appendChild(root);

    const restoreSpy = vi.fn();
    vi.mocked(captureWindowedScrollAnchor).mockReturnValue(restoreSpy);
    const parentListener = vi.fn();
    const blockListener = vi.fn();
    root.addEventListener('supermd-media-layout', parentListener);
    block.addEventListener('supermd-media-layout', blockListener);

    const updateSpy = vi.fn();

    commitMediaLayout(block, updateSpy);

    expect(captureWindowedScrollAnchor).toHaveBeenCalledTimes(1);
    expect(captureWindowedScrollAnchor).toHaveBeenCalledWith(root, block);
    expect(captureScrollAnchor).not.toHaveBeenCalled();
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(blockListener).toHaveBeenCalledTimes(1);
    const event = blockListener.mock.calls[0][0] as Event;
    expect(event.type).toBe('supermd-media-layout');
    expect(event.bubbles).toBe(false);
    expect(parentListener).not.toHaveBeenCalled();
    expect(refreshDocumentExtent).toHaveBeenCalledTimes(1);
    expect(refreshDocumentExtent).toHaveBeenCalledWith(root);
    expect(restoreSpy).toHaveBeenCalledTimes(1);
  });

  it('dispatches supermd-media-layout event on block even without a scroll root', () => {
    const block = document.createElement('div');
    block.setAttribute('data-windowed-block', '');
    const target = document.createElement('img');
    block.appendChild(target);
    document.body.appendChild(block);

    const eventListenerSpy = vi.fn();
    block.addEventListener('supermd-media-layout', eventListenerSpy);
    const updateSpy = vi.fn();

    commitMediaLayout(target, updateSpy);

    expect(captureScrollAnchor).not.toHaveBeenCalled();
    expect(captureWindowedScrollAnchor).not.toHaveBeenCalled();
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(eventListenerSpy).toHaveBeenCalledTimes(1);
    expect(refreshDocumentExtent).not.toHaveBeenCalled();
  });

  it('synchronously flushes React DOM updates before supermd-media-layout, extent refresh, and anchor restore', async () => {
    let markSized: (() => void) | undefined;

    function MediaFixture() {
      const [sized, setSized] = useState(false);
      markSized = () => setSized(true);
      return createElement(
        'div',
        { className: 'live-pane' },
        createElement(
          'div',
          { 'data-windowed-block': '' },
          !sized ? createElement('span', { className: 'image-loading' }, 'Loading…') : null,
          createElement('img', { 'data-sized': String(sized) }),
        ),
      );
    }

    const host = document.createElement('div');
    document.body.appendChild(host);
    reactRoot = createRoot(host);
    await act(async () => {
      reactRoot?.render(createElement(MediaFixture));
    });

    const root = host.querySelector<HTMLElement>('.live-pane')!;
    const block = host.querySelector<HTMLElement>('[data-windowed-block]')!;
    const target = host.querySelector<HTMLElement>('img')!;

    const steps: string[] = [];

    const restoreSpy = vi.fn(() => {
      steps.push(`restore:sized=${target.getAttribute('data-sized')}:loading=${block.querySelectorAll('.image-loading').length}`);
    });

    vi.mocked(captureWindowedScrollAnchor).mockImplementation(() => {
      steps.push(`capture:sized=${target.getAttribute('data-sized')}:loading=${block.querySelectorAll('.image-loading').length}`);
      return restoreSpy;
    });

    block.addEventListener('supermd-media-layout', () => {
      steps.push(`event:sized=${target.getAttribute('data-sized')}:loading=${block.querySelectorAll('.image-loading').length}`);
    });

    vi.mocked(refreshDocumentExtent).mockImplementation(() => {
      steps.push(`extent:sized=${target.getAttribute('data-sized')}:loading=${block.querySelectorAll('.image-loading').length}`);
      return true;
    });

    act(() => {
      commitMediaLayout(target, () => {
        steps.push('update');
        markSized?.();
      });
    });

    expect(captureWindowedScrollAnchor).toHaveBeenCalledWith(root, block);
    expect(refreshDocumentExtent).toHaveBeenCalledWith(root);
    expect(steps).toEqual([
      'capture:sized=false:loading=1',
      'update',
      'event:sized=true:loading=0',
      'extent:sized=true:loading=0',
      'restore:sized=true:loading=0',
    ]);
  });

  it('preserves visible paragraph scroll offset and zoomed document extent when media grows above the viewport', () => {
    const root = document.createElement('div');
    root.className = 'reading-scroll';
    const space = document.createElement('div');
    const page = document.createElement('div');
    page.className = 'document-page';
    const img = document.createElement('img');
    const paragraph = document.createElement('p');
    paragraph.textContent = 'Anchored reading line';

    page.append(img, paragraph);
    space.appendChild(page);
    root.appendChild(space);
    document.body.appendChild(root);

    let mediaExpanded = false;
    Object.defineProperty(root, 'clientWidth', { configurable: true, get: () => 800 });
    Object.defineProperty(root, 'clientHeight', { configurable: true, get: () => 600 });
    Object.defineProperty(root, 'scrollHeight', { configurable: true, get: () => (mediaExpanded ? 1560 : 1200) });
    Object.defineProperty(page, 'offsetHeight', { configurable: true, get: () => (mediaExpanded ? 1040 : 800) });
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      left: 0,
      bottom: 600,
      right: 800,
      width: 800,
      height: 600,
    } as DOMRect);
    vi.spyOn(page, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      left: 16,
      bottom: 800,
      right: 784,
      width: 768,
      height: 800,
    } as DOMRect);
    vi.spyOn(paragraph, 'getBoundingClientRect').mockImplementation(
      () =>
        ({
          top: (mediaExpanded ? 910 : 550) - root.scrollTop,
          bottom: (mediaExpanded ? 950 : 590) - root.scrollTop,
          left: 24,
          right: 760,
          width: 736,
          height: 40,
        }) as DOMRect,
    );

    applyDocumentZoom(root, 150, 100);
    expect(space.style.height).toBe('1200px');

    root.scrollTop = 400;
    const viewportTopBefore = paragraph.getBoundingClientRect().top;
    expect(viewportTopBefore).toBe(150);

    commitMediaLayout(img, () => {
      mediaExpanded = true;
    });

    expect(space.style.height).toBe('1560px');
    expect(root.scrollTop).toBe(760);
    expect(paragraph.getBoundingClientRect().top).toBe(viewportTopBefore);

    invalidateDocumentZoom(root);
  });

  it('releases a remounted WindowedBlock footprint before extent refresh and windowed scroll restoration', async () => {
    class FakeIntersectionObserver {
      static instances: FakeIntersectionObserver[] = [];
      constructor(readonly callback: IntersectionObserverCallback) {
        FakeIntersectionObserver.instances.push(this);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
      emit(target: Element, isIntersecting: boolean) {
        this.callback([{ target, isIntersecting } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
      }
    }
    class FakeResizeObserver {
      observe() {}
      disconnect() {}
    }

    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);

    let finishMedia: (() => void) | undefined;
    function RemountableMedia() {
      const [failed, setFailed] = useState(false);
      const ref = useRef<HTMLDivElement>(null);
      finishMedia = () => commitMediaLayout(ref.current, () => setFailed(true));
      return createElement(
        'div',
        { ref },
        !failed
          ? createElement('span', { className: 'image-loading' }, 'Loading diagram…')
          : createElement('span', { className: 'image-error' }, 'Diagram unavailable'),
      );
    }

    const host = document.createElement('div');
    document.body.appendChild(host);
    reactRoot = createRoot(host);

    await act(async () => {
      reactRoot?.render(
        createElement(
          'div',
          { className: 'android-reading' },
          createElement(
            'div',
            { className: 'document-space' },
            createElement(
              'div',
              { className: 'document-page' },
              createElement(WindowedBlock, { enabled: true, children: createElement(RemountableMedia) }),
              createElement(WindowedBlock, { enabled: true, children: createElement('p', null, 'Surviving chapter text') }),
            ),
          ),
        ),
      );
    });

    const root = host.querySelector<HTMLElement>('.android-reading')!;
    const page = host.querySelector<HTMLElement>('.document-page')!;
    const space = host.querySelector<HTMLElement>('.document-space')!;
    const [mediaBlock, textBlock] = Array.from(host.querySelectorAll<HTMLElement>('[data-windowed-block]'));
    const observer = FakeIntersectionObserver.instances[0];

    await act(async () => {
      observer.emit(mediaBlock, true);
      observer.emit(textBlock, true);
    });
    await act(async () => {
      finishMedia?.();
    });

    let remounted = false;
    vi.spyOn(mediaBlock, 'getBoundingClientRect').mockImplementation(() => {
      const currentHeight = !remounted || mediaBlock.style.minHeight ? 420 : 60;
      return {
        top: 480 - root.scrollTop,
        bottom: 480 - root.scrollTop + currentHeight,
        left: 0,
        right: 800,
        width: 800,
        height: currentHeight,
      } as DOMRect;
    });

    await act(async () => {
      observer.emit(mediaBlock, false);
    });
    remounted = true;
    await act(async () => {
      observer.emit(mediaBlock, true);
    });
    expect(mediaBlock.style.minHeight).toBe('420px');
    expect(mediaBlock.querySelector('.image-loading')).not.toBeNull();

    Object.defineProperty(root, 'clientWidth', { configurable: true, get: () => 800 });
    Object.defineProperty(page, 'offsetHeight', {
      configurable: true,
      get: () => (mediaBlock.style.minHeight ? 1420 : 1060),
    });
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      left: 0,
      bottom: 600,
      right: 800,
      width: 800,
      height: 600,
    } as DOMRect);
    vi.spyOn(page, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      left: 16,
      bottom: 1420,
      right: 784,
      width: 768,
      height: 1420,
    } as DOMRect);
    vi.spyOn(textBlock, 'getBoundingClientRect').mockImplementation(() => {
      const top = (mediaBlock.style.minHeight ? 900 : 540) - root.scrollTop;
      return {
        top,
        bottom: top + 120,
        left: 0,
        right: 800,
        width: 800,
        height: 120,
      } as DOMRect;
    });
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: () => mediaBlock,
    });

    applyDocumentZoom(root, 100, 100);
    expect(space.style.height).toBe('1420px');

    root.scrollTop = 420;
    const textTopBefore = textBlock.getBoundingClientRect().top;
    expect(textTopBefore).toBe(480);

    await act(async () => {
      finishMedia?.();
    });

    expect(mediaBlock.style.minHeight).toBe('');
    expect(mediaBlock.querySelector('.image-loading')).toBeNull();
    expect(space.style.height).toBe('1060px');
    expect(root.scrollTop).toBe(60);
    expect(textBlock.getBoundingClientRect().top).toBe(textTopBefore);

    invalidateDocumentZoom(root);
  });
});
