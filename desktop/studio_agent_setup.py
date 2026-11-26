"""Agent MCP setup, skill packaging, local bridge toggles, and cloud pairing helpers for Studio."""
from __future__ import annotations
import io, json, os, sys, threading, zipfile
from pathlib import Path

def _agent_cloud():
    try:
        from . import agent_cloud
    except ImportError:
        import agent_cloud
    return agent_cloud

def _studio_module():
    module = sys.modules.get("studio") or sys.modules.get("desktop.studio")
    if module is not None:
        return module
    try:
        from . import studio as module
    except ImportError:
        import studio as module
    return module

def _agent_bridge(studio_obj):
    return getattr(getattr(studio_obj, "session", None), "agent_bridge", None)

def _normalize_mcp_roots(roots) -> list[str]:
    if not roots:
        return []
    normalized, seen = [], set()
    for candidate in roots:
        if candidate is None:
            continue
        raw = str(candidate).strip()
        if not raw or "\0" in raw:
            continue
        try:
            resolved = Path(raw).expanduser().resolve(strict=True)
        except (OSError, RuntimeError, ValueError):
            continue
        if resolved.is_dir() and str(resolved) not in seen:
            seen.add(str(resolved))
            normalized.append(str(resolved))
    return normalized

def agent_mcp_setup_config(discovery_dir, *, roots=None, executable=None, frozen=None, platform=None, cli_script=None):
    """Return a directly executable, absolute MCP stdio command for this install."""
    frozen = getattr(sys, "frozen", False) if frozen is None else bool(frozen)
    # Resolving a source venv's Python symlink would bypass that environment
    # and lose its MCP dependencies. Frozen launchers can use canonical paths.
    executable_path = Path(os.path.abspath(Path(executable or sys.executable).expanduser()))
    if frozen:
        executable_path = executable_path.resolve()
    platform = sys.platform if platform is None else platform
    if frozen:
        if platform.startswith("win"):
            command = str(executable_path.with_name("super-md-cli.exe").resolve())
        elif platform.startswith("linux"):
            appimage = os.environ.get("APPIMAGE", "")
            appimage_path = Path(appimage).expanduser() if appimage else None
            appdir = os.environ.get("APPDIR", "")
            from_image = bool(appdir and executable_path.is_relative_to(Path(appdir).resolve()))
            command = str(appimage_path.resolve()) if from_image and appimage_path and appimage_path.is_file() else str(executable_path)
        else:
            command = str(executable_path)
        args = ["agent", "mcp"]
    else:
        if platform.startswith("win") and executable_path.name.casefold() == "pythonw.exe":
            console_python = executable_path.with_name("python.exe")
            if console_python.is_file():
                executable_path = console_python
        script = Path(cli_script or Path(__file__).with_name("agent_cli.py")).expanduser().resolve()
        command, args = str(executable_path), [str(script), "mcp"]
    for root_path in _normalize_mcp_roots(roots):
        args.extend(["--root", root_path])
    args.extend(["--live-sessions-dir", str(Path(discovery_dir).expanduser().resolve()), "--transport", "stdio"])
    return {"command": command, "args": args}

_REQUIRED_SKILL_PACKAGE_FILES = (
    "SKILL.md", "references/study-notes.md", "references/visual-authoring.md",
    "references/agent-connection.md", "assets/study-visual-example.svg",
)

def _bundle_agent_skill_markdown(skill_dir: Path) -> str:
    router = ((skill_dir / "SKILL.md").read_text(encoding="utf-8").rstrip()
              .replace("(references/study-notes.md)", "(#exam-ready-study-notes)")
              .replace("(references/visual-authoring.md)", "(#diagram-and-interaction-guide)")
              .replace("(references/agent-connection.md)", "(#agent-connection)"))
    study_notes = (skill_dir / "references" / "study-notes.md").read_text(encoding="utf-8").strip()
    visual_authoring = (skill_dir / "references" / "visual-authoring.md").read_text(encoding="utf-8").strip()
    connection = (skill_dir / "references" / "agent-connection.md").read_text(encoding="utf-8").strip()
    return f"{router}\n\n{study_notes}\n\n{visual_authoring}\n\n# Agent connection\n\n{connection}\n"

