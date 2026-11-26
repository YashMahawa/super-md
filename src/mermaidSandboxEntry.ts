import "./mermaidSandboxInit";
import { installMermaidSandboxWorker, type MermaidEngineLike } from "./mermaidSandboxWorker";

let cachedEngine: Promise<MermaidEngineLike> | null = null;

installMermaidSandboxWorker(window, window.parent, () => {
  if (!cachedEngine) {
    cachedEngine = import("mermaid")
      .then(mod => {
        const engine = mod.default as unknown as MermaidEngineLike & { startOnLoad?: boolean };
        engine.startOnLoad = false;
        return engine;
      })
      .catch(error => {
        cachedEngine = null;
        throw error;
      });
  }
  return cachedEngine;
});
