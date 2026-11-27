/**
 * Unified top-of-file YAML frontmatter parser and document metadata normalizer.
 * Recognizes optional UTF-8 BOM, `---` opener, `---` or `...` closer, trailing
 * horizontal whitespace on delimiter lines, empty blocks, and EOF closers.
 * Malformed or unclosed YAML blocks return null so callers fall back safely
 * to ordinary Markdown rendering.
 */

export type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };

export interface DocumentMetadata {
  title?: string;
  subtitle?: string;
  authors: string[];
  date?: string;
  description?: string;
  tags: string[];
  aliases: string[];
}

export type FrontmatterVisibleField = "title" | "author" | "tag";

export interface FrontmatterVisibleSpan {
  /** Inclusive canonical UTF-16 start offset in the Markdown document. */
  start: number;
  /** Exclusive canonical UTF-16 end offset in the Markdown document. */
  end: number;
  /** Rendered metadata field category in DocumentProperties. */
  field: FrontmatterVisibleField;
  /** 0-based index among `[data-frontmatter-field="<field>"]` elements. */
  fieldOrdinal: number;
}

export interface ParseFrontmatterOptions {
  /** When true, populate canonical source spans for displayed title/author/tag values in the same parse pass. */
  includeSpans?: boolean;
}

export interface ParsedFrontmatter {
  /** Exact raw substring from index 0 (including optional BOM and closing newline if present). */
  raw: string;
  /** UTF-16 code unit offset in the original Markdown where the body begins. */
  end: number;
  /** Parsed top-level YAML key-value mapping. */
  entries: Record<string, YamlValue>;
  /** Normalized reader/PDF properties, or null when no recognized fields are populated. */
  properties: DocumentMetadata | null;
  /** Canonical UTF-16 spans for displayed title, author, and tag values (present when `includeSpans` is true). */
  visibleSpans?: FrontmatterVisibleSpan[];
}

interface RawLine {
  raw: string;
  indent: number;
  trimmed: string;
  offset: number;
  trimmedOffset: number;
}

interface YamlNode {
  value: YamlValue;
  spans: Array<{ start: number; end: number }>;
  items?: YamlNode[];
  entries?: Record<string, YamlNode>;
}

const EMPTY_SPANS: Array<{ start: number; end: number }> = [];
const BLOCK_SCALAR_HEADER = /^([|>])(?:([+-])([1-9])?|([1-9])([+-])?)?[ \t]*(?:#.*)?$/;

function stripInlineComment(value: string): string {
  for (let i = 0; i < value.length; i++) {
    if (value[i] === "#" && (i === 0 || value[i - 1] === " " || value[i - 1] === "\t")) {
      return value.slice(0, i).trimEnd();
    }
  }
  return value.trimEnd();
}

function parseDoubleQuoted(input: string): { value: string; rest: string } | null {
  if (!input.startsWith('"')) return null;
  let out = "";
  for (let i = 1; i < input.length; i++) {
    const ch = input[i];
    if (ch === '"') {
      return { value: out, rest: input.slice(i + 1) };
    }
    if (ch === "\\") {
      i++;
      if (i >= input.length) return null;
      const esc = input[i];
      switch (esc) {
        case '"': out += '"'; break;
        case "\\": out += "\\"; break;
        case "/": out += "/"; break;
        case "n": out += "\n"; break;
        case "r": out += "\r"; break;
        case "t": out += "\t"; break;
        case "b": out += "\b"; break;
        case "f": out += "\f"; break;
        case "0": out += "\0"; break;
        case " ": out += " "; break;
        case "\n":
          while (i + 1 < input.length && (input[i + 1] === " " || input[i + 1] === "\t")) i++;
          break;
        case "x": {
          const hex = input.slice(i + 1, i + 3);
          if (!/^[0-9a-fA-F]{2}$/.test(hex)) return null;
          out += String.fromCodePoint(Number.parseInt(hex, 16));
          i += 2;
          break;
        }
        case "u": {
          const hex = input.slice(i + 1, i + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
          const cp = Number.parseInt(hex, 16);
          if (cp >= 0xd800 && cp <= 0xdfff) return null;
          out += String.fromCodePoint(cp);
          i += 4;
          break;
        }
        case "U": {
          const hex = input.slice(i + 1, i + 9);
          if (!/^[0-9a-fA-F]{8}$/.test(hex)) return null;
          const cp = Number.parseInt(hex, 16);
          if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return null;
          out += String.fromCodePoint(cp);
          i += 8;
          break;
        }
        default:
          out += esc;
          break;
      }
      continue;
    }
    if (ch === "\n") {
      out = out.replace(/[ \t]+$/, "");
      while (i + 1 < input.length && (input[i + 1] === " " || input[i + 1] === "\t")) i++;
      out += " ";
      continue;
    }
    out += ch;
  }
  return null;
}

function parseSingleQuoted(input: string): { value: string; rest: string } | null {
  if (!input.startsWith("'")) return null;
  let out = "";
  for (let i = 1; i < input.length; i++) {
    const ch = input[i];
    if (ch === "'") {
      if (input[i + 1] === "'") {
        out += "'";
        i++;
        continue;
      }
      return { value: out, rest: input.slice(i + 1) };
    }
    if (ch === "\n") {
      out = out.replace(/[ \t]+$/, "");
      while (i + 1 < input.length && (input[i + 1] === " " || input[i + 1] === "\t")) i++;
      out += " ";
      continue;
    }
    out += ch;
  }
  return null;
}

function onlyTrailingComment(rest: string): boolean {
  const trimmed = rest.trimStart();
  return trimmed === "" || trimmed.startsWith("#");
}

function parsePlainScalar(raw: string): YamlValue {
  const cleaned = stripInlineComment(raw).trim();
  if (cleaned === "" || cleaned === "~" || /^null$/i.test(cleaned)) return null;
  if (/^true$/i.test(cleaned)) return true;
  if (/^false$/i.test(cleaned)) return false;
  return cleaned;
}

function mapSliceToSpan(map: number[], relStart: number, relEnd: number): { start: number; end: number } | null {
  if (relEnd < relStart || map.length === 0) return null;
  if (relEnd === relStart) {
    const pos = map[Math.min(relStart, map.length - 1)] ?? 0;
    return { start: pos, end: pos };
  }
  const start = map[relStart];
  const last = map[relEnd - 1];
  if (start === undefined || last === undefined) return null;
  return { start, end: last + 1 };
}

function makeDirectMap(startOffset: number, length: number): number[] {
  const map = new Array<number>(length);
  for (let i = 0; i < length; i++) map[i] = startOffset + i;
  return map;
}

function splitTopLevelCommas(inner: string): Array<{ part: string; start: number }> | null {
  const parts: Array<{ part: string; start: number }> = [];
  let start = 0;
  let depthBracket = 0;
  let depthBrace = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '"') {
      const parsed = parseDoubleQuoted(inner.slice(i));
      if (!parsed) return null;
      i = inner.length - parsed.rest.length - 1;
      continue;
    }
    if (ch === "'") {
      const parsed = parseSingleQuoted(inner.slice(i));
      if (!parsed) return null;
      i = inner.length - parsed.rest.length - 1;
      continue;
    }
    if (ch === "[") depthBracket++;
    else if (ch === "]") { if (--depthBracket < 0) return null; }
    else if (ch === "{") depthBrace++;
    else if (ch === "}") { if (--depthBrace < 0) return null; }
    else if (ch === "," && depthBracket === 0 && depthBrace === 0) {
      parts.push({ part: inner.slice(start, i), start });
      start = i + 1;
    }
  }
  if (depthBracket !== 0 || depthBrace !== 0) return null;
  parts.push({ part: inner.slice(start), start });
  return parts;
}

