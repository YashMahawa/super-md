"""Verify desktop/core and desktop/agent subpackage layout, root shims, and mock propagation."""
from __future__ import annotations

import ast
import importlib
import ssl
import subprocess
import sys
import unittest
from pathlib import Path
from unittest import mock

DESKTOP_DIR = Path(__file__).resolve().parent
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


class CoreAgentSubpackageTests(unittest.TestCase):
    def test_package_markers_preserve_script_directory_root(self):
        self.assertFalse((DESKTOP_DIR / "__init__.py").exists())
        for subpkg in ("core", "agent"):
            marker = DESKTOP_DIR / subpkg / "__init__.py"
            self.assertTrue(marker.is_file(), f"Missing {marker}")
            self.assertEqual(marker.read_bytes(), b"")

    def test_root_shims_preserve_single_module_identity_and_reimport(self):
        cases = [("core", mod) for mod in CORE_MODULES] + [("agent", mod) for mod in AGENT_MODULES]
        for pkg, mod in cases:
            with self.subTest(package=pkg, module=mod):
                pkg_mod = importlib.import_module(f"{pkg}.{mod}")
                root_mod = importlib.import_module(mod)
                expected_file = (DESKTOP_DIR / pkg / f"{mod}.py").resolve()
                self.assertIs(root_mod, pkg_mod)
                self.assertIs(sys.modules[mod], sys.modules[f"{pkg}.{mod}"])
                self.assertEqual(Path(pkg_mod.__file__).resolve(), expected_file)

                sys.modules.pop(mod, None)
                reimported = importlib.import_module(mod)
                self.assertIs(reimported, pkg_mod)
                self.assertIs(sys.modules[mod], sys.modules[f"{pkg}.{mod}"])
                self.assertEqual(Path(reimported.__file__).resolve(), expected_file)

    def test_mock_patch_targets_propagate_across_alias_boundary(self):
        core_updates = importlib.import_module("core.updates")
        importlib.import_module("updates")
        completed = subprocess.CompletedProcess([], 0, "super-md: /opt/super-md/super-md\n", "")
        with (
            mock.patch("updates.shutil.which", side_effect=lambda n: "/usr/bin/dpkg-query" if n == "dpkg-query" else None),
            mock.patch("updates.subprocess.run", return_value=completed) as run_mock,
        ):
            self.assertEqual(core_updates.linux_install_kind("/opt/super-md/super-md", {}, True, "/home/test"), "deb")
            run_mock.assert_called_once()

        core_network_tls = importlib.import_module("core.network_tls")
        importlib.import_module("network_tls")
        fake_ctx = mock.MagicMock()
        with mock.patch("network_tls.ssl.create_default_context", return_value=fake_ctx) as ctx_mock:
            result = core_network_tls.client_context()
        ctx_mock.assert_called_once_with(purpose=ssl.Purpose.SERVER_AUTH)
        self.assertIs(result, fake_ctx)
        self.assertTrue(fake_ctx.check_hostname)
        self.assertEqual(fake_ctx.verify_mode, ssl.CERT_REQUIRED)

        agent_live_client_pkg = importlib.import_module("agent.agent_live_client")
        importlib.import_module("agent_live_client")
        original_client = agent_live_client_pkg.LiveTabClient
        sentinel = object()
        with mock.patch("agent_live_client.LiveTabClient", sentinel):
            self.assertIs(agent_live_client_pkg.LiveTabClient, sentinel)
        self.assertIs(agent_live_client_pkg.LiveTabClient, original_client)

    def test_subpackage_modules_have_zero_dual_import_shims(self):
        files = sorted((DESKTOP_DIR / "core").glob("*.py")) + sorted((DESKTOP_DIR / "agent").glob("*.py"))
        self.assertGreaterEqual(len(files), len(CORE_MODULES) + len(AGENT_MODULES) + 2)
        self.assertIn(DESKTOP_DIR / "agent" / "agent_live_client.py", files)
        for path in files:
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
            for node in ast.walk(tree):
                if isinstance(node, ast.Try):
                    for handler in node.handlers:
                        caught = _caught_exception_names(handler.type)
                        self.assertFalse(
                            caught & {"ImportError", "ModuleNotFoundError"},
                            f"Dual-import shim found in {path.relative_to(DESKTOP_DIR)}",
                        )


if __name__ == "__main__":
    unittest.main()
