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

