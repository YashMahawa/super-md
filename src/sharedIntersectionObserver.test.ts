// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { observeSharedIntersection } from "./sharedIntersectionObserver";

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  readonly observed: Element[] = [];
  readonly unobserved: Element[] = [];
  disconnected = false;
  constructor(readonly callback: IntersectionObserverCallback, readonly options?: IntersectionObserverInit) {
    FakeIntersectionObserver.instances.push(this);
  }
  observe(target: Element) { this.observed.push(target); }
  unobserve(target: Element) { this.unobserved.push(target); }
  disconnect() { this.disconnected = true; }
  emit(target: Element, isIntersecting: boolean) {
    this.callback([{ target, isIntersecting } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
}

afterEach(() => { vi.unstubAllGlobals(); FakeIntersectionObserver.instances = []; });

describe("shared intersection observers", () => {
  it("shares by root and options and releases callbacks and observer ownership", () => {
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    const root = document.createElement("main");
    const first = document.createElement("section");
    const second = document.createElement("section");
    const firstCallback = vi.fn();
    const secondCallback = vi.fn();
    const stopFirst = observeSharedIntersection(first, firstCallback, { root, rootMargin: "900px 0px" });
    const stopSecond = observeSharedIntersection(second, secondCallback, { root, rootMargin: "900px 0px" });

    expect(FakeIntersectionObserver.instances).toHaveLength(1);
    const shared = FakeIntersectionObserver.instances[0];
    expect(shared.observed).toEqual([first, second]);
    shared.emit(first, true);
    shared.emit(second, false);
    expect(firstCallback).toHaveBeenCalledTimes(1);
    expect(secondCallback).toHaveBeenCalledTimes(1);

    stopFirst();
    stopFirst();
    expect(shared.unobserved).toEqual([first]);
    shared.emit(first, false);
    expect(firstCallback).toHaveBeenCalledTimes(1);
    expect(shared.disconnected).toBe(false);
    stopSecond();
    expect(shared.disconnected).toBe(true);

    const otherRoot = document.createElement("main");
    const stopOther = observeSharedIntersection(document.createElement("section"), vi.fn(), { root: otherRoot, rootMargin: "900px 0px" });
    const stopOtherOptions = observeSharedIntersection(document.createElement("section"), vi.fn(), { root, rootMargin: "200px 0px" });
    expect(FakeIntersectionObserver.instances).toHaveLength(3);
    stopOther();
    stopOtherOptions();
  });
});
