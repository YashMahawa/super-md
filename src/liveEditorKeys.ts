export interface LiveEditorKeyInput {
  text: string;
  selectionStart: number;
  selectionEnd: number;
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  isComposing?: boolean;
  protectedBlock?: boolean;
}

export interface LiveEditorKeyResult {
  text: string;
  selectionStart: number;
  selectionEnd: number;
}

interface LineInfo {
  index: number;
  start: number;
  end: number;
  text: string;
}

interface QuotePrefix {
  depth: number;
  raw: string;
  outerRaw: string;
  canonical: string;
}

interface ParsedListLine {
  quote: QuotePrefix;
  indentRaw: string;
  indentCols: number;
  kind: 'unordered' | 'ordered';
  bullet: string;
  orderNumber: number;
  delimiter: '.' | ')' | '';
  numberStartOffset: number;
  numberEndOffset: number;
  hasTask: boolean;
  markerStep: number;
  markerCoreEnd: number;
  fullMarkerEnd: number;
  content: string;
}

interface TextEdit {
  from: number;
  to: number;
  insert: string;
}

const THEMATIC_BREAK = /^(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;

function columnWidth(raw: string): number {
  let col = 0;
  for (let i = 0; i < raw.length; i++) {
    col += raw[i] === '\t' ? 4 - (col % 4) : 1;
  }
  return col;
}

function splitLines(text: string): LineInfo[] {
  const lines: LineInfo[] = [];
  let start = 0;
  let index = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text[i] === '\n') {
      const end = i > start && text[i - 1] === '\r' ? i - 1 : i;
      lines.push({ index: index++, start, end, text: text.slice(start, end) });
      start = i + 1;
    }
  }
  return lines;
}

function lineIndexAt(lines: LineInfo[], offset: number): number {
  let low = 0;
  let high = lines.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >>> 1;
    if (lines[mid].start <= offset) low = mid;
    else high = mid - 1;
  }
  return low;
}

function scanQuotePrefix(line: string): QuotePrefix {
  const levelEnds: number[] = [];
  let pos = 0;
  let col = 0;
  let baseCol = 0;
  while (pos < line.length) {
    let nextPos = pos;
    let nextCol = col;
    while (nextPos < line.length && (line[nextPos] === ' ' || line[nextPos] === '\t')) {
      const step = line[nextPos] === '\t' ? 4 - (nextCol % 4) : 1;
      if (nextCol + step - baseCol > 3) break;
      nextCol += step;
      nextPos++;
    }
    if (line[nextPos] !== '>') break;
    pos = nextPos + 1;
    col = nextCol + 1;
    if (line[pos] === ' ') {
      pos++;
      col++;
      baseCol = col;
    } else if (line[pos] === '\t') {
      baseCol = col + 1;
    } else {
      baseCol = col;
    }
    levelEnds.push(pos);
  }
  if (!levelEnds.length) {
    return { depth: 0, raw: '', outerRaw: '', canonical: '' };
  }
  const raw = line.slice(0, pos);
  const canonical = raw.endsWith(' ') || raw.endsWith('\t') ? raw : `${raw} `;
  let outerRaw = '';
  if (levelEnds.length > 1) {
    const prevEnd = levelEnds[levelEnds.length - 2];
    const slice = line.slice(0, prevEnd);
    outerRaw = slice.endsWith(' ') || slice.endsWith('\t') ? slice : `${slice} `;
  }
  return { depth: levelEnds.length, raw, outerRaw, canonical };
}

function isValidFenceOpen(rest: string): { char: string; length: number } | null {
  const match = /^(`{3,}|~{3,})(.*)$/.exec(rest);
  if (!match || (match[1][0] === '`' && match[2].includes('`'))) return null;
  return { char: match[1][0], length: match[1].length };
}

function computeFencedLines(lines: LineInfo[]): Uint8Array {
  const fenced = new Uint8Array(lines.length);
  let activeFence: { char: string; length: number; quoteDepth: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i].text;
    const quote = scanQuotePrefix(lineText);
    const afterQuote = lineText.slice(quote.raw.length);
    const indentRaw = /^[ \t]*/.exec(afterQuote)![0];
    const rest = afterQuote.slice(indentRaw.length);

    if (activeFence) {
      if (quote.depth < activeFence.quoteDepth) {
        activeFence = null;
      } else {
        fenced[i] = 1;
        const close = /^(`{3,}|~{3,})[ \t]*$/.exec(rest);
        if (close && close[1][0] === activeFence.char && close[1].length >= activeFence.length) {
          activeFence = null;
        }
        continue;
      }
    }

    let candidate = rest;
    if (!THEMATIC_BREAK.test(rest)) {
      const listMatch = /^(?:[-+*]|\d{1,9}[.)])[ \t]+(.*)$/.exec(rest);
      if (listMatch) candidate = listMatch[1];
    }
    const open = isValidFenceOpen(candidate);
    if (open) {
      activeFence = { ...open, quoteDepth: quote.depth };
      fenced[i] = 1;
    }
  }
  return fenced;
}

