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

export interface ParsedFrontmatter {
  /** Exact raw substring from index 0 (including optional BOM and closing newline if present). */
  raw: string;
  /** UTF-16 code unit offset in the original Markdown where the body begins. */
  end: number;
  /** Parsed top-level YAML key-value mapping. */
  entries: Record<string, YamlValue>;
  /** Normalized reader/PDF properties, or null when no recognized fields are populated. */
  properties: DocumentMetadata | null;
}

interface RawLine {
  raw: string;
  indent: number;
  trimmed: string;
}

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
          out += String.fromCodePoint(Number.parseInt(hex, 16));
          i += 4;
          break;
        }
        case "U": {
          const hex = input.slice(i + 1, i + 9);
          if (!/^[0-9a-fA-F]{8}$/.test(hex)) return null;
          const cp = Number.parseInt(hex, 16);
          if (cp > 0x10ffff) return null;
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

function splitTopLevelCommas(inner: string): string[] | null {
  const parts: string[] = [];
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
      parts.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  if (depthBracket !== 0 || depthBrace !== 0) return null;
  parts.push(inner.slice(start));
  return parts;
}

function parseFlowValue(raw: string): { ok: true; value: YamlValue } | { ok: false } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, value: null };
  if (trimmed.startsWith('"')) {
    const parsed = parseDoubleQuoted(trimmed);
    if (!parsed || !onlyTrailingComment(parsed.rest)) return { ok: false };
    return { ok: true, value: parsed.value };
  }
  if (trimmed.startsWith("'")) {
    const parsed = parseSingleQuoted(trimmed);
    if (!parsed || !onlyTrailingComment(parsed.rest)) return { ok: false };
    return { ok: true, value: parsed.value };
  }
  if (trimmed.startsWith("[")) {
    if (!trimmed.endsWith("]")) return { ok: false };
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) return { ok: true, value: [] };
    const items = splitTopLevelCommas(inner);
    if (!items) return { ok: false };
    const out: YamlValue[] = [];
    for (const item of items) {
      if (!item.trim()) continue;
      const parsed = parseFlowValue(item);
      if (!parsed.ok) return { ok: false };
      out.push(parsed.value);
    }
    return { ok: true, value: out };
  }
  if (trimmed.startsWith("{")) {
    if (!trimmed.endsWith("}")) return { ok: false };
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) return { ok: true, value: {} };
    const pairs = splitTopLevelCommas(inner);
    if (!pairs) return { ok: false };
    const out: Record<string, YamlValue> = {};
    for (const pair of pairs) {
      if (!pair.trim()) continue;
      const kv = splitKeyValue(pair.trim(), true);
      if (!kv) return { ok: false };
      const parsed = parseFlowValue(kv.rest);
      if (!parsed.ok) return { ok: false };
      out[kv.key] = parsed.value;
    }
    return { ok: true, value: out };
  }
  if (trimmed.includes("[") || trimmed.includes("]") || trimmed.includes("{") || trimmed.includes("}")) {
    // Reject unbalanced flow indicators in flow values such as `[a, [b]`.
    if (!splitTopLevelCommas(trimmed)) return { ok: false };
  }
  return { ok: true, value: parsePlainScalar(trimmed) };
}

