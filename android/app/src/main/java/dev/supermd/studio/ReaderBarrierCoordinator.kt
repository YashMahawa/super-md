package dev.supermd.studio

import android.net.Uri
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull

internal class ReaderBarrierCoordinator(
    private val readState: () -> StudioState,
    private val readInitialOpenIntentUri: () -> String?,
    private val writeInitialOpenIntentUri: (String?) -> Unit,
    private val requestExternalOpen: (Uri, Int, ExternalIntentCaller) -> Unit,
    private val requestDocumentAccess: (rawUri: String, existingNote: Note?, writing: Boolean, explicit: Boolean) -> Unit,
    private val fail: (String) -> Unit,
    private val readerActionMutex: Mutex,
    private val readFlushRequester: () -> (suspend (String) -> Boolean)?,
    private val readFlushStatusRequester: () -> (suspend (String) -> ReaderFlushStatus)?,
    private val readerStateIsNativeAuthoritative: (String) -> Boolean,
) {
    fun requestInitialExternalOpen(
        uri: Uri,
        intentFlags: Int,
        caller: ExternalIntentCaller = ExternalIntentCaller(),
    ) {
        val key = uri.toString()
        if (readInitialOpenIntentUri() == key) return
        writeInitialOpenIntentUri(key)
        requestExternalOpen(uri, intentFlags, caller)
    }

    fun handleExpiredExternalOpenGrant(uri: Uri, initial: Boolean) {
        if (initial) {
            val key = uri.toString()
            if (readInitialOpenIntentUri() == key) return
            writeInitialOpenIntentUri(key)
        }
        val rawUri = uri.toString()
        val existing = readState().tabs.firstOrNull { it.uri?.let { raw -> sameDocument(Uri.parse(raw), Uri.parse(rawUri)) } == true }
        requestDocumentAccess(rawUri, existing, false, true)
    }

    fun rejectExternalOpen(uri: Uri, reason: String, initial: Boolean) {
        if (initial) {
            val key = uri.toString()
            if (readInitialOpenIntentUri() == key) return
            writeInitialOpenIntentUri(key)
        }
        fail("Could not open note: $reason")
    }

    suspend fun flushActiveNoteLocked(expectedActiveId: String): Boolean {
        val initial = readState()
        if (initial.tabs.isEmpty() && expectedActiveId.isEmpty()) return true
        if (initial.active.id != expectedActiveId) return false
        val statusRequester = readFlushStatusRequester()
        if (statusRequester != null) {
            val status = try {
                statusRequester.invoke(expectedActiveId)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                ReaderFlushStatus.FAILED
            }
            return when (status) {
                ReaderFlushStatus.ACKNOWLEDGED -> readState().active.id == expectedActiveId
                ReaderFlushStatus.WRONG_ACTIVE_NOTE ->
                    // Compose delivers supermdLoad asynchronously after native switches
                    // activeId. When the live reader confirms a different note is still
                    // mounted (with no unacknowledged draft for expectedActiveId) and
                    // native remains authoritative for expectedActiveId, there are no
                    // pending reader edits on expectedActiveId to flush.
                    readState().active.id == expectedActiveId &&
                        readerStateIsNativeAuthoritative(expectedActiveId)
                ReaderFlushStatus.FAILED -> false
            }
        }
        // A missing bridge is not an implicit flush acknowledgement. Only
        // proceed when the native snapshot is already the last acknowledged
        // reader state (for example, before the reader has ever attached).
        val accepted = try {
            readFlushRequester()?.invoke(expectedActiveId)
                ?: readerStateIsNativeAuthoritative(expectedActiveId)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            false
        }
        return accepted && readState().active.id == expectedActiveId
    }

    suspend fun performReaderBarrier(expectedActiveId: String, action: () -> Unit): Boolean = readerActionMutex.withLock {
        if (!flushActiveNoteLocked(expectedActiveId)) return@withLock false
        action()
        true
    }

    suspend fun performCurrentReaderBarrier(action: (String) -> Unit): Boolean = readerActionMutex.withLock {
        val currentActiveId = readState().active.id
        if (!flushActiveNoteLocked(currentActiveId)) return@withLock false
        action(currentActiveId)
        true
    }

    /** Waits until the reader reflects an already-selected native tab. This is
     * a read/flush acknowledgement only; it never changes focus or retries a
     * document write. */
    suspend fun awaitReaderSnapshot(noteId: String, timeoutMillis: Long = 8_000): Boolean =
        withTimeoutOrNull(timeoutMillis) {
            while (true) {
                val current = readState()
                if (current.activeId != noteId || current.active.id != noteId) return@withTimeoutOrNull false
                val statusRequester = readFlushStatusRequester()
                if (statusRequester != null) {
                    val status = try {
                        statusRequester.invoke(noteId)
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (_: Exception) {
                        ReaderFlushStatus.FAILED
                    }
                    when (status) {
                        ReaderFlushStatus.ACKNOWLEDGED -> return@withTimeoutOrNull true
                        ReaderFlushStatus.FAILED -> return@withTimeoutOrNull false
                        ReaderFlushStatus.WRONG_ACTIVE_NOTE -> delay(40)
                    }
                } else {
                    val acknowledged = try {
                        readFlushRequester()?.invoke(noteId) ?: readerStateIsNativeAuthoritative(noteId)
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (_: Exception) {
                        false
                    }
                    if (acknowledged) return@withTimeoutOrNull true
                    delay(40)
                }
            }
            @Suppress("UNREACHABLE_CODE")
            false
        } == true
}
