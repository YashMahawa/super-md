import { test, expect } from "@playwright/test";

test("relative links and wikilinks open target notes across Live, Read, and Split modes over open_workspace_link and scroll to pendingHeading", async ({ page }) => {
  await page.addInitScript(() => {
    const notes: Record<string, { id: string; path: string; content: string }> = {
      "/notes/Index.md": {
        id: "tab-index",
        path: "/notes/Index.md",
        content: [
          "# Course Index",
          "",
          "- [Lecture 2](lecture-2.md)",
          "- [Deck](study.smd)",
          "- [[Task Note]]",
          "- [[Lecture 2#Bayes|Bayes Theorem]]",
          "- [Secret](../outside.md)",
        ].join("\n"),
      },
      "/notes/lecture-2.md": {
        id: "tab-lecture-2-lower",
        path: "/notes/lecture-2.md",
        content: "# Lecture Two (Markdown Link)\n\nOpened via standard relative Markdown link.\n",
      },
      "/notes/study.smd": {
        id: "tab-study-smd",
        path: "/notes/study.smd",
        content: "# Portable Study Deck\n\nOpened from a relative `.smd` note link.\n",
      },
      "/notes/Task Note.md": {
        id: "tab-task-note",
        path: "/notes/Task Note.md",
        content: "# Task Note\n\nOpened from a spaced wikilink.\n",
      },
      "/notes/Lecture 2.md": {
        id: "tab-lecture-2",
        path: "/notes/Lecture 2.md",
        content:
          "# Lecture 2\n\n" +
          Array.from({ length: 45 }, (_, i) => `## Background ${i + 1}\n\n${"Introductory probability context. ".repeat(12)}\n`).join("\n") +
          "\n## Bayes\n\nPosterior equals likelihood times prior over evidence.\n\n" +
          Array.from({ length: 30 }, (_, i) => `## Appendix ${i + 1}\n\n${"Further derivations and exercises. ".repeat(12)}\n`).join("\n"),
      },
    };
    let jumpCounter = 0;
    (window as any).__rpcCalls = [];
    window.SuperMD = {
      post(id, command, raw) {
        const args = JSON.parse(raw);
        if (command === "document_sync") {
          window.supermdReply?.(id, { accepted: true, revision: 0 }, null);
          return;
        }
        if (command === "document_patch") {
          window.supermdReply?.(id, { accepted: true, revision: args.revision }, null);
          return;
        }
        if (command === "open_workspace_link") {
          (window as any).__rpcCalls.push(args);
          if (!args.documentPath) {
            window.supermdReply?.(id, { opened: false, message: "Save this note before opening linked notes." }, null);
            return;
          }
          if (String(args.target).startsWith("..")) {
            window.supermdReply?.(id, { opened: false, message: "Linked note is outside the authorized folder." }, null);
            return;
          }
          const decoded = decodeURIComponent(args.target);
          const hasExt = /\.(?:md|smd|fmd|markdown|txt)$/i.test(decoded);
          const resolvedPath = `/notes/${hasExt ? decoded : `${decoded}.md`}`;
          const target = notes[resolvedPath];
          if (!target) {
            window.supermdReply?.(id, { opened: false, message: `Linked note not found: ${decoded}` }, null);
            return;
          }
          const mode = (window as any).__testMode || "live";
          window.supermdReply?.(id, { opened: true, id: target.id, path: target.path }, null);
          window.supermdLoad?.({
            id: target.id,
            path: target.path,
            content: target.content,
            mode,
            dark: false,
            fullscreen: false,
            colors: {},
            font: "Manrope",
            size: 16,
            zoom: 100,
            motion: false,
            editProtocol: 1,
            restorePosition: true,
            readingLocation: { top: 0, offset: 0, zoom: 100, mode },
            ...(args.fragment ? { pendingHeading: { heading: args.fragment, token: `jump-${++jumpCounter}` } } : {}),
          });
          return;
        }
        window.supermdReply?.(id, true, null);
      },
    };
    (window as any).__loadIndex = (mode: "live" | "reader" | "split") => {
      (window as any).__testMode = mode;
      const index = notes["/notes/Index.md"];
      window.supermdLoad?.({
        id: index.id,
        path: index.path,
        content: index.content,
        mode,
        dark: false,
        fullscreen: false,
        colors: {},
        font: "Manrope",
        size: 16,
        zoom: 100,
        motion: false,
        editProtocol: 1,
      });
    };
  });

  await page.goto("/android-reader.html");
  await page.waitForFunction(() => typeof window.supermdLoad === "function");

  for (const mode of ["live", "reader", "split"] as const) {
    await page.evaluate(m => (window as any).__loadIndex(m), mode);
    await expect(page.locator(".android-reading h1")).toHaveText("Course Index");

    await page.locator('.android-reading a:has-text("Lecture 2")').click();
    await expect(page.locator(".android-reading h1")).toHaveText("Lecture Two (Markdown Link)");

    await page.evaluate(m => (window as any).__loadIndex(m), mode);
    await page.locator('.android-reading a:has-text("Deck")').click();
    await expect(page.locator(".android-reading h1")).toHaveText("Portable Study Deck");

    await page.evaluate(m => (window as any).__loadIndex(m), mode);
    await page.locator('.android-reading a:has-text("Task Note")').click();
    await expect(page.locator(".android-reading h1")).toHaveText("Task Note");

    await page.evaluate(m => (window as any).__loadIndex(m), mode);
    await page.locator('.android-reading a:has-text("Bayes Theorem")').click();
    await expect(page.locator(".android-reading h1")).toHaveText("Lecture 2");
    await expect.poll(() =>
      page.locator(".android-reading h2#bayes").evaluate(el => {
        const scroller = el.closest(".android-reading")!;
        return Math.abs(el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 16);
      })
    ).toBeLessThan(8);
  }

  // Verify blocked ../outside.md surfaces a safe status notice without changing URL.
  await page.evaluate(() => (window as any).__loadIndex("reader"));
  await page.locator('.android-reading a:has-text("Secret")').click();
  await expect(page.locator('[role="status"].reader-link-notice')).toContainText("Linked note is outside the authorized folder.");
  expect(page.url()).toContain("/android-reader.html");

  // Verify unsaved note without saved path surfaces an in-app status notice.
  await page.evaluate(() => {
    window.supermdLoad?.({
      id: "unsaved-tab-1",
      path: "unsaved-tab-1",
      content: "# Unsaved Draft\n\nFollow [[Task Note]].\n",
      mode: "live",
      dark: false,
      fullscreen: false,
      colors: {},
      font: "Manrope",
      size: 16,
      zoom: 100,
      motion: false,
    });
  });
  await page.locator('.android-reading a:has-text("Task Note")').click();
  await expect(page.locator('[role="status"].reader-link-notice')).toContainText("Save this note before opening linked notes.");
});

