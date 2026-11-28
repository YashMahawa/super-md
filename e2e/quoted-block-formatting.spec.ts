import { expect, test } from "@playwright/test";

test("toggles heading and list prefixes inside single and nested quotes while preserving markers and source selection offsets in Source, Split, and Live modes", async ({
  page,
}) => {
  const calls: Array<{ command: string; args: any }> = [];
  await page.exposeFunction("bridgePost", (id: string, command: string, raw: string) => {
    const args = JSON.parse(raw);
    calls.push({ command, args });
    void page.evaluate(({ id }) => window.supermdReply?.(id, true, null), { id });
  });
  await page.addInitScript(() => {
    window.SuperMD = { post: (id, command, args) => (window as any).bridgePost(id, command, args) };
  });

  await page.setViewportSize({ width: 1240, height: 800 });
  await page.goto("/android-reader.html");
  await page.waitForFunction(() => typeof window.supermdLoad === "function");

  const initialDoc = [
    "# Research Log",
    "",
    "> Primary observation",
    "> > Nested corollary",
    "",
    "Follow-up paragraph.",
  ].join("\n");

  const latestContent = () => calls.filter((c) => c.command === "document_changed").at(-1)?.args.content ?? initialDoc;
  const queryInsertionPoint = () =>
    page.evaluate(() => {
      const detail: { point?: { from: number; to: number } } = {};
      window.dispatchEvent(new CustomEvent("supermd-insertion-point", { detail }));
      return detail.point ?? null;
    });

  // 1. Source mode: toggle heading & list inside nested quote and verify source selection offsets
  await page.evaluate((content) => {
    window.supermdLoad?.({
      id: "quoted-format-note",
      content,
      path: "quoted-format-note",
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

  const corollaryFrom = initialDoc.indexOf("corollary");
  const corollaryTo = corollaryFrom + "corollary".length;
  await page.keyboard.press("Control+Home");
  for (let i = 0; i < corollaryFrom; i++) await page.keyboard.press("ArrowRight");
  for (let i = 0; i < "corollary".length; i++) await page.keyboard.press("Shift+ArrowRight");

  await expect.poll(queryInsertionPoint).toEqual({ from: corollaryFrom, to: corollaryTo });

  await page.keyboard.press("Control+Shift+H");
  await expect.poll(latestContent).toBe(
    ["# Research Log", "", "> Primary observation", "> > ## Nested corollary", "", "Follow-up paragraph."].join("\n"),
  );
  await expect.poll(queryInsertionPoint).toEqual({ from: corollaryFrom + 3, to: corollaryTo + 3 });

  await page.keyboard.press("Control+Shift+H");
  await expect.poll(latestContent).toBe(initialDoc);
  await expect.poll(queryInsertionPoint).toEqual({ from: corollaryFrom, to: corollaryTo });

  await page.keyboard.press("Control+Shift+L");
  await expect.poll(latestContent).toBe(
    ["# Research Log", "", "> Primary observation", "> > - Nested corollary", "", "Follow-up paragraph."].join("\n"),
  );
  await expect.poll(queryInsertionPoint).toEqual({ from: corollaryFrom + 2, to: corollaryTo + 2 });

  await page.keyboard.press("Control+Shift+L");
  await expect.poll(latestContent).toBe(initialDoc);
  await expect.poll(queryInsertionPoint).toEqual({ from: corollaryFrom, to: corollaryTo });

  // 2. Split mode: format outer quote as heading and nested quote as list, verify rendered preview + capture visual screenshot
  calls.length = 0;
  await page.evaluate((content) => {
    window.supermdLoad?.({
      id: "quoted-format-note",
      content,
      path: "quoted-format-note",
      mode: "split",
      dark: false,
      fullscreen: false,
      colors: {},
      font: "sans",
      size: 16,
      zoom: 100,
    });
  }, initialDoc);

  await expect(page.locator(".mode-split .markdown-body")).toBeVisible();
  await page.locator(".cm-content").click();
  const primaryFrom = initialDoc.indexOf("Primary");
  await page.keyboard.press("Control+Home");
  for (let i = 0; i < primaryFrom; i++) await page.keyboard.press("ArrowRight");
  await expect.poll(queryInsertionPoint).toEqual({ from: primaryFrom, to: primaryFrom });
  await page.evaluate(() => window.supermdFormat?.("heading"));

  const updatedAfterOuter = [
    "# Research Log",
    "",
    "> ## Primary observation",
    "> > Nested corollary",
    "",
    "Follow-up paragraph.",
  ].join("\n");
  await expect.poll(latestContent).toBe(updatedAfterOuter);
  await expect.poll(queryInsertionPoint).toEqual({ from: primaryFrom + 3, to: primaryFrom + 3 });

  const nestedAfterOuterFrom = updatedAfterOuter.indexOf("Nested");
  await page.keyboard.press("Control+Home");
  for (let i = 0; i < nestedAfterOuterFrom; i++) await page.keyboard.press("ArrowRight");
  await expect.poll(queryInsertionPoint).toEqual({ from: nestedAfterOuterFrom, to: nestedAfterOuterFrom });
  await page.evaluate(() => window.supermdFormat?.("list"));
  await expect.poll(queryInsertionPoint).toEqual({ from: nestedAfterOuterFrom + 2, to: nestedAfterOuterFrom + 2 });

  await expect(page.locator(".markdown-body blockquote > h2")).toHaveText("Primary observation");
  await expect(page.locator(".markdown-body blockquote blockquote ul li")).toHaveText("Nested corollary");
  await page.screenshot({ path: "/tmp/quoted-block-formatting.png" });

  // 3. Live mode: open blockquote, toggle heading & list on nested quote, verify markers and full-document source selection offsets
  calls.length = 0;
  await page.evaluate((content) => {
    window.supermdLoad?.({
      id: "quoted-format-note",
      content,
      path: "quoted-format-note",
      mode: "live",
      dark: false,
      fullscreen: false,
      colors: {},
      font: "sans",
      size: 16,
      zoom: 100,
    });
  }, initialDoc);

  await page.locator(".live-document blockquote").first().dblclick();
  const liveBox = page.getByRole("textbox", { name: "Edit Markdown block" });
  await expect(liveBox).toBeVisible();
  await expect(liveBox).toHaveValue("> Primary observation\n> > Nested corollary");

  const quoteOffset = initialDoc.indexOf("> Primary observation");
  const localCorollaryFrom = "> Primary observation\n> > Nested ".length;
  const localCorollaryTo = localCorollaryFrom + "corollary".length;

  await page.evaluate(
    ([start, end]) => {
      const area = document.querySelector<HTMLTextAreaElement>(".live-active-block textarea")!;
      area.focus();
      area.setSelectionRange(start, end);
    },
    [localCorollaryFrom, localCorollaryTo],
  );
  await expect.poll(queryInsertionPoint).toEqual({
    from: quoteOffset + localCorollaryFrom,
    to: quoteOffset + localCorollaryTo,
  });

  await page.evaluate(() => window.supermdFormat?.("heading"));
  await expect(liveBox).toHaveValue("> Primary observation\n> > ## Nested corollary");
  await expect.poll(queryInsertionPoint).toEqual({
    from: quoteOffset + localCorollaryFrom + 3,
    to: quoteOffset + localCorollaryTo + 3,
  });

  await page.evaluate(() => window.supermdFormat?.("heading"));
  await expect(liveBox).toHaveValue("> Primary observation\n> > Nested corollary");
  await expect.poll(queryInsertionPoint).toEqual({
    from: quoteOffset + localCorollaryFrom,
    to: quoteOffset + localCorollaryTo,
  });

  await page.evaluate(() => window.supermdFormat?.("list"));
  await expect(liveBox).toHaveValue("> Primary observation\n> > - Nested corollary");
  await expect.poll(queryInsertionPoint).toEqual({
    from: quoteOffset + localCorollaryFrom + 2,
    to: quoteOffset + localCorollaryTo + 2,
  });

  await page.keyboard.press("Escape");
  await expect(liveBox).toHaveCount(0);
  await expect(page.locator(".live-document blockquote blockquote ul li")).toHaveText("Nested corollary");

  // 4. Quoted thematic break regression: preserve `> - - -` alone and when selected next to an ordinary quoted line in Split and Live modes
  const ruleDoc = ["# Rule Check", "", "> Ordinary quoted line", "> - - -", "", "Trailing prose."].join("\n");
  const latestRuleContent = () =>
    calls.filter((c) => c.command === "document_changed").at(-1)?.args.content ?? ruleDoc;
  calls.length = 0;
  await page.evaluate((content) => {
    window.supermdLoad?.({
      id: "quoted-format-rule-note",
      content,
      path: "quoted-format-rule-note",
      mode: "split",
      dark: false,
      fullscreen: false,
      colors: {},
      font: "sans",
      size: 16,
      zoom: 100,
    });
  }, ruleDoc);

  await expect(page.locator(".mode-split .markdown-body blockquote > p")).toHaveText("Ordinary quoted line");
  await expect(page.locator(".mode-split .markdown-body blockquote > hr")).toHaveCount(1);
  await expect(page.locator(".mode-split .markdown-body blockquote ul")).toHaveCount(0);

  await page.locator(".cm-content").click();
  const ruleOnlyFrom = ruleDoc.indexOf("> - - -") + 2;
  await page.keyboard.press("Control+Home");
  for (let i = 0; i < ruleOnlyFrom; i++) await page.keyboard.press("ArrowRight");
  for (let i = 0; i < "- - -".length; i++) await page.keyboard.press("Shift+ArrowRight");
  await expect.poll(queryInsertionPoint).toEqual({ from: ruleOnlyFrom, to: ruleOnlyFrom + "- - -".length });

  await page.evaluate(() => window.supermdFormat?.("list"));
  await page.evaluate(() => window.supermdFormat?.("list"));
  expect(calls.filter((c) => c.command === "document_changed")).toHaveLength(0);
  await expect.poll(latestRuleContent).toBe(ruleDoc);
  await expect(page.locator(".mode-split .markdown-body blockquote > hr")).toHaveCount(1);
  await expect(page.locator(".mode-split .markdown-body blockquote ul")).toHaveCount(0);

  const ordinaryFrom = ruleDoc.indexOf("Ordinary");
  const ruleEnd = ruleDoc.indexOf("> - - -") + "> - - -".length;
  await page.keyboard.press("Control+Home");
  for (let i = 0; i < ordinaryFrom; i++) await page.keyboard.press("ArrowRight");
  for (let i = 0; i < ruleEnd - ordinaryFrom; i++) await page.keyboard.press("Shift+ArrowRight");
  await expect.poll(queryInsertionPoint).toEqual({ from: ordinaryFrom, to: ruleEnd });

  await page.evaluate(() => window.supermdFormat?.("list"));
  await expect.poll(latestRuleContent).toBe(
    ["# Rule Check", "", "> - Ordinary quoted line", "> - - -", "", "Trailing prose."].join("\n"),
  );
  await expect.poll(queryInsertionPoint).toEqual({ from: ordinaryFrom + 2, to: ruleEnd + 2 });
  await expect(page.locator(".mode-split .markdown-body blockquote > ul > li")).toHaveText("Ordinary quoted line");
  await expect(page.locator(".mode-split .markdown-body blockquote > hr")).toHaveCount(1);

  await page.evaluate(() => window.supermdFormat?.("list"));
  await expect.poll(latestRuleContent).toBe(ruleDoc);
  await expect.poll(queryInsertionPoint).toEqual({ from: ordinaryFrom, to: ruleEnd });
  await expect(page.locator(".mode-split .markdown-body blockquote > p")).toHaveText("Ordinary quoted line");
  await expect(page.locator(".mode-split .markdown-body blockquote > hr")).toHaveCount(1);
  await expect(page.locator(".mode-split .markdown-body blockquote ul")).toHaveCount(0);

  calls.length = 0;
  await page.evaluate((content) => {
    window.supermdLoad?.({
      id: "quoted-format-rule-note",
      content,
      path: "quoted-format-rule-note",
      mode: "live",
      dark: false,
      fullscreen: false,
      colors: {},
      font: "sans",
      size: 16,
      zoom: 100,
    });
  }, ruleDoc);

  await page.locator(".live-document blockquote").first().dblclick();
  await expect(liveBox).toBeVisible();
  await expect(liveBox).toHaveValue("> Ordinary quoted line\n> - - -");

  await page.evaluate(() => {
    const area = document.querySelector<HTMLTextAreaElement>(".live-active-block textarea")!;
    area.focus();
    area.setSelectionRange(2, area.value.length);
  });
  await page.evaluate(() => window.supermdFormat?.("list"));
  await expect(liveBox).toHaveValue("> - Ordinary quoted line\n> - - -");
  await page.keyboard.press("Escape");
  await expect(liveBox).toHaveCount(0);
  await expect(page.locator(".live-document blockquote > ul > li")).toHaveText("Ordinary quoted line");
  await expect(page.locator(".live-document blockquote > hr")).toHaveCount(1);

  await page.locator(".live-document blockquote").first().dblclick();
  await expect(liveBox).toBeVisible();
  await page.evaluate(() => {
    const area = document.querySelector<HTMLTextAreaElement>(".live-active-block textarea")!;
    area.focus();
    area.setSelectionRange(4, area.value.length);
  });
  await page.evaluate(() => window.supermdFormat?.("list"));
  await expect(liveBox).toHaveValue("> Ordinary quoted line\n> - - -");
  await page.keyboard.press("Escape");
  await expect(liveBox).toHaveCount(0);
  await expect(page.locator(".live-document blockquote > p")).toHaveText("Ordinary quoted line");
  await expect(page.locator(".live-document blockquote > hr")).toHaveCount(1);
  await expect(page.locator(".live-document blockquote ul")).toHaveCount(0);
});
