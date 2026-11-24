import { expect, test } from "@playwright/test";

test("formatting actions toggle cleanly and undo in a single step across Source, Split, and Live modes", async ({ page }) => {
  const calls: Array<{ command: string; args: any }> = [];
  await page.exposeFunction("bridgePost", (id: string, command: string, raw: string) => {
    const args = JSON.parse(raw);
    calls.push({ command, args });
    void page.evaluate(({ id }) => window.supermdReply?.(id, true, null), { id });
  });
  await page.addInitScript(() => {
    window.SuperMD = { post: (id, command, args) => (window as any).bridgePost(id, command, args) };
  });
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto("/android-reader.html");
  await page.waitForFunction(() => typeof window.supermdLoad === "function");

  const initialDoc = "Fourier transform\n\nSecond paragraph";
  await page.evaluate((content) => {
    window.supermdLoad?.({
      id: "format-note",
      content,
      path: "format-note",
      mode: "editor",
      dark: false,
      fullscreen: false,
      colors: {},
      font: "sans",
      size: 16,
      zoom: 100,
    });
  }, initialDoc);

  await expect(page.locator(".cm-content")).toBeVisible();
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+Home");
  for (let i = 0; i < 7; i++) await page.keyboard.press("Shift+ArrowRight");

  await expect.poll(() => calls.filter((c) => c.command === "editor_focus_changed").at(-1)?.args.focused).toBe(true);

  const cases: Array<{ action: string; shortcut?: string; expected: string }> = [
    { action: "bold", shortcut: "Control+b", expected: "**Fourier** transform\n\nSecond paragraph" },
    { action: "italic", shortcut: "Control+i", expected: "*Fourier* transform\n\nSecond paragraph" },
    { action: "inline_code", shortcut: "Control+e", expected: "`Fourier` transform\n\nSecond paragraph" },
    { action: "link", shortcut: "Control+k", expected: "[Fourier]() transform\n\nSecond paragraph" },
    { action: "heading", shortcut: "Control+Shift+H", expected: "## Fourier transform\n\nSecond paragraph" },
    { action: "list", shortcut: "Control+Shift+L", expected: "- Fourier transform\n\nSecond paragraph" },
    { action: "quote", shortcut: "Control+Shift+Q", expected: "> Fourier transform\n\nSecond paragraph" },
    { action: "inline_math", shortcut: "Control+Shift+M", expected: "$Fourier$ transform\n\nSecond paragraph" },
  ];

  const latestContent = () => calls.filter((c) => c.command === "document_changed").at(-1)?.args.content ?? initialDoc;

  for (const entry of cases) {
    if (entry.shortcut) {
      await page.keyboard.press(entry.shortcut);
      await expect.poll(latestContent).toBe(entry.expected);
      await page.keyboard.press(entry.shortcut);
      await expect.poll(latestContent).toBe(initialDoc);
    }
  }

  // Verify single-step Undo restores both document content and selection in Source mode
  await page.keyboard.press("Control+b");
  await expect.poll(latestContent).toBe("**Fourier** transform\n\nSecond paragraph");
  await page.keyboard.press("Control+z");
  await expect.poll(latestContent).toBe(initialDoc);
  // Immediately pressing Control+i should wrap the restored "Fourier" selection!
  await page.keyboard.press("Control+i");
  await expect.poll(latestContent).toBe("*Fourier* transform\n\nSecond paragraph");
  await page.keyboard.press("Control+z");
  await expect.poll(latestContent).toBe(initialDoc);

  // Switch to Split mode and verify formatting updates both Source and Preview
  await page.evaluate((content) => {
    window.supermdLoad?.({
      id: "format-note",
      content,
      path: "format-note",
      mode: "split",
      dark: false,
      fullscreen: false,
      colors: {},
      font: "sans",
      size: 16,
      zoom: 100,
    });
  }, initialDoc);
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+Home");
  for (let i = 0; i < 7; i++) await page.keyboard.press("Shift+ArrowRight");
  await page.evaluate(() => window.supermdFormat?.("bold"));
  await expect(page.locator(".markdown-body strong")).toHaveText("Fourier");
  await page.screenshot({ path: "/tmp/split-mode-formatting.png" });
  await page.evaluate(() => window.supermdFormat?.("bold"));
  await expect(page.locator(".markdown-body strong")).toHaveCount(0);

  // Switch to Live mode and verify formatting + single-step Undo inside an active block
  await page.evaluate((content) => {
    window.supermdLoad?.({
      id: "format-note",
      content,
      path: "format-note",
      mode: "live",
      dark: false,
      fullscreen: false,
      colors: {},
      font: "sans",
      size: 16,
      zoom: 100,
    });
  }, initialDoc);
  await page.getByText("Fourier transform").dblclick();
  const liveBox = page.getByRole("textbox", { name: "Edit Markdown block" });
  await expect(liveBox).toBeVisible();
  await page.evaluate(() => {
    const area = document.querySelector<HTMLTextAreaElement>(".live-active-block textarea")!;
    area.focus();
    area.setSelectionRange(0, 7);
  });
  await page.evaluate(() => window.supermdFormat?.("bold"));
  await expect(liveBox).toHaveValue("**Fourier** transform");
  await page.evaluate(() => window.supermdFormat?.("bold"));
  await expect(liveBox).toHaveValue("Fourier transform");

  await page.keyboard.press("Control+Shift+M");
  await expect(liveBox).toHaveValue("$Fourier$ transform");
  await page.evaluate(() => window.supermdHistory?.("undo"));
  await expect(liveBox).toHaveValue("Fourier transform");
  const liveSelection = await page.evaluate(() => {
    const area = document.querySelector<HTMLTextAreaElement>(".live-active-block textarea")!;
    return [area.selectionStart, area.selectionEnd];
  });
  expect(liveSelection).toEqual([0, 7]);
});

