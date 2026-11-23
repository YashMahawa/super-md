// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import Editor from "./Editor";
import LiveEditor from "./LiveEditor";
import { setTypewriterScroll } from "../typewriterScroll";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
function pointerEvent(type: string, init: MouseEventInit & { pointerId?: number; pointerType?: string } = {}) {
  const event = new MouseEvent(type, init);
  return Object.assign(event, { pointerId: init.pointerId ?? 1, pointerType: init.pointerType ?? "mouse" });
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
