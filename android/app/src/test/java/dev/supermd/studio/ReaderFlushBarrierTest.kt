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
}