def _build_agent_skill_zip_bytes(root_dir: Path) -> bytes:
    dist_zip = root_dir / "dist" / "super-md-skill.zip"
    if dist_zip.is_file():
        raw = dist_zip.read_bytes()
        with zipfile.ZipFile(io.BytesIO(raw), "r") as archive:
            names = set(archive.namelist())
            if any(name.endswith("/local-preferences.md") or name == "local-preferences.md" for name in names):
                raise ValueError("Skill archive must not contain local-preferences.md")
            if all(f"super-md/{rel}" in names for rel in _REQUIRED_SKILL_PACKAGE_FILES):
                return raw
    if getattr(sys, "frozen", False):
        raise FileNotFoundError("Bundled super-md-skill.zip is missing from this installation")
    source_dir = root_dir / "dist" / "super-md-skill"
    if not source_dir.is_dir():
        source_dir = root_dir / "docs" / "skills" / "super-md"
    for rel in _REQUIRED_SKILL_PACKAGE_FILES:
        if not (source_dir / rel).is_file():
            raise FileNotFoundError(f"Missing required skill file: {rel}")
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_STORED) as archive:
        for file_path in sorted(source_dir.rglob("*")):
            rel_parts = file_path.relative_to(source_dir).parts
            if any(part.startswith(".") or part == "local-preferences.md" for part in rel_parts):
                continue
            if file_path.is_file() and not file_path.is_symlink():
                info = zipfile.ZipInfo("super-md/" + "/".join(rel_parts))
                info.date_time = (1980, 1, 1, 0, 0, 0)
                info.compress_type = zipfile.ZIP_STORED
                archive.writestr(info, file_path.read_bytes())
    return buffer.getvalue()

def _stop_cloud_bridge(studio_obj, bridge) -> None:
    bridge.stop_cloud()
    studio_obj.settings["cloudAgentEnabled"] = False
    if getattr(studio_obj, "_cloud_started_local_bridge", False) and not studio_obj.settings.get("agentAccessEnabled", False):
        bridge.stop()
    studio_obj._cloud_started_local_bridge = False

def _restore_cloud_connection(studio_obj) -> None:
    if studio_obj.retired or not studio_obj.settings.get("cloudAgentEnabled") or studio_obj._cloud_revocation_pending:
        return
    bridge = _agent_bridge(studio_obj)
    if bridge is None or bridge.cloudClient.enabled:
        return
    try:
        config = _agent_cloud().read_cloud_config(studio_obj._agent_cloud_config_path)
        was_enabled = bridge.enabled
        bridge.start_cloud(config)
        studio_obj._cloud_started_local_bridge = not was_enabled
        studio_obj._agent_cloud_error = ""
    except Exception as error:
        # Keep the opt-in on transient errors so the user can retry without
        # re-pairing. Invalid pairing is surfaced, never silently replaced.
        studio_obj._agent_cloud_error = f"Cloud auto-connect failed: {str(error)[:140]}"
    studio_obj._emit(False)

def agent_access_enabled(studio_obj) -> bool:
    bridge = _agent_bridge(studio_obj)
    return bool(bridge and bridge.enabled)

def agent_access_status(studio_obj) -> str:
    bridge = _agent_bridge(studio_obj)
    if studio_obj._agent_error:
        return studio_obj._agent_error
    return "On · loopback only (fresh token each launch)" if bridge and bridge.enabled else "Off · no live tabs are exposed"

def agent_mcp_roots(studio_obj) -> list[str]:
    windows = [studio_obj]
    if hasattr(studio_obj, "session") and hasattr(studio_obj.session, "windows"):
        windows.extend(w for w in studio_obj.session.windows.values() if w is not studio_obj and not getattr(w, "retired", False))
    candidates: list[str | Path] = [w.folder for w in windows if getattr(w, "folder", "")]
    location = studio_obj.settings.get("newNoteLocation") if isinstance(getattr(studio_obj, "settings", None), dict) else None
    if location:
        candidates.append(location)
    for window in windows:
        for tab in getattr(window, "tabs", ()):
            tab_path = tab.get("path") if isinstance(tab, dict) else None
            if isinstance(tab_path, str) and tab_path:
                candidates.append(Path(tab_path).parent)
    return _normalize_mcp_roots(candidates)

