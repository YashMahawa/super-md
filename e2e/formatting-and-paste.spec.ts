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

test("URL paste wraps selected prose inline without dialog, pastes raw URL in bare cursor/code/frontmatter/Find, and edits existing selections", async ({ page }) => {
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

  const doc = [
    "---",
    "title: Field Notes",
    "source: replace_frontmatter",
    "---",
    "",
    "Read the documentation or run `replace_inline` here.",
    "",
    "```python",
    'endpoint = "replace_me"',
    "```",
  ].join("\n");
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

  // 1. Live mode: open prose block via #62's accessible "Edit block" button, paste URL over prose -> wraps inline
  const firstLiveBlock = page.locator(".live-block").first();
  await firstLiveBlock.hover();
  await firstLiveBlock.getByRole("button", { name: "Edit block" }).click();
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
  await expect(liveBox).toHaveValue("Read the [documentation](https://example.com/docs) or run `replace_inline` here.");
  await page.screenshot({ path: "/tmp/live-inline-url-paste.png" });

  // Edit the existing selection: unwrap [documentation](...) via Ctrl+K, then type over the preserved selection, then Undo twice
  await page.evaluate(() => {
    const area = document.querySelector<HTMLTextAreaElement>(".live-active-block textarea")!;
    const start = area.value.indexOf("[documentation]");
    area.setSelectionRange(start, start + "[documentation](https://example.com/docs)".length);
  });
  await page.keyboard.press("Control+k");
  await expect(liveBox).toHaveValue("Read the documentation or run `replace_inline` here.");
  await page.keyboard.type("manual");
  await expect(liveBox).toHaveValue("Read the manual or run `replace_inline` here.");
  await page.keyboard.press("Control+z");
  await expect(liveBox).toHaveValue("Read the documentation or run `replace_inline` here.");

  // Raw paste inside inline code in Live mode -> inserts raw URL
  await page.evaluate(() => {
    const area = document.querySelector<HTMLTextAreaElement>(".live-active-block textarea")!;
    const start = area.value.indexOf("replace_inline");
    area.setSelectionRange(start, start + "replace_inline".length);
    const clipboard = new DataTransfer();
    clipboard.setData("text/plain", "https://cli.example.com");
    area.dispatchEvent(new ClipboardEvent("paste", { clipboardData: clipboard, bubbles: true, cancelable: true }));
  });
  await expect(liveBox).toHaveValue("Read the documentation or run `https://cli.example.com` here.");
  await page.evaluate(() => window.supermdHistory?.("undo"));
  await expect(liveBox).toHaveValue("Read the documentation or run `replace_inline` here.");
  await page.keyboard.press("Escape");
  await expect(liveBox).toHaveCount(0);

  // Raw paste inside fenced code block in Live mode (opened via #62 Edit block button)
  const codeLiveBlock = page.locator(".live-block").nth(1);
  await codeLiveBlock.hover();
  await codeLiveBlock.getByRole("button", { name: "Edit block" }).click();
  await expect(liveBox).toBeVisible();
  await page.evaluate(() => {
    const area = document.querySelector<HTMLTextAreaElement>(".live-active-block textarea")!;
    const start = area.value.indexOf("replace_me");
    area.setSelectionRange(start, start + "replace_me".length);
    const clipboard = new DataTransfer();
    clipboard.setData("text/plain", "https://api.example.com/live");
    area.dispatchEvent(new ClipboardEvent("paste", { clipboardData: clipboard, bubbles: true, cancelable: true }));
  });
  await expect(liveBox).toHaveValue(/endpoint = "https:\/\/api\.example\.com\/live"/);
  await page.evaluate(() => window.supermdHistory?.("undo"));
  await expect(liveBox).toHaveValue(/endpoint = "replace_me"/);

  // 2. Source mode: formatted paste in prose, raw paste in YAML frontmatter, inline code, and fenced code, plus editing existing selection
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

  const selectSubstringInSource = async (currentText: string, target: string) => {
    const idx = currentText.indexOf(target);
    expect(idx).toBeGreaterThanOrEqual(0);
    await page.keyboard.press("Control+Home");
    for (let i = 0; i < idx; i++) await page.keyboard.press("ArrowRight");
    for (let i = 0; i < target.length; i++) await page.keyboard.press("Shift+ArrowRight");
  };
  const pasteUrlInSource = async (url: string) => {
    await page.evaluate((pasted) => {
      const content = document.querySelector(".cm-content")!;
      const clipboard = new DataTransfer();
      clipboard.setData("text/plain", pasted);
      content.dispatchEvent(new ClipboardEvent("paste", { clipboardData: clipboard, bubbles: true, cancelable: true }));
    }, url);
  };
  const latestSource = () => calls.filter((c) => c.command === "document_changed").at(-1)?.args.content ?? doc;

  // 2a. Raw paste inside YAML frontmatter ("replace_frontmatter") -> replaces with plain URL (NOT [replace_frontmatter](url))
  await selectSubstringInSource(doc, "replace_frontmatter");
  await pasteUrlInSource("https://frontmatter.example.com/spec");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(latestSource).toContain("source: https://frontmatter.example.com/spec");
  await expect.poll(latestSource).not.toContain("[replace_frontmatter]");
  await page.keyboard.press("Control+z");
  await expect.poll(latestSource).toBe(doc);

  // 2b. Formatted paste over prose ("documentation") -> wraps [documentation](https://example.com/guide), then edit restored selection after undo
  await selectSubstringInSource(doc, "documentation");
  await pasteUrlInSource("https://example.com/guide");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(latestSource).toContain(
    "Read the [documentation](https://example.com/guide) or run `replace_inline` here.",
  );

  // Undo restores selection on "documentation"; typing over or formatting edits that existing selection directly
  await page.keyboard.press("Control+z");
  await expect.poll(latestSource).toBe(doc);
  await page.keyboard.press("Control+b");
  await expect.poll(latestSource).toContain("Read the **documentation** or run `replace_inline` here.");
  await page.keyboard.type("handbook");
  await expect.poll(latestSource).toContain("Read the **handbook** or run `replace_inline` here.");
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+z");
  await expect.poll(latestSource).toBe(doc);

  // 2c. Raw paste inside inline code ("replace_inline") -> replaces with plain URL
  await selectSubstringInSource(doc, "replace_inline");
  await pasteUrlInSource("https://inline.example.com/cmd");
  await expect.poll(latestSource).toContain("or run `https://inline.example.com/cmd` here.");
  await page.keyboard.press("Control+z");
  await expect.poll(latestSource).toBe(doc);

  // 2d. Raw paste inside fenced python code ("replace_me") -> replaces with plain URL (NOT [replace_me](url))
  await selectSubstringInSource(doc, "replace_me");
  await pasteUrlInSource("https://api.example.com/v1");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(latestSource).toContain('endpoint = "https://api.example.com/v1"');

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

test("maps single-block Live rendered selections across rich inline syntax, nested lists, inline code/math, and partial formatting while preserving direction, undo, and protected blocks", async ({ page }) => {
  const calls: Array<{ command: string; args: any }> = [];
  await page.exposeFunction("bridgePost", (id: string, command: string, raw: string) => {
    const args = JSON.parse(raw);
    calls.push({ command, args });
    void page.evaluate(({ id }) => window.supermdReply?.(id, true, null), { id });
  });
  await page.addInitScript(() => {
    window.SuperMD = { post: (id, command, args) => (window as any).bridgePost(id, command, args) };
  });
  await page.setViewportSize({ width: 1120, height: 780 });
  await page.goto("/android-reader.html");
  await page.waitForFunction(() => typeof window.supermdLoad === "function");

  const doc = [
    "---",
    "title: Guarded Note",
    "---",
    "",
    "Observe **Fourier** [guide](https://example.com) and selected rendered range with `inline_cmd` and $x + 1$.",
    "",
    "- Parent list item",
    "  - Nested list target",
    "",
    "Second paragraph stays separate.",
    "",
    "```python",
    "protected_value = 42",
    "```",
  ].join("\n");

  const latestContent = () => calls.filter((c) => c.command === "document_changed").at(-1)?.args.content ?? doc;

  await page.evaluate((content) => {
    window.supermdLoad?.({
      id: "selection-guard-note",
      content,
      path: "selection-guard-note",
      mode: "live",
      dark: false,
      fullscreen: false,
      colors: {},
      font: "sans",
      size: 16,
      zoom: 100,
    });
  }, doc);

  const selectRenderedSubstring = async (selector: string, target: string, reversed = false) => {
    await page.evaluate(
      ({ selector, target, reversed }) => {
        const container = document.querySelector(selector)!;
        const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
        const nodes: Array<{ node: Text; start: number; end: number }> = [];
        let full = "";
        let n: Node | null;
        while ((n = walker.nextNode())) {
          const t = n as Text;
          if (t.parentElement?.closest(".katex-mathml")) continue;
          const start = full.length;
          full += t.data;
          nodes.push({ node: t, start, end: full.length });
        }
        const idx = full.indexOf(target);
        if (idx < 0) throw new Error(`Missing "${target}" in "${full}"`);
        const endIdx = idx + target.length;
        const startEntry = nodes.find((e) => idx >= e.start && idx <= e.end)!;
        const endEntry = nodes.find((e) => endIdx >= e.start && endIdx <= e.end)!;
        const sel = window.getSelection()!;
        sel.removeAllRanges();
        if (reversed) {
          sel.setBaseAndExtent(endEntry.node, endIdx - endEntry.start, startEntry.node, idx - startEntry.start);
        } else {
          const range = document.createRange();
          range.setStart(startEntry.node, idx - startEntry.start);
          range.setEnd(endEntry.node, endIdx - endEntry.start);
          sel.addRange(range);
        }
      },
      { selector, target, reversed },
    );
  };

  // 1. Multi-paragraph rendered selection in Live mode is kept separate (no mutation)
  await page.evaluate(() => {
    const paras = document.querySelectorAll(".live-document p");
    const range = document.createRange();
    range.setStart(paras[0]!.firstChild!, 0);
    range.setEnd(paras[1]!.firstChild!, 6);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  });
  await page.keyboard.press("Control+b");
  expect(latestContent()).toBe(doc);
  await expect(page.getByRole("textbox", { name: "Edit Markdown block" })).toHaveCount(0);

  // 2. Rendered inline code, inline math, fenced code, and boundary-straddling partial selection are guarded from invalid formatting
  await selectRenderedSubstring(".live-document p code", "inline_cmd");
  await page.keyboard.press("Control+b");
  expect(latestContent()).toBe(doc);

  await page.evaluate(() => {
    const katexEl = document.querySelector(".live-document p .katex")!;
    const range = document.createRange();
    range.selectNode(katexEl);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  });
  await page.keyboard.press("Control+b");
  expect(latestContent()).toBe(doc);

  await selectRenderedSubstring(".live-document pre", "protected_value");
  await page.keyboard.press("Control+b");
  expect(latestContent()).toBe(doc);

  await selectRenderedSubstring(".live-document p", "rier guide");
  await page.keyboard.press("Control+b");
  expect(latestContent()).toBe(doc);
  await expect(page.getByRole("textbox", { name: "Edit Markdown block" })).toHaveCount(0);

  // 3. Backward rendered selection in Live mode maps across bold + link to exact source offsets, preserves backward direction, and undoes in one step
  await selectRenderedSubstring(".live-document p", "selected rendered range", true);
  await page.keyboard.press("Control+b");
  const liveBox = page.getByRole("textbox", { name: "Edit Markdown block" });
  await expect(liveBox).toBeVisible();
  await expect(liveBox).toHaveValue(
    "Observe **Fourier** [guide](https://example.com) and **selected rendered range** with `inline_cmd` and $x + 1$.",
  );
  await expect.poll(latestContent).toContain("and **selected rendered range** with `inline_cmd` and $x + 1$.");
  const formattedDir = await page.evaluate(
    () => document.querySelector<HTMLTextAreaElement>(".live-active-block textarea")!.selectionDirection,
  );
  expect(formattedDir).toBe("backward");
  await page.screenshot({ path: "/tmp/live-selected-rendered-range.png" });

  // Single-step Undo restores unbolded text, exact selection, and backward direction
  await page.keyboard.press("Control+z");
  await expect(liveBox).toHaveValue(
    "Observe **Fourier** [guide](https://example.com) and selected rendered range with `inline_cmd` and $x + 1$.",
  );
  await expect.poll(latestContent).toBe(doc);
  const restoredSel = await page.evaluate(() => {
    const area = document.querySelector<HTMLTextAreaElement>(".live-active-block textarea")!;
    return {
      selected: area.value.slice(area.selectionStart, area.selectionEnd),
      direction: area.selectionDirection,
    };
  });
  expect(restoredSel).toEqual({ selected: "selected rendered range", direction: "backward" });
  await page.keyboard.press("Escape");
  await expect(liveBox).toHaveCount(0);

  // 4. Existing formatted text (partial substring inside **Fourier**) unwraps cleanly without splitting, and nested list item formats cleanly
  await selectRenderedSubstring(".live-document p", "rier");
  await page.keyboard.press("Control+b");
  await expect(liveBox).toHaveValue(
    "Observe Fourier [guide](https://example.com) and selected rendered range with `inline_cmd` and $x + 1$.",
  );
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Escape");
  await expect.poll(latestContent).toBe(doc);

  await selectRenderedSubstring(".live-document ul ul li", "Nested list target");
  await page.keyboard.press("Control+i");
  await expect(liveBox).toBeVisible();
  await expect(liveBox).toHaveValue("- Parent list item\n  - *Nested list target*");
  await page.keyboard.press("Control+z");
  await expect.poll(latestContent).toBe(doc);
});
