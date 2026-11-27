package dev.supermd.studio

import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ReaderFlushBarrierTest {
    @Test fun onlyExactTokenNoteAndNativeContentCompleteSuccessfully() = runBlocking {
        val barrier = ReaderFlushBarrier()
        val request = barrier.register("token-1", "note-1")

        assertFalse(barrier.complete("stale-token", "note-1", "latest", "latest", null))
        assertEquals(1, barrier.size())
        assertFalse(barrier.complete("token-1", "wrong-note", "latest", "latest", null))
        assertFalse(request.result.await())
        assertEquals(0, barrier.size())

        val contentMismatch = barrier.register("token-2", "note-1")
        assertFalse(barrier.complete("token-2", "note-1", "stale", "native", null))
        assertFalse(contentMismatch.result.await())

        val failed = barrier.register("token-3", "note-1")
        assertFalse(barrier.complete("token-3", "note-1", null, "native", "reader flush failed"))
        assertFalse(failed.result.await())

        val accepted = barrier.register("token-4", "note-1")
        assertTrue(barrier.complete("token-4", "note-1", "native", "native", null))
        assertTrue(accepted.result.await())
    }

    @Test fun retirementFailsAllPendingWaitersAndUnknownLateRepliesStayIgnored() = runBlocking {
        val barrier = ReaderFlushBarrier()
        val first = barrier.register("one", "note-1")
        val second = barrier.register("two", "note-2")

        barrier.failAll()

        assertFalse(first.result.await())
        assertFalse(second.result.await())
        assertEquals(0, barrier.size())
        assertFalse(barrier.complete("one", "note-1", "content", "content", null))
    }

    @Test fun cancellationRemovesOnlyItsOwnPendingRequest() = runBlocking {
        val barrier = ReaderFlushBarrier()
        val request = barrier.register("same", "note-1")
        val replacement = barrier.register("other", "note-1")

        barrier.cancel(request.token, request)

        assertFalse(request.result.await())
        assertEquals(1, barrier.size())
        assertTrue(barrier.complete("other", "note-1", "content", "content", null))
        assertTrue(replacement.result.await())
    }

    @Test fun timeoutCancellationMakesLateAcknowledgementHarmless() = runBlocking {
        val barrier = ReaderFlushBarrier()
        val request = barrier.register("timeout-token", "note-1")

        assertNull(withTimeoutOrNull(1) { request.result.await() })
        barrier.cancel(request.token, request)

        assertEquals(0, barrier.size())
        assertFalse(barrier.complete("timeout-token", "note-1", "native", "native", null))
        assertFalse(request.result.await())
    }

    @Test fun flushStatusDistinguishesActiveNoteHandoffFromGenuineFailures() = runBlocking {
        val barrier = ReaderFlushBarrier()

        val preLoad = barrier.register("pre-load", "note-2")
        assertFalse(barrier.complete("pre-load", "", null, null, "Reader has not loaded a note yet"))
        assertFalse(preLoad.result.await())
        assertEquals(ReaderFlushStatus.WRONG_ACTIVE_NOTE, preLoad.status.await())

        val previousNote = barrier.register("handoff", "note-2")
        assertFalse(barrier.complete("handoff", "note-1", null, null, "The active note changed before its edit flush"))
        assertFalse(previousNote.result.await())
        assertEquals(ReaderFlushStatus.WRONG_ACTIVE_NOTE, previousNote.status.await())

        val malformed = barrier.register("malformed", "note-2")
        assertFalse(barrier.complete("malformed", "note-1", null, null, "Malformed flush acknowledgement", wellFormed = false))
        assertFalse(malformed.result.await())
        assertEquals(ReaderFlushStatus.FAILED, malformed.status.await())

        val sameNoteError = barrier.register("same-note-error", "note-2")
        assertFalse(barrier.complete("same-note-error", "note-2", null, "native", "Reader has unacknowledged edits for this note"))
        assertFalse(sameNoteError.result.await())
        assertEquals(ReaderFlushStatus.FAILED, sameNoteError.status.await())

        val contentMismatch = barrier.register("mismatch", "note-2")
        assertFalse(barrier.complete("mismatch", "note-2", "reader-text", "native-text", null))
        assertFalse(contentMismatch.result.await())
        assertEquals(ReaderFlushStatus.FAILED, contentMismatch.status.await())

        val cancelled = barrier.register("cancelled", "note-2")
        barrier.cancel(cancelled.token, cancelled)
        assertFalse(cancelled.result.await())
        assertEquals(ReaderFlushStatus.FAILED, cancelled.status.await())

        val acknowledged = barrier.register("ok", "note-2")
        assertTrue(barrier.complete("ok", "note-2", "exact", "exact", null))
        assertTrue(acknowledged.result.await())
        assertEquals(ReaderFlushStatus.ACKNOWLEDGED, acknowledged.status.await())
    }
}
