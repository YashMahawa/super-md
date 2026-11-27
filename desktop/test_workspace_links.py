import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import types
import unittest
from pathlib import Path

from unittest import mock

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
from PySide6.QtCore import QCoreApplication
from PySide6.QtGui import QGuiApplication

from studio import Session
from test_studio import QuietStudio
import workspace_links
from workspace_links import WorkspaceLinkCache, resolve_workspace_link


def _try_create_link(link: Path, target: Path, *, target_is_directory: bool = False) -> bool:
    try:
        link.symlink_to(target, target_is_directory=target_is_directory)
        return True
    except (OSError, NotImplementedError) as exc:
        if sys.platform == "win32" and target_is_directory and getattr(exc, "winerror", None) == 1314:
            subprocess.run(
                ["cmd", "/c", "mklink", "/J", str(link), str(target)],
                check=False,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            return link.exists()
        if sys.platform == "win32" and getattr(exc, "winerror", None) == 1314:
            return False
        raise


class WorkspaceLinkRankingAndCacheTest(unittest.TestCase):
    def test_ranks_nested_wikilinks_deterministically_without_writing_index_files(self):
        with tempfile.TemporaryDirectory() as root_dir:
            root = Path(root_dir).resolve()
            (root / "Index.md").write_text("# Index\n", encoding="utf-8")
            archive = root / "Archive"
            archive.mkdir()
            exact_topic = archive / "Topic.md"
            exact_topic.write_text("# Exact Case Topic\n", encoding="utf-8")
            other_sibling = archive / "Sibling.md"
            other_sibling.write_text("# Other Dir MD\n", encoding="utf-8")

            specs = root / "Specs"
            deep = specs / "Deep"
            deep.mkdir(parents=True)
            (deep / "topic.md").write_text("# Lowercase Topic\n", encoding="utf-8")
            sub_note = specs / "Sub Note.md"
            sub_note.write_text("# Sub Note\n", encoding="utf-8")
            same_dir_smd = specs / "Sibling.smd"
            same_dir_smd.write_text("# Same Dir SMD\n", encoding="utf-8")

            cache = WorkspaceLinkCache()
            # 1. Nested subfolder wikilink resolves from root note
            self.assertEqual(
                resolve_workspace_link("Sub Note", wikilink=True, note_path=root / "Index.md", workspace_folder=root, cache=cache),
                sub_note.resolve(),
            )
            # 2. Exact case ("Topic") beats lowercase ("topic") even when lowercase is closer
            self.assertEqual(
                resolve_workspace_link("Topic", wikilink=True, note_path=deep / "topic.md", workspace_folder=root, cache=cache),
                exact_topic.resolve(),
            )
            # 3. Same-directory match ("Specs/Sibling.smd") beats other-directory ("Archive/Sibling.md") when case matches
            self.assertEqual(
                resolve_workspace_link("Sibling", wikilink=True, note_path=sub_note, workspace_folder=root, cache=cache),
                same_dir_smd.resolve(),
            )
            # 4. Zero hidden metadata or index files written anywhere in the workspace
            self.assertFalse(any(p.name.startswith(".") for p in root.rglob("*")))

    def test_bounded_scan_respects_file_cap_and_invalidates_across_ancestor_aliases(self):
        with tempfile.TemporaryDirectory() as base_dir:
            base = Path(base_dir).resolve()
            real_vault = base / "private" / "Vault"
            real_vault.mkdir(parents=True)
            for idx in range(10):
                (real_vault / f"Note-{idx:02d}.md").write_text(f"# {idx}\n", encoding="utf-8")

            bounded = WorkspaceLinkCache(max_files=4, ttl_seconds=60.0)
            self.assertEqual(len(bounded.scan(real_vault)), 4)

            alias_parent = base / "alias"
            vault_ref = real_vault
            if _try_create_link(alias_parent, base / "private", target_is_directory=True):
                vault_ref = alias_parent / "Vault"

            added = real_vault / "Note-00-Fresh.md"
            added.write_text("# Fresh\n", encoding="utf-8")
            bounded.invalidate(vault_ref)
            self.assertTrue(any(item.name == "Note-00-Fresh.md" for item in bounded.scan(vault_ref)))

    def _verify_asset_skip_alias_rejection_and_mutation_visibility(self) -> None:
        with tempfile.TemporaryDirectory() as base_dir:
            base = Path(base_dir).resolve()
            root = base / "Vault"
            root.mkdir()
            root = root.resolve()
            outside = base / "Outside.md"
            outside.write_text("# Outside\n", encoding="utf-8")
            outside_dir = base / "OutsideDir"
            outside_dir.mkdir()
            outside_dir = outside_dir.resolve()
            (outside_dir / "Leaked.md").write_text("# Leaked\n", encoding="utf-8")

            for idx in range(24):
                section = root / f"Section-{idx % 4}"
                section.mkdir(exist_ok=True)
                (section / f"Note-{idx:02d}.md").write_text(f"# Note {idx}\n", encoding="utf-8")

            assets = root / "assets"
            assets.mkdir()
            png_header = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
            for idx in range(240):
                (assets / f"figure-{idx:03d}.png").write_bytes(png_header)
            (assets / "archive.zip").write_bytes(b"PK\x03\x04" + b"\x00" * 32)

            # Eligible note extensions that are symlinks, junctions, or Finder aliases must still be rejected.
            has_file_link = _try_create_link(root / "Symlinked.md", outside)
            _try_create_link(root / "LinkedDir", outside_dir, target_is_directory=True)

            bookmark_alias = root / "BookmarkAlias.md"
            bookmark_alias.write_bytes(b"book\x00\x00\x00\x00mark\x00\x00\x00\x00" + b"\x00" * 32)
            xattr_alias = root / "FinderInfoAlias.smd"
            xattr_alias.write_text("# Looks like smd\n", encoding="utf-8")
            folder_alias_file = root / "FolderAlias"
            folder_alias_file.write_bytes(b"book\x00\x00\x00\x00mark\x00\x00\x00\x00" + b"\x00" * 32)

            real_open = Path.open
            real_getxattr = getattr(os, "getxattr", None)
            opened_non_notes: list[str] = []
            xattr_non_notes: list[str] = []

            def tracking_open(self_path: Path, *args, **kwargs):
                if self_path.suffix.lower() not in workspace_links.NOTE_EXTENSIONS:
                    opened_non_notes.append(self_path.name)
                return real_open(self_path, *args, **kwargs)

            def tracking_getxattr(target, attr, *args, **kwargs):
                p = Path(os.fsdecode(target))
                if p.suffix.lower() not in workspace_links.NOTE_EXTENSIONS:
                    xattr_non_notes.append(p.name)
                if p.name == "FinderInfoAlias.smd" and attr == "com.apple.FinderInfo":
                    info = bytearray(32)
                    info[8] = 0x80
                    return bytes(info)
                if real_getxattr is not None:
                    return real_getxattr(target, attr, *args, **kwargs)
                raise OSError("xattr unavailable")

            cache = WorkspaceLinkCache(ttl_seconds=60.0)
            patchers = [mock.patch.object(Path, "open", tracking_open)]
            if hasattr(os, "getxattr"):
                patchers.append(mock.patch.object(os, "getxattr", side_effect=tracking_getxattr))

            with patchers[0]:
                if len(patchers) > 1:
                    with patchers[1]:
                        scanned = cache.scan(root)
                else:
                    scanned = cache.scan(root)

            self.assertEqual(opened_non_notes, [])
            self.assertEqual(xattr_non_notes, [])

            scanned_names = {entry.name for entry in scanned}
            self.assertIn("Note-00.md", scanned_names)
            self.assertIn("Note-23.md", scanned_names)
            self.assertNotIn("Leaked.md", scanned_names)
            if has_file_link:
                self.assertNotIn("Symlinked.md", scanned_names)
            if os.name == "posix":
                self.assertNotIn("BookmarkAlias.md", scanned_names)
                if hasattr(os, "getxattr"):
                    self.assertNotIn("FinderInfoAlias.smd", scanned_names)
                with self.assertRaises(workspace_links.WorkspaceLinkError):
                    resolve_workspace_link(
                        "BookmarkAlias.md",
                        wikilink=False,
                        note_path=root / "Section-0" / "Note-00.md",
                        workspace_folder=root,
                        cache=cache,
                    )
            else:
                self.assertIn("BookmarkAlias.md", scanned_names)

            # Simulated Windows directory junction on a nested folder is still rejected.
            junction_dir = root / "JunctionSubdir"
            junction_dir.mkdir()
            (junction_dir / "HiddenBehindJunction.md").write_text("# Junction\n", encoding="utf-8")
            cache.invalidate(root)
            real_is_symlink_or_junction = workspace_links._is_symlink_or_junction
            with mock.patch.object(
                workspace_links,
                "_is_symlink_or_junction",
                side_effect=lambda p: p.name == "JunctionSubdir" or real_is_symlink_or_junction(p),
            ):
                rescanned = cache.scan(root)
            self.assertFalse(any(item.name == "HiddenBehindJunction.md" for item in rescanned))
            shutil.rmtree(junction_dir)

            # Real directory mutation (creating a note directly on disk without calling cache.invalidate)
            # is visible immediately on the next lookup within TTL.
            xattr_alias.unlink()
            if os.name != "posix":
                bookmark_alias.unlink()
            cache.invalidate(root)
            self.assertEqual(len(cache.scan(root)), 24)
            mutated = root / "Section-2" / "FreshlyMutated.md"
            mutated.write_text("# Added directly on disk\n", encoding="utf-8")
            self.assertEqual(
                resolve_workspace_link(
                    "FreshlyMutated",
                    wikilink=True,
                    note_path=root / "Section-0" / "Note-00.md",
                    workspace_folder=root,
                    cache=cache,
                ),
                mutated.resolve(),
            )

    def test_scan_skips_binary_opens_and_xattrs_on_unrelated_assets_while_rejecting_eligible_aliases_and_seeing_mutations(self):
        self._verify_asset_skip_alias_rejection_and_mutation_visibility()
        if os.name == "posix":
            fake_nt_os = types.SimpleNamespace(
                **{k: v for k, v in vars(os).items() if k != "getxattr"},
            )
            fake_nt_os.name = "nt"
            with (
                mock.patch.object(workspace_links, "os", fake_nt_os),
                mock.patch.object(sys.modules[__name__], "os", fake_nt_os),
            ):
                self._verify_asset_skip_alias_rejection_and_mutation_visibility()

    def test_cached_exact_nested_match_refreshes_when_higher_ranked_exact_target_added_externally(self):
        with tempfile.TemporaryDirectory() as root_dir:
            root = Path(root_dir) / "Vault"
            notes = root / "Notes"
            archive = root / "Archive"
            beta = root / "Beta"
            deep = root / "Specs" / "Deep"
            notes.mkdir(parents=True)
            archive.mkdir(parents=True)
            beta.mkdir(parents=True)
            deep.mkdir(parents=True)
            root = root.resolve()
            notes = notes.resolve()
            archive = archive.resolve()
            beta = beta.resolve()
            deep = deep.resolve()

            source = notes / "Source.md"
            source.write_text("# Source\n", encoding="utf-8")
            deep_topic = deep / "Topic.md"
            deep_topic.write_text("# Deep Exact Topic\n", encoding="utf-8")
            deep_ext_smd = deep / "ExtRank.smd"
            deep_ext_smd.write_text("# Deep Exact SMD\n", encoding="utf-8")
            deep_subtick = deep / "SubTick.md"
            deep_subtick.write_text("# Deep SubTick\n", encoding="utf-8")

            cache = WorkspaceLinkCache(ttl_seconds=60.0)

            # Warm cache with exact nested match at depth 2 and confirm warm-hit behavior.
            self.assertEqual(
                resolve_workspace_link("Topic", wikilink=True, note_path=source, workspace_folder=root, cache=cache),
                deep_topic,
            )
            _, from_cache = cache._scan_with_state(root)
            self.assertTrue(from_cache)

            # 1. Shallower exact match added externally in an existing folder beats cached depth-2 exact match.
            specs_topic = root / "Specs" / "Topic.md"
            specs_topic.write_text("# Shallower Specs Topic\n", encoding="utf-8")
            self.assertEqual(
                resolve_workspace_link("Topic", wikilink=True, note_path=source, workspace_folder=root, cache=cache),
                specs_topic.resolve(),
            )

            # 2. Alphabetically earlier exact match at same depth in an existing folder wins within TTL.
            archive_topic = archive / "Topic.md"
            archive_topic.write_text("# Archive Topic\n", encoding="utf-8")
            self.assertEqual(
                resolve_workspace_link("Topic", wikilink=True, note_path=source, workspace_folder=root, cache=cache),
                archive_topic,
            )

            # 3. Brand-new folder created externally with a higher-ranked exact target wins within TTL.
            alpha = root / "Alpha"
            alpha.mkdir()
            alpha_topic = alpha / "Topic.md"
            alpha_topic.write_text("# Alpha Topic\n", encoding="utf-8")
            self.assertEqual(
                resolve_workspace_link("Topic", wikilink=True, note_path=source, workspace_folder=root, cache=cache),
                alpha_topic.resolve(),
            )

            # 4. Higher-priority extension (.md ahead of cached .smd) in the same nested folder wins within TTL.
            self.assertEqual(
                resolve_workspace_link("ExtRank", wikilink=True, note_path=source, workspace_folder=root, cache=cache),
                deep_ext_smd,
            )
            deep_ext_md = deep / "ExtRank.md"
            deep_ext_md.write_text("# Deep Exact MD\n", encoding="utf-8")
            self.assertEqual(
                resolve_workspace_link("ExtRank", wikilink=True, note_path=source, workspace_folder=root, cache=cache),
                deep_ext_md,
            )

            # 5. Same-directory exact target added externally beats all cross-folder matches.
            same_dir_topic = notes / "Topic.md"
            same_dir_topic.write_text("# Same Dir Topic\n", encoding="utf-8")
            self.assertEqual(
                resolve_workspace_link("Topic", wikilink=True, note_path=source, workspace_folder=root, cache=cache),
                same_dir_topic,
            )

            # 6. Sub-tick / stale directory stat fallback: even if directory stat metadata stays unchanged
            # (e.g. coarse filesystem clock tick), racy_entries detects the externally added exact target.
            self.assertEqual(
                resolve_workspace_link("SubTick", wikilink=True, note_path=source, workspace_folder=root, cache=cache),
                deep_subtick,
            )
            frozen_beta_stat = beta.stat(follow_symlinks=False)
            beta_subtick = beta / "SubTick.md"
            beta_subtick.write_text("# Shallower Beta SubTick\n", encoding="utf-8")
            real_stat = Path.stat

            def stale_beta_stat(self_path: Path, *, follow_symlinks: bool = True):
                if self_path == beta:
                    return frozen_beta_stat
                return real_stat(self_path, follow_symlinks=follow_symlinks)

            with mock.patch.object(Path, "stat", stale_beta_stat):
                self.assertEqual(
                    resolve_workspace_link("SubTick", wikilink=True, note_path=source, workspace_folder=root, cache=cache),
                    beta_subtick,
                )

    def test_case_insensitive_fs_preserves_exact_case_ranking_and_invalidates_across_case_variants(self):
        with tempfile.TemporaryDirectory() as root_dir:
            root = Path(root_dir).resolve() / "Vault"
            root.mkdir()
            archive = root / "Archive"
            archive.mkdir()
            exact_topic = archive / "Topic.md"
            exact_topic.write_text("# Exact Case Topic\n", encoding="utf-8")
            deep = root / "Specs" / "Deep"
            deep.mkdir(parents=True)
            lower_topic = deep / "topic.md"
            lower_topic.write_text("# Lowercase Topic\n", encoding="utf-8")

            # Simulate macOS APFS case-insensitive VFS lookup + Path.resolve preserving caller casing
            real_stat = Path.stat
            real_is_file = Path.is_file
            real_is_dir = Path.is_dir
            real_samefile = os.path.samefile
            real_scandir = os.scandir

            def _ci_real_target(candidate: Path) -> Path:
                parts = candidate.parts
                if not parts:
                    return candidate
                cur = Path(parts[0])
                for seg in parts[1:]:
                    exact_child = cur / seg
                    try:
                        real_stat(exact_child, follow_symlinks=False)
                        cur = exact_child
                        continue
                    except OSError:
                        pass
                    try:
                        with real_scandir(cur) as it:
                            found = next((e.name for e in it if e.name.casefold() == seg.casefold()), None)
                    except OSError:
                        found = None
                    if found is None:
                        return candidate
                    cur = cur / found
                return cur

            def fake_stat(self_path: Path, *, follow_symlinks: bool = True):
                try:
                    return real_stat(self_path, follow_symlinks=follow_symlinks)
                except OSError:
                    mapped = _ci_real_target(self_path)
                    if mapped != self_path:
                        return real_stat(mapped, follow_symlinks=follow_symlinks)
                    raise

            def fake_is_file(self_path: Path, *args, **kwargs) -> bool:
                return real_is_file(self_path, *args, **kwargs) or real_is_file(
                    _ci_real_target(self_path),
                    *args,
                    **kwargs,
                )

            def fake_is_dir(self_path: Path, *args, **kwargs) -> bool:
                return real_is_dir(self_path, *args, **kwargs) or real_is_dir(
                    _ci_real_target(self_path),
                    *args,
                    **kwargs,
                )

            def fake_canonicalize(path: Path) -> Path:
                mapped = _ci_real_target(path)
                if not real_is_file(mapped) and not real_is_dir(mapped):
                    path.resolve(strict=True)
                # Preserve caller's casing like POSIX realpath() on APFS when fcntl is bypassed
                return Path(os.path.abspath(os.fspath(path)))

            def fake_samefile(a, b) -> bool:
                return real_samefile(_ci_real_target(Path(a)), _ci_real_target(Path(b)))

            def fake_scandir(target_dir):
                return real_scandir(_ci_real_target(Path(target_dir)))

            cache = WorkspaceLinkCache(ttl_seconds=60.0)
            alt_case_root = root.parent / "vault"
            alt_case_note = alt_case_root / "specs" / "deep" / "topic.md"

            with (
                mock.patch.object(Path, "stat", fake_stat),
                mock.patch.object(Path, "is_file", fake_is_file),
                mock.patch.object(Path, "is_dir", fake_is_dir),
                mock.patch.object(workspace_links, "_canonicalize_existing_path", side_effect=fake_canonicalize),
                mock.patch.object(os.path, "samefile", side_effect=fake_samefile),
                mock.patch.object(os, "scandir", side_effect=fake_scandir),
            ):
                # Bare [[Topic]] must NOT match Specs/Deep/topic.md via case-insensitive stat; Archive/Topic.md wins
                resolved_wiki = resolve_workspace_link(
                    "Topic",
                    wikilink=True,
                    note_path=alt_case_note,
                    workspace_folder=alt_case_root,
                    cache=cache,
                )
                self.assertEqual(resolved_wiki.name, "Topic.md")
                self.assertEqual(resolved_wiki.parent.name, "Archive")

                # Explicit relative [Topic](Topic.md) resolves in Specs/Deep with actual on-disk filename casing
                resolved_rel = resolve_workspace_link(
                    "Topic.md",
                    wikilink=False,
                    note_path=alt_case_note,
                    workspace_folder=alt_case_root,
                    cache=cache,
                )
                self.assertEqual(resolved_rel.name, "topic.md")
                self.assertEqual(resolved_rel.parent.name, "Deep")

                # Invalidating with differently-cased folder path evicts the cached scan
                fresh_note = deep / "FreshlyAdded.md"
                fresh_note.write_text("# Fresh\n", encoding="utf-8")
                cache.invalidate(root.parent / "vAuLt")
                resolved_fresh = resolve_workspace_link(
                    "FreshlyAdded",
                    wikilink=True,
                    note_path=alt_case_note,
                    workspace_folder=root,
                    cache=cache,
                )
                self.assertEqual(resolved_fresh, fresh_note)

            # Nested directory case-only rename invalidates/refreshes within TTL even without explicit invalidate()
            live_cache = WorkspaceLinkCache(ttl_seconds=60.0)
            self.assertEqual(
                resolve_workspace_link("Topic", wikilink=True, note_path=lower_topic, workspace_folder=root, cache=live_cache),
                exact_topic.resolve(),
            )
            # Rename Archive/Topic.md -> Archive/topic.md and Specs/Deep/topic.md -> Specs/Deep/Topic.md
            temp_archive = archive / "topic-tmp.md"
            exact_topic.rename(temp_archive)
            lower_archive = archive / "topic.md"
            temp_archive.rename(lower_archive)
            temp_deep = deep / "Topic-tmp.md"
            lower_topic.rename(temp_deep)
            upper_deep = deep / "Topic.md"
            temp_deep.rename(upper_deep)

            self.assertEqual(
                resolve_workspace_link("Topic", wikilink=True, note_path=lower_archive, workspace_folder=root, cache=live_cache),
                upper_deep.resolve(),
            )
            self.assertFalse(any(p.name.startswith(".") for p in root.rglob("*")))

    def test_windows_direntry_zero_inode_stat_preserves_case_folded_resolution(self):
        with tempfile.TemporaryDirectory() as root_dir:
            root = Path(root_dir) / "Vault"
            deep = root / "Specs" / "Deep"
            deep.mkdir(parents=True)
            root = root.resolve()
            deep = deep.resolve()
            lower_topic = deep / "topic.md"
            lower_topic.write_text("# Topic\n", encoding="utf-8")
            sibling = deep / "Index.md"
            sibling.write_text("# Index\n", encoding="utf-8")

            real_stat = Path.stat
            real_is_file = Path.is_file
            real_scandir = os.scandir

            class _WinDirEntryProxy:
                def __init__(self, inner):
                    self._inner = inner
                    self.name = inner.name
                    self.path = inner.path

                def is_symlink(self) -> bool:
                    return self._inner.is_symlink()

                def is_dir(self, *, follow_symlinks: bool = True) -> bool:
                    return self._inner.is_dir(follow_symlinks=follow_symlinks)

                def is_file(self, *, follow_symlinks: bool = True) -> bool:
                    return self._inner.is_file(follow_symlinks=follow_symlinks)

                def stat(self, *, follow_symlinks: bool = True) -> os.stat_result:
                    raw = list(self._inner.stat(follow_symlinks=follow_symlinks))
                    raw[1] = 0  # st_ino == 0 on Windows nt.DirEntry.stat()
                    raw[2] = 0  # st_dev == 0 on Windows nt.DirEntry.stat()
                    return os.stat_result(raw)

            class _ScandirContext:
                def __init__(self, target_dir):
                    self._ctx = real_scandir(target_dir)

                def __enter__(self):
                    return (_WinDirEntryProxy(e) for e in self._ctx.__enter__())

                def __exit__(self, exc_type, exc, tb):
                    return self._ctx.__exit__(exc_type, exc, tb)

            def fake_stat(self_path: Path, *, follow_symlinks: bool = True):
                try:
                    return real_stat(self_path, follow_symlinks=follow_symlinks)
                except OSError:
                    if self_path.name == "Topic.md" and self_path.parent == deep:
                        return real_stat(lower_topic, follow_symlinks=follow_symlinks)
                    raise

            def fake_is_file(self_path: Path, *args, **kwargs) -> bool:
                if self_path.name == "Topic.md" and self_path.parent == deep:
                    return True
                return real_is_file(self_path, *args, **kwargs)

            with (
                mock.patch.object(Path, "stat", fake_stat),
                mock.patch.object(Path, "is_file", fake_is_file),
                mock.patch.object(os, "scandir", side_effect=_ScandirContext),
            ):
                resolved = resolve_workspace_link(
                    "Topic.md",
                    wikilink=False,
                    note_path=sibling,
                    workspace_folder=root,
                    cache=WorkspaceLinkCache(),
                )
                self.assertEqual(resolved, lower_topic)

    @unittest.skipIf(workspace_links._fcntl is None, "POSIX fcntl.fcntl FCNTL_BUFSZ test")
    def test_darwin_f_getpath_respects_cpython_fcntl_bufsz_limit(self):
        with tempfile.TemporaryDirectory() as base_dir:
            base = Path(base_dir).resolve()
            real_vault = base / "private" / "Vault"
            real_vault.mkdir(parents=True)
            note = real_vault / "Inside.md"
            note.write_text("# Inside\n", encoding="utf-8")
            alias_parent = base / "var_alias"
            alias_parent.symlink_to(base / "private", target_is_directory=True)

            real_fcntl = workspace_links._fcntl.fcntl

            def darwin_fcntl(fd: int, cmd: int, arg=0):
                # Delegate to real CPython fcntl.fcntl first so any buffer > FCNTL_BUFSZ (1024)
                # raises ValueError("fcntl string arg too long") on Linux and macOS alike.
                try:
                    return real_fcntl(fd, cmd, arg)
                except OSError:
                    if cmd == workspace_links._MACOS_F_GETPATH and isinstance(arg, (bytes, bytearray)):
                        target = os.fsencode(os.path.realpath(f"/proc/self/fd/{fd}"))
                        padded = target + b"\x00" * max(1, len(arg) - len(target))
                        return padded[: len(arg)]
                    raise

            with (
                mock.patch.object(sys, "platform", "darwin"),
                mock.patch.object(workspace_links._fcntl, "fcntl", side_effect=darwin_fcntl),
            ):
                canonical = workspace_links._canonicalize_existing_path(alias_parent / "Vault" / "Inside.md")
                self.assertEqual(canonical, note)
                cache = WorkspaceLinkCache()
                cache.invalidate(alias_parent / "Vault")
                self.assertEqual(
                    resolve_workspace_link(
                        "Inside.md",
                        wikilink=False,
                        note_path=alias_parent / "Vault" / "Inside.md",
                        workspace_folder=alias_parent / "Vault",
                        cache=cache,
                    ),
                    note,
                )


class StudioOpenTabJumpTest(unittest.TestCase):
    app: QCoreApplication

    @classmethod
    def setUpClass(cls):
        cls.app = QGuiApplication.instance() or QGuiApplication(["Workspace link tests"])

    def setUp(self):
        self.session = Session(True)
        self.session.settings["python"] = sys.executable
        self.windows = []
        self.studio = self._window()

    def _window(self):
        win = QuietStudio(True, self.session)
        win.settings["python"] = sys.executable
        self.windows.append(win)
        return win

    def _wait_until(self, predicate, timeout=3.0):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.app.processEvents()
            if predicate():
                return
            time.sleep(0.01)
        self.app.processEvents()
        self.assertTrue(predicate())

    def tearDown(self):
        for win in self.windows:
            win.stop()
            win.pool.shutdown(wait=True, cancel_futures=True)
        self.session.writes.shutdown(wait=True)
        self.app.processEvents()
        shutil.rmtree(self.session.data, ignore_errors=True)

    def test_nested_wikilink_and_open_tab_jump_retain_drafts_update_recent_and_invalidate_on_rename(self):
        vault = (self.studio.data / "vault").resolve()
        vault.mkdir(parents=True, exist_ok=True)
        first = vault / "First.md"
        first.write_text("# First\n\nSee [[Second Note#Architecture]]\n", encoding="utf-8")
        nested = vault / "Specs"
        nested.mkdir()
        second = nested / "Second Note.md"
        second.write_text("# Second Note\n\n## Architecture\n\nDetails.\n", encoding="utf-8")

        studio = self.studio
        studio.ready = True
        studio.settings["autosave"] = False
        replies = []
        studio.replied.connect(lambda req_id, res, err: replies.append((req_id, res, err)))

        studio.openFolder(str(vault))
        studio.openNote(str(first))
        self._wait_until(lambda: studio._current()["path"] == str(first))
        first_tab_id = studio.active
        studio.post("edit-1", "document_changed", json.dumps({"id": first_tab_id, "content": "# First (unsaved draft)\n"}))

        replies.clear()
        studio.post("link-1", "open_workspace_link", json.dumps({
            "documentPath": str(first),
            "target": "Second Note",
            "fragment": "Architecture",
            "wikilink": True,
        }))
        self._wait_until(lambda: any(r[0] == "link-1" for r in replies))
        self.assertTrue(json.loads(next(r[1] for r in replies if r[0] == "link-1"))["opened"])
        self.assertEqual(studio._current()["path"], str(second))
        self.assertEqual(studio.recent[0], str(second))

        # Jumping back to already-open First.md focuses existing tab, retains draft, and promotes recent[0]
        tab_count = len(studio.tabs)
        replies.clear()
        studio.post("link-2", "open_workspace_link", json.dumps({
            "documentPath": str(second),
            "target": "../First.md",
            "fragment": "",
            "wikilink": False,
        }))
        self._wait_until(lambda: any(r[0] == "link-2" for r in replies))
        self.assertEqual(len(studio.tabs), tab_count)
        self.assertEqual(studio.active, first_tab_id)
        self.assertEqual(studio._current()["content"], "# First (unsaved draft)\n")
        self.assertEqual(studio.recent[0], str(first))

        # Renaming Second Note invalidates workspace_links so the new name resolves immediately
        second_tab = next(t for t in studio.tabs if t["path"] == str(second))
        studio.renameNote(second_tab["id"], "Renamed Spec.md")
        renamed = nested / "Renamed Spec.md"
        self._wait_until(lambda: second_tab["path"] == str(renamed))
        replies.clear()
        studio.post("link-3", "open_workspace_link", json.dumps({
            "documentPath": str(first),
            "target": "Renamed Spec",
            "fragment": "",
            "wikilink": True,
        }))
        self._wait_until(lambda: any(r[0] == "link-3" for r in replies))
        self.assertTrue(json.loads(next(r[1] for r in replies if r[0] == "link-3"))["opened"])
        self.assertEqual(studio._current()["path"], str(renamed))

        # Case-only rename ("Renamed Spec.md" -> "renamed spec.md") succeeds on case-insensitive & case-sensitive FS
        studio.renameNote(second_tab["id"], "renamed spec.md")
        case_renamed = nested / "renamed spec.md"
        self._wait_until(lambda: second_tab["path"] == str(case_renamed))
        self.assertEqual(second_tab["name"], "renamed spec.md")

        # Even if an open tab holds a differently-cased path string (as on macOS APFS before canonicalization),
        # workspace link jump reuses that open tab via inode identity without opening a duplicate tab.
        first_tab = next(t for t in studio.tabs if t["id"] == first_tab_id)
        first_tab["path"] = str(vault / "FIRST.MD")
        real_samefile = os.path.samefile
        with mock.patch.object(
            os.path,
            "samefile",
            side_effect=lambda a, b: True if {str(a), str(b)} == {str(vault / "FIRST.MD"), str(first)} else real_samefile(a, b),
        ):
            replies.clear()
            studio.post("link-4", "open_workspace_link", json.dumps({
                "documentPath": str(case_renamed),
                "target": "First",
                "fragment": "",
                "wikilink": True,
            }))
            self._wait_until(lambda: any(r[0] == "link-4" for r in replies))
        first_tab["path"] = str(first)
        self.assertEqual(len(studio.tabs), tab_count)
        self.assertEqual(studio.active, first_tab_id)
        self.assertEqual(studio._current()["content"], "# First (unsaved draft)\n")

    def test_external_higher_ranked_exact_target_supersedes_cached_nested_tab_without_losing_dirty_draft(self):
        vault = (self.studio.data / "ranked_vault").resolve()
        notes = vault / "Notes"
        archive = vault / "Archive"
        deep = vault / "Specs" / "Deep"
        notes.mkdir(parents=True, exist_ok=True)
        archive.mkdir(parents=True, exist_ok=True)
        deep.mkdir(parents=True, exist_ok=True)

        index_note = notes / "Index.md"
        index_note.write_text("# Index\n\nSee [[Topic]]\n", encoding="utf-8")
        deep_topic = deep / "Topic.md"
        deep_topic.write_text("# Deep Topic\n", encoding="utf-8")

        studio = self.studio
        studio.ready = True
        studio.settings["autosave"] = False
        replies = []
        studio.replied.connect(lambda req_id, res, err: replies.append((req_id, res, err)))

        studio.openFolder(str(vault))
        studio.openNote(str(index_note))
        self._wait_until(lambda: studio._current()["path"] == str(index_note))

        # Populate warm cache with nested exact match Specs/Deep/Topic.md and mark its open tab dirty.
        replies.clear()
        studio.post("rank-1", "open_workspace_link", json.dumps({
            "documentPath": str(index_note),
            "target": "Topic",
            "wikilink": True,
        }))
        self._wait_until(lambda: any(r[0] == "rank-1" for r in replies))
        self.assertTrue(json.loads(next(r[1] for r in replies if r[0] == "rank-1"))["opened"])
        self.assertEqual(studio._current()["path"], str(deep_topic))
        deep_tab_id = studio.active
        studio.post("dirty-deep", "document_changed", json.dumps({
            "id": deep_tab_id,
            "content": "# Deep Topic (unsaved draft)\n",
        }))

        # Externally add a higher-ranked shallower exact target Archive/Topic.md without calling invalidate().
        archive_topic = archive / "Topic.md"
        archive_topic.write_text("# Archive Topic\n", encoding="utf-8")

        replies.clear()
        studio.post("rank-2", "open_workspace_link", json.dumps({
            "documentPath": str(index_note),
            "target": "Topic",
            "wikilink": True,
        }))
        self._wait_until(lambda: any(r[0] == "rank-2" for r in replies))
        self.assertTrue(json.loads(next(r[1] for r in replies if r[0] == "rank-2"))["opened"])
        self.assertEqual(studio._current()["path"], str(archive_topic))
        self.assertEqual(studio.recent[0], str(archive_topic))

        # Previously open Specs/Deep/Topic.md tab retains its dirty draft and can still be focused by subpath.
        deep_tab = next(t for t in studio.tabs if t["id"] == deep_tab_id)
        self.assertEqual(deep_tab["content"], "# Deep Topic (unsaved draft)\n")

        tab_count = len(studio.tabs)
        replies.clear()
        studio.post("rank-3", "open_workspace_link", json.dumps({
            "documentPath": str(index_note),
            "target": "Specs/Deep/Topic",
            "wikilink": True,
        }))
        self._wait_until(lambda: any(r[0] == "rank-3" for r in replies))
        self.assertEqual(len(studio.tabs), tab_count)
        self.assertEqual(studio.active, deep_tab_id)
        self.assertEqual(studio._current()["content"], "# Deep Topic (unsaved draft)\n")

    @unittest.skipIf(workspace_links._fcntl is None, "POSIX fcntl.fcntl FCNTL_BUFSZ test")
    def test_darwin_studio_rejects_traversal_and_symlinks_and_runs_folder_hooks_without_fcntl_error(self):
        sandbox = (self.studio.data / "darwin_containment").resolve()
        folder = sandbox / "guarded"
        folder.mkdir(parents=True, exist_ok=True)
        outside = sandbox / "outside.md"
        outside.write_text("# Secret\n", encoding="utf-8")
        inside = folder / "Inside.md"
        inside.write_text("# Inside\n", encoding="utf-8")
        peer = folder / "Peer.md"
        peer.write_text("# Peer\n", encoding="utf-8")
        symlink_note = folder / "Symlink.md"
        symlink_note.symlink_to(outside)

        real_fcntl = workspace_links._fcntl.fcntl

        def darwin_fcntl(fd: int, cmd: int, arg=0):
            try:
                return real_fcntl(fd, cmd, arg)
            except OSError:
                if cmd == workspace_links._MACOS_F_GETPATH and isinstance(arg, (bytes, bytearray)):
                    target = os.fsencode(os.path.realpath(f"/proc/self/fd/{fd}"))
                    padded = target + b"\x00" * max(1, len(arg) - len(target))
                    return padded[: len(arg)]
                raise

        studio = self.studio
        studio.ready = True
        replies = []
        studio.replied.connect(lambda req_id, res, err: replies.append((req_id, res, err)))

        with (
            mock.patch.object(sys, "platform", "darwin"),
            mock.patch.object(workspace_links._fcntl, "fcntl", side_effect=darwin_fcntl),
        ):
            studio.openFolder(str(folder))
            studio.openNote(str(inside))
            self._wait_until(lambda: studio._current()["path"] == str(inside))

            for idx, bad_target in enumerate(["../outside.md", "../missing-outside.md", "Symlink.md"]):
                replies.clear()
                req = f"darwin-bad-{idx}"
                studio.post(req, "open_workspace_link", json.dumps({
                    "documentPath": str(inside),
                    "target": bad_target,
                    "wikilink": False,
                }))
                self._wait_until(lambda: any(r[0] == req for r in replies))
                rejected = json.loads(replies[-1][1])
                self.assertFalse(rejected["opened"])
                self.assertNotIn("fcntl", rejected["message"])
                if bad_target.startswith("../"):
                    self.assertIn("outside the authorized folder", rejected["message"])
                else:
                    self.assertIn("symlink", rejected["message"])

            replies.clear()
            studio.post("darwin-ok", "open_workspace_link", json.dumps({
                "documentPath": str(inside),
                "target": "Peer",
                "wikilink": True,
            }))
            self._wait_until(lambda: any(r[0] == "darwin-ok" for r in replies))
            self.assertTrue(json.loads(replies[-1][1])["opened"])
            self.assertEqual(studio._current()["path"], str(peer))
            studio.closeFolder()


if __name__ == "__main__":
    unittest.main()
