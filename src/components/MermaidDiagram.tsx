import { useEffect, useState } from "react";
import { renderMermaid } from "../mermaidRenderer";
import {canUsePele} from '../peleRenderer';
import SvgDiagram from './SvgDiagram';
import type {MediaAppearance} from '../mediaAppearance';
export default function MermaidDiagram({ source, dark, appearance, colors }: { source: string; dark: boolean; appearance?:MediaAppearance;colors?:Record<string,string> }) {
  const [rendered, setRendered] = useState<{svg:string;dark:boolean}>(); const [error, setError] = useState("");
  // Appearance is a display variant, never a change to the authored diagram.
  // Adapt/monochrome/invert start from light source colours, so dark-mode
  // inversion is not applied a second time to a dark Mermaid rendering.
  const renderDark=(!appearance||appearance==='original')&&dark;
  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => { renderMermaid(source, renderDark).then((svg) => { if (active) { setRendered({svg,dark:renderDark}); setError(""); } }).catch((reason) => active && setError(String(reason))); }, canUsePele(source)?40:220);
    return () => { active = false; window.clearTimeout(timer); };
  }, [renderDark, source]);
  if (error) return <div className="render-error">Mermaid: {error}</div>;
  // Keep authored themeCSS inside an inert image. It must not style the app,
  // other notes, or a diagram with a different theme.
  return <div className="mermaid" data-render-dark={rendered?String(rendered.dark):undefined}>{rendered?<SvgDiagram source={rendered.svg} dark={dark} appearance={appearance} colors={colors} preserveOriginal label="Mermaid diagram"/>:<span className="image-loading" role="status">Loading diagram…</span>}</div>;
}
