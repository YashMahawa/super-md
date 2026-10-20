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
}
