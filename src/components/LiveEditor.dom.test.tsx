// @vitest-environment jsdom
import { act, StrictMode, useState } from "react";
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
import LiveEditor, { formatActiveLiveBlock } from "./LiveEditor";
import { cancelHeadingNavigation } from "../documentNavigation";
import { applyHistoryEdit, replayHistory, tryLiveTextareaHistory, type LiveHistoryEditMeta, type NoteHistory } from "../noteHistory";
import * as proofreading from "../proofreading";
import { setTypewriterScroll } from "../typewriterScroll";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const execCommandCleanups: Array<() => void> = [];
afterEach(() => {
  while (execCommandCleanups.length > 0) execCommandCleanups.pop()?.();
  invokeMock.mockClear();
  toJsxRuntimeSpy.mockClear();
  vi.unstubAllGlobals();
});

function pointerEvent(type: string, init: MouseEventInit & { pointerId?: number; pointerType?: string } = {}) {
  const event = new MouseEvent(type, init);
  return Object.assign(event, { pointerId: init.pointerId ?? 1, pointerType: init.pointerType ?? "mouse" });
}
function StatefulLiveEditor({ initial, onEdit, typewriterScroll }: { initial: string; onEdit?: (next: string) => void; typewriterScroll?: boolean }) {
  const [markdown, setMarkdown] = useState(initial);
  return <LiveEditor markdown={markdown} documentPath={null} dark={false} python="" typewriterScroll={typewriterScroll} onChange={(next) => { setMarkdown(next); onEdit?.(next); }} />;
}
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
it("toggles formatting shortcuts, wraps URL pastes over selections, pastes plain URLs at bare cursor, and undoes with selection intact", async () => {
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  let doc = "Hello brave world";
  const renderCurrent = () => {
    root.render(<LiveEditor markdown={doc} documentPath={null} dark python="" onChange={(next) => { doc = next; renderCurrent(); }} />);
  };
  await act(async () => { renderCurrent(); });

  act(() => host.querySelector("p")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  const area = host.querySelector("textarea")!;
  expect(area.value).toBe("Hello brave world");

  // Select "brave" [6..11] and toggle Bold twice
  act(() => {
    area.focus();
    area.setSelectionRange(6, 11);
    area.dispatchEvent(new KeyboardEvent("keydown", { key: "b", ctrlKey: true, bubbles: true, cancelable: true }));
  });
  expect(doc).toBe("Hello **brave** world");
  expect([area.selectionStart, area.selectionEnd]).toEqual([8, 13]);
  expect(document.activeElement).toBe(area);

  act(() => {
    area.dispatchEvent(new KeyboardEvent("keydown", { key: "b", ctrlKey: true, bubbles: true, cancelable: true }));
  });
  expect(doc).toBe("Hello brave world");
  expect([area.selectionStart, area.selectionEnd]).toEqual([6, 11]);

  // Paste standalone URL over selected "brave" -> wraps [brave](https://example.com) inline without closing Live block
  act(() => {
    const pasteEvent = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, "clipboardData", {
      value: {
        files: [],
        getData: (type: string) => (type === "text/plain" ? "https://example.com" : ""),
      },
    });
    area.dispatchEvent(pasteEvent);
  });
  expect(doc).toBe("Hello [brave](https://example.com) world");
  expect(host.querySelector("textarea")).toBe(area);
  expect(document.activeElement).toBe(area);

  // Single Undo step restores exact prior text AND selection [6, 11]
  act(() => {
    area.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true }));
  });
  expect(doc).toBe("Hello brave world");
  expect([area.selectionStart, area.selectionEnd]).toEqual([6, 11]);

  // Bare cursor URL paste inserts plain URL directly
  act(() => {
    area.setSelectionRange(17, 17);
    const pasteEvent = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, "clipboardData", {
      value: {
        files: [],
        getData: (type: string) => (type === "text/plain" ? "https://example.org/plain" : ""),
      },
    });
    area.dispatchEvent(pasteEvent);
  });
  expect(doc).toBe("Hello brave worldhttps://example.org/plain");

  act(() => {
    area.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true }));
  });
  expect(doc).toBe("Hello brave world");
  expect([area.selectionStart, area.selectionEnd]).toEqual([17, 17]);

  act(() => root.unmount()); host.remove();
});
it("reveals Edit block on hover, keyboard focus, and tap without blocking single clicks or triggering on pan/fullscreen prose taps", async () => {
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host); const edit = vi.fn();
  const md = '[Standalone](https://example.com)\n\n> [!note]- Folded callout\n> Secret\n\n```smd-chart\n{"title":"Wave","x":{"min":0,"max":4},"series":[{"expression":"x"}]}\n```';
  await act(async () => root.render(<LiveEditor markdown={md} documentPath={null} dark={false} python="" onChange={edit} />));
  const blocks = host.querySelectorAll<HTMLElement>(".live-block");
  expect(host.querySelector('button[aria-label="Edit block"]')).toBeNull();

  // Keyboard focus reveals Edit block on standalone link without opening editor automatically.
  act(() => blocks[0].focus());
  expect(blocks[0].querySelector('button[aria-label="Edit block"]')).not.toBeNull();
  act(() => blocks[0].querySelector<HTMLButtonElement>('button[aria-label="Edit block"]')!.click());
  expect(host.querySelector("textarea")?.value).toBe("[Standalone](https://example.com)");
  act(() => host.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  expect(host.querySelector("textarea")).toBeNull();

  // Touch pan drag (>8px) does not reveal Edit block.
  act(() => {
    blocks[1].blur();
    document.body.focus();
    blocks[1].dispatchEvent(pointerEvent("pointerdown", { bubbles: true, pointerId: 2, pointerType: "touch", clientX: 20, clientY: 20 }));
    blocks[1].dispatchEvent(pointerEvent("pointermove", { bubbles: true, pointerId: 2, pointerType: "touch", clientX: 20, clientY: 45 }));
    blocks[1].dispatchEvent(pointerEvent("pointerup", { bubbles: true, pointerId: 2, pointerType: "touch", clientX: 20, clientY: 45 }));
  });
  expect(blocks[1].querySelector('button[aria-label="Edit block"]')).toBeNull();

  // Touch tap on collapsed callout reveals Edit block and opens source when clicked.
  act(() => {
    const summary = blocks[1].querySelector("summary")!;
    summary.dispatchEvent(pointerEvent("pointerdown", { bubbles: true, pointerId: 3, pointerType: "touch", clientX: 25, clientY: 25 }));
    summary.dispatchEvent(pointerEvent("pointerup", { bubbles: true, pointerId: 3, pointerType: "touch", clientX: 26, clientY: 25 }));
  });
  expect(blocks[1].querySelector('button[aria-label="Edit block"]')).not.toBeNull();
  act(() => blocks[1].querySelector<HTMLButtonElement>('button[aria-label="Edit block"]')!.click());
  expect(host.querySelector("textarea")?.value).toContain("[!note]- Folded callout");
  act(() => host.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));

  // Mouse hover on chart block reveals Edit block.
  act(() => { blocks[2].dispatchEvent(pointerEvent("pointerover", { bubbles: true, pointerType: "mouse", buttons: 0 })); blocks[2].dispatchEvent(pointerEvent("pointermove", { bubbles: true, pointerType: "mouse", buttons: 0 })); });
  expect(blocks[2].querySelector('button[aria-label="Edit block"]')).not.toBeNull();

  // Fullscreen plain-prose tap does not reveal Edit block.
  await act(async () => root.render(<LiveEditor markdown={"Plain paragraph"} documentPath={null} dark={false} python="" onChange={edit} />));
  document.documentElement.dataset.fullscreen = "true";
  const proseBlock = host.querySelector<HTMLElement>(".live-block")!;
  const p = proseBlock.querySelector("p")!;
  act(() => {
    p.dispatchEvent(pointerEvent("pointerdown", { bubbles: true, pointerId: 4, pointerType: "touch", clientX: 10, clientY: 10 }));
    p.dispatchEvent(pointerEvent("pointerup", { bubbles: true, pointerId: 4, pointerType: "touch", clientX: 10, clientY: 10 }));
  });
  expect(proseBlock.querySelector('button[aria-label="Edit block"]')).toBeNull();
  delete document.documentElement.dataset.fullscreen;

  act(() => root.unmount()); host.remove();
});
it("waits until pointer release on outside press and preserves lower block DOM across line-count edits", async () => {
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  let latest = "# Title\n\n- [ ] Check me\n\n[Jump](#title)";
  function Harness() {
    const [md, setMd] = useState(latest);
    return <div className="reading-scroll"><LiveEditor markdown={md} documentPath={null} dark={false} python="" onChange={(next) => { latest = next; setMd(next); }} /></div>;
  }
  await act(async () => root.render(<Harness />));
  const lowerCheckboxBlock = host.querySelectorAll<HTMLElement>(".live-block")[1];
  const lowerLinkBlock = host.querySelectorAll<HTMLElement>(".live-block")[2];

  act(() => host.querySelector("h1")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  const area = host.querySelector<HTMLTextAreaElement>("textarea")!;
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(area, "# Title\nLine 2\nLine 3\nLine 4");
    area.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(host.querySelector("textarea")).not.toBeNull();

  const link = lowerLinkBlock.querySelector("a")!;
  let clicked = 0;
  link.addEventListener("click", (e) => { e.preventDefault(); clicked++; });

  // Press down on link below: textarea blurs during mousedown, but editor stays open until release!
  act(() => {
    link.dispatchEvent(pointerEvent("pointerdown", { bubbles: true, clientY: 200 }));
    link.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientY: 200 }));
    area.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: link }));
    link.focus();
  });
  expect(host.querySelector("textarea")).not.toBeNull();

  // Release pointer and dispatch click: link receives first click and editor closes cleanly.
  await act(async () => {
    link.dispatchEvent(pointerEvent("pointerup", { bubbles: true, clientY: 200 }));
    link.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientY: 200 }));
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, clientY: 200 }));
    await new Promise((resolve) => window.setTimeout(resolve, 10));
  });

  expect(clicked).toBe(1);
  expect(latest).toContain("Line 4");
  expect(host.querySelector("textarea")).toBeNull();
  // Lower blocks kept their exact DOM elements despite text-length (+21 chars) and block-count (+1 block) changes!
  expect(host.querySelectorAll(".live-block")[2]).toBe(lowerCheckboxBlock);
  expect(host.querySelectorAll(".live-block")[3]).toBe(lowerLinkBlock);

  act(() => root.unmount()); host.remove();
});
it("isolates YAML frontmatter when double-clicking, navigating with ArrowUp, or inserting with Cmd+Enter", async () => {
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  let current = "\uFEFF---  \ntitle: Protected Metadata\nauthor: Paul Dirac\ntags: [quantum]\n...\n\n# Opening Heading\n\nBody paragraph.";
  const renderDoc = () => root.render(<LiveEditor markdown={current} documentPath={null} dark python="" onChange={(next: string) => { current = next; renderDoc(); }} />);
  await act(async () => renderDoc());
  expect(host.querySelector('[data-frontmatter-properties="true"]')?.textContent).toContain("Protected Metadata");
  act(() => host.querySelector("h1")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  const area = host.querySelector("textarea")!;
  expect(area).not.toBeNull();
  expect(area.value).toBe("# Opening Heading");
  expect(area.value).not.toContain("Protected Metadata");
  expect(area.value).not.toContain("---");

  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => {
    setter.call(area, "# Updated Heading");
    area.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(current).toBe("\uFEFF---  \ntitle: Protected Metadata\nauthor: Paul Dirac\ntags: [quantum]\n...\n\n# Updated Heading\n\nBody paragraph.");

  // ArrowDown to second block, then ArrowUp back to first block must still exclude YAML frontmatter.
  area.setSelectionRange(area.value.length, area.value.length);
  act(() => { area.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })); });
  const secondArea = host.querySelector("textarea")!;
  expect(secondArea.value).toBe("Body paragraph.");
  secondArea.setSelectionRange(0, 0);
  act(() => { secondArea.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true })); });
  const firstAgain = host.querySelector("textarea")!;
  expect(firstAgain.value).toBe("# Updated Heading");
  expect(firstAgain.value).not.toContain("Protected Metadata");

  // Ctrl+Enter below first block inserts cleanly without touching frontmatter.
  act(() => { firstAgain.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true })); });
  const inserted = host.querySelector("textarea")!;
  expect(inserted.value).toBe("");
  act(() => {
    setter.call(inserted, "Inserted after heading");
    inserted.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(current).toBe("\uFEFF---  \ntitle: Protected Metadata\nauthor: Paul Dirac\ntags: [quantum]\n...\n\n# Updated Heading\n\nInserted after heading\n\nBody paragraph.");

  act(() => root.unmount()); host.remove();
});
it("renders properties and an editable empty body block for frontmatter-only notes", async () => {
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const edit = vi.fn();
  const note = "---\ntitle: Frontmatter Only\n---";
  await act(async () => root.render(<LiveEditor markdown={note} documentPath={null} dark python="" onChange={edit} />));
  expect(host.querySelector('[data-frontmatter-properties="true"]')?.textContent).toContain("Frontmatter Only");
  const block = host.querySelector('[aria-label="Editable block 1"]')!;
  expect(block).not.toBeNull();
  act(() => block.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  const area = host.querySelector("textarea")!;
  expect(area.value).toBe("");
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => {
    setter.call(area, "# First Body Line");
    area.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(edit).toHaveBeenCalledWith("---\ntitle: Frontmatter Only\n---\n# First Body Line");
  act(() => root.unmount()); host.remove();
});
it("preserves the latest blurred textarea selection for supermd-insertion-point and clears it on external edits", async () => {
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  let doc = "# Heading\n\nMiddle block\n\nLast block";
  const rerender = async (next: string) => {
    doc = next;
    await act(async () => root.render(<LiveEditor markdown={doc} documentPath={null} dark={false} python="" onChange={(val) => { doc = val; }} />));
  };
  await rerender(doc);
  const paragraphs = host.querySelectorAll("p");
  act(() => paragraphs[0]!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  const area = host.querySelector("textarea")!;
  expect(area.value).toBe("Middle block");
  act(() => {
    area.focus();
    area.setSelectionRange(6, 12);
    area.dispatchEvent(new Event("select", { bubbles: true }));
    area.blur();
  });
  expect(host.querySelector("textarea")).toBeNull();

  const queryInsertion = (extra: Record<string, unknown> = {}) => {
    const detail: { point?: { from: number; to: number }; x?: number; y?: number } = { ...extra };
    window.dispatchEvent(new CustomEvent("supermd-insertion-point", { detail }));
    return detail.point;
  };
  expect(queryInsertion()).toEqual({ from: 17, to: 23 });
  expect(queryInsertion({ x: 30, y: 40 })).toBeUndefined();

  await rerender("# Externally replaced note");
  expect(queryInsertion()).toBeUndefined();
  act(() => root.unmount()); host.remove();
});

it("keeps focus on Tab/Shift+Tab, restores block focus on Escape, and reopens with Enter or F2", async () => {
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  let doc = "- First\n- Second\n\nNext paragraph";
  const renderDoc = () => root.render(<LiveEditor markdown={doc} documentPath={null} dark python="" onChange={(next) => { doc = next; renderDoc(); }} />);
  await act(async () => renderDoc());

  act(() => host.querySelector("li")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  const area = host.querySelector("textarea")!;
  expect(document.activeElement).toBe(area);
  area.setSelectionRange(10, 10);

  act(() => { area.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })); });
  expect(doc).toBe("- First\n  - Second\n\nNext paragraph");
  expect(document.activeElement).toBe(area);

  act(() => { area.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true })); });
  expect(doc).toBe("- First\n- Second\n\nNext paragraph");
  expect(document.activeElement).toBe(area);

  // Shift+Tab at 0 indent still keeps the textarea open and focused.
  act(() => { area.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true })); });
  expect(host.querySelector("textarea")).toBe(area);
  expect(document.activeElement).toBe(area);

  // Escape closes editor and leaves keyboard focus on that .live-block so Enter and F2 reopen it.
  act(() => { area.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
  expect(host.querySelector("textarea")).toBeNull();
  const firstBlock = host.querySelectorAll<HTMLElement>(".live-block")[0]!;
  expect(document.activeElement).toBe(firstBlock);

  act(() => { firstBlock.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
  expect(host.querySelector("textarea")?.value).toBe("- First\n- Second");
  act(() => { host.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
  expect(document.activeElement).toBe(firstBlock);

  act(() => { firstBlock.dispatchEvent(new KeyboardEvent("keydown", { key: "F2", bubbles: true, cancelable: true })); });
  expect(host.querySelector("textarea")?.value).toBe("- First\n- Second");

  act(() => root.unmount()); host.remove();
});

it("supports Cmd/Ctrl+Enter block creation, ArrowUp/ArrowDown navigation, and trailing blank space double-click", async () => {
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  let doc = "# Heading\n\nBody line";
  const renderDoc = () => root.render(<LiveEditor markdown={doc} documentPath={null} dark python="" onChange={(next) => { doc = next; renderDoc(); }} />);
  await act(async () => renderDoc());

  // Open first block and press Ctrl+Enter to create a new block immediately below it.
  act(() => host.querySelector("h1")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  act(() => { host.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true })); });
  const inserted = host.querySelector("textarea")!;
  expect(inserted.value).toBe("");
  expect(document.activeElement).toBe(inserted);

  // Pressing Escape on an untouched inserted block leaves no stray blank lines.
  act(() => { inserted.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
  expect(doc).toBe("# Heading\n\nBody line");

  // Reopen first block, press Meta+Enter (macOS Cmd+Enter), and type into the new block.
  act(() => host.querySelector("h1")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  act(() => { host.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true, cancelable: true })); });
  const cmdInserted = host.querySelector("textarea")!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(cmdInserted, "Inserted middle");
    cmdInserted.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(doc).toBe("# Heading\n\nInserted middle\n\nBody line");

  // ArrowDown at end of last line moves to "Body line"; ArrowUp at start of first line moves back.
  cmdInserted.setSelectionRange(cmdInserted.value.length, cmdInserted.value.length);
  act(() => { cmdInserted.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })); });
  const nextArea = host.querySelector("textarea")!;
  expect(nextArea.value).toBe("Body line");
  expect(nextArea.selectionStart).toBe(0);

  act(() => { nextArea.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true })); });
  expect(host.querySelector("textarea")?.value).toBe("Inserted middle");

  // Close editor, then double-click trailing blank space on .live-document to append at the end.
  act(() => { host.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
  act(() => { host.querySelector(".live-document")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
  const trailing = host.querySelector("textarea")!;
  expect(trailing.value).toBe("");
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(trailing, "Appended end");
    trailing.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(doc).toBe("# Heading\n\nInserted middle\n\nBody line\n\nAppended end");

  act(() => root.unmount()); host.remove();
});

it("edits diagrams, folded blocks, and unzoomed charts on double-click, resets zoomed charts, and supports viewer Edit source", async () => {
  const { default: ImageViewer } = await import("./ImageViewer");
  const { default: MarkdownPreview } = await import("./MarkdownPreview");
  const { chartZooms } = await import("../renderedOutputs");
  vi.useFakeTimers();
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const chartSpec = JSON.stringify({ title: "Wave", series: [{ expression: "x" }] });
  const longCode = Array.from({ length: 14 }, (_, i) => `const x${i} = ${i};`).join("\n");
  const svgSource = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60" fill="#369"/></svg>';
  const note = `> [!answer]- Folded callout\n> Secret\n\n\`\`\`js\n${longCode}\n\`\`\`\n\n\`\`\`svg\n${svgSource}\n\`\`\`\n\n\`\`\`smd-chart\n${chartSpec}\n\`\`\``;

  try {
    chartZooms.delete(chartSpec);
    await act(async () => root.render(<div>
      <ImageViewer />
      <div className="live-pane"><LiveEditor markdown={note} documentPath={null} dark={false} python="" onChange={() => {}} /></div>
      <div className="preview-pane"><MarkdownPreview markdown={`\`\`\`svg\n${svgSource}\n\`\`\``} documentPath={null} dark={false} python="" /></div>
    </div>));

    // Read-only preview single-click opens ImageViewer immediately (0ms) with no Edit source button.
    const previewImg = host.querySelector<HTMLImageElement>(".preview-pane img.svg-diagram")!;
    act(() => { previewImg.click(); });
    expect(host.querySelector(".image-viewer")).not.toBeNull();
    expect(Array.from(host.querySelectorAll(".image-viewer button")).map((b) => b.textContent)).not.toContain("Edit source");
    act(() => { host.querySelector<HTMLButtonElement>('[aria-label="Close image viewer"]')!.click(); });
    expect(host.querySelector(".image-viewer")).toBeNull();

    // Live single-click opens ImageViewer with Edit source; clicking Edit source closes modal and opens textarea.
    const liveSvg = host.querySelector<HTMLImageElement>(".live-pane img.svg-diagram")!;
    act(() => { liveSvg.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 })); });
    act(() => { vi.advanceTimersByTime(220); });
    expect(host.querySelector(".image-viewer")).not.toBeNull();
    const editBtn = Array.from(host.querySelectorAll<HTMLButtonElement>(".image-viewer button")).find((b) => b.textContent === "Edit source")!;
    expect(editBtn).toBeDefined();
    act(() => { editBtn.click(); });
    expect(host.querySelector(".image-viewer")).toBeNull();
    expect(host.querySelector("textarea")?.value).toContain("```svg");
    expect(document.activeElement).toBe(host.querySelector("textarea"));
    act(() => { host.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });

    // Double-clicking SVG diagram in Live mode opens textarea without leaving ImageViewer open.
    const remountedLiveSvg = host.querySelector<HTMLImageElement>(".live-pane img.svg-diagram")!;
    act(() => {
      remountedLiveSvg.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
      remountedLiveSvg.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 2 }));
      remountedLiveSvg.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, detail: 2 }));
      vi.advanceTimersByTime(250);
    });
    expect(host.querySelector(".image-viewer")).toBeNull();
    expect(host.querySelector("textarea")?.value).toContain("```svg");
    act(() => { host.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });

    // Double-clicking folded callout summary and >12-line code disclosure summary opens their source.
    act(() => { host.querySelector("details.callout > summary")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
    expect(host.querySelector("textarea")?.value).toContain("[!answer]- Folded callout");
    act(() => { host.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });

    act(() => { host.querySelector(".code-disclosure > summary")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
    expect(host.querySelector("textarea")?.value).toContain("const x13 = 13;");
    act(() => { host.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });

    // Zoomed chart double-click resets viewport instead of opening source; unzoomed chart double-click opens source.
    const chartSvg = host.querySelector<SVGSVGElement>(".interactive-chart svg")!;
    act(() => {
      chartSvg.dispatchEvent(new WheelEvent("wheel", { ctrlKey: true, deltaY: -120, bubbles: true, cancelable: true }));
      vi.runAllTimers();
    });
    const figure = host.querySelector<HTMLElement>(".interactive-chart")!;
    // Trigger zoom via native zoom event if requestAnimationFrame was queued:
    if (Number(figure.dataset.plotZoom) === 1) {
      chartSvg.focus?.();
      act(() => {
        Object.defineProperty(document, "activeElement", { configurable: true, value: chartSvg });
        window.dispatchEvent(new CustomEvent("supermd-chart-native-zoom", { detail: 2, cancelable: true }));
      });
      delete (document as any).activeElement;
    }
    expect(Number(figure.dataset.plotZoom)).not.toBe(1);
    act(() => { chartSvg.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true })); });
    expect(Number(figure.dataset.plotZoom)).toBe(1);
    expect(host.querySelector("textarea")).toBeNull();

    act(() => { chartSvg.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true })); });
    expect(host.querySelector("textarea")?.value).toContain("```smd-chart");
  } finally {
    chartZooms.delete(chartSpec);
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
  }
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

  // Inserting a block via Ctrl+Enter and typing into it also preserves all mounted subtrees and skips toJsxRuntime.
  await act(async () => {
    host.querySelector("h1")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  });
  await act(async () => {
    host.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true }));
  });
  const insertedArea = host.querySelector<HTMLTextAreaElement>("textarea")!;
  toJsxRuntimeSpy.mockClear();
  for (const insertedDraft of ["Inserted note", "Inserted note with extra details"]) {
    await act(async () => { typeInTextarea(insertedArea, insertedDraft); });
    expect(host.querySelector("li")).toBe(imageItem);
    expect(host.querySelector("img")).toBe(image);
    expect(host.querySelector(".interactive-chart svg")).toBe(chartSvg);
    expect(host.querySelector(".python-cell")).toBe(pythonCell);
  }
  expect(invokeMock).not.toHaveBeenCalled();
  expect(toJsxRuntimeSpy).not.toHaveBeenCalled();

  await act(async () => {
    insertedArea.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });
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

  // 2b. Double-clicking the block immediately above an active Ctrl+Enter inserted block keeps exact end bound
  await act(async () => {
    host.querySelector("h1")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  });
  await act(async () => {
    host.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true }));
  });
  area = host.querySelector<HTMLTextAreaElement>("textarea")!;
  await act(async () => { typeInTextarea(area, "Inserted beneath short heading."); });
  await act(async () => {
    host.querySelector("h1")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  });
  area = host.querySelector<HTMLTextAreaElement>("textarea")!;
  expect(area.value).toBe("# Short");
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

