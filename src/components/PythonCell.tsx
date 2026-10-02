import { useRef, useState, type ReactNode } from "react";
import { invoke } from "../nativeBridge";
import { pythonResults, remember } from "../renderedOutputs";
import type { PythonResult } from "../types";
import CopyCode from "./CopyCode";

export default function PythonCell({ source, python, highlighted }: { source: string; python: string; highlighted?: ReactNode }) {
  const [result, setResult] = useState<PythonResult | null>(() => pythonResults.get(source) || null);
  const [running, setRunning] = useState(false);
  const executedSource = useRef(pythonResults.has(source) ? source : "");
  const runId = useRef(0);
  const run = async () => {
    const currentRun = ++runId.current;
    const currentSource = source;
    setRunning(true);
    try {
      const output = await invoke<PythonResult>("run_python", { python, code: currentSource });
      remember(pythonResults, currentSource, output);
      if (currentRun === runId.current) { executedSource.current = currentSource; setResult(output); }
    } catch (error) {
      const failure = { stdout: "", stderr: String(error), images: [], ok: false };
      remember(pythonResults, currentSource, failure);
      if (currentRun === runId.current) { executedSource.current = currentSource; setResult(failure); }
    } finally { if (currentRun === runId.current) setRunning(false); }
  };
  const stale = Boolean(result && executedSource.current !== source);
  return (
    <div className="python-cell">
      <div className="cell-toolbar"><span>Python {stale && <small className="stale-badge">Output from earlier code</small>}</span><CopyCode source={source}/><button onClick={run} disabled={running || !python}>{running ? "Running…" : stale ? "Run updated code" : "Run"}</button></div>
      <details className="code-disclosure" open={source.split("\n").length <= 12}><summary>Python source <span>{source.split("\n").length} lines</span></summary><pre><code className="language-python">{highlighted ?? source}</code></pre></details>
      {result && <div className={`cell-output ${result.ok ? "" : "failed"} ${stale ? "stale" : ""}`}>
        {result.stdout && <pre>{result.stdout}</pre>}
        {result.stderr && <pre>{result.stderr}</pre>}
        {result.images.map((image, index) => <img key={index} src={image} alt={`Python figure ${index + 1}`} />)}
      </div>}
    </div>
  );
}