test("URL paste wraps selected prose inline without dialog and pastes plain URL in bare cursor, code, and Find inputs", async ({ page }) => {
  const calls: Array<{ command: string; args: any }> = [];
  await page.exposeFunction("bridgePost", (id: string, command: string, raw: string) => {
    const args = JSON.parse(raw);
    calls.push({ command, args });
    void page.evaluate(({ id }) => window.supermdReply?.(id, true, null), { id });
  });
  await page.addInitScript(() => {
    window.SuperMD = { post: (id, command, args) => (window as any).bridgePost(id, command, args) };
  });
  await page.setViewportSize({ width: 1100, height: 760 });
  await page.goto("/android-reader.html");
  await page.waitForFunction(() => typeof window.supermdLoad === "function");

  const doc = "Read the documentation here.\n\n```python\nendpoint = \"replace_me\"\n```";
  await page.evaluate((content) => {
    window.supermdLoad?.({
      id: "paste-note",
      content,
      path: "paste-note",
      mode: "live",
      dark: false,
      fullscreen: false,
      colors: {},
      font: "sans",
      size: 16,
      zoom: 100,
    });
  }, doc);

  // 1. Live mode: paste URL over selected prose -> wraps inline, stays in block edit mode, no modal dialog
  await page.getByText("Read the documentation here.").dblclick();
  const liveBox = page.getByRole("textbox", { name: "Edit Markdown block" });
  await expect(liveBox).toBeVisible();
  await page.evaluate(() => {
    const area = document.querySelector<HTMLTextAreaElement>(".live-active-block textarea")!;
    area.focus();
    area.setSelectionRange(9, 22); // "documentation"
    const clipboard = new DataTransfer();
    clipboard.setData("text/plain", "https://example.com/docs");
    area.dispatchEvent(new ClipboardEvent("paste", { clipboardData: clipboard, bubbles: true, cancelable: true }));
  });
  await expect(page.getByRole("dialog", { name: "Insert image or link" })).toHaveCount(0);
  await expect(liveBox).toBeVisible();
  await expect(liveBox).toHaveValue("Read the [documentation](https://example.com/docs) here.");
  await page.screenshot({ path: "/tmp/live-inline-url-paste.png" });

  // Single-step undo restores prose and selection
  await page.evaluate(() => window.supermdHistory?.("undo"));
  await expect(liveBox).toHaveValue("Read the documentation here.");
  const restoredRange = await page.evaluate(() => {
    const area = document.querySelector<HTMLTextAreaElement>(".live-active-block textarea")!;
    return [area.selectionStart, area.selectionEnd];
  });
  expect(restoredRange).toEqual([9, 22]);

  // 2. Source mode: bare cursor & fenced code block paste plain URL directly
  await page.evaluate((content) => {
    window.supermdLoad?.({
      id: "paste-note",
      content,
      path: "paste-note",
      mode: "editor",
      dark: false,
      fullscreen: false,
      colors: {},
      font: "sans",
      size: 16,
      zoom: 100,
    });
  }, doc);
  await page.locator(".cm-content").click();

  // Select "documentation" in Source mode and paste URL -> wraps [documentation](https://example.com/guide)
  await page.keyboard.press("Control+Home");
  for (let i = 0; i < 9; i++) await page.keyboard.press("ArrowRight");
  for (let i = 0; i < 13; i++) await page.keyboard.press("Shift+ArrowRight");
  await page.evaluate(() => {
    const content = document.querySelector(".cm-content")!;
    const clipboard = new DataTransfer();
    clipboard.setData("text/plain", "https://example.com/guide");
    content.dispatchEvent(new ClipboardEvent("paste", { clipboardData: clipboard, bubbles: true, cancelable: true }));
  });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(() => calls.filter((c) => c.command === "document_changed").at(-1)?.args.content).toContain(
    "Read the [documentation](https://example.com/guide) here.",
  );

  // Undo in Source mode -> reverts to original doc and keeps selection on "documentation"
  await page.keyboard.press("Control+z");
  await expect.poll(() => calls.filter((c) => c.command === "document_changed").at(-1)?.args.content).toBe(doc);

  // Select "replace_me" inside the fenced python block and paste URL -> replaces with plain URL (NOT [replace_me](url))
  const replaceStart = doc.indexOf("replace_me");
  await page.keyboard.press("Control+Home");
  for (let i = 0; i < replaceStart; i++) await page.keyboard.press("ArrowRight");
  for (let i = 0; i < "replace_me".length; i++) await page.keyboard.press("Shift+ArrowRight");
  await page.evaluate(() => {
    const content = document.querySelector(".cm-content")!;
    const clipboard = new DataTransfer();
    clipboard.setData("text/plain", "https://api.example.com/v1");
    content.dispatchEvent(new ClipboardEvent("paste", { clipboardData: clipboard, bubbles: true, cancelable: true }));
  });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(() => calls.filter((c) => c.command === "document_changed").at(-1)?.args.content).toContain(
    'endpoint = "https://api.example.com/v1"',
  );

  // 3. Find bar input: pasting URL into Find input does not trigger dialog or alter note
  await page.evaluate(() => window.supermdFind?.());
  const findInput = page.getByRole("searchbox", { name: "Find in note" });
  await expect(findInput).toBeVisible();
  await findInput.fill("documentation");
  await findInput.selectText();
  await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Find in note"]')!;
    const clipboard = new DataTransfer();
    clipboard.setData("text/plain", "https://search.example.com");
    input.dispatchEvent(new ClipboardEvent("paste", { clipboardData: clipboard, bubbles: true, cancelable: true }));
  });
  await expect(page.getByRole("dialog", { name: "Insert image or link" })).toHaveCount(0);
});
