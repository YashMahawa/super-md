import { visit } from "unist-util-visit";

export type SupportedBracedFenceLanguage = "python" | "py" | "mermaid";

const BRACED_FENCE_HEAD = /^\.?([A-Za-z][A-Za-z0-9_-]*)(?:$|[\s,#])/;

export function parseBracedFenceInfoLanguage(rawInfo: string): SupportedBracedFenceLanguage | null {
  const trimmed = rawInfo.trim();
  if (trimmed.length < 4 || !trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  const inner = trimmed.slice(1, -1).trim();
  const match = BRACED_FENCE_HEAD.exec(inner);
  if (!match) return null;
  const lower = match[1].toLowerCase();
  if (lower === "python" || lower === "py" || lower === "mermaid") return lower;
  return null;
}

export function parseBracedFenceLanguage(
  lang: string | null | undefined,
  meta?: string | null,
): SupportedBracedFenceLanguage | null {
  const info = lang ? (meta ? `${lang} ${meta}` : lang) : meta || "";
  return parseBracedFenceInfoLanguage(info);
}

export function normalizeFenceInfoLanguage(rawInfo: string): string {
  const braced = parseBracedFenceInfoLanguage(rawInfo);
  if (braced) return braced;
  return rawInfo.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "";
}

export function remarkBracedFences() {
  return (tree: any) => {
    visit(tree, "code", (node: any) => {
      const normalized = parseBracedFenceLanguage(node.lang, node.meta);
      if (normalized) {
        node.lang = normalized;
        delete node.meta;
      }
    });
    return tree;
  };
}
