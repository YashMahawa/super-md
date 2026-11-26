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

function extractFenceBodySpan(rawFence: string, fenceStart: number): { body: string; bodyStart: number } | null {
  const trimmedStart = rawFence.trimStart();
  if (trimmedStart.startsWith("{")) {
    return { body: rawFence, bodyStart: fenceStart };
  }
  const firstBreak = rawFence.indexOf("\n");
  if (firstBreak < 0) return null;
  if (!/^[ \t>]*(?:`{3,}|~{3,})/.test(rawFence.slice(0, firstBreak))) return null;
  const bodyOffset = firstBreak + 1;
  let bodyEnd = rawFence.length;
  const trimmedEnd = rawFence.replace(/[ \t\r\n]+$/, "");
  const lastBreak = trimmedEnd.lastIndexOf("\n");
  if (lastBreak >= firstBreak) {
    const closingLine = trimmedEnd.slice(lastBreak + 1);
    if (/^[ \t>]*(?:`{3,}|~{3,})[ \t]*$/.test(closingLine)) {
      bodyEnd = lastBreak;
    }
  }
  if (bodyEnd < bodyOffset) return null;
  return { body: rawFence.slice(bodyOffset, bodyEnd), bodyStart: fenceStart + bodyOffset };
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
        default:
          return null;
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
  return {
    contentStart,
    contentEnd: contentStart + rawContent.length,
    decoded,
    toSource,
    trimStartIndex,
    trimEndIndex,
  };
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
      if (c === " " || c === "\t" || c === "\r") {
        i++;
      } else if (c === "\n") {
        atLineStart = true;
        i++;
      } else if (atLineStart && c === ">") {
        i++;
      } else {
        break;
      }
    }
    return i;
  }

  scanString(pos: number): { value: string; span: DecodedStringSpan; next: number } | null {
    const s = this.text;
    if (s[pos] !== "\"") return null;
    let i = pos + 1;
    while (i < s.length) {
      const code = s.charCodeAt(i);
      if (code < 0x20) return null;
      if (code === 0x22) {
        const rawContent = s.slice(pos + 1, i);
        const span = decodeJsonStringWithOffsets(rawContent, this.base + pos + 1);
        if (!span) return null;
        return { value: span.decoded, span, next: i + 1 };
      }
      if (code === 0x5c) {
        i += 2;
        continue;
      }
      i++;
    }
    return null;
  }

  skipString(pos: number): number {
    const s = this.text;
    if (s[pos] !== "\"") return -1;
    let i = pos + 1;
    while (i < s.length) {
      const code = s.charCodeAt(i);
      if (code < 0x20) return -1;
      if (code === 0x22) return i + 1;
      if (code === 0x5c) {
        i += 2;
        continue;
      }
      i++;
    }
    return -1;
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
        step: {
          stepIndex,
          objectStart: this.base + start,
          objectEnd: this.base + cur + 1,
          hasMarkdown: false,
          hasLegacyDescription: false,
        },
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
            if (s[cur] === "]") {
              steps = parsedSteps;
              cur = this.skipWs(cur + 1);
              break;
            }
            if (s[cur] !== ",") return null;
            cur = this.skipWs(cur + 1);
          }
        }
      } else {
        const afterVal = this.skipValue(cur, 1);
        if (afterVal < 0) return null;
        cur = this.skipWs(afterVal);
      }
      if (s[cur] === "}") {
        if (!steps || steps.length < 2) return null;
        return { ...(titleSpan ? { titleSpan } : {}), steps };
      }
      if (s[cur] !== ",") return null;
      cur = this.skipWs(cur + 1);
    }
    return null;
  }
}

export function inspectStepDeckSource(rawFence: string, fenceStart = 0): StepDeckSourceInfo | null {
  if (!rawFence || rawFence.length > 200_000) return null;
  const extracted = extractFenceBodySpan(rawFence, fenceStart);
  if (!extracted) return null;
  return new JsonSpanScanner(extracted.body, extracted.bodyStart).scanStepDeck();
}

export function inspectChartSource(rawFence: string, fenceStart = 0): { titleSpan?: DecodedStringSpan } | null {
  if (!rawFence || rawFence.length > 200_000) return null;
  const extracted = extractFenceBodySpan(rawFence, fenceStart);
  if (!extracted) return null;
  const scanner = new JsonSpanScanner(extracted.body, extracted.bodyStart);
  const root = scanner.scanObjectTitleProperty(0);
  return root ? { ...(root.titleSpan ? { titleSpan: root.titleSpan } : {}) } : null;
}

