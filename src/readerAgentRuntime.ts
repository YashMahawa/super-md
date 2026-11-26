import { useLayoutEffect, type RefObject } from "react";
import { agentCharLength, agentCodePointOffset, agentOutlinePage, agentRead, agentRevision, agentSearch, agentSectionForExport, agentUtf16Offset, applyAgentPatchesDetailed, countCodePointsRange } from "./agentOperations";
import { suggestMathRepairs, applyMathRepairs } from "./mathRepair";
import { agentDiagrams, diagramMetadata, diagramMedia, visibleSourceRange, type AgentDiagramOptions } from "./agentView";
import { mediaBytes } from "./mediaExport";
import { editorReadingOffset, editorSelectedText, editorViewContext } from "./components/Editor";
import { readingOffset } from "./readingPosition";
import { inspectCachedPythonOutput, safePythonFigure } from "./renderedOutputs";
import { analyzeDocument } from "./documentAnalysis";
import { invoke } from "./nativeBridge";
import type { ReaderEdits } from "./readerEdits";
import { preparePdf } from "./preparePdf";
import { prepareFmd } from "./documentMedia";
import { prepareMarkdownExport } from "./markdownExport";
import { readerSourceAnalysis } from "./readerSourceAnalysis";
import type { NoteHistory } from "./noteHistory";
import type { AnchorViewMode } from "./sourceAnchor";

declare global {
  interface Window {
    supermdAgentRequest?: (request: Record<string, unknown>, callback?: (result: unknown, error: string) => void) => void;
    supermdAgentCompute?: (request: Record<string, unknown>, callback: (result: unknown, error: string) => void) => void;
  }
}

type AgentDocumentBase = { tabId: string; revision: string; sourceLength: number };
function resolveAgentDiagram(content: string, revision: string, request: Record<string, unknown>, diagramOptions?: AgentDiagramOptions) {
  if (request.expectedRevision !== revision) throw Error("A current expectedRevision is required to retrieve this diagram");
  const diagram = agentDiagrams(content, diagramOptions).find(item => item.id === request.diagramId);
  if (!diagram) throw Error("Diagram not found in this revision");
  return diagram;
}
function readAgentDocument(content: string, base: AgentDocumentBase, request: Record<string, unknown>, diagramOptions?: AgentDiagramOptions): Record<string, unknown> | null {
  if (request.expectedRevision !== undefined && request.expectedRevision !== base.revision) throw Error("Revision conflict: the note changed; read it again before editing");
  const action = request.action;
  if (action === "read_tab") return { ...base, ...agentRead(content, request.offset, request.limit, request.heading, request.view) };
  if (action === "outline_tab") return { ...base, ...agentOutlinePage(content, request.offset, request.limit) };
  if (action === "search_tab") return { ...base, ...agentSearch(content, request.query, request.limit, request.context, { offset: request.offset, caseSensitive: request.caseSensitive, wholeWord: request.wholeWord, regex: request.regex, excludeDiagrams: request.excludeDiagrams }) };
  const resolvedDiagramOptions = diagramOptions ?? { documentPath: typeof request.path === "string" ? request.path : undefined, python: typeof request.python === "string" ? request.python : undefined };
  if (action === "list_diagrams") {
    const diagrams = agentDiagrams(content, resolvedDiagramOptions), offset = request.offset === undefined ? 0 : request.offset, limit = request.limit === undefined ? 80 : request.limit;
    if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0) throw Error("diagram offset must be a nonnegative integer");
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 80) throw Error("diagram limit must be 1–80");
    if (offset > diagrams.length) throw Error(`diagram offset must be between 0 and ${diagrams.length}`);
    const end = Math.min(diagrams.length, offset + limit);
    return { ...base, diagrams: diagrams.slice(offset, end).map(item => diagramMetadata(content, item)), total: diagrams.length, nextOffset: end < diagrams.length ? end : null, truncated: end < diagrams.length };
  }
  if (action === "get_diagram") {
    const diagram = resolveAgentDiagram(content, base.revision, request, resolvedDiagramOptions);
    return { ...base, ...diagramMetadata(content, diagram), ...agentRead(diagram.source, request.offset, request.limit, undefined, "source") };
  }
  return null;
}
/** Pure snapshot operations for native-owned inactive tabs. `content` is added
 * only by the trusted native router and is never accepted from MCP requests. */
