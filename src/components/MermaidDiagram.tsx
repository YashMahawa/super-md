import { useEffect, useState } from "react";
import { renderMermaid } from "../mermaidRenderer";
export default function MermaidDiagram({ source, dark }: { source: string; dark: boolean }) {
  const [svg, setSvg] = useState(""); const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => { renderMermaid(source, dark).then((result) => { if (active) { setSvg(result); setError(""); } }).catch((reason) => active && setError(String(reason))); }, 220);
    return () => { active = false; window.clearTimeout(timer); };
  }, [dark, source]);
  if (error) return <div className="render-error">Mermaid: {error}</div>;
  return <div className="mermaid" dangerouslySetInnerHTML={{ __html: svg }} />;
}
