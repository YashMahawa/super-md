import { useEffect, useRef, useState } from "react";
import { imageMarkdown, imageRanges, importImageFiles, importImageUrl, linkDetails, markdownLabel, safeHostname, type ImportedImage, type LinkDetails } from "../documentMedia";
import { invoke } from "../nativeBridge";
import { sourceChanges, type SourceChange } from "../readerEdits";
import { alignRangeToCurrentSource } from "../revisionEdit";
import { setReaderOverlay } from "../readerOverlays";

export interface InsertionPoint { from: number; to: number }
export interface PendingInsertion {
  documentId: string;
  revision: number;
  tabSwitchEpoch: number;
  baseContent: string;
  point: InsertionPoint | undefined;
  replacing: boolean;
  expectedSlice: string | null;
}
interface RevisionStep {
  fromRevision: number;
  toRevision: number;
  changes: Array<SourceChange & { deletedNewline: boolean; nextNewlineAfterTo: number }>;
}
interface DocumentRevisionState {
  documentId: string;
  tabSwitchEpoch: number;
  revision: number;
  content: string;
  history: RevisionStep[];
}
const MAX_REVISION_HISTORY = 256;
const OVERLAY_SELECTOR = ".welcome-scrim,.image-viewer,.math-repair-panel,.repair-scrim,.reading-search,.media-scrim,.media-dialog,.theme-guide-dialog,.theme-guide-scrim,.media-save-menu,.reader-export-backdrop,.cm-search";
const SUPPORTED_DROP_IMAGE_MIME = /^image\/(png|jpeg|gif|webp|avif|svg\+xml)$/i;
const SUPPORTED_DROP_IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|svg)$/i;
export const UNSUPPORTED_DROP_MESSAGE = "Only supported images (PNG, JPEG, GIF, WebP, AVIF, or SVG) can be dropped into a note.";
export const SWITCHED_NOTE_IMPORT_MESSAGE = "Image import cancelled because you switched notes before it finished.";
export const STALE_INSERTION_MESSAGE = "The note changed at the insertion point while importing; drop the image again to insert it safely.";
const STALE_REPLACEMENT_MESSAGE = "The note changed while importing. Select the image again to replace it safely.";
function remapPointAcrossStep(point: InsertionPoint, step: RevisionStep, replacing: boolean): InsertionPoint | null {
  let { from, to } = point;
  for (const change of step.changes) {
    const delta = change.insert.length - (change.to - change.from);
    if (replacing || from < to) {
      if (change.to <= from) {
        from += delta;
        to += delta;
      } else if (change.from < to) {
        return null;
      }
      continue;
    }
    if (change.from === change.to) {
      if (change.from <= from) {
        from += change.insert.length;
        to = from;
      }
      continue;
    }
    if (change.from <= from && change.to >= from) return null;
    if (change.to < from) {
      if (change.deletedNewline && (change.nextNewlineAfterTo === -1 || change.nextNewlineAfterTo >= from)) {
        return null;
      }
      from += delta;
      to = from;
    }
  }
  return { from, to };
}
function resolvePendingInsertion(
  pending: PendingInsertion,
  state: DocumentRevisionState,
): { ok: true; point: InsertionPoint | undefined } | { ok: false; message: string } {
  const staleMessage = pending.replacing ? STALE_REPLACEMENT_MESSAGE : STALE_INSERTION_MESSAGE;
  if (pending.documentId !== state.documentId) {
    return { ok: false, message: pending.replacing ? STALE_REPLACEMENT_MESSAGE : SWITCHED_NOTE_IMPORT_MESSAGE };
  }
  if (pending.tabSwitchEpoch !== state.tabSwitchEpoch) {
    if (state.content === pending.baseContent) return { ok: true, point: pending.point };
    return { ok: false, message: staleMessage };
  }
  if (state.revision === pending.revision && state.content === pending.baseContent) {
    return { ok: true, point: pending.point };
  }
  const startPoint = pending.point ?? { from: pending.baseContent.length, to: pending.baseContent.length };
  let cursorRev = pending.revision;
  let currentPoint: InsertionPoint | null = startPoint;
  for (const step of state.history) {
    if (step.toRevision <= cursorRev) continue;
    if (step.fromRevision !== cursorRev) return { ok: false, message: staleMessage };
    currentPoint = remapPointAcrossStep(currentPoint, step, pending.replacing);
    if (!currentPoint) return { ok: false, message: staleMessage };
    cursorRev = step.toRevision;
  }
  if (cursorRev !== state.revision) return { ok: false, message: staleMessage };
  if (currentPoint.from < 0 || currentPoint.to < currentPoint.from || currentPoint.to > state.content.length) {
    return { ok: false, message: staleMessage };
  }
  if (pending.replacing && pending.expectedSlice !== null && state.content.slice(currentPoint.from, currentPoint.to) !== pending.expectedSlice) {
    return { ok: false, message: STALE_REPLACEMENT_MESSAGE };
  }
  if (pending.point === undefined && currentPoint.from === state.content.length && currentPoint.to === state.content.length) {
    return { ok: true, point: undefined };
  }
  return { ok: true, point: currentPoint };
}
function targetElement(target: EventTarget | null): Element | null {
  return target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
}
function hasFilePayload(transfer: DataTransfer | null | undefined): boolean {
  if (!transfer) return false;
  return Array.from(transfer.types || []).includes("Files") || (transfer.files?.length ?? 0) > 0;
}
function isSupportedDroppedImage(file: File): boolean {
  const mime = file.type.split(";")[0].trim().toLowerCase();
  if (mime.startsWith("image/")) return SUPPORTED_DROP_IMAGE_MIME.test(mime);
  return (!mime || mime === "application/octet-stream" || ((mime === "text/xml" || mime === "application/xml") && /\.svg$/i.test(file.name))) && SUPPORTED_DROP_IMAGE_EXT.test(file.name);
}
function formatDroppedImages(images: ImportedImage[], point: InsertionPoint | undefined, content: string, replacing = false): string {
  const atStart = !replacing && point?.from === 0 && point?.to === 0 && content.length > 0;
  const prefix = replacing || atStart ? "" : "\n\n";
  const suffix = replacing ? "" : atStart ? (content.startsWith("\n") ? "\n" : "\n\n") : "\n";
  return prefix + images.map(imageMarkdown).join("\n\n") + suffix;
}
function sourceEndAt(element: Element | null, renderedSource: string, currentSource: string): InsertionPoint | undefined {
  if (element?.closest(".live-document")) return undefined;
  const scope = element?.closest(".step-cards-description") ? element.closest(".step-cards")?.parentElement ?? null : element;
  const block = scope?.closest<HTMLElement>(".windowed-md-block[data-source-end],p[data-source-end],li[data-source-end],h1[data-source-end],h2[data-source-end],h3[data-source-end],h4[data-source-end],h5[data-source-end],h6[data-source-end],blockquote[data-source-end],aside[data-source-end],details[data-source-end],table[data-source-end],pre[data-source-end]") || scope?.closest<HTMLElement>("[data-source-end]");
  if (block?.dataset.sourceEnd !== undefined) {
    const end = Number(block.dataset.sourceEnd);
    if (Number.isFinite(end)) {
      return alignRangeToCurrentSource(renderedSource, currentSource, end, end) ?? undefined;
    }
  }
  return undefined;
}
function insertionPoint(coords?: { x: number; y: number }, target?: Element | null): InsertionPoint | undefined {
  const request: { point?: InsertionPoint; x?: number; y?: number; target?: Element | null } = {
    point: undefined,
    ...(coords ? { x: coords.x, y: coords.y } : {}),
    ...(target ? { target } : {}),
  };
  window.dispatchEvent(new CustomEvent("supermd-insertion-point", { detail: request }));
  if (!coords) {
    const text = document.activeElement;
    if (text instanceof HTMLTextAreaElement && text.dataset.sourceStart) {
      const start = Number(text.dataset.sourceStart); return { from: start + text.selectionStart, to: start + text.selectionEnd };
    }
  }
  return request.point;
}
declare global { interface Window { supermdInsertImages?: (images: ImportedImage[]) => void; supermdMedia?: () => void; supermdCaptureInsertion?: (x?: number, y?: number) => void } }
export default function MediaTools({ documentId, content, renderedContent, documentPath: _documentPath, onInsert, onNotice }: { documentId: string; content: string; renderedContent?: string; documentPath: string | null; onInsert: (text: string, point?: InsertionPoint) => void; onNotice: (message: string) => void }) {
  const [open, setOpen] = useState(false); const [url, setUrl] = useState(""); const [imageMode, setImageMode] = useState(false);
  const [details, setDetails] = useState<LinkDetails | null>(null); const [thumbnail, setThumbnail] = useState(false);
  const [thumbnailPreview,setThumbnailPreview] = useState("");
  const [thumbnailError,setThumbnailError] = useState("");
  const [busy, setBusy] = useState(false); const [fetching, setFetching] = useState(false); const [error, setError] = useState("");
  const [replacement, setReplacement] = useState(false);
  const [removed, setRemoved] = useState<{ documentId: string; from: number; text: string; expected: string } | null>(null);
  const docStateRef = useRef<DocumentRevisionState>({ documentId, tabSwitchEpoch: 0, revision: 0, content, history: [] });
  if (docStateRef.current.documentId !== documentId) {
    docStateRef.current = { documentId, tabSwitchEpoch: docStateRef.current.tabSwitchEpoch + 1, revision: 0, content, history: [] };
  } else if (docStateRef.current.content !== content) {
    const before = docStateRef.current.content;
    const rawChanges = sourceChanges(before, content);
    const changes = rawChanges.map((change) => ({
      ...change,
      deletedNewline: change.to > change.from && before.slice(change.from, change.to).includes("\n"),
      nextNewlineAfterTo: before.indexOf("\n", change.to),
    }));
    const nextRevision = docStateRef.current.revision + 1;
    const history = [...docStateRef.current.history, { fromRevision: docStateRef.current.revision, toRevision: nextRevision, changes }];
    if (history.length > MAX_REVISION_HISTORY) history.splice(0, history.length - MAX_REVISION_HISTORY);
    docStateRef.current = { ...docStateRef.current, revision: nextRevision, content, history };
  }
  const pendingTargetRef = useRef<PendingInsertion | null>(null);
  const modalSessionRef = useRef(0);
  const mounted = useRef(true);
  const reference = useRef({ onInsert, onNotice, content, renderedContent: renderedContent ?? content, documentId });
  reference.current = { onInsert, onNotice, content, renderedContent: renderedContent ?? content, documentId };
  const openRef = useRef(open); openRef.current = open;
  const busyRef = useRef(busy); busyRef.current = busy;
  const ignoreCapturedDrop = useRef(false);
  const dialogRef = useRef<HTMLElement>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);
  const capturePending = (point: InsertionPoint | undefined, isReplacing = false): PendingInsertion => {
    const state = docStateRef.current;
    return {
      documentId: state.documentId,
      revision: state.revision,
      tabSwitchEpoch: state.tabSwitchEpoch,
      baseContent: state.content,
      point,
      replacing: isReplacing,
      expectedSlice: isReplacing && point ? state.content.slice(point.from, point.to) : null,
    };
  };
  const openModal = () => { modalSessionRef.current += 1; openRef.current = true; setReaderOverlay("media", true); setOpen(true); };
  const closeModal = (clearPending = true) => { modalSessionRef.current += 1; openRef.current = false; busyRef.current = false; if (clearPending) pendingTargetRef.current = null; setReaderOverlay("media", false); setBusy(false); setOpen(false); };
  const hasActiveOverlay = (node?: Element | null) => busyRef.current || openRef.current || document.documentElement.dataset.readerOverlay === "true" || !!node?.closest?.(OVERLAY_SELECTOR) || !!document.querySelector(".welcome-scrim,.image-viewer,.math-repair-panel,.reading-search,.media-scrim,.theme-guide-dialog,.media-save-menu,.reader-export-backdrop");
  // Release any modal-captured baseline once the modal closes cleanly on the same note.
  useEffect(() => { setReaderOverlay("media", open); }, [open]);
  useEffect(() => () => setReaderOverlay("media", false), []);
  const prevDocIdRef = useRef(documentId);
  useEffect(() => {
    if (prevDocIdRef.current === documentId) return;
    prevDocIdRef.current = documentId;
    ignoreCapturedDrop.current = false;
    if (openRef.current) closeModal(!busyRef.current);
    setRemoved(null);
    setError("");
    setDetails(null);
    setUrl("");
    setReplacement(false);
    setImageMode(false);
    setThumbnail(false);
  }, [documentId]);
  useEffect(() => {
    if (!open) return;
    urlInputRef.current?.focus({ preventScroll: true });
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault(); e.stopImmediatePropagation();
        if (!busyRef.current) closeModal();
        return;
      }
      if (e.key === "Tab" && dialogRef.current) {
        const inputs = Array.from(dialogRef.current.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),[tabindex="0"]'));
        const first = inputs[0], last = inputs[inputs.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener("keydown", key, true);
    return () => document.removeEventListener("keydown", key, true);
  }, [open]);
  useEffect(() => { if (removed && (removed.documentId !== documentId || content !== removed.expected)) setRemoved(null); }, [content, documentId, removed]);
  const commitImages = (images: ImportedImage[], pending: PendingInsertion | null) => {
    if (!images.length) return;
    if (pending) {
      const resolved = resolvePendingInsertion(pending, docStateRef.current);
      if (!resolved.ok) {
        reference.current.onNotice(resolved.message);
        closeModal();
        return;
      }
      reference.current.onInsert(formatDroppedImages(images, resolved.point, reference.current.content, pending.replacing), resolved.point);
      closeModal();
      return;
    }
    reference.current.onInsert(formatDroppedImages(images, undefined, reference.current.content, false), undefined);
    closeModal();
  };
  const show = (value = "") => { if (busyRef.current) return; ignoreCapturedDrop.current = false; pendingTargetRef.current = capturePending(insertionPoint(), false); setReplacement(false); setUrl(value); setImageMode(false); setDetails(null); setError(""); setThumbnail(false); openModal(); };
  useEffect(() => {
    mounted.current = true;
    window.supermdMedia = () => show();
    window.supermdCaptureInsertion = (x?: number, y?: number) => {
      const hasCoords = typeof x === "number" && typeof y === "number" && Number.isFinite(x) && Number.isFinite(y);
      const hit = hasCoords && typeof document.elementFromPoint === "function" ? document.elementFromPoint(x, y) : null;
      if (hasActiveOverlay(hit)) { ignoreCapturedDrop.current = true; pendingTargetRef.current = null; return; }
      ignoreCapturedDrop.current = false;
      const { content: cur, renderedContent: ren } = reference.current;
      const point = hasCoords ? (sourceEndAt(hit, ren, cur) ?? insertionPoint({ x, y }, hit)) : insertionPoint();
      pendingTargetRef.current = capturePending(point, false);
    };
    window.supermdInsertImages = (images) => {
      if (ignoreCapturedDrop.current) { ignoreCapturedDrop.current = false; pendingTargetRef.current = null; return; }
      if (busyRef.current) return;
      if (!openRef.current && hasActiveOverlay(null)) { pendingTargetRef.current = null; return; }
      const pending = pendingTargetRef.current;
      pendingTargetRef.current = null;
      commitImages(images, pending);
    };
    const editImage = (event: Event) => {
      const { action, image } = (event as CustomEvent<{ action: string; image: HTMLElement }>).detail;
      if (!image?.isConnected || image.closest(".step-cards,.theme-guide-dialog") || busyRef.current) return;
      const block = image.closest<HTMLElement>(".live-block");
      const root = block || image.closest(".workspace,.android-document"); if (!root) return;
      const source = image.dataset.noteImageSource;
      const normalize = (url: string) => { try { return decodeURI(url); } catch { return url; } };
      const baseSource = reference.current.renderedContent;
      const blockStart = block ? Number(block.dataset.renderedStart ?? block.dataset.sourceStart) : -Infinity;
      const blockEnd = block ? Number(block.dataset.renderedEnd ?? block.dataset.sourceEnd) : Infinity;
      const candidates = imageRanges(baseSource).filter((range) => normalize(range.source) === normalize(source || "") && (!block || range.from >= blockStart && range.to <= blockEnd));
      const siblings = Array.from(root.querySelectorAll<HTMLElement>("[data-note-image-source]")).filter((node) => !node.closest(".step-cards,.theme-guide-dialog") && normalize(node.dataset.noteImageSource || "") === normalize(source || ""));
      const baseRange = candidates[siblings.indexOf(image)];
      if (!baseRange) { reference.current.onNotice("Couldn't locate this image in the source. Use Source mode to edit its reference."); return; }
      const aligned = alignRangeToCurrentSource(baseSource, reference.current.content, baseRange.from, baseRange.to);
      if (!aligned) { reference.current.onNotice("The note changed while updating the preview. Wait a moment or edit this image in Source mode."); return; }
      const point = { from: aligned.from, to: aligned.to };
      if (action === "remove") {
        const current = reference.current.content; setRemoved({ documentId: reference.current.documentId, from: point.from, text: current.slice(point.from, point.to), expected: current.slice(0, point.from) + current.slice(point.to) });
        reference.current.onInsert("", point);
      } else { ignoreCapturedDrop.current = false; pendingTargetRef.current = capturePending(point, true); setReplacement(true); setImageMode(true); setUrl(""); setDetails(null); setError(""); openModal(); }
    };
    const paste = (event: ClipboardEvent) => {
      const element = targetElement(event.target);
      if (busyRef.current || !element?.closest(".workspace,.android-document") || element.closest(".media-scrim,.cm-search,.theme-guide-dialog")) return;
      const files = Array.from(event.clipboardData?.files || []).filter((f) => /^image\//.test(f.type));
      if (files.length) {
        event.preventDefault();
        const pending = capturePending(insertionPoint(), false);
        void importImageFiles(files).then((images) => {
          if (!mounted.current || !images.length) return;
          const resolved = resolvePendingInsertion(pending, docStateRef.current);
          if (!resolved.ok) {
            reference.current.onNotice(resolved.message);
            return;
          }
          reference.current.onInsert(formatDroppedImages(images, resolved.point, reference.current.content), resolved.point);
        }).catch((e) => { if (mounted.current) reference.current.onNotice(String(e)); });
      }
    };
    let internalDrag = false;
    const dragStart = (event: DragEvent) => {
      const element = targetElement(event.target);
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
      const element = targetElement(event.target);
      const fromDocument = internalDrag; internalDrag = false;
      if (element instanceof HTMLInputElement && element.type === "file") return;
      const fileDrop = hasFilePayload(event.dataTransfer);
      if (hasActiveOverlay(element)) {
        if (fileDrop) { event.preventDefault(); event.stopPropagation(); }
        return;
      }
      if (!element?.closest(".workspace,.android-document")) {
        if (fileDrop) {
          event.preventDefault(); event.stopPropagation();
          if (!fromDocument && (event.dataTransfer?.files?.length ?? 0) > 0) {
            reference.current.onNotice("Drop images inside the note area to insert them.");
          }
        }
        return;
      }
      if (fromDocument) {
        // Preserve ordinary text drag/drop inside Source/Live editors. Only
        // suppress file-bearing internal drops and drops on read-only overlays.
        if (fileDrop) { event.preventDefault(); event.stopPropagation(); }
        return;
      }
      const allFiles = Array.from(event.dataTransfer?.files || []);
      if (!fileDrop && !allFiles.length) return;
      // Consume all external file drops before CodeMirror or the browser can
      // insert raw non-image file bytes or navigate away from the note.
      event.preventDefault(); event.stopPropagation();
      if (!allFiles.length) return;
      const files = allFiles.filter(isSupportedDroppedImage);
      if (!files.length) {
        reference.current.onNotice(UNSUPPORTED_DROP_MESSAGE);
        return;
      }
      const skipped = allFiles.length - files.length;
      const coords = typeof event.clientX === "number" && typeof event.clientY === "number" && Number.isFinite(event.clientX) && Number.isFinite(event.clientY) ? { x: event.clientX, y: event.clientY } : undefined;
      const point = sourceEndAt(element, reference.current.renderedContent, reference.current.content) ?? insertionPoint(coords, element);
      const pending = capturePending(point, false);
      void importImageFiles(files).then((images) => {
        if (!mounted.current || !images.length) return;
        const resolved = resolvePendingInsertion(pending, docStateRef.current);
        if (!resolved.ok) {
          reference.current.onNotice(resolved.message);
          return;
        }
        reference.current.onInsert(formatDroppedImages(images, resolved.point, reference.current.content), resolved.point);
        if (skipped > 0) {
          reference.current.onNotice(skipped === 1 ? "Skipped 1 unsupported file; only PNG, JPEG, GIF, WebP, AVIF, and SVG images were imported." : `Skipped ${skipped} unsupported files; only PNG, JPEG, GIF, WebP, AVIF, and SVG images were imported.`);
        }
      }).catch((e) => { if (mounted.current) reference.current.onNotice(String(e)); });
    };
    const over = (event: DragEvent) => {
      const element = targetElement(event.target);
      if (element instanceof HTMLInputElement && element.type === "file") return;
      if (!hasFilePayload(event.dataTransfer)) return;
      event.preventDefault();
      if (hasActiveOverlay(element) || !element?.closest(".workspace,.android-document")) {
        try { if (event.dataTransfer) event.dataTransfer.dropEffect = "none"; } catch { /* Ignore readonly DataTransfer mocks. */ }
      }
    };
    document.addEventListener("paste", paste, true); document.addEventListener("dragstart", dragStart, true); document.addEventListener("dragend", dragEnd, true); document.addEventListener("drop", drop, true); document.addEventListener("dragover", over, true); window.addEventListener("supermd-image-edit", editImage);
    return () => { mounted.current = false; delete window.supermdMedia; delete window.supermdInsertImages; delete window.supermdCaptureInsertion; document.removeEventListener("paste", paste, true); document.removeEventListener("dragstart", dragStart, true); document.removeEventListener("dragend", dragEnd, true); document.removeEventListener("drop", drop, true); document.removeEventListener("dragover", over, true); window.removeEventListener("supermd-image-edit", editImage); };
  }, []);
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
    const session = modalSessionRef.current;
    const pending = pendingTargetRef.current ?? capturePending(undefined, replacement);
    setBusy(true); busyRef.current = true; setError("");
    try {
      let text: string;
      if (imageMode) text = (replacement ? "" : "\n\n") + imageMarkdown(await importImageUrl(url)) + (replacement ? "" : "\n");
      else { const info = details || { url, title: safeHostname(url) }; text = `[${markdownLabel(info.title)}](<${info.url.replace(/>/g, "%3E")}>)`; if (thumbnail && info.thumbnail) text += "\n\n" + imageMarkdown(await importImageUrl(info.thumbnail)); }
      if (mounted.current) {
        const resolved = resolvePendingInsertion(pending, docStateRef.current);
        if (!resolved.ok) {
          if (openRef.current && modalSessionRef.current === session) throw new Error(resolved.message);
          reference.current.onNotice(resolved.message);
          return;
        }
        reference.current.onInsert(text, resolved.point);
        closeModal();
      }
    } catch (e) { if (mounted.current && modalSessionRef.current === session) setError(String(e)); } finally { if (modalSessionRef.current === session) { busyRef.current = false; if (mounted.current) setBusy(false); } }
  };
  if (!open) return removed && removed.documentId === documentId && content === removed.expected ? <div className="media-undo" role="status">Image removed<button type="button" onClick={() => { onInsert(removed.text, { from: removed.from, to: removed.from }); setRemoved(null); }}>Undo</button><button type="button" aria-label="Dismiss image undo" onClick={() => setRemoved(null)}>×</button></div> : null;
  return <div className="media-scrim" onClick={(e) => { if (e.target === e.currentTarget && !busy) closeModal(); }}><section ref={dialogRef} className="media-dialog" role="dialog" aria-modal="true" aria-label="Insert image or link" onKeyDown={(e) => {
    if (e.key === "Enter" && !e.nativeEvent.isComposing && !(e.target instanceof HTMLButtonElement) && !(e.target instanceof HTMLInputElement && (e.target.type === "file" || e.target.type === "checkbox"))) {
      e.preventDefault();
      if (!busy && /^https?:\/\/\S+$/.test(url)) void insert();
    }
  }}>
    <header><h2>{replacement ? "Replace image" : "Insert into your note"}</h2><button type="button" aria-label="Close insertion" disabled={busy} onClick={() => closeModal()}>×</button></header>
    <label className="media-file">Choose images<input type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/avif,image/svg+xml,.svg" multiple={!replacement} disabled={busy} onChange={async (e) => { const files = Array.from(e.target.files || []); if (!files.length) return; const session = modalSessionRef.current; const pending = pendingTargetRef.current; setBusy(true); busyRef.current = true; try { const images = await importImageFiles(files); if (mounted.current) commitImages(images, pending); } catch (e) { if (mounted.current && modalSessionRef.current === session) setError(String(e)); } finally { if (modalSessionRef.current === session) { busyRef.current = false; if (mounted.current) setBusy(false); } } }} /></label>
    {!replacement && <div className="segmented"><button type="button" aria-pressed={!imageMode} onClick={() => { setImageMode(false); setError(""); }}>Link</button><button type="button" aria-pressed={imageMode} onClick={() => { setImageMode(true); setError(""); }}>Image URL</button></div>}
    <label>Web address<input ref={urlInputRef} autoFocus type="url" value={url} onChange={(e) => { setUrl(e.target.value); setDetails(null); setError(""); }} placeholder="https://…" /></label>
    {fetching && <small role="status">Finding the link title…</small>}
    {!imageMode && details && <label>Link title<input value={details.title} onChange={(e) => setDetails({ ...details, title: e.target.value })} /></label>}
    {!imageMode && details?.thumbnail && <label className="media-check"><input type="checkbox" checked={thumbnail} onChange={(e) => setThumbnail(e.target.checked)} />Include the video thumbnail</label>}
    {!imageMode && thumbnail && details?.thumbnail && (thumbnailPreview ? <img className="link-thumbnail-preview" src={thumbnailPreview} alt={`Thumbnail preview: ${details.title}`} /> : <small role="status">{thumbnailError ? `Thumbnail preview unavailable: ${thumbnailError}` : "Loading thumbnail preview…"}</small>)}
    <small>Titles are fetched only when you paste or enter a web link here. Images are downloaded on insertion, so PDF and portable-file export can work offline.</small>
    {error && <p role="alert">{error}</p>}
    <footer><button type="button" disabled={busy || !/^https?:\/\/\S+$/.test(url)} className="primary-action" onClick={insert}>{busy ? "Preparing…" : replacement ? "Replace image" : imageMode ? "Insert image" : "Insert link"}</button></footer>
    {url && !imageMode && <button type="button" disabled={busy} onClick={() => {
      const pending = pendingTargetRef.current;
      if (pending) {
        const resolved = resolvePendingInsertion(pending, docStateRef.current);
        if (!resolved.ok) { reference.current.onNotice(resolved.message); closeModal(); return; }
        reference.current.onInsert(url, resolved.point);
      } else {
        reference.current.onInsert(url, undefined);
      }
      closeModal();
    }}>Paste plain URL instead</button>}
  </section></div>;
}
