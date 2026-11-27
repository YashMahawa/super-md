import { compileSearchPattern, nextSearchMatch, type SearchMatchConfig } from "./windowedSearch";

export const STEP_REVEAL_EVENT = "supermd-reveal-step";

export interface StepRevealDetail {
  stepIndex: number;
  openLegacyNote?: boolean;
}

export interface DecodedStringSpan {
  contentStart: number;
  contentEnd: number;
  decoded: string;
  toSource: number[];
  trimStartIndex: number;
  trimEndIndex: number;
}

export interface StepSourceSpan {
  stepIndex: number;
  objectStart: number;
  objectEnd: number;
  labelSpan?: DecodedStringSpan;
  markdownSpan?: DecodedStringSpan;
  descriptionSpan?: DecodedStringSpan;
  chartTitleSpan?: DecodedStringSpan;
  hasMarkdown: boolean;
  hasLegacyDescription: boolean;
}

export interface StepDeckSourceInfo {
  titleSpan?: DecodedStringSpan;
  steps: StepSourceSpan[];
}

export type StepVisibleRegion =
  | "deck-title"
  | "chart-title"
  | "step-label"
  | "step-markdown"
  | "step-legacy-description";

export interface StepDeckOccurrenceClassification {
  stepIndex: number | null;
  openLegacyNote: boolean;
  visibleRegion: StepVisibleRegion | null;
  fieldSpan: DecodedStringSpan | null;
  decodedRange: { from: number; to: number } | null;
}

const NO_OCCURRENCE: StepDeckOccurrenceClassification = {
  stepIndex: null,
  openLegacyNote: false,
  visibleRegion: null,
  fieldSpan: null,
  decodedRange: null,
};

export function extractFenceBodySpan(rawFence: string, fenceStart: number): { body: string; bodyStart: number } | null {
  if (rawFence.trimStart().startsWith("{")) return { body: rawFence, bodyStart: fenceStart };
  let lead = 0;
  while (lead < rawFence.length && (rawFence[lead] === "\r" || rawFence[lead] === "\n")) lead++;
  const slice = lead ? rawFence.slice(lead) : rawFence;
  const base = fenceStart + lead;
  const firstBreak = slice.indexOf("\n");
  if (firstBreak < 0 || !/^[ \t>]*(?:`{3,}|~{3,})/.test(slice.slice(0, firstBreak))) return null;
  const bodyOffset = firstBreak + 1;
  let bodyEnd = slice.length;
  const trimmedEnd = slice.replace(/[ \t\r\n]+$/, "");
  const lastBreak = trimmedEnd.lastIndexOf("\n");
  if (lastBreak >= firstBreak && /^[ \t>]*(?:`{3,}|~{3,})[ \t]*$/.test(trimmedEnd.slice(lastBreak + 1))) {
    bodyEnd = lastBreak;
  }
  return bodyEnd >= bodyOffset ? { body: slice.slice(bodyOffset, bodyEnd), bodyStart: base + bodyOffset } : null;
}

function decodeJsonStringWithOffsets(rawContent: string, contentStart: number): DecodedStringSpan | null {
  let decoded = "";
  const toSource: number[] = [];
  for (let i = 0; i < rawContent.length; ) {
    const ch = rawContent[i];
    if (ch === "\\") {
      if (i + 1 >= rawContent.length) return null;
      const esc = rawContent[i + 1];
      let mapped = "";
      let advance = 2;
      switch (esc) {
        case "\"": mapped = "\""; break;
        case "\\": mapped = "\\"; break;
        case "/": mapped = "/"; break;
        case "b": mapped = "\b"; break;
        case "f": mapped = "\f"; break;
        case "n": mapped = "\n"; break;
        case "r": mapped = "\r"; break;
        case "t": mapped = "\t"; break;
        case "u": {
          const hex = rawContent.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
          mapped = String.fromCharCode(parseInt(hex, 16));
          advance = 6;
          break;
        }
        default: return null;
      }
      toSource.push(contentStart + i);
      decoded += mapped;
      i += advance;
    } else {
      toSource.push(contentStart + i);
      decoded += ch;
      i += 1;
    }
  }
  toSource.push(contentStart + rawContent.length);
  let trimStartIndex = 0;
  while (trimStartIndex < decoded.length && /\s/.test(decoded[trimStartIndex])) trimStartIndex++;
  let trimEndIndex = decoded.length;
  while (trimEndIndex > trimStartIndex && /\s/.test(decoded[trimEndIndex - 1])) trimEndIndex--;
  return { contentStart, contentEnd: contentStart + rawContent.length, decoded, toSource, trimStartIndex, trimEndIndex };
}

