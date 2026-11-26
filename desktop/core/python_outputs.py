"""Private derived-output disk storage, not note assets or executable code."""
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

from documents import atomic_json, image_data


_RESULT_FIELDS = {"stdout", "stderr", "images", "ok"}
_CONTEXT_LIMITS = {"document": 2048, "cell": 512, "interpreter": 256}
LEGACY_PROVENANCE_WARNING = "Legacy saved output; document and runtime were not recorded"


def _digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _validate_context(context: dict) -> dict:
    if not isinstance(context, dict) or set(context) != set(_CONTEXT_LIMITS):
        raise ValueError("Python output context must contain document, cell, and interpreter")
    normalized = {}
    for key, limit in _CONTEXT_LIMITS.items():
        value = context[key]
        if not isinstance(value, str) or not value or len(value) > limit or any(ord(char) < 32 for char in value):
            raise ValueError(f"Invalid Python output context: {key}")
        normalized[key] = value
    return normalized


def _payload(result: dict) -> dict:
    # A provenance field may arrive from the UI, but it is never stored as
    # trusted metadata. Only the native store constructs the v2 envelope.
    if not isinstance(result, dict) or set(result) not in (_RESULT_FIELDS, _RESULT_FIELDS | {"provenance"}):
        raise ValueError("Invalid Python output")
    if not isinstance(result["ok"], bool):
        raise ValueError("Invalid Python output")
    if any(not isinstance(result[key], str) or len(result[key]) > 2_000_000 for key in ("stdout", "stderr")):
        raise ValueError("Python text output is too large")
    images = result["images"]
    if not isinstance(images, list) or len(images) > 20:
        raise ValueError("Too many Python figures")
    total = 0
    for image in images:
        _, decoded = image_data(image)
        total += len(decoded)
        if total > 75_000_000:
            raise ValueError("Python figures exceed 75 MB")
    return {key: result[key] for key in ("stdout", "stderr", "images", "ok")}


class PythonOutputs:
    def __init__(self, root: Path):
        self.root = Path(root)

    def _path(self, source: str):
        if not isinstance(source, str) or len(source) > 2_000_000:
            raise ValueError("Python source is too large")
        return self.root / (_digest(source) + ".json")

    def _scoped_path(self, source: str, context: dict):
        identity = json.dumps(
            {"source": source, "context": context}, ensure_ascii=False,
            sort_keys=True, separators=(",", ":"),
        )
        return self.root / (_digest(identity) + ".json")

    def store(self, source: str, result: dict, context: dict = None):
        payload = _payload(result)
        legacy_path = self._path(source)
        if context is None:
            path, value = legacy_path, payload
        else:
            context = _validate_context(context)
            path = self._scoped_path(source, context)
            value = {
                "schemaVersion": 2,
                "sourceDigest": _digest(source),
                "context": context,
                "savedAt": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                "result": payload,
            }
        self.root.mkdir(parents=True, exist_ok=True)
        atomic_json(path, value)

    def load(self, source: str, context: dict = None):
        legacy_path = self._path(source)
        if context is None:
            path = legacy_path
            if not path.exists():
                return None
            if path.stat().st_size > 110_000_000:
                raise ValueError("Cached Python output is too large")
            with path.open(encoding="utf-8") as file:
                return json.load(file)

        context = _validate_context(context)
        path = self._scoped_path(source, context)
        if path.exists():
            if path.stat().st_size > 110_000_000:
                raise ValueError("Cached Python output is too large")
            with path.open(encoding="utf-8") as file:
                envelope = json.load(file)
            if (not isinstance(envelope, dict) or envelope.get("schemaVersion") != 2
                    or envelope.get("sourceDigest") != _digest(source)
                    or envelope.get("context") != context
                    or not isinstance(envelope.get("savedAt"), str)):
                raise ValueError("Invalid scoped Python output")
            payload = _payload(envelope.get("result"))
            return {"result": payload, "provenance": {
                "verified": True,
                **context,
                "savedAt": envelope["savedAt"],
            }}

        # Legacy outputs remain untouched. They cannot prove which document,
        # cell, or interpreter produced them, so callers receive an explicit warning.
        if not legacy_path.exists():
            return None
        if legacy_path.stat().st_size > 110_000_000:
            raise ValueError("Cached Python output is too large")
        with legacy_path.open(encoding="utf-8") as file:
            legacy = json.load(file)
        return {"result": _payload(legacy), "provenance": {
            "verified": False,
            "reason": LEGACY_PROVENANCE_WARNING,
        }}
