const SKIP_TYPES = new Set(['code', 'inlineCode', 'math', 'inlineMath', 'html', 'definition', 'yaml']);
const CONTAINER_TYPES = new Set(['paragraph', 'heading', 'tableCell', 'emphasis', 'strong', 'delete', 'link', 'linkReference', 'highlight', 'subscript', 'superscript']);
const ASCII_PUNCT = /^[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]$/;
const SPAN_META: Record<DelimKind, { type: string; hName: string }> = {
  '==': { type: 'highlight', hName: 'mark' },
  '~': { type: 'subscript', hName: 'sub' },
  '^': { type: 'superscript', hName: 'sup' },
};

type DelimKind = '==' | '~' | '^';
type Piece =
  | { kind: 'node'; node: any }
  | { kind: 'text'; value: string; position?: any }
  | { kind: 'delim'; delim: DelimKind; canOpen: boolean; canClose: boolean };

function isAutolinkLiteral(node: any): boolean {
  if (node.type !== 'link' || node.children?.length !== 1 || node.children[0]?.type !== 'text') return false;
  const text = node.children[0].value;
  return node.url === text || node.url === `mailto:${text}` || node.url === `http://${text}`;
}

function computeEscapedMask(value: string, source: string, position: any): Uint8Array | null {
  const start = position?.start?.offset, end = position?.end?.offset;
  if (typeof start !== 'number' || typeof end !== 'number' || end <= start || end > source.length) return null;
  const raw = source.slice(start, end);
  if (!raw.includes('\\')) return null;
  const mask = new Uint8Array(value.length);
  let r = 0, v = 0;
  while (r < raw.length && v < value.length) {
    if (raw[r] === '\\' && r + 1 < raw.length && ASCII_PUNCT.test(raw[r + 1]) && raw[r + 1] === value[v]) {
      mask[v++] = 1;
      r += 2;
    } else if (raw[r] === value[v]) {
      r++;
      v++;
    } else {
      return null;
    }
  }
  return v === value.length && r === raw.length ? mask : null;
}

function hasDisallowedBreak(node: any, rejectSpaces: boolean): boolean {
  if (node.type === 'break') return true;
  if (typeof node.value === 'string') return rejectSpaces ? /\s/.test(node.value) : /[\r\n]/.test(node.value);
  return Array.isArray(node.children) && node.children.some((c: any) => hasDisallowedBreak(c, rejectSpaces));
}

function spanValid(delim: DelimKind, slice: Piece[]): boolean {
  const rejectSpaces = delim !== '==';
  return slice.length > 0 && !slice.some(piece =>
    piece.kind === 'text'
      ? (rejectSpaces ? /\s/.test(piece.value) : /[\r\n]/.test(piece.value))
      : piece.kind === 'node' && hasDisallowedBreak(piece.node, rejectSpaces),
  );
}

function piecesToNodes(pieces: Piece[]): any[] {
  const out: any[] = [];
  for (const piece of pieces) {
    if (piece.kind === 'node') {
      out.push(piece.node);
      continue;
    }
    const value = piece.kind === 'delim' ? piece.delim : piece.value;
    if (!value) continue;
    const prev = out[out.length - 1];
    if (prev?.type === 'text') {
      prev.value += value;
      delete prev.position;
    } else {
      out.push(piece.kind === 'text' && piece.position ? { type: 'text', value, position: piece.position } : { type: 'text', value });
    }
  }
  return out;
}