function splitKeyValue(
  trimmedLine: string,
  allowCompactFlowColon = false,
): { key: string; rest: string; restIndex: number } | null {
  if (!trimmedLine || trimmedLine.startsWith("#")) return null;
  if (trimmedLine.startsWith("- ") || trimmedLine === "-" || trimmedLine.startsWith("-\t")) return null;
  if (trimmedLine.startsWith('"') || trimmedLine.startsWith("'")) {
    const parsed = trimmedLine.startsWith('"') ? parseDoubleQuoted(trimmedLine) : parseSingleQuoted(trimmedLine);
    if (!parsed) return null;
    const after = parsed.rest.trimStart();
    if (!after.startsWith(":")) return null;
    const postColon = after.slice(1);
    if (!allowCompactFlowColon && postColon.length > 0 && postColon[0] !== " " && postColon[0] !== "\t") return null;
    const rest = postColon.trimStart();
    return { key: parsed.value, rest, restIndex: trimmedLine.length - rest.length };
  }
  if (/^[\[\]{}|>*&!%@]/.test(trimmedLine)) return null;
  for (let i = 0; i < trimmedLine.length; i++) {
    if (trimmedLine[i] !== ":") continue;
    const next = trimmedLine[i + 1];
    if (allowCompactFlowColon || next === undefined || next === " " || next === "\t") {
      const key = trimmedLine.slice(0, i).trim();
      if (!key || /[\[\]{}"']/.test(key)) return null;
      const rest = trimmedLine.slice(i + 1).trimStart();
      return { key, rest, restIndex: trimmedLine.length - rest.length };
    }
  }
  return null;
}

function parseFlowValue(raw: string, map: number[] | null): YamlNode | null {
  const leadTrimmed = raw.trimStart();
  if (!leadTrimmed) return { value: null, spans: EMPTY_SPANS };
  const lead = raw.length - leadTrimmed.length;
  const trimmed = leadTrimmed.trimEnd();
  const subMap = map ? map.slice(lead, lead + trimmed.length) : null;

  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    const parsed = trimmed.startsWith('"') ? parseDoubleQuoted(trimmed) : parseSingleQuoted(trimmed);
    if (!parsed || !onlyTrailingComment(parsed.rest)) return null;
    if (!subMap) return { value: parsed.value, spans: EMPTY_SPANS };
    const closeIdx = trimmed.length - parsed.rest.length - 1;
    const span = mapSliceToSpan(subMap, 1, closeIdx);
    return { value: parsed.value, spans: span ? [span] : EMPTY_SPANS };
  }

  if (trimmed.startsWith("[")) {
    if (!trimmed.endsWith("]")) return null;
    const inner = trimmed.slice(1, -1);
    if (!inner.trim()) return { value: [], spans: EMPTY_SPANS, items: subMap ? [] : undefined };
    const parts = splitTopLevelCommas(inner);
    if (!parts) return null;
    const innerMap = subMap ? subMap.slice(1, -1) : null;
    const values: YamlValue[] = [];
    const items: YamlNode[] | undefined = innerMap ? [] : undefined;
    for (const { part, start } of parts) {
      if (!part.trim()) continue;
      const itemNode = parseFlowValue(part, innerMap ? innerMap.slice(start, start + part.length) : null);
      if (!itemNode) return null;
      values.push(itemNode.value);
      items?.push(itemNode);
    }
    return { value: values, spans: EMPTY_SPANS, items };
  }

  if (trimmed.startsWith("{")) {
    if (!trimmed.endsWith("}")) return null;
    const inner = trimmed.slice(1, -1);
    if (!inner.trim()) return { value: {}, spans: EMPTY_SPANS, entries: subMap ? {} : undefined };
    const pairs = splitTopLevelCommas(inner);
    if (!pairs) return null;
    const innerMap = subMap ? subMap.slice(1, -1) : null;
    const out: Record<string, YamlValue> = {};
    const entries: Record<string, YamlNode> | undefined = innerMap ? {} : undefined;
    for (const { part, start } of pairs) {
      const pairLeadTrimmed = part.trimStart();
      if (!pairLeadTrimmed) continue;
      const pairLead = part.length - pairLeadTrimmed.length;
      const pairTrimmed = pairLeadTrimmed.trimEnd();
      const kv = splitKeyValue(pairTrimmed, true);
      if (!kv) return null;
      const valStartInInner = start + pairLead + kv.restIndex;
      const valNode = parseFlowValue(kv.rest, innerMap ? innerMap.slice(valStartInInner, valStartInInner + kv.rest.length) : null);
      if (!valNode) return null;
      out[kv.key] = valNode.value;
      if (entries) entries[kv.key] = valNode;
    }
    return { value: out, spans: EMPTY_SPANS, entries };
  }

  if (trimmed.includes("[") || trimmed.includes("]") || trimmed.includes("{") || trimmed.includes("}")) {
    // Reject unbalanced flow indicators in flow values such as `[a, [b]`.
    if (!splitTopLevelCommas(trimmed)) return null;
  }

  const scalar = parsePlainScalar(trimmed);
  if (!subMap || scalar === null) return { value: scalar, spans: EMPTY_SPANS };
  const withoutComment = stripInlineComment(trimmed);
  const withoutLead = withoutComment.trimStart();
  const cleanLead = withoutComment.length - withoutLead.length;
  const cleaned = withoutLead.trimEnd();
  const span = cleaned.length > 0 ? mapSliceToSpan(subMap, cleanLead, cleanLead + cleaned.length) : null;
  return { value: scalar, spans: span ? [span] : EMPTY_SPANS };
}

function isBlankOrComment(line: RawLine): boolean {
  return line.trimmed === "" || line.trimmed.startsWith("#");
}

function sequenceItemWithOffset(line: RawLine): { itemRest: string; itemOffset: number } | null {
  if (line.trimmed === "-") return { itemRest: "", itemOffset: line.trimmedOffset + 1 };
  if (line.trimmed.startsWith("- ") || line.trimmed.startsWith("-\t")) {
    const itemRest = line.trimmed.slice(1).trimStart();
    const idx = line.trimmed.length - itemRest.length;
    return { itemRest, itemOffset: line.trimmedOffset + idx };
  }
  return null;
}

function stripFlowLineComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inDouble) {
      if (ch === "\\") { i++; continue; }
      if (ch === '"') inDouble = false;
      continue;
    }
    if (inSingle) {
      if (ch === "'") {
        if (line[i + 1] === "'") { i++; continue; }
        inSingle = false;
      }
      continue;
    }
    if (ch === '"') inDouble = true;
    else if (ch === "'") inSingle = true;
    else if (ch === "#" && (i === 0 || line[i - 1] === " " || line[i - 1] === "\t")) {
      return line.slice(0, i).trimEnd();
    }
  }
  return line;
}

