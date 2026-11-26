// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const { nativeInvoke } = vi.hoisted(() => ({ nativeInvoke: vi.fn() }));
vi.mock("./nativeBridge", () => ({ invoke: nativeInvoke }));

import MarkdownPreview from "./components/MarkdownPreview";
import PythonCell from "./components/PythonCell";
import { cachedPythonOutput, pythonResults } from "./renderedOutputs";
import type { PythonContext } from "./types";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  nativeInvoke.mockReset();
  pythonResults.clear();
  delete document.documentElement.dataset.host;
  delete document.documentElement.dataset.platform;
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

  it("exposes Stop for the specific running Desktop cell while leaving an independent cell running and retaining verified output", async () => {
    document.documentElement.dataset.host = "qt";
    document.documentElement.dataset.platform = "desktop";

    // documentAnalysis assigns ordinal "0" to every distinct-source Python cell in a note.
    const ctx0: PythonContext = { document: "/desktop-stop.md", cell: "0", interpreter: "/usr/bin/python3" };
    const ctx1: PythonContext = { document: "/desktop-stop.md", cell: "0", interpreter: "/usr/bin/python3" };
    const pendingByJob = new Map<string, { resolve: (value: unknown) => void; reject: (reason: Error) => void; code: string }>();

    let cell0RunCount = 0;
    nativeInvoke.mockImplementation((command: string, args: Record<string, any> = {}) => {
      if (command === "load_python_output") return Promise.resolve(null);
      if (command === "cache_python_output" || command === "store_python_output") return Promise.resolve(true);
      if (command === "run_python") {
        if (!String(args.code).includes("independent cell 1") && cell0RunCount++ === 0) {
          return Promise.resolve({
            ok: true,
            stdout: "verified cell 0\n",
            stderr: "",
            images: [],
            provenance: { verified: true, document: ctx0.document, cell: ctx0.cell, interpreter: ctx0.interpreter },
          });
        }
        return new Promise((resolve, reject) => {
          pendingByJob.set(String(args.jobId), { resolve, reject, code: String(args.code) });
        });
      }
      if (command === "stop_python") {
        const entry = pendingByJob.get(String(args.jobId));
        if (entry) {
          pendingByJob.delete(String(args.jobId));
          queueMicrotask(() => entry.reject(new Error("Python cell cancelled")));
          return Promise.resolve({ stopped: true });
        }
        return Promise.resolve({ stopped: false });
      }
      return Promise.resolve(null);
    });

    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);

    const renderTwoCells = (cell0Source: string) => (
      <div>
        <PythonCell source={cell0Source} python="/usr/bin/python3" context={ctx0} />
        <PythonCell source="print('independent cell 1')" python="/usr/bin/python3" context={ctx1} />
      </div>
    );

    await act(async () => {
      root.render(renderTwoCells("print('verified cell 0')"));
    });

    // Establish a verified output on cell 0 first.
    const [runBtn0Initial] = [...host.querySelectorAll<HTMLButtonElement>("button.python-run")];
    await act(async () => {
      runBtn0Initial.click();
    });
    const cellsAfterInitial = [...host.querySelectorAll<HTMLElement>(".python-cell")];
    expect(cellsAfterInitial[0].querySelector(".cell-output")?.textContent).toContain("verified cell 0");

    // Edit cell 0's source, start both cell 0 and cell 1 concurrently, and verify per-cell progress + retained verified output.
    await act(async () => {
      root.render(renderTwoCells("import time\ntime.sleep(30)"));
    });
    expect(host.querySelectorAll(".python-cell")[0].textContent).toContain("Output from earlier code");

    const [runBtn0, runBtn1] = [...host.querySelectorAll<HTMLButtonElement>("button.python-run")];
    await act(async () => {
      runBtn0.click();
      runBtn1.click();
    });

    expect(pendingByJob.size).toBe(2);
    const [job0, job1] = [...pendingByJob.entries()];
    expect(job0[0]).not.toBe(job1[0]);

    const [cellEl0, cellEl1] = [...host.querySelectorAll<HTMLElement>(".python-cell")];
    expect(cellEl0.getAttribute("aria-busy")).toBe("true");
    expect(cellEl1.getAttribute("aria-busy")).toBe("true");
    expect(cellEl0.querySelector("button.python-run")?.textContent).toBe("Running…");
    expect(cellEl1.querySelector("button.python-run")?.textContent).toBe("Running…");
    // Cell 0 retains its last verified output while running.
    expect(cellEl0.querySelector(".cell-output")?.textContent).toContain("verified cell 0");

    const stopBtn0 = cellEl0.querySelector<HTMLButtonElement>("button.python-stop")!;
    const stopBtn1 = cellEl1.querySelector<HTMLButtonElement>("button.python-stop")!;
    expect(stopBtn0).not.toBeNull();
    expect(stopBtn1).not.toBeNull();

    // Stop only cell 0.
    await act(async () => {
      stopBtn0.click();
    });

    expect(nativeInvoke).toHaveBeenCalledWith("stop_python", { jobId: job0[0] });
    expect(cellEl0.getAttribute("aria-busy")).toBeNull();
    expect(cellEl0.querySelector("button.python-stop")).toBeNull();
    // Cell 0's last verified output and stale indicator remain intact with no synthetic failure recorded.
    expect(cellEl0.querySelector(".cell-output.failed")).toBeNull();
    expect(cellEl0.querySelector(".cell-output")?.textContent).toContain("verified cell 0");
    expect(cellEl0.textContent).toContain("Output from earlier code");
    expect(cachedPythonOutput("print('verified cell 0')", ctx0)?.stdout).toBe("verified cell 0\n");
    expect(cachedPythonOutput("import time\ntime.sleep(30)", ctx0)).toBeUndefined();

    // Cell 1 is still running independently and completes cleanly with its own verified output.
    expect(cellEl1.getAttribute("aria-busy")).toBe("true");
    expect(cellEl1.querySelector("button.python-stop")).not.toBeNull();
    await act(async () => {
      job1[1].resolve({
        ok: true,
        stdout: "independent cell 1\n",
        stderr: "",
        images: [],
        provenance: { verified: true, document: ctx1.document, cell: ctx1.cell, interpreter: ctx1.interpreter },
      });
    });
    expect(cellEl1.getAttribute("aria-busy")).toBeNull();
    expect(cellEl1.querySelector(".cell-output")?.textContent).toContain("independent cell 1");

    await act(async () => {
      root.unmount();
    });
  });

  it("retains per-cell progress, Stop control, and last verified output across remounts while running and keeps Android separate", async () => {
    document.documentElement.dataset.host = "qt";
    const ctx: PythonContext = { document: "/remount.md", cell: "0", interpreter: "/usr/bin/python3" };
    let rejectRun!: (error: Error) => void;
    let capturedJobId = "";

    nativeInvoke.mockImplementation((command: string, args: Record<string, any> = {}) => {
      if (command === "load_python_output") {
        return Promise.resolve({
          result: { ok: true, stdout: "persisted verified\n", stderr: "", images: [] },
          provenance: { verified: true, document: ctx.document, cell: ctx.cell, interpreter: ctx.interpreter },
        });
      }
      if (command === "run_python") {
        capturedJobId = String(args.jobId || "");
        return new Promise((_resolve, reject) => {
          rejectRun = reject;
        });
      }
      if (command === "stop_python") {
        queueMicrotask(() => rejectRun(new Error("Python cell cancelled")));
        return Promise.resolve({ stopped: true });
      }
      return Promise.resolve(null);
    });

    const host = document.createElement("div");
    document.body.appendChild(host);
    let root = createRoot(host);

    await act(async () => {
      root.render(<PythonCell source="print('persisted verified')" python="/usr/bin/python3" context={ctx} />);
    });
    expect(host.querySelector(".cell-output")?.textContent).toContain("persisted verified");

    await act(async () => {
      host.querySelector<HTMLButtonElement>("button.python-run")!.click();
    });
    expect(capturedJobId.length).toBeGreaterThan(0);

    // Simulate switching tabs or Live/Read mode (unmount + remount while still running).
    await act(async () => {
      root.unmount();
    });
    root = createRoot(host);
    await act(async () => {
      root.render(<PythonCell source="print('persisted verified')" python="/usr/bin/python3" context={ctx} />);
    });

    expect(host.querySelector("button.python-run")?.textContent).toBe("Running…");
    expect(host.querySelector(".cell-output")?.textContent).toContain("persisted verified");
    const stopAfterRemount = host.querySelector<HTMLButtonElement>("button.python-stop")!;
    expect(stopAfterRemount).not.toBeNull();

    await act(async () => {
      stopAfterRemount.click();
    });
    expect(nativeInvoke).toHaveBeenCalledWith("stop_python", { jobId: capturedJobId });
    expect(host.querySelector("button.python-stop")).toBeNull();
    expect(host.querySelector(".cell-output")?.textContent).toContain("persisted verified");

    // Non-Qt hosts (e.g. Android) do not attach Desktop jobId or render Stop.
    delete document.documentElement.dataset.host;
    document.documentElement.dataset.platform = "android";
    let resolveAndroid!: (value: unknown) => void;
    const androidCtx: PythonContext = { document: "/android.md", cell: "0", interpreter: "embedded" };
    nativeInvoke.mockClear();
    nativeInvoke.mockImplementation((command: string) => {
      if (command === "load_python_output") return Promise.resolve(null);
      if (command === "run_python") return new Promise(resolve => { resolveAndroid = resolve; });
      return Promise.resolve(null);
    });

    await act(async () => {
      root.render(<PythonCell source="print('android')" python="embedded" context={androidCtx} />);
    });
    await act(async () => {
      host.querySelector<HTMLButtonElement>("button.python-run")!.click();
    });
    expect(host.querySelector("button.python-stop")).toBeNull();
    const androidRunCall = nativeInvoke.mock.calls.find(([cmd]) => cmd === "run_python");
    expect(androidRunCall?.[1]).not.toHaveProperty("jobId");

    await act(async () => {
      resolveAndroid({ ok: true, stdout: "android\n", stderr: "", images: [] });
    });
    await act(async () => {
      root.unmount();
    });
  });

  it("unmounts prior PythonCell figures in MarkdownPreview when note code is replaced on Android before re-execution", async () => {
    delete document.documentElement.dataset.host;
    document.documentElement.dataset.platform = "android";

    const png1x1 =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2ZkAAAAASUVORK5CYII=";
    let resolve3dRun!: (value: unknown) => void;

    nativeInvoke.mockImplementation((command: string, args: Record<string, any> = {}) => {
      if (command === "load_python_output") {
        if (String(args.source || "").includes("sample_2d")) {
          return Promise.resolve({
            result: { ok: true, stdout: "", stderr: "", images: [png1x1] },
            provenance: { verified: true, document: "welcome", cell: "0", interpreter: "embedded" },
          });
        }
        return Promise.resolve(null);
      }
      if (command === "store_python_output" || command === "cache_python_output") {
        return Promise.resolve(true);
      }
      if (command === "run_python") {
        return new Promise(resolve => {
          resolve3dRun = resolve;
        });
      }
      return Promise.resolve(null);
    });

    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <MarkdownPreview
          markdown={"# Welcome\n\n```python\nprint('sample_2d')\n```\n"}
          documentPath="welcome"
          python="embedded"
          dark={false}
        />,
      );
    });
    expect(host.querySelector(".cell-output img")).not.toBeNull();

    // Replacing the note content with a new 3D matplotlib snippet must not keep the old figure mounted.
    await act(async () => {
      root.render(
        <MarkdownPreview
          markdown={"# Surface\n\n```python\nprint('plot_surface_3d')\n```\n"}
          documentPath="welcome"
          python="embedded"
          dark={false}
        />,
      );
    });
    expect(host.querySelector(".cell-output img")).toBeNull();

    const runBtn = host.querySelector<HTMLButtonElement>("button.python-run")!;
    await act(async () => {
      runBtn.click();
    });
    // Still null until the new 3D execution actually finishes.
    expect(host.querySelector(".cell-output img")).toBeNull();

    await act(async () => {
      resolve3dRun({
        ok: true,
        stdout: "",
        stderr: "",
        images: [png1x1],
        provenance: { verified: true, document: "welcome", cell: "0", interpreter: "embedded" },
      });
    });
    expect(host.querySelector(".cell-output img")).not.toBeNull();

    await act(async () => {
      root.unmount();
    });
  });
});
