// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

const { invoke, renderMermaidMock } = vi.hoisted(() => ({
  invoke: vi.fn(),
  renderMermaidMock: vi.fn(),
}));

vi.mock("./nativeBridge", () => ({ invoke }));
vi.mock("./mermaidRenderer", async importOriginal => {
  const actual = await importOriginal<typeof import("./mermaidRenderer")>();
  return {
    ...actual,
    renderMermaid: (...args: Parameters<typeof actual.renderMermaid>) =>
      renderMermaidMock(...args),
  };
});

import { MERMAID_SOURCE_LIMIT } from "./markdownExport";
import { preparePdf } from "./preparePdf";

const SAMPLE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="220" height="90" viewBox="0 0 220 90"><rect width="220" height="90" fill="#ffffff"/><text x="20" y="50">Pipeline Ready</text></svg>';

afterEach(() => {
  invoke.mockReset();
  renderMermaidMock.mockReset();
});

describe("PDF preparation for relative .mmd and .mermaid image links", () => {
  it("loads relative .mmd and .mermaid image links via load_text_asset, deduplicates sources, passes text to renderMermaid, and keeps prose links untouched", async () => {
    invoke.mockImplementation(async (command: string, args: { documentPath?: string; source?: string }) => {
      if (command === "load_text_asset" && args.source === "diagrams/flow.mmd") {
        return { text: "flowchart LR\n  Ingest --> Verify\n" };
      }
      if (command === "load_text_asset" && args.source === "diagrams/sequence.mermaid") {
        return "sequenceDiagram\n  Client->>Server: Request\n";
      }
      throw new Error(`Unexpected native call: ${command} ${JSON.stringify(args)}`);
    });
    renderMermaidMock.mockResolvedValue(SAMPLE_SVG);

    const markdown = [
      "# Architecture",
      "",
      '![Ingestion Flow](diagrams/flow.mmd "Primary pipeline")',
      "",
      "![[diagrams/flow.mmd|300]]",
      "",
      "![Sequence Overview][seq]",
      "",
      '<img src="diagrams/sequence.mermaid" alt="Sized Sequence" width="240px" />',
      "",
      "```smd-steps",
      JSON.stringify({
        title: "Walkthrough",
        steps: [
          { label: "Stage 1", image: "diagrams/flow.mmd", description: "Linked Mermaid step" },
          { label: "Stage 2", markdown: "![Step Sequence](diagrams/sequence.mermaid)" },
        ],
      }),
      "```",
      "",
      "See [raw diagram source](diagrams/flow.mmd) for details.",
      "",
      '[seq]: diagrams/sequence.mermaid "Protocol caption"',
      "",
    ].join("\n");

    const prepared = await preparePdf(markdown, "/notes/system.md");

    // Top-level preparePdf deduplicates diagrams/flow.mmd and diagrams/sequence.mermaid (2 loads),
    // plus 2 loads inside the isolated smd-steps sub-passes; load_asset / fetch_resource are never called.
    expect(invoke.mock.calls.every(([cmd]) => cmd === "load_text_asset")).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(4);
    expect(invoke).toHaveBeenCalledWith("load_text_asset", {
      documentPath: "/notes/system.md",
      source: "diagrams/flow.mmd",
    });
    expect(invoke).toHaveBeenCalledWith("load_text_asset", {
      documentPath: "/notes/system.md",
      source: "diagrams/sequence.mermaid",
    });
    expect(renderMermaidMock).toHaveBeenCalledWith(
      "flowchart LR\n  Ingest --> Verify\n",
      false,
      undefined,
    );
    expect(renderMermaidMock).toHaveBeenCalledWith(
      "sequenceDiagram\n  Client->>Server: Request\n",
      false,
      undefined,
    );

    expect(prepared.content).toMatch(/!\[Ingestion Flow\]\(diagram-\d+\.svg "Primary pipeline"\)/);
    expect(prepared.content).toMatch(/!\[diagrams\/flow\.mmd\]\(diagram-\d+\.svg\)\{width=300\}/);
    expect(prepared.content).toMatch(/!\[Sequence Overview\]\(diagram-\d+\.svg "Protocol caption"\)/);
    expect(prepared.content).toMatch(/!\[Sized Sequence\]\(diagram-\d+\.svg\)\{width=240px\}/);
    expect(prepared.content).toContain("See [raw diagram source](diagrams/flow.mmd) for details.");

    const gridMatch = /```smd-step-grid\n([\s\S]*?)\n```/.exec(prepared.content);
    expect(gridMatch).not.toBeNull();
    const grid = JSON.parse(gridMatch![1]);
    expect(grid.steps[0].image).toMatch(/^step-\d+-diagram-1\.svg$/);
    expect(grid.steps[1].markdown).toMatch(/!\[Step Sequence\]\(step-\d+-diagram-1\.svg\)/);

    expect(Object.keys(prepared.assets)).toHaveLength(6);
    for (const encoded of Object.values(prepared.assets)) {
      const svg = atob(encoded);
      expect(svg).toContain("<svg");
      expect(svg).toContain("Pipeline Ready");
    }
  });

  it("enforces note-relative path checks, unsaved-note guard, and remote-image consent without invoking native loaders", async () => {
    invoke.mockRejectedValue(new Error("Should never invoke native loader"));

    // 1. Unsaved note cannot resolve relative .mmd / .mermaid files.
    await expect(preparePdf("![Flow](diagrams/flow.mmd)", null)).rejects.toThrow(
      /Save your note before exporting relative Mermaid diagram diagrams\/flow\.mmd/i,
    );

    // 2. Traversal, absolute, Windows-drive, device-name, backslash, NUL, file:, and data: paths are rejected before IPC.
    const rejectedPaths = [
      "../outside.mmd",
      "diagrams/../../outside.mermaid",
      "diagrams/%2e%2e/%2e%2e/outside.mmd",
      "/etc/secret.mmd",
      "\\windows\\secret.mermaid",
      "diagrams%5csecret.mmd",
      "file:///etc/secret.mmd",
      "C:/secret/flow.mmd",
      "CON.mmd",
      "diagrams/bad%00name.mmd",
      "data:text/plain;base64,Z3JhcGggVEQ=#x.mmd",
    ];
    for (const bad of rejectedPaths) {
      await expect(preparePdf(`![Bad](<${bad}>)`, "/notes/check.md")).rejects.toThrow(
        /Cannot safely resolve Mermaid source|Mermaid source must be a local \.mmd or \.mermaid file/i,
      );
    }

    // 3. Remote .mmd / .mermaid URLs enforce remote-image consent first, and remain local-only even on trusted image hosts.
    const unconsentedRemoteInputs = [
      "![Remote](https://untrusted.example/diagram.mmd)",
      "![Remote](http://untrusted.example/diagram.mermaid)",
      "![ProtocolRel](//untrusted.example/diagram.mmd)",
      '<img src="https://untrusted.example/html.mmd" width="200">',
      "![Credentialed](https://user:pass@trusted.example/diagram.mmd)",
    ];
    for (const input of unconsentedRemoteInputs) {
      await expect(
        preparePdf(input, "/notes/check.md", "embedded", {
          trustedImageHosts: ["trusted.example"],
        }),
      ).rejects.toThrow(/requires explicit consent in the reader before exporting PDF/i);
    }

    await expect(
      preparePdf("![TrustedHost](https://trusted.example/diagram.mmd)", "/notes/check.md", "embedded", {
        trustedImageHosts: ["trusted.example"],
      }),
    ).rejects.toThrow(/Mermaid source must be a local \.mmd or \.mermaid file/i);

    expect(invoke).not.toHaveBeenCalled();
    expect(renderMermaidMock).not.toHaveBeenCalled();
  });

  it("surfaces readable errors for missing, rejected, oversized, empty, and invalid Mermaid source files", async () => {
    // Missing file
    invoke.mockRejectedValueOnce(new Error("No such file or directory"));
    await expect(preparePdf("![Missing](diagrams/missing.mmd)", "/notes/errors.md")).rejects.toThrow(
      "Cannot load Mermaid source diagrams/missing.mmd: No such file or directory",
    );

    // Host-rejected outside-root / symlink file
    invoke.mockRejectedValueOnce(new Error("Diagram source symlink paths are not allowed"));
    await expect(preparePdf("![Symlink](diagrams/linked.mermaid)", "/notes/errors.md")).rejects.toThrow(
      "Cannot load Mermaid source diagrams/linked.mermaid: Diagram source symlink paths are not allowed",
    );

    // Oversized file (> 2,000,000 chars)
    invoke.mockResolvedValueOnce("x".repeat(MERMAID_SOURCE_LIMIT + 1));
    await expect(preparePdf("![Huge](diagrams/huge.mmd)", "/notes/errors.md")).rejects.toThrow(
      "Mermaid source is unavailable or too large: diagrams/huge.mmd",
    );

    // Empty / whitespace-only file
    invoke.mockResolvedValueOnce("   \n\t  ");
    await expect(preparePdf("![Blank](diagrams/empty.mmd)", "/notes/errors.md")).rejects.toThrow(
      "Mermaid source is empty: diagrams/empty.mmd",
    );

    // Invalid Mermaid syntax
    invoke.mockResolvedValueOnce("flowchart TD\n  A --> ???\n");
    renderMermaidMock.mockRejectedValueOnce(new Error("Parse error on line 2"));
    await expect(preparePdf("![Broken](diagrams/broken.mmd)", "/notes/errors.md")).rejects.toThrow(
      "Invalid Mermaid diagram in diagrams/broken.mmd: Parse error on line 2",
    );
  });
});
