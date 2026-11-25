import {
  DEFAULT_HANDSHAKE_TIMEOUT_MS,
  DEFAULT_RENDER_TIMEOUT_MS,
  MAX_MERMAID_SOURCE_CHARS,
  MAX_SANDBOX_ERROR_CHARS,
  MAX_SANDBOX_SVG_CHARS,
  SANDBOX_CHANNEL,
  buildSandboxHtml,
  buildSandboxSrcdoc,
  type SandboxRenderRequest,
} from "./mermaidSandboxProtocol";
import { installMermaidSandboxWorker, type MermaidEngineLike } from "./mermaidSandboxWorker";

const FAST_PRIMARY_HANDSHAKE_MS = 3_000;
const HANDSHAKE_PING_INTERVAL_MS = 250;

type ActiveRequest = {
  requestId: string;
  resolve: (svg: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type FrameInstance = {
  iframe: HTMLIFrameElement;
  frameToken: string;
  ready: Promise<void>;
  isReady: boolean;
  resolveReady: () => void;
  rejectReady: (error: Error) => void;
  handshakeTimer: ReturnType<typeof setTimeout>;
  pingTimer: ReturnType<typeof setInterval>;
  activeRequest: ActiveRequest | null;
  disposeHook?: () => void;
  disposed: boolean;
  onMessage: (event: MessageEvent<unknown>) => void;
  onLoad: () => void;
  onError: () => void;
};

type ResolvedSandboxAssets = {
  url: string;
  scriptUrl?: string;
};

export type MermaidSandboxClientOptions = {
  hostWindow?: Window;
  handshakeTimeoutMs?: number;
  renderTimeoutMs?: number;
  resolveSandboxUrl?: () => Promise<string>;
  resolveSandboxScriptUrl?: () => Promise<string | undefined>;
  attachFrameHook?: (iframe: HTMLIFrameElement, hostWindow: Window) => (() => void) | undefined;
  loadVitestEngine?: () => Promise<MermaidEngineLike>;
};

function randomToken(): string {
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
  }
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}

async function defaultResolveSandboxAssets(): Promise<ResolvedSandboxAssets> {
  const mod = await import("virtual:mermaid-sandbox-url");
  return { url: mod.default, scriptUrl: mod.sandboxScriptUrl };
}

function createVitestJsdomBridge(
  iframe: HTMLIFrameElement,
  hostWindow: Window,
  loadEngine: () => Promise<MermaidEngineLike>,
): () => void {
  const sandboxDoc = hostWindow.document.implementation.createHTMLDocument("mermaid-sandbox");
  // Record the exact strict inner CSP inside the isolated sandbox document as well.
  sandboxDoc.documentElement.innerHTML = buildSandboxHtml("", () => "vitest").replace(
    /^<!doctype html><html>|<\/html>$/gi,
    "",
  );
  const listeners = new Set<(event: MessageEvent<unknown>) => void>();
  const fakeSandboxWindow = {
    document: sandboxDoc,
    parent: hostWindow,
    addEventListener(type: string, listener: (event: MessageEvent<unknown>) => void) {
      if (type === "message") listeners.add(listener);
    },
    removeEventListener(type: string, listener: (event: MessageEvent<unknown>) => void) {
      if (type === "message") listeners.delete(listener);
    },
  } as unknown as Window;

  let active = true;
  const contentWin = iframe.contentWindow;
  const parentPoster = {
    postMessage(payload: unknown) {
      if (!active) return;
      queueMicrotask(() => {
        if (!active || !iframe.isConnected) return;
        hostWindow.dispatchEvent(
          new MessageEvent("message", {
            data: payload,
            origin: "null",
            source: contentWin,
          }),
        );
      });
    },
  };

  const cleanupWorker = installMermaidSandboxWorker(fakeSandboxWindow, parentPoster, loadEngine);

  if (contentWin) {
    contentWin.postMessage = ((message: unknown) => {
      if (!active) return;
      queueMicrotask(() => {
        if (!active || !iframe.isConnected) return;
        const evt = new MessageEvent("message", {
          data: message,
          origin: hostWindow.location.origin,
          source: hostWindow,
        });
        for (const listener of Array.from(listeners)) listener(evt);
      });
    }) as typeof contentWin.postMessage;
  }

  return () => {
    active = false;
    cleanupWorker();
    listeners.clear();
    sandboxDoc.body?.replaceChildren();
  };
}

export class MermaidSandboxClient {
  private frame: FrameInstance | null = null;
  private renderQueue: Promise<void> = Promise.resolve();
  private preferSrcdocFallback = false;
  private readonly hostWindow: Window;
  private readonly handshakeTimeoutMs: number;
  private readonly renderTimeoutMs: number;
  private readonly resolveAssets: () => Promise<ResolvedSandboxAssets>;
  private readonly attachFrameHook?: (iframe: HTMLIFrameElement, hostWindow: Window) => (() => void) | undefined;
  private readonly loadVitestEngine?: () => Promise<MermaidEngineLike>;

  constructor(options: MermaidSandboxClientOptions = {}) {
    this.hostWindow = options.hostWindow ?? window;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.renderTimeoutMs = options.renderTimeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS;
    if (options.resolveSandboxUrl || options.resolveSandboxScriptUrl) {
      const urlResolver = options.resolveSandboxUrl;
      const scriptResolver = options.resolveSandboxScriptUrl;
      this.resolveAssets = async () => {
        const defaults = urlResolver ? undefined : await defaultResolveSandboxAssets();
        const url = urlResolver ? await urlResolver() : defaults!.url;
        const scriptUrl = scriptResolver ? await scriptResolver() : defaults?.scriptUrl;
        return { url, scriptUrl };
      };
    } else {
      this.resolveAssets = defaultResolveSandboxAssets;
    }
    this.attachFrameHook = options.attachFrameHook;
    this.loadVitestEngine = options.loadVitestEngine;
  }

  get activeIframe(): HTMLIFrameElement | null {
    return this.frame && !this.frame.disposed ? this.frame.iframe : null;
  }

  dispose(reason: Error = new Error("Mermaid sandbox was reset.")): void {
    if (this.frame) {
      this.destroyFrame(this.frame, reason);
    }
  }

  private destroyFrame(target: FrameInstance, error: Error): void {
    if (target.disposed) return;
    target.disposed = true;
    if (this.frame === target) {
      this.frame = null;
    }
    clearTimeout(target.handshakeTimer);
    clearInterval(target.pingTimer);
    this.hostWindow.removeEventListener("message", target.onMessage);
    target.iframe.removeEventListener("load", target.onLoad);
    target.iframe.removeEventListener("error", target.onError);
    target.disposeHook?.();
    try {
      target.iframe.removeAttribute("src");
      target.iframe.removeAttribute("srcdoc");
      target.iframe.remove();
    } catch {
      // Best-effort DOM cleanup.
    }
    target.rejectReady(error);
    if (target.activeRequest) {
      const pending = target.activeRequest;
      target.activeRequest = null;
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  private resolveHttpScriptUrl(rawScriptUrl?: string): string | undefined {
    if (!rawScriptUrl) return undefined;
    try {
      const resolved = new URL(rawScriptUrl, this.hostWindow.location?.href || undefined).href;
      return /^https?:\/\//i.test(resolved) ? resolved : undefined;
    } catch {
      return undefined;
    }
  }

  private async ensureFrame(mode?: "src" | "srcdoc"): Promise<FrameInstance> {
    if (this.frame && !this.frame.disposed) {
      if (this.frame.iframe.isConnected && this.frame.iframe.contentWindow) {
        return this.frame;
      }
      this.destroyFrame(this.frame, new Error("Mermaid sandbox frame crashed."));
    }

    const assets = await this.resolveAssets();
    const fallbackScriptUrl = this.resolveHttpScriptUrl(assets.scriptUrl);
    const desiredMode = mode ?? (this.preferSrcdocFallback ? "srcdoc" : "src");
    const useSrcdoc = desiredMode === "srcdoc" && Boolean(fallbackScriptUrl);
    const effectiveHandshakeMs =
      !useSrcdoc && Boolean(fallbackScriptUrl)
        ? Math.min(this.handshakeTimeoutMs, FAST_PRIMARY_HANDSHAKE_MS)
        : this.handshakeTimeoutMs;

    const doc = this.hostWindow.document;
    const mountRoot = doc.documentElement;
    if (!mountRoot) {
      throw new Error("Document root element is unavailable for Mermaid sandbox.");
    }

    const iframe = doc.createElement("iframe");
    // Opaque-origin sandbox: allow-scripts ONLY, strictly without allow-same-origin.
    iframe.setAttribute("sandbox", "allow-scripts");
    iframe.setAttribute("aria-hidden", "true");
    iframe.tabIndex = -1;
    iframe.dataset.mermaidSandbox = "true";
    // Keep the 1x1 transparent frame inside the visual viewport without negative
    // z-index occlusion so Chromium Blink and desktop GPU compositors never classify
    // the opaque-origin OOPIF as offscreen/occluded.
    iframe.style.cssText =
      "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none;border:0;background:transparent;overflow:hidden";

    const frameToken = randomToken();
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<void>((res, rej) => {
      resolveReady = res;
      rejectReady = rej;
    });
    void ready.catch(() => {});

    const sendPing = () => {
      if (instance.disposed || instance.isReady) return;
      try {
        instance.iframe.contentWindow?.postMessage({ channel: SANDBOX_CHANNEL, type: "ping" }, "*");
      } catch {
        // Handshake timer handles unresponsive frames.
      }
    };

    const instance: FrameInstance = {
      iframe,
      frameToken,
      ready,
      isReady: false,
      resolveReady,
      rejectReady,
      handshakeTimer: setTimeout(() => {
        this.destroyFrame(instance, new Error("Mermaid sandbox initialization timed out."));
      }, effectiveHandshakeMs),
      pingTimer: setInterval(sendPing, HANDSHAKE_PING_INTERVAL_MS),
      activeRequest: null,
      disposed: false,
      onLoad: sendPing,
      onError: () => {
        this.destroyFrame(instance, new Error("Mermaid sandbox frame failed to load."));
      },
      onMessage: (event: MessageEvent<unknown>) => {
        if (instance.disposed) return;
        if (!instance.iframe.contentWindow || event.source !== instance.iframe.contentWindow) return;
        if (event.origin !== "null") return;
        const raw = event.data;
        // Ignore foreign non-object or non-channel postMessage traffic (such as
        // browser extensions running content scripts in all frames).
        if (!raw || typeof raw !== "object") return;
        const message = raw as Record<string, unknown>;
        if (message.channel !== SANDBOX_CHANNEL) return;

        if (message.type === "ready") {
          instance.isReady = true;
          clearTimeout(instance.handshakeTimer);
          clearInterval(instance.pingTimer);
          instance.resolveReady();
          return;
        }

        if (message.type === "result") {
          const pending = instance.activeRequest;
          if (!pending) return;
          if (message.frameToken !== instance.frameToken || message.requestId !== pending.requestId) {
            this.destroyFrame(instance, new Error("Mermaid sandbox correlation mismatch."));
            return;
          }
          if (message.ok === true) {
            if (typeof message.svg !== "string" || message.svg.length === 0 || message.svg.length > MAX_SANDBOX_SVG_CHARS) {
              this.destroyFrame(instance, new Error("Mermaid sandbox returned an invalid or oversized SVG payload."));
              return;
            }
            instance.activeRequest = null;
            clearTimeout(pending.timer);
            pending.resolve(message.svg);
            return;
          }
          if (message.ok === false && typeof message.error === "string") {
            const errText = message.error.slice(0, MAX_SANDBOX_ERROR_CHARS) || "Mermaid rendering failed.";
            instance.activeRequest = null;
            clearTimeout(pending.timer);
            pending.reject(new Error(errText));
            return;
          }
          this.destroyFrame(instance, new Error("Invalid result payload from Mermaid sandbox."));
          return;
        }

        this.destroyFrame(instance, new Error("Malformed message from Mermaid sandbox."));
      },
    };
    (instance.pingTimer as unknown as { unref?: () => void }).unref?.();

    this.hostWindow.addEventListener("message", instance.onMessage);
    iframe.addEventListener("load", instance.onLoad);
    iframe.addEventListener("error", instance.onError);
    if (useSrcdoc && fallbackScriptUrl) {
      iframe.srcdoc = buildSandboxSrcdoc(fallbackScriptUrl);
    } else {
      iframe.src = assets.url;
    }
    // Mount on document.documentElement, NEVER on document.body.
    mountRoot.appendChild(iframe);

    if (this.attachFrameHook) {
      instance.disposeHook = this.attachFrameHook(iframe, this.hostWindow);
    } else if (import.meta.env.VITEST) {
      const loadEngine =
        this.loadVitestEngine ?? (async () => (await import("mermaid")).default as unknown as MermaidEngineLike);
      instance.disposeHook = createVitestJsdomBridge(iframe, this.hostWindow, loadEngine);
    }

    this.frame = instance;
    return instance;
  }

  render(id: string, source: string, dark: boolean): Promise<string> {
    if (source.length > MAX_MERMAID_SOURCE_CHARS) {
      return Promise.reject(new Error("Mermaid diagram source exceeds maximum size."));
    }
    const job = this.renderQueue.then(() => this.renderSerial(id, source, dark));
    this.renderQueue = job.then(
      () => undefined,
      () => undefined,
    );
    return job;
  }

  private async renderSerial(id: string, source: string, dark: boolean): Promise<string> {
    const firstMode: "src" | "srcdoc" = this.preferSrcdocFallback ? "srcdoc" : "src";
    let frame: FrameInstance | null = null;
    try {
      frame = await this.ensureFrame(firstMode);
      await frame.ready;
    } catch (error) {
      if (frame && !frame.disposed) {
        this.destroyFrame(frame, error instanceof Error ? error : new Error("Mermaid sandbox handshake failed."));
      }
      const assets = await this.resolveAssets();
      const hasScriptFallback = Boolean(this.resolveHttpScriptUrl(assets.scriptUrl));
      const retryMode: "src" | "srcdoc" =
        hasScriptFallback && firstMode === "src" ? "srcdoc" : "src";
      this.preferSrcdocFallback = retryMode === "srcdoc";
      const fresh = await this.ensureFrame(retryMode);
      await fresh.ready;
      return this.dispatchRender(fresh, id, source, dark);
    }

    if (frame.disposed || !frame.iframe.isConnected || !frame.iframe.contentWindow) {
      this.destroyFrame(frame, new Error("Mermaid sandbox frame crashed."));
      const fresh = await this.ensureFrame();
      await fresh.ready;
      return this.dispatchRender(fresh, id, source, dark);
    }
    return this.dispatchRender(frame, id, source, dark);
  }

  private dispatchRender(frame: FrameInstance, id: string, source: string, dark: boolean): Promise<string> {
    if (!frame.iframe.isConnected || !frame.iframe.contentWindow) {
      this.destroyFrame(frame, new Error("Mermaid sandbox frame crashed."));
      return Promise.reject(new Error("Mermaid sandbox frame crashed."));
    }
    const requestId = randomToken();
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.destroyFrame(frame, new Error("Mermaid sandbox render timed out."));
      }, this.renderTimeoutMs);

      frame.activeRequest = { requestId, resolve, reject, timer };
      const request: SandboxRenderRequest = {
        channel: SANDBOX_CHANNEL,
        type: "render",
        frameToken: frame.frameToken,
        requestId,
        id,
        source,
        dark,
      };
      try {
        frame.iframe.contentWindow!.postMessage(request, "*");
      } catch (error) {
        this.destroyFrame(
          frame,
          error instanceof Error ? error : new Error("Failed to post message to Mermaid sandbox."),
        );
      }
    });
  }
}

let sharedSandbox: MermaidSandboxClient | null = null;

export function renderInMermaidSandbox(id: string, source: string, dark: boolean): Promise<string> {
  if (!sharedSandbox) {
    sharedSandbox = new MermaidSandboxClient();
  }
  return sharedSandbox.render(id, source, dark);
}

export function resetSharedMermaidSandbox(): void {
  sharedSandbox?.dispose();
  sharedSandbox = null;
}
