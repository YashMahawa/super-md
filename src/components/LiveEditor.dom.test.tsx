// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import LiveEditor from "./LiveEditor";
import { writingIssues, type WritingOptions } from "../proofreadingCore";
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
it("changes full note Markdown only at the exact accepted suggestion across multi-block notes", async () => {
  class InlineProofreadingWorker {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: (() => void) | null = null;
    terminate = vi.fn();
    postMessage(payload: { id: number; text: string; options: WritingOptions; blocked: Array<[number, number]> }) {
      const issues = writingIssues(payload.text, payload.options, undefined, payload.blocked);
      this.onmessage?.({ data: { id: payload.id, issues } });
    }
  }
  vi.useFakeTimers();
  vi.stubGlobal("Worker", InlineProofreadingWorker);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    const initialNote = [
      "# Study Note",
      "",
      "Keep a apple and the the untouched in paragraph one.",
      "",
      "😀 Fix a apple and the the here while keeping `a apple` and $a + b$ intact.",
      "",
      "Keep a apple untouched in paragraph three.",
    ].join("\n");
    let currentNote = initialNote;
    const onChange = vi.fn((next: string) => {
      currentNote = next;
      root.render(<LiveEditor markdown={currentNote} documentPath={null} dark python="" grammarCheck onChange={onChange} />);
    });
    await act(async () => root.render(<LiveEditor markdown={currentNote} documentPath={null} dark python="" grammarCheck onChange={onChange} />));
    const targetParagraph = Array.from(host.querySelectorAll("p")).find(node => node.textContent?.includes("Fix a apple"))!;
    act(() => targetParagraph.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(host.querySelector("textarea")?.value).toContain("Fix a apple");
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });

    const firstStart = initialNote.indexOf("Fix a apple") + "Fix ".length;
    expect(initialNote.slice(firstStart, firstStart + 1)).toBe("a");
    const anButton = Array.from(host.querySelectorAll<HTMLButtonElement>(".writing-suggestions button")).find(btn => btn.textContent === "an")!;
    act(() => anButton.click());

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(currentNote.slice(0, firstStart)).toBe(initialNote.slice(0, firstStart));
    expect(currentNote.slice(firstStart, firstStart + 2)).toBe("an");
    expect(currentNote.slice(firstStart + 2)).toBe(initialNote.slice(firstStart + 1));

    const afterFirstNote = currentNote;
    const secondStart = afterFirstNote.indexOf("the the", firstStart);
    expect(afterFirstNote.slice(secondStart, secondStart + 7)).toBe("the the");
    const theButton = Array.from(host.querySelectorAll<HTMLButtonElement>(".writing-suggestions button")).find(btn => btn.textContent === "the")!;
    act(() => theButton.click());

    expect(onChange).toHaveBeenCalledTimes(2);
    expect(currentNote.slice(0, secondStart)).toBe(afterFirstNote.slice(0, secondStart));
    expect(currentNote.slice(secondStart, secondStart + 3)).toBe("the");
    expect(currentNote.slice(secondStart + 3)).toBe(afterFirstNote.slice(secondStart + 7));
  } finally {
    act(() => root.unmount());
    host.remove();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
