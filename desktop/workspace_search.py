"""On-demand folder Quick Switcher, streaming cross-note search, and recursive tree filtering.

Scans run in memory on demand, skip dotfiles and symlinks, enforce entry and size caps,
skip inline SVG/Mermaid/chart blocks by default, never decode portable embedded images,
and write zero cached indexes to disk.
"""
from __future__ import annotations

import os
import re
import threading
import time
from pathlib import Path
from typing import Callable

from documents import MAX_SEARCH_MARKDOWN_BYTES, read_searchable_markdown

NOTE_EXTENSIONS = frozenset({".md", ".smd", ".fmd", ".markdown", ".txt"})
MAX_WALK_ENTRIES = 5_000
MAX_WALK_DEPTH = 24
MAX_QUICK_RESULTS = 80
MAX_MATCHES_PER_FILE = 25
MAX_MATCHES_TOTAL = 400
STREAM_BATCH_SIZE = 12
STREAM_INTERVAL_SEC = 0.035

_DIAGRAM_FENCE_LANGS = frozenset({"svg", "svg+xml", "image/svg+xml", "mermaid", "smd-chart"})
_SVG_CANDIDATE_FENCE_LANGS = frozenset({"", "xml", "html"})
_FENCE_OPEN_RE = re.compile(r"^ {0,3}(`{3,}|~{3,})([^\n]*)$")
_SVG_START_RE = re.compile(r"^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>/]", re.IGNORECASE)
_SVG_END_RE = re.compile(r"</svg\s*>\s*$", re.IGNORECASE)
_INLINE_SVG_TAG_RE = re.compile(r"<(/?)svg(?=[\s>/])[^>]*>", re.IGNORECASE)
_NON_NEWLINE_RE = re.compile(r"[^\n]+")
_WORD_BOUNDARY_CHARS = frozenset(" /\\-_.")


def looks_like_svg(text: str) -> bool:
    return bool(_SVG_START_RE.search(text) and _SVG_END_RE.search(text))


def _mask_slice(text: str) -> str:
    return _NON_NEWLINE_RE.sub(lambda m: " " * len(m.group(0)), text)


def _raw_svg_spans(segment: str, base_offset: int) -> list[tuple[int, int]]:
    """Locate raw <svg ...>...</svg> spans in non-fenced Markdown text."""
    if "<svg" not in segment.lower():
        return []
    spans: list[tuple[int, int]] = []
    depth = 0
    start = -1
    for match in _INLINE_SVG_TAG_RE.finditer(segment):
        closing = bool(match.group(1))
        full = match.group(0)
        self_closing = not closing and full.rstrip().endswith("/>")
        if not closing:
            if depth == 0:
                start = match.start()
            if self_closing:
                if depth == 0:
                    spans.append((base_offset + start, base_offset + match.end()))
                    start = -1
            else:
                depth += 1
        elif depth > 0:
            depth -= 1
            if depth == 0 and start >= 0:
                spans.append((base_offset + start, base_offset + match.end()))
                start = -1
    return spans


