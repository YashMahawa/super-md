import threading
import time
import unittest

from latest_writes import (
    EXACT_ABORTED,
    EXACT_COMMITTED,
    EXACT_FAILED,
    EXACT_SUPERSEDED,
    ExactWriteAborted,
    LatestWriteExecutor,
)


class LatestWriteExecutorTest(unittest.TestCase):
    def test_many_replacements_keep_only_two_latest_slots(self):
        writer = LatestWriteExecutor()
        started = threading.Event()
        release = threading.Event()
        written = []

        def block():
            started.set()
            release.wait(2)

        first = writer.submit(block)
        self.assertTrue(started.wait(1))
        for index in range(500):
            writer.submit_latest("startup", lambda value=index: written.append(("startup", value)))
            writer.submit_latest("recovery", lambda value=index: written.append(("recovery", value)))
        self.assertEqual(writer.pending_count, 2)

        release.set()
        writer.shutdown(wait=True)
        first.result(timeout=1)
        self.assertEqual(set(written), {("startup", 499), ("recovery", 499)})
        self.assertEqual(len(written), 2)

    def test_continuation_yields_to_actual_fifo_save(self):
        writer = LatestWriteExecutor()
        first_started = threading.Event()
        release_first = threading.Event()
        order = []

        def first_snapshot():
            order.append("first-snapshot")
            first_started.set()
            release_first.wait(2)

        writer.submit_latest("recovery", first_snapshot)
        self.assertTrue(first_started.wait(1))
        manual_save = writer.submit(lambda: order.append("manual-save"))
        writer.submit_latest("recovery", lambda: order.append("latest-snapshot"))
        release_first.set()

        manual_save.result(timeout=1)
        writer.shutdown(wait=True)
        self.assertEqual(order, ["first-snapshot", "manual-save", "latest-snapshot"])

    def test_flush_waits_for_drain_continuation_queued_after_fifo_sentinel(self):
        writer = LatestWriteExecutor()
        active_started = threading.Event()
        release_active = threading.Event()
        pending_finished = threading.Event()
        order = []
        pending_at_sentinel = []

        def active_snapshot():
            order.append("active")
            active_started.set()
            release_active.wait(2)

        writer.submit_latest("recovery", active_snapshot)
        self.assertTrue(active_started.wait(1))
        writer.submit_latest("startup", lambda: (order.append("pending"), pending_finished.set()))

        # Queue this FIFO job while the first drain is blocked. The drain's
        # continuation will be placed behind it once the active job is freed.
        def run_sentinel():
            pending_at_sentinel.append(pending_finished.is_set())
            order.append("sentinel")

        sentinel = writer.submit(run_sentinel)
        release_active.set()
        sentinel.result(timeout=1)
        self.assertEqual(pending_at_sentinel, [False])

        writer.flush(timeout=1)
        self.assertTrue(pending_finished.is_set())
        self.assertEqual(order, ["active", "sentinel", "pending"])
        writer.shutdown(wait=True)

    def test_flush_from_writer_worker_fails_without_deadlocking(self):
        writer = LatestWriteExecutor()

        def flush_in_worker():
            with self.assertRaisesRegex(RuntimeError, "writer worker thread"):
                writer.flush(timeout=1)

        writer.submit(flush_in_worker).result(timeout=1)
        writer.flush(timeout=1)
        writer.shutdown(wait=True)

    def test_write_failure_is_reported_to_callback_without_rewriting_error(self):
        writer = LatestWriteExecutor()
        failures = []

        def fail():
            raise OSError("private/path/recovery.json")

        writer.submit_latest("recovery", fail, failures.append)
        writer.shutdown(wait=True)
        self.assertEqual(len(failures), 1)
        self.assertIsInstance(failures[0], OSError)
        self.assertIn("private/path", str(failures[0]))

    def test_shutdown_wait_flushes_pending_latest_after_earlier_jobs(self):
        writer = LatestWriteExecutor()
        started = threading.Event()
        release = threading.Event()
        finished_shutdown = threading.Event()
        values = []

        def block():
            started.set()
            release.wait(2)
            values.append("earlier-save")

        blocker = writer.submit(block)
        self.assertTrue(started.wait(1))
        writer.submit_latest("recovery", lambda: values.append("latest-recovery"))
        shutdown_thread = threading.Thread(target=lambda: (writer.shutdown(wait=True), finished_shutdown.set()))
        shutdown_thread.start()
        time.sleep(.02)
        self.assertFalse(finished_shutdown.is_set())
        release.set()
        shutdown_thread.join(timeout=2)
        self.assertFalse(shutdown_thread.is_alive())
        blocker.result(timeout=1)
        self.assertEqual(values, ["earlier-save", "latest-recovery"])

    def test_shutdown_called_from_worker_does_not_deadlock_or_drop_latest(self):
        writer = LatestWriteExecutor()
        written = []

        def shutdown_in_worker():
            writer.submit_latest("startup", lambda: written.append("startup"))
            writer.shutdown(wait=True)

        future = writer.submit(shutdown_in_worker)
        future.result(timeout=1)
        writer.shutdown(wait=True)
        self.assertEqual(written, ["startup"])

    def test_submit_latest_exact_reports_committed_superseded_and_failed(self):
        writer = LatestWriteExecutor()
        try:
            # 1. Undisturbed exact write reports committed and updates committed_revision
            rev1, fut1 = writer.submit_latest_exact("recovery", lambda: None)
            status1, done_rev1, err1 = fut1.result(timeout=1)
            self.assertEqual((status1, done_rev1, err1), (EXACT_COMMITTED, rev1, None))
            self.assertEqual(writer.committed_revision("recovery"), rev1)
            self.assertEqual(writer.latest_revision("recovery"), rev1)

            # 2. Pending exact write replaced before execution reports superseded
            block_started = threading.Event()
            release_block = threading.Event()
            blocker = writer.submit(lambda: (block_started.set(), release_block.wait(2)))
            self.assertTrue(block_started.wait(1))

            ran_displaced = []
            rev2, fut2 = writer.submit_latest_exact("recovery", lambda: ran_displaced.append(True))
            rev3, fut3 = writer.submit_latest_exact("recovery", lambda: None)
            self.assertEqual(fut2.result(timeout=1), (EXACT_SUPERSEDED, rev2, None))
            release_block.set()
            blocker.result(timeout=1)
            self.assertEqual(fut3.result(timeout=1), (EXACT_COMMITTED, rev3, None))
            self.assertEqual(ran_displaced, [])
            self.assertEqual(writer.committed_revision("recovery"), rev3)

            # 3. Exact write superseded mid-execution reports superseded while successor commits
            in_flight = threading.Event()
            allow_finish = threading.Event()

            def slow_recovery():
                in_flight.set()
                allow_finish.wait(2)

            rev4, fut4 = writer.submit_latest_exact("recovery", slow_recovery)
            self.assertTrue(in_flight.wait(1))
            rev5 = writer.submit_latest("recovery", lambda: None)
            allow_finish.set()
            self.assertEqual(fut4.result(timeout=1), (EXACT_SUPERSEDED, rev4, None))
            writer.flush(timeout=1)
            self.assertEqual(writer.committed_revision("recovery"), rev5)

            # 4. Failed exact write reports failed without advancing committed_revision
            def fail_recovery():
                raise OSError("disk full")

            rev6, fut6 = writer.submit_latest_exact("recovery", fail_recovery)
            status6, done_rev6, err6 = fut6.result(timeout=1)
            self.assertEqual((status6, done_rev6), (EXACT_FAILED, rev6))
            self.assertIsInstance(err6, OSError)
            self.assertEqual(writer.committed_revision("recovery"), rev5)

            # 5. Aborted exact write reports EXACT_ABORTED, skips on_done, and preserves committed_revision
            enqueued_revs = []
            done_calls = []

            def abort_recovery():
                raise ExactWriteAborted()

            rev7, fut7 = writer.submit_latest_exact(
                "recovery",
                abort_recovery,
                done_calls.append,
                on_enqueued=enqueued_revs.append,
            )
            self.assertEqual(enqueued_revs, [rev7])
            self.assertEqual(fut7.result(timeout=1), (EXACT_ABORTED, rev7, None))
            self.assertEqual(done_calls, [])
            self.assertEqual(writer.committed_revision("recovery"), rev5)
        finally:
            writer.shutdown(wait=True)


if __name__ == "__main__":
    unittest.main()
