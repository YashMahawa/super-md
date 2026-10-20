package dev.supermd.studio

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/**
 * A single-writer, latest-slot queue for full recovery snapshots. The writer
 * callback must perform its disk staging before using the supplied short,
 * revision-checked commit function for the atomic replacement.
 */
internal class LatestRecoveryWriter<T, K>(
    private val scope: CoroutineScope,
    private val debounceMillis: Long,
    private val signature: (T) -> K,
    private val write: suspend (T, commitIfLatest: (() -> Unit) -> Boolean) -> Unit,
    private val onFailure: (Throwable) -> Unit = {},
) {
    private data class Pending<T>(val revision: Long, val value: T, val immediate: Boolean)

    private val lock = Any()
    private val signals = Channel<Unit>(Channel.CONFLATED)
    private val waiters = LinkedHashMap<Long, MutableList<CompletableDeferred<Boolean>>>()
    private var pending: Pending<T>? = null
    private var latestRevision = 0L
    private var committedRevision = 0L
    private var failedRevision = 0L
    private var lastSignature: Any? = null
    private var hasSignature = false
    private var closed = false
    private var workerDone = false
    private val worker: Job = scope.launch(Dispatchers.IO) { runWorker() }

    init { require(debounceMillis >= 0) }

    /** Replaces any not-yet-written state, but skips recovery-irrelevant changes by signature. */
    fun schedule(value: T): Long? = submit(value, immediate = false, force = false)

    /** Requests an immediate snapshot and returns a handle that can await its durable outcome. */
    fun flush(value: T): Job? {
        val revision = submit(value, immediate = true, force = true) ?: return null
        return scope.launch { awaitRevision(revision) }
    }

    internal suspend fun flushAndAwait(value: T): Boolean {
        val revision = submit(value, immediate = true, force = true) ?: return false
        return awaitRevision(revision)
    }

    /** Enqueues the final state and makes the worker exit after it drains. */
    fun closeAfterLatest(value: T): Job {
        synchronized(lock) {
            if (!closed) {
                submitLocked(value, immediate = true)
                closed = true
                signals.trySend(Unit)
            }
        }
        return worker
    }

    internal fun pendingReferenceCount(): Int = synchronized(lock) { if (pending == null) 0 else 1 }
    internal fun latestScheduledRevision(): Long = synchronized(lock) { latestRevision }

    private fun submit(value: T, immediate: Boolean, force: Boolean): Long? = synchronized(lock) {
        if (closed) return@synchronized null
        val nextSignature = signature(value)
        val latestFailed = latestRevision > 0 && failedRevision >= latestRevision && committedRevision < latestRevision
        if (!force && hasSignature && lastSignature == nextSignature && !latestFailed) {
            return@synchronized latestRevision.takeIf { it > 0 }
        }
        submitLocked(value, immediate).also { lastSignature = nextSignature; hasSignature = true }
    }

    private fun submitLocked(value: T, immediate: Boolean): Long {
        val revision = ++latestRevision
        pending = Pending(revision, value, immediate)
        signals.trySend(Unit)
        return revision
    }

    private suspend fun awaitRevision(revision: Long): Boolean {
        val result = synchronized(lock) {
            if (committedRevision >= revision) return@synchronized CompletableDeferred(true).also { it.complete(true) }
            if ((failedRevision >= revision && latestRevision <= failedRevision) || workerDone) {
                return@synchronized CompletableDeferred(false).also { it.complete(false) }
            }
            CompletableDeferred<Boolean>().also { waiters.getOrPut(revision) { mutableListOf() }.add(it) }
        }
        return result.await()
    }

    private suspend fun runWorker() {
        try {
            while (true) {
                val observed = synchronized(lock) { pending }
                if (observed == null) {
                    if (synchronized(lock) { closed }) return
                    signals.receive()
                    continue
                }
                if (!observed.immediate && debounceMillis > 0) {
                    val changed = withTimeoutOrNull(debounceMillis) { signals.receive(); true } == true
                    if (changed) continue
                }
                val request = synchronized(lock) {
                    pending.also { pending = null }
                } ?: continue
                try {
                    write(request.value) { action -> commitIfLatest(request.revision, action) }
                } catch (error: Exception) {
                    val currentFailure = synchronized(lock) {
                        if (latestRevision == request.revision) failedRevision = maxOf(failedRevision, request.revision)
                        latestRevision == request.revision
                    }
                    if (currentFailure) {
                        runCatching { onFailure(error) }
                        failWaitersThrough(request.revision)
                    }
                }
            }
        } finally {
            signals.close()
            synchronized(lock) { workerDone = true }
            failAllWaiters()
        }
    }

    private fun commitIfLatest(revision: Long, action: () -> Unit): Boolean {
        val completed = mutableListOf<CompletableDeferred<Boolean>>()
        val committed = synchronized(lock) {
            if (latestRevision != revision) return@synchronized false
            action()
            committedRevision = revision
            val done = waiters.keys.filter { it <= revision }
            done.forEach { key -> completed += waiters.remove(key).orEmpty() }
            true
        }
        if (committed) completed.forEach { it.complete(true) }
        return committed
    }

    private fun failWaitersThrough(revision: Long) {
        val failed = mutableListOf<CompletableDeferred<Boolean>>()
        synchronized(lock) {
            val done = waiters.keys.filter { it <= revision }
            done.forEach { key -> failed += waiters.remove(key).orEmpty() }
        }
        failed.forEach { it.complete(false) }
    }

    private fun failAllWaiters() {
        val failed = synchronized(lock) {
            waiters.values.flatten().also { waiters.clear() }
        }
        failed.forEach { it.complete(false) }
    }
}

/** Shared IO owner; individual writer actors close after their final snapshot drains. */
internal object RecoveryWriterScope {
    val scope = CoroutineScope(kotlinx.coroutines.SupervisorJob() + Dispatchers.IO)
}

/** Fields serialized by NoteRecovery; list identity avoids walking full note bodies on unrelated UI updates. */
internal class RecoverySnapshotSignature(
    private val tabs: List<Note>,
    private val closedTabs: List<Note>,
    private val activeId: String,
    private val mode: String,
    private val normalZoom: Float,
    private val fullscreenZoom: Float,
) {
    override fun equals(other: Any?): Boolean = other is RecoverySnapshotSignature &&
        tabs === other.tabs && closedTabs === other.closedTabs && activeId == other.activeId &&
        mode == other.mode && normalZoom == other.normalZoom && fullscreenZoom == other.fullscreenZoom

    override fun hashCode(): Int {
        var result = System.identityHashCode(tabs)
        result = 31 * result + System.identityHashCode(closedTabs)
        result = 31 * result + activeId.hashCode()
        result = 31 * result + mode.hashCode()
        result = 31 * result + normalZoom.hashCode()
        result = 31 * result + fullscreenZoom.hashCode()
        return result
    }
}
