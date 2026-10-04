import { useMemo } from "react";
import { presentSvg } from "../svgImage";

const inkColor = () => typeof document === "undefined" ? "#1c2635" : getComputedStyle(document.documentElement).getPropertyValue("--text").trim() || "#1c2635";

export default function SvgDiagram({ source, dark = false }: { source: string; dark?: boolean }) {
  // dark is a dependency so line art re-inks when the theme changes.
  const rendered = useMemo(() => { try { return { ...presentSvg(source, inkColor()), error: "" }; } catch (error) { return { svg: "", mode: "color" as const, error: String(error) }; } }, [source, dark]);
  if (rendered.error) return <p className="render-error" role="alert">{rendered.error}</p>;
  return <figure className={`svg-figure svg-figure--${rendered.mode}`}><img className="svg-diagram" src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(rendered.svg)}`} alt="SVG drawing" /></figure>;
}
