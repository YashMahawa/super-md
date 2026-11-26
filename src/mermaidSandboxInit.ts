import { scrubSandboxHostBridges } from "./mermaidSandboxBootstrap";

if (typeof window !== "undefined") {
  scrubSandboxHostBridges(window as unknown as Record<string, unknown>);
}
