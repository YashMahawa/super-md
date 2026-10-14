import { useMemo } from "react";
import { presentSvg,svgImage } from "../svgImage";
import type {MediaAppearance} from '../mediaAppearance';

const inkColor = () => typeof document === "undefined" ? "#1c2635" : getComputedStyle(document.documentElement).getPropertyValue("--text").trim() || "#1c2635";

export default function SvgDiagram({ source, dark = false, appearance, ink }: { source: string; dark?: boolean; appearance?:MediaAppearance; ink?:string }) {
  // dark is a dependency so line art re-inks when the theme changes.
  const rendered = useMemo(() => { try { return { ...(appearance==='invert-dark'?{svg:svgImage(source),mode:'color' as const}:presentSvg(source, ink||inkColor())), error: "" }; } catch (error) { return { svg: "", mode: "color" as const, error: String(error) }; } }, [source, dark, appearance, ink]);
  if (rendered.error) return <p className="render-error" role="alert">{rendered.error}</p>;
  return <figure data-auto-ink={appearance==='auto'&&rendered.mode==='mono'?'true':undefined} className={`svg-figure svg-figure--${rendered.mode}`}><img draggable={false} className="svg-diagram" src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(rendered.svg)}`} alt="SVG drawing" /></figure>;
}
