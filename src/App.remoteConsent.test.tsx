// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(async (_command: string, _args?: unknown): Promise<unknown> => null),
}));

vi.mock("./nativeBridge", () => ({ invoke: invokeMock }));
vi.mock("./components/Editor", () => ({
  default: ({ value, onChange }: { value: string; onChange: (next: string) => void }) => (
    <textarea
      aria-label="Mock source editor"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));

import App from "./App";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
class ResizeObserverMock {
  observe() {}
  disconnect() {}
}
Object.assign(globalThis, { ResizeObserver: ResizeObserverMock });
const attachInternals = HTMLElement.prototype.attachInternals;
vi.spyOn(HTMLElement.prototype, "attachInternals").mockImplementation(function (this: HTMLElement) {
  const internals = attachInternals.call(this);
  internals.setFormValue ??= () => {};
  internals.setValidity ??= () => {};
  internals.checkValidity ??= () => true;
  internals.reportValidity ??= () => true;
  return internals;
});

describe("App note-scoped remote image consent across background saves and tab switches", () => {
  let root: Root | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    invokeMock.mockReset();
    localStorage.clear();
    localStorage.setItem("setup.complete", "true");
    localStorage.setItem("autosave", "true");
  });

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = null;
    vi.useRealTimers();
    document.body.innerHTML = "";
    localStorage.clear();
  });

  it("does not leak active DOM or cached image bytes into a background portable Save", async () => {
    const remotePng = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a44kAAAAASUVORK5CYII=";
    const sharedUrl = "https://once.example/shared-bg.png";
    const initialWorkspace = {
      activeId: "tab-b",
      recentlyClosed: [],
      tabs: [
        {
          id: "tab-a",
          path: "/vault/note-a.fmd",
          name: "note-a.fmd",
          content: `# Note A\n\n![Shared](${sharedUrl})\n`,
          savedContent: `# Note A\n\n![Shared](${sharedUrl})\n`,
        },
        {
          id: "tab-b",
          path: "/vault/note-b.fmd",
          name: "note-b.fmd",
          content: `# Note B\n\nEdited body.\n\n![Shared](${sharedUrl})\n`,
          savedContent: `# Note B\n\n![Shared](${sharedUrl})\n`,
        },
      ],
    };
    localStorage.setItem("workspace.tabs.browser", JSON.stringify(initialWorkspace));

    const savedRequests: Array<Record<string, any>> = [];
    invokeMock.mockImplementation(async (command: string, args: any) => {
      if (command === "fetch_resource") return { body: remotePng };
      if (command === "save_document") {
        savedRequests.push(args.request);
        return args.request.path;
      }
      return null;
    });

    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(<App />);
    });

    // Switch to Note A in Reader view and consent to loading the remote image so it mounts in the live DOM.
    const readerModeBtn = host.querySelector<HTMLButtonElement>('button[aria-label="reader view"]');
    await act(async () => {
      readerModeBtn?.click();
    });
    const tabAButton = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find(
      (btn) => btn.textContent?.includes("note-a.fmd"),
    );
    expect(tabAButton).toBeDefined();
    await act(async () => {
      tabAButton?.click();
    });

    const loadImgBtn = host.querySelector<HTMLButtonElement>('.remote-image-card[data-note-id="tab-a"] .remote-image-actions button');
    expect(loadImgBtn).not.toBeNull();
    await act(async () => {
      loadImgBtn?.click();
      await Promise.resolve();
    });

    // Note A's consented image is now mounted in the displayed DOM with data-note-id="tab-a".
    expect(host.querySelector('.note-image[data-note-id="tab-a"] img')?.getAttribute("src")).toBe(remotePng);
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "fetch_resource")).toEqual([
      ["fetch_resource", { url: sharedUrl, image: true }],
    ]);

    // Advance autosave timer (1200ms) while Note A remains displayed: dirty Note B saves in the background.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1300);
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    });

    expect(savedRequests).toHaveLength(1);
    expect(savedRequests[0]).toEqual({
      path: "/vault/note-b.fmd",
      sourcePath: "/vault/note-b.fmd",
      content: `# Note B\n\nEdited body.\n\n![Shared](${sharedUrl})\n`,
      assets: {},
    });
    // Zero extra network fetches occurred for Note B.
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "fetch_resource")).toHaveLength(1);
  });

  it("keeps consent and resolved bytes on the originating tab when switching notes mid-load and saving in the background", async () => {
    const remotePng = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a44kAAAAASUVORK5CYII=";
    const sharedUrl = "https://once.example/inflight-tab.png";
    const initialWorkspace = {
      activeId: "tab-a",
      recentlyClosed: [],
      tabs: [
        {
          id: "tab-a",
          path: "/vault/note-a.fmd",
          name: "note-a.fmd",
          content: `# Note A\n\nDirty edit in A.\n\n![Shared](${sharedUrl})\n`,
          savedContent: `# Note A\n\n![Shared](${sharedUrl})\n`,
        },
        {
          id: "tab-b",
          path: "/vault/note-b.fmd",
          name: "note-b.fmd",
          content: `# Note B\n\n![Shared](${sharedUrl})\n`,
          savedContent: `# Note B\n\n![Shared](${sharedUrl})\n`,
        },
      ],
    };
    localStorage.setItem("workspace.tabs.browser", JSON.stringify(initialWorkspace));

    let resolveFetch!: (value: { body: string }) => void;
    const savedRequests: Array<Record<string, any>> = [];
    invokeMock.mockImplementation((command: string, args: any) => {
      if (command === "fetch_resource") {
        return new Promise<{ body: string }>((resolve) => {
          resolveFetch = resolve;
        });
      }
      if (command === "save_document") {
        savedRequests.push(args.request);
        return Promise.resolve(args.request.path);
      }
      return Promise.resolve(null);
    });

    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(<App />);
    });

    const readerModeBtn = host.querySelector<HTMLButtonElement>('button[aria-label="reader view"]');
    await act(async () => {
      readerModeBtn?.click();
    });

    // Click Load image in Tab A, then switch to Tab B BEFORE fetch_resource resolves.
    const loadImgBtn = host.querySelector<HTMLButtonElement>('.remote-image-card[data-note-id="tab-a"] .remote-image-actions button');
    expect(loadImgBtn).not.toBeNull();
    await act(async () => {
      loadImgBtn?.click();
    });
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "fetch_resource")).toHaveLength(1);

    const tabBButton = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find(
      (btn) => btn.textContent?.includes("note-b.fmd"),
    );
    expect(tabBButton).toBeDefined();
    await act(async () => {
      tabBButton?.click();
    });

    // Tab B remains blocked on the remote image card.
    expect(host.querySelector('.remote-image-card[data-note-id="tab-b"]')).not.toBeNull();
    expect(host.querySelector(".note-image img")).toBeNull();

    // Now resolve Tab A's in-flight fetch while Tab B is active.
    await act(async () => {
      resolveFetch({ body: remotePng });
      await Promise.resolve();
    });
    expect(host.querySelector('.remote-image-card[data-note-id="tab-b"]')).not.toBeNull();
    expect(host.querySelector(".note-image img")).toBeNull();

    // Let background autosave run for dirty Tab A: Tab A reuses its resolved bytes offline without re-fetching!
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1300);
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    });
    expect(savedRequests).toHaveLength(1);
    expect(savedRequests[0].path).toBe("/vault/note-a.fmd");
    expect(Object.values(savedRequests[0].assets)).toEqual([remotePng]);
    expect(savedRequests[0].content).not.toContain(sharedUrl);
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "fetch_resource")).toHaveLength(1);

    // Manually clicking Save while on Tab B leaves Tab B's unapproved URL untouched and packages zero assets.
    savedRequests.length = 0;
    const saveButton = host.querySelector<HTMLElement>('[aria-label="Save"]');
    expect(saveButton).not.toBeNull();
    await act(async () => {
      saveButton?.click();
      await Promise.resolve();
    });
    expect(savedRequests).toHaveLength(1);
    expect(savedRequests[0]).toEqual({
      path: "/vault/note-b.fmd",
      sourcePath: "/vault/note-b.fmd",
      content: `# Note B\n\n![Shared](${sharedUrl})\n`,
      assets: {},
    });
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "fetch_resource")).toHaveLength(1);
  });

  it("reuses cached bytes and enforces owning-note consent on target-tab FMD and PDF exports", async () => {
    const rawBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a44kAAAAASUVORK5CYII=";
    const remotePng = `data:image/png;base64,${rawBase64}`;
    const sharedUrl = "https://once.example/shared-export.png";
    const initialWorkspace = {
      activeId: "tab-a",
      recentlyClosed: [],
      tabs: [
        {
          id: "tab-a",
          path: "/vault/export-a.md",
          name: "export-a.md",
          content: `# Export A\n\n![Shared](${sharedUrl})\n`,
          savedContent: `# Export A\n\n![Shared](${sharedUrl})\n`,
        },
        {
          id: "tab-b",
          path: "/vault/export-b.md",
          name: "export-b.md",
          content: `# Export B\n\n<img alt="Shared" src="${sharedUrl}" width="200">\n`,
          savedContent: `# Export B\n\n<img alt="Shared" src="${sharedUrl}" width="200">\n`,
        },
      ],
    };
    localStorage.setItem("workspace.tabs.browser", JSON.stringify(initialWorkspace));

    let resolveExportFmd!: (value: string) => void;
    const exportedFmd: Array<Record<string, any>> = [];
    const exportedPdf: Array<Record<string, any>> = [];
    invokeMock.mockImplementation((command: string, args: any) => {
      if (command === "fetch_resource") return Promise.resolve({ body: remotePng });
      if (command === "export_fmd") {
        exportedFmd.push(args);
        return new Promise<string>((resolve) => {
          resolveExportFmd = resolve;
        });
      }
      if (command === "export_portable_pdf") {
        exportedPdf.push(args);
        return Promise.resolve("/vault/export-a.pdf");
      }
      return Promise.resolve(null);
    });

    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(<App />);
    });

    // Consent and load the remote image in Tab A, then switch to Source view and rewrite as HTML <img> so no <img> stays mounted in DOM.
    const readerModeBtn = host.querySelector<HTMLButtonElement>('button[aria-label="reader view"]');
    await act(async () => {
      readerModeBtn?.click();
    });
    const loadImgBtn = host.querySelector<HTMLButtonElement>('.remote-image-card[data-note-id="tab-a"] .remote-image-actions button');
    expect(loadImgBtn).not.toBeNull();
    await act(async () => {
      loadImgBtn?.click();
      await Promise.resolve();
    });
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "fetch_resource")).toHaveLength(1);

    const editorModeBtn = host.querySelector<HTMLButtonElement>('button[aria-label="editor view"]');
    await act(async () => {
      editorModeBtn?.click();
    });
    expect(host.querySelector(".note-image img")).toBeNull();

    // Export Tab A as Portable FMD: reuses cached bytes from noteImageConsentRef without re-fetching.
    await act(async () => {
      host.querySelector<HTMLElement>('[aria-label="Export"]')?.click();
      await vi.advanceTimersByTimeAsync(20);
    });
    await act(async () => {
      Array.from(host.querySelectorAll<HTMLButtonElement>(".export-formats button"))
        .find((btn) => btn.textContent?.includes("Portable FMD"))
        ?.click();
    });
    await act(async () => {
      host.querySelector<HTMLElement>(".export-sheet .primary-action")?.click();
      for (let i = 0; i < 4; i += 1) await Promise.resolve();
    });
    expect(exportedFmd).toHaveLength(1);
    expect(Object.values(exportedFmd[0].assets)).toEqual([remotePng]);
    expect(exportedFmd[0].content).toContain("# Export A");
    expect(exportedFmd[0].content).not.toContain(sharedUrl);
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "fetch_resource")).toHaveLength(1);

    await act(async () => {
      resolveExportFmd("/vault/export-a.fmd");
      await vi.advanceTimersByTimeAsync(400);
    });

    // Rewrite Tab A as HTML <img> in Source view and export as PDF document: reuses cached bytes with zero extra network calls.
    const editor = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Mock source editor"]');
    expect(editor).not.toBeNull();
    await act(async () => {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
      descriptor?.set?.call(editor, `# Export A\n\n<img alt="Shared" src="${sharedUrl}" width="200">\n`);
      editor?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      host.querySelector<HTMLElement>('[aria-label="Export"]')?.click();
      await vi.advanceTimersByTimeAsync(20);
    });
    await act(async () => {
      Array.from(host.querySelectorAll<HTMLButtonElement>(".export-formats button"))
        .find((btn) => btn.textContent?.includes("PDF document"))
        ?.click();
    });
    await act(async () => {
      host.querySelector<HTMLElement>(".export-sheet .primary-action")?.click();
      await vi.advanceTimersByTimeAsync(50);
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    });
    expect(exportedPdf).toHaveLength(1);
    expect(exportedPdf[0].path).toBe("/vault/export-a.md");
    expect(Object.values(exportedPdf[0].assets)).toEqual([rawBase64]);
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "fetch_resource")).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });

    // Switch to Tab B (unapproved) and verify neither PDF nor FMD export leaks Tab A's consent or cached bytes.
    const tabBMd = `# Export B\n\n![Shared](${sharedUrl})\n\n<img alt="Shared" src="${sharedUrl}" width="200">\n`;
    await act(async () => {
      Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
        .find((btn) => btn.textContent?.includes("export-b.md"))
        ?.click();
    });
    const tabBEditor = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Mock source editor"]');
    await act(async () => {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
      descriptor?.set?.call(tabBEditor, tabBMd);
      tabBEditor?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      host.querySelector<HTMLElement>('[aria-label="Export"]')?.click();
      await vi.advanceTimersByTimeAsync(20);
    });
    await act(async () => {
      host.querySelector<HTMLElement>(".export-sheet .primary-action")?.click();
      await vi.advanceTimersByTimeAsync(50);
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    });
    expect(exportedPdf).toHaveLength(1);
    expect(host.querySelector(".export-error")?.textContent).toMatch(/consent/i);
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "fetch_resource")).toHaveLength(1);

    // Switch Tab B export format to Portable FMD: preserves unapproved URL verbatim with empty assets.
    await act(async () => {
      Array.from(host.querySelectorAll<HTMLButtonElement>(".export-formats button"))
        .find((btn) => btn.textContent?.includes("Portable FMD"))
        ?.click();
    });
    await act(async () => {
      host.querySelector<HTMLElement>(".export-sheet .primary-action")?.click();
      for (let i = 0; i < 4; i += 1) await Promise.resolve();
    });
    expect(exportedFmd).toHaveLength(2);
    expect(exportedFmd[1]).toEqual({
      content: tabBMd,
      assets: {},
    });
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "fetch_resource")).toHaveLength(1);
    await act(async () => {
      resolveExportFmd("/vault/export-b.fmd");
      await vi.advanceTimersByTimeAsync(400);
    });
  });
});