function parseListLine(lineText: string): ParsedListLine | null {
  const quote = scanQuotePrefix(lineText);
  const afterQuote = lineText.slice(quote.raw.length);
  const indentRaw = /^[ \t]*/.exec(afterQuote)![0];
  const indentCols = columnWidth(indentRaw);
  const rest = afterQuote.slice(indentRaw.length);
  if (!rest || THEMATIC_BREAK.test(rest)) return null;

  const match = /^(?:([-+*])|(\d{1,9})([.)]))(?:([ \t]+)(.*)|())$/.exec(rest);
  if (!match) return null;

  const markerOffset = quote.raw.length + indentRaw.length;
  const isOrdered = match[2] !== undefined;
  const bullet = match[1] ?? '';
  const orderNumber = isOrdered ? Number(match[2]) : 0;
  const delimiter = (match[3] ?? '') as '.' | ')' | '';
  const markerTokenLength = isOrdered ? match[2].length + match[3].length : 1;
  const spaceAfterMarker = match[4] ?? '';
  const afterMarker = match[5] ?? '';

  const taskMatch = spaceAfterMarker ? /^\[([ xX])\](?:([ \t]+)(.*)|())$/.exec(afterMarker) : null;
  const hasTask = taskMatch !== null;
  const markerCoreEnd = hasTask
    ? markerOffset + markerTokenLength + spaceAfterMarker.length + 3
    : markerOffset + markerTokenLength;
  const fullMarkerEnd = hasTask
    ? markerCoreEnd + (taskMatch[2]?.length ?? 0)
    : markerCoreEnd + spaceAfterMarker.length;
  const content = hasTask ? (taskMatch[3] ?? '') : afterMarker;
  const markerStep = isOrdered ? markerTokenLength + 1 : 2;

  return {
    quote,
    indentRaw,
    indentCols,
    kind: isOrdered ? 'ordered' : 'unordered',
    bullet,
    orderNumber,
    delimiter,
    numberStartOffset: markerOffset,
    numberEndOffset: markerOffset + (isOrdered ? match[2].length : 0),
    hasTask,
    markerStep,
    markerCoreEnd,
    fullMarkerEnd,
    content,
  };
}

function applyEdits(text: string, edits: TextEdit[]): string {
  if (!edits.length) return text;
  const sorted = [...edits].sort((a, b) => a.from - b.from);
  const parts: string[] = [];
  let cursor = 0;
  for (const edit of sorted) {
    parts.push(text.slice(cursor, edit.from), edit.insert);
    cursor = edit.to;
  }
  parts.push(text.slice(cursor));
  return parts.join('');
}

function renumberOrderedSiblings(
  lines: LineInfo[],
  fenced: Uint8Array,
  fromLineIndex: number,
  parentList: ParsedListLine,
  delta: number,
): TextEdit[] {
  const edits: TextEdit[] = [];
  let expectedPrev = parentList.orderNumber + 1;
  for (let i = fromLineIndex + 1; i < lines.length; i++) {
    if (fenced[i]) break;
    const line = lines[i];
    const quote = scanQuotePrefix(line.text);
    if (quote.depth !== parentList.quote.depth) break;
    const afterQuote = line.text.slice(quote.raw.length);
    if (!/\S/.test(afterQuote)) continue;

    const sibling = parseListLine(line.text);
    if (sibling) {
      if (sibling.indentCols > parentList.indentCols) continue;
      if (sibling.indentCols < parentList.indentCols) break;
      if (sibling.kind !== 'ordered' || sibling.delimiter !== parentList.delimiter) break;
      if (sibling.orderNumber !== expectedPrev) break;
      edits.push({
        from: line.start + sibling.numberStartOffset,
        to: line.start + sibling.numberEndOffset,
        insert: String(expectedPrev + delta),
      });
      expectedPrev++;
      continue;
    }

    const indentRaw = /^[ \t]*/.exec(afterQuote)![0];
    if (columnWidth(indentRaw) > parentList.indentCols) continue;
    break;
  }
  return edits;
}

