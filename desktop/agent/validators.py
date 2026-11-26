"""Shared stdlib-only parameter and revision validators for desktop agent layers."""
from __future__ import annotations

import json
from collections.abc import Iterable, Mapping
from typing import Any

_HEX_CHARS = frozenset("0123456789abcdef")


def require_sha256_revision(
    value: Any, *, field: str = "expected_revision", error_cls: type[Exception] = ValueError,
    hex_only: bool = True, message: str | None = None,
) -> str:
    """Require a 64-character SHA-256 revision string (lowercase hex by default)."""
    if not isinstance(value, str) or len(value) != 64 or (hex_only and any(ch not in _HEX_CHARS for ch in value)):
        raise error_cls(message or f"{field} must be the current SHA-256 revision")
    return value


def require_optional_sha256_revision(
    value: Any, *, field: str = "expected_revision", error_cls: type[Exception] = ValueError,
    hex_only: bool = True, message: str | None = None,
) -> str | None:
    """Validate an optional SHA-256 revision when supplied."""
    if value is None:
        return None
    return require_sha256_revision(value, field=field, error_cls=error_cls, hex_only=hex_only, message=message)


def require_nonneg_int(
    value: Any, *, field: str = "offset", max_value: int | None = None,
    error_cls: type[Exception] = ValueError, message: str | None = None,
) -> int:
    """Require a nonnegative integer (rejecting booleans) with an optional upper bound."""
    if isinstance(value, bool) or not isinstance(value, int) or value < 0 or (max_value is not None and value > max_value):
        if message is not None:
            raise error_cls(message)
        if max_value is not None:
            raise error_cls(f"{field} must be between 0 and {max_value:,}")
        raise error_cls(f"{field} must be a nonnegative integer")
    return value


def require_int_range(
    value: Any, min_value: int, max_value: int, *, field: str = "limit",
    error_cls: type[Exception] = ValueError, message: str | None = None,
) -> int:
    """Require an integer within ``[min_value, max_value]`` (rejecting booleans)."""
    if isinstance(value, bool) or not isinstance(value, int) or not min_value <= value <= max_value:
        raise error_cls(message or f"{field} must be between {min_value:,} and {max_value:,}")
    return value


def require_bool_flags(
    mapping: Mapping[str, Any], keys: Iterable[str], *,
    error_cls: type[Exception] = ValueError, message: str | None = None,
) -> None:
    """Ensure every present flag key in ``mapping`` is a strict boolean."""
    for key in keys:
        if key in mapping and not isinstance(mapping[key], bool):
            raise error_cls(message or f"{key} must be a boolean")


def require_identifier(
    value: Any, *, field: str, max_len: int = 128,
    error_cls: type[Exception] = ValueError, message: str | None = None,
) -> str:
    """Require a bounded non-empty string identifier."""
    if not isinstance(value, str) or not value or len(value) > max_len:
        raise error_cls(message or f"{field} is required")
    return value


def require_diagram_id(
    value: Any, *, max_len: int = 100, require_prefix: bool = True,
    error_cls: type[Exception] = ValueError, message: str | None = None,
) -> str:
    """Require a bounded diagram source reference."""
    if not isinstance(value, str) or not value or len(value) > max_len or (require_prefix and not value.startswith("diagram:")):
        raise error_cls(message or "diagramId is invalid")
    return value


def require_heading_selector(heading: Any, *, error_cls: type[Exception] = ValueError) -> int | str | None:
    """Validate an optional nonnegative outline index or non-empty heading title/slug."""
    if heading is None:
        return None
    if isinstance(heading, int) and not isinstance(heading, bool) and heading >= 0:
        return heading
    if isinstance(heading, str) and bool(heading.strip()) and len(heading) <= 300:
        return heading
    raise error_cls("heading must be an outline index, exact title, slug, or numbered heading prefix")


