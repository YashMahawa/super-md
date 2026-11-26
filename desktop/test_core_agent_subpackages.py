"""Verify desktop/core and desktop/agent subpackage layout, dual-mode shims, and mock propagation."""
from __future__ import annotations

import ast
import importlib
import os
import ssl
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

DESKTOP_DIR = Path(__file__).resolve().parent
SOURCE_ROOT = DESKTOP_DIR.parent
CORE_MODULES = (
    "network_tls", "background_service", "file_events", "closed_notes", "instance",
    "app_integration", "export_jobs", "python_outputs", "pending_python", "markdown_export",
    "latest_writes", "updates", "storage_inspector", "workspace_links", "folder_ops",
)
AGENT_MODULES = ("agent_stdio", "agent_live_client")


def _caught_exception_names(handler_type: ast.expr | None) -> set[str]:
    if isinstance(handler_type, ast.Name):
        return {handler_type.id}
    if isinstance(handler_type, ast.Attribute):
        return {handler_type.attr}
    if isinstance(handler_type, ast.Tuple):
        return {name for elt in handler_type.elts for name in _caught_exception_names(elt)}
    return set()


def _has_import(statements: list[ast.stmt]) -> bool:
    return any(isinstance(sub, (ast.Import, ast.ImportFrom)) for stmt in statements for sub in ast.walk(stmt))


def _has_relative_import(statements: list[ast.stmt]) -> bool:
    return any(isinstance(sub, ast.ImportFrom) and sub.level > 0 for stmt in statements for sub in ast.walk(stmt))


def _clean_env() -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if k not in {"PYTHONPATH", "PYTHONSAFEPATH", "PYTHONSTARTUP"}}
    env.setdefault("QT_QPA_PLATFORM", "offscreen")
    return env


