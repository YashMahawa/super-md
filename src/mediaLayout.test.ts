// @vitest-environment jsdom
import { createElement, act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commitMediaLayout } from './mediaLayout';
import { captureScrollAnchor } from './scrollAnchor';
import { captureWindowedScrollAnchor } from './windowedSearch';
import { refreshDocumentExtent } from './documentZoom';

vi.mock('./scrollAnchor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./scrollAnchor')>()),
  captureScrollAnchor: vi.fn(),
}));

vi.mock('./windowedSearch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./windowedSearch')>()),
  captureWindowedScrollAnchor: vi.fn(),
}));

vi.mock('./documentZoom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./documentZoom')>()),
  refreshDocumentExtent: vi.fn(),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe('commitMediaLayout', () => {
  let reactRoot: Root | null = null;

  beforeEach(() => {
    vi.resetAllMocks();
    document.body.replaceChildren();
  });

  afterEach(() => {
    if (reactRoot) {
      act(() => reactRoot?.unmount());
      reactRoot = null;
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

  it('handles undefined restore callback when scroll anchor capture returns undefined', () => {
    const root = document.createElement('div');
    root.className = 'live-pane';
    const target = document.createElement('p');
    root.appendChild(target);
    document.body.appendChild(root);

    vi.mocked(captureScrollAnchor).mockReturnValue(undefined as unknown as () => void);
    const updateSpy = vi.fn();

    expect(() => commitMediaLayout(target, updateSpy)).not.toThrow();
    expect(captureScrollAnchor).toHaveBeenCalledWith(root);
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(refreshDocumentExtent).toHaveBeenCalledWith(root);
  });

  it('a target inside [data-windowed-block] uses the windowed anchor helper and dispatches supermd-media-layout', () => {
    const root = document.createElement('div');
    root.className = 'android-reading';
    const block = document.createElement('div');
    block.setAttribute('data-windowed-block', '');
    const target = document.createElement('img');
    block.appendChild(target);
    root.appendChild(block);
    document.body.appendChild(root);

    const restoreSpy = vi.fn();
    vi.mocked(captureWindowedScrollAnchor).mockReturnValue(restoreSpy);
    const eventListenerSpy = vi.fn();
    block.addEventListener('supermd-media-layout', eventListenerSpy);

    const updateSpy = vi.fn();

    commitMediaLayout(target, updateSpy);

    expect(captureWindowedScrollAnchor).toHaveBeenCalledTimes(1);
    expect(captureWindowedScrollAnchor).toHaveBeenCalledWith(root, block);
    expect(captureScrollAnchor).not.toHaveBeenCalled();
    expect(updateSpy).toHaveBeenCalledTimes(1);

    expect(eventListenerSpy).toHaveBeenCalledTimes(1);
    const event = eventListenerSpy.mock.calls[0][0] as Event;
    expect(event.type).toBe('supermd-media-layout');

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
});
