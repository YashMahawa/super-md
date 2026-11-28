package dev.supermd.studio

import android.content.ContentResolver
import android.content.Context
import android.net.Uri
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONObject

internal class ReloadFromDiskCoordinator(
    private val context: Context,
    private val scope: CoroutineScope,
    private val resolver: ContentResolver,
    private val documentAccess: () -> DocumentAccess,
    private val media: MediaStorage,
    private val closedNoteStore: ClosedNoteStore,
    private val readerActionMutex: Mutex,
    private val closedNoteMutex: Mutex,
    private val documentWrites: Mutex,
    private val closingNoteIds: Set<String>,
    private val autosavePending: MutableSet<String>,
    private val readerEcho: MutableMap<String, String>,
    private val savedPortableAssets: MutableMap<String, JSONObject>,
    private val viewModelRetired: AtomicBoolean,
    private val readState: () -> StudioState,
    private val changeState: ((StudioState) -> StudioState) -> Unit,
    internal val readClosedNoteRefs: () -> List<ClosedNoteReference>,
    private val writeClosedNoteRefs: (List<ClosedNoteReference>) -> Unit,
    private val saveClosedNoteIndex: (List<ClosedNoteReference>) -> Unit,
    private val flushActiveNoteLocked: suspend (String) -> Boolean,
    private val flushRecoveryAndAwait: suspend () -> Boolean,
    private val readerBarrierFailed: () -> Unit,
    private val collectNativePortableAssets: (Note) -> JSONObject,
    private val cleanupPortableDirectories: suspend (Set<String>) -> Unit,
    private val invalidateNoteAssets: (String) -> Unit,
    private val clearReaderEditProtocol: (String) -> Unit,
    private val recordPortableBaseline: (String, String?) -> Unit,
    private val isDocumentAccessFailure: (Throwable) -> Boolean,
    private val requestDocumentAccess: (rawUri: String, existingNote: Note?, writing: Boolean, explicit: Boolean) -> Unit,
    private val fail: (String) -> Unit,
    private val readReloadAfterIndexCommitObserver: () -> (suspend () -> Unit)?,
) {
    private class ReloadArchiveFailedException(cause: Throwable) : Exception(cause.message, cause)

    private suspend fun reconcileUncommittedReloadArchive(
        savedSnapshotRef: ClosedNoteReference?,
        archivedReference: ClosedNoteReference?,
        previousRefs: List<ClosedNoteReference>?,
        nextRefs: List<ClosedNoteReference>?,
        cleanupDirs: MutableSet<String>,
        changedDuringReload: Boolean,
    ) {
        withContext(NonCancellable) {
            if (archivedReference != null && previousRefs != null && nextRefs != null) {
                val rolledBack = withContext(Dispatchers.IO) {
                    runCatching { saveClosedNoteIndex(previousRefs) }.isSuccess
                }
                if (rolledBack) {
                    writeClosedNoteRefs(previousRefs)
                    withContext(Dispatchers.IO) {
                        closedNoteStore.deleteUnindexedSnapshot(archivedReference)
                    }
                } else {
                    writeClosedNoteRefs(nextRefs)
                    archivedReference.assetDirectory?.let(cleanupDirs::remove)
                    if (!viewModelRetired.get()) {
                        changeState { state ->
                            state.copy(
                                closedTabs = (
                                    listOf(archivedReference.placeholder()) +
                                        state.closedTabs.filterNot { it.id == archivedReference.id }
                                    ).take(ClosedNoteStore.LIMIT),
                            )
                        }
                    }
                }
            } else if (savedSnapshotRef != null) {
                withContext(Dispatchers.IO) {
                    closedNoteStore.deleteUnindexedSnapshot(savedSnapshotRef)
                }
            }
            if (changedDuringReload && !viewModelRetired.get()) {
                changeState { state ->
                    state.copy(
                        message = "The note changed while reloading from disk. It remains open with the latest draft.",
                    )
                }
            }
            if (!viewModelRetired.get()) {
                flushRecoveryAndAwait()
            }
            cleanupPortableDirectories(cleanupDirs)
            cleanupDirs.clear()
        }
    }

    fun reloadFromDisk(id: String = readState().active.id): Job = scope.launch {
        if (readState().tabs.none { it.id == id && it.uri != null }) return@launch
        val barrierOk = readerActionMutex.withLock {
            val currentActiveId = readState().active.id
            if (id == currentActiveId) flushActiveNoteLocked(currentActiveId) else true
        }
        if (!barrierOk) {
            flushRecoveryAndAwait()
            readerBarrierFailed()
            return@launch
        }
        val cleanupDirs = ConcurrentHashMap.newKeySet<String>()
        val afterIndexCommitObserver = readReloadAfterIndexCommitObserver()
        try {
            closedNoteMutex.withLock {
                var snapshotNote: Note? = null
                var rawUri: String? = null
                var reloaded: Note? = null
                var savedSnapshotRef: ClosedNoteReference? = null
                var archivedReference: ClosedNoteReference? = null
                var previousRefs: List<ClosedNoteReference>? = null
                var nextRefs: List<ClosedNoteReference>? = null
                var indexCommitted = false
                var reloadCommitted = false
                try {
                    withContext(Dispatchers.IO) {
                        documentWrites.withLock {
                            currentCoroutineContext()[Job]?.let { if (!it.isActive) throw CancellationException() }
                            val note = readState().tabs.find { it.id == id } ?: return@withLock
                            if (id in closingNoteIds) return@withLock
                            val noteUri = note.uri ?: return@withLock
                            snapshotNote = note
                            rawUri = noteUri
                            val parsedUri = Uri.parse(noteUri)
                            val target = if (parsedUri.scheme.equals("content", ignoreCase = true)) {
                                documentAccess().resolve(parsedUri)
                            } else {
                                parsedUri
                            }
                            val loaded = ExternalDocumentEntryGuard.openVerifiedUserAuthorizedInputStream(
                                context = context,
                                resolver = resolver,
                                uri = target,
                                documentAccess = documentAccess(),
                                allowOwnShareNote = true,
                            ).use { stream ->
                                if (note.portable) {
                                    val opened = media.openFmd(stream)
                                    cleanupDirs.add(opened.directory)
                                    Note(
                                        id = note.id,
                                        name = note.name,
                                        uri = target.toString(),
                                        content = opened.markdown,
                                        saved = opened.markdown,
                                        relative = note.relative,
                                        assetDirectory = opened.directory,
                                        assetsDirty = false,
                                    )
                                } else {
                                    val text = readLimited(stream, 20_000_000).toString(Charsets.UTF_8).removePrefix("\uFEFF")
                                    Note(
                                        id = note.id,
                                        name = note.name,
                                        uri = target.toString(),
                                        content = text,
                                        saved = text,
                                        relative = note.relative,
                                        assetsDirty = false,
                                    )
                                }
                            }
                            reloaded = loaded

                            if (note.dirty) {
                                try {
                                    currentCoroutineContext()[Job]?.let { if (!it.isActive) throw CancellationException() }
                                    if (readState().tabs.find { it.id == id } != note || id in closingNoteIds) {
                                        return@withLock
                                    }
                                    val collectedAssets = if (note.portable || note.assetsDirty) collectNativePortableAssets(note) else JSONObject()
                                    val archivedAssetDir = if (!note.portable && collectedAssets.length() == 0) {
                                        null
                                    } else {
                                        media.materializePortableDirectory(
                                            assets = collectedAssets,
                                            reuseFromDirectory = note.assetDirectory,
                                        ).also { cleanupDirs.add(it) }
                                    }
                                    currentCoroutineContext()[Job]?.let { if (!it.isActive) throw CancellationException() }
                                    val archivedName = if (note.name.startsWith("Recovered ")) note.name else "Recovered ${note.name}"
                                    val archivedDraft = Note(
                                        id = UUID.randomUUID().toString(),
                                        name = archivedName,
                                        uri = null,
                                        content = note.content,
                                        saved = "",
                                        relative = note.relative,
                                        assetDirectory = archivedAssetDir,
                                        assetsDirty = archivedAssetDir != null || note.assetsDirty,
                                    )
                                    val ref = closedNoteStore.save(archivedDraft)
                                    savedSnapshotRef = ref
                                    currentCoroutineContext()[Job]?.let { if (!it.isActive) throw CancellationException() }
                                    if (readState().tabs.find { it.id == id } != note || id in closingNoteIds) {
                                        return@withLock
                                    }
                                    val prev = closedNoteStore.loadIndexStrict()
                                    val updated = (listOf(ref) + prev).take(ClosedNoteStore.LIMIT)
                                    saveClosedNoteIndex(updated)
                                    writeClosedNoteRefs(updated)
                                    archivedReference = ref
                                    previousRefs = prev
                                    nextRefs = updated
                                    indexCommitted = true
                                } catch (cancelled: CancellationException) {
                                    throw cancelled
                                } catch (archiveError: Exception) {
                                    throw ReloadArchiveFailedException(archiveError)
                                }
                            }
                        }
                        if (indexCommitted) {
                            afterIndexCommitObserver?.takeIf { readReloadAfterIndexCommitObserver() === it }?.invoke()
                        }
                    }

                    currentCoroutineContext()[Job]?.let { if (!it.isActive) throw CancellationException() }
                    val expectedNote = snapshotNote
                    val loadedNote = reloaded
                    if (expectedNote == null || loadedNote == null) {
                        reconcileUncommittedReloadArchive(
                            savedSnapshotRef = savedSnapshotRef,
                            archivedReference = archivedReference,
                            previousRefs = previousRefs,
                            nextRefs = nextRefs,
                            cleanupDirs = cleanupDirs,
                            changedDuringReload = false,
                        )
                        return@withLock
                    }

                    var changedDuringReload = false
                    documentWrites.withLock {
                        val latest = readState().tabs.find { it.id == id }
                        if (
                            latest == null ||
                            id in closingNoteIds ||
                            latest.uri != expectedNote.uri ||
                            latest.content != expectedNote.content ||
                            latest.saved != expectedNote.saved ||
                            latest.assetDirectory != expectedNote.assetDirectory ||
                            latest.assetsDirty != expectedNote.assetsDirty
                        ) {
                            changedDuringReload = true
                        } else {
                            reloadCommitted = true
                            if (nextRefs != null) {
                                writeClosedNoteRefs(nextRefs!!)
                            }
                            archivedReference?.assetDirectory?.let { cleanupDirs.remove(it) }
                            loadedNote.assetDirectory?.let { cleanupDirs.remove(it) }
                            if (expectedNote.assetDirectory != null && expectedNote.assetDirectory != loadedNote.assetDirectory) {
                                cleanupDirs.add(expectedNote.assetDirectory)
                            }
                            autosavePending.remove(id)
                            invalidateNoteAssets(id)
                            readerEcho.remove(id)
                            clearReaderEditProtocol(id)
                            if (loadedNote.portable) {
                                recordPortableBaseline(id, loadedNote.assetDirectory)
                            } else {
                                savedPortableAssets.remove(id)
                            }
                            changeState { state ->
                                state.copy(
                                    tabs = state.tabs.map { if (it.id == id) loadedNote else it },
                                    closedTabs = if (archivedReference != null) {
                                        (
                                            listOf(archivedReference!!.placeholder()) +
                                                state.closedTabs.filterNot { it.id == archivedReference!!.id }
                                            ).take(ClosedNoteStore.LIMIT)
                                    } else {
                                        state.closedTabs
                                    },
                                    conflictedTabIds = state.conflictedTabIds - id,
                                    pendingSaveConflictNoteId = state.pendingSaveConflictNoteId?.takeUnless { it == id },
                                    message = "Reloaded from disk",
                                )
                            }
                        }
                    }
                    if (changedDuringReload) {
                        reconcileUncommittedReloadArchive(
                            savedSnapshotRef = savedSnapshotRef,
                            archivedReference = archivedReference,
                            previousRefs = previousRefs,
                            nextRefs = nextRefs,
                            cleanupDirs = cleanupDirs,
                            changedDuringReload = true,
                        )
                    } else {
                        withContext(NonCancellable) {
                            cleanupPortableDirectories(cleanupDirs)
                            cleanupDirs.clear()
                        }
                    }
                } catch (cancelled: CancellationException) {
                    if (!reloadCommitted) {
                        reconcileUncommittedReloadArchive(
                            savedSnapshotRef = savedSnapshotRef,
                            archivedReference = archivedReference,
                            previousRefs = previousRefs,
                            nextRefs = nextRefs,
                            cleanupDirs = cleanupDirs,
                            changedDuringReload = false,
                        )
                    } else {
                        withContext(NonCancellable) {
                            cleanupPortableDirectories(cleanupDirs)
                            cleanupDirs.clear()
                        }
                    }
                    throw cancelled
                } catch (archiveFailed: ReloadArchiveFailedException) {
                    reconcileUncommittedReloadArchive(
                        savedSnapshotRef = savedSnapshotRef,
                        archivedReference = archivedReference,
                        previousRefs = previousRefs,
                        nextRefs = nextRefs,
                        cleanupDirs = cleanupDirs,
                        changedDuringReload = false,
                    )
                    fail("Could not archive draft before reloading: ${archiveFailed.message}")
                    return@withLock
                } catch (reloadError: Exception) {
                    reconcileUncommittedReloadArchive(
                        savedSnapshotRef = savedSnapshotRef,
                        archivedReference = archivedReference,
                        previousRefs = previousRefs,
                        nextRefs = nextRefs,
                        cleanupDirs = cleanupDirs,
                        changedDuringReload = false,
                    )
                    val failedUri = rawUri
                    if (failedUri != null && isDocumentAccessFailure(reloadError)) {
                        requestDocumentAccess(failedUri, snapshotNote, false, true)
                    } else {
                        fail("Could not reload note: ${reloadError.message}")
                    }
                    return@withLock
                }
            }
        } finally {
            cleanupPortableDirectories(cleanupDirs)
        }
    }
}
