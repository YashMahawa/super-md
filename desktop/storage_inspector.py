"""Bounded, read-only inventory of known Super MD app-data categories.

This deliberately does not discover directories or follow symlinks. It is an
inventory, not a cleanup mechanism: recovery and execution data are preserved.
"""
from __future__ import annotations

import os
import stat
from pathlib import Path


MAX_DEPTH = 4
MAX_ENTRIES = 20_000

# The paths are fixed by the application. Keep them out of returned reports:
# they can contain private filenames, even though all roots are app-owned.
CATEGORIES = (
    ("recovery", "Recovery", "preserved", ("closed-notes", "reader-conflicts"), ("recovery.json",)),
    ("execution-results", "Python execution results", "preserved", ("derived-python",), ()),
    ("python-runtime", "Managed Python runtime", "managed", ("python-env",), ()),
    ("fonts-themes", "Fonts and themes", "preserved", ("fonts",), ("theme.json", "theme-source.json")),
    ("workspace", "Workspace settings", "preserved", (), ("settings.json", "startup.json", "reading-positions.json")),
    ("update-state", "Update verification state", "preserved", ("updates",), ()),
)


def inspect_storage(root: str | os.PathLike[str], cancel_event=None, *,
                    max_entries: int = MAX_ENTRIES, max_depth: int = MAX_DEPTH) -> dict:
    """Return category bytes/file counts without following links or exposing paths.

    `cancel_event` may be a threading.Event. Scan limits are keyword-overridable
    to keep boundary behavior testable; callers should otherwise use defaults.
    Any inaccessible entry, cancellation, or exceeded bound produces a partial
    report rather than a misleading complete one.
    """
    if not isinstance(max_entries, int) or isinstance(max_entries, bool) or max_entries < 1:
        raise ValueError("max_entries must be a positive integer")
    if not isinstance(max_depth, int) or isinstance(max_depth, bool) or max_depth < 0:
        raise ValueError("max_depth must be a non-negative integer")

    root_path = Path(root)
    partial = False
    cancelled = False
    truncated = False
    scanned = 0

    def is_cancelled():
        return bool(cancel_event is not None and cancel_event.is_set())

    def add_file(path: Path, totals: list[int]) -> None:
        nonlocal partial, scanned, cancelled, truncated
        if is_cancelled():
            cancelled = partial = True
            return
        if scanned >= max_entries:
            truncated = partial = True
            return
        scanned += 1
        try:
            info = path.lstat()
        except FileNotFoundError:
            return
        except OSError:
            partial = True
            return
        if stat.S_ISREG(info.st_mode):
            totals[0] += info.st_size
            totals[1] += 1

    def add_directory(path: Path, totals: list[int]) -> None:
        nonlocal partial, scanned, cancelled, truncated
        stack = [(path, 0)]
        while stack:
            if is_cancelled():
                cancelled = partial = True
                return
            directory, depth = stack.pop()
            try:
                # scandir is deliberately scoped to explicit category roots.
                with os.scandir(directory) as entries:
                    for entry in entries:
                        if is_cancelled():
                            cancelled = partial = True
                            return
                        if scanned >= max_entries:
                            truncated = partial = True
                            return
                        scanned += 1
                        try:
                            info = entry.stat(follow_symlinks=False)
                        except OSError:
                            partial = True
                            continue
                        if stat.S_ISLNK(info.st_mode):
                            continue
                        if stat.S_ISREG(info.st_mode):
                            totals[0] += info.st_size
                            totals[1] += 1
                        elif stat.S_ISDIR(info.st_mode):
                            if depth < max_depth:
                                stack.append((Path(entry.path), depth + 1))
                            else:
                                # A directory at the scan boundary may contain
                                # unseen files, so don't report a complete sum.
                                partial = True
            except OSError:
                partial = True

    try:
        root_info = root_path.lstat()
        if not stat.S_ISDIR(root_info.st_mode):
            partial = True
            root_path = None
    except OSError:
        # Missing app data is a valid empty inventory; no traversal is needed.
        root_path = None

    categories = []
    for category_id, label, classification, directories, files in CATEGORIES:
        totals = [0, 0]
        if root_path is not None:
            for name in files:
                add_file(root_path / name, totals)
            for name in directories:
                if is_cancelled():
                    cancelled = partial = True
                    break
                if scanned >= max_entries:
                    truncated = partial = True
                    break
                path = root_path / name
                try:
                    info = path.lstat()
                except FileNotFoundError:
                    continue
                except OSError:
                    partial = True
                    continue
                scanned += 1
                if stat.S_ISDIR(info.st_mode):
                    add_directory(path, totals)
                elif stat.S_ISREG(info.st_mode):
                    totals[0] += info.st_size
                    totals[1] += 1
        categories.append({
            "id": category_id,
            "label": label,
            "classification": classification,
            "bytes": totals[0],
            "files": totals[1],
        })

    return {
        "status": "partial" if partial else "complete",
        "cancelled": cancelled,
        "truncated": truncated,
        "scannedEntries": scanned,
        "categories": categories,
    }