it("continues and clears list, task, and quote markers on Enter and indents/outdents lists with Tab and Shift+Tab without losing focus", async () => {
  document.documentElement.dataset.reduceMotion = "true";
  const host = document.createElement("div");
  host.className = "reading-scroll";
  Object.defineProperty(host, "clientHeight", { value: 400, configurable: true });
  host.getBoundingClientRect = () => ({ top: 0, bottom: 400, left: 0, right: 800, width: 800, height: 400, x: 0, y: 0, toJSON: () => ({}) });
  document.body.append(host);
  const root = createRoot(host);
  const edits: string[] = [];
  const initial = "- [x] Done task\n\n> [!answer]\n\nPlain paragraph\n\n```ts\n- literal code\n```";
  await act(async () => root.render(<StatefulLiveEditor initial={initial} onEdit={(v) => edits.push(v)} typewriterScroll />));

  // Open task list block
  act(() => host.querySelector("li")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  const area = host.querySelector<HTMLTextAreaElement>("textarea")!;
  area.focus();
  area.setSelectionRange(area.value.length, area.value.length);
  expect(document.activeElement).toBe(area);

  // IME composition Enter is ignored
  const imeEnter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, isComposing: true });
  act(() => { area.dispatchEvent(imeEnter); });
  expect(imeEnter.defaultPrevented).toBe(false);
  expect(area.value).toBe("- [x] Done task");

  // Enter continues task with unchecked checkbox, restores selection, and centers typewriter scroll
  area.getBoundingClientRect = () => ({ top: 320, bottom: 460, left: 20, right: 780, width: 760, height: 140, x: 20, y: 320, toJSON: () => ({}) });
  host.scrollTop = 100;
  const enter1 = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  act(() => { area.dispatchEvent(enter1); });
  expect(enter1.defaultPrevented).toBe(true);
  expect(area.value).toBe("- [x] Done task\n- [ ] ");
  expect(area.selectionStart).toBe(area.value.length);
  expect(area.selectionEnd).toBe(area.value.length);
  expect(document.activeElement).toBe(area);
  await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)); });
  expect(host.scrollTop).toBeGreaterThan(100);

  // Multi-line selection Tab and Shift+Tab preserve selection range and focus
  area.setSelectionRange(0, area.value.length);
  act(() => { area.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })); });
  expect(area.value).toBe("  - [x] Done task\n  - [ ] ");
  expect(area.selectionStart).toBe(0);
  expect(area.selectionEnd).toBe(area.value.length);
  act(() => { area.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true })); });
  expect(area.value).toBe("- [x] Done task\n- [ ] ");
  area.setSelectionRange(area.value.length, area.value.length);

  // Tab indents second task item and caps nested indentation at one level without losing focus
  const tab1 = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
  act(() => { area.dispatchEvent(tab1); });
  expect(tab1.defaultPrevented).toBe(true);
  expect(area.value).toBe("- [x] Done task\n  - [ ] ");
  expect(area.selectionStart).toBe(area.value.length);
  expect(document.activeElement).toBe(area);

  const tab2 = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
  act(() => { area.dispatchEvent(tab2); });
  expect(tab2.defaultPrevented).toBe(true);
  expect(area.value).toBe("- [x] Done task\n  - [ ] ");
  expect(document.activeElement).toBe(area);

  // Shift+Tab outdents back to root; a second Shift+Tab at root prevents blur without removing marker
  const shiftTab1 = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
  act(() => { area.dispatchEvent(shiftTab1); });
  expect(shiftTab1.defaultPrevented).toBe(true);
  expect(area.value).toBe("- [x] Done task\n- [ ] ");
  expect(document.activeElement).toBe(area);

  const shiftTabRoot = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
  act(() => { area.dispatchEvent(shiftTabRoot); });
  expect(shiftTabRoot.defaultPrevented).toBe(true);
  expect(area.value).toBe("- [x] Done task\n- [ ] ");
  expect(document.activeElement).toBe(area);

  // Enter on empty task marker clears it cleanly
  const enterClear = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  act(() => { area.dispatchEvent(enterClear); });
  expect(enterClear.defaultPrevented).toBe(true);
  expect(area.value).toBe("- [x] Done task\n");
  expect(area.selectionStart).toBe(area.value.length);

  // Escape dismisses the active textarea
  act(() => { area.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
  expect(host.querySelector("textarea")).toBeNull();
  expect(edits.at(-1)).toContain("- [x] Done task\n");

  // Open callout blockquote: Enter continues with "> " without repeating "[!answer]", and Escape closes
  const blocks = host.querySelectorAll<HTMLElement>(".live-block");
  act(() => blocks[1].dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  const quoteArea = host.querySelector<HTMLTextAreaElement>("textarea")!;
  quoteArea.focus();
  quoteArea.setSelectionRange(quoteArea.value.length, quoteArea.value.length);
  act(() => { quoteArea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
  expect(quoteArea.value).toBe("> [!answer]\n> ");
  act(() => { quoteArea.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
  expect(host.querySelector("textarea")).toBeNull();

  // Open plain paragraph: Ctrl+Shift+L toggles bullet list, Enter continues list, and Ctrl+Z/Ctrl+Shift+Z undo/redo cleanly
  act(() => host.querySelectorAll<HTMLElement>(".live-block")[2].dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  const paraArea = host.querySelector<HTMLTextAreaElement>("textarea")!;
  paraArea.focus();
  paraArea.setSelectionRange(paraArea.value.length, paraArea.value.length);
  act(() => { paraArea.dispatchEvent(new KeyboardEvent("keydown", { key: "L", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true })); });
  expect(paraArea.value).toBe("- Plain paragraph");
  act(() => { paraArea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
  expect(paraArea.value).toBe("- Plain paragraph\n- ");
  act(() => { paraArea.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true })); });
  expect(paraArea.value).toBe("- Plain paragraph");
  expect(paraArea.selectionStart).toBe("- Plain paragraph".length);
  act(() => { paraArea.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true })); });
  expect(paraArea.value).toBe("- Plain paragraph\n- ");
  act(() => { paraArea.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true })); });
  act(() => { paraArea.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true })); });
  expect(paraArea.value).toBe("Plain paragraph");

  // Tab/Shift+Tab indents and outdents plain paragraph in-place while retaining focus
  const paraTab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
  act(() => { paraArea.dispatchEvent(paraTab); });
  expect(paraTab.defaultPrevented).toBe(true);
  expect(paraArea.value).toBe("  Plain paragraph");
  act(() => { paraArea.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true })); });
  expect(paraArea.value).toBe("Plain paragraph");
  act(() => { paraArea.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });

  // Open protected code block: Enter remains literal (not prevented as a list continuation)
  act(() => host.querySelectorAll<HTMLElement>(".live-block")[3].dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  const codeArea = host.querySelector<HTMLTextAreaElement>("textarea")!;
  codeArea.setSelectionRange(codeArea.value.indexOf("code") + 4, codeArea.value.indexOf("code") + 4);
  const codeEnter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  act(() => { codeArea.dispatchEvent(codeEnter); });
  expect(codeEnter.defaultPrevented).toBe(false);

  act(() => root.unmount());
  host.remove();
  delete document.documentElement.dataset.reduceMotion;
});

