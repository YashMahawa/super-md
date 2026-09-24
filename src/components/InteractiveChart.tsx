import { useEffect, useMemo, useState } from "react";
import type { ChartSpec } from "../types";
import { compileMathExpression } from "../mathExpression";

const palette = ["#6750a4", "#006a6a", "#b3261e", "#7d5700", "#3f6374"];

export default function InteractiveChart({ source }: { source: string }) {
  const parsed = useMemo(() => {
    try { return { spec: JSON.parse(source) as ChartSpec, error: "" }; }
    catch (error) { return { spec: null, error: String(error) }; }
  }, [source]);
  const [values, setValues] = useState<Record<string, number>>(() =>
    Object.fromEntries((parsed.spec?.sliders ?? []).map((slider) => [slider.name, slider.value]))
  );
  const sliderSchema = JSON.stringify((parsed.spec?.sliders ?? []).map((slider) => [slider.name, slider.value]));
  useEffect(() => {
    const sliders = parsed.spec?.sliders ?? [];
    setValues((current) => Object.fromEntries(sliders.map((slider) => [slider.name, Number.isFinite(current[slider.name]) ? current[slider.name] : slider.value])));
  }, [sliderSchema]);
  const compiled = useMemo(() => (parsed.spec?.series ?? []).map((series) => {
    try { return { evaluate: compileMathExpression(series.expression ?? "0"), error: "" }; }
    catch (error) { return { evaluate: null, error: String(error) }; }
  }), [parsed.spec]);

  if (!parsed.spec) return <div className="render-error">Invalid smd-chart JSON: {parsed.error}</div>;
  const spec = parsed.spec;
  if (!Array.isArray(spec.series)) return <div className="render-error">Chart series must be an array.</div>;
  const effectiveValues = Object.fromEntries((spec.sliders ?? []).map((slider) => [slider.name, Number.isFinite(values[slider.name]) ? values[slider.name] : slider.value]));
  const xMin = Number.isFinite(spec.x?.min) ? spec.x!.min! : -10;
  const xMax = Number.isFinite(spec.x?.max) && spec.x!.max! > xMin ? spec.x!.max! : xMin + 20;
  const steps = Math.max(8, Math.min(spec.x?.steps ?? 160, 1000));
  const rawSeries = spec.series.map((series) => {
    if (series.points) return series.points.filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
    const evaluator = compiled[spec.series.indexOf(series)]?.evaluate;
    if (!evaluator) return [];
    return Array.from({ length: steps + 1 }, (_, index) => {
      const x = xMin + (index / steps) * (xMax - xMin);
      return [x, evaluator({ ...effectiveValues, x })] as [number, number];
    }).filter((point) => Number.isFinite(point[1]));
  });
  const allY = rawSeries.flat().map((point) => point[1]);
  const yMin = Number.isFinite(spec.y?.min) ? spec.y!.min! : allY.length ? Math.min(...allY, -1) : -1;
  const proposedYMax = Number.isFinite(spec.y?.max) ? spec.y!.max! : allY.length ? Math.max(...allY, 1) : 1;
  const yMax = proposedYMax > yMin ? proposedYMax : yMin + 2;
  const width = 760, height = 360, left = 56, top = 24, right = 20, bottom = 46;
  const px = (x: number) => left + ((x - xMin) / (xMax - xMin || 1)) * (width - left - right);
  const py = (y: number) => top + (1 - (y - yMin) / (yMax - yMin || 1)) * (height - top - bottom);

  return (
    <figure className="interactive-chart">
      {spec.title && <figcaption>{spec.title}</figcaption>}
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={spec.title ?? "Interactive graph"}>
        <line className="chart-axis" x1={left} x2={width - right} y1={py(0)} y2={py(0)} />
        <line className="chart-axis" x1={px(0)} x2={px(0)} y1={top} y2={height - bottom} />
        <text x={left} y={height - 12}>{spec.x?.label ?? `x: ${xMin} … ${xMax}`}</text>
        <text x={8} y={18}>{spec.y?.label ?? `y: ${yMin.toFixed(2)} … ${yMax.toFixed(2)}`}</text>
        {rawSeries.map((points, index) => (
          <polyline key={index} fill="none" stroke={spec.series[index].color ?? palette[index % palette.length]}
            strokeWidth="3" points={points.map(([x, y]) => `${px(x)},${py(y)}`).join(" ")} />
        ))}
      </svg>
      <div className="chart-controls">
        {(spec.sliders ?? []).map((slider) => (
          <label key={slider.name}>
            <span>{slider.label ?? slider.name}: <strong>{effectiveValues[slider.name]}</strong></span>
            <input type="range" min={slider.min} max={slider.max} step={slider.step} value={effectiveValues[slider.name]}
              onChange={(event) => setValues((current) => ({ ...current, [slider.name]: Number(event.target.value) }))} />
          </label>
        ))}
      </div>
      {compiled.some((series) => series.error) && <div className="chart-warning" role="status">Invalid expression: {compiled.find((series) => series.error)?.error}</div>}
      <div className="chart-legend">
        {spec.series.map((series, index) => <span key={index} style={{ color: series.color ?? palette[index % palette.length] }}>● {series.name ?? series.expression}</span>)}
      </div>
    </figure>
  );
}
