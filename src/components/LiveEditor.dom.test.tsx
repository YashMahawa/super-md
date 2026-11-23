// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import Editor from "./Editor";
import LiveEditor from "./LiveEditor";
import { setTypewriterScroll } from "../typewriterScroll";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
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

  // Open plain paragraph: Tab is NOT prevented so focus traversal across blocks stays intact
  act(() => host.querySelectorAll<HTMLElement>(".live-block")[2].dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  const paraArea = host.querySelector<HTMLTextAreaElement>("textarea")!;
  const paraTab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
  act(() => { paraArea.dispatchEvent(paraTab); });
  expect(paraTab.defaultPrevented).toBe(false);
  act(() => { paraArea.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });

  // Open protected code block: Enter and Tab remain literal (not prevented)
  act(() => host.querySelectorAll<HTMLElement>(".live-block")[3].dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  const codeArea = host.querySelector<HTMLTextAreaElement>("textarea")!;
  codeArea.setSelectionRange(codeArea.value.indexOf("code") + 4, codeArea.value.indexOf("code") + 4);
  const codeEnter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  const codeTab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
  act(() => { codeArea.dispatchEvent(codeEnter); codeArea.dispatchEvent(codeTab); });
  expect(codeEnter.defaultPrevented).toBe(false);
  expect(codeTab.defaultPrevented).toBe(false);

  act(() => root.unmount());
  host.remove();
  delete document.documentElement.dataset.reduceMotion;
});


