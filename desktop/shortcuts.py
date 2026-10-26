"""Validated, portable shortcut bindings with labels in native platform text."""
from __future__ import annotations

import sys

from PySide6.QtCore import QKeyCombination, Qt
from PySide6.QtGui import QKeySequence

def _definition_rows(platform: str) -> tuple[tuple[str, str, list[str]], ...]:
    # In QKeySequence PortableText, Ctrl maps to Command on Apple platforms;
    # Meta maps to the physical Control key. Keep common shortcuts portable.
    primary = "Ctrl"
    fullscreen = ["F11"]
    if platform == "darwin":
        fullscreen.append("Ctrl+Meta+F")  # Command+Control+F, macOS convention.
    redo = ["Ctrl+Shift+Z"] if platform == "darwin" else ["Ctrl+Y"]
    return (
        ("new_window", "New window", [f"{primary}+N", f"{primary}+Shift+N"]),
        ("new_note", "New note", [f"{primary}+T"]),
        ("open", "Open note", [f"{primary}+O"]),
        ("save", "Save note", [f"{primary}+S"]),
        ("undo", "Undo", [f"{primary}+Z"]),
        ("redo", "Redo", redo),
        ("copy", "Copy", [f"{primary}+C"]),
        ("cut", "Cut", [f"{primary}+X"]),
        ("paste", "Paste", [f"{primary}+V"]),
        ("select_all", "Select all", [f"{primary}+A"]),
        ("find", "Find in note", [f"{primary}+F"]),
        ("close_tab", "Close note tab", [f"{primary}+W"]),
        ("next_tab", "Next tab", [f"{primary}+Tab", f"{primary}+PgDown"]),
        ("previous_tab", "Previous tab", [f"{primary}+Shift+Tab", f"{primary}+PgUp"]),
        ("move_tab_left", "Move tab left", [f"{primary}+Shift+PgUp"]),
        ("move_tab_right", "Move tab right", [f"{primary}+Shift+PgDown"]),
        ("reopen_tab", "Reopen closed tab", [f"{primary}+Shift+T"]),
        *((f"tab_{number}", f"Switch to tab {number}", [f"{primary}+{number}"]) for number in range(1, 10)),
        ("close_window", "Close window", [f"{primary}+Shift+W"]),
        ("settings", "Settings", [f"{primary}+,"]),
        ("fullscreen", "Toggle fullscreen", fullscreen),
        ("dismiss", "Dismiss overlay / exit fullscreen", ["Escape"]),
        ("zoom_in", "Zoom in", [f"{primary}++", f"{primary}+="]),
        ("zoom_out", "Zoom out", [f"{primary}+-"]),
        ("zoom_reset", "Reset zoom", [f"{primary}+0"]),
    )


_DEFINITIONS = _definition_rows(sys.platform)
DEFINITIONS = tuple({"id": key, "label": label} for key, label, _ in _DEFINITIONS)
_DEFAULTS = {key: sequences for key, _, sequences in _DEFINITIONS}
_IDS = {item["id"] for item in DEFINITIONS}


def default_shortcuts(platform: str | None = None) -> dict[str, list[str]]:
    rows = _definition_rows(platform or sys.platform)
    return {action: [parse_sequence(value) or value for value in values] for action, _, values in rows}


def parse_sequence(value: str) -> str | None:
    if not isinstance(value, str) or not value.strip() or len(value) > 100:
        return None
    portable_input = value.strip().replace("PageDown", "PgDown").replace("PageUp", "PgUp")
    sequence = QKeySequence.fromString(portable_input, QKeySequence.SequenceFormat.PortableText)
    if sequence.count() != 1:
        return None
    portable = sequence.toString(QKeySequence.SequenceFormat.PortableText)
    if not portable:
        return None
    combination = sequence[0]
    modifiers = combination.keyboardModifiers()
    key = combination.key()
    has_modifier = bool(modifiers & (Qt.KeyboardModifier.ControlModifier | Qt.KeyboardModifier.AltModifier | Qt.KeyboardModifier.MetaModifier))
    function_key = int(Qt.Key.Key_F1) <= int(key) <= int(Qt.Key.Key_F35)
    if not has_modifier and not function_key and key != Qt.Key.Key_Escape:
        return None
    return portable


def native_label(value: str) -> str:
    sequence = QKeySequence.fromString(value, QKeySequence.SequenceFormat.PortableText)
    return sequence.toString(QKeySequence.SequenceFormat.NativeText) or "Disabled"


def normalize_shortcuts(candidate) -> tuple[dict[str, list[str]] | None, str]:
    """Validate the complete binding map and reject exact or prefix conflicts."""
    if not isinstance(candidate, dict):
        return None, "Shortcut settings must be a map."
    normalized: dict[str, list[str]] = {}
    for action in _DEFAULTS:
        values = candidate.get(action, _DEFAULTS[action])
        if not isinstance(values, list) or len(values) > 4:
            return None, f"Invalid shortcuts for {action}."
        parsed: list[str] = []
        for value in values:
            portable = parse_sequence(value)
            if portable is None:
                return None, f"Invalid key combination for {action}."
            if portable not in parsed:
                parsed.append(portable)
        normalized[action] = parsed
    assigned: list[tuple[str, str]] = []
    for action, sequences in normalized.items():
        for value in sequences:
            current = QKeySequence.fromString(value, QKeySequence.SequenceFormat.PortableText)
            for other_action, other_value in assigned:
                other = QKeySequence.fromString(other_value, QKeySequence.SequenceFormat.PortableText)
                if current.matches(other) != QKeySequence.SequenceMatch.NoMatch:
                    label = next(item["label"] for item in DEFINITIONS if item["id"] == other_action)
                    return None, f"That shortcut conflicts with {label}."
            assigned.append((action, value))
    return normalized, ""


def capture_sequence(key: int, modifiers: int) -> tuple[str, str]:
    """Turn QML's native key event into a validated portable sequence."""
    modifier_keys = {int(Qt.Key.Key_Control), int(Qt.Key.Key_Shift), int(Qt.Key.Key_Alt), int(Qt.Key.Key_Meta), int(Qt.Key.Key_AltGr)}
    if key in modifier_keys:
        return "", "Add a key after the modifier."
    try:
        combination = QKeyCombination(Qt.KeyboardModifier(modifiers), Qt.Key(key))
        portable = QKeySequence(combination).toString(QKeySequence.SequenceFormat.PortableText)
    except (TypeError, ValueError):
        portable = ""
    if not portable:
        return "", "That key cannot be used as a shortcut."
    parsed = parse_sequence(portable)
    if parsed is None:
        return "", "Use Ctrl, Alt, or Command with a key, or choose a function key."
    return parsed, ""
