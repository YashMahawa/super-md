import { expect, test } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

test.beforeEach(async ({ page }) => { await page.addInitScript(() => localStorage.setItem("setup.complete", "true")); });
test("tabs, undo, sidebar and layout survive view changes", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 }); await page.goto("/");
  await expect(page.getByRole("tab", { name: "Welcome.smd" })).toBeVisible();
  const height = await page.locator(".workspace").evaluate((node) => node.getBoundingClientRect().height); expect(height).toBeGreaterThan(600);
  await page.getByRole("button", { name: "New tab", exact: true }).click();
  await page.getByRole("button", { name: "editor view", exact: true }).click();
  await page.locator(".cm-content").click(); await page.keyboard.type("recoverable work");
  await page.getByRole("tab", { name: "Welcome.smd" }).click(); await page.getByRole("tab", { name: "Untitled.smd" }).click();
  await expect(page.locator(".cm-content")).toContainText("recoverable work");
  await page.locator(".cm-content").click(); await page.keyboard.press("Control+z");
  await expect(page.locator(".cm-content")).not.toContainText("recoverable work");
  await page.keyboard.type("keep this draft");
  await page.getByRole("button", { name: "Close Untitled.smd", exact: true }).click(); await page.getByRole("button", { name: "Reopen", exact: true }).click();
  await expect(page.locator(".cm-content")).toContainText("keep this draft");
  await page.reload(); await expect(page.locator(".cm-content")).toContainText("keep this draft");
  await page.getByRole("button", { name: "Toggle folder sidebar" }).click(); await expect(page.getByRole("complementary", { name: "Folder explorer" })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("desktop-workspace.png") });
});