def diagram_exclusion_spans(text: str) -> list[tuple[int, int]]:
    """Return (start, end) character spans for SVG, Mermaid, and smd-chart blocks."""
    if not text:
        return []
    spans: list[tuple[int, int]] = []
    code_fence_spans: list[tuple[int, int]] = []
    lines = text.splitlines(keepends=True)
    offset = 0
    index = 0
    count = len(lines)

    while index < count:
        raw_line = lines[index]
        stripped = raw_line.rstrip("\r\n")
        open_match = _FENCE_OPEN_RE.match(stripped)
        if not open_match:
            offset += len(raw_line)
            index += 1
            continue

        marker = open_match.group(1)
        info_rest = open_match.group(2).strip()
        # CommonMark backtick fences cannot contain backticks in their info string.
        if marker[0] == "`" and "`" in info_rest:
            offset += len(raw_line)
            index += 1
            continue

        lang = info_rest.split()[0].lower() if info_rest else ""
        fence_start = offset
        body_start = offset + len(raw_line)
        close_re = re.compile(rf"^ {{0,3}}{re.escape(marker[0])}{{{len(marker)},}}[ \t]*$")

        end_index = index + 1
        end_offset = body_start
        body_end = body_start
        closed = False
        while end_index < count:
            candidate = lines[end_index]
            if close_re.match(candidate.rstrip("\r\n")):
                body_end = end_offset
                end_offset += len(candidate)
                end_index += 1
                closed = True
                break
            end_offset += len(candidate)
            end_index += 1
        if not closed:
            body_end = end_offset

        code_fence_spans.append((fence_start, end_offset))
        is_diagram = lang in _DIAGRAM_FENCE_LANGS or (
            lang in _SVG_CANDIDATE_FENCE_LANGS and looks_like_svg(text[body_start:body_end])
        )
        if is_diagram:
            spans.append((fence_start, end_offset))

        offset = end_offset
        index = end_index

    # Scan gaps outside all code fences for raw inline/block <svg>...</svg>.
    cursor = 0
    for fence_start, fence_end in code_fence_spans:
        if fence_start > cursor:
            spans.extend(_raw_svg_spans(text[cursor:fence_start], cursor))
        cursor = fence_end
    if cursor < len(text):
        spans.extend(_raw_svg_spans(text[cursor:], cursor))

    if len(spans) <= 1:
        return spans
    spans.sort()
    merged: list[tuple[int, int]] = [spans[0]]
    for s, e in spans[1:]:
        prev_s, prev_e = merged[-1]
        if s <= prev_e:
            merged[-1] = (prev_s, max(prev_e, e))
        else:
            merged.append((s, e))
    return merged


def mask_diagram_spans(text: str) -> str:
    """Mask excluded diagram blocks with spaces while preserving exact line numbers."""
    spans = diagram_exclusion_spans(text)
    if not spans:
        return text
    parts: list[str] = []
    cursor = 0
    for start, end in spans:
        if start > cursor:
            parts.append(text[cursor:start])
        parts.append(_mask_slice(text[start:end]))
        cursor = end
    if cursor < len(text):
        parts.append(text[cursor:])
    return "".join(parts)


def canonical_note_key(path_value: str | Path | None) -> str:
    if not path_value:
        return ""
    try:
        resolved = str(Path(path_value).resolve(strict=False))
    except OSError:
        resolved = str(path_value)
    return os.path.normcase(resolved)


def _relative_display(path_obj: Path, folder: Path | None) -> str:
    if folder is not None:
        try:
            return path_obj.resolve(strict=False).relative_to(folder.resolve(strict=False)).as_posix()
        except ValueError:
            pass
    return path_obj.name


def walk_folder_notes(
    folder: Path,
    cancel_event: threading.Event | None = None,
    max_entries: int = MAX_WALK_ENTRIES,
) -> list[dict]:
    """Walk a folder on demand, skipping dotfiles and symlinks, enforcing entry and depth caps."""
    results: list[dict] = []
    seen_entries = 0

    try:
        if not folder.exists() or folder.is_symlink() or not folder.is_dir():
            return results
        root_resolved = folder.resolve(strict=False)
    except OSError:
        return results

    def visit(directory: Path, depth: int) -> None:
        nonlocal seen_entries
        if depth > MAX_WALK_DEPTH or seen_entries >= max_entries:
            return
        if cancel_event is not None and cancel_event.is_set():
            return
        try:
            with os.scandir(directory) as it:
                entries = []
                for entry in it:
                    if entry.name.startswith("."):
                        continue
                    try:
                        if entry.is_symlink():
                            continue
                        is_dir = entry.is_dir(follow_symlinks=False)
                        is_file = not is_dir and entry.is_file(follow_symlinks=False)
                    except OSError:
                        continue
                    if not is_dir and not is_file:
                        continue
                    entries.append((entry.name, Path(entry.path), is_dir))
        except OSError:
            return

        entries.sort(key=lambda item: (not item[2], item[0].lower()))
        for name, full_path, is_dir in entries:
            if cancel_event is not None and cancel_event.is_set():
                return
            if seen_entries >= max_entries:
                return
            if is_dir:
                visit(full_path, depth + 1)
            elif full_path.suffix.lower() in NOTE_EXTENSIONS:
                seen_entries += 1
                try:
                    rel = full_path.resolve(strict=False).relative_to(root_resolved).as_posix()
                except ValueError:
                    rel = name
                results.append({
                    "name": name,
                    "path": str(full_path),
                    "relative": rel,
                    "key": canonical_note_key(full_path),
                })

    visit(folder, 0)
    return results


