"""Shared stdlib-only helpers and document store for Super MD agent interfaces."""
from __future__ import annotations

from .source_ops import AgentDocumentError, RevisionConflict

__all__ = ["AgentDocumentError", "RevisionConflict"]
