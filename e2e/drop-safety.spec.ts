import { expect, test } from "@playwright/test";

const SAMPLE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="180" height="72"><rect width="180" height="72" rx="12" fill="#2d6a4f"/><text x="90" y="42" text-anchor="middle" fill="#ffffff" font-size="15">Observation Diagram</text></svg>';

test("Live mode drops land at translated block/gap offsets during active edits and non-image drops stay safe across Web and Reader", async ({ page }) => {
  const assets = new Map<string, string>();
  let seq = 0;
  await page.exposeFunction("bridgePost", (id: string, command: string, raw: string) => {
    const args = raw ? JSON.parse(raw) : {};
    let result: unknown = true;
    if (command === "import_images") {
      result = args.images.map((image: { name: string; data: string }) => {
        const source = `assets/import-drop-${++seq}.svg`;
        assets.set(source, image.data);
        return { source, alt: image.name };
      });
    }
    if (command === "load_asset") {
      result = assets.get(args.source) ?? null;
    }
    void page.evaluate(({ id, result }) => window.supermdReply?.(id, result, null), { id, result });
  });
  await page.addInitScript(() => {
    localStorage.setItem("setup.complete", "true");
    window.SuperMD = { post: (id, command, args) => (window as any).bridgePost(id, command, args) };
  });

  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto("/");

  // Load a clean multi-block note in Source ("editor view") mode.
  await page.getByRole("button", { name: "editor view", exact: true }).click();
  const cm = page.locator(".cm-content");
  await cm.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText("# Experiment Log\n\nMiddle observation paragraph.\n\nFinal conclusion.");

  // 1. Non-image file drop on CodeMirror does NOT dump raw PDF bytes into the note or navigate away.
  await page.evaluate(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(["%PDF-1.7 raw binary bytes that must never enter markdown"], "protocol.pdf", { type: "application/pdf" }));
    const editor = document.querySelector(".cm-content")!;
    editor.dispatchEvent(new DragEvent("dragover", { dataTransfer: transfer, bubbles: true, cancelable: true }));
    editor.dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true }));
  });
  await expect(page.getByText("Only supported images (PNG, JPEG, GIF, WebP, AVIF, or SVG) can be dropped into a note.")).toBeVisible();
  await expect(cm).not.toContainText("%PDF-1.7");
  await page.screenshot({ path: "/tmp/drop-safety-non-image-toast.png" });

  // 2. Switch to Live mode, open the first block for editing, lengthen its draft, and drop an SVG onto the second block.
  await page.getByRole("button", { name: "live view", exact: true }).click();
  await page.getByRole("heading", { name: "Experiment Log" }).dblclick();
  const activeTextarea = page.getByRole("textbox", { name: "Edit Markdown block" });
  await expect(activeTextarea).toBeVisible();
  await activeTextarea.fill("# Experiment Log — Extended Header With Extra Context");

  await page.evaluate((svg) => {
    const middleBlock = document.querySelectorAll<HTMLElement>(".live-block")[1]!;
    const rect = middleBlock.getBoundingClientRect();
    const transfer = new DataTransfer();
    transfer.items.add(new File([svg], "ObservationDiagram.svg", { type: "image/svg+xml" }));
    const target = middleBlock.querySelector("p") ?? middleBlock;
    target.dispatchEvent(
      new DragEvent("drop", {
        dataTransfer: transfer,
        bubbles: true,
        cancelable: true,
        clientX: Math.round(rect.left + 32),
        clientY: Math.round(rect.top + rect.height / 2),
      }),
    );
  }, SAMPLE_SVG);

  await expect(page.getByRole("img", { name: "ObservationDiagram.svg" })).toBeVisible();
  await page.screenshot({ path: "/tmp/drop-safety-live-offset.png" });

  // Switch back to Source mode to verify exact Markdown ordering:
  // Header -> Middle observation paragraph -> Dropped image -> Final conclusion.
  await page.getByRole("button", { name: "editor view", exact: true }).click();
  const sourceText = await page.locator(".cm-content").innerText();
  const headerIdx = sourceText.indexOf("# Experiment Log — Extended Header With Extra Context");
  const middleIdx = sourceText.indexOf("Middle observation paragraph.");
  const imageIdx = sourceText.indexOf("ObservationDiagram.svg");
  const finalIdx = sourceText.indexOf("Final conclusion.");
  expect(headerIdx).toBeGreaterThanOrEqual(0);
  expect(middleIdx).toBeGreaterThan(headerIdx);
  expect(imageIdx).toBeGreaterThan(middleIdx);
  expect(finalIdx).toBeGreaterThan(imageIdx);
});
