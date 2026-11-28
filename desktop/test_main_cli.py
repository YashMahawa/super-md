import io
import json
import os
import runpy
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr
from pathlib import Path
from unittest import mock

import main as desktop_main


def _find_smd_engine() -> Path | None:
    root = desktop_main.ROOT
    executable = "smd-engine.exe" if sys.platform == "win32" else "smd-engine"
    candidates = (
        root / "desktop" / executable,
        root / "smd-core" / "target" / "release" / executable,
        root / "smd-core" / "target" / "debug" / executable,
    )
    return next((path for path in candidates if path.is_file()), None)


class DesktopLauncherUnpackCliTest(unittest.TestCase):
    def test_engine_commands_include_unpack_alongside_pack_and_extract(self):
        for command in ("pack", "extract", "unpack"):
            self.assertIn(command, desktop_main.ENGINE_COMMANDS)

    def test_missing_engine_reports_error_for_unpack(self):
        with tempfile.TemporaryDirectory() as folder:
            stderr = io.StringIO()
            with (
                mock.patch.object(desktop_main, "ROOT", Path(folder)),
                mock.patch.object(sys, "argv", ["super-md", "unpack", "note.smd", "out"]),
                redirect_stderr(stderr),
            ):
                code = desktop_main.main()
            self.assertEqual(code, 1)
            self.assertIn("Native PDF/portable engine is missing from this installation", stderr.getvalue())

    def test_unpack_dispatches_headless_before_graphics_probe_and_prefers_packaged_engine_path(self):
        launcher = Path(__file__).resolve().parent / "main.py"
        executable = "smd-engine.exe" if sys.platform == "win32" else "smd-engine"
        with tempfile.TemporaryDirectory() as folder:
            packaged_root = Path(folder) / "_internal" / "resources"
            packaged_engine = packaged_root / "desktop" / executable
            packaged_engine.parent.mkdir(parents=True)
            packaged_engine.write_bytes(b"packaged-smd-engine")

            for argv, expected_exit in (
                (["super-md", "unpack", "lesson.smd", "out-dir"], 0),
                (["super-md", "unpack"], 1),
            ):
                with (
                    mock.patch("graphics_runtime.configure") as configure_mock,
                    mock.patch("graphics_runtime.probe") as probe_mock,
                    mock.patch("PySide6.QtWebEngineQuick.QtWebEngineQuick.initialize") as webengine_init_mock,
                    mock.patch("studio.ROOT", packaged_root),
                    mock.patch("subprocess.call", return_value=expected_exit) as call_mock,
                    mock.patch.object(sys, "argv", argv),
                ):
                    with self.assertRaises(SystemExit) as exited:
                        runpy.run_path(str(launcher), run_name="__main__")
                    self.assertEqual(exited.exception.code, expected_exit)
                    configure_mock.assert_not_called()
                    probe_mock.assert_not_called()
                    webengine_init_mock.assert_not_called()
                    call_mock.assert_called_once_with([str(packaged_engine), *argv[1:]])

    def test_launcher_dispatches_unpack_with_companion_asset_and_retains_path_and_overwrite_checks(self):
        if _find_smd_engine() is None:
            self.skipTest("smd-engine binary is not built in this workspace")

        launcher = Path(__file__).resolve().parent / "main.py"
        env = dict(os.environ)
        # Force any unintended graphics probe or QGuiApplication initialization to
        # fail immediately; CLI engine subcommands must stay headless pre-graphics.
        for name in (
            "DISPLAY",
            "WAYLAND_DISPLAY",
            "QT_QUICK_BACKEND",
            "QSG_RHI_BACKEND",
            "QTWEBENGINE_CHROMIUM_FLAGS",
        ):
            env.pop(name, None)
        env["QT_QPA_PLATFORM"] = "nonexistent-headless-qpa"

        def run_launcher(*args: str | Path) -> subprocess.CompletedProcess[str]:
            return subprocess.run(
                [sys.executable, str(launcher), *map(str, args)],
                cwd=launcher.parent,
                env=env,
                capture_output=True,
                text=True,
                timeout=30,
            )

        with tempfile.TemporaryDirectory(prefix="supermd-launcher-unpack-") as folder:
            root = Path(folder).resolve()
            companion_svg = (
                b'<svg xmlns="http://www.w3.org/2000/svg" width="48" height="24">'
                b'<rect width="48" height="24" fill="#3476ad"/></svg>'
            )
            (root / "companion.svg").write_bytes(companion_svg)
            note_md = root / "Portable lesson.md"
            note_md.write_text(
                "# Portable Lesson\n\nCompanion asset:\n\n![Figure](companion.svg)\n",
                encoding="utf-8",
            )
            portable_smd = root / "Portable lesson.smd"

            packed = run_launcher("pack", note_md, portable_smd)
            self.assertEqual(packed.returncode, 0, packed.stderr)
            self.assertTrue(portable_smd.is_file())

            # Invalid CLI invocations must fail cleanly without starting graphics or creating partial outputs.
            missing_note = run_launcher("unpack")
            self.assertEqual(missing_note.returncode, 1)
            self.assertIn("Expected note path", missing_note.stderr)

            missing_output = run_launcher("unpack", portable_smd)
            self.assertEqual(missing_output.returncode, 1)
            self.assertIn("Expected usage: smd-engine unpack NOTE OUTPUT_DIR", missing_output.stderr)

            extra_arg_dir = root / "extra-arg-out"
            extra_arg = run_launcher("unpack", portable_smd, extra_arg_dir, "unexpected")
            self.assertEqual(extra_arg.returncode, 1)
            self.assertIn("Expected usage: smd-engine unpack NOTE OUTPUT_DIR", extra_arg.stderr)
            self.assertFalse(extra_arg_dir.exists())

            plain_md_dir = root / "plain-md-out"
            plain_md = run_launcher("unpack", note_md, plain_md_dir)
            self.assertEqual(plain_md.returncode, 1)
            self.assertIn("This note is not portable", plain_md.stderr)
            self.assertFalse(plain_md_dir.exists())

            unpacked_dir = root / "unpacked"
            unpacked = run_launcher("unpack", portable_smd, unpacked_dir)
            self.assertEqual(unpacked.returncode, 0, unpacked.stderr)
            self.assertNotIn("base64", unpacked.stdout)
            summary = json.loads(unpacked.stdout)
            self.assertEqual(summary["assets"], 1)

            extracted_md = unpacked_dir / "Portable lesson.md"
            extracted_asset = unpacked_dir / "assets" / "image-1.svg"
            self.assertTrue(extracted_md.is_file())
            self.assertTrue(extracted_asset.is_file())
            markdown_text = extracted_md.read_text(encoding="utf-8")
            self.assertIn("# Portable Lesson", markdown_text)
            self.assertIn("assets/image-1.svg", markdown_text)
            self.assertNotIn("base64", markdown_text)
            self.assertEqual(extracted_asset.read_bytes(), companion_svg)

            # Retain engine overwrite checks for both Markdown and companion assets.
            extracted_md.write_text("user edited markdown sentinel", encoding="utf-8")
            extracted_asset.write_bytes(b"user edited asset sentinel")
            repeat = run_launcher("unpack", portable_smd, unpacked_dir)
            self.assertEqual(repeat.returncode, 1)
            self.assertIn("Output exists; choose an empty destination or another folder", repeat.stderr)
            self.assertEqual(extracted_md.read_text(encoding="utf-8"), "user edited markdown sentinel")
            self.assertEqual(extracted_asset.read_bytes(), b"user edited asset sentinel")

            asset_collision_dir = root / "asset-collision"
            (asset_collision_dir / "assets").mkdir(parents=True)
            existing_asset = asset_collision_dir / "assets" / "image-1.svg"
            existing_asset.write_bytes(b"preexisting asset bytes")
            asset_collision = run_launcher("unpack", portable_smd, asset_collision_dir)
            self.assertEqual(asset_collision.returncode, 1)
            self.assertIn("Output exists; choose an empty destination or another folder", asset_collision.stderr)
            self.assertEqual(existing_asset.read_bytes(), b"preexisting asset bytes")
            self.assertFalse((asset_collision_dir / "Portable lesson.md").exists())

            # Retain engine output-path checks (regular file target, reserved stem, and symlinks).
            file_as_dir = root / "existing-file.txt"
            file_as_dir.write_text("keep file intact", encoding="utf-8")
            file_target = run_launcher("unpack", portable_smd, file_as_dir)
            self.assertEqual(file_target.returncode, 1)
            self.assertIn("Output path exists and is not a directory", file_target.stderr)
            self.assertEqual(file_as_dir.read_text(encoding="utf-8"), "keep file intact")

            reserved_smd = root / "CON.smd"
            reserved_smd.write_bytes(portable_smd.read_bytes())
            reserved_dir = root / "reserved-out"
            reserved = run_launcher("unpack", reserved_smd, reserved_dir)
            self.assertEqual(reserved.returncode, 0, reserved.stderr)
            self.assertTrue((reserved_dir / "Note.md").is_file())
            self.assertEqual((reserved_dir / "assets" / "image-1.svg").read_bytes(), companion_svg)

            if os.name == "posix":
                outside_dir = root / "outside-target"
                outside_dir.mkdir()
                symlink_dir = root / "symlink-output"
                symlink_dir.symlink_to(outside_dir, target_is_directory=True)
                symlink_res = run_launcher("unpack", portable_smd, symlink_dir)
                self.assertEqual(symlink_res.returncode, 1)
                self.assertIn("Refusing to unpack through a symlink", symlink_res.stderr)
                self.assertEqual(list(outside_dir.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