function flowBalanceState(text: string): "balanced" | "incomplete" | "error" {
  let depthBracket = 0;
  let depthBrace = 0;
  let inSingle = false;
  let inDouble = false;
  let closedTop = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inDouble) {
      if (ch === "\\") { i++; if (i >= text.length) return "incomplete"; continue; }
      if (ch === '"') inDouble = false;
      continue;
    }
    if (inSingle) {
      if (ch === "'") {
        if (text[i + 1] === "'") { i++; continue; }
        inSingle = false;
      }
      continue;
    }
    if (closedTop) {
      if (ch === " " || ch === "\t") continue;
      if (ch === "#") break;
      return "error";
    }
    if (ch === '"') inDouble = true;
    else if (ch === "'") inSingle = true;
    else if (ch === "[") depthBracket++;
    else if (ch === "]") {
      if (--depthBracket < 0) return "error";
      if (depthBracket === 0 && depthBrace === 0) closedTop = true;
    } else if (ch === "{") depthBrace++;
    else if (ch === "}") {
      if (--depthBrace < 0) return "error";
      if (depthBracket === 0 && depthBrace === 0) closedTop = true;
    }
  }
  if (inSingle || inDouble || depthBracket > 0 || depthBrace > 0) return "incomplete";
  return closedTop ? "balanced" : "incomplete";
}

function collectFlowLines(
  lines: RawLine[],
  startIndex: number,
  initialRest: string,
  initialOffset: number,
  minContIndent: number,
  includeSpans: boolean,
): { combined: string; map: number[] | null; nextIndex: number } | null {
  const firstStripped = stripFlowLineComment(initialRest);
  let combined = firstStripped;
  const map = includeSpans ? makeDirectMap(initialOffset, firstStripped.length) : null;
  let idx = startIndex;
  while (true) {
    const state = flowBalanceState(combined);
    if (state === "error") return null;
    if (state === "balanced") return { combined, map, nextIndex: idx + 1 };
    idx++;
    if (idx >= lines.length) return null;
    if (isBlankOrComment(lines[idx])) continue;
    if (lines[idx].indent < minContIndent) return null;
    const nextStripped = stripFlowLineComment(lines[idx].trimmed);
    combined += " " + nextStripped;
    if (map) {
      map.push(lines[idx].trimmedOffset > 0 ? lines[idx].trimmedOffset - 1 : lines[idx].trimmedOffset);
      for (let i = 0; i < nextStripped.length; i++) map.push(lines[idx].trimmedOffset + i);
    }
  }
}

