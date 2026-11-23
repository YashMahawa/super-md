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
it("isolates YAML frontmatter when double-clicking the first visible block and preserves frontmatter verbatim on save", async () => {
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  let current = "\uFEFF---  \ntitle: Protected Metadata\nauthor: Paul Dirac\ntags: [quantum]\n...\n\n# Opening Heading\n\nBody paragraph.";
  const edit = vi.fn((next: string) => { current = next; });
  await act(async () => root.render(<LiveEditor markdown={current} documentPath={null} dark python="" onChange={edit} />));
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
  expect(edit).toHaveBeenCalledWith("\uFEFF---  \ntitle: Protected Metadata\nauthor: Paul Dirac\ntags: [quantum]\n...\n\n# Updated Heading\n\nBody paragraph.");
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
