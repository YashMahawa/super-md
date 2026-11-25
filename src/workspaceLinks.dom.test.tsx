// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const { bridgeInvoke } = vi.hoisted(() => ({
  bridgeInvoke: vi.fn(async (_command: string, _args?: unknown) => ({ opened: true })),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: bridgeInvoke }));

import { EditorView } from "@codemirror/view";
import { Reader } from "./androidReader";
import Editor from "./components/Editor";
import MarkdownPreview from "./components/MarkdownPreview";
import LiveEditor from "./components/LiveEditor";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | null = null;

const postCalls: Array<{ id: string; command: string; args: Record<string, unknown> }> = [];
const postSpy = vi.fn((id: string, command: string, rawArgs: string) => {
  postCalls.push({ id, command, args: JSON.parse(rawArgs || "{}") });
  window.supermdReply?.(id, { opened: true }, null);
});

beforeEach(() => {
  bridgeInvoke.mockClear();
  postCalls.length = 0;
  postSpy.mockClear();
  window.SuperMD = { post: postSpy };
});

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
    root = null;
  }
  document.body.innerHTML = "";
  delete (window as unknown as Record<string, unknown>).SuperMD;
  delete window.supermdBeforeNavigate;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("workspace link rendering, live-edit safety, and click routing", () => {
  it("renders wikilinks and spaced Markdown links across MarkdownPreview and LiveEditor without target=_blank on local links", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    const markdown = [
      "# Index Note",
      "",
      "Follow [[Subfolder Note#Deep Dive|Deep Dive Alias]], [[Portable.smd]], and [API Spec](../my specs/api.md#Auth).",
      "",
      "| Note | Link |",
      "| --- | --- |",
      "| Table | [[Table Target\\|Table Label]] |",
      "",
      "External [Website](https://example.org) and [Email](mailto:team@example.org) and [Same](#index-note).",
    ].join("\n");

    await act(async () => {
      root?.render(<MarkdownPreview markdown={markdown} documentPath="/vault/Index.md" python="" dark />);
    });

    const links = Array.from(host.querySelectorAll("a"));
    expect(links.map((a) => a.textContent)).toEqual([
      "Deep Dive Alias",
      "Portable.smd",
      "API Spec",
      "Table Label",
      "Website",
      "Email",
      "Same",
    ]);

    // Local links and same-note links never carry target="_blank"
    for (const localText of ["Deep Dive Alias", "Portable.smd", "API Spec", "Table Label", "Same"]) {
      const anchor = links.find((a) => a.textContent === localText)!;
      expect(anchor.getAttribute("target")).toBeNull();
    }

    // Clicking a wikilink flushes pending edits first, then calls open_workspace_link
    const callOrder: string[] = [];
    window.supermdBeforeNavigate = vi.fn(async () => {
      callOrder.push("beforeNavigate");
    });
    postSpy.mockImplementationOnce((id, cmd, rawArgs) => {
      callOrder.push(`${cmd}:${rawArgs}`);
      postCalls.push({ id, command: cmd, args: JSON.parse(rawArgs || "{}") });
      window.supermdReply?.(id, { opened: true }, null);
    });

    const wikiAnchor = links.find((a) => a.textContent === "Deep Dive Alias")!;
    await act(async () => {
      wikiAnchor.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(callOrder[0]).toBe("beforeNavigate");
    expect(postCalls.at(-1)).toMatchObject({
      command: "open_workspace_link",
      args: {
        documentPath: "/vault/Index.md",
        target: "Subfolder Note",
        fragment: "Deep Dive",
        wikilink: true,
      },
    });

    // Clicking a spaced relative Markdown link calls open_workspace_link with wikilink: false
    postCalls.length = 0;
    const relAnchor = links.find((a) => a.textContent === "API Spec")!;
    await act(async () => {
      relAnchor.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(postCalls.at(-1)).toMatchObject({
      command: "open_workspace_link",
      args: {
        documentPath: "/vault/Index.md",
        target: "../my specs/api.md",
        fragment: "Auth",
        wikilink: false,
      },
    });

    // Clicking external http/mailto links invokes open_external_url on native bridges
    postCalls.length = 0;
    const webAnchor = links.find((a) => a.textContent === "Website")!;
    await act(async () => {
      webAnchor.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(postCalls.at(-1)).toMatchObject({
      command: "open_external_url",
      args: {
        url: "https://example.org",
      },
    });

    postCalls.length = 0;
    const mailAnchor = links.find((a) => a.textContent === "Email")!;
    await act(async () => {
      mailAnchor.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(postCalls.at(-1)).toMatchObject({
      command: "open_external_url",
      args: {
        url: "mailto:team@example.org",
      },
    });
  });

  it("preserves exact LiveEditor block slicing and task checkbox toggling after wikilinks and spaced links", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    const initial = [
      "# Project Hub",
      "",
      "Links: [[Research Plan#Milestones|Plan]] and [Design Doc](./design notes/spec.md#UI).",
      "",
      "- [ ] Review [[Architecture.smd]]",
      "- [x] Ship release",
      "",
      "Editable trailing paragraph.",
    ].join("\n");
    let latest = initial;
    const onChange = vi.fn((next: string) => {
      latest = next;
    });

    await act(async () => {
      root?.render(
        <LiveEditor markdown={latest} documentPath="/vault/Hub.md" dark python="" onChange={onChange} />,
      );
    });

    // Toggle first task checkbox and verify neighboring wikilinks/spaced links are untouched
    const checkboxes = host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    expect(checkboxes).toHaveLength(2);
    await act(async () => {
      checkboxes[0].click();
    });
    expect(latest).toBe(initial.replace("- [ ] Review [[Architecture.smd]]", "- [x] Review [[Architecture.smd]]"));

    // Re-render with updated markdown and double-click the trailing paragraph to verify exact block slice
    await act(async () => {
      root?.render(
        <LiveEditor markdown={latest} documentPath="/vault/Hub.md" dark python="" onChange={onChange} />,
      );
    });
    const paragraphs = Array.from(host.querySelectorAll("p"));
    const trailing = paragraphs.find((p) => p.textContent === "Editable trailing paragraph.")!;
    await act(async () => {
      trailing.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    const editor = host.querySelector<HTMLTextAreaElement>("textarea");
    expect(editor).not.toBeNull();
    expect(editor?.value).toBe("Editable trailing paragraph.");
  });
});

describe("race-free cross-note #heading jump in Reader (including >80k-char windowed notes)", () => {
  it("scrolls to pendingHeading in >80k-char windowed notes and Source mode without saved-scroll override", async () => {
    class FakeIntersectionObserver {
      constructor(_cb: IntersectionObserverCallback) {}
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    class FakeResizeObserver {
      constructor(_cb: ResizeObserverCallback) {}
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    if (!Range.prototype.getClientRects) {
      Range.prototype.getClientRects = () => ([] as unknown as DOMRectList);
    }
    if (!Range.prototype.getBoundingClientRect) {
      Range.prototype.getBoundingClientRect = () =>
        ({ top: 0, bottom: 16, left: 0, right: 80, width: 80, height: 16, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    }
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    vi.useFakeTimers();

    const readerRootEl = document.createElement("div");
    readerRootEl.id = "root";
    document.body.append(readerRootEl);
    root = createRoot(readerRootEl);
    await act(async () => {
      root?.render(<Reader />);
    });

    const fillerParagraph = `${"Detailed background paragraph for windowed rendering verification. ".repeat(25)}\n\n`;
    const largeNote =
      `# Large Handbook\n\n` +
      fillerParagraph.repeat(55) +
      `## Target Deep Section\n\nTarget section paragraph.\n\n` +
      fillerParagraph.repeat(10);
    expect(largeNote.length).toBeGreaterThan(85_000);

    const baseColors = {
      primary: "#42669e",
      "on-primary": "#ffffff",
      "primary-container": "#d7e3ff",
      "on-primary-container": "#162c4c",
      surface: "#f7f9fd",
      "surface-low": "#f0f3fa",
      "surface-high": "#e5ebf5",
      text: "#181c22",
      muted: "#56647c",
      outline: "#c4c6d0",
    };

    const gotoOffsets: number[] = [];
    const onGotoOffset = (event: Event) => {
      gotoOffsets.push((event as CustomEvent<number>).detail);
    };
    window.addEventListener("supermd-goto-offset", onGotoOffset);
    try {

    // 1. Load >80k-char note in Read mode WITH both a stale readingLocation AND a pendingHeading
    await act(async () => {
      window.supermdLoad?.({
        id: "large-note",
        path: "/vault/Large.md",
        content: largeNote,
        mode: "reader",
        dark: false,
        fullscreen: false,
        font: "Manrope",
        size: 15,
        widthPercent: 100,
        lineHeight: 1.65,
        zoom: 100,
        motion: false,
        restorePosition: true,
        readingLocation: { top: 2400, offset: 4000, zoom: 100, mode: "reader" },
        pendingHeading: { heading: "Target Deep Section", token: "jump-token-1" },
        colors: baseColors,
      });
    });

    const readingHost = document.querySelector<HTMLElement>(".android-reading")!;
    expect(readingHost).not.toBeNull();
    // Verify the windowed block containing "## Target Deep Section" was force-rendered
    expect(readingHost.textContent).toContain("Target Deep Section");

    const mountedHeading = readingHost.querySelector<HTMLElement>("#target-deep-section")!;
    expect(mountedHeading).not.toBeNull();
    vi.spyOn(readingHost, "getBoundingClientRect").mockImplementation(
      () => ({ top: 0, bottom: 800, left: 0, right: 900, width: 900, height: 800, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect,
    );
    vi.spyOn(mountedHeading, "getBoundingClientRect").mockImplementation(
      () =>
        ({
          top: 936 - readingHost.scrollTop,
          bottom: 968 - readingHost.scrollTop,
          left: 0,
          right: 900,
          width: 900,
          height: 32,
          x: 0,
          y: 936 - readingHost.scrollTop,
          toJSON: () => ({}),
        }) as DOMRect,
    );

    // Simulate a follow-up native load where pendingHeading was consumed (null) and contentUnchanged is true,
    // then advance past all 0/120/320/700ms restore timers to verify saved readingLocation (top: 2400) NEVER overwrites scrollTop!
    await act(async () => {
      window.supermdLoad?.({
        id: "large-note",
        path: "/vault/Large.md",
        content: "",
        contentUnchanged: true,
        mode: "reader",
        dark: false,
        fullscreen: false,
        font: "Manrope",
        size: 15,
        widthPercent: 100,
        lineHeight: 1.65,
        zoom: 100,
        motion: false,
        restorePosition: true,
        readingLocation: { top: 2400, offset: 4000, zoom: 100, mode: "reader" },
        pendingHeading: null,
        colors: baseColors,
      } as never);
      vi.advanceTimersByTime(900);
    });
    expect(readingHost.scrollTop).toBe(920);

    // 2. Jump to heading in Source ("editor") mode dispatches supermd-goto-offset for "## Target Deep Section"
    await act(async () => {
      window.supermdLoad?.({
        id: "source-note",
        path: "/vault/Large.md",
        content: largeNote,
        mode: "editor",
        dark: false,
        fullscreen: false,
        font: "Manrope",
        size: 15,
        widthPercent: 100,
        lineHeight: 1.65,
        zoom: 100,
        motion: false,
        restorePosition: true,
        readingLocation: { top: 1500, offset: 100, zoom: 100, mode: "editor" },
        pendingHeading: { heading: "Target Deep Section", token: "jump-token-2" },
        colors: baseColors,
      });
      vi.advanceTimersByTime(400);
    });
    expect(gotoOffsets).toContain(largeNote.indexOf("## Target Deep Section"));
    } finally {
      window.removeEventListener("supermd-goto-offset", onGotoOffset);
    }
  }, 15_000);
});

describe("Source mode Ctrl/Cmd+Click workspace link navigation", () => {
  it("flushes pending edits via supermdBeforeNavigate and opens cross-note wikilinks from Source mode", async () => {
    if (!Range.prototype.getClientRects) {
      Range.prototype.getClientRects = () => ([] as unknown as DOMRectList);
    }
    if (!Range.prototype.getBoundingClientRect) {
      Range.prototype.getBoundingClientRect = () =>
        ({ top: 0, bottom: 16, left: 0, right: 80, width: 80, height: 16, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    }
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);

    const source = "Draft intro before [[Roadmap#Q4 Goals|Q4 Plan]] in source mode.";
    const onChange = vi.fn();
    await act(async () => {
      root?.render(
        <Editor
          sessionId="source-link-test"
          documentPath="/vault/Notes/Today.md"
          value={source}
          onChange={onChange}
          dark={false}
          focusMode={false}
        />,
      );
    });

    const cmContent = host.querySelector<HTMLElement>(".cm-content")!;
    expect(cmContent).not.toBeNull();
    const view = EditorView.findFromDOM(cmContent)!;
    expect(view).not.toBeNull();

    const targetPos = source.indexOf("Roadmap#Q4 Goals") + 3;
    vi.spyOn(view, "posAtCoords").mockReturnValue(targetPos);

    const events: string[] = [];
    window.supermdBeforeNavigate = vi.fn(async () => {
      events.push("flushed");
    });
    postSpy.mockImplementationOnce((id, cmd, rawArgs) => {
      events.push(cmd);
      postCalls.push({ id, command: cmd, args: JSON.parse(rawArgs || "{}") });
      window.supermdReply?.(id, { opened: true }, null);
    });

    await act(async () => {
      cmContent.dispatchEvent(
        new MouseEvent("mousedown", {
          bubbles: true,
          cancelable: true,
          button: 0,
          ctrlKey: true,
          clientX: 120,
          clientY: 24,
        }),
      );
    });

    expect(events).toEqual(["flushed", "open_workspace_link"]);
    expect(postCalls.at(-1)).toMatchObject({
      command: "open_workspace_link",
      args: {
        documentPath: "/vault/Notes/Today.md",
        target: "Roadmap",
        fragment: "Q4 Goals",
        wikilink: true,
      },
    });
  });

  it("keeps embedded asset loading on state.id for unsaved drafts while passing empty documentPath to open_workspace_link", async () => {
    class FakeIntersectionObserver {
      constructor(_cb: IntersectionObserverCallback) {}
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    class FakeResizeObserver {
      constructor(_cb: ResizeObserverCallback) {}
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);

    postSpy.mockImplementation((id, cmd, rawArgs) => {
      const args = JSON.parse(rawArgs || "{}");
      postCalls.push({ id, command: cmd, args });
      if (cmd === "load_asset") {
        window.supermdReply?.(
          id,
          "data:image/svg+xml;utf8," + encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' width='60' height='30'/>"),
          null,
        );
        return;
      }
      if (cmd === "open_workspace_link") {
        window.supermdReply?.(id, { opened: false, message: "Save this note before opening linked notes." }, null);
        return;
      }
      window.supermdReply?.(id, { opened: true }, null);
    });

    const readerRootEl = document.createElement("div");
    readerRootEl.id = "root";
    document.body.append(readerRootEl);
    root = createRoot(readerRootEl);
    await act(async () => {
      root?.render(<Reader />);
    });

    await act(async () => {
      window.supermdLoad?.({
        id: "draft-with-asset",
        path: "draft-with-asset",
        content: "# Draft\n\n![Proof](assets/proof.svg)\n\nFollow [[Task Note]].\n",
        mode: "reader",
        dark: false,
        fullscreen: false,
        font: "Manrope",
        size: 16,
        zoom: 100,
        motion: false,
        colors: {},
      });
    });

    const loadAssetCall = postCalls.find((call) => call.command === "load_asset");
    expect(loadAssetCall).toMatchObject({
      command: "load_asset",
      args: { documentPath: "draft-with-asset", source: "assets/proof.svg" },
    });

    const link = readerRootEl.querySelector<HTMLAnchorElement>(".android-reading a")!;
    expect(link).not.toBeNull();
    await act(async () => {
      link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    const openLinkCall = postCalls.find((call) => call.command === "open_workspace_link");
    expect(openLinkCall).toMatchObject({
      command: "open_workspace_link",
      args: { documentPath: "", target: "Task Note", fragment: "", wikilink: true },
    });
    expect(readerRootEl.querySelector('[role="status"].reader-link-notice')?.textContent).toBe(
      "Save this note before opening linked notes.",
    );
  });
});
