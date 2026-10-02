import { useEffect, useRef, useState } from "react";
import { Compartment, EditorSelection, EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxHighlighting, defaultHighlightStyle, foldGutter, foldKeymap } from "@codemirror/language";
import { searchKeymap, highlightSelectionMatches, openSearchPanel } from "@codemirror/search";
import { oneDarkHighlightStyle } from "@codemirror/theme-one-dark";

interface Props {
  sessionId?: string;
  value: string;
  onChange: (value: string) => void;
  dark: boolean;
  focusMode: boolean;
}

const sessions = new Map<string, { state: EditorState; top: number; appearance: Compartment; wrapping: Compartment; wrapped: boolean }>();
const callbacks = new Map<string, (value: string) => void>();
const statusHandlers = new Map<string, (state: EditorState) => void>();
export default function Editor({ sessionId = "default", value, onChange, dark, focusMode }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const changeHandler = useRef(onChange);
  changeHandler.current = onChange;
  callbacks.set(sessionId, onChange);
  const appearance = useRef(new Compartment());
  const wrapping = useRef(new Compartment());
  const [wrap, setWrap] = useState(true);
  const wrapReference = useRef(wrap); wrapReference.current = wrap;
  const position = useRef<HTMLSpanElement>(null);
  const describeSelection = (state: EditorState) => {
    const main = state.selection.main;
    const line = state.doc.lineAt(main.head);
    const selected = state.selection.ranges.reduce((total, range) => total + range.to - range.from, 0);
    if (position.current) position.current.textContent = `Ln ${line.number}, Col ${main.head - line.from + 1}${state.selection.ranges.length > 1 ? ` · ${state.selection.ranges.length} cursors` : selected ? ` · ${selected} selected` : ""}`;
  };
  statusHandlers.set(sessionId, describeSelection);
  const editorTheme = () => [ ...(dark ? [syntaxHighlighting(oneDarkHighlightStyle)] : []), EditorView.theme({
    "&": { height: "100%", background: "var(--surface)", color: "var(--text)" },
    ".cm-scroller": { fontFamily: "var(--mono)", fontSize: "calc(var(--editor-size) * var(--workspace-scale, 1))", lineHeight: "var(--editor-leading)", padding: focusMode ? "8vh 0 36vh" : "24px 0 38vh", scrollbarWidth: "thin", scrollbarColor: "var(--outline) transparent" },
    ".cm-content": { maxWidth: focusMode ? "var(--reading-max-width, none)" : "none", margin: focusMode ? "0 auto" : "0", padding: "0 24px", caretColor: "var(--primary)" },
    ".cm-line": { padding: "0 4px" },
    ".cm-gutters": { background: "var(--surface)", border: "0", color: "var(--muted)", paddingRight: "8px" },
    ".cm-lineNumbers .cm-gutterElement": { paddingLeft: "16px", paddingRight: "10px" },
    ".cm-activeLine": { background: "color-mix(in srgb, var(--primary) 7%, var(--surface))", borderRadius: "6px" },
    ".cm-activeLineGutter": { background: "transparent", color: "var(--primary)", fontWeight: "600" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--primary)", borderLeftWidth: "2px" },
    ".cm-selectionBackground": { background: "color-mix(in srgb, var(--primary) 25%, transparent) !important" },
    ".cm-foldGutter .cm-gutterElement": { cursor: "pointer", color: "var(--muted)" },
    ".cm-foldPlaceholder": { background: "var(--surface-high)", color: "var(--text)", border: "none", borderRadius: "6px", padding: "0 8px" }
  }, { dark }) ];

  useEffect(() => {
    if (!host.current) return;
    const cached = sessions.get(sessionId);
    if (cached) { appearance.current = cached.appearance; wrapping.current = cached.wrapping; setWrap(cached.wrapped); }
    const state = cached?.state.doc.toString() === value ? cached.state : EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        foldGutter(),
        history(),
        drawSelection(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        markdown({ base: markdownLanguage }),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, ...foldKeymap, indentWithTab]),
        EditorState.allowMultipleSelections.of(true),
        wrapping.current.of(EditorView.lineWrapping),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) callbacks.get(sessionId)?.(update.state.doc.toString());
          if (update.docChanged || update.selectionSet) statusHandlers.get(sessionId)?.(update.state);
        }),
        appearance.current.of(editorTheme())
      ]
    });
    view.current = new EditorView({ state, parent: host.current });
    describeSelection(view.current.state);
    if (cached) view.current.scrollDOM.scrollTop = cached.top;
    return () => {
      if (view.current) { sessions.set(sessionId, { state: view.current.state, top: view.current.scrollDOM.scrollTop, appearance: appearance.current, wrapping: wrapping.current, wrapped: wrapReference.current }); if (sessions.size > 40) { const first = sessions.keys().next().value!; sessions.delete(first); callbacks.delete(first); statusHandlers.delete(first); } view.current.destroy(); }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  useEffect(() => { view.current?.dispatch({ effects: appearance.current.reconfigure(editorTheme()) }); }, [dark, focusMode]);
  useEffect(() => { view.current?.dispatch({ effects: wrapping.current.reconfigure(wrap ? EditorView.lineWrapping : []) }); }, [wrap]);

  useEffect(() => {
    const instance = view.current;
    if (!instance) return;
    const previous = instance.state.doc.toString();
    if (previous === value) return;
    let from = 0;
    while (from < previous.length && from < value.length && previous[from] === value[from]) from++;
    let oldEnd = previous.length, newEnd = value.length;
    while (oldEnd > from && newEnd > from && previous[oldEnd - 1] === value[newEnd - 1]) { oldEnd--; newEnd--; }
    instance.dispatch({ changes: { from, to: oldEnd, insert: value.slice(from, newEnd) } });
  }, [value]);

  useEffect(() => {
    const open = () => view.current && openSearchPanel(view.current);
    window.addEventListener("supermd-find", open);
    return () => window.removeEventListener("supermd-find", open);
  }, []);

  useEffect(() => {
    const point = (event: Event) => { const instance = view.current; if (instance) (event as CustomEvent).detail.point = { from: instance.state.selection.main.from, to: instance.state.selection.main.to }; };
    window.addEventListener("supermd-insertion-point", point);
    return () => window.removeEventListener("supermd-insertion-point", point);
  }, []);

  useEffect(() => {
    const format = (event: Event) => {
      const instance = view.current;
      if (!instance) return;
      const detail = (event as CustomEvent<{ prefix: string; suffix?: string; block?: boolean }>).detail;
      if (detail.block) {
        instance.dispatch({ changes: { from: instance.state.selection.main.head, insert: detail.prefix } });
        instance.focus();
        return;
      }
      const suffix = detail.suffix ?? detail.prefix;
      const changes = instance.state.selection.ranges.map((range) => ({
        from: range.from,
        to: range.to,
        insert: `${detail.prefix}${instance.state.sliceDoc(range.from, range.to)}${suffix}`
      }));
      const mapped = instance.state.changes(changes);
      const ranges = instance.state.selection.ranges.map((range) => {
        const start = mapped.mapPos(range.from, -1) + detail.prefix.length;
        const end = start + range.to - range.from;
        return range.anchor > range.head ? EditorSelection.range(end, start) : EditorSelection.range(start, end);
      });
      instance.dispatch({ changes: mapped, selection: EditorSelection.create(ranges, instance.state.selection.mainIndex), userEvent: "input.format" });
      instance.focus();
    };
    window.addEventListener("supermd-format", format);
    return () => window.removeEventListener("supermd-format", format);
  }, []);

  return <div className="source-editor-shell">
    <div className="editor-host" ref={host} aria-label="Markdown editor" />
    <footer className="source-editor-status" aria-label="Source editor status">
      <span className="source-language">Markdown</span>
      <span ref={position} className="source-position">Ln 1, Col 1</span>
      <span className="source-status-spacer" />
      <button type="button" aria-pressed={wrap} title="Toggle line wrapping" onClick={() => setWrap(current => !current)}>Wrap lines</button>
      <span className="source-encoding">UTF-8</span>
    </footer>
  </div>;
}
