import { afterEach, describe, expect, it, vi } from "vitest";

const { nativeInvoke } = vi.hoisted(() => ({ nativeInvoke: vi.fn() }));
vi.mock("./nativeBridge", () => ({ invoke: nativeInvoke }));
import {
  cachedPythonOutput,
  exportRenderedViews,
  importRenderedViews,
  loadPythonOutput,
  pythonResults,
  pythonStored,
  storePythonOutput,
} from "./renderedOutputs";
import type { PythonContext, PythonResult } from "./types";

afterEach(() => { nativeInvoke.mockReset(); pythonResults.clear(); });

const context = (document: string, cell = "0", interpreter = "embedded"): PythonContext => ({ document, cell, interpreter });
const result = (stdout = "ok"): PythonResult => ({ ok: true, stdout, stderr: "", images: [] });
const verified = (ctx: PythonContext, stdout: string): PythonResult => ({
  ...result(stdout),
  provenance: { verified: true, document: ctx.document, cell: ctx.cell, interpreter: "python-3.13", savedAt: "2026-01-01T00:00:00.000Z" },
});

describe("Python output provenance and scoping", () => {
  it("isolates identical code across documents, duplicate cells, and interpreter settings", async () => {
    const source = "print(42)";
    const variants = [context("/a.md", "0", "embedded"), context("/a.md", "1", "embedded"), context("/b.md", "0", "embedded"), context("/a.md", "0", "python-3.12")];
    nativeInvoke.mockImplementation(async (_command: string, args: { context: PythonContext }) => verified(args.context, JSON.stringify(args.context)));
    const outputs = await Promise.all(variants.map(ctx => loadPythonOutput(source, ctx)));
    expect(nativeInvoke).toHaveBeenCalledTimes(4);
    expect(outputs.map(output => output?.stdout)).toEqual(variants.map(ctx => JSON.stringify(ctx)));
    expect(variants.map(ctx => cachedPythonOutput(source, ctx)?.stdout)).toEqual(variants.map(ctx => JSON.stringify(ctx)));
  });

  it("deduplicates concurrent loads for one scoped key and accepts wrapper or flattened results", async () => {
    const ctx = context("/scoped.md");
    let finish!: (value: unknown) => void;
    nativeInvoke.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const first = loadPythonOutput("print('one')", ctx);
    const second = loadPythonOutput("print('one')", ctx);
    await Promise.resolve();
    expect(nativeInvoke).toHaveBeenCalledTimes(1);
    finish({ ...result("one"), provenance: { verified: true, document: ctx.document, cell: ctx.cell, interpreter: "python-3.13" } });
    await expect(Promise.all([first, second])).resolves.toEqual([expect.objectContaining({ stdout: "one", provenance: expect.objectContaining({ verified: true }) }), expect.objectContaining({ stdout: "one", provenance: expect.objectContaining({ verified: true }) })]);

    const wrapped = context("/wrapped.md");
    nativeInvoke.mockResolvedValueOnce({ result: result("wrapped"), provenance: { verified: true, document: wrapped.document, cell: wrapped.cell, interpreter: "python-3.13" } });
    await expect(loadPythonOutput("print('wrapped')", wrapped)).resolves.toEqual(expect.objectContaining({ stdout: "wrapped", provenance: expect.objectContaining({ verified: true }) }));
  });

  it("preserves legacy disk output as visibly unverified and never stores it as scoped verified output", async () => {
    const ctx = context("/legacy.md");
    nativeInvoke.mockResolvedValueOnce(result("old"));
    const output = await loadPythonOutput("print('old')", ctx);
    expect(output?.provenance).toMatchObject({ verified: false });
    expect(pythonStored("print('old')", ctx)).toBe(true);
    expect(await storePythonOutput("print('old')", output!, ctx)).toBe(false);
    expect(nativeInvoke).toHaveBeenCalledTimes(1);
  });

  it("keeps source-only rendered-view imports in the legacy namespace", () => {
    const source = "print('legacy import')";
    importRenderedViews(source, { values: [], zooms: [], centers: [], grids: [], python: [[source, result("legacy")]], pythonScoped: [] });
    expect(cachedPythonOutput(source)?.provenance).toMatchObject({ verified: false });
    expect(cachedPythonOutput(source, context("/new.md"))).toBeUndefined();
    expect(exportRenderedViews(source).pythonScoped).toEqual([]);
  });

  it("round-trips only context-bearing verified outputs", () => {
    const source = "print('scoped export')", ctx = context("/export.md");
    importRenderedViews(source, { values: [], zooms: [], centers: [], grids: [], python: [], pythonScoped: [[source, ctx, verified(ctx, "saved")]] });
    expect(exportRenderedViews(source).pythonScoped).toHaveLength(1);
    expect(cachedPythonOutput(source, ctx)?.provenance?.verified).toBe(true);
  });

  it("does not execute Python when a cache is missing or unavailable", async () => {
    nativeInvoke.mockRejectedValueOnce(new Error("offline"));
    await expect(loadPythonOutput("print('never run')", context("/missing.md"))).resolves.toBeUndefined();
    expect(nativeInvoke).toHaveBeenCalledTimes(1);
    expect(nativeInvoke).not.toHaveBeenCalledWith("run_python", expect.anything());
  });
});
