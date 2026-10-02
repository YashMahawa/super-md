// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const fallback = vi.hoisted(() => vi.fn(async () => "fallback"));
vi.mock("@tauri-apps/api/core", () => ({ invoke: fallback }));
import { invoke } from "./nativeBridge";

beforeEach(() => { vi.useFakeTimers(); window.SuperMD = { post: vi.fn() }; });
afterEach(() => { delete window.SuperMD; vi.clearAllTimers(); vi.useRealTimers(); fallback.mockClear(); });
describe("native request lifecycle", () => {
  it("correlates concurrent replies and ignores duplicate or unknown replies", async () => {
    const a = invoke("read", { path: "A" }); const b = invoke("read", { path: "B" });
    const calls = vi.mocked(window.SuperMD!.post).mock.calls;
    expect(calls[0][0]).not.toBe(calls[1][0]); expect(calls[0][2]).toBe('{"path":"A"}');
    window.supermdReply!(calls[1][0], "B", null); window.supermdReply!(calls[0][0], "A", null);
    window.supermdReply!(calls[0][0], "wrong", null); window.supermdReply!("unknown", null, "wrong");
    await expect(a).resolves.toBe("A"); await expect(b).resolves.toBe("B"); expect(vi.getTimerCount()).toBe(0);
  });
  it("rejects native errors and immediately cleans up a throwing transport", async () => {
    const result = invoke("save"); const rejected = expect(result).rejects.toThrow("Permission denied");
    window.supermdReply!(vi.mocked(window.SuperMD!.post).mock.calls[0][0], null, "Permission denied"); await rejected;
    window.SuperMD!.post = () => { throw new Error("Disconnected"); };
    await expect(invoke("read")).rejects.toThrow("Disconnected"); expect(vi.getTimerCount()).toBe(0);
  });
  it.each([["read", 60000], ["run_python", 120000], ["export_pdf_native", 180000]])("bounds %s without accepting late replies", async (command, timeout) => {
    const result = invoke(command); const rejected = expect(result).rejects.toThrow(`${command} timed out`);
    const id = vi.mocked(window.SuperMD!.post).mock.calls[0][0];
    await vi.advanceTimersByTimeAsync(Number(timeout) - 1); expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1); await rejected; window.supermdReply!(id, "late", null); expect(vi.getTimerCount()).toBe(0);
  });
  it("keeps the legacy host fallback", async () => {
    delete window.SuperMD; await expect(invoke("doctor", { detail: true })).resolves.toBe("fallback");
    expect(fallback).toHaveBeenCalledWith("doctor", { detail: true });
  });
});
