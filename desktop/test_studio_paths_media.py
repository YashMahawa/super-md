"""Focused unit tests for unified local path validation and media envelope/writer helpers."""
from __future__ import annotations
import base64, json, os, sys, tempfile, unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import studio_paths_media
from studio import Studio, _validate_local_tab_asset_path

PNG_HEADER = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"


def _make_agent_proxy(*, new_location: str = "", folder: str = "", tabs=(), owned=(), opened=()):
    return SimpleNamespace(
        settings={"newNoteLocation": new_location}, folder=folder, tabs=list(tabs),
        _agent_owned_files=set(owned), _agent_open_paths=set(opened),
    )


class StudioPathsMediaUnitTests(unittest.TestCase):
    @unittest.skipUnless(os.name == "posix", "POSIX symlinks required for system alias simulation")
    def test_unified_system_aliases_var_tmp_etc_across_asset_and_agent_validators(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp).resolve(strict=True)
            private_root = base / "private"
            system_aliases = tuple((str(base / name), str(private_root / name)) for name in ("var", "tmp", "etc"))
            for alias_str, canonical_str in system_aliases:
                Path(canonical_str).mkdir(parents=True)
                Path(alias_str).symlink_to(Path(canonical_str))

            for name in ("var", "tmp", "etc"):
                with self.subTest(alias=name):
                    canonical_dir = private_root / name / "workspace"
                    outside_dir = private_root / name / "outside"
                    canonical_dir.mkdir(parents=True)
                    outside_dir.mkdir(parents=True)

                    note = canonical_dir / "note.smd"
                    note.write_text("# Note\n", encoding="utf-8")
                    asset = canonical_dir / "diagram.svg"
                    asset.write_bytes(b"<svg xmlns='http://www.w3.org/2000/svg'/>")
                    (outside_dir / "secret.md").write_text("secret\n", encoding="utf-8")

                    aliased_asset = base / name / "workspace" / "diagram.svg"
                    aliased_note = base / name / "workspace" / "note.smd"
                    aliased_outside = base / name / "outside" / "secret.md"

                    resolved = _validate_local_tab_asset_path(
                        str(aliased_asset), note, [],
                        unavailable_message="unavailable", outside_message="outside",
                        _system_aliases=system_aliases,
                    )
                    self.assertEqual(resolved, asset.resolve(strict=True))
                    with self.assertRaisesRegex(ValueError, "outside"):
                        _validate_local_tab_asset_path(
                            str(aliased_outside), note, [],
                            unavailable_message="unavailable", outside_message="outside",
                            _system_aliases=system_aliases,
                        )
                    proxy = _make_agent_proxy(folder=str(canonical_dir))
                    self.assertTrue(Studio._agent_path_allowed(proxy, aliased_note, _system_aliases=system_aliases))
                    self.assertFalse(Studio._agent_path_allowed(proxy, aliased_outside, _system_aliases=system_aliases))

        with patch("studio.sys.platform", "darwin"):
            self.assertEqual(
                studio_paths_media._active_system_aliases(None),
                (("/var", "/private/var"), ("/tmp", "/private/tmp"), ("/etc", "/private/etc")),
            )

    def test_symlink_and_windows_junction_rejected_on_ancestor_and_leaf_for_both_validators(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp).resolve(strict=True)
            workspace, sub, outside = base / "workspace", base / "workspace" / "sub", base / "outside"
            sub.mkdir(parents=True)
            outside.mkdir(parents=True)

            note = workspace / "study.smd"
            note.write_text("# Study\n", encoding="utf-8")
            leaf_asset = sub / "figure.png"
            leaf_asset.write_bytes(PNG_HEADER)
            (outside / "escape.png").write_bytes(PNG_HEADER)

            proxy = _make_agent_proxy(folder=str(workspace), owned={str(leaf_asset.resolve(strict=True))})
            for target_component, label in ((leaf_asset, "leaf"), (sub, "ancestor")):
                with self.subTest(kind="junction", component=label), patch(
                    "os.path.isjunction", create=True,
                    side_effect=lambda candidate, target=target_component: Path(candidate) == target,
                ):
                    with self.assertRaisesRegex(ValueError, "outside"):
                        _validate_local_tab_asset_path(
                            str(leaf_asset), note, [],
                            unavailable_message="unavailable", outside_message="outside", _system_aliases=(),
                        )
                    self.assertFalse(Studio._agent_path_allowed(proxy, leaf_asset, _system_aliases=()))

            if os.name == "posix":
                leaf_link = workspace / "leaf-link.png"
                leaf_link.symlink_to(leaf_asset)
                dir_link = workspace / "dir-link"
                dir_link.symlink_to(outside, target_is_directory=True)
                for bad_path, label in ((leaf_link, "leaf"), (dir_link / "escape.png", "ancestor")):
                    with self.subTest(kind="symlink", component=label):
                        with self.assertRaisesRegex(ValueError, "outside"):
                            _validate_local_tab_asset_path(
                                str(bad_path), note, [],
                                unavailable_message="unavailable", outside_message="outside", _system_aliases=(),
                            )
                        self.assertFalse(Studio._agent_path_allowed(proxy, bad_path, _system_aliases=()))

    @unittest.skipUnless(os.name == "posix", "POSIX symlinks required for 8.3 root-alias simulation")
    def test_agent_path_allowed_session_allowlist_and_83_root_alias_rewriting(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp).resolve(strict=True)
            canonical_user = base / "runneradmin"
            notes_dir, tab_dir, unapproved_dir = canonical_user / "notes", canonical_user / "open-tab", canonical_user / "unapproved"
            for folder in (notes_dir, tab_dir, unapproved_dir):
                folder.mkdir(parents=True)

            owned_note = unapproved_dir / "owned.md"
            opened_note = unapproved_dir / "opened.md"
            other_unapproved = unapproved_dir / "other.md"
            open_tab_note = tab_dir / "current.md"
            for item in (owned_note, opened_note, other_unapproved, notes_dir / "draft.md", tab_dir / "sibling.md", open_tab_note):
                item.write_text("# Doc\n", encoding="utf-8")

            allowlist_proxy = _make_agent_proxy(owned={str(owned_note)}, opened={str(opened_note)})
            self.assertTrue(Studio._agent_path_allowed(allowlist_proxy, owned_note, _system_aliases=()))
            self.assertTrue(Studio._agent_path_allowed(allowlist_proxy, opened_note, _system_aliases=()))
            self.assertFalse(Studio._agent_path_allowed(allowlist_proxy, other_unapproved, _system_aliases=()))
            self.assertFalse(Studio._agent_path_allowed(allowlist_proxy, unapproved_dir / "missing.md", _system_aliases=()))
            self.assertFalse(Studio._agent_path_allowed(allowlist_proxy, unapproved_dir, _system_aliases=()))

            short_user = base / "RUNNER~1"
            short_user.symlink_to(canonical_user, target_is_directory=True)
            (notes_dir / "escape.md").symlink_to(other_unapproved)

            orig_is_symlink = Path.is_symlink
            with patch.object(Path, "is_symlink", lambda p: False if p == short_user else orig_is_symlink(p)):
                roots_proxy = _make_agent_proxy(new_location=str(notes_dir), tabs=[{"path": str(open_tab_note)}])
                self.assertTrue(Studio._agent_path_allowed(roots_proxy, short_user / "notes" / "draft.md", _system_aliases=()))
                self.assertTrue(Studio._agent_path_allowed(roots_proxy, short_user / "open-tab" / "sibling.md", _system_aliases=()))
                self.assertFalse(Studio._agent_path_allowed(roots_proxy, short_user / "unapproved" / "other.md", _system_aliases=()))
                self.assertFalse(Studio._agent_path_allowed(roots_proxy, short_user / "notes" / "escape.md", _system_aliases=()))

            aliased_root_proxy = _make_agent_proxy(folder=str(short_user / "notes"))
            self.assertTrue(Studio._agent_path_allowed(aliased_root_proxy, short_user / "notes" / "draft.md", _system_aliases=()))
            self.assertFalse(Studio._agent_path_allowed(aliased_root_proxy, short_user / "notes" / "escape.md", _system_aliases=()))

    def test_media_envelope_fast_path_slicing_and_magic_byte_validation(self):
        large_png = PNG_HEADER + (b"\x00" * 450_000)
        encoded_large = base64.b64encode(large_png).decode("ascii")
        raw_fast = json.dumps({"mimeType": "image/png", "filename": "Chart Export.png", "body": encoded_large})
        self.assertGreater(len(raw_fast), 524_288)
        parsed, source_str, start, end = Studio._parse_media_envelope(raw_fast)
        self.assertIs(source_str, raw_fast)
        self.assertGreater(start, 0)
        self.assertEqual(source_str[start:end], encoded_large)

        with tempfile.TemporaryDirectory() as tmp:
            out_dir = Path(tmp)
            first = Studio._validate_and_write_media(parsed, out_dir, source_str=source_str, body_start=start, body_end=end)
            second = Studio._validate_and_write_media(parsed, out_dir, source_str=source_str, body_start=start, body_end=end)
            self.assertEqual((first["filename"], second["filename"]), ("Chart Export.png", "Chart Export (2).png"))
            self.assertEqual(Path(first["path"]).read_bytes(), large_png)
            self.assertEqual(Path(second["path"]).read_bytes(), large_png)

            with self.assertRaisesRegex(ValueError, "Media bytes do not match"):
                Studio._validate_and_write_media(
                    {"mimeType": "image/png", "filename": "spoofed.png",
                     "body": base64.b64encode(b"GIF89a-not-a-png").decode("ascii")},
                    out_dir,
                )
            self.assertFalse((out_dir / "spoofed.png").exists())

            with self.assertRaisesRegex(ValueError, "not valid base64"):
                Studio._validate_and_write_media(
                    {"mimeType": "text/plain", "filename": "diagram.mmd", "body": ("A" * 262_140 + "====") + ("B" * 16)},
                    out_dir,
                )

            proxy = SimpleNamespace(settings={"newNoteLocation": str(out_dir)})
            saved_svg = Studio._save_media_native(
                proxy,
                {"mimeType": "image/svg+xml", "filename": "vector.svg",
                 "body": base64.b64encode(b"<svg xmlns='http://www.w3.org/2000/svg'/>").decode("ascii")},
            )
            self.assertEqual(saved_svg["filename"], "vector.svg")
            self.assertTrue((out_dir / "vector.svg").is_file())


if __name__ == "__main__":
    unittest.main()
