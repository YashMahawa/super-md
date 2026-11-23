import { expect, test } from "@playwright/test";

test("typewriter scroll centers active line during typing, respects custom line heights, and allows manual wheel scrolling", async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).nativeEvents = [];
    window.SuperMD = {
      post: (id: string, command: string, args: string) => {
        (window as any).nativeEvents.push({ command, args: JSON.parse(args) });
        queueMicrotask(() => window.supermdReply?.(id, true, null));
      },
    };
  });
  await page.setViewportSize({ width: 1100, height: 680 });
  await page.goto("/android-reader.html");
  await page.waitForFunction(() => typeof window.supermdLoad === "function");

  const lines = Array.from({ length: 90 }, (_, i) => `Line ${i + 1}: Focused study writing in Markdown paragraph ${i + 1}.`).join("\n");
  const baseState = {
    id: "tw-e2e",
    content: lines,
    path: null,
    mode: "editor" as const,
    dark: false,
    fullscreen: false,
    colors: {},
    font: "Manrope",
    size: 18,
    zoom: 100,
    typewriterScroll: false,
  };

  await page.evaluate((s) => window.supermdLoad?.(s), baseState);
  const toggleBtn = page.getByRole("button", { name: "Typewriter", exact: true });
  await expect(toggleBtn).toHaveAttribute("aria-pressed", "false");

  // Enable typewriter mode via status bar button and verify native bridge sync.
  await toggleBtn.click();
  await expect(toggleBtn).toHaveAttribute("aria-pressed", "true");
  expect(await page.evaluate(() => (window as any).nativeEvents.find((e: any) => e.command === "typewriter_scroll")?.args)).toEqual({ enabled: true });

  // Focus editor and type at Line 1: even the very first line should center thanks to half-viewport padding.
  await page.locator(".cm-content").click({ position: { x: 40, y: 12 } });
  await page.keyboard.type("Start: ");

  const measureCenterError = () =>
    page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>(".cm-scroller")!;
      const active = document.querySelector<HTMLElement>(".cm-activeLine")!;
      const sRect = scroller.getBoundingClientRect();
      const aRect = active.getBoundingClientRect();
      const scrollerCenter = sRect.top + sRect.height / 2;
      const lineCenter = aRect.top + aRect.height / 2;
      return { error: Math.abs(lineCenter - scrollerCenter), lineHeight: aRect.height, scrollTop: scroller.scrollTop };
    });

  await expect.poll(async () => (await measureCenterError()).error, { timeout: 3000 }).toBeLessThan(28);

  // Jump to end of document and type new lines: active line stays centered in viewport.
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Appended centered line at bottom");
  await expect.poll(async () => (await measureCenterError()).error, { timeout: 3000 }).toBeLessThan(28);

  // Guardrail 2: Apply custom theme line-height (--editor-leading: 2.2, --editor-size: 22px) and verify centering.
  await page.evaluate(() => {
    document.documentElement.style.setProperty("--editor-size", "22px");
    document.documentElement.style.setProperty("--editor-leading", "2.2");
  });
  await page.keyboard.press("Enter");
  await page.keyboard.type("Custom tall leading line");
  await expect.poll(async () => (await measureCenterError()).lineHeight, { timeout: 3000 }).toBeGreaterThan(42);
  await expect.poll(async () => (await measureCenterError()).error, { timeout: 3000 }).toBeLessThan(34);

  // Guardrail 1: Manual wheel scroll must move viewport freely without snap-back interference.
  const scrollerBox = (await page.locator(".cm-scroller").boundingBox())!;
  await page.mouse.move(scrollerBox.x + scrollerBox.width / 2, scrollerBox.y + scrollerBox.height / 2);
  const beforeWheelScrollTop = await page.locator(".cm-scroller").evaluate((el) => el.scrollTop);
  await page.mouse.wheel(0, -320);
  await expect
    .poll(async () => beforeWheelScrollTop - (await page.locator(".cm-scroller").evaluate((el) => el.scrollTop)), { timeout: 3000 })
    .toBeGreaterThan(200);

  // Keyboard shortcut Ctrl+Alt+T toggles typewriter mode off and back on.
  await page.locator(".cm-content").focus();
  await page.keyboard.press("Control+Alt+t");
  await expect(toggleBtn).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("Control+Alt+t");
  await expect(toggleBtn).toHaveAttribute("aria-pressed", "true");
});

