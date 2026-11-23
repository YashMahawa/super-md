// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import LiveEditor from "./LiveEditor";
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
