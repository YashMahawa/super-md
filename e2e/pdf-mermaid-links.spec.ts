import { expect, test } from "@playwright/test";

test("Chromium PDF preparation renders relative .mmd and .mermaid image links to SVG diagrams and reports readable errors for missing or rejected files", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const mermaidFiles: Record<string, string> = {
      "diagrams/architecture.mmd": [
        "flowchart LR",
        '  Reader["Note Reader"] --> Loader["load_text_asset"]',
        '  Loader --> Mermaid["Mermaid SVG Resolver"]',
      ].join("\n"),
      "diagrams/handshake.mermaid": [
        "sequenceDiagram",
        "  participant Client",
        "  participant Exporter",
        "  Client->>Exporter: Load relative .mermaid",
        "  Exporter-->>Client: Vector SVG asset",
      ].join("\n"),
      "figures/Flow.mmd": [
        "flowchart TD",
        '  Encoded["Flow%2Emmd Path"] --> Cleaned["Decoded Flow.mmd"]',
      ].join("\n"),
      "diagrams/Flow#1.mmd": [
        "flowchart LR",
        '  HashFile["Flow#1.mmd"] --> HashOut["Encoded %23"]',
      ].join("\n"),
      "diagrams/Flow%Complete.mmd": [
        "flowchart TD",
        '  PctFile["Flow%Complete.mmd"] --> PctOut["Encoded %25"]',
      ].join("\n"),
      "diagrams/broken.mmd": "flowchart TD\n  A -->\n  invalid syntax ???\n",
    };
    const pngDataUrl =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

    (window as any).__pdfCaptures = [] as Array<{ command: string; args: any }>;

    window.SuperMD = {
      post: (id, command, raw) => {
        const args = JSON.parse(raw);
        (window as any).__pdfCaptures.push({ command, args });
        queueMicrotask(() => {
          if (command === "load_text_asset") {
            const source = String(args.source || "");
            const relative = decodeURIComponent(source.split("#", 1)[0].split("?", 1)[0]);
            if (relative === "diagrams/symlink-outside.mmd") {
              window.supermdReply?.(id, null, "Diagram source is outside the note folder");
              return;
            }
            if (relative === "diagrams/oversized.mmd") {
              window.supermdReply?.(id, { text: "a".repeat(2_000_005) }, null);
              return;
            }
            if (!(relative in mermaidFiles)) {
              window.supermdReply?.(id, null, "No such file or directory");
              return;
            }
            window.supermdReply?.(id, { text: mermaidFiles[relative] }, null);
            return;
          }
          if (command === "load_asset") {
            const source = String(args.source || "");
            if (
              source === "figures/photo.png?label=flow.mmd" ||
              source === "figures/photo.png#flow.mmd"
            ) {
              window.supermdReply?.(id, pngDataUrl, null);
              return;
            }
            window.supermdReply?.(id, null, `Unexpected load_asset source: ${source}`);
            return;
          }
          if (command === "fetch_resource") {
            window.supermdReply?.(id, null, `Unexpected ${command} call`);
            return;
          }
          if (command === "export_pdf_native") {
            window.supermdReply?.(id, { path: "/tmp/exported.pdf" }, null);
            return;
          }
          window.supermdReply?.(id, command === "load_python_output" ? null : true, null);
        });
      },
    };
  });

  await page.goto("/android-reader.html");
  await page.waitForFunction(() => typeof window.supermdLoad === "function");

  // 1. Valid relative .mmd, .mermaid, and encoded Flow%2Emmd image links render real SVG diagrams while ordinary PNGs with .mmd query/fragment stay on load_asset.
  await page.evaluate(async () => {
    window.supermdLoad?.({
      id: "mermaid-pdf-ok",
      path: "/workspace/notes/architecture.md",
      content: [
        "# Linked Mermaid PDF Export",
        "",
        '![System Architecture](diagrams/architecture.mmd "Architecture caption")',
        "",
        "![Handshake Sequence][seq]",
        "",
        "![[diagrams/architecture.mmd|320]]",
        "",
        "![Encoded Flow](figures/Flow%2Emmd?label=photo.png#top)",
        "",
        "![Hash Filename](diagrams/Flow%231.mmd)",
        "",
        "![Percent Filename](diagrams/Flow%25Complete.mmd)",
        "",
        "![Query Photo](figures/photo.png?label=flow.mmd)",
        "",
        "![Fragment Photo](figures/photo.png#flow.mmd)",
        "",
        "[Source file](diagrams/architecture.mmd)",
        "",
        "[seq]: diagrams/handshake.mermaid",
        "",
      ].join("\n"),
      mode: "editor",
      dark: false,
      fullscreen: false,
      colors: {},
      font: "Manrope",
      size: 16,
      zoom: 100,
    });
    (window as any).__pdfCaptures.length = 0;
    await (window.supermdExport as any)?.({
      pageSize: "a4",
      margin: 18,
      fontSize: 10,
      lineHeight: 1.45,
      fontFamily: "Manrope",
      pageNumbers: true,
    });
  });

  const okCaptures = await page.evaluate(() => (window as any).__pdfCaptures);
  expect(okCaptures.filter((c: any) => c.command === "export_failed")).toEqual([]);
  expect(okCaptures.filter((c: any) => c.command === "fetch_resource")).toEqual([]);
  expect(
    okCaptures.filter((c: any) => c.command === "load_asset").map((c: any) => c.args.source),
  ).toEqual(["figures/photo.png?label=flow.mmd", "figures/photo.png#flow.mmd"]);

  const textLoads = okCaptures.filter((c: any) => c.command === "load_text_asset");
  expect(textLoads.map((c: any) => c.args.source)).toEqual([
    "diagrams/architecture.mmd",
    "diagrams/handshake.mermaid",
    "figures/Flow.mmd",
    "diagrams/Flow%231.mmd",
    "diagrams/Flow%25Complete.mmd",
  ]);

  const pdfExportCall = okCaptures.find((c: any) => c.command === "export_pdf_native");
  expect(pdfExportCall).toBeTruthy();
  const { content: preparedContent, assets: preparedAssets } = pdfExportCall.args as {
    content: string;
    assets: Record<string, string>;
  };

  expect(preparedContent).toMatch(/!\[System Architecture\]\(diagram-\d+\.svg "Architecture caption"\)/);
  expect(preparedContent).toMatch(/!\[Handshake Sequence\]\(diagram-\d+\.svg\)/);
  expect(preparedContent).toMatch(/!\[diagrams\/architecture\.mmd\]\(diagram-\d+\.svg\)\{width=320\}/);
  expect(preparedContent).toMatch(/!\[Encoded Flow\]\(diagram-\d+\.svg\)/);
  expect(preparedContent).toMatch(/!\[Hash Filename\]\(diagram-\d+\.svg\)/);
  expect(preparedContent).toMatch(/!\[Percent Filename\]\(diagram-\d+\.svg\)/);
  expect(preparedContent).toMatch(/!\[Query Photo\]\(asset-\d+\.png\)/);
  expect(preparedContent).toMatch(/!\[Fragment Photo\]\(asset-\d+\.png\)/);
  expect(preparedContent).toContain("[Source file](diagrams/architecture.mmd)");

  const assetNames = Object.keys(preparedAssets);
  expect(assetNames).toHaveLength(8);
  const svgAssets = Object.fromEntries(
    Object.entries(preparedAssets).filter(([name]) => name.endsWith(".svg")),
  );
  const pngAssets = Object.entries(preparedAssets).filter(([name]) => name.endsWith(".png"));
  expect(Object.keys(svgAssets)).toHaveLength(6);
  expect(pngAssets).toHaveLength(2);

  const verifiedSvgs = await page.evaluate((assets: Record<string, string>) => {
    return Object.entries(assets).map(([name, b64]) => {
      const xml = atob(b64);
      const doc = new DOMParser().parseFromString(xml, "image/svg+xml");
      const root = doc.documentElement;
      return {
        name,
        hasParserError: Boolean(doc.querySelector("parsererror")),
        tag: root.localName,
        xmlns: root.getAttribute("xmlns"),
        viewBox: root.getAttribute("viewBox") || "",
        text: (root.textContent || "").replace(/\s+/g, " ").trim(),
        shapeCount: root.querySelectorAll("path, rect, line, polygon, circle, g").length,
      };
    });
  }, svgAssets);

  for (const svg of verifiedSvgs) {
    expect(svg.hasParserError).toBe(false);
    expect(svg.tag).toBe("svg");
    expect(svg.xmlns).toBe("http://www.w3.org/2000/svg");
    expect(svg.viewBox.split(/[\s,]+/).length).toBe(4);
    expect(svg.shapeCount).toBeGreaterThan(2);
  }
  expect(verifiedSvgs.some(svg => svg.text.includes("Note Reader") && svg.text.includes("Mermaid SVG Resolver"))).toBe(
    true,
  );
  expect(verifiedSvgs.some(svg => svg.text.includes("Load relative .mermaid") && svg.text.includes("Vector SVG asset"))).toBe(
    true,
  );
  expect(verifiedSvgs.some(svg => svg.text.includes("Flow%2Emmd Path") && svg.text.includes("Decoded Flow.mmd"))).toBe(
    true,
  );
  expect(
    verifiedSvgs.some(svg => svg.text.includes("Flow#1.mmd") && svg.text.includes("Encoded %23")),
  ).toBe(true);
  expect(
    verifiedSvgs.some(svg => svg.text.includes("Flow%Complete.mmd") && svg.text.includes("Encoded %25")),
  ).toBe(true);

  // 2. Missing, path-traversal, host-rejected outside-root, oversized, unconsented remote, and invalid-Mermaid files report readable errors.
  const errorCases: Array<{
    id: string;
    path: string | null;
    markdown: string;
    expected: RegExp;
    expectNoIpc?: boolean;
  }> = [
    {
      id: "missing-file",
      path: "/workspace/notes/architecture.md",
      markdown: "![Missing Diagram](diagrams/does-not-exist.mmd)",
      expected: /Cannot load Mermaid source diagrams\/does-not-exist\.mmd: No such file or directory/,
    },
    {
      id: "rejected-traversal",
      path: "/workspace/notes/architecture.md",
      markdown: "![Traversal](../outside%2Emmd)",
      expected: /Cannot safely resolve Mermaid source \.\.\/outside%2Emmd/,
      expectNoIpc: true,
    },
    {
      id: "rejected-outside-root",
      path: "/workspace/notes/architecture.md",
      markdown: "![Symlink Escape](diagrams/symlink-outside.mmd)",
      expected: /Cannot load Mermaid source diagrams\/symlink-outside\.mmd: Diagram source is outside the note folder/,
    },
    {
      id: "rejected-oversized",
      path: "/workspace/notes/architecture.md",
      markdown: "![Oversized](diagrams/oversized.mmd)",
      expected: /Mermaid source is unavailable or too large: diagrams\/oversized\.mmd/,
    },
    {
      id: "rejected-remote-consent",
      path: "/workspace/notes/architecture.md",
      markdown: "![Remote Mermaid](https://evil.example/figures/Flow%2Emmd)",
      expected: /Remote image from evil\.example requires explicit consent in the reader before exporting PDF/,
      expectNoIpc: true,
    },
    {
      id: "rejected-unsaved",
      path: null,
      markdown: "![Unsaved Note](diagrams/architecture.mmd)",
      expected: /Save your note before exporting relative Mermaid diagram diagrams\/architecture\.mmd/,
      expectNoIpc: true,
    },
    {
      id: "invalid-mermaid-syntax",
      path: "/workspace/notes/architecture.md",
      markdown: "![Broken Syntax](diagrams/broken.mmd)",
      expected: /Invalid Mermaid diagram in diagrams\/broken\.mmd:/,
    },
  ];

  for (const testCase of errorCases) {
    const captures = await page.evaluate(async item => {
      window.supermdLoad?.({
        id: item.id,
        path: item.path,
        content: `# Error check\n\n${item.markdown}\n`,
        mode: "editor",
        dark: false,
        fullscreen: false,
        colors: {},
        font: "Manrope",
        size: 16,
        zoom: 100,
      });
      (window as any).__pdfCaptures.length = 0;
      await (window.supermdExport as any)?.({
        pageSize: "a4",
        margin: 18,
        fontSize: 10,
        lineHeight: 1.45,
        fontFamily: "Manrope",
        pageNumbers: true,
      });
      return (window as any).__pdfCaptures;
    }, { id: testCase.id, path: testCase.path, markdown: testCase.markdown });

    expect(captures.find((c: any) => c.command === "export_pdf_native")).toBeUndefined();
    expect(captures.filter((c: any) => c.command === "fetch_resource")).toEqual([]);
    if (testCase.expectNoIpc) {
      expect(captures.filter((c: any) => c.command === "load_text_asset")).toEqual([]);
    }
    const failed = captures.find((c: any) => c.command === "export_failed");
    expect(failed?.args?.error).toMatch(testCase.expected);
  }
});
