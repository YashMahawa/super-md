"""Pure Markdown scanning, heading resolution, search, and prose pagination."""
from __future__ import annotations

import re
import sys
import unicodedata
from dataclasses import dataclass, field

if "." in (__package__ or ""):
    from .. import frontmatter
else:
    import frontmatter

MAX_PAGE_CHARS = 12_000
MAX_SEARCH_RESULTS = 25
MAX_OUTLINE_PAGE = 80
MAX_QUERY_CHARS = 500
_HEADING = re.compile(r"^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$")
_FENCE = re.compile(r"^\s{0,3}(`{3,}|~{3,})")

_SVG_FENCE_LANGUAGES = frozenset({"svg", "svg+xml", "image/svg+xml"})
_DIAGRAM_FENCE_LANGUAGES = _SVG_FENCE_LANGUAGES | {"mermaid", "smd-chart"}
_BRACED_FENCE_HEAD = re.compile(r"^\.?([A-Za-z][A-Za-z0-9_-]*)(?:$|[\s,#])")
_INLINE_SVG_OPEN = re.compile(r"<svg\b[^>]*>", re.IGNORECASE)
_INLINE_SVG_CLOSE = re.compile(r"</svg\s*>", re.IGNORECASE)


class AgentDocumentError(ValueError):
    """An expected, safe-to-report error from the document interface."""


class RevisionConflict(AgentDocumentError):
    """The document changed after the caller inspected its revision."""


def normalize_fence_language(raw_info: str) -> str:
    trimmed = raw_info.strip()
    if len(trimmed) >= 4 and trimmed.startswith("{") and trimmed.endswith("}"):
        match = _BRACED_FENCE_HEAD.match(trimmed[1:-1].strip())
        if match:
            lower = match.group(1).casefold()
            if lower in ("python", "py", "mermaid"):
                return lower
    parts = trimmed.split(None, 1)
    return parts[0].casefold() if parts else ""


@dataclass(frozen=True)
class _FencedSpan:
    fence_start: int
    fence_end: int
    body_start: int
    body_end: int
    line_start: int
    line_end: int
    is_svg: bool
    is_diagram: bool
    language: str = ""

    def to_svg_dict(self) -> dict:
        return {
            "start": self.body_start,
            "end": self.body_end,
            "line_start": self.line_start,
            "line_end": self.line_end,
        }


@dataclass
class _OpenFence:
    char: str
    size: int
    fence_start: int
    body_start: int
    line_start: int
    language: str = ""
    svg_tagged: bool = False
    diagram_tagged: bool = False
    probe: list[str] = field(default_factory=list)

    def is_svg(self) -> bool:
        return self.svg_tagged or "".join(self.probe).lstrip().lower().startswith("<svg")

    def to_span(self, *, fence_end: int, body_end: int, line_end: int) -> _FencedSpan:
        is_svg = self.is_svg()
        return _FencedSpan(
            fence_start=self.fence_start,
            fence_end=fence_end,
            body_start=self.body_start,
            body_end=body_end,
            line_start=self.line_start,
            line_end=max(self.line_start, line_end),
            is_svg=is_svg,
            is_diagram=self.diagram_tagged or is_svg,
            language=self.language,
        )


def _step_fence_boundary(
    body: str,
    opened: _OpenFence | None,
    *,
    offset: int,
    line_len: int,
    line_number: int,
    inspect_info: bool,
) -> tuple[bool, _OpenFence | None, _FencedSpan | None]:
    """Parse one line for CommonMark fence boundaries."""
    match = _FENCE.match(body)
    if match is None:
        return False, opened, None
    marker = match.group(1)
    if opened is None:
        language = normalize_fence_language(body[match.end():]) if inspect_info else ""
        svg_tagged = language in _SVG_FENCE_LANGUAGES
        return True, _OpenFence(
            char=marker[0],
            size=len(marker),
            fence_start=offset,
            body_start=offset + line_len,
            line_start=line_number + 1,
            language=language,
            svg_tagged=svg_tagged,
            diagram_tagged=svg_tagged or language in _DIAGRAM_FENCE_LANGUAGES,
        ), None
    if marker[0] == opened.char and len(marker) >= opened.size:
        closed = (
            opened.to_span(fence_end=offset + line_len, body_end=offset, line_end=line_number - 1)
            if inspect_info else None
        )
        return True, None, closed
    return True, opened, None