test("Android shares math, callouts, graphs and portable PDF preparation", async ({ page }) => {
  const requests: Array<{ command: string; args: any }> = [];
  await page.exposeFunction("bridgePost", (id: string, command: string, raw: string) => {
    requests.push({ command, args: JSON.parse(raw) });
    const result = command === "run_python" ? { ok: true, stdout: "local-python-ok", stderr: "", images: ["data:image/svg+xml;base64," + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><path d="M0 40L100 10" stroke="blue"/></svg>').toString("base64")] } : true;
    void page.evaluate(({ id, result }) => window.supermdReply?.(id, result, null), { id, result });
  });
  await page.addInitScript(() => { window.SuperMD = { post: (id, command, args) => (window as any).bridgePost(id, command, args) }; });
  await page.goto("/android-reader.html");
  const chart = JSON.stringify({ x: { min: -3, max: 3 }, series: [{ expression: "a * sin(x)" }], sliders: [{ name: "a", min: 0, max: 3, value: 1 }] });
  await page.evaluate((content) => window.supermdLoad?.({ id: "note", content, path: null, mode: "reader", dark: false, fullscreen: false, colors: {}, font: "sans", size: 17, zoom: 100 }), `> [!TIP] Learn\n> Work through the equation.\n\n$$\\begin{pmatrix}1&2\\\\3&4\\end{pmatrix}$$\n\n\`\`\`smd-chart\n${chart}\n\`\`\`\n\n\`\`\`mermaid\nflowchart LR\n  Read --> Understand\n\`\`\`\n\n\`\`\`python\nprint('local-python-ok')\n\`\`\``);
  await expect(page.locator(".callout-tip")).toBeVisible(); await expect(page.locator(".katex-error")).toHaveCount(0); await expect(page.locator(".katex")).toHaveCount(1);
  // Python source has no highlight.js wrapper; it must remain legible against
  // the fixed dark code surface even when the document uses a light theme.
  await expect(page.locator(".python-cell > pre code")).toHaveCSS("color", "rgb(238, 237, 244)");
  await expect(page.locator(".python-cell .hljs-string")).toContainText("local-python-ok");
  await expect(page.locator(".mermaid svg")).toBeVisible(); await page.locator("input[type=range]").fill("1.98");
  await page.getByRole("button", { name: "Run" }).click(); await expect(page.locator(".cell-output")).toContainText("local-python-ok");
  await page.evaluate(() => window.supermdExport?.({ pageSize: "a4", margin: 18, fontSize: 11, fontFamily: "Libertinus Serif", lineHeight: 1.35, pageNumbers: false }));
  expect(requests.find((item) => item.command === "export_failed")).toBeUndefined();
  await expect.poll(() => requests.some((item) => item.command === "export_pdf_native")).toBeTruthy();
  const prepared = requests.find((item) => item.command === "export_pdf_native")!.args;
  expect(Object.keys(prepared.assets)).toHaveLength(3); expect(prepared.content).not.toContain("```mermaid"); expect(prepared.options.pageNumbers).toBe(false);
  expect(prepared.content).toContain("print('local-python-ok')"); expect(prepared.content).toContain("local-python-ok");
  const input = test.info().outputPath("prepared.md"); await mkdir(dirname(input), { recursive: true }); await writeFile(input, prepared.content);
  expect(prepared.content).toMatch(/^> \[!TIP\] Learn\n> Work through the equation\.\n\n/);
  expect(prepared.content).toContain("\n\n![Diagram]");
  for (const [name, asset] of Object.entries(prepared.assets)) await writeFile(join(dirname(input), name), Buffer.from(asset as string, "base64"));
  for (const asset of Object.values(prepared.assets) as string[]) {
    const svg = Buffer.from(asset, "base64").toString(); expect(svg).toContain("<svg"); expect(svg).not.toContain("<foreignObject");
  }
});

test("click-to-edit, media drops, titled links and portable source work together", async ({ page }) => {
  const calls: Array<{ command: string; args: any }> = []; const assets = new Map<string, string>(); let sequence = 0;
  await page.exposeFunction("bridgePost", (id: string, command: string, raw: string) => {
    const args = JSON.parse(raw); calls.push({ command, args });
    let result: any = true;
    if (command === "import_images") result = args.images.map((image: any) => { const source = `assets/import-test-${++sequence}.${image.data.startsWith("data:image/svg") ? "svg" : "jpg"}`; assets.set(source, image.data); return { source, alt: image.name }; });
    if (command === "load_asset") result = assets.get(args.source);
    if (command === "fetch_resource") result = { body: args.image ? "data:image/svg+xml;base64," + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><rect width="100" height="50" fill="blue"/></svg>').toString("base64") : JSON.stringify({ title: "Understanding Fourier series", thumbnail_url: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg" }) };
    void page.evaluate(({ id, result }) => window.supermdReply?.(id, result, null), { id, result });
  });
  await page.addInitScript(() => { window.SuperMD = { post: (id, command, args) => (window as any).bridgePost(id, command, args) }; });
  await page.goto("/android-reader.html");
  await page.evaluate(() => window.supermdLoad?.({ id: "media-note", content: '# Study notes\n\n```svg\n<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><circle cx="50" cy="25" r="20" fill="blue"/></svg>\n```', path: "media-note", mode: "live", dark: false, fullscreen: false, colors: {}, font: "sans", size: 17, zoom: 100 }));
  await expect(page.locator(".live-edit-button")).toHaveCount(0); await expect(page.locator(".svg-diagram")).toBeVisible();
  await page.getByRole("heading", { name: "Study notes" }).click(); await expect(page.getByRole("textbox", { name: "Edit Markdown block" })).toContainText("# Study notes");
  await page.evaluate(() => { const editor = document.querySelector('textarea')!; const clipboard = new DataTransfer(); clipboard.setData("text/plain", "https://youtu.be/dQw4w9WgXcQ"); editor.dispatchEvent(new ClipboardEvent("paste", { clipboardData: clipboard, bubbles: true, cancelable: true })); });
  await expect(page.getByRole("dialog", { name: "Insert image or link" })).toBeVisible(); await expect(page.getByLabel("Link title")).toHaveValue("Understanding Fourier series");
  await page.getByLabel("Include the video thumbnail").check(); await page.getByRole("button", { name: "Insert link", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(() => calls.filter((call) => call.command === "document_changed").at(-1)?.args.content).toContain("[Understanding Fourier series](<https://youtu.be/dQw4w9WgXcQ>)");
  // Live textarea exits on blur; switch explicitly to reading for DOM file drop.
  const current = calls.filter((call) => call.command === "document_changed").at(-1)!.args.content;
  await page.evaluate((content) => window.supermdLoad?.({ id: "media-note", content, path: "media-note", mode: "reader", dark: false, fullscreen: false, colors: {}, font: "sans", size: 17, zoom: 100 }), current);
  await page.evaluate(() => { const transfer = new DataTransfer(); transfer.items.add(new File(['<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><path d="M0 0L40 40" stroke="red"/></svg>'], "Dropped.svg", { type: "image/svg+xml" })); document.querySelector('.android-reading')!.dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true })); });
  await expect(page.getByRole("img", { name: "Dropped.svg" })).toBeVisible();
  // Contextual tools only appear on selection; removal is reversible and
  // changes editable Markdown rather than an opaque portable envelope.
  await expect(page.getByRole("button", { name: "Remove", exact: true })).toHaveCount(0);
  await page.getByRole("img", { name: "Dropped.svg" }).click();
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(page.getByRole("img", { name: "Dropped.svg" })).toHaveCount(0);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.getByRole("img", { name: "Dropped.svg" })).toBeVisible();
  await page.evaluate(() => window.supermdPortable?.(false));
  await expect.poll(() => calls.some((call) => call.command === "export_fmd_native")).toBeTruthy();
  const bundle = calls.find((call) => call.command === "export_fmd_native")!.args;
  expect(Object.keys(bundle.assets)).toHaveLength(2); expect(bundle.content).not.toContain("base64"); expect(bundle.content).toContain("```svg");
  await page.evaluate(() => window.supermdExport?.({ pageSize: "a4", margin: 18, fontSize: 11, fontFamily: "Libertinus Serif", lineHeight: 1.35, pageNumbers: false }));
  await expect.poll(() => calls.some((call) => call.command === "export_pdf_native")).toBeTruthy();
  expect(calls.find((call) => call.command === "export_failed")).toBeUndefined();
  const pdf = calls.find((call) => call.command === "export_pdf_native")!.args;
  expect(Object.keys(pdf.assets)).toHaveLength(3); expect(pdf.content).not.toContain("```svg");
  await page.screenshot({ path: test.info().outputPath("media-and-vectors.png") });
});

test("editable zoom and one export chooser work at desktop widths", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 }); await page.goto("/");
  const zoom = page.getByRole("textbox", { name: "Zoom percentage", exact: true });
  await zoom.fill("175"); await zoom.press("Enter"); await expect(zoom).toHaveValue("175");
  const chromeHeight = await page.locator(".topbar").evaluate((node) => node.getBoundingClientRect().height);
  await page.keyboard.press("F11");
  await expect(page.locator(".fullscreen-controls input")).toHaveValue("100");
  await page.locator(".fullscreen-controls input").fill("210"); await page.locator(".fullscreen-controls input").press("Enter");
  await page.keyboard.press("F11"); await expect(zoom).toHaveValue("175");
  expect(await page.locator(".topbar").evaluate((node) => node.getBoundingClientRect().height)).toBe(chromeHeight);
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Export your note" })).toBeVisible();
  await page.getByRole("button", { name: "Portable FMD", exact: true }).click();
  await expect(page.getByText("One editable file", { exact: false })).toBeVisible();
  await expect(page.getByLabel("Page numbers", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "PDF document", exact: true }).click();
  await expect(page.getByLabel("Page numbers", { exact: true })).toBeVisible();
  await expect.poll(async () => page.locator('.export-format-indicator').evaluate((node) => Math.abs(node.getBoundingClientRect().left - node.parentElement!.querySelector('button')!.getBoundingClientRect().left))).toBeLessThan(4);
  await page.screenshot({ path: test.info().outputPath("desktop-export.png") });
  await page.getByRole("button", { name: "Close export settings" }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("slider", { name: "Reading size", exact: true })).toBeVisible();
  await page.getByRole("slider", { name: "Reading size", exact: true }).focus(); await page.keyboard.press("ArrowRight");
  await expect(page.getByText("Reading size (18px)", { exact: true })).toBeVisible();
  await page.getByRole("switch", { name: "Expressive motion", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-reduce-motion", "true");
  await expect(page.locator("smd-expressive-button.export-action")).toHaveAttribute("motion-off", "");
  await expect(page.locator("smd-slider").first()).toHaveAttribute("motion-off", "");
  expect(await page.getByRole("switch", { name: "Autosave", exact: true }).evaluate((node) => getComputedStyle(node).transitionDuration)).toBe("0s");
  await page.screenshot({ path: test.info().outputPath("desktop-material-settings.png") });
});

