import { useEffect, useRef, useState } from "react";
import { imageMarkdown, imageRanges, importImageFiles, importImageUrl, linkDetails, markdownLabel, safeHostname, type ImportedImage, type LinkDetails } from "../documentMedia";
import { invoke } from "../nativeBridge";
import { alignRangeToCurrentSource } from "../revisionEdit";

export interface InsertionPoint { from: number; to: number }
interface CapturedPoint extends InsertionPoint { baseSource: string }
function insertionPoint(currentSource: string): CapturedPoint | undefined {
  const request = { point: undefined as InsertionPoint | undefined };
  window.dispatchEvent(new CustomEvent("supermd-insertion-point", { detail: request }));
  const text = document.activeElement;
  if (text instanceof HTMLTextAreaElement && text.dataset.sourceStart) {
    const start = Number(text.dataset.sourceStart); return { from: start + text.selectionStart, to: start + text.selectionEnd, baseSource: currentSource };
  }
  return request.point ? { ...request.point, baseSource: currentSource } : undefined;
}
function resolveCapturedPoint(captured: CapturedPoint | undefined, currentSource: string): InsertionPoint | undefined | null {
  if (!captured) return undefined;
  return alignRangeToCurrentSource(captured.baseSource, currentSource, captured.from, captured.to);
}
declare global { interface Window { supermdInsertImages?: (images: ImportedImage[]) => void; supermdMedia?: () => void; supermdCaptureInsertion?: () => void } }
export default function MediaTools({ documentId, content, renderedContent, documentPath, onInsert, onNotice }: { documentId: string; content: string; renderedContent?: string; documentPath: string | null; onInsert: (text: string, point?: InsertionPoint) => void; onNotice: (message: string) => void }) {
  const [open, setOpen] = useState(false); const [url, setUrl] = useState(""); const [imageMode, setImageMode] = useState(false);
  const [details, setDetails] = useState<LinkDetails | null>(null); const [thumbnail, setThumbnail] = useState(false);
  const [thumbnailPreview,setThumbnailPreview] = useState("");
  const [thumbnailError,setThumbnailError] = useState("");
  const [busy, setBusy] = useState(false); const [fetching, setFetching] = useState(false); const [error, setError] = useState("");
  const [replacement, setReplacement] = useState(false);
  const [removed, setRemoved] = useState<{ from: number; text: string; expected: string } | null>(null);
  const target = useRef<CapturedPoint | undefined>(undefined); const replacing = useRef(false); const mounted = useRef(true);
  const reference = useRef({ onInsert, onNotice, content, renderedContent: renderedContent ?? content });
  reference.current = { onInsert, onNotice, content, renderedContent: renderedContent ?? content };
  // Release captured source references once the dialog closes so large notes
  // are never retained beyond an active insertion/replacement dialog.
  useEffect(() => { if (!open) target.current = undefined; }, [open]);
  useEffect(() => { if (removed && content !== removed.expected) setRemoved(null); }, [content, removed]);
  const commitImages = (images: ImportedImage[]) => {
    if (!images.length) return;
    const aligned = resolveCapturedPoint(target.current, reference.current.content);
    if (aligned === null || (replacing.current && !aligned)) { reference.current.onNotice("The note changed while importing. Select the image again to replace it safely."); return; }
    reference.current.onInsert((replacing.current ? "" : "\n\n") + images.map(imageMarkdown).join("\n\n") + (replacing.current ? "" : "\n"), aligned); setOpen(false);
  };
  const show = (value = "") => { target.current = insertionPoint(reference.current.content); replacing.current = false; setReplacement(false); setUrl(value); setImageMode(false); setDetails(null); setError(""); setThumbnail(false); setOpen(true); };
  useEffect(() => {
    mounted.current = true;
    window.supermdMedia = () => show();
    window.supermdCaptureInsertion = () => { target.current = insertionPoint(reference.current.content); replacing.current = false; };
    window.supermdInsertImages = commitImages;
    const editImage = (event: Event) => {
      const { action, image } = (event as CustomEvent<{ action: string; image: HTMLElement }>).detail;
      if (!image?.isConnected) return;
      const block = image.closest<HTMLElement>(".live-block");
      const root = block || image.closest(".workspace,.android-document"); if (!root) return;
      const source = image.dataset.noteImageSource;
      const normalize = (url: string) => { try { return decodeURI(url); } catch { return url; } };
      const baseSource = reference.current.renderedContent;
      const blockStart = block ? Number(block.dataset.renderedStart ?? block.dataset.sourceStart) : -Infinity;
      const blockEnd = block ? Number(block.dataset.renderedEnd ?? block.dataset.sourceEnd) : Infinity;
      const candidates = imageRanges(baseSource).filter((range) => normalize(range.source) === normalize(source || "") && (!block || range.from >= blockStart && range.to <= blockEnd));
      const siblings = Array.from(root.querySelectorAll<HTMLElement>("[data-note-image-source]")).filter((node) => normalize(node.dataset.noteImageSource || "") === normalize(source || ""));
      const baseRange = candidates[siblings.indexOf(image)];
      if (!baseRange) { reference.current.onNotice("Couldn't locate this image in the source. Use Source mode to edit its reference."); return; }
      const aligned = alignRangeToCurrentSource(baseSource, reference.current.content, baseRange.from, baseRange.to);
      if (!aligned) { reference.current.onNotice("The note changed while updating the preview. Wait a moment or edit this image in Source mode."); return; }
      if (action === "remove") {
        const current = reference.current.content; setRemoved({ from: aligned.from, text: current.slice(aligned.from, aligned.to), expected: current.slice(0, aligned.from) + current.slice(aligned.to) });
        reference.current.onInsert("", aligned);
      } else { replacing.current = true; target.current = { from: aligned.from, to: aligned.to, baseSource: reference.current.content }; setReplacement(true); setImageMode(true); setUrl(""); setDetails(null); setError(""); setOpen(true); }
    };
    const paste = (event: ClipboardEvent) => {
      const element = event.target as Element;
      if (!element.closest?.(".workspace,.android-document") || element.closest(".media-scrim,.cm-search,.theme-guide-dialog")) return;
      const files = Array.from(event.clipboardData?.files || []).filter((f) => /^image\//.test(f.type));
      if (files.length) { event.preventDefault(); const captured = insertionPoint(reference.current.content); void importImageFiles(files).then((images) => { if (!mounted.current) return; const aligned = resolveCapturedPoint(captured, reference.current.content); if (aligned === null) { reference.current.onNotice("The note changed around the cursor while importing. Paste the image again."); return; } reference.current.onInsert("\n\n" + images.map(imageMarkdown).join("\n\n") + "\n", aligned); }).catch((e) => reference.current.onNotice(String(e))); return; }
      const pasted = event.clipboardData?.getData("text/plain").trim() || "";
      if (/^https?:\/\/\S+$/.test(pasted)) { event.preventDefault(); show(pasted); }
    };
    let internalDrag = false;
    const dragStart = (event: DragEvent) => {
      const element = event.target instanceof Element ? event.target : null;
      internalDrag = !!element?.closest(".workspace,.android-document");
      // A browser can turn an embedded/data-URL image drag into a File.
      // Viewing or panning a rendered image must never re-import it into the note.
      if (element?.closest(".markdown-body img,.markdown-body svg,.image-viewer")) {
        event.preventDefault(); event.stopPropagation();
        // Cancelled drags do not receive dragend. Do not poison the next real
        // external file drop with a stale internal-drag flag.
        queueMicrotask(() => { internalDrag = false; });
      }
    };
    const dragEnd = () => { internalDrag = false; };
    const drop = (event: DragEvent) => {
      const element = event.target as Element;
      const fromDocument = internalDrag; internalDrag = false;
      if (!element.closest?.(".workspace,.android-document")) return;
      if (fromDocument || element.closest(".image-viewer,.math-repair-panel,.reading-search,.media-scrim,.theme-guide-dialog")) {
        // Preserve ordinary text drag/drop inside Source/Live editors. Only
        // suppress file-bearing internal drops and drops on read-only overlays.
        if (Array.from(event.dataTransfer?.types || []).includes("Files")) { event.preventDefault(); event.stopPropagation(); }
        return;
      }
      if ("__TAURI_INTERNALS__" in window) return; // Native desktop path drop owns image files.
      const files = Array.from(event.dataTransfer?.files || []).filter((f) => /^image\//.test(f.type) || /\.svg$/i.test(f.name));
      if (!files.length) return;
      event.preventDefault(); event.stopPropagation();
      const liveBlock = element.closest<HTMLElement>(".live-block");
      const renderedEnd = liveBlock?.dataset.renderedEnd ?? liveBlock?.dataset.sourceEnd;
      const captured: CapturedPoint | undefined = renderedEnd !== undefined
        ? { from: Number(renderedEnd), to: Number(renderedEnd), baseSource: liveBlock?.dataset.renderedEnd !== undefined ? reference.current.renderedContent : reference.current.content }
        : insertionPoint(reference.current.content);
      void importImageFiles(files).then((images) => { if (!mounted.current) return; const aligned = resolveCapturedPoint(captured, reference.current.content); if (aligned === null) { reference.current.onNotice("The note changed while importing the dropped image. Drop it again."); return; } reference.current.onInsert("\n\n" + images.map(imageMarkdown).join("\n\n") + "\n", aligned); }).catch((e) => reference.current.onNotice(String(e)));
    };
    const over = (event: DragEvent) => { if ((event.target as Element).closest?.(".workspace,.android-document") && Array.from(event.dataTransfer?.types || []).includes("Files")) event.preventDefault(); };
    document.addEventListener("paste", paste, true); document.addEventListener("dragstart", dragStart, true); document.addEventListener("dragend", dragEnd, true); document.addEventListener("drop", drop, true); document.addEventListener("dragover", over); window.addEventListener("supermd-image-edit", editImage);
    return () => { mounted.current = false; delete window.supermdMedia; delete window.supermdInsertImages; delete window.supermdCaptureInsertion; document.removeEventListener("paste", paste, true); document.removeEventListener("dragstart", dragStart, true); document.removeEventListener("dragend", dragEnd, true); document.removeEventListener("drop", drop, true); document.removeEventListener("dragover", over); window.removeEventListener("supermd-image-edit", editImage); };
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
    setBusy(true); setError(""); const captured = target.current;
    try {
      let text: string;
      if (imageMode) text = (replacement ? "" : "\n\n") + imageMarkdown(await importImageUrl(url)) + (replacement ? "" : "\n");
      else { const info = details || { url, title: safeHostname(url) }; text = `[${markdownLabel(info.title)}](<${info.url.replace(/>/g, "%3E")}>)`; if (thumbnail && info.thumbnail) text += "\n\n" + imageMarkdown(await importImageUrl(info.thumbnail)); }
      if (mounted.current) {
        const aligned = resolveCapturedPoint(captured, reference.current.content);
        if (aligned === null || (replacement && !aligned)) throw new Error("The note changed while importing. Select the image again to replace it safely.");
        onInsert(text, aligned); setOpen(false);
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
    {url && !imageMode && <button disabled={busy} onClick={() => { const aligned = resolveCapturedPoint(target.current, reference.current.content); if (aligned === null) { setError("The note changed while editing. Try inserting the link again."); return; } onInsert(url, aligned); setOpen(false); }}>Paste plain URL instead</button>}
  </section></div>;
}
