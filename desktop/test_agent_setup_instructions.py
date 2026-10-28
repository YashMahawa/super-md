import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from studio import agent_mcp_setup_config


class AgentSetupInstructionsTests(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
