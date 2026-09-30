import { useEffect, useRef } from "react";
import { Compartment, EditorSelection, EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";
import { searchKeymap, highlightSelectionMatches, openSearchPanel } from "@codemirror/search";
import { oneDark } from "@codemirror/theme-one-dark";

interface Props {
  sessionId?: string;
  value: string;
  onChange: (value: string) => void;
  dark: boolean;
  focusMode: boolean;
}

const sessions = new Map<string, { state: EditorState; top: number; appearance: Compartment }>();
const callbacks = new Map<string, (value: string) => void>();
export default function Editor({ sessionId = "default", value, onChange, dark, focusMode }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const changeHandler = useRef(onChange);
  changeHandler.current = onChange;
  callbacks.set(sessionId, onChange);
  const appearance = useRef(new Compartment());
  const editorTheme = () => [ ...(dark ? [oneDark] : []), EditorView.theme({
    "&": { height: "100%", background: "transparent" },
    ".cm-scroller": { fontFamily: "var(--mono)", fontSize: "calc(var(--editor-size) * var(--workspace-scale, 1))", lineHeight: "var(--editor-leading)", padding: focusMode ? "12vh 0 38vh" : "20px 0 45vh" },
    ".cm-content": { maxWidth: focusMode ? "820px" : "none", margin: focusMode ? "0 auto" : "0", padding: "0 28px" },
    ".cm-gutters": { background: "transparent", border: "0", color: "var(--muted)" },
    ".cm-activeLine, .cm-activeLineGutter": { background: "color-mix(in srgb, var(--primary) 8%, transparent)" },
    ".cm-selectionBackground": { background: "color-mix(in srgb, var(--primary) 30%, transparent) !important" }
  }) ];

  useEffect(() => {
    if (!host.current) return;
    const cached = sessions.get(sessionId);
    if (cached) appearance.current = cached.appearance;
    const state = cached?.state.doc.toString() === value ? cached.state : EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        history(),
        drawSelection(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        markdown({ base: markdownLanguage }),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
        EditorState.allowMultipleSelections.of(true),
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) callbacks.get(sessionId)?.(update.state.doc.toString());
        }),
        appearance.current.of(editorTheme())
      ]
    });
    view.current = new EditorView({ state, parent: host.current });
    if (cached) view.current.scrollDOM.scrollTop = cached.top;
    return () => {
      if (view.current) { sessions.set(sessionId, { state: view.current.state, top: view.current.scrollDOM.scrollTop, appearance: appearance.current }); if (sessions.size > 40) { const first = sessions.keys().next().value!; sessions.delete(first); callbacks.delete(first); } view.current.destroy(); }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  useEffect(() => { view.current?.dispatch({ effects: appearance.current.reconfigure(editorTheme()) }); }, [dark, focusMode]);

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

  return <div className="editor-host" ref={host} aria-label="Markdown editor" />;
}
