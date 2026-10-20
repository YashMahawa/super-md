"""Per-window ownership and cancellation for native PDF export jobs."""
from __future__ import annotations

import os
import threading
from pathlib import Path


class ExportCancelled(RuntimeError):
    pass


class ExportJob:
    def __init__(self, job_id: str):
        self.job_id = job_id
        self.cancelled = threading.Event()
        self._lock = threading.RLock()
        self._process = None
        self._promoted = False

    @property
    def promoted(self) -> bool:
        with self._lock:
            return self._promoted

    def check(self) -> None:
        if self.cancelled.is_set():
            raise ExportCancelled("PDF export cancelled")

    def attach_process(self, process) -> None:
        """Register only this job's engine process, terminating if already cancelled."""
        with self._lock:
            self._process = process
            if self.cancelled.is_set():
                self._terminate(process)

    @staticmethod
    def _terminate(process) -> None:
        try:
            if process is not None and process.poll() is None:
                process.terminate()
        except (OSError, ProcessLookupError):
            pass

    def cancel(self) -> bool:
        """Cancel before promotion; return false when the final file is already committed."""
        with self._lock:
            if self._promoted:
                return False
            self.cancelled.set()
            self._terminate(self._process)
            return True

    def stop_process(self) -> None:
        with self._lock:
            self._terminate(self._process)

    def promote(self, stage: Path, destination: Path, on_publishing=None) -> None:
        """Atomically publish a validated stage unless cancellation won the race."""
        with self._lock:
            self.check()
            if on_publishing is not None:on_publishing()
            os.replace(stage, destination)
            self._promoted = True


class ExportJobRegistry:
    """Small, thread-safe registry scoped to one Studio window."""

    MAX_JOBS = 8

    def __init__(self):
        self._lock = threading.RLock()
        self._jobs: dict[str, ExportJob] = {}

    def register(self, job_id: str) -> ExportJob:
        if not isinstance(job_id, str) or not job_id or len(job_id) > 128:
            raise ValueError("Invalid PDF export job id")
        with self._lock:
            if job_id in self._jobs:
                raise ValueError("PDF export job id is already in use")
            if len(self._jobs) >= self.MAX_JOBS:
                raise ValueError("Too many PDF exports are already running")
            job = ExportJob(job_id)
            self._jobs[job_id] = job
            return job

    def cancel(self, job_id: str) -> bool:
        with self._lock:
            job = self._jobs.get(job_id)
        return job.cancel() if job is not None else False

    def discard(self, job_id: str, job: ExportJob) -> None:
        with self._lock:
            if self._jobs.get(job_id) is job:
                del self._jobs[job_id]

    def cancel_all(self) -> None:
        with self._lock:
            jobs = tuple(self._jobs.values())
        for job in jobs:
            job.cancel()
