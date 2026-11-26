"""A serial writer with bounded, keyed latest-value side jobs.

Ordinary ``submit`` work is forwarded unchanged and is never coalesced. Jobs
submitted with ``submit_latest`` occupy one replaceable slot per key and are
drained on the same worker, yielding back to the executor queue between batches.
"""
from __future__ import annotations

import concurrent.futures
import threading
import time
from collections.abc import Callable


EXACT_COMMITTED = "committed"
EXACT_SUPERSEDED = "superseded"
EXACT_FAILED = "failed"


class LatestWriteExecutor:
    LATEST_KEYS = frozenset(("startup", "recovery"))

    def __init__(self, *, max_workers=1, thread_name_prefix="supermd-save"):
        if max_workers != 1:
            raise ValueError("LatestWriteExecutor requires one ordered worker")
        self._executor = concurrent.futures.ThreadPoolExecutor(
            max_workers=1, thread_name_prefix=thread_name_prefix
        )
        self._condition = threading.Condition()
        self._pending: dict[str, tuple[int, Callable, Callable | None, Callable | None]] = {}
        self._latest_revision: dict[str, int] = {}
        self._committed_revision: dict[str, int] = {}
        self._scheduled = False
        self._shutdown = False
        self._worker_ids: set[int] = set()

    def latest_revision(self, key: str) -> int:
        """Return the latest submitted revision number for ``key`` (0 if none)."""
        with self._condition:
            return self._latest_revision.get(key, 0)

    def committed_revision(self, key: str) -> int:
        """Return the latest durably committed revision number for ``key`` (0 if none)."""
        with self._condition:
            return self._committed_revision.get(key, 0)

    def submit(self, fn, /, *args, **kwargs):
        """Submit an ordinary FIFO job and preserve Future/result semantics."""
        with self._condition:
            if self._shutdown:
                raise RuntimeError("cannot schedule new futures after shutdown")
            return self._executor.submit(self._tracked, fn, args, kwargs)

    def _enqueue_latest(
        self,
        key: str,
        action: Callable,
        on_done: Callable | None,
        exact_done: Callable | None,
    ) -> int:
        if key not in self.LATEST_KEYS or not callable(action):
            raise ValueError("Latest writes are limited to startup and recovery snapshots")
        displaced = None
        with self._condition:
            if self._shutdown:
                raise RuntimeError("cannot schedule new futures after shutdown")
            rev = self._latest_revision.get(key, 0) + 1
            self._latest_revision[key] = rev
            displaced = self._pending.get(key)
            self._pending[key] = (rev, action, on_done, exact_done)
            if not self._scheduled:
                self._schedule_locked()
        if displaced is not None:
            prev_rev, _prev_action, _prev_on_done, prev_exact_done = displaced
            if prev_exact_done is not None:
                try:
                    prev_exact_done(EXACT_SUPERSEDED, prev_rev, None)
                except Exception:
                    pass
        return rev

    def submit_latest(self, key: str, action: Callable, on_done: Callable | None = None) -> int:
        """Replace the pending action for key, retaining at most one per key."""
        return self._enqueue_latest(key, action, on_done, None)

    def submit_latest_exact(
        self,
        key: str,
        action: Callable,
        on_done: Callable | None = None,
        exact_done: Callable | None = None,
    ) -> tuple[int, concurrent.futures.Future]:
        """Submit a keyed snapshot and track whether that exact revision committed.

        Resolves ``future`` (and optional ``exact_done``) with ``(status, rev, error)``
        where ``status`` is ``"committed"``, ``"superseded"``, or ``"failed"``.
        """
        outcome: concurrent.futures.Future = concurrent.futures.Future()

        def finish_exact(status: str, rev: int, error: BaseException | None) -> None:
            if not outcome.done():
                outcome.set_result((status, rev, error))
            if exact_done is not None:
                try:
                    exact_done(status, rev, error)
                except Exception:
                    pass

        rev = self._enqueue_latest(key, action, on_done, finish_exact)
        return rev, outcome

    def flush(self, timeout=3.0) -> None:
        """Wait for earlier FIFO work and all latest drains it leaves behind.

        A plain FIFO sentinel is not sufficient: an active latest drain may
        enqueue its continuation behind that sentinel. After the sentinel,
        wait for the owned drain state to become idle as well. Calls from the
        writer thread fail immediately because queued work cannot run until
        that thread returns.
        """
        if timeout is None or timeout < 0:
            raise ValueError("flush requires a non-negative bounded timeout")
        deadline = time.monotonic() + timeout
        with self._condition:
            if threading.get_ident() in self._worker_ids:
                raise RuntimeError("flush cannot wait from the writer worker thread")
            if self._shutdown:
                raise RuntimeError("cannot flush after writer shutdown")
            sentinel = self._executor.submit(self._tracked, lambda: None, (), {})

        remaining = max(0.0, deadline - time.monotonic())
        try:
            sentinel.result(timeout=remaining)
        except concurrent.futures.TimeoutError as failure:
            raise TimeoutError("timed out waiting for FIFO writer barrier") from failure

        with self._condition:
            while self._scheduled or self._pending:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError("timed out waiting for latest writer drains")
                self._condition.wait(remaining)

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

            for key, (rev, action, on_done, exact_done) in batch.items():
                if exact_done is not None:
                    with self._condition:
                        already_superseded = self._latest_revision.get(key, 0) != rev
                    if already_superseded:
                        try:
                            exact_done(EXACT_SUPERSEDED, rev, None)
                        except Exception:
                            pass
                        continue
                error = None
                try:
                    action()
                except Exception as failure:
                    error = failure
                with self._condition:
                    if error is not None:
                        status = EXACT_FAILED
                    elif self._latest_revision.get(key, 0) == rev:
                        self._committed_revision[key] = rev
                        status = EXACT_COMMITTED
                    else:
                        status = EXACT_SUPERSEDED
                if on_done is not None:
                    try:
                        on_done(error)
                    except Exception:
                        # The writer's job is durable I/O; a notification
                        # callback must not strand the remaining latest slots.
                        pass
                if exact_done is not None:
                    try:
                        exact_done(status, rev, error)
                    except Exception:
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