_ORIG_STEP_FENCE_BOUNDARY = _step_fence_boundary


def _resolve_step_fence():
    if _step_fence_boundary is not _ORIG_STEP_FENCE_BOUNDARY:
        return _step_fence_boundary
    for module_name in ("agent_documents", "desktop.agent_documents"):
        module = sys.modules.get(module_name)
        candidate = getattr(module, "_step_fence_boundary", None)
        if candidate is not None and candidate is not _ORIG_STEP_FENCE_BOUNDARY:
            return candidate
    return _step_fence_boundary


def _scan_read_only(
    text: str,
    *,
    collect_headings: bool = False,
    collect_fences: bool = False,
    fm_end: int | None = None,
) -> tuple[list[dict], list[_FencedSpan]]:
    has_fences = "```" in text or "~~~" in text
    if not collect_headings and not (collect_fences and has_fences):
        return [], []
    resolved_fm_end = (
        (frontmatter.frontmatter_end(text) if text.startswith(("---", "\ufeff---")) else 0)
        if fm_end is None else fm_end
    )
    step_fence = _resolve_step_fence()
    headings: list[dict] = []
    fences: list[_FencedSpan] = []
    offset = 0
    line_number = 1
    opened: _OpenFence | None = None
    for line in text.splitlines(keepends=True):
        line_len = len(line)
        if offset < resolved_fm_end:
            offset += line_len
            line_number += 1
            continue
        body = line.rstrip("\r\n")
        if has_fences:
            is_fence_line, opened, closed = step_fence(
                body,
                opened,
                offset=offset,
                line_len=line_len,
                line_number=line_number,
                inspect_info=collect_fences,
            )
            if closed is not None:
                fences.append(closed)
            if is_fence_line:
                offset += line_len
                line_number += 1
                continue
        if opened is None:
            if collect_headings:
                match = _HEADING.match(body)
                if match:
                    headings.append({
                        "index": len(headings),
                        "level": len(match.group(1)),
                        "title": match.group(2)[:300],
                        "line": line_number,
                        "start": offset,
                    })
        elif collect_fences and not opened.svg_tagged and len(opened.probe) < 4:
            opened.probe.append(body[:512])
        offset += line_len
        line_number += 1
    if opened is not None and collect_fences:
        fences.append(opened.to_span(fence_end=len(text), body_end=len(text), line_end=line_number - 1))
    return headings, fences


def _read_headings_and_svg_spans(
    text: str,
    *,
    include_headings: bool,
    include_svg: bool,
) -> tuple[list[dict], list[dict]]:
    found, fences = _scan_read_only(text, collect_headings=include_headings, collect_fences=include_svg)
    headings = _heading_sections(text, found) if include_headings else []
    svg_spans = [span.to_svg_dict() for span in fences if span.is_svg] if include_svg else []
    return headings, svg_spans


def _headings(text: str, *, include_internal: bool = False, fm_end: int | None = None) -> list[dict]:
    found, _ = _scan_read_only(text, collect_headings=True, fm_end=fm_end)
    if include_internal:
        return _heading_sections(text, found)
    return [{k: v for k, v in item.items() if k != "start"} for item in found]


def _heading_sections(text: str, headings: list[dict]) -> list[dict]:
    """Add code-point section bounds using the next same-or-higher-level heading."""
    section_ends = [len(text)] * len(headings)
    stack: list[int] = []
    for heading in headings:
        while stack and headings[stack[-1]]["level"] >= heading["level"]:
            section_ends[stack.pop()] = heading["start"]
        stack.append(heading["index"])
    return [{**heading, "sectionStart": heading["start"], "sectionEnd": section_ends[index]}
            for index, heading in enumerate(headings)]


def outline_source(source: str, offset: int = 0, limit: int = MAX_OUTLINE_PAGE, *, _fm_end: int | None = None) -> dict:
    """Pure bounded outline page with code-point positions and section ranges."""
    if not isinstance(source, str):
        raise AgentDocumentError("source must be text")
    headings = _headings(source, include_internal=True, fm_end=_fm_end)
    if not isinstance(offset, int) or isinstance(offset, bool) or not 0 <= offset <= len(headings):
        raise AgentDocumentError("outline offset must be between 0 and the heading count")
    if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= MAX_OUTLINE_PAGE:
        raise AgentDocumentError(f"outline limit must be between 1 and {MAX_OUTLINE_PAGE}")
    end = min(len(headings), offset + limit)
    return {"headings": headings[offset:end], "offset": offset, "total": len(headings),
            "nextOffset": end if end < len(headings) else None, "truncated": end < len(headings),
            "documentLength": len(source)}


