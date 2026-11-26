import { useEffect, useRef, useState } from "react";
import { Annotation, Compartment, EditorSelection, EditorState, Transaction } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection, type KeyBinding } from "@codemirror/view";
import { defaultKeymap, history, historyField, historyKeymap, indentWithTab, undo, redo, isolateHistory } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxHighlighting, defaultHighlightStyle, foldGutter, foldKeymap, syntaxTree, syntaxTreeAvailable } from "@codemirror/language";
import { repairPastedMath } from '../mathRepair';
import {
  applyMarkdownUrlPaste,
  normalizeFormatAction,
  notifyHistoryBoundary,
  parseStandaloneHttpUrl,
  toggleMarkdownFormat,
  type FormatAction,
} from "../markdownFormatting";
import { forEachDiagnostic, forceLinting, linter, setDiagnostics, type Action, type Diagnostic } from "@codemirror/lint";
import {checkWriting,type WritingOptions} from "../proofreading";
import {PROOFREADING_MAX_CHARS,computeWindowBounds} from "../proofreadingCore";
import {addPersonalWord,hasPersonalWord,normalizeDictionaryWord,subscribePersonalDictionary} from "../personalDictionary";
import { search, searchKeymap, highlightSelectionMatches, openSearchPanel, SearchQuery, setSearchQuery } from "@codemirror/search";
import { oneDarkHighlightStyle } from "@codemirror/theme-one-dark";
import type {SourceChange} from '../readerEdits';
import {
  TYPEWRITER_SHORTCUT,
  centerCursorEffect,
  getTypewriterScroll,
  setTypewriterScroll,
  toggleTypewriterScroll,
  typewriterScrollExtension,
  useTypewriterScroll,
} from "../typewriterScroll";

interface Props extends WritingOptions {
  latexAutofix?:boolean;
  typewriterScroll?:boolean;
  onTypewriterChange?:(enabled:boolean)=>void;
  sessionId?: string;
  value: string;
  onChange: (value: string, changes?:SourceChange[]) => void;
  dark: boolean;
  focusMode: boolean;
}

const sessions = new Map<string, { state: EditorState; top: number; appearance: Compartment; wrapping: Compartment; proofing:Compartment; typewriter: Compartment; wrapped: boolean; typewriterActive: boolean }>();
function trimEditorSessions() {
  // Bound retained undo trees across tabs by text volume, not only tab count.
  // The native model still owns every note; evicting a view cannot lose text.
  let retained = [...sessions.values()].reduce((size, entry) => size + entry.state.doc.length, 0);
  for (const [id, entry] of sessions) {
    if (sessions.size<=1 || sessions.size <= 40 && retained <= 4_000_000) break;
    sessions.delete(id); retained -= entry.state.doc.length;
    callbacks.delete(id); statusHandlers.delete(id);
    rangeHandlers.delete(id);
    pasteSettings.delete(id);
    selectionHistories.delete(id);
    typewriterHandlers.delete(id);
    typewriterStates.delete(id);
  }
}
const callbacks = new Map<string, (value: string,changes?:SourceChange[]) => void>();
const pasteSettings=new Map<string,boolean>();
const statusHandlers = new Map<string, (state: EditorState) => void>();
const rangeHandlers = new Map<string, (range: { from: number; to: number }) => void>();
const typewriterHandlers = new Map<string, ((enabled: boolean) => void) | undefined>();
const typewriterStates = new Map<string, boolean>();
const visibleEditors = new Map<string, EditorView>();
const externalValueSync = Annotation.define<boolean>();
interface SelectionTransition {
  beforeDoc: string;
  afterDoc: string;
  beforeSelection: EditorSelection;
  afterSelection: EditorSelection;
}
const selectionHistories = new Map<string, SelectionTransition[]>();

export function applyEditorFormat(editor: EditorView, action: FormatAction): boolean {
  const currentRanges = editor.state.selection.ranges.map((r) => ({ anchor: r.anchor, head: r.head }));
  const result = toggleMarkdownFormat(
    editor.state.doc.toString(),
    currentRanges,
    action,
    editor.state.selection.mainIndex,
  );
  const nextSelection = EditorSelection.create(
    result.ranges.map((r) => EditorSelection.range(r.anchor, r.head)),
    result.mainIndex,
  );
  notifyHistoryBoundary();
  editor.dispatch({
    changes: result.changes,
    selection: nextSelection,
    annotations: isolateHistory.of("full"),
    userEvent: "input.format",
    scrollIntoView: true,
  });
  notifyHistoryBoundary();
  editor.focus();
  return true;
}

export function formatEditorSession(id: string, rawAction: string): boolean {
  const action = normalizeFormatAction(rawAction);
  const editor = visibleEditors.get(id);
  if (!action || !editor) return false;
  return applyEditorFormat(editor, action);
}