test("pendingHeading coexists with shared source anchor mode transitions and ordinary tab position restore", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.addInitScript(() => {
    const lectureContent =
      "# Lecture 2\n\n" +
      Array.from({ length: 45 }, (_, i) => `## Background ${i + 1}\n\n${"Introductory probability context. ".repeat(12)}\n`).join("\n") +
      "\n## Bayes\n\nPosterior equals likelihood times prior over evidence.\n\n" +
      Array.from({ length: 35 }, (_, i) => `## Appendix ${i + 1}\n\n${"Further derivations and exercises. ".repeat(12)}\n`).join("\n");
    const appendixOffset = lectureContent.indexOf("## Appendix 25");
    const notes: Record<string, { id: string; path: string; content: string }> = {
      "/notes/Index.md": {
        id: "tab-index",
        path: "/notes/Index.md",
        content: "# Course Index\n\n- [[Lecture 2#Bayes|Bayes Theorem]]\n",
      },
      "/notes/Lecture 2.md": {
        id: "tab-lecture-2",
        path: "/notes/Lecture 2.md",
        content: lectureContent,
      },
    };
    let jumpSeq = 0;
    const savedLocations: Record<string, any> = {
      "/notes/Lecture 2.md": { top: 4200, offset: appendixOffset, zoom: 100, mode: "live" },
    };
    window.SuperMD = {
      post(id, command, raw) {
        const args = JSON.parse(raw);
        if (command === "document_sync") {
          window.supermdReply?.(id, { accepted: true, revision: 0 }, null);
          return;
        }
        if (command === "reading_position" && args.location) {
          const note = Object.values(notes).find(item => item.id === args.id);
          if (note) savedLocations[note.path] = args.location;
          window.supermdReply?.(id, true, null);
          return;
        }
        if (command === "open_workspace_link") {
          const target = notes["/notes/Lecture 2.md"];
          const mode = (window as any).__currentMode || "live";
          window.supermdReply?.(id, { opened: true, id: target.id, path: target.path }, null);
          window.supermdLoad?.({
            id: target.id,
            path: target.path,
            content: target.content,
            mode,
            dark: false,
            fullscreen: false,
            colors: {},
            font: "Manrope",
            size: 16,
            zoom: 100,
            motion: false,
            editProtocol: 1,
            restorePosition: true,
            readingLocation: savedLocations[target.path] ?? null,
            pendingHeading: { heading: args.fragment, token: `heading-${++jumpSeq}` },
          });
          return;
        }
        window.supermdReply?.(id, true, null);
      },
    };
    (window as any).__openTab = (notePath: string, mode: "live" | "reader" | "split" | "editor", pendingHeading?: string) => {
      (window as any).__currentMode = mode;
      const target = notes[notePath];
      window.supermdLoad?.({
        id: target.id,
        path: target.path,
        content: target.content,
        mode,
        dark: false,
        fullscreen: false,
        colors: {},
        font: "Manrope",
        size: 16,
        zoom: 100,
        motion: false,
        editProtocol: 1,
        restorePosition: true,
        readingLocation: savedLocations[target.path] ?? null,
        ...(pendingHeading ? { pendingHeading: { heading: pendingHeading, token: `heading-${++jumpSeq}` } } : {}),
      });
    };
  });

  await page.goto("/android-reader.html");
  await page.waitForFunction(() => typeof window.supermdLoad === "function");

  // 1. Open Index in Live mode and follow [[Lecture 2#Bayes|Bayes Theorem]] despite prior Appendix 25 readingLocation.
  await page.evaluate(() => (window as any).__openTab("/notes/Index.md", "live"));
  await page.locator('.android-reading a:has-text("Bayes Theorem")').click();
  await expect.poll(() =>
    page.locator(".android-reading h2#bayes").evaluate(el => {
      const scroller = el.closest(".android-reading")!;
      return Math.abs(el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 16);
    }),
  ).toBeLessThan(12);

  // 2. Ordinary mode transitions after pendingHeading (Live -> Split -> Source -> Live) preserve the #Bayes shared source anchor.
  await page.evaluate(() => (window as any).__openTab("/notes/Lecture 2.md", "split"));
  const cmScroller = page.locator(".cm-scroller");
  const readingRoot = page.locator(".android-reading");
  await expect(cmScroller).toBeVisible();
  await expect.poll(() =>
    page.locator(".cm-line", { hasText: "## Bayes" }).evaluate(el => {
      const box = el.getBoundingClientRect();
      const hostBox = el.closest(".cm-scroller")!.getBoundingClientRect();
      return box.bottom > hostBox.top && box.top < hostBox.bottom;
    }),
  ).toBe(true);
  await expect.poll(() =>
    page.locator(".android-reading h2#bayes").evaluate(el => {
      const box = el.getBoundingClientRect();
      const hostBox = el.closest(".android-reading")!.getBoundingClientRect();
      return box.bottom > hostBox.top && box.top < hostBox.bottom;
    }),
  ).toBe(true);

  await page.evaluate(() => (window as any).__openTab("/notes/Lecture 2.md", "editor"));
  await expect.poll(() =>
    page.locator(".cm-line", { hasText: "## Bayes" }).evaluate(el => {
      const box = el.getBoundingClientRect();
      const hostBox = el.closest(".cm-scroller")!.getBoundingClientRect();
      return box.bottom > hostBox.top && box.top < hostBox.bottom;
    }),
  ).toBe(true);

  await page.evaluate(() => (window as any).__openTab("/notes/Lecture 2.md", "live"));
  await expect.poll(() =>
    page.locator(".android-reading h2#bayes").evaluate(el => {
      const scroller = el.closest<HTMLElement>(".android-reading")!;
      const box = el.getBoundingClientRect();
      const hostBox = scroller.getBoundingClientRect();
      return scroller.dataset.measured === "true" && !scroller.dataset.navigating && box.bottom > hostBox.top && box.top < hostBox.bottom;
    }),
  ).toBe(true);

  // 3. Scroll Lecture 2 down to Appendix 20, verify it holds past post-transition settle passes, switch to Index and back without pendingHeading -> Appendix 20 restores normally.
  await page.locator(".android-reading h2#appendix-20").evaluate(el => el.scrollIntoView({ block: "start" }));
  await page.evaluate(() => {
    document.querySelector<HTMLElement>(".android-reading")!.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  const appendixTop = await readingRoot.evaluate(el => el.scrollTop);
  const appendixHeadingTop = await page.locator(".android-reading h2#appendix-20").evaluate(el => {
    const scroller = el.closest<HTMLElement>(".android-reading")!;
    return el.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  });
  expect(appendixTop).toBeGreaterThan(2500);
  await page.waitForTimeout(150);
  expect(Math.abs((await readingRoot.evaluate(el => el.scrollTop)) - appendixTop)).toBeLessThan(2);

  await page.evaluate(() => (window as any).__openTab("/notes/Index.md", "live"));
  await expect(page.locator(".android-reading h1")).toHaveText("Course Index");

  await page.evaluate(() => (window as any).__openTab("/notes/Lecture 2.md", "live"));
  await expect.poll(async () => Math.abs((await readingRoot.evaluate(el => el.scrollTop)) - appendixTop)).toBeLessThan(12);
  await expect.poll(() =>
    page.locator(".android-reading h2#appendix-20").evaluate((el, expectedTop) => {
      const scroller = el.closest<HTMLElement>(".android-reading")!;
      const box = el.getBoundingClientRect();
      const hostBox = scroller.getBoundingClientRect();
      return box.bottom > hostBox.top && box.top < hostBox.bottom && Math.abs((box.top - hostBox.top) - expectedTop) < 12;
    }, appendixHeadingTop),
  ).toBe(true);

  // 4. Direct pendingHeading jump in Split and Source modes aligns both preview and CodeMirror panes to ## Bayes.
  await page.evaluate(() => (window as any).__openTab("/notes/Index.md", "split"));
  await page.locator('.android-reading a:has-text("Bayes Theorem")').click();
  await expect.poll(() =>
    page.locator(".android-reading h2#bayes").evaluate(el => {
      const scroller = el.closest(".android-reading")!;
      return Math.abs(el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 16);
    }),
  ).toBeLessThan(12);
  await expect.poll(() =>
    page.locator(".cm-line", { hasText: "## Bayes" }).evaluate(el => {
      const box = el.getBoundingClientRect();
      const hostBox = el.closest(".cm-scroller")!.getBoundingClientRect();
      return box.bottom > hostBox.top && box.top < hostBox.bottom;
    }),
  ).toBe(true);

  await page.evaluate(() => (window as any).__openTab("/notes/Lecture 2.md", "editor", "Bayes"));
  await expect.poll(() =>
    page.locator(".cm-line", { hasText: "## Bayes" }).evaluate(el => {
      const box = el.getBoundingClientRect();
      const hostBox = el.closest(".cm-scroller")!.getBoundingClientRect();
      return box.bottom > hostBox.top && box.top < hostBox.bottom;
    }),
  ).toBe(true);
});

test("Source mode Ctrl/Cmd+Click jumps to same-note and cross-note headings in a real viewport", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.addInitScript(() => {
    const lectureContent =
      "# Lecture 2\n\nJump down to [[#Appendix 20]].\n\n" +
      Array.from({ length: 45 }, (_, i) => `## Background ${i + 1}\n\n${"Introductory probability context. ".repeat(12)}\n`).join("\n") +
      "\n## Bayes\n\nPosterior equals likelihood times prior over evidence.\n\n" +
      Array.from({ length: 30 }, (_, i) => `## Appendix ${i + 1}\n\n${"Further derivations and exercises. ".repeat(12)}\n`).join("\n");
    const notes: Record<string, { id: string; path: string; content: string }> = {
      "/notes/Index.md": {
        id: "tab-index",
        path: "/notes/Index.md",
        content: "# Course Index\n\nFollow [[Lecture 2#Bayes|Bayes Theorem]] from Source mode.\n",
      },
      "/notes/Lecture 2.md": {
        id: "tab-lecture-2",
        path: "/notes/Lecture 2.md",
        content: lectureContent,
      },
    };
    let jumpSeq = 0;
    window.SuperMD = {
      post(id, command, raw) {
        const args = JSON.parse(raw);
        if (command === "document_sync") {
          window.supermdReply?.(id, { accepted: true, revision: 0 }, null);
          return;
        }
        if (command === "open_workspace_link") {
          const target = notes["/notes/Lecture 2.md"];
          window.supermdReply?.(id, { opened: true, id: target.id, path: target.path }, null);
          window.supermdLoad?.({
            id: target.id,
            path: target.path,
            content: target.content,
            mode: "editor",
            dark: false,
            fullscreen: false,
            colors: {},
            font: "Manrope",
            size: 16,
            zoom: 100,
            motion: false,
            editProtocol: 1,
            restorePosition: true,
            readingLocation: { top: 0, offset: 0, zoom: 100, mode: "editor" },
            pendingHeading: { heading: args.fragment, token: `src-jump-${++jumpSeq}` },
          });
          return;
        }
        window.supermdReply?.(id, true, null);
      },
    };
    (window as any).__openSourceIndex = () => {
      const idx = notes["/notes/Index.md"];
      window.supermdLoad?.({
        id: idx.id,
        path: idx.path,
        content: idx.content,
        mode: "editor",
        dark: false,
        fullscreen: false,
        colors: {},
        font: "Manrope",
        size: 16,
        zoom: 100,
        motion: false,
        editProtocol: 1,
      });
    };
  });

  await page.goto("/android-reader.html");
  await page.waitForFunction(() => typeof window.supermdLoad === "function");
  await page.evaluate(() => (window as any).__openSourceIndex());

  const clickTextInLine = async (targetText: string) => {
    const line = page.locator(".cm-line", { hasText: targetText });
    await expect(line).toBeVisible();
    const point = await line.evaluate((el, needle) => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let full = "";
      const segments: Array<{ node: Text; start: number; end: number }> = [];
      let current: Node | null;
      while ((current = walker.nextNode())) {
        const textNode = current as Text;
        const start = full.length;
        full += textNode.data;
        segments.push({ node: textNode, start, end: full.length });
      }
      const idx = full.indexOf(needle);
      const mid = idx + Math.floor(needle.length / 2);
      const seg = segments.find(s => mid >= s.start && mid < s.end)!;
      const range = document.createRange();
      range.setStart(seg.node, mid - seg.start);
      range.setEnd(seg.node, mid - seg.start + 1);
      const rect = range.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }, targetText);
    await page.mouse.move(point.x, point.y);
    await page.keyboard.down("Control");
    await page.mouse.down();
    await page.mouse.up();
    await page.keyboard.up("Control");
  };

  await clickTextInLine("[[Lecture 2#Bayes|Bayes Theorem]]");

  await expect.poll(() =>
    page.locator(".cm-line", { hasText: "## Bayes" }).evaluate(el => {
      const lineBox = el.getBoundingClientRect();
      const hostBox = el.closest(".cm-scroller")!.getBoundingClientRect();
      return lineBox.bottom > hostBox.top && lineBox.top < hostBox.bottom;
    }),
  ).toBe(true);

  // Scroll back to top of Lecture 2 as a user wheel gesture and Ctrl+Click same-note [[#Appendix 20]]
  await page.locator(".cm-scroller").evaluate(el => {
    el.dispatchEvent(new WheelEvent("wheel", { deltaY: -400, bubbles: true }));
    el.scrollTop = 0;
    el.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await clickTextInLine("[[#Appendix 20]]");

  await expect.poll(() =>
    page.locator(".cm-line", { hasText: "## Appendix 20" }).evaluate(el => {
      const lineBox = el.getBoundingClientRect();
      const hostBox = el.closest(".cm-scroller")!.getBoundingClientRect();
      return lineBox.bottom > hostBox.top && lineBox.top < hostBox.bottom;
    }),
  ).toBe(true);
});
