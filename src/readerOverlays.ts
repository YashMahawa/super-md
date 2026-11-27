import { invoke } from "./nativeBridge";
const overlays = new Set<string>();
const dismissiblesByNote = new Map<string | null, Set<string>>();
const reportedOpenNotes = new Set<string | null>();
let activeReaderNoteId: string | null = null;
let dismissEditorSearchHandler: (() => boolean) | null = null;
let flushLiveEditHandler: (() => void) | null = null;

function normalizeNoteId(noteId: string | null | undefined): string | null {
  return typeof noteId === "string" && noteId.length > 0 ? noteId : null;
}

function hasDismissiblesForNote(noteId: string | null): boolean {
  return (dismissiblesByNote.get(noteId)?.size ?? 0) > 0;
}

function emitReaderDismissible(noteId: string | null, open: boolean) {
  if (document.documentElement.dataset.platform !== "android") return;
  const payload = noteId !== null ? { id: noteId, open } : { open };
  void invoke("reader_dismissible_changed", payload).catch(() => {});
}

export function getActiveReaderNoteId(): string | null {
  return activeReaderNoteId;
}

export function setActiveReaderNoteId(noteId: string | null) {
  const normalized = normalizeNoteId(noteId);
  const previousNoteId = activeReaderNoteId;
  activeReaderNoteId = normalized;
  if (normalized !== null) {
    document.documentElement.dataset.readerNoteId = normalized;
  } else {
    delete document.documentElement.dataset.readerNoteId;
  }
  if (previousNoteId !== normalized) {
    reportedOpenNotes.delete(previousNoteId);
  }
  const present = hasDismissiblesForNote(normalized);
  document.documentElement.dataset.readerDismissible = String(present);
  if (document.documentElement.dataset.platform === "android") {
    if (present && !reportedOpenNotes.has(normalized)) {
      reportedOpenNotes.add(normalized);
      emitReaderDismissible(normalized, true);
    } else if (!present && reportedOpenNotes.has(normalized)) {
      reportedOpenNotes.delete(normalized);
      emitReaderDismissible(normalized, false);
    }
  } else if (!present) {
    reportedOpenNotes.delete(normalized);
  }
}

/** Native fullscreen chrome must not cover document dialogs. Nested overlays
 * keep ownership until the last one closes. No note bytes cross this signal. */
export function setReaderOverlay(kind: string, open: boolean) {
  const previous = overlays.size > 0;
  if (open) overlays.add(kind); else overlays.delete(kind);
  const present = overlays.size > 0;
  const image = overlays.has("image") || overlays.has("step-viewer");
  document.documentElement.dataset.readerOverlay = String(present);
  document.documentElement.dataset.readerImageOverlay = String(image);
  if (previous !== present || kind === "image" || kind === "step-viewer") {
    void invoke("reader_overlay_changed", { open: present, image }).catch(() => {});
  }
}
export function hasReaderOverlay(): boolean {
  return (
    overlays.size > 0 ||
    document.documentElement.dataset.readerOverlay === "true" ||
    !!document.querySelector(".media-save-menu,.theme-guide-dialog,.media-dialog,.image-viewer,.step-viewer,.math-repair-panel,.reading-search,.reader-export-backdrop")
  );
}
/** Inline reader sessions (active Live block edit, CodeMirror Source search)
 * keep reading/editing chrome visible while still letting Android Back dismiss
 * the session before falling back to fullscreen exit or system Back. */
export function setReaderDismissible(kind: string, open: boolean, noteId: string | null = activeReaderNoteId) {
  const targetNoteId = normalizeNoteId(noteId);
  let set = dismissiblesByNote.get(targetNoteId);
  if (open) {
    if (!set) {
      set = new Set<string>();
      dismissiblesByNote.set(targetNoteId, set);
    }
    set.add(kind);
  } else if (set) {
    set.delete(kind);
    if (set.size === 0) dismissiblesByNote.delete(targetNoteId);
  }
  const present = hasDismissiblesForNote(targetNoteId);
  if (targetNoteId === activeReaderNoteId) {
    document.documentElement.dataset.readerDismissible = String(present);
    if (document.documentElement.dataset.platform === "android") {
      if (present && !reportedOpenNotes.has(targetNoteId)) {
        reportedOpenNotes.add(targetNoteId);
        emitReaderDismissible(targetNoteId, true);
      } else if (!present && reportedOpenNotes.has(targetNoteId)) {
        reportedOpenNotes.delete(targetNoteId);
        emitReaderDismissible(targetNoteId, false);
      }
    } else if (!present) {
      reportedOpenNotes.delete(targetNoteId);
    }
  } else if (!present && reportedOpenNotes.has(targetNoteId)) {
    reportedOpenNotes.delete(targetNoteId);
    emitReaderDismissible(targetNoteId, false);
  }
}
export function registerEditorSearchDismisser(handler: (() => boolean) | null) {
  dismissEditorSearchHandler = handler;
}
export function registerLiveEditFlusher(handler: (() => void) | null, expectedPrevious?: () => void) {
  if (handler === null && expectedPrevious && flushLiveEditHandler !== expectedPrevious) return;
  flushLiveEditHandler = handler;
}
export function flushActiveLiveEdit() {
  flushLiveEditHandler?.();
}
export function dismissReaderOverlay(): boolean {
  const modal =
    document.querySelector(".media-save-menu") ||
    document.querySelector(".theme-guide-dialog") ||
    document.querySelector(".media-dialog,.image-viewer,.step-viewer,.math-repair-panel,.reading-search");
  if (modal) {
    (document.activeElement || document).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    return true;
  }
  if (dismissEditorSearchHandler?.()) return true;
  const cmSearch = document.querySelector<HTMLElement>(".cm-search");
  if (cmSearch) {
    const closeButton = cmSearch.querySelector<HTMLButtonElement>("button[name='close']");
    if (closeButton) closeButton.click();
    else (cmSearch.querySelector<HTMLElement>("input,button") || cmSearch).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    return true;
  }
  const textarea = document.querySelector<HTMLTextAreaElement>(".live-active-block textarea");
  if (!textarea) return false;
  textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  if (document.contains(textarea)) textarea.blur();
  return true;
}
