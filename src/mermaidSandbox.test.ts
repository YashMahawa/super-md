// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

const engine = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn() }));
const fast = vi.hoisted(() => ({
  renderAsync: vi.fn().mockRejectedValue(new Error("Use compatibility renderer")),
}));
vi.mock("mermaid", () => ({ default: engine }));
vi.mock("pele/lazy", () => fast);

import { cachedMermaid, renderMermaid, sanitizeDiagram } from "./mermaidRenderer";
import { scrubSandboxHostBridges } from "./mermaidSandboxBootstrap";
import { MermaidSandboxClient, resetSharedMermaidSandbox } from "./mermaidSandboxHost";
import {
  MAX_MERMAID_SOURCE_CHARS,
  MAX_SANDBOX_SVG_CHARS,
  SANDBOX_CHANNEL,
  buildSandboxCsp,
  buildSandboxHtml,
  buildSandboxSrcdoc,
} from "./mermaidSandboxProtocol";

describe("Mermaid sandbox isolation and message channel", () => {
  afterEach(() => {
    resetSharedMermaidSandbox();
    for (const frame of Array.from(document.documentElement.querySelectorAll("iframe[data-mermaid-sandbox]"))) {
      frame.remove();
    }
    document.body.replaceChildren();
  });

  it("builds a strict inner CSP that blocks network, child frames, and non-data subresources", () => {
    const csp = buildSandboxCsp("abc123==");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'sha256-abc123==' 'wasm-unsafe-eval'");
    expect(csp).not.toContain("'unsafe-inline' 'wasm-unsafe-eval'");
    expect(csp).toContain("img-src data:");
    expect(csp).toContain("font-src data:");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("worker-src 'none'");
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain("child-src 'none'");

    let hashedInput = "";
    const html = buildSandboxHtml("console.log('a')\r\nconsole.log('</script><script>evil()')", escaped => {
      hashedInput = escaped;
      return "digest==";
    });
    expect(hashedInput).not.toContain("\r");
    expect(hashedInput).not.toContain("</script>");
    expect(html).toContain(`<script>${hashedInput}</script>`);
  });

  it("scrubs and locks host-injected WebView and Tauri bridges inside the sandbox realm", () => {
    const fakeScope: Record<string, unknown> = {
      SuperMD: { post: vi.fn(), agentReply: vi.fn() },
      qt: { webChannelTransport: {} },
      QWebChannel: function FakeChannel() {},
    };
    Object.defineProperty(fakeScope, "__TAURI_INTERNALS__", {
      value: { invoke: vi.fn(), postMessage: vi.fn(), plugins: { fs: true } },
      writable: false,
      configurable: false,
    });

    scrubSandboxHostBridges(fakeScope);

    expect(fakeScope.SuperMD).toBeUndefined();
    expect(fakeScope.qt).toBeUndefined();
    expect(fakeScope.QWebChannel).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(fakeScope, "SuperMD")?.configurable).toBe(false);
    expect(Object.getOwnPropertyDescriptor(fakeScope, "SuperMD")?.writable).toBe(false);

    const tauriInternals = fakeScope.__TAURI_INTERNALS__ as Record<string, unknown>;
    expect(tauriInternals.invoke).toBeUndefined();
    expect(tauriInternals.postMessage).toBeUndefined();
    expect(tauriInternals.plugins).toBeUndefined();
  });

  it("mounts the sandboxed iframe outside document.body without allow-same-origin", async () => {
    let observedBodyCountDuringRender = -1;
    engine.render.mockImplementationOnce(async () => {
      observedBodyCountDuringRender = document.body.children.length;
      return { svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 60"><text>Isolated</text></svg>' };
    });

    const svg = await renderMermaid("gantt\n  title Release\n  Task :a1, 2026-01-01, 1d");
    expect(svg).toContain("Isolated");
    expect(observedBodyCountDuringRender).toBe(0);
    expect(document.body.children.length).toBe(0);

    const frame = document.documentElement.querySelector("iframe[data-mermaid-sandbox]") as HTMLIFrameElement | null;
    expect(frame).not.toBeNull();
    expect(frame?.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame?.getAttribute("sandbox")).not.toContain("allow-same-origin");
    // Must stay inside the visual viewport (0,0,1x1,opacity:0) so Chromium Blink
    // never render-throttles the opaque-origin subframe on Android WebView.
    expect(frame?.style.position).toBe("fixed");
    expect(frame?.style.left).toBe("0px");
    expect(frame?.style.top).toBe("0px");
    expect(frame?.style.width).toBe("1px");
    expect(frame?.style.height).toBe("1px");
    expect(frame?.style.opacity).toBe("0");
    expect(frame?.style.pointerEvents).toBe("none");
  });

  it("ignores spoofed origins/sources and tears down the frame on correlation mismatch or oversized SVG", async () => {
    let capturedRequest: Record<string, unknown> | null = null;
    const client = new MermaidSandboxClient({
      resolveSandboxUrl: async () => "about:blank",
      attachFrameHook: (iframe, hostWin) => {
        queueMicrotask(() => {
          hostWin.dispatchEvent(
            new MessageEvent("message", {
              data: { channel: SANDBOX_CHANNEL, type: "ready" },
              origin: "null",
              source: iframe.contentWindow,
            }),
          );
        });
        if (iframe.contentWindow) {
          iframe.contentWindow.postMessage = ((msg: unknown) => {
            capturedRequest = msg as Record<string, unknown>;
            // First emit spoofed messages from non-null origin and wrong source; both must be ignored.
            hostWin.dispatchEvent(
              new MessageEvent("message", {
                data: {
                  channel: SANDBOX_CHANNEL,
                  type: "result",
                  frameToken: capturedRequest.frameToken,
                  requestId: capturedRequest.requestId,
                  ok: true,
                  svg: "<svg><text>Spoofed origin</text></svg>",
                },
                origin: "https://evil.example",
                source: iframe.contentWindow,
              }),
            );
            hostWin.dispatchEvent(
              new MessageEvent("message", {
                data: {
                  channel: SANDBOX_CHANNEL,
                  type: "result",
                  frameToken: capturedRequest.frameToken,
                  requestId: capturedRequest.requestId,
                  ok: true,
                  svg: "<svg><text>Spoofed source</text></svg>",
                },
                origin: "null",
                source: hostWin,
              }),
            );
            // Then emit a mismatched requestId from the actual frame; must fail and destroy the frame.
            queueMicrotask(() => {
              hostWin.dispatchEvent(
                new MessageEvent("message", {
                  data: {
                    channel: SANDBOX_CHANNEL,
                    type: "result",
                    frameToken: capturedRequest!.frameToken,
                    requestId: "wrong-request-id",
                    ok: true,
                    svg: "<svg><text>Wrong correlation</text></svg>",
                  },
                  origin: "null",
                  source: iframe.contentWindow,
                }),
              );
            });
          }) as typeof iframe.contentWindow.postMessage;
        }
        return undefined;
      },
    });

    await expect(client.render("smd-1", "graph TD; A-->B", false)).rejects.toThrow(/correlation mismatch/i);
    expect(client.activeIframe).toBeNull();

    await expect(
      client.render("smd-2", "x".repeat(MAX_MERMAID_SOURCE_CHARS + 1), false),
    ).rejects.toThrow(/exceeds maximum size/i);

    const oversizedClient = new MermaidSandboxClient({
      resolveSandboxUrl: async () => "about:blank",
      loadVitestEngine: async () => ({
        initialize: () => {},
        render: async () => ({ svg: `<svg>${"a".repeat(MAX_SANDBOX_SVG_CHARS + 10)}</svg>` }),
      }),
    });
    await expect(oversizedClient.render("smd-3", "graph TD; A-->B", false)).rejects.toThrow(/exceeds maximum size/i);
    oversizedClient.dispose();
  });

  it("recreates the sandboxed iframe after a render timeout or frame crash", async () => {
    let callCount = 0;
    const client = new MermaidSandboxClient({
      renderTimeoutMs: 40,
      resolveSandboxUrl: async () => "about:blank",
      loadVitestEngine: async () => ({
        initialize: () => {},
        render: async () => {
          callCount++;
          if (callCount === 1) {
            return new Promise(() => {}); // Simulate hung Mermaid render
          }
          return { svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>Fresh frame</text></svg>' };
        },
      }),
    });

    await expect(client.render("smd-hang", "gantt\n  title Hang", false)).rejects.toThrow(/timed out/i);
    expect(client.activeIframe).toBeNull();

    const firstRecovered = await client.render("smd-ok-1", "gantt\n  title Recover", false);
    expect(firstRecovered).toContain("Fresh frame");
    const firstFrame = client.activeIframe;
    expect(firstFrame).not.toBeNull();

    // Simulate frame crash (sudden removal from DOM) and confirm automatic recreation.
    firstFrame!.remove();
    const secondRecovered = await client.render("smd-ok-2", "gantt\n  title Recover 2", false);
    expect(secondRecovered).toContain("Fresh frame");
    expect(client.activeIframe).not.toBeNull();
    expect(client.activeIframe).not.toBe(firstFrame);
    client.dispose();
  });

  it("recovers from a transient cold-boot handshake timeout and rejects persistent handshake failure", async () => {
    let attempts = 0;
    const flakyHandshakeClient = new MermaidSandboxClient({
      handshakeTimeoutMs: 30,
      resolveSandboxUrl: async () => "about:blank",
      attachFrameHook: (iframe, hostWin) => {
        attempts++;
        if (attempts === 1) {
          // Simulate cold-boot stall where the first iframe never posts ready.
          return undefined;
        }
        queueMicrotask(() => {
          hostWin.dispatchEvent(
            new MessageEvent("message", {
              data: { channel: SANDBOX_CHANNEL, type: "ready" },
              origin: "null",
              source: iframe.contentWindow,
            }),
          );
        });
        if (iframe.contentWindow) {
          iframe.contentWindow.postMessage = ((msg: unknown) => {
            const req = msg as Record<string, unknown>;
            queueMicrotask(() => {
              hostWin.dispatchEvent(
                new MessageEvent("message", {
                  data: {
                    channel: SANDBOX_CHANNEL,
                    type: "result",
                    frameToken: req.frameToken,
                    requestId: req.requestId,
                    ok: true,
                    svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>Handshake recovered</text></svg>',
                  },
                  origin: "null",
                  source: iframe.contentWindow,
                }),
              );
            });
          }) as typeof iframe.contentWindow.postMessage;
        }
        return undefined;
      },
    });

    const svg = await flakyHandshakeClient.render("smd-boot", "gantt\n  title Boot", false);
    expect(svg).toContain("Handshake recovered");
    expect(attempts).toBe(2);
    flakyHandshakeClient.dispose();

    const deadHandshakeClient = new MermaidSandboxClient({
      handshakeTimeoutMs: 25,
      resolveSandboxUrl: async () => "about:blank",
      attachFrameHook: () => undefined,
    });
    await expect(deadHandshakeClient.render("smd-dead", "gantt\n  title Dead", false)).rejects.toThrow(
      /initialization timed out/i,
    );
    expect(deadHandshakeClient.activeIframe).toBeNull();
    deadHandshakeClient.dispose();
  });

  it("sanitizes DOMPurify bypasses and validates external resources in parent before caching", async () => {
    // GHSA-cg2g-xh64-v4q7 shadow-root template, GHSA-mrv2-3pqr-j5jr detached handler, GHSA-c6gr-qvv4-5v3f SMIL href
    const sanitized = sanitizeDiagram(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 40">' +
        '<template shadowrootmode="open"><svg onload="window.SuperMD()"></svg></template>' +
        '<animate attributeName="href" values="javascript:alert(1)" />' +
        '<g onmouseover="alert(1)"><text>Safe node</text></g></svg>',
    );
    expect(sanitized).not.toMatch(/onload|onmouseover|javascript:|<template/i);

    const externalSource = "gantt\n  title Uncached external image test";
    engine.render.mockResolvedValueOnce({
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><image href="https://evil.example/leak.png" width="10" height="10"/></svg>',
    });
    await expect(renderMermaid(externalSource, false)).rejects.toThrow(/External SVG resources/i);
    expect(cachedMermaid(externalSource, false)).toBeUndefined();

    const cssImportSource = "gantt\n  title Uncached CSS import test";
    engine.render.mockResolvedValueOnce({
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><style>@import url("https://evil.example/leak.css");</style><text>Hi</text></svg>',
    });
    await expect(renderMermaid(cssImportSource, false)).rejects.toThrow(/External SVG styles/i);
    expect(cachedMermaid(cssImportSource, false)).toBeUndefined();
  });

  it("serializes concurrent client.render calls and ignores foreign non-channel postMessage traffic", async () => {
    const order: string[] = [];
    const client = new MermaidSandboxClient({
      resolveSandboxUrl: async () => "about:blank",
      loadVitestEngine: async () => ({
        initialize: () => {},
        render: async (id, text) => {
          order.push(`start:${id}`);
          await new Promise(resolve => setTimeout(resolve, id === "smd-c1" ? 20 : 5));
          order.push(`end:${id}`);
          if (text.includes("INVALID")) {
            throw new Error("Parse error on line 3: unexpected token");
          }
          return { svg: `<svg xmlns="http://www.w3.org/2000/svg"><text>${id}</text></svg>` };
        },
      }),
    });

    // Launch three renders concurrently (including an invalid diagram) while injecting
    // foreign string/primitive/object postMessage noise from the iframe's contentWindow.
    const p1 = client.render("smd-c1", "classDiagram\n  Animal <|-- Duck", false);
    const p2 = client.render("smd-c2", "flowchart TD\n  A -->\n  INVALID", false);
    const p3 = client.render("smd-c3", "gantt\n  title Plan", false);

    await new Promise(resolve => setTimeout(resolve, 5));
    const frameWin = client.activeIframe?.contentWindow;
    expect(frameWin).toBeTruthy();
    window.dispatchEvent(new MessageEvent("message", { data: "extension-string-ping", origin: "null", source: frameWin }));
    window.dispatchEvent(new MessageEvent("message", { data: null, origin: "null", source: frameWin }));
    window.dispatchEvent(
      new MessageEvent("message", { data: { source: "devtools-bridge" }, origin: "null", source: frameWin }),
    );

    const [r1, r2, r3] = await Promise.allSettled([p1, p2, p3]);
    expect(r1).toEqual({
      status: "fulfilled",
      value: '<svg xmlns="http://www.w3.org/2000/svg"><text>smd-c1</text></svg>',
    });
    expect(r2.status).toBe("rejected");
    expect((r2 as PromiseRejectedResult).reason.message).toContain("Parse error on line 3");
    expect(r3).toEqual({
      status: "fulfilled",
      value: '<svg xmlns="http://www.w3.org/2000/svg"><text>smd-c3</text></svg>',
    });
    expect(order).toEqual(["start:smd-c1", "end:smd-c1", "start:smd-c2", "end:smd-c2", "start:smd-c3", "end:smd-c3"]);
    client.dispose();
  });

  it("falls back to an opaque-origin srcdoc script frame when HTML subframe navigation is intercepted", async () => {
    const srcdoc = buildSandboxSrcdoc("http://localhost:4173/assets/mermaid-sandbox-abc123.js");
    expect(srcdoc).toContain("default-src 'none'");
    expect(srcdoc).toContain("script-src http://localhost:4173/assets/mermaid-sandbox-abc123.js 'wasm-unsafe-eval'");
    expect(srcdoc).toContain('<script src="http://localhost:4173/assets/mermaid-sandbox-abc123.js"></script>');
    expect(() => buildSandboxSrcdoc('javascript:alert("xss")')).toThrow(/Invalid Mermaid sandbox script URL/);

    const observedModes: Array<"src" | "srcdoc"> = [];
    const fallbackClient = new MermaidSandboxClient({
      handshakeTimeoutMs: 30,
      resolveSandboxUrl: async () => "http://localhost:4173/assets/mermaid-sandbox-abc123.html",
      resolveSandboxScriptUrl: async () => "http://localhost:4173/assets/mermaid-sandbox-abc123.js",
      attachFrameHook: (iframe, hostWin) => {
        const mode = iframe.hasAttribute("srcdoc") ? "srcdoc" : "src";
        observedModes.push(mode);
        if (mode === "src") {
          // Simulate an intercepted .html navigation that never posts ready.
          return undefined;
        }
        queueMicrotask(() => {
          hostWin.dispatchEvent(
            new MessageEvent("message", {
              data: { channel: SANDBOX_CHANNEL, type: "ready" },
              origin: "null",
              source: iframe.contentWindow,
            }),
          );
        });
        if (iframe.contentWindow) {
          iframe.contentWindow.postMessage = ((msg: unknown) => {
            const req = msg as Record<string, unknown>;
            if (req.type !== "render") return;
            queueMicrotask(() => {
              hostWin.dispatchEvent(
                new MessageEvent("message", {
                  data: {
                    channel: SANDBOX_CHANNEL,
                    type: "result",
                    frameToken: req.frameToken,
                    requestId: req.requestId,
                    ok: true,
                    svg: `<svg xmlns="http://www.w3.org/2000/svg"><text>${String(req.id)}</text></svg>`,
                  },
                  origin: "null",
                  source: iframe.contentWindow,
                }),
              );
            });
          }) as typeof iframe.contentWindow.postMessage;
        }
        return undefined;
      },
    });

    const firstSvg = await fallbackClient.render("smd-fb-1", "classDiagram\n  A <|-- B", false);
    const secondSvg = await fallbackClient.render("smd-fb-2", "gantt\n  title Next", false);
    expect(firstSvg).toContain("smd-fb-1");
    expect(secondSvg).toContain("smd-fb-2");
    expect(observedModes).toEqual(["src", "srcdoc"]);
    expect(fallbackClient.activeIframe?.getAttribute("sandbox")).toBe("allow-scripts");
    fallbackClient.dispose();
  });
});