def _subsequence_score(token: str, candidate: str, candidate_lower: str) -> float | None:
    """Boundary-aware subsequence scorer; returns None when token chars don't appear in order."""
    pos = 0
    positions: list[int] = []
    for ch in token:
        found = candidate_lower.find(ch, pos)
        if found < 0:
            return None
        # Prefer an immediate word-boundary or camelCase hit if one exists slightly ahead
        if found > 0 and candidate[found - 1] not in _WORD_BOUNDARY_CHARS and not (
            candidate[found].isupper() and candidate[found - 1].islower()
        ):
            alt = found + 1
            while True:
                nxt = candidate_lower.find(ch, alt)
                if nxt < 0 or nxt - found > 16:
                    break
                if candidate[nxt - 1] in _WORD_BOUNDARY_CHARS or (
                    candidate[nxt].isupper() and candidate[nxt - 1].islower()
                ):
                    found = nxt
                    break
                alt = nxt + 1
        positions.append(found)
        pos = found + 1

    score = 0.0
    for idx, p in enumerate(positions):
        score += 12.0
        if p == 0:
            score += 35.0
        elif candidate[p - 1] in _WORD_BOUNDARY_CHARS:
            score += 28.0
        elif candidate[p].isupper() and candidate[p - 1].islower():
            score += 24.0
        if idx > 0:
            gap = p - positions[idx - 1] - 1
            if gap == 0:
                score += 22.0
            else:
                score -= min(gap * 2.0, 24.0)
    return score


def fuzzy_note_score(query: str, name: str, relative: str = "") -> float | None:
    """Rank how strongly query matches a note's filename and folder-relative path."""
    cleaned = query.strip()
    if not cleaned:
        return 0.0

    name_lower = name.lower()
    stem = name.rsplit(".", 1)[0] if "." in name else name
    stem_lower = stem.lower()
    rel = relative or name
    rel_lower = rel.lower()

    tokens = cleaned.split()
    total = 0.0
    for token in tokens:
        tok_low = token.lower()
        token_score: float | None = None

        if stem_lower == tok_low or name_lower == tok_low:
            token_score = 1200.0
        elif stem_lower.startswith(tok_low):
            token_score = 800.0 - (len(stem_lower) - len(tok_low)) * 1.5
        elif tok_low in name_lower:
            pos = name_lower.index(tok_low)
            boundary = 90.0 if pos == 0 or name[pos - 1] in _WORD_BOUNDARY_CHARS else 0.0
            token_score = 520.0 + boundary - pos * 2.5
        elif tok_low in rel_lower:
            pos = rel_lower.index(tok_low)
            boundary = 50.0 if pos == 0 or rel[pos - 1] in _WORD_BOUNDARY_CHARS else 0.0
            token_score = 320.0 + boundary - pos * 1.2
        else:
            sub_name = _subsequence_score(tok_low, name, name_lower)
            if sub_name is not None:
                token_score = 180.0 + sub_name
            else:
                sub_rel = _subsequence_score(tok_low, rel, rel_lower)
                if sub_rel is not None:
                    token_score = 80.0 + sub_rel

        if token_score is None:
            return None
        if token in name:
            token_score += 18.0
        total += token_score

    total -= min(len(name) * 0.35, 30.0)
    return total


