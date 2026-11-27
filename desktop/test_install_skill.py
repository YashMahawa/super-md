"""Tests for skill installer replace-and-restore rollback on copy failure."""
import io
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

import install_skill


def _seed_previous_skill_bundle(dest: Path) -> dict[str, bytes]:
    files = {
        "SKILL.md": b"---\nname: super-md\n---\n# Previous installed Super MD skill\n",
        "references/study-notes.md": b"# Previous study-notes reference\n",
        "references/visual-authoring.md": b"# Previous visual-authoring reference\n",
        "references/agent-connection.md": b"# Previous agent-connection reference\n",
        "references/local-preferences.md": b"Preferred notation: Dirac bra-ket and SI units\n",
        "assets/study-visual-example.svg": (
            b"<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'><rect width='10' height='10'/></svg>\n"
        ),
        "previous-bundle-marker.txt": b"previous-bundle-sentinel\n",
    }
    for rel_path, content in files.items():
        target = dest / rel_path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
    return files


def _snapshot_tree(root: Path) -> dict[str, bytes]:
    return {
        path.relative_to(root).as_posix(): path.read_bytes()
        for path in sorted(root.rglob("*"))
        if path.is_file()
    }


class InstallSkillReplaceRollbackTests(unittest.TestCase):
    def test_replace_restores_previous_bundle_and_local_preferences_when_bundle_copy_fails_mid_copy(self):
        with tempfile.TemporaryDirectory() as directory:
            temp_root = Path(directory)
            dest = temp_root / "super-md"
            expected_snapshot = _seed_previous_skill_bundle(dest)

            def failing_copytree(_src, dst, **_kwargs):
                dst_path = Path(dst)
                (dst_path / "references").mkdir(parents=True, exist_ok=True)
                (dst_path / "SKILL.md").write_bytes(b"---\nname: super-md\n---\n# Incomplete new bundle\n")
                (dst_path / "references" / "incomplete.partial").write_bytes(b"partial replacement")
                raise OSError("simulated failure while copying new skill bundle")

            stdout = io.StringIO()
            with patch.object(install_skill.shutil, "copytree", side_effect=failing_copytree), redirect_stdout(stdout):
                with self.assertRaisesRegex(OSError, "simulated failure while copying new skill bundle"):
                    install_skill.main(["--destination", str(dest), "--replace"])

            self.assertEqual(stdout.getvalue(), "")
            self.assertTrue(dest.is_dir())
            self.assertFalse((dest / "references" / "incomplete.partial").exists())
            self.assertEqual(_snapshot_tree(dest), expected_snapshot)
            self.assertEqual([entry.name for entry in temp_root.iterdir()], [dest.name])

    def test_replace_restores_previous_bundle_when_real_copytree_fails_on_bundle_file(self):
        with tempfile.TemporaryDirectory() as directory:
            temp_root = Path(directory)
            dest = temp_root / "super-md"
            expected_snapshot = _seed_previous_skill_bundle(dest)
            copied_bundle_files = 0
            real_copytree = install_skill.shutil.copytree
            real_copy2 = install_skill.shutil.copy2

            def failing_second_bundle_file(src, dst, *args, **kwargs):
                nonlocal copied_bundle_files
                if copied_bundle_files >= 1:
                    raise OSError("simulated mid-bundle file copy failure")
                copied_bundle_files += 1
                copied = real_copy2(src, dst, *args, **kwargs)
                self.assertTrue(Path(dst).is_file())
                return copied

            def copytree_with_failing_copy_function(*args, **kwargs):
                if len(args) < 5 and "copy_function" not in kwargs:
                    kwargs["copy_function"] = failing_second_bundle_file
                return real_copytree(*args, **kwargs)

            stdout = io.StringIO()
            with (
                patch.object(install_skill.shutil, "copytree", side_effect=copytree_with_failing_copy_function),
                redirect_stdout(stdout),
            ):
                with self.assertRaises(install_skill.shutil.Error) as raised:
                    install_skill.main(["--destination", str(dest), "--replace"])

            self.assertIn("simulated mid-bundle file copy failure", str(raised.exception))
            self.assertEqual(copied_bundle_files, 1)
            self.assertEqual(stdout.getvalue(), "")
            self.assertTrue(dest.is_dir())
            self.assertEqual(_snapshot_tree(dest), expected_snapshot)
            self.assertEqual([entry.name for entry in temp_root.iterdir()], [dest.name])

    def test_replace_restores_previous_bundle_and_local_preferences_when_bundle_copy_fails_before_creating_dest(self):
        with tempfile.TemporaryDirectory() as directory:
            temp_root = Path(directory)
            dest = temp_root / "super-md"
            expected_snapshot = _seed_previous_skill_bundle(dest)

            stdout = io.StringIO()
            with (
                patch.object(
                    install_skill.shutil,
                    "copytree",
                    side_effect=PermissionError("simulated permission error before creating replacement"),
                ),
                redirect_stdout(stdout),
            ):
                with self.assertRaisesRegex(PermissionError, "simulated permission error"):
                    install_skill.main(["--destination", str(dest), "--replace"])

            self.assertEqual(stdout.getvalue(), "")
            self.assertTrue(dest.is_dir())
            self.assertEqual(_snapshot_tree(dest), expected_snapshot)
            self.assertEqual([entry.name for entry in temp_root.iterdir()], [dest.name])

    def test_replace_restores_previous_bundle_and_removes_incomplete_replacement_when_local_preferences_copy_fails(self):
        for partial_write in (False, True):
            with self.subTest(partial_write=partial_write), tempfile.TemporaryDirectory() as directory:
                temp_root = Path(directory)
                dest = temp_root / "super-md"
                expected_snapshot = _seed_previous_skill_bundle(dest)
                observed_new_bundle_before_failure = False

                real_copyfile = install_skill.shutil.copyfile

                def failing_copyfile(src, dst, *args, **kwargs):
                    nonlocal observed_new_bundle_before_failure
                    dst_path = Path(dst)
                    if dst_path != dest / "references" / "local-preferences.md":
                        return real_copyfile(src, dst, *args, **kwargs)
                    self.assertTrue((dest / "SKILL.md").is_file())
                    self.assertNotEqual((dest / "SKILL.md").read_bytes(), expected_snapshot["SKILL.md"])
                    self.assertFalse((dest / "previous-bundle-marker.txt").exists())
                    observed_new_bundle_before_failure = True
                    if partial_write:
                        dst_path.parent.mkdir(parents=True, exist_ok=True)
                        dst_path.write_bytes(b"corrupted-partial-preferences")
                    raise OSError("simulated failure while restoring local-preferences.md")

                stdout = io.StringIO()
                with (
                    patch.object(install_skill.shutil, "copyfile", side_effect=failing_copyfile),
                    redirect_stdout(stdout),
                ):
                    with self.assertRaisesRegex(OSError, "simulated failure while restoring local-preferences.md"):
                        install_skill.main(["--destination", str(dest), "--replace"])

                self.assertTrue(observed_new_bundle_before_failure)
                self.assertEqual(stdout.getvalue(), "")
                self.assertTrue(dest.is_dir())
                self.assertEqual(_snapshot_tree(dest), expected_snapshot)
                self.assertEqual(
                    (dest / "references" / "local-preferences.md").read_bytes(),
                    expected_snapshot["references/local-preferences.md"],
                )
                self.assertEqual([entry.name for entry in temp_root.iterdir()], [dest.name])


if __name__ == "__main__":
    unittest.main()