test("Obsidian multiline display math preserves the full study document", async ({ page }) => {
  const markdown = process.env.SUPERMD_OBSIDIAN_NOTE ? await readFile(process.env.SUPERMD_OBSIDIAN_NOTE, "utf8") : String.raw`# Probability

$$\boxed{\begin{aligned}
P(A\cup B)=&P(A)+P(B)\\
&-P(A\cap B).
\end{aligned}}$$

**Proof:** Preserved explanation.

> [!TIP] Learn
> $$P(A\cap B)\le1$$

## The rest of the document

| Formula | Meaning |
|---|---|
| $P(A\cap B)$ | Both events |
`;
  const calls: Array<{ command: string; args: any }> = [];
  await page.exposeFunction("bridgePost", (id: string, command: string, raw: string) => {
    calls.push({ command, args: JSON.parse(raw) }); void page.evaluate((id) => window.supermdReply?.(id, true, null), id);
  });
  await page.addInitScript(() => { window.SuperMD = { post: (id, command, args) => (window as any).bridgePost(id, command, args) }; });
  await page.goto('/android-reader.html');
  const expectedHeadings = (markdown.match(/^#{1,6}\s/gm) || []).length;
  for (const mode of ["reader", "live"] as const) {
    await page.evaluate(({ content, mode }) => window.supermdLoad?.({ id: "math-note", content, mode, path: null, dark: false, fullscreen: false, colors: {}, font: "sans", size: 17, zoom: 100 }), { content: markdown, mode });
    await expect(page.locator('.katex-display').first()).toBeVisible();
    await expect(page.locator('.katex-error')).toHaveCount(0);
    await expect(page.locator('.markdown-body h1,.markdown-body h2,.markdown-body h3,.markdown-body h4,.markdown-body h5,.markdown-body h6')).toHaveCount(expectedHeadings);
    expect(await page.locator('.katex').count()).toBeGreaterThan(2);
  }
  await page.evaluate(() => window.supermdExport?.({ pageSize: "a4", margin: 18, fontSize: 11, fontFamily: "Libertinus Serif", lineHeight: 1.35, pageNumbers: false }));
  await expect.poll(() => calls.some((call) => call.command === 'export_pdf_native')).toBeTruthy();
  expect(calls.find((call) => call.command === 'export_failed')).toBeUndefined();
});
