// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import WindowedBlock from "./WindowedBlock";
import { cancelHeadingNavigation, navigateToHeading } from "../documentNavigation";

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  constructor(readonly callback: IntersectionObserverCallback) { FakeIntersectionObserver.instances.push(this); }
  observe() {}
  unobserve() {}
  disconnect() {}
  emit(target: Element, isIntersecting: boolean) {
    this.callback([{ target, isIntersecting } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
}
class FakeResizeObserver {
  constructor(readonly callback: ResizeObserverCallback) {}
  observe() {}
  disconnect() {}
}

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | null = null;
afterEach(() => {
  if (root) { act(() => root?.unmount()); root = null; }
  document.body.innerHTML = "";
  FakeIntersectionObserver.instances = [];
  vi.unstubAllGlobals();
});

describe("windowed block focus reveal", () => {
  it('retains the final height when leaving before a ResizeObserver measurement arrives',async()=>{
    vi.stubGlobal('IntersectionObserver',FakeIntersectionObserver);vi.stubGlobal('ResizeObserver',FakeResizeObserver);
    const host=document.createElement('div');document.body.append(host);root=createRoot(host);
    await act(async()=>root?.render(<div className="android-reading"><WindowedBlock enabled estimate={80}><p>Measured lazily</p></WindowedBlock></div>));
    const block=host.querySelector<HTMLElement>('[data-windowed-block]')!;
    await act(async()=>FakeIntersectionObserver.instances[0].emit(block,true));
    vi.spyOn(block,'getBoundingClientRect').mockReturnValue({height:227.375} as DOMRect);
    await act(async()=>FakeIntersectionObserver.instances[0].emit(block,false));
    expect(block.querySelector('p')).toBeNull();expect(block.style.height).toBe('227.375px');
  });
  it("mounts content on keyboard focus and keeps a focused block mounted outside the viewport", async () => {
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root?.render(
      <div className="android-reading">
        <WindowedBlock enabled tabIndex={0} text="keyboard content"><button>Keyboard reachable content</button></WindowedBlock>
      </div>,
    ));
    const block = host.querySelector<HTMLElement>("[data-windowed-block]")!;
    expect(block.querySelector("button")).toBeNull();

    await act(async () => { block.focus(); });
    expect(block.querySelector("button")?.textContent).toBe("Keyboard reachable content");
    await act(async () => { FakeIntersectionObserver.instances[0].emit(block, false); });
    expect(block.querySelector("button")).not.toBeNull();
    await act(async () => {
      block.blur();
      await new Promise(resolve => window.setTimeout(resolve, 0));
    });
    expect(block.querySelector("button")).toBeNull();
  });

  it("reveals and focuses the real semantic heading when navigating from its lightweight placeholder", async () => {
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root?.render(
      <div className="android-reading">
        <WindowedBlock enabled headings={[{ id: "chapter", key: "chapter" }]}>
          <h2 id="chapter" data-heading-key="chapter">Accessible chapter</h2>
          <p>Chapter text remains in the mounted block.</p>
        </WindowedBlock>
      </div>,
    ));
    const reading = host.querySelector<HTMLElement>(".android-reading")!;
    const placeholder = reading.querySelector<HTMLElement>("[data-heading-key=chapter]")!;
    expect(placeholder.tagName).toBe("SPAN");
    expect(placeholder.getAttribute("aria-hidden")).toBe("true");
    expect(reading.querySelector("h2")).toBeNull();

    await act(async () => { navigateToHeading(reading, "chapter"); });
    for (let count = 0; frames.length && count < 10; count += 1) {
      const callback = frames.shift()!;
      await act(async () => callback(performance.now()));
    }
    const heading = reading.querySelector<HTMLElement>("h2[data-heading-key=chapter]");
    expect(heading?.textContent).toBe("Accessible chapter");
    expect(document.activeElement).toBe(heading);
    expect(heading?.getAttribute("aria-hidden")).toBeNull();
    cancelHeadingNavigation(reading);
  });
});