function HistoryBackedLiveEditor({
  initial,
  spellCheck = false,
  grammarCheck = false,
  historyRef,
  onDocChange,
  triggerRef,
}: {
  initial: string;
  spellCheck?: boolean;
  grammarCheck?: boolean;
  historyRef: { current: NoteHistory };
  onDocChange?: (value: string) => void;
  triggerRef: { current: (direction: "undo" | "redo") => void };
}) {
  const [markdown, setMarkdown] = useState(initial);
  const [replayToken, setReplayToken] = useState(0);
  const latestMarkdownRef = { current: markdown };
  latestMarkdownRef.current = markdown;

  const commitChange = (next: string, meta?: LiveHistoryEditMeta) => {
    const prev = latestMarkdownRef.current;
    if (next === prev) return;
    applyHistoryEdit(historyRef.current, prev, next, Date.now(), meta);
    latestMarkdownRef.current = next;
    setMarkdown(next);
    onDocChange?.(next);
  };

  const runHistory = (direction: "undo" | "redo") => {
    const activeEl = document.activeElement;
    if (activeEl instanceof HTMLTextAreaElement && activeEl.closest(".live-active-block")) {
      if (tryLiveTextareaHistory(direction)) return true;
    }
    const next = replayHistory(historyRef.current, latestMarkdownRef.current, direction);
    if (next === undefined) return false;
    latestMarkdownRef.current = next;
    setReplayToken((n) => n + 1);
    setMarkdown(next);
    onDocChange?.(next);
    return true;
  };
  triggerRef.current = (direction) => {
    runHistory(direction);
  };

  return (
    <div className="reading-scroll">
      <LiveEditor
        markdown={markdown}
        documentPath={null}
        dark={false}
        python=""
        spellCheck={spellCheck}
        grammarCheck={grammarCheck}
        onChange={commitChange}
        onHistory={runHistory}
        historyReplayToken={replayToken}
      />
    </div>
  );
}

