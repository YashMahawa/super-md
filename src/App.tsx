import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as pickMobileDocument, save as chooseMobileDocument } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { AnimatePresence, motion, MotionConfig, useReducedMotion } from "motion/react";
import { ArrowsOutIcon, BookOpenIcon, BrowsersIcon, ChartLineIcon, CodeIcon, ColumnsIcon, CrosshairIcon, FilePdfIcon, FloppyDiskIcon, FolderOpenIcon, FunctionIcon, GearSixIcon, MagnifyingGlassIcon, MinusIcon, NoteIcon, SidebarSimpleIcon, PencilSimpleIcon, PlusIcon, SparkleIcon, TextBIcon, TextHTwoIcon, TextItalicIcon, XIcon } from "@phosphor-icons/react";
import Editor, { editorReadingOffset } from "./components/Editor";
import BrandMark from "./components/BrandMark";
import LiveEditor from "./components/LiveEditor";
import MarkdownPreview from "./components/MarkdownPreview";
import WelcomeSetup from "./components/WelcomeSetup";
import FolderPanel from "./components/FolderPanel";
import { preparePdf } from "./preparePdf";
import { addTab, closeTab, editTab, initialWorkspace, isDirty, markTabSaved, openTab, readWorkspace, restoreClosedTab, tabTitle, type DocumentWorkspace } from "./documentTabs";
import type { DocumentData, ExportOptions, ThemeMode, ViewMode } from "./types";
import { clampPreviewZoom, previewLayoutWidth, zoomShortcut } from "./zoom";
import MediaTools, { type InsertionPoint } from "./components/MediaTools";
import ImageViewer from "./components/ImageViewer";
import { imageMarkdown, prepareFmd, type ImportedImage } from "./documentMedia";
import { recordRecent } from "./recentFiles";
import ZoomInput from "./components/ZoomInput";
import ReadingSearch from "./components/ReadingSearch";
import { MaterialButton, MaterialIconButton, MaterialSelect, MaterialSlider, MaterialSwitch, materialThemes } from "./components/MaterialControls";
import { useDocumentAnalysis } from "./documentAnalysisWorker";
import type { OutlineEntry } from "./documentAnalysis";
import { applyAlignedTaskToggle } from "./revisionEdit";
import { readingOffset, revealReadingOffset } from "./readingPosition";
import { loadReadingLocation, saveReadingLocation } from "./readingLocations";
import { cancelHeadingNavigation, navigateToHeading } from "./documentNavigation";
import { markScrollInput, scrollInputVersion } from "./scrollAnchor";
import { isTypewriterShortcutEvent, setTypewriterScroll, toggleTypewriterScroll, useTypewriterScroll } from "./typewriterScroll";

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
| PDF layout | Embedded Typst typesetter |
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

const defaultExport: ExportOptions = { pageSize: "a4", margin: 14, fontSize: 10.5, lineHeight: 1.4, paragraphSpacing: 0.65, fontFamily: "Manrope", pageNumbers: true };
const readerFonts = [
  { value: "sans", label: "Noto Sans · clean" },
  { value: "humanist", label: "Manrope · expressive" },
  { value: "serif", label: "System serif · book" },
];
const pdfFonts = ["Libertinus Serif", "New Computer Modern", "Noto Sans", "DejaVu Sans Mono"];
const spring = {
  selector: { type: "spring" as const, stiffness: 580, damping: 29, mass: 0.75 },
  sheet: { type: "spring" as const, stiffness: 340, damping: 28, mass: 0.9 },
  surface: { type: "spring" as const, stiffness: 390, damping: 31, mass: 0.85 },
};

