import { visit } from "unist-util-visit";

export interface EquationTagInfo {
  raw: string;
  plain: string;
  displayText: string;
  refText: string;
  eqrefText: string;
  starred: boolean;
}

export interface EquationTarget {
  label: string;
  anchorId: string;
  tag: EquationTagInfo | null;
}

interface ParsedCommand {
  kind: "tag" | "label" | "eqref" | "ref";
  starred: boolean;
  arg: string;
  start: number;
  end: number;
  raw: string;
}

const SKIP_PHRASING_CONTAINERS = new Set([
  "code",
  "inlineCode",
  "math",
  "inlineMath",
  "html",
  "definition",
  "yaml",
]);

const UNWRAP_TAG_MACROS = new Set([
  "text",
  "textrm",
  "mathrm",
  "textbf",
  "mathbf",
  "textit",
  "mathit",
  "mathsf",
  "mathtt",
  "operatorname",
]);

const TAG_SYMBOL_MACROS: Record<string, string> = {
  dagger: "†",
  ddagger: "‡",
  star: "⋆",
  ast: "*",
  S: "§",
  P: "¶",
};

export function equationAnchorId(label: string): string {
  const trimmed = label.trim();
  let encoded = "";
  for (const ch of trimmed) {
    if (/^[A-Za-z0-9-]$/.test(ch)) {
      encoded += ch;
    } else {
      encoded += `_${ch.codePointAt(0)!.toString(16)}_`;
    }
  }
  return `smd-eq-${encoded || "empty"}`;
}

export function trustEquationHref(context: { command?: string; url?: string }): boolean {
  return (
    context.command === "\\href" &&
    typeof context.url === "string" &&
    /^#smd-eq-[A-Za-z0-9_-]+$/.test(context.url)
  );
}

function isAsciiAlpha(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function readBalancedBraces(source: string, openBraceIndex: number): { content: string; end: number } | null {
  if (source[openBraceIndex] !== "{") return null;
  let depth = 1;
  let i = openBraceIndex + 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return { content: source.slice(openBraceIndex + 1, i), end: i + 1 };
      }
    }
    i++;
  }
  return null;
}

function hasOuterParens(value: string): boolean {
  if (!value.startsWith("(") || !value.endsWith(")")) return false;
  let depth = 0;
  for (let i = 0; i < value.length; i++) {
    if (value[i] === "(") depth++;
    else if (value[i] === ")") {
      depth--;
      if (depth === 0 && i < value.length - 1) return false;
    }
  }
  return depth === 0;
}

