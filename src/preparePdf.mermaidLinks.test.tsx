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

import {
  MERMAID_SOURCE_LIMIT,
  isMermaidSourcePath,
  loadLocalMermaidSource,
  normalizeLocalMermaidSource,
  prepareMarkdownExport,
  validateLocalMermaidSourcePath,
} from "./markdownExport";
import { preparePdf } from "./preparePdf";

const SAMPLE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="220" height="90" viewBox="0 0 220 90"><rect width="220" height="90" fill="#ffffff"/><text x="20" y="50">Pipeline Ready</text></svg>';
const SAMPLE_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

afterEach(() => {
  invoke.mockReset();
  renderMermaidMock.mockReset();
});

describe("PDF preparation for relative .mmd and .mermaid image links", () => {
  it("classifies Mermaid paths from the query/fragment-stripped, safely decoded path component", () => {
    for (const nonMermaid of [
      "figures/photo.png?label=flow.mmd",
      "figures/photo.png#flow.mmd",
      "figures/photo.png?label=flow.mmd#diagram.mermaid",
      "figures/photo%2Epng?label=flow%2Emmd",
      `${SAMPLE_PNG}#flow.mmd`,
      "data:text/plain;base64,Z3JhcGggVEQ=#x.mmd",
      "https://trusted.example/figures/photo.png?label=flow.mmd",
      "https://cdn.mmd/photo.png",
      "https://cdn.mmd?file=1",
      "figures/photo.png%3Flabel=flow.mmd",
      "figures/photo.png%00.mmd",
      "figures/photo.png%2fflow.mmd",
      "figures/photo.png%5cflow.mmd",
      "figures/Flow%ZZ.mmd",
      "figures/Flow.mmd ",
      "figures/Flow.mmd%20",
      "figures/Flow.mmd.",
      "figures/Flow.mmd%2E",
      "figures/.mmd",
      ".mermaid",
    ]) {
      expect(isMermaidSourcePath(nonMermaid), nonMermaid).toBe(false);
    }

    for (const mermaidPath of [
      "diagrams/flow.mmd",
      "diagrams/sequence.mermaid",
      "diagrams/Flow%231.mmd",
      "diagrams/Flow%25Complete.mmd",
      "diagrams/Flow%231%2Emermaid?v=2#section",
      "diagrams/Flow%25Complete%2Emmd?preview=photo.png#top",
      "figures/Flow%2Emmd",
      "figures/Flow%2Emermaid",
      "figures/My%20Flow%2E%6D%6D%64?v=2#section",
      "diagrams/flow.mmd?preview=photo.png#thumb.png",
      "https://untrusted.example/diagram.mmd",
      "https://untrusted.example/diagrams/Flow%231.mmd",
      "https://trusted.example/diagrams/Flow%25Complete.mmd",
      "https://trusted.example/figures/Flow%2Emmd?v=1",
      "//untrusted.example/Flow%2Emermaid",
      "../outside.mmd",
      "../outside%2Emmd",
    ]) {
      expect(isMermaidSourcePath(mermaidPath), mermaidPath).toBe(true);
    }

    expect(validateLocalMermaidSourcePath("diagrams/Flow%231.mmd")).toBe("diagrams/Flow#1.mmd");
    expect(validateLocalMermaidSourcePath("diagrams/Flow%25Complete.mmd")).toBe("diagrams/Flow%Complete.mmd");
    expect(validateLocalMermaidSourcePath("diagrams/Flow%231%2Emermaid?v=2#section")).toBe(
      "diagrams/Flow#1.mermaid",
    );
    expect(validateLocalMermaidSourcePath("diagrams/Flow%25Complete%2Emmd?v=2#section")).toBe(
      "diagrams/Flow%Complete.mmd",
    );
    expect(normalizeLocalMermaidSource("diagrams/Flow#1.mmd")).toBe("diagrams/Flow%231.mmd");
    expect(normalizeLocalMermaidSource("diagrams/Flow%Complete.mmd")).toBe("diagrams/Flow%25Complete.mmd");
    expect(normalizeLocalMermaidSource("figures/My Flow.mermaid")).toBe("figures/My%20Flow.mermaid");
  });

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

  it("keeps ordinary PNGs with .mmd/.mermaid query or fragment suffixes on image handlers and routes encoded Mermaid paths to load_text_asset", async () => {
    invoke.mockImplementation(
      async (command: string, args: { documentPath?: string; source?: string; url?: string }) => {
        if (command === "load_asset") {
          if (
            args.source === "figures/photo.png?label=flow.mmd" ||
            args.source === "figures/photo.png#flow.mmd" ||
            args.source === "figures/photo%2Epng?label=flow%2Emmd"
          ) {
            return SAMPLE_PNG;
          }
        }
        if (command === "fetch_resource" && args.url === "https://trusted.example/photo.png?label=flow.mmd") {
          return { body: SAMPLE_PNG };
        }
        if (command === "load_text_asset") {
          if (args.source === "figures/Flow.mmd") {
            return { text: "flowchart TD\n  Encoded --> Diagram\n" };
          }
          if (args.source === "figures/My%20Flow.mermaid") {
            return "sequenceDiagram\n  Alice->>Bob: Encoded .mermaid\n";
          }
          if (args.source === "diagrams/Flow%231.mmd") {
            return "flowchart LR\n  HashNode[\"Flow#1\"] --> Verified\n";
          }
          if (args.source === "diagrams/Flow%25Complete.mmd") {
            return { text: "flowchart TD\n  PctNode[\"100% Complete\"] --> Verified\n" };
          }
        }
        throw new Error(`Unexpected native call: ${command} ${JSON.stringify(args)}`);
      },
    );
    renderMermaidMock.mockResolvedValue(SAMPLE_SVG);

    const markdown = [
      "![Query PNG](figures/photo.png?label=flow.mmd)",
      "",
      "![Fragment PNG](figures/photo.png#flow.mmd)",
      "",
      '<img src="figures/photo%2Epng?label=flow%2Emmd" alt="Encoded PNG" width="180" />',
      "",
      `![Inline PNG](${SAMPLE_PNG}#flow.mmd)`,
      "",
      '<img src="https://trusted.example/photo.png?label=flow.mmd" alt="Remote PNG" width="200" />',
      "",
      "![Encoded Mermaid](figures/Flow%2Emmd)",
      "",
      "![Same Mermaid Unencoded](figures/Flow.mmd?preview=photo.png)",
      "",
      "![Encoded Spaced Mermaid](figures/My%20Flow%2Emermaid?theme=neutral#top)",
      "",
      "![Hash Filename](diagrams/Flow%231.mmd)",
      "",
      "![[diagrams/Flow%231.mmd|260]]",
      "",
      '<img src="diagrams/Flow%25Complete.mmd" alt="Percent Filename" width="220" />',
      "",
      "![Percent Alias](diagrams/Flow%25Complete%2Emmd?preview=photo.png#top)",
      "",
    ].join("\n");

    const prepared = await preparePdf(markdown, "/notes/mixed.md", "embedded", {
      trustedImageHosts: ["trusted.example"],
    });

    const assetCalls = invoke.mock.calls.filter(([cmd]) => cmd === "load_asset").map(([, a]) => a.source);
    expect(assetCalls).toEqual([
      "figures/photo.png?label=flow.mmd",
      "figures/photo.png#flow.mmd",
      "figures/photo%2Epng?label=flow%2Emmd",
    ]);

    const fetchCalls = invoke.mock.calls.filter(([cmd]) => cmd === "fetch_resource").map(([, a]) => a.url);
    expect(fetchCalls).toEqual(["https://trusted.example/photo.png?label=flow.mmd"]);

    // Aliases of the same local file share one single-encoded load_text_asset call.
    const textCalls = invoke.mock.calls.filter(([cmd]) => cmd === "load_text_asset").map(([, a]) => a.source);
    expect(textCalls).toEqual([
      "figures/Flow.mmd",
      "figures/My%20Flow.mermaid",
      "diagrams/Flow%231.mmd",
      "diagrams/Flow%25Complete.mmd",
    ]);
    expect(renderMermaidMock).toHaveBeenCalledTimes(7);

    expect(prepared.content).toMatch(/!\[Query PNG\]\(asset-\d+\.png\)/);
    expect(prepared.content).toMatch(/!\[Fragment PNG\]\(asset-\d+\.png\)/);
    expect(prepared.content).toMatch(/!\[Encoded PNG\]\(asset-\d+\.png\)\{width=180\}/);
    expect(prepared.content).toMatch(/!\[Inline PNG\]\(asset-\d+\.png\)/);
    expect(prepared.content).toMatch(/!\[Remote PNG\]\(asset-\d+\.png\)\{width=200\}/);
    expect(prepared.content).toMatch(/!\[Encoded Mermaid\]\(diagram-\d+\.svg\)/);
    expect(prepared.content).toMatch(/!\[Same Mermaid Unencoded\]\(diagram-\d+\.svg\)/);
    expect(prepared.content).toMatch(/!\[Encoded Spaced Mermaid\]\(diagram-\d+\.svg\)/);
    expect(prepared.content).toMatch(/!\[Hash Filename\]\(diagram-\d+\.svg\)/);
    expect(prepared.content).toMatch(/!\[diagrams\/Flow%231\.mmd\]\(diagram-\d+\.svg\)\{width=260\}/);
    expect(prepared.content).toMatch(/!\[Percent Filename\]\(diagram-\d+\.svg\)\{width=220\}/);
    expect(prepared.content).toMatch(/!\[Percent Alias\]\(diagram-\d+\.svg\)/);

    // Verify shared companion Markdown export also routes ordinary PNGs and '#', '%', and encoded Mermaid paths cleanly.
    invoke.mockClear();
    const mdExport = await prepareMarkdownExport(
      [
        "![Query PNG](figures/photo.png?label=flow.mmd)",
        "[PNG Link](figures/photo.png#flow.mmd)",
        "![Encoded Mermaid](figures/Flow%2Emmd)",
        "[Encoded Mermaid Link](figures/My%20Flow%2Emermaid?v=1)",
        "![Hash Mermaid](diagrams/Flow%231.mmd)",
        "[Hash Mermaid Link](diagrams/Flow%231%2Emmd?v=1#top)",
        "![Percent Mermaid](diagrams/Flow%25Complete.mmd)",
        "[Percent Mermaid Link](diagrams/Flow%25Complete%2Emmd#sec)",
      ].join("\n\n"),
      "/notes/mixed.md",
    );
    expect(mdExport.assets).toEqual({ "figures/photo.png": SAMPLE_PNG });
    expect(
      invoke.mock.calls.filter(([cmd]) => cmd === "load_text_asset").map(([, a]) => a.source),
    ).toEqual([
      "figures/Flow.mmd",
      "figures/My%20Flow.mermaid",
      "diagrams/Flow%231.mmd",
      "diagrams/Flow%25Complete.mmd",
    ]);
    expect(mdExport.content).toContain("![Query PNG](figures/photo.png?label=flow.mmd)");
    expect(mdExport.content).toContain("[PNG Link](figures/photo.png#flow.mmd)");
    expect(mdExport.content).toContain("```mermaid\nflowchart TD\n  Encoded --> Diagram\n```");
    expect(mdExport.content).toContain("```mermaid\nsequenceDiagram\n  Alice->>Bob: Encoded .mermaid\n```");
    expect(mdExport.content.match(/```mermaid\nflowchart LR\n  HashNode\["Flow#1"\] --> Verified\n```/g)).toHaveLength(2);
    expect(mdExport.content.match(/```mermaid\nflowchart TD\n  PctNode\["100% Complete"\] --> Verified\n```/g)).toHaveLength(
      2,
    );
  });

  it("enforces note-relative path checks, unsaved-note guard, and remote-image consent without invoking native loaders", async () => {
    invoke.mockRejectedValue(new Error("Should never invoke native loader"));

    // 1. Unsaved note cannot resolve relative .mmd / .mermaid files (including percent-encoded extensions).
    await expect(preparePdf("![Flow](diagrams/flow.mmd)", null)).rejects.toThrow(
      /Save your note before exporting relative Mermaid diagram diagrams\/flow\.mmd/i,
    );
    await expect(preparePdf("![Flow](figures/Flow%2Emmd)", null)).rejects.toThrow(
      /Save your note before exporting relative Mermaid diagram figures\/Flow%2Emmd/i,
    );

    // 2. Traversal, absolute, Windows-drive, device-name, and file: Mermaid paths are rejected before any IPC.
    const rejectedMermaidPaths = [
      "../outside.mmd",
      "../outside%2Emmd",
      "diagrams/../../outside.mermaid",
      "diagrams/%2e%2e/%2e%2e/outside.mmd",
      "/etc/secret.mmd",
      "file:///etc/secret.mmd",
      "C:/secret/flow.mmd",
      "CON.mmd",
    ];
    for (const bad of rejectedMermaidPaths) {
      await expect(preparePdf(`![Bad](<${bad}>)`, "/notes/check.md")).rejects.toThrow(
        /Cannot safely resolve Mermaid source/i,
      );
    }

    // Unsafe-encoded, backslash, NUL, malformed-escape, trailing-space/dot, and data: inputs are excluded from Mermaid classification and rejected by loadLocalMermaidSource before IPC.
    const unsafeNonMermaidInputs = [
      "%2fetc/secret.mmd",
      "\\windows\\secret.mermaid",
      "diagrams%5csecret.mmd",
      "diagrams%2fsecret.mmd",
      "diagrams/bad%00name.mmd",
      "figures/Flow%ZZ.mmd",
      "figures/Flow.mmd ",
      "data:text/plain;base64,Z3JhcGggVEQ=#x.mmd",
    ];
    for (const bad of unsafeNonMermaidInputs) {
      expect(isMermaidSourcePath(bad), bad).toBe(false);
      await expect(loadLocalMermaidSource("/notes/check.md", bad)).rejects.toThrow(
        /Cannot safely resolve Mermaid source|Mermaid source must be a local \.mmd or \.mermaid file/i,
      );
    }

    // 3. Remote .mmd / .mermaid URLs (including percent-encoded extensions) enforce remote-image consent first and never enter load_text_asset.
    const unconsentedRemoteInputs = [
      "![Remote](https://untrusted.example/diagram.mmd)",
      "![RemoteEncoded](https://untrusted.example/figures/Flow%2Emmd)",
      "![RemoteHash](https://untrusted.example/diagrams/Flow%231.mmd)",
      "![RemotePercent](https://untrusted.example/diagrams/Flow%25Complete.mmd)",
      "![Remote](http://untrusted.example/diagram.mermaid)",
      "![ProtocolRel](//untrusted.example/diagram.mmd)",
      "![ProtocolRelEncoded](//untrusted.example/Flow%2Emermaid)",
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

    for (const trustedMermaid of [
      "https://trusted.example/diagram.mmd",
      "https://trusted.example/figures/Flow%2Emmd?v=1",
      "https://trusted.example/diagrams/Flow%231.mmd",
      "https://trusted.example/diagrams/Flow%25Complete.mmd",
    ]) {
      await expect(
        preparePdf(`![TrustedHost](${trustedMermaid})`, "/notes/check.md", "embedded", {
          trustedImageHosts: ["trusted.example"],
        }),
      ).rejects.toThrow(/Mermaid source must be a local \.mmd or \.mermaid file/i);
      await expect(loadLocalMermaidSource("/notes/check.md", trustedMermaid)).rejects.toThrow(
        /Mermaid source must be a local \.mmd or \.mermaid file/i,
      );
    }

    expect(invoke).not.toHaveBeenCalled();
    expect(renderMermaidMock).not.toHaveBeenCalled();
  });

  it("propagates AbortSignal cancellation across linked Mermaid loading and rendering without stale progress", async () => {
    const preCancelled = new AbortController();
    preCancelled.abort();
    await expect(
      preparePdf("![Encoded](figures/Flow%2Emmd)", "/notes/cancel.md", "embedded", {
        signal: preCancelled.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(invoke).not.toHaveBeenCalled();

    let resolveLoad!: (value: string) => void;
    invoke.mockImplementationOnce(
      () =>
        new Promise<string>(resolve => {
          resolveLoad = resolve;
        }),
    );
    const inFlight = new AbortController();
    const onProgress = vi.fn();
    const running = preparePdf("![HashEncoded](diagrams/Flow%231.mmd)", "/notes/cancel.md", "embedded", {
      signal: inFlight.signal,
      onProgress,
    });
    expect(invoke).toHaveBeenCalledWith("load_text_asset", {
      documentPath: "/notes/cancel.md",
      source: "diagrams/Flow%231.mmd",
    });
    inFlight.abort();
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    const progressCallsAtAbort = onProgress.mock.calls.length;
    resolveLoad("flowchart LR\n  A --> B\n");
    await Promise.resolve();
    await Promise.resolve();
    expect(renderMermaidMock).not.toHaveBeenCalled();
    expect(onProgress).toHaveBeenCalledTimes(progressCallsAtAbort);

    invoke.mockResolvedValueOnce("flowchart LR\n  A --> B\n");
    let resolveRender!: (value: string) => void;
    renderMermaidMock.mockImplementationOnce(
      () =>
        new Promise<string>(resolve => {
          resolveRender = resolve;
        }),
    );
    const duringRender = new AbortController();
    const renderRun = preparePdf("![PctEncoded](diagrams/Flow%25Complete.mmd)", "/notes/cancel.md", "embedded", {
      signal: duringRender.signal,
    });
    await vi.waitFor(() =>
      expect(renderMermaidMock).toHaveBeenCalledWith(
        "flowchart LR\n  A --> B\n",
        false,
        duringRender.signal,
      ),
    );
    expect(invoke).toHaveBeenLastCalledWith("load_text_asset", {
      documentPath: "/notes/cancel.md",
      source: "diagrams/Flow%25Complete.mmd",
    });
    duringRender.abort();
    await expect(renderRun).rejects.toMatchObject({ name: "AbortError" });
    resolveRender(SAMPLE_SVG);
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
