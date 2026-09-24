import { useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { PythonResult } from "../types";

export default function PythonCell({ source, python }: { source: string; python: string }) {
  const [result, setResult] = useState<PythonResult | null>(null);
  const [running, setRunning] = useState(false);
  const executedSource = useRef("");
  const runId = useRef(0);
  const run = async () => {
    const currentRun = ++runId.current;
    const currentSource = source;
    setRunning(true);
    try {
      const output = await invoke<PythonResult>("run_python", { python, code: currentSource });
      if (currentRun === runId.current) { executedSource.current = currentSource; setResult(output); }
    } catch (error) {
      if (currentRun === runId.current) { executedSource.current = currentSource; setResult({ stdout: "", stderr: String(error), images: [], ok: false }); }
    } finally { if (currentRun === runId.current) setRunning(false); }
  };
  const stale = Boolean(result && executedSource.current !== source);
  return (
    <div className="python-cell">
      <div className="cell-toolbar"><span>Python {stale && <small className="stale-badge">Output from earlier code</small>}</span><button onClick={run} disabled={running || !python}>{running ? "Running…" : stale ? "Run updated code" : "Run"}</button></div>
      <pre><code className="language-python">{source}</code></pre>
      {result && <div className={`cell-output ${result.ok ? "" : "failed"} ${stale ? "stale" : ""}`}>
        {result.stdout && <pre>{result.stdout}</pre>}
        {result.stderr && <pre>{result.stderr}</pre>}
        {result.images.map((image, index) => <img key={index} src={image} alt={`Python figure ${index + 1}`} />)}
      </div>}
    </div>
  );
}