function collectQuotedScalar(
  lines: RawLine[],
  startIndex: number,
  initialRest: string,
  initialOffset: number,
  minContIndent: number,
  includeSpans: boolean,
): { node: YamlNode; nextIndex: number } | null {
  const quote = initialRest[0];
  let combined = initialRest;
  const map = includeSpans ? makeDirectMap(initialOffset, initialRest.length) : null;
  let idx = startIndex;
  while (true) {
    const parsed = quote === '"' ? parseDoubleQuoted(combined) : parseSingleQuoted(combined);
    if (parsed) {
      if (!onlyTrailingComment(parsed.rest)) return null;
      if (!map) return { node: { value: parsed.value, spans: EMPTY_SPANS }, nextIndex: idx + 1 };
      const closeIdx = combined.length - parsed.rest.length - 1;
      const span = mapSliceToSpan(map, 1, closeIdx);
      return { node: { value: parsed.value, spans: span ? [span] : EMPTY_SPANS }, nextIndex: idx + 1 };
    }
    idx++;
    if (idx >= lines.length) return null;
    if (lines[idx].trimmed === "") {
      combined += "\n";
      map?.push(lines[idx].offset);
      continue;
    }
    if (lines[idx].indent < minContIndent) return null;
    combined += "\n" + lines[idx].trimmed;
    if (map) {
      map.push(lines[idx].offset);
      for (let i = 0; i < lines[idx].trimmed.length; i++) map.push(lines[idx].trimmedOffset + i);
    }
  }
}

function parseBlockScalar(
  lines: RawLine[],
  startIndex: number,
  header: string,
  parentIndent: number,
  includeSpans: boolean,
): { node: YamlNode; nextIndex: number } | null {
  const match = BLOCK_SCALAR_HEADER.exec(header);
  if (!match) return null;
  const style = match[1];
  const chomp = match[2] || match[5] || "clip";
  const indentDigit = match[3] || match[4];
  const rawContent: string[] = [];
  const lineIndices: number[] = [];
  let idx = startIndex + 1;
  while (idx < lines.length) {
    const raw = lines[idx].raw;
    if (raw.trim() === "") {
      rawContent.push("");
      lineIndices.push(idx);
      idx++;
      continue;
    }
    if (lines[idx].indent <= parentIndent) break;
    rawContent.push(raw);
    lineIndices.push(idx);
    idx++;
  }
  while (rawContent.length > 0 && rawContent[rawContent.length - 1] === "" && chomp === "-") {
    rawContent.pop();
    lineIndices.pop();
  }
  let blockIndent = indentDigit ? parentIndent + Number(indentDigit) : Infinity;
  if (!indentDigit) {
    for (const line of rawContent) {
      if (line !== "") {
        const leading = line.match(/^ */)?.[0].length ?? 0;
        if (leading < blockIndent) blockIndent = leading;
      }
    }
  }
  if (!Number.isFinite(blockIndent)) return { node: { value: "", spans: EMPTY_SPANS }, nextIndex: idx };
  const dedented = rawContent.map(line => (line === "" ? "" : line.slice(Math.min(line.length, blockIndent))));
  let out = "";
  if (style === "|") {
    out = dedented.join("\n");
  } else {
    for (let i = 0; i < dedented.length; i++) {
      const curr = dedented[i];
      if (i === 0) {
        out += curr;
        continue;
      }
      const prev = dedented[i - 1];
      const moreIndented = curr.startsWith(" ") || curr.startsWith("\t") || prev.startsWith(" ") || prev.startsWith("\t");
      if (curr === "" || prev === "") out += "\n" + curr;
      else if (moreIndented) out += "\n" + curr;
      else out += " " + curr;
    }
  }
  if (chomp === "-" || chomp === "clip") out = out.replace(/\n+$/, "");
  if (!includeSpans) return { node: { value: out, spans: EMPTY_SPANS }, nextIndex: idx };
  const spans: Array<{ start: number; end: number }> = [];
  for (const li of lineIndices) {
    if (lines[li].trimmed === "") continue;
    const start = style === "|"
      ? lines[li].offset + Math.min(lines[li].raw.length, blockIndent)
      : lines[li].trimmedOffset;
    const end = lines[li].offset + lines[li].raw.length;
    if (end > start) spans.push({ start, end });
  }
  return { node: { value: out, spans }, nextIndex: idx };
}

function nextMeaningfulLine(lines: RawLine[], fromIndex: number): number {
  let idx = fromIndex;
  while (idx < lines.length && isBlankOrComment(lines[idx])) idx++;
  return idx;
}

function plainLineSpan(
  text: string,
  baseOffset: number,
  includeSpans: boolean,
): { stripped: string; span: { start: number; end: number } | null } {
  const withoutComment = stripInlineComment(text);
  const withoutLead = withoutComment.trimStart();
  const lead = withoutComment.length - withoutLead.length;
  const cleaned = withoutLead.trimEnd();
  return {
    stripped: cleaned,
    span: includeSpans && cleaned.length > 0 ? { start: baseOffset + lead, end: baseOffset + lead + cleaned.length } : null,
  };
}

