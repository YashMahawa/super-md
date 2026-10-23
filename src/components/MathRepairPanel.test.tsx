// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import MathRepairPanel from "./MathRepairPanel";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
  delete document.documentElement.dataset.readerOverlay;
});

function mount(content: string, apply = vi.fn(), close = vi.fn()) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<MathRepairPanel content={content} apply={apply} close={close} />));
  return { apply, close };
}
function button(label: string): HTMLButtonElement {
  const result = [...document.querySelectorAll("button")].find(item => item.textContent?.trim() === label);
  if (!result) throw new Error(`Missing button: ${label}`);
  return result;
}
function click(element: HTMLElement) { act(() => element.click()); }

it("select all and none update the count and only selected suggestions apply", () => {
  const source = String.raw`\(x\]` + "\n\n" + String.raw`$ x^2 $`;
  const { apply } = mount(source);
  expect(document.querySelector("header small")?.textContent).toBe("2 of 2 selected");
  click(button("Select none"));
  expect(document.querySelector("header small")?.textContent).toBe("0 of 2 selected");
  expect(button("Apply 0 repairs").disabled).toBe(true);
  click(button("Select all"));
  expect(document.querySelector("header small")?.textContent).toBe("2 of 2 selected");
  click(button("Select none"));
  const checkbox = document.querySelector<HTMLInputElement>('input[aria-label="Apply repair 1"]')!;
  act(() => { checkbox.click(); });
  expect(document.querySelector("header small")?.textContent).toBe("1 of 2 selected");
  click(button("Apply 1 repair"));
  expect(apply).toHaveBeenCalledTimes(1);
  expect(apply.mock.calls[0][0]).toContain("$x$");
  expect(apply.mock.calls[0][0]).toContain("$ x^2 $");
});

it("discards exclusions when source content changes to a smaller, different repair batch", () => {
  const { apply } = mount(String.raw`\(x\]` + "\n\n" + String.raw`$ x^2 $`);
  click(button("Select none"));
  act(() => root!.render(<MathRepairPanel content={String.raw`$\sqrt{x$`} apply={apply} close={vi.fn()} />));
  expect(document.querySelector("header small")?.textContent).toBe("1 of 1 selected");
  click(button("Apply 1 repair"));
  expect(apply).toHaveBeenCalledTimes(1);
  expect(apply.mock.calls[0][0]).toBe(String.raw`$\sqrt{x}$`);
});

it("shows an empty state and disables Apply when no safe repairs exist", () => {
  mount("This is ordinary prose with no formula.");
  expect(document.body.textContent).toContain("No safe repairs found.");
  expect(button("Apply 0 repairs").disabled).toBe(true);
});

it("traps Tab in both directions, closes on Escape, restores focus and clears the reader overlay", () => {
  const opener = document.createElement("button");
  document.body.append(opener);
  opener.focus();
  const { close } = mount(String.raw`\(x\]`);
  const panel = document.querySelector<HTMLElement>("[role=dialog]")!;
  const controls = [...panel.querySelectorAll<HTMLElement>("button:not(:disabled),input,summary")];
  expect(document.activeElement).toBe(controls[0]);
  expect(document.documentElement.dataset.readerOverlay).toBe("true");

  controls[0].focus();
  const backwards = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
  document.dispatchEvent(backwards);
  expect(backwards.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(controls.at(-1));

  const forwards = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
  document.dispatchEvent(forwards);
  expect(forwards.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(controls[0]);

  const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  document.dispatchEvent(escape);
  expect(escape.defaultPrevented).toBe(true);
  expect(close).toHaveBeenCalledTimes(1);
  act(() => root!.unmount());
  root = undefined;
  expect(document.documentElement.dataset.readerOverlay).toBe("false");
  expect(document.activeElement).toBe(opener);
  opener.remove();
});

it("applies at most once even if the Apply control receives repeated clicks", () => {
  const { apply, close } = mount(String.raw`\(x\]`);
  const applyButton = button("Apply 1 repair");
  act(() => { applyButton.click(); applyButton.click(); });
  expect(apply).toHaveBeenCalledTimes(1);
  expect(close).toHaveBeenCalledTimes(1);
});

it("keeps Unicode prefixes intact when applying helper offsets", () => {
  const source = "😀 and notes\n" + String.raw`\(\sqrt{x\]`;
  const { apply } = mount(source);
  click(button("Apply 1 repair"));
  expect(apply).toHaveBeenCalledWith("😀 and notes\n" + String.raw`$\sqrt{x}$`);
});