export async function computeAgentDocumentRequest(request: Record<string, unknown>): Promise<Record<string, unknown>> {
  const content = request.content, tabId = request.tabId, action = request.action;
  if (typeof content !== "string" || typeof tabId !== "string") throw Error("Native document snapshot is required");
  const revision = await agentRevision(content), sourceLength = agentCharLength(content), base = { tabId, revision, sourceLength };
  const readResult = readAgentDocument(content, base, request);
  if (readResult) return readResult;
  if (action === "patch_tab") {
    if (typeof request.expectedRevision !== "string" || request.expectedRevision !== revision) throw Error("A current expectedRevision is required to edit a tab");
    const patch = applyAgentPatchesDetailed(content, request.operations);
    return { ...base, baseRevision: revision, baseSourceLength: sourceLength, revision: await agentRevision(patch.text), sourceLength: agentCharLength(patch.text), changed: patch.text !== content, applied: patch.applied, operations: patch.operations, patchedContent: patch.text };
  }
  if (action === "get_diagram_image") throw Error("Diagram image requests require the active reader view");
  throw Error("Unsupported snapshot agent action");
}

export interface AgentRuntimeNote { id: string; content: string; path: string | null; mode: AnchorViewMode; python?: string; editProtocol?: number }
export interface UseReaderAgentRuntimeOptions {
  reference: RefObject<AgentRuntimeNote | null>;
  edits: RefObject<ReaderEdits | null>;
  zoomReference: RefObject<number>;
  histories: RefObject<Map<string, NoteHistory>>;
  trustedHostsRef: RefObject<string[]>;
  update: (content: string) => void;
}

