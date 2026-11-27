"""Unit tests for desktop/studio_reader_runtime.py behind the Studio facade."""
from __future__ import annotations

import ast
import base64
import io
import os
import socket
import tempfile
import unittest
import urllib.request
from email.message import Message
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
import studio as studio_module
import studio_reader_runtime


class _FakeResponse(io.BytesIO):
    def __init__(self, payload: bytes, content_type: str = "text/plain; charset=utf-8"):
        super().__init__(payload)
        self.headers = Message()
        self.headers["Content-Type"] = content_type


class StudioReaderRuntimeTest(unittest.TestCase):
    def test_module_boundary_has_no_studio_lookup_sys_modules_or_importerror_fallback(self):
        source = Path(studio_reader_runtime.__file__).read_text(encoding="utf-8")
        tree = ast.parse(source)
        self.assertNotIn("_studio_module", source)
        self.assertFalse(hasattr(studio_reader_runtime, "_studio_module"))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    self.assertNotIn(alias.name, ("studio", "desktop.studio"))
            elif isinstance(node, ast.ImportFrom):
                self.assertNotIn(node.module, ("studio", "desktop.studio"))
                for alias in node.names:
                    self.assertNotEqual(alias.name, "studio")
            elif isinstance(node, ast.Attribute):
                self.assertFalse(
                    isinstance(node.value, ast.Name) and node.value.id == "sys" and node.attr == "modules",
                    "studio_reader_runtime must not inspect sys.modules",
                )
            elif isinstance(node, ast.ExceptHandler):
                self.assertFalse(
                    isinstance(node.type, ast.Name) and node.type.id == "ImportError",
                    "studio_reader_runtime must use __package__ imports rather than ImportError handlers",
                )

    def test_public_address_and_pinned_handlers_honor_explicit_collaborators(self):
        for bad_url in ("file:///etc/passwd", "ftp://example.com/a", "https://user:pass@example.com/", "https://"):
            with self.assertRaisesRegex(ValueError, "Use a public web URL"):
                studio_module.public_address(bad_url)

        for blocked_ip in ("127.0.0.1", "10.0.0.8", "192.168.1.2", "169.254.169.254", "::1"):
            addr = [(socket.AF_INET6 if ":" in blocked_ip else socket.AF_INET, socket.SOCK_STREAM, 6, "", (blocked_ip, 443))]
            with patch("socket.getaddrinfo", return_value=addr):
                with self.assertRaisesRegex(ValueError, "Private, local and reserved"):
                    studio_module.public_address("https://internal.example/data")

        public_addr = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 443))]
        with patch("socket.getaddrinfo", return_value=public_addr):
            self.assertEqual(studio_module.public_address("https://example.com/ok"), "93.184.216.34")

        seen: list[tuple[str, object]] = []
        sentinel_ctx = object()
        https_handler = studio_module.PinnedHTTPSHandler()
        with (
            patch.object(studio_module, "public_address", return_value="93.184.216.34") as pub_mock,
            patch.object(studio_module, "client_context", return_value=sentinel_ctx) as ctx_mock,
            patch.object(
                https_handler, "do_open",
                side_effect=lambda factory, req, context=None: seen.append((req.full_url, context)) or _FakeResponse(b"ok"),
            ),
        ):
            https_handler.https_open(urllib.request.Request("https://example.com/ping"))
        pub_mock.assert_called_once_with("https://example.com/ping")
        ctx_mock.assert_called_once_with()
        self.assertEqual(seen, [("https://example.com/ping", sentinel_ctx)])

    def test_fetch_public_resource_honors_public_url_redirect_checks_and_simplenamespace(self):
        checked_urls: list[str] = []

        class _RedirectingHTTPHandler(urllib.request.HTTPHandler):
            def http_open(self, request):
                if request.full_url == "http://example.com/start":
                    headers = Message()
                    headers["Location"] = "http://127.0.0.1/admin"
                    resp = urllib.response.addinfourl(io.BytesIO(b""), headers, request.full_url, 302)
                    resp.msg = "Found"
                    return resp
                return _FakeResponse(b"ok")

        def _guard(u: str) -> str:
            checked_urls.append(u)
            if "127.0.0.1" in u:
                raise ValueError("Blocked redirect")
            return "93.184.216.34"

        proxy = SimpleNamespace(_public_url=_guard)
        with patch.object(studio_module, "PinnedHTTPHandler", _RedirectingHTTPHandler):
            with self.assertRaisesRegex(ValueError, "Blocked redirect"):
                studio_module.Studio._fetch(proxy, {"url": "http://example.com/start"})
        self.assertEqual(checked_urls, ["http://example.com/start", "http://127.0.0.1/admin"])

        bare = SimpleNamespace()
        png = b"\x89PNG\r\n\x1a\nok"
        with (
            patch.object(studio_module, "public_address", return_value="93.184.216.34") as pub_mock,
            patch("urllib.request.OpenerDirector.open", return_value=_FakeResponse(png, "image/png")),
        ):
            res = studio_module.Studio._fetch(bare, {"url": "https://example.com/a.png", "image": True})
        pub_mock.assert_called_once_with("https://example.com/a.png")
        self.assertEqual(res["body"], f"data:image/png;base64,{base64.b64encode(png).decode()}")

    def test_resolve_image_and_text_assets_enforce_containment_symlinks_and_size_caps(self):
        proxy = SimpleNamespace()
        with self.assertRaisesRegex(ValueError, "Save this note to resolve relative images"):
            studio_module.Studio._asset(proxy, {"path": "", "assets": {}}, "pic.png")
        with self.assertRaisesRegex(ValueError, "Save this note to resolve relative diagram source files"):
            studio_module.Studio._text_asset(proxy, {"path": "", "assets": {}}, "flow.mmd")

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            folder = root / "notes"
            folder.mkdir()
            note = folder / "doc.md"
            (root / "outside.png").write_bytes(b"png")
            outside_mmd = root / "outside.mmd"
            outside_mmd.write_text("graph TD; A-->B;", encoding="utf-8")
            (folder / "pic.png").write_bytes(b"12345")
            (folder / "flow 1.mermaid").write_text("flowchart LR\n  A --> B\n", encoding="utf-8")
            tab = {"path": str(note), "assets": {"embedded.png": "data:image/png;base64,AA=="}}

            self.assertEqual(studio_module.Studio._asset(proxy, tab, "embedded.png"), "data:image/png;base64,AA==")
            self.assertTrue(studio_module.Studio._asset(proxy, tab, "pic.png").startswith("data:image/png;base64,"))
            self.assertIn("flowchart LR", studio_module.Studio._text_asset(proxy, tab, "flow%201.mermaid"))
            with self.assertRaisesRegex(ValueError, "Only local .mmd or .mermaid"):
                studio_module.Studio._text_asset(proxy, tab, "notes.txt")
            with self.assertRaisesRegex(ValueError, "Image is outside the note folder"):
                studio_module.Studio._asset(proxy, tab, "../outside.png")
            with self.assertRaisesRegex(ValueError, "Diagram source is outside the note folder"):
                studio_module.Studio._text_asset(proxy, tab, "../outside.mmd")
            with patch.object(studio_module, "MAX_IMAGE", 3):
                with self.assertRaisesRegex(ValueError, "Image exceeds 25 MB"):
                    studio_module.Studio._asset(proxy, tab, "pic.png")

            link = folder / "linked.mmd"
            try:
                link.symlink_to(outside_mmd)
            except (OSError, NotImplementedError):
                pass
            else:
                with self.assertRaisesRegex(ValueError, "Diagram source symlink paths are not allowed"):
                    studio_module.Studio._text_asset(proxy, tab, "linked.mmd")

    def test_find_open_tab_matches_canonical_and_case_folded_paths(self):
        with tempfile.TemporaryDirectory() as tmp:
            note = (Path(tmp) / "Topic.md").resolve()
            note.write_text("# Topic\n", encoding="utf-8")
            upper = str(note.with_name("TOPIC.MD"))
            tab = {"id": "tab-1", "path": upper}
            proxy = SimpleNamespace(tabs=[tab])
            self.assertIs(studio_module.Studio._find_open_tab(proxy, "tab-1"), tab)
            self.assertIsNone(studio_module.Studio._find_open_tab(proxy, str(note), canonicalize_local=False))
            with (
                patch.object(studio_module, "local_path", wraps=studio_module.local_path) as lp_spy,
                patch("os.path.samefile", side_effect=lambda a, b: {str(a), str(b)} == {upper, str(note)}),
            ):
                self.assertIs(studio_module.Studio._find_open_tab(proxy, note.as_uri(), canonicalize_local=True), tab)
            lp_spy.assert_called_once_with(note.as_uri())

    def test_resolve_pdf_engine_and_python_cell_and_reader_crashed(self):
        with tempfile.TemporaryDirectory() as tmp:
            fake_root = Path(tmp)
            win_bin = fake_root / "smd-core" / "target" / "release" / "smd-engine.exe"
            win_bin.parent.mkdir(parents=True)
            win_bin.write_bytes(b"MZ")
            with patch.object(studio_module, "ROOT", fake_root), patch.object(studio_module.sys, "platform", "win32"):
                self.assertEqual(studio_module.Studio._engine(SimpleNamespace()), win_bin)
            win_bin.unlink()
            with patch.object(studio_module, "ROOT", fake_root):
                with self.assertRaisesRegex(ValueError, "Native PDF engine is not installed"):
                    studio_module.Studio._engine(SimpleNamespace())

        events: list[tuple[str, object]] = []
        jobs = SimpleNamespace(
            register=lambda tag: events.append(("register", tag)) or "job-1",
            discard=lambda j: events.append(("discard", j)),
        )
        proxy = SimpleNamespace(settings={"python": "/usr/bin/python3"}, _python_jobs=jobs)
        with patch.object(studio_module.python_runtime, "run", return_value={"stdout": "42"}) as run_mock:
            out = studio_module.Studio._python(proxy, "", "print(42)", folder="/tmp")
        self.assertEqual(out, {"stdout": "42"})
        run_mock.assert_called_once_with("/usr/bin/python3", "print(42)", cwd="/tmp", job="job-1")
        self.assertEqual(events, [("register", ""), ("discard", "job-1")])

        emitted: list[bool] = []
        crashed = SimpleNamespace(
            retired=False, ready=True, _last_reader_text="hi", _last_reader_agent_seq={"t": 2},
            reader_overlay=True, image_overlay=True, _emit=emitted.append,
        )
        studio_module.Studio.readerCrashed(crashed)
        self.assertEqual((crashed.ready, crashed._last_reader_text, crashed._last_reader_agent_seq), (False, None, {}))
        self.assertEqual((crashed.reader_overlay, crashed.image_overlay, emitted), (False, False, [False]))


if __name__ == "__main__":
    unittest.main()