class JsonSpanScanner {
  private readonly text: string;
  private readonly base: number;

  constructor(text: string, base: number) {
    this.text = text;
    this.base = base;
  }

  skipWs(pos: number): number {
    const s = this.text;
    let i = pos;
    let atLineStart = i === 0 || s[i - 1] === "\n";
    while (i < s.length) {
      const c = s[i];
      if (c === " " || c === "\t" || c === "\r") i++;
      else if (c === "\n") { atLineStart = true; i++; }
      else if (atLineStart && c === ">") i++;
      else break;
    }
    return i;
  }

  skipString(pos: number): number {
    const s = this.text;
    if (s[pos] !== "\"") return -1;
    for (let i = pos + 1; i < s.length; i++) {
      const code = s.charCodeAt(i);
      if (code < 0x20) return -1;
      if (code === 0x22) return i + 1;
      if (code === 0x5c) i++;
    }
    return -1;
  }

  scanString(pos: number): { value: string; span: DecodedStringSpan; next: number } | null {
    const next = this.skipString(pos);
    if (next < 0) return null;
    const span = decodeJsonStringWithOffsets(this.text.slice(pos + 1, next - 1), this.base + pos + 1);
    return span ? { value: span.decoded, span, next } : null;
  }

  skipValue(pos: number, depth = 0): number {
    if (depth > 64) return -1;
    const s = this.text;
    const i = this.skipWs(pos);
    if (i >= s.length) return -1;
    const ch = s[i];
    if (ch === "\"") return this.skipString(i);
    if (ch === "{") {
      let cur = this.skipWs(i + 1);
      if (s[cur] === "}") return cur + 1;
      while (cur < s.length) {
        const afterKey = this.skipString(cur);
        if (afterKey < 0) return -1;
        cur = this.skipWs(afterKey);
        if (s[cur] !== ":") return -1;
        const afterVal = this.skipValue(cur + 1, depth + 1);
        if (afterVal < 0) return -1;
        cur = this.skipWs(afterVal);
        if (s[cur] === "}") return cur + 1;
        if (s[cur] !== ",") return -1;
        cur = this.skipWs(cur + 1);
      }
      return -1;
    }
    if (ch === "[") {
      let cur = this.skipWs(i + 1);
      if (s[cur] === "]") return cur + 1;
      while (cur < s.length) {
        const afterVal = this.skipValue(cur, depth + 1);
        if (afterVal < 0) return -1;
        cur = this.skipWs(afterVal);
        if (s[cur] === "]") return cur + 1;
        if (s[cur] !== ",") return -1;
        cur = this.skipWs(cur + 1);
      }
      return -1;
    }
    let end = i;
    while (end < s.length && !/[\s,\]}]/.test(s[end])) end++;
    return end > i ? end : -1;
  }

  scanObjectTitleProperty(pos: number): { titleSpan?: DecodedStringSpan; next: number } | null {
    const s = this.text;
    const i = this.skipWs(pos);
    if (s[i] !== "{") return null;
    let cur = this.skipWs(i + 1);
    let titleSpan: DecodedStringSpan | undefined;
    if (s[cur] === "}") return { titleSpan, next: cur + 1 };
    while (cur < s.length) {
      const key = this.scanString(cur);
      if (!key) return null;
      cur = this.skipWs(key.next);
      if (s[cur] !== ":") return null;
      cur = this.skipWs(cur + 1);
      if (key.value === "title" && s[cur] === "\"") {
        const val = this.scanString(cur);
        if (!val) return null;
        titleSpan = val.span;
        cur = this.skipWs(val.next);
      } else {
        const afterVal = this.skipValue(cur, 1);
        if (afterVal < 0) return null;
        cur = this.skipWs(afterVal);
      }
      if (s[cur] === "}") return { titleSpan, next: cur + 1 };
      if (s[cur] !== ",") return null;
      cur = this.skipWs(cur + 1);
    }
    return null;
  }

  scanStepObject(pos: number, stepIndex: number): { step: StepSourceSpan; next: number } | null {
    const s = this.text;
    const start = this.skipWs(pos);
    if (s[start] !== "{") return null;
    let cur = this.skipWs(start + 1);
    let labelSpan: DecodedStringSpan | undefined;
    let markdownSpan: DecodedStringSpan | undefined;
    let descriptionSpan: DecodedStringSpan | undefined;
    let chartTitleSpan: DecodedStringSpan | undefined;
    if (s[cur] === "}") {
      return {
        step: { stepIndex, objectStart: this.base + start, objectEnd: this.base + cur + 1, hasMarkdown: false, hasLegacyDescription: false },
        next: cur + 1,
      };
    }
    while (cur < s.length) {
      const key = this.scanString(cur);
      if (!key) return null;
      cur = this.skipWs(key.next);
      if (s[cur] !== ":") return null;
      cur = this.skipWs(cur + 1);
      if ((key.value === "label" || key.value === "markdown" || key.value === "description") && s[cur] === "\"") {
        const val = this.scanString(cur);
        if (!val) return null;
        if (key.value === "label") labelSpan = val.span;
        else if (key.value === "markdown") markdownSpan = val.span;
        else descriptionSpan = val.span;
        cur = this.skipWs(val.next);
      } else if (key.value === "chart" && s[cur] === "{") {
        const chartObj = this.scanObjectTitleProperty(cur);
        if (!chartObj) return null;
        chartTitleSpan = chartObj.titleSpan;
        cur = this.skipWs(chartObj.next);
      } else {
        const afterVal = this.skipValue(cur, 1);
        if (afterVal < 0) return null;
        cur = this.skipWs(afterVal);
      }
      if (s[cur] === "}") {
        const hasMarkdown = Boolean(markdownSpan && markdownSpan.decoded.length > 0);
        const hasLegacyDescription = !hasMarkdown && Boolean(descriptionSpan && descriptionSpan.decoded.length > 0);
        return {
          step: {
            stepIndex,
            objectStart: this.base + start,
            objectEnd: this.base + cur + 1,
            ...(labelSpan ? { labelSpan } : {}),
            ...(markdownSpan ? { markdownSpan } : {}),
            ...(descriptionSpan ? { descriptionSpan } : {}),
            ...(chartTitleSpan ? { chartTitleSpan } : {}),
            hasMarkdown,
            hasLegacyDescription,
          },
          next: cur + 1,
        };
      }
      if (s[cur] !== ",") return null;
      cur = this.skipWs(cur + 1);
    }
    return null;
  }

  scanStepDeck(): StepDeckSourceInfo | null {
    const s = this.text;
    const rootStart = this.skipWs(0);
    if (s[rootStart] !== "{") return null;
    let cur = this.skipWs(rootStart + 1);
    if (s[cur] === "}") return null;
    let titleSpan: DecodedStringSpan | undefined;
    let steps: StepSourceSpan[] | null = null;
    while (cur < s.length) {
      const key = this.scanString(cur);
      if (!key) return null;
      cur = this.skipWs(key.next);
      if (s[cur] !== ":") return null;
      cur = this.skipWs(cur + 1);
      if (key.value === "title" && s[cur] === "\"") {
        const val = this.scanString(cur);
        if (!val) return null;
        titleSpan = val.span;
        cur = this.skipWs(val.next);
      } else if (key.value === "steps" && s[cur] === "[") {
        const parsedSteps: StepSourceSpan[] = [];
        cur = this.skipWs(cur + 1);
        if (s[cur] === "]") {
          steps = parsedSteps;
          cur = this.skipWs(cur + 1);
        } else {
          while (cur < s.length) {
            const parsedStep = this.scanStepObject(cur, parsedSteps.length);
            if (!parsedStep) return null;
            parsedSteps.push(parsedStep.step);
            cur = this.skipWs(parsedStep.next);
            if (s[cur] === "]") { steps = parsedSteps; cur = this.skipWs(cur + 1); break; }
            if (s[cur] !== ",") return null;
            cur = this.skipWs(cur + 1);
          }
        }
      } else {
        const afterVal = this.skipValue(cur, 1);
        if (afterVal < 0) return null;
        cur = this.skipWs(afterVal);
      }
      if (s[cur] === "}") return steps && steps.length >= 2 ? { ...(titleSpan ? { titleSpan } : {}), steps } : null;
      if (s[cur] !== ",") return null;
      cur = this.skipWs(cur + 1);
    }
    return null;
  }
}

