import { useMemo } from "react";
import { presentSvg,svgImage,svgContrastBackdrop } from "../svgImage";
import type {MediaAppearance} from '../mediaAppearance';

const inkColor = () => typeof document === "undefined" ? "#1c2635" : getComputedStyle(document.documentElement).getPropertyValue("--text").trim() || "#1c2635";

export default function SvgDiagram({ source, appearance, ink }: { source: string; dark?: boolean; appearance?:MediaAppearance; ink?:string }) {
  const raw=!!appearance&&appearance!=='original',visualInk=raw?undefined:ink||inkColor();
  // Auto colours are applied by the shared filter. Do not reparse/re-encode
  // every SVG in a huge note when just the accent or theme changes.
  const rendered = useMemo(() => { try { return { ...(raw?{svg:svgImage(source),mode:'color' as const}:presentSvg(source, visualInk!)), error: "" }; } catch (error) { return { svg: "", mode: "color" as const, error: String(error) }; } }, [source, raw, visualInk]);
  const backing=useMemo(()=>svgContrastBackdrop(source),[source]);
  const backdrop=appearance==='contrast'?backing:undefined;
  if (rendered.error) return <p className="render-error" role="alert">{rendered.error}</p>;
  return <figure className={`svg-figure svg-figure--${rendered.mode}`}><img draggable={false} data-light-ink={backing==='#222026'?'true':undefined} className="svg-diagram" style={{backgroundColor:backdrop}} src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(rendered.svg)}`} alt="SVG drawing" /></figure>;
}