def agent_setup_instructions(studio_obj) -> str:
    bridge = _agent_bridge(studio_obj)
    if not bridge or not bridge.enabled:
        return "Enable live agent access to prepare the local MCP server configuration."
    roots = studio_obj._agent_mcp_roots() if hasattr(studio_obj, "_agent_mcp_roots") else agent_mcp_roots(studio_obj)
    return json.dumps(agent_mcp_setup_config(bridge.discovery_dir, roots=roots), ensure_ascii=False, indent=2)

def agent_access_tabs_summary(studio_obj) -> str:
    bridge = _agent_bridge(studio_obj)
    if not bridge or not bridge.enabled:
        return "No tabs are exposed."
    studios = [window for window in studio_obj.session.windows.values() if not window.retired]
    tabs = sum(len(window.tabs) for window in studios)
    return f"{tabs} open tabs across {len(studios)} windows are available to the local MCP server."

def cloud_agent_configured(studio_obj) -> bool: return studio_obj._agent_cloud_config_path.is_file()
def cloud_agent_revocation_pending(studio_obj) -> bool: return studio_obj._cloud_revocation_pending

def cloud_agent_enabled(studio_obj) -> bool:
    bridge = _agent_bridge(studio_obj)
    return bool(bridge and bridge.cloudClient.enabled)

def cloud_agent_status(studio_obj) -> str:
    if studio_obj._agent_cloud_error:
        return studio_obj._agent_cloud_error
    if studio_obj._cloud_revocation_pending:
        return "Disconnecting and revoking this desktop pairing…"
    bridge = _agent_bridge(studio_obj)
    return bridge.cloudClient.status if bridge else "Cloud relay is unavailable."

def cloud_relay_origin(studio_obj) -> str:
    if not studio_obj.cloudAgentConfigured:
        return ""
    try:
        return _agent_cloud().read_cloud_config(studio_obj._agent_cloud_config_path)["serverOrigin"]
    except Exception:
        return ""

def cloud_connector_url(studio_obj) -> str:
    if not studio_obj.cloudAgentConfigured:
        return ""
    try:
        cloud = _agent_cloud()
        return cloud.connector_url(cloud.read_cloud_config(studio_obj._agent_cloud_config_path))
    except Exception:
        return ""

def best_effort_revoke_cloud_config(config) -> None:
    if not config:
        return
    def run():
        try: _agent_cloud().revoke(config, timeout=8)
        except Exception: pass
    threading.Thread(target=run, name="supermd-agent-cloud-revoke-old", daemon=True).start()

def finish_cloud_revocation(studio_obj, confirmed, device_id) -> None:
    erased = False
    try:
        current = _agent_cloud().read_cloud_config(studio_obj._agent_cloud_config_path)
        if current.get("deviceId") == device_id:
            studio_obj._agent_cloud_config_path.unlink(missing_ok=True)
            erased = not studio_obj._agent_cloud_config_path.exists()
    except FileNotFoundError:
        erased = True
    except Exception:
        confirmed = False
    studio_obj._cloud_revocation_pending = False
    studio_obj.settings["cloudAgentEnabled"] = False
    studio_obj._preferences()
    if not erased:
        studio_obj._agent_cloud_error = "Relay revoke finished, but the local pairing file could not be erased. Remove it from app data before reconnecting."
    elif confirmed:
        studio_obj._agent_cloud_error = "Relay revocation confirmed; local pairing credentials were erased."
    else:
        studio_obj._agent_cloud_error = "Local pairing credentials were erased, but relay revocation could not be confirmed."
    studio_obj._emit(False)

