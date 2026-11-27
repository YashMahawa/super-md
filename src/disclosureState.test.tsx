// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import MarkdownPreview from "./components/MarkdownPreview";
import { Reader } from "./androidReader";
import App from "./App";
import { clearNoteDisclosures, hasNoteDisclosureOverrides } from "./disclosureState";
import { exportRenderedViews } from "./renderedOutputs";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

type ObserverEntry = { target: Element; isIntersecting: boolean };
type ObserverCallback = (entries: ObserverEntry[]) => void;

const BASE_READER_STATE = {
  path: "/notes/Study.md",
  portable: false,
  mode: "reader" as const,
  dark: false,
  fullscreen: false,
  font: "sans",
  size: 17,
  width: 820,
  widthPercent: 90,
  lineHeight: 1.7,
  colors: {},
  zoom: 100,
  motion: false,
  python: "embedded",
};

const longCodeBody = Array.from({ length: 15 }, (_, idx) => `export const step${idx + 1} = ${idx + 1};`).join("\n");
const shortCodeBody = ["const a = 1;", "const b = 2;", "export const sum = a + b;"].join("\n");

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const originalIntersectionObserver = globalThis.IntersectionObserver;
const originalResizeObserver = globalThis.ResizeObserver;

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("welcomed", "true");
  clearNoteDisclosures();
  Element.prototype.scrollIntoView = vi.fn();
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
    root = null;
  }
  host?.remove();
  host = null;
  document.body.innerHTML = "";
  clearNoteDisclosures();
  globalThis.IntersectionObserver = originalIntersectionObserver;
  globalThis.ResizeObserver = originalResizeObserver;
  delete window.SuperMD;
  vi.restoreAllMocks();
});

function installMockIntersectionObserver() {
  const callbacks = new Set<ObserverCallback>();
  const targets = new Set<Element>();
  globalThis.IntersectionObserver = class {
    private readonly cb: ObserverCallback;
    constructor(cb: IntersectionObserverCallback) {
      this.cb = cb as unknown as ObserverCallback;
      callbacks.add(this.cb);
    }
    observe(target: Element) {
      targets.add(target);
      queueMicrotask(() => {
        if (targets.has(target)) this.cb([{ target, isIntersecting: true }]);
      });
    }
    unobserve(target: Element) {
      targets.delete(target);
    }
    disconnect() {
      callbacks.delete(this.cb);
    }
    takeRecords() {
      return [];
    }
  } as unknown as typeof IntersectionObserver;

  return {
    setIntersecting(predicate: (el: Element) => boolean) {
      for (const cb of callbacks) {
        cb([...targets].map(target => ({ target, isIntersecting: predicate(target) })));
      }
    },
  };
}