function handleEnter(
  text: string,
  lines: LineInfo[],
  fenced: Uint8Array,
  pos: number,
): LiveEditorKeyResult | null {
  const lineIndex = lineIndexAt(lines, pos);
  if (fenced[lineIndex]) return null;

  const line = lines[lineIndex];
  const col = Math.min(pos - line.start, line.text.length);
  const lineBreak = text.includes('\r\n') ? '\r\n' : '\n';

  const list = parseListLine(line.text);
  if (list && col >= list.markerCoreEnd) {
    const isEmpty = !/\S/.test(list.content);
    if (isEmpty) {
      const replacement = list.quote.depth > 0 ? list.quote.canonical : '';
      const edits: TextEdit[] = [{ from: line.start, to: line.end, insert: replacement }];
      if (list.kind === 'ordered') {
        edits.push(...renumberOrderedSiblings(lines, fenced, lineIndex, list, -1));
      }
      const nextCursor = line.start + replacement.length;
      return {
        text: applyEdits(text, edits),
        selectionStart: nextCursor,
        selectionEnd: nextCursor,
      };
    }

    const nextMarker = list.kind === 'ordered'
      ? `${list.quote.raw}${list.indentRaw}${list.orderNumber + 1}${list.delimiter}${list.hasTask ? ' [ ] ' : ' '}`
      : `${list.quote.raw}${list.indentRaw}${list.bullet}${list.hasTask ? ' [ ] ' : ' '}`;

    let replaceFrom = line.start + col;
    const minFrom = line.start + list.fullMarkerEnd;
    while (replaceFrom > minFrom && (text[replaceFrom - 1] === ' ' || text[replaceFrom - 1] === '\t')) {
      replaceFrom--;
    }

    const insert = lineBreak + nextMarker;
    const edits: TextEdit[] = [{ from: replaceFrom, to: pos, insert }];
    if (list.kind === 'ordered') {
      edits.push(...renumberOrderedSiblings(lines, fenced, lineIndex, list, 1));
    }
    const nextCursor = replaceFrom + insert.length;
    return {
      text: applyEdits(text, edits),
      selectionStart: nextCursor,
      selectionEnd: nextCursor,
    };
  }

  const quote = list ? list.quote : scanQuotePrefix(line.text);
  if (quote.depth > 0) {
    const quoteCoreEnd = quote.raw.replace(/[ \t]+$/, '').length;
    if (col < quoteCoreEnd) return null;

    const quoteContent = line.text.slice(quote.raw.length);
    if (!/\S/.test(quoteContent)) {
      const replacement = quote.outerRaw;
      const nextCursor = line.start + replacement.length;
      return {
        text: applyEdits(text, [{ from: line.start, to: line.end, insert: replacement }]),
        selectionStart: nextCursor,
        selectionEnd: nextCursor,
      };
    }

    let replaceFrom = line.start + col;
    const minFrom = line.start + quote.raw.length;
    while (replaceFrom > minFrom && (text[replaceFrom - 1] === ' ' || text[replaceFrom - 1] === '\t')) {
      replaceFrom--;
    }
    const insert = lineBreak + quote.canonical;
    const nextCursor = replaceFrom + insert.length;
    return {
      text: applyEdits(text, [{ from: replaceFrom, to: pos, insert }]),
      selectionStart: nextCursor,
      selectionEnd: nextCursor,
    };
  }

  return null;
}

interface TrackedListItem {
  lineIndex: number;
  quoteDepth: number;
  oldIndent: number;
  newIndent: number;
  kind: 'unordered' | 'ordered';
  delimiter: '.' | ')' | '';
  orderNumber: number;
  markerStep: number;
  inSelection: boolean;
}