function installNativeTextareaExecCommandMock() {
  const originalExecCommand = Object.getOwnPropertyDescriptor(document, "execCommand");
  type StackItem = { before: string; after: string; beforeSel: [number, number]; afterSel: [number, number] };
  const stacks = new WeakMap<HTMLTextAreaElement, { undo: StackItem[]; redo: StackItem[] }>();
  const getStack = (area: HTMLTextAreaElement) => {
    let stack = stacks.get(area);
    if (!stack) {
      stack = { undo: [], redo: [] };
      stacks.set(area, stack);
    }
    return stack;
  };
  const setNativeValue = (area: HTMLTextAreaElement, next: string, selStart: number, selEnd: number, inputType: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(area, next);
    area.setSelectionRange(selStart, selEnd);
    area.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType }));
    area.dispatchEvent(new InputEvent("input", { bubbles: true, inputType }));
  };
  const execCommandMock = vi.fn((command: string, _ui?: boolean, value = "") => {
    const active = document.activeElement;
    if (!(active instanceof HTMLTextAreaElement)) return false;
    const stack = getStack(active);
    if (command === "insertText" || command === "delete") {
      const from = active.selectionStart;
      const to = active.selectionEnd;
      const inserted = command === "insertText" ? value : "";
      const before = active.value;
      const after = before.slice(0, from) + inserted + before.slice(to);
      if (after === before) return false;
      const afterPos = from + inserted.length;
      stack.undo.push({ before, after, beforeSel: [from, to], afterSel: [afterPos, afterPos] });
      stack.redo = [];
      setNativeValue(active, after, afterPos, afterPos, command === "insertText" ? "insertText" : "deleteContentBackward");
      return true;
    }
    if (command === "undo") {
      const step = stack.undo.pop();
      if (!step) return false;
      stack.redo.push(step);
      setNativeValue(active, step.before, step.beforeSel[0], step.beforeSel[1], "historyUndo");
      return true;
    }
    if (command === "redo") {
      const step = stack.redo.pop();
      if (!step) return false;
      stack.undo.push(step);
      setNativeValue(active, step.after, step.afterSel[0], step.afterSel[1], "historyRedo");
      return true;
    }
    return false;
  });
  Object.defineProperty(document, "execCommand", { configurable: true, writable: true, value: execCommandMock });
  execCommandCleanups.push(() => {
    if (originalExecCommand) Object.defineProperty(document, "execCommand", originalExecCommand);
    else delete (document as { execCommand?: unknown }).execCommand;
  });
  return { execCommandMock };
}

it("undoes inside one Live block via native textarea undo and redoes after leaving that block, and crosses block boundaries", async () => {
  installNativeTextareaExecCommandMock();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const historyRef: { current: NoteHistory } = { current: { undo: [], redo: [], last: 0 } };
  const triggerRef: { current: (direction: "undo" | "redo") => void } = { current: () => {} };
  let currentDoc = "First paragraph\n\nSecond paragraph";

  await act(async () => {
    root.render(
      <HistoryBackedLiveEditor
        initial={currentDoc}
        historyRef={historyRef}
        triggerRef={triggerRef}
        onDocChange={(next) => {
          currentDoc = next;
        }}
      />,
    );
  });

  // 1. Open Block 1, type via native execCommand, undo INSIDE Block 1, then leave Block 1 and redo!
  act(() => {
    host.querySelectorAll<HTMLElement>(".live-block")[0].dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  });
  const block1Area = host.querySelector<HTMLTextAreaElement>("textarea")!;
  block1Area.focus();
  block1Area.setSelectionRange(block1Area.value.length, block1Area.value.length);
  act(() => {
    document.execCommand("insertText", false, " refined");
  });
  expect(block1Area.value).toBe("First paragraph refined");
  expect(currentDoc).toBe("First paragraph refined\n\nSecond paragraph");

  // Undo inside Block 1 via Ctrl+Z while textarea remains open and focused.
  act(() => {
    block1Area.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true }));
  });
  expect(host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("First paragraph");
  expect(currentDoc).toBe("First paragraph\n\nSecond paragraph");

  // Leave Block 1 with Escape, then Redo from document history!
  act(() => {
    block1Area.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });
  expect(host.querySelector("textarea")).toBeNull();
  act(() => {
    triggerRef.current("redo");
  });
  expect(host.querySelector("textarea")).toBeNull();
  expect(currentDoc).toBe("First paragraph refined\n\nSecond paragraph");
  expect(host.textContent).toContain("First paragraph refined");

  // 2. Cross block boundaries: open Block 2, edit Block 2, then Undo twice (Block 2 -> Block 1) and Redo twice!
  act(() => {
    host.querySelectorAll<HTMLElement>(".live-block")[1].dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  });
  const block2Area = host.querySelector<HTMLTextAreaElement>("textarea")!;
  block2Area.focus();
  block2Area.setSelectionRange(block2Area.value.length, block2Area.value.length);
  act(() => {
    document.execCommand("insertText", false, " updated");
  });
  expect(block2Area.value).toBe("Second paragraph updated");
  expect(currentDoc).toBe("First paragraph refined\n\nSecond paragraph updated");

  // First Ctrl+Z inside Block 2 undoes Block 2's native textarea edit.
  act(() => {
    block2Area.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true }));
  });
  expect(host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("Second paragraph");
  expect(currentDoc).toBe("First paragraph refined\n\nSecond paragraph");

  // Second Ctrl+Z while still in Block 2's exhausted textarea crosses into Block 1!
  act(() => {
    host.querySelector<HTMLTextAreaElement>("textarea")!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true }),
    );
  });
  expect(currentDoc).toBe("First paragraph\n\nSecond paragraph");
  const reanchoredBlock1 = host.querySelector<HTMLTextAreaElement>("textarea")!;
  expect(reanchoredBlock1.value).toBe("First paragraph");
  expect(document.activeElement).toBe(reanchoredBlock1);

  // Redo twice crosses forward from Block 1 back into Block 2!
  act(() => {
    reanchoredBlock1.dispatchEvent(new KeyboardEvent("keydown", { key: "y", ctrlKey: true, bubbles: true, cancelable: true }));
  });
  expect(currentDoc).toBe("First paragraph refined\n\nSecond paragraph");
  expect(host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("First paragraph refined");

  act(() => {
    host.querySelector<HTMLTextAreaElement>("textarea")!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "z", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }),
    );
  });
  expect(currentDoc).toBe("First paragraph refined\n\nSecond paragraph updated");
  expect(host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("Second paragraph updated");

  act(() => root.unmount());
  host.remove();
});

