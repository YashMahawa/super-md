import { test, expect } from "@playwright/test";

const ONE_PIXEL_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4b8AAAAASUVORK5CYII=";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(png => {
    (window as unknown as Record<string, unknown>).__bridgeCalls = [];
    window.SuperMD = {
      post: (id, command, rawArgs) => {
        const parsed = rawArgs ? JSON.parse(rawArgs) : {};
        ((window as unknown as Record<string, unknown[]>).__bridgeCalls).push({ command, parsed });
        queueMicrotask(() => {
          if (command === "fetch_resource") {
            window.supermdReply?.(id, { body: png }, null);
            return;
          }
          window.supermdReply?.(id, null, null);
        });
      },
    };
  }, ONE_PIXEL_PNG);
  await page.goto("/android-reader.html");
  await page.waitForFunction(() => typeof window.supermdLoad === "function");
});

test("renders complex fallback Mermaid diagrams in an opaque-origin sandbox without touching document.body or exposing SuperMD", async ({
  page,
}) => {
  const externalRequests: string[] = [];
  page.on("request", req => {
    const url = req.url();
    if (!url.startsWith("http://127.0.0.1:1420/") && !url.startsWith("data:") && !url.startsWith("blob:")) {
      externalRequests.push(url);
    }
  });

  // Track every element ever appended directly to document.body during diagram rendering.
  await page.evaluate(() => {
    const appended: string[] = [];
    const observer = new MutationObserver(records => {
      for (const record of records) {
        for (const node of Array.from(record.addedNodes)) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            appended.push((node as Element).tagName);
          }
        }
      }
    });
    observer.observe(document.body, { childList: true });
    (window as unknown as Record<string, unknown>).__bodyAddedTags = appended;
  });

  const content = [
    "# Complex diagram note",
    "",
    "```mermaid",
    "gantt",
    "  title Semester Milestones",
    "  dateFormat YYYY-MM-DD",
    "  section Research",
    "  Literature review :a1, 2026-09-01, 7d",
    "  Prototype sandbox :after a1, 5d",
    "```",
    "",
    "```mermaid",
    '%%{init: {"theme":"base","themeCSS":"body { background: rgb(255, 0, 0) !important; } .node rect { stroke-width: 2px; }"}}%%',
    "flowchart LR",
    '  M1["$$E = mc^2$$"] --> M2["Isolated layout"]',
    "```",
  ].join("\n");

  await page.evaluate(markdown => {
    window.supermdLoad?.({
      id: "sandbox-complex",
      path: null,
      content: markdown,
      mode: "reader",
      dark: false,
      fullscreen: false,
      colors: { surface: "#fbf8f6", text: "#1e1b20", primary: "#395d8f" },
      font: "Manrope",
      size: 16,
      zoom: 100,
      motion: false,
      svgAppearance: "auto",
    });
  }, content);

  const diagrams = page.locator(".mermaid img");
  await expect(diagrams).toHaveCount(2, { timeout: 25_000 });
  for (let idx = 0; idx < 2; idx++) {
    await expect(diagrams.nth(idx)).toBeVisible();
    await expect.poll(() => diagrams.nth(idx).evaluate(i => (i as HTMLImageElement).naturalWidth)).toBeGreaterThan(80);
  }

  // Zero measurement containers or iframes were mounted on document.body; host body style stays isolated.
  expect(await page.evaluate(() => (window as unknown as Record<string, string[]>).__bodyAddedTags)).toEqual([]);
  expect(await page.locator("body").evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe("rgb(255, 0, 0)");

  // Verify the sandboxed frame sits outside document.body, lacks allow-same-origin, and cannot reach window.parent.SuperMD.
  const sandboxCheck = await page.evaluate(() => {
    const frame = document.documentElement.querySelector("iframe[data-mermaid-sandbox]") as HTMLIFrameElement | null;
    if (!frame) return null;
    let canReadSandboxDoc = false;
    try {
      canReadSandboxDoc = frame.contentDocument !== null;
    } catch {
      canReadSandboxDoc = false;
    }
    return {
      inBody: document.body.contains(frame),
      sandboxAttr: frame.getAttribute("sandbox"),
      canReadSandboxDoc,
    };
  });
  expect(sandboxCheck).toEqual({
    inBody: false,
    sandboxAttr: "allow-scripts",
    canReadSandboxDoc: false,
  });

  // Also verify from inside the live sandbox frame via Playwright's frame handle that both
  // window.parent.SuperMD and any frame-injected window.SuperMD (e.g. Android addJavascriptInterface) are unreachable.
  const childFrame = page.frames().find(f => f !== page.mainFrame());
  expect(childFrame).toBeDefined();
  const parentProbe = await childFrame!.evaluate(() => {
    let parentBridge = "unreachable";
    try {
      const candidate = (window.parent as unknown as Record<string, unknown>).SuperMD;
      if (candidate !== undefined) parentBridge = "leaked";
    } catch {
      parentBridge = "SecurityError";
    }
    const selfWin = window as unknown as Record<string, unknown>;
    try {
      selfWin.SuperMD = { restored: true };
    } catch {
      // Non-writable property in strict mode.
    }
    return {
      origin: window.origin,
      parentBridge,
      selfBridge: typeof selfWin.SuperMD,
    };
  });
  expect(parentProbe.origin).toBe("null");
  expect(["SecurityError", "unreachable"]).toContain(parentProbe.parentBridge);
  expect(parentProbe.selfBridge).toBe("undefined");
  expect(externalRequests).toEqual([]);
});