function findPrecedingOrderedSiblingAtIndent(
  lines: LineInfo[],
  fenced: Uint8Array,
  tracked: Map<number, TrackedListItem>,
  lineIndex: number,
  quoteDepth: number,
  targetIndent: number,
  delimiter: '.' | ')' | '',
): number | null {
  for (let i = lineIndex - 1; i >= 0; i--) {
    if (fenced[i]) return null;
    const prevTrack = tracked.get(i);
    if (prevTrack) {
      if (prevTrack.quoteDepth < quoteDepth) return null;
      if (prevTrack.quoteDepth > quoteDepth) continue;
      if (prevTrack.newIndent < targetIndent) return null;
      if (prevTrack.newIndent > targetIndent) continue;
      if (prevTrack.kind === 'ordered' && prevTrack.delimiter === delimiter) {
        return prevTrack.orderNumber;
      }
      return null;
    }
    const quote = scanQuotePrefix(lines[i].text);
    if (quote.depth < quoteDepth) return null;
    if (quote.depth > quoteDepth) continue;
    const afterQuote = lines[i].text.slice(quote.raw.length);
    if (!/\S/.test(afterQuote)) continue;
    const parsed = parseListLine(lines[i].text);
    if (parsed) {
      if (parsed.indentCols < targetIndent) return null;
      if (parsed.indentCols > targetIndent) continue;
      if (parsed.kind === 'ordered' && parsed.delimiter === delimiter) {
        return parsed.orderNumber;
      }
      return null;
    }
    const indentRaw = /^[ \t]*/.exec(afterQuote)![0];
    if (columnWidth(indentRaw) > targetIndent) continue;
    return null;
  }
  return null;
}

function findPrecedingListItem(
  lines: LineInfo[],
  fenced: Uint8Array,
  tracked: Map<number, TrackedListItem>,
  lineIndex: number,
  quoteDepth: number,
): TrackedListItem | null {
  for (let i = lineIndex - 1; i >= 0; i--) {
    if (fenced[i]) return null;
    const prevTrack = tracked.get(i);
    if (prevTrack) {
      if (prevTrack.quoteDepth === quoteDepth) return prevTrack;
      if (prevTrack.quoteDepth < quoteDepth) return null;
      continue;
    }
    const quote = scanQuotePrefix(lines[i].text);
    if (quote.depth < quoteDepth) return null;
    if (quote.depth > quoteDepth) continue;
    const afterQuote = lines[i].text.slice(quote.raw.length);
    if (!/\S/.test(afterQuote)) continue;
    const parsed = parseListLine(lines[i].text);
    if (parsed) {
      return {
        lineIndex: i,
        quoteDepth: parsed.quote.depth,
        oldIndent: parsed.indentCols,
        newIndent: parsed.indentCols,
        kind: parsed.kind,
        delimiter: parsed.delimiter,
        orderNumber: parsed.orderNumber,
        markerStep: parsed.markerStep,
        inSelection: false,
      };
    }
    return null;
  }
  return null;
}

function mapOffsetThroughEdits(
  offset: number,
  edits: TextEdit[],
  keepBeforeFirstInsertAt: number | null,
): number {
  let delta = 0;
  for (const edit of edits) {
    const deleteLen = edit.to - edit.from;
    const insertLen = edit.insert.length;
    if (offset < edit.from) break;
    if (offset === edit.from && deleteLen === 0 && keepBeforeFirstInsertAt === offset) {
      break;
    }
    if (offset >= edit.to) {
      delta += insertLen - deleteLen;
    } else {
      delta += Math.min(insertLen, offset - edit.from) - (offset - edit.from);
    }
  }
  return offset + delta;
}

