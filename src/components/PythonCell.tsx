import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { PythonResult } from "../types";

export default function PythonCell({ source, python }: { source: string; python: string }) {
  const [result, setResult] = useState<PythonResult | null>(null);
  const [running, setRunning] = useState(false);
  const run = async () => {
    setRunning(true);
    try { setResult(await invoke<PythonResult>("run_python", { python, code: source })); }
    catch (error) { setResult({ stdout: "", stderr: String(error), images: [], ok: false }); }
    finally { setRunning(false); }
  };
  return (
    <div className="python-cell">
      <div className="cell-toolbar"><span>Python</span><button onClick={run} disabled={running || !python}>{running ? "Running…" : "Run"}</button></div>
      <pre><code className="language-python">{source}</code></pre>
      {result && <div className={`cell-output ${result.ok ? "" : "failed"}`}>
        {result.stdout && <pre>{result.stdout}</pre>}
        {result.stderr && <pre>{result.stderr}</pre>}
        {result.images.map((image, index) => <img key={index} src={image} alt={`Python figure ${index + 1}`} />)}
      </div>}
    </div>
  );
}
