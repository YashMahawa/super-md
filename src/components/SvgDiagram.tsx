import { useMemo } from "react";
import { presentSvg,svgImage,svgContrastBackdrop } from "../svgImage";
import type {MediaAppearance} from '../mediaAppearance';
import {adaptSvg} from '../svgTheme';

const inkColor = () => typeof document === "undefined" ? "#1c2635" : getComputedStyle(document.documentElement).getPropertyValue("--text").trim() || "#1c2635";

export default function SvgDiagram({ source, appearance, ink, colors, dark=false }: { source: string; dark?: boolean; appearance?:MediaAppearance; ink?:string;colors?:Record<string,string> }) {
  const raw=!!appearance&&appearance!=='original',visualInk=raw?undefined:ink||inkColor();
  // Only mounted diagrams create display variants when the palette changes;
  // the Markdown tree and offscreen diagrams remain cached/windowed.
  const rendered = useMemo(() => { try { return { ...(raw?{svg:svgImage(source),mode:'color' as const}:presentSvg(source, visualInk!)), error: "" }; } catch (error) { return { svg: "", mode: "color" as const, error: String(error) }; } }, [source, raw, visualInk]);
  const backing=useMemo(()=>svgContrastBackdrop(source),[source]);
  const adapted=useMemo(()=>appearance==='auto'&&!rendered.error?adaptSvg(rendered.svg,colors??{primary:ink??inkColor()},dark):rendered.svg,[rendered.svg,rendered.error,appearance,colors,dark,ink]);
  const backdrop=appearance==='contrast'?backing:undefined;
  if (rendered.error) return <p className="render-error" role="alert">{rendered.error}</p>;
  return <figure className={`svg-figure svg-figure--${rendered.mode}`}><img draggable={false} data-media-adapted={appearance==='auto'?'true':undefined} data-light-ink={backing==='#222026'?'true':undefined} className="svg-diagram" style={{backgroundColor:backdrop}} src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(adapted)}`} alt="SVG drawing" /></figure>;
}
