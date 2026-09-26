import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as pickMobileDocument, save as chooseMobileDocument } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { AnimatePresence, motion, MotionConfig, useReducedMotion } from "motion/react";
import { ArrowsOut, BookOpen, Browsers, ChartLine, Code, Columns, Crosshair, FilePdf, FloppyDisk, FolderOpen, Function as FunctionIcon, GearSix, MagnifyingGlass, Minus, Note, PencilSimple, Plus, Sparkle, TextB, TextHTwo, TextItalic, X } from "@phosphor-icons/react";
import Editor from "./components/Editor";
import BrandMark from "./components/BrandMark";
import LiveEditor from "./components/LiveEditor";
import MarkdownPreview from "./components/MarkdownPreview";
import WelcomeSetup from "./components/WelcomeSetup";
import { addTab, closeTab, editTab, initialWorkspace, isDirty, markTabSaved, openTab, readWorkspace, restoreClosedTab, tabTitle, type DocumentWorkspace } from "./documentTabs";
import type { DocumentData, ExportOptions, ThemeMode, ViewMode } from "./types";
import { clampPreviewZoom, previewLayoutWidth, zoomShortcut } from "./zoom";

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

const android = /Android/i.test(navigator.userAgent);
const compactViewport = () => android || (typeof window.matchMedia === "function" && window.matchMedia("(max-width: 760px)").matches);
const pickerCancelled = (error: unknown) => /cancelled|canceled/i.test(String(error));

