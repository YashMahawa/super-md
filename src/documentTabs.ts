import type { DocumentData } from "./types";

export interface DocumentTab {
  id: string;
  path: string | null;
  content: string;
  savedContent: string;
  name: string;
}

export interface DocumentWorkspace {
  tabs: DocumentTab[];
  activeId: string;
  recentlyClosed: DocumentTab[];
}

const id = () => crypto.randomUUID();

export function untitledTab(content = "", name = "Untitled.smd"): DocumentTab {
  return { id: id(), path: null, content, savedContent: content, name };
}

export function tabTitle(tab: DocumentTab): string {
  return tab.path?.split(/[\\/]/).pop() || tab.name;
}

export function isDirty(tab: DocumentTab): boolean {
  return tab.content !== tab.savedContent;
}

export function initialWorkspace(content = "", name = "Untitled.smd"): DocumentWorkspace {
  const tab = untitledTab(content, name);
  return { tabs: [tab], activeId: tab.id, recentlyClosed: [] };
}

export function addTab(state: DocumentWorkspace, tab = untitledTab()): DocumentWorkspace {
  return { ...state, tabs: [...state.tabs, tab], activeId: tab.id };
}

export function openTab(state: DocumentWorkspace, document: DocumentData): DocumentWorkspace {
  const existing = state.tabs.find((tab) => tab.path === document.path);
  if (existing) return { ...state, activeId: existing.id };
  const tab: DocumentTab = { id: id(), path: document.path, content: document.content, savedContent: document.content, name: document.path.split(/[\\/]/).pop() || "Untitled.smd" };
  return addTab(state, tab);
}

export function editTab(state: DocumentWorkspace, tabId: string, content: string): DocumentWorkspace {
  return { ...state, tabs: state.tabs.map((tab) => tab.id === tabId ? { ...tab, content } : tab) };
}

export function markTabSaved(state: DocumentWorkspace, tabId: string, path: string, savedContent: string): DocumentWorkspace {
  return { ...state, tabs: state.tabs.map((tab) => tab.id === tabId ? { ...tab, path, name: path.split(/[\\/]/).pop() || tab.name, savedContent } : tab) };
}

export function closeTab(state: DocumentWorkspace, tabId: string): DocumentWorkspace {
  const index = state.tabs.findIndex((tab) => tab.id === tabId);
  if (index < 0) return state;
  const tab = state.tabs[index];
  const tabs = state.tabs.filter((item) => item.id !== tabId);
  const next = tabs.length ? tabs : [untitledTab()];
  return {
    tabs: next,
    activeId: state.activeId === tabId ? next[Math.min(index, next.length - 1)].id : state.activeId,
    recentlyClosed: [tab, ...state.recentlyClosed].slice(0, 12),
  };
}

export function restoreClosedTab(state: DocumentWorkspace): DocumentWorkspace {
  const [tab, ...recentlyClosed] = state.recentlyClosed;
  return tab ? { tabs: [...state.tabs, tab], activeId: tab.id, recentlyClosed } : state;
}

export function readWorkspace(storage: Pick<Storage, "getItem">, key: string, fallback: DocumentWorkspace): DocumentWorkspace {
  try {
    const parsed = JSON.parse(storage.getItem(key) || "null") as DocumentWorkspace | null;
    if (!parsed || !Array.isArray(parsed.tabs) || !parsed.tabs.length || !parsed.tabs.every((tab) =>
      typeof tab.id === "string" && typeof tab.content === "string" && typeof tab.savedContent === "string" &&
      typeof tab.name === "string" && (tab.path === null || typeof tab.path === "string"))) return fallback;
    return {
      tabs: parsed.tabs,
      activeId: parsed.tabs.some((tab) => tab.id === parsed.activeId) ? parsed.activeId : parsed.tabs[0].id,
      recentlyClosed: Array.isArray(parsed.recentlyClosed) ? parsed.recentlyClosed.slice(0, 12) : [],
    };
  } catch { return fallback; }
}
