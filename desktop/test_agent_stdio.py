from __future__ import annotations

import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import agent_cli
import agent_live_cli


class AgentStdioTests(unittest.TestCase):
    def test_cli_imports_remain_free_of_qt(self):
        cli = Path(__file__).with_name("agent_cli.py")
        result = subprocess.run(
            [sys.executable, "-c", "import agent_cli, agent_live_cli, sys; assert 'PySide6' not in sys.modules"],
            cwd=cli.parent, capture_output=True, check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr.decode("utf-8", errors="replace"))

    def test_emitters_reconfigure_cp1252_pipes_to_utf8(self):
        for emitter in (agent_cli._emit, agent_live_cli._emit):
            with self.subTest(emitter=emitter.__module__), patch("sys.stdout", io.TextIOWrapper(
                    io.BytesIO(), encoding="cp1252", errors="strict")) as stream:
                emitter({"ok": True, "result": {"text": "emoji 🧭 and CJK 東京"}})
                stream.flush()
                self.assertEqual(stream.encoding.lower().replace("_", "-"), "utf-8")
                raw = stream.buffer.getvalue()
                self.assertTrue(raw.endswith(b"\n"))
                self.assertEqual(json.loads(raw.decode("utf-8"))["result"]["text"], "emoji 🧭 and CJK 東京")

    def test_emitters_keep_stringio_redirects_working(self):
        for emitter in (agent_cli._emit, agent_live_cli._emit):
            with self.subTest(emitter=emitter.__module__), patch("sys.stdout", io.StringIO()) as stream:
                emitter({"ok": True, "result": {"text": "emoji 🧭"}})
                self.assertEqual(json.loads(stream.getvalue())["result"]["text"], "emoji 🧭")

    def test_stdin_create_and_json_read_work_with_cp1252_startup_streams(self):
        cli = Path(__file__).with_name("agent_cli.py")
        payload = "# UTF-8 input 🧭\n本文 café\n".encode("utf-8")
        environment = dict(os.environ, PYTHONIOENCODING="cp1252")
        with tempfile.TemporaryDirectory(prefix="supermd-utf8-stdio-") as directory:
            root = Path(directory)
            created = subprocess.run(
                [sys.executable, str(cli), "--root", str(root), "create", "utf8.md", "--stdin"],
                cwd=cli.parent, env=environment, input=payload, capture_output=True, check=False,
            )
            self.assertEqual(created.returncode, 0, created.stderr.decode("utf-8", errors="replace"))
            self.assertEqual(created.stderr, b"")
            self.assertEqual(json.loads(created.stdout.decode("utf-8"))["ok"], True)

            read = subprocess.run(
                [sys.executable, str(cli), "--root", str(root), "read", "utf8.md", "--view", "source"],
                cwd=cli.parent, env=environment, capture_output=True, check=False,
            )
            self.assertEqual(read.returncode, 0, read.stderr.decode("utf-8", errors="replace"))
            self.assertEqual(read.stderr, b"")
            response = json.loads(read.stdout.decode("utf-8"))
            self.assertEqual(response["result"]["text"], payload.decode("utf-8"))


if __name__ == "__main__":
    unittest.main()
