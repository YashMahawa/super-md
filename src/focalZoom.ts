export interface Point { x: number; y: number }
/** Keep the world point under the pointer fixed when scaling about an origin. */
export function zoomTranslation(pan: Point, origin: Point, focus: Point, previous: number, next: number): Point {
  const ratio = next / previous;
  return {x: focus.x - origin.x - (focus.x - origin.x - pan.x) * ratio,
    y: focus.y - origin.y - (focus.y - origin.y - pan.y) * ratio};
}
/** A plot center is expressed in units of its original domain span. */
export function zoomPlotCenter(center: Point, previous: number, next: number, focus: Point): Point {
  return {x: center.x + (focus.x - .5) * (1 / previous - 1 / next),
    y: center.y + (.5 - focus.y) * (1 / previous - 1 / next)};
}
export function axisNumber(value: number): string {
  if (Math.abs(value) < 1e-12) return "0";
  return Math.abs(value) >= 1e5 || Math.abs(value) < .001 ? value.toExponential(2) : String(Number(value.toPrecision(5)));
}
export function axisTicks(min: number, max: number, count = 6): number[] {
  const rough = (max - min) / count;
  if (!(rough > 0) || !Number.isFinite(rough)) return [];
  const power = 10 ** Math.floor(Math.log10(rough)), fraction = rough / power;
  const step = (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * power;
  const first = Math.ceil(min / step) * step;
  return Array.from({length: Math.min(20, Math.max(0, Math.floor((max - first) / step) + 1))}, (_, i) => first + i * step);
}
