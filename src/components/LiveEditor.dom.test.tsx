// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import Editor from "./Editor";
import LiveEditor from "./LiveEditor";
import { setTypewriterScroll } from "../typewriterScroll";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
if (typeof Range !== "undefined") {
  if (!Range.prototype.getClientRects) {
    Range.prototype.getClientRects = () =>
      ({
        length: 0,
        item: () => null,
        [Symbol.iterator]: function* () {},
      }) as unknown as DOMRectList;
  }
  if (!Range.prototype.getBoundingClientRect) {
    Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 20);
  }
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

it("preserves identical Markdown text and textarea selection ranges in LiveEditor with typewriterScroll ON vs OFF", async () => {
  document.documentElement.dataset.reduceMotion = "true";
  const initial = "# Live Study Note\n\nConsider $\\nabla \\cdot \\mathbf{E} = \\rho / \\varepsilon_0$ in **日本語** 🧪.";
  const runLiveSteps = async (enabled: boolean) => {
    const host = document.createElement("div");
    host.className = "reading-scroll";
    Object.defineProperty(host, "clientHeight", { value: 480, configurable: true });
    host.getBoundingClientRect = () => ({ top: 0, bottom: 480, left: 0, right: 800, width: 800, height: 480, x: 0, y: 0, toJSON: () => ({}) });
    document.body.append(host);
    const root = createRoot(host);
    let doc = initial;
    const snapshots: Array<{ doc: string; value: string; start: number; end: number; dir: string }> = [];
    const rerender = async () => {
      await act(async () => {
        root.render(
          <LiveEditor
            markdown={doc}
            documentPath={null}
            dark={false}
            python=""
            typewriterScroll={enabled}
            onChange={(next) => {
              doc = next;
            }}
          />,
        );
      });
    };
    await rerender();
    act(() => host.querySelector("p")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    const area = host.querySelector<HTMLTextAreaElement>("textarea")!;
    area.getBoundingClientRect = () => ({ top: 380, bottom: 520, left: 20, right: 780, width: 760, height: 140, x: 20, y: 380, toJSON: () => ({}) });

    const setValueAndSelection = (nextValue: string, start: number, end: number, direction: "forward" | "backward" | "none" = "none") => {
      act(() => {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
        setter.call(area, nextValue);
        area.setSelectionRange(start, end, direction);
        area.dispatchEvent(new Event("input", { bubbles: true }));
      });
      snapshots.push({ doc, value: area.value, start: area.selectionStart, end: area.selectionEnd, dir: area.selectionDirection });
    };

    // 1. Typing multiline formula
    const appended = `${area.value}\nAnd $\\nabla \\times \\mathbf{B} = \\mu_0 \\mathbf{J}$`;
    setValueAndSelection(appended, appended.length, appended.length);

    // 2. Backward range selection across multibyte Japanese + emoji
    const jpStart = area.value.indexOf("日本語");
    act(() => {
      area.setSelectionRange(jpStart, jpStart + "日本語** 🧪".length, "backward");
      area.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowUp", bubbles: true }));
    });
    snapshots.push({ doc, value: area.value, start: area.selectionStart, end: area.selectionEnd, dir: area.selectionDirection });

    // 3. IME composition preedit -> committed text replacement
    const preedit = `${area.value.slice(0, jpStart)}でんじきがく** 🧪${area.value.slice(jpStart + "日本語** 🧪".length)}`;
    act(() => {
      area.dispatchEvent(new CompositionEvent("compositionstart", { data: "", bubbles: true }));
    });
    setValueAndSelection(preedit, jpStart + "でんじきがく".length, jpStart + "でんじきがく".length);
    const committed = `${area.value.slice(0, jpStart)}電磁気学** 🧪${area.value.slice(jpStart + "でんじきがく** 🧪".length)}`;
    setValueAndSelection(committed, jpStart + "電磁気学".length, jpStart + "電磁気学".length);
    act(() => {
      area.dispatchEvent(new CompositionEvent("compositionend", { data: "電磁気学", bubbles: true }));
    });
    snapshots.push({ doc, value: area.value, start: area.selectionStart, end: area.selectionEnd, dir: area.selectionDirection });

    act(() => root.unmount());
    host.remove();
    return snapshots;
  };

  const offSnapshots = await runLiveSteps(false);
  const onSnapshots = await runLiveSteps(true);
  expect(onSnapshots).toEqual(offSnapshots);
  delete document.documentElement.dataset.reduceMotion;
});