test("neutralizes XSS advisories, @import stylesheets, external SVG images, and direct http/https/file images while preserving consented fetch_resource", async ({
  page,
}) => {
  const externalRequests: string[] = [];
  page.on("request", req => {
    const url = req.url();
    if (!url.startsWith("http://127.0.0.1:1420/") && !url.startsWith("data:") && !url.startsWith("blob:")) {
      externalRequests.push(url);
    }
  });

  await page.evaluate(() => {
    (window as unknown as Record<string, unknown>).__xssTriggered = false;
  });

  const maliciousNote = [
    "# Untrusted shared note",
    "",
    "```mermaid",
    '%%{init: {"themeCSS":"@import url(https://evil.example/exfil.css);"}}%%',
    "flowchart TD",
    '  A["<template shadowrootmode=open><svg onload=\'window.__xssTriggered=true\'></svg></template>"] --> B["<img src=x onerror=\'window.__xssTriggered=true\'>"]',
    "```",
    "",
    "```svg",
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 40"><image href="https://evil.example/beacon.png" width="20" height="20"/></svg>',
    "```",
    "",
    `![Injected SVG](data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" onload="window.__xssTriggered=true"><script>window.__xssTriggered=true</script></svg>')})`,
    "",
    "![Consented remote](https://images.example/diagram.png)",
  ].join("\n");

  await page.evaluate(markdown => {
    window.supermdLoad?.({
      id: "untrusted-note",
      path: null,
      content: markdown,
      mode: "reader",
      dark: true,
      fullscreen: false,
      colors: { surface: "#191420", text: "#f3e4ed", primary: "#e3a8c7" },
      font: "Manrope",
      size: 16,
      zoom: 100,
      motion: false,
      svgAppearance: "auto",
    });
  }, maliciousNote);

  // External SVG block and malicious SVG data URI must be rejected with safe error states, while Mermaid XSS payload is sanitized.
  await expect(page.locator(".mermaid img")).toBeVisible({ timeout: 25_000 });
  await expect(page.locator(".render-error")).toContainText("External SVG resources must be embedded first.");
  await expect(page.locator(".image-error")).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as Record<string, unknown>).__xssTriggered)).toBe(false);
  expect(externalRequests).toEqual([]);

  // Direct http:, https:, and file: <img> probes must be blocked without reaching the network.
  const failedReasons: Record<string, string> = {};
  page.on("requestfailed", req => {
    failedReasons[req.url()] = req.failure()?.errorText ?? "failed";
  });
  const directProbe = await page.evaluate(async () => {
    const violations: string[] = [];
    const onViolation = (event: SecurityPolicyViolationEvent) => {
      violations.push(`${event.effectiveDirective}:${event.blockedURI}`);
    };
    document.addEventListener("securitypolicyviolation", onViolation);
    const probe = (src: string) =>
      new Promise<string>(resolve => {
        const img = new Image();
        img.onload = () => resolve("loaded");
        img.onerror = () => resolve("blocked");
        img.src = src;
      });
    const results = {
      http: await probe("http://evil.example/direct.png"),
      https: await probe("https://evil.example/direct.png"),
      file: await probe("file:///etc/passwd"),
    };
    document.removeEventListener("securitypolicyviolation", onViolation);
    return { results, violations };
  });
  expect(directProbe.results).toEqual({ http: "blocked", https: "blocked", file: "blocked" });
  expect(directProbe.violations).toEqual(
    expect.arrayContaining([
      "img-src:http://evil.example/direct.png",
      "img-src:https://evil.example/direct.png",
    ]),
  );
  expect(failedReasons["http://evil.example/direct.png"]).toMatch(/csp/i);
  expect(failedReasons["https://evil.example/direct.png"]).toMatch(/csp/i);

  externalRequests.length = 0;
  // Remote Markdown image stays behind the consent gate, then loads via fetch_resource into a data: URI.
  await expect(page.getByRole("group", { name: "Remote image from images.example" })).toBeVisible();
  await page.getByRole("button", { name: "Load image" }).click();
  const consentedImg = page.getByRole("img", { name: "Consented remote" });
  await expect(consentedImg).toBeVisible();
  await expect(consentedImg).toHaveAttribute("src", ONE_PIXEL_PNG);
  expect(externalRequests).toEqual([]);
});

