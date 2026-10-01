import { useMemo } from "react";
import { svgImage } from "../svgImage";
export default function SvgDiagram({ source }: { source: string }) {
  const rendered = useMemo(() => { try { return { svg: svgImage(source), error: "" }; } catch (error) { return { svg: "", error: String(error) }; } }, [source]);
  if (rendered.error) return <p className="render-error" role="alert">{rendered.error}</p>;
  return <img className="svg-diagram" src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(rendered.svg)}`} alt="SVG diagram" />;
}
