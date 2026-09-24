import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { AnimatePresence, motion, MotionConfig, useReducedMotion } from "motion/react";
import { ArrowsOut, BookOpen, ChartLine, Code, Columns, Crosshair, FilePdf, FloppyDisk, FolderOpen, Function as FunctionIcon, GearSix, MagnifyingGlass, Minus, Note, PencilSimple, Plus, TextB, TextHTwo, TextItalic, X } from "@phosphor-icons/react";
import Editor from "./components/Editor";
import MarkdownPreview from "./components/MarkdownPreview";
import WelcomeSetup from "./components/WelcomeSetup";
import type { DocumentData, ExportOptions, ThemeMode, ViewMode } from "./types";
import { clampPreviewZoom, zoomShortcut } from "./zoom";

const welcome = `# Super MD

Write on the left. Study on the right. Press **F11** for a truly distraction-free canvas.

> [!NOTE] Portable by design
> This is ordinary Markdown with optional Super MD blocks—no vault, database, or hidden metadata.

## Math that stays on the page

Inline math such as $e^{i\\pi}+1=0$ and display math:

$$
\\int_{-\\infty}^{\\infty} e^{-x^2} \\, dx = \\sqrt{\\pi}
$$

| Feature | Super MD |
|:--|:--|
| PDF layout | Pandoc + Typst |
| Interactive plots | Native slider blocks |
| Python | Your chosen venv |

:::callout warning "No silent code execution"
Python cells run only when you press **Run**. The code runs locally with your selected interpreter.
:::

## Interactive graph

\`\`\`smd-chart
{
  "title": "A sine wave you can manipulate",
  "x": { "min": -6.28, "max": 6.28, "label": "x" },
  "series": [{ "name": "a · sin(bx)", "expression": "a * Math.sin(b * x)" }],
  "sliders": [
    { "name": "a", "label": "Amplitude", "min": 0.25, "max": 3, "step": 0.25, "value": 1 },
    { "name": "b", "label": "Frequency", "min": 0.25, "max": 4, "step": 0.25, "value": 1 }
  ]
}
\`\`\`

## Matplotlib

\`\`\`python
import numpy as np
import matplotlib.pyplot as plt

x = np.linspace(-4, 4, 300)
plt.plot(x, np.exp(-x**2), color="#6750a4")
plt.title("Gaussian")
plt.grid(alpha=.2)
\`\`\`
`;

const defaultExport: ExportOptions = { pageSize: "a4", margin: 18, fontSize: 10.5, lineHeight: 1.35, fontFamily: "New Computer Modern" };
const readerFonts = [
  { value: "sans", label: "Noto Sans · clean" },
  { value: "humanist", label: "Manrope · expressive" },
  { value: "serif", label: "System serif · book" },
];
const pdfFonts = ["New Computer Modern", "Libertinus Serif", "Noto Sans", "DejaVu Serif", "Arial", "Georgia", "Times New Roman"];
const spring = {
  selector: { type: "spring" as const, stiffness: 580, damping: 29, mass: 0.75 },
  sheet: { type: "spring" as const, stiffness: 340, damping: 28, mass: 0.9 },
  surface: { type: "spring" as const, stiffness: 390, damping: 31, mass: 0.85 },
};

function storedTheme(key: string, fallback: ThemeMode): ThemeMode {
  return (localStorage.getItem(key) as ThemeMode) || fallback;
}

function storedNumber(key: string, fallback: number): number {
  const value = Number(localStorage.getItem(key));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function storedImageHosts(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem("images.trustedHosts") || "[]");
    return Array.isArray(value) ? value.filter((host): host is string => typeof host === "string") : [];
  } catch { return []; }
}

function firstRunSetup(): boolean {
  if (localStorage.getItem("setup.complete") === "true") return false;
  if (localStorage.getItem("setup.started") === "true") return true;
  if (localStorage.getItem("theme.normal") !== null) {
    localStorage.setItem("setup.complete", "true");
    return false;
  }
  localStorage.setItem("setup.started", "true");
  return true;
}