class CoreAgentSubpackageTests(unittest.TestCase):
    def test_package_markers_preserve_script_directory_root(self):
        self.assertFalse((DESKTOP_DIR / "__init__.py").exists())
        for subpkg in ("core", "agent"):
            marker = DESKTOP_DIR / subpkg / "__init__.py"
            self.assertTrue(marker.is_file(), f"Missing {marker}")
            self.assertEqual(marker.read_bytes(), b"")

    def _run_subprocess_probe(self, *, repo_root: bool, shim_first: bool, cwd: Path) -> None:
        cases = [("core", mod) for mod in CORE_MODULES] + [("agent", mod) for mod in AGENT_MODULES]
        prefix = "desktop." if repo_root else ""
        probe = (
            "import importlib, pathlib, subprocess, sys\n"
            "from unittest import mock\n"
            f"desktop_dir = pathlib.Path({str(DESKTOP_DIR)!r}).resolve()\n"
            f"source_root = pathlib.Path({str(SOURCE_ROOT)!r}).resolve()\n"
            f"repo_root, shim_first, prefix = {repo_root!r}, {shim_first!r}, {prefix!r}\n"
            "if not repo_root:\n"
            "    sys.path.insert(0, str(desktop_dir))\n"
            "resolved = lambda: {(pathlib.Path(p) if p else pathlib.Path.cwd()).resolve() for p in sys.path}\n"
            "assert (desktop_dir if repo_root else source_root) not in resolved(), sys.path\n"
            "for blocked in (('core', 'agent') if repo_root else ('desktop',)):\n"
            "    try: importlib.import_module(blocked)\n"
            "    except ModuleNotFoundError: pass\n"
            "    else: raise AssertionError(f'Unexpected {blocked} on sys.path')\n"
            "load_shim = (lambda m: getattr(__import__('desktop', fromlist=[m]), m)) if repo_root else importlib.import_module\n"
            f"for pkg, mod in {cases!r}:\n"
            "    shim_mod = load_shim(mod) if shim_first else None\n"
            "    pkg_mod = importlib.import_module(f'{prefix}{pkg}.{mod}')\n"
            "    shim_mod = shim_mod or load_shim(mod)\n"
            "    assert shim_mod is pkg_mod, (pkg, mod)\n"
            "    assert sys.modules[f'{prefix}{mod}'] is sys.modules[f'{prefix}{pkg}.{mod}']\n"
            "    if repo_root: assert getattr(sys.modules['desktop'], mod) is pkg_mod\n"
            "    assert pathlib.Path(pkg_mod.__file__).resolve() == (desktop_dir / pkg / f'{mod}.py').resolve()\n"
            "    sys.modules.pop(f'{prefix}{mod}', None)\n"
            "    if repo_root: delattr(sys.modules['desktop'], mod)\n"
            "    assert load_shim(mod) is pkg_mod\n"
            "    if repo_root: assert getattr(sys.modules['desktop'], mod) is pkg_mod\n"
            "if repo_root:\n"
            "    from desktop import workspace_links, agent_stdio, agent_live_client\n"
            "    assert callable(workspace_links.resolve_workspace_link) and callable(agent_stdio.configure_stdio)\n"
            "    assert hasattr(agent_live_client, 'MultiSessionLiveClient')\n"
            "    assert not any(n in ('core', 'agent') or n.startswith(('core.', 'agent.')) for n in sys.modules)\n"
            "else:\n"
            "    assert not any(n == 'desktop' or n.startswith('desktop.') for n in sys.modules)\n"
            "assert (desktop_dir if repo_root else source_root) not in resolved(), sys.path\n"
            "completed = subprocess.CompletedProcess([], 0, 'super-md: /opt/super-md/super-md\\n', '')\n"
            "with (\n"
            "    mock.patch(f'{prefix}updates.shutil.which', side_effect=lambda n: '/usr/bin/dpkg-query' if n == 'dpkg-query' else None),\n"
            "    mock.patch(f'{prefix}updates.subprocess.run', return_value=completed) as run_mock,\n"
            "):\n"
            "    assert sys.modules[f'{prefix}core.updates'].linux_install_kind('/opt/super-md/super-md', {}, True, '/home/test') == 'deb'\n"
            "    run_mock.assert_called_once()\n"
            "sentinel = object()\n"
            "with mock.patch(f'{prefix}agent_live_client.LiveTabClient', sentinel):\n"
            "    assert sys.modules[f'{prefix}agent.agent_live_client'].LiveTabClient is sentinel\n"
        )
        args = [sys.executable, "-E", *([] if repo_root else ["-P"]), "-c", probe]
        completed = subprocess.run(args, cwd=cwd, env=_clean_env(), capture_output=True, text=True, check=False, timeout=30)
        self.assertEqual(completed.returncode, 0, completed.stdout + "\n" + completed.stderr)

    def test_repo_root_package_entrypoints_in_clean_subprocess(self):
        for shim_first in (True, False):
            with self.subTest(shim_first=shim_first):
                self._run_subprocess_probe(repo_root=True, shim_first=shim_first, cwd=SOURCE_ROOT)

    def test_flat_desktop_entrypoints_in_clean_subprocess(self):
        with tempfile.TemporaryDirectory() as isolated_cwd:
            for shim_first in (True, False):
                with self.subTest(shim_first=shim_first):
                    self._run_subprocess_probe(repo_root=False, shim_first=shim_first, cwd=Path(isolated_cwd))

    def test_root_shims_preserve_single_module_identity_and_reimport(self):
        prefix = f"{__package__}." if __package__ else ""
        cases = [("core", mod) for mod in CORE_MODULES] + [("agent", mod) for mod in AGENT_MODULES]
        for pkg, mod in cases:
            with self.subTest(package=pkg, module=mod):
                pkg_name = f"{prefix}{pkg}.{mod}"
                shim_name = f"{prefix}{mod}"
                pkg_mod = importlib.import_module(pkg_name)
                root_mod = importlib.import_module(shim_name)
                expected_file = (DESKTOP_DIR / pkg / f"{mod}.py").resolve()
                self.assertIs(root_mod, pkg_mod)
                self.assertIs(sys.modules[shim_name], sys.modules[pkg_name])
                self.assertEqual(Path(pkg_mod.__file__).resolve(), expected_file)

                sys.modules.pop(shim_name, None)
                if __package__ and __package__ in sys.modules and hasattr(sys.modules[__package__], mod):
                    delattr(sys.modules[__package__], mod)
                try:
                    reimported = importlib.import_module(shim_name)
                    self.assertIs(reimported, pkg_mod)
                    self.assertIs(sys.modules[shim_name], sys.modules[pkg_name])
                    if __package__ and __package__ in sys.modules:
                        self.assertIs(getattr(sys.modules[__package__], mod), pkg_mod)
                    self.assertEqual(Path(reimported.__file__).resolve(), expected_file)
                finally:
                    sys.modules[shim_name] = sys.modules[pkg_name]
                    if __package__ and __package__ in sys.modules:
                        setattr(sys.modules[__package__], mod, sys.modules[pkg_name])

    def test_mock_patch_targets_propagate_across_alias_boundary(self):
        prefix = f"{__package__}." if __package__ else ""
        core_updates = importlib.import_module(f"{prefix}core.updates")
        importlib.import_module(f"{prefix}updates")
        completed = subprocess.CompletedProcess([], 0, "super-md: /opt/super-md/super-md\n", "")
        with (
            mock.patch(f"{prefix}updates.shutil.which", side_effect=lambda n: "/usr/bin/dpkg-query" if n == "dpkg-query" else None),
            mock.patch(f"{prefix}updates.subprocess.run", return_value=completed) as run_mock,
        ):
            self.assertEqual(core_updates.linux_install_kind("/opt/super-md/super-md", {}, True, "/home/test"), "deb")
            run_mock.assert_called_once()

        core_network_tls = importlib.import_module(f"{prefix}core.network_tls")
        importlib.import_module(f"{prefix}network_tls")
        fake_ctx = mock.MagicMock()
        with mock.patch(f"{prefix}network_tls.ssl.create_default_context", return_value=fake_ctx) as ctx_mock:
            result = core_network_tls.client_context()
        ctx_mock.assert_called_once_with(purpose=ssl.Purpose.SERVER_AUTH)
        self.assertIs(result, fake_ctx)
        self.assertTrue(fake_ctx.check_hostname)
        self.assertEqual(fake_ctx.verify_mode, ssl.CERT_REQUIRED)

        agent_live_client_pkg = importlib.import_module(f"{prefix}agent.agent_live_client")
        importlib.import_module(f"{prefix}agent_live_client")
        original_client = agent_live_client_pkg.LiveTabClient
        sentinel = object()
        with mock.patch(f"{prefix}agent_live_client.LiveTabClient", sentinel):
            self.assertIs(agent_live_client_pkg.LiveTabClient, sentinel)
        self.assertIs(agent_live_client_pkg.LiveTabClient, original_client)

    def test_subpackage_modules_have_zero_dual_import_shims_and_clean_intra_imports(self):
        files = sorted((DESKTOP_DIR / "core").glob("*.py")) + sorted((DESKTOP_DIR / "agent").glob("*.py"))
        self.assertGreaterEqual(len(files), len(CORE_MODULES) + len(AGENT_MODULES) + 2)
        self.assertIn(DESKTOP_DIR / "agent" / "agent_live_client.py", files)
        migrated = set(CORE_MODULES) | set(AGENT_MODULES)
        for path in files:
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
            for node in ast.walk(tree):
                if isinstance(node, ast.Try) and _has_import(node.body):
                    for handler in node.handlers:
                        if _caught_exception_names(handler.type) & {"ImportError", "ModuleNotFoundError"}:
                            self.assertFalse(
                                _has_import(handler.body) or _has_relative_import(node.body),
                                f"Dual-import try/except shim found in {path.relative_to(DESKTOP_DIR)}",
                            )
                if isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                    top = node.module.split(".", 1)[0]
                    self.assertNotIn(
                        top,
                        migrated | {"core", "agent"},
                        f"Non-relative intra-subpackage import {node.module!r} in {path.relative_to(DESKTOP_DIR)}",
                    )


if __name__ == "__main__":
    unittest.main()
