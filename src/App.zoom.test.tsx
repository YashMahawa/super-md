// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ fullscreen: false }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ isFullscreen: async () => native.fullscreen, setFullscreen: async (value: boolean) => { native.fullscreen = value; } }) }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({ WebviewWindow: class {} }));
vi.mock("./components/Editor", () => ({ default: () => <div className="mock-editor" /> }));
vi.mock("./components/MarkdownPreview", () => ({ default: () => <div className="mock-preview" /> }));
import App from "./App";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
class ResizeObserverMock { observe() {} disconnect() {} }
Object.assign(globalThis, { ResizeObserver: ResizeObserverMock });

let root: Root | null = null;
afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  native.fullscreen = false;
  document.body.innerHTML = "";
  localStorage.clear();
});

describe("workspace zoom modes", () => {
  it("keeps top chrome fixed and restores normal zoom after fullscreen", async () => {
    localStorage.setItem("setup.complete", "true");
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => { root?.render(<App />); });

    const workspace = host.querySelector(".workspace")!;
    const topbar = host.querySelector(".topbar")!;
    await act(async () => { workspace.dispatchEvent(new WheelEvent("wheel", { ctrlKey: true, deltaY: -90, bubbles: true, cancelable: true })); });
    expect(host.querySelector(".zoom-value")?.textContent).toBe("115%");
    expect(topbar.getAttribute("style")).toBeNull();

    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "F11", bubbles: true })); });
    expect(document.documentElement.dataset.fullscreen).toBe("true");
    expect(host.querySelector(".fullscreen-controls")?.textContent).toContain("100%");
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "+", code: "Equal", ctrlKey: true, bubbles: true, cancelable: true })); });
    expect(host.querySelector(".fullscreen-controls")?.textContent).toContain("110%");

    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "F11", bubbles: true })); });
    expect(document.documentElement.dataset.fullscreen).toBe("false");
    expect(host.querySelector(".zoom-value")?.textContent).toBe("115%");
  });
});
