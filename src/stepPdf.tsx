import {renderToStaticMarkup} from "react-dom/server";
import InlineDiagram, {type DiagramSpec} from "./components/InlineDiagram";

/** Export SVG primitives with explicit print colours, independent of reader CSS. */
export function stepDiagramSvg(diagram: DiagramSpec): string {
  const parsed = new DOMParser().parseFromString(renderToStaticMarkup(<InlineDiagram diagram={diagram}/>), "text/html");
  const svg = parsed.querySelector("svg")!;
  svg.querySelectorAll("line").forEach(line => {
    line.setAttribute("stroke", "#667085"); line.setAttribute("stroke-width", "3");
    if (line.classList.contains("is-dashed")) line.setAttribute("stroke-dasharray", "5 7");
  });
  svg.querySelectorAll("g").forEach(group => {
    const active = group.classList.contains("is-active"), visited = group.classList.contains("is-visited");
    if (group.classList.contains("is-muted")) group.setAttribute("opacity", ".4");
    group.querySelectorAll("circle,rect").forEach(shape => {
      shape.setAttribute("fill", active ? "#ffb367" : visited ? "#153d4b" : "#f4f7fb");
      shape.setAttribute("stroke", "#386a57"); shape.setAttribute("stroke-width", "2.5");
    });
    group.querySelectorAll("text").forEach(text => {
      text.setAttribute("fill", visited ? "#f1faff" : "#20252d");
      text.setAttribute("font-size", "21"); text.setAttribute("font-family", "sans-serif");
    });
  });
  return new XMLSerializer().serializeToString(svg);
}