it("handles Tab and Shift+Tab through the active LiveEditor path across ordered lists, quotes, and multi-line selections", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let doc = [
    "1. First step\n2. Second step\n\n   - [x] Nested task",
    "> 1. Quoted parent\n> - Quoted child A\n>   - Quoted child B",
    "> [!note]\n> Quoted prose",
    "10. Ten\n11. Eleven",
  ].join("\n\n");
  const renderDoc = () =>
    root.render(
      <LiveEditor
        markdown={doc}
        documentPath={null}
        dark={false}
        python=""
        onChange={(next) => {
          doc = next;
          renderDoc();
        }}
      />,
    );
  await act(async () => { renderDoc(); });

  // 1. Ordered list single-line Tab, nested cap, Shift+Tab outdent, and loose multi-line selection
  act(() => host.querySelectorAll<HTMLElement>(".live-block")[0]!.querySelector("li")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  let area = host.querySelector<HTMLTextAreaElement>("textarea")!;
  area.focus();
  const secondCaret = area.value.indexOf("Second") + 3;
  area.setSelectionRange(secondCaret, secondCaret);

  const ordTab1 = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
  act(() => { area.dispatchEvent(ordTab1); });
  expect(ordTab1.defaultPrevented).toBe(true);
  expect(area.value).toBe("1. First step\n   2. Second step\n\n   - [x] Nested task");
  expect([area.selectionStart, area.selectionEnd]).toEqual([secondCaret + 3, secondCaret + 3]);
  expect(document.activeElement).toBe(area);

  const ordTabCap = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
  act(() => { area.dispatchEvent(ordTabCap); });
  expect(ordTabCap.defaultPrevented).toBe(true);
  expect(area.value).toBe("1. First step\n   2. Second step\n\n   - [x] Nested task");
  expect(document.activeElement).toBe(area);

  const ordShiftTab = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
  act(() => { area.dispatchEvent(ordShiftTab); });
  expect(ordShiftTab.defaultPrevented).toBe(true);
  expect(area.value).toBe("1. First step\n2. Second step\n\n   - [x] Nested task");
  expect([area.selectionStart, area.selectionEnd]).toEqual([secondCaret, secondCaret]);

  // Multi-line selection across ordered sibling + blank line + nested task item
  const multiFrom = area.value.indexOf("2. Second step");
  area.setSelectionRange(multiFrom, area.value.length);
  act(() => { area.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })); });
  expect(area.value).toBe("1. First step\n   2. Second step\n\n      - [x] Nested task");
  expect([area.selectionStart, area.selectionEnd]).toEqual([multiFrom, area.value.length]);
  expect(document.activeElement).toBe(area);

  act(() => { area.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true })); });
  expect(area.value).toBe("1. First step\n2. Second step\n\n   - [x] Nested task");
  expect([area.selectionStart, area.selectionEnd]).toEqual([multiFrom, area.value.length]);
  act(() => { area.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });

  // 2. Quoted list single-line & multi-line Tab/Shift+Tab (preserving `> ` prefix)
  act(() => host.querySelectorAll<HTMLElement>(".live-block")[1]!.querySelector("li")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  area = host.querySelector<HTMLTextAreaElement>("textarea")!;
  area.focus();
  const quotedChildCaret = area.value.indexOf("Quoted child A");
  area.setSelectionRange(quotedChildCaret, quotedChildCaret);
  act(() => { area.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })); });
  expect(area.value).toBe("> 1. Quoted parent\n>    - Quoted child A\n>   - Quoted child B");
  expect(area.selectionStart).toBe(quotedChildCaret + 3);
  expect(document.activeElement).toBe(area);

  act(() => { area.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true })); });
  expect(area.value).toBe("> 1. Quoted parent\n> - Quoted child A\n>   - Quoted child B");
  expect(area.selectionStart).toBe(quotedChildCaret);

  // Multi-line selection across quoted list items
  const quotedMultiStart = area.value.indexOf("> - Quoted child A");
  area.setSelectionRange(quotedMultiStart, area.value.length);
  act(() => { area.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })); });
  expect(area.value).toBe("> 1. Quoted parent\n>    - Quoted child A\n>      - Quoted child B");
  expect([area.selectionStart, area.selectionEnd]).toEqual([quotedMultiStart, area.value.length]);

  act(() => { area.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true })); });
  expect(area.value).toBe("> 1. Quoted parent\n> - Quoted child A\n>   - Quoted child B");
  expect([area.selectionStart, area.selectionEnd]).toEqual([quotedMultiStart, area.value.length]);
  act(() => { area.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });

  // 3. Plain blockquote / callout prose Tab & Shift+Tab without stripping `> `
  act(() => host.querySelectorAll<HTMLElement>(".live-block")[2]!.querySelector("p")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  area = host.querySelector<HTMLTextAreaElement>("textarea")!;
  area.focus();
  const proseCaret = area.value.indexOf("Quoted prose");
  area.setSelectionRange(proseCaret, proseCaret);
  act(() => { area.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })); });
  expect(area.value).toBe("> [!note]\n>   Quoted prose");
  expect(area.selectionStart).toBe(proseCaret + 2);
  act(() => { area.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true })); });
  expect(area.value).toBe("> [!note]\n> Quoted prose");
  act(() => { area.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true })); });
  expect(area.value).toBe("> [!note]\n> Quoted prose");
  expect(document.activeElement).toBe(area);
  act(() => { area.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });

  // 4. Double-digit ordered list (`10. Ten\n11. Eleven`) aligns nested item at 4 spaces
  act(() => host.querySelectorAll<HTMLElement>(".live-block")[3]!.querySelector("li")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  area = host.querySelector<HTMLTextAreaElement>("textarea")!;
  area.focus();
  const elevenCaret = area.value.indexOf("Eleven");
  area.setSelectionRange(elevenCaret, elevenCaret);
  act(() => { area.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })); });
  expect(area.value).toBe("10. Ten\n    11. Eleven");
  expect(area.selectionStart).toBe(elevenCaret + 4);
  act(() => { area.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true })); });
  expect(area.value).toBe("10. Ten\n11. Eleven");
  expect(area.selectionStart).toBe(elevenCaret);

  act(() => root.unmount());
  host.remove();
});

it("retains LiveEditor focus across WritingSuggestions replacement, dismissal, personal dictionary save, and single-step undo", async () => {
  vi.useFakeTimers();
  window.localStorage.removeItem("supermd.personal-dictionary.v1");
  const checkSpy = vi.spyOn(proofreading, "checkWriting").mockImplementation(async (slice) => {
    const out: proofreading.WritingIssue[] = [];
    const tehIdx = slice.indexOf("teh");
    if (tehIdx !== -1) {
      out.push({ from: tehIdx, to: tehIdx + 3, kind: "spelling", message: "Possible spelling error: teh", replacements: ["right"] });
    }
    const tokenIdx = slice.indexOf("customtoken");
    if (tokenIdx !== -1) {
      out.push({ from: tokenIdx, to: tokenIdx + 11, kind: "spelling", message: "Possible spelling error: customtoken", replacements: [] });
    }
    const extraIdx = slice.indexOf("anoter");
    if (extraIdx !== -1) {
      out.push({ from: extraIdx, to: extraIdx + 6, kind: "spelling", message: "Possible spelling error: anoter", replacements: ["another"] });
    }
    return out;
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let currentDoc = "teh customtoken and anoter word here.";
  const renderLive = () =>
    root.render(
      <LiveEditor
        markdown={currentDoc}
        documentPath={null}
        dark={false}
        python=""
        spellCheck
        grammarCheck
        onChange={(next) => {
          currentDoc = next;
          renderLive();
        }}
      />,
    );

  try {
    await act(async () => { renderLive(); });
    act(() => host.querySelector("p")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    const area = host.querySelector<HTMLTextAreaElement>("textarea")!;
    area.focus();
    const initialCaret = currentDoc.indexOf("word");
    area.setSelectionRange(initialCaret, initialCaret);
    act(() => { area.dispatchEvent(new Event("select", { bubbles: true })); });

    await act(async () => { await vi.advanceTimersByTimeAsync(650); });
    const panel = host.querySelector(".writing-suggestions");
    expect(panel).not.toBeNull();

    // Accept length-changing "right" replacement for "teh" (+2 chars) and verify caret shifts by +2
    const rightBtn = Array.from(panel!.querySelectorAll("button")).find((btn) => btn.textContent === "right");
    expect(rightBtn).toBeDefined();
    await act(async () => { rightBtn!.click(); });
    expect(area.value).toBe("right customtoken and anoter word here.");
    expect(document.activeElement).toBe(area);
    expect(area.selectionStart).toBe(initialCaret + 2);

    // Single-step Ctrl+Z reverts the accepted suggestion and restores original caret
    act(() => { area.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true })); });
    expect(area.value).toBe("teh customtoken and anoter word here.");
    expect(area.selectionStart).toBe(initialCaret);
    expect(document.activeElement).toBe(area);

    await act(async () => { await vi.advanceTimersByTimeAsync(650); });
    const refreshed = host.querySelector(".writing-suggestions")!;
    expect(refreshed).not.toBeNull();

    // Add "customtoken" to personal dictionary while keeping textarea open & focused
    const dictBtn = Array.from(refreshed.querySelectorAll<HTMLButtonElement>("button")).find((btn) =>
      btn.title.includes("customtoken"),
    );
    expect(dictBtn).toBeDefined();
    await act(async () => { dictBtn!.click(); });
    expect(document.activeElement).toBe(area);
    expect(host.querySelector("textarea")).toBe(area);
    expect(JSON.parse(window.localStorage.getItem("supermd.personal-dictionary.v1") || "[]")).toContain("customtoken");

    // Dismiss a remaining suggestion while keeping textarea open & focused
    const dismissBtn = Array.from(host.querySelectorAll<HTMLButtonElement>(".writing-suggestions button")).find(
      (btn) => btn.textContent === "Dismiss",
    );
    expect(dismissBtn).toBeDefined();
    await act(async () => { dismissBtn!.click(); });
    expect(document.activeElement).toBe(area);
    expect(host.querySelector("textarea")).toBe(area);
  } finally {
    checkSpy.mockRestore();
    act(() => root.unmount());
    host.remove();
    window.localStorage.removeItem("supermd.personal-dictionary.v1");
    vi.useRealTimers();
  }
});

