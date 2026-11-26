"""Transport-independent Markdown patch validation and sequential application."""
from __future__ import annotations

import json
import re

try:
    from .source_ops import AgentDocumentError
except ImportError:
    from agent.source_ops import AgentDocumentError


def validate_patch_operations(operations: list[dict]) -> None:
    """Validate the transport-independent patch envelope before either backend applies it."""
    if not isinstance(operations, list) or not 1 <= len(operations) <= 100:
        raise AgentDocumentError("Provide 1–100 patch operations")
    try:
        if len(json.dumps(operations, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) > 64_000:
            raise AgentDocumentError("Patch operations exceed 64 KB")
    except (TypeError, UnicodeError) as exc:
        raise AgentDocumentError("Patch operations must contain valid JSON text") from exc
    for index, operation in enumerate(operations):
        fail = lambda message: AgentDocumentError(f"operations[{index}]: {message}")
        if not isinstance(operation, dict):
            raise fail("Each patch operation must be an object")
        kind = operation.get("type")
        allowed = ({"type", "old", "new", "count", "expectedCount"} if kind == "replace" else
                   {"type", "start_line", "end_line", "text"} if kind == "lines" else
                   {"type", "line", "text"} if kind == "insert" else {"type"})
        unknown = next((key for key in operation if key not in allowed), None)
        if unknown is not None:
            expected = ", ".join(sorted(allowed))
            raise fail(f"Unknown field '{unknown}'; expected {expected}")
        if kind == "replace":
            old, new = operation.get("old"), operation.get("new")
            if not isinstance(old, str) or not old:
                raise fail("replace.old must be non-empty text")
            if not isinstance(new, str):
                raise fail("replace.new must be text")
            expected_count = operation.get("expectedCount")
            if "expectedCount" in operation and (not isinstance(expected_count, int) or isinstance(expected_count, bool) or expected_count < 1):
                raise fail("replace.expectedCount must be a positive integer")
            count = operation.get("count", "all" if isinstance(expected_count, int) and not isinstance(expected_count, bool) and expected_count > 1 else 1)
            if not ((isinstance(count, int) and not isinstance(count, bool) and count == 1) or count == "all"):
                raise fail("replace.count must be 1 or 'all'")
        elif kind == "lines":
            start, end, replacement = operation.get("start_line"), operation.get("end_line"), operation.get("text")
            if (not isinstance(start, int) or isinstance(start, bool) or
                    not isinstance(end, int) or isinstance(end, bool) or start < 1 or end < start):
                raise fail("Line range must be 1-based, inclusive, with end_line >= start_line")
            if not isinstance(replacement, str):
                raise fail("lines.text must be text")
        elif kind == "insert":
            line, replacement = operation.get("line"), operation.get("text")
            if not isinstance(line, int) or isinstance(line, bool) or line < 1:
                raise fail("insert.line must be a positive 1-based line number")
            if not isinstance(replacement, str):
                raise fail("insert.text must be text")
        else:
            raise fail("Patch type must be 'replace', 'lines' or 'insert'")


def apply_patch_operations_detailed(source: str, operations: list[dict]) -> tuple[str, list[dict]]:
    """Apply a validated batch sequentially and report Unicode code-point ranges."""
    validate_patch_operations(operations)
    edited = source
    summaries = []
    for index, operation in enumerate(operations):
        previous = edited
        kind = operation["type"]
        if kind == "replace":
            old, replacement = operation["old"], operation["new"]
            expected_count = operation.get("expectedCount")
            count = operation.get("count", "all" if isinstance(expected_count, int) and expected_count > 1 else 1)
            occurrences = edited.count(old)
            if occurrences < 1 or (count == 1 and occurrences != 1) or (expected_count is not None and occurrences != expected_count):
                expected = expected_count if expected_count is not None else ("one" if count == 1 else "at least one")
                raise AgentDocumentError(f"operations[{index}]: Exact replacement expected {expected} match; found {occurrences}")
            start_index = edited.index(old)
            last_index = edited.rfind(old) if count == "all" else start_index
            start_offset, end_offset = start_index, last_index + len(old)
            edited = edited.replace(old, replacement, 1 if count == 1 else -1)
        else:
            parts = edited.splitlines(keepends=True)
            if not parts and edited == "":
                parts = []
            if kind == "insert":
                start = operation["line"]
                if start > len(parts) + 1:
                    raise AgentDocumentError(f"operations[{index}]: insert.line must be between 1 and {len(parts) + 1}")
                end = start
                replacement = operation["text"]
                if start == len(parts) + 1 and parts and not re.search(r"[\r\n\v\f\x85\u2028\u2029]$", parts[-1]):
                    delimiter = re.search(r"\r\n|[\r\n\v\f\x85\u2028\u2029]", edited)
                    replacement = (delimiter.group(0) if delimiter else "\n") + replacement
                start_offset = sum(map(len, parts[:start - 1]))
                end_offset = start_offset
                edited = "".join(parts[:start - 1]) + replacement + "".join(parts[start - 1:])
            else:
                start, end, replacement = operation["start_line"], operation["end_line"], operation["text"]
                if start > len(parts) + 1 or end > len(parts) + 1:
                    raise AgentDocumentError(f"operations[{index}]: Line range must be 1-based, inclusive, with end_line <= line_count + 1")
                start_offset = sum(map(len, parts[:start - 1]))
                end_offset = sum(map(len, parts[:min(end, len(parts))]))
                replacement_parts = replacement.splitlines(keepends=True)
                if replacement and not replacement.endswith(("\n", "\r")) and end <= len(parts):
                    target = parts[start - 1:min(end, len(parts))]
                    if target and target[-1].endswith("\n"):
                        replacement_parts[-1] += "\n"
                edited = "".join(parts[:start - 1] + replacement_parts + parts[min(end, len(parts)):])
        if len(edited.encode("utf-8")) > 20_000_000:
            raise AgentDocumentError(f"operations[{index}]: Edited Markdown exceeds the 20 MB limit")
        summaries.append({"operationIndex": index, "type": kind, "startOffset": start_offset,
                          "endOffset": end_offset, "deltaChars": len(edited) - len(previous)})
    return edited, summaries
