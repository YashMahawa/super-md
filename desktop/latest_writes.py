"""A serial writer with bounded, keyed latest-value side jobs.

Ordinary ``submit`` work is forwarded unchanged and is never coalesced. Jobs
submitted with ``submit_latest`` occupy one replaceable slot per key and are
drained on the same worker, yielding back to the executor queue between batches.
"""
from __future__ import annotations

import concurrent.futures
import threading
from collections.abc import Callable


class LatestWriteExecutor:
    LATEST_KEYS = frozenset(("startup", "recovery"))

    def __init__(self, *, max_workers=1, thread_name_prefix="supermd-save"):
        if max_workers != 1:
            raise ValueError("LatestWriteExecutor requires one ordered worker")
        self._executor = concurrent.futures.ThreadPoolExecutor(
            max_workers=1, thread_name_prefix=thread_name_prefix
        )
        self._condition = threading.Condition()
        self._pending: dict[str, tuple[Callable, Callable | None]] = {}
        self._scheduled = False
        self._shutdown = False
        self._worker_ids: set[int] = set()

    def submit(self, fn, /, *args, **kwargs):
        """Submit an ordinary FIFO job and preserve Future/result semantics."""
        with self._condition:
            if self._shutdown:
                raise RuntimeError("cannot schedule new futures after shutdown")
            return self._executor.submit(self._tracked, fn, args, kwargs)

    def submit_latest(self, key: str, action: Callable, on_done: Callable | None = None) -> None:
        """Replace the pending action for key, retaining at most one per key."""
        if key not in self.LATEST_KEYS or not callable(action):
            raise ValueError("Latest writes are limited to startup and recovery snapshots")
        with self._condition:
            if self._shutdown:
                raise RuntimeError("cannot schedule new futures after shutdown")
            self._pending[key] = (action, on_done)
            if not self._scheduled:
                self._schedule_locked()

    def _schedule_locked(self):
        self._scheduled = True
        try:
            self._executor.submit(self._drain)
        except RuntimeError:
            # This is only expected if the underlying executor was shut down
            # outside this wrapper. Keep latest state intact for shutdown's
            # inline fallback rather than silently discarding it.
            self._scheduled = False
            self._condition.notify_all()
            raise

    def _tracked(self, fn, args, kwargs):
        self._worker_ids.add(threading.get_ident())
        return fn(*args, **kwargs)

    def _drain(self):
        self._worker_ids.add(threading.get_ident())
        while True:
            with self._condition:
                batch = self._pending
                self._pending = {}
                if not batch:
                    self._scheduled = False
                    self._condition.notify_all()
                    return

            for key, (action, on_done) in batch.items():
                error = None
                try:
                    action()
                except Exception as failure:
                    error = failure
                if on_done is not None:
                    try:
                        on_done(error)
                    except Exception:
                        # The writer's job is durable I/O; a notification
                        # callback must not strand the remaining latest slots.
                        pass

            with self._condition:
                if self._pending:
                    try:
                        # Submit a new drain at the tail. Ordinary file saves
                        # already in the executor queue retain FIFO priority.
                        self._executor.submit(self._drain)
                        return
                    except RuntimeError:
                        # If an external executor shutdown races this active
                        # drain, continue inline so already-owned latest values
                        # are not lost. Normal wrapper shutdown waits for the
                        # drain before closing the underlying executor.
                        continue
                self._scheduled = False
                self._condition.notify_all()
                return

    @property
    def pending_count(self):
        """Number of pending keyed actions (useful for diagnostics/tests)."""
        with self._condition:
            return len(self._pending)

    def shutdown(self, wait=True, *, cancel_futures=False):
        """Flush latest slots, then close the serial executor.

        Actual queued jobs are never canceled. A worker-thread shutdown cannot
        synchronously wait for itself; it closes non-blockingly and the already
        queued drain flushes latest state after earlier FIFO jobs.
        """
        worker_call = threading.get_ident() in self._worker_ids
        with self._condition:
            self._shutdown = True
            if self._pending and not self._scheduled:
                try:
                    self._schedule_locked()
                except RuntimeError:
                    # The worker-thread case below can drain inline; otherwise
                    # preserve latest work and let the caller observe failure.
                    if not worker_call:
                        raise
            if wait and not worker_call:
                while self._scheduled or self._pending:
                    self._condition.wait()

        self._executor.shutdown(wait=wait and not worker_call, cancel_futures=False)
