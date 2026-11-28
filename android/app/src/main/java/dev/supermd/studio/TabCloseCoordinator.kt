package dev.supermd.studio

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.withContext

internal class TabCloseCoordinator(
    private val scope: CoroutineScope,
    private val media: MediaStorage,
    private val openRequests: OpenRequestGate,
    private val closedNoteMutex: Mutex,
    private val documentWrites: Mutex,
    private val closedNoteStore: ClosedNoteStore,
    private val closingNoteIds: MutableSet<String>,
    internal val readClosedNoteRefs: () -> List<ClosedNoteReference>,
    private val writeClosedNoteRefs: (List<ClosedNoteReference>) -> Unit,
    private val setCloseAfterSaveNoteId: (String?) -> Unit,
    private val saveClosedNoteIndex: (List<ClosedNoteReference>) -> Unit,
    private val readState: () -> StudioState,
    private val writeState: (StudioState) -> Unit,
    private val change: ((StudioState) -> StudioState) -> Unit,
    private val performCurrentReaderBarrier: suspend ((String) -> Unit) -> Boolean,
    private val readerBarrierFailed: () -> Unit,
    private val awaitReaderSnapshot: suspend (String) -> Boolean,
    private val saveManual: (String) -> Unit,
    private val removeReaderEcho: (String) -> Unit,
    private val clearReaderEditProtocol: (String) -> Unit,
    private val removeAutosavePending: (String) -> Unit,
    private val removeSavedPortableAssets: (String) -> Unit,
) {
    fun requestClose(id: String) {
        openRequests.invalidate()
        scope.launch { executeClose(id, confirmIfRequired = true) }
    }

    fun dismissCloseConfirmation() {
        setCloseAfterSaveNoteId(null)
        writeState(readState().copy(pendingCloseNoteId = null))
    }

    fun resolveCloseConfirmation(choice: String) {
        val id = readState().pendingCloseNoteId ?: return
        writeState(readState().copy(pendingCloseNoteId = null))
        when (choice) {
            "discard" -> {
                setCloseAfterSaveNoteId(null)
                close(id, discardChanges = true)
            }
            "save" -> {
                setCloseAfterSaveNoteId(id)
                saveManual(id)
            }
            else -> setCloseAfterSaveNoteId(null)
        }
    }

    private fun isDiscardableEmptyTab(note: Note): Boolean =
        note.uri == null && note.content.isBlank() && (
            note.assetDirectory == null ||
                (!note.assetsDirty && runCatching { media.portableAssets(note.assetDirectory).length() == 0 }.getOrDefault(false))
        )

    private fun discardEmptyTab(id: String) {
        removeReaderEcho(id)
        clearReaderEditProtocol(id)
        removeAutosavePending(id)
        removeSavedPortableAssets(id)
        change { state ->
            val remaining = state.tabs.filterNot { it.id == id }
            val next = remaining.ifEmpty { listOf(Note()) }
            state.copy(
                tabs = next,
                activeId = if (state.active.id == id) next.first().id else state.activeId,
                conflictedTabIds = state.conflictedTabIds - id,
                pendingCloseNoteId = state.pendingCloseNoteId?.takeUnless { it == id },
                pendingSaveConflictNoteId = state.pendingSaveConflictNoteId?.takeUnless { it == id },
                message = "Empty tab discarded",
            )
        }
    }

    fun close(
        id: String,
        expectedRevision: String? = null,
        refuseDirty: Boolean = false,
        discardChanges: Boolean = false,
        onComplete: ((String?) -> Unit)? = null,
    ) {
        openRequests.invalidate()
        scope.launch {
            executeClose(
                id = id,
                expectedRevision = expectedRevision,
                refuseDirty = refuseDirty,
                discardChanges = discardChanges,
                confirmIfRequired = false,
                onComplete = onComplete,
            )
        }
    }

    private suspend fun executeClose(
        id: String,
        expectedRevision: String? = null,
        refuseDirty: Boolean = false,
        discardChanges: Boolean = false,
        confirmIfRequired: Boolean = false,
        onComplete: ((String?) -> Unit)? = null,
    ) {
        var previousActiveId = ""
        var requestedConfirmation = false
        var preserve = false
        var revisionError: String? = null
        var closeError: String? = null
        val accepted = performCurrentReaderBarrier { currentActiveId ->
            previousActiveId = currentActiveId
            val note = readState().tabs.find { it.id == id } ?: return@performCurrentReaderBarrier
            if (confirmIfRequired && note.requiresCloseConfirmation) {
                change { state -> state.copy(activeId = if (state.tabs.any { it.id == id }) id else state.activeId, pendingCloseNoteId = id) }
                requestedConfirmation = true
                return@performCurrentReaderBarrier
            }
            if (expectedRevision != null && !agentContentRevision(note.content).equals(expectedRevision, ignoreCase = true)) {
                revisionError = "Revision conflict: the note changed since the supplied revision; it remains open"
                return@performCurrentReaderBarrier
            }
            if (refuseDirty && note.dirty && !discardChanges) {
                closeError = "The note has unsaved changes. Set options.discardChanges=true to close it; Android will retain its recovery copy."
                return@performCurrentReaderBarrier
            }
            if (!closingNoteIds.add(id)) return@performCurrentReaderBarrier
            if (isDiscardableEmptyTab(note)) {
                discardEmptyTab(id)
                closingNoteIds.remove(id)
            } else preserve = true
        }
        if (!accepted) {
            readerBarrierFailed()
            onComplete?.invoke("The note draft could not be synchronized before closing")
            return
        }
        if (requestedConfirmation) {
            onComplete?.invoke(null)
            return
        }
        if (revisionError != null) { onComplete?.invoke(revisionError); return }
        if (closeError != null) { onComplete?.invoke(closeError); return }
        if (preserve) closeAfterReaderBarrier(id)
        val afterClose = readState()
        if (afterClose.tabs.any { it.id == id }) {
            onComplete?.invoke("The note could not be closed; it remains open")
            return
        }
        if (afterClose.active.id != previousActiveId && !awaitReaderSnapshot(afterClose.active.id)) {
            val message = "The note was closed and preserved, but the active reader is still loading; refresh the tabs before the next action."
            writeState(readState().copy(message = message))
            onComplete?.invoke(message)
            return
        }
        onComplete?.invoke(null)
    }

    suspend fun closeAfterReaderBarrier(id: String) {
        var locked = false
        var documentLocked = false
        try {
            closedNoteMutex.lock(); locked = true
            // Serialize the latest acknowledged snapshot with manual/automatic
            // document writes. The reader barrier completed before this lock.
            documentWrites.lock(); documentLocked = true
            val noteToClose = readState().tabs.find { it.id == id } ?: return
            if (isDiscardableEmptyTab(noteToClose)) {
                discardEmptyTab(id)
                return
            }
            val reference = withContext(Dispatchers.IO) { closedNoteStore.save(noteToClose) }
            if (readState().tabs.find { it.id == id } != noteToClose) {
                writeState(readState().copy(message = "The note changed while it was closing. It remains open with the latest text."))
                return
            }
            val previousRefs = withContext(Dispatchers.IO) { closedNoteStore.loadIndexStrict() }
            val nextRefs = (listOf(reference) + previousRefs.filterNot { it.id == id }).take(ClosedNoteStore.LIMIT)
            try {
                withContext(Dispatchers.IO) {
                    saveClosedNoteIndex(nextRefs)
                    writeClosedNoteRefs(nextRefs)
                }
            } catch (error: Exception) {
                withContext(NonCancellable + Dispatchers.IO) {
                    closedNoteStore.deleteUnindexedSnapshot(reference)
                }
                writeState(readState().copy(message = "Could not update closed-note recovery: ${error.message}"))
                return
            }
            if (readState().tabs.find { it.id == id } != noteToClose) {
                val rolledBack = withContext(NonCancellable + Dispatchers.IO) {
                    runCatching { saveClosedNoteIndex(previousRefs) }.isSuccess
                }
                if (rolledBack) {
                    writeClosedNoteRefs(previousRefs)
                    withContext(NonCancellable + Dispatchers.IO) {
                        closedNoteStore.deleteUnindexedSnapshot(reference)
                    }
                } else {
                    writeClosedNoteRefs(nextRefs)
                }
                writeState(readState().copy(message = "The note changed while it was closing. It remains open with the latest text."))
                return
            }
            removeReaderEcho(id)
            clearReaderEditProtocol(id)
            removeAutosavePending(id)
            change { state ->
                val remaining = state.tabs.filterNot { it.id == id }
                val next = remaining.ifEmpty { listOf(Note()) }
                state.copy(
                    tabs = next,
                    closedTabs = (listOf(reference.placeholder()) + state.closedTabs.filterNot { it.id == id }).take(ClosedNoteStore.LIMIT),
                    activeId = if (state.active.id == id) next.first().id else state.activeId,
                    conflictedTabIds = state.conflictedTabIds - id,
                    pendingCloseNoteId = state.pendingCloseNoteId?.takeUnless { it == id },
                    pendingSaveConflictNoteId = state.pendingSaveConflictNoteId?.takeUnless { it == id },
                    message = "Tab closed. Reopen from the menu to recover edits.",
                )
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Exception) {
            writeState(readState().copy(message = "Could not preserve the closed note: ${error.message}"))
        } finally {
            closingNoteIds.remove(id)
            if (documentLocked) documentWrites.unlock()
            if (locked) closedNoteMutex.unlock()
        }
    }
}
