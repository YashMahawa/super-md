import { useEffect, useRef, useState, type ReactNode } from "react";
import { invoke } from "../nativeBridge";
import { pythonResults, remember, retainVisiblePython,storePythonOutput,loadPythonOutput,pythonStored } from "../renderedOutputs";
import type { PythonResult } from "../types";
import CopyCode from "./CopyCode";

// Figures come from local processes or caches: accept only bounded SVG/PNG/JPEG data.
const safeFigure = (image: unknown): image is string => typeof image === "string" && image.length <= 12_000_000 && /^data:image\/(?:svg\+xml|png|jpeg);base64,[A-Za-z0-9+/]+=*$/.test(image.slice(0, 64) + (image.length > 64 ? image.slice(-8) : ""));

export default function PythonCell({ source, python, highlighted }: { source: string; python: string; highlighted?: ReactNode }) {
  const [result, setResult] = useState<PythonResult | null>(() => pythonResults.get(source) || null);
  const [running, setRunning] = useState(false);
  const [stored,setStored]=useState(()=>pythonStored(source));
  const executedSource = useRef(pythonResults.has(source) ? source : "");
  const runId = useRef(0);
  const cell=useRef<HTMLDivElement>(null);
  useEffect(()=>result?retainVisiblePython(executedSource.current,result):undefined,[result]);
  useEffect(()=>{let active=true;const initialRun=runId.current;void loadPythonOutput(source).then(output=>{if(active&&output&&runId.current===initialRun){executedSource.current=source;setResult(output);setStored(pythonStored(source));}});return()=>{active=false;};},[source]);
  useEffect(()=>{if(!result||stored)return;let active=true;void storePythonOutput(executedSource.current,result).then(saved=>{if(active)setStored(saved);});return()=>{active=false;};},[result,stored]);
  useEffect(()=>{if(stored&&!running)cell.current?.dispatchEvent(new Event('supermd-output-stored',{bubbles:true}));},[stored,running]);
  const run = async () => {
    const currentRun = ++runId.current;
    const currentSource = source;
    setRunning(true);
    try {
      const output = await invoke<PythonResult>("run_python", { python, code: currentSource });
      remember(pythonResults, currentSource, output);
      if (currentRun === runId.current) { executedSource.current = currentSource;setStored(false); setResult(output); }
    } catch (error) {
      const failure = { stdout: "", stderr: String(error), images: [], ok: false };
      remember(pythonResults, currentSource, failure);
      if (currentRun === runId.current) { executedSource.current = currentSource;setStored(false); setResult(failure); }
    } finally { if (currentRun === runId.current) setRunning(false); }
  };
  const stale = Boolean(result && executedSource.current !== source);
  return (
    <div ref={cell} className="python-cell" data-output-pinned={!!result&&!stored||running}>
      <div className="cell-toolbar"><span>Python {stale && <small className="stale-badge">Output from earlier code</small>}</span><CopyCode source={source}/><button onClick={run} disabled={running}>{running ? "Running…" : stale ? "Run updated code" : "Run"}</button></div>
      <pre className="python-source" aria-label="Python source"><code className="language-python">{highlighted ?? source}</code></pre>
      {result && <div className={`cell-output ${result.ok ? "" : "failed"} ${stale ? "stale" : ""}`}>
        {result.stdout && <pre>{result.stdout}</pre>}
        {result.stderr && <pre>{result.stderr}</pre>}
        {result.images.filter(safeFigure).slice(0, 16).map((image, index) => <img key={index} src={image} alt={`Python figure ${index + 1}`} />)}
      </div>}
    </div>
  );
}
