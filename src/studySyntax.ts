const SKIP_TYPES = new Set(['code', 'inlineCode', 'math', 'inlineMath', 'html', 'definition', 'yaml']);
const CONTAINER_TYPES = new Set(['paragraph', 'heading', 'tableCell', 'emphasis', 'strong', 'delete', 'link', 'linkReference', 'highlight', 'subscript', 'superscript']);
const ESCAPED_TEXT_TYPE = '__studyEscaped';
const FULL_PHRASING_SPANS = ['autolink', 'destinationLiteral', 'destinationRaw', 'reference', 'titleQuote', 'titleApostrophe'];
const PUNCT_RE = /[\p{P}\p{S}]/u;
const SPAN_META: Record<DelimKind, { type: string; hName: string }> = {
  '==': { type: 'highlight', hName: 'mark' },
  '~': { type: 'subscript', hName: 'sub' },
  '^': { type: 'superscript', hName: 'sup' },
};

type DelimKind = '==' | '~' | '^';
type Piece =
  | { kind: 'node'; node: any }
  | { kind: 'text'; value: string; escaped?: boolean; position?: any }
  | { kind: 'delim'; delim: DelimKind; canOpen: boolean; canClose: boolean };

function copyPoint(d: any) {
  return { line: d.line, column: d.column, offset: d.offset };
}

