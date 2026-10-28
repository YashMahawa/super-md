from __future__ import annotations

import base64
import hashlib
import http.client
import json
import queue
import sys
import tempfile
import threading
import time
import types
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from types import SimpleNamespace

import agent_live


class _BoundSignal:
    def __init__(self, queue_ref=None):
        self.queue = queue_ref
        self.slots = []

    def connect(self, callback, *_args):
        self.slots.append(callback)

    def emit(self, *args):
        for callback in list(self.slots):
            if self.queue is None:
                callback(*args)
            else:
                self.queue.put((callback, args))


class _SignalDescriptor:
    def __set_name__(self, owner, name):
        self.name = "_signal_" + name

    def __get__(self, instance, owner):
        if instance is None:
            return self
        if self.name not in instance.__dict__:
            instance.__dict__[self.name] = _BoundSignal(getattr(instance, "_qt_queue", None))
        return instance.__dict__[self.name]


def _install_qt_stub(queue_ref):
    qt_core = types.ModuleType("PySide6.QtCore")

    class QObject:
        def __init__(self, *_args, **_kwargs):
            self._qt_queue = queue_ref

    class Qt:
        class ConnectionType:
            QueuedConnection = 1

    def Slot(*_args, **_kwargs):
        return lambda function: function

    qt_core.QObject = QObject
    qt_core.Signal = lambda *_args, **_kwargs: _SignalDescriptor()
    qt_core.Slot = Slot
    qt_core.Qt = Qt
    package = types.ModuleType("PySide6")
    package.__path__ = []
    package.QtCore = qt_core
    sys.modules["PySide6"] = package
    sys.modules["PySide6.QtCore"] = qt_core


class _FakeStudio:
    agentRequest = _SignalDescriptor()

    def __init__(self, qt_queue, window_id, tabs, active):
        self._qt_queue = qt_queue
        self.window_id = window_id
        self.tabs = tabs
        self.active = active
        self.retired = False
        self.live_source = next(tab["content"] for tab in tabs if tab["id"] == active)
        self._agent_job_records = {"job-1": {"status": "completed"}}

    def _agent_document_action(self, payload):
        if payload["action"] == "create_document":
            tab = {"id": "created", "name": payload.get("title") or "Untitled.md", "path": "",
                   "content": payload["content"], "saved": "", "portable": False, "assets": {}}
            self.tabs.append(tab); self.active = tab["id"]
            return {"tabId": tab["id"], "windowId": self.window_id, "title": tab["name"],
                    "path": "", "revision": hashlib.sha256(tab["content"].encode()).hexdigest(), "isDirty": True}
        if payload["action"] == "save_document":
            return {"tabId": payload["tabId"], "windowId": self.window_id, "path": "/tmp/owned.md",
                    "filename": "owned.md", "revision": hashlib.sha256(self.live_source.encode()).hexdigest(),
                    "format": "md", "isDirty": False}
        if payload["action"] == "open_document":
            if payload.get("filename", "") == "":
                tab = next((item for item in self.tabs if item["id"] == payload.get("tabId")), None)
                if tab is None:
                    raise ValueError("target tab is not open")
                self.active = tab["id"]
                self.live_source = tab["content"]
                return {"tabId": tab["id"], "windowId": self.window_id, "title": tab["name"],
                        "path": tab["path"], "revision": hashlib.sha256(tab["content"].encode()).hexdigest(),
                        "isDirty": tab["content"] != tab["saved"]}
            return {"status": "opening", "path": payload["filename"], "windowId": self.window_id}
        if payload["action"] == "replace_tab_asset":
            return {"tabId": payload["tabId"], "assetName": payload["assetName"],
                    "revision": hashlib.sha256(self.live_source.encode()).hexdigest(), "changed": True}
        raise ValueError("unsupported")

    def _agent_job_status(self, job_id):
        return {"jobId": job_id, "status": "completed", "filename": "a.pdf", "format": "pdf",
                "bytes": 10, "sha256": "a" * 64}


