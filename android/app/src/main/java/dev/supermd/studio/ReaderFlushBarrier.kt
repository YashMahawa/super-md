package dev.supermd.studio

import kotlinx.coroutines.CompletableDeferred
import java.util.concurrent.ConcurrentHashMap

/** Correlates native flush requests with acknowledgements from one reader bridge. */
internal class ReaderFlushBarrier {
    internal enum class Outcome {
        ACKNOWLEDGED,
        ACTIVE_NOTE_MISMATCH,
        FAILED,
    }

    internal data class Request(
        val token: String,
        val noteId: String,
        val result: CompletableDeferred<Boolean>,
        val outcome: CompletableDeferred<Outcome> = CompletableDeferred(),
    )
    private val pending = ConcurrentHashMap<String, Request>()

    fun register(token: String, noteId: String): Request {
        require(token.isNotBlank() && noteId.isNotBlank())
        val request = Request(token, noteId, CompletableDeferred())
        check(pending.putIfAbsent(token, request) == null) { "Duplicate reader flush token" }
        return request
    }

    /** Unknown/stale tokens are ignored; any known malformed or mismatched reply fails its waiter. */
    fun complete(
        token: String,
        noteId: String,
        content: String?,
        nativeContent: String?,
        error: String?,
        wellFormed: Boolean = true,
    ): Boolean {
        val request = pending.remove(token) ?: return false
        val outcome = when {
            !wellFormed -> Outcome.FAILED
            request.noteId != noteId -> Outcome.ACTIVE_NOTE_MISMATCH
            error == null && content != null && nativeContent != null && content == nativeContent -> Outcome.ACKNOWLEDGED
            else -> Outcome.FAILED
        }
        val accepted = outcome == Outcome.ACKNOWLEDGED
        request.outcome.complete(outcome)
        request.result.complete(accepted)
        return accepted
    }

    fun cancel(token: String, request: Request) {
        if (pending.remove(token, request)) {
            request.outcome.complete(Outcome.FAILED)
            request.result.complete(false)
        }
    }

    fun failAll() {
        val outstanding = pending.values.toList()
        pending.clear()
        outstanding.forEach {
            it.outcome.complete(Outcome.FAILED)
            it.result.complete(false)
        }
    }

    internal fun size(): Int = pending.size
}
