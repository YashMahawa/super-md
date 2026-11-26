"""Transport-independent Markdown patch validation and sequential application."""
from __future__ import annotations

import json
import re
import sys
from typing import Any

from .source_ops import AgentDocumentError

MAX_PATCH_OPERATIONS = 100
MAX_PATCH_BYTES = 64_000
MAX_AGENT_NOTE_BYTES = 20_000_000


def _patch_error(index: int, message: str) -> AgentDocumentError:
    return AgentDocumentError(f"operations[{index}]: {message}")


def validate_patch_operations(operations: list[dict[str, Any]]) -> None:
    """Validate the transport-independent patch envelope before either backend applies it."""
    if not isinstance(operations, list) or not 1 <= len(operations) <= MAX_PATCH_OPERATIONS:
        raise AgentDocumentError("Provide 1–100 patch operations")
    try:
        encoded = json.dumps(operations, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if len(encoded) > MAX_PATCH_BYTES:
            raise AgentDocumentError("Patch operations exceed 64 KB")
    except (TypeError, UnicodeError) as exc:
        raise AgentDocumentError("Patch operations must contain valid JSON text") from exc
    for index, operation in enumerate(operations):
        if not isinstance(operation, dict):
            raise _patch_error(index, "Each patch operation must be an object")
        kind = operation.get("type")
        allowed = (
            {"type", "old", "new", "count", "expectedCount"} if kind == "replace" else
            {"type", "start_line", "end_line", "text"} if kind == "lines" else
            {"type", "line", "text"} if kind == "insert" else {"type"}
        )
        unknown = next((key for key in operation if key not in allowed), None)
        if unknown is not None:
            expected = ", ".join(sorted(allowed))
            raise _patch_error(index, f"Unknown field '{unknown}'; expected {expected}")
        if kind == "replace":
            old, new = operation.get("old"), operation.get("new")
            if not isinstance(old, str) or not old:
                raise _patch_error(index, "replace.old must be non-empty text")
            if not isinstance(new, str):
                raise _patch_error(index, "replace.new must be text")
            expected_count = operation.get("expectedCount")
            if "expectedCount" in operation and (
                not isinstance(expected_count, int) or isinstance(expected_count, bool) or expected_count < 1
            ):
                raise _patch_error(index, "replace.expectedCount must be a positive integer")
            default_count = (
                "all"
                if isinstance(expected_count, int) and not isinstance(expected_count, bool) and expected_count > 1
                else 1
            )
            count = operation.get("count", default_count)
            if not ((isinstance(count, int) and not isinstance(count, bool) and count == 1) or count == "all"):
                raise _patch_error(index, "replace.count must be 1 or 'all'")
        elif kind == "lines":
            start, end, replacement = operation.get("start_line"), operation.get("end_line"), operation.get("text")
            if (
                not isinstance(start, int) or isinstance(start, bool)
                or not isinstance(end, int) or isinstance(end, bool)
                or start < 1 or end < start
            ):
                raise _patch_error(index, "Line range must be 1-based, inclusive, with end_line >= start_line")
            if not isinstance(replacement, str):
                raise _patch_error(index, "lines.text must be text")
        elif kind == "insert":
            line, replacement = operation.get("line"), operation.get("text")
            if not isinstance(line, int) or isinstance(line, bool) or line < 1:
                raise _patch_error(index, "insert.line must be a positive 1-based line number")
            if not isinstance(replacement, str):
                raise _patch_error(index, "insert.text must be text")
        else:
            raise _patch_error(index, "Patch type must be 'replace', 'lines' or 'insert'")


def _apply_replace(edited: str, operation: dict[str, Any], index: int) -> tuple[str, int, int]:
    old, replacement = operation["old"], operation["new"]
    expected_count = operation.get("expectedCount")
    count = operation.get("count", "all" if isinstance(expected_count, int) and expected_count > 1 else 1)
    occurrences = edited.count(old)
    if occurrences < 1 or (count == 1 and occurrences != 1) or (
        expected_count is not None and occurrences != expected_count
    ):
        expected = expected_count if expected_count is not None else ("one" if count == 1 else "at least one")
        raise _patch_error(index, f"Exact replacement expected {expected} match; found {occurrences}")
    start_index = edited.index(old)
    last_index = edited.rfind(old) if count == "all" else start_index
    updated = edited.replace(old, replacement, 1 if count == 1 else -1)
    return updated, start_index, last_index + len(old)


def _apply_insert(edited: str, parts: list[str], operation: dict[str, Any], index: int) -> tuple[str, int, int]:
    start = operation["line"]
    if start > len(parts) + 1:
        raise _patch_error(index, f"insert.line must be between 1 and {len(parts) + 1}")
    replacement = operation["text"]
    if start == len(parts) + 1 and parts and not re.search(r"[\r\n\v\f\x85\u2028\u2029]$", parts[-1]):
        delimiter = re.search(r"\r\n|[\r\n\v\f\x85\u2028\u2029]", edited)
        replacement = (delimiter.group(0) if delimiter else "\n") + replacement
    start_offset = sum(map(len, parts[:start - 1]))
    updated = "".join(parts[:start - 1]) + replacement + "".join(parts[start - 1:])
    return updated, start_offset, start_offset


def _apply_line_range(parts: list[str], operation: dict[str, Any], index: int) -> tuple[str, int, int]:
    start, end, replacement = operation["start_line"], operation["end_line"], operation["text"]
    if start > len(parts) + 1 or end > len(parts) + 1:
        raise _patch_error(index, "Line range must be 1-based, inclusive, with end_line <= line_count + 1")
    start_offset = sum(map(len, parts[:start - 1]))
    clamped_end = min(end, len(parts))
    end_offset = sum(map(len, parts[:clamped_end]))
    replacement_parts = replacement.splitlines(keepends=True)
    if replacement and not replacement.endswith(("\n", "\r")) and end <= len(parts):
        target = parts[start - 1:clamped_end]
        if target and target[-1].endswith("\n"):
            replacement_parts[-1] += "\n"
    updated = "".join(parts[:start - 1] + replacement_parts + parts[clamped_end:])
    return updated, start_offset, end_offset


def apply_patch_operations_detailed(
    source: str,
    operations: list[dict[str, Any]],
    *,
    _validated: bool = False,
) -> tuple[str, list[dict[str, Any]]]:
    """Apply a validated batch sequentially and report Unicode code-point ranges."""
    if not _validated:
        validate_patch_operations(operations)
    edited = source
    summaries: list[dict[str, Any]] = []
    for index, operation in enumerate(operations):
        previous = edited
        kind = operation["type"]
        if kind == "replace":
            edited, start_offset, end_offset = _apply_replace(edited, operation, index)
        else:
            parts = edited.splitlines(keepends=True)
            if not parts and edited == "":
                parts = []
            if kind == "insert":
                edited, start_offset, end_offset = _apply_insert(edited, parts, operation, index)
            else:
                edited, start_offset, end_offset = _apply_line_range(parts, operation, index)
        if len(edited.encode("utf-8")) > MAX_AGENT_NOTE_BYTES:
            raise _patch_error(index, "Edited Markdown exceeds the 20 MB limit")
        summaries.append({
            "operationIndex": index,
            "type": kind,
            "startOffset": start_offset,
            "endOffset": end_offset,
            "deltaChars": len(edited) - len(previous),
        })
    return edited, summaries


def apply_patch_operations(source: str, operations: list[dict[str, Any]]) -> str:
    """Apply patch operations sequentially and return only the updated Markdown source."""
    return apply_patch_operations_detailed(source, operations)[0]


_PEER_MODULE = (
    "agent.patches"
    if __name__ == "desktop.agent.patches"
    else ("desktop.agent.patches" if __name__ == "agent.patches" else None)
)
if _PEER_MODULE and _PEER_MODULE in sys.modules:
    sys.modules[__name__] = sys.modules[_PEER_MODULE]