function parseValueAfterKey(
  lines: RawLine[],
  lineIndex: number,
  rest: string,
  restOffset: number,
  keyIndent: number,
  includeSpans: boolean,
): { node: YamlNode; nextIndex: number } | null {
  if (rest === "" || rest.startsWith("#")) {
    const nextIdx = nextMeaningfulLine(lines, lineIndex + 1);
    if (nextIdx >= lines.length) return { node: { value: null, spans: EMPTY_SPANS }, nextIndex: lines.length };
    const nextLine = lines[nextIdx];
    if (nextLine.indent >= keyIndent && sequenceItemWithOffset(nextLine)) {
      return parseBlockSequence(lines, nextIdx, nextLine.indent, includeSpans);
    }
    if (nextLine.indent > keyIndent) {
      if (splitKeyValue(nextLine.trimmed)) {
        return parseBlockMapping(lines, nextIdx, nextLine.indent, includeSpans);
      }
      const parts: string[] = [];
      const spans: Array<{ start: number; end: number }> = [];
      let idx = nextIdx;
      while (idx < lines.length) {
        if (isBlankOrComment(lines[idx])) { idx++; continue; }
        if (lines[idx].indent <= keyIndent) break;
        if (splitKeyValue(lines[idx].trimmed) || sequenceItemWithOffset(lines[idx])) break;
        const piece = plainLineSpan(lines[idx].trimmed, lines[idx].trimmedOffset, includeSpans);
        parts.push(piece.stripped);
        if (piece.span) spans.push(piece.span);
        idx++;
      }
      const value = parsePlainScalar(parts.join(" "));
      return { node: { value, spans: value === null ? EMPTY_SPANS : spans }, nextIndex: idx };
    }
    return { node: { value: null, spans: EMPTY_SPANS }, nextIndex: nextIdx };
  }

  if (rest.startsWith("|") || rest.startsWith(">")) {
    return parseBlockScalar(lines, lineIndex, rest, keyIndent, includeSpans);
  }
  if (rest.startsWith('"') || rest.startsWith("'")) {
    return collectQuotedScalar(lines, lineIndex, rest, restOffset, keyIndent + 1, includeSpans);
  }
  if (rest.startsWith("[") || rest.startsWith("{")) {
    const collected = collectFlowLines(lines, lineIndex, rest, restOffset, keyIndent, includeSpans);
    if (!collected) return null;
    const node = parseFlowValue(collected.combined, collected.map);
    if (!node) return null;
    return { node, nextIndex: collected.nextIndex };
  }

  const firstPiece = plainLineSpan(rest, restOffset, includeSpans);
  const parts = [firstPiece.stripped];
  const spans: Array<{ start: number; end: number }> = firstPiece.span ? [firstPiece.span] : [];
  let idx = lineIndex + 1;
  while (idx < lines.length) {
    if (isBlankOrComment(lines[idx])) break;
    if (lines[idx].indent <= keyIndent) break;
    if (splitKeyValue(lines[idx].trimmed) || sequenceItemWithOffset(lines[idx])) break;
    const piece = plainLineSpan(lines[idx].trimmed, lines[idx].trimmedOffset, includeSpans);
    parts.push(piece.stripped);
    if (piece.span) spans.push(piece.span);
    idx++;
  }
  const value = parsePlainScalar(parts.join(" "));
  return { node: { value, spans: value === null ? EMPTY_SPANS : spans }, nextIndex: idx };
}

function parseBlockSequence(
  lines: RawLine[],
  startIndex: number,
  seqIndent: number,
  includeSpans: boolean,
): { node: YamlNode; nextIndex: number } | null {
  const values: YamlValue[] = [];
  const items: YamlNode[] | undefined = includeSpans ? [] : undefined;
  let idx = startIndex;
  while (idx < lines.length) {
    if (isBlankOrComment(lines[idx])) { idx++; continue; }
    if (lines[idx].indent < seqIndent) break;
    if (lines[idx].indent > seqIndent) return null;
    const seq = sequenceItemWithOffset(lines[idx]);
    if (!seq) break;
    const { itemRest, itemOffset } = seq;
    if (itemRest === "" || itemRest.startsWith("#")) {
      const nextIdx = nextMeaningfulLine(lines, idx + 1);
      if (nextIdx < lines.length && lines[nextIdx].indent > seqIndent) {
        if (sequenceItemWithOffset(lines[nextIdx])) {
          const sub = parseBlockSequence(lines, nextIdx, lines[nextIdx].indent, includeSpans);
          if (!sub) return null;
          values.push(sub.node.value);
          items?.push(sub.node);
          idx = sub.nextIndex;
          continue;
        }
        if (splitKeyValue(lines[nextIdx].trimmed)) {
          const sub = parseBlockMapping(lines, nextIdx, lines[nextIdx].indent, includeSpans);
          if (!sub) return null;
          values.push(sub.node.value);
          items?.push(sub.node);
          idx = sub.nextIndex;
          continue;
        }
      }
      values.push(null);
      items?.push({ value: null, spans: EMPTY_SPANS });
      idx = nextIdx;
      continue;
    }
    const inlineKv = splitKeyValue(itemRest);
    if (inlineKv) {
      const entryIndent = seqIndent + 2;
      const firstVal = parseValueAfterKey(lines, idx, inlineKv.rest, itemOffset + inlineKv.restIndex, seqIndent + 1, includeSpans);
      if (!firstVal) return null;
      const obj: Record<string, YamlValue> = { [inlineKv.key]: firstVal.node.value };
      const entries: Record<string, YamlNode> | undefined = includeSpans ? { [inlineKv.key]: firstVal.node } : undefined;
      let nextIdx = firstVal.nextIndex;
      const peek = nextMeaningfulLine(lines, nextIdx);
      if (peek < lines.length && lines[peek].indent >= entryIndent && !sequenceItemWithOffset(lines[peek])) {
        const restMap = parseBlockMapping(lines, peek, lines[peek].indent, includeSpans);
        if (!restMap) return null;
        Object.assign(obj, restMap.node.value as Record<string, YamlValue>);
        if (entries && restMap.node.entries) Object.assign(entries, restMap.node.entries);
        nextIdx = restMap.nextIndex;
      }
      values.push(obj);
      items?.push({ value: obj, spans: EMPTY_SPANS, entries });
      idx = nextIdx;
      continue;
    }
    if (itemRest.startsWith("|") || itemRest.startsWith(">")) {
      const block = parseBlockScalar(lines, idx, itemRest, seqIndent, includeSpans);
      if (!block) return null;
      values.push(block.node.value);
      items?.push(block.node);
      idx = block.nextIndex;
      continue;
    }
    if (itemRest.startsWith('"') || itemRest.startsWith("'")) {
      const quoted = collectQuotedScalar(lines, idx, itemRest, itemOffset, seqIndent + 1, includeSpans);
      if (!quoted) return null;
      values.push(quoted.node.value);
      items?.push(quoted.node);
      idx = quoted.nextIndex;
      continue;
    }
    if (itemRest.startsWith("[") || itemRest.startsWith("{")) {
      const collected = collectFlowLines(lines, idx, itemRest, itemOffset, seqIndent + 1, includeSpans);
      if (!collected) return null;
      const node = parseFlowValue(collected.combined, collected.map);
      if (!node) return null;
      values.push(node.value);
      items?.push(node);
      idx = collected.nextIndex;
      continue;
    }
    const piece = plainLineSpan(itemRest, itemOffset, includeSpans);
    const scalar = parsePlainScalar(itemRest);
    values.push(scalar);
    items?.push({ value: scalar, spans: scalar !== null && piece.span ? [piece.span] : EMPTY_SPANS });
    idx++;
  }
  return { node: { value: values, spans: EMPTY_SPANS, items }, nextIndex: idx };
}

