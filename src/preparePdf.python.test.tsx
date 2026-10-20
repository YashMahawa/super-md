import { afterEach, expect, it, vi } from "vitest";

const { pythonOutput, invoke } = vi.hoisted(() => ({ pythonOutput: vi.fn(), invoke: vi.fn() }));
vi.mock("./renderedOutputs", () => ({ pythonOutput }));
vi.mock("./nativeBridge", () => ({ invoke }));
import { preparePdf } from "./preparePdf";

afterEach(() => { pythonOutput.mockReset(); invoke.mockReset(); });

it("uses the same source-based duplicate ordinals for PDF Python output lookup", async () => {
  const markdown = "```python\nprint(42)\n```\n\n```py\nprint(42)\n```";
  pythonOutput.mockResolvedValue(undefined);
  const output = await preparePdf(markdown, "/notes/a.md", "python-3.12");
  expect(pythonOutput.mock.calls).toEqual([
    ["print(42)", { document: "/notes/a.md", cell: "0", interpreter: "python-3.12" }],
    ["print(42)", { document: "/notes/a.md", cell: "1", interpreter: "python-3.12" }],
  ]);
  expect(output.content).toContain("```python");
  expect(invoke).not.toHaveBeenCalledWith("run_python", expect.anything());
});

it("keeps standalone PDF lookup on the legacy no-context API", async () => {
  pythonOutput.mockResolvedValue(undefined);
  await preparePdf("```python\nprint('legacy')\n```", null);
  expect(pythonOutput).toHaveBeenCalledWith("print('legacy')", undefined);
});

it('labels unverified saved results in exports without rerunning or dropping them',async()=>{
  pythonOutput.mockResolvedValue({ok:true,stdout:'legacy result',stderr:'',images:[],provenance:{verified:false,reason:'Legacy saved output'}});
  const output=await preparePdf("```Python\nprint('legacy')\n```",'/legacy.md');
  expect(output.content).toContain('Unverified saved output');
  expect(output.content).toContain('legacy result');
  expect(output.content).toContain("print('legacy')");
  expect(invoke).not.toHaveBeenCalledWith('run_python',expect.anything());
});
