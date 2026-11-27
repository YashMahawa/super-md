// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const { nativeInvoke } = vi.hoisted(() => ({ nativeInvoke: vi.fn() }));
vi.mock("./nativeBridge", () => ({ invoke: nativeInvoke }));

import PythonCell from "./components/PythonCell";
import { cachedPythonOutput, pythonResults } from "./renderedOutputs";
import type { PythonContext } from "./types";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  nativeInvoke.mockReset();
  pythonResults.clear();
  document.body.innerHTML = "";
});

describe("PythonCell execution and cancellation", () => {
  it("renders ordinary results and ignores tab/window cancellation without caching a failure", async () => {
    const ctx: PythonContext = { document: "/note.md", cell: "0", interpreter: "/usr/bin/python3" };
    nativeInvoke.mockImplementation(async (command: string) => {
      if (command === "load_python_output") return null;
      if (command === "store_python_output" || command === "cache_python_output") return true;
      return {
        ok: true,
        stdout: "42\n",
        stderr: "",
        images: [],
        provenance: { verified: true, document: ctx.document, cell: ctx.cell, interpreter: ctx.interpreter },
      };
    });

    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(<PythonCell source="print(42)" python="/usr/bin/python3" context={ctx} />);
    });

    const button = host.querySelector("button.python-run") as HTMLButtonElement;
    await act(async () => {
      button.click();
    });

    expect(host.querySelector(".cell-output")?.textContent).toContain("42");
    expect(cachedPythonOutput("print(42)", ctx)?.stdout).toBe("42\n");

    const cancelledCtx: PythonContext = { document: "/closed.md", cell: "0", interpreter: "/usr/bin/python3" };
    nativeInvoke.mockImplementation(async (command: string) => {
      if (command === "load_python_output") return null;
      if (command === "run_python") throw new Error("Python cell cancelled");
      return null;
    });

    await act(async () => {
      root.render(<PythonCell source="import time; time.sleep(10)" python="/usr/bin/python3" context={cancelledCtx} />);
    });

    const cancelBtn = host.querySelector("button.python-run") as HTMLButtonElement;
    await act(async () => {
      cancelBtn.click();
    });

    expect(cachedPythonOutput("import time; time.sleep(10)", cancelledCtx)).toBeUndefined();
    expect(cancelBtn.disabled).toBe(false);

    const errorCtx: PythonContext = { document: "/timeout.md", cell: "0", interpreter: "/usr/bin/python3" };
    nativeInvoke.mockImplementation(async (command: string) => {
      if (command === "load_python_output") return null;
      if (command === "run_python") throw new Error("Python cell stopped after 1 seconds");
      return null;
    });

    await act(async () => {
      root.render(<PythonCell source="while True: pass" python="/usr/bin/python3" context={errorCtx} />);
    });

    const errorBtn = host.querySelector("button.python-run") as HTMLButtonElement;
    await act(async () => {
      errorBtn.click();
    });

    expect(host.querySelector(".cell-output.failed")?.textContent).toContain("Python cell stopped after 1 seconds");
    expect(cachedPythonOutput("while True: pass", errorCtx)?.ok).toBe(false);

    await act(async () => {
      root.unmount();
    });
  });
});
