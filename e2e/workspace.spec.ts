import { expect, test } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
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
