// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import ExportProgressIndicator from "./ExportProgressIndicator";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
});

function mount(completed?: number, total?: number) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<ExportProgressIndicator completed={completed} total={total} />));
  return host;
}

it("keeps native determinate progress semantics and clamps the visible count", () => {
  const view = mount(7, 5);
  const progress = view.querySelector("progress")!;
  expect(progress.getAttribute("aria-label")).toBe("Export preparation progress");
  expect(progress.max).toBe(5);
  expect(progress.value).toBe(5);
  expect(progress.hasAttribute("value")).toBe(true);
  expect(view.querySelector(".export-progress-morph")?.getAttribute("aria-hidden")).toBe("true");
});

it("leaves the native progress element indeterminate when total is unavailable", () => {
  const view = mount(undefined, 0);
  const progress = view.querySelector("progress")!;
  expect(progress.getAttribute("aria-label")).toBe("Export in progress");
  expect(progress.hasAttribute("value")).toBe(false);
  expect(progress.hasAttribute("max")).toBe(false);
});