test("status bar Typewriter toggle in web workspace immediately controls LiveEditor smooth block centering", async ({ page }) => {
  const blocks = Array.from({ length: 30 }, (_, i) => `## Topic ${i + 1}\n\nParagraph content for block ${i + 1} with study notes.`).join("\n\n");
  await page.addInitScript((initialContent) => {
    localStorage.setItem("setup.complete", "true");
    localStorage.setItem(
      "workspace.tabs.browser",
      JSON.stringify({
        activeId: "tab-1",
        tabs: [{ id: "tab-1", name: "Notes.md", path: null, content: initialContent, savedContent: initialContent }],
        recentlyClosed: [],
      })
    );
  }, blocks);

  await page.setViewportSize({ width: 1200, height: 720 });
  await page.goto("/");

  // Switch to Source view and click the status bar Typewriter button.
  await page.getByRole("button", { name: "editor view" }).click();
  const statusToggle = page.getByRole("button", { name: "Typewriter", exact: true });
  await expect(statusToggle).toHaveAttribute("aria-pressed", "false");
  await statusToggle.click();
  await expect(statusToggle).toHaveAttribute("aria-pressed", "true");

  // Switch to Live view and double-click a block near the bottom of the viewport: it smoothly centers!
  await page.getByRole("button", { name: "live view" }).click();
  await expect(page.locator(".live-document")).toHaveAttribute("data-typewriter", "true");

  const targetParagraph = page.getByText("Paragraph content for block 5 with study notes.", { exact: true });
  await targetParagraph.scrollIntoViewIfNeeded();
  // Position block near the lower portion of the viewport before double-clicking.
  await page.locator(".live-pane .reading-scroll").evaluate((el) => {
    el.scrollTop = Math.max(0, el.scrollTop - 160);
  });
  await targetParagraph.dblclick();

  const textarea = page.getByRole("textbox", { name: "Edit Markdown block" });
  await expect(textarea).toBeFocused();
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const scroller = document.querySelector<HTMLElement>(".live-pane .reading-scroll")!;
          const area = document.querySelector<HTMLElement>(".live-active-block textarea")!;
          const sRect = scroller.getBoundingClientRect();
          const aRect = area.getBoundingClientRect();
          return Math.abs(aRect.top + aRect.height / 2 - (sRect.top + sRect.height / 2));
        }),
      { timeout: 4000 },
    )
    .toBeLessThan(24);

  // Settings switch reflects and controls the same typewriter state.
  await textarea.press("Escape");
  await page.getByRole("button", { name: "Settings" }).click();
  const settingsDialog = page.getByRole("dialog", { name: "Settings" });
  await expect(settingsDialog).toBeVisible();
  const switchControl = settingsDialog.getByRole("switch", { name: "Typewriter scrolling" });
  await expect(switchControl).toBeChecked();
  await switchControl.click();
  await expect(switchControl).not.toBeChecked();
  await page.keyboard.press("Escape");
  await expect(page.locator(".live-document")).not.toHaveAttribute("data-typewriter", "true");
});

test("native supermdLoad toggle keeps active line centered across frames and fits narrow Android phone status bar", async ({ page }) => {
  await page.addInitScript(() => {
    document.documentElement.dataset.platform = "android";
    window.SuperMD = {
      post: (id: string) => {
        queueMicrotask(() => window.supermdReply?.(id, true, null));
      },
    };
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/android-reader.html");
  await page.waitForFunction(() => typeof window.supermdLoad === "function");

  const lines = Array.from({ length: 80 }, (_, i) => `Line ${i + 1}: Mobile study note entry ${i + 1}.`).join("\n");
  const baseState = {
    id: "tw-native-mobile",
    content: lines,
    path: null,
    mode: "editor" as const,
    dark: false,
    fullscreen: false,
    colors: {},
    font: "Manrope",
    size: 16,
    zoom: 100,
    typewriterScroll: false,
  };

  await page.evaluate((s) => window.supermdLoad?.(s), baseState);
  const statusBar = page.locator(".source-editor-status");
  const toggleBtn = page.getByRole("button", { name: "Typewriter", exact: true });
  const wrapBtn = page.getByRole("button", { name: "Wrap lines", exact: true });
  await expect(toggleBtn).toBeVisible();
  await expect(wrapBtn).toBeVisible();

  // Move cursor to the end of the document with a selection so the status bar has long Ln/Col/selected text on a 390px phone.
  await page.locator(".cm-content").focus();
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Shift+Home");
  const layoutFit = await statusBar.evaluate((el) => {
    const bar = el.getBoundingClientRect();
    const buttons = Array.from(el.querySelectorAll("button")).map((b) => b.getBoundingClientRect());
    return {
      overflow: el.scrollWidth - el.clientWidth,
      allButtonsInside: buttons.every((r) => r.left >= bar.left && r.right <= bar.right),
    };
  });
  expect(layoutFit.overflow).toBeLessThanOrEqual(0);
  expect(layoutFit.allButtonsInside).toBe(true);

  await page.keyboard.press("End");
  // Toggle typewriterScroll via native supermdLoad (simulating Qt Ctrl+Alt+T or Qt/Android Settings switch without DOM keydown).
  await page.evaluate((s) => window.supermdLoad?.({ ...s, contentUnchanged: true, typewriterScroll: true } as any), baseState);
  // Wait across multiple animation frames to verify captureScrollAnchor does not snap the centered cursor back.
  await page.waitForTimeout(150);
  await expect(toggleBtn).toHaveAttribute("aria-pressed", "true");

  const centerError = await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>(".cm-scroller")!;
    const active = document.querySelector<HTMLElement>(".cm-activeLine")!;
    const sRect = scroller.getBoundingClientRect();
    const aRect = active.getBoundingClientRect();
    return Math.abs((aRect.top + aRect.height / 2) - (sRect.top + sRect.height / 2));
  });
  expect(centerError).toBeLessThan(28);
});