function storedTheme(key: string, fallback: ThemeMode): ThemeMode {
  const value = localStorage.getItem(key);
  return value === "caelestia" ? "system" : ["system", "light", "dark", "black"].includes(value || "") ? value as ThemeMode : fallback;
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
const compactViewport = () => (typeof window.matchMedia === "function" && window.matchMedia("(max-width: 760px)").matches);
const pickerCancelled = (error: unknown) => /cancelled|canceled/i.test(String(error));

function countLines(text: string): number {
  let lines = 1;
  let at = text.indexOf("\n");
  while (at !== -1) {
    lines++;
    at = text.indexOf("\n", at + 1);
  }
  return lines;
}

function countWords(text: string): number {
  let words = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const whitespace = code === 32 || (code >= 9 && code <= 13) || code === 160;
    if (whitespace) inWord = false;
    else if (!inWord) { inWord = true; words++; }
  }
  return words;
}

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
  const { pinnedAnalysis, outline, isReady: previewReady } = useDocumentAnalysis(activeTab.id, content, view);
  const modeOffsetRef = useRef<{ tabId: string; offset: number } | null>(null);
  const tabOffsetsRef = useRef(new Map<string, number>());
  const pendingHeadingRef = useRef<{ tabId: string; view: ViewMode; headingId: string; offset: number; input: number } | null>(null);
  const [focusMode, setFocusMode] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [normalTheme, setNormalTheme] = useState<ThemeMode>(() => storedTheme("theme.normal", "system"));
  const [fullscreenTheme, setFullscreenTheme] = useState<ThemeMode>(() => storedTheme("theme.fullscreen", "black"));
  const [caelestia, setCaelestia] = useState<any>(null);
  const [python, setPython] = useState(() => localStorage.getItem("python") || "");
  const [showSettings, setShowSettings] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [exportFormat, setExportFormat] = useState<"pdf" | "fmd">("pdf");
  const [exportOptions, setExportOptions] = useState<ExportOptions>(() => { try { return { ...defaultExport, ...JSON.parse(localStorage.getItem("pdf.options") || "{}") }; } catch { return defaultExport; } });
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState("");
  useEffect(() => {
    if (!showSettings && !showExport) return;
    const previous = document.activeElement as HTMLElement | null;
    const frame = requestAnimationFrame(() => document.querySelector<HTMLElement>('.sheet-title button')?.focus());
    const keys = (event: KeyboardEvent) => {
      const sheet = document.querySelector<HTMLElement>('.sheet'); if (!sheet) return;
      if (event.key === "Escape" && !exporting) { event.preventDefault(); setShowSettings(false); setShowExport(false); }
      if (event.key === "Tab") {
        const controls = Array.from(sheet.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),smd-select:not([disabled]),smd-slider,smd-switch:not([disabled]),smd-expressive-button:not([disabled])')).filter((node) => node.getClientRects().length > 0);
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener("keydown", keys);
    return () => { cancelAnimationFrame(frame); document.removeEventListener("keydown", keys); previous?.focus(); };
  }, [showSettings, showExport, exporting]);
  const [folderRoot, setFolderRoot] = useState<string | null>(() => localStorage.getItem("folder.root"));
  const [folderVisible, setFolderVisible] = useState(() => localStorage.getItem("folder.visible") === "true");
  const [folderWidth, setFolderWidth] = useState(() => Math.max(180, Math.min(420, storedNumber("folder.width", 248))));
  const folderDrag = useRef(false);
  const closing = useRef(false);
  useEffect(() => { localStorage.setItem("pdf.options", JSON.stringify(exportOptions)); }, [exportOptions]);
  useEffect(() => { localStorage.setItem("folder.visible", String(folderVisible)); localStorage.setItem("folder.width", String(folderWidth)); }, [folderVisible, folderWidth]);
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
  const typewriterScroll = useTypewriterScroll();
  const [reduceMotion, setReduceMotion] = useState(() => localStorage.getItem("reduceMotion") === "true");
  const [spellCheck, setSpellCheck] = useState(() => localStorage.getItem("spellCheck") === "true");
  const [grammarCheck, setGrammarCheck] = useState(() => localStorage.getItem("grammarCheck") === "true");
  const [trustedImageHosts, setTrustedImageHosts] = useState(storedImageHosts);
  const [draftWindows, setDraftWindows] = useState<string[]>([]);
  const [showWelcome, setShowWelcome] = useState(firstRunSetup);
  const systemReduceMotion = useReducedMotion();
  const motionEnabled = !reduceMotion && !systemReduceMotion;
  const activeTheme = fullscreen ? fullscreenTheme : normalTheme;
  const dark = activeTheme === "dark" || activeTheme === "black" || (activeTheme === "system" && (caelestia?.mode ? caelestia.mode !== "light" : window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true));
  const workspaceZoom = fullscreen ? fullscreenZoom : normalZoom;
  zoomRef.current = workspaceZoom;
  const setZoom = useCallback((updater: number | ((current: number) => number)) => {
    const apply = (current: number) => clampPreviewZoom(typeof updater === "number" ? updater : updater(current));
    if (fullscreen) setFullscreenZoom(apply);
    else setNormalZoom(apply);
  }, [fullscreen]);
  const zoomBy = useCallback((step: number) => setZoom((current) => current + step), [setZoom]);
  const trustImageHost = useCallback((host: string) => setTrustedImageHosts((current) => current.includes(host) ? current : [...current, host]), []);
  const captureActiveOffset = useCallback((tabId: string, currentView: ViewMode): number => {
    if (currentView === "editor") return editorReadingOffset(tabId) ?? 0;
    const scroller = readingScrollRef.current;
    if (currentView === "split") {
      if (scroller && scroller.scrollTop > 0) return readingOffset(scroller);
      return editorReadingOffset(tabId) ?? (scroller ? readingOffset(scroller) : 0);
    }
    return scroller ? readingOffset(scroller) : 0;
  }, []);

  const switchView = useCallback((nextView: ViewMode) => {
    setView((currentView) => {
      if (currentView === nextView) return currentView;
      const tab = documentsRef.current.tabs.find((item) => item.id === documentsRef.current.activeId) ?? documentsRef.current.tabs[0];
      if (tab) {
        const offset = captureActiveOffset(tab.id, currentView);
        modeOffsetRef.current = { tabId: tab.id, offset };
        tabOffsetsRef.current.set(tab.id, offset);
      }
      pendingHeadingRef.current = null;
      if (readingScrollRef.current) cancelHeadingNavigation(readingScrollRef.current);
      return nextView;
    });
  }, [captureActiveOffset]);

  const selectTab = useCallback((nextId: string) => {
    setDocuments((current) => {
      if (current.activeId === nextId) return current;
      const active = current.tabs.find((item) => item.id === current.activeId);
      if (active) tabOffsetsRef.current.set(active.id, captureActiveOffset(active.id, view));
      pendingHeadingRef.current = null;
      if (readingScrollRef.current) cancelHeadingNavigation(readingScrollRef.current);
      return { ...current, activeId: nextId };
    });
  }, [captureActiveOffset, view]);

  const navigateOutlineHeading = useCallback((entry: OutlineEntry) => {
    markScrollInput();
    if (view === "editor") {
      pendingHeadingRef.current = null;
      window.dispatchEvent(new CustomEvent("supermd-goto-offset", { detail: entry.offset }));
      return;
    }
    if (view === "split") {
      window.dispatchEvent(new CustomEvent("supermd-goto-offset", { detail: entry.offset }));
    }
    const scroller = readingScrollRef.current;
    if (scroller && previewReady) {
      pendingHeadingRef.current = null;
      navigateToHeading(scroller, entry.id);
    } else {
      pendingHeadingRef.current = { tabId: activeTab.id, view, headingId: entry.id, offset: entry.offset, input: scrollInputVersion() };
    }
  }, [activeTab.id, previewReady, view]);

  useEffect(() => {
    window.supermdHeading = (id, offset = 0) => navigateOutlineHeading({ id, title: id, level: 1, offset });
    return () => { delete window.supermdHeading; };
  }, [navigateOutlineHeading]);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(max-width: 760px)");
    const onChange = () => { setMobileUi(query.matches); if (query.matches) switchView(view === "split" ? "live" : view); };
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [switchView, view]);

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
    if (!node || !previewReady) return;
    const measure = () => setPreviewViewportWidth(node.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [view, activeTab.id, previewReady]);

  useLayoutEffect(() => {
    if (!previewReady) return;
    if (pendingHeadingRef.current?.tabId === activeTab.id && pendingHeadingRef.current.view === view) {
      modeOffsetRef.current = null;
      return;
    }
    const startingInput = scrollInputVersion();
    const saved = path ? loadReadingLocation(path) : null;
    let targetOffset: number | undefined;
    if (modeOffsetRef.current?.tabId === activeTab.id) {
      targetOffset = modeOffsetRef.current.offset;
      modeOffsetRef.current = null;
    } else if (tabOffsetsRef.current.has(activeTab.id)) {
      targetOffset = tabOffsetsRef.current.get(activeTab.id);
    } else if (saved) {
      targetOffset = saved.offset;
    }
    if (targetOffset === undefined) return;
    let stopped = false;
    const stop = () => { stopped = true; };
    const inputs = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
    inputs.forEach((name) => window.addEventListener(name, stop, { capture: true, passive: true }));
    const apply = () => {
      if (stopped || scrollInputVersion() !== startingInput) return;
      if (view === "editor" || view === "split") {
        window.dispatchEvent(new CustomEvent("supermd-goto-offset", { detail: targetOffset }));
      }
      if (view !== "editor") {
        const host = readingScrollRef.current;
        if (host) revealReadingOffset(host, targetOffset);
      }
    };
    const frame = requestAnimationFrame(() => { apply(); requestAnimationFrame(apply); });
    const timers = [120, 320, 700].map((delay) => window.setTimeout(apply, delay));
    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
      timers.forEach(window.clearTimeout);
      inputs.forEach((name) => window.removeEventListener(name, stop, { capture: true }));
    };
  }, [activeTab.id, path, previewReady, view]);

  useLayoutEffect(() => {
    if (!previewReady) return;
    const pending = pendingHeadingRef.current;
    if (!pending) return;
    pendingHeadingRef.current = null;
    if (pending.tabId !== activeTab.id || pending.view !== view || pending.input !== scrollInputVersion()) return;
    const host = readingScrollRef.current;
    if (host) navigateToHeading(host, pending.headingId);
  }, [activeTab.id, previewReady, view]);

  useEffect(() => {
    if (!previewReady) return;
    const root = view === "editor" ? document.querySelector<HTMLElement>(".editor-pane .cm-scroller") : readingScrollRef.current;
    if (!root) return;
    let timer = 0;
    const persist = () => {
      if (!root.isConnected) return;
      const offset = captureActiveOffset(activeTab.id, view);
      tabOffsetsRef.current.set(activeTab.id, offset);
      if (path) saveReadingLocation(path, { top: root.scrollTop, offset, zoom: zoomRef.current, mode: view });
    };
    const onScroll = () => { window.clearTimeout(timer); timer = window.setTimeout(persist, 600); };
    root.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("pagehide", persist);
    return () => {
      window.clearTimeout(timer);
      persist();
      root.removeEventListener("scroll", onScroll);
      window.removeEventListener("pagehide", persist);
    };
  }, [activeTab.id, captureActiveOffset, path, previewReady, view]);

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
  const applyDocument = useCallback((doc: DocumentData) => { setDocuments((current) => openTab(current, doc)); recordRecent(doc.path); }, []);
  const chooseFolder = useCallback(async () => {
    try { const root = await invoke<string | null>("open_workspace_folder"); if (root) { setFolderRoot(root); setFolderVisible(true); localStorage.setItem("folder.root", root); } }
    catch (error) { flash(`Could not open folder: ${error}`); }
  }, []);
  const openFolderFile = useCallback(async (path: string) => { try { applyDocument(await invoke<DocumentData>("read_document_at", { path })); } catch (error) { flash(String(error)); } }, [applyDocument]);
  const closeWindow = useCallback(async () => {
    if (closing.current || !("__TAURI_INTERNALS__" in window)) return;
    closing.current = true;
    try {
      // Drafts are recovered next launch; no cancel/close loop or data discard.
      localStorage.setItem(sessionKey, JSON.stringify(documentsRef.current));
      await getCurrentWindow().destroy();
    } catch (error) { closing.current = false; flash(`Window could not close: ${error}. Save your note first.`); }
  }, [sessionKey]);
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let disposed = false; let stop: (() => void) | undefined;
    getCurrentWindow().onCloseRequested((event) => { event.preventDefault(); void closeWindow(); }).then((unlisten) => { if (disposed) unlisten(); else stop = unlisten; });
    return () => { disposed = true; stop?.(); };
  }, [closeWindow]);
  const newDocument = useCallback(() => setDocuments((current) => addTab(current)), []);
  const insertMedia = useCallback((text: string, point?: InsertionPoint) => {
    setDocuments((current) => { const tab = current.tabs.find((t) => t.id === current.activeId)!; const from = Math.max(0, Math.min(point?.from ?? tab.content.length, tab.content.length)); const to = Math.max(from, Math.min(point?.to ?? from, tab.content.length)); return editTab(current, tab.id, tab.content.slice(0, from) + text + tab.content.slice(to)); });
  }, []);
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
      const prepared = /\.fmd$/i.test(tab.path || "") && !saveAs ? await prepareFmd(tab.content, tab.path) : { content: tab.content, assets: {} };
      const saved = android ? await (async () => {
        const target = saveAs || !tab.path ? await chooseMobileDocument({ defaultPath: tabTitle(tab), filters: [{ name: "Markdown", extensions: ["smd", "md"] }] }) : tab.path;
        if (!target) return null;
        await writeTextFile(target, tab.content);
        return target;
      })() : await invoke<string | null>("save_document", { request: { path: saveAs ? null : tab.path, content: prepared.content, assets: prepared.assets, sourcePath: tab.path } });
      if (saved) { setDocuments((current) => markTabSaved(current.tabs.find((t) => t.id === tab.id)?.content === tab.content ? editTab(current, tab.id, prepared.content) : current, tab.id, saved, prepared.content)); recordRecent(saved); flash("Saved"); }
    } catch (error) { if (!pickerCancelled(error)) flash(`Could not save: ${error}`); }
    finally { savingRef.current.delete(tab.id); }
  }, []);
  const toggleFullscreen = useCallback(async () => {
    if(!fullscreen) setFullscreenZoom(normalZoom);
    if (!("__TAURI_INTERNALS__" in window)) {
      const next = !fullscreen;
      if (document.fullscreenEnabled) {
        try { if (next) await document.documentElement.requestFullscreen(); else if (document.fullscreenElement) await document.exitFullscreen(); }
        catch (error) { flash(`Fullscreen could not change: ${error}`); return; }
      }
      setFullscreen(next); return;
    }
    try {
      const nativeWindow = getCurrentWindow();
      const next = !(await nativeWindow.isFullscreen());
      await nativeWindow.setFullscreen(next); setFullscreen(next);
    } catch (error) { flash(`Fullscreen could not change: ${error}`); }
  }, [fullscreen,normalZoom]);
  useEffect(() => {
    if ("__TAURI_INTERNALS__" in window) return;
    const changed = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }, []);

  const openNewWindow = useCallback((recoverLabel?: string) => {
    if (!("__TAURI_INTERNALS__" in window)) { flash("New windows are available in the desktop app"); return; }
    const label = recoverLabel ?? `document-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const child = new WebviewWindow(label, { url: `index.html?window=${recoverLabel ? "recover" : "new"}`, title: recoverLabel ? "Super MD — Recovered draft" : "Super MD — New window", width: 1180, height: 800, minWidth: 760, minHeight: 520, zoomHotkeysEnabled: false });
    child.once("tauri://error", (event) => flash(`Could not open window: ${event.payload}`));
  }, []);

  useEffect(() => {
    const syncTheme = () => invoke<any>("load_system_theme").then(setCaelestia).catch(() => undefined);
    void syncTheme();
    const themeTimer = window.setInterval(syncTheme, 30_000);
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
    return () => window.clearInterval(themeTimer);
  }, [applyDocument, sessionKey]);

  useEffect(() => {
    // Coalesce whole-workspace serialization during typing. Window close and
    // beforeunload still flush the latest snapshot synchronously.
    const timer = window.setTimeout(() => {
      try { localStorage.setItem(sessionKey, JSON.stringify(documents)); }
      catch { flash("Session recovery is full; save large notes to files"); }
    }, 200);
    return () => window.clearTimeout(timer);
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
      const images = payload.paths.filter((name) => /\.(png|jpe?g|svg|gif|webp|avif)$/i.test(name));
      if (images.length) { const id = documentsRef.current.activeId; try { const imported = await invoke<ImportedImage[]>("import_image_paths", { paths: images }); setDocuments((current) => { const tab = current.tabs.find((tab) => tab.id === id); return tab ? editTab(current, id, tab.content + "\n\n" + imported.map(imageMarkdown).join("\n\n") + "\n") : current; }); } catch (e) { flash(String(e)); } return; }
      const candidate = payload.paths.find((name) => /\.(smd|md|markdown|fmd)$/i.test(name));
      if (!candidate) { flash("Drop an image, .fmd, .smd or Markdown document"); return; }
      try { applyDocument(await invoke<DocumentData>("read_document_at", { path: candidate })); }
      catch (error) { flash(`Could not open dropped file: ${error}`); }
    }).then((stop) => { unlisten = stop; });
    return () => unlisten?.();
  }, [applyDocument, insertMedia]);

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
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "o") { event.preventDefault(); event.shiftKey ? chooseFolder() : open(); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "b") { event.preventDefault(); setFolderVisible((visible) => !visible); }
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "n") { event.preventDefault(); openNewWindow(); }
      else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "n") { event.preventDefault(); newDocument(); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "w") { event.preventDefault(); event.shiftKey ? closeWindow() : setDocuments((current) => closeTab(current, current.activeId)); }
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "t") { event.preventDefault(); setDocuments(restoreClosedTab); }
      if (!event.defaultPrevented && isTypewriterShortcutEvent(event)) { event.preventDefault(); toggleTypewriterScroll(); }
      if ((event.ctrlKey || event.metaKey) && event.key === "Tab") {
        event.preventDefault();
        setDocuments((current) => {
          const index = current.tabs.findIndex((tab) => tab.id === current.activeId);
          const next = (index + (event.shiftKey ? current.tabs.length - 1 : 1)) % current.tabs.length;
          return { ...current, activeId: current.tabs[next].id };
        });
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f" && (view === "reader" || view === "live")) {
        event.preventDefault();
        setSearching(true);
        window.dispatchEvent(new Event("supermd-find-focus"));
      }
      const zoom = zoomShortcut(event);
      if (zoom) { event.preventDefault(); if (zoom === "reset") setZoom(100); else zoomBy(zoom === "in" ? 10 : -10); }
    };
    const openFind = () => {
      if (view === "reader" || view === "live") {
        setSearching(true);
        window.dispatchEvent(new Event("supermd-find-focus"));
      }
    };
    window.addEventListener("keydown", handler);
    window.addEventListener("supermd-find", openFind);
    return () => {
      window.removeEventListener("keydown", handler);
      window.removeEventListener("supermd-find", openFind);
    };
  }, [newDocument, open, openNewWindow, save, setZoom, toggleFullscreen, zoomBy, chooseFolder, closeWindow, view]);

  useEffect(() => {
    if (view === "editor" || view === "split") setSearching(false);
  }, [view]);

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
    localStorage.setItem("spellCheck", String(spellCheck));
    localStorage.setItem("grammarCheck", String(grammarCheck));
  }, [autosave, editorLeading, editorSize, grammarCheck, motionEnabled, readerFont, readerSize, readerWidth, reduceMotion, spellCheck]);

  useEffect(() => {
    if (!autosave || !dirty || !path) return;
    const timer = window.setTimeout(() => save(false), 1200);
    return () => window.clearTimeout(timer);
  }, [autosave, content, dirty, path, save]);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = activeTheme === "system" ? (caelestia?.mode ?? (typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")) : activeTheme;
    root.dataset.fullscreen = String(fullscreen);
    if (activeTheme === "system" && caelestia?.colours) {
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

  const togglePreviewTask = useCallback((baseSource: string, offset: number, checked: boolean): boolean => {
    const tab = documentsRef.current.tabs.find((item) => item.id === documentsRef.current.activeId);
    if (!tab) return false;
    const aligned = applyAlignedTaskToggle(baseSource, tab.content, offset, checked);
    if (!aligned) return false;
    setDocuments((current) => editTab(current, tab.id, aligned.content));
    return true;
  }, []);

  const title = tabTitle(activeTab);
  const location = useMemo(() => path ? path.split(/[\\/]/).slice(0, -1).join("/") : "New document", [path]);
  const lineCount = useMemo(() => countLines(content), [content]);
  const previewSource = pinnedAnalysis?.source ?? content;
  const wordCount = useMemo(() => countWords(previewSource), [previewSource]);
  const choosePython = async () => {
    const selected = await invoke<string | null>("choose_python");
    if (selected) { setPython(selected); localStorage.setItem("python", selected); }
  };
  const exportPdf = async () => {
    if (exporting) return;
    setExporting(true); setExportError("");
    try {
      const output = exportFormat === "fmd"
        ? await invoke<string | null>("export_fmd", await prepareFmd(content, path))
        : await invoke<string | null>("export_portable_pdf", { path, ...await preparePdf(content, path, python || "embedded", { trustedImageHosts }), options: exportOptions });
      if (output) { flash(`Exported ${output}`); setShowExport(false); }
    } catch (error) { setExportError(String(error)); }
    finally { setExporting(false); }
  };
  const format = (prefix: string, suffix?: string, block = false) =>
    window.dispatchEvent(new CustomEvent("supermd-format", { detail: { prefix, suffix, block } }));

  return (
    <MotionConfig reducedMotion={motionEnabled ? "never" : "always"}>
    <div className={`app view-${view} ${focusMode ? "focus-mode" : ""}`}>
      {!fullscreen && <header className="topbar">
        <div className="brand"><span className="brand-mark"><BrandMark /></span><span className="document-identity"><strong title={title}>{title}</strong><small title={location}>{location}</small></span><span className={`save-state ${dirty ? "is-dirty" : ""}`}>{dirty ? "Recoverable edit" : path ? "Saved" : "Draft"}</span></div>
        <nav className="file-actions" aria-label="File actions">
          <MaterialIconButton motion={motionEnabled} selected={folderVisible} onClick={() => setFolderVisible((value) => !value)} title="Files · Ctrl+B" label="Toggle folder sidebar"><SidebarSimpleIcon size={20} /></MaterialIconButton>
          <MaterialIconButton motion={motionEnabled} onClick={newDocument} title="New · Ctrl+N" label="New document"><PlusIcon size={20} /></MaterialIconButton>
          <MaterialIconButton motion={motionEnabled} onClick={() => openNewWindow()} title="New window · Ctrl+Shift+N" label="New window"><BrowsersIcon size={20} /></MaterialIconButton>
          <MaterialButton motion={motionEnabled} variant="text" onClick={open} label="Open"><FolderOpenIcon size={19} /><span>Open</span></MaterialButton>
          <MaterialIconButton motion={motionEnabled} onClick={chooseFolder} title="Open folder · Ctrl+Shift+O" label="Open folder"><FolderOpenIcon size={20} weight="fill" /></MaterialIconButton>
          <MaterialButton motion={motionEnabled} variant="text" onClick={() => save(false)} label="Save"><FloppyDiskIcon size={19} /><span>Save</span></MaterialButton>
          <MaterialIconButton motion={motionEnabled} onClick={() => window.dispatchEvent(new Event("supermd-find"))} title="Find and replace · Ctrl+F" label="Find and replace"><MagnifyingGlassIcon size={20} /></MaterialIconButton>
          <MaterialButton motion={motionEnabled} variant="text" onClick={() => window.supermdMedia?.()} label="Insert image or link">Insert</MaterialButton>
        </nav>
        <nav className="right-actions" aria-label="View and export">
          <div className="segmented" aria-label="View mode">
            {(mobileUi ? ["live", "editor", "reader"] : ["editor", "live", "split", "reader"] as ViewMode[]).map((mode) => <button key={mode} className={view === mode ? "active" : ""} onClick={() => switchView(mode as ViewMode)} title={`${mode[0].toUpperCase()}${mode.slice(1)} view`} aria-label={`${mode} view`} aria-pressed={view === mode}>{view === mode && <motion.i className="segment-indicator" layoutId="view-indicator" transition={motionEnabled ? spring.selector : { duration: 0 }} />}{mode === "editor" ? <PencilSimpleIcon size={17} /> : mode === "split" ? <ColumnsIcon size={17} /> : mode === "live" ? <SparkleIcon size={17} /> : <BookOpenIcon size={17} />}<span>{mode === "editor" && mobileUi ? "Source" : mode === "reader" && mobileUi ? "Read" : mode}</span></button>)}
          </div>
          <MaterialIconButton motion={motionEnabled} selected={focusMode} onClick={() => setFocusMode((value) => !value)} title="Focus mode" label="Focus mode"><CrosshairIcon size={20} /></MaterialIconButton>
          <MaterialIconButton motion={motionEnabled} onClick={toggleFullscreen} title="Fullscreen · F11" label="Fullscreen"><ArrowsOutIcon size={20} /></MaterialIconButton>
          <MaterialIconButton motion={motionEnabled} onClick={() => setShowSettings(true)} title="Settings" label="Settings"><GearSixIcon size={20} /></MaterialIconButton>
          <MaterialButton className="export-action" motion={motionEnabled} onClick={() => setShowExport(true)} label="Export"><FilePdfIcon size={19} weight="bold" /><span>Export</span></MaterialButton>
        </nav>
      </header>}
      {!fullscreen && <div className="tab-strip" role="tablist" aria-label="Open documents">
        <div className="tab-scroll">{documents.tabs.map((tab) => <div key={tab.id} className={`document-tab ${tab.id === documents.activeId ? "selected" : ""}`} role="presentation">
          <button role="tab" aria-selected={tab.id === documents.activeId} title={tab.path ?? tab.name} onClick={() => selectTab(tab.id)} onAuxClick={(event) => { if (event.button === 1) setDocuments((current) => closeTab(current, tab.id)); }}><span className={`tab-dot ${isDirty(tab) ? "dirty" : ""}`} /><span className="tab-name">{tabTitle(tab)}</span></button>
          <button className="tab-close" onClick={() => setDocuments((current) => closeTab(current, tab.id))} title={`Close ${tabTitle(tab)}`} aria-label={`Close ${tabTitle(tab)}`}><XIcon size={14} /></button>
        </div>)}</div>
        <button className="tab-add" onClick={newDocument} title="New tab · Ctrl+N" aria-label="New tab"><PlusIcon size={17} /></button>
        {documents.recentlyClosed.length > 0 && <button className="tab-reopen" onClick={() => setDocuments(restoreClosedTab)} title="Reopen closed tab · Ctrl+Shift+T">Reopen</button>}
      </div>}
      {!fullscreen && view === "editor" && <div className="formatbar" aria-label="Formatting tools">
        <span className="format-label">Insert</span>
        <button onClick={() => format("## ", "", true)} title="Heading 2" aria-label="Heading 2"><TextHTwoIcon size={18} /></button>
        <button onClick={() => format("**") } title="Bold" aria-label="Bold"><TextBIcon size={18} /></button>
        <button onClick={() => format("_") } title="Italic" aria-label="Italic"><TextItalicIcon size={18} /></button>
        <span className="format-divider" />
        <button onClick={() => format("`") } title="Inline code" aria-label="Inline code"><CodeIcon size={18} /></button>
        <button onClick={() => format("$", "$") } title="Inline math" aria-label="Inline math"><FunctionIcon size={18} /></button>
        <span className="format-divider" />
        <button className="format-text-button" onClick={() => format("\n:::callout note \"Note\"\nWrite here.\n:::\n", "", true)} title="Insert callout"><NoteIcon size={18} /><span>Callout</span></button>
        <button className="format-text-button" onClick={() => format("\n```smd-chart\n{\n  \"title\": \"Interactive graph\",\n  \"x\": { \"min\": -6.28, \"max\": 6.28 },\n  \"series\": [{ \"expression\": \"a * Math.sin(x)\" }],\n  \"sliders\": [{ \"name\": \"a\", \"min\": 0, \"max\": 3, \"step\": 0.1, \"value\": 1 }]\n}\n```\n", "", true)} title="Insert interactive graph"><ChartLineIcon size={18} /><span>Graph</span></button>
        <span className="format-hint">Alt+click adds a cursor</span>
      </div>}
      {fullscreen && <div className="fullscreen-controls" aria-label="Fullscreen controls"><button onClick={() => zoomBy(-10)} title="Zoom out"><MinusIcon size={16} /></button><ZoomInput value={workspaceZoom} onChange={setZoom} /><button onClick={() => zoomBy(10)} title="Zoom in"><PlusIcon size={16} /></button><span /><button onClick={toggleFullscreen} title="Leave fullscreen · F11"><ArrowsOutIcon size={17} /></button></div>}
      <div className="work-area" style={{ "--folder-width": `${folderWidth}px` } as React.CSSProperties}>
      {folderVisible && !fullscreen && <><FolderPanel root={folderRoot} activePath={path} outline={outline} onHeading={navigateOutlineHeading} onChoose={chooseFolder} onHide={() => setFolderVisible(false)} onOpen={openFolderFile} /><div className="folder-resizer" role="separator" aria-label="Resize folder sidebar" aria-orientation="vertical" tabIndex={0} onPointerDown={(e) => { folderDrag.current = true; e.currentTarget.setPointerCapture(e.pointerId); }} onPointerMove={(e) => { if (folderDrag.current) setFolderWidth(Math.max(180, Math.min(420, e.clientX))); }} onPointerUp={() => { folderDrag.current = false; }} onLostPointerCapture={() => { folderDrag.current = false; }} onKeyDown={(e) => { if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); setFolderWidth((w) => Math.max(180, Math.min(420, w + (e.key === "ArrowRight" ? 10 : -10)))); } }} /></>}
      <main className="workspace" ref={workspaceRef} data-resizing={resizing || windowResizing} data-dragging-file={draggingFile} style={{ "--split-left": `${splitPercent}fr`, "--split-right": `${100 - splitPercent}fr`, "--workspace-scale": workspaceZoom / 100 } as React.CSSProperties}>
        {searching && (view === "reader" || view === "live") && <ReadingSearch content={content} renderedRevision={previewReady ? pinnedAnalysis?.source : undefined} close={() => setSearching(false)} onChange={view === "reader" ? undefined : (value) => setDocuments((current) => editTab(current, activeTab.id, value))} />}
        {(view === "editor" || view === "split") && <motion.section layout={false} initial={false} transition={motionEnabled && !resizing && !windowResizing ? spring.surface : { duration: 0 }} className="editor-pane" aria-label="Markdown source"><div className="pane-head"><span><PencilSimpleIcon size={15} /> Markdown</span>{view === "editor" ? <span className="zoom-controls" aria-label="Workspace zoom"><button onClick={() => zoomBy(-10)} aria-label="Zoom out"><MinusIcon size={14} /></button><ZoomInput value={workspaceZoom} onChange={setZoom} /><button onClick={() => zoomBy(10)} aria-label="Zoom in"><PlusIcon size={14} /></button></span> : <small>{lineCount} lines</small>}</div><Editor key={activeTab.id} sessionId={activeTab.id} value={content} onChange={(value) => setDocuments((current) => editTab(current, activeTab.id, value))} dark={dark} focusMode={focusMode} spellCheck={spellCheck} grammarCheck={grammarCheck} typewriterScroll={typewriterScroll} onTypewriterChange={setTypewriterScroll} /></motion.section>}
        {view === "split" && <div className="pane-resizer" role="separator" aria-label="Resize editor and preview" aria-orientation="vertical" aria-valuemin={25} aria-valuemax={75} aria-valuenow={splitPercent} tabIndex={0} onPointerDown={onResizePointerDown} onPointerMove={onResizePointerMove} onPointerUp={onResizePointerUp} onLostPointerCapture={() => setResizing(false)} onDoubleClick={() => setSplitPercent(50)} onKeyDown={(event) => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); setSplitPercent((current) => Math.max(25, Math.min(75, current + (event.key === "ArrowRight" ? 5 : -5)))); } }}><span /></div>}
        {(view === "reader" || view === "split") && <motion.section layout={false} initial={false} transition={motionEnabled && !resizing && !windowResizing ? spring.surface : { duration: 0 }} className="preview-pane" aria-label="Reading preview"><div className="pane-head"><span><BookOpenIcon size={15} /> Preview</span><div className="preview-tools"><small>{wordCount} words</small><span className="zoom-controls" aria-label="Workspace zoom"><button onClick={() => zoomBy(-10)} title="Zoom out · Ctrl+-" aria-label="Zoom out"><MinusIcon size={14} /></button><ZoomInput value={workspaceZoom} onChange={setZoom} /><button onClick={() => zoomBy(10)} title="Zoom in · Ctrl++" aria-label="Zoom in"><PlusIcon size={14} /></button></span></div></div><div className="reading-scroll" ref={readingScrollRef}>{pinnedAnalysis ? <div className="preview-page" style={{ width: previewLayoutWidth(previewViewportWidth, readerWidth, workspaceZoom), zoom: workspaceZoom / 100 }}><MarkdownPreview markdown={pinnedAnalysis.source} onChange={(value) => setDocuments((current) => editTab(current, activeTab.id, value))} onToggleTask={togglePreviewTask} sourceAnalysis={pinnedAnalysis} documentPath={path} python={python} dark={dark} trustedImageHosts={trustedImageHosts} onTrustImageHost={trustImageHost} /></div> : <div className="reader-loading" role="status"><span className="expressive-loading-shape" aria-hidden="true"/>Preparing preview</div>}</div></motion.section>}
        {view === "live" && <motion.section layout={false} initial={false} transition={motionEnabled && !windowResizing ? spring.surface : { duration: 0 }} className="live-pane" aria-label="Live Markdown"><div className="pane-head"><span><SparkleIcon size={15} /> Live preview</span><span className="preview-tools"><small>Click content to edit</small><ZoomInput value={workspaceZoom} onChange={setZoom} /></span></div><div className="reading-scroll" ref={readingScrollRef}>{pinnedAnalysis ? <LiveEditor key={activeTab.id} sessionId={activeTab.id} markdown={content} sourceAnalysis={pinnedAnalysis} onChange={(value) => setDocuments((current) => editTab(current, activeTab.id, value))} documentPath={path} python={python} dark={dark} trustedImageHosts={trustedImageHosts} onTrustImageHost={trustImageHost} spellCheck={spellCheck} grammarCheck={grammarCheck} typewriterScroll={typewriterScroll} /> : <div className="reader-loading" role="status"><span className="expressive-loading-shape" aria-hidden="true"/>Preparing preview</div>}</div></motion.section>}
      </main></div>
      <AnimatePresence>{notice && <motion.div key="notice" className="snackbar" initial={motionEnabled ? { opacity: 0, y: 18, x: "-50%", scale: .94 } : false} animate={{ opacity: 1, y: 0, x: "-50%", scale: 1 }} exit={motionEnabled ? { opacity: 0, y: 12, x: "-50%", scale: .96 } : { opacity: 0 }} transition={motionEnabled ? spring.surface : { duration: 0 }}>{notice}</motion.div>}</AnimatePresence>
      <AnimatePresence>{showSettings && <motion.div key="settings" className="scrim" initial={motionEnabled ? { opacity: 0 } : false} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: motionEnabled ? .24 : 0 }} onMouseDown={() => setShowSettings(false)}><motion.aside className="sheet" role="dialog" aria-modal="true" aria-label="Settings" initial={motionEnabled ? { opacity: 0, y: 40, scale: .9, borderRadius: 44 } : false} animate={{ opacity: 1, y: 0, scale: 1, borderRadius: 28 }} exit={motionEnabled ? { opacity: 0, y: 18, scale: .96 } : { opacity: 0 }} transition={motionEnabled ? spring.sheet : { duration: 0 }} onMouseDown={(event) => event.stopPropagation()}>
        <div className="sheet-title"><h2>Appearance & runtime</h2><button onClick={() => setShowSettings(false)} aria-label="Close settings"><XIcon size={20} /></button></div>
        <MaterialSelect label="Normal theme" motion={motionEnabled} value={normalTheme} options={materialThemes} onChange={(value) => setNormalTheme(value as ThemeMode)} />
        <MaterialSelect label="Fullscreen theme" motion={motionEnabled} value={fullscreenTheme} options={materialThemes} onChange={(value) => setFullscreenTheme(value as ThemeMode)} />
        {!android && <label>Python interpreter<div className="path-field"><input value={python} onChange={(event) => { setPython(event.target.value); localStorage.setItem("python", event.target.value); }} /><button onClick={choosePython}>Choose</button></div></label>}
        {android && <p className="help">PDF export and Python cells run locally on Android. Run cells before export to include their figures.</p>}
        <h3>Typography</h3>
        <MaterialSelect label="Reading font" motion={motionEnabled} value={readerFont} options={readerFonts} onChange={setReaderFont} />
        <div className="form-grid">
          <label>Editor size ({editorSize}px)<MaterialSlider motion={motionEnabled} label="Editor size" min={11} max={22} step={1} value={editorSize} onChange={setEditorSize} /></label>
          <label>Editor spacing ({editorLeading.toFixed(2)})<MaterialSlider motion={motionEnabled} label="Editor spacing" min={1.2} max={2.2} step={0.05} value={editorLeading} onChange={setEditorLeading} /></label>
          <label>Reading size ({readerSize}px)<MaterialSlider motion={motionEnabled} label="Reading size" min={13} max={26} step={1} value={readerSize} onChange={setReaderSize} /></label>
          <label>Reading width ({readerWidth}px)<MaterialSlider motion={motionEnabled} label="Reading width" min={560} max={1200} step={20} value={readerWidth} onChange={setReaderWidth} /></label>
          <label>Window zoom ({normalZoom}%)<MaterialSlider motion={motionEnabled} label="Window zoom" min={60} max={240} step={1} value={normalZoom} onChange={setNormalZoom} /></label>
          <label>Fullscreen zoom ({fullscreenZoom}%)<MaterialSlider motion={motionEnabled} label="Fullscreen zoom" min={60} max={240} step={1} value={fullscreenZoom} onChange={setFullscreenZoom} /></label>
        </div>
        <h3>Behaviour</h3>
        <label className="switch-row"><span><strong>Autosave</strong><small>Save 1.2 seconds after edits to an existing file</small></span><MaterialSwitch motion={motionEnabled} label="Autosave" checked={autosave} onChange={setAutosave} /></label>
        <label className="switch-row"><span><strong>Typewriter scrolling</strong><small>Off by default · Keep the active line centered while typing (Ctrl+Alt+T)</small></span><MaterialSwitch motion={motionEnabled} label="Typewriter scrolling" checked={typewriterScroll} onChange={setTypewriterScroll} /></label>
        <label className="switch-row"><span><strong>Expressive motion</strong><small>{systemReduceMotion ? "Disabled by your system reduced-motion preference" : "Spring transitions, shape-shifting controls, and fluid sheets"}</small></span><MaterialSwitch motion={motionEnabled} label="Expressive motion" checked={motionEnabled} disabled={Boolean(systemReduceMotion)} onChange={(enabled) => setReduceMotion(!enabled)} /></label>
        <label className="switch-row"><span><strong>Spell check</strong><small>Offline English spelling suggestions in Source and Live editing</small></span><MaterialSwitch motion={motionEnabled} label="Spell check" checked={spellCheck} onChange={setSpellCheck} /></label>
        <label className="switch-row"><span><strong>Grammar check</strong><small>Offline repeated-word and article checks in Source and Live editing</small></span><MaterialSwitch motion={motionEnabled} label="Grammar check" checked={grammarCheck} onChange={setGrammarCheck} /></label>
        {draftWindows.length > 0 && <div className="draft-recovery"><strong>Recover another window</strong><small>Untitled notes from previously closed windows</small><div>{draftWindows.map((label) => <button key={label} onClick={() => openNewWindow(label)}>Open draft {label.slice(-8)}</button>)}</div></div>}
        {trustedImageHosts.length > 0 && <div className="trusted-domains"><span>Trusted image domains: {trustedImageHosts.join(", ")}</span><button onClick={() => setTrustedImageHosts([])}>Clear</button></div>}
        <p className="help">Alt+click adds cursors. Ctrl+Alt+↑/↓ adds cursors by line. Ctrl+F opens search and replace.</p>
      </motion.aside></motion.div>}</AnimatePresence>
      <AnimatePresence>{showExport && <motion.div key="export" className="scrim" initial={motionEnabled ? { opacity: 0 } : false} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: motionEnabled ? .24 : 0 }} onMouseDown={() => { if (!exporting) setShowExport(false); }}><motion.aside className="sheet export-sheet" role="dialog" aria-modal="true" aria-label="Export settings" initial={motionEnabled ? { opacity: 0, y: 40, scale: .9, borderRadius: 44 } : false} animate={{ opacity: 1, y: 0, scale: 1, borderRadius: 28 }} exit={motionEnabled ? { opacity: 0, y: 18, scale: .96 } : { opacity: 0 }} transition={motionEnabled ? spring.sheet : { duration: 0 }} onMouseDown={(event) => event.stopPropagation()}>
        <div className="sheet-title"><h2>Export your note</h2><button onClick={() => setShowExport(false)} disabled={exporting} aria-label="Close export settings"><XIcon size={20} /></button></div>
        <div className="segmented export-formats" aria-label="Export format"><motion.i className="export-format-indicator" animate={{ x: exportFormat === "fmd" ? "100%" : "0%" }} transition={motionEnabled ? spring.selector : { duration: 0 }} />{(["pdf", "fmd"] as const).map((format) => <button key={format} aria-pressed={exportFormat === format} className={exportFormat === format ? "active" : ""} disabled={exporting} onClick={() => { setExportFormat(format); setExportError(""); }}><span>{format === "pdf" ? "PDF document" : "Portable FMD"}</span></button>)}</div>
        <p className="help">{exportFormat === "pdf" ? "The embedded Typst engine paginates text, tables and vector equations. Charts use your current slider values. Run Python cells first to include their figures. The preview DOM is not printed." : "One editable file with your Markdown and images together. Reopen it in Super MD to edit, drop in images, or select an image to replace or remove it. Image data stays out of Source mode."}</p>
        {exportFormat === "pdf" && <><div className="form-grid">
          <MaterialSelect label="Document font" motion={motionEnabled} value={exportOptions.fontFamily} options={pdfFonts.map(font => ({ value: font, label: font }))} onChange={(value) => setExportOptions({ ...exportOptions, fontFamily: value })} />
          <MaterialSelect label="Page size" motion={motionEnabled} value={exportOptions.pageSize} options={[{ value: "a4", label: "A4" }, { value: "a5", label: "A5" }, { value: "letter", label: "US Letter" }, { value: "legal", label: "US Legal" }]} onChange={(value) => setExportOptions({ ...exportOptions, pageSize: value as ExportOptions["pageSize"] })} />
          <label>Margin (mm)<input type="number" min="4" max="60" value={exportOptions.margin} onChange={(event) => setExportOptions({ ...exportOptions, margin: Number(event.target.value) })} /></label>
          <label>Font size (pt)<input type="number" min="7" max="24" step="0.5" value={exportOptions.fontSize} onChange={(event) => setExportOptions({ ...exportOptions, fontSize: Number(event.target.value) })} /></label>
          <label>Line height<input type="number" min="0.9" max="2.2" step="0.05" value={exportOptions.lineHeight} onChange={(event) => setExportOptions({ ...exportOptions, lineHeight: Number(event.target.value) })} /></label>
        </div>
        <div className="switch-row"><span><strong>Page numbers</strong><small>Include page numbers in the PDF footer</small></span><MaterialSwitch motion={motionEnabled} label="Page numbers" checked={exportOptions.pageNumbers} onChange={(checked) => setExportOptions({ ...exportOptions, pageNumbers: checked })} /></div></>}
        {exportError && <pre className="export-error" role="alert">{exportError}</pre>}
        <MaterialButton className="primary-action" motion={motionEnabled} onClick={exportPdf} disabled={exporting}>{exporting ? exportFormat === "pdf" ? "Typesetting…" : "Packing images…" : "Choose destination & export"}</MaterialButton>
      </motion.aside></motion.div>}</AnimatePresence>
      {showWelcome && <WelcomeSetup theme={normalTheme} onTheme={setNormalTheme} readerFont={readerFont} onReaderFont={setReaderFont} motionEnabled={motionEnabled} onMotion={(enabled) => setReduceMotion(!enabled)} onFinish={(openFile) => { localStorage.setItem("setup.complete", "true"); localStorage.removeItem("setup.started"); setShowWelcome(false); if (openFile) window.setTimeout(() => open(), 100); }} />}
      <ImageViewer />
      <MediaTools key={activeTab.id} documentId={activeTab.id} content={content} renderedContent={pinnedAnalysis?.source} documentPath={path} onInsert={insertMedia} onNotice={flash} />
    </div>
    </MotionConfig>
  );
}