export function normalizeTagPlainText(raw: string): string {
  let out = "";
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === "~") {
      out += " ";
      i++;
      continue;
    }
    if (ch === "\\") {
      if (i + 1 >= raw.length) {
        i++;
        continue;
      }
      const next = raw[i + 1];
      if ("{},; !:".includes(next)) {
        if (next === "{" || next === "}") out += next;
        else if (next !== "!") out += " ";
        i += 2;
        continue;
      }
      if ("#$%&~_^".includes(next)) {
        out += next;
        i += 2;
        continue;
      }
      if (isAsciiAlpha(next.charCodeAt(0))) {
        let end = i + 2;
        while (end < raw.length && isAsciiAlpha(raw.charCodeAt(end))) end++;
        const name = raw.slice(i + 1, end);
        let ws = end;
        while (ws < raw.length && (raw[ws] === " " || raw[ws] === "\t")) ws++;
        if (UNWRAP_TAG_MACROS.has(name) && raw[ws] === "{") {
          const group = readBalancedBraces(raw, ws);
          if (group) {
            out += normalizeTagPlainText(group.content);
            i = group.end;
            continue;
          }
        }
        if (name in TAG_SYMBOL_MACROS) {
          out += TAG_SYMBOL_MACROS[name];
          i = end;
          continue;
        }
        out += raw.slice(i, end);
        i = end;
        continue;
      }
      out += next;
      i += 2;
      continue;
    }
    if (ch === "{") {
      const group = readBalancedBraces(raw, i);
      if (group) {
        out += normalizeTagPlainText(group.content);
        i = group.end;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out.replace(/\s+/g, " ").trim();
}

export function formatEquationTag(raw: string, starred: boolean): EquationTagInfo | null {
  const plain = normalizeTagPlainText(raw);
  if (!plain) return null;
  if (starred) {
    return {
      raw,
      plain,
      displayText: plain,
      refText: plain,
      eqrefText: hasOuterParens(plain) ? plain : `(${plain})`,
      starred: true,
    };
  }
  return {
    raw,
    plain,
    displayText: `(${plain})`,
    refText: plain,
    eqrefText: `(${plain})`,
    starred: false,
  };
}

function scanLatexCommands(
  source: string,
  allowed: ReadonlySet<ParsedCommand["kind"]>,
  isMath: boolean,
): ParsedCommand[] {
  const commands: ParsedCommand[] = [];
  let i = 0;
  while (i < source.length) {
    if (isMath && source[i] === "%") {
      let slashes = 0;
      for (let j = i - 1; j >= 0 && source[j] === "\\"; j--) slashes++;
      if (slashes % 2 === 0) {
        const nl = source.indexOf("\n", i);
        if (nl < 0) break;
        i = nl + 1;
        continue;
      }
    }
    if (source[i] !== "\\") {
      i++;
      continue;
    }
    let slashEnd = i;
    while (slashEnd < source.length && source[slashEnd] === "\\") slashEnd++;
    const slashCount = slashEnd - i;
    if (slashCount % 2 === 0) {
      i = slashEnd;
      continue;
    }
    const cmdBackslash = slashEnd - 1;
    const nameStart = slashEnd;
    if (nameStart >= source.length || !isAsciiAlpha(source.charCodeAt(nameStart))) {
      i = slashEnd + 1;
      continue;
    }
    let nameEnd = nameStart + 1;
    while (nameEnd < source.length && isAsciiAlpha(source.charCodeAt(nameEnd))) nameEnd++;
    const name = source.slice(nameStart, nameEnd);
    if (
      (name === "tag" || name === "label" || name === "eqref" || name === "ref") &&
      allowed.has(name)
    ) {
      let cursor = nameEnd;
      let starred = false;
      if (name === "tag" && source[cursor] === "*") {
        starred = true;
        cursor++;
      }
      while (cursor < source.length && (source[cursor] === " " || source[cursor] === "\t")) {
        cursor++;
      }
      if (source[cursor] === "{") {
        const group = readBalancedBraces(source, cursor);
        if (group) {
          const arg = group.content.trim();
          if (arg.length > 0 && !/[\r\n]/.test(arg)) {
            commands.push({
              kind: name,
              starred,
              arg,
              start: cmdBackslash,
              end: group.end,
              raw: source.slice(cmdBackslash, group.end),
            });
            i = group.end;
            continue;
          }
        }
      }
    }
    i = nameEnd;
  }
  return commands;
}

function normalizeKatexTagArg(raw: string): string {
  return raw.replace(/\\(dagger|ddagger|star|ast)(?![A-Za-z])/g, (_, name: string) => TAG_SYMBOL_MACROS[name] || _);
}

export function extractDisplayEquationMetadata(tex: string): {
  tag: EquationTagInfo | null;
  labels: string[];
  katexTex: string;
} {
  const commands = scanLatexCommands(tex, new Set(["tag", "label"]), true);
  if (!commands.length) {
    return { tag: null, labels: [], katexTex: tex };
  }
  let tag: EquationTagInfo | null = null;
  const labels: string[] = [];
  const edits: Array<{ start: number; end: number; replacement: string }> = [];
  for (const cmd of commands) {
    if (cmd.kind === "tag") {
      const parsed = formatEquationTag(cmd.arg, cmd.starred);
      if (parsed) tag = parsed;
      const normalizedArg = normalizeKatexTagArg(cmd.arg);
      if (normalizedArg !== cmd.arg) {
        edits.push({
          start: cmd.start,
          end: cmd.end,
          replacement: `\\tag${cmd.starred ? "*" : ""}{${normalizedArg}}`,
        });
      }
    } else if (cmd.kind === "label") {
      labels.push(cmd.arg);
      edits.push({ start: cmd.start, end: cmd.end, replacement: "" });
    }
  }
  if (!edits.length) {
    return { tag, labels, katexTex: tex };
  }
  let katexTex = "";
  let last = 0;
  for (const edit of edits) {
    katexTex += tex.slice(last, edit.start) + edit.replacement;
    last = edit.end;
  }
  katexTex += tex.slice(last);
  return { tag, labels, katexTex };
}

function escapeLatexText(value: string): string {
  let out = "";
  for (const ch of value) {
    switch (ch) {
      case "\\":
        out += "\\textbackslash{}";
        break;
      case "{":
      case "}":
      case "$":
      case "&":
      case "#":
      case "_":
      case "%":
        out += `\\${ch}`;
        break;
      case "~":
        out += "\\textasciitilde{}";
        break;
      case "^":
        out += "\\textasciicircum{}";
        break;
      default:
        out += ch;
        break;
    }
  }
  return out;
}

export function resolveMathReferencesForKatex(
  tex: string,
  equations: ReadonlyMap<string, EquationTarget>,
): { tex: string; changed: boolean } {
  const commands = scanLatexCommands(tex, new Set(["eqref", "ref"]), true);
  if (!commands.length) return { tex, changed: false };
  let out = "";
  let last = 0;
  for (const cmd of commands) {
    out += tex.slice(last, cmd.start);
    const target = equations.get(cmd.arg);
    if (target?.tag) {
      const rendered = cmd.kind === "eqref" ? target.tag.eqrefText : target.tag.refText;
      out += `\\href{#${target.anchorId}}{\\text{${escapeLatexText(rendered)}}}`;
    } else {
      out += cmd.kind === "eqref" ? "\\text{(??)}" : "\\text{??}";
    }
    last = cmd.end;
  }
  out += tex.slice(last);
  return { tex: out, changed: true };
}

function isAutolink(node: any): boolean {
  if (node?.type !== "link" || node.children?.length !== 1 || node.children[0]?.type !== "text") {
    return false;
  }
  const text = node.children[0].value;
  return node.url === text || node.url === `mailto:${text}` || node.url === `http://${text}`;
}

function isMathCodeBlock(node: any): boolean {
  return node?.type === "code" && String(node.lang || "").trim().toLowerCase() === "math";
}

export function remarkEquationReferences() {
  return (tree: unknown) => {
    const equations = new Map<string, EquationTarget>();
    const nodeLabels = new WeakMap<object, { originalTex: string; katexTex: string; anchorIds: string[] }>();

    visit(tree as never, (node: any) => {
      if (node.type !== "math" && !isMathCodeBlock(node)) return;
      const originalTex = String(node.value || "");
      const meta = extractDisplayEquationMetadata(originalTex);
      const anchorIds: string[] = [];
      for (const label of meta.labels) {
        if (!equations.has(label)) {
          const id = equationAnchorId(label);
          equations.set(label, { label, anchorId: id, tag: meta.tag });
          if (!anchorIds.includes(id)) anchorIds.push(id);
        }
      }
      if (anchorIds.length > 0 || meta.katexTex !== originalTex) {
        nodeLabels.set(node, { originalTex, katexTex: meta.katexTex, anchorIds });
      }
    });

    const refCommands = new Set<ParsedCommand["kind"]>(["eqref", "ref"]);

    visit(tree as never, (node: any) => {
      if (node.type === "math" || isMathCodeBlock(node)) {
        const stored = nodeLabels.get(node);
        const originalTex = stored ? stored.originalTex : String(node.value || "");
        const baseTex = stored ? stored.katexTex : originalTex;
        const resolved = resolveMathReferencesForKatex(baseTex, equations);
        const finalTex = resolved.tex;
        const anchorIds = stored?.anchorIds ?? [];
        if (!anchorIds.length && finalTex === originalTex) return;

        node.value = finalTex;
        const codeElement = {
          type: "element",
          tagName: "code",
          properties: { className: ["language-math", "math-display"] },
          children: [{ type: "text", value: finalTex }],
        };
        const preElement = {
          type: "element",
          tagName: "pre",
          properties: {},
          children: [codeElement],
        };
        const extraAnchors = anchorIds.slice(1).map((id) => ({
          type: "element",
          tagName: "span",
          properties: { id, className: ["math-equation-extra-anchor"] },
          children: [],
        }));
        node.data = {
          ...node.data,
          hName: "div",
          hProperties: {
            ...node.data?.hProperties,
            ...(anchorIds[0] ? { id: anchorIds[0] } : {}),
            className: ["math-equation-anchor"],
            "data-math-source": originalTex,
          },
          hChildren: [...extraAnchors, preElement],
        };
        return;
      }

      if (node.type === "inlineMath") {
        const originalTex = String(node.value || "");
        const resolved = resolveMathReferencesForKatex(originalTex, equations);
        if (!resolved.changed) return;
        node.value = resolved.tex;
        node.data = {
          ...node.data,
          hName: "span",
          hProperties: {
            ...node.data?.hProperties,
            className: ["math-inline-source"],
            "data-math-inline-source": originalTex,
          },
          hChildren: [
            {
              type: "element",
              tagName: "code",
              properties: { className: ["language-math", "math-inline"] },
              children: [{ type: "text", value: resolved.tex }],
            },
          ],
        };
        return;
      }

      if (node.type === "link" && typeof node.url === "string" && node.url.startsWith("#") && !node.url.startsWith("#smd-eq-")) {
        let decoded = node.url.slice(1);
        try {
          decoded = decodeURIComponent(decoded);
        } catch {
          // Keep raw fragment when malformed percent encoding is present.
        }
        const target = equations.get(decoded);
        if (target) {
          const originalHref = node.url;
          node.url = `#${target.anchorId}`;
          node.data = {
            ...node.data,
            hProperties: {
              ...node.data?.hProperties,
              "data-source-href": originalHref,
            },
          };
        }
      }
    });

    const rewritePhrasing = (parent: any, insideLink: boolean): void => {
      if (!parent || SKIP_PHRASING_CONTAINERS.has(parent.type) || isAutolink(parent)) return;
      if (!Array.isArray(parent.children)) return;
      const nextInsideLink = insideLink || parent.type === "link" || parent.type === "linkReference";
      let modified = false;
      const nextChildren: any[] = [];
      for (const child of parent.children) {
        if (child?.type === "text" && typeof child.value === "string" && child.value.includes("\\")) {
          const matches = scanLatexCommands(child.value, refCommands, false);
          if (matches.length > 0) {
            modified = true;
            let cursor = 0;
            for (const match of matches) {
              if (match.start > cursor) {
                nextChildren.push({ type: "text", value: child.value.slice(cursor, match.start) });
              }
              const target = equations.get(match.arg);
              if (target?.tag) {
                const labelText = match.kind === "eqref" ? target.tag.eqrefText : target.tag.refText;
                if (nextInsideLink) {
                  nextChildren.push({
                    type: "equationRef",
                    data: {
                      hName: "span",
                      hProperties: {
                        className: ["equation-ref"],
                        "data-source-tex": match.raw,
                      },
                    },
                    children: [{ type: "text", value: labelText }],
                  });
                } else {
                  nextChildren.push({
                    type: "link",
                    url: `#${target.anchorId}`,
                    data: {
                      hProperties: {
                        className: ["equation-ref"],
                        "data-source-tex": match.raw,
                      },
                    },
                    children: [{ type: "text", value: labelText }],
                  });
                }
              } else {
                const fallback = match.kind === "eqref" ? "(??)" : "??";
                nextChildren.push({
                  type: "equationRef",
                  data: {
                    hName: "span",
                    hProperties: {
                      className: ["equation-ref", "is-unresolved"],
                      "data-source-tex": match.raw,
                    },
                  },
                  children: [{ type: "text", value: fallback }],
                });
              }
              cursor = match.end;
            }
            if (cursor < child.value.length) {
              nextChildren.push({ type: "text", value: child.value.slice(cursor) });
            }
            continue;
          }
        }
        rewritePhrasing(child, nextInsideLink);
        nextChildren.push(child);
      }
      if (modified) {
        parent.children = nextChildren;
      }
    };

    rewritePhrasing(tree, false);
  };
}
