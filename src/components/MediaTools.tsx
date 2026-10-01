import { useEffect, useRef, useState } from "react";
import { imageMarkdown, importImageFiles, importImageUrl, linkDetails, markdownLabel, prepareFmd, type ImportedImage, type LinkDetails } from "../documentMedia";
import { invoke } from "../nativeBridge";

export interface InsertionPoint { from: number; to: number }
function insertionPoint(): InsertionPoint | undefined {
  const request = { point: undefined as InsertionPoint | undefined };
  window.dispatchEvent(new CustomEvent("supermd-insertion-point", { detail: request }));
  const text = document.activeElement;
  if (text instanceof HTMLTextAreaElement && text.dataset.sourceStart) {
    const start = Number(text.dataset.sourceStart); return { from: start + text.selectionStart, to: start + text.selectionEnd };
  }
  return request.point;
}
declare global { interface Window { supermdInsertImages?: (images: ImportedImage[]) => void; supermdMedia?: () => void; supermdCaptureInsertion?: () => void } }
export default function MediaTools({ documentId, content, documentPath, onInsert, onNotice }: { documentId: string; content: string; documentPath: string | null; onInsert: (text: string, point?: InsertionPoint) => void; onNotice: (message: string) => void }) {
  const [open, setOpen] = useState(false); const [url, setUrl] = useState(""); const [imageMode, setImageMode] = useState(false);
  const [details, setDetails] = useState<LinkDetails | null>(null); const [thumbnail, setThumbnail] = useState(false);
  const [busy, setBusy] = useState(false); const [fetching, setFetching] = useState(false); const [error, setError] = useState("");
  const target = useRef<InsertionPoint | undefined>(undefined); const mounted = useRef(true); const reference = useRef({ onInsert, onNotice }); reference.current = { onInsert, onNotice };
  const show = (value = "") => { target.current = insertionPoint(); setUrl(value); setImageMode(false); setDetails(null); setError(""); setThumbnail(false); setOpen(true); };
  useEffect(() => {
    mounted.current = true;
    window.supermdMedia = () => show();
    window.supermdCaptureInsertion = () => { target.current = insertionPoint(); };
    window.supermdInsertImages = (images) => { reference.current.onInsert("\n\n" + images.map(imageMarkdown).join("\n\n") + "\n", target.current); setOpen(false); };
    const paste = (event: ClipboardEvent) => {
      const element = event.target as Element;
      if (!element.closest?.(".workspace,.android-document") || element.closest(".media-scrim,.cm-search")) return;
      const files = Array.from(event.clipboardData?.files || []).filter((f) => /^image\//.test(f.type));
      if (files.length) { event.preventDefault(); const point = insertionPoint(); void importImageFiles(files).then((images) => { if (mounted.current) reference.current.onInsert("\n\n" + images.map(imageMarkdown).join("\n\n") + "\n", point); }).catch((e) => reference.current.onNotice(String(e))); return; }
      const pasted = event.clipboardData?.getData("text/plain").trim() || "";
      if (/^https?:\/\/\S+$/.test(pasted)) { event.preventDefault(); show(pasted); }
    };
    const drop = (event: DragEvent) => {
      const element = event.target as Element;
      if (!element.closest?.(".workspace,.android-document") || element.closest(".media-scrim")) return;
      if ("__TAURI_INTERNALS__" in window) return; // Native desktop path drop owns image files.
      const files = Array.from(event.dataTransfer?.files || []).filter((f) => /^image\//.test(f.type) || /\.svg$/i.test(f.name));
      if (!files.length) return;
      event.preventDefault(); event.stopPropagation();
      const end = element.closest<HTMLElement>(".live-block")?.dataset.sourceEnd;
      const point = end ? { from: Number(end), to: Number(end) } : insertionPoint();
      void importImageFiles(files).then((images) => { if (mounted.current) reference.current.onInsert("\n\n" + images.map(imageMarkdown).join("\n\n") + "\n", point); }).catch((e) => reference.current.onNotice(String(e)));
    };
    const over = (event: DragEvent) => { if ((event.target as Element).closest?.(".workspace,.android-document") && Array.from(event.dataTransfer?.types || []).includes("Files")) event.preventDefault(); };
    document.addEventListener("paste", paste, true); document.addEventListener("drop", drop, true); document.addEventListener("dragover", over);
    return () => { mounted.current = false; delete window.supermdMedia; delete window.supermdInsertImages; delete window.supermdCaptureInsertion; document.removeEventListener("paste", paste, true); document.removeEventListener("drop", drop, true); document.removeEventListener("dragover", over); };
  }, [documentId]);
  useEffect(() => { setFetching(false); if (!open || imageMode || !/^https?:\/\/\S+$/.test(url)) return;
    let active = true; setFetching(true); setDetails(null);
    const timer = setTimeout(() => { void linkDetails(url).then((info) => { if (active) setDetails(info); }).catch((e) => { if (active) { setDetails({ url, title: new URL(url).hostname }); setError(`Title unavailable; you can still insert the link. ${e}`); } }).finally(() => { if (active) setFetching(false); }); }, 300);
    return () => { active = false; clearTimeout(timer); };
  }, [open, url, imageMode]);
  const insert = async () => {
    setBusy(true); setError(""); const point = target.current;
    try {
      let text: string;
      if (imageMode) text = "\n\n" + imageMarkdown(await importImageUrl(url)) + "\n";
      else { const info = details || { url, title: new URL(url).hostname }; text = `[${markdownLabel(info.title)}](<${info.url.replace(/>/g, "%3E")}>)`; if (thumbnail && info.thumbnail) text += "\n\n" + imageMarkdown(await importImageUrl(info.thumbnail)); }
      if (mounted.current) { onInsert(text, point); setOpen(false); }
    } catch (e) { if (mounted.current) setError(String(e)); } finally { if (mounted.current) setBusy(false); }
  };
  const portable = async () => { setBusy(true); setError(""); try {
    if (window.SuperMD) await invoke("request_fmd_export");
    else { const prepared = await prepareFmd(content, documentPath); const saved = await invoke<string | null>("export_fmd", prepared); if (saved) onNotice(`Portable file exported: ${saved}`); }
    if (mounted.current) setOpen(false);
  } catch (e) { if (mounted.current) setError(String(e)); } finally { if (mounted.current) setBusy(false); } };
  if (!open) return null;
  return <div className="media-scrim" onKeyDown={(e) => {
    if (e.key === "Escape" && !busy) setOpen(false);
    if (e.key === "Tab") { const inputs = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),[tabindex="0"]')); const first = inputs[0], last = inputs[inputs.length - 1]; if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); } }
  }}><section className="media-dialog" role="dialog" aria-modal="true" aria-label="Insert image or link">
    <header><h2>Insert into your note</h2><button aria-label="Close insertion" disabled={busy} onClick={() => setOpen(false)}>×</button></header>
    <label className="media-file">Choose images<input type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/avif,image/svg+xml,.svg" multiple disabled={busy} onChange={async (e) => { const files = Array.from(e.target.files || []); if (!files.length) return; setBusy(true); try { const images = await importImageFiles(files); if (mounted.current) { onInsert("\n\n" + images.map(imageMarkdown).join("\n\n") + "\n", target.current); setOpen(false); } } catch (e) { setError(String(e)); } finally { setBusy(false); } }} /></label>
    <div className="segmented"><button aria-pressed={!imageMode} onClick={() => { setImageMode(false); setError(""); }}>Link</button><button aria-pressed={imageMode} onClick={() => { setImageMode(true); setError(""); }}>Image URL</button></div>
    <label>Web address<input autoFocus type="url" value={url} onChange={(e) => { setUrl(e.target.value); setDetails(null); setError(""); }} placeholder="https://…" /></label>
    {fetching && <small role="status">Finding the link title…</small>}
    {!imageMode && details && <label>Link title<input value={details.title} onChange={(e) => setDetails({ ...details, title: e.target.value })} /></label>}
    {!imageMode && details?.thumbnail && <label className="media-check"><input type="checkbox" checked={thumbnail} onChange={(e) => setThumbnail(e.target.checked)} />Include the video thumbnail</label>}
    <small>Titles are fetched only when you paste or enter a web link here. Images are downloaded on insertion, so PDF and portable-file export can work offline.</small>
    {error && <p role="alert">{error}</p>}
    <footer><button disabled={busy} onClick={portable}>Export portable .fmd</button><button disabled={busy || !/^https?:\/\/\S+$/.test(url)} className="primary-action" onClick={insert}>{busy ? "Preparing…" : imageMode ? "Insert image" : "Insert link"}</button></footer>
    {url && !imageMode && <button disabled={busy} onClick={() => { onInsert(url, target.current); setOpen(false); }}>Paste plain URL instead</button>}
  </section></div>;
}
