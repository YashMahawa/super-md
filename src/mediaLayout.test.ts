// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

describe('commitMediaLayout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.replaceChildren();
  });

  it('null target still invokes update', () => {
    const updateSpy = vi.fn();

    commitMediaLayout(null, updateSpy);

    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(captureScrollAnchor).not.toHaveBeenCalled();
    expect(captureWindowedScrollAnchor).not.toHaveBeenCalled();
    expect(refreshDocumentExtent).not.toHaveBeenCalled();
  });

  it('a target under a scroll root captures and restores its anchor', () => {
    const root = document.createElement('div');
    root.className = 'reading-scroll';
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
  });

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

  it('verifies update/flush, event dispatch, extent refresh, and restore ordering with mocks and spies', () => {
    const root = document.createElement('div');
    root.className = 'live-pane';
    const block = document.createElement('div');
    block.setAttribute('data-windowed-block', '');
    const target = document.createElement('img');
    block.appendChild(target);
    root.appendChild(block);
    document.body.appendChild(root);

    const executionOrder: string[] = [];

    const restoreSpy = vi.fn(() => {
      executionOrder.push('restore');
    });

    vi.mocked(captureWindowedScrollAnchor).mockImplementation(() => {
      executionOrder.push('captureWindowedScrollAnchor');
      return restoreSpy;
    });

    const updateSpy = vi.fn(() => {
      executionOrder.push('update');
    });

    block.addEventListener('supermd-media-layout', () => {
      executionOrder.push('supermd-media-layout');
    });

    vi.mocked(refreshDocumentExtent).mockImplementation(() => {
      executionOrder.push('refreshDocumentExtent');
      return true;
    });

    commitMediaLayout(target, updateSpy);

    expect(executionOrder).toEqual([
      'captureWindowedScrollAnchor',
      'update',
      'supermd-media-layout',
      'refreshDocumentExtent',
      'restore',
    ]);
  });
});
