let queue = Promise.resolve();
let serial = 0;
export function renderMermaid(source: string, dark = false): Promise<string> {
  const render = async () => {
    const { default: mermaid } = await import("mermaid");
    const container = document.createElement("div");
    container.style.cssText = "position:fixed;left:-100000px;top:0;width:1200px;visibility:hidden;pointer-events:none";
    document.body.appendChild(container);
    try {
      mermaid.initialize({ startOnLoad: false, theme: dark ? "dark" : "neutral", securityLevel: "strict", htmlLabels: false, flowchart: { htmlLabels: false }, fontFamily: "Arial, sans-serif" });
      return (await mermaid.render(`smd-diagram-${++serial}`, source, container)).svg;
    } finally { container.remove(); }
  };
  const result = queue.then(render); queue = result.then(() => undefined, () => undefined);
  return result;
}
