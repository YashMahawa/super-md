// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn(async () => null));
vi.mock("./nativeBridge", () => ({ invoke: invokeMock }));
vi.mock("./components/Editor", () => ({ default: ({ value, onChange }: { value: string; onChange: (next: string) => void }) => <textarea className="mock-editor" aria-label="Mock source editor" value={value} onChange={(event) => onChange(event.target.value)} /> }));
vi.mock("./components/MarkdownPreview", () => ({ default: () => <div className="mock-preview" /> }));
import App from "./App";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
class ResizeObserverMock { observe() {} disconnect() {} }
Object.assign(globalThis, { ResizeObserver: ResizeObserverMock });

let root: Root | null = null;
afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  localStorage.clear();
  invokeMock.mockClear();
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
    expect(host.querySelector<HTMLInputElement>('.zoom-entry input')?.value).toBe("115");
    expect(topbar.getAttribute("style")).toBeNull();

    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "F11", bubbles: true })); });
    expect(document.documentElement.dataset.fullscreen).toBe("true");
    expect(host.querySelector<HTMLInputElement>('.fullscreen-controls input')?.value).toBe("115");
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "+", code: "Equal", ctrlKey: true, bubbles: true, cancelable: true })); });
    expect(host.querySelector<HTMLInputElement>('.fullscreen-controls input')?.value).toBe("125");

    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "F11", bubbles: true })); });
    expect(document.documentElement.dataset.fullscreen).toBe("false");
    expect(host.querySelector<HTMLInputElement>('.zoom-entry input')?.value).toBe("115");
  });

  it("restores browser local-session tabs and user note paths and flushes updates on beforeunload", async () => {
    localStorage.setItem("setup.complete", "true");
    localStorage.setItem("workspace.tabs.browser", JSON.stringify({
      tabs: [
        { id: "saved-note", path: "/notes/research.smd", content: "# Saved Research", savedContent: "# Saved Research", name: "research.smd" },
        { id: "dirty-draft", path: null, content: "Unsaved browser draft", savedContent: "", name: "Untitled.smd" },
      ],
      activeId: "dirty-draft",
      recentlyClosed: [
        { id: "closed-note", path: "/notes/archive.md", content: "Archived body", savedContent: "Archived body", name: "archive.md" },
      ],
    }));

    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => { root?.render(<App />); });

    const tabs = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    expect(tabs.map((tab) => tab.textContent)).toEqual(["research.smd", "Untitled.smd"]);
    expect(tabs[0].getAttribute("title")).toBe("/notes/research.smd");
    expect(tabs[1].getAttribute("aria-selected")).toBe("true");
    expect(host.querySelector<HTMLTextAreaElement>(".mock-editor")?.value).toBe("Unsaved browser draft");
    expect(invokeMock).not.toHaveBeenCalledWith("startup_document", expect.anything());
    expect(invokeMock).not.toHaveBeenCalledWith("load_draft", expect.anything());

    await act(async () => { host.querySelector<HTMLButtonElement>(".tab-reopen")?.click(); });
    expect(host.querySelector<HTMLTextAreaElement>(".mock-editor")?.value).toBe("Archived body");
    await act(async () => { window.dispatchEvent(new Event("beforeunload")); });

    const persisted = JSON.parse(localStorage.getItem("workspace.tabs.browser") || "null");
    expect(persisted.activeId).toBe("closed-note");
    expect(persisted.tabs.map((tab: { path: string | null }) => tab.path)).toEqual(["/notes/research.smd", null, "/notes/archive.md"]);
  });
});
