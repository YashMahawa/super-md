import { useEffect, useRef } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";
import { searchKeymap, highlightSelectionMatches, openSearchPanel } from "@codemirror/search";
import { oneDark } from "@codemirror/theme-one-dark";

interface Props {
  value: string;
  onChange: (value: string) => void;
  dark: boolean;
  focusMode: boolean;
}

export default function Editor({ value, onChange, dark, focusMode }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const changeHandler = useRef(onChange);
  changeHandler.current = onChange;

  useEffect(() => {
    if (!host.current) return;
    const state = EditorState.create({
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
          if (update.docChanged) changeHandler.current(update.state.doc.toString());
        }),
        ...(dark ? [oneDark] : []),
        EditorView.theme({
          "&": { height: "100%", background: "transparent" },
          ".cm-scroller": { fontFamily: "var(--mono)", fontSize: "calc(var(--editor-size) * var(--workspace-scale, 1))", lineHeight: "var(--editor-leading)", padding: focusMode ? "12vh 0 38vh" : "20px 0 45vh" },
          ".cm-content": { maxWidth: focusMode ? "820px" : "none", margin: focusMode ? "0 auto" : "0", padding: "0 28px" },
          ".cm-gutters": { background: "transparent", border: "0", color: "var(--muted)" },
          ".cm-activeLine, .cm-activeLineGutter": { background: "color-mix(in srgb, var(--primary) 8%, transparent)" },
          ".cm-selectionBackground": { background: "color-mix(in srgb, var(--primary) 30%, transparent) !important" }
        })
      ]
    });
    view.current = new EditorView({ state, parent: host.current });
    return () => view.current?.destroy();
    // Recreate only when presentation-affecting editor configuration changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dark, focusMode]);

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
      instance.dispatch({ changes });
      instance.focus();
    };
    window.addEventListener("supermd-format", format);
    return () => window.removeEventListener("supermd-format", format);
  }, []);

  return <div className="editor-host" ref={host} aria-label="Markdown editor" />;
}