export function inspectStepDeckSource(rawFence: string, fenceStart = 0): StepDeckSourceInfo | null {
  if (!rawFence || rawFence.length > 200_000) return null;
  const extracted = extractFenceBodySpan(rawFence, fenceStart);
  return extracted ? new JsonSpanScanner(extracted.body, extracted.bodyStart).scanStepDeck() : null;
}

export function inspectChartSource(rawFence: string, fenceStart = 0): { titleSpan?: DecodedStringSpan } | null {
  if (!rawFence || rawFence.length > 200_000) return null;
  const extracted = extractFenceBodySpan(rawFence, fenceStart);
  if (!extracted) return null;
  const root = new JsonSpanScanner(extracted.body, extracted.bodyStart).scanObjectTitleProperty(0);
  return root ? (root.titleSpan ? { titleSpan: root.titleSpan } : {}) : null;
}

function binarySearchSourceOffset(toSource: number[], target: number): number {
  let lo = 0, hi = toSource.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const val = toSource[mid];
    if (val === target) return mid;
    if (val < target) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

export function mapSourceRangeToDecoded(
  span: DecodedStringSpan,
  range: { from: number; to: number },
  trimmedOnly = false,
): { from: number; to: number } | null {
  if (range.from < span.contentStart || range.to > span.contentEnd || range.to <= range.from) return null;
  const dFrom = binarySearchSourceOffset(span.toSource, range.from);
  const dTo = dFrom >= 0 ? binarySearchSourceOffset(span.toSource, range.to) : -1;
  if (dFrom < 0 || dTo <= dFrom) return null;
  if (trimmedOnly && (dFrom < span.trimStartIndex || dTo > span.trimEndIndex)) return null;
  return { from: dFrom, to: dTo };
}

export function classifyStepDeckOccurrence(
  deckInfo: StepDeckSourceInfo,
  range: { from: number; to: number },
  activeStepIndex = 0,
): StepDeckOccurrenceClassification {
  for (const step of deckInfo.steps) {
    if (range.from < step.objectStart || range.from >= step.objectEnd || range.to > step.objectEnd) continue;
    const tryField = (span: DecodedStringSpan | undefined, visibleRegion: StepVisibleRegion, trimmedOnly: boolean, openLegacyNote = false) => {
      if (!span) return null;
      const decodedRange = mapSourceRangeToDecoded(span, range, trimmedOnly);
      return decodedRange ? { stepIndex: step.stepIndex, openLegacyNote, visibleRegion, fieldSpan: span, decodedRange } : null;
    };
    const hit =
      tryField(step.chartTitleSpan, "chart-title", true) ??
      tryField(step.labelSpan, "step-label", true) ??
      (step.hasMarkdown ? tryField(step.markdownSpan, "step-markdown", false) : null) ??
      (step.hasLegacyDescription ? tryField(step.descriptionSpan, "step-legacy-description", false, true) : null);
    if (hit) return hit;
    const inLegacyRaw = Boolean(step.hasLegacyDescription && step.descriptionSpan && range.from >= step.descriptionSpan.contentStart && range.to <= step.descriptionSpan.contentEnd);
    return {
      stepIndex: step.stepIndex,
      openLegacyNote: inLegacyRaw,
      visibleRegion: null,
      fieldSpan: inLegacyRaw ? (step.descriptionSpan ?? null) : null,
      decodedRange: null,
    };
  }
  if (deckInfo.titleSpan) {
    const decodedRange = mapSourceRangeToDecoded(deckInfo.titleSpan, range, true);
    if (decodedRange) {
      const clampedActive = Math.max(0, Math.min(activeStepIndex, deckInfo.steps.length - 1));
      const targetStep = deckInfo.steps[clampedActive]?.hasMarkdown ? clampedActive : deckInfo.steps.findIndex(s => s.hasMarkdown);
      if (targetStep >= 0) {
        return { stepIndex: targetStep, openLegacyNote: false, visibleRegion: "deck-title", fieldSpan: deckInfo.titleSpan, decodedRange };
      }
    }
  }
  return NO_OCCURRENCE;
}

export function closestSourceOwner(el: Element | null): HTMLElement | null {
  let cur = el?.closest<HTMLElement>("[data-source-start],.code-container") ?? null;
  while (cur) {
    const stepDeck = cur.closest<HTMLElement>(".step-cards");
    if (stepDeck && stepDeck !== cur) {
      cur = stepDeck.hasAttribute("data-source-start")
        ? stepDeck
        : (stepDeck.parentElement?.closest<HTMLElement>("[data-source-start],.code-container") ?? null);
      continue;
    }
    return cur;
  }
  return null;
}

export function resolveRenderedStepCard(owner: HTMLElement): HTMLElement | null {
  if (owner.classList.contains("step-cards")) return owner;
  if (owner.classList.contains("step-cards-placeholder")) {
    const deckId = owner.getAttribute("data-step-deck-id");
    if (deckId) {
      for (const card of document.querySelectorAll<HTMLElement>(".step-viewer .step-cards")) {
        if (card.getAttribute("data-step-deck-id") === deckId) return card;
      }
    }
  }
  return owner.querySelector<HTMLElement>(".step-cards");
}

export function stepCardScrollTarget(owner: HTMLElement): Element {
  const card = resolveRenderedStepCard(owner);
  if (!card || card.closest(".step-viewer")) return owner;
  const viewportHeight = typeof window !== "undefined" && window.innerHeight > 0 ? window.innerHeight : 800;
  if (card.getBoundingClientRect().height > viewportHeight * 0.85) {
    return card.querySelector(".step-cards-inline-figure,.step-cards-chart-frame.is-current,.step-cards-figure.is-current,.step-cards-stage") ?? card;
  }
  return card;
}

export function stepRegionElement(card: HTMLElement, region: StepVisibleRegion): Element | null {
  switch (region) {
    case "deck-title": return card.querySelector(".step-cards-heading");
    case "chart-title": return card.querySelector(".step-cards-chart-frame.is-current figcaption");
    case "step-label": return card.querySelector(".step-cards-step-title");
    case "step-markdown": return card.querySelector(".step-cards-description");
    case "step-legacy-description": return card.querySelector(".step-cards-legacy-note > div");
  }
}

export function isDirectChartTitleMatch(
  rawFence: string,
  fenceStart: number,
  candidate: { from: number; to: number },
  query?: string,
  options: SearchMatchConfig = false,
): boolean {
  const chartInfo = inspectChartSource(rawFence, fenceStart);
  if (!chartInfo?.titleSpan) return false;
  const dRange = mapSourceRangeToDecoded(chartInfo.titleSpan, candidate, true);
  if (!dRange) return false;
  if (query !== undefined && chartInfo.titleSpan.toSource[dRange.to] - chartInfo.titleSpan.toSource[dRange.from] !== dRange.to - dRange.from) {
    const { pattern } = compileSearchPattern(query, options, false);
    if (!pattern) return false;
    const sub = chartInfo.titleSpan.decoded.slice(dRange.from, dRange.to);
    const m = pattern.exec(sub);
    if (!m || m.index !== 0 || m[0].length !== sub.length) return false;
  }
  return true;
}

export function stepDeckFenceMatches(
  rawFence: string,
  fenceStart: number,
  query: string,
  options: SearchMatchConfig = false,
): Array<{ from: number; to: number }> {
  const extracted = extractFenceBodySpan(rawFence, fenceStart);
  if (!extracted) return [];
  const { pattern } = compileSearchPattern(query, options, false);
  if (!pattern) return [];
  const text = `${extracted.body}\n`;
  const bodyLen = extracted.body.length;
  const ranges: Array<{ from: number; to: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = nextSearchMatch(pattern, text)) && ranges.length < 5000) {
    if (match.index >= bodyLen) continue;
    const end = Math.min(bodyLen, match.index + match[0].length);
    if (end > match.index) ranges.push({ from: extracted.bodyStart + match.index, to: extracted.bodyStart + end });
  }
  return ranges;
}