it("combines accessible Edit block controls with prose URL wrapping, raw paste in code/frontmatter, and editing the existing selection", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let doc = [
    "Read the manual or run `old_cmd` today.",
    "",
    "```python",
    'endpoint = "old_host"',
    "```",
  ].join("\n");
  const renderDoc = () =>
    root.render(
      <LiveEditor
        markdown={doc}
        documentPath={null}
        dark={false}
        python=""
        onChange={(next) => {
          doc = next;
          renderDoc();
        }}
      />,
    );
  await act(async () => { renderDoc(); });

  const dispatchPaste = (area: HTMLTextAreaElement, text: string) => {
    const pasteEvent = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, "clipboardData", {
      value: {
        files: [],
        getData: (type: string) => (type === "text/plain" ? text : ""),
      },
    });
    area.dispatchEvent(pasteEvent);
  };

  // 1. Open first block via #62's accessible "Edit block" button on focus.
  const firstBlock = host.querySelectorAll<HTMLElement>(".live-block")[0]!;
  act(() => firstBlock.focus());
  const editBtn = firstBlock.querySelector<HTMLButtonElement>('button[aria-label="Edit block"]');
  expect(editBtn).not.toBeNull();
  act(() => editBtn!.click());
  let area = host.querySelector<HTMLTextAreaElement>("textarea")!;
  expect(area.value).toBe("Read the manual or run `old_cmd` today.");

  // Formatted paste over prose selection "manual" -> [manual](https://example.com/manual)
  const manualStart = area.value.indexOf("manual");
  act(() => {
    area.focus();
    area.setSelectionRange(manualStart, manualStart + 6);
    dispatchPaste(area, "https://example.com/manual");
  });
  expect(area.value).toBe("Read the [manual](https://example.com/manual) or run `old_cmd` today.");

  // Edit the existing selection: select full [manual](https://example.com/manual), unwrap with Ctrl+K,
  // then bold the preserved "manual" selection with Ctrl+B, and replace it.
  const linkSpanStart = area.value.indexOf("[manual]");
  const linkSpanEnd = linkSpanStart + "[manual](https://example.com/manual)".length;
  act(() => {
    area.setSelectionRange(linkSpanStart, linkSpanEnd);
    area.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true }));
  });
  expect(area.value).toBe("Read the manual or run `old_cmd` today.");
  expect([area.selectionStart, area.selectionEnd]).toEqual([manualStart, manualStart + 6]);

  act(() => {
    area.dispatchEvent(new KeyboardEvent("keydown", { key: "b", ctrlKey: true, bubbles: true, cancelable: true }));
  });
  expect(area.value).toBe("Read the **manual** or run `old_cmd` today.");
  expect([area.selectionStart, area.selectionEnd]).toEqual([manualStart + 2, manualStart + 8]);

  // Raw paste over inline code selection `old_cmd` -> replaces with raw URL (not [old_cmd](url))
  const cmdStart = area.value.indexOf("old_cmd");
  act(() => {
    area.setSelectionRange(cmdStart, cmdStart + "old_cmd".length);
    dispatchPaste(area, "https://cli.example.com");
  });
  expect(area.value).toBe("Read the **manual** or run `https://cli.example.com` today.");
  act(() => {
    area.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });
  expect(host.querySelector("textarea")).toBeNull();

  // 2. Open fenced code block via #62's accessible "Edit block" button on hover and raw-paste over "old_host".
  const codeBlock = host.querySelectorAll<HTMLElement>(".live-block")[1]!;
  act(() => {
    codeBlock.dispatchEvent(pointerEvent("pointerover", { bubbles: true, pointerType: "mouse", buttons: 0 }));
    codeBlock.dispatchEvent(pointerEvent("pointermove", { bubbles: true, pointerType: "mouse", buttons: 0 }));
  });
  const codeEditBtn = codeBlock.querySelector<HTMLButtonElement>('button[aria-label="Edit block"]');
  expect(codeEditBtn).not.toBeNull();
  act(() => codeEditBtn!.click());
  area = host.querySelector<HTMLTextAreaElement>("textarea")!;
  const hostStart = area.value.indexOf("old_host");
  act(() => {
    area.focus();
    area.setSelectionRange(hostStart, hostStart + "old_host".length);
    dispatchPaste(area, "https://api.example.com/v2");
  });
  expect(area.value).toContain('endpoint = "https://api.example.com/v2"');
  expect(area.value).not.toContain("[old_host]");

  // Single-step Undo restores "old_host" AND its [hostStart, hostStart + 8] selection
  act(() => {
    area.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true }));
  });
  expect(area.value).toContain('endpoint = "old_host"');
  expect([area.selectionStart, area.selectionEnd]).toEqual([hostStart, hostStart + "old_host".length]);

  act(() => root.unmount());
  host.remove();
});

it("keeps WritingSuggestions replacements undoable and isolated both inside the active textarea and after leaving the block", async () => {
  vi.useFakeTimers();
  const originalWorker = globalThis.Worker;
  class MockProofreadingWorker {
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    postMessage(data: { id: number; text: string }) {
      const idx = data.text.indexOf("teh");
      const issues =
        idx === -1
          ? []
          : [
              {
                from: idx,
                to: idx + 3,
                kind: "spelling",
                message: "Possible spelling error: teh",
                replacements: ["the"],
              },
            ];
      queueMicrotask(() => {
        this.onmessage?.({ data: { id: data.id, issues } } as MessageEvent);
      });
    }
    terminate() {}
  }
  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    writable: true,
    value: MockProofreadingWorker,
  });
  try {
    installNativeTextareaExecCommandMock();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const historyRef: { current: NoteHistory } = { current: { undo: [], redo: [], last: 0 } };
    const triggerRef: { current: (direction: "undo" | "redo") => void } = { current: () => {} };
    let currentDoc = "Fix teh typo";

    await act(async () => {
      root.render(
        <HistoryBackedLiveEditor
          initial={currentDoc}
          spellCheck
          grammarCheck
          historyRef={historyRef}
          triggerRef={triggerRef}
          onDocChange={(next) => {
            currentDoc = next;
          }}
        />,
      );
    });

    act(() => {
      host.querySelector<HTMLElement>(".live-block")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    const area = host.querySelector<HTMLTextAreaElement>("textarea")!;
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);

    // Type a single character so we also verify a same-length "teh" -> "the" suggestion does not coalesce into it.
    act(() => {
      document.execCommand("insertText", false, ".");
    });
    expect(area.value).toBe("Fix teh typo.");

    // Advance timers so WritingSuggestions finishes checking "Fix teh typo." and offers "the".
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });
    const theButton = [...host.querySelectorAll<HTMLButtonElement>(".writing-suggestions button")].find(
      (btn) => btn.textContent === "the",
    );
    expect(theButton).toBeDefined();

    // Accept the "the" suggestion while focused in the textarea.
    act(() => {
      theButton!.click();
    });
    expect(area.value).toBe("Fix the typo.");
    expect(currentDoc).toBe("Fix the typo.");
    expect(document.activeElement).toBe(area);

    // Immediate Ctrl+Z inside the textarea reverts ONLY the accepted suggestion ("the" -> "teh"), keeping "." intact!
    act(() => {
      area.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true }));
    });
    expect(area.value).toBe("Fix teh typo.");
    expect(currentDoc).toBe("Fix teh typo.");

    // Leave the block with Escape, then Redo restores "Fix the typo.", and two Undos step cleanly through suggestion then "."!
    act(() => {
      area.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(host.querySelector("textarea")).toBeNull();

    act(() => {
      triggerRef.current("redo");
    });
    expect(currentDoc).toBe("Fix the typo.");

    act(() => {
      triggerRef.current("undo");
    });
    expect(currentDoc).toBe("Fix teh typo.");

    act(() => {
      triggerRef.current("undo");
    });
    expect(currentDoc).toBe("Fix teh typo");

    act(() => root.unmount());
    host.remove();
    await vi.advanceTimersByTimeAsync(50_000);
  } finally {
    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      writable: true,
      value: originalWorker,
    });
    vi.useRealTimers();
  }
});

it("keeps the active textarea mounted, focused, and undo/redo reconciled inside React StrictMode across Edit block and double-click", async () => {
  installNativeTextareaExecCommandMock();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const historyRef: { current: NoteHistory } = { current: { undo: [], redo: [], last: 0 } };
  const triggerRef: { current: (direction: "undo" | "redo") => void } = { current: () => {} };
  let currentDoc = "# First heading\n\nSecond paragraph";
  const removedTextareas: HTMLTextAreaElement[] = [];
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.removedNodes) {
        if (node instanceof HTMLTextAreaElement) removedTextareas.push(node);
      }
    }
  });
  observer.observe(host, { childList: true, subtree: true });

  await act(async () => {
    root.render(
      <StrictMode>
        <div className="reading-scroll">
          <HistoryBackedLiveEditor
            initial={currentDoc}
            historyRef={historyRef}
            triggerRef={triggerRef}
            onDocChange={(next) => {
              currentDoc = next;
            }}
          />
        </div>
      </StrictMode>,
    );
  });

  // 1. Open first block via revealed "Edit block" button inside StrictMode.
  const firstBlock = host.querySelectorAll<HTMLElement>(".live-block")[0]!;
  act(() => {
    firstBlock.focus();
  });
  const editButton = firstBlock.querySelector<HTMLButtonElement>('button[aria-label="Edit block"]')!;
  expect(editButton).not.toBeNull();
  act(() => {
    editButton.click();
  });
  const firstTextarea = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Edit Markdown block"]');
  expect(firstTextarea).not.toBeNull();
  expect(document.activeElement).toBe(firstTextarea);
  expect(removedTextareas).toHaveLength(0);

  act(() => {
    firstTextarea!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });
  expect(host.querySelector("textarea")).toBeNull();

  // 2. Open second block via double-click with Typewriter scroll enabled inside StrictMode, edit, undo, exit, and redo.
  act(() => {
    setTypewriterScroll(true);
  });
  try {
    removedTextareas.length = 0;
    const secondBlock = host.querySelectorAll<HTMLElement>(".live-block")[1]!;
    act(() => {
      secondBlock.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    const secondTextarea = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Edit Markdown block"]')!;
    expect(secondTextarea).not.toBeNull();
    expect(document.activeElement).toBe(secondTextarea);
    expect(removedTextareas).toHaveLength(0);

    act(() => {
      secondTextarea.setSelectionRange(secondTextarea.value.length, secondTextarea.value.length);
      document.execCommand("insertText", false, " updated");
    });
    expect(currentDoc).toBe("# First heading\n\nSecond paragraph updated");

    act(() => {
      secondTextarea.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true }));
    });
    expect(currentDoc).toBe("# First heading\n\nSecond paragraph");

    act(() => {
      secondTextarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(host.querySelector("textarea")).toBeNull();

    act(() => {
      triggerRef.current("redo");
    });
    expect(currentDoc).toBe("# First heading\n\nSecond paragraph updated");
  } finally {
    act(() => {
      setTypewriterScroll(false);
    });
    observer.disconnect();
    act(() => root.unmount());
    host.remove();
  }
});

