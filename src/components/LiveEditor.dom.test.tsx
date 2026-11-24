// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const { invokeMock, toJsxRuntimeSpy } = vi.hoisted(() => ({
  invokeMock: vi.fn(async (command: string, _args: unknown) => {
    if (command === "fetch_resource") return { body: "data:image/png;base64,iVBORw0KGgo=" };
    if (command === "load_asset") return "data:image/png;base64,iVBORw0KGgo=";
    return null;
  }),
  toJsxRuntimeSpy: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("hast-util-to-jsx-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("hast-util-to-jsx-runtime")>();
  return {
    ...actual,
    toJsxRuntime: (...args: Parameters<typeof actual.toJsxRuntime>) => {
      toJsxRuntimeSpy(...args);
      return actual.toJsxRuntime(...args);
    },
  };
});

import Editor from "./Editor";
import LiveEditor from "./LiveEditor";
import { cancelHeadingNavigation } from "../documentNavigation";
import { setTypewriterScroll } from "../typewriterScroll";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  invokeMock.mockClear();
  toJsxRuntimeSpy.mockClear();
  vi.unstubAllGlobals();
});
it("has no edit icons; single clicks select and double clicks edit, not links", async () => {
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host); const edit = vi.fn();
  await act(async () => root.render(<LiveEditor markdown={'# Clear notes\n\n[Video](https://youtube.com)'} documentPath={null} dark python="" onChange={edit} />));
  expect(host.querySelector(".live-edit-button")).toBeNull();
  act(() => host.querySelector("a")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
  expect(host.querySelector("textarea")).toBeNull();
  act(() => host.querySelector("h1")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  expect(host.querySelector("textarea")).toBeNull();
  act(() => host.querySelector("h1")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  expect(host.querySelector("textarea")?.value).toBe("# Clear notes");
  act(()=>host.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true})));
  expect(host.querySelector("textarea")).toBeNull();
  act(() => root.unmount()); host.remove();
});
it("keeps answer disclosure interactive and Python source in one box", async () => {
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  await act(async () => root.render(<LiveEditor markdown={'> [!answer]- Reveal answer\n> Hidden answer\n\n```python\nprint(42)\n```'} documentPath={null} dark python="" onChange={vi.fn()} />));
  const headings = host.querySelectorAll("summary");
  expect(headings.length).toBe(1);
  expect(host.querySelector('.python-cell details')).toBeNull();
  expect(host.querySelectorAll('.python-cell .python-source')).toHaveLength(1);
  expect(host.querySelector('.python-cell .cell-toolbar')?.textContent).toContain('Run');
  for (const summary of headings) act(() => summary.dispatchEvent(new MouseEvent("click",{bubbles:true,cancelable:true})));
  expect(host.querySelector("textarea")).toBeNull();
  act(() => root.unmount()); host.remove();
});
it("toggles scroll centering immediately in LiveEditor when clicking Editor status bar Typewriter button", async () => {
  setTypewriterScroll(false);
  document.documentElement.dataset.reduceMotion = "true";
  const host = document.createElement("div");
  host.className = "reading-scroll";
  Object.defineProperty(host, "clientHeight", { value: 500, configurable: true });
  host.getBoundingClientRect = () => ({ top: 0, bottom: 500, left: 0, right: 800, width: 800, height: 500, x: 0, y: 0, toJSON: () => ({}) });
  document.body.append(host);
  const root = createRoot(host);
  const markdown = "# Heading\n\nParagraph block to center";
  await act(async () => root.render(<div>
    <Editor sessionId="tw-sync" value={markdown} onChange={vi.fn()} dark={false} focusMode={false} />
    <LiveEditor markdown={markdown} documentPath={null} dark={false} python="" onChange={vi.fn()} />
  </div>));

  const toggleButton = Array.from(host.querySelectorAll(".source-editor-status button")).find((btn) => btn.textContent === "Typewriter")!;
  expect(toggleButton.getAttribute("aria-pressed")).toBe("false");
  const liveDoc = host.querySelector<HTMLElement>(".live-document")!;
  expect(liveDoc.dataset.typewriter).toBeUndefined();

  act(() => toggleButton.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  expect(toggleButton.getAttribute("aria-pressed")).toBe("true");
  expect(liveDoc.dataset.typewriter).toBe("true");
  expect(liveDoc.style.getPropertyValue("--live-typewriter-pad")).toBe("250px");

  act(() => host.querySelector("p")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  const area = host.querySelector<HTMLTextAreaElement>("textarea")!;
  expect(area).not.toBeNull();
  area.getBoundingClientRect = () => ({ top: 420, bottom: 540, left: 20, right: 780, width: 760, height: 120, x: 20, y: 420, toJSON: () => ({}) });
  act(() => toggleButton.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  expect(toggleButton.getAttribute("aria-pressed")).toBe("false");
  expect(liveDoc.dataset.typewriter).toBeUndefined();

  act(() => {
    host.scrollTop = 100;
    toggleButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(toggleButton.getAttribute("aria-pressed")).toBe("true");
  // area midpoint = 420 + 60 = 480, viewport center = 250 -> delta = +230 on top of scrollTop
  expect(host.scrollTop).toBeGreaterThan(250);

  act(() => root.unmount());
  host.remove();
  delete document.documentElement.dataset.reduceMotion;
  setTypewriterScroll(false);
});

function typeInTextarea(area: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(area, value);
  area.dispatchEvent(new Event("input", { bubbles: true }));
}

it("keeps list images, charts, and Python cells mounted with zero redundant IPC calls across LiveEditor typing and commit", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let markdown = [
    "# Live heading",
    "",
    "- ![Diagram](images/diagram.png)",
    "",
    "```smd-chart",
    '{"title":"Energy","series":[{"expression":"cos(x)"}]}',
    "```",
    "",
    "```python",
    "print(42)",
    "```",
  ].join("\n");

  const renderLive = () =>
    root.render(
      <LiveEditor
        markdown={markdown}
        documentPath="/notes/live.md"
        dark
        python="python3"
        onChange={(next) => {
          markdown = next;
          renderLive();
        }}
      />,
    );

  await act(async () => { renderLive(); });

  const imageItem = host.querySelector("li")!;
  const image = host.querySelector<HTMLImageElement>("img")!;
  const chartSvg = host.querySelector<SVGSVGElement>(".interactive-chart svg")!;
  const pythonCell = host.querySelector<HTMLElement>(".python-cell")!;
  const initialBlocks = Array.from(host.querySelectorAll<HTMLElement>(".live-block"));
  const frozenDownstreamStarts = initialBlocks.slice(1).map((block) => block.dataset.sourceStart);
  const frozenDownstreamEnds = initialBlocks.slice(1).map((block) => block.dataset.sourceEnd);

  expect(image.getAttribute("src")).toMatch(/^data:image\/png;base64,/);
  expect(chartSvg).not.toBeNull();
  expect(pythonCell).not.toBeNull();
  expect(invokeMock.mock.calls.some(([cmd]) => cmd === "resolve_reader_asset")).toBe(true);
  expect(invokeMock.mock.calls.some(([cmd]) => cmd === "load_asset")).toBe(true);
  expect(invokeMock.mock.calls.some(([cmd]) => cmd === "load_python_output")).toBe(true);
  invokeMock.mockClear();
  toJsxRuntimeSpy.mockClear();

  await act(async () => {
    host.querySelector("h1")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  });
  const area = host.querySelector<HTMLTextAreaElement>("textarea")!;
  expect(area.value).toBe("# Live heading");
  expect(invokeMock).not.toHaveBeenCalled();
  expect(toJsxRuntimeSpy).not.toHaveBeenCalled();

  const drafts = [
    "# Live heading — step 1",
    "# Live heading — step 2 with longer text",
    "# Live heading — step 3 with longer text\nand a subtitle line",
  ];
  for (const draft of drafts) {
    await act(async () => { typeInTextarea(area, draft); });
    expect(area.value).toBe(draft);
    expect(host.querySelector("li")).toBe(imageItem);
    expect(host.querySelector("img")).toBe(image);
    expect(host.querySelector(".interactive-chart svg")).toBe(chartSvg);
    expect(host.querySelector(".python-cell")).toBe(pythonCell);
    const activeBlocks = Array.from(host.querySelectorAll<HTMLElement>(".live-block"));
    expect(activeBlocks.slice(1).map((block) => block.dataset.sourceStart)).toEqual(frozenDownstreamStarts);
    expect(activeBlocks.slice(1).map((block) => block.dataset.sourceEnd)).toEqual(frozenDownstreamEnds);
  }
  expect(invokeMock).not.toHaveBeenCalled();
  expect(toJsxRuntimeSpy).not.toHaveBeenCalled();

  await act(async () => {
    area.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });
  expect(host.querySelector("textarea")).toBeNull();
  expect(host.querySelector("h1")?.textContent).toContain("Live heading — step 3");
  expect(host.querySelector("li")).toBe(imageItem);
  expect(host.querySelector("img")).toBe(image);
  expect(host.querySelector(".interactive-chart svg")).toBe(chartSvg);
  expect(host.querySelector(".python-cell")).toBe(pythonCell);
  expect(invokeMock).not.toHaveBeenCalled();

  act(() => root.unmount());
  host.remove();
});

it("translates frozen offsets for task toggles, downstream double-clicks, source copy, and heading jumps when active edits change block length", async () => {
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("ResizeObserver", undefined);

  const host = document.createElement("div");
  host.className = "reading-scroll";
  host.getBoundingClientRect = () => ({ top: 0, bottom: 600, left: 0, right: 800, width: 800, height: 600, x: 0, y: 0, toJSON: () => ({}) });
  document.body.append(host);
  const root = createRoot(host);

  const initial = [
    "# Intro",
    "",
    "See [Target section](#target-section).",
    "",
    "- [ ] First task",
    "- [ ] Second task",
    "",
    "## Target section",
    "",
    "Downstream tail paragraph.",
  ].join("\n");
  let markdown = initial;

  const renderLive = () =>
    root.render(
      <LiveEditor
        markdown={markdown}
        documentPath={null}
        dark={false}
        python=""
        onChange={(next) => {
          markdown = next;
          renderLive();
        }}
      />,
    );

  await act(async () => { renderLive(); });

  // 1. Task toggle while active draft grew and includes checkbox-like syntax
  await act(async () => {
    host.querySelector("h1")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  });
  let area = host.querySelector<HTMLTextAreaElement>("textarea")!;
  const expandedIntro = "# Intro expanded with extra words and - [ ] inline draft note";
  await act(async () => { typeInTextarea(area, expandedIntro); });
  const checkboxes = host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
  expect(checkboxes).toHaveLength(2);
  await act(async () => { checkboxes[0].click(); });
  expect(host.querySelector("textarea")).toBeNull();
  expect(markdown).toContain(expandedIntro);
  expect(markdown).toContain("- [x] First task\n- [ ] Second task");

  // 2. Downstream double-click while active draft changed block length
  await act(async () => {
    host.querySelector("h1")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  });
  area = host.querySelector<HTMLTextAreaElement>("textarea")!;
  await act(async () => { typeInTextarea(area, "# Short"); });
  const tailParagraph = Array.from(host.querySelectorAll("p")).find((p) => p.textContent === "Downstream tail paragraph.")!;
  await act(async () => {
    tailParagraph.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  });
  area = host.querySelector<HTMLTextAreaElement>("textarea")!;
  expect(area.value).toBe("Downstream tail paragraph.");
  await act(async () => { typeInTextarea(area, "Downstream tail paragraph updated."); });
  expect(markdown.startsWith("# Short\n\n")).toBe(true);
  expect(markdown.endsWith("\n\nDownstream tail paragraph updated.")).toBe(true);
  await act(async () => {
    area.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });

  // 3. Heading jump while active draft changed block length
  await act(async () => {
    host.querySelector("h1")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  });
  area = host.querySelector<HTMLTextAreaElement>("textarea")!;
  await act(async () => { typeInTextarea(area, "# Heading with forty extra characters added here!!"); });
  const targetHeading = host.querySelector<HTMLElement>("#target-section")!;
  targetHeading.getBoundingClientRect = () => ({
    top: 900 - host.scrollTop,
    bottom: 930 - host.scrollTop,
    left: 0,
    right: 400,
    width: 400,
    height: 30,
    x: 0,
    y: 900 - host.scrollTop,
    toJSON: () => ({}),
  });
  const jumpLink = host.querySelector<HTMLAnchorElement>('a[href="#target-section"]')!;
  await act(async () => {
    jumpLink.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  expect(host.scrollTop).toBe(900 - 16);
  expect(document.activeElement).toBe(targetHeading);
  cancelHeadingNavigation(host);

  act(() => root.unmount());
  host.remove();
});

it("copies accurate Markdown across unmounted windowed blocks when active LiveEditor draft changes block length", async () => {
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
  class FakeResizeObserver { constructor(_callback: ResizeObserverCallback) {} observe() {} disconnect() {} }
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);

  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);

  const filler = "Windowed body sentence for large live note. ".repeat(2_000);
  let markdown = `# Editable top\n\nLead paragraph.\n\n## Unmounted section\n\n${filler}`;
  const renderLive = () =>
    root.render(
      <LiveEditor
        markdown={markdown}
        documentPath={null}
        dark={false}
        python=""
        onChange={(next) => {
          markdown = next;
          renderLive();
        }}
      />,
    );

  await act(async () => { renderLive(); });
  const initialWindowedBlocks = Array.from(host.querySelectorAll<HTMLElement>("[data-windowed-block]"));
  expect(initialWindowedBlocks.length).toBeGreaterThanOrEqual(4);
  const observer = FakeIntersectionObserver.instances[0]!;
  await act(async () => {
    observer.emit(initialWindowedBlocks[0]!, true);
    observer.emit(initialWindowedBlocks[1]!, true);
  });

  const copySelection = () => {
    const unmountedHeading = Array.from(host.querySelectorAll<HTMLElement>('[data-windowed-mounted="false"]'))[0]!;
    expect(unmountedHeading).toBeDefined();
    const range = document.createRange();
    range.setStartBefore(host.querySelector("p")!);
    range.setEndAfter(unmountedHeading);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    let copied = "";
    const copyEvent = new Event("copy", { bubbles: true, cancelable: true });
    Object.defineProperty(copyEvent, "clipboardData", {
      value: { setData: (_type: string, value: string) => { copied = value; } },
    });
    act(() => {
      host.querySelector("p")!.dispatchEvent(copyEvent);
    });
    selection.removeAllRanges();
    expect(copyEvent.defaultPrevented).toBe(true);
    return copied;
  };

  const baselineCopy = copySelection();
  expect(baselineCopy).toContain("Lead paragraph.");
  expect(baselineCopy.endsWith("## Unmounted section")).toBe(true);

  await act(async () => {
    host.querySelector("h1")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  });
  const area = host.querySelector<HTMLTextAreaElement>("textarea")!;
  await act(async () => {
    typeInTextarea(area, "# Editable top with substantial extra length added while typing");
  });

  expect(copySelection()).toBe(baselineCopy);

  await act(async () => {
    area.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });
  expect(copySelection()).toBe(baselineCopy);

  act(() => root.unmount());
  host.remove();
});

