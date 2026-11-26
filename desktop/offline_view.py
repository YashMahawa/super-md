"""Bounded subprocess rendering for offline and background note previews."""
from __future__ import annotations

import hashlib
import json
import sys
import tempfile
import threading
import time
from pathlib import Path
from core.paths import DESKTOP_DIR
from core.process_tree import (
    CREATE_SUSPENDED,
    OwnedProcessTree,
    contained_spawn_kwargs,
    read_tail,
    spawn_contained_process,
    terminate_posix_tree,
)


DEFAULT_PREVIEW_TIMEOUT = 55.0
_MAX_DIAGNOSTIC_BYTES = 16384

_CREATE_SUSPENDED = CREATE_SUSPENDED
_preview_spawn_kwargs = contained_spawn_kwargs
_terminate_posix_preview = terminate_posix_tree


class _PreviewProcessController(OwnedProcessTree):
    """Owns and confines cleanup to the process tree spawned for one preview."""


class PreviewCancelled(RuntimeError):
    """Raised when an offline or background preview is cancelled by tab or window close."""


class PreviewJob:
    """Per-preview cancellation handle; marks cancellation promptly while owned workers wait."""

    def __init__(self, tab_id: str = ""):
        self.tab_id = tab_id
        self.cancelled = threading.Event()
        self._lock = threading.Lock()

    def check(self) -> None:
        if self.cancelled.is_set():
            raise PreviewCancelled("Preview cancelled")

    def cancel(self) -> bool:
        with self._lock:
            if self.cancelled.is_set():
                return False
            self.cancelled.set()
            return True


class PreviewJobRegistry:
    """Thread-safe registry of active background preview helpers scoped to one Studio window."""

    def __init__(self):
        self._lock = threading.RLock()
        self._jobs: set[PreviewJob] = set()
        self._retired = False

    def register(self, tab_id: str = "") -> PreviewJob:
        job = PreviewJob(tab_id)
        with self._lock:
            if self._retired:
                job.cancelled.set()
            else:
                self._jobs.add(job)
        return job

    def discard(self, job: PreviewJob | None) -> None:
        if job is None:
            return
        with self._lock:
            self._jobs.discard(job)

    def active_count(self, tab_id: str | None = None) -> int:
        with self._lock:
            if tab_id is None:
                return len(self._jobs)
            return sum(1 for job in self._jobs if job.tab_id == tab_id)

    def cancel_tab(self, tab_id: str) -> int:
        if not tab_id:
            return 0
        with self._lock:
            targets = tuple(job for job in self._jobs if job.tab_id == tab_id)
        cancelled = 0
        for job in targets:
            if job.cancel():
                cancelled += 1
        return cancelled

    def cancel_all(self, *, retire: bool = False) -> int:
        with self._lock:
            if retire:
                self._retired = True
            targets = tuple(self._jobs)
        cancelled = 0
        for job in targets:
            if job.cancel():
                cancelled += 1
        return cancelled


def _spawn_preview_process(
    command: list[str],
    *,
    stdout_path: Path,
    stderr_path: Path,
    env: dict | None = None,
    job: PreviewJob | None = None,
    os_name: str | None = None,
    popen_fn=None,
    kernel32=None,
    ntdll=None,
) -> _PreviewProcessController:
    controller = spawn_contained_process(
        command,
        env=env,
        stdout_path=stdout_path,
        stderr_path=stderr_path,
        label="offline preview",
        is_cancelled=job.cancelled.is_set if job is not None else None,
        on_cancelled=lambda: PreviewCancelled("Preview cancelled"),
        controller_cls=_PreviewProcessController,
        os_name=os_name,
        popen_fn=popen_fn,
        kernel32=kernel32,
        ntdll=ntdll,
    )
    assert isinstance(controller, _PreviewProcessController)
    return controller


def _read_tail(path: Path, limit: int = _MAX_DIAGNOSTIC_BYTES) -> str:
    return read_tail(path, limit=limit)


def _extract_structured_error(stdout_text: str) -> str | None:
    for candidate in reversed([line.strip() for line in stdout_text.splitlines() if line.strip()]):
        try:
            payload = json.loads(candidate)
        except ValueError:
            continue
        if isinstance(payload, dict) and payload.get("ok") is False:
            error_obj = payload.get("error")
            if isinstance(error_obj, dict) and isinstance(error_obj.get("message"), str) and error_obj["message"].strip():
                return error_obj["message"].strip()
            if isinstance(error_obj, str) and error_obj.strip():
                return error_obj.strip()
    return None


