package dev.supermd.studio

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LatestRecoveryWriterTest {
    @Test fun latestSlotAndRevisionGuardPreventStaleCommitAfterNewerSchedule() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val startedOldWrite = CompletableDeferred<Unit>()
        val releaseOldWrite = CompletableDeferred<Unit>()
        val committed = mutableListOf<String>()
        val writer = LatestRecoveryWriter<String, String>(
            scope = scope,
            debounceMillis = 0,
            signature = { it },
            write = { value, commit ->
                if (value == "old") {
                    startedOldWrite.complete(Unit)
                    releaseOldWrite.await()
                }
                commit { committed += value }
            },
        )
        try {
            writer.schedule("old")
            startedOldWrite.await()
            assertEquals(2L, writer.schedule("pending-1"))
            assertEquals(3L, writer.schedule("latest"))
            assertTrue(writer.pendingReferenceCount() <= 1)

            val durable = async { writer.flushAndAwait("latest") }
            delay(10)
            releaseOldWrite.complete(Unit)

            assertTrue(durable.await())
            assertFalse(committed.contains("old"))
            assertEquals("latest", committed.last())
        } finally {
            releaseOldWrite.complete(Unit)
            writer.closeAfterLatest("latest").join()
            scope.cancel()
        }
    }

    @Test fun unchangedRecoverySignatureSkipsThemeOnlyChangesButFlushForcesLatest() = runBlocking {
        data class Snapshot(val tabs: List<String>, val active: String, val mode: String, val theme: String)
        class Signature(val tabs: List<String>, val active: String, val mode: String) {
            override fun equals(other: Any?) = other is Signature && tabs === other.tabs && active == other.active && mode == other.mode
            override fun hashCode() = 31 * System.identityHashCode(tabs) + active.hashCode() + mode.hashCode()
        }
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val writes = mutableListOf<Snapshot>()
        val tabs = listOf("large note state")
        val writer = LatestRecoveryWriter<Snapshot, Signature>(
            scope, 60_000,
            signature = { Signature(it.tabs, it.active, it.mode) },
            write = { value, commit -> commit { writes += value } },
        )
        try {
            val first = Snapshot(tabs, "active", "reader", "dark")
            val themeOnly = first.copy(theme = "light")
            assertEquals(1L, writer.schedule(first))
            assertEquals(1L, writer.schedule(themeOnly))
            assertEquals(1L, writer.latestScheduledRevision())

            assertTrue(writer.flushAndAwait(themeOnly))
            assertEquals(themeOnly, writes.single())
        } finally {
            writer.closeAfterLatest(Snapshot(tabs, "active", "reader", "light")).join()
            scope.cancel()
        }
    }

    @Test fun failedSnapshotPreservesFailureForAwaiterAndNewerSnapshotCanCommit() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val writes = mutableListOf<String>()
        var errors = 0
        val writer = LatestRecoveryWriter<String, String>(
            scope, 0, { it },
            write = { value, commit ->
                if (value == "bad") error("private path must not be shown")
                commit { writes += value }
            },
            onFailure = { errors++ },
        )
        try {
            assertFalse(writer.flushAndAwait("bad"))
            assertEquals(1, errors)
            assertTrue(writer.flushAndAwait("good"))
            assertEquals(listOf("good"), writes)
        } finally {
            writer.closeAfterLatest("good").join()
            scope.cancel()
        }
    }

    @Test fun sameRecoveryStateCanBeScheduledAgainAfterItsWriteFails() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        var attempts = 0
        val writes = mutableListOf<String>()
        val writer = LatestRecoveryWriter<String, String>(
            scope, 0, { it },
            write = { value, commit ->
                attempts++
                if (attempts == 1) error("temporary storage failure")
                commit { writes += value }
            },
        )
        try {
            assertFalse(writer.flushAndAwait("same-state"))
            assertEquals(2L, writer.schedule("same-state"))
            assertTrue(writer.flushAndAwait("same-state"))
            assertEquals("same-state", writes.last())
        } finally {
            writer.closeAfterLatest("same-state").join()
            scope.cancel()
        }
    }

    @Test fun closingWriterForcesLatestStateAndExitsActor() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val writes = mutableListOf<String>()
        val writer = LatestRecoveryWriter<String, String>(
            scope, 60_000, { it },
            write = { value, commit -> commit { writes += value } },
        )
        writer.schedule("obsolete")
        val actor = writer.closeAfterLatest("final")
        actor.join()
        assertTrue(actor.isCompleted)
        assertEquals("final", writes.last())
        assertNull(writer.schedule("after-close"))
        scope.cancel()
    }

    @Test fun debounceCoalescesAQueuedBurstToTheLatestSnapshot() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val writes = mutableListOf<String>()
        val writer = LatestRecoveryWriter<String, String>(
            scope, 100, { it },
            write = { value, commit -> commit { writes += value } },
        )
        try {
            writer.schedule("first")
            writer.schedule("latest")
            assertTrue(writer.flushAndAwait("latest"))
            assertEquals(listOf("latest"), writes)
        } finally {
            writer.closeAfterLatest("latest").join()
            scope.cancel()
        }
    }

    @Test fun recoverySignatureUsesListIdentityAndOnlySerializedScalars() {
        val tabs = listOf(Note(name = "large", content = "body"))
        val closed = emptyList<Note>()
        val base = RecoverySnapshotSignature(tabs, closed, "id", "reader", 100f, 120f)
        val sameSerializedFields = RecoverySnapshotSignature(tabs, closed, "id", "reader", 100f, 120f)
        val newListButEqualContent = RecoverySnapshotSignature(ArrayList(tabs), closed, "id", "reader", 100f, 120f)
        val scalarChanged = RecoverySnapshotSignature(tabs, closed, "id", "editor", 100f, 120f)

        assertEquals(base, sameSerializedFields)
        assertFalse(base == newListButEqualContent)
        assertFalse(base == scalarChanged)
    }

    @Test fun flushAndAwaitExactDistinguishesCommittedSupersededAndFailedRevisions() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val inFlightStarted = CompletableDeferred<Unit>()
        val releaseInFlight = CompletableDeferred<Unit>()
        val midWriteStarted = CompletableDeferred<Unit>()
        val releaseMidWrite = CompletableDeferred<Unit>()
        val committed = mutableListOf<String>()
        val writer = LatestRecoveryWriter<String, String>(
            scope = scope,
            debounceMillis = 0,
            signature = { it },
            write = { value, commit ->
                when (value) {
                    "in-flight" -> {
                        inFlightStarted.complete(Unit)
                        releaseInFlight.await()
                    }
                    "staged-mid-write" -> {
                        midWriteStarted.complete(Unit)
                        releaseMidWrite.await()
                    }
                    "staged-fail" -> error("disk write error")
                }
                commit { committed += value }
            },
        )
        try {
            // 1. Coalesced in pending while an earlier write is in flight -> SUPERSEDED
            writer.schedule("in-flight")
            inFlightStarted.await()
            val coalescedExact = async { writer.flushAndAwaitExact("staged-coalesced") }
            while (writer.latestScheduledRevision() < 2L) delay(5)
            val baselineFlush = writer.flush("baseline-1")
            releaseInFlight.complete(Unit)
            baselineFlush?.join()

            val coalescedOutcome = coalescedExact.await()
            assertEquals(LatestRecoveryWriter.ExactFlushResult.SUPERSEDED, coalescedOutcome.result)
            assertFalse("Coalesced staged snapshot never committed", committed.contains("staged-coalesced"))
            assertEquals("baseline-1", committed.last())

            // 2. Superseded mid-write before commitIfLatest -> SUPERSEDED
            val midWriteExact = async { writer.flushAndAwaitExact("staged-mid-write") }
            midWriteStarted.await()
            val baselineFlush2 = writer.flush("baseline-2")
            releaseMidWrite.complete(Unit)
            baselineFlush2?.join()

            val midWriteOutcome = midWriteExact.await()
            assertEquals(LatestRecoveryWriter.ExactFlushResult.SUPERSEDED, midWriteOutcome.result)
            assertFalse("Mid-write superseded snapshot must not commit", committed.contains("staged-mid-write"))
            assertEquals("baseline-2", committed.last())

            // 3. Uncontested staged snapshot -> COMMITTED with matching committedRevision
            val committedOutcome = writer.flushAndAwaitExact("staged-committed")
            assertEquals(LatestRecoveryWriter.ExactFlushResult.COMMITTED, committedOutcome.result)
            assertEquals(committedOutcome.revision, writer.committedRevision())
            assertEquals("staged-committed", committed.last())

            // 4. Failed write reports FAILED
            val failedOutcome = writer.flushAndAwaitExact("staged-fail")
            assertEquals(LatestRecoveryWriter.ExactFlushResult.FAILED, failedOutcome.result)
            assertEquals("staged-committed", committed.last())

            // 5. flushAndAwaitExact bypasses debounceMillis (60s debounce completes immediately)
            val debouncedCommitted = mutableListOf<String>()
            val debouncedWriter = LatestRecoveryWriter<String, String>(
                scope = scope,
                debounceMillis = 60_000,
                signature = { it },
                write = { value, commit -> commit { debouncedCommitted += value } },
            )
            try {
                val startedAt = System.nanoTime()
                val immediateOutcome = debouncedWriter.flushAndAwaitExact("bypass-debounce")
                val elapsedMillis = (System.nanoTime() - startedAt) / 1_000_000.0
                assertEquals(LatestRecoveryWriter.ExactFlushResult.COMMITTED, immediateOutcome.result)
                assertEquals(listOf("bypass-debounce"), debouncedCommitted)
                assertTrue("flushAndAwaitExact must bypass 60s debounce (took ${elapsedMillis}ms)", elapsedMillis < 5_000.0)
            } finally {
                debouncedWriter.closeAfterLatest("bypass-debounce").join()
            }
        } finally {
            releaseInFlight.complete(Unit)
            releaseMidWrite.complete(Unit)
            writer.closeAfterLatest("final").join()
            scope.cancel()
        }
    }
}