test("typewriter mode is off by default for new and existing users and persists across reloads on web and native reader", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 740 });
  await page.goto("/");

  // 1. Brand-new user: dismiss welcome dialog if shown; typewriter must be OFF by default and unset in localStorage.
  const finishWelcome = page.getByRole("button", { name: /start writing|get started|continue|done/i }).first();
  if (await finishWelcome.isVisible().catch(() => false)) {
    await finishWelcome.click();
  }
  expect(await page.evaluate(() => localStorage.getItem("editor.typewriter"))).toBeNull();

  // 2. Existing user upgrading from an earlier version (populated preferences + tabs, no editor.typewriter key).
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem("setup.complete", "true");
    localStorage.setItem("theme.normal", "dark");
    localStorage.setItem("autosave", "true");
    localStorage.setItem("editor.size", "16");
    localStorage.setItem(
      "workspace.tabs.browser",
      JSON.stringify({
        activeId: "existing-1",
        tabs: [
          {
            id: "existing-1",
            name: "ExistingStudyNotes.md",
            path: null,
            content: "# Existing User Note\n\n$$\n\\sum_{n=1}^{\\infty} \\frac{1}{n^2} = \\frac{\\pi^2}{6}\n$$\n\nParagraph text.",
            savedContent: "# Existing User Note\n\n$$\n\\sum_{n=1}^{\\infty} \\frac{1}{n^2} = \\frac{\\pi^2}{6}\n$$\n\nParagraph text.",
          },
        ],
        recentlyClosed: [],
      }),
    );
  });
  await page.reload();

  // Verify OFF across Source, Split, Live, and Settings for upgraded existing user.
  await page.getByRole("button", { name: "editor view" }).click();
  const statusToggle = page.getByRole("button", { name: "Typewriter", exact: true });
  await expect(statusToggle).toHaveAttribute("aria-pressed", "false");

  await page.getByRole("button", { name: "split view" }).click();
  await expect(statusToggle).toHaveAttribute("aria-pressed", "false");

  await page.getByRole("button", { name: "live view" }).click();
  await expect(page.locator(".live-document")).not.toHaveAttribute("data-typewriter", "true");

  await page.getByRole("button", { name: "Settings" }).click();
  const settingsSwitch = page.getByRole("dialog", { name: "Settings" }).getByRole("switch", { name: "Typewriter scrolling" });
  await expect(settingsSwitch).not.toBeChecked();

  // Enable in Settings, close modal, and reload the browser page: setting must persist ON across all modes.
  await settingsSwitch.click();
  await expect(settingsSwitch).toBeChecked();
  expect(await page.evaluate(() => localStorage.getItem("editor.typewriter"))).toBe("true");
  await page.keyboard.press("Escape");

  await page.reload();
  // Desktop reloads into Split view by default: verify Typewriter persisted ON across Split, Live, and Source.
  await expect(statusToggle).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "live view" }).click();
  await expect(page.locator(".live-document")).toHaveAttribute("data-typewriter", "true");
  await page.getByRole("button", { name: "editor view" }).click();
  await expect(statusToggle).toHaveAttribute("aria-pressed", "true");

  // Disable via status bar button and reload: setting must persist OFF.
  await statusToggle.click();
  await expect(statusToggle).toHaveAttribute("aria-pressed", "false");
  expect(await page.evaluate(() => localStorage.getItem("editor.typewriter"))).toBe("false");

  await page.reload();
  await page.getByRole("button", { name: "editor view" }).click();
  await expect(statusToggle).toHaveAttribute("aria-pressed", "false");

  // Native reader payload omitting typewriterScroll must default OFF even if WebView localStorage had "true".
  await page.evaluate(() => localStorage.setItem("editor.typewriter", "true"));
  await page.goto("/android-reader.html");
  await page.waitForFunction(() => typeof window.supermdLoad === "function");
  await page.evaluate(() => {
    window.supermdLoad?.({
      id: "omitted-tw",
      content: "# Native Reader Default Off\n\nBody line.",
      path: null,
      mode: "editor",
      dark: false,
      fullscreen: false,
      colors: {},
      font: "Manrope",
      size: 16,
      zoom: 100,
    });
  });
  await expect(page.getByRole("button", { name: "Typewriter", exact: true })).toHaveAttribute("aria-pressed", "false");
});