it("toggles only the clicked nested task checkbox and keeps slider-containing tasks checked in LiveEditor", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);

  const chartSpec = JSON.stringify({
    series: [{ expression: "k * x" }],
    sliders: [{ name: "k", label: "Slope", min: 1, max: 5, step: 1, value: 2 }],
  });

  let markdown = [
    "# Study Session",
    "",
    "- [x] Review unit",
    "  - [ ] Complete nested exercise",
    "  - [x] Verify slider response",
    "",
    "    ```smd-chart",
    `    ${chartSpec}`,
    "    ```",
  ].join("\n");

  const renderLive = () =>
    root.render(
      <LiveEditor
        markdown={markdown}
        documentPath="/notes/live-tasks.md"
        python=""
        dark={false}
        onChange={(next) => {
          markdown = next;
          renderLive();
        }}
      />,
    );

  await act(async () => { renderLive(); });

  // Open the heading block and expand its draft so source offsets shift downstream,
  // then change the study slider inside the checked nested task.
  await act(async () => {
    host.querySelector("h1")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  });
  const area = host.querySelector<HTMLTextAreaElement>("textarea")!;
  const updatedHeading = "# Study Session — Week 4";
  await act(async () => { typeInTextarea(area, updatedHeading); });

  const slider = host.querySelector<HTMLInputElement>('.chart-controls input[type="range"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(slider, "4");
    slider.dispatchEvent(new Event("input", { bubbles: true }));
    slider.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(host.querySelector(".chart-slider-head output")?.textContent).toBe("4");
  expect(markdown).toContain(updatedHeading);
  expect(markdown).toContain("  - [x] Verify slider response");

  // Click the unchecked nested checkbox while the heading draft is still open:
  // only "Complete nested exercise" flips to [x], keeping "Review unit" [x] and preserving the heading draft.
  const checkboxes = host.querySelectorAll<HTMLInputElement>('input[type="checkbox"][data-task-checkbox]');
  expect(checkboxes).toHaveLength(3);
  await act(async () => {
    checkboxes[1].click();
  });
  expect(host.querySelector("textarea")).toBeNull();
  expect(markdown).toContain(updatedHeading);
  expect(markdown).toContain("- [x] Review unit\n  - [x] Complete nested exercise\n  - [x] Verify slider response");

  await act(async () => root.unmount());
  host.remove();
});

it("preserves the clicked rendered text caret on double-click across inline emphasis, links, code, math, lists, and callouts while keeping keyboard entry and protected blocks intact", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);

  const proseBlock = [
    "Review *italic* and **bold** plus [reference guide](https://example.com/docs?mode=live) with `npm test`, $x^2 + 1$, ==key==, %%note comment%%<!-- html comment --> ![diagram](diagram.png){width=240} and \\*literal\\* above",
    "then inspect the target phrase below.",
  ].join("\n");
  const listBlock = [
    "- [x] Ship *core* parser",
    "- [ ] Verify [live caret](https://example.com/list) on the second item",
  ].join("\n");
  const calloutBlock = [
    "> [!note] Custom *callout* heading",
    "> First quoted line with [spec](https://example.com/spec)",
    "> Second quoted target line.",
  ].join("\n");
  const defaultCalloutBlock = [
    "> [!tip]",
    "> Synthesized title body target.",
  ].join("\n");
  const tableBlock = [
    "| Feature | Notes |",
    "| --- | --- |",
    "| [[Project Plan|Roadmap]] | Table cell target entry |",
  ].join("\n");
  const codeBlock = [
    "```ts",
    "- keep literal code behavior",
    "```",
  ].join("\n");

  let doc = [proseBlock, listBlock, calloutBlock, defaultCalloutBlock, tableBlock, codeBlock].join("\n\n");
  const renderDoc = () =>
    root.render(
      <LiveEditor
        markdown={doc}
        documentPath={null}
        dark={false}
        python=""
        onChange={(next) => {
          doc = next;
          renderDoc();
        }}
      />,
    );
  await act(async () => { renderDoc(); });

  let mockedHit: { offsetNode: Node; offset: number } | null = null;
  const caretSpy = vi.fn(() => mockedHit);
  Object.defineProperty(document, "caretPositionFromPoint", {
    configurable: true,
    writable: true,
    value: caretSpy,
  });

  const findTextHit = (rootEl: Element, needle: string, innerOffset = 0): { offsetNode: Text; offset: number } => {
    const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (parent?.closest(".katex-mathml")) continue;
      const textNode = node as Text;
      const at = textNode.data.indexOf(needle);
      if (at >= 0) return { offsetNode: textNode, offset: at + innerOffset };
    }
    throw new Error(`Text "${needle}" not found inside ${rootEl.tagName}`);
  };

  const dblClickAt = (blockIndex: number, needle: string, innerOffset = 0) => {
    const blockEl = host.querySelectorAll<HTMLElement>(".live-block")[blockIndex]!;
    const hit = findTextHit(blockEl, needle, innerOffset);
    mockedHit = hit;
    act(() => {
      (hit.offsetNode.parentElement ?? blockEl).dispatchEvent(
        new MouseEvent("dblclick", { bubbles: true, cancelable: true, detail: 2, clientX: 160, clientY: 120 }),
      );
    });
    return host.querySelector<HTMLTextAreaElement>("textarea")!;
  };

  try {
    // 1. Double-clicking "target" on line 2 below emphasis, strong, link, inline code, inline math, highlight, and escapes:
    let area = dblClickAt(0, "target", 0);
    expect(area.value).toBe(proseBlock);
    expect([area.selectionStart, area.selectionEnd]).toEqual([
      proseBlock.indexOf("target"),
      proseBlock.indexOf("target"),
    ]);
    act(() => { area.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });

    // 2. Double-clicking mid-word inside *italic* ("ita|lic") places collapsed caret inside the emphasis content:
    area = dblClickAt(0, "italic", 3);
    expect([area.selectionStart, area.selectionEnd]).toEqual([
      proseBlock.indexOf("italic") + 3,
      proseBlock.indexOf("italic") + 3,
    ]);
    act(() => { area.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });

    // 3. Double-clicking inside inline code `npm test` ("npm |test") places collapsed caret at "test":
    area = dblClickAt(0, "npm test", 4);
    expect([area.selectionStart, area.selectionEnd]).toEqual([
      proseBlock.indexOf("npm test") + 4,
      proseBlock.indexOf("npm test") + 4,
    ]);
    act(() => { area.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });

    // 4. Double-clicking downstream task item while upstream block is actively edited with changed length:
    area = dblClickAt(0, "target", 0);
    const expandedProse = proseBlock + " — expanded while active with extra characters";
    await act(async () => { typeInTextarea(area, expandedProse); });
    area = dblClickAt(1, "second item", 0);
    expect(area.value).toBe(listBlock);
    expect([area.selectionStart, area.selectionEnd]).toEqual([
      listBlock.indexOf("second item"),
      listBlock.indexOf("second item"),
    ]);
    act(() => { area.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });

    // 5. Custom-titled callout and default-titled callout map lower body lines accurately:
    area = dblClickAt(2, "target line", 0);
    expect(area.value).toBe(calloutBlock);
    expect([area.selectionStart, area.selectionEnd]).toEqual([
      calloutBlock.indexOf("target line"),
      calloutBlock.indexOf("target line"),
    ]);
    act(() => { area.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });

    area = dblClickAt(3, "target.", 0);
    expect(area.value).toBe(defaultCalloutBlock);
    expect([area.selectionStart, area.selectionEnd]).toEqual([
      defaultCalloutBlock.indexOf("target."),
      defaultCalloutBlock.indexOf("target."),
    ]);
    act(() => { area.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });

    // 5b. GFM table cell after a wikilink column maps accurately:
    area = dblClickAt(4, "target entry", 0);
    expect(area.value).toBe(tableBlock);
    expect([area.selectionStart, area.selectionEnd]).toEqual([
      tableBlock.indexOf("target entry"),
      tableBlock.indexOf("target entry"),
    ]);
    act(() => { area.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });

    // 6. Keyboard edit entry (Enter and F2) does not query click caret coordinates:
    caretSpy.mockClear();
    const focusedBlock = host.querySelectorAll<HTMLElement>(".live-block")[4]!;
    expect(document.activeElement).toBe(focusedBlock);
    act(() => { focusedBlock.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
    area = host.querySelector<HTMLTextAreaElement>("textarea")!;
    expect(area.value).toBe(tableBlock);
    expect(area.selectionStart).toBe(area.selectionEnd);
    expect(caretSpy).not.toHaveBeenCalled();
    act(() => { area.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });

    act(() => { focusedBlock.dispatchEvent(new KeyboardEvent("keydown", { key: "F2", bubbles: true, cancelable: true })); });
    area = host.querySelector<HTMLTextAreaElement>("textarea")!;
    expect(area.value).toBe(tableBlock);
    expect(area.selectionStart).toBe(area.selectionEnd);
    expect(caretSpy).not.toHaveBeenCalled();
    act(() => { area.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });

    // 7. Protected fenced code block skips prose click caret lookup and preserves literal Enter:
    caretSpy.mockClear();
    const protectedEl = host.querySelectorAll<HTMLElement>(".live-block")[5]!;
    act(() => {
      protectedEl.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, detail: 2, clientX: 160, clientY: 300 }));
    });
    area = host.querySelector<HTMLTextAreaElement>("textarea")!;
    expect(area.value).toBe(codeBlock);
    expect(area.selectionStart).toBe(area.selectionEnd);
    expect(caretSpy).not.toHaveBeenCalled();
    area.setSelectionRange(area.value.indexOf("behavior") + 8, area.value.indexOf("behavior") + 8);
    const codeEnter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    act(() => { area.dispatchEvent(codeEnter); });
    expect(codeEnter.defaultPrevented).toBe(false);
  } finally {
    delete (document as Partial<Document>).caretPositionFromPoint;
    act(() => root.unmount());
    host.remove();
  }
});