def require_search_params(
    query: Any, limit: Any = 10, context: Any = 100, offset: Any = 0, *,
    max_offset: int | None = None, flags: Mapping[str, Any] | Iterable[Any] = (),
    error_cls: type[Exception] = ValueError,
) -> tuple[str, int, int, int]:
    """Validate search query, limit, context, offset, and optional boolean filter flags."""
    if not isinstance(query, str) or not query or len(query) > 500:
        raise error_cls("query must contain between 1 and 500 characters")
    checked_limit = require_int_range(limit, 1, 25, field="limit", error_cls=error_cls)
    checked_context = require_int_range(context, 0, 500, field="context", error_cls=error_cls)
    checked_offset = require_nonneg_int(offset, field="offset", max_value=max_offset, error_cls=error_cls)
    if isinstance(flags, Mapping):
        require_bool_flags(flags, flags.keys(), error_cls=error_cls)
    else:
        for item in flags:
            if isinstance(item, tuple) and len(item) == 2:
                if not isinstance(item[1], bool):
                    raise error_cls(f"{item[0]} must be a boolean")
            elif not isinstance(item, bool):
                raise error_cls("search flags must be booleans")
    return query, checked_limit, checked_context, checked_offset


def require_viewport_width(
    width: Any, *, min_width: int = 64, max_width: int = 1600,
    error_cls: type[Exception] = ValueError, message: str | None = None,
) -> int:
    """Require an integer viewport render width in pixels."""
    if isinstance(width, bool) or not isinstance(width, int) or not min_width <= width <= max_width:
        raise error_cls(message or f"width must be between {min_width:,} and {max_width:,} pixels")
    return width


def require_image_format(
    image_format: Any, *, field: str = "image_format", error_cls: type[Exception] = ValueError,
) -> str:
    """Require a supported live raster snapshot format (``png`` or ``jpeg``)."""
    if image_format not in ("png", "jpeg"):
        raise error_cls(f"{field} must be png or jpeg")
    return image_format


def require_repair_indices(
    indices: Any, *, allow_empty: bool = True, max_items: int = 40,
    field: str = "repair_indices", error_cls: type[Exception] = ValueError, message: str | None = None,
) -> list[int]:
    """Require up to ``max_items`` unique nonnegative LaTeX repair indices."""
    if (not isinstance(indices, list) or len(indices) > max_items or (not allow_empty and not indices)
            or any(not isinstance(v, int) or isinstance(v, bool) or v < 0 for v in indices)
            or len(set(indices)) != len(indices)):
        if message is not None:
            raise error_cls(message)
        if not allow_empty and isinstance(indices, list) and not indices:
            raise error_cls(f"{field} requires 1–{max_items} unique nonnegative repair indexes")
        raise error_cls(f"{field} must be up to {max_items} unique nonnegative repair indexes")
    return indices


def require_export_params(
    format_value: Any, *, options: Any = None, filename: Any = None,
    allowed_formats: tuple[str, ...] = ("pdf", "smd", "md"),
    require_safe_basename: bool = False, error_cls: type[Exception] = ValueError,
) -> tuple[str, dict[str, Any] | None, str | None]:
    """Validate export format, bounded JSON options dict, and optional basename."""
    if format_value not in allowed_formats:
        choices = (", ".join(allowed_formats[:-1]) + f", or {allowed_formats[-1]}"
                   if len(allowed_formats) > 2 else " or ".join(allowed_formats))
        raise error_cls(f"format must be {choices}")
    if options is not None:
        if not isinstance(options, dict):
            raise error_cls("Export options must be an object smaller than 8 KB")
        try:
            encoded = json.dumps(options, ensure_ascii=False).encode("utf-8")
        except (TypeError, ValueError, UnicodeError) as exc:
            raise error_cls("Export options must be an object smaller than 8 KB") from exc
        if len(encoded) > 8_000:
            raise error_cls("Export options must be an object smaller than 8 KB")
    if filename is not None and (
        not isinstance(filename, str) or len(filename) > 160
        or (require_safe_basename and any(ch in filename for ch in ("/", "\\", "\0")))
    ):
        raise error_cls("filename must be a short basename")
    return format_value, options, filename
