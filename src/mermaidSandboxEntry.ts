import mermaid from "mermaid";
import { installMermaidSandboxWorker } from "./mermaidSandboxWorker";

installMermaidSandboxWorker(window, window.parent, async () => mermaid);