it("formats rendered Live selections across nested lists, existing formatting, inline code/math unwraps, upstream draft shifts, backward directional selections, and single-step undo while guarding protected code and multi-paragraph selections", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const historyRef: { current: NoteHistory } = { current: { undo: [], redo: [], last: 0 } };
  const triggerRef: { current: (direction: "undo" | "redo") => void } = { current: () => {} };
  let doc = [
    "---",
    "title: Rendered Selection Formatting",
    "---",
    "",
    "Intro block.",
    "",
    "Study **Fourier** [docs](https://example.com), `cmd_flag`, $x + 1$, and selected rendered range with backward target.",
    "",
    "- Parent list target",
    "  - Nested child item target",
    "",
    "Trailing paragraph stays separate.",
    "",
    "```ts",
    "const protectedCode = 1;",
    "```",
  ].join("\n");

  await act(async () => {
    root.render(
      <HistoryBackedLiveEditor
        initial={doc}
        historyRef={historyRef}
        triggerRef={triggerRef}
        onDocChange={(next) => {
          doc = next;
        }}
      />,
    );
  });

  const selectRenderedSubstring = (container: Element, target: string, reversed = false) => {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    const entries: Array<{ node: Text; start: number; end: number }> = [];
    let full = "";
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if ((n as Text).parentElement?.closest(".katex-mathml")) continue;
      const start = full.length;
      full += (n as Text).data;
      entries.push({ node: n as Text, start, end: full.length });
    }
    const idx = full.indexOf(target);
    if (idx < 0) throw new Error(`Missing rendered substring "${target}" in "${full}"`);
    const endIdx = idx + target.length;
    const s = entries.find((e) => idx >= e.start && idx <= e.end)!;
    const t = entries.find((e) => endIdx >= e.start && endIdx <= e.end)!;
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    if (reversed && typeof sel.setBaseAndExtent === "function") {
      sel.setBaseAndExtent(t.node, endIdx - t.start, s.node, idx - s.start);
    } else {
      const r = document.createRange();
      r.setStart(s.node, idx - s.start);
      r.setEnd(t.node, endIdx - t.start);
      sel.addRange(r);
    }
  };

  // 0. Unselected Ctrl+B in rendered Live mode is NOT intercepted (leaves sidebar shortcut untouched)
  window.getSelection()?.removeAllRanges();
  const unselectedCtrlB = new KeyboardEvent("keydown", { key: "b", ctrlKey: true, bubbles: true, cancelable: true });
  act(() => {
    host.querySelector(".live-document")!.dispatchEvent(unselectedCtrlB);
  });
  expect(unselectedCtrlB.defaultPrevented).toBe(false);
  expect(host.querySelector("textarea")).toBeNull();

  // 1. Open block 0 ("Intro block.") and lengthen it so downstream rendered blocks have shifted document offsets
  let blocks = host.querySelectorAll<HTMLElement>(".live-block");
  act(() => blocks[0]!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  const introArea = host.querySelector<HTMLTextAreaElement>("textarea")!;
  await act(async () => {
    typeInTextarea(introArea, "Intro block with extra upstream draft text.");
  });
  expect(doc).toContain("Intro block with extra upstream draft text.");

  // 2. While block 0 is still open, select "selected rendered range" in rendered block 1 and press Ctrl+B
  const secondPara = blocks[1]!.querySelector("p")!;
  selectRenderedSubstring(secondPara, "selected rendered range");
  const ctrlB = new KeyboardEvent("keydown", { key: "b", ctrlKey: true, bubbles: true, cancelable: true });
  act(() => {
    secondPara.dispatchEvent(ctrlB);
  });
  expect(ctrlB.defaultPrevented).toBe(true);

  let area = host.querySelector<HTMLTextAreaElement>("textarea")!;
  expect(area.value).toBe(
    "Study **Fourier** [docs](https://example.com), `cmd_flag`, $x + 1$, and **selected rendered range** with backward target.",
  );
  const formattedSelStart = area.value.indexOf("selected rendered range");
  expect([area.selectionStart, area.selectionEnd, area.selectionDirection]).toEqual([
    formattedSelStart,
    formattedSelStart + "selected rendered range".length,
    "forward",
  ]);

  // Single-step Undo inside textarea restores exact pre-format block text and selection; Redo reapplies it
  act(() => {
    area.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true }));
  });
  expect(area.value).toBe(
    "Study **Fourier** [docs](https://example.com), `cmd_flag`, $x + 1$, and selected rendered range with backward target.",
  );
  const plainSelStart = area.value.indexOf("selected rendered range");
  expect([area.selectionStart, area.selectionEnd, area.selectionDirection]).toEqual([
    plainSelStart,
    plainSelStart + "selected rendered range".length,
    "forward",
  ]);
  act(() => {
    area.dispatchEvent(new KeyboardEvent("keydown", { key: "y", ctrlKey: true, bubbles: true, cancelable: true }));
  });
  expect(area.value).toContain("**selected rendered range**");
  act(() => {
    area.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true }));
    area.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });
  expect(host.querySelector("textarea")).toBeNull();

  // 3. Backward directional rendered selection preserves "backward" direction on open and on single-step Undo
  blocks = host.querySelectorAll<HTMLElement>(".live-block");
  selectRenderedSubstring(blocks[1]!.querySelector("p")!, "backward target", true);
  act(() => {
    window.dispatchEvent(new CustomEvent("supermd-format", { detail: { action: "italic" } }));
  });
  area = host.querySelector<HTMLTextAreaElement>("textarea")!;
  expect(area.value).toContain("*backward target*");
  const backStart = area.value.indexOf("backward target");
  expect([area.selectionStart, area.selectionEnd, area.selectionDirection]).toEqual([
    backStart,
    backStart + "backward target".length,
    "backward",
  ]);
  act(() => {
    area.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true }));
  });
  expect(area.value).not.toContain("*backward target*");
  expect([area.selectionStart, area.selectionEnd, area.selectionDirection]).toEqual([
    area.value.indexOf("backward target"),
    area.value.indexOf("backward target") + "backward target".length,
    "backward",
  ]);
  act(() => {
    area.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });

  // 4. Existing formatted text (`**Fourier**`) unwraps cleanly on `bold` and unwraps/restores via document-level undo after Escape
  blocks = host.querySelectorAll<HTMLElement>(".live-block");
  selectRenderedSubstring(blocks[1]!.querySelector("p")!, "Fourier");
  let didFormat = false;
  act(() => {
    didFormat = formatActiveLiveBlock("bold");
  });
  expect(didFormat).toBe(true);
  area = host.querySelector<HTMLTextAreaElement>("textarea")!;
  expect(area.value).toBe(
    "Study Fourier [docs](https://example.com), `cmd_flag`, $x + 1$, and selected rendered range with backward target.",
  );
  act(() => {
    area.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });
  act(() => {
    triggerRef.current("undo");
  });
  expect(doc).toContain("Study **Fourier** [docs]");

  // 5. Inline code & inline math: cross-actions (`bold`) are blocked without opening textarea, while matching actions (`inline_code` / `inline_math`) unwrap cleanly
  const snapshotBeforeGuards = doc;
  blocks = host.querySelectorAll<HTMLElement>(".live-block");
  const codeEl = blocks[1]!.querySelector("code")!;
  selectRenderedSubstring(codeEl, "cmd_flag");
  expect(formatActiveLiveBlock("bold")).toBe(false);
  expect(host.querySelector("textarea")).toBeNull();
  expect(doc).toBe(snapshotBeforeGuards);

  act(() => {
    didFormat = formatActiveLiveBlock("inline_code");
  });
  expect(didFormat).toBe(true);
  area = host.querySelector<HTMLTextAreaElement>("textarea")!;
  expect(area.value).toContain(", cmd_flag, $x + 1$,");
  act(() => {
    area.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true }));
    area.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });

  blocks = host.querySelectorAll<HTMLElement>(".live-block");
  const katexEl = blocks[1]!.querySelector(".katex")!;
  const mathRange = document.createRange();
  mathRange.selectNodeContents(katexEl);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(mathRange);
  expect(formatActiveLiveBlock("bold")).toBe(false);
  expect(host.querySelector("textarea")).toBeNull();
  act(() => {
    didFormat = formatActiveLiveBlock("inline_math");
  });
  expect(didFormat).toBe(true);
  area = host.querySelector<HTMLTextAreaElement>("textarea")!;
  expect(area.value).toContain("`cmd_flag`, x + 1, and");
  act(() => {
    area.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true }));
    area.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });

  // 6. Nested list items: formats parent li (excluding nested ul) and nested child li independently while rejecting cross-li selection
  blocks = host.querySelectorAll<HTMLElement>(".live-block");
  selectRenderedSubstring(blocks[2]!.querySelectorAll("li")[0]!, "Parent list");
  act(() => {
    didFormat = formatActiveLiveBlock("italic");
  });
  expect(didFormat).toBe(true);
  area = host.querySelector<HTMLTextAreaElement>("textarea")!;
  expect(area.value).toBe("- *Parent list* target\n  - Nested child item target");
  act(() => {
    area.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });

  blocks = host.querySelectorAll<HTMLElement>(".live-block");
  const listItems = blocks[2]!.querySelectorAll("li");
  selectRenderedSubstring(listItems[1]!, "child item");
  act(() => {
    didFormat = formatActiveLiveBlock("bold");
  });
  expect(didFormat).toBe(true);
  area = host.querySelector<HTMLTextAreaElement>("textarea")!;
  expect(area.value).toBe("- *Parent list* target\n  - Nested **child item** target");
  act(() => {
    area.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });

  blocks = host.querySelectorAll<HTMLElement>(".live-block");
  const refreshedItems = blocks[2]!.querySelectorAll("li");
  const crossLi = document.createRange();
  crossLi.setStart(refreshedItems[0]!.firstChild!, 0);
  crossLi.setEnd(refreshedItems[1]!.firstChild!, 4);
  sel.removeAllRanges();
  sel.addRange(crossLi);
  const afterNestedEdit = doc;
  expect(formatActiveLiveBlock("bold")).toBe(false);
  expect(host.querySelector("textarea")).toBeNull();
  expect(doc).toBe(afterNestedEdit);

  // 7. Protected fenced code block (<pre>) and multi-paragraph rendered selections are rejected without opening textarea
  const preEl = blocks[4]!.querySelector("pre")!;
  selectRenderedSubstring(preEl, "protectedCode");
  expect(formatActiveLiveBlock("bold")).toBe(false);
  expect(host.querySelector("textarea")).toBeNull();
  expect(doc).toBe(afterNestedEdit);

  const paras = host.querySelectorAll(".live-document p");
  const multiPara = document.createRange();
  multiPara.setStart(paras[1]!.firstChild!, 0);
  multiPara.setEnd(paras[2]!.firstChild!, 8);
  sel.removeAllRanges();
  sel.addRange(multiPara);
  expect(formatActiveLiveBlock("bold")).toBe(false);
  expect(host.querySelector("textarea")).toBeNull();
  expect(doc).toBe(afterNestedEdit);

  sel.removeAllRanges();
  act(() => root.unmount());
  host.remove();
});