function binarySearchSourceOffset(toSource: number[], target: number): number {
  let lo = 0;
  let hi = toSource.length - 1;
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
  if (range.from < span.contentStart || range.to > span.contentEnd || range.to <= range.from) {
    return null;
  }
  const dFrom = binarySearchSourceOffset(span.toSource, range.from);
  if (dFrom < 0) return null;
  const dTo = binarySearchSourceOffset(span.toSource, range.to);
  if (dTo <= dFrom) return null;
  if (trimmedOnly && (dFrom < span.trimStartIndex || dTo > span.trimEndIndex)) {
    return null;
  }
  return { from: dFrom, to: dTo };
}

export function classifyStepDeckOccurrence(
  deckInfo: StepDeckSourceInfo,
  range: { from: number; to: number },
  activeStepIndex = 0,
): StepDeckOccurrenceClassification {
  for (const step of deckInfo.steps) {
    if (range.from >= step.objectStart && range.from < step.objectEnd && range.to <= step.objectEnd) {
      if (step.chartTitleSpan) {
        const decodedRange = mapSourceRangeToDecoded(step.chartTitleSpan, range, true);
        if (decodedRange) {
          return {
            stepIndex: step.stepIndex,
            openLegacyNote: false,
            visibleRegion: "chart-title",
            fieldSpan: step.chartTitleSpan,
            decodedRange,
          };
        }
      }
      if (step.labelSpan) {
        const decodedRange = mapSourceRangeToDecoded(step.labelSpan, range, true);
        if (decodedRange) {
          return {
            stepIndex: step.stepIndex,
            openLegacyNote: false,
            visibleRegion: "step-label",
            fieldSpan: step.labelSpan,
            decodedRange,
          };
        }
      }
      if (step.hasMarkdown && step.markdownSpan) {
        const decodedRange = mapSourceRangeToDecoded(step.markdownSpan, range, false);
        if (decodedRange) {
          return {
            stepIndex: step.stepIndex,
            openLegacyNote: false,
            visibleRegion: "step-markdown",
            fieldSpan: step.markdownSpan,
            decodedRange,
          };
        }
      }
      if (step.hasLegacyDescription && step.descriptionSpan) {
        const decodedRange = mapSourceRangeToDecoded(step.descriptionSpan, range, false);
        if (decodedRange) {
          return {
            stepIndex: step.stepIndex,
            openLegacyNote: true,
            visibleRegion: "step-legacy-description",
            fieldSpan: step.descriptionSpan,
            decodedRange,
          };
        }
        if (range.from >= step.descriptionSpan.contentStart && range.to <= step.descriptionSpan.contentEnd) {
          return {
            stepIndex: step.stepIndex,
            openLegacyNote: true,
            visibleRegion: null,
            fieldSpan: step.descriptionSpan,
            decodedRange: null,
          };
        }
      }
      return {
        stepIndex: step.stepIndex,
        openLegacyNote: false,
        visibleRegion: null,
        fieldSpan: null,
        decodedRange: null,
      };
    }
  }
  if (deckInfo.titleSpan) {
    const decodedRange = mapSourceRangeToDecoded(deckInfo.titleSpan, range, true);
    if (decodedRange) {
      const clampedActive = Math.max(0, Math.min(activeStepIndex, deckInfo.steps.length - 1));
      if (deckInfo.steps[clampedActive]?.hasMarkdown) {
        return {
          stepIndex: clampedActive,
          openLegacyNote: false,
          visibleRegion: "deck-title",
          fieldSpan: deckInfo.titleSpan,
          decodedRange,
        };
      }
      const firstMarkdownStep = deckInfo.steps.findIndex(s => s.hasMarkdown);
      if (firstMarkdownStep >= 0) {
        return {
          stepIndex: firstMarkdownStep,
          openLegacyNote: false,
          visibleRegion: "deck-title",
          fieldSpan: deckInfo.titleSpan,
          decodedRange,
        };
      }
    }
  }
  return {
    stepIndex: null,
    openLegacyNote: false,
    visibleRegion: null,
    fieldSpan: null,
    decodedRange: null,
  };
}
