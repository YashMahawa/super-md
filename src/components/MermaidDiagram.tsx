import { useEffect, useId, useState } from "react";

export default function MermaidDiagram({ source, dark }: { source: string; dark: boolean }) {
  const id = `mermaid-${useId().replaceAll(":", "")}`;
  const [svg, setSvg] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    import("mermaid").then(({ default: mermaid }) => {
      mermaid.initialize({ startOnLoad: false, theme: dark ? "dark" : "neutral", securityLevel: "strict" });
      return mermaid.render(id, source);
    }).then((result) => {
      if (active) { setSvg(result.svg); setError(""); }
    }).catch((reason) => active && setError(String(reason)));
    return () => { active = false; };
  }, [dark, id, source]);
  if (error) return <div className="render-error">Mermaid: {error}</div>;
  return <div className="mermaid" dangerouslySetInnerHTML={{ __html: svg }} />;
}
