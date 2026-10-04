import { useEffect, useRef, useState } from "react";
import { imageMarkdown, imageRanges, importImageFiles, importImageUrl, linkDetails, markdownLabel, safeHostname, type ImportedImage, type LinkDetails } from "../documentMedia";
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
  const [thumbnailPreview,setThumbnailPreview] = useState("");
  const [thumbnailError,setThumbnailError] = useState("");
  const [busy, setBusy] = useState(false); const [fetching, setFetching] = useState(false); const [error, setError] = useState("");
  const [replacement, setReplacement] = useState(false);
  const [removed, setRemoved] = useState<{ from: number; text: string; expected: string } | null>(null);
  const target = useRef<InsertionPoint | undefined>(undefined); const targetSource = useRef(content); const replacing = useRef(false); const mounted = useRef(true); const reference = useRef({ onInsert, onNotice, content }); reference.current = { onInsert, onNotice, content };
  const commitImages = (images: ImportedImage[]) => {
    if (replacing.current && reference.current.content !== targetSource.current) { reference.current.onNotice("The note changed while importing. Select the image again to replace it safely."); return; }
    reference.current.onInsert((replacing.current ? "" : "\n\n") + images.map(imageMarkdown).join("\n\n") + (replacing.current ? "" : "\n"), target.current); setOpen(false);
  };
  const show = (value = "") => { target.current = insertionPoint(); replacing.current = false; setReplacement(false); setUrl(value); setImageMode(false); setDetails(null); setError(""); setThumbnail(false); setOpen(true); };
  useEffect(() => {
    mounted.current = true;
    window.supermdMedia = () => show();
    window.supermdCaptureInsertion = () => { target.current = insertionPoint(); replacing.current = false; };
    window.supermdInsertImages = commitImages;
    const editImage = (event: Event) => {
      const { action, image } = (event as CustomEvent<{ action: string; image: HTMLElement }>).detail;
      if (!image?.isConnected) return;
      const block = image.closest<HTMLElement>(".live-block");
      const root = block || image.closest(".workspace,.android-document"); if (!root) return;
      const source = image.dataset.noteImageSource;
      const normalize = (url: string) => { try { return decodeURI(url); } catch { return url; } };
      const candidates = imageRanges(reference.current.content).filter((range) => normalize(range.source) === normalize(source || "") && (!block || range.from >= Number(block.dataset.sourceStart) && range.to <= Number(block.dataset.sourceEnd)));
      const siblings = Array.from(root.querySelectorAll<HTMLElement>("[data-note-image-source]")).filter((node) => normalize(node.dataset.noteImageSource || "") === normalize(source || ""));
      const range = candidates[siblings.indexOf(image)];
      if (!range) { reference.current.onNotice("Couldn't locate this image in the source. Use Source mode to edit its reference."); return; }
      target.current = { from: range.from, to: range.to };
      if (action === "remove") {
        const current = reference.current.content; setRemoved({ from: range.from, text: current.slice(range.from, range.to), expected: current.slice(0, range.from) + current.slice(range.to) });
        reference.current.onInsert("", target.current);
      } else { replacing.current = true; targetSource.current = reference.current.content; setReplacement(true); setImageMode(true); setUrl(""); setDetails(null); setError(""); setOpen(true); }
    };
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
    document.addEventListener("paste", paste, true); document.addEventListener("drop", drop, true); document.addEventListener("dragover", over); window.addEventListener("supermd-image-edit", editImage);
    return () => { mounted.current = false; delete window.supermdMedia; delete window.supermdInsertImages; delete window.supermdCaptureInsertion; document.removeEventListener("paste", paste, true); document.removeEventListener("drop", drop, true); document.removeEventListener("dragover", over); window.removeEventListener("supermd-image-edit", editImage); };
  }, [documentId]);
  useEffect(() => { setFetching(false); if (!open || imageMode || !/^https?:\/\/\S+$/.test(url)) return;
    let active = true; setFetching(true); setDetails(null);
    const timer = setTimeout(() => { void linkDetails(url).then((info) => { if (active) setDetails(info); }).catch((e) => { if (active) { setDetails({ url, title: safeHostname(url) }); setError(`Title unavailable; you can still insert the link. ${e}`); } }).finally(() => { if (active) setFetching(false); }); }, 300);
    return () => { active = false; clearTimeout(timer); };
  }, [open, url, imageMode]);
  useEffect(()=> {
    let active = true;
    setThumbnailPreview(""); setThumbnailError("");
    if (open && !imageMode && thumbnail && details?.thumbnail) {
      void invoke<{body:string}>("fetch_resource",{url:details.thumbnail,image:true})
        .then(result=>{if(active) setThumbnailPreview(result.body);})
        .catch(reason=>{if(active) setThumbnailError(String(reason));});
    }
    return ()=>{active=false;};
  },[open,imageMode,thumbnail,details?.thumbnail]);
  const insert = async () => {
    setBusy(true); setError(""); const point = target.current;
    try {
      let text: string;
      if (imageMode) text = (replacement ? "" : "\n\n") + imageMarkdown(await importImageUrl(url)) + (replacement ? "" : "\n");
      else { const info = details || { url, title: safeHostname(url) }; text = `[${markdownLabel(info.title)}](<${info.url.replace(/>/g, "%3E")}>)`; if (thumbnail && info.thumbnail) text += "\n\n" + imageMarkdown(await importImageUrl(info.thumbnail)); }
      if (mounted.current) {
        if (replacement && reference.current.content !== targetSource.current) throw new Error("The note changed while importing. Select the image again to replace it safely.");
        onInsert(text, point); setOpen(false);
      }
    } catch (e) { if (mounted.current) setError(String(e)); } finally { if (mounted.current) setBusy(false); }
  };
  if (!open) return removed && content === removed.expected ? <div className="media-undo" role="status">Image removed<button onClick={() => { onInsert(removed.text, { from: removed.from, to: removed.from }); setRemoved(null); }}>Undo</button><button aria-label="Dismiss image undo" onClick={() => setRemoved(null)}>×</button></div> : null;
  return <div className="media-scrim" onKeyDown={(e) => {
    if (e.key === "Escape" && !busy) setOpen(false);
    if (e.key === "Tab") { const inputs = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),[tabindex="0"]')); const first = inputs[0], last = inputs[inputs.length - 1]; if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); } }
  }}><section className="media-dialog" role="dialog" aria-modal="true" aria-label="Insert image or link">
    <header><h2>{replacement ? "Replace image" : "Insert into your note"}</h2><button aria-label="Close insertion" disabled={busy} onClick={() => setOpen(false)}>×</button></header>
    <label className="media-file">Choose images<input type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/avif,image/svg+xml,.svg" multiple={!replacement} disabled={busy} onChange={async (e) => { const files = Array.from(e.target.files || []); if (!files.length) return; setBusy(true); try { const images = await importImageFiles(files); if (mounted.current) commitImages(images); } catch (e) { if (mounted.current) setError(String(e)); } finally { if (mounted.current) setBusy(false); } }} /></label>
    {!replacement && <div className="segmented"><button aria-pressed={!imageMode} onClick={() => { setImageMode(false); setError(""); }}>Link</button><button aria-pressed={imageMode} onClick={() => { setImageMode(true); setError(""); }}>Image URL</button></div>}
    <label>Web address<input autoFocus type="url" value={url} onChange={(e) => { setUrl(e.target.value); setDetails(null); setError(""); }} placeholder="https://…" /></label>
    {fetching && <small role="status">Finding the link title…</small>}
    {!imageMode && details && <label>Link title<input value={details.title} onChange={(e) => setDetails({ ...details, title: e.target.value })} /></label>}
    {!imageMode && details?.thumbnail && <label className="media-check"><input type="checkbox" checked={thumbnail} onChange={(e) => setThumbnail(e.target.checked)} />Include the video thumbnail</label>}
    {!imageMode && thumbnail && details?.thumbnail && (thumbnailPreview ? <img className="link-thumbnail-preview" src={thumbnailPreview} alt={`Thumbnail preview: ${details.title}`} /> : <small role="status">{thumbnailError ? `Thumbnail preview unavailable: ${thumbnailError}` : "Loading thumbnail preview…"}</small>)}
    <small>Titles are fetched only when you paste or enter a web link here. Images are downloaded on insertion, so PDF and portable-file export can work offline.</small>
    {error && <p role="alert">{error}</p>}
    <footer><button disabled={busy || !/^https?:\/\/\S+$/.test(url)} className="primary-action" onClick={insert}>{busy ? "Preparing…" : replacement ? "Replace image" : imageMode ? "Insert image" : "Insert link"}</button></footer>
    {url && !imageMode && <button disabled={busy} onClick={() => { onInsert(url, target.current); setOpen(false); }}>Paste plain URL instead</button>}
  </section></div>;
}
