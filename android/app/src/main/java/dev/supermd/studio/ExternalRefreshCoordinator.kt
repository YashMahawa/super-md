package dev.supermd.studio

import android.app.Application
import android.net.Uri
import androidx.core.net.toUri
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONObject

internal class ExternalRefreshCoordinator<Snapshot>(
    private val app: Application,
    private val workspaceKey: String,
    private val scope: CoroutineScope,
    private val media: MediaStorage,
    private val closedNoteStore: ClosedNoteStore,
    private val documentWrites: Mutex,
    private val closingNoteIds: Set<String>,
    private val autosavePending: MutableSet<String>,
    private val savedPortableAssets: MutableMap<String, JSONObject>,
    private val readerEcho: MutableMap<String, String>,
    private val documentAccessClearSeq: AtomicLong,
    private val readDocumentAccess: () -> DocumentAccess,
    private val readState: () -> StudioState,
    private val changeState: ((StudioState) -> StudioState) -> Unit,
    private val readInitialFolderLoadJob: () -> Job?,
    private val liveViewModels: () -> List<StudioViewModel>,
    private val readVmState: (StudioViewModel) -> StudioState,
    private val readVmClosedNoteRefs: (StudioViewModel) -> List<ClosedNoteReference>,
    private val baselinePortableAssets: (Note) -> JSONObject,
    private val sameDocumentUri: (String, String) -> Boolean,
    private val markDocumentWriteBlocked: (String) -> Unit,
    private val invalidateNoteAssets: (String) -> Unit,
    private val clearReaderEditProtocol: (String) -> Unit,
    private val pendingRefreshLock: Any,
    private val pendingRefreshUris: MutableMap<String, Long>,
    private val readRefreshAllGeneration: () -> Long,
    private val writeRefreshAllGeneration: (Long) -> Unit,
    private val readRefreshGeneration: () -> Long,
    private val writeRefreshGeneration: (Long) -> Unit,
    private val readRefreshJob: () -> Job?,
    private val writeRefreshJob: (Job?) -> Unit,
    private val readPreIoObserver: () -> (suspend () -> Unit)?,
    private val readIoObserver: () -> (suspend () -> Unit)?,
    private val readPostAdoptObserver: () -> (suspend () -> Unit)?,
    private val createSnapshot: (Note, JSONObject?) -> Snapshot,
    private val snapshotNote: (Snapshot) -> Note,
    private val preIoBaselineAssets: (Snapshot) -> JSONObject?,
    private val readResolvedBaseline: (Snapshot) -> JSONObject?,
    private val writeResolvedBaseline: (Snapshot, JSONObject?) -> Unit,
) {
    private data class CleanExternalUpdate<Snapshot>(
        val snapshot: Snapshot,
        val markdown: String,
        val directory: String? = null,
        val assets: JSONObject? = null,
    )

    private val resolver get() = app.contentResolver

    fun isPortableDirectoryReferenced(directory: String): Boolean {
        return liveViewModels().any { vm ->
            val state = readVmState(vm)
            state.tabs.any { it.assetDirectory == directory } ||
                state.closedTabs.any { it.assetDirectory == directory } ||
                readVmClosedNoteRefs(vm).any { it.assetDirectory == directory }
        }
    }

    private fun isPortableDirectoryReferencedOnDisk(directory: String): Boolean {
        val indexed = try {
            closedNoteStore.loadIndexStrict()
        } catch (_: Exception) {
            return true
        }
        if (indexed.any { it.assetDirectory == directory }) {
            return true
        }
        val deletedDir = File(app.filesDir, "deleted-drafts/$workspaceKey")
        return deletedDir.listFiles().orEmpty()
            .filter { it.isFile && it.extension == "json" }
            .any { file ->
                runCatching {
                    file.bufferedReader().use { NoteRecovery.read(it, StudioState()).tabs.any { tab -> tab.assetDirectory == directory } }
                }.getOrDefault(true)
            }
    }

    private fun deletePortableDirectoryIfUnreferenced(directory: String) {
        if (!isPortableDirectoryReferenced(directory) && !isPortableDirectoryReferencedOnDisk(directory)) {
            val target = File(app.filesDir, "portable-assets/$directory")
            media.invalidateLocalAsset(target)
            target.deleteRecursively()
        }
    }

    suspend fun cleanupPortableDirectories(directories: Set<String>) {
        if (directories.isEmpty()) return
        val dirsToDelete = directories.filterNot(::isPortableDirectoryReferenced)
        if (dirsToDelete.isEmpty()) return
        withContext(NonCancellable + Dispatchers.IO) {
            dirsToDelete.forEach(::deletePortableDirectoryIfUnreferenced)
        }
    }

    private fun baselineMatchesRefreshSnapshot(current: Note, snapshot: Snapshot): Boolean {
        val expected = snapshotNote(snapshot)
        if (
            current.uri != expected.uri ||
            current.portable != expected.portable ||
            current.saved != expected.saved ||
            current.assetDirectory != expected.assetDirectory
        ) return false
        if (!expected.portable) return true
        val currentBaseline = savedPortableAssets[current.id]
        val preIoBaseline = preIoBaselineAssets(snapshot)
        return when {
            preIoBaseline != null ->
                currentBaseline != null && portableAssetsMatch(preIoBaseline, currentBaseline)
            expected.assetsDirty ->
                currentBaseline == null
            else ->
                currentBaseline == null ||
                    readResolvedBaseline(snapshot)?.let { portableAssetsMatch(it, currentBaseline) } == true
        }
    }

    private fun canAdoptCleanRefresh(current: Note?, conflictedTabIds: Set<String>, snapshot: Snapshot): Boolean =
        current != null &&
            current.id !in closingNoteIds &&
            current.id !in conflictedTabIds &&
            !current.dirty &&
            current.content == snapshotNote(snapshot).content &&
            baselineMatchesRefreshSnapshot(current, snapshot)

    private fun canCommitRefreshConflict(current: Note?, conflictedTabIds: Set<String>, snapshot: Snapshot): Boolean =
        current != null &&
            current.id !in closingNoteIds &&
            current.id !in conflictedTabIds &&
            current.dirty &&
            baselineMatchesRefreshSnapshot(current, snapshot)

    private fun completePendingRefresh(snapshotGen: Long) {
        synchronized(pendingRefreshLock) {
            if (readRefreshAllGeneration() <= snapshotGen) writeRefreshAllGeneration(0L)
            pendingRefreshUris.entries.removeIf { it.value <= snapshotGen }
        }
    }

    fun refreshExternal(changedUri: Uri? = null, immediate: Boolean = false) {
        val state = readState()
        val conflicted = state.conflictedTabIds
        val hasCandidate = state.tabs.any { tab ->
            tab.uri != null && tab.id !in conflicted &&
                (changedUri == null || sameDocumentUri(tab.uri, changedUri.toString()))
        }
        if (!hasCandidate) return
        synchronized(pendingRefreshLock) {
            val gen = readRefreshGeneration() + 1L
            writeRefreshGeneration(gen)
            if (changedUri == null) writeRefreshAllGeneration(gen)
            else pendingRefreshUris[changedUri.toString()] = gen
        }
        readRefreshJob()?.cancel()
        writeRefreshJob(
            scope.launch {
                if (!immediate) delay(200)
                val startupFolderJob = readInitialFolderLoadJob()
                if (
                    startupFolderJob?.isActive == true &&
                    readState().folder?.let { !isKnownPathDocumentProvider(it.toUri().authority) } == true
                ) {
                    runCatching { startupFolderJob.join() }
                }
                val (snapshotGen, checkAll, requestedUris) = synchronized(pendingRefreshLock) {
                    Triple(readRefreshGeneration(), readRefreshAllGeneration() > 0L, pendingRefreshUris.keys.toSet())
                }
                val current = readState()
                val snapshotTabs = current.tabs.filter { tab ->
                    tab.uri != null && tab.id !in current.conflictedTabIds &&
                        (checkAll || requestedUris.any { target -> sameDocumentUri(tab.uri, target) })
                }
                refreshExternalTabs(snapshotTabs) { completePendingRefresh(snapshotGen) }
            },
        )
    }

    suspend fun refreshExternalTabs(
        snapshotTabs: List<Note>,
        onCommitted: (() -> Unit)? = null,
    ) {
        val initialConflicted = readState().conflictedTabIds
        val snapshots = snapshotTabs
            .filter { it.uri != null && it.id !in initialConflicted }
            .map { note ->
                createSnapshot(
                    note,
                    if (note.portable) savedPortableAssets[note.id]?.let { JSONObject(it.toString()) } else null,
                )
            }
        if (snapshots.isEmpty()) {
            onCommitted?.invoke()
            return
        }
        val dirtyConflicts = mutableMapOf<String, Snapshot>()
        val cleanUpdates = mutableMapOf<String, CleanExternalUpdate<Snapshot>>()
        val newlyBlockedUris = ConcurrentHashMap<String, Long>()
        val pendingPortableDirs = ConcurrentHashMap.newKeySet<String>()
        val obsoletePortableDirs = ConcurrentHashMap.newKeySet<String>()
        val preIoObserver = readPreIoObserver()
        val ioObserver = readIoObserver()
        val ownShareAuthority = "${app.packageName}.share"
        try {
            withContext(Dispatchers.IO) {
                preIoObserver?.takeIf { readPreIoObserver() === it }?.invoke()
                for (initialSnapshot in snapshots) {
                    if (coroutineContext[Job]?.isActive == false) break
                    documentWrites.withLock {
                        val initialNote = snapshotNote(initialSnapshot)
                        val currentState = readState()
                        val note = currentState.tabs.find { it.id == initialNote.id } ?: return@withLock
                        val noteUriRaw = note.uri ?: return@withLock
                        if (note.id in closingNoteIds || note.id in currentState.conflictedTabIds) return@withLock
                        val snapshot = if (baselineMatchesRefreshSnapshot(note, initialSnapshot) && note.content == initialNote.content) {
                            initialSnapshot
                        } else {
                            createSnapshot(
                                note,
                                if (note.portable) savedPortableAssets[note.id]?.let { JSONObject(it.toString()) } else null,
                            )
                        }
                        val documentAccess = readDocumentAccess()
                        val clearSeq = documentAccessClearSeq.get()
                        val parsedUri = noteUriRaw.toUri()
                        val target = try {
                            documentAccess.resolve(parsedUri, writing = false)
                        } catch (cancelled: CancellationException) {
                            throw cancelled
                        } catch (error: Throwable) {
                            if (isDocumentAccessFailure(error)) newlyBlockedUris[noteUriRaw] = clearSeq
                            return@withLock
                        }
                        if (parsedUri.scheme.equals("content", ignoreCase = true)) {
                            val writeTarget = try {
                                documentAccess.resolve(parsedUri, writing = true)
                            } catch (cancelled: CancellationException) {
                                throw cancelled
                            } catch (error: Throwable) {
                                if (isDocumentAccessFailure(error)) newlyBlockedUris[noteUriRaw] = clearSeq
                                return@withLock
                            }
                            val effectiveWriteTarget = if (documentAccess.hasWriteGrant(writeTarget)) writeTarget else target
                            val writeGrantConfirmed = documentAccess.hasWriteGrant(effectiveWriteTarget)
                            val readOnlyOrUnconfirmedGrant = parsedUri.authority != ownShareAuthority &&
                                documentAccess.hasAnyReadOrPendingGrant(target) &&
                                !writeGrantConfirmed
                            if (readOnlyOrUnconfirmedGrant) {
                                newlyBlockedUris[noteUriRaw] = clearSeq
                            }
                        }
                        if (note.dirty) {
                            val expectedAssets = if (note.portable) {
                                preIoBaselineAssets(snapshot) ?: baselinePortableAssets(note).also { writeResolvedBaseline(snapshot, it) }
                            } else null
                            val matches = try {
                                val stream = resolver.openInputStream(target) ?: return@withLock
                                stream.use { input ->
                                    if (note.portable) {
                                        media.portableEnvelopeMatches(input, note.saved, expectedAssets ?: JSONObject())
                                    } else {
                                        val current = readLimited(input, 20_000_000).toString(Charsets.UTF_8).removePrefix("\uFEFF")
                                        current == note.saved.removePrefix("\uFEFF")
                                    }
                                }
                            } catch (cancelled: CancellationException) {
                                throw cancelled
                            } catch (error: Throwable) {
                                if (isDocumentAccessFailure(error)) newlyBlockedUris[noteUriRaw] = clearSeq
                                return@withLock
                            }
                            if (!matches) dirtyConflicts[note.id] = snapshot
                        } else if (note.portable) {
                            val disk = try {
                                resolver.openInputStream(target)?.use(media::openFmd)
                            } catch (cancelled: CancellationException) {
                                throw cancelled
                            } catch (error: Throwable) {
                                if (isDocumentAccessFailure(error)) newlyBlockedUris[noteUriRaw] = clearSeq
                                return@withLock
                            } ?: return@withLock
                            pendingPortableDirs.add(disk.directory)
                            val expectedAssets = preIoBaselineAssets(snapshot)
                                ?: baselinePortableAssets(note).also { writeResolvedBaseline(snapshot, it) }
                            val diskAssets = runCatching { media.portableAssets(disk.directory) }.getOrNull()
                            if (diskAssets == null || (disk.markdown == note.content && portableAssetsMatch(expectedAssets, diskAssets))) {
                                deletePortableDirectoryIfUnreferenced(disk.directory)
                                pendingPortableDirs.remove(disk.directory)
                            } else {
                                cleanUpdates[note.id]?.directory?.let { prev ->
                                    deletePortableDirectoryIfUnreferenced(prev)
                                    pendingPortableDirs.remove(prev)
                                }
                                cleanUpdates[note.id] = CleanExternalUpdate(snapshot, disk.markdown, disk.directory, diskAssets)
                            }
                        } else {
                            val text = try {
                                resolver.openInputStream(target)?.use { readLimited(it, 20_000_000).toString(Charsets.UTF_8).removePrefix("\uFEFF") }
                            } catch (cancelled: CancellationException) {
                                throw cancelled
                            } catch (error: Throwable) {
                                if (isDocumentAccessFailure(error)) newlyBlockedUris[noteUriRaw] = clearSeq
                                return@withLock
                            } ?: return@withLock
                            if (text != note.content) cleanUpdates[note.id] = CleanExternalUpdate(snapshot, text)
                        }
                    }
                }
                if (coroutineContext[Job]?.isActive != false && (dirtyConflicts.isNotEmpty() || cleanUpdates.isNotEmpty())) {
                    ioObserver?.takeIf { readIoObserver() === it }?.invoke()
                }
            }
            currentCoroutineContext()[Job]?.let { if (!it.isActive) throw CancellationException() }
            if (newlyBlockedUris.isNotEmpty()) {
                documentWrites.withLock {
                    val openUris = readState().tabs
                        .filter { it.id !in closingNoteIds }
                        .mapNotNull { it.uri }
                    newlyBlockedUris.forEach { (raw, clearSeqAtCheck) ->
                        val matchingOpen = openUris.any { open -> sameDocumentUri(open, raw) }
                        if (matchingOpen && documentAccessClearSeq.get() == clearSeqAtCheck) {
                            markDocumentWriteBlocked(raw)
                        }
                    }
                }
            }
            if (dirtyConflicts.isEmpty() && cleanUpdates.isEmpty()) {
                onCommitted?.invoke()
                return
            }
            var committedAny = false
            documentWrites.withLock {
                val currentState = readState()
                val currentTabsById = currentState.tabs.associateBy { it.id }
                val newlyConflicted = mutableSetOf<String>()
                dirtyConflicts.forEach { (id, snapshot) ->
                    if (canCommitRefreshConflict(currentTabsById[id], currentState.conflictedTabIds, snapshot)) {
                        newlyConflicted.add(id)
                    }
                }
                val adoptableUpdates = mutableMapOf<String, CleanExternalUpdate<Snapshot>>()
                cleanUpdates.forEach { (id, update) ->
                    val current = currentTabsById[id]
                    if (canAdoptCleanRefresh(current, currentState.conflictedTabIds, update.snapshot)) {
                        adoptableUpdates[id] = update
                    } else if (canCommitRefreshConflict(current, currentState.conflictedTabIds, update.snapshot)) {
                        newlyConflicted.add(id)
                    }
                }
                newlyConflicted.forEach { autosavePending.remove(it) }
                if (newlyConflicted.isEmpty() && adoptableUpdates.isEmpty()) return@withLock
                committedAny = true
                val previousPortableDirs = adoptableUpdates.mapNotNull { (id, update) ->
                    val oldDir = snapshotNote(update.snapshot).assetDirectory
                    if (update.directory != null && oldDir != null && oldDir != update.directory) id to oldDir else null
                }
                adoptableUpdates.forEach { (id, update) ->
                    invalidateNoteAssets(id)
                    readerEcho.remove(id)
                    clearReaderEditProtocol(id)
                    if (update.directory != null && update.assets != null) {
                        savedPortableAssets[id] = update.assets
                    }
                }
                changeState { s ->
                    s.copy(
                        tabs = s.tabs.map { tab ->
                            val update = adoptableUpdates[tab.id]
                            val expected = update?.let { snapshotNote(it.snapshot) }
                            if (
                                update != null &&
                                expected != null &&
                                !tab.dirty &&
                                tab.id !in s.conflictedTabIds &&
                                tab.uri == expected.uri &&
                                tab.content == expected.content &&
                                tab.saved == expected.saved &&
                                tab.assetDirectory == expected.assetDirectory
                            ) {
                                tab.copy(content = update.markdown, saved = update.markdown, assetDirectory = update.directory ?: tab.assetDirectory, assetsDirty = false)
                            } else tab
                        },
                        conflictedTabIds = s.conflictedTabIds + newlyConflicted,
                        message = if (newlyConflicted.isNotEmpty()) "This file changed on disk. Autosave is paused for this tab." else s.message,
                    )
                }
                previousPortableDirs.forEach { (id, oldDir) ->
                    val adoptedDir = adoptableUpdates[id]?.directory
                    if (
                        adoptedDir != null &&
                        readState().tabs.any { it.id == id && it.assetDirectory == adoptedDir } &&
                        !isPortableDirectoryReferenced(oldDir)
                    ) {
                        obsoletePortableDirs.add(oldDir)
                    }
                }
                adoptableUpdates.forEach { (id, update) ->
                    val dir = update.directory ?: return@forEach
                    if (readState().tabs.any { it.id == id && it.assetDirectory == dir }) {
                        pendingPortableDirs.remove(dir)
                    }
                }
            }
            onCommitted?.invoke()
            if (!committedAny) return
            readPostAdoptObserver()?.invoke()
        } finally {
            cleanupPortableDirectories(pendingPortableDirs + obsoletePortableDirs)
        }
    }
}
