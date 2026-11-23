import {headingSlug} from './headingSlug';

export const NOTE_EXTENSIONS = ['.md', '.smd', '.fmd', '.markdown', '.txt'] as const;

const ASSET_OR_NOTE_EXT = /\.(?:md|smd|fmd|markdown|txt|png|jpe?g|svg|gif|webp|avif|pdf|mmd|mermaid)(?:[?#]|$)/i;

export function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function hasSupportedNoteExtension(target: string): boolean {
  const clean = target.split(/[?#]/, 1)[0].trim().toLowerCase();
  return NOTE_EXTENSIONS.some(ext => clean.endsWith(ext));
}

export function encodeMarkdownDestination(value: string): string {
  return value.replace(/[ \t<>()]/g, ch => {
    switch (ch) {
      case ' ': return '%20';
      case '\t': return '%09';
      case '<': return '%3C';
      case '>': return '%3E';
      case '(': return '%28';
      case ')': return '%29';
      default: return ch;
    }
  });
}

function escapeLinkLabel(label: string): string {
  return label.replace(/([\[\]])/g, '\\$1');
}

export interface ParsedWikilink {
  sameNote: boolean;
  target: string;
  fragment: string;
  label: string;
}

export function parseWikilinkParts(rawInner: string): ParsedWikilink | null {
  if (!rawInner || /[\r\n]/.test(rawInner)) return null;
  const pipeIndex = rawInner.indexOf('|');
  const rawLeft = pipeIndex >= 0 ? rawInner.slice(0, pipeIndex) : rawInner;
  const rawAlias = pipeIndex >= 0 ? rawInner.slice(pipeIndex + 1) : undefined;
  // Support GFM table-escaped pipes: [[Target\|Alias]]
  const cleanedLeft = rawAlias !== undefined && rawLeft.endsWith('\\') ? rawLeft.slice(0, -1) : rawLeft;
  const trimmedLeft = cleanedLeft.trim();
  if (!trimmedLeft) return null;

  if (trimmedLeft.startsWith('#')) {
    const fragment = trimmedLeft.slice(1).trim();
    if (!fragment) return null;
    const label = rawAlias !== undefined && rawAlias.trim() ? rawAlias.trim() : fragment;
    return {sameNote: true, target: '', fragment, label};
  }

  const hashIndex = trimmedLeft.indexOf('#');
  const target = (hashIndex >= 0 ? trimmedLeft.slice(0, hashIndex) : trimmedLeft).trim();
  const fragment = hashIndex >= 0 ? trimmedLeft.slice(hashIndex + 1).trim() : '';
  if (!target) return null;
  const label = rawAlias !== undefined && rawAlias.trim() ? rawAlias.trim() : trimmedLeft;
  return {sameNote: false, target, fragment, label};
}

export function formatWikilinkMarkdown(rawInner: string, encodeDestinations = false): string | null {
  const parsed = parseWikilinkParts(rawInner);
  if (!parsed) return null;
  if (parsed.sameNote) {
    return `[${escapeLinkLabel(parsed.label)}](#${headingSlug(parsed.fragment)})`;
  }
  const destPath = hasSupportedNoteExtension(parsed.target) ? parsed.target : `${parsed.target}.md`;
  const formattedPath = encodeDestinations ? encodeMarkdownDestination(destPath) : destPath;
  const formattedFragment = parsed.fragment
    ? `#${encodeDestinations ? encodeMarkdownDestination(parsed.fragment) : parsed.fragment}`
    : '';
  return `[${escapeLinkLabel(parsed.label)}](${formattedPath}${formattedFragment})`;
}

export function parseOriginalWikilinkSlice(rawSlice: string): ParsedWikilink | null {
  if (!rawSlice.startsWith('[[') || !rawSlice.endsWith(']]') || rawSlice.length < 5) return null;
  return parseWikilinkParts(rawSlice.slice(2, -2));
}

export function isLikelyInlineLinkDestination(dest: string): boolean {
  const trimmed = dest.trim();
  if (!trimmed || !/[ \t]/.test(trimmed)) return false;
  if (/^(?:#|\.\.?\/|\/|https?:\/\/|mailto:)/i.test(trimmed)) return true;
  return ASSET_OR_NOTE_EXT.test(trimmed);
}

export type ClassifiedRenderedLink =
  | {kind: 'none'}
  | {kind: 'same-note'; fragment: string}
  | {kind: 'external'; url: string}
  | {kind: 'blocked'; url: string}
  | {kind: 'workspace'; target: string; fragment: string; wikilink: boolean};

export function classifyRenderedLink(href: string | undefined, wikilinkTarget?: string, wikilinkFragment?: string): ClassifiedRenderedLink {
  if (wikilinkTarget) {
    const hashIdx = href ? href.indexOf('#') : -1;
    const fragment = wikilinkFragment !== undefined
      ? wikilinkFragment
      : hashIdx >= 0 ? safeDecodeURIComponent(href!.slice(hashIdx + 1)) : '';
    return {kind: 'workspace', target: wikilinkTarget, fragment, wikilink: true};
  }
  if (!href) return {kind: 'none'};
  if (href.startsWith('#')) {
    return {kind: 'same-note', fragment: safeDecodeURIComponent(href.slice(1))};
  }
  if (/^(?:https?:|mailto:)/i.test(href)) {
    return {kind: 'external', url: href};
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith('//')) {
    return {kind: 'blocked', url: href};
  }
  const hashIdx = href.indexOf('#');
  const rawPath = (hashIdx >= 0 ? href.slice(0, hashIdx) : href).split('?', 1)[0];
  const rawFragment = hashIdx >= 0 ? href.slice(hashIdx + 1) : '';
  const target = safeDecodeURIComponent(rawPath);
  const fragment = safeDecodeURIComponent(rawFragment);
  if (!target) {
    return fragment ? {kind: 'same-note', fragment} : {kind: 'none'};
  }
  return {kind: 'workspace', target, fragment, wikilink: false};
}

export function shouldKeepLinkInPdf(url: string | undefined): boolean {
  if (!url) return false;
  const trimmed = url.trim();
  if (trimmed.startsWith('#') && trimmed.length > 1) return true;
  return /^(?:https?:|mailto:)/i.test(trimmed);
}

function isEscapedOrImageAt(lineText: string, bracketIndex: number): boolean {
  if (bracketIndex > 0 && lineText[bracketIndex - 1] === '!') return true;
  let slashes = 0;
  for (let i = bracketIndex - 1; i >= 0 && lineText[i] === '\\'; i--) slashes++;
  return (slashes & 1) === 1;
}

export function findSourceLinkAtOffset(lineText: string, columnOffset: number): ClassifiedRenderedLink | null {
  if (!lineText || columnOffset < 0 || columnOffset > lineText.length) return null;
  const wikiRegex = /\[\[([^\[\r\n\]]+?)\]\]/g;
  for (let match = wikiRegex.exec(lineText); match; match = wikiRegex.exec(lineText)) {
    const start = match.index;
    const end = start + match[0].length;
    if (isEscapedOrImageAt(lineText, start)) continue;
    if (columnOffset >= start && columnOffset <= end) {
      const parsed = parseWikilinkParts(match[1]);
      if (!parsed) return null;
      if (parsed.sameNote) return {kind: 'same-note', fragment: parsed.fragment};
      return {kind: 'workspace', target: parsed.target, fragment: parsed.fragment, wikilink: true};
    }
  }
  const mdLinkRegex = /\[((?:\\.|\[[^\r\n\[\]]*\]|[^\[\]\r\n])*)\]\((?:<([^<>\r\n]*)>|([^<>\r\n()]+?))(?:\s+(?:"[^"\r\n]*"|'[^'\r\n]*'))?\)/g;
  for (let match = mdLinkRegex.exec(lineText); match; match = mdLinkRegex.exec(lineText)) {
    const start = match.index;
    const end = start + match[0].length;
    if (isEscapedOrImageAt(lineText, start)) continue;
    if (columnOffset >= start && columnOffset <= end) {
      const rawDest = (match[2] ?? match[3] ?? '').trim();
      if (!rawDest) return null;
      return classifyRenderedLink(encodeMarkdownDestination(rawDest));
    }
  }
  return null;
}