def _heading_slug(title: str) -> str:
    decomposed = unicodedata.normalize("NFKD", title).lower()
    parts: list[str] = []
    current: list[str] = []
    for char in decomposed:
        if unicodedata.category(char)[0] in ("L", "N"):
            current.append(char)
        elif current:
            parts.append("".join(current))
            current.clear()
    if current:
        parts.append("".join(current))
    return "-".join(parts)


def _ambiguous_heading(selector: str, matches: list[dict]) -> AgentDocumentError:
    candidates = "; ".join(f"{item['index']}: {item['title'][:80]} (line {item['line']})"
                            for item in matches[:5])
    if len(matches) > 5:
        candidates += "; …"
    return AgentDocumentError(f"Heading selector '{selector[:80]}' is ambiguous ({len(matches)} matches); "
                              f"candidates: {candidates}. Use an outline index or a more specific exact title/slug.")


def resolve_heading(headings: list[dict], selector: int | str) -> dict:
    """Resolve a zero-based outline index or an exact title, slug, or section number."""
    if isinstance(selector, int) and not isinstance(selector, bool):
        if 0 <= selector < len(headings):
            return headings[selector]
        raise AgentDocumentError(f"Heading index {selector} is not present in this document")
    if not isinstance(selector, str) or not selector.strip() or len(selector) > 300:
        raise AgentDocumentError("heading must be an outline index or exact title, slug, or numbered heading prefix")
    query = selector.strip()
    exact = [item for item in headings if item["title"] == query]
    if len(exact) == 1:
        return exact[0]
    if len(exact) > 1:
        raise _ambiguous_heading(query, exact)
    slug = _heading_slug(query)
    slug_matches = [item for item in headings if _heading_slug(item["title"]) == slug]
    if len(slug_matches) == 1:
        return slug_matches[0]
    if len(slug_matches) > 1:
        raise _ambiguous_heading(query, slug_matches)
    if re.fullmatch(r"\d+(?:\.\d+)*", query):
        numbered = [item for item in headings
                    if re.match(r"^" + re.escape(query) + r"(?:$|[\s:)\-—]|\.(?=\s))", item["title"])]
        if len(numbered) == 1:
            return numbered[0]
        if len(numbered) > 1:
            raise _ambiguous_heading(query, numbered)
    raise AgentDocumentError(f"No heading matches '{query[:80]}'; use an exact title, slug, or outline index")


def section_source(source: str, selector: int | str) -> dict:
    """Return the exact source range for one heading and its nested subsections."""
    if not isinstance(source, str):
        raise AgentDocumentError("source must be text")
    heading = resolve_heading(_headings(source, include_internal=True), selector)
    start, end = heading["sectionStart"], heading["sectionEnd"]
    return {"text": source[start:end], "sectionStart": start, "sectionEnd": end,
            "documentLength": len(source)}


def _word_character(value: str) -> bool:
    return value == "_" or (bool(value) and unicodedata.category(value)[0] in ("L", "N"))


def diagram_spans(text: str, *, include_inline_svg: bool = False) -> list[dict]:
    """Return diagram body ranges as code-point `{start, end}` offsets; end is exclusive."""
    _, fences = _scan_read_only(text, collect_fences=True)
    spans = [{"start": span.body_start, "end": span.body_end} for span in fences if span.is_diagram]
    if not include_inline_svg:
        return spans
    if "<" in text:
        cursor = 0
        fence_idx = 0
        while True:
            open_match = _INLINE_SVG_OPEN.search(text, cursor)
            if open_match is None:
                break
            start = open_match.start()
            while fence_idx < len(fences) and fences[fence_idx].fence_end <= start:
                fence_idx += 1
            if fence_idx < len(fences) and fences[fence_idx].fence_start <= start < fences[fence_idx].fence_end:
                cursor = fences[fence_idx].fence_end
                continue
            if open_match.group(0).rstrip().endswith("/>"):
                spans.append({"start": start, "end": open_match.end()})
                cursor = open_match.end()
                continue
            close_match = _INLINE_SVG_CLOSE.search(text, open_match.end())
            end = close_match.end() if close_match is not None else len(text)
            spans.append({"start": start, "end": end})
            cursor = end
    unique = {(item["start"], item["end"]) for item in spans}
    return [{"start": start, "end": end} for start, end in sorted(unique)]