def revoke_cloud_agent(studio_obj) -> None:
    if studio_obj._cloud_revocation_pending:
        return
    try:
        cloud = _agent_cloud()
        config = cloud.read_cloud_config(studio_obj._agent_cloud_config_path)
        bridge = _agent_bridge(studio_obj)
        studio_obj.settings["cloudAgentEnabled"] = False
        studio_obj._preferences()
        studio_obj._cloud_revocation_pending = True
        studio_obj._agent_cloud_error = ""
        device_id = config["deviceId"]
        def run():
            confirmed = False
            try:
                if bridge:
                    bridge.stop_cloud()
                cloud.revoke(config, timeout=8)
                confirmed = True
            except Exception:
                pass
            studio_obj.cloudRevocationFinished.emit(confirmed, device_id)
        threading.Thread(target=run, name="supermd-agent-cloud-revoke", daemon=True).start()
    except Exception as error:
        studio_obj._agent_cloud_error = str(error)[:180]
    studio_obj._emit(False)

def _replace_agent_pairing(studio_obj, build_pairing) -> bool:
    try:
        if getattr(studio_obj, "_cloud_revocation_pending", False):
            raise ValueError("Wait for desktop pairing revocation to finish")
        cloud = _agent_cloud()
        old_config = None
        try: old_config = cloud.read_cloud_config(studio_obj._agent_cloud_config_path)
        except Exception: pass
        bridge = _agent_bridge(studio_obj)
        if bridge and bridge.cloudClient.enabled:
            _stop_cloud_bridge(studio_obj, bridge)
        pairing = build_pairing(cloud)
        cloud.write_cloud_config(studio_obj._agent_cloud_config_path, cloud.device_config(pairing))
        getattr(studio_obj, "_best_effort_revoke_cloud_config", best_effort_revoke_cloud_config)(old_config)
        studio_obj._agent_cloud_error = ""
        studio_obj._emit(False)
        return True
    except Exception as error:
        studio_obj._agent_cloud_error = str(error)[:180]
        studio_obj._emit(False)
        return False

def create_agent_pairing(studio_obj, server_origin) -> bool:
    return _replace_agent_pairing(studio_obj, lambda cloud: cloud.new_pairing(server_origin))

def import_agent_pairing(studio_obj, source) -> bool:
    def load_pairing(cloud):
        path = _studio_module().local_path(source)
        if path.stat().st_size > 16_000:
            raise ValueError("Pairing file is too large")
        return cloud.validate_pairing(json.loads(path.read_text(encoding="utf-8")))
    return _replace_agent_pairing(studio_obj, load_pairing)

def export_agent_pairing(studio_obj, destination) -> bool:
    try:
        cloud = _agent_cloud()
        path = _studio_module().local_path(destination)
        cloud.export_pairing(path, cloud.read_cloud_config(studio_obj._agent_cloud_config_path))
        studio_obj.message = f"Pairing file saved to {path}"
        studio_obj._agent_cloud_error = ""
        studio_obj._emit(False)
        return True
    except Exception as error:
        studio_obj._agent_cloud_error = str(error)[:180]
        studio_obj._emit(False)
        return False

def set_cloud_agent_enabled(studio_obj, enabled) -> None:
    bridge = _agent_bridge(studio_obj)
    try:
        if bridge is None:
            raise ValueError("Cloud agent access is unavailable in this app session")
        if enabled:
            config = _agent_cloud().read_cloud_config(studio_obj._agent_cloud_config_path)
            was_enabled = bridge.enabled
            bridge.start_cloud(config)
            studio_obj._cloud_started_local_bridge = not was_enabled
            studio_obj.settings["cloudAgentEnabled"] = True
        else:
            _stop_cloud_bridge(studio_obj, bridge)
        studio_obj._preferences()
        studio_obj._agent_cloud_error = ""
    except Exception as error:
        studio_obj.settings["cloudAgentEnabled"] = False
        studio_obj._agent_cloud_error = str(error)[:180]
    studio_obj._emit(False)

def copy_cloud_connector_url(studio_obj) -> None:
    url = studio_obj.cloudConnectorUrl
    if not url:
        studio_obj._agent_cloud_error = "Create or import a pairing before copying the connector URL."
    else:
        _studio_module().QGuiApplication.clipboard().setText(url)
        studio_obj._agent_cloud_error = "Connector URL copied. Treat it as a secret."
    studio_obj._emit(False)