export function useReaderAgentRuntime({ reference, edits, zoomReference, histories, trustedHostsRef, update }: UseReaderAgentRuntimeOptions): void {
  useLayoutEffect(() => {
    const MAX_AGENT_QUEUE = 16;
    let active = false, disposed = false;
    const queue: Array<{ request: Record<string, unknown>; reply: (result: unknown, error?: string) => void }> = [];
    const executeRequest = async (request: Record<string, unknown>) => {
      const current = reference.current; if (!current) throw Error("The reader is not ready");
      if (current.editProtocol === 1) await edits.current!.flush(current.id);
      const note = reference.current; if (!note || note.id !== current.id) throw Error("The active tab changed; refresh the tab list");
      const revision = await agentRevision(note.content);
      if (reference.current?.id !== note.id || reference.current.content !== note.content) throw Error("The note changed while reading; retry");
      const base = { tabId: note.id, revision, sourceLength: agentCharLength(note.content) };
      const diagramOptions = { documentPath: note.path, python: note.python || "embedded" };
      if (request.action === "flush_current") return base;
      if (request.action === "list_tabs") {
        const tabs = Array.isArray(request.tabs) ? request.tabs : [];
        return { tabs: tabs.map(item => { const tab = item as Record<string, unknown>; return tab.id === note.id ? { ...tab, ...base, id: note.id } : tab; }) };
      }
      if (request.tabId !== undefined && request.tabId !== note.id) throw Error("Select this tab before requesting its live reader");
      const readResult = readAgentDocument(note.content, base, request, diagramOptions); if (readResult) return readResult;
      if (request.action === "get_diagram_image") {
        const diagram = resolveAgentDiagram(note.content, revision, request, diagramOptions);
        const imageFormat = request.imageFormat === "jpeg" ? "jpeg" : "png";
        const image = await mediaBytes(await diagramMedia(diagram, note.path), imageFormat, typeof request.width === "number" ? Math.min(1600, Math.max(64, Math.round(request.width))) : 1600);
        return { ...base, diagramId: diagram.id, mime_type: image.mimeType, data: image.body, width: image.width, height: image.height };
      }
      if (request.action === "get_context") {
        const analysis = readerSourceAnalysis(note.mode, note.content)?.analysis ?? analyzeDocument(note.content);
        const headingAtOffset = (utf16Offset: number) => {
          let current = "";
          for (const item of analysis.outline) { if (item.offset <= utf16Offset) current = item.title; else break; }
          return current.slice(0, 300);
        };
        const cleanNodeText = (element: HTMLElement) => {
          const copy = element.cloneNode(true) as HTMLElement;
          copy.querySelectorAll('.katex-mathml,button,script,style,[inert],[aria-hidden="true"]').forEach(node => node.remove());
          return copy.textContent?.trim() ?? "";
        };
        const requestedContextLimit = typeof request.limit === "number" && Number.isFinite(request.limit) ? Math.max(1, Math.min(12000, Math.floor(request.limit))) : 6000;
        let host: HTMLElement | null = null;
        let visibleText = "";
        let heading = "";
        let scrollFraction = 0;
        let range: { start: number; end: number } | null = null;
        let offset = 0;
        let selectionText = "";

        if (note.mode === "editor") {
          const editorCtx = editorViewContext(note.id);
          host = editorCtx?.scroller ?? document.querySelector<HTMLElement>(".cm-scroller");
          if (editorCtx) {
            offset = editorCtx.offset;
            range = { start: editorCtx.visibleStart, end: editorCtx.visibleEnd };
            visibleText = editorCtx.visibleText;
            scrollFraction = editorCtx.scrollFraction;
            selectionText = editorCtx.selectionText || window.getSelection()?.toString() || "";
          } else {
            offset = editorReadingOffset(note.id) ?? 0;
            selectionText = editorSelectedText(note.id) || window.getSelection()?.toString() || "";
            visibleText = note.content.slice(offset, offset + 2000).trim();
          }
          heading = headingAtOffset(offset);
        } else {
          host = document.querySelector<HTMLElement>(".android-reading");
          const bounds = host?.getBoundingClientRect();
          const activeTextarea = note.mode === "live" ? host?.querySelector<HTMLTextAreaElement>(".live-active-block textarea") : null;
          const visibleParts: string[] = [];
          let firstBlockHeading = "";
          if (host && bounds) {
            const candidates = Array.from(host.querySelectorAll<HTMLElement>("h1,h2,h3,h4,p,li,pre,.live-active-block textarea"));
            for (const element of candidates) {
              if (element instanceof HTMLTextAreaElement) {
                const box = element.getBoundingClientRect();
                if (box.bottom > bounds.top && box.top < bounds.bottom && box.height > 0) {
                  const draft = element.value.trim();
                  if (draft) visibleParts.push(draft);
                }
                continue;
              }
              if (element.closest(".live-active-block")) continue;
              const box = element.getBoundingClientRect();
              if (box.bottom > bounds.top && box.top < bounds.bottom && box.height > 0) {
                if (!firstBlockHeading && /^H[1-6]$/.test(element.tagName)) firstBlockHeading = element.textContent?.trim().slice(0, 300) ?? "";
                const text = cleanNodeText(element);
                if (text) visibleParts.push(text);
              }
              if (visibleParts.length >= 30) break;
            }
          }
          range = host ? visibleSourceRange(host, note.content) : null;
          if (activeTextarea && bounds) {
            const taRect = activeTextarea.getBoundingClientRect();
            const taStart = Number(activeTextarea.dataset.sourceStart);
            if (Number.isInteger(taStart) && taStart >= 0 && taRect.bottom > bounds.top && taRect.top < bounds.bottom && taRect.height > 0) {
              const taEnd = Math.min(note.content.length, taStart + activeTextarea.value.length);
              range = range ? { start: Math.min(range.start, taStart), end: Math.max(range.end, taEnd) } : taEnd > taStart ? { start: taStart, end: taEnd } : null;
            }
          }
          offset = range?.start ?? (host ? readingOffset(host) : 0);
          if (activeTextarea && activeTextarea.selectionEnd > activeTextarea.selectionStart) {
            const taStart = Number(activeTextarea.dataset.sourceStart);
            if (Number.isInteger(taStart) && taStart >= 0) offset = Math.min(note.content.length, taStart + activeTextarea.selectionStart);
          }
          heading = firstBlockHeading || headingAtOffset(offset);
          scrollFraction = host ? host.scrollTop / Math.max(1, host.scrollHeight - host.clientHeight) : 0;
          visibleText = visibleParts.join("\n").slice(0, 2000);
          if (note.mode === "split") {
            selectionText = editorSelectedText(note.id) || window.getSelection()?.toString() || "";
          } else if (note.mode === "live" && activeTextarea && activeTextarea.selectionEnd > activeTextarea.selectionStart) {
            selectionText = activeTextarea.value.slice(activeTextarea.selectionStart, activeTextarea.selectionEnd);
          } else {
            selectionText = window.getSelection()?.toString() || "";
          }
        }

        // Inspect active StepCards decks (both inline and portaled .step-viewer dialogs on document.body).
        interface ActiveDeckState { deckTitle: string; stepLabel: string; stepIndex: number; stepCount: number; start?: number; end?: number; expanded: boolean; notesText: string }
        const activeDecks: ActiveDeckState[] = [];
        const readDeckState = (cardEl: HTMLElement, sourceAnchor: Element | null, expanded: boolean): ActiveDeckState | null => {
          const deckTitle = cardEl.dataset.deckTitle?.trim() || "";
          const stepLabel = cardEl.dataset.stepLabel?.trim() || "";
          const stepIndex = Number(cardEl.dataset.stepIndex);
          const stepCount = Number(cardEl.dataset.stepCount);
          if (!deckTitle || !Number.isInteger(stepIndex) || stepIndex < 0 || !Number.isInteger(stepCount) || stepCount < 1) return null;
          const block = sourceAnchor?.closest<HTMLElement>("[data-source-start][data-source-end]");
          const start = block ? Number(block.dataset.sourceStart) : NaN;
          const end = block ? Number(block.dataset.sourceEnd) : NaN;
          const notesEl = cardEl.querySelector<HTMLElement>(".step-cards-notes");
          const notesParts: string[] = [];
          if (stepLabel) notesParts.push(stepLabel);
          if (notesEl) {
            const desc = notesEl.querySelector<HTMLElement>(".step-cards-description");
            if (desc) { const cleaned = cleanNodeText(desc); if (cleaned) notesParts.push(cleaned); }
            else {
              const legacy = notesEl.querySelector<HTMLElement>(".step-cards-legacy-note");
              if (legacy) { const cleaned = cleanNodeText(legacy); if (cleaned) notesParts.push(cleaned); }
            }
          }
          return {
            deckTitle, stepLabel, stepIndex, stepCount, expanded,
            ...(Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start ? { start, end } : {}),
            notesText: notesParts.join("\n").trim(),
          };
        };
        for (const viewer of document.querySelectorAll<HTMLElement>(".step-viewer")) {
          const cardEl = viewer.querySelector<HTMLElement>(".step-cards");
          if (!cardEl) continue;
          const deckId = cardEl.dataset.stepDeckId;
          const placeholder = deckId && host ? Array.from(host.querySelectorAll<HTMLElement>(".step-cards-placeholder")).find(el => el.dataset.stepDeckId === deckId) ?? null : null;
          const parsed = readDeckState(cardEl, placeholder, true);
          if (parsed) activeDecks.push(parsed);
        }
        if (host) {
          const hostBounds = host.getBoundingClientRect();
          for (const cardEl of host.querySelectorAll<HTMLElement>(".step-cards")) {
            const box = cardEl.getBoundingClientRect();
            if (box.height <= 0 || box.bottom <= hostBounds.top || box.top >= hostBounds.bottom) continue;
            const parsed = readDeckState(cardEl, cardEl, false);
            if (parsed) activeDecks.push(parsed);
          }
        }
        const primaryDeck = activeDecks.find(d => d.expanded) ?? activeDecks[0];
        if (primaryDeck?.expanded) {
          if (primaryDeck.notesText) {
            const slideSummary = `${primaryDeck.deckTitle} — ${primaryDeck.notesText}`;
            visibleText = [slideSummary, visibleText].filter(Boolean).join("\n").slice(0, 2000);
          }
          if (primaryDeck.start !== undefined && primaryDeck.end !== undefined) {
            offset = primaryDeck.start;
            range = range ? { start: Math.min(range.start, primaryDeck.start), end: Math.max(range.end, primaryDeck.end) } : { start: primaryDeck.start, end: primaryDeck.end };
          }
        } else if (primaryDeck && primaryDeck.notesText && !visibleText.includes(primaryDeck.stepLabel)) {
          visibleText = [visibleText, `${primaryDeck.deckTitle} — ${primaryDeck.notesText}`].filter(Boolean).join("\n").slice(0, 2000);
        }

        const visibleRange = range ?? { start: offset, end: Math.min(note.content.length, offset + requestedContextLimit) };
        const sourceOffset = agentCodePointOffset(note.content, offset), sourceLimit = Math.max(1, Math.min(requestedContextLimit, countCodePointsRange(note.content, offset, visibleRange.end)));
        let diagramScanRange: { start: number; end: number } | null = activeDecks.some(deck => deck.expanded && deck.start === undefined) ? null : { ...visibleRange };
        if (diagramScanRange) {
          for (const deck of activeDecks) {
            if (deck.expanded && deck.start !== undefined && deck.end !== undefined) {
              diagramScanRange = { start: Math.min(diagramScanRange.start, deck.start), end: Math.max(diagramScanRange.end, deck.end) };
            }
          }
        }
        const allDiagrams = agentDiagrams(note.content, diagramScanRange ? { ...diagramOptions, range: diagramScanRange } : diagramOptions);
        const filteredDiagrams = allDiagrams.filter(item => {
          if (activeDecks.some(deck => deck.expanded && (deck.start !== undefined ? item.start === deck.start : item.deckTitle === deck.deckTitle))) return true;
          return range ? item.end > range.start && item.start < range.end : item.start >= offset && item.start < offset + requestedContextLimit;
        }).map(item => {
          if (item.stepIndex === undefined) return item;
          const matchingDeck = activeDecks.find(deck => deck.start !== undefined ? deck.start === item.start : deck.deckTitle === item.deckTitle);
          return matchingDeck ? { ...item, activeStep: item.stepIndex === matchingDeck.stepIndex } : item;
        });
        // Prioritize active slide diagrams so a 30-item cap never drops the open slide.
        filteredDiagrams.sort((a, b) => Number(b.activeStep === true) - Number(a.activeStep === true));

        // Summarize cached outputs for executed Python cells without ever running unexecuted code.
        const pythonCells: Array<Record<string, unknown>> = [];
        let cellOrdinal = 0;
        const walkPython = (node: any) => {
          if (pythonCells.length >= 8) return;
          if (node.position?.start?.offset !== undefined && node.position?.end?.offset !== undefined && (node.position.end.offset <= visibleRange.start || node.position.start.offset >= visibleRange.end)) return;
          if (node.type === "code" && ["python", "py"].includes(String(node.lang || "").toLowerCase()) && node.position?.start?.offset !== undefined && node.position?.end?.offset !== undefined) {
            const cellStart = node.position.start.offset, cellEnd = node.position.end.offset;
            const pyIndex = analysis.pythonCells.findIndex(cell => cell.offset === cellStart && cell.source === String(node.value || ""));
            const ordinal = pyIndex >= 0 ? pyIndex : cellOrdinal++;
            const inRange = range ? cellEnd > range.start && cellStart < range.end : cellStart >= offset && cellStart < offset + requestedContextLimit;
            if (inRange && pythonCells.length < 8) {
              const duplicateOrdinal = pyIndex >= 0 ? analysis.pythonCells[pyIndex].ordinal : 0;
              const cached = inspectCachedPythonOutput(node.value, { document: note.path ?? null, cell: String(duplicateOrdinal), interpreter: note.python || "embedded" });
              if (cached) {
                const codeStart = agentCodePointOffset(note.content, cellStart), codeEnd = agentCodePointOffset(note.content, cellEnd);
                const figures = cached.images.filter(safePythonFigure).slice(0, 16).map((_, idx) => `diagram:python:${codeStart}:${idx}`);
                const stdoutLimit = 500, stderrLimit = 500;
                pythonCells.push({
                  ordinal,
                  sourceStart: codeStart,
                  sourceEnd: codeEnd,
                  ok: cached.ok,
                  stdout: cached.stdout.slice(0, stdoutLimit),
                  ...(cached.stdout.length > stdoutLimit ? { stdoutTruncated: true } : {}),
                  stderr: cached.stderr.slice(0, stderrLimit),
                  ...(cached.stderr.length > stderrLimit ? { stderrTruncated: true } : {}),
                  figureIds: figures,
                });
              }
            }
          }
          for (const child of node.children ?? []) walkPython(child);
        };
        walkPython(analysis.tree);

        const splitRangeEnd = !!range && range.end > 0 && range.end < note.content.length && note.content.charCodeAt(range.end - 1) >= 0xd800 && note.content.charCodeAt(range.end - 1) <= 0xdbff && note.content.charCodeAt(range.end) >= 0xdc00 && note.content.charCodeAt(range.end) <= 0xdfff;
        const visiblePage = splitRangeEnd
          ? agentRead(note.content.slice(0, range!.end), sourceOffset, sourceLimit)
          : agentRead(note.content, sourceOffset, sourceLimit, undefined, "prose", range ? Math.max(sourceOffset, agentCodePointOffset(note.content, range.end)) : undefined);
        // The viewport bounds the page text, not the document's pagination.
        const visibleSource = { ...visiblePage, total_chars: base.sourceLength, next_offset: visiblePage.end < base.sourceLength ? visiblePage.end : null, truncated: visiblePage.end < base.sourceLength };
        const portalViewer = primaryDeck?.expanded ? document.querySelector<HTMLElement>(".step-viewer") : null;
        const viewportRect = (portalViewer ?? host)?.getBoundingClientRect();
        const left = viewportRect ? Math.max(0, viewportRect.left) : 0, top = viewportRect ? Math.max(0, viewportRect.top) : 0;
        const right = viewportRect ? Math.min(window.innerWidth, viewportRect.right) : 0, bottom = viewportRect ? Math.min(window.innerHeight, viewportRect.bottom) : 0;
        const activeStepSummary = primaryDeck ? {
          deckTitle: primaryDeck.deckTitle.slice(0, 200),
          stepLabel: primaryDeck.stepLabel.slice(0, 200),
          stepIndex: primaryDeck.stepIndex,
          stepCount: primaryDeck.stepCount,
          activeStep: true as const,
          ...(primaryDeck.expanded ? { expanded: true } : {}),
        } : undefined;
        const contextPayload: Record<string, unknown> = {
          ...base,
          mode: note.mode,
          zoom: zoomReference.current,
          reading: { offset: sourceOffset, scrollFraction, heading, visibleText },
          visibleSource,
          diagrams: filteredDiagrams.slice(0, 30).map(item => diagramMetadata(note.content, item)),
          ...(pythonCells.length ? { pythonCells } : {}),
          ...(activeStepSummary ? { activeStep: activeStepSummary } : {}),
          viewport: { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top), viewportWidth: window.innerWidth, viewportHeight: window.innerHeight, devicePixelRatio: window.devicePixelRatio },
          selection: { text: selectionText.slice(0, 2000) },
        };
        // Enforce local MCP's 24 KB UTF-8 cap on get_context responses.
        const encodedSize = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
        if (encodedSize(contextPayload) > 23_000 && Array.isArray(contextPayload.pythonCells)) {
          contextPayload.pythonCells = (contextPayload.pythonCells as Array<Record<string, unknown>>).slice(0, 4).map(cell => ({ ...cell, stdout: String(cell.stdout ?? "").slice(0, 200), stderr: String(cell.stderr ?? "").slice(0, 200) }));
        }
        while (encodedSize(contextPayload) > 23_000) {
          const vs = contextPayload.visibleSource as Record<string, unknown>;
          const currentText = String(vs.text ?? "");
          if (currentText.length <= 200) break;
          const currentChars = agentCharLength(currentText);
          if (currentChars <= 200) break;
          const targetChars = Math.max(200, Math.floor(currentChars * 0.7));
          const trimmed = currentText.slice(0, agentUtf16Offset(currentText, targetChars));
          const nextEnd = (vs.start as number) + targetChars;
          contextPayload.visibleSource = { ...vs, text: trimmed, returned_chars: targetChars, end: nextEnd, next_offset: nextEnd < base.sourceLength ? nextEnd : null, truncated: nextEnd < base.sourceLength };
        }
        return contextPayload;
      }
      if (request.action === "latex_review") {
        const repairs = suggestMathRepairs(note.content); let remaining = 48000;
        const view = [];
        for (const [index, repair] of repairs.slice(0, 40).entries()) {
          const item = { index, before: repair.before.slice(0, 2000), after: repair.after.slice(0, 2000), reason: repair.reason }, size = JSON.stringify(item).length;
          if (size > remaining) break; remaining -= size; view.push(item);
        }
        return { ...base, repairs: view, total: repairs.length, truncated: view.length < repairs.length };
      }
      if (request.action === "patch_tab" || request.action === "latex_apply") {
        if (typeof request.expectedRevision !== "string" || request.expectedRevision !== revision) throw Error("A current expectedRevision is required to edit a tab");
        let content: string, applied = 0, patchOperations: unknown[] | undefined;
        if (request.action === "latex_apply") {
          const selected = request.repairIndices;
          if (!Array.isArray(selected) || !selected.length || selected.length > 40 || selected.some(index => !Number.isInteger(index) || index < 0)) throw Error("Choose 1–40 repairIndices from latex_review");
          const repairs = suggestMathRepairs(note.content), indices = Array.from(new Set(selected)) as number[];
          if (indices.some(index => index >= repairs.length)) throw Error("A selected repair is no longer available");
          content = applyMathRepairs(note.content, indices.map(index => repairs[index])); applied = indices.length;
        } else {
          const patch = applyAgentPatchesDetailed(note.content, request.operations); content = patch.text; applied = patch.applied; patchOperations = patch.operations;
        }
        if (reference.current?.id !== note.id || reference.current.content !== note.content) throw Error("Revision conflict: typing changed the note before the edit");
        const history = histories.current.get(note.id); if (history) history.last = 0;
        update(content); const nextHistory = histories.current.get(note.id); if (nextHistory) nextHistory.last = 0;
        if (note.editProtocol === 1) await edits.current!.flush(note.id);
        const response: { tabId: string; revision: string; changed: boolean; applied: number; operations?: unknown[] } = { tabId: note.id, revision: await agentRevision(content), changed: content !== note.content, applied };
        if (patchOperations) response.operations = patchOperations;
        return response;
      }
      if (request.action === "export_document") {
        const format = String(request.format); if (!["pdf", "smd", "md", "mdzip"].includes(format)) throw Error("Export format must be pdf, smd, md or mdzip");
        const suppliedOptions = request.options && typeof request.options === "object" && !Array.isArray(request.options) ? request.options as Record<string, unknown> : {};
        const rawArchive = Object.prototype.hasOwnProperty.call(suppliedOptions, "archive") ? suppliedOptions.archive : request.archive;
        if (rawArchive !== undefined && typeof rawArchive !== "boolean") throw Error("Export archive option must be a boolean");
        if (rawArchive === true && format !== "md" && format !== "mdzip") throw Error("Archive mode is only supported for Markdown exports");
        const archive = format === "mdzip" || rawArchive === true;
        const hasSection = Object.prototype.hasOwnProperty.call(suppliedOptions, "section"), section = hasSection ? agentSectionForExport(note.content, suppliedOptions.section) : undefined;
        const exportContent = section?.text ?? note.content, { section: _section, archive: _archive, ...exportOptions } = suppliedOptions;
        const prepared = format === "pdf" ? await preparePdf(exportContent, note.path, note.python || "embedded", { trustedImageHosts: trustedHostsRef.current }) : format === "smd" ? await prepareFmd(exportContent, note.path) : await prepareMarkdownExport(exportContent, note.path, { compatible: archive, python: note.python || "embedded" });
        if (reference.current?.id !== note.id || reference.current.content !== note.content) throw Error("Revision conflict: the note changed while preparing the export");
        const result = await invoke<Record<string, unknown>>("agent_export_native", { ...prepared, id: note.id, expectedRevision: revision, requestId: request.requestId, format: archive ? "mdzip" : format, ...(archive ? { archive: true } : {}), filename: request.filename, options: exportOptions });
        return section ? { ...result, sectionStart: section.sectionStart, sectionEnd: section.sectionEnd, documentLength: section.documentLength } : result;
      }
      throw Error("Unsupported live reader action");
    };
    const pumpQueue = () => {
      if (active || disposed) return;
      const next = queue.shift();
      if (!next) return;
      active = true;
      void executeRequest(next.request).then(
        result => { active = false; if (disposed) next.reply(null, "The reader view closed before completing the agent request"); else { next.reply(result); pumpQueue(); } },
        error => { active = false; if (disposed) next.reply(null, "The reader view closed before completing the agent request"); else { next.reply(null, error instanceof Error ? error.message : "Agent request failed"); pumpQueue(); } },
      );
    };
    const handleCompute: NonNullable<Window["supermdAgentCompute"]> = (request, callback) => {
      void computeAgentDocumentRequest(request).then(result => callback(result, ""), error => callback(null, error instanceof Error ? error.message : "Agent request failed"));
    };
    const handleRequest: NonNullable<Window["supermdAgentRequest"]> = (request, callback) => {
      let settled = false;
      const reply = (result: unknown, error = "") => {
        if (settled) return;
        settled = true;
        if (callback) callback(result, error);
        else void invoke("agent_result", { requestId: request.requestId, result, error });
      };
      if (disposed) { reply(null, "The reader view is unmounted"); return; }
      if (active && queue.length >= MAX_AGENT_QUEUE) { reply(null, "The reader agent request queue is full; retry shortly."); return; }
      queue.push({ request, reply });
      pumpQueue();
    };
    window.supermdAgentCompute = handleCompute;
    window.supermdAgentRequest = handleRequest;
    return () => {
      disposed = true;
      for (const pendingItem of queue.splice(0)) { pendingItem.reply(null, "The reader view closed before completing the agent request"); }
      if (window.supermdAgentRequest === handleRequest) delete window.supermdAgentRequest;
      if (window.supermdAgentCompute === handleCompute) delete window.supermdAgentCompute;
    };
  }, [update]);
}
