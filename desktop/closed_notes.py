"""Private disk snapshots for recently closed native note tabs.

Snapshots are immutable and are intentionally not removed when the bounded
reopen index changes. That keeps an older draft recoverable until explicit
storage inspection/cleanup is available.
"""
import json
import re
import uuid
from pathlib import Path

from documents import atomic_json


class ClosedNoteStore:
    LIMIT = 12

    def __init__(self, root: Path):
        self.root = Path(root)
        self.index_path = self.root / "index.json"

    @staticmethod
    def _token(value):
        if not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{32}", value):
            raise ValueError("Invalid closed-note snapshot reference")
        return value

    def save(self, note: dict) -> dict:
        if not isinstance(note, dict) or not isinstance(note.get("id"), str) or not note["id"]:
            raise ValueError("Invalid closed note")
        token = uuid.uuid4().hex
        self.root.mkdir(parents=True, exist_ok=True)
        atomic_json(self.root / f"snapshot-{token}.json", note)
        return {
            "id": note["id"], "name": note.get("name", "Untitled.md"),
            "path": note.get("path", ""), "portable": bool(note.get("portable", False)),
            "content": "", "saved": "", "assets": {},
            "_closedSnapshot": token,
        }

    def load(self, reference: dict) -> dict:
        token = self._token(reference.get("_closedSnapshot"))
        path = self.root / f"snapshot-{token}.json"
        if not path.is_file():
            raise FileNotFoundError("The closed-note snapshot is unavailable")
        with path.open(encoding="utf-8") as file:
            note = json.load(file)
        if not isinstance(note, dict) or note.get("id") != reference.get("id"):
            raise ValueError("The closed-note snapshot is invalid")
        return note

    def load_index(self) -> list[dict]:
        try:return self.load_index_strict()
        except (OSError, ValueError, TypeError):return []

    def load_index_strict(self) -> list[dict]:
        if not self.index_path.exists():return []
        with self.index_path.open(encoding="utf-8") as file:
            values = json.load(file)
        if not isinstance(values, list) or len(values)>self.LIMIT:
            raise ValueError("Invalid closed-note index")
        if any(not isinstance(value,dict) or not isinstance(value.get("id"),str) or not self._valid_ref(value) for value in values):
            raise ValueError("A closed-note reference is unavailable")
        return values

    def _valid_ref(self, value):
        try:
            self._token(value.get("_closedSnapshot"))
            return (self.root / f"snapshot-{value['_closedSnapshot']}.json").is_file()
        except (ValueError, TypeError):
            return False

    def save_index(self, references: list[dict]) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        atomic_json(self.index_path, references[:self.LIMIT])
