const SKIP_TYPES = new Set(['code', 'inlineCode', 'math', 'inlineMath', 'html', 'definition', 'yaml']);
const CONTAINER_TYPES = new Set(['paragraph', 'heading', 'tableCell', 'emphasis', 'strong', 'delete', 'link', 'linkReference', 'highlight', 'subscript', 'superscript']);
const ESCAPED_TEXT_TYPE = '__studyEscaped';
const FULL_PHRASING_SPANS = ['autolink', 'destinationLiteral', 'destinationRaw', 'reference', 'titleQuote', 'titleApostrophe'];
const CANDIDATE_RE = /==|[~^]/;
const WS_RE = /\s/;
const LINE_BREAK_RE = /[\r\n]/;
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
  if (typeof node.value === 'string') return rejectSpaces ? WS_RE.test(node.value) : LINE_BREAK_RE.test(node.value);
  if (!Array.isArray(node.children)) return false;
  for (let i = 0; i < node.children.length; i++) {
    if (hasDisallowedBreak(node.children[i], rejectSpaces)) return true;
  }
  return false;
}

function piecesToNodes(pieces: Piece[], start: number, end: number): any[] {
  const out: any[] = [];
  for (let i = start; i < end; i++) {
    const piece = pieces[i];
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

function codePointAtPos(s: string, idx: number): number {
  return idx < s.length ? s.codePointAt(idx)! : -1;
}

function codePointBefore(s: string, idx: number): number {
  if (idx <= 0) return -1;
  const lo = s.charCodeAt(idx - 1);
  if (lo >= 0xdc00 && lo <= 0xdfff && idx > 1) {
    const hi = s.charCodeAt(idx - 2);
    if (hi >= 0xd800 && hi <= 0xdbff) return ((hi - 0xd800) << 10) + (lo - 0xdc00) + 0x10000;
  }
  return lo;
}

function siblingBoundary(sibling: any, front: boolean): number {
  if (!sibling) return -1;
  if (sibling.type === 'break') return 0x0a;
  if (sibling.type === 'text' || sibling.type === ESCAPED_TEXT_TYPE) {
    const s: string = sibling.value;
    return front ? codePointAtPos(s, 0) : codePointBefore(s, s.length);
  }
  return 0x78;
}

function isBoundaryWs(cp: number): boolean {
  if (cp < 0) return true;
  return cp < 128 ? cp === 0x20 || (cp >= 0x09 && cp <= 0x0d) : WS_RE.test(String.fromCodePoint(cp));
}

function isBoundaryPunct(cp: number): boolean {
  if (cp < 0) return false;
  return cp < 128
    ? (cp >= 0x21 && cp <= 0x2f) || (cp >= 0x3a && cp <= 0x40) || (cp >= 0x5b && cp <= 0x60) || (cp >= 0x7b && cp <= 0x7e)
    : PUNCT_RE.test(String.fromCodePoint(cp));
}

function delimFlanking(code: number, before: number, after: number): number {
  const beforeWs = isBoundaryWs(before);
  const afterWs = isBoundaryWs(after);
  if (code !== 61) return (!afterWs ? 1 : 0) | (!beforeWs ? 2 : 0);
  const beforePunct = !beforeWs && isBoundaryPunct(before);
  const afterPunct = !afterWs && isBoundaryPunct(after);
  const canOpen = !afterWs && (!afterPunct || beforeWs || beforePunct);
  const canClose = !beforeWs && (!beforePunct || afterWs || afterPunct);
  return (canOpen ? 1 : 0) | (canClose ? 2 : 0);
}

function tokenizeChildren(children: any[]): Piece[] | null {
  const pieces: Piece[] = [];
  let sawDelim = false;
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
    if (!CANDIDATE_RE.test(s)) {
      pieces.push({ kind: 'text', value: s, position: child.position });
      continue;
    }
    const prevBoundary = siblingBoundary(idx > 0 ? children[idx - 1] : null, false);
    const nextBoundary = siblingBoundary(idx + 1 < children.length ? children[idx + 1] : null, true);

    let segStart = 0;
    let split = false;
    const len = s.length;
    let i = 0;
    while (i < len) {
      const code = s.charCodeAt(i);
      if (code === 61 || code === 126 || code === 94) {
        let end = i + 1;
        while (end < len && s.charCodeAt(end) === code) end++;
        const run = end - i;
        if ((code === 61 && run === 2) || (code !== 61 && run === 1)) {
          const before = i > 0 ? codePointBefore(s, i) : prevBoundary;
          const after = end < len ? codePointAtPos(s, end) : nextBoundary;
          const flank = delimFlanking(code, before, after);
          if (flank !== 0) {
            if (i > segStart) pieces.push({ kind: 'text', value: s.slice(segStart, i) });
            split = true;
            sawDelim = true;
            pieces.push({
              kind: 'delim',
              delim: code === 61 ? '==' : code === 126 ? '~' : '^',
              canOpen: (flank & 1) !== 0,
              canClose: (flank & 2) !== 0,
            });
            segStart = end;
          }
        }
        i = end;
        continue;
      }
      i++;
    }
    if (!split) pieces.push({ kind: 'text', value: s, position: child.position });
    else if (segStart < len) pieces.push({ kind: 'text', value: s.slice(segStart) });
  }
  return sawDelim ? pieces : null;
}

function matchPieces(pieces: Piece[]): any[] | null {
  const working: Piece[] = [];
  const hlOpeners: number[] = [];
  const subOpeners: number[] = [];
  const supOpeners: number[] = [];
  let changed = false;

  for (let p = 0; p < pieces.length; p++) {
    const piece = pieces[p];
    if (piece.kind !== 'delim') {
      if (hlOpeners.length > 0 || subOpeners.length > 0 || supOpeners.length > 0) {
        if (piece.kind === 'text') {
          if (hlOpeners.length > 0 && LINE_BREAK_RE.test(piece.value)) {
            hlOpeners.length = 0;
            subOpeners.length = 0;
            supOpeners.length = 0;
          } else if ((subOpeners.length > 0 || supOpeners.length > 0) && WS_RE.test(piece.value)) {
            subOpeners.length = 0;
            supOpeners.length = 0;
          }
        } else if (hlOpeners.length > 0 && hasDisallowedBreak(piece.node, false)) {
          hlOpeners.length = 0;
          subOpeners.length = 0;
          supOpeners.length = 0;
        } else if ((subOpeners.length > 0 || supOpeners.length > 0) && hasDisallowedBreak(piece.node, true)) {
          subOpeners.length = 0;
          supOpeners.length = 0;
        }
      }
      working.push(piece);
      continue;
    }

    const stack = piece.delim === '==' ? hlOpeners : piece.delim === '~' ? subOpeners : supOpeners;
    let matchIdx = -1;
    if (piece.canClose && stack.length > 0) {
      const top = stack.length - 1;
      if (stack[top] + 1 < working.length) matchIdx = top;
      else if (top > 0) matchIdx = top - 1;
    }

    if (matchIdx >= 0) {
      const openerPos = stack[matchIdx];
      stack.length = matchIdx;
      while (hlOpeners.length > 0 && hlOpeners[hlOpeners.length - 1] > openerPos) hlOpeners.pop();
      while (subOpeners.length > 0 && subOpeners[subOpeners.length - 1] > openerPos) subOpeners.pop();
      while (supOpeners.length > 0 && supOpeners[supOpeners.length - 1] > openerPos) supOpeners.pop();
      const meta = SPAN_META[piece.delim];
      const children = piecesToNodes(working, openerPos + 1, working.length);
      working.length = openerPos + 1;
      working[openerPos] = {
        kind: 'node',
        node: { type: meta.type, data: { hName: meta.hName }, children },
      };
      changed = true;
    } else {
      const pos = working.length;
      working.push(piece);
      if (piece.canOpen) stack.push(pos);
    }
  }
  return changed ? piecesToNodes(working, 0, working.length) : null;
}

function transformNode(node: any): void {
  if (!node || SKIP_TYPES.has(node.type) || !Array.isArray(node.children)) return;
  if (CONTAINER_TYPES.has(node.type) && !isAutolinkLiteral(node)) {
    let hasCandidate = false;
    for (let i = 0; i < node.children.length; i++) {
      const c = node.children[i];
      if (c.type === 'text' && CANDIDATE_RE.test(c.value)) { hasCandidate = true; break; }
    }
    if (hasCandidate) {
      const pieces = tokenizeChildren(node.children);
      const matched = pieces ? matchPieces(pieces) : null;
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

const FROM_MARKDOWN_EXT = studySyntaxFromMarkdown();
const TO_MARKDOWN_EXT = studySyntaxToMarkdown();

/** Parse and stringify `==highlight==`, `~subscript~`, and `^superscript^` spans
 * outside code and math while preserving explicit backslash/entity escapes. */
export function remarkStudySyntax(this: any) {
  const data = this.data();
  const fromMarkdownExtensions = data.fromMarkdownExtensions || (data.fromMarkdownExtensions = []);
  const toMarkdownExtensions = data.toMarkdownExtensions || (data.toMarkdownExtensions = []);
  fromMarkdownExtensions.push(FROM_MARKDOWN_EXT);
  toMarkdownExtensions.push(TO_MARKDOWN_EXT);
}
