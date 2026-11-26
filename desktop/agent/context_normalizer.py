"""Stdlib-only reading and viewport context normalizers for MCP view_current."""
from __future__ import annotations

from typing import Any


def _bounded_text(value: Any, limit: int) -> str | None:
    return value[:limit] if isinstance(value, str) else None


def _safe_int(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def normalize_reading_context(context: dict[str, Any]) -> dict[str, Any]:
    """Repair prefix-relative visibleSource pagination using authoritative sourceLength."""
    source_length = _safe_int(context.get("sourceLength"))
    visible_source = context.get("visibleSource")
    if source_length is None or source_length < 0 or not isinstance(visible_source, dict):
        return dict(context)
    start, end = _safe_int(visible_source.get("start")), _safe_int(visible_source.get("end"))
    if start is None or end is None or start < 0 or end < start or end > source_length:
        return dict(context)
    return {
        **context,
        "visibleSource": {
            **visible_source,
            "total_chars": source_length,
            "next_offset": end if end < source_length else None,
            "truncated": end < source_length,
        },
    }


def bounded_diagrams(value: Any) -> list[dict[str, Any]] | None:
    """Bound visible diagram descriptors and strip inline data/base64 asset references."""
    if not isinstance(value, list):
        return None
    items: list[dict[str, Any]] = []
    for raw in value[:30]:
        if not isinstance(raw, dict):
            continue
        item: dict[str, Any] = {}
        for key, limit in (("id", 128), ("kind", 128), ("preview", 160), ("deckTitle", 200), ("stepLabel", 200)):
            text = _bounded_text(raw.get(key), limit)
            if text is not None:
                item[key] = text
        for key in ("sourceStart", "sourceEnd", "sourceChars"):
            num = _safe_int(raw.get(key))
            if num is not None:
                item[key] = num
        step_index = _safe_int(raw.get("stepIndex"))
        if step_index is not None and step_index >= 0:
            item["stepIndex"] = step_index
        step_count = _safe_int(raw.get("stepCount"))
        if step_count is not None and step_count >= 1:
            item["stepCount"] = step_count
        if isinstance(raw.get("activeStep"), bool):
            item["activeStep"] = raw["activeStep"]
        asset_ref = _bounded_text(raw.get("assetReference"), 512)
        if asset_ref is not None and not asset_ref.lower().startswith("data:") and "base64," not in asset_ref.lower():
            item["assetReference"] = asset_ref
        items.append(item)
    return items


def bounded_active_step(value: Any) -> dict[str, Any] | None:
    """Bound active walkthrough step metadata when valid."""
    if not isinstance(value, dict):
        return None
    deck_title = _bounded_text(value.get("deckTitle"), 200)
    step_index, step_count = _safe_int(value.get("stepIndex")), _safe_int(value.get("stepCount"))
    if deck_title is None or step_index is None or step_index < 0 or step_count is None or step_count < 1:
        return None
    result: dict[str, Any] = {
        "deckTitle": deck_title, "stepIndex": step_index,
        "stepCount": step_count, "activeStep": value.get("activeStep") is not False,
    }
    step_label = _bounded_text(value.get("stepLabel"), 200)
    if step_label is not None:
        result["stepLabel"] = step_label
    if isinstance(value.get("expanded"), bool):
        result["expanded"] = value["expanded"]
    return result


def bounded_python_cells(value: Any) -> list[dict[str, Any]] | None:
    """Bound Python cell execution summaries and figure IDs."""
    if not isinstance(value, list):
        return None
    cells: list[dict[str, Any]] = []
    for raw in value[:8]:
        if not isinstance(raw, dict) or not isinstance(raw.get("ok"), bool):
            continue
        entry: dict[str, Any] = {"ok": raw["ok"]}
        for key in ("ordinal", "sourceStart", "sourceEnd"):
            num = _safe_int(raw.get(key))
            if num is not None and num >= 0:
                entry[key] = num
        for stream, trunc_key in (("stdout", "stdoutTruncated"), ("stderr", "stderrTruncated")):
            text = _bounded_text(raw.get(stream), 500)
            if text is not None:
                entry[stream] = text
            if raw.get(trunc_key) is True or (isinstance(raw.get(stream), str) and len(raw[stream]) > 500):
                entry[trunc_key] = True
        if isinstance(raw.get("figureIds"), list):
            entry["figureIds"] = [
                fid for fid in raw["figureIds"]
                if isinstance(fid, str) and fid.startswith("diagram:python:") and len(fid) <= 128
            ][:16]
        cells.append(entry)
    return cells or None


def viewport_contexts(
    image: dict[str, Any], tab_id: str, expected_revision: str,
) -> tuple[dict[str, Any], dict[str, Any] | None]:
    """Extract bounded image-capture metadata and optional coherent readingContext."""
    nested = image.get("context") if isinstance(image.get("context"), dict) else None
    metadata = image.get("metadata") if isinstance(image.get("metadata"), dict) else None
    source = nested if nested is not None else image
    raw_tab_id = source.get("tabId") if isinstance(source.get("tabId"), str) and source.get("tabId") else (
        metadata.get("tabId") if metadata and isinstance(metadata.get("tabId"), str) else None
    )
    source_revision = source.get("revision")
    revision_matches = not isinstance(source_revision, str) or source_revision == expected_revision
    capture_ctx: dict[str, Any] = {
        "tabId": tab_id, "revision": expected_revision, "contextRevisionMatches": revision_matches,
    }
    if raw_tab_id and raw_tab_id != tab_id:
        capture_ctx["nativeTabId"] = raw_tab_id
    if isinstance(source_revision, str) and source_revision != expected_revision:
        capture_ctx["contextRevision"] = source_revision
    mode = _bounded_text(source.get("mode", metadata.get("mode") if metadata else None), 64)
    if mode is not None:
        capture_ctx["mode"] = mode
    zoom = source.get("zoom", metadata.get("zoom") if metadata else None)
    if isinstance(zoom, (int, float)) and not isinstance(zoom, bool):
        capture_ctx["zoom"] = zoom
    raw_reading = source.get("reading", metadata.get("reading") if metadata else None)
    if isinstance(raw_reading, dict):
        reading: dict[str, Any] = {
            key: raw_reading[key] for key in ("offset", "scrollFraction")
            if isinstance(raw_reading.get(key), (int, float)) and not isinstance(raw_reading.get(key), bool)
        }
        for key, limit in (("heading", 300), ("visibleText", 2000)):
            text = _bounded_text(raw_reading.get(key), limit)
            if text is not None:
                reading[key] = text
        capture_ctx["reading"] = reading
    raw_selection = source.get("selection", metadata.get("selection") if metadata else None)
    if isinstance(raw_selection, dict):
        sel_text = _bounded_text(raw_selection.get("text"), 2000)
        capture_ctx["selection"] = {} if sel_text is None else {"text": sel_text}
    raw_viewport = source.get("viewport", metadata.get("viewport") if metadata else None)
    if isinstance(raw_viewport, dict):
        capture_ctx["viewport"] = {
            key: raw_viewport[key]
            for key in ("x", "y", "width", "height", "viewportWidth", "viewportHeight", "devicePixelRatio")
            if isinstance(raw_viewport.get(key), (int, float)) and not isinstance(raw_viewport.get(key), bool)
        }
    active_step = bounded_active_step(source.get("activeStep", metadata.get("activeStep") if metadata else None))
    if active_step is not None:
        capture_ctx["activeStep"] = active_step
    source_length = _safe_int(source.get("sourceLength"))
    normalized_src = source.get("visibleSource")
    if source_length is not None and source_length >= 0 and isinstance(normalized_src, dict):
        normalized_src = normalize_reading_context(
            {"sourceLength": source_length, "visibleSource": normalized_src}
        ).get("visibleSource")
    visible_source: dict[str, Any] | None = None
    preview_truncated = False
    if isinstance(normalized_src, dict) and isinstance(normalized_src.get("text"), str):
        text_chars = normalized_src["text"]
        returned_text = text_chars[:12_000]
        preview_truncated = len(text_chars) > len(returned_text)
        visible_source = {"text": returned_text}
        source_range: dict[str, Any] = {}
        if preview_truncated:
            visible_source["previewTruncated"] = source_range["previewTruncated"] = True
        start = _safe_int(normalized_src.get("start"))
        for key in ("start", "end", "total_chars", "next_offset", "truncated", "view"):
            alt = normalized_src.get("totalChars") if key == "total_chars" else (
                normalized_src.get("nextOffset") if key == "next_offset" else None
            )
            field = normalized_src.get(key, alt)
            if key in ("end", "next_offset") and preview_truncated:
                if start is not None:
                    visible_source[key] = source_range[key] = start + len(returned_text)
            elif key == "truncated" and preview_truncated:
                visible_source[key] = source_range[key] = True
            elif (_safe_int(field) is not None or isinstance(field, bool)
                    or (key == "next_offset" and field is None)
                    or (key == "view" and isinstance(field, str))):
                visible_source[key] = source_range[key] = field
        if source_range:
            capture_ctx["sourceRange"] = source_range
    diagrams, python_cells = bounded_diagrams(source.get("diagrams")), bounded_python_cells(source.get("pythonCells"))
    coherent = (revision_matches and visible_source is not None and not preview_truncated
                and isinstance(source_revision, str) and source_revision == expected_revision)
    captured_reading: dict[str, Any] | None = None
    if coherent and visible_source is not None:
        captured_reading = {**capture_ctx, "visibleSource": visible_source}
        if source_length is not None and source_length >= 0:
            captured_reading["sourceLength"] = source_length
        if diagrams is not None:
            captured_reading["diagrams"] = diagrams
        if python_cells is not None:
            captured_reading["pythonCells"] = python_cells
    return capture_ctx, captured_reading


def normalize_initial_reading_context(
    raw_context: dict[str, Any], *, resolved_tab: str, target: str,
) -> dict[str, Any]:
    """Normalize and bound a raw get_context response for view_current."""
    normalized = normalize_reading_context(raw_context)
    if "diagrams" in normalized:
        bounded_diags = bounded_diagrams(normalized.get("diagrams"))
        if bounded_diags is not None:
            normalized["diagrams"] = bounded_diags
    for key, fn in (("activeStep", bounded_active_step), ("pythonCells", bounded_python_cells)):
        if key in normalized:
            bounded_val = fn(normalized.get(key))
            if bounded_val is not None:
                normalized[key] = bounded_val
            else:
                normalized.pop(key, None)
    raw_ctx_tab = normalized.get("tabId")
    reading_context = dict(normalized)
    if isinstance(raw_ctx_tab, str) and raw_ctx_tab and raw_ctx_tab != resolved_tab:
        reading_context["nativeTabId"] = raw_ctx_tab
    reading_context["tabId"] = resolved_tab
    reading_context["target"] = target
    return reading_context


_normalize_reading_context = normalize_reading_context
_bounded_diagrams = bounded_diagrams
_bounded_active_step = bounded_active_step
_bounded_python_cells = bounded_python_cells
_viewport_contexts = viewport_contexts
