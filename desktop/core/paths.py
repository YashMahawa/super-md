"""Centralized filesystem roots for source checkouts and frozen desktop bundles."""
from __future__ import annotations

from collections.abc import Mapping
import os
import sys
from pathlib import Path

DESKTOP_DIR = Path(__file__).resolve().parents[1]
SOURCE_ROOT = DESKTOP_DIR.parent
APPDATA_OVERRIDE_ENV = "SUPERMD_APPDATA_DIR"


def resource_root() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys._MEIPASS) / "resources"
    return SOURCE_ROOT


def _is_link_or_junction(candidate: Path) -> bool:
    if candidate.is_symlink():
        return True
    is_junction = getattr(candidate, "is_junction", None)
    return bool(is_junction and is_junction())


def configured_appdata_root(env: Mapping[str, str] | None = None) -> Path | None:
    raw = (os.environ if env is None else env).get(APPDATA_OVERRIDE_ENV, "").strip()
    if not raw:
        return None
    candidate = Path(raw).expanduser()
    if not candidate.is_absolute():
        raise ValueError(f"{APPDATA_OVERRIDE_ENV} must be an absolute path: {raw!r}")
    if _is_link_or_junction(candidate):
        raise ValueError(f"{APPDATA_OVERRIDE_ENV} must not be a symlink: {raw!r}")
    return candidate.resolve()


def appdata_root(*, writable_location_fn=None, env: Mapping[str, str] | None = None) -> Path:
    override = configured_appdata_root(env)
    if override is not None:
        return override
    from PySide6.QtCore import QStandardPaths

    resolver = QStandardPaths.writableLocation if writable_location_fn is None else writable_location_fn
    return Path(resolver(QStandardPaths.StandardLocation.AppDataLocation)).resolve()


RESOURCE_ROOT = resource_root()