def rank_quick_switcher(
    query: str,
    tabs: list[dict],
    recent: list[dict],
    folder: Path | None,
    *,
    active_id: str = "",
    cancel_event: threading.Event | None = None,
    folder_entries: list[dict] | None = None,
    max_results: int = MAX_QUICK_RESULTS,
) -> list[dict]:
    """Return ordered Quick Switcher items across pinned/recent notes, open tabs, and folder files."""
    by_key: dict[str, dict] = {}
    untitled_tabs: list[dict] = []

    for tab_order, tab in enumerate(tabs):
        tab_id = str(tab.get("id") or "")
        tab_path = str(tab.get("path") or "")
        name = str(tab.get("name") or (Path(tab_path).name if tab_path else "Untitled.md"))
        item = {
            "tabId": tab_id,
            "path": tab_path,
            "name": name,
            "relative": _relative_display(Path(tab_path), folder) if tab_path else "Unsaved tab",
            "dirty": bool(tab.get("dirty")),
            "active": tab_id == active_id and bool(active_id),
            "open": True,
            "pinned": False,
            "recentOrder": None,
            "tabOrder": tab_order,
        }
        if tab_path:
            by_key[canonical_note_key(tab_path)] = item
        else:
            untitled_tabs.append(item)

    for rec_order, rec in enumerate(recent):
        rec_path = str(rec.get("path") or "")
        if not rec_path:
            continue
        key = canonical_note_key(rec_path)
        pinned = bool(rec.get("pinned"))
        if key in by_key:
            by_key[key]["pinned"] = pinned
            by_key[key]["recentOrder"] = rec_order
            continue
        p = Path(rec_path)
        try:
            if p.is_symlink() or not p.is_file():
                continue
        except OSError:
            continue
        by_key[key] = {
            "tabId": "",
            "path": rec_path,
            "name": str(rec.get("name") or p.name),
            "relative": _relative_display(p, folder),
            "dirty": False,
            "active": False,
            "open": False,
            "pinned": pinned,
            "recentOrder": rec_order,
            "tabOrder": None,
        }

    entries = (
        folder_entries
        if folder_entries is not None
        else (walk_folder_notes(folder, cancel_event=cancel_event) if folder is not None else [])
    )
    for entry in entries:
        if cancel_event is not None and cancel_event.is_set():
            return []
        key = entry["key"]
        if key in by_key:
            if entry.get("relative"):
                by_key[key]["relative"] = entry["relative"]
            continue
        by_key[key] = {
            "tabId": "",
            "path": entry["path"],
            "name": entry["name"],
            "relative": entry["relative"],
            "dirty": False,
            "active": False,
            "open": False,
            "pinned": False,
            "recentOrder": None,
            "tabOrder": None,
        }

    candidates = untitled_tabs + list(by_key.values())
    cleaned = query.strip()
    if not cleaned:
        pinned_items = sorted(
            (c for c in candidates if c["pinned"]),
            key=lambda c: (c["recentOrder"] if c["recentOrder"] is not None else 999999, c["name"].lower()),
        )
        recent_items = sorted(
            (c for c in candidates if not c["pinned"] and c["recentOrder"] is not None),
            key=lambda c: c["recentOrder"],
        )
        open_only = sorted(
            (c for c in candidates if not c["pinned"] and c["recentOrder"] is None and c["open"]),
            key=lambda c: (0 if c["active"] else 1, c["tabOrder"] if c["tabOrder"] is not None else 999999),
        )
        folder_only = sorted(
            (c for c in candidates if not c["pinned"] and c["recentOrder"] is None and not c["open"]),
            key=lambda c: c["relative"].lower(),
        )
        return (pinned_items + recent_items + open_only + folder_only)[:max_results]

    scored: list[tuple[float, dict]] = []
    for item in candidates:
        if cancel_event is not None and cancel_event.is_set():
            return []
        base = fuzzy_note_score(cleaned, item["name"], item["relative"])
        if base is None:
            continue
        bonus = (16.0 if item["pinned"] else 0.0) + (12.0 if item["open"] else 0.0) + (8.0 if item["recentOrder"] is not None else 0.0)
        scored.append((base + bonus, item))

    scored.sort(key=lambda pair: (-pair[0], pair[1]["relative"].lower(), pair[1]["name"].lower()))
    return [pair[1] for pair in scored[:max_results]]