function isAutolinkLiteral(node: any): boolean {
  if (node.type !== 'link' || node.children?.length !== 1 || node.children[0]?.type !== 'text') return false;
  const text = node.children[0].value;
  return node.url === text || node.url === `mailto:${text}` || node.url === `http://${text}`;
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
    if (piece.kind === 'text' && piece.escaped) {
      out.push(piece.position ? { type: ESCAPED_TEXT_TYPE, value: piece.value, position: piece.position } : { type: ESCAPED_TEXT_TYPE, value: piece.value });
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

function normalizeEscapedChildren(children: any[]): void {
  let hasEscaped = false;
  for (let i = 0; i < children.length; i++) {
    if (children[i]?.type === ESCAPED_TEXT_TYPE) { hasEscaped = true; break; }
  }
  if (!hasEscaped) return;
  let write = 0;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    const isTextLike = child?.type === 'text' || child?.type === ESCAPED_TEXT_TYPE;
    if (child?.type === ESCAPED_TEXT_TYPE) child.type = 'text';
    const prev = write > 0 ? children[write - 1] : null;
    if (isTextLike && prev?.type === 'text') {
      prev.value += child.value;
      if (prev.position && child.position?.end) prev.position = { start: prev.position.start, end: child.position.end };
      else delete prev.position;
    } else {
      children[write++] = child;
    }
  }
  children.length = write;
}

function firstChar(s: string): string {
  if (!s) return '';
  const code = s.charCodeAt(0);
  return code >= 0xd800 && code <= 0xdbff && s.length > 1 ? s.slice(0, 2) : s[0];
}

function lastChar(s: string): string {
  if (!s) return '';
  const code = s.charCodeAt(s.length - 1);
  return code >= 0xdc00 && code <= 0xdfff && s.length > 1 ? s.slice(-2) : s[s.length - 1];
}

function siblingBoundary(sibling: any, front: boolean): string {
  if (!sibling) return '';
  if (sibling.type === 'break') return '\n';
  if (sibling.type === 'text' || sibling.type === ESCAPED_TEXT_TYPE) {
    return front ? firstChar(sibling.value) : lastChar(sibling.value);
  }
  return 'x';
}

function delimFlanking(ch: string, before: string, after: string): { canOpen: boolean; canClose: boolean } {
  const beforeWs = !before || /\s/.test(before);
  const afterWs = !after || /\s/.test(after);
  if (ch !== '=') return { canOpen: !afterWs, canClose: !beforeWs };
  const beforePunct = !beforeWs && PUNCT_RE.test(before);
  const afterPunct = !afterWs && PUNCT_RE.test(after);
  return {
    canOpen: !afterWs && (!afterPunct || beforeWs || beforePunct),
    canClose: !beforeWs && (!beforePunct || afterWs || afterPunct),
  };
}

function tokenizeChildren(children: any[]): Piece[] {
  const pieces: Piece[] = [];
  for (let idx = 0; idx < children.length; idx++) {
    const child = children[idx];
    if (child.type === ESCAPED_TEXT_TYPE) {
      pieces.push({ kind: 'text', value: child.value, escaped: true, position: child.position });
      continue;
    }
    if (child.type !== 'text') {
      pieces.push({ kind: 'node', node: child });
      continue;
    }
    const s: string = child.value;
    if (!/[=~^]/.test(s)) {
      pieces.push({ kind: 'text', value: s, position: child.position });
      continue;
    }
    const prevBoundary = siblingBoundary(idx > 0 ? children[idx - 1] : null, false);
    const nextBoundary = siblingBoundary(idx + 1 < children.length ? children[idx + 1] : null, true);

    let buf = '', i = 0, split = false;
    while (i < s.length) {
      const ch = s[i];
      if (ch === '=' || ch === '~' || ch === '^') {
        let run = 1;
        while (i + run < s.length && s[i + run] === ch) run++;
        if ((ch === '=' && run === 2) || ((ch === '~' || ch === '^') && run === 1)) {
          const before = i > 0 ? lastChar(s.slice(0, i)) : prevBoundary;
          const after = i + run < s.length ? firstChar(s.slice(i + run)) : nextBoundary;
          const { canOpen, canClose } = delimFlanking(ch, before, after);
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

function transformNode(node: any): void {
  if (!node || SKIP_TYPES.has(node.type) || !Array.isArray(node.children)) return;
  if (CONTAINER_TYPES.has(node.type) && !isAutolinkLiteral(node)) {
    let hasCandidate = false;
    for (let i = 0; i < node.children.length; i++) {
      const c = node.children[i];
      if (c.type === 'text' && /[=~^]/.test(c.value)) { hasCandidate = true; break; }
    }
    if (hasCandidate) {
      const pieces = tokenizeChildren(node.children);
      let hasDelim = false;
      for (let i = 0; i < pieces.length; i++) if (pieces[i].kind === 'delim') { hasDelim = true; break; }
      const matched = hasDelim ? matchPieces(pieces) : null;
      if (matched) node.children = matched;
    }
  }
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    if (child?.children) transformNode(child);
  }
  normalizeEscapedChildren(node.children);
}

function studySyntaxFromMarkdown() {
  return {
    enter: {
      characterEscape(this: any, token: any) {
        this.data.studyEscStart = token.start;
        this.config.enter.data.call(this, token);
      },
      characterReference(this: any, token: any) {
        this.config.enter.data.call(this, token);
        const tail = this.stack[this.stack.length - 1];
        this.data.studyRefStart = token.start;
        this.data.studyRefOffset = tail.value.length;
        this.data.studyRefEnd = tail.position.end;
      },
    },
    exit: {
      characterEscapeValue(this: any, token: any) {
        const ch = this.sliceSerialize(token);
        const parent = this.stack[this.stack.length - 2];
        if ((ch === '=' || ch === '~' || ch === '^') && parent && parent.type !== 'fragment') {
          const tail = this.stack.pop();
          const end = copyPoint(token.end);
          if (!tail.value) {
            tail.type = ESCAPED_TEXT_TYPE;
            tail.value = ch;
            tail.position.end = end;
          } else {
            parent.children.push({
              type: ESCAPED_TEXT_TYPE,
              value: ch,
              position: { start: copyPoint(this.data.studyEscStart || token.start), end },
            });
          }
        } else {
          this.config.exit.data.call(this, token);
        }
        this.data.studyEscStart = undefined;
      },
      characterReference(this: any, token: any) {
        const tail = this.stack.pop();
        const parent = this.stack[this.stack.length - 1];
        const offset: number = this.data.studyRefOffset ?? tail.value.length;
        const added: string = tail.value.slice(offset);
        const end = copyPoint(token.end);
        if ((added === '=' || added === '~' || added === '^') && parent && parent.type !== 'fragment') {
          if (!offset) {
            tail.type = ESCAPED_TEXT_TYPE;
            tail.position.end = end;
          } else {
            tail.value = tail.value.slice(0, offset);
            tail.position.end = this.data.studyRefEnd;
            parent.children.push({
              type: ESCAPED_TEXT_TYPE,
              value: added,
              position: { start: copyPoint(this.data.studyRefStart || token.start), end },
            });
          }
        } else {
          tail.position.end = end;
        }
        this.data.studyRefStart = this.data.studyRefOffset = this.data.studyRefEnd = undefined;
      },
    },
    transforms: [
      (tree: any) => {
        transformNode(tree);
      },
    ],
  };
}

function makeSpanHandler(construct: string, marker: DelimKind) {
  const edge = marker[0];
  const handle: any = (node: any, _: any, state: any, info: any) => {
    const tracker = state.createTracker(info);
    const exit = state.enter(construct);
    let value = tracker.move(marker);
    value += state.containerPhrasing(node, {
      ...tracker.current(),
      before: edge,
      after: edge,
    });
    value += tracker.move(marker);
    exit();
    return value;
  };
  handle.peek = () => edge;
  return handle;
}

function studySyntaxToMarkdown() {
  return {
    unsafe: [
      { character: '=', after: '=', inConstruct: 'phrasing', notInConstruct: FULL_PHRASING_SPANS },
      { character: '=', before: '=', inConstruct: 'phrasing', notInConstruct: FULL_PHRASING_SPANS },
      { character: '~', inConstruct: 'phrasing', notInConstruct: FULL_PHRASING_SPANS },
      { character: '^', inConstruct: 'phrasing', notInConstruct: FULL_PHRASING_SPANS },
      { character: '%', after: '%', inConstruct: 'phrasing', notInConstruct: FULL_PHRASING_SPANS },
    ],
    handlers: {
      highlight: makeSpanHandler('highlight', '=='),
      subscript: makeSpanHandler('subscript', '~'),
      superscript: makeSpanHandler('superscript', '^'),
    },
  };
}

/** Parse and stringify `==highlight==`, `~subscript~`, and `^superscript^` spans
 * outside code and math while preserving explicit backslash/entity escapes. */
export function remarkStudySyntax(this: any) {
  const data = this.data();
  const fromMarkdownExtensions = data.fromMarkdownExtensions || (data.fromMarkdownExtensions = []);
  const toMarkdownExtensions = data.toMarkdownExtensions || (data.toMarkdownExtensions = []);
  fromMarkdownExtensions.push(studySyntaxFromMarkdown());
  toMarkdownExtensions.push(studySyntaxToMarkdown());
}
