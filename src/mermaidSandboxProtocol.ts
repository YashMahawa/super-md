export const SANDBOX_CHANNEL = "supermd-mermaid-sandbox" as const;
export const MAX_MERMAID_SOURCE_CHARS = 250_000;
export const MAX_SANDBOX_SVG_CHARS = 2_000_000;
export const MAX_SANDBOX_ERROR_CHARS = 4_096;
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000;
export const DEFAULT_RENDER_TIMEOUT_MS = 8_000;

export type SandboxReadyMessage = {
  channel: typeof SANDBOX_CHANNEL;
  type: "ready";
};

export type SandboxRenderRequest = {
  channel: typeof SANDBOX_CHANNEL;
  type: "render";
  frameToken: string;
  requestId: string;
  id: string;
  source: string;
  dark: boolean;
};

export type SandboxRenderResult =
  | {
      channel: typeof SANDBOX_CHANNEL;
      type: "result";
      frameToken: string;
      requestId: string;
      ok: true;
      svg: string;
    }
  | {
      channel: typeof SANDBOX_CHANNEL;
      type: "result";
      frameToken: string;
      requestId: string;
      ok: false;
      error: string;
    };

export function buildSandboxCsp(scriptSha256Base64: string): string {
  return [
    "default-src 'none'",
    `script-src 'sha256-${scriptSha256Base64}' 'wasm-unsafe-eval'`,
    "style-src 'unsafe-inline'",
    "img-src data:",
    "font-src data:",
    "connect-src 'none'",
    "worker-src 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "object-src 'none'",
    "media-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ");
}

export function buildSandboxHtml(iifeScript: string, sha256OfEscapedScript: (escapedScript: string) => string): string {
  // Escape closing script tags before hashing so the exact inline text bytes match the CSP digest.
  const escaped = iifeScript.replace(/<\/(script)/gi, "<\\/$1");
  const digest = sha256OfEscapedScript(escaped);
  const csp = buildSandboxCsp(digest);
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"></head><body><script>${escaped}</script></body></html>`;
}

export function isSandboxRenderRequest(value: unknown): value is SandboxRenderRequest {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.channel === SANDBOX_CHANNEL &&
    candidate.type === "render" &&
    typeof candidate.frameToken === "string" &&
    candidate.frameToken.length > 0 &&
    candidate.frameToken.length <= 128 &&
    typeof candidate.requestId === "string" &&
    candidate.requestId.length > 0 &&
    candidate.requestId.length <= 128 &&
    typeof candidate.id === "string" &&
    /^[\w-]+$/.test(candidate.id) &&
    candidate.id.length <= 128 &&
    typeof candidate.source === "string" &&
    typeof candidate.dark === "boolean"
  );
}