test("PDF export receives self-contained sanitized SVG output from the isolated Mermaid sandbox", async ({ page }) => {
  const note = [
    "# Exportable timeline",
    "",
    "```mermaid",
    "gantt",
    "  title Milestone Schedule",
    "  dateFormat YYYY-MM-DD",
    "  Design :d1, 2026-10-01, 3d",
    "  Verify :after d1, 2d",
    "```",
  ].join("\n");

  await page.evaluate(markdown => {
    window.supermdLoad?.({
      id: "export-note",
      path: null,
      content: markdown,
      mode: "reader",
      dark: false,
      fullscreen: false,
      colors: { surface: "#ffffff", text: "#20252d", primary: "#315d99" },
      font: "Manrope",
      size: 16,
      zoom: 100,
      motion: false,
      svgAppearance: "auto",
    });
  }, note);

  await expect(page.locator(".mermaid img")).toBeVisible({ timeout: 25_000 });
  await page.evaluate(() => window.supermdExport?.({ paper: "a4", marginMm: 18 }));

  const exportedCall = await expect
    .poll(async () => {
      const calls = await page.evaluate(
        () => (window as unknown as Record<string, Array<{ command: string; parsed: Record<string, unknown> }>>).__bridgeCalls,
      );
      return calls.find(entry => entry.command === "export_pdf_native") ?? null;
    })
    .not.toBeNull()
    .then(() =>
      page.evaluate(() => {
        const calls = (
          window as unknown as Record<string, Array<{ command: string; parsed: Record<string, unknown> }>>
        ).__bridgeCalls;
        return calls.find(entry => entry.command === "export_pdf_native")?.parsed ?? null;
      }),
    );

  expect(exportedCall).not.toBeNull();
  const assets = (exportedCall as { assets: Record<string, string> }).assets;
  const assetValues = Object.values(assets);
  expect(assetValues.length).toBe(1);
  const rawPayload = assetValues[0].includes(",") ? assetValues[0].split(",")[1] : assetValues[0];
  const svg = await page.evaluate(b64 => atob(b64), rawPayload);
  expect(svg).toContain('data-diagram-engine="mermaid"');
  expect(svg).not.toMatch(/<script|<foreignObject|onload/i);
});
