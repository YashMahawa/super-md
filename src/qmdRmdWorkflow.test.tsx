// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { analyzeDocument } from "./documentAnalysis";
import {
  closeTab,
  editTab,
  initialWorkspace,
  isDirty,
  markTabSaved,
  openTab,
  readWorkspace,
  restoreClosedTab,
  tabTitle,
} from "./documentTabs";

const { prepareFmdSpy, editorBridge, readerTree } = vi.hoisted(() => {
  if (typeof document !== "undefined") {
    document.body.innerHTML = '<div id="root"></div>';
  }
  return {
    prepareFmdSpy: vi.fn(),
    editorBridge: {
      value: "",
      onChange: null as ((value: string) => void) | null,
    },
    readerTree: {
      element: null as ReactNode,
      mountRoot: null as ((container: Element | DocumentFragment) => Root) | null,
    },
  };
});

vi.mock("react-dom/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-dom/client")>();
  readerTree.mountRoot = actual.createRoot;
  return {
    ...actual,
    createRoot: () => ({
      render: (node: ReactNode) => {
        readerTree.element = node;
      },
      unmount: () => {},
    }),
  };
});

vi.mock("./documentMedia", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./documentMedia")>();
  return {
    ...actual,
    prepareFmd: (...args: Parameters<typeof actual.prepareFmd>) => {
      prepareFmdSpy(...args);
      return actual.prepareFmd(...args);
    },
  };
});

vi.mock("./components/Editor", () => ({
  default: ({ value, onChange }: { value: string; onChange?: (next: string) => void }) => {
    editorBridge.value = value;
    editorBridge.onChange = onChange ?? null;
    return <div className="mock-editor">{value}</div>;
  },
  editorReadingOffset: () => 0,
  editorSelectedText: () => null,
  editorViewContext: () => undefined,
  editorHistory: () => false,
  exportEditorSession: () => undefined,
  formatEditorSession: () => false,
  importEditorSession: () => {},
  cachedEditorHistory: () => undefined,
}));

import "./androidReader";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
class ResizeObserverMock {
  observe() {}
  disconnect() {}
}
Object.assign(globalThis, { ResizeObserver: ResizeObserverMock });

let mountedRoot: Root | null = null;
afterEach(() => {
  if (mountedRoot) act(() => mountedRoot?.unmount());
  mountedRoot = null;
  editorBridge.value = "";
  editorBridge.onChange = null;
  prepareFmdSpy.mockClear();
  delete window.SuperMD;
  document.body.innerHTML = '<div id="root"></div>';
  localStorage.clear();
});

const baseReaderColors = {
  primary: "#6750a4",
  "on-primary": "#ffffff",
  surface: "#141218",
  "surface-low": "#1d1b20",
  "surface-high": "#2b2930",
  text: "#e6e1e5",
  muted: "#cac4d0",
  outline: "#49454f",
};