export function revealStepCardsSlide(
  owner: HTMLElement,
  bounds: { start: number; end: number } | null,
  content: string,
  target: { from: number; to: number },
  openNestedDisclosures?: (desc: Element) => boolean,
): { changed: boolean; card: HTMLElement | null } {
  const stepOwner = owner.matches(".step-cards,.step-cards-placeholder")
    ? owner
    : owner.querySelector<HTMLElement>(".step-cards,.step-cards-placeholder");
  if (!stepOwner || stepOwner.classList.contains("step-cards-error")) return { changed: false, card: null };
  const initialCard = resolveRenderedStepCard(stepOwner);
  if (!bounds) return { changed: false, card: initialCard };
  const deckInfo = inspectStepDeckSource(content.slice(bounds.start, bounds.end), bounds.start);
  if (!deckInfo) return { changed: false, card: initialCard };
  const beforeStep = Number(initialCard?.getAttribute("data-step-index") ?? stepOwner.getAttribute("data-step-index") ?? 0) || 0;
  const beforeLegacyOpen = Boolean(initialCard?.querySelector<HTMLDetailsElement>(".step-cards-legacy-note")?.open);
  const occ = classifyStepDeckOccurrence(deckInfo, target, beforeStep);
  if (occ.stepIndex === null) return { changed: false, card: initialCard };
  (initialCard ?? stepOwner).dispatchEvent(
    new CustomEvent<StepRevealDetail>(STEP_REVEAL_EVENT, {
      detail: { stepIndex: occ.stepIndex, openLegacyNote: occ.openLegacyNote },
    }),
  );
  const liveCard = resolveRenderedStepCard(stepOwner);
  let openedNested = false;
  if (liveCard && occ.visibleRegion === "step-markdown" && openNestedDisclosures) {
    const desc = liveCard.querySelector(".step-cards-description");
    if (desc) openedNested = openNestedDisclosures(desc);
  }
  const afterStep = Number(liveCard?.getAttribute("data-step-index") ?? stepOwner.getAttribute("data-step-index") ?? 0) || 0;
  const afterLegacyOpen = Boolean(liveCard?.querySelector<HTMLDetailsElement>(".step-cards-legacy-note")?.open);
  return { changed: afterStep !== beforeStep || afterLegacyOpen !== beforeLegacyOpen || openedNested, card: liveCard };
}