export default function App() {
  const windowLabel = useMemo(() => "__TAURI_INTERNALS__" in window ? getCurrentWindow().label : "browser", []);
  const sessionKey = `workspace.tabs.${windowLabel}`;
  const [documents, setDocuments] = useState<DocumentWorkspace>(() => readWorkspace(localStorage, sessionKey,
    new URLSearchParams(window.location.search).has("window") ? initialWorkspace() : initialWorkspace(welcome, "Welcome.smd")));
  const documentsRef = useRef(documents);
  documentsRef.current = documents;
  const activeTab = documents.tabs.find((tab) => tab.id === documents.activeId) ?? documents.tabs[0];
  const content = activeTab.content;
  const path = activeTab.path;
  const dirty = isDirty(activeTab);
  const [mobileUi, setMobileUi] = useState(compactViewport);
  const [view, setView] = useState<ViewMode>(() => compactViewport() ? "live" : "split");
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
  const [normalZoom, setNormalZoom] = useState(() => clampPreviewZoom(storedNumber("workspace.zoom.normal", 100)));
  const [fullscreenZoom, setFullscreenZoom] = useState(() => clampPreviewZoom(storedNumber("workspace.zoom.fullscreen", 100)));
  const [previewViewportWidth, setPreviewViewportWidth] = useState(900);
  const [splitPercent, setSplitPercent] = useState(() => Math.max(25, Math.min(75, storedNumber("workspace.split", 50))));
  const [resizing, setResizing] = useState(false);
  const [windowResizing, setWindowResizing] = useState(false);
  const [draggingFile, setDraggingFile] = useState(false);
  const workspaceRef = useRef<HTMLElement>(null);
  const savingRef = useRef(new Set<string>());
  const openingRef = useRef(false);
  const resizeFrame = useRef<number | null>(null);
  const pendingSplit = useRef(splitPercent);
  const readingScrollRef = useRef<HTMLDivElement>(null);
  const gestureStartZoom = useRef(100);
  const gestureInWorkspace = useRef(false);
  const pinchStartDistance = useRef(0);
  const zoomRef = useRef(100);
  const [autosave, setAutosave] = useState(() => localStorage.getItem("autosave") === "true");
  const [reduceMotion, setReduceMotion] = useState(() => localStorage.getItem("reduceMotion") === "true");
  const [trustedImageHosts, setTrustedImageHosts] = useState(storedImageHosts);
  const [draftWindows, setDraftWindows] = useState<string[]>([]);
  const [showWelcome, setShowWelcome] = useState(firstRunSetup);
  const systemReduceMotion = useReducedMotion();
  const motionEnabled = !reduceMotion && !systemReduceMotion;
  const activeTheme = fullscreen ? fullscreenTheme : normalTheme;
  const dark = activeTheme === "dark" || activeTheme === "black" || (activeTheme === "caelestia" && caelestia?.mode !== "light");
  const workspaceZoom = fullscreen ? fullscreenZoom : normalZoom;
  zoomRef.current = workspaceZoom;
  const setZoom = useCallback((updater: number | ((current: number) => number)) => {
    const apply = (current: number) => clampPreviewZoom(typeof updater === "number" ? updater : updater(current));
    if (fullscreen) setFullscreenZoom(apply);
    else setNormalZoom(apply);
  }, [fullscreen]);
  const zoomBy = useCallback((step: number) => setZoom((current) => current + step), [setZoom]);
  const trustImageHost = useCallback((host: string) => setTrustedImageHosts((current) => current.includes(host) ? current : [...current, host]), []);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(max-width: 760px)");
    const onChange = () => { setMobileUi(android || query.matches); if (android || query.matches) setView((current) => current === "split" ? "live" : current); };
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    if (android) document.documentElement.dataset.platform = "android";
    return () => { if (android) delete document.documentElement.dataset.platform; };
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => localStorage.setItem("workspace.zoom.normal", String(normalZoom)), 180);
    return () => window.clearTimeout(timer);
  }, [normalZoom]);
  useEffect(() => {
    const timer = window.setTimeout(() => localStorage.setItem("workspace.zoom.fullscreen", String(fullscreenZoom)), 180);
    return () => window.clearTimeout(timer);
  }, [fullscreenZoom]);
  useEffect(() => {
    const timer = window.setTimeout(() => localStorage.setItem("workspace.split", String(splitPercent)), 180);
    return () => window.clearTimeout(timer);
  }, [splitPercent]);
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
    const inWorkspace = (target: EventTarget | null, x?: number, y?: number) =>
      (target instanceof Element && !!target.closest(".workspace")) ||
      (typeof x === "number" && typeof y === "number" && !!document.elementFromPoint(x, y)?.closest(".workspace"));
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      if (inWorkspace(event.target, event.clientX, event.clientY)) setZoom((current) => current * Math.exp(-event.deltaY * .0016));
    };
    const onGestureStart = (event: Event) => {
      event.preventDefault();
      const gesture = event as Event & { clientX?: number; clientY?: number };
      gestureInWorkspace.current = inWorkspace(event.target, gesture.clientX, gesture.clientY);
      gestureStartZoom.current = zoomRef.current;
    };
    const onGestureChange = (event: Event) => {
      event.preventDefault();
      if (gestureInWorkspace.current) setZoom(gestureStartZoom.current * (event as Event & { scale: number }).scale);
    };
    const onGestureEnd = (event: Event) => { event.preventDefault(); gestureInWorkspace.current = false; };
    const distance = (touches: TouchList) => Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 2) return;
      gestureInWorkspace.current = inWorkspace(event.target, event.touches[0].clientX, event.touches[0].clientY);
      pinchStartDistance.current = distance(event.touches);
      gestureStartZoom.current = zoomRef.current;
    };
    const onTouchMove = (event: TouchEvent) => {
      if (event.touches.length !== 2 || !gestureInWorkspace.current) return;
      event.preventDefault();
      if (pinchStartDistance.current > 0) setZoom(gestureStartZoom.current * distance(event.touches) / pinchStartDistance.current);
    };
    const onTouchEnd = (event: TouchEvent) => { if (event.touches.length < 2) gestureInWorkspace.current = false; };
    document.addEventListener("wheel", onWheel, { passive: false, capture: true });
    document.addEventListener("gesturestart", onGestureStart, { passive: false, capture: true });
    document.addEventListener("gesturechange", onGestureChange, { passive: false, capture: true });
    document.addEventListener("gestureend", onGestureEnd, { passive: false, capture: true });
    document.addEventListener("touchstart", onTouchStart, { passive: true, capture: true });
    document.addEventListener("touchmove", onTouchMove, { passive: false, capture: true });
    document.addEventListener("touchend", onTouchEnd, { passive: true, capture: true });
    return () => {
      document.removeEventListener("wheel", onWheel, true);
      document.removeEventListener("gesturestart", onGestureStart, true);
      document.removeEventListener("gesturechange", onGestureChange, true);
      document.removeEventListener("gestureend", onGestureEnd, true);
      document.removeEventListener("touchstart", onTouchStart, true);
      document.removeEventListener("touchmove", onTouchMove, true);
      document.removeEventListener("touchend", onTouchEnd, true);
    };
  }, [setZoom]);

  const onResizePointerDown = (event: React.PointerEvent<HTMLDivElement>) => { event.currentTarget.setPointerCapture(event.pointerId); setResizing(true); };
  const onResizePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!resizing || !workspaceRef.current) return;
    const bounds = workspaceRef.current.getBoundingClientRect();
    pendingSplit.current = Math.max(25, Math.min(75, Math.round(((event.clientX - bounds.left) / bounds.width) * 100)));
    if (resizeFrame.current === null) resizeFrame.current = window.requestAnimationFrame(() => { setSplitPercent(pendingSplit.current); resizeFrame.current = null; });
  };
  const onResizePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (resizeFrame.current !== null) { window.cancelAnimationFrame(resizeFrame.current); resizeFrame.current = null; setSplitPercent(pendingSplit.current); }
    setResizing(false);
  };

  const flash = (message: string) => { setNotice(message); window.setTimeout(() => setNotice(""), 2800); };
  const applyDocument = useCallback((doc: DocumentData) => setDocuments((current) => openTab(current, doc)), []);
  const newDocument = useCallback(() => setDocuments((current) => addTab(current)), []);
  const open = useCallback(async () => {
    if (openingRef.current) return;
    openingRef.current = true;
    try {
      const doc = android ? await (async () => {
        const selected = await pickMobileDocument({ multiple: false, directory: false, filters: [{ name: "Markdown", extensions: ["md", "markdown", "smd"] }] });
        return typeof selected === "string" ? { path: selected, content: await readTextFile(selected) } : null;
      })() : await invoke<DocumentData | null>("open_document");
      if (doc) applyDocument(doc);
    } catch (error) { if (!pickerCancelled(error)) flash(`Could not open: ${error}`); }
    finally { openingRef.current = false; }
  }, [applyDocument]);
  const save = useCallback(async (saveAs = false) => {
    const tab = documentsRef.current.tabs.find((item) => item.id === documentsRef.current.activeId);
    if (!tab || savingRef.current.has(tab.id)) return;
    savingRef.current.add(tab.id);
    try {
      const saved = android ? await (async () => {
        const target = saveAs || !tab.path ? await chooseMobileDocument({ defaultPath: tabTitle(tab), filters: [{ name: "Markdown", extensions: ["smd", "md"] }] }) : tab.path;
        if (!target) return null;
        await writeTextFile(target, tab.content);
        return target;
      })() : await invoke<string | null>("save_document", { request: { path: saveAs ? null : tab.path, content: tab.content } });
      if (saved) { setDocuments((current) => markTabSaved(current, tab.id, saved, tab.content)); flash("Saved"); }
    } catch (error) { if (!pickerCancelled(error)) flash(`Could not save: ${error}`); }
    finally { savingRef.current.delete(tab.id); }
  }, []);
  const toggleFullscreen = useCallback(async () => {
    const window = getCurrentWindow();
    const next = !(await window.isFullscreen());
    await window.setFullscreen(next);
    setFullscreen(next);
  }, []);

  const openNewWindow = useCallback((recoverLabel?: string) => {
    if (!("__TAURI_INTERNALS__" in window)) { flash("New windows are available in the desktop app"); return; }
    const label = recoverLabel ?? `document-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const child = new WebviewWindow(label, { url: `index.html?window=${recoverLabel ? "recover" : "new"}`, title: recoverLabel ? "Super MD — Recovered draft" : "Super MD — New window", width: 1180, height: 800, minWidth: 760, minHeight: 520, zoomHotkeysEnabled: false });
    child.once("tauri://error", (event) => flash(`Could not open window: ${event.payload}`));
  }, []);

  useEffect(() => {
    invoke<any>("load_caelestia_theme").then(setCaelestia).catch(() => undefined);
    const query = new URLSearchParams(window.location.search);
    const hadSession = localStorage.getItem(sessionKey) !== null;
    if (query.get("window") === "recover" || (!hadSession && query.get("window") !== "new")) {
      invoke<string | null>("load_draft").then((draft) => {
        if (draft) setDocuments((current) => {
          const next = addTab(current);
          return editTab(next, next.activeId, draft);
        });
      }).catch(() => undefined);
    }
    if (query.has("document")) invoke<DocumentData>("read_document_at", { path: query.get("document") }).then(applyDocument).catch(() => undefined);
    else if (!hadSession && !query.has("window")) invoke<DocumentData | null>("startup_document").then((doc) => { if (doc) applyDocument(doc); }).catch(() => undefined);
    invoke<string | null>("detect_python").then((detected) => {
      setPython((current) => {
        if (current || !detected) return current;
        localStorage.setItem("python", detected);
        return detected;
      });
    }).catch(() => undefined);
  }, [applyDocument, sessionKey]);

  useEffect(() => {
    try { localStorage.setItem(sessionKey, JSON.stringify(documents)); }
    catch { flash("Session recovery is full; save large notes to files"); }
  }, [documents, sessionKey]);

  useEffect(() => {
    if (showSettings) invoke<string[]>("list_draft_windows").then(setDraftWindows).catch(() => setDraftWindows([]));
  }, [showSettings]);

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    const nativeWindow = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    let resizeTimer = 0;
    nativeWindow.isFullscreen().then(setFullscreen).catch(() => undefined);
    nativeWindow.onResized(() => {
      setWindowResizing(true);
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => setWindowResizing(false), 160);
      nativeWindow.isFullscreen().then(setFullscreen).catch(() => undefined);
    }).then((stop) => { unlisten = stop; });
    return () => { unlisten?.(); window.clearTimeout(resizeTimer); };
  }, []);

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let unlisten: (() => void) | undefined;
    getCurrentWindow().onDragDropEvent(async ({ payload }) => {
      if (payload.type === "over") { setDraggingFile(true); return; }
      setDraggingFile(false);
      if (payload.type !== "drop") return;
      const candidate = payload.paths.find((name) => /\.(smd|md|markdown)$/i.test(name));
      if (!candidate) { flash("Drop a .smd or Markdown document"); return; }
      try { applyDocument(await invoke<DocumentData>("read_document_at", { path: candidate })); }
      catch (error) { flash(`Could not open dropped file: ${error}`); }
    }).then((stop) => { unlisten = stop; });
    return () => unlisten?.();
  }, [applyDocument]);

  useEffect(() => {
    const flush = () => {
      try { localStorage.setItem(sessionKey, JSON.stringify(documentsRef.current)); }
      catch { /* The regular persistence effect already displays the error. */ }
    };
    window.addEventListener("beforeunload", flush);
    return () => window.removeEventListener("beforeunload", flush);
  }, [sessionKey]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "F11") { event.preventDefault(); toggleFullscreen(); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); save(event.shiftKey); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "o") { event.preventDefault(); open(); }
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "n") { event.preventDefault(); openNewWindow(); }
      else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "n") { event.preventDefault(); newDocument(); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "w") { event.preventDefault(); setDocuments((current) => closeTab(current, current.activeId)); }
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "t") { event.preventDefault(); setDocuments(restoreClosedTab); }
      if ((event.ctrlKey || event.metaKey) && event.key === "Tab") {
        event.preventDefault();
        setDocuments((current) => {
          const index = current.tabs.findIndex((tab) => tab.id === current.activeId);
          const next = (index + (event.shiftKey ? current.tabs.length - 1 : 1)) % current.tabs.length;
          return { ...current, activeId: current.tabs[next].id };
        });
      }
      const zoom = zoomShortcut(event);
      if (zoom) { event.preventDefault(); if (zoom === "reset") setZoom(100); else zoomBy(zoom === "in" ? 10 : -10); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [newDocument, open, openNewWindow, save, setZoom, toggleFullscreen, zoomBy]);

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

  const title = tabTitle(activeTab);
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
        <div className="brand"><span className="brand-mark"><BrandMark /></span><span className="document-identity"><strong title={title}>{title}</strong><small title={location}>{location}</small></span><span className={`save-state ${dirty ? "is-dirty" : ""}`}>{dirty ? "Recoverable edit" : path ? "Saved" : "Draft"}</span></div>
        <nav className="file-actions" aria-label="File actions">
          <button className="toolbar-button icon-only" onClick={newDocument} title="New · Ctrl+N" aria-label="New document"><Plus size={19} /></button>
          <button className="toolbar-button icon-only" onClick={() => openNewWindow()} title="New window · Ctrl+Shift+N" aria-label="New window"><Browsers size={19} /></button>
          <button className="toolbar-button" onClick={open} title="Open · Ctrl+O"><FolderOpen size={19} /><span>Open</span></button>
          <button className="toolbar-button" onClick={() => save(false)} title="Save · Ctrl+S"><FloppyDisk size={19} /><span>Save</span></button>
          <button className="toolbar-button icon-only" onClick={() => window.dispatchEvent(new Event("supermd-find"))} title="Find and replace · Ctrl+F" aria-label="Find and replace"><MagnifyingGlass size={19} /></button>
        </nav>
        <nav className="right-actions" aria-label="View and export">
          <div className="segmented" aria-label="View mode">
            {(mobileUi ? ["live", "editor", "reader"] : ["editor", "live", "split", "reader"] as ViewMode[]).map((mode) => <button key={mode} className={view === mode ? "active" : ""} onClick={() => setView(mode as ViewMode)} title={`${mode[0].toUpperCase()}${mode.slice(1)} view`} aria-label={`${mode} view`} aria-pressed={view === mode}>{view === mode && <motion.i className="segment-indicator" layoutId="view-indicator" transition={motionEnabled ? spring.selector : { duration: 0 }} />}{mode === "editor" ? <PencilSimple size={17} /> : mode === "split" ? <Columns size={17} /> : mode === "live" ? <Sparkle size={17} /> : <BookOpen size={17} />}<span>{mode === "editor" && mobileUi ? "Source" : mode === "reader" && mobileUi ? "Read" : mode}</span></button>)}
          </div>
          <button className={`toolbar-button icon-only ${focusMode ? "active" : ""}`} onClick={() => setFocusMode((value) => !value)} title="Focus mode" aria-label="Focus mode" aria-pressed={focusMode}><Crosshair size={19} /></button>
          <button className="toolbar-button icon-only" onClick={toggleFullscreen} title="Fullscreen · F11" aria-label="Fullscreen"><ArrowsOut size={19} /></button>
          <button className="toolbar-button icon-only" onClick={() => setShowSettings(true)} title="Settings" aria-label="Settings"><GearSix size={19} /></button>
          <button className="export-action" onClick={() => android ? flash("Semantic PDF export currently requires desktop Pandoc + Typst") : setShowExport(true)} title={android ? "PDF export is currently desktop-only" : "Export PDF"}><FilePdf size={19} weight="bold" /><span>Export PDF</span></button>
        </nav>
      </header>}
      {!fullscreen && <div className="tab-strip" role="tablist" aria-label="Open documents">
        <div className="tab-scroll">{documents.tabs.map((tab) => <div key={tab.id} className={`document-tab ${tab.id === documents.activeId ? "selected" : ""}`} role="presentation">
          <button role="tab" aria-selected={tab.id === documents.activeId} title={tab.path ?? tab.name} onClick={() => setDocuments((current) => ({ ...current, activeId: tab.id }))} onAuxClick={(event) => { if (event.button === 1) setDocuments((current) => closeTab(current, tab.id)); }}><span className={`tab-dot ${isDirty(tab) ? "dirty" : ""}`} /><span className="tab-name">{tabTitle(tab)}</span></button>
          <button className="tab-close" onClick={() => setDocuments((current) => closeTab(current, tab.id))} title={`Close ${tabTitle(tab)}`} aria-label={`Close ${tabTitle(tab)}`}><X size={14} /></button>
        </div>)}</div>
        <button className="tab-add" onClick={newDocument} title="New tab · Ctrl+N" aria-label="New tab"><Plus size={17} /></button>
        {documents.recentlyClosed.length > 0 && <button className="tab-reopen" onClick={() => setDocuments(restoreClosedTab)} title="Reopen closed tab · Ctrl+Shift+T">Reopen</button>}
      </div>}
      {!fullscreen && view === "editor" && <div className="formatbar" aria-label="Formatting tools">
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
      {fullscreen && <div className="fullscreen-controls" aria-label="Fullscreen controls"><button onClick={() => zoomBy(-10)} title="Zoom out"><Minus size={16} /></button><button onClick={() => setZoom(100)} title="Reset workspace zoom">{workspaceZoom}%</button><button onClick={() => zoomBy(10)} title="Zoom in"><Plus size={16} /></button><span /><button onClick={toggleFullscreen} title="Leave fullscreen · F11"><ArrowsOut size={17} /></button></div>}
      <main className="workspace" ref={workspaceRef} data-resizing={resizing || windowResizing} data-dragging-file={draggingFile} style={{ "--split-left": `${splitPercent}fr`, "--split-right": `${100 - splitPercent}fr`, "--workspace-scale": workspaceZoom / 100 } as React.CSSProperties}>
        {(view === "editor" || view === "split") && <motion.section layout="position" initial={false} transition={motionEnabled && !resizing && !windowResizing ? spring.surface : { duration: 0 }} className="editor-pane" aria-label="Markdown source"><div className="pane-head"><span><PencilSimple size={15} /> Markdown</span>{view === "editor" ? <span className="zoom-controls" aria-label="Workspace zoom"><button onClick={() => zoomBy(-10)} aria-label="Zoom out"><Minus size={14} /></button><button className="zoom-value" onClick={() => setZoom(100)} aria-label={`Reset zoom, currently ${workspaceZoom}%`}>{workspaceZoom}%</button><button onClick={() => zoomBy(10)} aria-label="Zoom in"><Plus size={14} /></button></span> : <small>{lineCount} lines</small>}</div><Editor key={activeTab.id} value={content} onChange={(value) => setDocuments((current) => editTab(current, activeTab.id, value))} dark={dark} focusMode={focusMode} /></motion.section>}
        {view === "split" && <div className="pane-resizer" role="separator" aria-label="Resize editor and preview" aria-orientation="vertical" aria-valuemin={25} aria-valuemax={75} aria-valuenow={splitPercent} tabIndex={0} onPointerDown={onResizePointerDown} onPointerMove={onResizePointerMove} onPointerUp={onResizePointerUp} onLostPointerCapture={() => setResizing(false)} onDoubleClick={() => setSplitPercent(50)} onKeyDown={(event) => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); setSplitPercent((current) => Math.max(25, Math.min(75, current + (event.key === "ArrowRight" ? 5 : -5)))); } }}><span /></div>}
        {(view === "reader" || view === "split") && <motion.section layout="position" initial={false} transition={motionEnabled && !resizing && !windowResizing ? spring.surface : { duration: 0 }} className="preview-pane" aria-label="Reading preview"><div className="pane-head"><span><BookOpen size={15} /> Preview</span><div className="preview-tools"><small>{wordCount} words</small><span className="zoom-controls" aria-label="Workspace zoom"><button onClick={() => zoomBy(-10)} title="Zoom out · Ctrl+-" aria-label="Zoom out"><Minus size={14} /></button><button className="zoom-value" onClick={() => setZoom(100)} title="Reset zoom · Ctrl+0" aria-label={`Reset zoom, currently ${workspaceZoom}%`}>{workspaceZoom}%</button><button onClick={() => zoomBy(10)} title="Zoom in · Ctrl++" aria-label="Zoom in"><Plus size={14} /></button></span></div></div><div className="reading-scroll" ref={readingScrollRef}><div className="preview-page" style={{ width: previewLayoutWidth(previewViewportWidth, readerWidth, workspaceZoom), zoom: workspaceZoom / 100 }}><MarkdownPreview markdown={content} documentPath={path} python={python} dark={dark} trustedImageHosts={trustedImageHosts} onTrustImageHost={trustImageHost} /></div></div></motion.section>}
        {view === "live" && <motion.section layout="position" initial={false} transition={motionEnabled && !windowResizing ? spring.surface : { duration: 0 }} className="live-pane" aria-label="Live Markdown"><div className="pane-head"><span><Sparkle size={15} /> Live preview</span><small>Tap a pencil to edit a block</small></div><div className="reading-scroll"><LiveEditor key={activeTab.id} markdown={content} onChange={(value) => setDocuments((current) => editTab(current, activeTab.id, value))} documentPath={path} python={python} dark={dark} trustedImageHosts={trustedImageHosts} onTrustImageHost={trustImageHost} /></div></motion.section>}
      </main>
      <AnimatePresence>{notice && <motion.div key="notice" className="snackbar" initial={motionEnabled ? { opacity: 0, y: 18, x: "-50%", scale: .94 } : false} animate={{ opacity: 1, y: 0, x: "-50%", scale: 1 }} exit={motionEnabled ? { opacity: 0, y: 12, x: "-50%", scale: .96 } : { opacity: 0 }} transition={motionEnabled ? spring.surface : { duration: 0 }}>{notice}</motion.div>}</AnimatePresence>
      <AnimatePresence>{showSettings && <motion.div key="settings" className="scrim" initial={motionEnabled ? { opacity: 0 } : false} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: motionEnabled ? .24 : 0 }} onMouseDown={() => setShowSettings(false)}><motion.aside className="sheet" initial={motionEnabled ? { opacity: 0, y: 40, scale: .9, borderRadius: 44 } : false} animate={{ opacity: 1, y: 0, scale: 1, borderRadius: 28 }} exit={motionEnabled ? { opacity: 0, y: 18, scale: .96 } : { opacity: 0 }} transition={motionEnabled ? spring.sheet : { duration: 0 }} onMouseDown={(event) => event.stopPropagation()}>
        <div className="sheet-title"><h2>Appearance & runtime</h2><button onClick={() => setShowSettings(false)} aria-label="Close settings"><X size={20} /></button></div>
        <label>Normal theme<select value={normalTheme} onChange={(event) => setNormalTheme(event.target.value as ThemeMode)}><option value="caelestia">Caelestia dynamic</option><option value="light">Material light</option><option value="dark">Material dark</option><option value="black">Pure black</option></select></label>
        <label>Fullscreen theme<select value={fullscreenTheme} onChange={(event) => setFullscreenTheme(event.target.value as ThemeMode)}><option value="caelestia">Caelestia dynamic</option><option value="light">Material light</option><option value="dark">Material dark</option><option value="black">Pure black</option></select></label>
        {!android && <label>Python interpreter<div className="path-field"><input value={python} onChange={(event) => { setPython(event.target.value); localStorage.setItem("python", event.target.value); }} /><button onClick={choosePython}>Choose</button></div></label>}
        {android && <p className="help">Python execution and semantic PDF export require the desktop backend. Charts, math, callouts, and live reading work on this device.</p>}
        <h3>Typography</h3>
        <label>Reading font<select value={readerFont} onChange={(event) => setReaderFont(event.target.value)}>{readerFonts.map((font) => <option key={font.value} value={font.value}>{font.label}</option>)}</select></label>
        <div className="form-grid">
          <label>Editor size ({editorSize}px)<input type="range" min="11" max="22" step="1" value={editorSize} onChange={(event) => setEditorSize(Number(event.target.value))} /></label>
          <label>Editor spacing ({editorLeading.toFixed(2)})<input type="range" min="1.2" max="2.2" step="0.05" value={editorLeading} onChange={(event) => setEditorLeading(Number(event.target.value))} /></label>
          <label>Reading size ({readerSize}px)<input type="range" min="13" max="26" step="1" value={readerSize} onChange={(event) => setReaderSize(Number(event.target.value))} /></label>
          <label>Reading width ({readerWidth}px)<input type="range" min="560" max="1200" step="20" value={readerWidth} onChange={(event) => setReaderWidth(Number(event.target.value))} /></label>
          <label>Window zoom ({normalZoom}%)<input type="range" min="60" max="240" step="10" value={normalZoom} onChange={(event) => setNormalZoom(Number(event.target.value))} /></label>
          <label>Fullscreen zoom ({fullscreenZoom}%)<input type="range" min="60" max="240" step="10" value={fullscreenZoom} onChange={(event) => setFullscreenZoom(Number(event.target.value))} /></label>
        </div>
        <h3>Behaviour</h3>
        <label className="switch-row"><span><strong>Autosave</strong><small>Save 1.2 seconds after edits to an existing file</small></span><input type="checkbox" checked={autosave} onChange={(event) => setAutosave(event.target.checked)} /></label>
        <label className="switch-row"><span><strong>Expressive motion</strong><small>{systemReduceMotion ? "Disabled by your system reduced-motion preference" : "Spring transitions, shape-shifting controls, and fluid sheets"}</small></span><input type="checkbox" checked={motionEnabled} disabled={Boolean(systemReduceMotion)} onChange={(event) => setReduceMotion(!event.target.checked)} /></label>
        {draftWindows.length > 0 && <div className="draft-recovery"><strong>Recover another window</strong><small>Untitled notes from previously closed windows</small><div>{draftWindows.map((label) => <button key={label} onClick={() => openNewWindow(label)}>Open draft {label.slice(-8)}</button>)}</div></div>}
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
