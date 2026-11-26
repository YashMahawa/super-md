"""Centralized filesystem roots for source checkouts and frozen desktop bundles."""
from __future__ import annotations

import sys
from pathlib import Path

DESKTOP_DIR = Path(__file__).resolve().parents[1]
SOURCE_ROOT = DESKTOP_DIR.parent


def resource_root() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys._MEIPASS) / "resources"
    return SOURCE_ROOT


RESOURCE_ROOT = resource_root()
