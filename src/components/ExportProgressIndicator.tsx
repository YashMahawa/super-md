import "./ExportProgressIndicator.css";

/** One visible expressive shape; native progress remains available to assistive
 * technology without a competing visual loading track. */
export default function ExportProgressIndicator({ completed, total }: { completed?: number; total?: number }) {
  const determinate = Number.isFinite(total) && total! > 0 && Number.isFinite(completed);
  const max = determinate ? total! : undefined;
  const value = determinate ? Math.max(0, Math.min(completed!, max!)) : undefined;

  return <div className="export-progress-indicator">
    <span className="export-progress-morph" aria-hidden="true" />
    {determinate
      ? <progress aria-label="Export preparation progress" max={max} value={value} />
      : <progress aria-label="Export in progress" />}
  </div>;
}