function parseBlockMapping(
  lines: RawLine[],
  startIndex: number,
  mapIndent: number,
  includeSpans: boolean,
): { node: YamlNode; nextIndex: number } | null {
  const result: Record<string, YamlValue> = {};
  const entries: Record<string, YamlNode> | undefined = includeSpans ? {} : undefined;
  let idx = startIndex;
  while (idx < lines.length) {
    if (isBlankOrComment(lines[idx])) { idx++; continue; }
    if (lines[idx].indent < mapIndent) break;
    if (lines[idx].indent > mapIndent) return null;
    const kv = splitKeyValue(lines[idx].trimmed);
    if (!kv) return null;
    const parsed = parseValueAfterKey(lines, idx, kv.rest, lines[idx].trimmedOffset + kv.restIndex, mapIndent, includeSpans);
    if (!parsed) return null;
    result[kv.key] = parsed.node.value;
    if (entries) entries[kv.key] = parsed.node;
    idx = parsed.nextIndex;
  }
  return { node: { value: result, spans: EMPTY_SPANS, entries }, nextIndex: idx };
}

function toRawLines(markdown: string, yamlStart: number, yamlEnd: number): RawLine[] | null {
  if (yamlEnd <= yamlStart) return [];
  let sliceEnd = yamlEnd;
  if (sliceEnd > yamlStart && markdown[sliceEnd - 1] === "\n") {
    sliceEnd--;
    if (sliceEnd > yamlStart && markdown[sliceEnd - 1] === "\r") sliceEnd--;
  }
  const lines: RawLine[] = [];
  let pos = yamlStart;
  while (pos <= sliceEnd) {
    const nl = markdown.indexOf("\n", pos);
    const rawEnd = nl < 0 || nl > sliceEnd ? sliceEnd : (nl > pos && markdown[nl - 1] === "\r" ? nl - 1 : nl);
    const raw = markdown.slice(pos, rawEnd);
    let indent = 0;
    let hasLeadingTab = false;
    for (let i = 0; i < raw.length; i++) {
      if (raw[i] === " ") indent++;
      else if (raw[i] === "\t") { hasLeadingTab = true; break; }
      else break;
    }
    const trimmed = raw.trim();
    if (hasLeadingTab && trimmed !== "" && !trimmed.startsWith("#")) return null;
    const leadWs = raw.length - raw.trimStart().length;
    lines.push({
      raw,
      indent,
      trimmed,
      offset: pos,
      trimmedOffset: trimmed ? pos + leadWs : pos,
    });
    if (nl < 0 || nl >= sliceEnd) break;
    pos = nl + 1;
  }
  return lines;
}

function scalarToString(value: YamlValue | undefined): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function lookupCaseInsensitive<T>(entries: Record<string, T>, target: string): T | undefined {
  if (Object.prototype.hasOwnProperty.call(entries, target)) return entries[target];
  const lower = target.toLowerCase();
  for (const [key, value] of Object.entries(entries)) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}

