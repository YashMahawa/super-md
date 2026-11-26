"""Compatibility facade for Super MD's Qt-free desktop.agent document modules."""
from __future__ import annotations

import sys

if __package__:
    from .agent import fs_ops, patches, source_ops, store
else:
    from agent import fs_ops, patches, source_ops, store

AgentDocumentError, RevisionConflict = source_ops.AgentDocumentError, source_ops.RevisionConflict
MAX_PAGE_CHARS, MAX_SEARCH_RESULTS = source_ops.MAX_PAGE_CHARS, source_ops.MAX_SEARCH_RESULTS
MAX_OUTLINE_PAGE, MAX_QUERY_CHARS = source_ops.MAX_OUTLINE_PAGE, source_ops.MAX_QUERY_CHARS
MAX_AGENT_NOTE_BYTES, MAX_PATCH_OPERATIONS = patches.MAX_AGENT_NOTE_BYTES, patches.MAX_PATCH_OPERATIONS
MAX_PATCH_BYTES = patches.MAX_PATCH_BYTES
MAX_ASSET_BYTES, MAX_ENVELOPE_CACHE_BYTES = fs_ops.MAX_ASSET_BYTES, fs_ops.MAX_ENVELOPE_CACHE_BYTES
DocumentStore, digest_bytes = store.DocumentStore, fs_ops.digest_bytes
validate_patch_operations = patches.validate_patch_operations
apply_patch_operations = patches.apply_patch_operations
apply_patch_operations_detailed = patches.apply_patch_operations_detailed
normalize_fence_language, diagram_spans = source_ops.normalize_fence_language, source_ops.diagram_spans
outline_source, read_source = source_ops.outline_source, source_ops.read_source
resolve_heading, search_source, section_source = source_ops.resolve_heading, source_ops.search_source, source_ops.section_source
_HEADING, _FENCE, _BRACED_FENCE_HEAD = source_ops._HEADING, source_ops._FENCE, source_ops._BRACED_FENCE_HEAD
_SVG_FENCE_LANGUAGES, _DIAGRAM_FENCE_LANGUAGES = source_ops._SVG_FENCE_LANGUAGES, source_ops._DIAGRAM_FENCE_LANGUAGES
_INLINE_SVG_OPEN, _INLINE_SVG_CLOSE = source_ops._INLINE_SVG_OPEN, source_ops._INLINE_SVG_CLOSE
_FencedSpan, _OpenFence = source_ops._FencedSpan, source_ops._OpenFence
_step_fence_boundary, _scan_read_only = source_ops._step_fence_boundary, source_ops._scan_read_only
_read_headings_and_svg_spans, _headings = source_ops._read_headings_and_svg_spans, source_ops._headings
_heading_sections, _heading_slug, _ambiguous_heading = source_ops._heading_sections, source_ops._heading_slug, source_ops._ambiguous_heading
_prose_page_end, _elide_svg_page = source_ops._prose_page_end, source_ops._elide_svg_page
_svg_spans, _word_character = source_ops._svg_spans, source_ops._word_character
_LOCK_GUARD, _CachedEnvelope, _NoteCacheEntry = fs_ops._LOCK_GUARD, fs_ops._CachedEnvelope, fs_ops._NoteCacheEntry
_symlink_component, _path_lock = fs_ops._symlink_component, fs_ops._path_lock
_atomic_replace, _create_once, _serialize = fs_ops._atomic_replace, fs_ops._create_once, fs_ops._serialize
_asset_record, _asset_metadata, _resolve_asset_id = fs_ops._asset_record, store._asset_metadata, fs_ops._resolve_asset_id

__all__ = [
    "MAX_AGENT_NOTE_BYTES", "MAX_ASSET_BYTES", "MAX_ENVELOPE_CACHE_BYTES", "MAX_OUTLINE_PAGE",
    "MAX_PAGE_CHARS", "MAX_PATCH_BYTES", "MAX_PATCH_OPERATIONS", "MAX_QUERY_CHARS",
    "MAX_SEARCH_RESULTS", "AgentDocumentError", "DocumentStore", "RevisionConflict",
    "apply_patch_operations", "apply_patch_operations_detailed", "diagram_spans", "digest_bytes",
    "normalize_fence_language", "outline_source", "read_source", "resolve_heading",
    "search_source", "section_source", "validate_patch_operations",
]

_PEER_MODULE = (
    "agent_documents"
    if __name__ == "desktop.agent_documents"
    else ("desktop.agent_documents" if __name__ == "agent_documents" else None)
)
if _PEER_MODULE and _PEER_MODULE in sys.modules:
    sys.modules[__name__] = sys.modules[_PEER_MODULE]
