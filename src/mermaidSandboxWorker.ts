import {
  MAX_MERMAID_SOURCE_CHARS,
  MAX_SANDBOX_ERROR_CHARS,
  MAX_SANDBOX_SVG_CHARS,
  SANDBOX_CHANNEL,
  isSandboxPingMessage,
  isSandboxRenderRequest,
  type SandboxReadyMessage,
  type SandboxRenderResult,
} from "./mermaidSandboxProtocol";

export interface MermaidEngineLike {
  initialize(config: Record<string, unknown>): void;
  render(id: string, text: string, svgContainingElement?: Element): Promise<{ svg: string }>;
}

export interface MessagePoster {
  postMessage(message: unknown, targetOrigin: string): void;
}

export function installMermaidSandboxWorker(
  scopeWindow: Window,
  parentTarget: MessagePoster,
  loadEngine: () => Promise<MermaidEngineLike>,
): () => void {
  let queue = Promise.resolve();

  const sendReady = () => {
    const ready: SandboxReadyMessage = { channel: SANDBOX_CHANNEL, type: "ready" };
    parentTarget.postMessage(ready, "*");
  };

  const reply = (payload: SandboxRenderResult) => {
    parentTarget.postMessage(payload, "*");
  };

  const onMessage = (event: MessageEvent<unknown>) => {
    if (event.source !== scopeWindow.parent && event.source !== (parentTarget as unknown)) return;
    const data = event.data;
    if (isSandboxPingMessage(data)) {
      sendReady();
      return;
    }
    if (!isSandboxRenderRequest(data)) return;
    const { frameToken, requestId, id, source, dark } = data;
    if (source.length > MAX_MERMAID_SOURCE_CHARS) {
      reply({
        channel: SANDBOX_CHANNEL,
        type: "result",
        frameToken,
        requestId,
        ok: false,
        error: "Mermaid diagram source exceeds maximum size.",
      });
      return;
    }

    const job = queue.then(async () => {
      const doc = scopeWindow.document;
      let container: HTMLDivElement | null = null;
      try {
        if (!doc.body) {
          const body = doc.createElement("body");
          doc.documentElement.appendChild(body);
        }
        doc.body.style.cssText = "margin:0;padding:0;overflow:hidden";
        container = doc.createElement("div");
        // Keep the measurement container inside the sandbox viewport without
        // visibility:hidden so Chromium cross-origin subframe throttling never
        // skips style/layout before Mermaid inspects getBBox() or offsetWidth.
        container.style.cssText =
          "position:fixed;left:0;top:0;width:1200px;height:800px;pointer-events:none";
        doc.body.appendChild(container);
        void container.offsetWidth;
        const mermaid = await loadEngine();
        mermaid.initialize({
          startOnLoad: false,
          theme: dark ? "dark" : "neutral",
          securityLevel: "strict",
          htmlLabels: false,
          flowchart: { htmlLabels: false },
          gantt: { useWidth: 1200 },
          c4: { useWidth: 1200 },
          fontFamily: "Arial, sans-serif",
        });
        const rendered = await mermaid.render(id, source, container);
        if (!rendered || typeof rendered.svg !== "string") {
          throw new Error("Mermaid did not produce an SVG string.");
        }
        if (rendered.svg.length > MAX_SANDBOX_SVG_CHARS) {
          throw new Error("Rendered Mermaid SVG exceeds maximum size.");
        }
        reply({
          channel: SANDBOX_CHANNEL,
          type: "result",
          frameToken,
          requestId,
          ok: true,
          svg: rendered.svg,
        });
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : String(reason);
        reply({
          channel: SANDBOX_CHANNEL,
          type: "result",
          frameToken,
          requestId,
          ok: false,
          error: message.slice(0, MAX_SANDBOX_ERROR_CHARS),
        });
      } finally {
        try {
          container?.remove();
          doc.body?.replaceChildren();
        } catch {
          // Best-effort sandbox DOM cleanup.
        }
      }
    });
    queue = job.then(
      () => undefined,
      () => undefined,
    );
  };

  scopeWindow.addEventListener("message", onMessage);
  const ready: SandboxReadyMessage = { channel: SANDBOX_CHANNEL, type: "ready" };
  parentTarget.postMessage(ready, "*");
  return () => scopeWindow.removeEventListener("message", onMessage);
}
