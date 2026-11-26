"""Safe, bounded document operations shared by the Super MD agent CLI and MCP.

This compatibility facade re-exports the Qt-free :mod:`desktop.agent` modules
so existing CLI entry points, MCP tools, and unit-test mocks keep working.
"""
from __future__ import annotations

try:  # package import and direct-script import are both supported
    from . import documents
    from .agent.fs_ops import (
        _LOCK_GUARD, _atomic_replace, _create_once, _path_lock, _serialize, _symlink_component,
    )
    from .agent.patches import apply_patch_operations_detailed, validate_patch_operations
    from .agent.source_ops import (
        MAX_OUTLINE_PAGE, MAX_PAGE_CHARS, MAX_QUERY_CHARS, MAX_SEARCH_RESULTS,
        AgentDocumentError, RevisionConflict, _BRACED_FENCE_HEAD, _DIAGRAM_FENCE_LANGUAGES,
        _FENCE, _FencedSpan, _HEADING, _INLINE_SVG_CLOSE, _INLINE_SVG_OPEN, _OpenFence,
        _SVG_FENCE_LANGUAGES, _ambiguous_heading, _elide_svg_page, _heading_sections,
        _heading_slug, _headings, _prose_page_end, _read_headings_and_svg_spans,
        _scan_read_only, _step_fence_boundary, _svg_spans, _word_character, diagram_spans,
        normalize_fence_language, outline_source, read_source, resolve_heading,
        search_source, section_source,
    )
    from .agent.store import (
        MAX_ASSET_BYTES, MAX_ENVELOPE_CACHE_BYTES, DocumentStore, _CachedEnvelope,
        _asset_metadata, _asset_record, _resolve_asset_id, digest_bytes,
    )
except ImportError:
    import documents
    from agent.fs_ops import (
        _LOCK_GUARD, _atomic_replace, _create_once, _path_lock, _serialize, _symlink_component,
    )
    from agent.patches import apply_patch_operations_detailed, validate_patch_operations
    from agent.source_ops import (
        MAX_OUTLINE_PAGE, MAX_PAGE_CHARS, MAX_QUERY_CHARS, MAX_SEARCH_RESULTS,
        AgentDocumentError, RevisionConflict, _BRACED_FENCE_HEAD, _DIAGRAM_FENCE_LANGUAGES,
        _FENCE, _FencedSpan, _HEADING, _INLINE_SVG_CLOSE, _INLINE_SVG_OPEN, _OpenFence,
        _SVG_FENCE_LANGUAGES, _ambiguous_heading, _elide_svg_page, _heading_sections,
        _heading_slug, _headings, _prose_page_end, _read_headings_and_svg_spans,
        _scan_read_only, _step_fence_boundary, _svg_spans, _word_character, diagram_spans,
        normalize_fence_language, outline_source, read_source, resolve_heading,
        search_source, section_source,
    )
    from agent.store import (
        MAX_ASSET_BYTES, MAX_ENVELOPE_CACHE_BYTES, DocumentStore, _CachedEnvelope,
        _asset_metadata, _asset_record, _resolve_asset_id, digest_bytes,
    )
