import { afterEach, expect, it, vi } from "vitest";

const { invoke, renderMermaid } = vi.hoisted(() => ({ invoke: vi.fn(), renderMermaid: vi.fn() }));
vi.mock("./nativeBridge", () => ({ invoke }));
vi.mock("./mermaidRenderer", () => ({ renderMermaid }));
import { preparePdf } from "./preparePdf";

const image = "data:image/png;base64,AA==";
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

afterEach(() => { invoke.mockReset(); renderMermaid.mockReset(); });

it("rejects an already-cancelled preparation before native asset work starts", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(preparePdf("![image](photo.png)", "/notes/a.md", "embedded", { signal: controller.signal }))
    .rejects.toMatchObject({ name: "AbortError" });
  expect(invoke).not.toHaveBeenCalled();
});

it("does not start queued asset tasks after cancellation", async () => {
  const pending = Array.from({ length: 4 }, () => deferred<string>());
  invoke.mockImplementation(() => pending[invoke.mock.calls.length - 1].promise);
  const markdown = Array.from({ length: 5 }, (_, index) => `![image](photo-${index}.png)`).join("\n\n");
  const controller = new AbortController();
  const preparation = preparePdf(markdown, "/notes/a.md", "embedded", { signal: controller.signal });
  expect(invoke).toHaveBeenCalledTimes(4);
  controller.abort();
  await expect(preparation).rejects.toMatchObject({ name: "AbortError" });
  for (const item of pending) item.resolve(image);
  await Promise.resolve();
  expect(invoke).toHaveBeenCalledTimes(4);
});

it("checks cancellation when an asynchronous asset request returns", async () => {
  const pending = deferred<string>();
  invoke.mockReturnValue(pending.promise);
  const controller = new AbortController();
  const preparation = preparePdf("![image](photo.png)", "/notes/a.md", "embedded", { signal: controller.signal });
  pending.resolve(image);
  controller.abort();
  await expect(preparation).rejects.toMatchObject({ name: "AbortError" });
});

it("does not report stale completion progress after the caller is cancelled", async () => {
  const pending = deferred<string>();
  invoke.mockReturnValue(pending.promise);
  const controller = new AbortController();
  const onProgress = vi.fn();
  const preparation = preparePdf("![image](photo.png)", "/notes/a.md", "embedded", { signal: controller.signal, onProgress });
  controller.abort();
  await expect(preparation).rejects.toMatchObject({ name: "AbortError" });
  const progressAtCancellation = onProgress.mock.calls.length;
  pending.resolve(image);
  await Promise.resolve();
  await Promise.resolve();
  expect(onProgress).toHaveBeenCalledTimes(progressAtCancellation);
  expect(onProgress).not.toHaveBeenCalledWith({ phase: "assets+diagrams", completed: 1, total: 1 });
});

it("forwards cancellation to Mermaid without invoking it for pre-cancelled work", async () => {
  renderMermaid.mockResolvedValue("<svg />");
  const controller = new AbortController();
  const preparation = preparePdf("```mermaid\ngraph TD; A-->B\n```", "/notes/a.md", "embedded", { signal: controller.signal });
  expect(renderMermaid).toHaveBeenCalledWith("graph TD; A-->B", false, controller.signal);
  controller.abort();
  await expect(preparation).rejects.toMatchObject({ name: "AbortError" });
});
