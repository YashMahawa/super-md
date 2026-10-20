import { useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { invoke } from "../nativeBridge";
import { cachedPythonOutput, pythonContextKey, rememberPythonOutput, retainVisiblePython,storePythonOutput,loadPythonOutput,pythonStored } from "../renderedOutputs";
import type { PythonContext, PythonResult } from "../types";
import CopyCode from "./CopyCode";
import {DocumentAppearance} from '../documentAppearance';
import SvgDiagram from './SvgDiagram';

function PythonFigure({image,index}:{image:string;index:number}) {
  const theme=useContext(DocumentAppearance);
  const svg=useMemo(()=>{if(!image.startsWith('data:image/svg+xml;base64,'))return null;try{return new TextDecoder().decode(Uint8Array.from(atob(image.slice(image.indexOf(',')+1)),c=>c.charCodeAt(0)));}catch{return null;}},[image]);
  return svg?<SvgDiagram source={svg} dark={theme?.dark} appearance={theme?.svgAppearance} colors={theme?.colors} preserveOriginal label={`Python figure ${index+1}`}/>:<img draggable={false} data-media-kind="image" src={image} alt={`Python figure ${index+1}`}/>;
}

// Figures come from local processes or caches: accept only bounded SVG/PNG/JPEG data.
const safeFigure = (image: unknown): image is string => typeof image === "string" && image.length <= 12_000_000 && /^data:image\/(?:svg\+xml|png|jpeg);base64,[A-Za-z0-9+/]+=*$/.test(image.slice(0, 64) + (image.length > 64 ? image.slice(-8) : ""));

export default function PythonCell({ source, python, highlighted, context }: { source: string; python: string; highlighted?: ReactNode; context?:PythonContext }) {
  const identity=context?pythonContextKey(source,context):JSON.stringify([source]);
  const scope= context?JSON.stringify([context.document,context.cell,context.interpreter]):"legacy";
  const initial=cachedPythonOutput(source,context)||null;
  const [result, setResult] = useState<PythonResult | null>(() => initial);
  const [running, setRunning] = useState(false);
  const [stored,setStored]=useState(()=>!!initial&&pythonStored(source,context));
  const executedSource = useRef(initial?source:"");
  const executedContext = useRef(context);
  const executedIdentity = useRef(initial?identity:"");
  const runId = useRef(0);
  const pendingStore = useRef<{source:string;context?:PythonContext;freshExecution:boolean}|null>(null);
  const cell=useRef<HTMLDivElement>(null);
  useEffect(()=>result?retainVisiblePython(executedSource.current,result,executedContext.current):undefined,[result]);
  useEffect(()=>{
    let active=true;
    const initialRun=++runId.current;
    setRunning(false);
    const contextChanged=(executedContext.current?JSON.stringify([executedContext.current.document,executedContext.current.cell,executedContext.current.interpreter]):"legacy")!==scope;
    if(contextChanged){executedSource.current="";executedIdentity.current="";executedContext.current=context;setResult(null);setStored(false);}
    void loadPythonOutput(source,context).then(output=>{
      if(active&&output&&runId.current===initialRun){executedSource.current=source;executedContext.current=context;executedIdentity.current=identity;setResult(output);setStored(pythonStored(source,context));}
    });
    return()=>{active=false;};
  },[source,scope]);
  useEffect(()=>{
    const pending=pendingStore.current;
    if(!result||!pending)return;
    pendingStore.current=null;
    let active=true;
    void storePythonOutput(pending.source,result,pending.context,pending.freshExecution).then(saved=>{
      if(!active)return;
      setStored(saved);
      if(saved&&pending.freshExecution&&pending.context&&result.provenance?.unsaved===true){
        const persisted:PythonResult={...result,provenance:{verified:true,document:pending.context.document,cell:pending.context.cell,interpreter:pending.context.interpreter}};
        rememberPythonOutput(pending.source,persisted,pending.context);
        setResult(persisted);
      }
    });
    return()=>{active=false;};
  },[result]);
  useEffect(()=>{if(stored&&!running)cell.current?.dispatchEvent(new Event('supermd-output-stored',{bubbles:true}));},[stored,running]);
  const run = async () => {
    const currentRun = ++runId.current;
    const currentSource = source;
    setRunning(true);
    try {
      const output = await invoke<PythonResult>("run_python", { python, code: currentSource,...(context?{context}:{}) });
      const nativeVerified=!!(context&&output.provenance?.verified&&output.provenance.document===context.document&&output.provenance.cell===context.cell&&typeof output.provenance.interpreter==='string');
      const scopedOutput:PythonResult=context?{...output,provenance:nativeVerified?output.provenance:(output.provenance??{verified:true,document:context.document,cell:context.cell,interpreter:context.interpreter})}:{...output,provenance:{verified:false,reason:'Unscoped live output'}};
      rememberPythonOutput(currentSource,scopedOutput,context);
      if (currentRun === runId.current) { executedSource.current = currentSource;executedContext.current=context;executedIdentity.current=identity;pendingStore.current={source:currentSource,context,freshExecution:!!context&&!nativeVerified};setStored(false); setResult(scopedOutput); }
    } catch (error) {
      const failure:PythonResult = { stdout: "", stderr: String(error), images: [], ok: false,provenance:{verified:false,reason:'Execution failed before output was recorded'} };
      rememberPythonOutput(currentSource, failure,context);
      if (currentRun === runId.current) { executedSource.current = currentSource;executedContext.current=context;executedIdentity.current=identity;pendingStore.current=null;setStored(false); setResult(failure); }
    } finally { if (currentRun === runId.current) setRunning(false); }
  };
  const stale = Boolean(result && (executedSource.current !== source || executedIdentity.current !== identity));
  return (
    <div ref={cell} className="python-cell" data-output-pinned={!!result&&!stored||running}>
      <div className="cell-toolbar"><span>Python {stale && <small className="stale-badge">Output from earlier code</small>} {result?.provenance?.unsaved&&<small className="stale-badge">Output not saved</small>} {result?.provenance&&!result.provenance.verified&&!result.provenance.unsaved&&result.provenance.reason?.includes('Legacy')&&<small className="stale-badge">Unverified saved output</small>}</span><CopyCode source={source}/><button className="python-run" onClick={run} disabled={running}>{running ? "Running…" : stale ? "Run updated code" : "Run"}</button></div>
      <pre className="python-source" aria-label="Python source"><code className="language-python">{highlighted ?? source}</code></pre>
      {result && <div className={`cell-output ${result.ok ? "" : "failed"} ${stale ? "stale" : ""}`}>
        {result.stdout && <pre>{result.stdout}</pre>}
        {result.stderr && <pre>{result.stderr}</pre>}
        {result.images.filter(safeFigure).slice(0, 16).map((image, index) => <PythonFigure key={index} image={image} index={index}/>)}
      </div>}
    </div>
  );
}