function extractAuthorNameAndSpans(
  value: YamlValue,
  node?: YamlNode,
): { name: string; spans: Array<{ start: number; end: number }> } | undefined {
  const direct = scalarToString(value);
  if (direct) return { name: direct, spans: node?.spans ?? EMPTY_SPANS };
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const rawName = lookupCaseInsensitive(value, "name");
    const useName = rawName !== undefined && rawName !== null;
    const nameVal = useName ? rawName : lookupCaseInsensitive(value, "literal");
    const nameNode = node?.entries ? lookupCaseInsensitive(node.entries, useName ? "name" : "literal") : undefined;
    const directName = scalarToString(nameVal);
    if (directName) return { name: directName, spans: nameNode?.spans ?? EMPTY_SPANS };
    if (nameVal && typeof nameVal === "object" && !Array.isArray(nameVal)) {
      const literal = scalarToString(lookupCaseInsensitive(nameVal, "literal"));
      if (literal) {
        const literalNode = nameNode?.entries ? lookupCaseInsensitive(nameNode.entries, "literal") : undefined;
        return { name: literal, spans: literalNode?.spans ?? EMPTY_SPANS };
      }
      const given = scalarToString(lookupCaseInsensitive(nameVal, "given"));
      const family = scalarToString(lookupCaseInsensitive(nameVal, "family"));
      const parts = [given, family].filter(Boolean);
      if (parts.length) {
        const givenNode = nameNode?.entries ? lookupCaseInsensitive(nameNode.entries, "given") : undefined;
        const familyNode = nameNode?.entries ? lookupCaseInsensitive(nameNode.entries, "family") : undefined;
        return {
          name: parts.join(" "),
          spans: [
            ...(given && givenNode ? givenNode.spans : EMPTY_SPANS),
            ...(family && familyNode ? familyNode.spans : EMPTY_SPANS),
          ],
        };
      }
    }
    const given = scalarToString(lookupCaseInsensitive(value, "given"));
    const family = scalarToString(lookupCaseInsensitive(value, "family"));
    const parts = [given, family].filter(Boolean);
    if (parts.length) {
      const givenNode = node?.entries ? lookupCaseInsensitive(node.entries, "given") : undefined;
      const familyNode = node?.entries ? lookupCaseInsensitive(node.entries, "family") : undefined;
      return {
        name: parts.join(" "),
        spans: [
          ...(given && givenNode ? givenNode.spans : EMPTY_SPANS),
          ...(family && familyNode ? familyNode.spans : EMPTY_SPANS),
        ],
      };
    }
  }
  return undefined;
}

function splitCommaScalarSpans(
  markdown: string,
  spans: Array<{ start: number; end: number }>,
): Array<Array<{ start: number; end: number }>> | null {
  if (!spans.length) return null;
  let sawComma = false;
  const groups: Array<Array<{ start: number; end: number }>> = [];
  let current: Array<{ start: number; end: number }> = [];
  for (const s of spans) {
    const rawSlice = markdown.slice(s.start, s.end);
    if (!rawSlice.includes(",")) {
      const lead = rawSlice.length - rawSlice.trimStart().length;
      const cleaned = rawSlice.trim();
      if (cleaned) current.push({ start: s.start + lead, end: s.start + lead + cleaned.length });
      continue;
    }
    sawComma = true;
    const parts = rawSlice.split(",");
    let cursor = 0;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const lead = part.length - part.trimStart().length;
      const cleaned = part.trim();
      if (cleaned) current.push({ start: s.start + cursor + lead, end: s.start + cursor + lead + cleaned.length });
      if (i < parts.length - 1) {
        groups.push(current);
        current = [];
      }
      cursor += part.length + 1;
    }
  }
  if (!sawComma) return null;
  groups.push(current);
  return groups;
}

function extractTagList(entries: Record<string, YamlValue>, keys: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string | undefined) => {
    if (!raw) return;
    const trimmed = raw.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    out.push(trimmed);
  };
  for (const key of keys) {
    const val = lookupCaseInsensitive(entries, key);
    if (val === undefined || val === null) continue;
    if (Array.isArray(val)) {
      for (const item of val) add(scalarToString(item));
    } else {
      const str = scalarToString(val);
      if (str) {
        if (str.includes(",")) {
          for (const part of str.split(",")) add(part);
        } else {
          add(str);
        }
      }
    }
  }
  return out;
}

function normalizeMetadataAndSpans(
  entries: Record<string, YamlValue>,
  nodeEntries: Record<string, YamlNode> | undefined,
  markdown: string,
  includeSpans: boolean,
): { properties: DocumentMetadata | null; visibleSpans?: FrontmatterVisibleSpan[] } {
  const visibleSpans: FrontmatterVisibleSpan[] | undefined = includeSpans ? [] : undefined;

  const title = scalarToString(lookupCaseInsensitive(entries, "title"));
  if (title && visibleSpans && nodeEntries) {
    const titleNode = lookupCaseInsensitive(nodeEntries, "title");
    if (titleNode) {
      for (const s of titleNode.spans) {
        if (s.end > s.start) visibleSpans.push({ start: s.start, end: s.end, field: "title", fieldOrdinal: 0 });
      }
    }
  }

  const authors: string[] = [];
  const seenAuthors = new Set<string>();
  for (const key of ["author", "authors", "creator"]) {
    const val = lookupCaseInsensitive(entries, key);
    if (val === undefined || val === null) continue;
    const node = nodeEntries ? lookupCaseInsensitive(nodeEntries, key) : undefined;
    if (Array.isArray(val)) {
      for (let i = 0; i < val.length; i++) {
        const extracted = extractAuthorNameAndSpans(val[i], node?.items?.[i]);
        if (!extracted || seenAuthors.has(extracted.name)) continue;
        seenAuthors.add(extracted.name);
        authors.push(extracted.name);
        if (visibleSpans) {
          for (const s of extracted.spans) {
            if (s.end > s.start) visibleSpans.push({ start: s.start, end: s.end, field: "author", fieldOrdinal: 0 });
          }
        }
      }
    } else {
      const extracted = extractAuthorNameAndSpans(val, node);
      if (extracted && !seenAuthors.has(extracted.name)) {
        seenAuthors.add(extracted.name);
        authors.push(extracted.name);
        if (visibleSpans) {
          for (const s of extracted.spans) {
            if (s.end > s.start) visibleSpans.push({ start: s.start, end: s.end, field: "author", fieldOrdinal: 0 });
          }
        }
      }
    }
  }

  const tags: string[] = [];
  const seenTags = new Set<string>();
  const addTag = (raw: string | undefined, spans: Array<{ start: number; end: number }>) => {
    if (!raw) return;
    const trimmed = raw.trim();
    if (!trimmed || seenTags.has(trimmed)) return;
    seenTags.add(trimmed);
    const ord = tags.length;
    tags.push(trimmed);
    if (visibleSpans) {
      for (const s of spans) {
        if (s.end > s.start) visibleSpans.push({ start: s.start, end: s.end, field: "tag", fieldOrdinal: ord });
      }
    }
  };
  for (const key of ["tags", "tag", "keywords"]) {
    const val = lookupCaseInsensitive(entries, key);
    if (val === undefined || val === null) continue;
    const node = nodeEntries ? lookupCaseInsensitive(nodeEntries, key) : undefined;
    if (Array.isArray(val)) {
      for (let i = 0; i < val.length; i++) {
        addTag(scalarToString(val[i]), node?.items?.[i]?.spans ?? EMPTY_SPANS);
      }
    } else {
      const str = scalarToString(val);
      if (!str) continue;
      const nodeSpans = node?.spans ?? EMPTY_SPANS;
      if (str.includes(",")) {
        const rawParts = str.split(",");
        const splitGroups = visibleSpans ? splitCommaScalarSpans(markdown, nodeSpans) : null;
        for (let i = 0; i < rawParts.length; i++) {
          addTag(rawParts[i], splitGroups ? (splitGroups[i] ?? EMPTY_SPANS) : nodeSpans);
        }
      } else {
        addTag(str, nodeSpans);
      }
    }
  }

  const subtitle = scalarToString(lookupCaseInsensitive(entries, "subtitle"));
  const date = scalarToString(lookupCaseInsensitive(entries, "date"));
  const description =
    scalarToString(lookupCaseInsensitive(entries, "description")) ??
    scalarToString(lookupCaseInsensitive(entries, "subject")) ??
    scalarToString(lookupCaseInsensitive(entries, "abstract"));
  const aliases = extractTagList(entries, ["aliases", "alias"]);

  const properties = (!title && !subtitle && !authors.length && !date && !description && !tags.length && !aliases.length)
    ? null
    : { title, subtitle, authors, date, description, tags, aliases };

  return includeSpans ? { properties, visibleSpans } : { properties };
}

