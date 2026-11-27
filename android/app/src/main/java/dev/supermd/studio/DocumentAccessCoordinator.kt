package dev.supermd.studio

import android.app.Application
import android.content.ContentResolver
import android.net.Uri
import android.provider.DocumentsContract
import androidx.documentfile.provider.DocumentFile
import java.util.UUID
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

internal class DocumentAccessCoordinator(
    private val app: Application,
    private val scope: CoroutineScope,
    private val resolver: ContentResolver,
    private val readDocumentAccess: () -> DocumentAccess,
    private val accessRequestsMutable: MutableStateFlow<DocumentAccessRequest?>,
    private val blockedDocumentWrites: MutableSet<String>,
    private val documentAccessClearSeq: AtomicLong,
    private val promptedDocumentAccess: MutableSet<String>,
    private val promptedAssetAccess: MutableSet<String>,
    private val pendingAccessHeadings: MutableMap<String, String>,
    private val documentWrites: Mutex,
    private val closingNoteIds: Set<String>,
    private val readState: () -> StudioState,
    private val writeState: (StudioState) -> Unit,
    private val changeState: ((StudioState) -> StudioState) -> Unit,
    private val sameDocumentUri: (String, String) -> Boolean,
    private val rememberLinkedAsset: (Note, String, Uri) -> Unit,
    private val invalidateNoteAssets: (String) -> Unit,
    private val readAssetAccessRestored: () -> ((String, String) -> Unit)?,
    private val performReaderBarrier: suspend (String, () -> Unit) -> Boolean,
    private val readerBarrierFailed: () -> Unit,
    private val rememberNote: (Note) -> Unit,
    private val scheduleAutosave: (String) -> Unit,
    private val openNote: (Uri, String?) -> Unit,
    private val fail: (String) -> Unit,
) {
    private val documentAccess: DocumentAccess
        get() = readDocumentAccess()

    private fun blockedWritesSnapshot(): Set<String> =
        synchronized(blockedDocumentWrites) { LinkedHashSet(blockedDocumentWrites) }

    private fun syncBlockedWriteState() {
        val snapshot = blockedWritesSnapshot()
        if (readState().blockedWriteUris != snapshot) {
            writeState(readState().copy(blockedWriteUris = snapshot))
        }
    }

    fun markDocumentWriteBlocked(uri: String) {
        synchronized(blockedDocumentWrites) {
            if (blockedDocumentWrites.none { sameDocumentUri(it, uri) }) {
                blockedDocumentWrites.add(uri)
            }
        }
        syncBlockedWriteState()
    }

    fun writeIsBlocked(uri: String): Boolean = synchronized(blockedDocumentWrites) {
        blockedDocumentWrites.any { sameDocumentUri(it, uri) }
    }

    fun clearDocumentAccessFailure(uri: String) {
        documentAccessClearSeq.incrementAndGet()
        synchronized(blockedDocumentWrites) {
            blockedDocumentWrites.removeAll { sameDocumentUri(it, uri) }
        }
        promptedDocumentAccess.removeAll { sameDocumentUri(it, uri) }
        syncBlockedWriteState()
    }

    fun requestDocumentAccess(uri: String, note: Note?, writing: Boolean, explicit: Boolean = false): String {
        if (writing) {
            synchronized(blockedDocumentWrites) {
                if (blockedDocumentWrites.none { sameDocumentUri(it, uri) }) {
                    blockedDocumentWrites.add(uri)
                }
            }
        }
        val blockedSnapshot = blockedWritesSnapshot()
        val alreadyPrompted = promptedDocumentAccess.any { sameDocumentUri(it, uri) }
        promptedDocumentAccess.add(uri)
        if ((!alreadyPrompted || explicit) && accessRequestsMutable.value == null) {
            val name = note?.name ?: Uri.parse(uri).lastPathSegment?.substringAfterLast('/') ?: "This note"
            accessRequestsMutable.value = DocumentAccessRequest(uri, name, note?.id, writing)
        }
        val current = readState()
        writeState(
            if (!alreadyPrompted || explicit) {
                current.copy(busy = false, blockedWriteUris = blockedSnapshot, message = DOCUMENT_ACCESS_MESSAGE)
            } else {
                current.copy(busy = false, blockedWriteUris = blockedSnapshot)
            },
        )
        return DOCUMENT_ACCESS_MESSAGE
    }

    fun requestWriteAccessIfBlocked(id: String, explicit: Boolean = false): Boolean {
        val note = readState().tabs.firstOrNull { it.id == id } ?: return false
        val uri = note.uri ?: return false
        if (!writeIsBlocked(uri)) return false
        requestDocumentAccess(uri, note, writing = true, explicit = explicit)
        return true
    }

    fun documentWriteNeedsAccess(id: String): Boolean {
        val current = readState()
        return current.writeNeedsAccess(id) || current.tabs.firstOrNull { it.id == id }?.uri?.let(::writeIsBlocked) == true
    }

    fun resolveVerifiedWriteDestination(source: Uri): Uri {
        val candidate = documentAccess.resolve(source, writing = true)
        if (!DocumentsContract.isTreeUri(candidate) || documentAccess.hasWriteGrant(candidate)) {
            return candidate
        }
        if (!DocumentsContract.isTreeUri(source)) {
            return source
        }
        val authority = source.authority?.takeIf { it.isNotEmpty() }
        val docId = runCatching { DocumentsContract.getDocumentId(source) }.getOrNull()?.takeIf { it.isNotEmpty() }
        val plainFallback = if (authority != null && docId != null) {
            DocumentsContract.buildDocumentUri(authority, docId)
        } else {
            null
        }
        if (plainFallback != null && documentAccess.hasWriteGrant(plainFallback)) {
            return plainFallback
        }
        throw SecurityException("Write access to this folder document has not been confirmed")
    }

    fun reportDocumentSaveFailure(id: String, error: Throwable, fallback: String): String {
        val note = readState().tabs.firstOrNull { it.id == id }
        return if (isDocumentAccessFailure(error) && note?.uri != null) requestDocumentAccess(note.uri, note, writing = true)
        else { fail(fallback); fallback }
    }

    fun restoreDocumentAccess(request: DocumentAccessRequest, chosen: Uri): Job = scope.launch {
        val wasBlockedBeforeRestore = writeIsBlocked(request.uri) || writeIsBlocked(chosen.toString())
        try {
            if (request.assetSource != null) {
                val note = readState().tabs.firstOrNull { it.id == request.noteId } ?: error("The note is no longer open")
                require(sameDocumentUri(note.uri ?: note.id, request.uri)) { "The note's destination changed; its draft was left intact." }
                withContext(Dispatchers.IO) {
                    documentAccess.persist(chosen)
                    val name = DocumentFile.fromSingleUri(app, chosen)?.name
                    require(name == request.name) { "Choose ${request.name}; the selected file has a different name." }
                    resolver.openFileDescriptor(chosen, "r")?.use { } ?: error("Android did not grant read access")
                }
                rememberLinkedAsset(note, request.assetSource, chosen)
                promptedAssetAccess.remove("${note.id}\n${request.assetSource}")
                invalidateNoteAssets(note.id)
                accessRequestsMutable.value = null
                writeState(readState().copy(message = "Linked file access restored. You can retry the export."))
                readAssetAccessRestored()?.invoke(note.uri ?: note.id, request.assetSource)
                return@launch
            }
            require(sameDocument(Uri.parse(request.uri), chosen)) { "Choose the original ${request.name}. To use another destination, save a copy instead." }
            val (resolved, writeRestored) = withContext(Dispatchers.IO) {
                documentAccess.persist(chosen)
                val target = documentAccess.resolve(chosen, request.writing)
                // Verify without truncating or writing any bytes. The existing
                // draft and its saved baseline remain authoritative.
                if (request.writing && DocumentsContract.isTreeUri(target) && !documentAccess.hasWriteGrant(target)) {
                    throw SecurityException("Android did not grant write access to this file")
                }
                resolver.openFileDescriptor(target, if (request.writing) "rw" else "r")?.use { }
                    ?: error("Android did not grant access to this file")
                if (request.writing) {
                    target to true
                } else {
                    val writeCandidate = documentAccess.resolve(chosen, writing = true)
                    val candidateWritable = documentAccess.hasWriteGrant(writeCandidate) &&
                        runCatching { resolver.openFileDescriptor(writeCandidate, "rw")?.use { true } == true }.getOrDefault(false)
                    if (candidateWritable) {
                        writeCandidate to true
                    } else {
                        val targetWritable = target != writeCandidate &&
                            documentAccess.hasWriteGrant(target) &&
                            runCatching { resolver.openFileDescriptor(target, "rw")?.use { true } == true }.getOrDefault(false)
                        target to targetWritable
                    }
                }
            }
            val carriedHeading = pendingAccessHeadings.keys
                .firstOrNull { key -> sameDocumentUri(key, resolved.toString()) || sameDocumentUri(key, request.uri) }
                ?.let(pendingAccessHeadings::remove)
            val note = readState().tabs.firstOrNull { it.id == request.noteId }
            require(request.noteId == null || note != null) { "The note was closed; its recovery data was left intact." }
            if (note != null) {
                require(note.uri?.let { sameDocumentUri(it, request.uri) } == true) { "The note's destination changed; its draft was left intact." }
                val shouldActivate = !request.writing || carriedHeading != null
                val jump = carriedHeading?.takeIf { it.isNotBlank() }?.let { PendingHeadingJump(note.id, it, UUID.randomUUID().toString()) }
                val existingNoteUri = note.uri
                val keepExistingNoteUri = !writeRestored &&
                    DocumentsContract.isTreeUri(resolved) &&
                    documentAccess.resolveReadAccess(resolved) is SafReadAccess.PendingTreeMembership &&
                    runCatching { resolver.openFileDescriptor(Uri.parse(existingNoteUri), "r")?.use { true } == true }.getOrDefault(false)
                val updatedNoteUri = if (keepExistingNoteUri) existingNoteUri else resolved.toString()
                val currentActiveId = readState().active.id
                var barrierRejected = false
                if (shouldActivate && currentActiveId.isNotEmpty() && currentActiveId != note.id) {
                    val accepted = performReaderBarrier(currentActiveId) {
                        changeState { state ->
                            state.copy(
                                tabs = state.tabs.map { if (it.id == note.id) it.copy(uri = updatedNoteUri) else it },
                                activeId = note.id,
                                pendingHeading = jump ?: state.pendingHeading,
                                message = "File access restored; your draft is unchanged",
                            )
                        }
                    }
                    if (!accepted) {
                        barrierRejected = true
                        changeState { state -> state.copy(tabs = state.tabs.map { if (it.id == note.id) it.copy(uri = updatedNoteUri) else it }) }
                    }
                } else {
                    changeState { state ->
                        state.copy(
                            tabs = state.tabs.map { if (it.id == note.id) it.copy(uri = updatedNoteUri) else it },
                            activeId = if (shouldActivate) note.id else state.activeId,
                            pendingHeading = jump ?: state.pendingHeading,
                            message = "File access restored; your draft is unchanged",
                        )
                    }
                }
                if (writeRestored) {
                    clearDocumentAccessFailure(request.uri)
                    clearDocumentAccessFailure(resolved.toString())
                } else {
                    markDocumentWriteBlocked(request.uri)
                    markDocumentWriteBlocked(resolved.toString())
                    promptedDocumentAccess.removeAll { sameDocumentUri(it, request.uri) || sameDocumentUri(it, resolved.toString()) }
                }
                accessRequestsMutable.value = null
                readState().tabs.firstOrNull { it.id == note.id }?.let(rememberNote)
                if (barrierRejected) readerBarrierFailed()
                if (note.dirty && writeRestored) scheduleAutosave(note.id)
            } else {
                if (writeRestored) {
                    clearDocumentAccessFailure(request.uri)
                    clearDocumentAccessFailure(resolved.toString())
                } else {
                    markDocumentWriteBlocked(request.uri)
                    markDocumentWriteBlocked(resolved.toString())
                    promptedDocumentAccess.removeAll { sameDocumentUri(it, request.uri) || sameDocumentUri(it, resolved.toString()) }
                }
                accessRequestsMutable.value = null
                openNote(resolved, carriedHeading)
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Exception) {
            if (request.writing || wasBlockedBeforeRestore) {
                markDocumentWriteBlocked(request.uri)
            }
            val detail = if (isDocumentAccessFailure(error)) "This file is still read-only. Your draft is safe; choose the original file with write access or save a copy." else error.message ?: "Access could not be restored"
            accessRequestsMutable.value = request.copy(detail = detail)
        }
    }

    fun seedRestoredDocumentAccess(initialFolderJob: Job?): Job? {
        val candidateUris = readState().tabs
            .mapNotNull { it.uri }
            .filter { raw -> runCatching { Uri.parse(raw).scheme.equals("content", ignoreCase = true) }.getOrDefault(false) }
            .distinct()
        if (candidateUris.isEmpty()) return null
        return scope.launch {
            if (
                initialFolderJob != null &&
                readState().folder?.let { !isKnownPathDocumentProvider(Uri.parse(it).authority) } == true
            ) {
                runCatching { initialFolderJob.join() }
            }
            val deniedUris = withContext(Dispatchers.IO) {
                buildMap<String, Long> {
                    for (raw in candidateUris) {
                        if (coroutineContext[Job]?.isActive == false) break
                        documentWrites.withLock {
                            val stillOpen = readState().tabs.any { tab ->
                                tab.id !in closingNoteIds && tab.uri != null && sameDocumentUri(tab.uri, raw)
                            }
                            if (!stillOpen) return@withLock
                            val clearSeq = documentAccessClearSeq.get()
                            val parsed = Uri.parse(raw)
                            if (
                                documentAccess.evaluateRestoredWriteAccess(resolver, parsed) ==
                                DocumentWriteGuardOutcome.PERMISSION_DENIED
                            ) {
                                put(raw, clearSeq)
                            }
                        }
                    }
                }
            }
            if (deniedUris.isEmpty()) return@launch
            documentWrites.withLock {
                val openUris = readState().tabs
                    .filter { it.id !in closingNoteIds }
                    .mapNotNull { it.uri }
                deniedUris.forEach { (raw, clearSeqAtCheck) ->
                    val matchingOpen = openUris.any { open -> sameDocumentUri(open, raw) }
                    if (matchingOpen && documentAccessClearSeq.get() == clearSeqAtCheck) {
                        markDocumentWriteBlocked(raw)
                    }
                }
            }
        }
    }
}