def search_source(source: str, query: str, limit: int = 10, context: int = 100, offset: int = 0,
                  case_sensitive: bool = False, whole_word: bool = False, regex: bool = False,
                  exclude_diagrams: bool = False) -> dict:
    """Search a Markdown snapshot without file or UI access; offsets are code points."""
    if not isinstance(source, str):
        raise AgentDocumentError("source must be text")
    if not isinstance(query, str) or not query or len(query) > MAX_QUERY_CHARS:
        raise AgentDocumentError(f"query must contain 1–{MAX_QUERY_CHARS} characters")
    if not isinstance(offset, int) or isinstance(offset, bool) or offset < 0 or offset > len(source):
        raise AgentDocumentError("offset must be between 0 and the document character count")
    if (not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= MAX_SEARCH_RESULTS or
            not isinstance(context, int) or isinstance(context, bool) or not 0 <= context <= 500):
        raise AgentDocumentError("limit must be 1–25 and context 0–500")
    if any(not isinstance(value, bool) for value in (case_sensitive, whole_word, regex, exclude_diagrams)):
        raise AgentDocumentError("case_sensitive, whole_word, regex and exclude_diagrams must be booleans")
    if regex:
        escaped = False
        in_class = False
        for char in query:
            if escaped:
                if char.isdigit() or char == "k":
                    raise AgentDocumentError("regex supports no backreferences")
                if not in_class and char in ("b", "B"):
                    raise AgentDocumentError("regex supports no zero-width word-boundary assertions")
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == "[":
                in_class = True
            elif char == "]":
                in_class = False
            elif not in_class and char in "*+?{}()|":
                raise AgentDocumentError("regex supports literals, dot, character classes and anchors only; quantifiers, groups and alternation are not supported")
        if escaped:
            raise AgentDocumentError("regex ends with an incomplete escape")
        try:
            pattern = re.compile(query, re.MULTILINE | (0 if case_sensitive else re.IGNORECASE))
        except re.error as exc:
            raise AgentDocumentError("regex is not valid in the supported safe subset") from exc
        if pattern.search("") is not None:
            raise AgentDocumentError("regex must match at least one character")
    else:
        pattern = re.compile(re.escape(query), re.MULTILINE | (0 if case_sensitive else re.IGNORECASE))
    spans = diagram_spans(source) if exclude_diagrams else []
    matches = []
    total = 0
    remaining = 0
    cursor = 0
    span_idx = 0
    while True:
        match = pattern.search(source, cursor)
        if match is None:
            break
        start, end = match.span()
        if end <= start:
            cursor = start + 1
            continue
        cursor = end
        if whole_word and ((start > 0 and _word_character(source[start - 1])) or
                           (end < len(source) and _word_character(source[end]))):
            continue
        if exclude_diagrams:
            while span_idx < len(spans) and spans[span_idx]["end"] <= start:
                span_idx += 1
            if span_idx < len(spans) and start < spans[span_idx]["end"] and end > spans[span_idx]["start"]:
                continue
        total += 1
        if start < offset:
            continue
        remaining += 1
        if len(matches) < limit:
            left, right = max(0, start - context), min(len(source), end + context)
            matches.append({"offset": start, "line": source.count("\n", 0, start) + 1,
                            "start": left, "end": right, "snippet": source[left:right],
                            "matchOffset": start, "matchLength": end - start, "snippetOffset": left})
    next_offset = (matches[-1]["matchOffset"] + matches[-1]["matchLength"]
                   if remaining > len(matches) and matches else None)
    return {"matches": matches, "totalMatches": total, "remainingMatches": remaining,
            "nextOffset": next_offset, "truncated": remaining > len(matches)}


def _svg_spans(text: str) -> list[dict]:
    _, fences = _scan_read_only(text, collect_fences=True)
    return [span.to_svg_dict() for span in fences if span.is_svg]