def _format_preview_failure(stdout_path: Path, stderr_path: Path) -> str:
    stdout_tail = _read_tail(stdout_path)
    stderr_tail = _read_tail(stderr_path)
    structured = _extract_structured_error(stdout_tail)
    if structured:
        return structured[-1000:]
    combined = "\n".join(part for part in (stdout_tail.strip(), stderr_tail.strip()) if part)
    if combined:
        return combined[-1000:]
    return "Preview helper exited without producing a valid PNG image"


def _agent_cli_command() -> list[str]:
    if getattr(sys, "frozen", False):
        return [sys.executable, "agent"]
    return [sys.executable, str(DESKTOP_DIR / "agent_cli.py")]


def _run_preview_helper(
    command: list[str],
    target: Path,
    directory: Path,
    *,
    label: str,
    timeout: float = DEFAULT_PREVIEW_TIMEOUT,
    job: PreviewJob | None = None,
    env: dict | None = None,
) -> bytes:
    if job is not None:
        job.check()
    stdout_path = directory / "stdout.txt"
    stderr_path = directory / "stderr.txt"
    controller = _spawn_preview_process(
        command,
        stdout_path=stdout_path,
        stderr_path=stderr_path,
        env=env,
        job=job,
    )
    deadline = time.monotonic() + max(0.01, float(timeout))
    step = 0.02 if job is not None else 0.1
    try:
        while True:
            if job is not None and job.cancelled.is_set():
                controller.terminate()
                raise PreviewCancelled(f"{label} cancelled")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                controller.terminate()
                raise ValueError(f"{label} timed out after {timeout:g} seconds")
            if controller.wait_step(min(step, remaining)):
                break
        if job is not None and job.cancelled.is_set():
            controller.terminate()
            raise PreviewCancelled(f"{label} cancelled")
    finally:
        controller.cleanup()

    if controller.process.returncode or not target.is_file():
        raise ValueError(f"{label} failed: {_format_preview_failure(stdout_path, stderr_path)}")
    data = target.read_bytes()
    if len(data) < 24 or not data.startswith(b"\x89PNG\r\n\x1a\n"):
        raise ValueError(f"{label} failed: {_format_preview_failure(stdout_path, stderr_path)}")
    return data


def render_offline(
    store,
    path_value,
    *,
    width: int = 1200,
    expected_revision: str | None = None,
    timeout: float = DEFAULT_PREVIEW_TIMEOUT,
    job: PreviewJob | None = None,
) -> bytes:
    path = store.resolve(path_value)
    raw = path.read_bytes()
    revision = hashlib.sha256(raw).hexdigest()
    if expected_revision and expected_revision != revision:
        raise ValueError("Revision conflict; inspect the note again")
    with tempfile.TemporaryDirectory(prefix="supermd-preview-", ignore_cleanup_errors=True) as directory:
        root_dir = Path(directory)
        target = root_dir / "preview.png"
        command = list(_agent_cli_command())
        for root in store.roots:
            command += ["--root", str(root)]
        command += ["--root", directory, "preview", str(path), str(target), "--width", str(width)]
        data = _run_preview_helper(
            command,
            target,
            root_dir,
            label="Offline reader preview",
            timeout=timeout,
            job=job,
        )
        if path.read_bytes() != raw:
            raise ValueError("The source changed while rendering; retry")
        return data


def render_live_snapshot(
    content,
    assets,
    source_path,
    *,
    width: int = 1200,
    heading: str | None = None,
    view: dict | None = None,
    timeout: float = DEFAULT_PREVIEW_TIMEOUT,
    job: PreviewJob | None = None,
) -> bytes:
    with tempfile.TemporaryDirectory(prefix="supermd-live-preview-", ignore_cleanup_errors=True) as directory:
        root = Path(directory)
        source = Path(source_path) if source_path else root / "Untitled.md"
        if not source_path:
            source.write_text("", encoding="utf-8")
        snapshot = root / "snapshot.json"
        snapshot.write_text(
            json.dumps({"content": content, "assets": assets, "view": view or {}}),
            encoding="utf-8",
        )
        target = root / "preview.png"
        command = list(_agent_cli_command())
        command += [
            "--root",
            str(source.parent),
            "--root",
            directory,
            "preview",
            str(source),
            str(target),
            "--snapshot",
            str(snapshot),
            "--width",
            str(max(320, width)),
        ]
        if heading:
            command += ["--heading", heading]
        return _run_preview_helper(
            command,
            target,
            root,
            label="Background preview",
            timeout=timeout,
            job=job,
        )
