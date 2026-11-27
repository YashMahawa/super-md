"""Qt-free profile approval and legacy-upgrade helpers for headless background startup."""
from __future__ import annotations

import json
from pathlib import Path

if __package__ and "." in __package__:
    from ..documents import atomic_write
else:
    from documents import atomic_write

HEADLESS_APPROVAL_REQUIRED_ERROR = (
    "First-time headless startup requires explicit prior approval on this profile. "
    "Enable Live agent access or Keep running in the system tray in Super MD Settings, "
    "or run `super-md agent service approve` first."
)

_LEGACY_BACKGROUND_SETTING_KEYS = (
    "agentAccessEnabled",
    "cloudAgentEnabled",
    "background",
    "backgroundEnabled",
)

_EXPLICIT_HEADLESS_SETTING_KEYS = (
    "keepInBackground",
    "agentAccessEnabled",
    "headlessServiceApproved",
)


def resolve_studio_data_dir(appdata_or_data: Path) -> Path:
    resolved = Path(appdata_or_data).resolve()
    return resolved if resolved.name == "qt-studio" else resolved / "qt-studio"


def has_legacy_background_markers(
    data_dir: Path,
    stored_settings: dict | None,
    *,
    fresh_service_log: bool = False,
) -> bool:
    """Return True when a pre-#41 profile had background or agent artifacts without explicit keepInBackground."""
    if isinstance(stored_settings, dict) and "keepInBackground" in stored_settings:
        return False
    return bool(
        (
            isinstance(stored_settings, dict)
            and any(stored_settings.get(key) is True for key in _LEGACY_BACKGROUND_SETTING_KEYS)
        )
        or (data_dir / "agent-sessions").is_dir()
        or (data_dir / "agent-cloud.json").is_file()
        or (
            not fresh_service_log
            and (
                (data_dir / "background-service.log").is_file()
                or (data_dir.name == "qt-studio" and (data_dir.parent / "background-service.log").is_file())
            )
        )
    )


def is_headless_startup_approved(appdata_or_data: Path, *, fresh_service_log: bool = False) -> bool:
    """Return True when headless startup is approved by Settings, prior CLI approval, or #65 legacy migration."""
    data_dir = resolve_studio_data_dir(appdata_or_data)
    settings_path = data_dir / "settings.json"
    stored_settings = None
    try:
        stored = json.loads(settings_path.read_text(encoding="utf-8"))
        if isinstance(stored, dict) and isinstance(stored.get("settings"), dict):
            stored_settings = stored["settings"]
    except (OSError, ValueError, TypeError, AttributeError):
        pass
    if isinstance(stored_settings, dict) and any(
        stored_settings.get(key) is True for key in _EXPLICIT_HEADLESS_SETTING_KEYS
    ):
        return True
    return has_legacy_background_markers(data_dir, stored_settings, fresh_service_log=fresh_service_log)


def read_persisted_headless_approval(data_dir: Path) -> bool:
    """Return True if on-disk settings.json explicitly records headlessServiceApproved: true."""
    try:
        stored = json.loads((Path(data_dir) / "settings.json").read_text(encoding="utf-8"))
        return isinstance(stored, dict) and isinstance(stored.get("settings"), dict) and (
            stored["settings"].get("headlessServiceApproved") is True
        )
    except (OSError, ValueError, TypeError, AttributeError):
        return False


def approve_headless_startup(appdata_or_data: Path) -> Path:
    """Persist explicit prior headless startup approval without starting a daemon or creating discovery state."""
    data_dir = resolve_studio_data_dir(appdata_or_data)
    if data_dir.is_symlink() or (data_dir.parent.exists() and data_dir.parent.is_symlink()):
        raise ValueError("Super MD profile directory must not be a symlink")
    settings_path = data_dir / "settings.json"
    if settings_path.is_symlink():
        raise ValueError("Super MD settings.json must not be a symlink")
    if settings_path.exists():
        try:
            stored = json.loads(settings_path.read_text(encoding="utf-8"))
        except (OSError, ValueError, TypeError) as exc:
            raise ValueError(
                "Existing Super MD settings.json is unreadable; repair it before approving headless startup."
            ) from exc
        if not isinstance(stored, dict) or (
            "settings" in stored and not isinstance(stored.get("settings"), dict)
        ):
            raise ValueError(
                "Existing Super MD settings.json is malformed; repair it before approving headless startup."
            )
        payload = dict(stored)
        existing_settings = dict(stored.get("settings") or {})
        if "keepInBackground" not in existing_settings:
            existing_settings["keepInBackground"] = has_legacy_background_markers(
                data_dir, existing_settings, fresh_service_log=False
            )
        existing_settings["headlessServiceApproved"] = True
        payload["settings"] = existing_settings
        payload.setdefault("recent", [])
        payload.setdefault("pinned", [])
    else:
        legacy_keep = has_legacy_background_markers(data_dir, None, fresh_service_log=False)
        payload = {
            "settings": {
                "keepInBackground": legacy_keep,
                "agentAccessEnabled": False,
                "cloudAgentEnabled": False,
                "headlessServiceApproved": True,
            },
            "recent": [],
            "pinned": [],
        }
    data_dir.mkdir(parents=True, exist_ok=True)
    atomic_write(settings_path, json.dumps(payload, ensure_ascii=False).encode("utf-8"))
    return settings_path
