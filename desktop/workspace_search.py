"""Streaming cross-note text search with source-offset-preserving case folding and UTF-16 UI spans."""
from __future__ import annotations

from collections import deque
from concurrent.futures import Future, ThreadPoolExecutor
from contextlib import closing
from dataclasses import dataclass, field
import os
import threading
from pathlib import Path
from typing import Callable, Iterator

from agent_documents import diagram_spans
import documents

KNOWN_NOTE_SUFFIXES = (".markdown", ".smd", ".fmd", ".qmd", ".rmd", ".md", ".txt")
MAX_WALK_ENTRIES = 10_000
MAX_FOLDER_DEPTH = 32
MAX_SEARCH_MATCHES = 500
MAX_MATCHES_PER_NOTE = 50
SNIPPET_MAX_CHARS = 140
BATCH_SIZE = 20
SEARCH_WORKERS = 4
SEARCH_CHUNK_SIZE = 16
SEARCH_WINDOW_CHUNKS = 4
_SEARCH_EXECUTOR = ThreadPoolExecutor(max_workers=SEARCH_WORKERS, thread_name_prefix="supermd-search")


def is_searchable_note_name(name: str) -> bool:
    if not name or name.startswith("."):
        return False
    dot = name.rfind(".")
    if dot <= 0:
        return False
    return name[dot:].lower() in KNOWN_NOTE_SUFFIXES


def canonical_note_key(path: str | Path) -> str:
    try:
        resolved = Path(path).expanduser().resolve(strict=False)
        return os.path.normcase(str(resolved))
    except OSError:
        return os.path.normcase(str(path))


def walk_folder_notes(
    folder_root: Path | None,
    *,
    cancel_event: threading.Event | None = None,
    max_entries: int = MAX_WALK_ENTRIES,
) -> list[dict]:
    """Recursively list supported note files under `folder_root`, skipping dotfiles and symlinks."""
    if folder_root is None:
        return []
    try:
        if folder_root.is_symlink() or getattr(folder_root, "is_junction", lambda: False)() or not folder_root.is_dir():
            return []
        root_str = str(folder_root.resolve())
    except OSError:
        return []

    results: list[dict] = []
    stack: list[tuple[str, str, int]] = [(root_str, "", 0)]
    while stack and len(results) < max_entries:
        if cancel_event is not None and cancel_event.is_set():
            return results
        current_dir, rel_prefix, depth = stack.pop()
        if depth > MAX_FOLDER_DEPTH:
            continue
        try:
            with os.scandir(current_dir) as entries:
                dir_items = list(entries)
        except OSError:
            continue

        subdirs: list[tuple[str, str, str]] = []
        files: list[os.DirEntry[str]] = []
        for entry in dir_items:
            if cancel_event is not None and cancel_event.is_set():
                return results
            ename = entry.name
            if ename.startswith("."):
                continue
            try:
                if entry.is_symlink() or getattr(entry, "is_junction", lambda: False)():
                    continue
                if entry.is_dir(follow_symlinks=False):
                    sub_rel = f"{rel_prefix}/{ename}" if rel_prefix else ename
                    subdirs.append((ename.lower(), entry.path, sub_rel))
                elif entry.is_file(follow_symlinks=False) and is_searchable_note_name(ename):
                    files.append(entry)
            except OSError:
                continue

        files.sort(key=lambda e: e.name.lower())
        for entry in files:
            if len(results) >= max_entries:
                break
            ename = entry.name
            epath = entry.path
            rel = f"{rel_prefix}/{ename}" if rel_prefix else ename
            results.append({
                "name": ename,
                "path": epath,
                "relative": rel,
                "canonicalKey": os.path.normcase(epath),
            })

        subdirs.sort(key=lambda item: item[0], reverse=True)
        next_depth = depth + 1
        for _, sub_path, sub_rel in subdirs:
            stack.append((sub_path, sub_rel, next_depth))
    return results


