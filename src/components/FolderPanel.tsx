import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CaretDown, CaretRight, FileText, Folder, FolderOpen, X } from "@phosphor-icons/react";
import { readRecent } from "../recentFiles";

interface Entry { name: string; path: string; directory: boolean }
function Branch({ root, path, activePath, filter, onOpen, depth = 0 }: { root: string; path: string; activePath: string | null; filter: string; onOpen: (path: string) => void; depth?: number }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    invoke<Entry[]>("read_directory_children", { root, path }).then((result) => { if (active) { setEntries(result); setError(""); } }).catch((reason) => active && setError(String(reason)));
    return () => { active = false; };
  }, [root, path]);
  if (error) return <p className="folder-empty" role="alert">{error}</p>;
  return <>{entries.filter((entry) => entry.directory || entry.name.toLowerCase().includes(filter.toLowerCase())).map((entry) => <div key={entry.path}>
    <button className={`folder-entry ${activePath === entry.path ? "active" : ""}`} style={{ paddingLeft: 8 + depth * 14 }} title={entry.path} aria-expanded={entry.directory ? expanded.has(entry.path) : undefined} onClick={() => entry.directory ? setExpanded((current) => { const next = new Set(current); next.has(entry.path) ? next.delete(entry.path) : next.add(entry.path); return next; }) : onOpen(entry.path)}>
      {entry.directory ? <>{expanded.has(entry.path) ? <CaretDown size={12} /> : <CaretRight size={12} />}<Folder size={16} /></> : <FileText size={16} />}<span>{entry.name}</span>
    </button>
    {entry.directory && expanded.has(entry.path) && <Branch root={root} path={entry.path} activePath={activePath} filter={filter} onOpen={onOpen} depth={depth + 1} />}
  </div>)}</>;
}

export default function FolderPanel({ root, activePath, onChoose, onHide, onOpen }: { root: string | null; activePath: string | null; onChoose: () => void; onHide: () => void; onOpen: (path: string) => void }) {
  const [filter, setFilter] = useState("");
  const [recent, setRecent] = useState(() => readRecent(localStorage));
  useEffect(() => { const update = () => setRecent(readRecent(localStorage)); window.addEventListener("supermd-recents", update); window.addEventListener("storage", update); return () => { window.removeEventListener("supermd-recents", update); window.removeEventListener("storage", update); }; }, []);
  return <aside className="folder-panel" aria-label="Folder explorer"><header><strong title={root ?? "Files"}>{root?.split(/[\\/]/).pop() || "Files"}</strong><button onClick={onChoose} title="Open folder" aria-label="Open folder"><FolderOpen size={18} /></button><button onClick={onHide} title="Hide sidebar · Ctrl+B" aria-label="Hide sidebar"><X size={16} /></button></header>
    {recent.length > 0 && <section className="recent-files" aria-label="Recently opened files"><div><strong>Recent files</strong><button onClick={() => { localStorage.removeItem("recent.files"); window.dispatchEvent(new Event("supermd-recents")); }}>Clear</button></div>{recent.map((file) => <button className="folder-entry" key={file.path} title={file.path} onClick={() => onOpen(file.path)}><FileText size={16} /><span>{file.name}</span></button>)}</section>}
    {root ? <><input aria-label="Filter file names" placeholder="Filter names in expanded folders" value={filter} onChange={(e) => setFilter(e.target.value)} /><div className="folder-tree"><Branch root={root} path={root} activePath={activePath} filter={filter} onOpen={onOpen} /></div></> : <div className="folder-empty"><p>Open any folder to browse your notes. No vault or metadata files.</p><button onClick={onChoose}>Open folder</button></div>}
  </aside>;
}
