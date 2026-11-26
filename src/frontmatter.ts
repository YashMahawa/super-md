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
    const name = lookupCaseInsensitive(value, "name") ?? lookupCaseInsensitive(value, "literal");
    const directName = scalarToString(name);
    if (directName) return directName;
    if (name && typeof name === "object" && !Array.isArray(name)) {
      const literal = scalarToString(lookupCaseInsensitive(name, "literal"));
      if (literal) return literal;
      const parts = [scalarToString(lookupCaseInsensitive(name, "given")), scalarToString(lookupCaseInsensitive(name, "family"))].filter(Boolean);
      if (parts.length) return parts.join(" ");
    }
    const parts = [scalarToString(lookupCaseInsensitive(value, "given")), scalarToString(lookupCaseInsensitive(value, "family"))].filter(Boolean);
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
