// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ReadingSearch, { type ReadingSearchSeed } from "./components/ReadingSearch";

class MockHighlight {
  ranges: Range[];
  constructor(...ranges: Range[]) {
    this.ranges = ranges;
  }
}

describe("ReadingSearch seeded cross-note handoff", () => {
  let host: HTMLElement;
  let searchContainer: HTMLDivElement;
  let highlights: Map<string, MockHighlight>;

  beforeEach(() => {
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    highlights = new Map<string, MockHighlight>();
    Object.defineProperty(globalThis, "CSS", {
      configurable: true,
      value: { highlights },
    });
    Object.defineProperty(window, "Highlight", {
      configurable: true,
      value: MockHighlight,
    });
    host = document.createElement("section");
    host.className = "android-reading";
    host.innerHTML = "<p>Alpha needle first</p><p>Second NEEDLE match</p>";
    searchContainer = document.createElement("div");
    document.body.append(host, searchContainer);
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("opens seeded with query, highlights matches, selects first match, and updates on new seed", async () => {
    const onClose = vi.fn();
    const root = createRoot(searchContainer);
    const flushFrame = async () => {
      await act(async () => {
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      });
    };

    const firstSeed: ReadingSearchSeed = { query: "needle", caseSensitive: false, nonce: 1 };
    await act(async () => {
      root.render(<ReadingSearch content="Alpha needle first\n\nSecond NEEDLE match" close={onClose} seed={firstSeed} />);
    });
    await flushFrame();

    const input = searchContainer.querySelector<HTMLInputElement>('input[role="searchbox"]');
    const status = searchContainer.querySelector("output");
    expect(input?.value).toBe("needle");
    expect(status?.textContent).toBe("1 / 2");
    expect(highlights.get("smd-search")?.ranges).toHaveLength(2);
    expect(highlights.get("smd-search-current")?.ranges).toHaveLength(1);
    expect(highlights.get("smd-search-current")?.ranges[0]?.toString()).toBe("needle");

    const caseSeed: ReadingSearchSeed = { query: "NEEDLE", caseSensitive: true, nonce: 2 };
    await act(async () => {
      root.render(<ReadingSearch content="Alpha needle first\n\nSecond NEEDLE match" close={onClose} seed={caseSeed} />);
    });
    await flushFrame();

    expect(input?.value).toBe("NEEDLE");
    expect(status?.textContent).toBe("1 / 1");
    expect(highlights.get("smd-search")?.ranges).toHaveLength(1);
    expect(highlights.get("smd-search-current")?.ranges[0]?.toString()).toBe("NEEDLE");

    await act(async () => {
      input?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.unmount();
    });
  });
});
