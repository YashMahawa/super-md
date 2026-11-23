import { test, expect } from "@playwright/test";

test("relative links and wikilinks open target notes across Live, Read, and Split modes and scroll to one-shot pendingHeading", async ({ page }) => {
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
        if (command === "open_relative_note") {
          (window as any).__rpcCalls.push(args);
          if (String(args.target).startsWith("..")) {
            window.supermdReply?.(id, null, "Linked note is outside the authorized folder.");
            return;
          }
          const decoded = decodeURIComponent(args.target);
          const resolvedPath = `/notes/${decoded}`;
          const target = notes[resolvedPath];
          if (!target) {
            window.supermdReply?.(id, null, `Linked note not found: ${decoded}`);
            return;
          }
          const mode = (window as any).__testMode || "live";
          window.supermdReply?.(id, true, null);
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
            // Supply a stale top=0 readingLocation to verify pendingHeading wins.
            readingLocation: { top: 0, offset: 0, zoom: 100, mode },
            ...(args.heading ? { pendingHeading: args.heading } : {}),
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