describe("per-note disclosure state for folded callouts and code", () => {
  it("preserves owner default folds, clean static SSR markup, and removes overrides when toggled back to default", () => {
    const markdown = [
      "> [!answer] Derivative",
      "> $3x^2$",
      "",
      "> [!solution]",
      "> Factor first.",
      "",
      ':::callout answer "Portable answer"',
      "Hidden portable body.",
      ":::",
      "",
      "> [!note]- Folded hint",
      "> Power rule.",
      "",
      "> [!tip]+ Open tip",
      "> Check units.",
      "",
      "> [!warning] Always visible",
      "> Domain $x > 0$.",
      "",
      "```ts",
      shortCodeBody,
      "```",
      "",
      "```ts",
      longCodeBody,
      "```",
    ].join("\n");

    const ssrHtml = renderToStaticMarkup(
      <MarkdownPreview markdown={markdown} documentPath={null} python="embedded" dark={false} />,
    );
    expect(ssrHtml).not.toContain("data-disclosure-key");
    expect(ssrHtml).not.toContain("data-disclosure-default");
    expect(ssrHtml).toContain('<aside class="callout callout-warning"');

    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => {
      root!.render(
        <MarkdownPreview noteId="note-defaults" markdown={markdown} documentPath="/notes/Defaults.md" python="embedded" dark={false} />,
      );
    });

    const callouts = Array.from(host.querySelectorAll<HTMLDetailsElement>("details.callout"));
    expect(callouts.map(el => [el.getAttribute("data-callout-type"), el.open])).toEqual([
      ["answer", false],
      ["solution", false],
      ["answer", false],
      ["note", false],
      ["tip", true],
    ]);
    const codeDisclosures = Array.from(host.querySelectorAll<HTMLDetailsElement>("details.code-disclosure"));
    expect(codeDisclosures.map(el => el.open)).toEqual([true, false]);
    expect(hasNoteDisclosureOverrides("note-defaults")).toBe(false);

    // Toggle answer open and open-by-default tip closed -> stores overrides
    act(() => {
      callouts[0]!.open = true;
      callouts[0]!.dispatchEvent(new Event("toggle"));
      callouts[4]!.open = false;
      callouts[4]!.dispatchEvent(new Event("toggle"));
      codeDisclosures[1]!.open = true;
      codeDisclosures[1]!.dispatchEvent(new Event("toggle"));
    });
    expect(hasNoteDisclosureOverrides("note-defaults")).toBe(true);
    expect(exportRenderedViews(markdown, "note-defaults").disclosures).toHaveLength(3);

    // Toggle all three back to their authored defaults -> overrides cleared back to zero
    act(() => {
      callouts[0]!.open = false;
      callouts[0]!.dispatchEvent(new Event("toggle"));
      callouts[4]!.open = true;
      callouts[4]!.dispatchEvent(new Event("toggle"));
      codeDisclosures[1]!.open = false;
      codeDisclosures[1]!.dispatchEvent(new Event("toggle"));
    });
    expect(hasNoteDisclosureOverrides("note-defaults")).toBe(false);
    expect(exportRenderedViews(markdown, "note-defaults").disclosures).toEqual([]);

    // Author changing fold marker in source ([!note]- -> [!note]+) applies new owner default
    act(() => {
      callouts[3]!.open = true;
      callouts[3]!.dispatchEvent(new Event("toggle"));
    });
    const authorUpdated = markdown.replace("> [!note]- Folded hint", "> [!note]+ Folded hint");
    act(() => {
      root!.render(
        <MarkdownPreview noteId="note-defaults" markdown={authorUpdated} documentPath="/notes/Defaults.md" python="embedded" dark={false} />,
      );
    });
    const updatedNoteCallout = host.querySelector<HTMLDetailsElement>('details.callout[data-callout-type="note"]')!;
    expect(updatedNoteCallout.open).toBe(true);
  });

  it("preserves folded callouts and code across windowed block unmount/remount in Reader and Live modes", async () => {
    window.SuperMD = {
      post(id: string) {
        queueMicrotask(() => window.supermdReply?.(id, null, null));
      },
    };
    const observer = installMockIntersectionObserver();
    const filler = Array.from({ length: 120 }, (_, i) => `Paragraph ${i + 1}: ${"study notes ".repeat(60)}`).join("\n\n");
    const markdown = [
      "# Windowed Study Note",
      "",
      "> [!answer] Flashcard",
      "> Duplicate answer body.",
      "",
      "> [!answer] Flashcard",
      "> Duplicate answer body.",
      "",
      "> [!question] Outer prompt",
      "> Read carefully.",
      ">",
      "> > [!answer] Nested derivation",
      "> > $y = x^2 + 1$",
      "",
      "> [!tip]+ Default expanded tip",
      "> Collapse me and scroll away.",
      "",
      "```ts",
      shortCodeBody,
      "```",
      "",
      "```ts",
      longCodeBody,
      "```",
      "",
      filler,
    ].join("\n");
    expect(markdown.length).toBeGreaterThan(80_000);

    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => {
      root!.render(<Reader />);
    });

    for (const mode of ["reader", "live"] as const) {
      const noteId = `windowed-${mode}`;
      await act(async () => {
        window.supermdLoad!({ ...BASE_READER_STATE, id: noteId, content: markdown, mode });
        await Promise.resolve();
      });

      const getCallouts = () => Array.from(host!.querySelectorAll<HTMLDetailsElement>("details.callout"));
      const getCodes = () => Array.from(host!.querySelectorAll<HTMLDetailsElement>("details.code-disclosure"));

      expect(getCallouts().map(el => el.open)).toEqual([false, false, false, true]);
      expect(getCodes().map(el => el.open)).toEqual([true, false]);

      // Open ONLY the SECOND duplicate [!answer], open the nested [!answer], close the [!tip]+,
      // fold the short code block closed, and expand the >12-line code block open.
      act(() => {
        const callouts = getCallouts();
        const codes = getCodes();
        callouts[1]!.open = true;
        callouts[1]!.dispatchEvent(new Event("toggle"));
        callouts[2]!.open = true;
        callouts[2]!.dispatchEvent(new Event("toggle"));
        callouts[3]!.open = false;
        callouts[3]!.dispatchEvent(new Event("toggle"));
        codes[0]!.open = false;
        codes[0]!.dispatchEvent(new Event("toggle"));
        codes[1]!.open = true;
        codes[1]!.dispatchEvent(new Event("toggle"));
      });

      // Scroll far down so all top windowed blocks unmount their children
      act(() => {
        observer.setIntersecting(() => false);
      });
      expect(host.querySelectorAll("details.callout")).toHaveLength(0);
      expect(host.querySelectorAll("details.code-disclosure")).toHaveLength(0);
      expect(host.querySelectorAll('[data-windowed-mounted="false"]').length).toBeGreaterThan(5);

      // Scroll back up so blocks remount -> exact user-toggled state restored while duplicate #0 stays closed!
      act(() => {
        observer.setIntersecting(() => true);
      });
      expect(getCallouts().map(el => el.open)).toEqual([false, true, true, false]);
      expect(getCodes().map(el => el.open)).toEqual([false, true]);
    }
  });

  it("isolates identical disclosures per note across tab switches, mode switches, checkbox edits, and viewState reload", async () => {
    const nativeCalls: Array<{ cmd: string; args: Record<string, unknown> }> = [];
    window.SuperMD = {
      post(id: string, cmd: string, payload: string) {
        nativeCalls.push({ cmd, args: JSON.parse(payload) });
        queueMicrotask(() => window.supermdReply?.(id, null, null));
      },
    };

    const sharedMarkdown = [
      "# Quiz",
      "",
      "[Jump to summary](#summary)",
      "",
      "> [!answer] Shared answer",
      "> - [ ] Verify boundary condition",
      "> Secret value is 42.",
      "",
      "```ts",
      longCodeBody,
      "```",
      "",
      "## Summary",
      "",
      "Done.",
    ].join("\n");

    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => {
      root!.render(<Reader />);
    });

    act(() => {
      window.supermdLoad!({ ...BASE_READER_STATE, id: "tab-a", path: "/notes/A.md", content: sharedMarkdown, mode: "live" });
    });

    // Link navigation (#summary) stays separate and must NOT auto-open closed disclosures
    const jumpLink = host.querySelector<HTMLAnchorElement>('a[href="#summary"]')!;
    act(() => {
      jumpLink.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(host.querySelector<HTMLDetailsElement>("details.callout-answer")!.open).toBe(false);
    expect(host.querySelector<HTMLDetailsElement>("details.code-disclosure")!.open).toBe(false);

    // Open both disclosures in tab-a
    act(() => {
      const answer = host!.querySelector<HTMLDetailsElement>("details.callout-answer")!;
      const code = host!.querySelector<HTMLDetailsElement>("details.code-disclosure")!;
      answer.querySelector("summary")!.click();
      code.querySelector("summary")!.click();
    });
    expect(host.querySelector<HTMLDetailsElement>("details.callout-answer")!.open).toBe(true);
    expect(host.querySelector<HTMLDetailsElement>("details.code-disclosure")!.open).toBe(true);

    // Toggle task checkbox inside the open callout and prepend text above -> callout & code remain open!
    const checkbox = host.querySelector<HTMLInputElement>('details.callout-answer input[type="checkbox"]')!;
    act(() => {
      checkbox.click();
    });
    const checkedTabAContent = sharedMarkdown.replace("- [ ] Verify", "- [x] Verify");
    const editedAboveTabAContent = `Intro note added above.\n\n${checkedTabAContent}`;
    act(() => {
      window.supermdLoad!({ ...BASE_READER_STATE, id: "tab-a", path: "/notes/A.md", content: editedAboveTabAContent, mode: "live" });
    });
    expect(host.querySelector<HTMLDetailsElement>("details.callout-answer")!.open).toBe(true);
    expect(host.querySelector<HTMLDetailsElement>("details.code-disclosure")!.open).toBe(true);

    // Switch to tab-b with identical source -> tab-b keeps owner defaults (closed)!
    act(() => {
      window.supermdLoad!({ ...BASE_READER_STATE, id: "tab-b", path: "/notes/B.md", content: sharedMarkdown, mode: "reader" });
    });
    expect(host.querySelector<HTMLDetailsElement>("details.callout-answer")!.open).toBe(false);
    expect(host.querySelector<HTMLDetailsElement>("details.code-disclosure")!.open).toBe(false);

    // Switch back to tab-a and cycle modes reader -> editor -> split -> reader -> still open!
    for (const mode of ["reader", "editor", "split", "reader"] as const) {
      act(() => {
        window.supermdLoad!({ ...BASE_READER_STATE, id: "tab-a", path: "/notes/A.md", content: editedAboveTabAContent, mode });
      });
    }
    expect(host.querySelector<HTMLDetailsElement>("details.callout-answer")!.open).toBe(true);
    expect(host.querySelector<HTMLDetailsElement>("details.code-disclosure")!.open).toBe(true);

    // Flush viewState via reload_reader, unmount Reader completely, mount a fresh Reader, and restore from viewState!
    await act(async () => {
      window.supermdFlush!({ action: "reload_reader" });
      await Promise.resolve();
      await Promise.resolve();
    });
    const flushed = nativeCalls.find(entry => entry.cmd === "document_flushed")!;
    expect(flushed).toBeTruthy();
    const exportedViewState = flushed.args.viewState as Record<string, unknown>;
    expect((exportedViewState.rendered as { disclosures: unknown[] }).disclosures).toHaveLength(2);

    act(() => {
      root!.unmount();
    });
    root = createRoot(host);
    act(() => {
      root!.render(<Reader />);
    });
    act(() => {
      window.supermdLoad!({
        ...BASE_READER_STATE,
        id: "tab-a",
        path: "/notes/A.md",
        content: editedAboveTabAContent,
        mode: "reader",
        viewState: exportedViewState as never,
      });
    });
    expect(host.querySelector<HTMLDetailsElement>("details.callout-answer")!.open).toBe(true);
    expect(host.querySelector<HTMLDetailsElement>("details.code-disclosure")!.open).toBe(true);
  });

  it("preserves per-tab disclosure state across browser App tab switches and reopen closed tab without leaking across tabs", () => {
    const shared = [
      "# Tab Note",
      "",
      "> [!answer] Tab secret",
      "> Answer 7",
      "",
      "```ts",
      longCodeBody,
      "```",
    ].join("\n");
    localStorage.setItem(
      "workspace.tabs.browser",
      JSON.stringify({
        tabs: [
          { id: "browser-tab-1", path: "/notes/One.md", content: shared, savedContent: shared, name: "One.md" },
          { id: "browser-tab-2", path: "/notes/Two.md", content: shared, savedContent: shared, name: "Two.md" },
        ],
        activeId: "browser-tab-1",
        recentlyClosed: [],
      }),
    );

    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => {
      root!.render(<App />);
    });

    // Switch to reader view for crisp single-pane inspection
    act(() => {
      host!.querySelector<HTMLButtonElement>('button[aria-label="reader view"]')!.click();
    });
    expect(host.querySelector<HTMLDetailsElement>("details.callout-answer")!.open).toBe(false);
    expect(host.querySelector<HTMLDetailsElement>("details.code-disclosure")!.open).toBe(false);

    // Open both disclosures in Tab 1
    act(() => {
      host!.querySelector<HTMLDetailsElement>("details.callout-answer > summary")!.click();
      host!.querySelector<HTMLDetailsElement>("details.code-disclosure > summary")!.click();
    });
    expect(host.querySelector<HTMLDetailsElement>("details.callout-answer")!.open).toBe(true);
    expect(host.querySelector<HTMLDetailsElement>("details.code-disclosure")!.open).toBe(true);

    // Switch to Tab 2 -> identical Markdown stays closed
    const tabButtons = () => Array.from(host!.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    act(() => {
      tabButtons()[1]!.click();
    });
    expect(host.querySelector<HTMLDetailsElement>("details.callout-answer")!.open).toBe(false);
    expect(host.querySelector<HTMLDetailsElement>("details.code-disclosure")!.open).toBe(false);

    // Switch back to Tab 1 -> restored open
    act(() => {
      tabButtons()[0]!.click();
    });
    expect(host.querySelector<HTMLDetailsElement>("details.callout-answer")!.open).toBe(true);
    expect(host.querySelector<HTMLDetailsElement>("details.code-disclosure")!.open).toBe(true);

    // Close Tab 1 and click Reopen -> restored open
    act(() => {
      host!.querySelector<HTMLButtonElement>('button[aria-label="Close One.md"]')!.click();
    });
    expect(host.querySelector<HTMLDetailsElement>("details.callout-answer")!.open).toBe(false);
    act(() => {
      host!.querySelector<HTMLButtonElement>("button.tab-reopen")!.click();
    });
    expect(host.querySelector<HTMLDetailsElement>("details.callout-answer")!.open).toBe(true);
    expect(host.querySelector<HTMLDetailsElement>("details.code-disclosure")!.open).toBe(true);
  });
});