def _build_snippet(raw_line: str, match_start: int, match_end: int, max_len: int = 140) -> tuple[str, int, int]:
    """Create a compact display snippet around [match_start, match_end] with snippet-relative match indices."""
    expanded = raw_line.replace("\t", " ")
    leading = len(expanded) - len(expanded.lstrip(" "))
    trailing = len(expanded) - len(expanded.rstrip(" "))
    trim_start = min(leading, match_start)
    trim_end = max(match_end, len(expanded) - trailing)
    trimmed = expanded[trim_start:trim_end]
    rel_start = match_start - trim_start
    rel_end = match_end - trim_start

    if len(trimmed) <= max_len:
        return trimmed, rel_start, rel_end

    match_len = max(1, rel_end - rel_start)
    half = max(12, (max_len - match_len) // 2)
    win_start = max(0, rel_start - half)
    win_end = min(len(trimmed), win_start + max_len)
    if win_end - win_start < max_len:
        win_start = max(0, win_end - max_len)

    prefix = "…" if win_start > 0 else ""
    suffix = "…" if win_end < len(trimmed) else ""
    snippet = prefix + trimmed[win_start:win_end] + suffix
    new_start = len(prefix) + (rel_start - win_start)
    new_end = min(len(snippet), new_start + match_len)
    return snippet, new_start, new_end


def _scan_note_lines(
    content: str,
    needle: str,
    *,
    case_sensitive: bool,
    exclude_diagrams: bool,
    meta: dict,
    cancel_event: threading.Event | None,
    max_per_file: int = MAX_MATCHES_PER_FILE,
    remaining_budget: int = MAX_MATCHES_TOTAL,
) -> tuple[list[dict], bool]:
    """Scan a single note's Markdown text and return (matches, hit_budget_cap)."""
    if not content or not needle or remaining_budget <= 0:
        return [], False
    if len(content.encode("utf-8", errors="ignore")) > MAX_SEARCH_MARKDOWN_BYTES:
        return [], False

    searchable = mask_diagram_spans(content) if exclude_diagrams else content
    target_needle = needle if case_sensitive else needle.lower()
    needle_len = len(needle)
    raw_lines = content.splitlines()
    search_lines = searchable.splitlines()

    hits: list[dict] = []
    per_file_cap = min(max_per_file, remaining_budget)
    for line_idx, (raw_line, search_line) in enumerate(zip(raw_lines, search_lines), start=1):
        if cancel_event is not None and cancel_event.is_set():
            return hits, False
        haystack = search_line if case_sensitive else search_line.lower()
        pos = haystack.find(target_needle)
        while pos >= 0:
            snippet, m_start, m_end = _build_snippet(raw_line, pos, pos + needle_len)
            hits.append({
                "tabId": meta["tabId"],
                "path": meta["path"],
                "name": meta["name"],
                "relative": meta["relative"],
                "dirty": meta["dirty"],
                "open": meta["open"],
                "line": line_idx,
                "snippet": snippet,
                "matchStart": m_start,
                "matchEnd": m_end,
            })
            if len(hits) >= per_file_cap:
                more_in_file = haystack.find(target_needle, pos + max(1, needle_len)) >= 0 or line_idx < len(search_lines)
                return hits, len(hits) >= remaining_budget and more_in_file
            pos = haystack.find(target_needle, pos + max(1, needle_len))
    return hits, False


def stream_text_search(
    query: str,
    tabs: list[dict],
    recent: list[dict],
    folder: Path | None,
    *,
    active_id: str = "",
    case_sensitive: bool = False,
    exclude_diagrams: bool = True,
    cancel_event: threading.Event | None = None,
    on_batch: Callable[[list[dict], int, bool, bool], None] | None = None,
) -> dict:
    """Stream line-numbered cross-note matches across live open tabs, folder files, and recent notes."""
    if not query or not query.strip():
        if on_batch is not None:
            on_batch([], 0, False, True)
        return {"matches": [], "scannedFiles": 0, "truncated": False, "cancelled": False}

    needle = query
    all_matches: list[dict] = []
    pending_batch: list[dict] = []
    scanned_files = 0
    truncated = False
    last_emit = time.monotonic()

    def flush_batch(done: bool = False) -> None:
        nonlocal pending_batch, last_emit
        if on_batch is None:
            pending_batch = []
            return
        if pending_batch or done:
            batch = pending_batch
            pending_batch = []
            last_emit = time.monotonic()
            on_batch(batch, scanned_files, truncated, done)

    def maybe_flush() -> None:
        if len(pending_batch) >= STREAM_BATCH_SIZE or (pending_batch and time.monotonic() - last_emit >= STREAM_INTERVAL_SEC):
            flush_batch(done=False)

    seen_keys: set[str] = set()
    ordered_tabs = sorted(
        tabs,
        key=lambda t: (0 if str(t.get("id") or "") == active_id else 1),
    )

    # 1. Scan open tabs first using live in-memory buffers (unsaved edits beat disk).
    for tab in ordered_tabs:
        if cancel_event is not None and cancel_event.is_set():
            return {"matches": all_matches, "scannedFiles": scanned_files, "truncated": truncated, "cancelled": True}
        tab_id = str(tab.get("id") or "")
        tab_path = str(tab.get("path") or "")
        if tab_path:
            seen_keys.add(canonical_note_key(tab_path))
        content = str(tab.get("content") or "")
        scanned_files += 1
        budget = MAX_MATCHES_TOTAL - len(all_matches)
        if budget <= 0:
            truncated = True
            break
        meta = {
            "tabId": tab_id,
            "path": tab_path,
            "name": str(tab.get("name") or (Path(tab_path).name if tab_path else "Untitled.md")),
            "relative": _relative_display(Path(tab_path), folder) if tab_path else "Unsaved tab",
            "dirty": bool(tab.get("dirty")),
            "open": True,
        }
        hits, capped = _scan_note_lines(
            content,
            needle,
            case_sensitive=case_sensitive,
            exclude_diagrams=exclude_diagrams,
            meta=meta,
            cancel_event=cancel_event,
            remaining_budget=budget,
        )
        if hits:
            all_matches.extend(hits)
            pending_batch.extend(hits)
            maybe_flush()
        if capped or len(all_matches) >= MAX_MATCHES_TOTAL:
            truncated = True
            break

    # 2. Scan folder notes on disk (skipping dotfiles, symlinks, and already-scanned open tabs).
    if not truncated and folder is not None:
        entries = walk_folder_notes(folder, cancel_event=cancel_event)
        for entry in entries:
            if cancel_event is not None and cancel_event.is_set():
                return {"matches": all_matches, "scannedFiles": scanned_files, "truncated": truncated, "cancelled": True}
            key = entry["key"]
            if key in seen_keys:
                continue
            seen_keys.add(key)
            file_path = Path(entry["path"])
            markdown = read_searchable_markdown(file_path)
            if markdown is None:
                continue
            scanned_files += 1
            budget = MAX_MATCHES_TOTAL - len(all_matches)
            if budget <= 0:
                truncated = True
                break
            meta = {
                "tabId": "",
                "path": entry["path"],
                "name": entry["name"],
                "relative": entry["relative"],
                "dirty": False,
                "open": False,
            }
            hits, capped = _scan_note_lines(
                markdown,
                needle,
                case_sensitive=case_sensitive,
                exclude_diagrams=exclude_diagrams,
                meta=meta,
                cancel_event=cancel_event,
                remaining_budget=budget,
            )
            if hits:
                all_matches.extend(hits)
                pending_batch.extend(hits)
                maybe_flush()
            if capped or len(all_matches) >= MAX_MATCHES_TOTAL:
                truncated = True
                break

    # 3. Scan accessible recent notes not already covered by open tabs or open folder.
    if not truncated:
        for rec in recent:
            if cancel_event is not None and cancel_event.is_set():
                return {"matches": all_matches, "scannedFiles": scanned_files, "truncated": truncated, "cancelled": True}
            rec_path = str(rec.get("path") or "")
            if not rec_path:
                continue
            key = canonical_note_key(rec_path)
            if key in seen_keys:
                continue
            seen_keys.add(key)
            file_path = Path(rec_path)
            markdown = read_searchable_markdown(file_path)
            if markdown is None:
                continue
            scanned_files += 1
            budget = MAX_MATCHES_TOTAL - len(all_matches)
            if budget <= 0:
                truncated = True
                break
            meta = {
                "tabId": "",
                "path": rec_path,
                "name": str(rec.get("name") or file_path.name),
                "relative": _relative_display(file_path, folder),
                "dirty": False,
                "open": False,
            }
            hits, capped = _scan_note_lines(
                markdown,
                needle,
                case_sensitive=case_sensitive,
                exclude_diagrams=exclude_diagrams,
                meta=meta,
                cancel_event=cancel_event,
                remaining_budget=budget,
            )
            if hits:
                all_matches.extend(hits)
                pending_batch.extend(hits)
                maybe_flush()
            if capped or len(all_matches) >= MAX_MATCHES_TOTAL:
                truncated = True
                break

    if cancel_event is not None and cancel_event.is_set():
        return {"matches": all_matches, "scannedFiles": scanned_files, "truncated": truncated, "cancelled": True}

    flush_batch(done=True)
    return {"matches": all_matches, "scannedFiles": scanned_files, "truncated": truncated, "cancelled": False}


def _matches_filename_filter(tokens: list[str], name: str, relative: str) -> bool:
    name_low = name.lower()
    rel_low = relative.lower()
    return all(tok in name_low or tok in rel_low for tok in tokens)


def filter_folder_tree(
    folder: Path,
    query: str,
    *,
    cancel_event: threading.Event | None = None,
    max_entries: int = MAX_WALK_ENTRIES,
) -> list[dict]:
    """Recursively filter folder notes across all subfolders, hiding empty/non-matching directories."""
    cleaned = query.strip().lower()
    if not cleaned:
        return []
    tokens = cleaned.split()
    seen_entries = 0

    try:
        if not folder.exists() or folder.is_symlink() or not folder.is_dir():
            return []
        root_resolved = folder.resolve(strict=False)
    except OSError:
        return []

    def visit(directory: Path, depth: int) -> list[dict]:
        nonlocal seen_entries
        if depth > MAX_WALK_DEPTH or seen_entries >= max_entries:
            return []
        if cancel_event is not None and cancel_event.is_set():
            return []
        try:
            with os.scandir(directory) as it:
                entries = []
                for entry in it:
                    if entry.name.startswith("."):
                        continue
                    try:
                        if entry.is_symlink():
                            continue
                        is_dir = entry.is_dir(follow_symlinks=False)
                        is_file = not is_dir and entry.is_file(follow_symlinks=False)
                    except OSError:
                        continue
                    if not is_dir and not is_file:
                        continue
                    entries.append((entry.name, Path(entry.path), is_dir))
        except OSError:
            return []

        entries.sort(key=lambda item: (not item[2], item[0].lower()))
        rows: list[dict] = []
        for name, full_path, is_dir in entries:
            if cancel_event is not None and cancel_event.is_set():
                return []
            if seen_entries >= max_entries:
                break
            if is_dir:
                children = visit(full_path, depth + 1)
                if children:
                    rows.append({
                        "name": name,
                        "path": str(full_path),
                        "directory": True,
                        "depth": depth,
                        "expanded": True,
                    })
                    rows.extend(children)
            elif full_path.suffix.lower() in NOTE_EXTENSIONS:
                seen_entries += 1
                try:
                    rel = full_path.resolve(strict=False).relative_to(root_resolved).as_posix()
                except ValueError:
                    rel = name
                if _matches_filename_filter(tokens, name, rel):
                    rows.append({
                        "name": name,
                        "path": str(full_path),
                        "relative": rel,
                        "directory": False,
                        "depth": depth,
                        "expanded": False,
                    })
        return rows

    return visit(folder, 0)
