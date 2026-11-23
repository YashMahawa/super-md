import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from types import SimpleNamespace

from studio import Studio, agent_mcp_setup_config


class AgentSetupInstructionsTests(unittest.TestCase):
    def test_exported_setup_guide_is_a_self_contained_skill_with_working_configuration(self):
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "agent guide.md"
            setup = json.dumps({"command": "/apps/super-md", "args": ["agent", "mcp"]})
            proxy = SimpleNamespace(agentAccessEnabled=True, agentSetupInstructions=setup,
                                    cloudAgentConfigured=False, _emit=lambda *args: None)
            Studio.saveAgentSetupInstructions(proxy, str(destination))
            self.assertEqual(proxy._agent_error, "")
            text = destination.read_text(encoding="utf-8")
            self.assertTrue(text.startswith("---\nname: super-md\n"))
            self.assertIn(setup, text)
            self.assertIn("diagram-image", text)
            self.assertIn("asset_action", text)
            self.assertIn("get_context", text)
            self.assertNotIn("pairingKey", text)

    def test_source_fallback_exports_connection_reference_without_a_build(self):
        import studio
        import shutil
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = Path(studio.__file__).resolve().parent.parent / "docs" / "skills" / "super-md"
            shutil.copytree(source, root / "docs" / "skills" / "super-md")
            destination = root / "agent guide.md"
            setup = json.dumps({"command": "/apps/super-md", "args": ["agent", "mcp"]})
            proxy = SimpleNamespace(agentAccessEnabled=True, agentSetupInstructions=setup,
                                    cloudAgentConfigured=False, _emit=lambda *args: None)
            with patch.object(studio, "ROOT", root):
                Studio.saveAgentSetupInstructions(proxy, str(destination))
            self.assertEqual(proxy._agent_error, "")
            text = destination.read_text(encoding="utf-8")
            self.assertTrue(text.startswith("---\nname: super-md\n"))
            for required in [setup, "diagram-image", "asset_action", "get_context"]:
                self.assertIn(required, text)
            self.assertNotIn("pairingKey", text)

    @unittest.skipUnless(os.name == "posix", "venv Python symlinks require POSIX")
    def test_source_python_symlink_retains_its_virtual_environment(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            base = root / "base-python"
            base.touch()
            python = root / "venv/bin/python"
            python.parent.mkdir(parents=True)
            python.symlink_to(base)
            config = agent_mcp_setup_config(root / "sessions", executable=python, frozen=False)
            self.assertEqual(config["command"], os.path.abspath(python))
            self.assertNotEqual(config["command"], str(python.resolve()))

    def test_unrelated_parent_appimage_environment_does_not_replace_managed_launcher(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            image = root / "Other editor.AppImage"
            image.touch()
            executable = root / "installed/super-md"
            with patch.dict(os.environ, {"APPIMAGE": str(image), "APPDIR": str(root / "other-mount")}):
                config = agent_mcp_setup_config(root / "sessions", executable=executable, frozen=True, platform="linux")
            self.assertEqual(config["command"], str(executable.resolve()))

    def test_source_checkout_uses_absolute_python_script_and_session_directory(self):
        with tempfile.TemporaryDirectory(prefix="Super MD setup ") as directory:
            root = Path(directory)
            python = root / "venv" / "bin" / "python"
            script = root / "desktop" / "agent_cli.py"
            sessions = root / "app data" / "agent sessions"
            config = agent_mcp_setup_config(sessions, executable=python, frozen=False,
                                            platform="linux", cli_script=script)
        self.assertEqual(config["command"], os.path.abspath(python))
        self.assertEqual(config["args"], [str(script.resolve()), "mcp", "--live-sessions-dir",
                                           str(sessions.resolve()), "--transport", "stdio"])
        self.assertTrue(Path(config["command"]).is_absolute())
        self.assertTrue(Path(config["args"][0]).is_absolute())

    def test_source_checkout_uses_console_python_when_started_with_pythonw(self):
        with tempfile.TemporaryDirectory() as directory:
            pythonw = Path(directory) / "pythonw.exe"
            python = Path(directory) / "python.exe"
            python.touch()
            config = agent_mcp_setup_config(Path(directory) / "sessions", executable=pythonw,
                                            frozen=False, platform="win32", cli_script=Path(directory) / "agent_cli.py")
        self.assertEqual(config["command"], os.path.abspath(python))
        self.assertEqual(config["args"][1], "mcp")

    def test_frozen_linux_and_macos_run_the_absolute_app_executable_dispatch(self):
        for platform in ("linux", "darwin"):
            with self.subTest(platform=platform), tempfile.TemporaryDirectory() as directory:
                executable = Path(directory) / "Super MD"
                config = agent_mcp_setup_config(Path(directory) / "sessions", executable=executable,
                                                frozen=True, platform=platform)
            self.assertEqual(config["command"], str(executable.resolve()))
            self.assertEqual(config["args"][:2], ["agent", "mcp"])

    def test_frozen_windows_uses_the_bundled_console_launcher(self):
        with tempfile.TemporaryDirectory() as directory:
            gui = Path(directory) / "super-md.exe"
            config = agent_mcp_setup_config(Path(directory) / "sessions", executable=gui,
                                            frozen=True, platform="win32")
            installer = Path(__file__).with_name("windows") / "installer.nsi"
            installer_text = installer.read_text(encoding="utf-8")
        self.assertEqual(config["command"], str((gui.parent / "super-md-cli.exe").resolve()))
        self.assertEqual(config["args"][:2], ["agent", "mcp"])
        self.assertIn('Delete "$INSTDIR\\super-md-cli.exe"', installer_text)

    def test_frozen_linux_appimage_uses_persistent_image_instead_of_mount_path(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            mounted_executable = root / ".mount_supermd" / "usr" / "lib" / "super-md" / "super-md"
            mounted_executable.parent.mkdir(parents=True)
            mounted_executable.touch()
            image = root / "Super MD.AppImage"
            image.touch()
            with patch.dict(os.environ, {"APPIMAGE": str(image), "APPDIR": str(root / ".mount_supermd")}):
                config = agent_mcp_setup_config(root / "sessions", executable=mounted_executable,
                                                frozen=True, platform="linux")
        self.assertEqual(config["command"], str(image.resolve()))
        self.assertEqual(config["args"][:2], ["agent", "mcp"])

    def test_frozen_managed_linux_copy_and_stale_appimage_use_actual_executable(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            executable = root / ".local" / "opt" / "super-md-qt-1.2.3" / "super-md"
            executable.parent.mkdir(parents=True)
            executable.touch()
            absent_image = root / "removed.AppImage"
            with patch.dict(os.environ, {"APPIMAGE": str(absent_image)}):
                config = agent_mcp_setup_config(root / "sessions", executable=executable,
                                                frozen=True, platform="linux")
        self.assertEqual(config["command"], str(executable.resolve()))

    def test_appimage_environment_is_ignored_for_source_and_non_linux_builds(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            image = root / "Super MD.AppImage"
            image.touch()
            executable = root / "super-md"
            with patch.dict(os.environ, {"APPIMAGE": str(image)}):
                source = agent_mcp_setup_config(root / "sessions", executable=executable,
                                                frozen=False, platform="linux", cli_script=root / "agent_cli.py")
                mac = agent_mcp_setup_config(root / "sessions", executable=executable,
                                             frozen=True, platform="darwin")
        self.assertEqual(source["command"], os.path.abspath(executable))
        self.assertEqual(mac["command"], str(executable.resolve()))

    def test_property_json_contains_ready_to_copy_command_configuration(self):
        with tempfile.TemporaryDirectory() as directory:
            config = agent_mcp_setup_config(Path(directory) / "private sessions", executable=Path("/usr/bin/python3"),
                                            frozen=False, platform="darwin", cli_script=Path("/opt/Super MD/desktop/agent_cli.py"))
            encoded = json.dumps(config, ensure_ascii=False, indent=2)
        parsed = json.loads(encoded)
        self.assertEqual(parsed["command"], os.path.abspath("/usr/bin/python3"))
        self.assertEqual(parsed["args"][1:], ["mcp", "--live-sessions-dir", str((Path(directory) / "private sessions").resolve()), "--transport", "stdio"])

    @staticmethod
    def _assert_complete_self_contained_guide(testcase: unittest.TestCase, text: str):
        import re
        for required in (
            "study-notes.md",
            "visual-authoring.md",
            "agent-connection.md",
            "# Exam-ready study notes",
            "# Diagram and interaction guide",
            "# Agent connection",
            "# Connection for this installation",
        ):
            testcase.assertIn(required, text)
        stripped = re.sub(r"```.*?```", "", text, flags=re.DOTALL)
        stripped = re.sub(r"`[^`\n]+`", "", stripped)
        headings = {
            re.sub(r"[^a-z0-9 -]", "", line.lstrip("#").strip().lower()).replace(" ", "-")
            for line in stripped.splitlines()
            if line.startswith("#")
        }
        for target in re.findall(r"\[[^\]]+\]\(([^)]+)\)", stripped):
            if target.startswith(("https://", "http://")):
                continue
            testcase.assertTrue(target.startswith("#"), f"Unexpected relative file link in standalone guide: {target}")
            testcase.assertIn(target[1:], headings, f"Broken anchor in standalone guide: {target}")

    def test_saved_guides_embed_all_authoring_references_without_broken_relative_links(self):
        import shutil
        import studio

        with tempfile.TemporaryDirectory() as directory:
            temp = Path(directory)
            setup = json.dumps({"command": "/apps/super-md", "args": ["agent", "mcp"]})
            built_dest = temp / "built-guide.md"
            proxy = SimpleNamespace(agentAccessEnabled=True, agentSetupInstructions=setup,
                                    cloudAgentConfigured=False, _emit=lambda *args: None)
            Studio.saveAgentSetupInstructions(proxy, str(built_dest))
            self._assert_complete_self_contained_guide(self, built_dest.read_text(encoding="utf-8"))

            fallback_root = temp / "source-checkout"
            shutil.copytree(Path(studio.__file__).resolve().parent.parent / "docs" / "skills" / "super-md",
                            fallback_root / "docs" / "skills" / "super-md")
            fallback_dest = temp / "fallback-guide.md"
            with patch.object(studio, "ROOT", fallback_root):
                Studio.saveAgentSetupInstructions(proxy, str(fallback_dest))
            self._assert_complete_self_contained_guide(self, fallback_dest.read_text(encoding="utf-8"))

    def test_workspace_new_note_and_open_tab_folders_populate_deduplicated_roots_and_copy_sets_message(self):
        from PySide6.QtGui import QGuiApplication
        app = QGuiApplication.instance() or QGuiApplication([])
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            workspace_dir = base / "workspace"
            new_notes_dir = base / "new-notes"
            note_dir = base / "course-notes"
            other_window_dir = base / "window-two"
            retired_dir = base / "retired-window"
            sessions_dir = base / "sessions"
            for folder in (workspace_dir, new_notes_dir, note_dir, other_window_dir, retired_dir, sessions_dir):
                folder.mkdir(parents=True)
            saved_note = note_dir / "lecture.smd"
            saved_note.write_text("# Lecture\n", encoding="utf-8")
            dup_note = workspace_dir / "duplicate.md"
            dup_note.write_text("# Dup\n", encoding="utf-8")

            second_window = SimpleNamespace(
                retired=False,
                folder=str(other_window_dir),
                tabs=[{"id": "t2", "path": str(dup_note)}, {"id": "t3", "path": ""}],
            )
            retired_window = SimpleNamespace(
                retired=True,
                folder=str(retired_dir),
                tabs=[{"id": "t4", "path": str(retired_dir / "old.md")}],
            )
            bridge = SimpleNamespace(enabled=True, discovery_dir=sessions_dir)
            emitted = []
            studio_proxy = SimpleNamespace(
                retired=False,
                folder=str(workspace_dir),
                settings={"newNoteLocation": str(new_notes_dir)},
                tabs=[
                    {"id": "t1", "path": str(saved_note)},
                    {"id": "t-dup", "path": str(dup_note)},
                    {"id": "t-unsaved", "path": ""},
                ],
                message="",
                _agent_error="",
                _emit=lambda *args: emitted.append(args),
            )
            studio_proxy.session = SimpleNamespace(
                agent_bridge=bridge,
                windows={"w1": studio_proxy, "w2": second_window, "w3": retired_window},
            )
            studio_proxy._agent_mcp_roots = lambda: Studio._agent_mcp_roots(studio_proxy)
            studio_proxy.agentAccessEnabled = True
            studio_proxy.agentSetupInstructions = Studio.agentSetupInstructions.fget(studio_proxy)

            parsed = json.loads(studio_proxy.agentSetupInstructions)
            args = parsed["args"]
            root_values = [args[i + 1] for i, token in enumerate(args[:-1]) if token == "--root"]
            self.assertEqual(
                root_values,
                [
                    str(workspace_dir.resolve()),
                    str(other_window_dir.resolve()),
                    str(new_notes_dir.resolve()),
                    str(note_dir.resolve()),
                ],
            )
            self.assertNotIn(str(retired_dir.resolve()), root_values)

            Studio.copyAgentSetupInstructions(studio_proxy)
            self.assertEqual(app.clipboard().text(), studio_proxy.agentSetupInstructions)
            self.assertIn("copied", studio_proxy.message.lower())
            self.assertTrue(emitted)

    def test_export_skill_package_excludes_local_preferences_and_credentials(self):
        import shutil
        import zipfile
        import studio

        with tempfile.TemporaryDirectory() as directory:
            temp = Path(directory)
            proxy = SimpleNamespace(
                _agent_error="",
                message="",
                cloudConnectorUrl="https://relay.example.test/mcp/secret-token",
                _emit=lambda *args: None,
            )
            built_zip = temp / "exported-skill"
            self.assertTrue(Studio.exportAgentSkill(proxy, str(built_zip)))
            expected_zip = temp / "exported-skill.zip"
            self.assertTrue(expected_zip.is_file())
            self.assertIn("Skill package saved", proxy.message)

            fallback_root = temp / "source-only"
            skill_copy = fallback_root / "docs" / "skills" / "super-md"
            shutil.copytree(Path(studio.__file__).resolve().parent.parent / "docs" / "skills" / "super-md", skill_copy)
            (skill_copy / "references" / "local-preferences.md").write_text("Private user notes\n", encoding="utf-8")
            fallback_zip = temp / "fallback-skill.zip"
            with patch.object(studio, "ROOT", fallback_root):
                self.assertTrue(Studio.exportAgentSkill(proxy, str(fallback_zip)))

            for archive_path in (expected_zip, fallback_zip):
                with zipfile.ZipFile(archive_path, "r") as zf:
                    names = set(zf.namelist())
                    for required in (
                        "super-md/SKILL.md",
                        "super-md/references/study-notes.md",
                        "super-md/references/visual-authoring.md",
                        "super-md/references/agent-connection.md",
                        "super-md/assets/study-visual-example.svg",
                    ):
                        self.assertIn(required, names)
                    self.assertFalse(any("local-preferences.md" in name for name in names))
                    combined = b"".join(zf.read(name) for name in names).decode("utf-8", errors="replace")
                    self.assertNotIn("secret-token", combined)
                    self.assertNotIn("pairingKey", combined)

    def test_install_skill_supports_agent_presets_and_preserves_local_preferences_on_replace(self):
        import io
        from contextlib import redirect_stdout
        import agent_cli

        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            env = {
                "HOME": str(home),
                "USERPROFILE": str(home),
                "CODEX_HOME": str(home / ".codex"),
                "CLAUDE_CONFIG_DIR": str(home / ".claude"),
                "CURSOR_HOME": str(home / ".cursor"),
            }
            with patch.dict(os.environ, env, clear=False), patch("pathlib.Path.home", return_value=home):
                for preset, expected_dir in (
                    ("claude", home / ".claude" / "skills" / "super-md"),
                    ("cursor", home / ".cursor" / "skills" / "super-md"),
                    ("codex", home / ".codex" / "skills" / "super-md"),
                ):
                    buf = io.StringIO()
                    with redirect_stdout(buf):
                        code = agent_cli.main(["install-skill", "--agent", preset])
                    self.assertEqual(code, 0)
                    payload = json.loads(buf.getvalue())
                    self.assertTrue(payload["ok"])
                    self.assertEqual(Path(payload["result"]["installed"]), expected_dir)
                    for rel in (
                        "SKILL.md",
                        "references/study-notes.md",
                        "references/visual-authoring.md",
                        "references/agent-connection.md",
                        "assets/study-visual-example.svg",
                    ):
                        self.assertTrue((expected_dir / rel).is_file(), f"Missing {rel} for {preset}")

                claude_dir = home / ".claude" / "skills" / "super-md"
                prefs = claude_dir / "references" / "local-preferences.md"
                prefs.write_text("Preferred notation: Dirac bra-ket\n", encoding="utf-8")
                buf = io.StringIO()
                with redirect_stdout(buf):
                    code = agent_cli.main(["install-skill", "--agent", "claude", "--replace"])
                self.assertEqual(code, 0)
                replaced = json.loads(buf.getvalue())
                self.assertIsNotNone(replaced["result"]["backup"])
                self.assertEqual(prefs.read_text(encoding="utf-8"), "Preferred notation: Dirac bra-ket\n")

    def test_persistent_local_agent_access_restores_across_sessions_with_fresh_token_and_respects_test_state(self):
        import sys
        from PySide6.QtCore import QStandardPaths, QUrl
        from PySide6.QtGui import QGuiApplication
        from PySide6.QtQml import QQmlComponent, QQmlEngine
        from agent_live import create_qt_bridge
        from studio import Session, Studio

        _app = QGuiApplication.instance() or QGuiApplication([])
        with tempfile.TemporaryDirectory() as app_data_root:
            with patch.object(QStandardPaths, "writableLocation", return_value=app_data_root):
                first = Session(isolated=False)
                first.settings["python"] = sys.executable
                self.assertFalse(first.settings["agentAccessEnabled"])
                first.agent_bridge = create_qt_bridge(first, first.data)
                studio1 = Studio(False, first)
                engine = QQmlEngine()
                panel = None
                try:
                    self.assertFalse(studio1.agentAccessEnabled)
                    component = QQmlComponent(engine, QUrl.fromLocalFile(str(Path(__file__).resolve().parent / "qml" / "AgentAccess.qml")))
                    self.assertTrue(component.isReady(), component.errorString())
                    engine.rootContext().setContextProperty("studio", studio1)
                    view_state = SimpleNamespace(colors={"muted": "#666666", "primary": "#386a57", "outline": "#cccccc", "surface": "#ffffff", "text": "#111111"})
                    panel = component.createWithInitialProperties({"hostStudio": studio1, "viewState": {"colors": view_state.colors}})
                    self.assertIsNotNone(panel, component.errorString())
                    export_btn = panel.findChild(object, "exportAgentSkill")
                    self.assertIsNotNone(export_btn)
                    switch = panel.findChild(object, "liveAgentAccessSwitch")
                    self.assertIsNotNone(switch)

                    studio1.setAgentAccessEnabled(True)
                    self.assertTrue(studio1.agentAccessEnabled)
                    self.assertTrue(first.settings["agentAccessEnabled"])
                    first_token = first.agent_bridge.token
                    first_discovery = first.agent_bridge.discovery_path
                    self.assertTrue(first_discovery.is_file())
                    if os.name == "posix":
                        self.assertEqual(first.agent_bridge.discovery_dir.stat().st_mode & 0o777, 0o700)
                finally:
                    if panel is not None:
                        panel.deleteLater()
                    studio1.stop()
                    first.agent_bridge.stop()
                    first.writes.shutdown(wait=True)
                self.assertFalse(first_discovery.exists())

                isolated = Session(isolated=True)
                try:
                    self.assertFalse(isolated.settings["agentAccessEnabled"])
                    self.assertNotEqual(isolated.data, first.data)
                finally:
                    isolated.writes.shutdown(wait=True)

                second = Session(isolated=False)
                second.settings["python"] = sys.executable
                self.assertTrue(second.settings["agentAccessEnabled"])
                second.agent_bridge = create_qt_bridge(second, second.data)
                studio2 = Studio(False, second)
                try:
                    if second.settings.get("agentAccessEnabled"):
                        second.agent_bridge.start()
                    self.assertTrue(studio2.agentAccessEnabled)
                    second_token = second.agent_bridge.token
                    second_discovery = second.agent_bridge.discovery_path
                    self.assertNotEqual(second_token, first_token)
                    self.assertTrue(second_discovery.is_file())
                finally:
                    studio2.stop()
                    second.agent_bridge.stop()
                    second.writes.shutdown(wait=True)
                self.assertFalse(second_discovery.exists())


if __name__ == "__main__":
    unittest.main()