test("browser typing, range selection, Chromium CDP IME composition, and undo/redo match identically with typewriter on vs off", async ({ page }) => {
  test.setTimeout(120_000);
  const initialStudyNote = [
    "---",
    "title: Quantum Statistical Mechanics & Multilingual Notes",
    "tags: [thermodynamics, 日本語, 中文, 🧪🔬🚀]",
    "---",
    "",
    "# 1. Grand Canonical Partition Function",
    "",
    "For chemical potential $\\mu$ and inverse temperature $\\beta = (k_B T)^{-1}$ on a Cafe\u0301 lattice:",
    "",
    "$$",
    "\\mathcal{Z}(\\beta, \\mu, V) = \\operatorname{Tr}\\exp\\!\\left(-\\beta(\\hat{H} - \\mu\\hat{N})\\right)",
    "$$",
    "",
    "| Ensemble | Potential | Fluctuation |",
    "| :--- | :---: | ---: |",
    "| Canonical | $F = -k_B T \\ln Z$ | $\\langle (\\Delta E)^2 \\rangle = k_B T^2 C_V$ 🧪 |",
    "| Grand Canonical | $\\Omega = -k_B T \\ln \\mathcal{Z}$ | Draft 🚀 |",
    "",
    "```python",
    "def fermi_dirac(energy: float, mu: float, beta: float) -> float:",
    "    import math",
    "    return 1.0 / (math.exp(beta * (energy - mu)) + 1.0)",
    "```",
    "",
    ...Array.from({ length: 45 }, (_, i) => `- [x] Derivation step ${i + 1}: verify Matsubara frequency $\\omega_n = (2n+1)\\pi / \\hbar\\beta$`),
  ].join("\n");

  await page.setViewportSize({ width: 1120, height: 680 });
  await page.addInitScript(() => {
    window.SuperMD = {
      post: (id: string, command: string, args: string) => {
        const parsed = args ? JSON.parse(args) : {};
        const reply =
          command === "document_sync" || command === "document_resync"
            ? { accepted: true, revision: 0 }
            : command === "document_patch"
              ? { accepted: true, revision: parsed.revision ?? 1 }
              : true;
        queueMicrotask(() => window.supermdReply?.(id, reply, null));
      },
    };
  });
  const cdp = await page.context().newCDPSession(page);

  const runScenario = async (typewriterEnabled: boolean) => {
    await page.goto("about:blank");
    await page.goto("/android-reader.html");
    await page.waitForFunction(() => typeof window.supermdLoad === "function");
    await page.evaluate(
      ({ content, tw }) => {
        localStorage.clear();
        window.supermdLoad?.({
          id: `tw-invariant-e2e-${tw}`,
          editProtocol: 1,
          content,
          path: null,
          mode: "editor",
          dark: false,
          fullscreen: false,
          colors: {},
          font: "Manrope",
          size: 17,
          zoom: 100,
          typewriterScroll: tw,
        } as any);
      },
      { content: initialStudyNote, tw: typewriterEnabled },
    );

    await expect(page.getByRole("button", { name: "Typewriter", exact: true })).toHaveAttribute(
      "aria-pressed",
      String(typewriterEnabled),
    );

    const checkpoints: Array<{
      label: string;
      doc: string;
      selection: { main: number; ranges: Array<{ anchor: number; head: number }> };
      status: string;
    }> = [];

    const record = async (label: string) => {
      const snap = await page.evaluate(() => {
        const contentEl = document.querySelector(".cm-content") as any;
        const cmView = contentEl?.cmTile?.root?.view ?? contentEl?.cmView?.view;
        if (!cmView) throw new Error("CodeMirror EditorView not found on .cm-content");
        return {
          doc: cmView.state.doc.toString() as string,
          selection: cmView.state.selection.toJSON() as { main: number; ranges: Array<{ anchor: number; head: number }> },
          status: document.querySelector(".source-position")?.textContent ?? "",
        };
      });
      checkpoints.push({ label, ...snap });
    };

    await record("initial");

    // 1. Jump to table row, type realistic Markdown + inline math + emoji, and use Backspace.
    const draftOffset = initialStudyNote.indexOf("Draft 🚀") + "Draft 🚀".length;
    await page.evaluate((offset) => {
      window.dispatchEvent(new CustomEvent("supermd-goto-offset", { detail: offset }));
    }, draftOffset);
    await page.keyboard.type(" -> $\\langle (\\Delta N)^2 \\rangle = k_B T (\\partial N/\\partial\\mu)_{T,V}$!X");
    await page.keyboard.press("Backspace");
    await record("after-math-typing-and-backspace");

    // 2. Keyboard backward range selection (Shift+ArrowLeft) and replacement, then forward range selection (Shift+ArrowRight).
    for (let i = 0; i < 6; i++) await page.keyboard.press("Shift+ArrowLeft");
    await record("backward-selection");
    await page.keyboard.type("_{T,V}$ ✅");
    await record("replace-backward-selection");

    await page.keyboard.press("Home");
    for (let i = 0; i < 12; i++) await page.keyboard.press("Shift+ArrowRight");
    await record("forward-selection-from-line-start");
    await page.keyboard.press("End");

    // 3. Jump to bottom of document, let CodeMirror's viewport Markdown parser settle, and perform multi-stage Chromium CDP IME compositions.
    await page.keyboard.press("Control+End");
    await page.waitForTimeout(200);
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.type("## 2. IME Derivations: ");
    await page.waitForTimeout(550); // Ensure distinct undo history boundary before IME composition

    // Japanese Kana -> Kanji candidate cycling via real Chromium Input.imeSetComposition + Input.insertText
    await cdp.send("Input.imeSetComposition", { text: "b", selectionStart: 1, selectionEnd: 1 });
    await cdp.send("Input.imeSetComposition", { text: "ぶんぱい", selectionStart: 4, selectionEnd: 4 });
    await cdp.send("Input.imeSetComposition", { text: "ぶんぱいかんすう", selectionStart: 4, selectionEnd: 8 });
    await record("during-japanese-ime-preedit");
    await cdp.send("Input.insertText", { text: "分配関数と自由エネルギー" });
    await record("committed-japanese-ime");

    await page.waitForTimeout(550);
    await page.keyboard.type(" · ");
    await page.waitForTimeout(550);

    // Chinese Pinyin multi-syllable IME composition
    await cdp.send("Input.imeSetComposition", { text: "jueregongshi", selectionStart: 12, selectionEnd: 12 });
    await cdp.send("Input.insertText", { text: "巨正则系综" });
    await record("committed-chinese-ime");

    await page.waitForTimeout(550);
    // Cancelled IME composition (preedit shown, then cancelled to empty string)
    await cdp.send("Input.imeSetComposition", { text: "טיוטה", selectionStart: 5, selectionEnd: 5 });
    await cdp.send("Input.imeSetComposition", { text: "", selectionStart: 0, selectionEnd: 0 });
    await record("cancelled-ime-preedit");

    const centerErrorAtBottom = await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>(".cm-scroller")!;
      const active = document.querySelector<HTMLElement>(".cm-activeLine")!;
      const sRect = scroller.getBoundingClientRect();
      const aRect = active.getBoundingClientRect();
      return Math.abs((aRect.top + aRect.height / 2) - (sRect.top + sRect.height / 2));
    });

    // 4. Multi-step Undo (Ctrl+Z) and Redo (Ctrl+Y) across IME commits and Markdown/math edits.
    for (let step = 1; step <= 4; step++) {
      await page.keyboard.press("Control+z");
      await record(`undo-${step}`);
    }
    for (let step = 1; step <= 4; step++) {
      await page.keyboard.press("Control+y");
      await record(`redo-${step}`);
    }

    return { checkpoints, centerErrorAtBottom };
  };

  const offResult = await runScenario(false);
  const onResult = await runScenario(true);
  await cdp.detach().catch(() => {});

  expect(onResult.checkpoints).toEqual(offResult.checkpoints);
  expect(onResult.centerErrorAtBottom).toBeLessThan(28);
  expect(offResult.centerErrorAtBottom).toBeGreaterThan(80);
});

