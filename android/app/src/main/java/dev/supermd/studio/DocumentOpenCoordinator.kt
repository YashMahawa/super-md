package dev.supermd.studio

import android.app.Application
import android.content.ContentResolver
import android.content.Intent
import android.content.SharedPreferences
import android.net.Uri
import android.provider.DocumentsContract
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject

private enum class DocumentWriteOpenState { UNCHANGED, RESTORED, BLOCKED }

internal class DocumentOpenCoordinator(
    private val app: Application,
    private val windowPrefs: SharedPreferences,
    private val scope: CoroutineScope,
    private val media: MediaStorage,
    private val openRequests: OpenRequestGate,
    private val blockedDocumentWrites: MutableSet<String>,
    private val confirmedTreeDocumentKeys: MutableSet<String>,
    private val closingNoteIds: Set<String>,
    private val pendingAccessHeadings: MutableMap<String, String>,
    private val readDocumentAccess: () -> DocumentAccess,
    private val readWorkspaceLinks: () -> WorkspaceLinkCache,
    private val readState: () -> StudioState,
    private val writeState: (StudioState) -> Unit,
    private val changeState: ((StudioState) -> StudioState) -> Unit,
    private val readRecent: () -> List<RecentNote>,
    private val setListedRelative: (String) -> Unit,
    private val readStartupAccessSeedJob: () -> Job?,
    private val listFolder: (Uri, String) -> Job,
    private val relativeInOpenFolder: (Uri, String?) -> String?,
    private val openWorkspaceLink: suspend (String, String, String, Boolean, Boolean) -> JSONObject,
    private val resolveDisplayName: (Uri) -> String?,
    private val recordPortableBaseline: (String, String?) -> Unit,
    private val cleanupPortableDirectories: suspend (Set<String>) -> Unit,
    private val rememberNote: (Note) -> Unit,
    private val scheduleAutosave: (String) -> Unit,
    private val writeIsBlocked: (String) -> Boolean,
    private val markDocumentWriteBlocked: (String) -> Unit,
    private val clearDocumentAccessFailure: (String) -> Unit,
    private val requestDocumentAccess: (String, Note?, Boolean, Boolean) -> String,
    private val performCurrentReaderBarrier: suspend ((String) -> Unit) -> Boolean,
    private val readerBarrierFailed: () -> Unit,
    private val fail: (String) -> Unit,
    private val openDocument: (Uri, String?, String?) -> Job,
) {
    private val resolver: ContentResolver get() = app.contentResolver
    private val documentAccess: DocumentAccess get() = readDocumentAccess()
    private val workspaceLinks: WorkspaceLinkCache get() = readWorkspaceLinks()
    private fun sameDocumentUri(left: String, right: String) = sameDocument(Uri.parse(left), Uri.parse(right))

    suspend fun applyWorkspaceFolder(uri: Uri, clearPrompt: Boolean = false) {
        withContext(Dispatchers.IO) { documentAccess.persist(uri) }
        workspaceLinks.invalidate()
        setListedRelative("")
        windowPrefs.edit().putBoolean("folderMigrated", true).putString("folder", uri.toString()).putString("folderRelative", "").apply()
        changeState {
            if (clearPrompt) it.copy(folder = uri.toString(), folderRelative = "", folderAccessPrompt = null)
            else it.copy(folder = uri.toString(), folderRelative = "")
        }
        val listJob = listFolder(uri, "")
        readStartupAccessSeedJob()?.let { seedJob ->
            if (seedJob.isActive) runCatching { seedJob.join() }
        }
        if (synchronized(blockedDocumentWrites) { blockedDocumentWrites.isNotEmpty() }) {
            listJob.join()
            val candidates = synchronized(blockedDocumentWrites) { blockedDocumentWrites.toList() }
            val stateBeforeUnblock = readState()
            val listedFileUris = stateBeforeUnblock.files.asSequence().filter { !it.directory }.map { it.uri }.toSet()
            val relativeHints = buildMap<String, String> {
                readRecent().forEach { r -> if (!r.relative.isNullOrEmpty()) put(r.uri, r.relative) }
                stateBeforeUnblock.tabs.forEach { t -> if (t.uri != null && !t.relative.isNullOrEmpty()) put(t.uri, t.relative) }
            }
            val (unblockedTargets, confirmedKeys) = withContext(Dispatchers.IO) {
                val selectedAuthority = uri.authority?.takeIf { it.isNotEmpty() }
                val selectedRoot = if (DocumentsContract.isTreeUri(uri)) {
                    runCatching { DocumentsContract.getTreeDocumentId(uri) }.getOrNull()?.takeIf { it.isNotEmpty() && '\u0000' !in it }
                } else null
                if (selectedAuthority == null || selectedRoot == null || !documentAccess.hasWriteGrant(uri)) {
                    emptyList<Pair<String, Uri>>() to emptySet()
                } else {
                    val knownPathProvider = isKnownPathDocumentProvider(selectedAuthority)
                    val canonicalSelectedTree = DocumentsContract.buildTreeDocumentUri(selectedAuthority, selectedRoot)
                    val passLazy = lazy(LazyThreadSafetyMode.NONE) { SafProjectionPass(resolver) }
                    val matched = candidates.mapNotNull { raw ->
                        val parsedRaw = Uri.parse(raw)
                        if (parsedRaw.scheme != "content" || parsedRaw.authority != selectedAuthority) return@mapNotNull null
                        val docId = runCatching { DocumentsContract.getDocumentId(parsedRaw) }.getOrNull()
                            ?.takeIf { it.isNotEmpty() && '\u0000' !in it } ?: return@mapNotNull null
                        val scopedTarget = DocumentsContract.buildDocumentUriUsingTree(canonicalSelectedTree, docId)
                        val inSelectedTree = if (knownPathProvider) {
                            isKnownPathContainedInTree(selectedAuthority, selectedRoot, docId)
                        } else {
                            docId == selectedRoot ||
                                scopedTarget.toString() in listedFileUris ||
                                confirmThirdPartyTreeMembership(
                                    pass = passLazy.value,
                                    treeUri = canonicalSelectedTree,
                                    rootDocumentId = selectedRoot,
                                    targetDocumentId = docId,
                                    relativeHint = relativeHints[raw]
                                        ?: relativeHints.entries.firstOrNull { (k, _) -> sameDocumentUri(k, raw) }?.value,
                                )
                        }
                        if (!inSelectedTree) return@mapNotNull null
                        if (passLazy.isInitialized()) confirmedTreeDocumentKeys.addAll(passLazy.value.confirmedTreeKeys)
                        val writable = documentAccess.hasWriteGrant(scopedTarget) &&
                            runCatching { resolver.openFileDescriptor(scopedTarget, "rw")?.use { true } == true }.getOrDefault(false)
                        if (writable) raw to scopedTarget else null
                    }
                    val discoveredKeys = if (passLazy.isInitialized()) passLazy.value.confirmedTreeKeys else emptySet()
                    matched to discoveredKeys
                }
            }
            if (confirmedKeys.isNotEmpty()) confirmedTreeDocumentKeys.addAll(confirmedKeys)
            if (unblockedTargets.isNotEmpty()) {
                unblockedTargets.forEach { (raw, scopedTarget) ->
                    clearDocumentAccessFailure(raw)
                    clearDocumentAccessFailure(scopedTarget.toString())
                }
                val dirtyUnblockedIds = mutableListOf<String>()
                changeState { current ->
                    val updatedTabs = current.tabs.map { tab ->
                        val tabUri = tab.uri ?: return@map tab
                        if (tab.id in closingNoteIds) return@map tab
                        val match = unblockedTargets.firstOrNull { (raw, scopedTarget) ->
                            sameDocumentUri(tabUri, raw) || sameDocumentUri(tabUri, scopedTarget.toString())
                        } ?: return@map tab
                        val nextUri = match.second.toString()
                        val nextRelative = relativeInOpenFolder(match.second, uri.toString()) ?: tab.relative
                        if (tab.dirty) dirtyUnblockedIds += tab.id
                        if (tab.uri != nextUri || tab.relative != nextRelative) tab.copy(uri = nextUri, relative = nextRelative) else tab
                    }
                    if (updatedTabs != current.tabs) current.copy(tabs = updatedTabs) else current
                }
                dirtyUnblockedIds.forEach(scheduleAutosave)
            }
        }
    }

    fun grantWorkspaceFolderForLink(uri: Uri): Job = scope.launch {
        val prompt = readState().folderAccessPrompt
        try {
            applyWorkspaceFolder(uri, clearPrompt = true)
            if (prompt != null) {
                openWorkspaceLink(prompt.noteId, prompt.target, prompt.fragment, prompt.wikilink, false)
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Exception) {
            writeState(readState().copy(folderAccessPrompt = null))
            fail("Could not open folder: ${error.message}")
        }
    }

    private fun loadNoteForOpen(uri: Uri, relative: String?, onExtractedPortable: ((Note) -> Unit)? = null): Note {
        documentAccess.persist(uri)
        val target = documentAccess.resolve(uri)
        return loadResolvedNoteForOpen(target, uri, relative, externalIntentFlags = null, externalCaller = ExternalIntentCaller(), onExtractedPortable = onExtractedPortable)
    }

    private fun loadNoteForOpen(
        uri: Uri,
        relative: String?,
        externalIntentFlags: Int?,
        externalCaller: ExternalIntentCaller,
        onExtractedPortable: ((Note) -> Unit)? = null,
    ): Note {
        if (externalIntentFlags == null) return loadNoteForOpen(uri, relative, onExtractedPortable)
        // External Intents must prove their own live caller grant; never manufacture
        // access from persisted SAF folder trees or untrusted app-private paths.
        return loadResolvedNoteForOpen(uri, uri, relative, externalIntentFlags, externalCaller, onExtractedPortable)
    }

    private fun loadResolvedNoteForOpen(
        target: Uri,
        originalUri: Uri,
        relative: String?,
        externalIntentFlags: Int?,
        externalCaller: ExternalIntentCaller,
        onExtractedPortable: ((Note) -> Unit)? = null,
    ): Note {
        val existing = readState().tabs.find { it.uri?.let { raw -> sameDocumentUri(raw, originalUri.toString()) } == true }
        // Reopening an existing draft must still validate its grant,
        // but must never reload older disk bytes over its edits.
        if (existing != null) {
            val verifyStream = if (externalIntentFlags != null) {
                ExternalDocumentEntryGuard.openVerifiedExternalInputStream(app, resolver, target, externalIntentFlags, externalCaller)
            } else {
                resolver.openInputStream(target) ?: error("Document permission is unavailable; choose it again")
            }
            verifyStream.use { }
            val keepExistingUri = existing.uri != null &&
                DocumentsContract.isTreeUri(target) &&
                documentAccess.resolveReadAccess(target) is SafReadAccess.PendingTreeMembership
            return existing.copy(
                uri = if (keepExistingUri) existing.uri else target.toString(),
                relative = relative ?: existing.relative,
            )
        }
        val inputStream = if (externalIntentFlags != null) {
            ExternalDocumentEntryGuard.openVerifiedExternalInputStream(app, resolver, target, externalIntentFlags, externalCaller)
        } else {
            resolver.openInputStream(target) ?: error("Document permission is unavailable; choose it again")
        }
        return inputStream.use { stream ->
            val name = resolveDisplayName(target) ?: relative?.substringAfterLast('/')?.takeIf(String::isNotBlank) ?: "Note.md"
            val buffered = stream.buffered()
            buffered.mark(65536)
            val prefix = ByteArray(32768); val count = buffered.read(prefix); buffered.reset()
            val header = if (count > 0) String(prefix, 0, count, Charsets.UTF_8).trimStart('\uFEFF', ' ', '\n', '\r', '\t') else ""
            val portable = portableGzipHeader(prefix.copyOfRange(0, maxOf(count, 0))) || portableEnvelopeHeader(header)
            if (portable) {
                val opened = media.openFmd(buffered)
                Note(name = name, uri = target.toString(), content = opened.markdown, saved = opened.markdown, relative = relative, assetDirectory = opened.directory)
                    .also { recordPortableBaseline(it.id, opened.directory); onExtractedPortable?.invoke(it) }
            } else {
                val content = readLimited(buffered, 20_000_000).toString(Charsets.UTF_8).removePrefix("\uFEFF")
                Note(name = name, uri = target.toString(), content = content, saved = content, relative = relative)
            }
        }
    }

    fun retainOpenedNote(note: Note, activate: Boolean, headingFragment: String? = null): String {
        val existing = readState().tabs.find { it.uri != null && note.uri != null && sameDocumentUri(it.uri, note.uri) }
        val targetId = existing?.id ?: note.id
        val jump = headingFragment?.takeIf { it.isNotBlank() }?.let { PendingHeadingJump(targetId, it, UUID.randomUUID().toString()) }
        changeState { state ->
            state.copy(
                tabs = if (existing != null) state.tabs.map { if (it.id == existing.id) it.copy(uri = note.uri, relative = note.relative ?: it.relative) else it } else state.tabs + note,
                activeId = if (activate) targetId else state.activeId,
                pendingHeading = if (activate) jump else state.pendingHeading,
            )
        }
        readState().tabs.firstOrNull { it.id == targetId }?.let(rememberNote)
        return targetId
    }

    suspend fun openNoteInternal(
        uri: Uri,
        relative: String? = null,
        headingFragment: String? = null,
        scheduleDirtyAutosave: Boolean = false,
        alwaysReportError: Boolean = false,
        errorPrefix: String = "Could not open note",
        externalIntentFlags: Int? = null,
        externalCaller: ExternalIntentCaller = ExternalIntentCaller(),
        request: Long = openRequests.begin(),
    ): JSONObject {
        val requestedHeading = headingFragment?.trim()?.takeIf { it.isNotEmpty() }
        val wasBlockedInitially = writeIsBlocked(uri.toString()) ||
            readState().tabs.any { it.uri != null && sameDocumentUri(it.uri, uri.toString()) && writeIsBlocked(it.uri) }
        var newlyExtractedNote: Note? = null
        try {
            val (note, writeOpenState) = withContext(Dispatchers.IO) {
                var loaded = loadNoteForOpen(uri, relative, externalIntentFlags, externalCaller) { newlyExtractedNote = it }
                val loadedUriStr = loaded.uri
                val parsedLoaded = loadedUriStr?.let(Uri::parse)
                val wasBlocked = wasBlockedInitially || writeIsBlocked(uri.toString()) || (loadedUriStr != null && writeIsBlocked(loadedUriStr))
                if (parsedLoaded == null || !parsedLoaded.scheme.equals("content", ignoreCase = true)) {
                    loaded to DocumentWriteOpenState.UNCHANGED
                } else if (wasBlocked) {
                    val callerAllowsWrite = externalIntentFlags == null ||
                        (externalIntentFlags and Intent.FLAG_GRANT_WRITE_URI_PERMISSION) != 0
                    val writeTarget = if (externalIntentFlags == null) documentAccess.resolve(parsedLoaded, writing = true) else parsedLoaded
                    val candidateVerified = callerAllowsWrite &&
                        documentAccess.hasWriteGrant(writeTarget) &&
                        runCatching { resolver.openFileDescriptor(writeTarget, "rw")?.use { true } == true }.getOrDefault(false)
                    if (candidateVerified) {
                        if (writeTarget.toString() != loadedUriStr) loaded = loaded.copy(uri = writeTarget.toString())
                        loaded to DocumentWriteOpenState.RESTORED
                    } else {
                        val fallbackLoadedVerified = externalIntentFlags == null &&
                            writeTarget != parsedLoaded &&
                            callerAllowsWrite &&
                            documentAccess.hasWriteGrant(parsedLoaded) &&
                            runCatching { resolver.openFileDescriptor(parsedLoaded, "rw")?.use { true } == true }.getOrDefault(false)
                        loaded to if (fallbackLoadedVerified) DocumentWriteOpenState.RESTORED else DocumentWriteOpenState.BLOCKED
                    }
                } else {
                    val ownShareAuthority = "${app.packageName}.share"
                    val writeTarget = if (externalIntentFlags == null) documentAccess.resolve(parsedLoaded, writing = true) else parsedLoaded
                    if (externalIntentFlags == null && documentAccess.hasWriteGrant(writeTarget) && writeTarget.toString() != loadedUriStr) {
                        val writeVerified = runCatching { resolver.openFileDescriptor(writeTarget, "rw")?.use { true } == true }.getOrDefault(false)
                        if (writeVerified) {
                            loaded = loaded.copy(uri = writeTarget.toString())
                            loaded to DocumentWriteOpenState.UNCHANGED
                        } else {
                            val loadedWritable = documentAccess.hasWriteGrant(parsedLoaded) &&
                                runCatching { resolver.openFileDescriptor(parsedLoaded, "rw")?.use { true } == true }.getOrDefault(false)
                            loaded to if (parsedLoaded.authority != ownShareAuthority && !loadedWritable) DocumentWriteOpenState.BLOCKED else DocumentWriteOpenState.UNCHANGED
                        }
                    } else {
                        val effectiveWriteTarget = if (documentAccess.hasWriteGrant(writeTarget)) writeTarget else parsedLoaded
                        val readOnlyOrUnconfirmedGrant = parsedLoaded.authority != ownShareAuthority &&
                            documentAccess.hasAnyReadOrPendingGrant(parsedLoaded) &&
                            !documentAccess.hasWriteGrant(effectiveWriteTarget)
                        loaded to if (readOnlyOrUnconfirmedGrant) DocumentWriteOpenState.BLOCKED else DocumentWriteOpenState.UNCHANGED
                    }
                }
            }
            when (writeOpenState) {
                DocumentWriteOpenState.RESTORED -> { clearDocumentAccessFailure(uri.toString()); note.uri?.let(clearDocumentAccessFailure) }
                DocumentWriteOpenState.BLOCKED -> { markDocumentWriteBlocked(uri.toString()); note.uri?.let(markDocumentWriteBlocked) }
                DocumentWriteOpenState.UNCHANGED -> Unit
            }
            if (!openRequests.isCurrent(request)) {
                retainOpenedNote(note, activate = false)
                return JSONObject().put("opened", false)
            }
            var openedTabId: String? = null
            val accepted = performCurrentReaderBarrier { currentActiveId ->
                if (scheduleDirtyAutosave) {
                    readState().tabs.firstOrNull { it.id == currentActiveId }?.takeIf { it.dirty && it.uri != null }?.let { scheduleAutosave(it.id) }
                }
                val activate = openRequests.isCurrent(request)
                val carriedHeading = requestedHeading ?: note.uri?.let { targetUri ->
                    pendingAccessHeadings.keys.firstOrNull { key -> sameDocumentUri(key, targetUri) }?.let(pendingAccessHeadings::remove)
                }
                openedTabId = retainOpenedNote(note, activate = activate, headingFragment = carriedHeading?.takeIf { activate && it.isNotBlank() })
                if (writeOpenState == DocumentWriteOpenState.RESTORED) {
                    openedTabId?.let { id -> if (readState().tabs.firstOrNull { it.id == id }?.dirty == true) scheduleAutosave(id) }
                }
            }
            if (!accepted || openedTabId == null) {
                if (!openRequests.isCurrent(request)) retainOpenedNote(note, activate = false) else readerBarrierFailed()
                return JSONObject().put("opened", false)
            }
            return JSONObject().put("opened", true).put("id", openedTabId).put("uri", note.uri ?: uri.toString())
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Exception) {
            if (wasBlockedInitially) markDocumentWriteBlocked(uri.toString())
            if (!alwaysReportError && !openRequests.isCurrent(request)) return JSONObject().put("opened", false)
            val msg = if (isDocumentAccessFailure(error)) {
                if (requestedHeading != null) pendingAccessHeadings[uri.toString()] = requestedHeading
                requestDocumentAccess(uri.toString(), readState().tabs.firstOrNull { it.uri?.let { raw -> sameDocumentUri(raw, uri.toString()) } == true }, false, true)
            } else {
                "$errorPrefix: ${error.message}".also(fail)
            }
            return JSONObject().put("opened", false).put("message", msg)
        } finally {
            val extracted = newlyExtractedNote
            val extractedDir = extracted?.assetDirectory
            if (extracted != null && extractedDir != null && readState().tabs.none { it.id == extracted.id && it.assetDirectory == extractedDir }) {
                withContext(NonCancellable) {
                    recordPortableBaseline(extracted.id, null)
                    cleanupPortableDirectories(setOf(extractedDir))
                }
            }
        }
    }

    fun open(uri: Uri, relative: String? = null, pendingHeading: String? = null): Job =
        openDocument(uri, relative, pendingHeading)
}