function splitKeyValue(trimmedLine: string, allowCompactFlowColon = false): { key: string; rest: string } | null {
  if (!trimmedLine || trimmedLine.startsWith("#")) return null;
  if (trimmedLine.startsWith("- ") || trimmedLine === "-" || trimmedLine.startsWith("-\t")) return null;
  if (trimmedLine.startsWith('"')) {
    const parsed = parseDoubleQuoted(trimmedLine);
    if (!parsed) return null;
    const after = parsed.rest.trimStart();
    if (!after.startsWith(":")) return null;
    const postColon = after.slice(1);
    if (!allowCompactFlowColon && postColon.length > 0 && postColon[0] !== " " && postColon[0] !== "\t") return null;
    return { key: parsed.value, rest: postColon.trimStart() };
  }
  if (trimmedLine.startsWith("'")) {
    const parsed = parseSingleQuoted(trimmedLine);
    if (!parsed) return null;
    const after = parsed.rest.trimStart();
    if (!after.startsWith(":")) return null;
    const postColon = after.slice(1);
    if (!allowCompactFlowColon && postColon.length > 0 && postColon[0] !== " " && postColon[0] !== "\t") return null;
    return { key: parsed.value, rest: postColon.trimStart() };
  }
  if (/^[\[\]{}|>*&!%@]/.test(trimmedLine)) return null;
  for (let i = 0; i < trimmedLine.length; i++) {
    if (trimmedLine[i] !== ":") continue;
    const next = trimmedLine[i + 1];
    if (allowCompactFlowColon || next === undefined || next === " " || next === "\t") {
      const key = trimmedLine.slice(0, i).trim();
      if (!key || /[\[\]{}"']/.test(key)) return null;
      return { key, rest: trimmedLine.slice(i + 1).trimStart() };
    }
  }
  return null;
}

function isBlankOrComment(line: RawLine): boolean {
  return line.trimmed === "" || line.trimmed.startsWith("#");
}

function isSequenceItem(trimmed: string): { itemRest: string } | null {
  if (trimmed === "-") return { itemRest: "" };
  if (trimmed.startsWith("- ") || trimmed.startsWith("-\t")) {
    return { itemRest: trimmed.slice(1).trimStart() };
  }
  return null;
}

function collectFlowLines(lines: RawLine[], startIndex: number, initialRest: string, minContIndent: number): { combined: string; nextIndex: number } | null {
  let combined = stripFlowLineComment(initialRest);
  let idx = startIndex;
  while (true) {
    const state = flowBalanceState(combined);
    if (state === "error") return null;
    if (state === "balanced") return { combined, nextIndex: idx + 1 };
    idx++;
    if (idx >= lines.length) return null;
    if (isBlankOrComment(lines[idx])) continue;
    if (lines[idx].indent < minContIndent) return null;
    combined += " " + stripFlowLineComment(lines[idx].trimmed);
  }
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

function collectQuotedScalar(lines: RawLine[], startIndex: number, initialRest: string, minContIndent: number): { value: string; nextIndex: number } | null {
  const quote = initialRest[0];
  let combined = initialRest;
  let idx = startIndex;
  while (true) {
    const parsed = quote === '"' ? parseDoubleQuoted(combined) : parseSingleQuoted(combined);
    if (parsed) {
      if (!onlyTrailingComment(parsed.rest)) return null;
      return { value: parsed.value, nextIndex: idx + 1 };
    }
    idx++;
    if (idx >= lines.length) return null;
    if (lines[idx].trimmed === "") {
      combined += "\n";
      continue;
    }
    if (lines[idx].indent < minContIndent) return null;
    combined += "\n" + lines[idx].trimmed;
  }
}

function parseBlockScalar(lines: RawLine[], startIndex: number, header: string, parentIndent: number): { value: string; nextIndex: number } | null {
  const match = BLOCK_SCALAR_HEADER.exec(header);
  if (!match) return null;
  const style = match[1];
  const chomp = match[2] || match[5] || "clip";
  const indentDigit = match[3] || match[4];
  const rawContent: string[] = [];
  let idx = startIndex + 1;
  while (idx < lines.length) {
    const raw = lines[idx].raw;
    if (raw.trim() === "") {
      rawContent.push("");
      idx++;
      continue;
    }
    if (lines[idx].indent <= parentIndent) break;
    rawContent.push(raw);
    idx++;
  }
  while (rawContent.length > 0 && rawContent[rawContent.length - 1] === "" && chomp === "-") {
    rawContent.pop();
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
  if (!Number.isFinite(blockIndent)) return { value: "", nextIndex: idx };
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
  if (chomp === "-") out = out.replace(/\n+$/, "");
  else if (chomp === "clip") out = out.replace(/\n+$/, "");
  return { value: out, nextIndex: idx };
}

function nextMeaningfulLine(lines: RawLine[], fromIndex: number): number {
  let idx = fromIndex;
  while (idx < lines.length && isBlankOrComment(lines[idx])) idx++;
  return idx;
}

function parseValueAfterKey(
  lines: RawLine[],
  lineIndex: number,
  rest: string,
  keyIndent: number,
): { value: YamlValue; nextIndex: number } | null {
  if (rest === "" || rest.startsWith("#")) {
    const nextIdx = nextMeaningfulLine(lines, lineIndex + 1);
    if (nextIdx >= lines.length) return { value: null, nextIndex: lines.length };
    const nextLine = lines[nextIdx];
    if (nextLine.indent > keyIndent && isSequenceItem(nextLine.trimmed)) {
      return parseBlockSequence(lines, nextIdx, nextLine.indent);
    }
    if (nextLine.indent === keyIndent && isSequenceItem(nextLine.trimmed)) {
      return parseBlockSequence(lines, nextIdx, keyIndent);
    }
    if (nextLine.indent > keyIndent) {
      if (splitKeyValue(nextLine.trimmed)) {
        return parseBlockMapping(lines, nextIdx, nextLine.indent);
      }
      const parts: string[] = [];
      let idx = nextIdx;
      while (idx < lines.length) {
        if (isBlankOrComment(lines[idx])) { idx++; continue; }
        if (lines[idx].indent <= keyIndent) break;
        if (splitKeyValue(lines[idx].trimmed) || isSequenceItem(lines[idx].trimmed)) break;
        parts.push(stripInlineComment(lines[idx].trimmed));
        idx++;
      }
      return { value: parsePlainScalar(parts.join(" ")), nextIndex: idx };
    }
    return { value: null, nextIndex: nextIdx };
  }

  if (rest.startsWith("|") || rest.startsWith(">")) {
    return parseBlockScalar(lines, lineIndex, rest, keyIndent);
  }
  if (rest.startsWith('"') || rest.startsWith("'")) {
    return collectQuotedScalar(lines, lineIndex, rest, keyIndent + 1);
  }
  if (rest.startsWith("[") || rest.startsWith("{")) {
    const collected = collectFlowLines(lines, lineIndex, rest, keyIndent);
    if (!collected) return null;
    const parsed = parseFlowValue(collected.combined);
    if (!parsed.ok) return null;
    return { value: parsed.value, nextIndex: collected.nextIndex };
  }

  const parts = [stripInlineComment(rest)];
  let idx = lineIndex + 1;
  while (idx < lines.length) {
    if (isBlankOrComment(lines[idx])) break;
    if (lines[idx].indent <= keyIndent) break;
    if (splitKeyValue(lines[idx].trimmed) || isSequenceItem(lines[idx].trimmed)) break;
    parts.push(stripInlineComment(lines[idx].trimmed));
    idx++;
  }
  return { value: parsePlainScalar(parts.join(" ")), nextIndex: idx };
}

function parseBlockSequence(lines: RawLine[], startIndex: number, seqIndent: number): { value: YamlValue[]; nextIndex: number } | null {
  const items: YamlValue[] = [];
  let idx = startIndex;
  while (idx < lines.length) {
    if (isBlankOrComment(lines[idx])) { idx++; continue; }
    if (lines[idx].indent < seqIndent) break;
    if (lines[idx].indent > seqIndent) return null;
    const seq = isSequenceItem(lines[idx].trimmed);
    if (!seq) break;
    const itemRest = seq.itemRest;
    if (itemRest === "" || itemRest.startsWith("#")) {
      const nextIdx = nextMeaningfulLine(lines, idx + 1);
      if (nextIdx < lines.length && lines[nextIdx].indent > seqIndent) {
        if (isSequenceItem(lines[nextIdx].trimmed)) {
          const sub = parseBlockSequence(lines, nextIdx, lines[nextIdx].indent);
          if (!sub) return null;
          items.push(sub.value);
          idx = sub.nextIndex;
          continue;
        }
        if (splitKeyValue(lines[nextIdx].trimmed)) {
          const sub = parseBlockMapping(lines, nextIdx, lines[nextIdx].indent);
          if (!sub) return null;
          items.push(sub.value);
          idx = sub.nextIndex;
          continue;
        }
      }
      items.push(null);
      idx = nextIdx;
      continue;
    }
    const inlineKv = splitKeyValue(itemRest);
    if (inlineKv) {
      const entryIndent = seqIndent + 2;
      const firstVal = parseValueAfterKey(lines, idx, inlineKv.rest, seqIndent + 1);
      if (!firstVal) return null;
      const obj: Record<string, YamlValue> = { [inlineKv.key]: firstVal.value };
      let nextIdx = firstVal.nextIndex;
      const peek = nextMeaningfulLine(lines, nextIdx);
      if (peek < lines.length && lines[peek].indent >= entryIndent && !isSequenceItem(lines[peek].trimmed)) {
        const restMap = parseBlockMapping(lines, peek, lines[peek].indent);
        if (!restMap) return null;
        Object.assign(obj, restMap.value);
        nextIdx = restMap.nextIndex;
      }
      items.push(obj);
      idx = nextIdx;
      continue;
    }
    if (itemRest.startsWith("|") || itemRest.startsWith(">")) {
      const block = parseBlockScalar(lines, idx, itemRest, seqIndent);
      if (!block) return null;
      items.push(block.value);
      idx = block.nextIndex;
      continue;
    }
    if (itemRest.startsWith('"') || itemRest.startsWith("'")) {
      const quoted = collectQuotedScalar(lines, idx, itemRest, seqIndent + 1);
      if (!quoted) return null;
      items.push(quoted.value);
      idx = quoted.nextIndex;
      continue;
    }
    if (itemRest.startsWith("[") || itemRest.startsWith("{")) {
      const collected = collectFlowLines(lines, idx, itemRest, seqIndent + 1);
      if (!collected) return null;
      const parsed = parseFlowValue(collected.combined);
      if (!parsed.ok) return null;
      items.push(parsed.value);
      idx = collected.nextIndex;
      continue;
    }
    items.push(parsePlainScalar(itemRest));
    idx++;
  }
  return { value: items, nextIndex: idx };
}

function parseBlockMapping(lines: RawLine[], startIndex: number, mapIndent: number): { value: Record<string, YamlValue>; nextIndex: number } | null {
  const result: Record<string, YamlValue> = {};
  let idx = startIndex;
  while (idx < lines.length) {
    if (isBlankOrComment(lines[idx])) { idx++; continue; }
    if (lines[idx].indent < mapIndent) break;
    if (lines[idx].indent > mapIndent) return null;
    const kv = splitKeyValue(lines[idx].trimmed);
    if (!kv) return null;
    const parsed = parseValueAfterKey(lines, idx, kv.rest, mapIndent);
    if (!parsed) return null;
    result[kv.key] = parsed.value;
    idx = parsed.nextIndex;
  }
  return { value: result, nextIndex: idx };
}

function toRawLines(yamlBody: string): RawLine[] | null {
  const lines: RawLine[] = [];
  for (const rawLine of yamlBody.split(/\r?\n/)) {
    let indent = 0;
    let hasLeadingTab = false;
    for (let i = 0; i < rawLine.length; i++) {
      if (rawLine[i] === " ") indent++;
      else if (rawLine[i] === "\t") { hasLeadingTab = true; break; }
      else break;
    }
    const trimmed = rawLine.trim();
    if (hasLeadingTab && trimmed !== "" && !trimmed.startsWith("#")) return null;
    lines.push({ raw: rawLine, indent, trimmed });
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

function extractAuthorName(value: YamlValue): string | undefined {
  const direct = scalarToString(value);
  if (direct) return direct;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const name = value.name ?? value.literal;
    const directName = scalarToString(name);
    if (directName) return directName;
    if (name && typeof name === "object" && !Array.isArray(name)) {
      const literal = scalarToString(name.literal);
      if (literal) return literal;
      const parts = [scalarToString(name.given), scalarToString(name.family)].filter(Boolean);
      if (parts.length) return parts.join(" ");
    }
    const parts = [scalarToString(value.given), scalarToString(value.family)].filter(Boolean);
    if (parts.length) return parts.join(" ");
  }
  return undefined;
}

function extractAuthors(entries: Record<string, YamlValue>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (name: string | undefined) => {
    if (!name) return;
    if (!seen.has(name)) { seen.add(name); out.push(name); }
  };
  for (const key of ["author", "authors", "creator"]) {
    const val = lookupCaseInsensitive(entries, key);
    if (val === undefined || val === null) continue;
    if (Array.isArray(val)) {
      for (const item of val) add(extractAuthorName(item));
    } else {
      add(extractAuthorName(val));
    }
  }
  return out;
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

function lookupCaseInsensitive(entries: Record<string, YamlValue>, target: string): YamlValue | undefined {
  if (Object.prototype.hasOwnProperty.call(entries, target)) return entries[target];
  const lower = target.toLowerCase();
  for (const [key, value] of Object.entries(entries)) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}

function normalizeMetadata(entries: Record<string, YamlValue>): DocumentMetadata | null {
  const title = scalarToString(lookupCaseInsensitive(entries, "title"));
  const subtitle = scalarToString(lookupCaseInsensitive(entries, "subtitle"));
  const authors = extractAuthors(entries);
  const date = scalarToString(lookupCaseInsensitive(entries, "date"));
  const description =
    scalarToString(lookupCaseInsensitive(entries, "description")) ??
    scalarToString(lookupCaseInsensitive(entries, "subject")) ??
    scalarToString(lookupCaseInsensitive(entries, "abstract"));
  const tags = extractTagList(entries, ["tags", "tag", "keywords"]);
  const aliases = extractTagList(entries, ["aliases", "alias"]);

  if (!title && !subtitle && !authors.length && !date && !description && !tags.length && !aliases.length) {
    return null;
  }
  return { title, subtitle, authors, date, description, tags, aliases };
}

export function parseFrontmatter(markdown: string): ParsedFrontmatter | null {
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
    let lineEnd = markdown.indexOf("\n", lineStart);
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

  const yamlSlice = markdown.slice(yamlStart, yamlEnd).replace(/\r?\n$/, "");
  const lines = yamlSlice === "" ? [] : toRawLines(yamlSlice);
  if (!lines) return null;

  const firstMeaningful = nextMeaningfulLine(lines, 0);
  let entries: Record<string, YamlValue> = {};
  if (firstMeaningful < lines.length) {
    if (lines[firstMeaningful].indent !== 0) return null;
    const parsed = parseBlockMapping(lines, firstMeaningful, 0);
    if (!parsed || nextMeaningfulLine(lines, parsed.nextIndex) < lines.length) return null;
    entries = parsed.value;
  }

  return {
    raw: markdown.slice(0, frontmatterEnd),
    end: frontmatterEnd,
    entries,
    properties: normalizeMetadata(entries),
  };
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

interface SpanLine {
  raw: string;
  indent: number;
  trimmed: string;
  offset: number;
  trimmedOffset: number;
}

interface SpanNode {
  value: YamlValue;
  spans: Array<{ start: number; end: number }>;
  items?: SpanNode[];
  entries?: Record<string, SpanNode>;
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

function splitKeyValueWithIndex(
  trimmedLine: string,
  allowCompactFlowColon = false,
): { key: string; rest: string; restIndex: number } | null {
  if (!trimmedLine || trimmedLine.startsWith("#")) return null;
  if (trimmedLine.startsWith("- ") || trimmedLine === "-" || trimmedLine.startsWith("-\t")) return null;
  if (trimmedLine.startsWith('"') || trimmedLine.startsWith("'")) {
    const parsed = trimmedLine.startsWith('"') ? parseDoubleQuoted(trimmedLine) : parseSingleQuoted(trimmedLine);
    if (!parsed) return null;
    let idx = trimmedLine.length - parsed.rest.length;
    while (idx < trimmedLine.length && (trimmedLine[idx] === " " || trimmedLine[idx] === "\t")) idx++;
    if (trimmedLine[idx] !== ":") return null;
    idx++;
    if (!allowCompactFlowColon && idx < trimmedLine.length && trimmedLine[idx] !== " " && trimmedLine[idx] !== "\t") return null;
    while (idx < trimmedLine.length && (trimmedLine[idx] === " " || trimmedLine[idx] === "\t")) idx++;
    return { key: parsed.value, rest: trimmedLine.slice(idx), restIndex: idx };
  }
  if (/^[\[\]{}|>*&!%@]/.test(trimmedLine)) return null;
  for (let i = 0; i < trimmedLine.length; i++) {
    if (trimmedLine[i] !== ":") continue;
    const next = trimmedLine[i + 1];
    if (allowCompactFlowColon || next === undefined || next === " " || next === "\t") {
      const key = trimmedLine.slice(0, i).trim();
      if (!key || /[\[\]{}"']/.test(key)) return null;
      let restIndex = i + 1;
      while (restIndex < trimmedLine.length && (trimmedLine[restIndex] === " " || trimmedLine[restIndex] === "\t")) restIndex++;
      return { key, rest: trimmedLine.slice(restIndex), restIndex };
    }
  }
  return null;
}

function splitTopLevelCommasWithRanges(inner: string): Array<{ part: string; start: number }> | null {
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

function parseFlowSpanNode(raw: string, map: number[]): SpanNode | null {
  let lead = 0;
  while (lead < raw.length && (raw[lead] === " " || raw[lead] === "\t" || raw[lead] === "\r" || raw[lead] === "\n")) lead++;
  let endIdx = raw.length;
  while (endIdx > lead && (raw[endIdx - 1] === " " || raw[endIdx - 1] === "\t" || raw[endIdx - 1] === "\r" || raw[endIdx - 1] === "\n")) endIdx--;
  const trimmed = raw.slice(lead, endIdx);
  const subMap = map.slice(lead, endIdx);
  if (!trimmed) return { value: null, spans: [] };
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    const parsed = trimmed.startsWith('"') ? parseDoubleQuoted(trimmed) : parseSingleQuoted(trimmed);
    if (!parsed || !onlyTrailingComment(parsed.rest)) return null;
    const closeIdx = trimmed.length - parsed.rest.length - 1;
    const span = mapSliceToSpan(subMap, 1, closeIdx);
    return { value: parsed.value, spans: span ? [span] : [] };
  }
  if (trimmed.startsWith("[")) {
    if (!trimmed.endsWith("]")) return null;
    const inner = trimmed.slice(1, -1);
    const innerMap = subMap.slice(1, -1);
    if (!inner.trim()) return { value: [], spans: [], items: [] };
    const parts = splitTopLevelCommasWithRanges(inner);
    if (!parts) return null;
    const items: SpanNode[] = [];
    for (const { part, start } of parts) {
      if (!part.trim()) continue;
      const itemNode = parseFlowSpanNode(part, innerMap.slice(start, start + part.length));
      if (!itemNode) return null;
      items.push(itemNode);
    }
    return { value: items.map(i => i.value), spans: [], items };
  }
  if (trimmed.startsWith("{")) {
    if (!trimmed.endsWith("}")) return null;
    const inner = trimmed.slice(1, -1);
    const innerMap = subMap.slice(1, -1);
    if (!inner.trim()) return { value: {}, spans: [], entries: {} };
    const pairs = splitTopLevelCommasWithRanges(inner);
    if (!pairs) return null;
    const entries: Record<string, SpanNode> = {};
    const out: Record<string, YamlValue> = {};
    for (const { part, start } of pairs) {
      if (!part.trim()) continue;
      let pairLead = 0;
      while (pairLead < part.length && (part[pairLead] === " " || part[pairLead] === "\t")) pairLead++;
      const pairTrimmed = part.slice(pairLead).trimEnd();
      const kv = splitKeyValueWithIndex(pairTrimmed, true);
      if (!kv) return null;
      const valStartInInner = start + pairLead + kv.restIndex;
      const valNode = parseFlowSpanNode(kv.rest, innerMap.slice(valStartInInner, valStartInInner + kv.rest.length));
      if (!valNode) return null;
      entries[kv.key] = valNode;
      out[kv.key] = valNode.value;
    }
    return { value: out, spans: [], entries };
  }
  const withoutComment = stripInlineComment(trimmed);
  let cleanLead = 0;
  while (cleanLead < withoutComment.length && (withoutComment[cleanLead] === " " || withoutComment[cleanLead] === "\t")) cleanLead++;
  const cleaned = withoutComment.slice(cleanLead).trimEnd();
  const scalar = parsePlainScalar(trimmed);
  const span = scalar !== null && cleaned.length > 0 ? mapSliceToSpan(subMap, cleanLead, cleanLead + cleaned.length) : null;
  return { value: scalar, spans: span ? [span] : [] };
}

function collectFlowWithMap(
  lines: SpanLine[],
  startIndex: number,
  initialRest: string,
  initialOffset: number,
  minContIndent: number,
): { combined: string; map: number[]; nextIndex: number } | null {
  const firstStripped = stripFlowLineComment(initialRest);
  let combined = firstStripped;
  const map = makeDirectMap(initialOffset, firstStripped.length);
  let idx = startIndex;
  while (true) {
    const state = flowBalanceState(combined);
    if (state === "error") return null;
    if (state === "balanced") return { combined, map, nextIndex: idx + 1 };
    idx++;
    if (idx >= lines.length) return null;
    if (lines[idx].trimmed === "" || lines[idx].trimmed.startsWith("#")) continue;
    if (lines[idx].indent < minContIndent) return null;
    const nextStripped = stripFlowLineComment(lines[idx].trimmed);
    combined += " " + nextStripped;
    map.push(lines[idx].trimmedOffset > 0 ? lines[idx].trimmedOffset - 1 : lines[idx].trimmedOffset);
    for (let i = 0; i < nextStripped.length; i++) map.push(lines[idx].trimmedOffset + i);
  }
}

function collectQuotedWithMap(
  lines: SpanLine[],
  startIndex: number,
  initialRest: string,
  initialOffset: number,
  minContIndent: number,
): { node: SpanNode; nextIndex: number } | null {
  const quote = initialRest[0];
  let combined = initialRest;
  const map = makeDirectMap(initialOffset, initialRest.length);
  let idx = startIndex;
  while (true) {
    const parsed = quote === '"' ? parseDoubleQuoted(combined) : parseSingleQuoted(combined);
    if (parsed) {
      if (!onlyTrailingComment(parsed.rest)) return null;
      const closeIdx = combined.length - parsed.rest.length - 1;
      const span = mapSliceToSpan(map, 1, closeIdx);
      return { node: { value: parsed.value, spans: span ? [span] : [] }, nextIndex: idx + 1 };
    }
    idx++;
    if (idx >= lines.length) return null;
    if (lines[idx].trimmed === "") {
      combined += "\n";
      map.push(lines[idx].offset);
      continue;
    }
    if (lines[idx].indent < minContIndent) return null;
    combined += "\n" + lines[idx].trimmed;
    map.push(lines[idx].offset);
    for (let i = 0; i < lines[idx].trimmed.length; i++) map.push(lines[idx].trimmedOffset + i);
  }
}

function parseBlockScalarWithSpans(
  lines: SpanLine[],
  startIndex: number,
  header: string,
  parentIndent: number,
): { node: SpanNode; nextIndex: number } | null {
  const rawLines: RawLine[] = lines.map(l => ({ raw: l.raw, indent: l.indent, trimmed: l.trimmed }));
  const parsed = parseBlockScalar(rawLines, startIndex, header, parentIndent);
  if (!parsed) return null;
  const spans: Array<{ start: number; end: number }> = [];
  for (let i = startIndex + 1; i < parsed.nextIndex; i++) {
    if (lines[i].trimmed === "") continue;
    spans.push({ start: lines[i].trimmedOffset, end: lines[i].offset + lines[i].raw.length });
  }
  return { node: { value: parsed.value, spans }, nextIndex: parsed.nextIndex };
}

function nextMeaningfulSpanLine(lines: SpanLine[], fromIndex: number): number {
  let idx = fromIndex;
  while (idx < lines.length && (lines[idx].trimmed === "" || lines[idx].trimmed.startsWith("#"))) idx++;
  return idx;
}

function plainLineSpan(text: string, baseOffset: number): { stripped: string; span: { start: number; end: number } | null } {
  const withoutComment = stripInlineComment(text);
  let lead = 0;
  while (lead < withoutComment.length && (withoutComment[lead] === " " || withoutComment[lead] === "\t")) lead++;
  const cleaned = withoutComment.slice(lead).trimEnd();
  return {
    stripped: cleaned,
    span: cleaned.length > 0 ? { start: baseOffset + lead, end: baseOffset + lead + cleaned.length } : null,
  };
}

function parseSpanValueAfterKey(
  lines: SpanLine[],
  lineIndex: number,
  rest: string,
  restOffset: number,
  keyIndent: number,
): { node: SpanNode; nextIndex: number } | null {
  if (rest === "" || rest.startsWith("#")) {
    const nextIdx = nextMeaningfulSpanLine(lines, lineIndex + 1);
    if (nextIdx >= lines.length) return { node: { value: null, spans: [] }, nextIndex: lines.length };
    const nextLine = lines[nextIdx];
    if (nextLine.indent >= keyIndent && isSequenceItem(nextLine.trimmed)) {
      return parseSpanBlockSequence(lines, nextIdx, nextLine.indent);
    }
    if (nextLine.indent > keyIndent) {
      if (splitKeyValue(nextLine.trimmed)) {
        return parseSpanBlockMapping(lines, nextIdx, nextLine.indent);
      }
      const parts: string[] = [];
      const spans: Array<{ start: number; end: number }> = [];
      let idx = nextIdx;
      while (idx < lines.length) {
        if (lines[idx].trimmed === "" || lines[idx].trimmed.startsWith("#")) { idx++; continue; }
        if (lines[idx].indent <= keyIndent) break;
        if (splitKeyValue(lines[idx].trimmed) || isSequenceItem(lines[idx].trimmed)) break;
        const piece = plainLineSpan(lines[idx].trimmed, lines[idx].trimmedOffset);
        parts.push(piece.stripped);
        if (piece.span) spans.push(piece.span);
        idx++;
      }
      const value = parsePlainScalar(parts.join(" "));
      return { node: { value, spans: value === null ? [] : spans }, nextIndex: idx };
    }
    return { node: { value: null, spans: [] }, nextIndex: nextIdx };
  }
  if (rest.startsWith("|") || rest.startsWith(">")) {
    return parseBlockScalarWithSpans(lines, lineIndex, rest, keyIndent);
  }
  if (rest.startsWith('"') || rest.startsWith("'")) {
    return collectQuotedWithMap(lines, lineIndex, rest, restOffset, keyIndent + 1);
  }
  if (rest.startsWith("[") || rest.startsWith("{")) {
    const collected = collectFlowWithMap(lines, lineIndex, rest, restOffset, keyIndent);
    if (!collected) return null;
    const node = parseFlowSpanNode(collected.combined, collected.map);
    if (!node) return null;
    return { node, nextIndex: collected.nextIndex };
  }
  const firstPiece = plainLineSpan(rest, restOffset);
  const parts = [firstPiece.stripped];
  const spans: Array<{ start: number; end: number }> = firstPiece.span ? [firstPiece.span] : [];
  let idx = lineIndex + 1;
  while (idx < lines.length) {
    if (lines[idx].trimmed === "" || lines[idx].trimmed.startsWith("#")) break;
    if (lines[idx].indent <= keyIndent) break;
    if (splitKeyValue(lines[idx].trimmed) || isSequenceItem(lines[idx].trimmed)) break;
    const piece = plainLineSpan(lines[idx].trimmed, lines[idx].trimmedOffset);
    parts.push(piece.stripped);
    if (piece.span) spans.push(piece.span);
    idx++;
  }
  const value = parsePlainScalar(parts.join(" "));
  return { node: { value, spans: value === null ? [] : spans }, nextIndex: idx };
}

function sequenceItemWithOffset(line: SpanLine): { itemRest: string; itemOffset: number } | null {
  if (line.trimmed === "-") return { itemRest: "", itemOffset: line.trimmedOffset + 1 };
  if (line.trimmed.startsWith("- ") || line.trimmed.startsWith("-\t")) {
    let idx = 1;
    while (idx < line.trimmed.length && (line.trimmed[idx] === " " || line.trimmed[idx] === "\t")) idx++;
    return { itemRest: line.trimmed.slice(idx), itemOffset: line.trimmedOffset + idx };
  }
  return null;
}

function parseSpanBlockSequence(lines: SpanLine[], startIndex: number, seqIndent: number): { node: SpanNode; nextIndex: number } | null {
  const items: SpanNode[] = [];
  let idx = startIndex;
  while (idx < lines.length) {
    if (lines[idx].trimmed === "" || lines[idx].trimmed.startsWith("#")) { idx++; continue; }
    if (lines[idx].indent < seqIndent) break;
    if (lines[idx].indent > seqIndent) return null;
    const seq = sequenceItemWithOffset(lines[idx]);
    if (!seq) break;
    const { itemRest, itemOffset } = seq;
    if (itemRest === "" || itemRest.startsWith("#")) {
      const nextIdx = nextMeaningfulSpanLine(lines, idx + 1);
      if (nextIdx < lines.length && lines[nextIdx].indent > seqIndent) {
        if (isSequenceItem(lines[nextIdx].trimmed)) {
          const sub = parseSpanBlockSequence(lines, nextIdx, lines[nextIdx].indent);
          if (!sub) return null;
          items.push(sub.node);
          idx = sub.nextIndex;
          continue;
        }
        if (splitKeyValue(lines[nextIdx].trimmed)) {
          const sub = parseSpanBlockMapping(lines, nextIdx, lines[nextIdx].indent);
          if (!sub) return null;
          items.push(sub.node);
          idx = sub.nextIndex;
          continue;
        }
      }
      items.push({ value: null, spans: [] });
      idx = nextIdx;
      continue;
    }
    const inlineKv = splitKeyValueWithIndex(itemRest);
    if (inlineKv) {
      const entryIndent = seqIndent + 2;
      const firstVal = parseSpanValueAfterKey(lines, idx, inlineKv.rest, itemOffset + inlineKv.restIndex, seqIndent + 1);
      if (!firstVal) return null;
      const entries: Record<string, SpanNode> = { [inlineKv.key]: firstVal.node };
      const obj: Record<string, YamlValue> = { [inlineKv.key]: firstVal.node.value };
      let nextIdx = firstVal.nextIndex;
      const peek = nextMeaningfulSpanLine(lines, nextIdx);
      if (peek < lines.length && lines[peek].indent >= entryIndent && !isSequenceItem(lines[peek].trimmed)) {
        const restMap = parseSpanBlockMapping(lines, peek, lines[peek].indent);
        if (!restMap) return null;
        Object.assign(entries, restMap.node.entries);
        Object.assign(obj, restMap.node.value as Record<string, YamlValue>);
        nextIdx = restMap.nextIndex;
      }
      items.push({ value: obj, spans: [], entries });
      idx = nextIdx;
      continue;
    }
    if (itemRest.startsWith("|") || itemRest.startsWith(">")) {
      const block = parseBlockScalarWithSpans(lines, idx, itemRest, seqIndent);
      if (!block) return null;
      items.push(block.node);
      idx = block.nextIndex;
      continue;
    }
    if (itemRest.startsWith('"') || itemRest.startsWith("'")) {
      const quoted = collectQuotedWithMap(lines, idx, itemRest, itemOffset, seqIndent + 1);
      if (!quoted) return null;
      items.push(quoted.node);
      idx = quoted.nextIndex;
      continue;
    }
    if (itemRest.startsWith("[") || itemRest.startsWith("{")) {
      const collected = collectFlowWithMap(lines, idx, itemRest, itemOffset, seqIndent + 1);
      if (!collected) return null;
      const node = parseFlowSpanNode(collected.combined, collected.map);
      if (!node) return null;
      items.push(node);
      idx = collected.nextIndex;
      continue;
    }
    const piece = plainLineSpan(itemRest, itemOffset);
    const scalar = parsePlainScalar(itemRest);
    items.push({ value: scalar, spans: scalar !== null && piece.span ? [piece.span] : [] });
    idx++;
  }
  return { node: { value: items.map(i => i.value), spans: [], items }, nextIndex: idx };
}

function parseSpanBlockMapping(lines: SpanLine[], startIndex: number, mapIndent: number): { node: SpanNode; nextIndex: number } | null {
  const entries: Record<string, SpanNode> = {};
  const result: Record<string, YamlValue> = {};
  let idx = startIndex;
  while (idx < lines.length) {
    if (lines[idx].trimmed === "" || lines[idx].trimmed.startsWith("#")) { idx++; continue; }
    if (lines[idx].indent < mapIndent) break;
    if (lines[idx].indent > mapIndent) return null;
    const kv = splitKeyValueWithIndex(lines[idx].trimmed);
    if (!kv) return null;
    const parsed = parseSpanValueAfterKey(lines, idx, kv.rest, lines[idx].trimmedOffset + kv.restIndex, mapIndent);
    if (!parsed) return null;
    entries[kv.key] = parsed.node;
    result[kv.key] = parsed.node.value;
    idx = parsed.nextIndex;
  }
  return { node: { value: result, spans: [], entries }, nextIndex: idx };
}

function lookupSpanNodeCaseInsensitive(entries: Record<string, SpanNode>, target: string): SpanNode | undefined {
  if (Object.prototype.hasOwnProperty.call(entries, target)) return entries[target];
  const lower = target.toLowerCase();
  for (const [key, node] of Object.entries(entries)) {
    if (key.toLowerCase() === lower) return node;
  }
  return undefined;
}

function extractAuthorNodeSpans(node: SpanNode): { name: string; spans: Array<{ start: number; end: number }> } | null {
  const direct = scalarToString(node.value);
  if (direct) return { name: direct, spans: node.spans };
  if (node.entries) {
    const nameNode = node.entries.name ?? node.entries.literal;
    if (nameNode) {
      const directName = scalarToString(nameNode.value);
      if (directName) return { name: directName, spans: nameNode.spans };
      if (nameNode.entries) {
        if (nameNode.entries.literal && scalarToString(nameNode.entries.literal.value)) {
          return { name: scalarToString(nameNode.entries.literal.value)!, spans: nameNode.entries.literal.spans };
        }
        const givenNode = nameNode.entries.given;
        const familyNode = nameNode.entries.family;
        const given = scalarToString(givenNode?.value);
        const family = scalarToString(familyNode?.value);
        const parts = [given, family].filter(Boolean);
        if (parts.length) {
          return {
            name: parts.join(" "),
            spans: [...(given && givenNode ? givenNode.spans : []), ...(family && familyNode ? familyNode.spans : [])],
          };
        }
      }
    }
    const givenNode = node.entries.given;
    const familyNode = node.entries.family;
    const given = scalarToString(givenNode?.value);
    const family = scalarToString(familyNode?.value);
    const parts = [given, family].filter(Boolean);
    if (parts.length) {
      return {
        name: parts.join(" "),
        spans: [...(given && givenNode ? givenNode.spans : []), ...(family && familyNode ? familyNode.spans : [])],
      };
    }
  }
  return null;
}

/**
 * Return canonical UTF-16 source spans for frontmatter values rendered in
 * DocumentProperties (`title`, `author`, and `tags`) in exact display order.
 * Excludes YAML keys, comments, quotes, and unrendered fields (`subtitle`,
 * `date`, `description`, `aliases`, etc.).
 */
export function frontmatterVisibleValueSpans(markdown: string): FrontmatterVisibleSpan[] {
  const fm = parseFrontmatter(markdown);
  if (!fm || !fm.properties) return [];
  const { title, authors, tags } = fm.properties;
  if (!title && !authors.length && !tags.length) return [];

  let cursor = markdown.startsWith("\uFEFF") ? 1 : 0;
  cursor += 3;
  while (cursor < markdown.length && (markdown[cursor] === " " || markdown[cursor] === "\t")) cursor++;
  if (markdown[cursor] === "\r" && markdown[cursor + 1] === "\n") cursor += 2;
  else if (markdown[cursor] === "\n") cursor += 1;
  const yamlStart = cursor;

  let lineStart = cursor;
  let yamlEnd = -1;
  while (lineStart <= markdown.length) {
    const lineEnd = markdown.indexOf("\n", lineStart);
    const contentEnd = lineEnd < 0 ? markdown.length : (lineEnd > lineStart && markdown[lineEnd - 1] === "\r" ? lineEnd - 1 : lineEnd);
    if (/^(?:---|\.\.\.)[ \t]*$/.test(markdown.slice(lineStart, contentEnd))) {
      yamlEnd = lineStart;
      break;
    }
    if (lineEnd < 0) break;
    lineStart = lineEnd + 1;
  }
  if (yamlEnd <= yamlStart) return [];

  let sliceEnd = yamlEnd;
  if (sliceEnd > yamlStart && markdown[sliceEnd - 1] === "\n") {
    sliceEnd--;
    if (sliceEnd > yamlStart && markdown[sliceEnd - 1] === "\r") sliceEnd--;
  }

  const lines: SpanLine[] = [];
  let pos = yamlStart;
  while (pos <= sliceEnd) {
    const nl = markdown.indexOf("\n", pos);
    const rawEnd = nl < 0 || nl > sliceEnd ? sliceEnd : (nl > pos && markdown[nl - 1] === "\r" ? nl - 1 : nl);
    const raw = markdown.slice(pos, rawEnd);
    let indent = 0;
    while (indent < raw.length && raw[indent] === " ") indent++;
    let leadWs = indent;
    while (leadWs < raw.length && (raw[leadWs] === " " || raw[leadWs] === "\t")) leadWs++;
    const trimmed = raw.trim();
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

  const first = nextMeaningfulSpanLine(lines, 0);
  if (first >= lines.length || lines[first].indent !== 0) return [];
  const rootParsed = parseSpanBlockMapping(lines, first, 0);
  if (!rootParsed || !rootParsed.node.entries) return [];
  const entries = rootParsed.node.entries;

  const result: FrontmatterVisibleSpan[] = [];

  if (title) {
    const titleNode = lookupSpanNodeCaseInsensitive(entries, "title");
    if (titleNode) {
      for (const s of titleNode.spans) {
        if (s.end > s.start) result.push({ start: s.start, end: s.end, field: "title", fieldOrdinal: 0 });
      }
    }
  }

  if (authors.length > 0) {
    const seenAuthors = new Set<string>();
    for (const key of ["author", "authors", "creator"]) {
      const node = lookupSpanNodeCaseInsensitive(entries, key);
      if (!node) continue;
      const candidates = node.items ?? [node];
      for (const item of candidates) {
        const extracted = extractAuthorNodeSpans(item);
        if (!extracted || seenAuthors.has(extracted.name)) continue;
        seenAuthors.add(extracted.name);
        for (const s of extracted.spans) {
          if (s.end > s.start) result.push({ start: s.start, end: s.end, field: "author", fieldOrdinal: 0 });
        }
      }
    }
  }

  if (tags.length > 0) {
    const seenTags = new Set<string>();
    let tagOrdinal = 0;
    const addTagSpans = (rawTag: string, spans: Array<{ start: number; end: number }>) => {
      const trimmed = rawTag.trim();
      if (!trimmed || seenTags.has(trimmed)) return;
      seenTags.add(trimmed);
      const ord = tagOrdinal++;
      for (const s of spans) {
        if (s.end > s.start) result.push({ start: s.start, end: s.end, field: "tag", fieldOrdinal: ord });
      }
    };
    for (const key of ["tags", "tag", "keywords"]) {
      const node = lookupSpanNodeCaseInsensitive(entries, key);
      if (!node) continue;
      if (node.items) {
        for (const item of node.items) {
          const str = scalarToString(item.value);
          if (str) addTagSpans(str, item.spans);
        }
      } else {
        const str = scalarToString(node.value);
        if (!str) continue;
        if (str.includes(",") && node.spans.length === 1) {
          const base = node.spans[0];
          const rawSlice = markdown.slice(base.start, base.end);
          if (rawSlice.includes(",")) {
            let cursorIdx = 0;
            for (const part of rawSlice.split(",")) {
              const lead = part.length - part.trimStart().length;
              const cleaned = part.trim();
              if (cleaned) {
                addTagSpans(cleaned, [{ start: base.start + cursorIdx + lead, end: base.start + cursorIdx + lead + cleaned.length }]);
              }
              cursorIdx += part.length + 1;
            }
            continue;
          }
        }
        if (str.includes(",")) {
          for (const part of str.split(",")) addTagSpans(part, node.spans);
        } else {
          addTagSpans(str, node.spans);
        }
      }
    }
  }

  return result;
}