test("sustains 60 chars/s typing in a 20,000-line Markdown note with typewriter on without noticeable frame drops", async ({ page }) => {
  test.setTimeout(150_000);

  // Build a realistic 20,000-line (~1.1 MB) Markdown study document with headings, prose, LaTeX math, tables, and code blocks.
  const build20kNote = () => {
    const lines: string[] = [
      "---",
      "title: Comprehensive 20,000-Line Physics & Systems Engineering Compendium",
      "---",
      "",
    ];
    let section = 1;
    while (lines.length < 19_990) {
      lines.push(`## Section ${section}: Relativistic Mechanics & Spectral Analysis`);
      lines.push("");
      lines.push(
        `In lecture ${section}, we evaluate the Lagrangian density $\\mathcal{L}(\\phi, \\partial_\\mu\\phi) = \\frac{1}{2}(\\partial_\\mu\\phi)(\\partial^\\mu\\phi) - \\frac{1}{2}m^2\\phi^2$ across discrete lattice manifolds.`,
      );
      lines.push("");
      lines.push("| Mode | Eigenvalue $\\lambda_k$ | Convergence | Notes |");
      lines.push("| :--- | :---: | :---: | ---: |");
      lines.push(`| $k=${section}$ | $\\omega_k = \\sqrt{c^2 k^2 + m^2 c^4 / \\hbar^2}$ | $O(h^4)$ | Verified 🧪 |`);
      lines.push("");
      lines.push("```python");
      lines.push(`def dispersion_${section}(k: float, m: float = 1.0, c: float = 299792458.0) -> float:`);
      lines.push("    return (c * c * k * k + m * m) ** 0.5");
      lines.push("```");
      lines.push("");
      lines.push(`- [x] Confirm symplectic integrator energy drift $< 10^{-12}$ at step ${section}`);
      lines.push(`- [ ] Cross-check Green's function pole structure for $G_R(\\omega, \\mathbf{k})$`);
      lines.push("");
      section++;
    }
    while (lines.length < 20_000) {
      lines.push(`Appendix reference line ${lines.length + 1}: orthogonal polynomial recurrence relation.`);
    }
    return lines.slice(0, 20_000).join("\n");
  };

  const largeNote = build20kNote();
  expect(largeNote.split("\n")).toHaveLength(20_000);

  const run60CharsPerSecProbe = async (surfaceLabel: string) =>
    page.evaluate(async (label: string) => {
      const contentEl = document.querySelector(".cm-content") as any;
      const cmView = contentEl?.cmTile?.root?.view ?? contentEl?.cmView?.view;
      if (!cmView) throw new Error(`EditorView missing on ${label}`);
      cmView.focus();

      // Position cursor near line 10,000 in the middle of the 20,000-line document and let initial background parse/scroll settle.
      const targetLine = cmView.state.doc.line(10_000);
      cmView.dispatch({
        selection: { anchor: targetLine.to },
        scrollIntoView: true,
        userEvent: "select",
      });
      // Warm up the incremental edit + fragment reuse path with a reversible no-op edit before starting telemetry.
      cmView.dispatch({
        changes: { from: targetLine.to, to: targetLine.to, insert: " " },
        selection: { anchor: targetLine.to + 1 },
        scrollIntoView: true,
        userEvent: "input.type",
      });
      cmView.dispatch({
        changes: { from: targetLine.to, to: targetLine.to + 1, insert: "" },
        selection: { anchor: targetLine.to },
        scrollIntoView: true,
        userEvent: "delete.backward",
      });
      await new Promise((resolve) => window.setTimeout(resolve, 2000));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

      const longTasks: Array<{ duration: number; startTime: number }> = [];
      let observer: PerformanceObserver | null = null;
      if (typeof PerformanceObserver !== "undefined") {
        observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            longTasks.push({ duration: Number(entry.duration.toFixed(2)), startTime: Number(entry.startTime.toFixed(1)) });
          }
        });
        try {
          observer.observe({ type: "longtask", buffered: false });
        } catch {
          // Ignore if unsupported.
        }
      }

      const streamText =
        "\nTyped @ 60 chars/s: $\\int_0^\\infty e^{-\\alpha x^2}\\,dx = \\frac{1}{2}\\sqrt{\\frac{\\pi}{\\alpha}}$ — smooth centered viewport!\n" +
        "Second 60Hz line: verifying zero noticeable frame drops on a 20,000-line study note.";
      const chars = Array.from(streamText).slice(0, 180); // Exactly 180 chars @ 60 chars/s = 3.00s

      const frameDeltas: number[] = [];
      let rafActive = true;
      let prevFrame = performance.now();
      const tickFrame = (now: number) => {
        if (!rafActive) return;
        frameDeltas.push(now - prevFrame);
        prevFrame = now;
        requestAnimationFrame(tickFrame);
      };
      requestAnimationFrame((now) => {
        prevFrame = now;
        requestAnimationFrame(tickFrame);
      });

      const keystrokeCosts: number[] = [];
      const startWall = performance.now();

      await new Promise<void>((resolve) => {
        let index = 0;
        const step = () => {
          const ch = chars[index++];
          const t0 = performance.now();
          const head = cmView.state.selection.main.head;
          cmView.dispatch({
            changes: { from: head, to: head, insert: ch },
            selection: { anchor: head + ch.length },
            scrollIntoView: true,
            userEvent: "input.type",
          });
          keystrokeCosts.push(performance.now() - t0);
          if (index >= chars.length) {
            resolve();
            return;
          }
          const nextDue = startWall + index * (1000 / 60);
          window.setTimeout(step, Math.max(0, nextDue - performance.now()));
        };
        step();
      });

      const elapsedMs = performance.now() - startWall;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      rafActive = false;
      await new Promise((resolve) => window.setTimeout(resolve, 40));
      observer?.disconnect();

      const percentile = (values: number[], p: number) => {
        if (!values.length) return 0;
        const sorted = [...values].sort((a, b) => a - b);
        return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
      };
      const avg = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);

      const host = document.querySelector<HTMLElement>(".editor-host")!;
      const scroller = document.querySelector<HTMLElement>(".cm-scroller")!;
      const active = document.querySelector<HTMLElement>(".cm-activeLine")!;
      const hRect = host.getBoundingClientRect();
      const aRect = active.getBoundingClientRect();
      const centerErrorPx = Math.abs((aRect.top + aRect.height / 2) - (hRect.top + hRect.height / 2));
      const scrollerHeightDeltaPx = Math.abs(scroller.clientHeight - host.clientHeight);

      return {
        surface: label,
        lines: cmView.state.doc.lines,
        charCount: chars.length,
        elapsedMs: Number(elapsedMs.toFixed(1)),
        effectiveCharsPerSec: Number(((chars.length * 1000) / elapsedMs).toFixed(1)),
        perKeystrokeMs: {
          avg: Number(avg(keystrokeCosts).toFixed(3)),
          p50: Number(percentile(keystrokeCosts, 0.5).toFixed(3)),
          p95: Number(percentile(keystrokeCosts, 0.95).toFixed(3)),
          max: Number(Math.max(...keystrokeCosts).toFixed(3)),
        },
        frames: {
          count: frameDeltas.length,
          avgMs: Number(avg(frameDeltas).toFixed(2)),
          p95Ms: Number(percentile(frameDeltas, 0.95).toFixed(2)),
          maxMs: Number((frameDeltas.length ? Math.max(...frameDeltas) : 0).toFixed(2)),
          framesOver50ms: frameDeltas.filter((d) => d > 50).length,
        },
        longTasks: {
          count: longTasks.length,
          totalDurationMs: Number(longTasks.reduce((sum, item) => sum + item.duration, 0).toFixed(2)),
          maxDurationMs: Number((longTasks.length ? Math.max(...longTasks.map((t) => t.duration)) : 0).toFixed(2)),
          entries: longTasks,
        },
        scrollerHeightDeltaPx,
        centerErrorPx: Number(centerErrorPx.toFixed(2)),
        insertedPresent: cmView.state.doc.toString().includes(chars.join("")),
      };
    }, surfaceLabel);

  // Surface A: Shared Native Reader (/android-reader.html, used by Qt Desktop & Android)
  await page.addInitScript(() => {
    window.SuperMD = {
      post: (id: string, command: string, args: string) => {
        const parsed = args ? JSON.parse(args) : {};
        const reply =
          command === "document_sync" || command === "document_resync"
            ? { accepted: true, revision: 0 }
            : command === "document_patch"
              ? { accepted: true, revision: parsed.revision ?? 1 }
              : true;
        queueMicrotask(() => window.supermdReply?.(id, reply, null));
      },
    };
  });
  await page.setViewportSize({ width: 1280, height: 760 });
  await page.goto("/android-reader.html");
  await page.waitForFunction(() => typeof window.supermdLoad === "function");
  await page.evaluate((content) => {
    window.supermdLoad?.({
      id: "perf-20k-native-off",
      editProtocol: 1,
      content,
      path: null,
      mode: "editor",
      dark: false,
      fullscreen: false,
      colors: {},
      font: "Manrope",
      size: 16,
      zoom: 100,
      typewriterScroll: false,
    } as any);
  }, largeNote);
  await expect(page.getByRole("button", { name: "Typewriter", exact: true })).toHaveAttribute("aria-pressed", "false");
  const nativeOffReport = await run60CharsPerSecProbe("native-reader-20k-off");
  console.log("[TYPEWRITER_20K_PERF]", JSON.stringify(nativeOffReport));

  await page.goto("about:blank");
  await page.goto("/android-reader.html");
  await page.waitForFunction(() => typeof window.supermdLoad === "function");
  await page.evaluate((content) => {
    window.supermdLoad?.({
      id: "perf-20k-native",
      editProtocol: 1,
      content,
      path: null,
      mode: "editor",
      dark: false,
      fullscreen: false,
      colors: {},
      font: "Manrope",
      size: 16,
      zoom: 100,
      typewriterScroll: true,
    } as any);
  }, largeNote);
  await expect(page.getByRole("button", { name: "Typewriter", exact: true })).toHaveAttribute("aria-pressed", "true");

  const nativeReport = await run60CharsPerSecProbe("native-reader-20k");
  console.log("[TYPEWRITER_20K_PERF]", JSON.stringify(nativeReport));

  expect(nativeReport.insertedPresent).toBe(true);
  expect(nativeReport.lines).toBeGreaterThanOrEqual(20_002);
  expect(nativeReport.scrollerHeightDeltaPx).toBeLessThanOrEqual(2);
  expect(nativeReport.perKeystrokeMs.p50).toBeLessThanOrEqual(Math.max(28, nativeOffReport.perKeystrokeMs.p50 * 1.5 + 8));
  expect(nativeReport.perKeystrokeMs.avg).toBeLessThanOrEqual(Math.max(35, nativeOffReport.perKeystrokeMs.avg * 1.5 + 10));
  expect(nativeReport.frames.framesOver50ms).toBeLessThanOrEqual(Math.max(24, Math.ceil(nativeOffReport.frames.framesOver50ms * 1.6) + 10));
  expect(nativeReport.longTasks.count).toBeLessThanOrEqual(Math.max(18, nativeOffReport.longTasks.count + 8));
  expect(nativeReport.longTasks.maxDurationMs).toBeLessThanOrEqual(Math.max(400, nativeOffReport.longTasks.maxDurationMs * 1.6 + 120));
  expect(nativeReport.centerErrorPx).toBeLessThan(28);
  expect(nativeOffReport.centerErrorPx).toBeGreaterThan(80);

  // Surface B: Web Workspace (/ in Source mode)
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.setItem("setup.complete", "true");
    localStorage.setItem("editor.typewriter", "false");
  });
  await page.reload();
  await page.getByRole("button", { name: "editor view" }).click();
  await expect(page.getByRole("button", { name: "Typewriter", exact: true })).toHaveAttribute("aria-pressed", "false");
  await page.evaluate((content) => {
    const contentEl = document.querySelector(".cm-content") as any;
    const cmView = contentEl?.cmTile?.root?.view ?? contentEl?.cmView?.view;
    cmView.dispatch({ changes: { from: 0, to: cmView.state.doc.length, insert: content } });
  }, largeNote);
  await page.waitForTimeout(1500);

  const webOffReport = await run60CharsPerSecProbe("web-workspace-source-20k-off");
  console.log("[TYPEWRITER_20K_PERF]", JSON.stringify(webOffReport));

  await page.getByRole("button", { name: "Typewriter", exact: true }).click();
  await expect(page.getByRole("button", { name: "Typewriter", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.waitForTimeout(400);

  const webReport = await run60CharsPerSecProbe("web-workspace-source-20k");
  console.log("[TYPEWRITER_20K_PERF]", JSON.stringify(webReport));

  expect(webReport.insertedPresent).toBe(true);
  expect(webReport.lines).toBeGreaterThanOrEqual(20_004);
  expect(webReport.scrollerHeightDeltaPx).toBeLessThanOrEqual(2);
  expect(webReport.perKeystrokeMs.p50).toBeLessThanOrEqual(Math.max(28, webOffReport.perKeystrokeMs.p50 * 1.5 + 8));
  expect(webReport.perKeystrokeMs.avg).toBeLessThanOrEqual(Math.max(35, webOffReport.perKeystrokeMs.avg * 1.5 + 10));
  expect(webReport.frames.framesOver50ms).toBeLessThanOrEqual(Math.max(24, Math.ceil(webOffReport.frames.framesOver50ms * 1.6) + 10));
  expect(webReport.longTasks.count).toBeLessThanOrEqual(Math.max(18, webOffReport.longTasks.count + 8));
  expect(webReport.longTasks.maxDurationMs).toBeLessThanOrEqual(Math.max(400, webOffReport.longTasks.maxDurationMs * 1.6 + 120));
  expect(webReport.centerErrorPx).toBeLessThan(28);
  expect(webOffReport.centerErrorPx).toBeGreaterThan(80);

  await page.evaluate(() => localStorage.clear());
  await page.goto("about:blank");
});

