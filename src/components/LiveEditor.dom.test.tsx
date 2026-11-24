// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import Editor from "./Editor";
import LiveEditor from "./LiveEditor";
import { setTypewriterScroll } from "../typewriterScroll";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
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
