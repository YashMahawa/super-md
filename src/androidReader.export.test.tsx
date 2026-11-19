// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { agentRevision } from "./agentOperations";

const { native, prepareMarkdown } = vi.hoisted(() => ({
  native: vi.fn(),
  prepareMarkdown: vi.fn(),
}));

vi.mock("./nativeBridge", () => ({ invoke: native }));
vi.mock("./markdownExport", () => ({ prepareMarkdownExport: prepareMarkdown }));

beforeEach(() => {
  vi.resetModules();
  native.mockReset();
  prepareMarkdown.mockReset();
  document.body.innerHTML = '<div id="root"></div>';
});

afterEach(() => {
  delete window.supermdLoad;
  delete window.supermdExportMarkdown;
  delete window.supermdAgentRequest;
  delete window.supermdAgentCompute;
});

it("forwards note Python path for ZIP export and supports live agent mdzip export", async () => {
  native.mockImplementation(async (command: string, args: unknown) => {
    if (command === "agent_export_native") return { jobId: "job-zip-1", status: "running", ...(args as object) };
    return null;
  });
  prepareMarkdown.mockResolvedValue({
    content: "# Study\n\n![Diagram](<image1.svg>)\n",
    assets: { "image1.svg": "data:image/svg+xml;base64,PHN2Zy8+" },
  });

  await import("./androidReader");
  await vi.waitFor(() => expect(typeof window.supermdLoad).toBe("function"));

  const content = "# Study\n\nLink [[Concept Note]]\n";
  window.supermdLoad!({
    id: "tab-1",
    content,
    path: "/vault/Study.md",
    mode: "reader",
    dark: false,
    fullscreen: false,
    font: "sans",
    size: 16,
    colors: { primary: "#386a57" },
    zoom: 100,
    python: "/opt/venv/bin/python",
  });
  await vi.waitFor(() => expect(document.querySelector(".android-document")).not.toBeNull());

  await window.supermdExportMarkdown!(true);
  expect(prepareMarkdown).toHaveBeenCalledWith(content, "/vault/Study.md", {
    compatible: true,
    python: "/opt/venv/bin/python",
  });
  expect(native).toHaveBeenCalledWith("export_markdown_native", {
    id: "tab-1",
    content: "# Study\n\n![Diagram](<image1.svg>)\n",
    assets: { "image1.svg": "data:image/svg+xml;base64,PHN2Zy8+" },
    archive: true,
  });

  prepareMarkdown.mockClear();
  const revision = await agentRevision(content);
  const reply = await new Promise<{ result: unknown; error: string }>((resolve) => {
    window.supermdAgentRequest!(
      {
        requestId: "req-mdzip-1",
        action: "export_document",
        tabId: "tab-1",
        format: "mdzip",
        filename: "Study",
        expectedRevision: revision,
      },
      (result, error) => resolve({ result, error }),
    );
  });

  expect(reply.error).toBe("");
  expect(prepareMarkdown).toHaveBeenCalledWith(content, "/vault/Study.md", {
    compatible: true,
    python: "/opt/venv/bin/python",
  });
  expect(reply.result).toMatchObject({
    jobId: "job-zip-1",
    status: "running",
    format: "mdzip",
    filename: "Study",
  });
});
