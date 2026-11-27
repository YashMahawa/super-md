"""Stdlib-only reading and viewport context normalizers for MCP view_current."""
from __future__ import annotations

import sys
from typing import Any


def _bounded_text(value: Any, limit: int) -> str | None:
    return value[:limit] if isinstance(value, str) else None


def _safe_int(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def bounded_properties(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    out: dict[str, Any] = {}
    if (raw_title := _bounded_text(value.get("title"), 300)) and raw_title.strip():
        out["title"] = raw_title.strip()
    raw_authors = value.get("authors") if isinstance(value.get("authors"), list) else []
    authors = [item.strip()[:200] for item in raw_authors if isinstance(item, str) and item.strip()][:20]
    clean_author = (_bounded_text(value.get("author"), 500) or "").strip()
    if authors:
        out["authors"], out["author"] = authors, clean_author or ", ".join(authors)[:500]
    elif clean_author:
        out["author"], out["authors"] = clean_author, [clean_author[:200]]
    raw_tags = value.get("tags") if isinstance(value.get("tags"), list) else []
    if tags := [item.strip()[:100] for item in raw_tags if isinstance(item, str) and item.strip()][:50]:
        out["tags"] = tags
    return out or None


def normalize_reading_context(context: dict[str, Any]) -> dict[str, Any]:
    base = dict(context)
    if "properties" in base:
        if (bounded_props := bounded_properties(base.get("properties"))) is not None:
            base["properties"] = bounded_props
        else:
            base.pop("properties", None)
    source_length, visible_source = _safe_int(base.get("sourceLength")), base.get("visibleSource")
    if source_length is None or source_length < 0 or not isinstance(visible_source, dict):
        return base
    start, end = _safe_int(visible_source.get("start")), _safe_int(visible_source.get("end"))
    if start is None or end is None or start < 0 or end < start or end > source_length:
        return base
    vs = {**visible_source, "total_chars": source_length, "next_offset": end if end < source_length else None, "truncated": end < source_length}
    return {**base, "visibleSource": vs}


def bounded_diagrams(value: Any) -> list[dict[str, Any]] | None:
    if not isinstance(value, list):
        return None
    items: list[dict[str, Any]] = []
    for raw in value[:30]:
        if not isinstance(raw, dict):
            continue
        item: dict[str, Any] = {k: raw[k][:lim] for k, lim in (("id", 128), ("kind", 128), ("preview", 160), ("deckTitle", 200), ("stepLabel", 200)) if isinstance(raw.get(k), str)}
        item.update({k: raw[k] for k in ("sourceStart", "sourceEnd", "sourceChars") if _safe_int(raw.get(k)) is not None})
        item.update({k: raw[k] for k, mn in (("stepIndex", 0), ("stepCount", 1)) if (_safe_int(raw.get(k)) is not None and raw[k] >= mn)})
        if isinstance(raw.get("activeStep"), bool):
            item["activeStep"] = raw["activeStep"]
        if (ref := _bounded_text(raw.get("assetReference"), 512)) is not None and not ref.lower().startswith("data:") and "base64," not in ref.lower():
            item["assetReference"] = ref
        items.append(item)
    return items


def bounded_active_step(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    deck_title, step_index, step_count = _bounded_text(value.get("deckTitle"), 200), _safe_int(value.get("stepIndex")), _safe_int(value.get("stepCount"))
    if deck_title is None or step_index is None or step_index < 0 or step_count is None or step_count < 1:
        return None
    res: dict[str, Any] = {"deckTitle": deck_title, "stepIndex": step_index, "stepCount": step_count, "activeStep": value.get("activeStep") is not False}
    if isinstance(value.get("stepLabel"), str):
        res["stepLabel"] = value["stepLabel"][:200]
    if isinstance(value.get("expanded"), bool):
        res["expanded"] = value["expanded"]
    return res


def bounded_python_cells(value: Any) -> list[dict[str, Any]] | None:
    if not isinstance(value, list):
        return None
    cells: list[dict[str, Any]] = []
    for raw in value[:8]:
        if not isinstance(raw, dict) or not isinstance(raw.get("ok"), bool):
            continue
        entry: dict[str, Any] = {"ok": raw["ok"], **{k: raw[k] for k in ("ordinal", "sourceStart", "sourceEnd") if (_safe_int(raw.get(k)) is not None and raw[k] >= 0)}}
        for stream, trunc_key in (("stdout", "stdoutTruncated"), ("stderr", "stderrTruncated")):
            if isinstance(raw.get(stream), str):
                entry[stream] = raw[stream][:500]
            if raw.get(trunc_key) is True or (isinstance(raw.get(stream), str) and len(raw[stream]) > 500):
                entry[trunc_key] = True
        if isinstance(raw.get("figureIds"), list):
            entry["figureIds"] = [f for f in raw["figureIds"] if isinstance(f, str) and f.startswith("diagram:python:") and len(f) <= 128][:16]
        cells.append(entry)
    return cells or None


def viewport_contexts(image: dict[str, Any], tab_id: str, expected_revision: str) -> tuple[dict[str, Any], dict[str, Any] | None]:
    nested = image.get("context") if isinstance(image.get("context"), dict) else None
    meta = image.get("metadata") if isinstance(image.get("metadata"), dict) else None
    src = nested if nested is not None else image
    raw_tab_id = src.get("tabId") if isinstance(src.get("tabId"), str) and src.get("tabId") else (meta.get("tabId") if meta and isinstance(meta.get("tabId"), str) else None)
    source_rev = src.get("revision")
    rev_ok = not isinstance(source_rev, str) or source_rev == expected_revision
    ctx: dict[str, Any] = {"tabId": tab_id, "revision": expected_revision, "contextRevisionMatches": rev_ok}
    if raw_tab_id and raw_tab_id != tab_id:
        ctx["nativeTabId"] = raw_tab_id
    if isinstance(source_rev, str) and source_rev != expected_revision:
        ctx["contextRevision"] = source_rev
    if (mode := _bounded_text(src.get("mode", meta.get("mode") if meta else None), 64)) is not None:
        ctx["mode"] = mode
    if isinstance(zoom := src.get("zoom", meta.get("zoom") if meta else None), (int, float)) and not isinstance(zoom, bool):
        ctx["zoom"] = zoom
    if isinstance(raw_reading := src.get("reading", meta.get("reading") if meta else None), dict):
        reading = {k: raw_reading[k] for k in ("offset", "scrollFraction") if isinstance(raw_reading.get(k), (int, float)) and not isinstance(raw_reading.get(k), bool)}
        reading.update({k: raw_reading[k][:lim] for k, lim in (("heading", 300), ("visibleText", 2000)) if isinstance(raw_reading.get(k), str)})
        ctx["reading"] = reading
    if isinstance(raw_sel := src.get("selection", meta.get("selection") if meta else None), dict):
        sel_text = _bounded_text(raw_sel.get("text"), 2000)
        ctx["selection"] = {} if sel_text is None else {"text": sel_text}
    if isinstance(raw_vp := src.get("viewport", meta.get("viewport") if meta else None), dict):
        vkeys = ("x", "y", "width", "height", "viewportWidth", "viewportHeight", "devicePixelRatio")
        ctx["viewport"] = {k: raw_vp[k] for k in vkeys if isinstance(raw_vp.get(k), (int, float)) and not isinstance(raw_vp.get(k), bool)}
    if (active_step := bounded_active_step(src.get("activeStep", meta.get("activeStep") if meta else None))) is not None:
        ctx["activeStep"] = active_step
    if (props := bounded_properties(src.get("properties", meta.get("properties") if meta else None))) is not None:
        ctx["properties"] = props
    source_length, norm_src = _safe_int(src.get("sourceLength")), src.get("visibleSource")
    if source_length is not None and source_length >= 0 and isinstance(norm_src, dict):
        norm_src = normalize_reading_context({"sourceLength": source_length, "visibleSource": norm_src}).get("visibleSource")
    visible_source: dict[str, Any] | None = None
    preview_truncated = False
    if isinstance(norm_src, dict) and isinstance(norm_src.get("text"), str):
        text_chars = norm_src["text"]
        ret_text = text_chars[:12_000]
        preview_truncated = len(text_chars) > len(ret_text)
        visible_source, source_range = {"text": ret_text}, {}
        if preview_truncated:
            visible_source["previewTruncated"] = source_range["previewTruncated"] = True
        start = _safe_int(norm_src.get("start"))
        for key in ("start", "end", "total_chars", "next_offset", "truncated", "view"):
            alt = norm_src.get("totalChars") if key == "total_chars" else (norm_src.get("nextOffset") if key == "next_offset" else None)
            field = norm_src.get(key, alt)
            if key in ("end", "next_offset") and preview_truncated:
                if start is not None:
                    visible_source[key] = source_range[key] = start + len(ret_text)
            elif key == "truncated" and preview_truncated:
                visible_source[key] = source_range[key] = True
            elif _safe_int(field) is not None or isinstance(field, bool) or (key == "next_offset" and field is None) or (key == "view" and isinstance(field, str)):
                visible_source[key] = source_range[key] = field
        if source_range:
            ctx["sourceRange"] = source_range
    diagrams, python_cells = bounded_diagrams(src.get("diagrams")), bounded_python_cells(src.get("pythonCells"))
    coherent = rev_ok and visible_source is not None and not preview_truncated and isinstance(source_rev, str) and source_rev == expected_revision
    captured = ({**ctx, "visibleSource": visible_source, **({"sourceLength": source_length} if source_length is not None and source_length >= 0 else {}),
                 **({"diagrams": diagrams} if diagrams is not None else {}), **({"pythonCells": python_cells} if python_cells is not None else {})}
                if coherent and visible_source is not None else None)
    return ctx, captured


def normalize_initial_reading_context(raw_context: dict[str, Any], *, resolved_tab: str, target: str) -> dict[str, Any]:
    norm = normalize_reading_context(raw_context)
    if "diagrams" in norm and (bdiags := bounded_diagrams(norm.get("diagrams"))) is not None:
        norm["diagrams"] = bdiags
    for key, fn in (("activeStep", bounded_active_step), ("pythonCells", bounded_python_cells)):
        if key in norm:
            if (bval := fn(norm.get(key))) is not None:
                norm[key] = bval
            else:
                norm.pop(key, None)
    out = dict(norm)
    if isinstance(norm.get("tabId"), str) and norm["tabId"] and norm["tabId"] != resolved_tab:
        out["nativeTabId"] = norm["tabId"]
    out["tabId"], out["target"] = resolved_tab, target
    return out


_bounded_properties, _normalize_reading_context = bounded_properties, normalize_reading_context
_bounded_diagrams, _bounded_active_step = bounded_diagrams, bounded_active_step
_bounded_python_cells, _viewport_contexts = bounded_python_cells, viewport_contexts

if __name__ in ("agent.context_normalizer", "desktop.agent.context_normalizer"):
    sys.modules.setdefault("agent.context_normalizer", sys.modules[__name__])
    sys.modules.setdefault("desktop.agent.context_normalizer", sys.modules[__name__])