describe("Shipped Web & native reader .qmd and .Rmd editable-note round trips", () => {
  it("preserves exact .qmd and .Rmd filenames, casing, paths, and source across documentTabs and storage", () => {
    const qmdSource = '---\ntitle: "Quarto Study"\n---\n\n```{python}\n#| echo: false\nx = 1\n```\n';
    const rmdSource = '---\ntitle: "Clinical Trial"\n---\n\n```{r setup, include=FALSE}\nx <- 2\n```\n';

    let ws = initialWorkspace();
    ws = openTab(ws, { path: "/research/quarto-guide.qmd", content: qmdSource });
    ws = openTab(ws, { path: "/research/ClinicalTrial.Rmd", content: rmdSource });
    ws = openTab(ws, { path: "/research/UPPER_MODEL.QMD", content: "# Upper QMD\n" });

    expect(ws.tabs.slice(1).map((t) => ({ name: t.name, title: tabTitle(t), path: t.path }))).toEqual([
      { name: "quarto-guide.qmd", title: "quarto-guide.qmd", path: "/research/quarto-guide.qmd" },
      { name: "ClinicalTrial.Rmd", title: "ClinicalTrial.Rmd", path: "/research/ClinicalTrial.Rmd" },
      { name: "UPPER_MODEL.QMD", title: "UPPER_MODEL.QMD", path: "/research/UPPER_MODEL.QMD" },
    ]);

    const rmdTab = ws.tabs.find((t) => t.path === "/research/ClinicalTrial.Rmd")!;
    const rmdEdited = `${rmdSource}\nPrimary endpoint preserved.\n`;
    ws = editTab(ws, rmdTab.id, rmdEdited);
    expect(isDirty(ws.tabs.find((t) => t.id === rmdTab.id)!)).toBe(true);

    // Ordinary save preserves exact ClinicalTrial.Rmd path, name, and content.
    ws = markTabSaved(ws, rmdTab.id, "/research/ClinicalTrial.Rmd", rmdEdited);
    const savedRmd = ws.tabs.find((t) => t.id === rmdTab.id)!;
    expect(savedRmd.name).toBe("ClinicalTrial.Rmd");
    expect(savedRmd.path).toBe("/research/ClinicalTrial.Rmd");
    expect(savedRmd.content).toBe(rmdEdited);
    expect(isDirty(savedRmd)).toBe(false);

    // Close + reopen closed tab and Web localStorage workspace round-trip keep .Rmd and .qmd intact.
    ws = closeTab(ws, rmdTab.id);
    ws = restoreClosedTab(ws);
    localStorage.setItem("workspace.tabs.browser", JSON.stringify(ws));
    const restored = readWorkspace(localStorage, "workspace.tabs.browser", initialWorkspace());
    expect(restored.tabs.some((t) => t.name === "ClinicalTrial.Rmd" && t.content === rmdEdited)).toBe(true);
    expect(restored.tabs.some((t) => t.name === "quarto-guide.qmd" && t.content === qmdSource)).toBe(true);

    // Quarto braced {python}/{mermaid} fences parse while R {r ...} chunks remain untouched raw fenced code without execution.
    const qmdAnalysis = analyzeDocument(`${qmdSource}\n\`\`\`{mermaid}\ngraph LR\n  A --> B\n\`\`\`\n`);
    expect(qmdAnalysis.pythonCells).toHaveLength(1);
    const rmdAnalysis = analyzeDocument(rmdEdited);
    expect(rmdAnalysis.pythonCells).toHaveLength(0);
  });

  it("loads, edits, and flushes ordinary saves for .qmd and .Rmd notes over the shipped SuperMD bridge without portable rewrites", async () => {
    const bridgeCalls: Array<{ command: string; args: Record<string, unknown> }> = [];
    window.SuperMD = {
      post(id: string, command: string, rawArgs: string) {
        const args = JSON.parse(rawArgs) as Record<string, unknown>;
        bridgeCalls.push({ command, args });
        queueMicrotask(() => window.supermdReply?.(id, { accepted: true, revision: Number(args.revision ?? 0) }, null));
      },
    };

    const flush = async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    };

    const host = document.getElementById("root")!;
    mountedRoot = readerTree.mountRoot!(host);
    await act(async () => {
      mountedRoot?.render(readerTree.element);
      await flush();
    });
    expect(bridgeCalls.some((c) => c.command === "reader_ready")).toBe(true);

    const qmdSource = '---\ntitle: "Quarto Study"\n---\n\n```{python}\n#| label: fig-1\nx = [1, 2, 3]\n```\n';
    await act(async () => {
      window.supermdLoad?.({
        id: "qmd-tab-1",
        path: "/research/quarto-guide.qmd",
        portable: false,
        content: qmdSource,
        mode: "editor",
        editProtocol: 1,
        dark: true,
        fullscreen: false,
        font: "Manrope",
        size: 16,
        colors: baseReaderColors,
        zoom: 100,
      });
      await flush();
    });
    expect(editorBridge.value).toBe(qmdSource);

    const qmdEdited = `${qmdSource}\nOrdinary Quarto prose edit.\n`;
    await act(async () => {
      editorBridge.onChange?.(qmdEdited);
      await flush();
    });
    await act(async () => {
      window.supermdFlush?.({ action: "save" });
      await flush();
    });

    expect(prepareFmdSpy).not.toHaveBeenCalled();
    expect(bridgeCalls).toContainEqual({
      command: "document_flushed",
      args: expect.objectContaining({
        id: "qmd-tab-1",
        content: qmdEdited,
        operation: { action: "save" },
      }),
    });

    const rmdSource = '---\ntitle: "Clinical Trial"\n---\n\n```{r setup, include=FALSE}\nknitr::opts_chunk$set(echo = TRUE)\n```\n';
    await act(async () => {
      window.supermdLoad?.({
        id: "rmd-tab-1",
        path: "/research/ClinicalTrial.Rmd",
        portable: false,
        content: rmdSource,
        mode: "editor",
        editProtocol: 1,
        dark: true,
        fullscreen: false,
        font: "Manrope",
        size: 16,
        colors: baseReaderColors,
        zoom: 100,
      });
      await flush();
    });
    expect(editorBridge.value).toBe(rmdSource);

    const rmdEdited = `${rmdSource}\nOrdinary R Markdown prose edit.\n`;
    await act(async () => {
      editorBridge.onChange?.(rmdEdited);
      await flush();
    });
    await act(async () => {
      window.supermdFlush?.({ action: "save" });
      await flush();
    });

    expect(prepareFmdSpy).not.toHaveBeenCalled();
    expect(bridgeCalls).toContainEqual({
      command: "document_flushed",
      args: expect.objectContaining({
        id: "rmd-tab-1",
        content: rmdEdited,
        operation: { action: "save" },
      }),
    });
  });
});
