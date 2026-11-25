import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";
import { mediaContrast } from "../src/mediaAppearance";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const FIVE_DIAGRAM_NOTE = [
  "# Production Mermaid Verification",
  "",
  "```mermaid",
  "flowchart TD",
  '  subgraph Cluster["Unicode αβγ — 日本語 🚀"]',
  '    Start["Read → Parse"] --> Done["Verified ✓"]',
  "  end",
  "```",
  "",
  "```mermaid",
  "sequenceDiagram",
  "  participant Alice",
  "  participant Bob",
  "  Alice->>Bob: Request payload",
  "  Bob-->>Alice: Acknowledge receipt",
  "```",
  "",
  "```mermaid",
  "classDiagram",
  "  Animal <|-- Duck",
  "  class Animal {",
  "    +int age",
  "    +String gender",
  "    +isMammal() bool",
  "  }",
  "  class Duck {",
  "    +String beakColor",
  "    +swim() void",
  "  }",
  "```",
  "",
  "```mermaid",
  "gantt",
  "  title Release Schedule",
  "  dateFormat YYYY-MM-DD",
  "  section Core",
  "  Specification :a1, 2026-09-01, 5d",
  "  Implementation :after a1, 6d",
  "```",
  "",
  "```mermaid",
  "flowchart TD",
  "  A -->",
  "  invalid syntax ???",
  "```",
].join("\n");

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(err => (err ? reject(err) : resolve(port)));
    });
  });
}

async function waitForHttpReady(url: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // Server still starting.
    }
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error(`Timed out waiting for vite preview at ${url}`);
}

let previewProcess: ChildProcess | null = null;
let previewOrigin = "";