def set_agent_access_enabled(studio_obj, enabled) -> None:
    bridge = _agent_bridge(studio_obj)
    if bridge is None:
        studio_obj._agent_error = "Live agent access is unavailable in this app session."
        studio_obj._emit(False)
        return
    try:
        if enabled:
            bridge.start()
        else:
            bridge.stop()
            studio_obj.settings["cloudAgentEnabled"] = False
        studio_obj._agent_error = ""
        studio_obj.settings["agentAccessEnabled"] = bool(enabled)
        studio_obj._preferences()
        studio_obj._emit(False)
    except Exception as error:
        studio_obj._agent_error = f"Could not enable live agent access ({type(error).__name__})."
        studio_obj.settings["agentAccessEnabled"] = False
        studio_obj._emit(False)

def copy_agent_setup_instructions(studio_obj) -> None:
    if not studio_obj.agentAccessEnabled:
        studio_obj._agent_error = "Enable live agent access before copying its MCP configuration."
        studio_obj._emit(False)
        return
    _studio_module().QGuiApplication.clipboard().setText(studio_obj.agentSetupInstructions)
    studio_obj._agent_error = ""
    studio_obj.message = "MCP server configuration copied to clipboard"
    studio_obj._emit(False)

def save_agent_setup_instructions(studio_obj, destination) -> None:
    if not studio_obj.agentAccessEnabled:
        studio_obj._agent_error = "Enable live agent access before saving its setup guide."
        studio_obj._emit(False)
        return
    studio_mod = _studio_module()
    try:
        path = studio_mod.local_path(destination)
        if path.suffix.casefold() != ".md":
            path = path.with_suffix(".md")
        root_dir = studio_mod.ROOT
        skill_path = root_dir / "dist" / "super-md-agent-SKILL.md"
        if skill_path.is_file():
            skill = skill_path.read_text(encoding="utf-8").rstrip()
        elif not getattr(sys, "frozen", False):
            skill = _bundle_agent_skill_markdown(root_dir / "docs" / "skills" / "super-md").rstrip()
        else:
            raise FileNotFoundError("Bundled super-md-agent-SKILL.md is missing")
        guide = (skill + "\n\n# Connection for this installation\n\n"
                 "This local MCP server can inspect and revise tabs that are open in this Super MD app session. "
                 "It runs over stdio and reads the private, temporary discovery directory shown below.\n\n"
                 "## MCP client configuration\n\n```json\n" + studio_obj.agentSetupInstructions + "\n```\n\n"
                 "Live access is off by default. Enable it in Super MD Settings → AI agents before starting the MCP server. "
                 "Disabling access or closing Super MD revokes the temporary session token. The token is not included in this file.\n")
        if studio_obj.cloudAgentConfigured and studio_obj.cloudConnectorUrl:
            guide += ("\n## Cloud relay connector\n\n"
                      "Use this Streamable HTTP MCP endpoint with the intended MCP client. It is a bearer capability; "
                      "keep this guide private and share it only with that client.\n\n"
                      "```text\n" + studio_obj.cloudConnectorUrl + "\n```\n")
        studio_mod.atomic_write(path, guide.encode("utf-8"))
        studio_obj._agent_error = ""
        studio_obj.message = f"Setup guide saved to {path}"
        studio_obj._emit(False)
    except (OSError, ValueError, TypeError) as error:
        studio_obj._agent_error = f"Could not save setup guide ({type(error).__name__})."
        studio_obj._emit(False)

def export_agent_skill(studio_obj, destination) -> bool:
    studio_mod = _studio_module()
    try:
        path = studio_mod.local_path(destination)
        if path.suffix.casefold() != ".zip":
            path = path.with_suffix(".zip")
        studio_mod.atomic_write(path, _build_agent_skill_zip_bytes(studio_mod.ROOT))
        studio_obj._agent_error = ""
        studio_obj.message = f"Skill package saved to {path}"
        studio_obj._emit(False)
        return True
    except (OSError, ValueError, TypeError, zipfile.BadZipFile) as error:
        studio_obj._agent_error = f"Could not save skill package ({type(error).__name__})."
        studio_obj._emit(False)
        return False
