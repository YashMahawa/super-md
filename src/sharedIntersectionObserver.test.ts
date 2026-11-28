// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_OBSERVER_WORK_BUDGET_MS,
  getObserverWorkBudgetMs,
  observeSharedIntersection,
  setObserverWorkBudgetMs,
  type IntersectionStepFlush,
} from "./sharedIntersectionObserver";

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

afterEach(() => {
  setObserverWorkBudgetMs(DEFAULT_OBSERVER_WORK_BUDGET_MS);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  FakeIntersectionObserver.instances = [];
});

function makeRect(top: number, height: number): DOMRect {
  return {
    top,
    bottom: top + height,
    left: 0,
    right: 800,
    width: 800,
    height,
    x: 0,
    y: top,
    toJSON() {},
  } as DOMRect;
}

describe("shared intersection observers", () => {
  it("commits a delivery once and isolates transactional subscribers from ordinary observers",()=>{
    vi.stubGlobal("IntersectionObserver",FakeIntersectionObserver);
    const root=document.createElement('main'),first=document.createElement('section'),second=document.createElement('section');
    const order:string[]=[];
    const commit=vi.fn((host:Element|Document|null,update:()=>void)=>{expect(host).toBe(root);order.push('before');update();order.push('after');});
    const stops=[observeSharedIntersection(first,()=>order.push('first'),{root},commit),observeSharedIntersection(second,()=>order.push('second'),{root},commit),observeSharedIntersection(document.createElement('section'),vi.fn(),{root})];
    expect(FakeIntersectionObserver.instances).toHaveLength(2);
    const observer=FakeIntersectionObserver.instances[0];
    const entries=[first,second].map((target,i)=>({target,isIntersecting:i===0,intersectionRatio:i===0?1:0,time:0,boundingClientRect:target.getBoundingClientRect(),intersectionRect:target.getBoundingClientRect(),rootBounds:root.getBoundingClientRect()}));
    observer.callback(entries,observer as unknown as IntersectionObserver);
    expect(commit).toHaveBeenCalledTimes(1);expect(order).toEqual(['before','first','second','after']);
    stops.forEach(stop=>stop());expect(observer.disconnected).toBe(true);
  });
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

  it("enforces a measured observer work budget per frame and drains margin mounts closest-to-viewport first", () => {
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    let clock = 100;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    setObserverWorkBudgetMs(5);
    expect(getObserverWorkBudgetMs()).toBe(5);

    const root = document.createElement("main");
    vi.spyOn(root, "getBoundingClientRect").mockReturnValue(makeRect(0, 800));

    const visibleA = document.createElement("section");
    const visibleB = document.createElement("section");
    const marginFar = document.createElement("section");
    const marginNear = document.createElement("section");
    const marginMid = document.createElement("section");
    vi.spyOn(visibleA, "getBoundingClientRect").mockReturnValue(makeRect(40, 120));
    vi.spyOn(visibleB, "getBoundingClientRect").mockReturnValue(makeRect(200, 120));
    vi.spyOn(marginFar, "getBoundingClientRect").mockReturnValue(makeRect(1400, 120)); // distance 600px
    vi.spyOn(marginNear, "getBoundingClientRect").mockReturnValue(makeRect(900, 120)); // distance 100px
    vi.spyOn(marginMid, "getBoundingClientRect").mockReturnValue(makeRect(-320, 120)); // distance 200px

    const order: string[] = [];
    const commits: string[][] = [];
    const commit = vi.fn((_host: Element | Document | null, update: (flush?: IntersectionStepFlush) => void) => {
      const slice: string[] = [];
      update((work) => {
        slice.push("flush");
        work();
      });
      commits.push(slice);
    });

    const register = (el: Element, label: string) =>
      observeSharedIntersection(
        el,
        () => {
          order.push(label);
          clock += 3;
          return true;
        },
        { root, rootMargin: "900px 0px" },
        commit,
      );

    const stops = [
      register(visibleA, "visibleA"),
      register(visibleB, "visibleB"),
      register(marginFar, "marginFar"),
      register(marginNear, "marginNear"),
      register(marginMid, "marginMid"),
    ];

    const observer = FakeIntersectionObserver.instances[0];
    const viewportBounds = makeRect(0, 800);
    observer.callback(
      [visibleA, visibleB, marginFar, marginNear, marginMid].map((target) => ({
        target,
        isIntersecting: true,
        intersectionRatio: 1,
        time: clock,
        boundingClientRect: target.getBoundingClientRect(),
        intersectionRect: target.getBoundingClientRect(),
        rootBounds: viewportBounds,
      })),
      observer as unknown as IntersectionObserver,
    );

    // Visible blocks commit atomically in one flushSync and consume the 5 ms budget (2 * 3 ms = 6 ms >= 5 ms).
    expect(commit).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["visibleA", "visibleB"]);
    expect(commits[0]).toEqual(["flush"]);
    expect(frames).toHaveLength(1);

    // Next animation frame drains margin mounts ordered by viewport proximity (100px -> 200px), stopping at budget.
    clock += 20;
    frames.shift()!(clock);
    expect(commit).toHaveBeenCalledTimes(2);
    expect(order).toEqual(["visibleA", "visibleB", "marginNear", "marginMid"]);
    expect(frames).toHaveLength(1);

    // Final animation frame finishes the remaining farthest margin mount (600px).
    clock += 20;
    frames.shift()!(clock);
    expect(commit).toHaveBeenCalledTimes(3);
    expect(order).toEqual(["visibleA", "visibleB", "marginNear", "marginMid", "marginFar"]);
    expect(frames).toHaveLength(0);

    stops.forEach((stop) => stop());
  });

  it("re-measures carried-over pending entries on subsequent scroll deliveries and bridges mounted holes", () => {
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    let clock = 100;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    setObserverWorkBudgetMs(4);

    const root = document.createElement("main");
    vi.spyOn(root, "getBoundingClientRect").mockReturnValue(makeRect(0, 800));

    // Simulate contiguous DOM siblings [b0, b1, b2, b3, b4]
    const blocks = Array.from({ length: 5 }, () => {
      const el = document.createElement("section");
      el.dataset.windowedMounted = "false";
      root.appendChild(el);
      return el;
    });
    const [b0, b1, b2, b3, b4] = blocks;
    let rects = [
      makeRect(-700, 150),
      makeRect(-550, 150),
      makeRect(-400, 150), // initially in upper rootMargin
      makeRect(50, 150),   // initially visible
      makeRect(250, 150),  // initially visible
    ];
    blocks.forEach((el, idx) => {
      vi.spyOn(el, "getBoundingClientRect").mockImplementation(() => rects[idx]);
    });

    const mountedOrder: string[] = [];
    const commit = vi.fn((_host: Element | Document | null, update: (flush?: IntersectionStepFlush) => void) => {
      update((work) => work());
    });

    const stops = blocks.map((el, idx) =>
      observeSharedIntersection(
        el,
        () => {
          el.dataset.windowedMounted = "true";
          mountedOrder.push(`b${idx}`);
          clock += 3;
          return true;
        },
        { root, rootMargin: "900px 0px" },
        commit,
      ),
    );

    const observer = FakeIntersectionObserver.instances[0];
    // Frame 1: b2 (upper margin), b3 (visible), b4 (visible) enter observer.
    // b3 + b4 commit atomically (6 ms >= 4 ms budget), leaving b2 in pending with stale rect (-400).
    observer.callback(
      [b2, b3, b4].map((target) => ({
        target,
        isIntersecting: true,
        intersectionRatio: 1,
        time: clock,
        boundingClientRect: target.getBoundingClientRect(),
        intersectionRect: target.getBoundingClientRect(),
        rootBounds: makeRect(0, 800),
      })),
      observer as unknown as IntersectionObserver,
    );
    expect(mountedOrder).toEqual(["b3", "b4"]);

    // Frame 2 (before rAF): fast upward scroll brings b2 into the viewport while b1 is in upper margin
    // right below already-mounted b0 (contiguity bridge must mount b1 immediately alongside b2!).
    b0.dataset.windowedMounted = "true";
    rects = [
      makeRect(-350, 150), // b0 already mounted in upper margin
      makeRect(-200, 150), // b1 in upper margin between mounted b0 and visible b2 -> bridged!
      makeRect(20, 150),   // b2 now visible (carried over in pending with stale -400 entry!)
      makeRect(170, 150),
      makeRect(320, 150),
    ];
    observer.callback(
      [b1].map((target) => ({
        target,
        isIntersecting: true,
        intersectionRatio: 1,
        time: clock,
        boundingClientRect: target.getBoundingClientRect(),
        intersectionRect: target.getBoundingClientRect(),
        rootBounds: makeRect(0, 800),
      })),
      observer as unknown as IntersectionObserver,
    );

    // Carried-over visible b2 AND bridged offscreen b1 both mount immediately (no unmounted hole between b0 and b2!).
    expect(mountedOrder).toEqual(["b3", "b4", "b2", "b1"]);
    expect(b1.dataset.windowedMounted).toBe("true");
    expect(b2.dataset.windowedMounted).toBe("true");

    stops.forEach((stop) => stop());
  });

  it("drops scrolled-past deferred margin mounts and skips commit for already-unmounted releases", () => {
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    const frames: FrameRequestCallback[] = [];
    const cancelRaf = vi.fn();
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", cancelRaf);

    let clock = 50;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    setObserverWorkBudgetMs(2);

    const root = document.createElement("main");
    vi.spyOn(root, "getBoundingClientRect").mockReturnValue(makeRect(0, 800));

    const visible = document.createElement("section");
    const scrolledPast = document.createElement("section");
    const unsubscribed = document.createElement("section");
    const unmountedOffscreen = document.createElement("section");
    unmountedOffscreen.dataset.windowedMounted = "false";

    let scrolledPastTop = 950;
    vi.spyOn(visible, "getBoundingClientRect").mockReturnValue(makeRect(50, 120));
    vi.spyOn(scrolledPast, "getBoundingClientRect").mockImplementation(() => makeRect(scrolledPastTop, 120));
    vi.spyOn(unsubscribed, "getBoundingClientRect").mockReturnValue(makeRect(1100, 120));

    const mounted: string[] = [];
    let offscreenReleaseCalls = 0;
    const commit = vi.fn((_host: Element | Document | null, update: (flush?: IntersectionStepFlush) => void) => {
      update((work) => work());
    });

    const stopVisible = observeSharedIntersection(visible, () => { mounted.push("visible"); clock += 3; return true; }, { root, rootMargin: "900px 0px" }, commit);
    const stopScrolledPast = observeSharedIntersection(scrolledPast, () => { mounted.push("scrolledPast"); return true; }, { root, rootMargin: "900px 0px" }, commit);
    const stopUnsubscribed = observeSharedIntersection(unsubscribed, () => { mounted.push("unsubscribed"); return true; }, { root, rootMargin: "900px 0px" }, commit);
    const stopOffscreen = observeSharedIntersection(unmountedOffscreen, () => { offscreenReleaseCalls += 1; return false; }, { root, rootMargin: "900px 0px" }, commit);

    const observer = FakeIntersectionObserver.instances[0];
    // Purely already-unmounted offscreen delivery runs subscriber without invoking commit().
    observer.callback(
      [{ target: unmountedOffscreen, isIntersecting: false, intersectionRatio: 0, time: clock, boundingClientRect: makeRect(5000, 120), intersectionRect: makeRect(0, 0), rootBounds: makeRect(0, 800) }],
      observer as unknown as IntersectionObserver,
    );
    expect(offscreenReleaseCalls).toBe(1);
    expect(commit).not.toHaveBeenCalled();

    // Queue visible + two margin mounts; visible consumes budget, deferring both margin mounts.
    observer.callback(
      [visible, scrolledPast, unsubscribed].map((target) => ({
        target,
        isIntersecting: true,
        intersectionRatio: 1,
        time: clock,
        boundingClientRect: target.getBoundingClientRect(),
        intersectionRect: target.getBoundingClientRect(),
        rootBounds: makeRect(0, 800),
      })),
      observer as unknown as IntersectionObserver,
    );
    expect(mounted).toEqual(["visible"]);
    expect(frames).toHaveLength(1);

    // Before the next frame, one target unsubscribes and the other scrolls outside rootMargin (900px).
    stopUnsubscribed();
    scrolledPastTop = 2400; // 2400 > 800 + 900
    clock += 20;
    frames.shift()!(clock);
    expect(mounted).toEqual(["visible"]);
    expect(commit).toHaveBeenCalledTimes(1);

    stopVisible();
    stopScrolledPast();
    stopOffscreen();
  });
});