def mask_diagram_spans(text: str) -> str:
    """Replace diagram/SVG spans with NUL code points while preserving line breaks and source offsets."""
    spans = diagram_spans(text, include_inline_svg=True)
    if not spans:
        return text
    pieces: list[str] = []
    cursor = 0
    for span in spans:
        start, end = span["start"], span["end"]
        if start > cursor:
            pieces.append(text[cursor:start])
        if end > cursor:
            segment = text[max(cursor, start):end]
            pieces.append("".join(ch if ch in "\r\n" else "\0" for ch in segment))
            cursor = end
    if cursor < len(text):
        pieces.append(text[cursor:])
    return "".join(pieces)


def utf16_offset(text: str, cp_index: int) -> int:
    """Convert a Python code-point offset in `text` into UTF-16 code units (for QML/JavaScript)."""
    clamped = max(0, min(cp_index, len(text)))
    if text.isascii():
        return clamped
    return len(text[:clamped].encode("utf-16-le", errors="surrogatepass")) // 2


def fold_with_offsets(text: str) -> tuple[str, list[int], list[int]]:
    """Case-normalize `text` while mapping each folded code point back to `[orig_start, orig_end)`."""
    parts: list[str] = []
    starts: list[int] = []
    ends: list[int] = []
    for idx, ch in enumerate(text):
        folded = ch.casefold()
        if not folded:
            continue
        parts.append(folded)
        for _ in range(len(folded)):
            starts.append(idx)
            ends.append(idx + 1)
    return "".join(parts), starts, ends