export function parseFrontmatter(markdown: string, options?: ParseFrontmatterOptions): ParsedFrontmatter | null {
  let cursor = markdown.startsWith("\uFEFF") ? 1 : 0;
  if (!markdown.startsWith("---", cursor)) return null;
  cursor += 3;
  while (cursor < markdown.length && (markdown[cursor] === " " || markdown[cursor] === "\t")) cursor++;
  if (markdown[cursor] === "\r" && markdown[cursor + 1] === "\n") cursor += 2;
  else if (markdown[cursor] === "\n") cursor += 1;
  else return null;

  const yamlStart = cursor;
  let lineStart = cursor;
  let yamlEnd = -1;
  let frontmatterEnd = -1;

  while (lineStart <= markdown.length) {
    const lineEnd = markdown.indexOf("\n", lineStart);
    let nextLineStart: number;
    let contentEnd: number;
    if (lineEnd < 0) {
      contentEnd = markdown.length;
      nextLineStart = markdown.length + 1;
    } else {
      contentEnd = lineEnd > lineStart && markdown[lineEnd - 1] === "\r" ? lineEnd - 1 : lineEnd;
      nextLineStart = lineEnd + 1;
    }
    const line = markdown.slice(lineStart, contentEnd);
    if (/^(?:---|\.\.\.)[ \t]*$/.test(line)) {
      yamlEnd = lineStart;
      frontmatterEnd = lineEnd < 0 ? markdown.length : lineEnd + 1;
      break;
    }
    if (lineEnd < 0) break;
    lineStart = nextLineStart;
  }

  if (yamlEnd < 0 || frontmatterEnd < 0) return null;

  const includeSpans = Boolean(options?.includeSpans);
  const lines = toRawLines(markdown, yamlStart, yamlEnd);
  if (!lines) return null;

  const firstMeaningful = nextMeaningfulLine(lines, 0);
  let entries: Record<string, YamlValue> = {};
  let nodeEntries: Record<string, YamlNode> | undefined = includeSpans ? {} : undefined;
  if (firstMeaningful < lines.length) {
    if (lines[firstMeaningful].indent !== 0) return null;
    const parsed = parseBlockMapping(lines, firstMeaningful, 0, includeSpans);
    if (!parsed || nextMeaningfulLine(lines, parsed.nextIndex) < lines.length) return null;
    entries = parsed.node.value as Record<string, YamlValue>;
    nodeEntries = parsed.node.entries;
  }

  const normalized = normalizeMetadataAndSpans(entries, nodeEntries, markdown, includeSpans);
  const result: ParsedFrontmatter = {
    raw: markdown.slice(0, frontmatterEnd),
    end: frontmatterEnd,
    entries,
    properties: normalized.properties,
  };
  if (includeSpans) result.visibleSpans = normalized.visibleSpans ?? [];
  return result;
}

/**
 * Replace recognized YAML frontmatter characters with spaces while preserving
 * all `\r` and `\n` line breaks so AST parsers skip frontmatter without
 * shifting any UTF-16 character or line offsets in the body.
 */
export function maskFrontmatter(markdown: string): string {
  const fm = parseFrontmatter(markdown);
  if (!fm) return markdown;
  const prefix = fm.raw.replace(/[^\r\n]/g, " ");
  return prefix + markdown.slice(fm.end);
}

/**
 * Return canonical UTF-16 source spans for frontmatter values rendered in
 * DocumentProperties (`title`, `author`, and `tags`) in exact display order.
 * Excludes YAML keys, comments, quotes, and unrendered fields (`subtitle`,
 * `date`, `description`, `aliases`, etc.).
 */
export function frontmatterVisibleValueSpans(markdown: string): FrontmatterVisibleSpan[] {
  return parseFrontmatter(markdown, { includeSpans: true })?.visibleSpans ?? [];
}