test.describe("Production build Mermaid rendering (vite preview)", () => {
  test.setTimeout(90_000);

  test.beforeAll(async () => {
    const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
    const npxCmd = process.platform === "win32" ? "npx.cmd" : "npx";
    execFileSync(npmCmd, ["run", "build"], {
      cwd: repoRoot,
      stdio: "pipe",
      env: { ...process.env },
    });

    const port = await getFreePort();
    previewOrigin = `http://127.0.0.1:${port}`;
    previewProcess = spawn(
      npxCmd,
      ["vite", "preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
      {
        cwd: repoRoot,
        stdio: "ignore",
        detached: process.platform !== "win32",
      },
    );
    previewProcess.unref();
    await waitForHttpReady(`${previewOrigin}/android-reader.html`);
  });

  test.afterAll(async () => {
    if (!previewProcess) return;
    const proc = previewProcess;
    previewProcess = null;
    try {
      if (process.platform !== "win32" && proc.pid) {
        process.kill(-proc.pid, "SIGKILL");
      } else {
        proc.kill("SIGKILL");
      }
    } catch {
      // Already exited.
    }
  });

  test("renders flowchart, sequence, class, and gantt diagrams and reports parse error for invalid Mermaid in built android-reader.html", async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    const cspViolations: string[] = [];
    page.on("pageerror", err => consoleErrors.push(err.message));
    page.on("console", msg => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    await page.addInitScript(() => {
      (window as unknown as Record<string, string[]>).__cspViolations = [];
      document.addEventListener("securitypolicyviolation", event => {
        (window as unknown as Record<string, string[]>).__cspViolations.push(
          `${event.effectiveDirective}:${event.blockedURI}`,
        );
      });
      window.SuperMD = {
        post: id => {
          queueMicrotask(() => window.supermdReply?.(id, null, null));
        },
      };
    });

    await page.goto(`${previewOrigin}/android-reader.html`);
    await page.waitForFunction(() => typeof window.supermdLoad === "function");

    await page.evaluate(markdown => {
      window.supermdLoad?.({
        id: "prod-five-blocks",
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
    }, FIVE_DIAGRAM_NOTE);

    const renderedImages = page.locator(".mermaid img");
    await expect(renderedImages).toHaveCount(4);
    for (let i = 0; i < 4; i++) {
      await renderedImages.nth(i).scrollIntoViewIfNeeded();
      await expect(renderedImages.nth(i)).toBeVisible();
      await expect
        .poll(() => renderedImages.nth(i).evaluate(img => (img as HTMLImageElement).naturalWidth))
        .toBeGreaterThan(60);
    }

    await expect(page.locator(".image-loading")).toHaveCount(0);
    const renderError = page.locator(".render-error");
    await expect(renderError).toHaveCount(1);
    await expect(renderError).toContainText(/Parse error on line 3/i);
    await expect(renderError).not.toContainText(/initialization timed out/i);

    // Verify sandbox iframe attributes and isolation in the production build.
    const frameSummary = await page.evaluate(() => {
      const frames = Array.from(document.documentElement.querySelectorAll("iframe[data-mermaid-sandbox]"));
      return frames.map(f => ({
        sandbox: f.getAttribute("sandbox"),
        src: f.getAttribute("src") ?? "",
        inBody: document.body.contains(f),
      }));
    });
    expect(frameSummary).toHaveLength(1);
    expect(frameSummary[0].sandbox).toBe("allow-scripts");
    expect(frameSummary[0].src).toMatch(/\/assets\/mermaid-sandbox-[\w-]+\.html$/);
    expect(frameSummary[0].inBody).toBe(false);

    // Verify sequence diagram label contrast in both light mode and dark original mode.
    await page.evaluate(markdown => {
      window.supermdLoad?.({
        id: "prod-five-blocks-dark",
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
      });
    }, FIVE_DIAGRAM_NOTE);

    await expect(renderedImages).toHaveCount(4);
    for (let i = 0; i < 4; i++) {
      await expect
        .poll(() => renderedImages.nth(i).evaluate(img => (img as HTMLImageElement).naturalWidth))
        .toBeGreaterThan(60);
    }
    await expect(renderError).toContainText(/Parse error on line 3/i);

    const darkSequenceContrast = await renderedImages.nth(1).evaluate(img => {
      const bg = getComputedStyle(img).backgroundColor;
      const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      const bgHex = m
        ? "#" + [m[1], m[2], m[3]].map(v => Number(v).toString(16).padStart(2, "0")).join("")
        : "#fdfdfc";
      const decoded = decodeURIComponent((img as HTMLImageElement).src.split(",").slice(1).join(","));
      const xml = new DOMParser().parseFromString(decoded, "image/svg+xml");
      const rootFill = xml.documentElement.getAttribute("fill") || "#e9e2e8";
      return { bgHex, rootFill };
    });
    expect(mediaContrast(darkSequenceContrast.bgHex, darkSequenceContrast.rootFill)).toBeGreaterThanOrEqual(7);

    // Reload the page and re-verify all 5 blocks settle cleanly.
    await page.reload();
    await page.waitForFunction(() => typeof window.supermdLoad === "function");
    await page.evaluate(markdown => {
      window.supermdLoad?.({
        id: "prod-five-blocks-reload",
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
    }, FIVE_DIAGRAM_NOTE);

    await expect(renderedImages).toHaveCount(4);
    for (let i = 0; i < 4; i++) {
      await expect
        .poll(() => renderedImages.nth(i).evaluate(img => (img as HTMLImageElement).naturalWidth))
        .toBeGreaterThan(60);
    }
    await expect(page.locator(".image-loading")).toHaveCount(0);
    await expect(renderError).toContainText(/Parse error on line 3/i);

    cspViolations.push(
      ...(await page.evaluate(() => (window as unknown as Record<string, string[]>).__cspViolations ?? [])),
    );
    expect(cspViolations).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });

  test("renders all 5 Mermaid blocks in built index.html and recovers via srcdoc fallback if .html subframe navigation is intercepted", async ({
    page,
  }) => {
    // Simulate a leftover Service Worker / SPA router intercepting .html subframe navigations.
    await page.route("**/assets/mermaid-sandbox-*.html", async route => {
      await route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: "<!doctype html><html><body>stale spa shell</body></html>",
      });
    });

    await page.goto(`${previewOrigin}/`);
    const welcomeDialog = page.getByRole("dialog", { name: "Welcome to Super MD" });
    if (await welcomeDialog.isVisible().catch(() => false)) {
      await page.getByRole("button", { name: /Continue/i }).click();
      await page.getByRole("button", { name: /Continue/i }).click();
      await page.getByRole("button", { name: /Explore the sample/i }).click();
    }

    const cm = page.locator(".cm-content");
    await cm.click();
    await page.keyboard.press("Control+a");
    await page.evaluate(text => {
      const el = document.querySelector(".cm-content");
      const dt = new DataTransfer();
      dt.setData("text/plain", text);
      el?.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    }, FIVE_DIAGRAM_NOTE);

    const previewPane = page.locator(".preview-pane");
    const renderedImages = previewPane.locator(".mermaid img");
    await expect(renderedImages).toHaveCount(4, { timeout: 25_000 });
    for (let i = 0; i < 4; i++) {
      await expect
        .poll(() => renderedImages.nth(i).evaluate(img => (img as HTMLImageElement).naturalWidth))
        .toBeGreaterThan(60);
    }
    await expect(previewPane.locator(".image-loading")).toHaveCount(0);
    const renderError = previewPane.locator(".render-error");
    await expect(renderError).toHaveCount(1);
    await expect(renderError).toContainText(/Parse error on line 3/i);
    await expect(renderError).not.toContainText(/initialization timed out/i);

    const fallbackFrame = await page.evaluate(() => {
      const frame = document.documentElement.querySelector("iframe[data-mermaid-sandbox]");
      return frame
        ? {
            sandbox: frame.getAttribute("sandbox"),
            hasSrcdoc: frame.hasAttribute("srcdoc"),
            inBody: document.body.contains(frame),
          }
        : null;
    });
    expect(fallbackFrame).toEqual({
      sandbox: "allow-scripts",
      hasSrcdoc: true,
      inBody: false,
    });
  });
});