function handleTab(
  text: string,
  lines: LineInfo[],
  fenced: Uint8Array,
  selectionStart: number,
  selectionEnd: number,
  outdent: boolean,
): LiveEditorKeyResult | null {
  const startLine = lineIndexAt(lines, selectionStart);
  let endLine = lineIndexAt(lines, selectionEnd);
  if (selectionEnd > selectionStart && endLine > startLine && selectionEnd === lines[endLine].start) {
    endLine--;
  }

  for (let i = startLine; i <= endLine; i++) {
    if (fenced[i]) return null;
  }

  const parsedLines = new Map<number, ParsedListLine>();
  let listCount = 0;
  for (let i = startLine; i <= endLine; i++) {
    const lineText = lines[i].text;
    const quote = scanQuotePrefix(lineText);
    const afterQuote = lineText.slice(quote.raw.length);
    if (!/\S/.test(afterQuote)) continue;
    const parsed = parseListLine(lineText);
    if (!parsed) return null;
    parsedLines.set(i, parsed);
    listCount++;
  }

  if (listCount === 0) return null;

  const tracked = new Map<number, TrackedListItem>();
  const edits: TextEdit[] = [];

  for (let i = startLine; i <= endLine; i++) {
    const parsed = parsedLines.get(i);
    if (!parsed) continue;

    const prev = findPrecedingListItem(lines, fenced, tracked, i, parsed.quote.depth);
    let nextIndent = parsed.indentCols;

    if (outdent) {
      if (parsed.indentCols > 0) {
        if (parsed.indentCols <= 3 && (!prev || prev.oldIndent === 0)) {
          nextIndent = 0;
        } else {
          const step = prev ? prev.markerStep : 2;
          nextIndent = Math.max(0, parsed.indentCols - step);
        }
      }
    } else {
      const step = prev ? prev.markerStep : 2;
      let maxIndent: number;
      if (!prev) {
        maxIndent = 2;
      } else if (prev.inSelection && prev.newIndent === prev.oldIndent && parsed.indentCols >= prev.oldIndent) {
        maxIndent = parsed.indentCols;
      } else {
        maxIndent = prev.newIndent + step;
      }
      if (parsed.indentCols < maxIndent) {
        nextIndent = Math.min(parsed.indentCols + step, maxIndent);
      }
    }

    let nextOrderNumber = parsed.orderNumber;
    if (parsed.kind === 'ordered' && nextIndent !== parsed.indentCols) {
      const prevSiblingNumber = findPrecedingOrderedSiblingAtIndent(
        lines,
        fenced,
        tracked,
        i,
        parsed.quote.depth,
        nextIndent,
        parsed.delimiter,
      );
      if (prevSiblingNumber !== null) {
        nextOrderNumber = prevSiblingNumber + 1;
      } else if (nextIndent > 0 && prev) {
        nextOrderNumber = 1;
      }
    }

    const nextNumberStr = parsed.kind === 'ordered' ? String(nextOrderNumber) : '';
    const nextMarkerStep = parsed.kind === 'ordered' ? nextNumberStr.length + 1 + 1 : parsed.markerStep;

    tracked.set(i, {
      lineIndex: i,
      quoteDepth: parsed.quote.depth,
      oldIndent: parsed.indentCols,
      newIndent: nextIndent,
      kind: parsed.kind,
      delimiter: parsed.delimiter,
      orderNumber: nextOrderNumber,
      markerStep: nextMarkerStep,
      inSelection: true,
    });

    const nextIndentRaw = ' '.repeat(nextIndent);
    if (parsed.kind === 'ordered' && (nextIndentRaw !== parsed.indentRaw || nextOrderNumber !== parsed.orderNumber)) {
      const editStart = lines[i].start + parsed.quote.raw.length;
      edits.push({
        from: editStart,
        to: lines[i].start + parsed.numberEndOffset,
        insert: `${nextIndentRaw}${nextNumberStr}`,
      });
    } else if (nextIndentRaw !== parsed.indentRaw) {
      const editStart = lines[i].start + parsed.quote.raw.length;
      edits.push({
        from: editStart,
        to: editStart + parsed.indentRaw.length,
        insert: nextIndentRaw,
      });
    }
  }

  if (!edits.length) {
    return { text, selectionStart, selectionEnd };
  }

  const nextText = applyEdits(text, edits);
  const firstSelectedLine = lines[startLine];
  const firstParsed = parsedLines.get(startLine);
  const firstIndentStart = firstParsed ? firstSelectedLine.start + firstParsed.quote.raw.length : -1;
  const keepStart = selectionStart < selectionEnd && selectionStart === firstIndentStart ? selectionStart : null;

  return {
    text: nextText,
    selectionStart: mapOffsetThroughEdits(selectionStart, edits, keepStart),
    selectionEnd: mapOffsetThroughEdits(selectionEnd, edits, null),
  };
}

export function handleLiveEditorKey(input: LiveEditorKeyInput): LiveEditorKeyResult | null {
  const {
    text,
    selectionStart,
    selectionEnd,
    key,
    shiftKey = false,
    ctrlKey = false,
    metaKey = false,
    altKey = false,
    isComposing = false,
    protectedBlock = false,
  } = input;

  if (isComposing || protectedBlock || ctrlKey || metaKey || altKey) return null;
  if (key !== 'Enter' && key !== 'Tab') return null;
  if (key === 'Enter' && (shiftKey || selectionStart !== selectionEnd)) return null;

  const from = Math.max(0, Math.min(selectionStart, selectionEnd, text.length));
  const to = Math.max(from, Math.min(Math.max(selectionStart, selectionEnd), text.length));
  const lines = splitLines(text);
  const fenced = computeFencedLines(lines);

  if (key === 'Enter') {
    return handleEnter(text, lines, fenced, from);
  }
  return handleTab(text, lines, fenced, from, to, shiftKey);
}