def _prose_page_end(start: int, limit: int, max_end: int, spans: list[dict]) -> int:
    """Consume a page of visible prose, skipping SVG bodies without pagination loops."""
    cursor = start
    remaining = limit
    for span in spans:
        if span["end"] <= cursor or span["start"] >= max_end:
            continue
        if span["start"] > cursor:
            plain_end = min(span["start"], max_end)
            consumed = min(plain_end - cursor, remaining)
            cursor += consumed
            remaining -= consumed
            if remaining == 0:
                return cursor
        # The omitted source is consumed at zero prose budget cost. Clamp to
        # the caller's heading/document boundary.
        cursor = min(max_end, max(cursor, span["end"]))
        if cursor >= max_end:
            return max_end
    return min(max_end, cursor + remaining)


def _elide_svg_page(text: str, start: int, end: int, spans: list[dict] | None = None) -> tuple[str, list[dict]]:
    pieces = []
    omissions = []
    cursor = start
    for span in _svg_spans(text) if spans is None else spans:
        left, right = max(start, span["start"]), min(end, span["end"])
        if left >= right:
            continue
        pieces.append(text[cursor:left])
        omitted = {"source_start": span["start"], "source_end": span["end"],
                   "line_start": span["line_start"], "line_end": span["line_end"],
                   "omitted_chars": span["end"] - span["start"],
                   "omitted_lines": max(1, span["line_end"] - span["line_start"] + 1)}
        omissions.append(omitted)
        pieces.append(f"[SVG omitted: {omitted['omitted_chars']} chars, source lines "
                      f"{omitted['line_start']}–{omitted['line_end']}]\n")
        cursor = right
    pieces.append(text[cursor:end])
    return "".join(pieces), omissions


def read_source(
    source: str,
    *,
    offset: int = 0,
    limit: int = MAX_PAGE_CHARS,
    heading: int | str | None = None,
    view: str = "prose",
) -> dict:
    """Read a bounded source or prose page with optional heading scoping and SVG elision."""
    if not isinstance(source, str):
        raise AgentDocumentError("source must be text")
    if not isinstance(offset, int) or isinstance(offset, bool) or offset < 0 or offset > len(source):
        raise AgentDocumentError("offset must be between 0 and the document character count")
    if not isinstance(limit, int) or isinstance(limit, bool) or limit < 1 or limit > MAX_PAGE_CHARS:
        raise AgentDocumentError(f"limit must be between 1 and {MAX_PAGE_CHARS}")
    if view not in ("prose", "source"):
        raise AgentDocumentError("view must be 'prose' or 'source'")
    document_length = len(source)
    section_start, section_end = 0, document_length
    headings, spans = _read_headings_and_svg_spans(
        source,
        include_headings=heading is not None,
        include_svg=view == "prose",
    )
    selected_heading = None
    if heading is not None:
        selected_heading = resolve_heading(headings, heading)
        section_start, section_end = selected_heading["sectionStart"], selected_heading["sectionEnd"]
    if offset > section_end:
        raise AgentDocumentError(f"offset must be within the selected section (sectionEnd {section_end})")
    start = offset if heading is None else max(section_start, offset)
    page_end = (_prose_page_end(start, limit, section_end, spans) if view == "prose"
                else min(section_end, start + limit))
    page_text = source[start:page_end]
    omitted = []
    if view == "prose":
        page_text, omitted = _elide_svg_page(source, start, page_end, spans)
    result = {
        "start": start, "end": page_end, "total_chars": section_end - section_start,
        "next_offset": page_end if page_end < section_end else None,
        "truncated": page_end < section_end, "view": view, "text": page_text,
        "returned_chars": len(page_text), "svg_omissions": omitted,
        "sectionStart": section_start, "sectionEnd": section_end, "documentLength": document_length,
    }
    if selected_heading is not None:
        result["heading"] = {key: selected_heading[key] for key in ("index", "level", "title", "line")}
    return result


_PEER_MODULE = (
    "agent.source_ops"
    if __name__ == "desktop.agent.source_ops"
    else ("desktop.agent.source_ops" if __name__ == "agent.source_ops" else None)
)
if _PEER_MODULE and _PEER_MODULE in sys.modules:
    sys.modules[__name__] = sys.modules[_PEER_MODULE]

