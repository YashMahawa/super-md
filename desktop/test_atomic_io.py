import ast
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

if __package__:
    from . import atomic_io, documents
else:
    import atomic_io
    import documents


class AtomicIoTest(unittest.TestCase):
    def test_documents_reexports_atomic_io_symbols_and_os_singleton(self):
        self.assertIs(documents.atomic_output_file, atomic_io.atomic_output_file)
        self.assertIs(documents._StagedAtomicJsonScope, atomic_io._StagedAtomicJsonScope)
        self.assertIs(documents._stage_target_key, atomic_io._stage_target_key)
        self.assertIs(documents._ATOMIC_JSON_STAGE_TLS, atomic_io._ATOMIC_JSON_STAGE_TLS)
        self.assertIs(documents._replace_with_windows_sharing_retry, atomic_io._replace_with_windows_sharing_retry)
        self.assertIs(documents._write_json_str, atomic_io._write_json_str)
        self.assertIs(documents.os, atomic_io.os)
        for name in ("atomic_write", "atomic_json", "stage_atomic_json", "_write_json_value"):
            self.assertTrue(callable(getattr(documents, name)), name)

    def test_atomic_io_has_no_monkeypatch_detection_or_module_registries(self):
        source = Path(atomic_io.__file__).read_text(encoding="utf-8")
        tree = ast.parse(source, filename=atomic_io.__file__)
        for forbidden in (
            "sys.modules",
            "_reexport_namespaces",
            "_bind_reexport_namespace",
            "_resolve_reexported",
            "_DEFAULT_",
        ):
            self.assertNotIn(forbidden, source)
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                self.assertNotIn("sys", [alias.name for alias in node.names])
            elif isinstance(node, ast.ImportFrom):
                self.assertNotEqual(node.module, "sys")
            elif isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
                self.assertNotEqual(node.func.id, "globals")

    def test_repo_root_package_imports_resolve_cleanly_in_clean_subprocess(self):
        env = {k: v for k, v in os.environ.items() if k not in {"PYTHONPATH", "PYTHONSAFEPATH", "PYTHONSTARTUP"}}
        repo_root = Path(__file__).resolve().parent.parent
        for probe in (
            "from desktop import atomic_io, documents\n"
            "from desktop.core import closed_notes\n"
            "assert documents.atomic_output_file is atomic_io.atomic_output_file\n"
            "assert all(callable(getattr(documents, n)) for n in ('atomic_json', 'stage_atomic_json', 'atomic_write', '_write_json_value'))\n"
            "assert closed_notes.atomic_json is documents.atomic_json\n",
            "from desktop.core import closed_notes\n"
            "from desktop import atomic_io, documents\n"
            "assert documents.atomic_output_file is atomic_io.atomic_output_file\n"
            "assert callable(documents.atomic_json)\n"
            "assert closed_notes.atomic_json is documents.atomic_json\n",
        ):
            proc = subprocess.run(
                [sys.executable, "-E", "-c", probe],
                cwd=repo_root,
                env=env,
                capture_output=True,
                text=True,
                timeout=30,
            )
            self.assertEqual(proc.returncode, 0, proc.stdout + "\n" + proc.stderr)

    def test_mid_write_failures_preserve_target_and_remove_temp_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)

            out_target = root / "stream.bin"
            out_target.write_bytes(b"keep-stream")
            with self.assertRaises(RuntimeError):
                with atomic_io.atomic_output_file(out_target) as raw:
                    raw.write(b"partial-data")
                    raise RuntimeError("abort mid-stream")
            self.assertEqual(out_target.read_bytes(), b"keep-stream")
            self.assertEqual(list(root.glob("*.tmp")), [])

            fdopen_target = root / "fdopen.bin"
            fdopen_target.write_bytes(b"keep-fdopen")
            closed_fds: list[int] = []
            real_close = os.close
            with patch.object(documents.os, "fdopen", side_effect=OSError("fdopen failed")), \
                 patch.object(documents.os, "close", side_effect=lambda fd: (closed_fds.append(fd), real_close(fd))):
                with self.assertRaises(OSError):
                    with atomic_io.atomic_output_file(fdopen_target):
                        pass
            self.assertEqual(len(closed_fds), 1)
            self.assertEqual(fdopen_target.read_bytes(), b"keep-fdopen")
            self.assertEqual(list(root.glob("*.tmp")), [])

            write_target = root / "note.md"
            write_target.write_bytes(b"keep-markdown")
            with patch(f"{documents.__name__}.os.replace", side_effect=OSError("disk full")):
                with self.assertRaises(OSError):
                    documents.atomic_write(write_target, b"discarded")
            self.assertEqual(write_target.read_bytes(), b"keep-markdown")
            self.assertEqual(list(root.glob("*.tmp")), [])

            json_target = root / "recovery.json"
            json_target.write_bytes(b'{"saved": true}')
            with self.assertRaises(TypeError):
                documents.atomic_json(json_target, {"ok": "partial", "bad": object()})
            self.assertEqual(json_target.read_bytes(), b'{"saved": true}')
            self.assertEqual(list(root.glob("*.tmp")), [])

            smd_target = root / "note.smd"
            smd_target.write_bytes(b"keep-portable")
            with patch(f"{documents.__name__}.MAX_FILE", 32):
                with self.assertRaises(ValueError):
                    documents.write_portable(smd_target, "# Exceeds 32-byte compressed limit\n", {})
            self.assertEqual(smd_target.read_bytes(), b"keep-portable")
            self.assertEqual(list(root.glob("*.tmp")), [])

    @unittest.skipUnless(os.name == "posix" and hasattr(os, "fchmod"), "POSIX mode bits require fchmod")
    def test_posix_mode_bits_preserved_across_all_atomic_writers(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            raw_path = root / "raw.bin"
            raw_path.write_bytes(b"initial")
            raw_path.chmod(0o640)
            with atomic_io.atomic_output_file(raw_path) as handle:
                handle.write(b"updated")
            self.assertEqual(stat.S_IMODE(raw_path.stat().st_mode), 0o640)

            md_path = root / "note.md"
            md_path.write_bytes(b"initial")
            md_path.chmod(0o640)
            documents.atomic_write(md_path, b"updated")
            self.assertEqual(stat.S_IMODE(md_path.stat().st_mode), 0o640)

            json_path = root / "state.json"
            json_path.write_text("{}", encoding="utf-8")
            json_path.chmod(0o640)
            documents.atomic_json(json_path, {"updated": True})
            self.assertEqual(stat.S_IMODE(json_path.stat().st_mode), 0o640)
            self.assertEqual(json.loads(json_path.read_text(encoding="utf-8")), {"updated": True})

            smd_path = root / "note.smd"
            documents.write_portable(smd_path, "# Initial\n", {})
            smd_path.chmod(0o640)
            documents.write_portable(smd_path, "# Overwritten\n", {})
            self.assertEqual(stat.S_IMODE(smd_path.stat().st_mode), 0o640)
            self.assertEqual(documents.open_note(smd_path), ("# Overwritten\n", {}, True))

    def test_windows_permission_retry_and_fatal_winerror_under_documents_os_patches(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            real_replace = os.replace
            for winerr in (5, 32):
                target = root / f"retry-{winerr}.txt"
                target.write_bytes(b"before")
                sleeps: list[float] = []
                attempts = 0

                def transient_lock(src, dst, code=winerr):
                    nonlocal attempts
                    attempts += 1
                    if attempts <= 2:
                        err = PermissionError("transient lock")
                        err.winerror = code
                        raise err
                    real_replace(src, dst)

                with patch.object(documents.os, "name", "nt"), \
                     patch.object(documents.os, "replace", side_effect=transient_lock), \
                     patch("time.sleep", side_effect=sleeps.append):
                    documents.atomic_write(target, b"after-object-patch")
                self.assertEqual((attempts, sleeps, target.read_bytes()), (3, [0.005, 0.01], b"after-object-patch"))

                attempts = 0
                sleeps.clear()
                with patch.object(documents.os, "name", "nt"), \
                     patch(f"{documents.__name__}.os.replace", side_effect=transient_lock), \
                     patch("time.sleep", side_effect=sleeps.append):
                    documents.atomic_json(target, {"winerror": winerr})
                self.assertEqual((attempts, sleeps), (3, [0.005, 0.01]))
                self.assertEqual(json.loads(target.read_text(encoding="utf-8")), {"winerror": winerr})

            fatal_target = root / "fatal.txt"
            fatal_target.write_bytes(b"untouched")
            fatal = PermissionError("non-sharing permission error")
            fatal.winerror = 13
            for replace_ctx in (patch.object(documents.os, "replace", side_effect=fatal), patch(f"{documents.__name__}.os.replace", side_effect=fatal)):
                with patch.object(documents.os, "name", "nt"), replace_ctx, patch("time.sleep") as sleep_spy:
                    with self.assertRaises(PermissionError):
                        documents.atomic_write(fatal_target, b"blocked")
                    sleep_spy.assert_not_called()
                self.assertEqual(fatal_target.read_bytes(), b"untouched")
                self.assertEqual(list(root.glob("*.tmp")), [])

    def test_stage_atomic_json_and_documents_collaborator_monkeypatch_propagation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            recovery = root / "recovery.json"
            recovery.write_text('[{"v": 0}]', encoding="utf-8")

            seen_payloads: list[object] = []
            seen_strings: list[str] = []
            published_targets: list[Path] = []
            real_write_val = documents._write_json_value
            real_write_str = documents._write_json_str
            real_replace_retry = documents._replace_with_windows_sharing_retry

            def spy_write_val(raw, value, seen):
                seen_payloads.append(value)
                return real_write_val(raw, value, seen)

            def spy_write_str(raw, text):
                seen_strings.append(text)
                return real_write_str(raw, text)

            def spy_replace_retry(src, dst):
                published_targets.append(Path(dst))
                return real_replace_retry(src, dst)

            nested_payload = [{"v": 1, "nested": {"items": ["alpha", {"deep": "beta"}]}}]
            with patch.object(documents, "_write_json_value", side_effect=spy_write_val), \
                 patch.object(documents, "_write_json_str", side_effect=spy_write_str), \
                 patch.object(documents, "_replace_with_windows_sharing_retry", side_effect=spy_replace_retry):
                with documents.stage_atomic_json(recovery) as staged:
                    documents.atomic_json(recovery, nested_payload)
                    self.assertTrue(staged.intercepted)
                    self.assertIsNotNone(staged.temporary)
                    self.assertEqual(published_targets, [])
                    self.assertEqual(json.loads(recovery.read_text(encoding="utf-8")), [{"v": 0}])
                    staged.publish()
                self.assertEqual(published_targets, [recovery.resolve()])
                self.assertEqual(json.loads(recovery.read_text(encoding="utf-8")), nested_payload)
                self.assertEqual(list(root.glob("*.tmp")), [])

                smd_path = root / "portable.smd"
                documents.write_portable(smd_path, "# Portable\n", {})
                self.assertEqual(published_targets[-1], smd_path)
            self.assertIn(nested_payload, seen_payloads)
            self.assertIn({"items": ["alpha", {"deep": "beta"}]}, seen_payloads)
            self.assertIn(["alpha", {"deep": "beta"}], seen_payloads)
            self.assertIn({"deep": "beta"}, seen_payloads)
            self.assertIn("beta", seen_payloads)
            self.assertTrue({"nested", "items", "alpha", "deep", "beta"}.issubset(seen_strings))

            with documents.stage_atomic_json(recovery) as discarded:
                documents.atomic_json(recovery, [{"v": 2}])
                self.assertTrue(discarded.intercepted)
                discarded.discard()
            self.assertEqual(json.loads(recovery.read_text(encoding="utf-8")), nested_payload)
            self.assertEqual(list(root.glob("*.tmp")), [])

            with documents.stage_atomic_json(recovery, abort_check=lambda: True) as aborted:
                documents.atomic_json(recovery, [{"v": 3}])
                self.assertTrue(aborted.intercepted)
                self.assertIsNone(aborted.temporary)
            self.assertEqual(json.loads(recovery.read_text(encoding="utf-8")), nested_payload)
            self.assertEqual(list(root.glob("*.tmp")), [])


if __name__ == "__main__":
    unittest.main()
