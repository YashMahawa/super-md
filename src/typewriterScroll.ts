import { useSyncExternalStore } from "react";
import { EditorSelection, EditorState, Transaction, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, type Command, type ViewUpdate } from "@codemirror/view";

export const TYPEWRITER_STORAGE_KEY = "editor.typewriter";
export const TYPEWRITER_SHORTCUT = "Mod-Alt-t";

const scrollIntoViewEffectProbe = EditorView.scrollIntoView(0) as unknown as { type: unknown };
function hasExplicitScrollEffect(tr: Transaction): boolean {
  for (const effect of tr.effects) {
    if ((effect as unknown as { type: unknown }).type === scrollIntoViewEffectProbe.type) {
      return true;
    }
  }
  return false;
}

function readStoredTypewriter(): boolean {
  try {
    if (typeof localStorage !== "undefined") {
      return localStorage.getItem(TYPEWRITER_STORAGE_KEY) === "true";
    }
  } catch {
    // Restricted WebView or non-browser environments fall back to off.
  }
  return false;
}

let typewriterEnabled = readStoredTypewriter();
const listeners = new Set<() => void>();

export function getTypewriterScroll(): boolean {
  return typewriterEnabled;
}

export function setTypewriterScroll(enabled: boolean, options?: { persist?: boolean }): void {
  const next = Boolean(enabled);
  if (options?.persist !== false) {
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(TYPEWRITER_STORAGE_KEY, String(next));
      }
    } catch {
      // Ignore storage quota or sandbox restrictions.
    }
  }
  if (typewriterEnabled === next) return;
  typewriterEnabled = next;
  listeners.forEach((listener) => listener());
}

export function toggleTypewriterScroll(options?: { persist?: boolean }): boolean {
  const next = !typewriterEnabled;
  setTypewriterScroll(next, options);
  return next;
}

export function subscribeTypewriterScroll(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useTypewriterScroll(controlled?: boolean): boolean {
  const shared = useSyncExternalStore(subscribeTypewriterScroll, getTypewriterScroll, () => false);
  return controlled ?? shared;
}

/** Determine whether a CodeMirror transaction represents user typing or keyboard
 * cursor navigation that should vertically center the active line, while leaving
 * manual scrolling, pointer selections, and external prop syncs untouched. */
export function shouldCenterTypewriterTransaction(tr: Transaction): boolean {
  if (tr.isUserEvent("select.pointer")) return false;
  if (hasExplicitScrollEffect(tr)) return false;
  if (tr.scrollIntoView) return true;
  if (tr.isUserEvent("input") || tr.isUserEvent("delete") || tr.isUserEvent("undo") || tr.isUserEvent("redo")) return true;
  if (tr.docChanged && tr.selection && tr.annotation(Transaction.addToHistory) !== false) return true;
  return false;
}

export function centerCursorEffect(state: EditorState) {
  const main = state.selection.main;
  const assoc = main.empty ? (main.assoc || 1) : (main.head > main.anchor ? -1 : 1);
  return EditorView.scrollIntoView(EditorSelection.cursor(main.head, assoc), { y: "center" });
}

const typewriterTheme = EditorView.theme({
  "&.cm-editor .cm-scroller": {
    paddingTop: "var(--cm-typewriter-pad, 50vh)",
    paddingBottom: "var(--cm-typewriter-pad, 50vh)",
  },
});

const typewriterPaddingPlugin = ViewPlugin.fromClass(
  class {
    private observer: ResizeObserver | null = null;
    private lastPad = -1;

    constructor(private readonly view: EditorView) {
      this.syncPadding();
      if (typeof ResizeObserver !== "undefined") {
        this.observer = new ResizeObserver(() => this.syncPadding());
        this.observer.observe(this.view.scrollDOM);
      }
    }

    update(update: ViewUpdate) {
      if (update.geometryChanged) this.syncPadding();
    }

    syncPadding() {
      const height = this.view.scrollDOM.clientHeight;
      if (height <= 0) return;
      const half = Math.max(24, Math.floor(height / 2));
      if (half === this.lastPad) return;
      this.lastPad = half;
      this.view.dom.style.setProperty("--cm-typewriter-pad", `${half}px`);
    }

    destroy() {
      this.observer?.disconnect();
      this.observer = null;
      this.view.dom.style.removeProperty("--cm-typewriter-pad");
    }
  }
);

const typewriterTransactionExtender = EditorState.transactionExtender.of((tr) => {
  if (!shouldCenterTypewriterTransaction(tr)) return null;
  return { effects: centerCursorEffect(tr.state) };
});

const activeTypewriterExtension: Extension = [
  typewriterTheme,
  typewriterPaddingPlugin,
  typewriterTransactionExtender,
];

export function typewriterScrollExtension(enabled: boolean): Extension {
  return enabled ? activeTypewriterExtension : [];
}

export function isTypewriterShortcutEvent(event: KeyboardEvent): boolean {
  return (event.ctrlKey || event.metaKey) && event.altKey && !event.shiftKey && event.key.toLowerCase() === "t";
}

export const toggleTypewriterCommand: Command = () => {
  toggleTypewriterScroll();
  return true;
};

/** Compute the vertical scroll delta needed on `scroller` to center the active
 * block (or active caret line when typing / editing tall blocks) in `LiveEditor`. */
export function liveEditorCenterDelta(area: HTMLTextAreaElement, scroller: HTMLElement, followCaret = false): number {
  const scrollerRect = scroller.getBoundingClientRect();
  const viewportHeight = scroller.clientHeight || scrollerRect.height;
  if (viewportHeight <= 0) return 0;
  const viewportCenter = scrollerRect.top + viewportHeight / 2;
  const areaRect = area.getBoundingClientRect();
  if (!followCaret && areaRect.height <= viewportHeight * 0.75) {
    return (areaRect.top + areaRect.height / 2) - viewportCenter;
  }
  const style = getComputedStyle(area);
  const fontSize = Number.parseFloat(style.fontSize) || 16;
  const lineHeight = Number.parseFloat(style.lineHeight) || fontSize * 1.7;
  const padTop = Number.parseFloat(style.paddingTop) || 10;
  const caret = typeof area.selectionEnd === "number" ? area.selectionEnd : area.value.length;
  const text = area.value;
  let lineIndex = 0;
  for (let i = 0, limit = Math.min(caret, text.length); i < limit; i++) {
    if (text.charCodeAt(i) === 10) lineIndex++;
  }
  const unscaledHeight = area.clientHeight || area.offsetHeight || areaRect.height;
  const scaleY = area.offsetHeight > 0 ? areaRect.height / area.offsetHeight : 1;
  const localCenter = Math.max(0, Math.min(unscaledHeight, padTop + (lineIndex + 0.5) * lineHeight - area.scrollTop));
  return (areaRect.top + localCenter * scaleY) - viewportCenter;
}
