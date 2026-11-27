// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  invoke: vi.fn(async (_cmd: string, _args?: Record<string, unknown>): Promise<unknown> => null),
  dropHandler: null as null | ((event: { payload: { type: string; paths: string[] } }) => Promise<void> | void),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    label: "main",
    isFullscreen: async () => false,
    setFullscreen: async () => {},
    onResized: async () => () => {},
    onCloseRequested: async () => () => {},
    onDragDropEvent: async (cb: (event: { payload: { type: string; paths: string[] } }) => Promise<void> | void) => {
      native.dropHandler = cb;
      return () => { native.dropHandler = null; };
    },
  }),
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({ WebviewWindow: class { once() {} } }));
vi.mock("./components/Editor", () => ({
  default: ({ value, onChange }: { value: string; onChange: (next: string) => void }) => (
    <textarea aria-label="Mock source editor" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));
vi.mock("./components/MarkdownPreview", () => ({ default: ({ markdown }: { markdown: string }) => <div className="mock-preview">{markdown}</div> }));

import App from "./App";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
class ResizeObserverMock { observe() {} disconnect() {} }
Object.assign(globalThis, { ResizeObserver: ResizeObserverMock });

let root: Root | null = null;
afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  native.invoke.mockReset();
  native.invoke.mockResolvedValue(null);
  native.dropHandler = null;
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  document.body.innerHTML = "";
  localStorage.clear();
});

describe("App .qmd and .Rmd open, folder search, and ordinary save workflow", () => {
  it("opens .qmd and .Rmd notes via Open dialog, folder list/search, and Tauri drop, and preserves filename and source on save", async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    localStorage.setItem("setup.complete", "true");
    localStorage.setItem("folder.root", "/research");
    localStorage.setItem("folder.visible", "true");

    const qmdInitial = "---\ntitle: \"Quarto Study\"\n---\n\n```{python}\n#| echo: false\nx = 1\n```\n";
    const rmdInitial = "---\ntitle: \"Clinical Trial\"\n---\n\n```{r setup, include=FALSE}\nx <- 2\n```\n";

    native.invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "read_directory_children") {
        return [
          { name: "ClinicalTrial.Rmd", path: "/research/ClinicalTrial.Rmd", directory: false },
          { name: "quarto-guide.qmd", path: "/research/quarto-guide.qmd", directory: false },
          { name: "UPPER_CASE.QMD", path: "/research/UPPER_CASE.QMD", directory: false },
        ];
      }
      if (cmd === "open_document") {
        return { path: "/research/quarto-guide.qmd", content: qmdInitial };
      }
      if (cmd === "read_document_at") {
        const requested = String(args?.path || "");
        if (requested === "/research/ClinicalTrial.Rmd") return { path: requested, content: rmdInitial };
        if (requested === "/research/UPPER_CASE.QMD") return { path: requested, content: "# Upper QMD\n" };
      }
      if (cmd === "save_document") {
        const req = args?.request as { path: string | null };
        return req.path;
      }
      return null;
    });

    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => { root?.render(<App />); });

    // Folder panel lists .Rmd, .qmd, and .QMD with exact case and filters case-insensitively.
    const treeEntries = () => Array.from(host.querySelectorAll(".folder-tree button.folder-entry span")).map((el) => el.textContent);
    expect(treeEntries()).toEqual(["ClinicalTrial.Rmd", "quarto-guide.qmd", "UPPER_CASE.QMD"]);

    const filterInput = host.querySelector('input[aria-label="Filter file names"]') as HTMLInputElement;
    const setReactInputValue = (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    };

    await act(async () => { setReactInputValue(filterInput, ".rmd"); });
    expect(treeEntries()).toEqual(["ClinicalTrial.Rmd"]);
    await act(async () => { setReactInputValue(filterInput, ""); });

    const getEditor = () => host.querySelector('textarea[aria-label="Mock source editor"]') as HTMLTextAreaElement;

    // Open .qmd via Ctrl+O -> open_document, edit, and save via Ctrl+S -> save_document.
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "o", ctrlKey: true, bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(getEditor().value).toBe(qmdInitial);
    expect(host.textContent).toContain("quarto-guide.qmd");

    const qmdUpdated = `${qmdInitial}\nNew Quarto paragraph.\n`;
    await act(async () => { setReactInputValue(getEditor(), qmdUpdated); });
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(native.invoke).toHaveBeenCalledWith("save_document", {
      request: {
        path: "/research/quarto-guide.qmd",
        content: qmdUpdated,
        assets: {},
        sourcePath: "/research/quarto-guide.qmd",
      },
    });

    // Open .Rmd via folder entry click, edit, and save -> preserves capital-R ClinicalTrial.Rmd.
    const rmdEntryBtn = Array.from(host.querySelectorAll(".folder-tree button.folder-entry")).find((el) => el.textContent === "ClinicalTrial.Rmd") as HTMLButtonElement;
    await act(async () => {
      rmdEntryBtn.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getEditor().value).toBe(rmdInitial);
    expect(host.textContent).toContain("ClinicalTrial.Rmd");

    const rmdUpdated = `${rmdInitial}\nPrimary outcome unchanged.\n`;
    await act(async () => { setReactInputValue(getEditor(), rmdUpdated); });
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(native.invoke).toHaveBeenCalledWith("save_document", {
      request: {
        path: "/research/ClinicalTrial.Rmd",
        content: rmdUpdated,
        assets: {},
        sourcePath: "/research/ClinicalTrial.Rmd",
      },
    });

    // Tauri drag-drop accepts uppercase .QMD as well.
    expect(native.dropHandler).not.toBeNull();
    await act(async () => {
      await native.dropHandler?.({ payload: { type: "drop", paths: ["/research/UPPER_CASE.QMD"] } });
      await Promise.resolve();
    });
    expect(getEditor().value).toBe("# Upper QMD\n");
    expect(host.textContent).toContain("UPPER_CASE.QMD");
  });
});