const formatKeymap: KeyBinding[] = [
  { key: "Mod-b", run: (editor) => applyEditorFormat(editor, "bold") },
  { key: "Mod-i", run: (editor) => applyEditorFormat(editor, "italic") },
  { key: "Mod-e", run: (editor) => applyEditorFormat(editor, "inline_code") },
  { key: "Mod-`", run: (editor) => applyEditorFormat(editor, "inline_code") },
  { key: "Mod-k", run: (editor) => applyEditorFormat(editor, "link") },
  { key: "Mod-Shift-h", run: (editor) => applyEditorFormat(editor, "heading") },
  { key: "Mod-Shift-l", run: (editor) => applyEditorFormat(editor, "list") },
  { key: "Mod-Shift-q", run: (editor) => applyEditorFormat(editor, "quote") },
  { key: "Mod-Alt-q", run: (editor) => applyEditorFormat(editor, "quote") },
  { key: "Mod-Shift-m", run: (editor) => applyEditorFormat(editor, "inline_math") },
];

function sourceProofreadingRange(editor: EditorView): { from: number; to: number } {
  const docLen = editor.state.doc.length;
  const vpFrom = editor.state.doc.lineAt(Math.max(0, editor.viewport.from - 500)).from;
  const vpTo = Math.min(docLen, editor.viewport.to + 500);
  if (vpTo - vpFrom <= PROOFREADING_MAX_CHARS) return { from: vpFrom, to: vpTo };
  let focusPos = editor.state.selection.main.head;
  const rect = editor.scrollDOM.getBoundingClientRect();
  if (rect.height > 0 && editor.scrollDOM.scrollHeight > editor.scrollDOM.clientHeight + 4) {
    const caretCoords = focusPos >= vpFrom && focusPos <= vpTo ? editor.coordsAtPos(focusPos) : null;
    const caretVisible = Boolean(caretCoords && caretCoords.bottom >= rect.top - 48 && caretCoords.top <= rect.bottom + 48);
    if (!caretVisible) {
      const mid = editor.posAtCoords({ x: rect.left + 80, y: rect.top + rect.height * 0.5 });
      if (mid !== null) focusPos = mid;
      else {
        const maxScroll = Math.max(1, editor.scrollDOM.scrollHeight - editor.scrollDOM.clientHeight);
        const ratio = Math.max(0, Math.min(1, editor.scrollDOM.scrollTop / maxScroll));
        focusPos = vpFrom + Math.round((vpTo - vpFrom) * ratio);
      }
    }
  }
  const sub = computeWindowBounds(editor.state.sliceDoc(vpFrom, vpTo), focusPos - vpFrom, PROOFREADING_MAX_CHARS);
  return { from: vpFrom + sub.from, to: vpFrom + sub.to };
}

