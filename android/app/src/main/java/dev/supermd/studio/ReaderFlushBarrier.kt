package dev.supermd.studio

import kotlinx.coroutines.CompletableDeferred
import java.util.concurrent.ConcurrentHashMap

/** Outcome of an explicit native flush request against one live reader bridge. */
internal enum class ReaderFlushStatus {
    ACKNOWLEDGED,
    WRONG_ACTIVE_NOTE,
    FAILED,
}

/** Correlates native flush requests with acknowledgements from one reader bridge. */
internal class ReaderFlushBarrier {
    internal data class Request(
        val token: String,
        val noteId: String,
        val allowPendingNativeLoad: Boolean = false,
        val result: CompletableDeferred<Boolean>,
        val status: CompletableDeferred<ReaderFlushStatus> = CompletableDeferred(),
        @Volatile var dispatchedAtEnqueue: String? = null,
    )
    private val pending = ConcurrentHashMap<String, Request>()

    fun register(token: String, noteId: String, allowPendingNativeLoad: Boolean = false): Request {
        require(token.isNotBlank() && noteId.isNotBlank())
        val request = Request(token, noteId, allowPendingNativeLoad, CompletableDeferred())
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
    ): Boolean = complete(
        token = token,
        noteId = noteId,
        content = content,
        nativeContent = nativeContent,
        dispatchedContent = null,
        error = error,
        wellFormed = wellFormed,
    )

    fun complete(
        token: String,
        noteId: String,
        content: String?,
        nativeContent: String?,
        dispatchedContent: String?,
        error: String?,
        wellFormed: Boolean = true,
    ): Boolean {
        val request = pending.remove(token) ?: return false
        val matchesContent = nativeContent != null && (
            content == nativeContent ||
                (
                    request.allowPendingNativeLoad && (
                        (request.dispatchedAtEnqueue != null && content == request.dispatchedAtEnqueue) ||
                            (dispatchedContent != null && content == dispatchedContent)
                        )
                    )
            )
        val accepted = wellFormed && request.noteId == noteId && error == null && content != null && matchesContent
        val outcome = when {
            accepted -> ReaderFlushStatus.ACKNOWLEDGED
            wellFormed && noteId != request.noteId -> ReaderFlushStatus.WRONG_ACTIVE_NOTE
            else -> ReaderFlushStatus.FAILED
        }
        request.status.complete(outcome)
        request.result.complete(accepted)
        return accepted
    }

    fun cancel(token: String, request: Request) {
        if (pending.remove(token, request)) {
            request.status.complete(ReaderFlushStatus.FAILED)
            request.result.complete(false)
        }
    }

    fun failAll() {
        val outstanding = pending.values.toList()
        pending.clear()
        outstanding.forEach {
            it.status.complete(ReaderFlushStatus.FAILED)
            it.result.complete(false)
        }
    }

    internal fun size(): Int = pending.size
}