class LiveDesktopBridgeTests(unittest.TestCase):
    def setUp(self):
        self.events = queue.Queue()
        self._previous_qt_modules = {name: module for name, module in sys.modules.items()
                                     if name == "PySide6" or name.startswith("PySide6.")}
        _install_qt_stub(self.events)
        self.temp = tempfile.TemporaryDirectory()
        self.window_id = "window-test-1"
        self.active_id = "tab-active"
        self.inactive_id = "tab-inactive"
        self.source = "# Live draft\n\nA diagram is here.\n"
        tabs = [
            {"id": self.active_id, "name": "Active.md", "path": "", "content": "# Old\n", "saved": "# Old\n", "portable": False, "assets": {}},
            {"id": self.inactive_id, "name": "Other.md", "path": "", "content": "# Other\n\nneedle here\n", "saved": "# Other\n\nneedle here\n", "portable": False, "assets": {}},
        ]
        self.session = SimpleNamespace(windows={})
        self.studio = _FakeStudio(self.events, self.window_id, tabs, self.active_id)
        self.session.windows[self.window_id] = self.studio
        self.bridge = agent_live.create_qt_bridge(self.session, Path(self.temp.name))
        self.discovery = self.bridge.start()
        self.studio.agentRequest.connect(self._handle_qml_request)
        self.client = agent_live.LiveTabClient(self.bridge.discovery_path)

    def tearDown(self):
        self.bridge.stop()
        self.temp.cleanup()
        for name in [name for name in sys.modules if name == "PySide6" or name.startswith("PySide6.")]:
            sys.modules.pop(name, None)
        sys.modules.update(self._previous_qt_modules)

    def _finish(self, request, result=None, error=""):
        self.bridge.complete(request["requestId"], result, error, window_id=self.studio.window_id)

    def _handle_qml_request(self, raw):
        request = json.loads(raw)
        action = request["action"]
        if action == "flush_current":
            active = next(tab for tab in self.studio.tabs if tab["id"] == self.studio.active)
            active["content"] = self.studio.live_source
            self._finish(request, {"flushed": True})
        elif action == "list_tabs":
            current = next(tab for tab in request["tabs"] if tab["id"] == self.active_id)
            current.update({"revision": hashlib.sha256(self.studio.live_source.encode()).hexdigest(),
                            "sourceLength": len(self.studio.live_source), "isDirty": True})
            self._finish(request, {"tabs": request["tabs"]})
        elif action == "read_tab":
            self.studio.tabs[0]["content"] = self.studio.live_source
            revision = hashlib.sha256(self.studio.live_source.encode()).hexdigest()
            start = request.get("offset", 0)
            text = self.studio.live_source[start:start + request.get("limit", 12000)]
            self._finish(request, {"tabId": self.active_id, "windowId": self.window_id,
                                   "revision": revision, "offset": start, "markdown": text,
                                   "totalLength": len(self.studio.live_source)})
        elif action == "patch_tab":
            current_revision = hashlib.sha256(self.studio.live_source.encode()).hexdigest()
            if request["expectedRevision"] != current_revision:
                self._finish(request, error="The live tab revision changed")
                return
            updated = self.studio.live_source
            for operation in request["operations"]:
                if operation.get("type") != "replace" or operation["old"] not in updated:
                    self._finish(request, error="Invalid test operation")
                    return
                updated = updated.replace(operation["old"], operation["new"], 1)
            self.studio.live_source = updated
            self.studio.tabs[0]["content"] = updated
            self._finish(request, {"revision": hashlib.sha256(updated.encode()).hexdigest(), "changed": True})
        elif action == "render_tab":
            png = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lS8AAAAASUVORK5CYII=")
            self._finish(request, {"mime_type": "image/png", "data": base64.b64encode(png).decode(),
                                   "width": 1, "height": 1,
                                   "revision": hashlib.sha256(self.studio.live_source.encode()).hexdigest()})
        elif action == "get_context":
            self._finish(request, {"tabId": self.active_id, "revision": hashlib.sha256(self.studio.live_source.encode()).hexdigest(),
                                   "mode": "live", "zoom": 100, "reading": {"visibleText": "Live draft"},
                                   "selection": {"text": ""}})
        elif action == "latex_review":
            self._finish(request, {"tabId": self.active_id, "revision": hashlib.sha256(self.studio.live_source.encode()).hexdigest(),
                                   "repairs": [{"index": 0, "before": "\\(x", "after": "\\(x\\)", "reason": "unclosed"}],
                                   "total": 1, "truncated": False})
        elif action == "latex_apply":
            self._finish(request, {"tabId": self.active_id, "revision": hashlib.sha256(self.studio.live_source.encode()).hexdigest(),
                                   "applied": len(request.get("repairIndices", []))})
        elif action == "list_diagrams":
            self._finish(request, {"tabId": self.active_id, "revision": hashlib.sha256(self.studio.live_source.encode()).hexdigest(),
                                   "diagrams": [{"id": "diagram:4", "kind": "svg", "sourceStart": 4}]})
        elif action == "get_diagram":
            self._finish(request, {"tabId": self.active_id, "revision": hashlib.sha256(self.studio.live_source.encode()).hexdigest(),
                                   "diagramId": request["diagramId"], "source": "<svg/>", "start": 4, "end": 10})
        elif action == "get_diagram_image":
            png = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lS8AAAAASUVORK5CYII=")
            self._finish(request, {"mime_type": "image/png", "data": base64.b64encode(png).decode(), "width": 1, "height": 1,
                                   "diagramId": request["diagramId"], "revision": hashlib.sha256(self.studio.live_source.encode()).hexdigest()})
        elif action == "export_document":
            self._finish(request, {"filename": "Active.pdf", "format": "pdf", "bytes": 12,
                                   "sha256": "a" * 64, "path": "/tmp/Active.pdf"})
        else:
            self._finish(request, error="Unknown test action")

    def _call_with_qt_pump(self, callback):
        result = {}
        done = threading.Event()

        def worker():
            try:
                result["value"] = callback()
            except Exception as error:
                result["error"] = error
            finally:
                done.set()

        thread = threading.Thread(target=worker, daemon=True)
        thread.start()
        deadline = time.monotonic() + 3
        while not done.is_set() and time.monotonic() < deadline:
            try:
                slot, args = self.events.get(timeout=0.02)
            except queue.Empty:
                continue
            slot(*args)
        thread.join(0.2)
        self.assertTrue(done.is_set(), "bridge request did not finish")
        if "error" in result:
            raise result["error"]
        return result.get("value")

    def test_live_read_flushes_pending_typing_and_patch_is_revision_guarded(self):
        self.studio.live_source = self.source
        read = self._call_with_qt_pump(lambda: self.client.read_tab(
            self.active_id, window_id=self.window_id))
        self.assertEqual(read["markdown"], self.source)
        self.assertEqual(read["revision"], hashlib.sha256(self.source.encode()).hexdigest())
        self.assertEqual(self.studio.tabs[0]["content"], self.source)
        updated = self._call_with_qt_pump(lambda: self.client.patch_tab(
            self.active_id, read["revision"], [{"type": "replace", "old": "diagram", "new": "chart"}],
            window_id=self.window_id))
        self.assertTrue(updated["changed"])
        self.assertIn("A chart", self.studio.live_source)
        with self.assertRaises(agent_live.LiveBridgeError):
            self._call_with_qt_pump(lambda: self.client.patch_tab(
                self.active_id, "0" * 64, [{"type": "replace", "old": "A chart", "new": "no"}],
                window_id=self.window_id))
        self.assertIn("A chart", self.studio.live_source)
        self.assertFalse(self.bridge._pending)

    def test_inactive_search_flushes_active_draft_and_viewport_decodes_image(self):
        self.studio.live_source = self.source
        search = self._call_with_qt_pump(lambda: self.client.search_tab(
            self.inactive_id, "needle", window_id=self.window_id))
        self.assertEqual(search["matches"][0]["line"], 3)
        self.assertEqual(self.studio.tabs[0]["content"], self.source)
        image = self._call_with_qt_pump(lambda: self.client.render_tab(
            self.active_id, 64, window_id=self.window_id))
        self.assertEqual(image["mime_type"], "image/png")
        self.assertTrue(image["data"].startswith(b"\x89PNG\r\n\x1a\n"))

    def test_live_listing_preserves_native_tabs_and_updates_active_revision(self):
        self.studio.live_source = self.source
        listing = self._call_with_qt_pump(self.client.list_tabs)
        self.assertEqual(len(listing["tabs"]), 2)
        active = next(row for row in listing["tabs"] if row["id"] == self.active_id)
        self.assertTrue(active["isDirty"])
        self.assertEqual(active["revision"], hashlib.sha256(self.source.encode()).hexdigest())
        self.assertEqual(active["windowId"], self.window_id)

    def test_revision_checked_asset_extraction_returns_original_image_bytes(self):
        png_b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lS8AAAAASUVORK5CYII="
        self.studio.live_source = self.source
        self.studio.tabs[0]["assets"] = {"assets/pixel.png": "data:image/png;base64," + png_b64}
        page = self._call_with_qt_pump(lambda: self.client.read_tab(
            self.active_id, limit=1, asset_offset=0, asset_limit=1, window_id=self.window_id))
        self.assertEqual(page["assetCount"], 1)
        self.assertEqual(page["assets"][0]["name"], "assets/pixel.png")
        revision = hashlib.sha256(self.source.encode()).hexdigest()
        image = self._call_with_qt_pump(lambda: self.client.get_tab_image(
            self.active_id, asset_name="assets/pixel.png", expected_revision=revision,
            window_id=self.window_id))
        self.assertEqual(image["asset"], "assets/pixel.png")
        self.assertEqual(image["mime_type"], "image/png")
        self.assertTrue(image["data"].startswith(b"\x89PNG\r\n\x1a\n"))

    def test_document_actions_route_with_revision_and_window_guards(self):
        self.studio.live_source = self.source
        revision = hashlib.sha256(self.source.encode()).hexdigest()
        context = self._call_with_qt_pump(lambda: self.client.document_action(
            self.active_id, "get_context", window_id=self.window_id))
        self.assertEqual(context["mode"], "live")
        review = self._call_with_qt_pump(lambda: self.client.document_action(
            self.active_id, "latex_review", window_id=self.window_id))
        self.assertEqual(review["repairs"][0]["index"], 0)
        applied = self._call_with_qt_pump(lambda: self.client.document_action(
            self.active_id, "latex_apply", expected_revision=revision, repair_indices=[0],
            window_id=self.window_id))
        self.assertEqual(applied["applied"], 1)
        exported = self._call_with_qt_pump(lambda: self.client.document_action(
            self.active_id, "export_document", format="pdf", expected_revision=revision,
            window_id=self.window_id))
        self.assertEqual(exported["filename"], "Active.pdf")
        with self.assertRaises(agent_live.LiveBridgeError):
            self.client.document_action(self.active_id, "unknown", window_id=self.window_id)

    def test_native_create_save_open_and_async_job_status(self):
        created = self._call_with_qt_pump(lambda: self.client.document_action(
            "", "create_document", content="# New note\n", title="New", format="md", window_id=self.window_id))
        self.assertEqual(created["tabId"], "created")
        saved = self._call_with_qt_pump(lambda: self.client.document_action(
            "created", "save_document", expected_revision=created["revision"], window_id=self.window_id))
        self.assertEqual(saved["filename"], "owned.md")
        opened = self._call_with_qt_pump(lambda: self.client.document_action(
            "created", "open_document", filename="/tmp/owned.md", window_id=self.window_id))
        self.assertEqual(opened["status"], "opening")
        status = self._call_with_qt_pump(lambda: self.client.document_action(
            "created", "job_status", job_id="job-1", window_id=self.window_id))
        self.assertEqual(status["status"], "completed")

    def test_explicit_open_on_inactive_tab_flushes_then_activates_it(self):
        self.studio.live_source = self.source
        activated = self._call_with_qt_pump(lambda: self.client.document_action(
            self.inactive_id, "open_document", filename="", window_id=self.window_id))
        self.assertEqual(self.studio.active, self.inactive_id)
        self.assertEqual(self.studio.tabs[0]["content"], self.source)
        self.assertEqual(activated["tabId"], self.inactive_id)
        self.assertEqual(activated["revision"], hashlib.sha256(self.studio.tabs[1]["content"].encode()).hexdigest())

    def test_diagram_source_and_image_use_revision_guarded_renderer_api(self):
        revision = hashlib.sha256(self.studio.live_source.encode()).hexdigest()
        listing = self._call_with_qt_pump(lambda: self.client.list_diagrams(self.active_id, window_id=self.window_id))
        self.assertEqual(listing["diagrams"][0]["id"], "diagram:4")
        source = self._call_with_qt_pump(lambda: self.client.get_diagram(
            self.active_id, "diagram:4", revision, window_id=self.window_id))
        self.assertEqual(source["source"], "<svg/>")
        image = self._call_with_qt_pump(lambda: self.client.get_diagram_image(
            self.active_id, "diagram:4", revision, window_id=self.window_id))
        self.assertTrue(image["data"].startswith(b"\x89PNG"))

    def test_cloud_rpc_qualifies_tabs_and_disable_cancels_only_cloud_requests(self):
        result = self._call_with_qt_pump(lambda: self.bridge.handle_cloud_request({"action": "list_tabs"}))
        self.assertTrue(result["tabs"][0]["tabId"].startswith(self.window_id + ":"))
        self.assertEqual(result["tabs"][0]["id"], result["tabs"][0]["tabId"])
        failure = {}
        worker = threading.Thread(target=lambda: self._capture_cloud_failure(failure), daemon=True)
        worker.start()
        self.events.get(timeout=1)  # queued Qt dispatch remains unprocessed
        self.bridge.stop_cloud()
        worker.join(1)
        self.assertFalse(worker.is_alive())
        self.assertIn("cancelled", str(failure.get("error", "")).lower())
        self.assertFalse(self.bridge._pending)

    def _capture_cloud_failure(self, target):
        try:
            self.bridge._remote_call_gui({"action": "read_tab", "tabId": self.active_id})
        except Exception as error:
            target["error"] = error

    def test_auth_invalid_origin_discovery_permissions_and_disable_cleanup(self):
        url = self.bridge.endpoint
        body = b'{"action":"list_tabs"}'
        for headers, expected in [({"Authorization": "Bearer invalid"}, 401),
                                  ({"Authorization": "Bearer " + self.bridge.token, "Origin": "http://evil.example"}, 403),
                                  ({"Authorization": "Bearer " + self.bridge.token, "Host": "evil.example"}, 403)]:
            request = urllib.request.Request(url, data=body, method="POST", headers=headers)
            with self.assertRaises(urllib.error.HTTPError) as caught:
                urllib.request.urlopen(request, timeout=1)
            self.assertEqual(caught.exception.code, expected)
            caught.exception.close()
        self.assertTrue(self.bridge.discovery_path.exists())
        self.assertNotIn("token", self.bridge.status())
        if sys.platform != "win32":
            self.assertEqual(self.bridge.discovery_path.stat().st_mode & 0o777, 0o600)
        discovery_path = self.bridge.discovery_path
        self.bridge.stop()
        self.assertFalse(discovery_path.exists())
        self.assertFalse(self.bridge.enabled)
        with self.assertRaises(agent_live.LiveBridgeError):
            agent_live.read_discovery(discovery_path)


if __name__ == "__main__":
    unittest.main()