export default function App() {
  const [content, setContent] = useState(welcome);
  const [path, setPath] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [view, setView] = useState<ViewMode>("split");
  const [focusMode, setFocusMode] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [normalTheme, setNormalTheme] = useState<ThemeMode>(() => storedTheme("theme.normal", "caelestia"));
  const [fullscreenTheme, setFullscreenTheme] = useState<ThemeMode>(() => storedTheme("theme.fullscreen", "black"));
  const [caelestia, setCaelestia] = useState<any>(null);
  const [python, setPython] = useState(() => localStorage.getItem("python") || "");
  const [showSettings, setShowSettings] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [exportOptions, setExportOptions] = useState(defaultExport);
  const [notice, setNotice] = useState("");
  const [editorSize, setEditorSize] = useState(() => storedNumber("editor.size", 14));
  const [editorLeading, setEditorLeading] = useState(() => storedNumber("editor.leading", 1.7));
  const [readerSize, setReaderSize] = useState(() => storedNumber("reader.size", 17));
  const [readerWidth, setReaderWidth] = useState(() => storedNumber("reader.width", 880));
  const [readerFont, setReaderFont] = useState(() => localStorage.getItem("reader.font") || "sans");
  const [previewZoom, setPreviewZoom] = useState(() => clampPreviewZoom(storedNumber("preview.zoom", 100)));
  const [previewViewportWidth, setPreviewViewportWidth] = useState(900);
  const [splitPercent, setSplitPercent] = useState(() => Math.max(25, Math.min(75, storedNumber("workspace.split", 50))));
  const [resizing, setResizing] = useState(false);
  const workspaceRef = useRef<HTMLElement>(null);
  const readingScrollRef = useRef<HTMLDivElement>(null);
  const gestureStartZoom = useRef(previewZoom);
  const gestureInPreview = useRef(false);
  const [autosave, setAutosave] = useState(() => localStorage.getItem("autosave") === "true");
  const [reduceMotion, setReduceMotion] = useState(() => localStorage.getItem("reduceMotion") === "true");
  const [trustedImageHosts, setTrustedImageHosts] = useState(storedImageHosts);
  const [showWelcome, setShowWelcome] = useState(firstRunSetup);
  const systemReduceMotion = useReducedMotion();
  const motionEnabled = !reduceMotion && !systemReduceMotion;
  const activeTheme = fullscreen ? fullscreenTheme : normalTheme;
  const dark = activeTheme === "dark" || activeTheme === "black" || (activeTheme === "caelestia" && caelestia?.mode !== "light");
  const zoomBy = useCallback((step: number) => setPreviewZoom((current) => clampPreviewZoom(current + step)), []);

  useEffect(() => { localStorage.setItem("preview.zoom", String(previewZoom)); }, [previewZoom]);
  useEffect(() => { localStorage.setItem("workspace.split", String(splitPercent)); }, [splitPercent]);
  useEffect(() => { localStorage.setItem("images.trustedHosts", JSON.stringify(trustedImageHosts)); }, [trustedImageHosts]);
  useEffect(() => {
    const node = readingScrollRef.current;
    if (!node) return;
    const measure = () => setPreviewViewportWidth(node.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [view]);

  useEffect(() => {
    const inPreview = (target: EventTarget | null) => target instanceof Element && !!target.closest(".reading-scroll");
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      if (inPreview(event.target)) setPreviewZoom((current) => clampPreviewZoom(current * Math.exp(-event.deltaY * .0016)));
    };
    const onGestureStart = (event: Event) => {
      event.preventDefault();
      gestureInPreview.current = inPreview(event.target);
      gestureStartZoom.current = previewZoom;
    };
    const onGestureChange = (event: Event) => {
      event.preventDefault();
      if (gestureInPreview.current) setPreviewZoom(clampPreviewZoom(gestureStartZoom.current * (event as Event & { scale: number }).scale));
    };
    const onGestureEnd = (event: Event) => { event.preventDefault(); gestureInPreview.current = false; };
    document.addEventListener("wheel", onWheel, { passive: false, capture: true });
    document.addEventListener("gesturestart", onGestureStart, { passive: false });
    document.addEventListener("gesturechange", onGestureChange, { passive: false });
    document.addEventListener("gestureend", onGestureEnd, { passive: false });
    return () => {
      document.removeEventListener("wheel", onWheel, true);
      document.removeEventListener("gesturestart", onGestureStart);
      document.removeEventListener("gesturechange", onGestureChange);
      document.removeEventListener("gestureend", onGestureEnd);
    };
  }, [previewZoom]);

  const onResizePointerDown = (event: React.PointerEvent<HTMLDivElement>) => { event.currentTarget.setPointerCapture(event.pointerId); setResizing(true); };
  const onResizePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!resizing || !workspaceRef.current) return;
    const bounds = workspaceRef.current.getBoundingClientRect();
    setSplitPercent(Math.max(25, Math.min(75, Math.round(((event.clientX - bounds.left) / bounds.width) * 100))));
  };
  const onResizePointerUp = (event: React.PointerEvent<HTMLDivElement>) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); setResizing(false); };

  const flash = (message: string) => { setNotice(message); window.setTimeout(() => setNotice(""), 2800); };
  const applyDocument = (doc: DocumentData) => { setContent(doc.content); setPath(doc.path); setDirty(false); invoke("clear_draft").catch(() => undefined); };
  const newDocument = useCallback(() => {
    if (dirty && !window.confirm("Discard unsaved changes and create a new document?")) return;
    setContent("");
    setPath(null);
    setDirty(false);
    invoke("clear_draft").catch(() => undefined);
  }, [dirty]);
  const open = useCallback(async () => {
    if (dirty && !window.confirm("Discard unsaved changes and open another document?")) return;
    try {
      const doc = await invoke<DocumentData | null>("open_document");
      if (doc) applyDocument(doc);
    } catch (error) { flash(`Could not open: ${error}`); }
  }, [dirty]);
  const save = useCallback(async (saveAs = false) => {
    try {
      const saved = await invoke<string | null>("save_document", { request: { path: saveAs ? null : path, content } });
      if (saved) { setPath(saved); setDirty(false); invoke("clear_draft").catch(() => undefined); flash("Saved"); }
    } catch (error) { flash(`Could not save: ${error}`); }
  }, [content, path]);
  const toggleFullscreen = useCallback(async () => {
    const window = getCurrentWindow();
    const next = !(await window.isFullscreen());
    await window.setFullscreen(next);
    setFullscreen(next);
  }, []);

  useEffect(() => {
    invoke<any>("load_caelestia_theme").then(setCaelestia).catch(() => undefined);
    invoke<DocumentData | null>("startup_document").then(async (doc) => {
      if (doc) applyDocument(doc);
      else {
        const draft = await invoke<string | null>("load_draft");
        if (draft) { setContent(draft); setPath(null); setDirty(true); }
      }
    }).catch(() => undefined);
    invoke<string | null>("detect_python").then((detected) => {
      setPython((current) => {
        if (current || !detected) return current;
        localStorage.setItem("python", detected);
        return detected;
      });
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "F11") { event.preventDefault(); toggleFullscreen(); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); save(event.shiftKey); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "o") { event.preventDefault(); open(); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "n") { event.preventDefault(); newDocument(); }
      const zoom = zoomShortcut(event);
      if (zoom) { event.preventDefault(); if (zoom === "reset") setPreviewZoom(100); else zoomBy(zoom === "in" ? 10 : -10); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [newDocument, open, save, toggleFullscreen, zoomBy]);

  useEffect(() => {
    localStorage.setItem("theme.normal", normalTheme);
    localStorage.setItem("theme.fullscreen", fullscreenTheme);
  }, [normalTheme, fullscreenTheme]);

  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--editor-size", `${editorSize}px`);
    root.style.setProperty("--editor-leading", String(editorLeading));
    root.style.setProperty("--reader-size", `${readerSize}px`);
    root.style.setProperty("--reader-width", `${readerWidth}px`);
    root.style.setProperty("--reader-font", readerFont === "serif" ? "Georgia, 'Noto Serif', serif" : readerFont === "humanist" ? "'Manrope Variable', 'Noto Sans', sans-serif" : "'Noto Sans', Arial, sans-serif");
    root.dataset.reduceMotion = String(!motionEnabled);
    localStorage.setItem("editor.size", String(editorSize));
    localStorage.setItem("editor.leading", String(editorLeading));
    localStorage.setItem("reader.size", String(readerSize));
    localStorage.setItem("reader.width", String(readerWidth));
    localStorage.setItem("reader.font", readerFont);
    localStorage.setItem("autosave", String(autosave));
    localStorage.setItem("reduceMotion", String(reduceMotion));
  }, [autosave, editorLeading, editorSize, motionEnabled, readerFont, readerSize, readerWidth, reduceMotion]);

  useEffect(() => {
    if (!autosave || !dirty || !path) return;
    const timer = window.setTimeout(() => save(false), 1200);
    return () => window.clearTimeout(timer);
  }, [autosave, content, dirty, path, save]);

  useEffect(() => {
    if (!dirty || path) return;
    const timer = window.setTimeout(() => invoke("save_draft", { content }).catch(() => undefined), 800);
    return () => window.clearTimeout(timer);
  }, [content, dirty, path]);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = activeTheme;
    root.dataset.fullscreen = String(fullscreen);
    if (activeTheme === "caelestia" && caelestia?.colours) {
      const color = (name: string, fallback: string) => `#${caelestia.colours[name] ?? fallback}`;
      root.style.setProperty("--primary", color("primary", "6750a4"));
      root.style.setProperty("--on-primary", color("onPrimary", "ffffff"));
      root.style.setProperty("--surface", color("surface", "141218"));
      root.style.setProperty("--surface-low", color("surfaceContainerLow", "1d1b20"));
      root.style.setProperty("--surface-high", color("surfaceContainerHigh", "2b2930"));
      root.style.setProperty("--text", color("onSurface", "e6e1e5"));
      root.style.setProperty("--muted", color("onSurfaceVariant", "cac4d0"));
      root.style.setProperty("--outline", color("outlineVariant", "49454f"));
    } else ["--primary", "--on-primary", "--surface", "--surface-low", "--surface-high", "--text", "--muted", "--outline"].forEach((name) => root.style.removeProperty(name));
  }, [activeTheme, caelestia, fullscreen]);

  const title = useMemo(() => path?.split(/[\\/]/).pop() ?? "Untitled.smd", [path]);
  const location = useMemo(() => path ? path.split(/[\\/]/).slice(0, -1).join("/") : "New document", [path]);
  const lineCount = useMemo(() => content.split("\n").length, [content]);
  const wordCount = useMemo(() => content.trim() ? content.trim().split(/\s+/).length : 0, [content]);
  const choosePython = async () => {
    const selected = await invoke<string | null>("choose_python");
    if (selected) { setPython(selected); localStorage.setItem("python", selected); }
  };
  const exportPdf = async () => {
    try {
      const output = await invoke<string | null>("export_pdf", { path, content, options: exportOptions });
      if (output) { flash(`Exported ${output}`); setShowExport(false); }
    } catch (error) { flash(`Export failed: ${error}`); }
  };
  const format = (prefix: string, suffix?: string, block = false) =>
    window.dispatchEvent(new CustomEvent("supermd-format", { detail: { prefix, suffix, block } }));

  return (
    <MotionConfig reducedMotion={motionEnabled ? "never" : "always"}>
    <div className={`app view-${view} ${focusMode ? "focus-mode" : ""}`}>
      {!fullscreen && <header className="topbar">
        <div className="brand"><span className="brand-mark"><img src="/brand-mark.svg" alt="" /></span><span className="document-identity"><strong title={title}>{title}</strong><small title={location}>{location}</small></span><span className={`save-state ${dirty ? "is-dirty" : ""}`}>{dirty ? "Unsaved" : path ? "Saved" : "Draft"}</span></div>
        <nav className="file-actions" aria-label="File actions">
          <button className="toolbar-button icon-only" onClick={newDocument} title="New · Ctrl+N" aria-label="New document"><Plus size={19} /></button>
          <button className="toolbar-button" onClick={open} title="Open · Ctrl+O"><FolderOpen size={19} /><span>Open</span></button>
          <button className="toolbar-button" onClick={() => save(false)} title="Save · Ctrl+S"><FloppyDisk size={19} /><span>Save</span></button>
          <button className="toolbar-button icon-only" onClick={() => window.dispatchEvent(new Event("supermd-find"))} title="Find and replace · Ctrl+F" aria-label="Find and replace"><MagnifyingGlass size={19} /></button>
        </nav>
        <nav className="right-actions" aria-label="View and export">
          <div className="segmented" aria-label="View mode">
            {(["editor", "split", "reader"] as ViewMode[]).map((mode) => <button key={mode} className={view === mode ? "active" : ""} onClick={() => setView(mode)} title={`${mode[0].toUpperCase()}${mode.slice(1)} view`} aria-label={`${mode} view`} aria-pressed={view === mode}>{view === mode && <motion.i className="segment-indicator" layoutId="view-indicator" transition={motionEnabled ? spring.selector : { duration: 0 }} />}{mode === "editor" ? <PencilSimple size={17} /> : mode === "split" ? <Columns size={17} /> : <BookOpen size={17} />}<span>{mode}</span></button>)}
          </div>
          <button className={`toolbar-button icon-only ${focusMode ? "active" : ""}`} onClick={() => setFocusMode((value) => !value)} title="Focus mode" aria-label="Focus mode" aria-pressed={focusMode}><Crosshair size={19} /></button>
          <button className="toolbar-button icon-only" onClick={toggleFullscreen} title="Fullscreen · F11" aria-label="Fullscreen"><ArrowsOut size={19} /></button>
          <button className="toolbar-button icon-only" onClick={() => setShowSettings(true)} title="Settings" aria-label="Settings"><GearSix size={19} /></button>
          <button className="export-action" onClick={() => setShowExport(true)}><FilePdf size={19} weight="bold" /><span>Export PDF</span></button>
        </nav>
      </header>}
      {!fullscreen && view !== "reader" && <div className="formatbar" aria-label="Formatting tools">
        <span className="format-label">Insert</span>
        <button onClick={() => format("## ", "", true)} title="Heading 2" aria-label="Heading 2"><TextHTwo size={18} /></button>
        <button onClick={() => format("**") } title="Bold" aria-label="Bold"><TextB size={18} /></button>
        <button onClick={() => format("_") } title="Italic" aria-label="Italic"><TextItalic size={18} /></button>
        <span className="format-divider" />
        <button onClick={() => format("`") } title="Inline code" aria-label="Inline code"><Code size={18} /></button>
        <button onClick={() => format("$", "$") } title="Inline math" aria-label="Inline math"><FunctionIcon size={18} /></button>
        <span className="format-divider" />
        <button className="format-text-button" onClick={() => format("\n:::callout note \"Note\"\nWrite here.\n:::\n", "", true)} title="Insert callout"><Note size={18} /><span>Callout</span></button>
        <button className="format-text-button" onClick={() => format("\n```smd-chart\n{\n  \"title\": \"Interactive graph\",\n  \"x\": { \"min\": -6.28, \"max\": 6.28 },\n  \"series\": [{ \"expression\": \"a * Math.sin(x)\" }],\n  \"sliders\": [{ \"name\": \"a\", \"min\": 0, \"max\": 3, \"step\": 0.1, \"value\": 1 }]\n}\n```\n", "", true)} title="Insert interactive graph"><ChartLine size={18} /><span>Graph</span></button>
        <span className="format-hint">Alt+click adds a cursor</span>
      </div>}
      {fullscreen && <div className="fullscreen-hint">F11 to leave fullscreen</div>}
      <main className="workspace" ref={workspaceRef} data-resizing={resizing} style={{ "--split-left": `${splitPercent}fr`, "--split-right": `${100 - splitPercent}fr` } as React.CSSProperties}>
        {view !== "reader" && <motion.section layout="position" initial={false} transition={motionEnabled && !resizing ? spring.surface : { duration: 0 }} className="editor-pane" aria-label="Markdown source"><div className="pane-head"><span><PencilSimple size={15} /> Markdown</span><small>{lineCount} lines</small></div><Editor value={content} onChange={(value) => { setContent(value); setDirty(true); }} dark={dark} focusMode={focusMode} /></motion.section>}
        {view === "split" && <div className="pane-resizer" role="separator" aria-label="Resize editor and preview" aria-orientation="vertical" aria-valuemin={25} aria-valuemax={75} aria-valuenow={splitPercent} tabIndex={0} onPointerDown={onResizePointerDown} onPointerMove={onResizePointerMove} onPointerUp={onResizePointerUp} onLostPointerCapture={() => setResizing(false)} onDoubleClick={() => setSplitPercent(50)} onKeyDown={(event) => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); setSplitPercent((current) => Math.max(25, Math.min(75, current + (event.key === "ArrowRight" ? 5 : -5)))); } }}><span /></div>}
        {view !== "editor" && <motion.section layout="position" initial={false} transition={motionEnabled && !resizing ? spring.surface : { duration: 0 }} className="preview-pane" aria-label="Reading preview"><div className="pane-head"><span><BookOpen size={15} /> Preview</span><div className="preview-tools"><small>{wordCount} words</small><span className="zoom-controls" aria-label="Preview zoom"><button onClick={() => zoomBy(-10)} title="Zoom out · Ctrl+-" aria-label="Zoom out"><Minus size={14} /></button><button className="zoom-value" onClick={() => setPreviewZoom(100)} title="Reset zoom · Ctrl+0" aria-label={`Reset zoom, currently ${previewZoom}%`}>{previewZoom}%</button><button onClick={() => zoomBy(10)} title="Zoom in · Ctrl++" aria-label="Zoom in"><Plus size={14} /></button></span></div></div><div className="reading-scroll" ref={readingScrollRef}><div className="preview-page" style={{ width: Math.min(readerWidth, Math.max(220, previewViewportWidth - (previewViewportWidth < 760 ? 40 : 92))), zoom: previewZoom / 100 }}><MarkdownPreview markdown={content} documentPath={path} python={python} dark={dark} trustedImageHosts={trustedImageHosts} onTrustImageHost={(host) => setTrustedImageHosts((current) => current.includes(host) ? current : [...current, host])} /></div></div></motion.section>}
      </main>
      <AnimatePresence>{notice && <motion.div key="notice" className="snackbar" initial={motionEnabled ? { opacity: 0, y: 18, x: "-50%", scale: .94 } : false} animate={{ opacity: 1, y: 0, x: "-50%", scale: 1 }} exit={motionEnabled ? { opacity: 0, y: 12, x: "-50%", scale: .96 } : { opacity: 0 }} transition={motionEnabled ? spring.surface : { duration: 0 }}>{notice}</motion.div>}</AnimatePresence>
      <AnimatePresence>{showSettings && <motion.div key="settings" className="scrim" initial={motionEnabled ? { opacity: 0 } : false} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: motionEnabled ? .24 : 0 }} onMouseDown={() => setShowSettings(false)}><motion.aside className="sheet" initial={motionEnabled ? { opacity: 0, y: 40, scale: .9, borderRadius: 44 } : false} animate={{ opacity: 1, y: 0, scale: 1, borderRadius: 28 }} exit={motionEnabled ? { opacity: 0, y: 18, scale: .96 } : { opacity: 0 }} transition={motionEnabled ? spring.sheet : { duration: 0 }} onMouseDown={(event) => event.stopPropagation()}>
        <div className="sheet-title"><h2>Appearance & runtime</h2><button onClick={() => setShowSettings(false)} aria-label="Close settings"><X size={20} /></button></div>
        <label>Normal theme<select value={normalTheme} onChange={(event) => setNormalTheme(event.target.value as ThemeMode)}><option value="caelestia">Caelestia dynamic</option><option value="light">Material light</option><option value="dark">Material dark</option><option value="black">Pure black</option></select></label>
        <label>Fullscreen theme<select value={fullscreenTheme} onChange={(event) => setFullscreenTheme(event.target.value as ThemeMode)}><option value="caelestia">Caelestia dynamic</option><option value="light">Material light</option><option value="dark">Material dark</option><option value="black">Pure black</option></select></label>
        <label>Python interpreter<div className="path-field"><input value={python} onChange={(event) => { setPython(event.target.value); localStorage.setItem("python", event.target.value); }} /><button onClick={choosePython}>Choose</button></div></label>
        <h3>Typography</h3>
        <label>Reading font<select value={readerFont} onChange={(event) => setReaderFont(event.target.value)}>{readerFonts.map((font) => <option key={font.value} value={font.value}>{font.label}</option>)}</select></label>
        <div className="form-grid">
          <label>Editor size ({editorSize}px)<input type="range" min="11" max="22" step="1" value={editorSize} onChange={(event) => setEditorSize(Number(event.target.value))} /></label>
          <label>Editor spacing ({editorLeading.toFixed(2)})<input type="range" min="1.2" max="2.2" step="0.05" value={editorLeading} onChange={(event) => setEditorLeading(Number(event.target.value))} /></label>
          <label>Reading size ({readerSize}px)<input type="range" min="13" max="26" step="1" value={readerSize} onChange={(event) => setReaderSize(Number(event.target.value))} /></label>
          <label>Reading width ({readerWidth}px)<input type="range" min="560" max="1200" step="20" value={readerWidth} onChange={(event) => setReaderWidth(Number(event.target.value))} /></label>
        </div>
        <h3>Behaviour</h3>
        <label className="switch-row"><span><strong>Autosave</strong><small>Save 1.2 seconds after edits to an existing file</small></span><input type="checkbox" checked={autosave} onChange={(event) => setAutosave(event.target.checked)} /></label>
        <label className="switch-row"><span><strong>Expressive motion</strong><small>{systemReduceMotion ? "Disabled by your system reduced-motion preference" : "Spring transitions, shape-shifting controls, and fluid sheets"}</small></span><input type="checkbox" checked={motionEnabled} disabled={Boolean(systemReduceMotion)} onChange={(event) => setReduceMotion(!event.target.checked)} /></label>
        {trustedImageHosts.length > 0 && <div className="trusted-domains"><span>Trusted image domains: {trustedImageHosts.join(", ")}</span><button onClick={() => setTrustedImageHosts([])}>Clear</button></div>}
        <p className="help">Alt+click adds cursors. Ctrl+Alt+↑/↓ adds cursors by line. Ctrl+F opens search and replace.</p>
      </motion.aside></motion.div>}</AnimatePresence>
      <AnimatePresence>{showExport && <motion.div key="export" className="scrim" initial={motionEnabled ? { opacity: 0 } : false} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: motionEnabled ? .24 : 0 }} onMouseDown={() => setShowExport(false)}><motion.aside className="sheet export-sheet" initial={motionEnabled ? { opacity: 0, y: 40, scale: .9, borderRadius: 44 } : false} animate={{ opacity: 1, y: 0, scale: 1, borderRadius: 28 }} exit={motionEnabled ? { opacity: 0, y: 18, scale: .96 } : { opacity: 0 }} transition={motionEnabled ? spring.sheet : { duration: 0 }} onMouseDown={(event) => event.stopPropagation()}>
        <div className="sheet-title"><h2>Semantic PDF export</h2><button onClick={() => setShowExport(false)} aria-label="Close export settings"><X size={20} /></button></div>
        <p className="help">Pandoc parses the document; Typst performs real pagination and typesetting. The preview DOM is not printed.</p>
        <div className="form-grid">
          <label>Document font<select value={exportOptions.fontFamily} onChange={(event) => setExportOptions({ ...exportOptions, fontFamily: event.target.value })}>{pdfFonts.map((font) => <option key={font} value={font}>{font}</option>)}</select></label>
          <label>Page size<select value={exportOptions.pageSize} onChange={(event) => setExportOptions({ ...exportOptions, pageSize: event.target.value as ExportOptions["pageSize"] })}><option value="a4">A4</option><option value="a5">A5</option><option value="letter">US Letter</option><option value="legal">US Legal</option></select></label>
          <label>Margin (mm)<input type="number" min="4" max="60" value={exportOptions.margin} onChange={(event) => setExportOptions({ ...exportOptions, margin: Number(event.target.value) })} /></label>
          <label>Font size (pt)<input type="number" min="7" max="24" step="0.5" value={exportOptions.fontSize} onChange={(event) => setExportOptions({ ...exportOptions, fontSize: Number(event.target.value) })} /></label>
          <label>Line height<input type="number" min="0.9" max="2.2" step="0.05" value={exportOptions.lineHeight} onChange={(event) => setExportOptions({ ...exportOptions, lineHeight: Number(event.target.value) })} /></label>
        </div>
        <button className="primary-action" onClick={exportPdf}>Choose destination & export</button>
      </motion.aside></motion.div>}</AnimatePresence>
      {showWelcome && <WelcomeSetup theme={normalTheme} onTheme={setNormalTheme} readerFont={readerFont} onReaderFont={setReaderFont} motionEnabled={motionEnabled} onMotion={(enabled) => setReduceMotion(!enabled)} onFinish={(openFile) => { localStorage.setItem("setup.complete", "true"); localStorage.removeItem("setup.started"); setShowWelcome(false); if (openFile) window.setTimeout(() => open(), 100); }} />}
    </div>
    </MotionConfig>
  );
}
