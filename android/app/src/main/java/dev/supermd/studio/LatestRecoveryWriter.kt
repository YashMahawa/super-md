package dev.supermd.studio

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
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
    internal enum class ExactFlushResult {
        COMMITTED,
        SUPERSEDED,
        FAILED,
    }

    internal data class ExactFlushOutcome(
        val revision: Long,
        val result: ExactFlushResult,
    )

    private data class Pending<T>(val revision: Long, val value: T, val immediate: Boolean)

    private val lock = Any()
    private val signals = Channel<Unit>(Channel.CONFLATED)
    private val waiters = LinkedHashMap<Long, MutableList<CompletableDeferred<Boolean>>>()
    private val exactWaiters = LinkedHashMap<Long, MutableList<CompletableDeferred<ExactFlushResult>>>()
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

    internal fun submitImmediate(value: T): Long? = submit(value, immediate = true, force = true)

    internal suspend fun awaitRevisionResult(revision: Long): Boolean = awaitRevision(revision)

    internal suspend fun flushAndAwait(value: T): Boolean {
        val revision = submit(value, immediate = true, force = true) ?: return false
        return awaitRevision(revision)
    }

    /**
     * Submits [value] for immediate write and awaits confirmation that this exact
     * submitted revision committed to disk rather than being coalesced or superseded.
     */
    internal suspend fun flushAndAwaitExact(value: T): ExactFlushOutcome {
        val deferred = CompletableDeferred<ExactFlushResult>()
        val superseded = mutableListOf<CompletableDeferred<ExactFlushResult>>()
        val revision = synchronized(lock) {
            if (closed || workerDone) return ExactFlushOutcome(0L, ExactFlushResult.FAILED)
            val rev = submitLocked(value, immediate = true, superseded = superseded)
            lastSignature = signature(value)
            hasSignature = true
            exactWaiters.getOrPut(rev) { mutableListOf() }.add(deferred)
            rev
        }
        superseded.forEach { it.complete(ExactFlushResult.SUPERSEDED) }
        return ExactFlushOutcome(revision, deferred.await())
    }

    /** Enqueues the final state and makes the worker exit after it drains. */
    fun closeAfterLatest(value: T): Job {
        val superseded = mutableListOf<CompletableDeferred<ExactFlushResult>>()
        synchronized(lock) {
            if (!closed) {
                submitLocked(value, immediate = true, superseded = superseded)
                closed = true
                signals.trySend(Unit)
            }
        }
        superseded.forEach { it.complete(ExactFlushResult.FAILED) }
        return worker
    }

    internal fun pendingReferenceCount(): Int = synchronized(lock) { if (pending == null) 0 else 1 }
    internal fun latestScheduledRevision(): Long = synchronized(lock) { latestRevision }
    internal fun committedRevision(): Long = synchronized(lock) { committedRevision }

    private fun submit(value: T, immediate: Boolean, force: Boolean): Long? {
        val superseded = mutableListOf<CompletableDeferred<ExactFlushResult>>()
        val revision = synchronized(lock) {
            if (closed) return@synchronized null
            val nextSignature = signature(value)
            val latestFailed = latestRevision > 0 && failedRevision >= latestRevision && committedRevision < latestRevision
            if (!force && hasSignature && lastSignature == nextSignature && !latestFailed) {
                return@synchronized latestRevision.takeIf { it > 0 }
            }
            submitLocked(value, immediate, superseded).also { lastSignature = nextSignature; hasSignature = true }
        }
        superseded.forEach { it.complete(ExactFlushResult.SUPERSEDED) }
        return revision
    }

    private fun submitLocked(
        value: T,
        immediate: Boolean,
        superseded: MutableList<CompletableDeferred<ExactFlushResult>>,
    ): Long {
        pending?.let { previous ->
            superseded += exactWaiters.remove(previous.revision).orEmpty()
        }
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
                var requestCommitted = false
                try {
                    write(request.value) { action ->
                        commitIfLatest(request.revision, action).also { if (it) requestCommitted = true }
                    }
                    if (!requestCommitted) {
                        var unfinishedExact: List<CompletableDeferred<ExactFlushResult>> = emptyList()
                        var status = ExactFlushResult.FAILED
                        synchronized(lock) {
                            unfinishedExact = exactWaiters.remove(request.revision).orEmpty()
                            if (latestRevision > request.revision && !closed) {
                                status = ExactFlushResult.SUPERSEDED
                            }
                        }
                        unfinishedExact.forEach { it.complete(status) }
                    }
                } catch (error: Exception) {
                    var exactFailed: List<CompletableDeferred<ExactFlushResult>> = emptyList()
                    val currentFailure = synchronized(lock) {
                        exactFailed = exactWaiters.remove(request.revision).orEmpty()
                        if (latestRevision == request.revision) failedRevision = maxOf(failedRevision, request.revision)
                        latestRevision == request.revision
                    }
                    exactFailed.forEach { it.complete(ExactFlushResult.FAILED) }
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
        val exactCompleted = mutableListOf<CompletableDeferred<ExactFlushResult>>()
        val committed = synchronized(lock) {
            if (latestRevision != revision) return@synchronized false
            action()
            committedRevision = revision
            val done = waiters.keys.filter { it <= revision }
            done.forEach { key -> completed += waiters.remove(key).orEmpty() }
            exactCompleted += exactWaiters.remove(revision).orEmpty()
            true
        }
        if (committed) {
            completed.forEach { it.complete(true) }
            exactCompleted.forEach { it.complete(ExactFlushResult.COMMITTED) }
        }
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
        var failedCoalesced: List<CompletableDeferred<Boolean>> = emptyList()
        var failedExact: List<CompletableDeferred<ExactFlushResult>> = emptyList()
        synchronized(lock) {
            failedCoalesced = waiters.values.flatten().also { waiters.clear() }
            failedExact = exactWaiters.values.flatten().also { exactWaiters.clear() }
        }
        failedCoalesced.forEach { it.complete(false) }
        failedExact.forEach { it.complete(ExactFlushResult.FAILED) }
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
    private val agentJumpTabId: String? = null,
) {
    override fun equals(other: Any?): Boolean = other is RecoverySnapshotSignature &&
        tabs === other.tabs && closedTabs === other.closedTabs && activeId == other.activeId &&
        mode == other.mode && normalZoom == other.normalZoom && fullscreenZoom == other.fullscreenZoom &&
        agentJumpTabId == other.agentJumpTabId

    override fun hashCode(): Int {
        var result = System.identityHashCode(tabs)
        result = 31 * result + System.identityHashCode(closedTabs)
        result = 31 * result + activeId.hashCode()
        result = 31 * result + mode.hashCode()
        result = 31 * result + normalZoom.hashCode()
        result = 31 * result + fullscreenZoom.hashCode()
        result = 31 * result + (agentJumpTabId?.hashCode() ?: 0)
        return result
    }
}