def _build_snippet(raw_line: str, match_start: int, match_end: int) -> tuple[str, int, int]:
    """Return `(snippet, utf16_match_start, utf16_match_end)` around `[match_start, match_end)`."""
    lead = len(raw_line) - len(raw_line.lstrip(" \t"))
    trail_stripped = raw_line.rstrip(" \t\r\n")
    effective = trail_stripped[lead:]
    adj_start = max(0, match_start - lead)
    adj_end = max(adj_start, min(len(effective), match_end - lead))

    if len(effective) <= SNIPPET_MAX_CHARS:
        return effective, utf16_offset(effective, adj_start), utf16_offset(effective, adj_end)

    match_len = max(1, adj_end - adj_start)
    context_before = max(16, (SNIPPET_MAX_CHARS - match_len) // 2)
    win_start = max(0, adj_start - context_before)
    win_end = min(len(effective), win_start + SNIPPET_MAX_CHARS)
    if win_end - win_start < SNIPPET_MAX_CHARS:
        win_start = max(0, win_end - SNIPPET_MAX_CHARS)

    prefix = "…" if win_start > 0 else ""
    suffix = "…" if win_end < len(effective) else ""
    body = effective[win_start:win_end]
    snippet = f"{prefix}{body}{suffix}"
    cp_start = len(prefix) + (adj_start - win_start)
    cp_end = len(prefix) + min(len(body), adj_end - win_start)
    return snippet, utf16_offset(snippet, cp_start), utf16_offset(snippet, cp_end)


def _find_direct_line_matches(haystack: str, needle: str) -> list[tuple[int, int]]:
    spans: list[tuple[int, int]] = []
    nlen = len(needle)
    step = max(1, nlen)
    cursor = 0
    while len(spans) < MAX_MATCHES_PER_NOTE:
        pos = haystack.find(needle, cursor)
        if pos < 0:
            break
        spans.append((pos, pos + nlen))
        cursor = pos + step
    return spans


def _find_line_matches(search_line: str, query: str, *, folded_needle: str, case_sensitive: bool) -> list[tuple[int, int]]:
    """Return non-overlapping `(orig_start, orig_end)` code-point spans in `search_line`."""
    if case_sensitive:
        return _find_direct_line_matches(search_line, query)

    if search_line.isascii() and folded_needle.isascii():
        return _find_direct_line_matches(search_line.lower(), folded_needle)

    spans: list[tuple[int, int]] = []

    haystack, starts, ends = fold_with_offsets(search_line)
    if not folded_needle or not haystack:
        return spans
    nlen = len(folded_needle)
    total = len(starts)
    f_cursor = 0
    while len(spans) < MAX_MATCHES_PER_NOTE:
        f_pos = haystack.find(folded_needle, f_cursor)
        if f_pos < 0:
            break
        f_end = f_pos + nlen
        on_start = f_pos == 0 or starts[f_pos] != starts[f_pos - 1]
        on_end = f_end == total or starts[f_end] != starts[f_end - 1]
        if not (on_start and on_end):
            f_cursor = f_pos + 1
            continue
        orig_start = starts[f_pos]
        orig_end = ends[f_end - 1]
        spans.append((orig_start, orig_end))
        f_cursor = f_end
        while f_cursor < total and starts[f_cursor] < orig_end:
            f_cursor += 1
    return spans


def _might_contain_needle(markdown: str, query: str, folded_needle: str, case_sensitive: bool) -> bool:
    if "\x00" in query or "\x00" in folded_needle:
        return True
    if case_sensitive:
        return query in markdown
    if markdown.isascii() and folded_needle.isascii():
        return folded_needle in markdown.lower()
    return folded_needle in markdown.casefold()


def _scan_note_lines(
    markdown: str,
    query: str,
    *,
    folded_needle: str,
    case_sensitive: bool,
    exclude_diagrams: bool,
    note_meta: dict,
    remaining_budget: int,
    cancel_event: threading.Event | None = None,
) -> tuple[list[dict], bool]:
    if not markdown or not query or remaining_budget <= 0:
        return [], False
    if not _might_contain_needle(markdown, query, folded_needle, case_sensitive):
        return [], False
    searchable = mask_diagram_spans(markdown) if exclude_diagrams else markdown
    raw_lines = markdown.splitlines()
    search_lines = searchable.splitlines()
    matches: list[dict] = []
    truncated = False
    limit = min(MAX_MATCHES_PER_NOTE, remaining_budget)

    for idx, search_line in enumerate(search_lines):
        if cancel_event is not None and cancel_event.is_set():
            return matches, False
        raw_line = raw_lines[idx] if idx < len(raw_lines) else search_line
        for orig_start, orig_end in _find_line_matches(
            search_line,
            query,
            folded_needle=folded_needle,
            case_sensitive=case_sensitive,
        ):
            if len(matches) >= limit:
                if len(matches) >= remaining_budget:
                    truncated = True
                break
            snippet, u16_start, u16_end = _build_snippet(raw_line, orig_start, orig_end)
            matches.append({
                "key": f"{note_meta['key']}:{idx + 1}:{orig_start}",
                "tabId": note_meta.get("tabId") or "",
                "path": note_meta.get("path") or "",
                "name": note_meta["name"],
                "relative": note_meta["relative"],
                "dirty": bool(note_meta.get("dirty")),
                "isOpen": bool(note_meta.get("isOpen")),
                "line": idx + 1,
                "column": utf16_offset(raw_line, orig_start) + 1,
                "snippet": snippet,
                "matchStart": u16_start,
                "matchEnd": u16_end,
            })
        if truncated:
            break
    return matches, truncated


def _resolve_folder_root(folder_root: Path | None) -> Path | None:
    if folder_root is None:
        return None
    try:
        if (
            not folder_root.is_symlink()
            and not getattr(folder_root, "is_junction", lambda: False)()
            and folder_root.is_dir()
        ):
            return folder_root.resolve()
    except OSError:
        pass
    return None


def _relative_note_label(path_str: str, fallback: str, resolved_root: Path | None) -> str:
    if not path_str:
        return fallback
    if resolved_root is not None:
        try:
            return Path(path_str).resolve(strict=False).relative_to(resolved_root).as_posix()
        except (OSError, ValueError):
            pass
    return Path(path_str).name or fallback


def _note_meta(
    *,
    key: str,
    name: str,
    relative: str,
    tab_id: str = "",
    path: str = "",
    dirty: bool = False,
    is_open: bool = False,
) -> dict:
    return {
        "key": key,
        "tabId": tab_id,
        "path": path,
        "name": name,
        "relative": relative,
        "dirty": dirty,
        "isOpen": is_open,
    }


def _iter_searchable_notes(
    tabs_snapshot: list[dict],
    recent_snapshot: list[dict],
    resolved_root: Path | None,
    *,
    active_id: str,
    cancel_event: threading.Event | None = None,
) -> Iterator[tuple[str, dict]]:
    """Yield `(markdown, note_meta)` in search precedence order: active tab, open tabs, then folder or recents."""
    ordered_tabs = sorted(tabs_snapshot, key=lambda t: (0 if t.get("id") == active_id else 1))
    seen_paths: set[str] = set()

    for tab in ordered_tabs:
        if cancel_event is not None and cancel_event.is_set():
            return
        path = tab.get("path") or ""
        note_key = canonical_note_key(path) if path else ""
        if note_key:
            seen_paths.add(note_key)
        tab_id = tab.get("id") or ""
        name = tab.get("name") or (Path(path).name if path else "Untitled.md")
        yield (
            tab.get("content") or "",
            _note_meta(
                key=note_key if path else f"tab:{tab_id}",
                tab_id=tab_id,
                path=path,
                name=name,
                relative=_relative_note_label(path, name, resolved_root),
                dirty=bool(tab.get("dirty")),
                is_open=True,
            ),
        )

    if cancel_event is not None and cancel_event.is_set():
        return

    disk_candidates: list[dict] = []
    if resolved_root is not None:
        disk_candidates = walk_folder_notes(resolved_root, cancel_event=cancel_event)
    else:
        for recent in sorted(recent_snapshot, key=lambda x: (0 if x.get("pinned") else 1)):
            rpath = recent.get("path") or ""
            if rpath:
                disk_candidates.append({
                    "path": rpath,
                    "name": recent.get("name") or Path(rpath).name,
                    "relative": Path(rpath).name,
                })

    deduped_candidates: list[dict] = []
    for entry in disk_candidates:
        if cancel_event is not None and cancel_event.is_set():
            return
        epath = entry["path"]
        key = entry.get("canonicalKey") or canonical_note_key(epath)
        if key in seen_paths:
            continue
        seen_paths.add(key)
        deduped_candidates.append(
            _note_meta(
                key=key,
                path=epath,
                name=entry["name"],
                relative=entry.get("relative") or entry["name"],
            )
        )

    if not deduped_candidates:
        return
    if len(deduped_candidates) == 1:
        meta = deduped_candidates[0]
        markdown = documents.read_searchable_markdown(meta["path"])
        if markdown is not None:
            yield markdown, meta
        return

    stop_workers = threading.Event()

    def _read_disk_chunk(chunk: list[dict]) -> list[tuple[str | None, dict]]:
        out: list[tuple[str | None, dict]] = []
        for meta in chunk:
            if stop_workers.is_set() or (cancel_event is not None and cancel_event.is_set()):
                break
            out.append((documents.read_searchable_markdown(meta["path"]), meta))
        return out

    chunks: list[list[dict]] = []
    cursor_idx = 0
    ramp = (2, 4, 8)
    step_idx = 0
    total_candidates = len(deduped_candidates)
    while cursor_idx < total_candidates:
        step = ramp[step_idx] if step_idx < len(ramp) else SEARCH_CHUNK_SIZE
        step_idx += 1
        chunks.append(deduped_candidates[cursor_idx : cursor_idx + step])
        cursor_idx += step

    inflight: deque[Future[list[tuple[str | None, dict]]]] = deque()
    next_chunk_idx = 0

    def _submit_window() -> None:
        nonlocal next_chunk_idx
        while len(inflight) < SEARCH_WINDOW_CHUNKS and next_chunk_idx < len(chunks):
            if stop_workers.is_set() or (cancel_event is not None and cancel_event.is_set()):
                break
            chunk = chunks[next_chunk_idx]
            next_chunk_idx += 1
            inflight.append(_SEARCH_EXECUTOR.submit(_read_disk_chunk, chunk))

    try:
        _submit_window()
        while inflight:
            if cancel_event is not None and cancel_event.is_set():
                return
            fut = inflight.popleft()
            _submit_window()
            for markdown, meta in fut.result():
                if cancel_event is not None and cancel_event.is_set():
                    return
                if markdown is None:
                    continue
                yield markdown, meta
    finally:
        stop_workers.set()
        for pending_fut in inflight:
            pending_fut.cancel()
        for pending_fut in inflight:
            if not pending_fut.cancelled():
                try:
                    pending_fut.result()
                except Exception:
                    pass


@dataclass
class _SearchStream:
    query: str
    folded_needle: str
    case_sensitive: bool
    exclude_diagrams: bool
    max_matches: int
    cancel_event: threading.Event | None = None
    on_batch: Callable[[list[dict], int, bool, bool], None] | None = None
    all_matches: list[dict] = field(default_factory=list)
    pending_batch: list[dict] = field(default_factory=list)
    scanned_files: int = 0
    truncated: bool = False

    def is_cancelled(self) -> bool:
        return self.cancel_event is not None and self.cancel_event.is_set()

    def flush(self, *, done: bool = False) -> None:
        if self.on_batch is not None and (self.pending_batch or done):
            batch = self.pending_batch
            self.pending_batch = []
            self.on_batch(batch, self.scanned_files, self.truncated, done)

    def scan_note(self, markdown: str, note_meta: dict) -> bool:
        """Scan one note, emit full batches, and return True when `max_matches` is reached."""
        self.scanned_files += 1
        found, hit_cap = _scan_note_lines(
            markdown,
            self.query,
            folded_needle=self.folded_needle,
            case_sensitive=self.case_sensitive,
            exclude_diagrams=self.exclude_diagrams,
            note_meta=note_meta,
            remaining_budget=self.max_matches - len(self.all_matches),
            cancel_event=self.cancel_event,
        )
        if found:
            self.all_matches.extend(found)
            self.pending_batch.extend(found)
            if len(self.pending_batch) >= BATCH_SIZE:
                self.flush(done=False)
        if hit_cap or len(self.all_matches) >= self.max_matches:
            self.truncated = True
            return True
        return False

    def finish(self, *, cancelled: bool = False) -> dict:
        if not cancelled:
            self.flush(done=True)
        return {
            "matches": self.all_matches,
            "scannedFiles": self.scanned_files,
            "truncated": self.truncated,
            "cancelled": cancelled,
        }


def stream_text_search(
    query: str,
    tabs_snapshot: list[dict],
    recent_snapshot: list[dict],
    folder_root: Path | None,
    *,
    active_id: str = "",
    case_sensitive: bool = False,
    exclude_diagrams: bool = True,
    cancel_event: threading.Event | None = None,
    on_batch: Callable[[list[dict], int, bool, bool], None] | None = None,
    max_matches: int = MAX_SEARCH_MATCHES,
) -> dict:
    """Stream cross-note matches across open tabs and folder/recent notes without disk indexing."""
    if not query or not query.strip():
        if on_batch is not None:
            on_batch([], 0, False, True)
        return {"matches": [], "scannedFiles": 0, "truncated": False, "cancelled": False}

    resolved_root = _resolve_folder_root(folder_root)
    stream = _SearchStream(
        query=query,
        folded_needle=query if case_sensitive else query.casefold(),
        case_sensitive=case_sensitive,
        exclude_diagrams=exclude_diagrams,
        max_matches=max_matches,
        cancel_event=cancel_event,
        on_batch=on_batch,
    )
    with closing(
        _iter_searchable_notes(
            tabs_snapshot,
            recent_snapshot,
            resolved_root,
            active_id=active_id,
            cancel_event=cancel_event,
        )
    ) as searchable_notes:
        for markdown, meta in searchable_notes:
            if stream.scan_note(markdown, meta) or stream.is_cancelled():
                break

    if stream.is_cancelled():
        return stream.finish(cancelled=True)
    return stream.finish()
