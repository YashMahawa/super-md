import { invoke } from "./nativeBridge";
const overlays = new Set<string>();
const dismissibles = new Set<string>();
let dismissEditorSearchHandler: (() => boolean) | null = null;
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
/** Inline reader sessions (active Live block edit, CodeMirror Source search)
 * keep reading/editing chrome visible while still letting Android Back dismiss
 * the session before falling back to fullscreen exit or system Back. */
export function setReaderDismissible(kind: string, open: boolean) {
  const previous = dismissibles.size > 0;
  if (open) dismissibles.add(kind); else dismissibles.delete(kind);
  const present = dismissibles.size > 0;
  document.documentElement.dataset.readerDismissible = String(present);
  if (previous !== present && document.documentElement.dataset.platform === "android") {
    void invoke("reader_dismissible_changed", { open: present }).catch(() => {});
  }
}
export function registerEditorSearchDismisser(handler: (() => boolean) | null) {
  dismissEditorSearchHandler = handler;
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
