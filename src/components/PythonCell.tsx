import { useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { invoke } from "../nativeBridge";
import { cachedPythonOutput, pythonContextKey, rememberPythonOutput, retainVisiblePython, storePythonOutput, loadPythonOutput, pythonStored } from "../renderedOutputs";
import type { PythonContext, PythonResult } from "../types";
import CopyCode from "./CopyCode";
import { DocumentAppearance } from "../documentAppearance";
import SvgDiagram from "./SvgDiagram";

function PythonFigure({ image, index }: { image: string; index: number }) {
  const theme = useContext(DocumentAppearance);
  const svg = useMemo(() => {
    if (!image.startsWith("data:image/svg+xml;base64,")) return null;
    try {
      return new TextDecoder().decode(Uint8Array.from(atob(image.slice(image.indexOf(",") + 1)), c => c.charCodeAt(0)));
    } catch {
      return null;
    }
  }, [image]);
  return svg
    ? <SvgDiagram source={svg} dark={theme?.dark} appearance={theme?.svgAppearance} colors={theme?.colors} preserveOriginal label={`Python figure ${index + 1}`} />
    : <img draggable={false} data-media-kind="image" src={image} alt={`Python figure ${index + 1}`} />;
}

// Figures come from local processes or caches: accept only bounded SVG/PNG/JPEG data.
const safeFigure = (image: unknown): image is string =>
  typeof image === "string" && image.length <= 12_000_000 && /^data:image\/(?:svg\+xml|png|jpeg);base64,[A-Za-z0-9+/]+=*$/.test(image.slice(0, 64) + (image.length > 64 ? image.slice(-8) : ""));

const isDesktopQtHost = (): boolean =>
  typeof document !== "undefined" && document.documentElement.dataset.host === "qt";

const nextCellJobId = (): string =>
  globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

interface RetainedVerifiedOutput {
  result: PythonResult;
  source: string;
  context?: PythonContext;
  identity: string;
  stored: boolean;
}

interface ScopedActiveRun {
  key: string;
  jobId: string | null;
  stopping: boolean;
  retained: RetainedVerifiedOutput | null;
  completed?: {
    result: PythonResult;
    source: string;
    context?: PythonContext;
    identity: string;
    freshExecution: boolean;
  };
  cancelled?: boolean;
  listeners: Set<() => void>;
}

// Tracks only actively executing scoped runs keyed by full pythonContextKey
// ([source, document, cell-ordinal, interpreter]) so distinct cells in the same
// note never collide while tab or mode switches preserve progress, Stop, and
// the cell's last verified output.
const activeScopedRuns = new Map<string, ScopedActiveRun>();

export default function PythonCell({ source, python, highlighted, context, sourceStart, sourceEnd }: { source: string; python: string; highlighted?: ReactNode; context?: PythonContext; sourceStart?: number; sourceEnd?: number }) {
  const desktopQt = isDesktopQtHost();
  const trackScopedRuns = desktopQt && Boolean(context);
  const identity = context ? pythonContextKey(source, context) : JSON.stringify([source]);
  const docScope = context ? JSON.stringify([context.document, context.cell, context.interpreter]) : "legacy";
  const inFlightOnMount = trackScopedRuns ? activeScopedRuns.get(identity) ?? null : null;
  const cachedOnMount = cachedPythonOutput(source, context) || null;
  const initial = cachedOnMount ?? inFlightOnMount?.retained?.result ?? null;
  const initialSource = cachedOnMount ? source : (inFlightOnMount?.retained?.source ?? "");
  const initialIdentity = cachedOnMount ? identity : (inFlightOnMount?.retained?.identity ?? "");
  const initialStored = cachedOnMount ? pythonStored(source, context) : Boolean(inFlightOnMount?.retained?.stored);

  const [result, setResult] = useState<PythonResult | null>(() => initial);
  const [running, setRunning] = useState(() => Boolean(inFlightOnMount));
  const [stopping, setStopping] = useState(() => Boolean(inFlightOnMount?.stopping));
  const [stored, setStored] = useState(() => initialStored);

  const executedSource = useRef(initialSource);
  const executedContext = useRef(context);
  const executedIdentity = useRef(initialIdentity);
  const lastVerifiedRef = useRef<RetainedVerifiedOutput | null>(
    cachedOnMount && cachedOnMount.provenance?.verified
      ? { result: cachedOnMount, source, context, identity, stored: pythonStored(source, context) }
      : (inFlightOnMount?.retained ?? null),
  );
  const activeRunRef = useRef<ScopedActiveRun | null>(inFlightOnMount);
  const localJobIdRef = useRef<string | null>(null);
  const localRunningRef = useRef(false);
  const runId = useRef(0);
  const pendingStore = useRef<{ source: string; context?: PythonContext; freshExecution: boolean } | null>(null);
  const cell = useRef<HTMLDivElement>(null);

  useEffect(() => (result ? retainVisiblePython(executedSource.current, result, executedContext.current) : undefined), [result]);

  useEffect(() => {
    if (!trackScopedRuns) return;
    const current = activeRunRef.current ?? activeScopedRuns.get(identity) ?? null;
    if (!current) return;
    activeRunRef.current = current;
    if (activeScopedRuns.get(current.key) === current) {
      setRunning(true);
      setStopping(current.stopping);
      if (current.retained && !lastVerifiedRef.current) {
        lastVerifiedRef.current = current.retained;
      }
    }
    const listener = () => {
      if (activeScopedRuns.get(current.key) === current) {
        setRunning(true);
        setStopping(current.stopping);
        return;
      }
      if (activeRunRef.current === current) {
        activeRunRef.current = null;
      }
      if (current.completed) {
        const done = current.completed;
        executedSource.current = done.source;
        executedContext.current = done.context;
        executedIdentity.current = done.identity;
        pendingStore.current = { source: done.source, context: done.context, freshExecution: done.freshExecution };
        if (done.result.provenance?.verified) {
          lastVerifiedRef.current = {
            result: done.result,
            source: done.source,
            context: done.context,
            identity: done.identity,
            stored: !done.freshExecution,
          };
        }
        setStored(false);
        setResult(done.result);
      } else if (current.cancelled && lastVerifiedRef.current) {
        const verified = lastVerifiedRef.current;
        executedSource.current = verified.source;
        executedContext.current = verified.context;
        executedIdentity.current = verified.identity;
        setStored(verified.stored);
        setResult(verified.result);
      }
      setRunning(false);
      setStopping(false);
    };
    current.listeners.add(listener);
    return () => {
      current.listeners.delete(listener);
    };
  }, [trackScopedRuns, identity]);

  useEffect(() => {
    let active = true;
    const prevDocScope = executedContext.current ? JSON.stringify([executedContext.current.document, executedContext.current.cell, executedContext.current.interpreter]) : "legacy";
    const docChanged = prevDocScope !== docScope;
    if (!desktopQt) {
      const initialRun = ++runId.current;
      localRunningRef.current = false;
      localJobIdRef.current = null;
      setRunning(false);
      setStopping(false);
      if (docChanged) {
        executedSource.current = "";
        executedIdentity.current = "";
        executedContext.current = context;
        lastVerifiedRef.current = null;
        setResult(null);
        setStored(false);
      }
      void loadPythonOutput(source, context).then(output => {
        if (active && output && runId.current === initialRun) {
          executedSource.current = source;
          executedContext.current = context;
          executedIdentity.current = identity;
          const isStored = pythonStored(source, context);
          if (output.provenance?.verified) {
            lastVerifiedRef.current = { result: output, source, context, identity, stored: isStored };
          }
          setResult(output);
          setStored(isStored);
        }
      });
      return () => { active = false; };
    }
    const scopedActive = trackScopedRuns ? activeScopedRuns.get(identity) ?? null : null;
    if (docChanged) {
      ++runId.current;
      activeRunRef.current = scopedActive;
      localRunningRef.current = false;
      localJobIdRef.current = null;
      executedSource.current = scopedActive?.retained?.source ?? "";
      executedIdentity.current = scopedActive?.retained?.identity ?? "";
      executedContext.current = context;
      lastVerifiedRef.current = scopedActive?.retained ?? null;
      setRunning(Boolean(scopedActive));
      setStopping(Boolean(scopedActive?.stopping));
      setResult(scopedActive?.retained?.result ?? null);
      setStored(Boolean(scopedActive?.retained?.stored));
    } else if (activeRunRef.current && activeScopedRuns.get(activeRunRef.current.key) === activeRunRef.current) {
      return () => { active = false; };
    } else if (scopedActive) {
      activeRunRef.current = scopedActive;
      setRunning(true);
      setStopping(scopedActive.stopping);
      return () => { active = false; };
    } else if (!localRunningRef.current) {
      activeRunRef.current = null;
      setRunning(false);
      setStopping(false);
    }
    if (scopedActive || localRunningRef.current) {
      return () => { active = false; };
    }
    const initialRun = ++runId.current;
    void loadPythonOutput(source, context).then(output => {
      if (active && output && runId.current === initialRun) {
        executedSource.current = source;
        executedContext.current = context;
        executedIdentity.current = identity;
        const isStored = pythonStored(source, context);
        if (output.provenance?.verified) {
          lastVerifiedRef.current = { result: output, source, context, identity, stored: isStored };
        }
        setResult(output);
        setStored(isStored);
      }
    });
    return () => { active = false; };
  }, [desktopQt, trackScopedRuns, source, identity, docScope]);

  useEffect(() => {
    const pending = pendingStore.current;
    if (!result || !pending) return;
    pendingStore.current = null;
    let active = true;
    void storePythonOutput(pending.source, result, pending.context, pending.freshExecution).then(saved => {
      if (!active) return;
      setStored(saved);
      if (lastVerifiedRef.current && lastVerifiedRef.current.source === pending.source) {
        lastVerifiedRef.current = { ...lastVerifiedRef.current, stored: saved };
      }
      if (saved && pending.freshExecution && pending.context && result.provenance?.unsaved === true) {
        const persisted: PythonResult = { ...result, provenance: { verified: true, document: pending.context.document, cell: pending.context.cell, interpreter: pending.context.interpreter } };
        rememberPythonOutput(pending.source, persisted, pending.context);
        const persistedIdentity = pythonContextKey(pending.source, pending.context);
        lastVerifiedRef.current = { result: persisted, source: pending.source, context: pending.context, identity: persistedIdentity, stored: true };
        setResult(persisted);
      }
    });
    return () => { active = false; };
  }, [result]);

  useEffect(() => {
    if (stored && !running) cell.current?.dispatchEvent(new Event("supermd-output-stored", { bubbles: true }));
  }, [stored, running]);

  const canStop = desktopQt;

  const restoreLastVerifiedIfNeeded = () => {
    const verified = lastVerifiedRef.current;
    if (!verified) return;
    rememberPythonOutput(verified.source, verified.result, verified.context);
    executedSource.current = verified.source;
    executedContext.current = verified.context;
    executedIdentity.current = verified.identity;
    pendingStore.current = null;
    setStored(verified.stored);
    setResult(verified.result);
  };

  const run = async () => {
    if (running) return;
    const currentRun = ++runId.current;
    const currentSource = source;
    const currentIdentity = identity;
    const currentContext = context;
    const desktopStop = isDesktopQtHost();
    const jobId = desktopStop ? nextCellJobId() : null;

    setRunning(true);
    setStopping(false);

    if (currentContext) {
      const entry: ScopedActiveRun | null = desktopStop
        ? {
            key: currentIdentity,
            jobId,
            stopping: false,
            retained: lastVerifiedRef.current,
            listeners: new Set(),
          }
        : null;
      if (entry) {
        activeScopedRuns.set(currentIdentity, entry);
        activeRunRef.current = entry;
      } else {
        localRunningRef.current = true;
      }
      try {
        const output = await invoke<PythonResult>("run_python", {
          python,
          code: currentSource,
          ...(jobId ? { jobId } : {}),
          context: currentContext,
        });
        const nativeVerified = !!(output.provenance?.verified && output.provenance.document === currentContext.document && output.provenance.cell === currentContext.cell && typeof output.provenance.interpreter === "string");
        const scopedOutput: PythonResult = {
          ...output,
          provenance: nativeVerified ? output.provenance : (output.provenance ?? { verified: true, document: currentContext.document, cell: currentContext.cell, interpreter: currentContext.interpreter }),
        };
        const freshExecution = !nativeVerified;
        rememberPythonOutput(currentSource, scopedOutput, currentContext);
        if (entry) {
          entry.completed = { result: scopedOutput, source: currentSource, context: currentContext, identity: currentIdentity, freshExecution };
        }
        if (currentRun === runId.current) {
          executedSource.current = currentSource;
          executedContext.current = currentContext;
          executedIdentity.current = currentIdentity;
          pendingStore.current = { source: currentSource, context: currentContext, freshExecution };
          if (scopedOutput.provenance?.verified) {
            lastVerifiedRef.current = { result: scopedOutput, source: currentSource, context: currentContext, identity: currentIdentity, stored: !freshExecution };
          }
          setStored(false);
          setResult(scopedOutput);
        }
      } catch (error) {
        if (error instanceof Error && error.message === "Python cell cancelled") {
          if (entry) entry.cancelled = true;
          if (currentRun === runId.current && desktopStop) restoreLastVerifiedIfNeeded();
          return;
        }
        const failure: PythonResult = {
          stdout: "",
          stderr: String(error),
          images: [],
          ok: false,
          provenance: { verified: false, reason: "Execution failed before output was recorded" },
        };
        rememberPythonOutput(currentSource, failure, currentContext);
        if (entry) {
          entry.completed = { result: failure, source: currentSource, context: currentContext, identity: currentIdentity, freshExecution: false };
        }
        if (currentRun === runId.current) {
          executedSource.current = currentSource;
          executedContext.current = currentContext;
          executedIdentity.current = currentIdentity;
          pendingStore.current = null;
          setStored(false);
          setResult(failure);
        }
      } finally {
        if (entry) {
          if (activeScopedRuns.get(currentIdentity) === entry) {
            activeScopedRuns.delete(currentIdentity);
          }
          if (activeRunRef.current === entry) {
            activeRunRef.current = null;
          }
        } else {
          localRunningRef.current = false;
        }
        if (currentRun === runId.current) {
          setRunning(false);
          setStopping(false);
        }
        if (entry) {
          for (const listener of [...entry.listeners]) listener();
        }
      }
      return;
    }

    localRunningRef.current = true;
    localJobIdRef.current = jobId;
    try {
      const output = await invoke<PythonResult>("run_python", {
        python,
        code: currentSource,
        ...(jobId ? { jobId } : {}),
      });
      const scopedOutput: PythonResult = { ...output, provenance: { verified: false, reason: "Unscoped live output" } };
      rememberPythonOutput(currentSource, scopedOutput, undefined);
      if (currentRun === runId.current) {
        executedSource.current = currentSource;
        executedContext.current = undefined;
        executedIdentity.current = currentIdentity;
        pendingStore.current = { source: currentSource, context: undefined, freshExecution: false };
        setStored(false);
        setResult(scopedOutput);
      }
    } catch (error) {
      if (error instanceof Error && error.message === "Python cell cancelled") {
        if (currentRun === runId.current && desktopStop) restoreLastVerifiedIfNeeded();
        return;
      }
      const failure: PythonResult = {
        stdout: "",
        stderr: String(error),
        images: [],
        ok: false,
        provenance: { verified: false, reason: "Execution failed before output was recorded" },
      };
      rememberPythonOutput(currentSource, failure, undefined);
      if (currentRun === runId.current) {
        executedSource.current = currentSource;
        executedContext.current = undefined;
        executedIdentity.current = currentIdentity;
        pendingStore.current = null;
        setStored(false);
        setResult(failure);
      }
    } finally {
      localRunningRef.current = false;
      localJobIdRef.current = null;
      if (currentRun === runId.current) {
        setRunning(false);
        setStopping(false);
      }
    }
  };

  const stop = async () => {
    const activeScoped = activeRunRef.current ?? (trackScopedRuns ? activeScopedRuns.get(identity) ?? null : null);
    const jobId = activeScoped ? activeScoped.jobId : localJobIdRef.current;
    if (!running || stopping || !jobId) return;
    setStopping(true);
    if (activeScoped) {
      activeScoped.stopping = true;
      for (const listener of [...activeScoped.listeners]) listener();
    }
    try {
      await invoke<{ stopped: boolean }>("stop_python", { jobId });
    } catch {
      if (activeScoped && activeScopedRuns.get(activeScoped.key) === activeScoped) {
        activeScoped.stopping = false;
        for (const listener of [...activeScoped.listeners]) listener();
      }
      setStopping(false);
    }
  };

  const stale = Boolean(result && (executedSource.current !== source || executedIdentity.current !== identity));
  return (
    <div ref={cell} className="python-cell" aria-busy={running || undefined} data-output-pinned={!!result && !stored || running} data-source-start={sourceStart} data-source-end={sourceEnd}>
      <div className="cell-toolbar">
        <span>
          Python{" "}
          {stale && <small className="stale-badge">Output from earlier code</small>}{" "}
          {result?.provenance?.unsaved && <small className="stale-badge">Output not saved</small>}{" "}
          {result?.provenance && !result.provenance.verified && !result.provenance.unsaved && result.provenance.reason?.includes("Legacy") && <small className="stale-badge">Unverified saved output</small>}
        </span>
        <CopyCode source={source} />
        {running && canStop && (
          <button type="button" className="python-stop" onClick={stop} disabled={stopping}>
            {stopping ? "Stopping…" : "Stop"}
          </button>
        )}
        <button type="button" className="python-run" onClick={run} disabled={running}>
          {running ? "Running…" : stale ? "Run updated code" : "Run"}
        </button>
      </div>
      <pre className="python-source" aria-label="Python source"><code className="language-python">{highlighted ?? source}</code></pre>
      {result && <div className={`cell-output ${result.ok ? "" : "failed"} ${stale ? "stale" : ""}`}>
        {result.stdout && <pre>{result.stdout}</pre>}
        {result.stderr && <pre>{result.stderr}</pre>}
        {result.images.filter(safeFigure).slice(0, 16).map((image, index) => <PythonFigure key={index} image={image} index={index} />)}
      </div>}
    </div>
  );
}