function tokenizeChildren(children: any[], source: string): Piece[] {
  const pieces: Piece[] = [];
  for (let idx = 0; idx < children.length; idx++) {
    const child = children[idx];
    if (child.type !== 'text') {
      pieces.push({ kind: 'node', node: child });
      continue;
    }
    const s: string = child.value;
    if (!/[=~^]/.test(s)) {
      pieces.push({ kind: 'text', value: s, position: child.position });
      continue;
    }
    const escaped = source ? computeEscapedMask(s, source, child.position) : null;
    const prevSibling = idx > 0 ? children[idx - 1] : null;
    const nextSibling = idx + 1 < children.length ? children[idx + 1] : null;
    const prevBoundary = !prevSibling ? '' : prevSibling.type === 'break' ? '\n' : 'x';
    const nextBoundary = !nextSibling ? '' : nextSibling.type === 'break' ? '\n' : 'x';

    let buf = '', i = 0, split = false;
    while (i < s.length) {
      const ch = s[i];
      if (!escaped?.[i] && (ch === '=' || ch === '~' || ch === '^')) {
        let run = 1;
        while (i + run < s.length && s[i + run] === ch && !escaped?.[i + run]) run++;
        if ((ch === '=' && run === 2) || ((ch === '~' || ch === '^') && run === 1)) {
          const before = i > 0 ? s[i - 1] : prevBoundary;
          const after = i + run < s.length ? s[i + run] : nextBoundary;
          const canOpen = Boolean(after) && !/\s/.test(after);
          const canClose = Boolean(before) && !/\s/.test(before);
          if (canOpen || canClose) {
            if (buf) { pieces.push({ kind: 'text', value: buf }); buf = ''; }
            split = true;
            pieces.push({ kind: 'delim', delim: (ch === '=' ? '==' : ch) as DelimKind, canOpen, canClose });
            i += run;
            continue;
          }
        }
        buf += s.slice(i, i + run);
        i += run;
        continue;
      }
      buf += ch;
      i++;
    }
    if (!split) pieces.push({ kind: 'text', value: s, position: child.position });
    else if (buf) pieces.push({ kind: 'text', value: buf });
  }
  return pieces;
}

function matchPieces(pieces: Piece[]): any[] | null {
  const working: Piece[] = [];
  const openers: Array<{ pos: number; delim: DelimKind }> = [];
  let changed = false;

  for (const piece of pieces) {
    if (piece.kind !== 'delim') {
      working.push(piece);
      continue;
    }
    let matchedIndex = -1;
    if (piece.canClose) {
      for (let k = openers.length - 1; k >= 0; k--) {
        if (openers[k].delim === piece.delim && spanValid(piece.delim, working.slice(openers[k].pos + 1))) {
          matchedIndex = k;
          break;
        }
      }
    }
    if (matchedIndex >= 0) {
      const opener = openers[matchedIndex];
      openers.length = matchedIndex;
      const meta = SPAN_META[piece.delim];
      working[opener.pos] = {
        kind: 'node',
        node: { type: meta.type, data: { hName: meta.hName }, children: piecesToNodes(working.splice(opener.pos + 1)) },
      };
      changed = true;
    } else {
      const pos = working.length;
      working.push(piece);
      if (piece.canOpen) openers.push({ pos, delim: piece.delim });
    }
  }
  return changed ? piecesToNodes(working) : null;
}

function transformNode(node: any, source: string): void {
  if (!node || SKIP_TYPES.has(node.type) || !Array.isArray(node.children) || isAutolinkLiteral(node)) return;
  if (CONTAINER_TYPES.has(node.type)) {
    let hasCandidate = false;
    for (let i = 0; i < node.children.length; i++) {
      const c = node.children[i];
      if (c.type === 'text' && /[=~^]/.test(c.value)) { hasCandidate = true; break; }
    }
    if (hasCandidate) {
      const pieces = tokenizeChildren(node.children, source);
      let hasDelim = false;
      for (let i = 0; i < pieces.length; i++) if (pieces[i].kind === 'delim') { hasDelim = true; break; }
      const matched = hasDelim ? matchPieces(pieces) : null;
      if (matched) node.children = matched;
    }
  }
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    if (child?.children) transformNode(child, source);
  }
}

/** Parse `==highlight==`, `~subscript~`, and `^superscript^` spans outside code
 * and math nodes while keeping spaces rejected in sub/sup and unmatched markers literal. */
export function remarkStudySyntax(this: unknown) {
  return (tree: any, file?: { value?: unknown }) => {
    const source = typeof file?.value === 'string' ? file.value : '';
    if (source && !/==|[~^]/.test(source)) return;
    transformNode(tree, source);
  };
}

/** When `remarkGfm` runs with `{ singleTilde: false }`, `mdast-util-gfm-strikethrough`
 * still escapes every single `~` in `remark-stringify`. Restrict tilde escaping to `~~`
 * pairs so `H~2~O` survives `preparePdf` intact for `smd-core` subscript typesetting. */
export function remarkSingleTildeStringify(this: any) {
  const extensions = this.data().toMarkdownExtensions || [];
  for (const ext of extensions) {
    for (const sub of ext.extensions || [ext]) {
      if (Array.isArray(sub.unsafe)) {
        sub.unsafe = sub.unsafe.flatMap((entry: any) =>
          entry.character === '~' && entry.inConstruct === 'phrasing'
            ? [{ ...entry, after: '~' }, { ...entry, before: '~' }]
            : [entry],
        );
      }
    }
  }
}
