// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ReadingSearch, { type ReadingSearchSeed } from "./ReadingSearch";

class MockHighlight {
  ranges: Range[];
  constructor(...ranges: Range[]) {
    this.ranges = ranges;
  }
}

describe("ReadingSearch background worker revision synchronization", () => {
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
    searchContainer = document.createElement("div");
    document.body.append(searchContainer);
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("retains seeded auto-select while renderedRevision is null and highlights 1 / 2 once worker DOM commits", async () => {
    const onClose = vi.fn();
    const root = createRoot(searchContainer);
    const flushFrame = async () => {
      await act(async () => {
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      });
    };

    const noteSource = "First AuroraSignal paragraph\n\nSecond AuroraSignal paragraph";
    const seed: ReadingSearchSeed = { query: "AuroraSignal", caseSensitive: false, nonce: 1 };

    // Mount while worker analysis is still in flight (renderedRevision = null, no .android-reading yet).
    await act(async () => {
      root.render(<ReadingSearch content={noteSource} renderedRevision={null} close={onClose} seed={seed} />);
    });
    await flushFrame();

    // Now mount .android-reading and commit renderedRevision === noteSource.
    const host = document.createElement("section");
    host.className = "android-reading";
    host.innerHTML = "<p data-source-start=\"0\" data-source-end=\"28\">First AuroraSignal paragraph</p><p data-source-start=\"30\" data-source-end=\"59\">Second AuroraSignal paragraph</p>";
    document.body.prepend(host);

    await act(async () => {
      root.render(<ReadingSearch content={noteSource} renderedRevision={noteSource} close={onClose} seed={seed} />);
    });
    await flushFrame();

    const status = searchContainer.querySelector("output");
    expect(status?.textContent).toBe("1 / 2");
    expect(highlights.get("smd-search")?.ranges).toHaveLength(2);
    expect(highlights.get("smd-search-current")?.ranges).toHaveLength(1);
    expect(highlights.get("smd-search-current")?.ranges[0]?.toString()).toBe("AuroraSignal");

    await act(async () => {
      root.unmount();
    });
  });

  it("defers post-replace DOM reveal in live mode until renderedRevision catches up to replaced content", async () => {
    const host = document.createElement("section");
    host.className = "android-reading";
    const initialSource = "Alpha token\n\nBeta token";
    host.innerHTML = "<div class=\"live-block\" data-source-start=\"0\" data-source-end=\"11\"><p data-source-start=\"0\" data-source-end=\"11\">Alpha token</p></div><div class=\"live-block\" data-source-start=\"13\" data-source-end=\"23\"><p data-source-start=\"13\" data-source-end=\"23\">Beta token</p></div>";
    document.body.prepend(host);

    let latestContent = initialSource;
    const onChange = vi.fn((next: string) => {
      latestContent = next;
    });
    const root = createRoot(searchContainer);
    const flushFrame = async () => {
      await act(async () => {
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      });
    };

    const seed: ReadingSearchSeed = { query: "token", caseSensitive: false, nonce: 1 };
    await act(async () => {
      root.render(<ReadingSearch content={initialSource} renderedRevision={initialSource} close={vi.fn()} onChange={onChange} seed={seed} />);
    });
    await flushFrame();

    const replaceToggle = searchContainer.querySelector<HTMLButtonElement>('button[aria-label="Replace in source"]');
    await act(async () => {
      replaceToggle?.click();
    });
    await flushFrame();

    const replaceInput = searchContainer.querySelector<HTMLInputElement>('input[aria-label="Replacement text"]');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(replaceInput, "updated");
      replaceInput?.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const replaceBtn = Array.from(searchContainer.querySelectorAll("button")).find(btn => btn.textContent === "Replace");
    await act(async () => {
      replaceBtn?.click();
    });
    expect(onChange).toHaveBeenCalledWith("Alpha updated\n\nBeta token");

    // Frame while worker still holds initialSource in renderedRevision.
    await act(async () => {
      root.render(<ReadingSearch content={latestContent} renderedRevision={initialSource} close={vi.fn()} onChange={onChange} seed={seed} />);
    });
    await flushFrame();

    // Commit updated worker DOM & renderedRevision.
    host.innerHTML = "<div class=\"live-block\" data-source-start=\"0\" data-source-end=\"13\"><p data-source-start=\"0\" data-source-end=\"13\">Alpha updated</p></div><div class=\"live-block\" data-source-start=\"15\" data-source-end=\"25\"><p data-source-start=\"15\" data-source-end=\"25\">Beta token</p></div>";
    await act(async () => {
      root.render(<ReadingSearch content={latestContent} renderedRevision={latestContent} close={vi.fn()} onChange={onChange} seed={seed} />);
    });
    await flushFrame();

    const status = searchContainer.querySelector("output");
    expect(status?.textContent).toBe("1 / 1");
    expect(highlights.get("smd-search")?.ranges).toHaveLength(1);
    expect(highlights.get("smd-search-current")?.ranges).toHaveLength(1);
    expect(highlights.get("smd-search-current")?.ranges[0]?.toString()).toBe("token");

    await act(async () => {
      root.unmount();
    });
  });

  it("retains seeded exact occurrence bounds while renderedRevision is null and selects 2 / 2 once worker DOM commits", async () => {
    const onClose = vi.fn();
    const root = createRoot(searchContainer);
    const flushFrame = async () => {
      await act(async () => {
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      });
    };

    const noteSource = "First AuroraSignal paragraph\n\nSecond AuroraSignal paragraph";
    const secondStart = noteSource.lastIndexOf("AuroraSignal");
    const seed: ReadingSearchSeed = {
      query: "AuroraSignal",
      caseSensitive: true,
      sourceStart: secondStart,
      sourceEnd: secondStart + "AuroraSignal".length,
      matchText: "AuroraSignal",
      nonce: 2,
    };

    await act(async () => {
      root.render(<ReadingSearch content={noteSource} renderedRevision={null} close={onClose} seed={seed} />);
    });
    await flushFrame();

    const host = document.createElement("section");
    host.className = "android-reading";
    host.innerHTML = "<p data-source-start=\"0\" data-source-end=\"28\">First AuroraSignal paragraph</p><p data-source-start=\"30\" data-source-end=\"59\">Second AuroraSignal paragraph</p>";
    document.body.prepend(host);

    await act(async () => {
      root.render(<ReadingSearch content={noteSource} renderedRevision={noteSource} close={onClose} seed={seed} />);
    });
    await flushFrame();

    const status = searchContainer.querySelector("output");
    expect(status?.textContent).toBe("2 / 2");
    expect(highlights.get("smd-search")?.ranges).toHaveLength(2);
    expect(highlights.get("smd-search-current")?.ranges).toHaveLength(1);
    const currentParent = highlights.get("smd-search-current")?.ranges[0]?.startContainer.parentElement;
    expect(currentParent?.textContent).toBe("Second AuroraSignal paragraph");

    await act(async () => {
      root.unmount();
    });
  });

  it("keeps stale seeded occurrence passive (0 / 2) across delayed worker renderedRevision commit", async () => {
    const onClose = vi.fn();
    const root = createRoot(searchContainer);
    const flushFrame = async () => {
      await act(async () => {
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      });
    };

    const noteSource = "Prepended edit.\n\nFirst AuroraSignal paragraph\n\nSecond AuroraSignal paragraph";
    const staleSeed: ReadingSearchSeed = {
      query: "AuroraSignal",
      caseSensitive: true,
      sourceStart: 6,
      sourceEnd: 6 + "AuroraSignal".length,
      matchText: "AuroraSignal",
      nonce: 3,
    };

    await act(async () => {
      root.render(<ReadingSearch content={noteSource} renderedRevision={null} close={onClose} seed={staleSeed} />);
    });
    await flushFrame();

    const host = document.createElement("section");
    host.className = "android-reading";
    host.innerHTML = "<p data-source-start=\"0\" data-source-end=\"15\">Prepended edit.</p><p data-source-start=\"17\" data-source-end=\"45\">First AuroraSignal paragraph</p><p data-source-start=\"47\" data-source-end=\"76\">Second AuroraSignal paragraph</p>";
    document.body.prepend(host);

    await act(async () => {
      root.render(<ReadingSearch content={noteSource} renderedRevision={noteSource} close={onClose} seed={staleSeed} />);
    });
    await flushFrame();

    const status = searchContainer.querySelector("output");
    expect(status?.textContent).toBe("0 / 2");
    expect(highlights.get("smd-search")?.ranges).toHaveLength(2);
    expect(highlights.has("smd-search-current")).toBe(false);

    await act(async () => {
      root.unmount();
    });
  });
});