function unclosedDisplayMathBefore(state: EditorState, limit: number): boolean {
  if (limit <= 0 || limit > 200_000) return false;
  const codeSpans: Array<[number, number]> = [];
  syntaxTree(state).iterate({
    from: 0,
    to: limit,
    enter(node) {
      if (["FencedCode", "CodeBlock", "InlineCode", "HTMLBlock", "HTMLTag"].includes(node.name)) {
        codeSpans.push([node.from, node.to]);
        return false;
      }
    }
  });
  const prefix = state.sliceDoc(0, limit);
  let spanIndex = 0;
  let count = 0;
  for (let i = 0; i < prefix.length - 1; i++) {
    while (spanIndex < codeSpans.length && codeSpans[spanIndex][1] <= i) spanIndex++;
    if (spanIndex < codeSpans.length && codeSpans[spanIndex][0] <= i) {
      i = codeSpans[spanIndex][1] - 1;
      continue;
    }
    if (prefix[i] === "\\" && prefix[i + 1] === "$") { i++; continue; }
    if (prefix[i] === "$" && prefix[i + 1] === "$") { count++; i++; }
  }
  return count % 2 === 1;
}
function toggleTypewriterFromView(editor: EditorView): boolean {
  for (const [id, activeView] of visibleEditors) {
    if (activeView === editor) {
      const next = !(typewriterStates.get(id) ?? getTypewriterScroll());
      const handler = typewriterHandlers.get(id);
      setTypewriterScroll(next, { persist: !handler });
      handler?.(next);
      return true;
    }
  }
  toggleTypewriterScroll();
  return true;
}
export function editorKeyBindings(host: string | undefined = typeof document === "undefined" ? undefined : document.documentElement.dataset.host): KeyBinding[] {
  // Qt owns application shortcuts and forwards undo/redo/find/formatting through
  // native commands. Android and browser builds retain CodeMirror's keymaps.
  const nativeShortcuts = host === "qt";
  const typewriterBinding: KeyBinding[] = nativeShortcuts ? [] : [{ key: TYPEWRITER_SHORTCUT, run: toggleTypewriterFromView }];
  const baseDefaults = defaultKeymap.filter((binding) => binding.key !== "Mod-i");
  return [
    ...typewriterBinding,
    ...(nativeShortcuts ? [] : formatKeymap),
    ...baseDefaults,
    ...(nativeShortcuts ? [] : historyKeymap),
    ...(nativeShortcuts ? [] : searchKeymap),
    ...foldKeymap,
    indentWithTab,
  ];
}
export function editorReadingOffset(id:string):number|undefined {
  const view=visibleEditors.get(id);if(!view)return;
  const rect=view.scrollDOM.getBoundingClientRect();
  return view.posAtCoords({x:rect.left+80,y:rect.top+16})??view.viewport.from;
}
export function editorSelectedText(id:string):string|null {
  const view=visibleEditors.get(id);if(!view)return null;
  const main=view.state.selection.main;
  return main.empty?null:view.state.sliceDoc(main.from,main.to);
}
export interface EditorViewContext {
  scroller:HTMLElement;
  offset:number;
  visibleStart:number;
  visibleEnd:number;
  scrollFraction:number;
  visibleText:string;
  selectionText:string;
}
export function editorViewContext(id:string):EditorViewContext|undefined {
  const view=visibleEditors.get(id);
  if(!view)return;
  const scroller=view.scrollDOM,rect=scroller.getBoundingClientRect(),docLength=view.state.doc.length;
  let visibleStart=view.viewport.from,visibleEnd=view.viewport.to;
  if(rect.height>0&&rect.width>0){
    const topPos=view.posAtCoords({x:rect.left+Math.min(80,Math.max(8,rect.width/2)),y:rect.top+8});
    const bottomPos=view.posAtCoords({x:rect.left+Math.min(80,Math.max(8,rect.width/2)),y:Math.max(rect.top+8,rect.bottom-8)});
    if(topPos!==null)visibleStart=view.state.doc.lineAt(topPos).from;
    if(bottomPos!==null)visibleEnd=view.state.doc.lineAt(bottomPos).to;
  }
  visibleStart=Math.max(0,Math.min(docLength,visibleStart));
  visibleEnd=Math.max(visibleStart,Math.min(docLength,visibleEnd));
  if(visibleEnd===visibleStart&&docLength>0){
    visibleEnd=Math.min(docLength,view.viewport.to>visibleStart?view.viewport.to:visibleStart+4000);
  }
  const offset=visibleStart;
  const visibleText=view.state.sliceDoc(visibleStart,visibleEnd).trim().slice(0,2000);
  const selectionText=editorSelectedText(id)??'';
  const scrollFraction=scroller.scrollTop/Math.max(1,scroller.scrollHeight-scroller.clientHeight);
  return {scroller,offset,visibleStart,visibleEnd,scrollFraction,visibleText,selectionText};
}
export function editorHistory(id:string,direction:"undo"|"redo"):boolean {const view=visibleEditors.get(id);return !!view && (direction==="undo"?undo(view):redo(view));}
export function cachedEditorHistory(id:string,direction:'undo'|'redo',content:string):string|undefined {
  const cached=sessions.get(id);if(!cached||cached.state.doc.toString()!==content)return;
  const changed=(direction==='undo'?undo:redo)({state:cached.state,dispatch:transaction=>{cached.state=transaction.state;}});
  return changed?cached.state.doc.toString():undefined;
}
import { scrollRectIntoSearchScroller, type VerticalBandRect } from "../searchScroll";
export function editorFindQuery(id:string,query:string,caseSensitive:boolean,options?:{wholeWord?:boolean;regexp?:boolean}) {
  const wholeWord=!!options?.wholeWord,regexp=!!options?.regexp;
  visibleEditors.get(id)?.dispatch({effects:setSearchQuery.of(new SearchQuery({search:query,caseSensitive,wholeWord,regexp,literal:!regexp}))});
}
function readEditorMatchRect(view:EditorView,from:number,to:number):VerticalBandRect|null {
  try {
    const docLen=view.state.doc.length;
    const safeFrom=Math.max(0,Math.min(from,docLen));
    const safeTo=Math.max(safeFrom,Math.min(to,docLen));
    const start=view.coordsAtPos(safeFrom);
    if(!start)return null;
    const end=safeTo>safeFrom?view.coordsAtPos(safeTo):null;
    return {top:end?Math.min(start.top,end.top):start.top,bottom:end?Math.max(start.bottom,end.bottom):start.bottom};
  } catch {
    return null;
  }
}
export function editorFindRange(id:string,from:number,to:number) {
  const view=visibleEditors.get(id);if(!view)return;
  view.dispatch({selection:{anchor:from,head:to},effects:EditorView.scrollIntoView(from,{y:"center"})});
  const rect=readEditorMatchRect(view,from,to);
  if(rect)scrollRectIntoSearchScroller(view.scrollDOM,rect,()=>readEditorMatchRect(view,from,to),"center");
}
export function ensureEditorSearchRangeVisible(id:string,from:number,to:number) {
  const view=visibleEditors.get(id);if(!view)return;
  const rect=readEditorMatchRect(view,from,to);
  if(rect)scrollRectIntoSearchScroller(view.scrollDOM,rect,()=>readEditorMatchRect(view,from,to),"ensure-visible");
}
export interface PortableEditorSession { state: unknown; top: number; wrapped: boolean; typewriter?: boolean }
const incomingSessions = new Map<string, PortableEditorSession>();
const incomingWeights=new Map<string,number>();
export function exportEditorSession(id: string): PortableEditorSession | undefined {
  const view = visibleEditors.get(id), cached = sessions.get(id);
  const state = view?.state || cached?.state;
  if (!state) return;
  const result = {state: state.toJSON({history: historyField}), top: view?.scrollDOM.scrollTop ?? cached?.top ?? 0, wrapped: view?.lineWrapping ?? cached?.wrapped ?? true, typewriter: typewriterStates.get(id) ?? cached?.typewriterActive ?? getTypewriterScroll()};
  // View metadata is transient, bounded and never part of portable Markdown.
  if (JSON.stringify(result).length <= 2_000_000) return result;
}
export function importEditorSession(id: string, data: PortableEditorSession | undefined) {
  if (!data || typeof data.top !== "number" || !Number.isFinite(data.top) || typeof data.wrapped !== "boolean") return;
  const size=JSON.stringify(data).length;if(size>2_000_000)return;
  incomingSessions.set(id, data); sessions.delete(id);
  incomingWeights.set(id,size);let retained=[...incomingWeights.values()].reduce((n,size)=>n+size,0);
  while(incomingSessions.size>40||retained>4_000_000){const first=incomingSessions.keys().next().value!;incomingSessions.delete(first);retained-=incomingWeights.get(first)||0;incomingWeights.delete(first);}
}
export default function Editor({ sessionId = "default", value, onChange, dark, focusMode,spellCheck=false,grammarCheck=false,latexAutofix=false,typewriterScroll,onTypewriterChange }: Props) {
  pasteSettings.set(sessionId,latexAutofix);
  typewriterHandlers.set(sessionId,onTypewriterChange);
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const changeHandler = useRef(onChange);
  changeHandler.current = onChange;
  callbacks.set(sessionId, onChange);
  const appearance = useRef(new Compartment());
  const wrapping = useRef(new Compartment());
  const proofing=useRef(new Compartment());
  const lastLintedRange=useRef<{from:number;to:number}>({from:0,to:0});
  const [proofRange,setProofRange]=useState<{from:number;to:number}|null>(null);
  const [dictionaryRevision,setDictionaryRevision]=useState(0);
  rangeHandlers.set(sessionId,setProofRange);
  const filterSavedDiagnostics=(diagnostics:readonly Diagnostic[],state:EditorState)=>diagnostics.filter(d=>!(d.source==="Spelling"&&hasPersonalWord(state.sliceDoc(d.from,d.to))));
  const typewriter = useRef(new Compartment());
  const activeTypewriter = useTypewriterScroll(typewriterScroll);
  const typewriterReference = useRef(activeTypewriter); typewriterReference.current = activeTypewriter;
  typewriterStates.set(sessionId, activeTypewriter);
  const appliedTypewriter = useRef(activeTypewriter);
  const writingExtension=()=>!spellCheck&&!grammarCheck?[]:linter(async editor=>{
    const {from,to}=sourceProofreadingRange(editor);
    lastLintedRange.current={from,to};
    rangeHandlers.get(sessionId)?.({from,to});
    const blocked:Array<[number,number]>=[];
    syntaxTree(editor.state).iterate({from,to,enter(node){if(["FencedCode","CodeBlock","InlineCode","HTMLBlock","HTMLTag","Link","Image","URL"].includes(node.name)){blocked.push([Math.max(0,node.from-from),Math.min(to-from,node.to-from)]);return false;}}});
    const slice=editor.state.sliceDoc(from,to);
    if(unclosedDisplayMathBefore(editor.state,from)){
      const closeMath=slice.indexOf("$$");
      blocked.push([0,closeMath===-1?slice.length:closeMath+2]);
    }
    const issues=await checkWriting(slice,{spellCheck,grammarCheck},blocked);
    return issues.map(issue=>{
      const validReplacements=issue.replacements.filter(r=>typeof r==="string"&&r.trim().length>0);
      const actions:Action[]=validReplacements.map(replacement=>({name:`Use “${replacement}”`,apply(targetView,start,end){targetView.dispatch({changes:{from:start,to:end,insert:replacement}});}}));
      const flaggedWord=issue.kind==="spelling"?(issue.word??slice.slice(issue.from,issue.to)):"";
      if(flaggedWord&&normalizeDictionaryWord(flaggedWord)){
        actions.push({
          name:"Add to dictionary",
          apply(targetView){
            addPersonalWord(flaggedWord);
            const kept:Diagnostic[]=[];
            forEachDiagnostic(targetView.state,(d,dFrom,dTo)=>{
              if(!(d.source==="Spelling"&&hasPersonalWord(targetView.state.sliceDoc(dFrom,dTo))))kept.push({...d,from:dFrom,to:dTo});
            });
            targetView.dispatch({...setDiagnostics(targetView.state,kept),annotations:Transaction.addToHistory.of(false)});
          }
        });
      }
      return {from:from+issue.from,to:from+issue.to,severity:"info",source:issue.kind==="spelling"?"Spelling":"Grammar",message:issue.message,actions} satisfies Diagnostic;
    });
  },{delay:600,markerFilter:filterSavedDiagnostics,tooltipFilter:filterSavedDiagnostics,needsRefresh:update=>update.viewportChanged||(update.selectionSet&&update.state.doc.length>PROOFREADING_MAX_CHARS)});
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
    // CodeMirror paints selection behind its text lines. An opaque active-line
    // fill hides the selected characters even while the native range is right.
    ".cm-activeLine": { background: "color-mix(in srgb, var(--primary) 7%, transparent)", borderRadius: "6px" },
    ".cm-activeLineGutter": { background: "transparent", color: "var(--primary)", fontWeight: "600" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--primary)", borderLeftWidth: "2px" },
    ".cm-selectionBackground": { background: "color-mix(in srgb, var(--primary) 25%, transparent) !important" },
    ".cm-foldGutter .cm-gutterElement": { cursor: "pointer", color: "var(--muted)" },
    ".cm-foldPlaceholder": { background: "var(--surface-high)", color: "var(--text)", border: "none", borderRadius: "6px", padding: "0 8px" }
  }, { dark }) ];

  useEffect(() => {
    if (!host.current) return;
    const cached = sessions.get(sessionId);
    const incoming = incomingSessions.get(sessionId); incomingSessions.delete(sessionId);incomingWeights.delete(sessionId);
    if (incoming) {
      setWrap(incoming.wrapped);
      if (typeof incoming.typewriter === "boolean" && typewriterScroll === undefined) setTypewriterScroll(incoming.typewriter, { persist: false });
    }
    if (cached) { appearance.current = cached.appearance; wrapping.current = cached.wrapping;proofing.current=cached.proofing; typewriter.current = cached.typewriter; setWrap(cached.wrapped); }
    const initialTypewriter = typeof incoming?.typewriter === "boolean" && typewriterScroll === undefined ? incoming.typewriter : activeTypewriter;
    const config = {
      doc: value,
      extensions: [
        lineNumbers(),
        foldGutter(),
        history({ minDepth: 30 }),
        EditorView.domEventHandlers({paste(event,editor){
          if(event.defaultPrevented||event.clipboardData?.files.length)return false;
          const text=event.clipboardData?.getData('text/plain');
          if(!text)return false;
          const standaloneUrl=parseStandaloneHttpUrl(text);
          if(standaloneUrl){
            let syntaxBlocked=false;
            for(const range of editor.state.selection.ranges){
              if(range.empty){syntaxBlocked=true;break;}
              if(syntaxTreeAvailable(editor.state,range.to)){
                syntaxTree(editor.state).iterate({
                  from:range.from,
                  to:range.to,
                  enter(node){
                    if(['FencedCode','CodeBlock','InlineCode','HTMLBlock','HTMLTag','Link','Image','URL'].includes(node.name)){
                      syntaxBlocked=true;return false;
                    }
                  },
                });
              }
              if(syntaxBlocked)break;
            }
            const wrapped=syntaxBlocked?null:applyMarkdownUrlPaste(
              editor.state.doc.toString(),
              editor.state.selection.ranges.map(r=>({anchor:r.anchor,head:r.head})),
              text,
              editor.state.selection.mainIndex,
            );
            event.preventDefault();
            notifyHistoryBoundary();
            if(wrapped){
              editor.dispatch({
                changes:wrapped.changes,
                selection:EditorSelection.create(wrapped.ranges.map(r=>EditorSelection.range(r.anchor,r.head)),wrapped.mainIndex),
                annotations:isolateHistory.of('full'),
                userEvent:'input.paste',
                scrollIntoView:true,
              });
            }else{
              editor.dispatch({
                ...editor.state.replaceSelection(text),
                annotations:isolateHistory.of('full'),
                userEvent:'input.paste',
                scrollIntoView:true,
              });
            }
            notifyHistoryBoundary();
            editor.focus();
            return true;
          }
          if(!pasteSettings.get(sessionId)||!/[\\$^]/.test(text))return false;
          let repaired:string|undefined;
          for(const range of editor.state.selection.ranges){
            if(!syntaxTreeAvailable(editor.state,range.to))return false;
            for(let node=syntaxTree(editor.state).resolveInner(range.from,-1);node;node=node.parent!){
              if(['FencedCode','CodeBlock','InlineCode','HTMLBlock','HTMLTag','Link','Image','URL'].includes(node.name)&&!(range.from<=node.from&&range.to>=node.to))return false;
            }
            const next=repairPastedMath(text,editor.state.sliceDoc(Math.max(0,range.from-16_384),range.from),editor.state.sliceDoc(range.to,Math.min(editor.state.doc.length,range.to+16_384)));
            if(repaired!==undefined&&repaired!==next)return false;repaired=next;
          }
          if(repaired===undefined||repaired===text)return false;
          event.preventDefault();
          notifyHistoryBoundary();
          editor.dispatch({...editor.state.replaceSelection(repaired),annotations:isolateHistory.of('full'),userEvent:'input.paste',scrollIntoView:true});
          notifyHistoryBoundary();
          return true;
        }}),
        drawSelection(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        search({top:true}),
        markdown({ base: markdownLanguage }),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        keymap.of(editorKeyBindings()),
        EditorState.allowMultipleSelections.of(true),
        wrapping.current.of(EditorView.lineWrapping),
        proofing.current.of(writingExtension()),
        typewriter.current.of(typewriterScrollExtension(initialTypewriter)),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            if (!update.transactions.some((tr) => tr.annotation(externalValueSync))) {
              const beforeDoc = update.startState.doc.toString();
              const afterDoc = update.state.doc.toString();
              if (beforeDoc.length + afterDoc.length <= 2_000_000) {
                const list = selectionHistories.get(sessionId) || [];
                list.push({
                  beforeDoc,
                  afterDoc,
                  beforeSelection: update.startState.selection,
                  afterSelection: update.state.selection,
                });
                while (list.length > 60) list.shift();
                selectionHistories.set(sessionId, list);
              }
            }
            const changes:SourceChange[]=[];
            update.changes.iterChanges((from,to,_fromB,_toB,insert)=>changes.push({from,to,insert:insert.toString()}));
            callbacks.get(sessionId)?.(update.state.doc.toString(),changes);
          }
          if (update.docChanged || update.selectionSet || update.viewportChanged) {
            if (update.docChanged || update.selectionSet) statusHandlers.get(sessionId)?.(update.state);
            if (update.state.doc.length > PROOFREADING_MAX_CHARS) rangeHandlers.get(sessionId)?.(sourceProofreadingRange(update.view));
          }
        }),
        appearance.current.of(editorTheme())
      ]
    };
    let state = cached?.state.doc.toString() === value ? cached.state : EditorState.create(config);
    if (incoming) {
      try {
        const restored = EditorState.fromJSON(incoming.state, config, {history: historyField});
        if (restored.doc.toString() === value) state = restored;
      } catch { /* Invalid/oversized optional view state must not block the note. */ }
    }
    view.current = new EditorView({ state, parent: host.current });
    visibleEditors.set(sessionId, view.current);
    if (cached && state === cached.state && cached.typewriterActive !== initialTypewriter) {
      view.current.dispatch({ effects: typewriter.current.reconfigure(typewriterScrollExtension(initialTypewriter)) });
    }
    appliedTypewriter.current = initialTypewriter;
    describeSelection(view.current.state);
    if (cached) view.current.scrollDOM.scrollTop = cached.top;
    if (incoming) view.current.scrollDOM.scrollTop = Math.max(0, incoming.top);
    if (!cached && !incoming && initialTypewriter) view.current.dispatch({ effects: centerCursorEffect(view.current.state) });
    if (view.current.state.doc.length > PROOFREADING_MAX_CHARS) setProofRange(sourceProofreadingRange(view.current));
    let scrollTimer: ReturnType<typeof setTimeout> | undefined;
    const onScroll = () => {
      const instance = view.current;
      if (!instance || instance.state.doc.length <= PROOFREADING_MAX_CHARS) return;
      const nextRange = sourceProofreadingRange(instance);
      rangeHandlers.get(sessionId)?.(nextRange);
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => {
        const current = view.current;
        if (!current || current.state.doc.length <= PROOFREADING_MAX_CHARS) return;
        const settled = sourceProofreadingRange(current);
        if (settled.from !== lastLintedRange.current.from || settled.to !== lastLintedRange.current.to) forceLinting(current);
      }, 600);
    };
    view.current.scrollDOM.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      clearTimeout(scrollTimer);
      view.current?.scrollDOM.removeEventListener("scroll", onScroll);
      visibleEditors.delete(sessionId);
      if (view.current) { sessions.delete(sessionId); sessions.set(sessionId, { state: view.current.state, top: view.current.scrollDOM.scrollTop, appearance: appearance.current, wrapping: wrapping.current,proofing:proofing.current, typewriter: typewriter.current, wrapped: wrapReference.current, typewriterActive: typewriterReference.current }); trimEditorSessions(); view.current.destroy(); }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  useEffect(() => subscribePersonalDictionary(() => {
    setDictionaryRevision(n => n + 1);
    const instance = view.current;
    if (!instance) return;
    const kept: Diagnostic[] = [];
    forEachDiagnostic(instance.state, (d, dFrom, dTo) => {
      if (!(d.source === "Spelling" && hasPersonalWord(instance.state.sliceDoc(dFrom, dTo)))) kept.push({ ...d, from: dFrom, to: dTo });
    });
    instance.dispatch({ ...setDiagnostics(instance.state, kept), annotations: Transaction.addToHistory.of(false) });
  }), []);

  useEffect(() => { view.current?.dispatch({ effects: appearance.current.reconfigure(editorTheme()) }); }, [dark, focusMode]);
  useEffect(() => { view.current?.dispatch({ effects: wrapping.current.reconfigure(wrap ? EditorView.lineWrapping : []) }); }, [wrap]);
  useEffect(()=>{
    const instance=view.current;
    if(!instance)return;
    if(instance.state.doc.length>PROOFREADING_MAX_CHARS)setProofRange(sourceProofreadingRange(instance));
    instance.dispatch({effects:proofing.current.reconfigure(writingExtension())});
  },[spellCheck,grammarCheck,sessionId,dictionaryRevision]);
  useEffect(() => {
    const instance = view.current;
    if (!instance || appliedTypewriter.current === activeTypewriter) return;
    appliedTypewriter.current = activeTypewriter;
    const beforePad = Number.parseFloat(getComputedStyle(instance.scrollDOM).paddingTop) || 0;
    instance.dispatch({
      effects: [
        typewriter.current.reconfigure(typewriterScrollExtension(activeTypewriter)),
        ...(activeTypewriter ? [centerCursorEffect(instance.state)] : []),
      ],
    });
    if (!activeTypewriter) {
      const afterPad = Number.parseFloat(getComputedStyle(instance.scrollDOM).paddingTop) || 0;
      if (afterPad !== beforePad) instance.scrollDOM.scrollTop = Math.max(0, instance.scrollDOM.scrollTop + (afterPad - beforePad));
    }
  }, [activeTypewriter, sessionId]);

  useEffect(() => {
    const instance = view.current;
    if (!instance) return;
    const previous = instance.state.doc.toString();
    if (previous === value) return;
    let from = 0;
    while (from < previous.length && from < value.length && previous[from] === value[from]) from++;
    let oldEnd = previous.length, newEnd = value.length;
    while (oldEnd > from && newEnd > from && previous[oldEnd - 1] === value[newEnd - 1]) { oldEnd--; newEnd--; }
    let restoredSelection: EditorSelection | undefined;
    const recorded = selectionHistories.get(sessionId);
    if (recorded) {
      for (let i = recorded.length - 1; i >= 0; i--) {
        const item = recorded[i];
        if (item.afterDoc === previous && item.beforeDoc === value) {
          restoredSelection = item.beforeSelection;
          break;
        }
        if (item.beforeDoc === previous && item.afterDoc === value) {
          restoredSelection = item.afterSelection;
          break;
        }
      }
    }
    instance.dispatch({
      changes: { from, to: oldEnd, insert: value.slice(from, newEnd) },
      ...(restoredSelection ? { selection: restoredSelection } : {}),
      annotations: [Transaction.addToHistory.of(false), externalValueSync.of(true)],
    });
  }, [value, sessionId]);

  useEffect(() => {
    const open = () => view.current && openSearchPanel(view.current);
    const navigate = (event: Event) => {
      const editor = view.current;
      if (!editor) return;
      const offset = Math.max(0, Math.min(editor.state.doc.length, Number((event as CustomEvent).detail) || 0));
      editor.dispatch({ selection: { anchor: offset }, effects: EditorView.scrollIntoView(offset, { y: "start" }) });
      editor.focus();
    };
    window.addEventListener("supermd-find", open);
    window.addEventListener("supermd-goto-offset", navigate);
    return () => { window.removeEventListener("supermd-find", open); window.removeEventListener("supermd-goto-offset", navigate); };
  }, []);

  useEffect(() => {
    const point = (event: Event) => {
      const instance = view.current;
      if (!instance) return;
      const detail = (event as CustomEvent<{ point?: { from: number; to: number }; x?: number; y?: number; coords?: { x: number; y: number } }>).detail;
      if (!detail) return;
      const x = typeof detail.x === "number" ? detail.x : detail.coords?.x;
      const y = typeof detail.y === "number" ? detail.y : detail.coords?.y;
      if (typeof x === "number" && typeof y === "number" && Number.isFinite(x) && Number.isFinite(y)) {
        const bounds = instance.dom.getBoundingClientRect();
        const inBounds = (bounds.width === 0 && bounds.height === 0) || (x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom);
        if (inBounds) {
          const at = instance.posAtCoords({ x, y });
          if (at !== null) {
            detail.point = { from: at, to: at };
            return;
          }
        } else if (document.querySelector(".android-reading")) {
          return;
        }
      }
      detail.point = { from: instance.state.selection.main.from, to: instance.state.selection.main.to };
    };
    window.addEventListener("supermd-insertion-point", point);
    return () => window.removeEventListener("supermd-insertion-point", point);
  }, []);

  useEffect(() => {
    const format = (event: Event) => {
      const instance = view.current;
      if (!instance) return;
      const detail = (event as CustomEvent<{ action?: string; prefix?: string; suffix?: string; block?: boolean }>).detail;
      const action = normalizeFormatAction(detail?.action);
      if (action) {
        applyEditorFormat(instance, action);
        return;
      }
      const prefix = detail?.prefix ?? "";
      if (detail?.block) {
        notifyHistoryBoundary();
        instance.dispatch({ changes: { from: instance.state.selection.main.head, insert: prefix }, annotations: isolateHistory.of("full"), userEvent: "input.format" });
        notifyHistoryBoundary();
        instance.focus();
        return;
      }
      const suffix = detail?.suffix ?? prefix;
      const changes = instance.state.selection.ranges.map((range) => ({
        from: range.from,
        to: range.to,
        insert: `${prefix}${instance.state.sliceDoc(range.from, range.to)}${suffix}`
      }));
      const mapped = instance.state.changes(changes);
      const ranges = instance.state.selection.ranges.map((range) => {
        const start = mapped.mapPos(range.from, -1) + prefix.length;
        const end = start + range.to - range.from;
        return range.anchor > range.head ? EditorSelection.range(end, start) : EditorSelection.range(start, end);
      });
      notifyHistoryBoundary();
      instance.dispatch({ changes: mapped, selection: EditorSelection.create(ranges, instance.state.selection.mainIndex), annotations: isolateHistory.of("full"), userEvent: "input.format" });
      notifyHistoryBoundary();
      instance.focus();
    };
    window.addEventListener("supermd-format", format);
    return () => window.removeEventListener("supermd-format", format);
  }, []);

  const showProofRange = Boolean((spellCheck || grammarCheck) && value.length > PROOFREADING_MAX_CHARS);
  const clampedFrom = showProofRange ? Math.max(0, Math.min(value.length - 1, proofRange?.from ?? 0)) : 0;
  const clampedTo = showProofRange ? Math.max(clampedFrom + 1, Math.min(value.length, proofRange?.to ?? Math.min(value.length, PROOFREADING_MAX_CHARS))) : 0;

  return <div className="source-editor-shell">
    <div className="editor-host" ref={host} aria-label="Markdown editor" />
    <footer className="source-editor-status" aria-label="Source editor status">
      <span className="source-language">Markdown</span>
      <span ref={position} className="source-position">Ln 1, Col 1</span>
      {showProofRange && <span className="source-proofreading-range" role="status">12,000-character range ({(clampedFrom + 1).toLocaleString("en-US")}–{clampedTo.toLocaleString("en-US")} of {value.length.toLocaleString("en-US")})</span>}
      <span className="source-status-spacer" />
      <button type="button" aria-pressed={activeTypewriter} title="Toggle typewriter scrolling (Ctrl+Alt+T)" onClick={() => { const next = !activeTypewriter; setTypewriterScroll(next, { persist: !onTypewriterChange }); onTypewriterChange?.(next); }}>Typewriter</button>
      <button type="button" aria-pressed={wrap} title="Toggle line wrapping" onClick={() => setWrap(current => !current)}>Wrap lines</button>
      <span className="source-encoding">UTF-8</span>
    </footer>
  </div>;
}
