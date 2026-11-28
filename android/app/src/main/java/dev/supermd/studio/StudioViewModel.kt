package dev.supermd.studio

import android.app.Application
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import android.util.Base64
import androidx.documentfile.provider.DocumentFile
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean

// SAF documents can be shared by independent Android activities. Serialize
// comparison, staging, write and saved-state updates across those windows.
private val documentWrites = Mutex()
private val activeStudioViewModels: MutableSet<StudioViewModel> =
    java.util.Collections.synchronizedSet(java.util.Collections.newSetFromMap(java.util.WeakHashMap()))

private fun liveStudioViewModels(current: StudioViewModel): List<StudioViewModel> =
    synchronized(activeStudioViewModels) {
        val app = current.getApplication<Application>()
        val snapshot = activeStudioViewModels.filter {
            !it.viewModelRetired.get() && it.getApplication<Application>() === app
        }
        if (snapshot.any { it === current } || current.viewModelRetired.get()) snapshot else snapshot + current
    }

internal data class UriRemap(
    val oldUri: String,
    val newUri: String,
    val newName: String? = null,
    val newRelative: String? = null,
)

data class Note(val id: String = UUID.randomUUID().toString(), val name: String = "Untitled.md", val uri: String? = null, val content: String = "", val saved: String = "", val relative: String? = null, val assetDirectory: String? = null, val assetsDirty: Boolean = false) {
    val dirty get() = content != saved || assetsDirty
    val portable get() = assetDirectory != null
    val requiresCloseConfirmation get() = if (uri == null) (content.isNotBlank() || assetsDirty) && dirty else dirty
}
private class ExternalConflictDetectedException : RuntimeException()
internal data class OpenDocumentTarget(
    val uri: Uri,
    val externalIntentFlags: Int? = null,
    val externalCaller: ExternalIntentCaller = ExternalIntentCaller(),
)
internal const val MAX_AGENT_SNAPSHOT_BYTES = 2 * 1024 * 1024
internal enum class PortableSaveRecovery { ORIGINAL_INTACT, RESTORE_OUR_WRITE, LEAVE_CONCURRENT_BYTES }
internal fun agentContentRevision(content: String): String = java.security.MessageDigest.getInstance("SHA-256")
    .digest(content.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
internal fun portableAssetsMatch(left: JSONObject, right: JSONObject): Boolean =
    left.length() == right.length() && left.keys().asSequence().all { key -> left.optString(key) == right.optString(key) }
internal fun portableSaveSnapshotMatches(note: Note, expectedRevision: String, diskMarkdown: String, currentAssets: JSONObject, diskAssets: JSONObject): Boolean =
    agentContentRevision(note.content).equals(expectedRevision, ignoreCase = true) && diskMarkdown == note.saved && portableAssetsMatch(currentAssets, diskAssets)
internal fun portableSaveRecovery(current: ByteArray, original: ByteArray, staged: ByteArray): PortableSaveRecovery = when {
    current.contentEquals(original) -> PortableSaveRecovery.ORIGINAL_INTACT
    current.contentEquals(staged) -> PortableSaveRecovery.RESTORE_OUR_WRITE
    else -> PortableSaveRecovery.LEAVE_CONCURRENT_BYTES
}
internal fun matchesAssetWriteSnapshot(current: Note?, activeId: String, expected: Note, requireActive: Boolean = true): Boolean =
    current != null && current.id == expected.id && (!requireActive || activeId == expected.id)
        && current.content == expected.content && current.saved == expected.saved
        && current.uri == expected.uri && current.assetDirectory == expected.assetDirectory && current.portable == expected.portable
data class RecentNote(val name: String, val uri: String, val relative: String? = null, val pinned:Boolean=false)
internal fun orderedRecents(notes:List<RecentNote>)=notes.distinctBy {it.uri}.sortedByDescending {it.pinned}.take(10)
private fun renamedRelative(relative:String?,name:String)=relative?.let {val parent=it.substringBeforeLast('/',"");if(parent.isEmpty())name else "$parent/$name"}
data class FileEntry(val name: String, val uri: String, val directory: Boolean, val relative: String)
data class OutlineHeading(val id: String, val title: String, val level: Int, val offset: Int)
private val EMPTY_NOTE = Note(id = "", name = "Super MD", content = "", saved = "")
data class StudioState(val latexAutofix:Boolean=false, val typewriterScroll:Boolean=false, val selectionAssistant:String="chatgpt", val centerLock:Boolean=true, val customTheme:String="", val activeThemeKind:String="builtin", val activeThemeId:String="", val customThemeSource:String="", val savedThemes:List<SavedThemeEntry> = emptyList(), val patternKind:String="", val patternOpacity:Float=-1f, val patternSize:Float=0f, val patternSpacing:Float=0f, val restorePosition:Boolean=true, val fullDocumentAccessibility:Boolean=false, val startup:String="restore", val imageAppearance:String="original", val svgAppearance:String="original", val imageContrast:Float=1.25f, val spellCheck:Boolean = false, val grammarCheck:Boolean = false, val accent: String = "system", val widthPercent: Float = 100f, val lineHeight: Float = 1.65f, val autosave: Boolean = true, val customFonts: List<String> = emptyList(), val readerOverlay: Boolean = false, val editorFocused: Boolean = false, val zoomCommand: Long = 0, val tabs: List<Note> = listOf(Note(name = "Welcome.md", content = sample, saved = sample)), val closedTabs: List<Note> = emptyList(), val activeId: String = "", val mode: String = "live", val fullscreen: Boolean = false, val normalZoom: Float = 100f, val fullscreenZoom: Float = 100f, val theme: String = "system", val fullscreenTheme: String = "black", val motion: Boolean = true, val font: String = "Manrope", val size: Float = 15f, val folder: String? = null, val folderRelative: String = "", val files: List<FileEntry> = emptyList(), val busy: Boolean = false, val message: String? = null, val error: String? = null, val welcomed: Boolean = false, val pdf: String = "{\"pageSize\":\"a4\",\"margin\":14,\"fontSize\":10.5,\"lineHeight\":1.5,\"paragraphSpacing\":0.65,\"fontFamily\":\"Manrope\",\"pageNumbers\":true}", val storageReport: StorageReport? = null, val storageScanning: Boolean = false, val conflictedTabIds: Set<String> = emptySet(), val blockedWriteUris: Set<String> = emptySet(), val pendingCloseNoteId: String? = null, val pendingSaveConflictNoteId: String? = null, val pendingHeading: PendingHeadingJump? = null, val folderAccessPrompt: WorkspaceFolderPrompt? = null) {
    val active get() = tabs.find { it.id == activeId } ?: tabs.firstOrNull() ?: EMPTY_NOTE
    val zoom get() = if (fullscreen) fullscreenZoom else normalZoom
    val activeConflicted get() = active.id.isNotEmpty() && active.id in conflictedTabIds
    val pendingCloseNote get() = pendingCloseNoteId?.let { id -> tabs.find { it.id == id } }
    val pendingSaveConflictNote get() = pendingSaveConflictNoteId?.let { id -> tabs.find { it.id == id } }
    fun writeNeedsAccess(id: String): Boolean {
        if (blockedWriteUris.isEmpty()) return false
        val uri = tabs.firstOrNull { it.id == id }?.uri ?: return false
        val parsed = Uri.parse(uri)
        return blockedWriteUris.any { sameDocument(Uri.parse(it), parsed) }
    }
}
val sample = """
# A clear place to think

> [!TIP] Try it, then explain it
> Your notes stay portable. Open any folder, use live or source mode, and export a properly typeset PDF offline.

## Mathematics

Inline ${'$'}e^{i\pi}+1=0${'$'} and a full display equation:

${'$'}${'$'}
\begin{pmatrix}1&2\\3&4\end{pmatrix}\qquad\int_0^1 x^2\,dx=\frac13
${'$'}${'$'}

| Topic | Formula |
|---|---|
| Gaussian | ${'$'}e^{-x^2}${'$'} |
| Circle | ${'$'}\pi r^2${'$'} |

```smd-chart
{"title":"Explore a sine wave","x":{"min":-6.28,"max":6.28},"series":[{"expression":"a * Math.sin(x)"}],"sliders":[{"name":"a","label":"Amplitude","min":0.1,"max":3,"step":0.05,"value":1}]}
```

```mermaid
flowchart LR
  Read --> Explore --> Understand
```

## Local Matplotlib

Press Run to execute this code on your device. Nothing runs automatically when opening or exporting a note.

```python
import numpy as np
import matplotlib.pyplot as plt
x = np.linspace(-4, 4, 200)
plt.plot(x, np.exp(-x*x), color="#42669e")
plt.title("Gaussian")
plt.grid(alpha=.2)
```
""".trimIndent()

fun reorderedNotes(notes: List<Note>, id: String, index: Int): List<Note> {
    val source = notes.indexOfFirst { it.id == id }
    if (source < 0 || index !in notes.indices || source == index) return notes
    return notes.toMutableList().apply { add(index, removeAt(source)) }
}

class StudioViewModel(app: Application, val workspaceKey: String = "main") : AndroidViewModel(app) {
    private val prefs = app.getSharedPreferences("studio", 0)
    private val confirmedTreeDocumentKeys = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()
    private fun isConfirmedTreeChild(treeUri: Uri, documentId: String): Boolean {
        val rootId = runCatching { DocumentsContract.getTreeDocumentId(treeUri) }.getOrNull()
        if (rootId != null && documentId == rootId) return true
        val key = DocumentsContract.buildDocumentUriUsingTree(treeUri, documentId).toString()
        return key in confirmedTreeDocumentKeys ||
            runCatching { mutable.value.files.any { !it.directory && it.uri == key } }.getOrDefault(false)
    }
    internal var documentAccess = DocumentAccess(
        context = app,
        activeFolderUriProvider = { runCatching { mutable.value.folder?.let(Uri::parse) }.getOrNull() },
        relativeHintProvider = { target ->
            runCatching {
                mutable.value.tabs.firstOrNull { it.uri != null && !it.relative.isNullOrEmpty() && sameDocument(Uri.parse(it.uri), target) }?.relative
                    ?: recentMutable.value.firstOrNull { !it.relative.isNullOrEmpty() && sameDocument(Uri.parse(it.uri), target) }?.relative
            }.getOrNull()
        },
        isConfirmedTreeChildProvider = ::isConfirmedTreeChild,
        onConfirmedTreeKeys = { keys -> confirmedTreeDocumentKeys.addAll(keys) },
    )
    internal var workspaceLinks = WorkspaceLinkCache(ContentResolverTreeLister(app))
    private val accessRequestsMutable = MutableStateFlow<DocumentAccessRequest?>(null)
    val documentAccessRequests = accessRequestsMutable.asStateFlow()
    private val blockedDocumentWrites: MutableSet<String> = java.util.Collections.synchronizedSet(linkedSetOf())
    private val documentAccessClearSeq = java.util.concurrent.atomic.AtomicLong(0L)
    private val promptedDocumentAccess = mutableSetOf<String>()
    private val promptedAssetAccess = mutableSetOf<String>()
    private val pendingAccessHeadings = java.util.concurrent.ConcurrentHashMap<String, String>()
    internal val readerFolderIndex = ReaderFolderIndex()
    private val readerCapabilities = java.util.concurrent.CopyOnWriteArraySet<ReaderAssetCapabilities>()
    internal fun attachReaderCapabilities(capabilities: ReaderAssetCapabilities) = readerAssetCoordinator.attachReaderCapabilities(capabilities)
    internal fun detachReaderCapabilities(capabilities: ReaderAssetCapabilities) = readerAssetCoordinator.detachReaderCapabilities(capabilities)
    internal fun invalidateNoteAssets(noteId: String) = readerAssetCoordinator.invalidateNoteAssets(noteId)
    internal fun invalidateAllNoteAssets() = readerAssetCoordinator.invalidateAllNoteAssets()
    internal fun matchesReaderAssetNote(noteId: String, target: ReaderAssetTarget? = null): Boolean =
        readerAssetCoordinator.matchesReaderAssetNote(noteId, target)
    var assetAccessRestored: ((String, String) -> Unit)? = null
    fun retainDocumentAccess(uri: Uri) = documentAccess.persist(uri)
    fun dismissDocumentAccess() { accessRequestsMutable.value = null }
    private fun linkedAssetUri(note: Note, source: String): Uri? = readerAssetCoordinator.linkedAssetUri(note, source)
    private fun rememberLinkedAsset(note: Note, source: String, uri: Uri) = readerAssetCoordinator.rememberLinkedAsset(note, source, uri)
    internal fun reportLinkedAssetFailure(document: String, source: String, error: Throwable): Boolean {
        if (!isDocumentAccessFailure(error)) return false
        val note = mutable.value.tabs.firstOrNull { it.id == document || it.uri?.let { uri -> sameDocumentUri(uri, document) } == true } ?: return false
        clearPendingPortableWriteState()
        val key = "${note.id}\n$source"
        if (accessRequestsMutable.value == null && promptedAssetAccess.add(key)) {
            accessRequestsMutable.value = DocumentAccessRequest(note.uri ?: note.id, Uri.decode(source).substringAfterLast('/'), note.id, false, assetSource = source)
            mutable.value = mutable.value.copy(busy = false, message = LINKED_ASSET_ACCESS_MESSAGE)
        } else mutable.value = mutable.value.copy(busy = false)
        return true
    }
    private fun sameDocumentUri(left: String, right: String) = sameDocument(Uri.parse(left), Uri.parse(right))
    private fun blockedWritesSnapshot(): Set<String> = synchronized(blockedDocumentWrites) { LinkedHashSet(blockedDocumentWrites) }
    private fun syncBlockedWriteState() {
        val snapshot = blockedWritesSnapshot()
        if (mutable.value.blockedWriteUris != snapshot) {
            mutable.value = mutable.value.copy(blockedWriteUris = snapshot)
        }
    }
    private fun markDocumentWriteBlocked(uri: String) {
        synchronized(blockedDocumentWrites) {
            if (blockedDocumentWrites.none { sameDocumentUri(it, uri) }) {
                blockedDocumentWrites.add(uri)
            }
        }
        syncBlockedWriteState()
    }
    private fun writeIsBlocked(uri: String) = synchronized(blockedDocumentWrites) {
        blockedDocumentWrites.any { sameDocumentUri(it, uri) }
    }
    internal fun clearDocumentAccessFailure(uri: String) {
        documentAccessClearSeq.incrementAndGet()
        synchronized(blockedDocumentWrites) {
            blockedDocumentWrites.removeAll { sameDocumentUri(it, uri) }
        }
        promptedDocumentAccess.removeAll { sameDocumentUri(it, uri) }
        syncBlockedWriteState()
    }
    private fun requestDocumentAccess(uri: String, note: Note?, writing: Boolean, explicit: Boolean = false): String {
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
        mutable.value = if (!alreadyPrompted || explicit) {
            mutable.value.copy(busy = false, blockedWriteUris = blockedSnapshot, message = DOCUMENT_ACCESS_MESSAGE)
        } else {
            mutable.value.copy(busy = false, blockedWriteUris = blockedSnapshot)
        }
        return DOCUMENT_ACCESS_MESSAGE
    }
    fun requestWriteAccessIfBlocked(id: String, explicit: Boolean = false): Boolean {
        val note = mutable.value.tabs.firstOrNull { it.id == id } ?: return false
        val uri = note.uri ?: return false
        if (!writeIsBlocked(uri)) return false
        requestDocumentAccess(uri, note, writing = true, explicit = explicit)
        return true
    }
    fun documentWriteNeedsAccess(id: String): Boolean {
        val current = mutable.value
        return current.writeNeedsAccess(id) || current.tabs.firstOrNull { it.id == id }?.uri?.let(::writeIsBlocked) == true
    }
    private fun resolveVerifiedWriteDestination(source: Uri): Uri {
        val candidate = documentAccess.resolve(source, writing = true)
        if (!DocumentsContract.isTreeUri(candidate) || (documentAccess.hasTreeScopedWriteGrant(candidate) && documentAccess.hasWriteGrant(candidate))) {
            return candidate
        }
        if (DocumentsContract.isTreeUri(source) &&
            documentAccess.confirmEmbeddedTreeMembershipIfWritable(candidate) &&
            documentAccess.hasTreeScopedWriteGrant(candidate) &&
            documentAccess.hasWriteGrant(candidate)
        ) {
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
    internal fun reportDocumentSaveFailure(id: String, error: Throwable, fallback: String): String {
        val note = mutable.value.tabs.firstOrNull { it.id == id }
        return if (isDocumentAccessFailure(error) && note?.uri != null) requestDocumentAccess(note.uri, note, writing = true)
        else { fail(fallback); fallback }
    }
    internal fun reportDocumentRenameFailure(id: String, error: Throwable, showGlobalError: Boolean = true): String {
        val note = mutable.value.tabs.firstOrNull { it.id == id }
        if (isDocumentAccessFailure(error) && note?.uri != null) {
            return requestDocumentAccess(note.uri, note, writing = true, explicit = true)
        }
        val msg = error.message ?: "Could not rename note"
        if (showGlobalError) fail("Could not rename note: $msg")
        return msg
    }
    fun restoreDocumentAccess(request: DocumentAccessRequest, chosen: Uri) = viewModelScope.launch {
        val wasBlockedBeforeRestore = writeIsBlocked(request.uri) || writeIsBlocked(chosen.toString())
        try {
            if (request.assetSource != null) {
                val note = mutable.value.tabs.firstOrNull { it.id == request.noteId } ?: error("The note is no longer open")
                require(sameDocumentUri(note.uri ?: note.id, request.uri)) { "The note's destination changed; its draft was left intact." }
                withContext(Dispatchers.IO) {
                    documentAccess.persist(chosen)
                    val name = DocumentFile.fromSingleUri(getApplication(), chosen)?.name
                    require(name == request.name) { "Choose ${request.name}; the selected file has a different name." }
                    resolver.openFileDescriptor(chosen, "r")?.use { } ?: error("Android did not grant read access")
                }
                rememberLinkedAsset(note, request.assetSource, chosen)
                promptedAssetAccess.remove("${note.id}\n${request.assetSource}")
                invalidateNoteAssets(note.id)
                accessRequestsMutable.value = null
                mutable.value = mutable.value.copy(message = "Linked file access restored. You can retry the export.")
                assetAccessRestored?.invoke(note.uri ?: note.id, request.assetSource)
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
            val note = mutable.value.tabs.firstOrNull { it.id == request.noteId }
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
                val currentActiveId = mutable.value.active.id
                var barrierRejected = false
                if (shouldActivate && currentActiveId.isNotEmpty() && currentActiveId != note.id) {
                    val accepted = performReaderBarrier(currentActiveId) {
                        change { state ->
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
                        change { state -> state.copy(tabs = state.tabs.map { if (it.id == note.id) it.copy(uri = updatedNoteUri) else it }) }
                    }
                } else {
                    change { state ->
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
                mutable.value.tabs.firstOrNull { it.id == note.id }?.let(::remember)
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
                open(resolved, pendingHeading = carriedHeading)
            }
        } catch (cancelled: kotlinx.coroutines.CancellationException) { throw cancelled }
        catch (error: Exception) {
            if (request.writing || wasBlockedBeforeRestore) {
                markDocumentWriteBlocked(request.uri)
            }
            val detail = if (isDocumentAccessFailure(error)) "This file is still read-only. Your draft is safe; choose the original file with write access or save a copy." else error.message ?: "Access could not be restored"
            accessRequestsMutable.value = request.copy(detail = detail)
        }
    }
    private val windowPrefs = app.getSharedPreferences("studio-window-$workspaceKey", 0)
    private val themesDir = File(app.filesDir, "themes")
    internal var themeValidator: (String) -> String = { PdfEngine.validateTheme(it) }
    internal var bundledThemeReader: ((BundledThemePreset) -> String)? = null
    internal var isObservingCustomTheme: Boolean = false
        private set
    val media = MediaStorage(app)
    val fonts = FontLibrary(app)
    val updates = AppUpdates(app)
    private fun loadRecent()=runCatching { val list=JSONArray(prefs.getString("recent","[]"));orderedRecents((0 until minOf(list.length(),100)).map {i->val n=list.getJSONObject(i);RecentNote(n.getString("name"),n.getString("uri"),n.optString("relative").takeIf {it.isNotBlank()},n.optBoolean("pinned"))}) }.getOrDefault(emptyList())
    private val recentMutable = MutableStateFlow(loadRecent())
    val recent = recentMutable.asStateFlow()
    data class PortableWriteRequest(
        val save: Boolean,
        val noteId: String,
        val localAssets: List<String> = emptyList(),
    )
    var requestPortable: (() -> Unit)? = null
    var requestSaveAs: ((Note) -> Unit)? = null
    var requestPortableWrite: ((PortableWriteRequest) -> Boolean)? = null
    private val savedPortableAssets = java.util.concurrent.ConcurrentHashMap<String, JSONObject>()
    private var closeAfterSaveNoteId: String? = null
    private var portableForceOverwrite = false
    private var portableSaveAsNoteId: String? = null
    private fun recordPortableBaseline(id: String, directory: String?) {
        if (directory == null) savedPortableAssets.remove(id)
        else runCatching { media.portableAssets(directory) }.getOrNull()?.let { savedPortableAssets[id] = it }
    }
    private fun baselinePortableAssets(note: Note): JSONObject =
        savedPortableAssets[note.id] ?: runCatching { media.portableAssets(note.assetDirectory) }.getOrDefault(JSONObject()).also {
            if (note.assetDirectory != null && !note.assetsDirty) savedPortableAssets[note.id] = it
        }
    private fun diskMatchesBaseline(target: Uri, note: Note, baselineAssets: JSONObject? = null): Boolean =
        if (note.portable) {
            val expectedAssets = baselineAssets ?: baselinePortableAssets(note)
            resolver.openInputStream(target)?.use { stream ->
                media.portableEnvelopeMatches(stream, note.saved, expectedAssets)
            } ?: error("Cannot read the current portable note")
        } else {
            val current = resolver.openInputStream(target)?.use { readLimited(it, 20_000_000).toString(Charsets.UTF_8).removePrefix("\uFEFF") }
                ?: error("Cannot read the current note")
            current == note.saved.removePrefix("\uFEFF")
        }
    fun markAssetsDirty(id: String) {
        change { s -> s.copy(tabs = s.tabs.map { if (it.id == id && !it.assetsDirty) it.copy(assetsDirty = true) else it }) }
        scheduleAutosave(id)
    }
    @Volatile internal var readerFlushRequester: (suspend (String) -> Boolean)? = null
    @Volatile internal var readerFlushStatusRequester: (suspend (String) -> ReaderFlushStatus)? = null
    private val readerActionMutex = Mutex()
    private val openRequests = OpenRequestGate()
    private val openIntentDispatcher = OpenIntentDispatcher<OpenDocumentTarget> { left, right -> left.uri == right.uri }
    internal val openDispatcherSessionId: String = java.util.UUID.randomUUID().toString()
    private var initialOpenIntentUri: String? = null
    fun requestOpen(uri: Uri, relative: String? = null) =
        openIntentDispatcher.request(OpenDocumentTarget(uri, externalIntentFlags = null), relative)
    internal fun requestExternalOpen(
        uri: Uri,
        intentFlags: Int,
        caller: ExternalIntentCaller = ExternalIntentCaller(),
    ) = openIntentDispatcher.request(
        OpenDocumentTarget(uri, externalIntentFlags = intentFlags, externalCaller = caller),
    )
    internal fun requestInitialExternalOpen(
        uri: Uri,
        intentFlags: Int,
        caller: ExternalIntentCaller = ExternalIntentCaller(),
    ) {
        val key = uri.toString()
        if (initialOpenIntentUri == key) return
        initialOpenIntentUri = key
        requestExternalOpen(uri, intentFlags, caller)
    }
    internal fun handleExpiredExternalOpenGrant(uri: Uri, initial: Boolean) {
        if (initial) {
            val key = uri.toString()
            if (initialOpenIntentUri == key) return
            initialOpenIntentUri = key
        }
        val existing = mutable.value.tabs.firstOrNull { it.uri?.let { raw -> sameDocumentUri(raw, uri.toString()) } == true }
        requestDocumentAccess(uri.toString(), existing, writing = false, explicit = true)
    }
    internal fun rejectExternalOpen(uri: Uri, reason: String, initial: Boolean) {
        if (initial) {
            val key = uri.toString()
            if (initialOpenIntentUri == key) return
            initialOpenIntentUri = key
        }
        fail("Could not open note: $reason")
    }
    internal fun attachReaderOpenHandler(handler: OpenIntentDispatcher.Handler<OpenDocumentTarget>?) = openIntentDispatcher.attach(handler)
    internal fun detachReaderOpenHandler(handler: OpenIntentDispatcher.Handler<OpenDocumentTarget>) = openIntentDispatcher.detach(handler)
    private suspend fun flushActiveNoteLocked(expectedActiveId: String): Boolean {
        if (mutable.value.tabs.isEmpty() && expectedActiveId.isEmpty()) return true
        if (mutable.value.active.id != expectedActiveId) return false
        val statusRequester = readerFlushStatusRequester
        if (statusRequester != null) {
            val status = try {
                statusRequester.invoke(expectedActiveId)
            } catch (cancelled: kotlinx.coroutines.CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                ReaderFlushStatus.FAILED
            }
            return when (status) {
                ReaderFlushStatus.ACKNOWLEDGED -> mutable.value.active.id == expectedActiveId
                ReaderFlushStatus.WRONG_ACTIVE_NOTE ->
                    // Compose delivers supermdLoad asynchronously after native switches
                    // activeId. When the live reader confirms a different note is still
                    // mounted (with no unacknowledged draft for expectedActiveId) and
                    // native remains authoritative for expectedActiveId, there are no
                    // pending reader edits on expectedActiveId to flush.
                    mutable.value.active.id == expectedActiveId &&
                        readerStateIsNativeAuthoritative(expectedActiveId)
                ReaderFlushStatus.FAILED -> false
            }
        }
        // A missing bridge is not an implicit flush acknowledgement. Only
        // proceed when the native snapshot is already the last acknowledged
        // reader state (for example, before the reader has ever attached).
        val accepted = try {
            readerFlushRequester?.invoke(expectedActiveId)
                ?: readerStateIsNativeAuthoritative(expectedActiveId)
        } catch (cancelled: kotlinx.coroutines.CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            false
        }
        return accepted && mutable.value.active.id == expectedActiveId
    }
    private suspend fun performReaderBarrier(expectedActiveId: String, action: () -> Unit): Boolean = readerActionMutex.withLock {
        if (!flushActiveNoteLocked(expectedActiveId)) return@withLock false
        action()
        true
    }
    private suspend fun performCurrentReaderBarrier(action: (String) -> Unit): Boolean = readerActionMutex.withLock {
        val currentActiveId = mutable.value.active.id
        if (!flushActiveNoteLocked(currentActiveId)) return@withLock false
        action(currentActiveId)
        true
    }
    /** Waits until the reader reflects an already-selected native tab. This is
     * a read/flush acknowledgement only; it never changes focus or retries a
     * document write. */
    internal suspend fun awaitReaderSnapshot(noteId: String, timeoutMillis: Long = 8_000): Boolean =
        kotlinx.coroutines.withTimeoutOrNull(timeoutMillis) {
            while (true) {
                val current = mutable.value
                if (current.activeId != noteId || current.active.id != noteId) return@withTimeoutOrNull false
                val statusRequester = readerFlushStatusRequester
                if (statusRequester != null) {
                    val status = try {
                        statusRequester.invoke(noteId)
                    } catch (cancelled: kotlinx.coroutines.CancellationException) {
                        throw cancelled
                    } catch (_: Exception) {
                        ReaderFlushStatus.FAILED
                    }
                    when (status) {
                        ReaderFlushStatus.ACKNOWLEDGED -> return@withTimeoutOrNull true
                        ReaderFlushStatus.FAILED -> return@withTimeoutOrNull false
                        ReaderFlushStatus.WRONG_ACTIVE_NOTE -> kotlinx.coroutines.delay(40)
                    }
                } else {
                    val acknowledged = try {
                        readerFlushRequester?.invoke(noteId) ?: readerStateIsNativeAuthoritative(noteId)
                    } catch (cancelled: kotlinx.coroutines.CancellationException) {
                        throw cancelled
                    } catch (_: Exception) {
                        false
                    }
                    if (acknowledged) return@withTimeoutOrNull true
                    kotlinx.coroutines.delay(40)
                }
            }
            @Suppress("UNREACHABLE_CODE")
            false
        } == true
    private fun readerBarrierFailed() {
        mutable.value = mutable.value.copy(message = "The reader could not confirm its latest edits. The action was canceled; keep the note open and try again.")
    }
    private fun remember(note: Note) {
        val uri = note.uri ?: return
        storeRecent(listOf(RecentNote(note.name,uri,note.relative,recentMutable.value.any {sameDocumentUri(it.uri,uri)&&it.pinned}))+recentMutable.value.filterNot {sameDocumentUri(it.uri,uri)})
    }
    private fun storeRecent(notes:List<RecentNote>) {
        recentMutable.value=orderedRecents(notes)
        prefs.edit().putString("recent",JSONArray().apply {recentMutable.value.forEach {put(JSONObject().put("name",it.name).put("uri",it.uri).put("relative",it.relative ?: "").put("pinned",it.pinned))}}.toString()).apply()
    }
    fun pinRecent(uri:String)=storeRecent(recentMutable.value.map {if(it.uri==uri)it.copy(pinned=!it.pinned) else it})
    fun clearRecent()=storeRecent(recentMutable.value.filter {it.pinned})
    private val snapshot = if (workspaceKey == "main") File(app.filesDir, "workspace.json") else File(app.filesDir, "workspaces/$workspaceKey.json").also { it.parentFile!!.mkdirs() }
    private val closedNoteStore = ClosedNoteStore(if (workspaceKey == "main") File(app.filesDir, "closed-notes") else File(app.filesDir, "workspaces/$workspaceKey/closed-notes"))
    private var closedNoteIndexError: String? = null
    @Volatile private var closedNoteRefs: List<ClosedNoteReference> = runCatching {closedNoteStore.loadIndexStrict()}
        .onFailure {closedNoteIndexError=it.message}
        .getOrDefault(emptyList())
    private val closingNoteIds = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()
    private val closedNoteMutex = Mutex()
    @Volatile internal var reloadAfterIndexCommitObserver: (suspend () -> Unit)? = null
    @Volatile internal var closedNoteIndexSaveInterceptor: ((List<ClosedNoteReference>) -> Unit)? = null
    private fun saveClosedNoteIndex(references: List<ClosedNoteReference>) {
        closedNoteIndexSaveInterceptor?.invoke(references)
        closedNoteStore.saveIndex(references)
    }
    internal fun currentClosedNoteReferencesForTest(): List<ClosedNoteReference> = closedNoteRefs
    private var listedRelative = ""
    private var listFolderSeq = 0L
    private var listFolderJob: Job? = null
    private val mutable = MutableStateFlow(restore())
    internal val viewModelRetired = AtomicBoolean(false)
    private val recoveryWriter = LatestRecoveryWriter<StudioState, RecoverySnapshotSignature>(
        scope = RecoveryWriterScope.scope,
        debounceMillis = 1_200,
        signature = ::recoverySignature,
        write = { state, commitIfLatest ->
            val temporary = File(snapshot.parentFile, "${snapshot.name}.${UUID.randomUUID()}.tmp")
            try {
                java.io.FileOutputStream(temporary).use { stream ->
                    val writer = stream.bufferedWriter(Charsets.UTF_8)
                    NoteRecovery.write(writer, state)
                    writer.flush()
                    stream.fd.sync()
                }
                commitIfLatest {
                    check(temporary.renameTo(snapshot)) { "Could not replace recovery snapshot" }
                    windowPrefs.edit()
                        .putBoolean("folderMigrated", true)
                        .putString("folder", state.folder)
                        .putString("folderRelative", if (state.folder != null) state.folderRelative else "")
                        .apply()
                }
            } finally {
                temporary.delete()
            }
        },
        onFailure = {
            if (!viewModelRetired.get()) viewModelScope.launch(Dispatchers.Main.immediate) {
                if (!viewModelRetired.get()) mutable.value = mutable.value.copy(
                    error = "Draft recovery could not be saved. The previous recovery snapshot is preserved; please save your note to a file.",
                )
            }
        },
    )
    private val preferencesChanged = android.content.SharedPreferences.OnSharedPreferenceChangeListener { _, key ->
        if(key=="latexAutofix")mutable.value=mutable.value.copy(latexAutofix=prefs.getBoolean("latexAutofix",false))
        if(key=="typewriterScroll")mutable.value=mutable.value.copy(typewriterScroll=prefs.getBoolean("typewriterScroll",false))
        if(key=="selectionAssistant")mutable.value=mutable.value.copy(selectionAssistant=SelectionActions.provider(prefs.getString("selectionAssistant",null)))
        if(key in setOf("customTheme","customThemeSource","savedThemes","activeThemeKind","activeThemeId")){
            mutable.value=themePreferences(mutable.value)
            if(key in setOf("customThemeSource","activeThemeKind"))observeCustomTheme()
        }
        if (key == "recent") {recentMutable.value=loadRecent();observeActive()}
        if(key in setOf("restorePosition","fullDocumentAccessibility","centerLock","startup","imageAppearance","svgAppearance","imageContrast","patternKind","patternOpacity","patternSize","patternSpacing"))mutable.value=readingPreferences(mutable.value)
        if (key in setOf("accent", "theme", "fullTheme", "motion", "font", "size", "pdf", "welcomed", "widthPercent", "lineHeight", "autosave", "fonts", "spellCheck", "grammarCheck")) {
            mutable.value = mutable.value.copy(theme = prefs.getString("theme", "system")!!, fullscreenTheme = prefs.getString("fullTheme", "black")!!, motion = prefs.getBoolean("motion", true), font = prefs.getString("font", "Manrope")!!, size = prefs.getFloat("size", 15f), pdf = prefs.getString("pdf", null) ?: StudioState().pdf, welcomed = prefs.getBoolean("welcomed", false))
                .copy(spellCheck=prefs.getBoolean("spellCheck",false),grammarCheck=prefs.getBoolean("grammarCheck",false),accent = prefs.getString("accent","system")!!, widthPercent = prefs.getFloat("widthPercent",100f),lineHeight = prefs.getFloat("lineHeight",1.65f),autosave = prefs.getBoolean("autosave",true),customFonts = fonts.families)
        }
    }
    private var observedUris=emptySet<String>()
    private var themeJob:Job?=null
    private var themeReloadPending=false
    private val themeObserver=object:android.database.ContentObserver(android.os.Handler(android.os.Looper.getMainLooper())) {
        override fun onChange(selfChange:Boolean){reloadCustomTheme()}
    }
    private fun android.content.SharedPreferences.Editor.clearBackgroundOverrides(): android.content.SharedPreferences.Editor =
        remove("patternKind").remove("patternOpacity").remove("patternSize").remove("patternSpacing")
    private fun migrateLegacyCustomTheme() {
        if (prefs.getBoolean("themeLibraryMigrated", false)) return
        val legacyRaw = prefs.getString("customTheme", "") ?: ""
        val legacySource = prefs.getString("customThemeSource", "") ?: ""
        if (legacyRaw.isNotBlank() && parseSavedThemes(prefs.getString("savedThemes", null), themesDir).isEmpty()) {
            val name = themeDocument(legacyRaw)?.optString("name")?.takeIf { it.isNotBlank() } ?: "Imported theme"
            val id = UUID.randomUUID().toString().replace("-", "")
            runCatching { writeSavedThemeFile(themesDir, id, legacyRaw) }.onSuccess {
                val saved = listOf(SavedThemeEntry(id, name, legacySource))
                prefs.edit()
                    .putBoolean("themeLibraryMigrated", true)
                    .putString("savedThemes", encodeSavedThemes(saved))
                    .putString("activeThemeKind", "saved")
                    .putString("activeThemeId", id)
                    .apply()
                return
            }
        }
        prefs.edit().putBoolean("themeLibraryMigrated", true).apply()
    }
    private fun themePreferences(s: StudioState): StudioState {
        val saved = parseSavedThemes(prefs.getString("savedThemes", null), themesDir)
        val rawTheme = prefs.getString("customTheme", "") ?: ""
        val rawKind = prefs.getString("activeThemeKind", null)
        val rawId = prefs.getString("activeThemeId", "") ?: ""
        val rawSource = prefs.getString("customThemeSource", "") ?: ""
        val (kind, id, source) = when {
            rawTheme.isBlank() -> Triple("builtin", "", "")
            rawKind == "preset" && rawId.isNotBlank() -> Triple("preset", rawId, "")
            rawKind == "saved" && saved.any { it.id == rawId } -> {
                val entry = saved.first { it.id == rawId }
                Triple("saved", entry.id, entry.sourceUri)
            }
            else -> Triple(rawKind ?: "saved", rawId, if (rawKind == "preset") "" else rawSource)
        }
        return s.copy(
            customTheme = rawTheme,
            activeThemeKind = kind,
            activeThemeId = id,
            customThemeSource = source,
            savedThemes = saved,
        )
    }
    private fun openBundledThemeRaw(preset: BundledThemePreset): String {
        bundledThemeReader?.let { return it(preset) }
        return runCatching {
            getApplication<Application>().assets.open(preset.assetPath).use(::readBoundedThemeStream)
        }.getOrElse { error ->
            for (candidate in listOf(
                File("../public/themes/${preset.filename}"),
                File("../../public/themes/${preset.filename}"),
                File("public/themes/${preset.filename}"),
            )) {
                if (candidate.isFile) return candidate.inputStream().use(::readBoundedThemeStream)
            }
            throw error
        }
    }
    private fun linkedAssetGrantUris(): List<String> = runCatching {
        val grants = JSONArray(prefs.getString("linkedAssetGrants", "[]"))
        (0 until minOf(grants.length(), 256)).mapNotNull { grants.optJSONObject(it)?.optString("uri")?.takeIf(String::isNotBlank) }
    }.getOrDefault(emptyList())
    private fun isUriStillReferenced(targetUri: String, remainingThemes: List<SavedThemeEntry>): Boolean {
        if (remainingThemes.any { it.sourceUri.isNotBlank() && sameDocumentUri(it.sourceUri, targetUri) }) return true
        if (mutable.value.tabs.any { it.uri != null && sameDocumentUri(it.uri, targetUri) }) return true
        if (mutable.value.closedTabs.any { it.uri != null && sameDocumentUri(it.uri, targetUri) }) return true
        if (recentMutable.value.any { sameDocumentUri(it.uri, targetUri) }) return true
        if (mutable.value.folder?.let { sameDocumentUri(it, targetUri) } == true) return true
        if (linkedAssetGrantUris().any { sameDocumentUri(it, targetUri) }) return true
        return false
    }
    private fun observeCustomTheme(){
        resolver.unregisterContentObserver(themeObserver)
        isObservingCustomTheme = false
        val kind = prefs.getString("activeThemeKind", "builtin")
        val source = prefs.getString("customThemeSource", null)?.takeIf { it.isNotBlank() }
        if (kind != "preset" && source != null) {
            runCatching {
                resolver.registerContentObserver(Uri.parse(source), true, themeObserver)
                isObservingCustomTheme = true
            }
        }
    }
    fun reloadCustomTheme(){
        if (prefs.getString("activeThemeKind", "builtin") == "preset") return
        val source = prefs.getString("customThemeSource", null)?.takeIf { it.isNotBlank() } ?: return
        if(themeJob?.isActive==true){themeReloadPending=true;return}
        importCustomTheme(Uri.parse(source),false)
    }
    fun resetCustomTheme(){
        themeReloadPending=false
        themeJob?.cancel()
        prefs.edit()
            .remove("customTheme")
            .remove("customThemeSource")
            .putString("activeThemeKind", "builtin")
            .remove("activeThemeId")
            .clearBackgroundOverrides()
            .apply()
        observeCustomTheme()
        mutable.value = themePreferences(readingPreferences(mutable.value))
    }
    suspend fun applyBundledTheme(presetId: String): JSONObject {
        if (presetId == "builtin") {
            resetCustomTheme()
            return JSONObject().put("id", "builtin").put("name", "Built-in appearance")
        }
        val preset = bundledThemes(getApplication<Application>().assets).firstOrNull { it.id == presetId }
            ?: error("Unknown bundled theme")
        themeReloadPending = false
        themeJob?.cancel()
        val canonical = withContext(Dispatchers.IO) {
            validateThemeRaw(openBundledThemeRaw(preset), themeValidator)
        }
        val name = JSONObject(canonical).getString("name")
        prefs.edit()
            .putBoolean("themeLibraryMigrated", true)
            .putString("customTheme", canonical)
            .remove("customThemeSource")
            .putString("activeThemeKind", "preset")
            .putString("activeThemeId", preset.id)
            .clearBackgroundOverrides()
            .apply()
        observeCustomTheme()
        mutable.value = themePreferences(readingPreferences(mutable.value)).copy(message = "Applied $name")
        return JSONObject().put("id", preset.id).put("name", name)
    }
    fun selectBundledTheme(presetId: String) {
        themeReloadPending = false
        themeJob?.cancel()
        themeJob = viewModelScope.launch {
            try {
                applyBundledTheme(presetId)
            } catch (cancelled: kotlinx.coroutines.CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                fail("Theme not applied; previous appearance kept. ${error.message}")
            }
        }
    }
    fun selectSavedTheme(entryId: String) {
        themeReloadPending = false
        themeJob?.cancel()
        themeJob = viewModelScope.launch {
            try {
                val entry = parseSavedThemes(prefs.getString("savedThemes", null), themesDir).firstOrNull { it.id == entryId }
                    ?: error("Saved theme is unavailable")
                val canonical = withContext(Dispatchers.IO) {
                    val file = File(themesDir, "${entry.id}.json")
                    require(file.isFile) { "Saved theme file is missing" }
                    validateThemeRaw(file.inputStream().use(::readBoundedThemeStream), themeValidator)
                }
                val name = JSONObject(canonical).getString("name")
                prefs.edit()
                    .putString("customTheme", canonical)
                    .apply {
                        if (entry.sourceUri.isNotBlank()) putString("customThemeSource", entry.sourceUri)
                        else remove("customThemeSource")
                    }
                    .putString("activeThemeKind", "saved")
                    .putString("activeThemeId", entry.id)
                    .clearBackgroundOverrides()
                    .apply()
                observeCustomTheme()
                mutable.value = themePreferences(readingPreferences(mutable.value)).copy(message = "Applied $name")
            } catch (cancelled: kotlinx.coroutines.CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                fail("Theme not applied; previous appearance kept. ${error.message}")
            }
        }
    }
    fun deleteSavedTheme(entryId: String) {
        val saved = parseSavedThemes(prefs.getString("savedThemes", null), themesDir)
        val removed = saved.firstOrNull { it.id == entryId } ?: return
        val remaining = saved.filterNot { it.id == entryId }
        File(themesDir, "${removed.id}.json").delete()
        val wasActive = prefs.getString("activeThemeKind", null) == "saved" && prefs.getString("activeThemeId", null) == entryId
        if (wasActive) {
            themeReloadPending = false
            themeJob?.cancel()
        }
        prefs.edit()
            .putString("savedThemes", encodeSavedThemes(remaining))
            .apply {
                if (wasActive) {
                    remove("customTheme")
                    remove("customThemeSource")
                    putString("activeThemeKind", "builtin")
                    remove("activeThemeId")
                    clearBackgroundOverrides()
                }
            }
            .apply()
        if (wasActive) observeCustomTheme()
        if (removed.sourceUri.isNotBlank() && !isUriStillReferenced(removed.sourceUri, remaining)) {
            runCatching { resolver.releasePersistableUriPermission(Uri.parse(removed.sourceUri), Intent.FLAG_GRANT_READ_URI_PERMISSION) }
        }
        mutable.value = themePreferences(readingPreferences(mutable.value)).copy(message = "Removed ${removed.name}")
    }
    fun importCustomTheme(uri:Uri,remember:Boolean=true){
        themeJob?.cancel()
        themeJob=viewModelScope.launch {
            if(!remember)delay(250)
            try {
                val canonical=withContext(Dispatchers.IO){
                    val raw = resolver.openInputStream(uri)?.use(::readBoundedThemeStream) ?: error("Cannot read theme")
                    validateThemeRaw(raw, themeValidator)
                }
                val name = JSONObject(canonical).getString("name")
                if (remember) {
                    runCatching { resolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) }
                    val saved = parseSavedThemes(prefs.getString("savedThemes", null), themesDir)
                    val existing = saved.firstOrNull { it.sourceUri.isNotBlank() && sameDocumentUri(it.sourceUri, uri.toString()) }
                    val entryId = existing?.id ?: UUID.randomUUID().toString().replace("-", "")
                    withContext(Dispatchers.IO) { writeSavedThemeFile(themesDir, entryId, canonical) }
                    val updatedSaved = if (existing != null) {
                        saved.map { if (it.id == entryId) SavedThemeEntry(entryId, name, uri.toString()) else it }
                    } else {
                        saved + SavedThemeEntry(entryId, name, uri.toString())
                    }
                    prefs.edit()
                        .putBoolean("themeLibraryMigrated", true)
                        .putString("savedThemes", encodeSavedThemes(updatedSaved))
                        .putString("activeThemeKind", "saved")
                        .putString("activeThemeId", entryId)
                        .putString("customTheme", canonical)
                        .putString("customThemeSource", uri.toString())
                        .clearBackgroundOverrides()
                        .apply()
                    observeCustomTheme()
                    mutable.value = themePreferences(readingPreferences(mutable.value)).copy(message = "Applied $name")
                } else {
                    val changed = canonical != mutable.value.customTheme
                    val activeId = prefs.getString("activeThemeId", "") ?: ""
                    val saved = parseSavedThemes(prefs.getString("savedThemes", null), themesDir)
                    val updatedSaved = if (activeId.isNotBlank() && saved.any { it.id == activeId }) {
                        withContext(Dispatchers.IO) { writeSavedThemeFile(themesDir, activeId, canonical) }
                        saved.map { if (it.id == activeId) it.copy(name = name) else it }
                    } else saved
                    prefs.edit()
                        .putString("customTheme", canonical)
                        .apply { if (updatedSaved != saved) putString("savedThemes", encodeSavedThemes(updatedSaved)) }
                        .clearBackgroundOverrides()
                        .apply()
                    val next = themePreferences(readingPreferences(mutable.value))
                    mutable.value = if (changed) next.copy(message = "Applied $name") else next
                }
            }catch(cancelled:kotlinx.coroutines.CancellationException){throw cancelled}
            catch(error:Exception){val message="Theme not applied; previous appearance kept. ${error.message}";if(remember)fail(message)else mutable.value=mutable.value.copy(message=message)}
        }
        themeJob?.invokeOnCompletion {viewModelScope.launch {if(themeReloadPending){themeReloadPending=false;reloadCustomTheme()}}}
    }
    fun exportCustomTheme(uri:Uri)=viewModelScope.launch {
        val raw=themeForSharing(mutable.value)
        try{withContext(Dispatchers.IO){resolver.openOutputStream(uri,"wt")?.use {it.write(raw.toByteArray(Charsets.UTF_8))}?:error("Cannot write theme")};mutable.value=mutable.value.copy(message="Theme exported. Edit the JSON and import it to apply.")}
        catch(error:Exception){fail("Could not export theme: ${error.message}")}
    }
    private var metadataJob:Job?=null
    fun shareCustomTheme(ready:(Intent)->Unit)=viewModelScope.launch {
        try {
            val raw=themeForSharing(mutable.value)
            val file=withContext(Dispatchers.IO) {
                val folder=File(getApplication<Application>().cacheDir,"share/${UUID.randomUUID()}").apply {mkdirs()}
                File(folder,"Super MD theme.supermd-theme.json").apply {writeText(raw,Charsets.UTF_8)}
            }
            val app=getApplication<Application>()
            val uri=androidx.core.content.FileProvider.getUriForFile(app,"${app.packageName}.share",file)
            ready(Intent(Intent.ACTION_SEND).setType("application/json").putExtra(Intent.EXTRA_STREAM,uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION).apply {clipData=android.content.ClipData.newUri(resolver,file.name,uri)})
        } catch(error:Exception){fail("Could not share theme: ${error.message}")}
    }
    private val deletedDrafts=DeletedDraftStore(File(app.filesDir,"deleted-drafts/$workspaceKey"))
    private val documentObserver=object:android.database.ContentObserver(android.os.Handler(android.os.Looper.getMainLooper())) {
        override fun onChange(selfChange:Boolean){readerFolderIndex.clear();refreshMetadata();refreshExternal()}
        override fun onChange(selfChange:Boolean,uri:Uri?){
            val matchesOpenTab = uri != null && mutable.value.tabs.any { it.uri != null && sameDocumentUri(it.uri, uri.toString()) }
            if (!matchesOpenTab) readerFolderIndex.clear()
            refreshMetadata()
            if (uri == null || matchesOpenTab) refreshExternal(uri)
        }
    }
    private fun observeActive() {
        val uris=(mutable.value.tabs.mapNotNull {it.uri}+recentMutable.value.map {it.uri}+listOfNotNull(mutable.value.folder)).toSet()
        if(uris==observedUris)return
        resolver.unregisterContentObserver(documentObserver);observedUris=uris
        uris.forEach {runCatching{resolver.registerContentObserver(Uri.parse(it),true,documentObserver)}}
    }
    /** Notification-driven SAF updates. A failed query is not proof of deletion. */
    fun refreshMetadata() {
        metadataJob?.cancel()
        workspaceLinks.invalidate()
        metadataJob=viewModelScope.launch {
            delay(200)
            data class CapturedMetadataRefresh(
                val folderSnapshot: String?,
                val relativeSnapshot: String,
                val listSeqSnapshot: Long,
                val result: SafMetadataRefreshResult,
            )
            val captured = withContext(Dispatchers.IO) {
                documentWrites.withLock {
                    kotlinx.coroutines.currentCoroutineContext()[Job]?.let { if (!it.isActive) throw kotlinx.coroutines.CancellationException() }
                    if (viewModelRetired.get()) return@withLock null
                    val beforeIo = mutable.value
                    val folderSnapshot = beforeIo.folder
                    val relativeSnapshot = normalizeRelativePath(beforeIo.folderRelative.ifEmpty { listedRelative })
                    val listSeqSnapshot = listFolderSeq
                    val uris = (beforeIo.tabs.mapNotNull { it.uri } + recentMutable.value.map { it.uri }).distinct()
                    val relativeHints = buildMap {
                        recentMutable.value.forEach { r -> if (!r.relative.isNullOrEmpty()) put(r.uri, r.relative) }
                        beforeIo.tabs.forEach { t -> if (t.uri != null && !t.relative.isNullOrEmpty()) put(t.uri, t.relative) }
                    }
                    val confirmedSnapshot = buildSet {
                        addAll(confirmedTreeDocumentKeys)
                        beforeIo.files.forEach { entry -> canonicalTreeDocumentKey(Uri.parse(entry.uri))?.let(::add) }
                    }
                    CapturedMetadataRefresh(
                        folderSnapshot = folderSnapshot,
                        relativeSnapshot = relativeSnapshot,
                        listSeqSnapshot = listSeqSnapshot,
                        result = refreshSafWorkspaceMetadata(
                            resolver = resolver,
                            documentAccess = documentAccess,
                            uris = uris,
                            relativeHints = relativeHints,
                            folderUriRaw = folderSnapshot,
                            listedRelative = relativeSnapshot,
                            confirmedTreeKeys = confirmedSnapshot,
                        ),
                    )
                }
            } ?: return@launch
            val folderSnapshot = captured.folderSnapshot
            val relativeSnapshot = captured.relativeSnapshot
            val listSeqSnapshot = captured.listSeqSnapshot
            val refreshSnapshot = captured.result
            confirmedTreeDocumentKeys.addAll(refreshSnapshot.confirmedTreeKeys)
            val metadata=refreshSnapshot.metadata
            val removed=metadata.filterValues {it==null}.keys
            removed.forEach { raw ->
                val parsed = Uri.parse(raw)
                canonicalTreeDocumentKey(parsed)?.let(confirmedTreeDocumentKeys::remove)
                confirmedTreeDocumentKeys.removeIf { key -> sameDocument(Uri.parse(key), parsed) }
            }
            val s=mutable.value
            val discarded=s.tabs.filter {it.uri in removed}
            val recovered=discarded.filter {it.dirty}.map {it.copy(name="Recovered ${it.name}",uri=null,saved="")}
            // Archive before closing; a failed write leaves the draft open.
            if(recovered.isNotEmpty()) {
                val archived=withContext(Dispatchers.IO) {runCatching {recovered.forEach(deletedDrafts::save)}}
                if(archived.isFailure){fail("Could not preserve a deleted note's edits. Its draft is still open; save it to another file.");return@launch}
                if(mutable.value!==s){refreshMetadata();return@launch} // Never overwrite edits made during archive I/O.
            }
            discarded.forEach {readerEcho.remove(it.id)}
            val kept=s.tabs.filter {it.uri !in removed}.map {note->metadata[note.uri]?.takeIf {it.isNotBlank()}?.let {note.copy(name=it,relative=renamedRelative(note.relative,it))} ?: note}
            if(discarded.isNotEmpty()||kept!=s.tabs) change {it.copy(tabs=kept.ifEmpty {listOf(Note())},closedTabs=(recovered+it.closedTabs).take(12),message=if(discarded.isNotEmpty())"File deleted. Its tab was closed; unsaved edits remain recoverable in Settings." else "Updated renamed note")}
            val recents=recentMutable.value.filter {it.uri !in removed}.map {note->metadata[note.uri]?.takeIf {it.isNotBlank()}?.let {note.copy(name=it,relative=renamedRelative(note.relative,it))} ?: note}
            if(recents!=recentMutable.value)storeRecent(recents)
            val currentFolder=mutable.value.folder
            if(currentFolder!=null) {
                val currentRelative=normalizeRelativePath(mutable.value.folderRelative.ifEmpty { listedRelative })
                if(currentFolder==folderSnapshot&&currentRelative==relativeSnapshot&&listFolderSeq==listSeqSnapshot&&refreshSnapshot.folderListing!=null) {
                    refreshSnapshot.folderListing.fold(
                        onSuccess = {listing->
                            listedRelative=listing.effectiveRelative
                            if(listing.effectiveRelative!=relativeSnapshot) {
                                windowPrefs.edit().putBoolean("folderMigrated",true).putString("folderRelative",listing.effectiveRelative).apply()
                            }
                            if(mutable.value.folderRelative!=listing.effectiveRelative||mutable.value.files!=listing.entries) {
                                mutable.value=mutable.value.copy(folderRelative=listing.effectiveRelative,files=listing.entries)
                            }
                        },
                        onFailure = {error->fail("Could not list folder: ${error.message}")},
                    )
                } else {
                    listFolder(Uri.parse(currentFolder),currentRelative)
                }
            }
        }
    }
    private val folderSearchController = FolderSearchController(
        app = app,
        scope = viewModelScope,
        media = media,
        documentAccess = documentAccess,
        readState = { mutable.value },
        readRecent = { recentMutable.value },
        flushActiveReader = { activeId ->
            val statusRequester = readerFlushStatusRequester
            if (statusRequester != null) statusRequester.invoke(activeId)
            else readerFlushRequester?.invoke(activeId)
        },
        sameDocumentUri = ::sameDocumentUri,
        onBarrierActiveTab = { id -> performReaderBarrier(id) { } },
        onSelectTab = ::select,
        onOpenUri = { uri, relative -> open(uri, relative) },
    )
    private val folderSearchMutable get() = folderSearchController.folderSearchMutable
    val folderSearch = folderSearchController.state
    private val seededFindMutable get() = folderSearchController.seededFindMutable
    val seededFind = folderSearchController.seededFind
    private var initialFolderLoadJob: Job? = null
    private var startupAccessSeedJob: Job? = null

    init {
        activeStudioViewModels.add(this)
        listedRelative = mutable.value.folderRelative
        val restoredFromSnapshot = snapshot.exists()
        mutable.value.tabs.filter { it.portable && it.uri != null && !it.assetsDirty }.forEach { recordPortableBaseline(it.id, it.assetDirectory) }
        prefs.registerOnSharedPreferenceChangeListener(preferencesChanged)
        observeActive()
        observeCustomTheme()
        migrateLegacyClosedNotes()
        val initialFolderJob = mutable.value.folder?.let { listFolder(Uri.parse(it), mutable.value.folderRelative) }
        initialFolderLoadJob = initialFolderJob
        if (restoredFromSnapshot) {
            startupAccessSeedJob = seedRestoredDocumentAccess(initialFolderJob)
        }
        if (workspaceKey == "main") viewModelScope.launch {
            updates.restore()
            if (!BuildConfig.DEBUG && updates.state.value.checkOnOpen) {
                kotlinx.coroutines.delay(6000)
                updates.check()
            }
        }
    }

    @androidx.annotation.VisibleForTesting
    internal fun isStartupAccessSeedActive(): Boolean = startupAccessSeedJob?.isActive == true

    private fun seedRestoredDocumentAccess(initialFolderJob: Job?): Job? {
        val candidateUris = mutable.value.tabs
            .mapNotNull { it.uri }
            .filter { raw -> runCatching { Uri.parse(raw).scheme.equals("content", ignoreCase = true) }.getOrDefault(false) }
            .distinct()
        if (candidateUris.isEmpty()) return null
        return viewModelScope.launch {
            if (
                initialFolderJob != null &&
                mutable.value.folder?.let { !isKnownPathDocumentProvider(Uri.parse(it).authority) } == true
            ) {
                runCatching { initialFolderJob.join() }
            }
            val deniedUris = withContext(Dispatchers.IO) {
                buildMap<String, Long> {
                    for (raw in candidateUris) {
                        if (coroutineContext[Job]?.isActive == false) break
                        documentWrites.withLock {
                            val stillOpen = mutable.value.tabs.any { tab ->
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
                val openUris = mutable.value.tabs
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
    override fun onCleared() {
        activeStudioViewModels.remove(this)
        viewModelRetired.set(true)
        metadataJob?.cancel()
        listFolderJob?.cancel()
        readerFlushRequester = null
        folderSearchController.cancel()
        invalidateAllNoteAssets()
        recoveryWriter.closeAfterLatest(mutable.value)
        prefs.unregisterOnSharedPreferenceChangeListener(preferencesChanged)
        resolver.unregisterContentObserver(documentObserver)
        resolver.unregisterContentObserver(themeObserver)
        super.onCleared()
    }
    val state = mutable.asStateFlow()
    fun inspectStorage() = studioSettings.inspectStorage()
    fun clearPythonStorage() = studioSettings.clearPythonStorage()
    val headings: kotlinx.coroutines.flow.StateFlow<List<OutlineHeading>> get() = readerProtocolAndOutline.headings
    val imageOverlay: kotlinx.coroutines.flow.StateFlow<Boolean> get() = readerProtocolAndOutline.imageOverlay
    internal val lastOutlineNoteId: String get() = readerProtocolAndOutline.lastOutlineNoteId
    fun outline(id: String, entries: JSONArray) = readerProtocolAndOutline.outline(id, entries)
    private fun resolveDisplayName(target: Uri): String? =
        if (target.scheme.equals("file", ignoreCase = true)) {
            target.path?.let { File(it).name }?.takeIf(String::isNotBlank)
                ?: target.lastPathSegment?.substringAfterLast('/')?.takeIf(String::isNotBlank)
        } else {
            runCatching { DocumentFile.fromSingleUri(getApplication(), target)?.name?.takeIf(String::isNotBlank) }.getOrNull()
                ?: target.lastPathSegment?.substringAfterLast('/')?.takeIf(String::isNotBlank)
        }

    private var autosaveJob: Job? = null
    private val autosavePending = mutableSetOf<String>()
    private fun scheduleAutosave(id: String) {
        if (!mutable.value.autosave || id in mutable.value.conflictedTabIds) return
        if (mutable.value.tabs.firstOrNull { it.id == id }?.uri?.let(::writeIsBlocked) == true) return
        autosavePending.add(id)
        if (autosaveJob?.isActive == true) return
        autosaveJob = viewModelScope.launch {
            while (autosavePending.isNotEmpty()) {
                delay(900)
                val next = autosavePending.firstOrNull() ?: break
                autosavePending.remove(next)
                var note=mutable.value.tabs.find { it.id==next && it.uri!=null && it.dirty } ?: continue
                if (note.id in mutable.value.conflictedTabIds) continue
                if (writeIsBlocked(note.uri!!)) continue
                if (!mutable.value.autosave) continue
                try {
                    if (mutable.value.active.id == note.id) {
                        if (!performReaderBarrier(note.id) { }) {
                            mutable.value = mutable.value.copy(message = "Autosave paused because the reader could not confirm its latest edits.")
                            continue
                        }
                        note = mutable.value.tabs.find { it.id == next && it.uri != null && it.dirty } ?: continue
                        if (note.id in mutable.value.conflictedTabIds) continue
                    }
                    // Do not cancel an in-flight write when another keystroke or
                    // window transition arrives. Recovery remains an independent stream.
                    withContext(kotlinx.coroutines.NonCancellable) {
                        documentWrites.withLock {
                        if (closingNoteIds.contains(note.id) || mutable.value.tabs.none {
                                it.id == note.id && it.uri == note.uri && it.content == note.content && it.assetsDirty == note.assetsDirty
                            }) return@withLock
                        val writtenTarget = withContext(Dispatchers.IO) {
                            val target = resolveVerifiedWriteDestination(Uri.parse(note.uri))
                            if (!diskMatchesBaseline(target, note)) throw ExternalConflictDetectedException()
                            val staged=File(getApplication<Application>().cacheDir,"autosave-${UUID.randomUUID()}.tmp")
                            try {
                                staged.outputStream().use { if(note.portable) media.writeLocalPortable(it,note.content,note.assetDirectory) else it.write(note.content.toByteArray()) }
                                if (!note.portable) copyAttachments(note,target)
                                resolver.openOutputStream(target,"wt")?.use { staged.inputStream().use { input->input.copyTo(it) } } ?: error("Cannot write this document")
                            } finally {staged.delete()}
                            target
                        }
                        if (note.portable) recordPortableBaseline(note.id, note.assetDirectory)
                        clearDocumentAccessFailure(writtenTarget.toString())
                        change { s->s.copy(tabs=s.tabs.map { if(it.id==note.id)it.copy(saved=note.content,assetsDirty=false,uri=writtenTarget.toString()) else it }, conflictedTabIds=s.conflictedTabIds-note.id) }
                        mutable.value.tabs.firstOrNull { it.id == note.id }?.let(::remember)
                        if(mutable.value.tabs.any {it.id==note.id && it.dirty && it.id !in mutable.value.conflictedTabIds})autosavePending.add(note.id)
                        }
                    }
                } catch (_: ExternalConflictDetectedException) {
                    autosavePending.remove(note.id)
                    change { s -> s.copy(conflictedTabIds = s.conflictedTabIds + note.id, message = "This file changed on disk. Autosave is paused for this tab.") }
                } catch(error:Exception) {if(isDocumentAccessFailure(error))requestDocumentAccess(note.uri!!,note,writing=true) else fail("Autosave paused: ${error.message}")}
            }
        }
    }
    var outputUri: Uri? = null
    private var pdfDestinationIsNew = false
    private var portableDestinationIsNew = false
    var shareReady: ((Intent) -> Unit)? = null
    private var shareFile: File? = null

    internal fun setPdfDestination(uri: Uri) { outputUri = uri; pdfDestinationIsNew = true }
    internal fun setPortableDestination(uri: Uri) { portableOutput = uri; portableDestinationIsNew = true }

    fun prepareShare(format: String): Boolean {
        if (mutable.value.busy || format !in listOf("pdf", "smd", "md", "mdzip")) return false
        val folder = File(getApplication<Application>().cacheDir, "share/${UUID.randomUUID()}").apply { mkdirs() }
        val filename = if (format == "mdzip") ExportFilename.suggestedName(mutable.value.active.name, NativeExportFormat.MARKDOWN).removeSuffix(".md") + ".zip"
            else ExportFilename.suggestedName(mutable.value.active.name, NativeExportFormat.fromShareFormat(format))
        val file = File(folder, filename)
        shareFile = file
        busy(true)
        when (format) {
            "pdf" -> { outputUri = Uri.fromFile(file); pdfDestinationIsNew = false }
            "smd" -> { portableOutput = Uri.fromFile(file); portableDestinationIsNew = false }
        }
        return true
    }
    fun prepareMarkdownExport(sharing: Boolean, archive: Boolean): Boolean {
        if (mutable.value.busy) return false
        shareFile = null
        if (sharing) return prepareShare(if (archive) "mdzip" else "md")
        busy(true)
        return true
    }
    suspend fun shareMarkdown(id: String, content: String, assets: JSONObject, archive: Boolean) {
        val note = mutable.value.tabs.firstOrNull { it.id == id } ?: error("The export note is no longer open")
        val filename = ExportFilename.suggestedName(note.name, NativeExportFormat.MARKDOWN)
        val shared = shareFile
        val companions = mutableListOf<File>()
        val output = withContext(Dispatchers.IO) {
            MarkdownExport(getApplication(), filename, content, assets).use { bundle ->
                if (shared == null) bundle.save(noteLocation(), archive)
                else {
                    require(shared.extension == if (archive) "zip" else "md") { "The share format changed; try again" }
                    if (archive) shared.outputStream().use(bundle::writeZip)
                    else {
                        for ((path, item) in bundle.files) {
                            val target = File(shared.parentFile, path)
                            check(target.parentFile!!.mkdirs() || target.parentFile!!.isDirectory)
                            item.first.copyTo(target, overwrite = false)
                            companions += target
                        }
                        bundle.markdown.copyTo(shared, overwrite = false)
                    }
                    Uri.fromFile(shared) to shared.name
                }
            }
        }
        if (shared != null) finishShare(output.first, companions)
        else mutable.value = mutable.value.copy(busy = false, message = "Exported ${output.second}${if (noteLocation().isBlank()) " to Downloads/Super MD" else " to your configured folder"}")
    }
    private fun finishShare(target: Uri, companions: List<File> = emptyList()): Boolean {
        val file = shareFile ?: return false
        if (target != Uri.fromFile(file)) return false
        val app = getApplication<Application>()
        val uri = androidx.core.content.FileProvider.getUriForFile(app, "${app.packageName}.share", file)
        val mime = if (file.extension == "zip") "application/zip" else NativeExportFormat.fromShareFormat(file.extension).mimeType
        val send = if (companions.isEmpty()) Intent(Intent.ACTION_SEND).setType(mime).putExtra(Intent.EXTRA_STREAM, uri)
            else Intent(Intent.ACTION_SEND_MULTIPLE).setType("*/*").putParcelableArrayListExtra(Intent.EXTRA_STREAM, arrayListOf(uri).apply {
                companions.forEach { add(androidx.core.content.FileProvider.getUriForFile(app, "${app.packageName}.share", it)) }
            })
        send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION).apply {
            clipData = android.content.ClipData.newUri(app.contentResolver, file.name, uri).also { clip ->
                companions.forEach { clip.addItem(android.content.ClipData.Item(androidx.core.content.FileProvider.getUriForFile(app, "${app.packageName}.share", it))) }
            }
        }
        shareFile = null
        mutable.value = mutable.value.copy(busy = false, message = "Share copy ready")
        shareReady?.invoke(send) ?: error("The share screen is no longer open. Your copy is still in the app cache.")
        return true
    }
    private val resolver get() = getApplication<Application>().contentResolver

    /** Validate the new SAF target before opening it for output; never rename an existing note URI. */
    private fun prepareExportDestination(uri: Uri, format: NativeExportFormat, allowRename: Boolean): Uri {
        if (uri.scheme != "content") {
            val name = uri.lastPathSegment ?: ""
            require(ExportFilename.suffixMatches(name, format)) { "The destination name must end in .${format.extension}" }
            return uri
        }
        fun metadata(target: Uri) = ExportDocumentMetadata(
            resolver.query(target, arrayOf(android.provider.OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
                val column = cursor.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME)
                if (column >= 0 && cursor.moveToFirst()) cursor.getString(column)?.takeIf(String::isNotBlank) else null
            },
            resolver.getType(target),
        )

        var target = uri
        ExportDestinationPolicy.validate(metadata(target), format, allowRename) { correctedName ->
            val renamed = runCatching { DocumentsContract.renameDocument(resolver, target, correctedName) }.getOrNull()
            if (renamed == null) null else {
                // Keep the provider-returned URI; some providers move documents
                // to a different document ID when renaming.
                target = renamed
                metadata(target)
            }
        }
        if (target != uri) {
            if (uri == outputUri) outputUri = target
            if (uri == portableOutput) portableOutput = target
        }
        return target
    }

    private fun verifyExportHeader(file: File, format: NativeExportFormat) {
        val prefix = file.inputStream().use { input ->
            val buffer = ByteArray(64)
            var length = 0
            while (length < buffer.size) {
                val read = input.read(buffer, length, buffer.size - length)
                if (read <= 0) break
                length += read
            }
            buffer.copyOf(length)
        }
        require(ExportFilename.hasExpectedHeader(prefix, format)) {
            "The generated ${format.extension.uppercase()} did not have its expected file signature."
        }
    }

    private fun syncNoteAssetScopes(previous: StudioState, next: StudioState) {
        val nextById = next.tabs.associateBy { it.id }
        previous.tabs.forEach { old ->
            val current = nextById[old.id]
            if (current == null || old.uri != current.uri || old.relative != current.relative || old.assetDirectory != current.assetDirectory) {
                invalidateNoteAssets(old.id)
            }
        }
        if (previous.folder != next.folder) {
            if (next.folder == null) invalidateAllNoteAssets() else readerFolderIndex.clear()
        }
    }

    private fun change(block: (StudioState) -> StudioState) {
        val previous = mutable.value
        val next = block(previous)
        mutable.value = next
        syncNoteAssetScopes(previous, next)
        observeActive()
        schedulePersist()
    }
    private fun restore(): StudioState {
        val restoredFolder = windowPrefs.getString("folder", if (workspaceKey == "main" && !windowPrefs.getBoolean("folderMigrated", false)) prefs.getString("folder", null) else null)
        val restoredRelative = if (restoredFolder != null) normalizeRelativePath(windowPrefs.getString("folderRelative", "") ?: "") else ""
        listedRelative = restoredRelative
        var s = StudioState(theme = prefs.getString("theme", "system")!!, fullscreenTheme = prefs.getString("fullTheme", "black")!!, motion = prefs.getBoolean("motion", true), welcomed = prefs.getBoolean("welcomed", false), font = prefs.getString("font", "Manrope")!!, size = prefs.getFloat("size", 15f), folder = restoredFolder, folderRelative = restoredRelative, pdf = prefs.getString("pdf", null) ?: StudioState().pdf)
        s = s.copy(spellCheck=prefs.getBoolean("spellCheck",false),grammarCheck=prefs.getBoolean("grammarCheck",false),accent = prefs.getString("accent","system")!!, widthPercent = prefs.getFloat("widthPercent",100f),lineHeight = prefs.getFloat("lineHeight",1.65f),autosave = prefs.getBoolean("autosave",true),customFonts = fonts.families)
        try {
            if (snapshot.isFile) s=snapshot.bufferedReader().use {NoteRecovery.read(it,s)}
        } catch (_: Exception) { s = s.copy(error = "The recovery snapshot could not be read. Your original files are untouched.") }
        migrateLegacyCustomTheme()
        s=themePreferences(readingPreferences(s)).copy(selectionAssistant=SelectionActions.provider(prefs.getString("selectionAssistant",null)),latexAutofix=prefs.getBoolean("latexAutofix",false),typewriterScroll=prefs.getBoolean("typewriterScroll",false))
        if(s.welcomed) {
            val kept=s.tabs.filter {it.dirty || s.startup=="restore"&&!(it.uri==null&&it.name=="Welcome.md")}
            val tabs=if(s.startup=="new")listOf(Note())+kept else kept.ifEmpty {listOf(Note())}
            s=s.copy(tabs=tabs,activeId=if(s.startup=="new")tabs.first().id else s.activeId)
        }
        if (s.tabs.isEmpty()) s = s.copy(tabs = listOf(Note()))
        val activeIds=s.tabs.map {it.id}.toSet()
        val activeId = s.activeId.takeIf { it in activeIds } ?: s.tabs.first().id
        val indexResult=runCatching {closedNoteStore.loadIndexStrict()}
        if(indexResult.isSuccess)closedNoteIndexError=null else closedNoteIndexError=indexResult.exceptionOrNull()?.message ?: "invalid closed-note index"
        val refs=indexResult.getOrDefault(emptyList()).filterNot {it.id in activeIds}.take(ClosedNoteStore.LIMIT)
        closedNoteRefs=refs
        return s.copy(activeId=activeId, closedTabs=closedNotesForRestore(refs,s.closedTabs,activeIds,indexResult.isSuccess),
            error=closedNoteIndexError?.let {"Closed-note recovery index could not be read; historical snapshots were left untouched. $it"} ?: s.error)
    }
    private lateinit var studioSettingsCache: StudioSettingsCoordinator
    private val studioSettings: StudioSettingsCoordinator
        get() = if (::studioSettingsCache.isInitialized) studioSettingsCache else synchronized(this) {
            if (!::studioSettingsCache.isInitialized) {
                studioSettingsCache = StudioSettingsCoordinator(
                    app = getApplication(), prefs = prefs, scope = viewModelScope,
                    readState = { mutable.value }, writeState = { mutable.value = it }, changeState = ::change,
                    performReaderBarrier = ::performReaderBarrier, readerBarrierFailed = ::readerBarrierFailed,
                    setImageOverlay = { readerProtocolAndOutline.setImageOverlay(it) },
                )
            }
            studioSettingsCache
        }
    private fun readingPreferences(s: StudioState): StudioState = studioSettings.readingPreferences(s)
    fun readingPreference(key: String, value: String) = studioSettings.readingPreference(key, value)
    fun themeBackgroundPreference(key: String, value: Float) = studioSettings.themeBackgroundPreference(key, value)
    fun resetThemeBackground() = studioSettings.resetThemeBackground()
    fun restorePosition(value: Boolean) = studioSettings.restorePosition(value)
    fun fullDocumentAccessibility(value: Boolean) = studioSettings.fullDocumentAccessibility(value)
    fun centerLock(value: Boolean) = studioSettings.centerLock(value)
    fun imageContrast(value: Float) = studioSettings.imageContrast(value)
    fun readingLocation(uri: String?): JSONObject? = studioSettings.readingLocation(uri)
    fun readingPosition(id: String, location: JSONObject) = studioSettings.readingPosition(id, location)
    private fun recoverySignature(state: StudioState) = RecoverySnapshotSignature(
        state.tabs, state.closedTabs, state.activeId, state.mode, state.normalZoom, state.fullscreenZoom,
    )
    private fun schedulePersist() { recoveryWriter.schedule(mutable.value) }
    fun flush(): Job? = recoveryWriter.flush(mutable.value)
    internal suspend fun flushRecoveryAndAwait(): Boolean = recoveryWriter.flushAndAwait(mutable.value)
    // The exact String the reader last sent per note. Echoing it back on every
    // keystroke re-serializes the whole note on both sides and costs battery.
    val readerEcho = java.util.concurrent.ConcurrentHashMap<String, String>()
    private val readerEditProtocol = ReaderEditProtocol()
    private val readerProtocolAndOutline = ReaderProtocolAndOutlineCoordinator(
        app = getApplication(), scope = viewModelScope,
        readerEcho = readerEcho, readerEditProtocol = readerEditProtocol,
        readState = { mutable.value }, changeState = ::change, editNote = ::edit, fail = ::fail,
    )
    internal fun clearReaderEditProtocol(id: String) = readerProtocolAndOutline.clearReaderEditProtocol(id)
    internal fun readerStateIsNativeAuthoritative(id: String): Boolean = readerProtocolAndOutline.readerStateIsNativeAuthoritative(id)
    fun readerEdit(id: String, content: String, protocolPatch: Boolean = false) = readerProtocolAndOutline.readerEdit(id, content, protocolPatch)
    internal fun readerSync(id: String, epoch: String, revision: Long, content: String): JSONObject =
        readerProtocolAndOutline.readerSync(id, epoch, revision, content)
    internal fun readerPatch(id: String, epoch: String, baseRevision: Long, revision: Long, changes: List<ReaderEditChange>): JSONObject =
        readerProtocolAndOutline.readerPatch(id, epoch, baseRevision, revision, changes)
    internal fun readerResync(id: String, epoch: String, revision: Long, bases: List<String>, content: String): JSONObject =
        readerProtocolAndOutline.readerResync(id, epoch, revision, bases, content)
    internal fun preserveMalformedReaderResync(id: String?, content: String?) =
        readerProtocolAndOutline.preserveMalformedReaderResync(id, content)

    fun edit(id: String, content: String) { change { s -> s.copy(tabs = s.tabs.map { if (it.id == id) it.copy(content = content) else it }) }; scheduleAutosave(id) }
    /** Commit an inactive-note patch computed from an immutable reader snapshot. */
    internal suspend fun commitAgentSnapshotPatch(id: String, expectedRevision: String, patchedContent: String, patchedRevision: String) = documentWrites.withLock {
        require(patchedContent.toByteArray(Charsets.UTF_8).size <= MAX_AGENT_SNAPSHOT_BYTES) { "The patched document exceeds Android's 2 MiB relay snapshot limit" }
        val note = mutable.value.tabs.firstOrNull { it.id == id } ?: error("The requested note is no longer open")
        require(agentContentRevision(note.content).equals(expectedRevision, ignoreCase = true)) { "Revision conflict: the note changed before the patch could be saved" }
        require(agentContentRevision(patchedContent).equals(patchedRevision, ignoreCase = true)) { "The computed patch failed revision verification" }
        require(!closingNoteIds.contains(id)) { "The note is closing; retry the patch after it remains open" }
        if (note.content != patchedContent) {
            readerEcho.remove(id)
            readerEditProtocol.clear(id)
            change { state -> state.copy(tabs = state.tabs.map { if (it.id == id) it.copy(content = patchedContent) else it }) }
            scheduleAutosave(id)
        }
    }
    fun newNote(titleHint: String? = null, content: String? = null, background: Boolean = false, format: String = "md", onCreated: ((Note?) -> Unit)? = null) {
        if (format !in setOf("md", "smd")) { onCreated?.invoke(null); return }
        openRequests.invalidate()
        viewModelScope.launch {
            val nativeFormat = if (format == "smd") NativeExportFormat.PORTABLE_SMD else NativeExportFormat.MARKDOWN
            val title = ExportFilename.suggestedName(titleHint ?: "Untitled", nativeFormat)
            val assets = if (format == "smd") media.createEmptyPortableDirectory() else null
            val note = Note(name = title, content = content ?: "", assetDirectory = assets)
            val accepted = performCurrentReaderBarrier {
                    change { state ->
                        val preservedId = state.tabs.firstOrNull { it.id == state.activeId }?.id ?: state.tabs.firstOrNull()?.id ?: note.id
                        state.copy(tabs = state.tabs + note, activeId = if (background) preservedId else note.id)
                    }
                }
            if (!accepted) {
                assets?.let { File(getApplication<Application>().filesDir, "portable-assets/$it").deleteRecursively() }
                readerBarrierFailed()
            }
            onCreated?.invoke(note.takeIf { accepted })
        }
    }
    fun select(id: String) = selectExpected(mutable.value.active.id, id)
    fun cycle(direction:Int) {
        val state=mutable.value
        if(state.tabs.isEmpty())return
        val index=state.tabs.indexOfFirst{it.id==state.active.id}
        selectExpected(state.active.id,state.tabs[Math.floorMod(index+direction,state.tabs.size)].id)
    }
    fun tabNumber(number:Int) {
        val state=mutable.value
        val index=if(number==9)state.tabs.lastIndex else number-1
        state.tabs.getOrNull(index)?.let{selectExpected(state.active.id,it.id)}
    }
    private fun selectExpected(expectedActiveId:String,targetId:String) {
        // A later explicit tab choice must not be overwritten by a file load
        // that began earlier and is still waiting on I/O or the reader flush.
        openRequests.invalidate()
        viewModelScope.launch {
            var switchedUri: Uri? = null
            val accepted=performReaderBarrier(expectedActiveId) {
                val target = mutable.value.tabs.find { it.id == targetId }
                if(target != null) {
                    change {it.copy(activeId=targetId)}
                    if (target.id !in mutable.value.conflictedTabIds) switchedUri = target.uri?.let(Uri::parse)
                }
            }
            if(!accepted)readerBarrierFailed()
            else if(switchedUri != null)refreshExternal(switchedUri, immediate = true)
        }
    }
    private data class RefreshTabSnapshot(
        val note: Note,
        val preIoBaselineAssets: JSONObject?,
        @Volatile var resolvedBaselineAssets: JSONObject? = preIoBaselineAssets,
    )
    private lateinit var externalRefreshCache: ExternalRefreshCoordinator<RefreshTabSnapshot>
    private val externalRefresh: ExternalRefreshCoordinator<RefreshTabSnapshot>
        get() = if (::externalRefreshCache.isInitialized) externalRefreshCache else synchronized(this) {
            if (!::externalRefreshCache.isInitialized) {
                externalRefreshCache = ExternalRefreshCoordinator(
                    app = getApplication(), workspaceKey = workspaceKey, scope = viewModelScope,
                    media = media, closedNoteStore = closedNoteStore, documentWrites = documentWrites,
                    closingNoteIds = closingNoteIds, autosavePending = autosavePending,
                    savedPortableAssets = savedPortableAssets, readerEcho = readerEcho,
                    documentAccessClearSeq = documentAccessClearSeq,
                    readDocumentAccess = { documentAccess },
                    readState = { mutable.value }, changeState = ::change,
                    readInitialFolderLoadJob = { initialFolderLoadJob },
                    liveViewModels = { liveStudioViewModels(this) },
                    readVmState = { it.mutable.value }, readVmClosedNoteRefs = { it.closedNoteRefs },
                    baselinePortableAssets = ::baselinePortableAssets, sameDocumentUri = ::sameDocumentUri,
                    markDocumentWriteBlocked = ::markDocumentWriteBlocked,
                    invalidateNoteAssets = ::invalidateNoteAssets,
                    clearReaderEditProtocol = ::clearReaderEditProtocol,
                    pendingRefreshLock = pendingRefreshLock, pendingRefreshUris = pendingRefreshUris,
                    readRefreshAllGeneration = { refreshAllGeneration }, writeRefreshAllGeneration = { refreshAllGeneration = it },
                    readRefreshGeneration = { refreshGeneration }, writeRefreshGeneration = { refreshGeneration = it },
                    readRefreshJob = { refreshJob }, writeRefreshJob = { refreshJob = it },
                    readPreIoObserver = { refreshExternalPreIoObserver },
                    readIoObserver = { refreshExternalIoObserver },
                    readPostAdoptObserver = { refreshPostAdoptObserver },
                    createSnapshot = { note, preIo -> RefreshTabSnapshot(note, preIo) },
                    snapshotNote = RefreshTabSnapshot::note,
                    preIoBaselineAssets = RefreshTabSnapshot::preIoBaselineAssets,
                    readResolvedBaseline = RefreshTabSnapshot::resolvedBaselineAssets,
                    writeResolvedBaseline = { snapshot, resolved -> snapshot.resolvedBaselineAssets = resolved },
                )
            }
            externalRefreshCache
        }
    internal fun isPortableDirectoryReferenced(directory: String): Boolean =
        externalRefresh.isPortableDirectoryReferenced(directory)
    private suspend fun cleanupPortableDirectories(directories: Set<String>) =
        externalRefresh.cleanupPortableDirectories(directories)
    internal var refreshJob: Job? = null
    @Volatile internal var refreshExternalPreIoObserver: (suspend () -> Unit)? = null
    @Volatile internal var refreshExternalIoObserver: (suspend () -> Unit)? = null
    @Volatile internal var refreshPostAdoptObserver: (suspend () -> Unit)? = null
    @Volatile internal var portablePostWriteObserver: (suspend () -> Unit)? = null
    private val pendingRefreshLock = Any()
    private val pendingRefreshUris = mutableMapOf<String, Long>()
    private var refreshAllGeneration = 0L
    private var refreshGeneration = 0L
    fun refreshExternal(changedUri: Uri? = null, immediate: Boolean = false) =
        externalRefresh.refreshExternal(changedUri, immediate)
    @androidx.annotation.VisibleForTesting
    internal fun isRefreshExternalActive(): Boolean = refreshJob?.isActive == true

    internal suspend fun refreshExternalTabs(
        snapshotTabs: List<Note>,
        onCommitted: (() -> Unit)? = null,
    ) {
        externalRefresh.refreshExternalTabs(snapshotTabs, onCommitted)
    }
    fun reorder(id: String, index: Int) = change { it.copy(tabs = reorderedNotes(it.tabs, id, index)) }
    private fun migrateLegacyClosedNotes() = viewModelScope.launch {
        var locked=false
        try {
            closedNoteMutex.lock();locked=true
            val existingIds=closedNoteRefs.map {it.id}.toSet()
            val legacy=mutable.value.closedTabs.filter {it.id !in existingIds}
            if(legacy.isEmpty())return@launch
            val migrated=runCatching { withContext(Dispatchers.IO) { legacy.map { it to closedNoteStore.save(it) } } }.getOrElse {
                mutable.value=mutable.value.copy(message="Some older closed notes could not be moved to disk; they remain available in memory.")
                return@launch
            }
            val stillClosed=migrated.filter { (old,_) -> mutable.value.closedTabs.any {it==old} }
            if(stillClosed.isEmpty())return@launch
            val activeIds=mutable.value.tabs.map {it.id}.toSet()
            val currentRefs=withContext(Dispatchers.IO){closedNoteStore.loadIndexStrict()}
            val next=(stillClosed.map {it.second}+currentRefs).distinctBy {it.id}
                .filterNot {it.id in activeIds}.take(ClosedNoteStore.LIMIT)
            withContext(Dispatchers.IO){saveClosedNoteIndex(next);closedNoteRefs=next}
            val replacements=stillClosed.associate {it.first.id to it}
            val finalRefs=next.filter {ref ->
                val old=replacements[ref.id]?.first
                old==null || mutable.value.closedTabs.any {it==old}
            }
            if(finalRefs!=next)withContext(Dispatchers.IO){saveClosedNoteIndex(finalRefs);closedNoteRefs=finalRefs}
            closedNoteRefs=finalRefs
            change { state -> state.copy(closedTabs=state.closedTabs.map {old ->
                replacements[old.id]?.takeIf {it.first==old}?.second?.placeholder() ?: old
            }.take(ClosedNoteStore.LIMIT)) }
        } catch(error:Exception) {
            mutable.value=mutable.value.copy(message="Older closed-note recovery could not be updated; the notes remain available. ${error.message}")
        } finally {if(locked)closedNoteMutex.unlock()}
    }
    fun requestClose(id: String) {
        openRequests.invalidate()
        viewModelScope.launch { executeClose(id, confirmIfRequired = true) }
    }
    fun dismissCloseConfirmation() {
        closeAfterSaveNoteId = null
        mutable.value = mutable.value.copy(pendingCloseNoteId = null)
    }
    fun resolveCloseConfirmation(choice: String) {
        val id = mutable.value.pendingCloseNoteId ?: return
        mutable.value = mutable.value.copy(pendingCloseNoteId = null)
        when (choice) {
            "discard" -> {
                closeAfterSaveNoteId = null
                close(id, discardChanges = true)
            }
            "save" -> {
                closeAfterSaveNoteId = id
                saveManual(noteId = id)
            }
            else -> closeAfterSaveNoteId = null
        }
    }
    private fun isDiscardableEmptyTab(note: Note): Boolean =
        note.uri == null && note.content.isBlank() && (
            note.assetDirectory == null ||
                (!note.assetsDirty && runCatching { media.portableAssets(note.assetDirectory).length() == 0 }.getOrDefault(false))
        )
    private fun discardEmptyTab(id: String) {
        readerEcho.remove(id)
        clearReaderEditProtocol(id)
        autosavePending.remove(id)
        savedPortableAssets.remove(id)
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
    fun close(id: String, expectedRevision: String? = null, refuseDirty: Boolean = false, discardChanges: Boolean = false, onComplete: ((String?) -> Unit)? = null) {
        openRequests.invalidate()
        viewModelScope.launch {
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
            val note = mutable.value.tabs.find { it.id == id } ?: return@performCurrentReaderBarrier
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
        val afterClose = mutable.value
        if (afterClose.tabs.any { it.id == id }) {
            onComplete?.invoke("The note could not be closed; it remains open")
            return
        }
        if (afterClose.active.id != previousActiveId && !awaitReaderSnapshot(afterClose.active.id)) {
            val message = "The note was closed and preserved, but the active reader is still loading; refresh the tabs before the next action."
            mutable.value = mutable.value.copy(message = message)
            onComplete?.invoke(message)
            return
        }
        onComplete?.invoke(null)
    }

    private suspend fun closeAfterReaderBarrier(id: String) {
        var locked = false
        var documentLocked = false
        try {
            closedNoteMutex.lock(); locked = true
            // Serialize the latest acknowledged snapshot with manual/automatic
            // document writes. The reader barrier completed before this lock.
            documentWrites.lock(); documentLocked = true
            val noteToClose = mutable.value.tabs.find { it.id == id } ?: return
            if (isDiscardableEmptyTab(noteToClose)) {
                discardEmptyTab(id)
                return
            }
            val reference = withContext(Dispatchers.IO) { closedNoteStore.save(noteToClose) }
            if (mutable.value.tabs.find { it.id == id } != noteToClose) {
                mutable.value = mutable.value.copy(message = "The note changed while it was closing. It remains open with the latest text.")
                return
            }
            val previousRefs = withContext(Dispatchers.IO) { closedNoteStore.loadIndexStrict() }
            val nextRefs = (listOf(reference) + previousRefs.filterNot { it.id == id }).take(ClosedNoteStore.LIMIT)
            try {
                withContext(Dispatchers.IO) {
                    saveClosedNoteIndex(nextRefs)
                    closedNoteRefs = nextRefs
                }
            } catch (error: Exception) {
                withContext(kotlinx.coroutines.NonCancellable + Dispatchers.IO) {
                    closedNoteStore.deleteUnindexedSnapshot(reference)
                }
                mutable.value = mutable.value.copy(message = "Could not update closed-note recovery: ${error.message}")
                return
            }
            if (mutable.value.tabs.find { it.id == id } != noteToClose) {
                val rolledBack = withContext(kotlinx.coroutines.NonCancellable + Dispatchers.IO) {
                    runCatching { saveClosedNoteIndex(previousRefs) }.isSuccess
                }
                if (rolledBack) {
                    closedNoteRefs = previousRefs
                    withContext(kotlinx.coroutines.NonCancellable + Dispatchers.IO) {
                        closedNoteStore.deleteUnindexedSnapshot(reference)
                    }
                } else {
                    closedNoteRefs = nextRefs
                }
                mutable.value = mutable.value.copy(message = "The note changed while it was closing. It remains open with the latest text.")
                return
            }
            readerEcho.remove(id)
            clearReaderEditProtocol(id)
            autosavePending.remove(id)
            change { state ->
                val remaining = state.tabs.filterNot { it.id == id }
                val next = remaining.ifEmpty { listOf(Note()) }
                state.copy(tabs = next, closedTabs = (listOf(reference.placeholder()) + state.closedTabs.filterNot { it.id == id }).take(ClosedNoteStore.LIMIT),
                    activeId = if (state.active.id == id) next.first().id else state.activeId,
                    conflictedTabIds = state.conflictedTabIds - id,
                    pendingCloseNoteId = state.pendingCloseNoteId?.takeUnless { it == id },
                    pendingSaveConflictNoteId = state.pendingSaveConflictNoteId?.takeUnless { it == id },
                    message = "Tab closed. Reopen from the menu to recover edits.")
            }
        } catch (cancelled: kotlinx.coroutines.CancellationException) {
            throw cancelled
        } catch (error: Exception) {
            mutable.value = mutable.value.copy(message = "Could not preserve the closed note: ${error.message}")
        } finally {
            closingNoteIds.remove(id)
            if (documentLocked) documentWrites.unlock()
            if (locked) closedNoteMutex.unlock()
        }
    }
    fun reopen() {
        openRequests.invalidate()
        val referenceNote=mutable.value.closedTabs.firstOrNull() ?: return
        val reference=closedNoteRefs.firstOrNull {it.id==referenceNote.id}
        viewModelScope.launch {
            val note=try {if(reference==null)referenceNote else withContext(Dispatchers.IO){closedNoteStore.load(reference)}}
                catch(error:Exception) {mutable.value=mutable.value.copy(message="Could not reopen the closed note: ${error.message}");return@launch}
            var updatedRefs: List<ClosedNoteReference>? = null
            val accepted = closedNoteMutex.withLock {
                performCurrentReaderBarrier {
                    if(mutable.value.closedTabs.none {it.id==referenceNote.id})return@performCurrentReaderBarrier
                    readerEcho.remove(note.id)
                    if (note.portable && note.uri != null && !note.assetsDirty) recordPortableBaseline(note.id, note.assetDirectory)
                    closedNoteRefs=closedNoteRefs.filterNot {it.id==note.id}
                    updatedRefs = closedNoteRefs
                    change { state ->
                        val existing=state.tabs.find {it.id==note.id}
                        val tabs=if(existing==null)state.tabs+note else state.tabs
                        state.copy(tabs=tabs,closedTabs=state.closedTabs.dropWhile {it.id==referenceNote.id}.filterNot {it.id==referenceNote.id},activeId=note.id)
                    }
                }.also { barrierAccepted ->
                    if (barrierAccepted) {
                        updatedRefs?.let { refs ->
                            withContext(kotlinx.coroutines.NonCancellable + Dispatchers.IO) {
                                runCatching { saveClosedNoteIndex(refs) }
                            }
                        }
                    }
                }
            }
            if(!accepted)readerBarrierFailed()
        }
    }
    fun recoverDeletedDraft() {
        openRequests.invalidate()
        val expectedActiveId = mutable.value.active.id
        viewModelScope.launch {
            val note=withContext(Dispatchers.IO){deletedDrafts.latest(mutable.value.tabs.map {it.id}.toSet())}
            if(note==null)change {it.copy(message="No additional deleted drafts to recover.")}
            else {
                val ref=closedNoteRefs.firstOrNull {it.id==note.id}
                val legacy=mutable.value.closedTabs.find {it.id==note.id}
                // Never let a lightweight placeholder mask the complete deleted
                // draft. A failed snapshot read falls back to that durable source.
                val restored=if(ref!=null)withContext(Dispatchers.IO){closedNoteStore.loadForRecovery(ref,note)}
                    else legacy?.takeIf {it.content.isNotEmpty() || it.saved.isNotEmpty() || it.assetDirectory!=null} ?: note
                val accepted=performReaderBarrier(expectedActiveId) {
                    closedNoteRefs=closedNoteRefs.filterNot {it.id==note.id}
                    change {s->
                        if(s.tabs.any {it.id==note.id})s.copy(activeId=note.id,closedTabs=s.closedTabs.filter {it.id!=note.id})
                        else s.copy(tabs=s.tabs+restored,activeId=note.id,closedTabs=s.closedTabs.filter {it.id!=note.id})
                    }
                }
                if(!accepted)readerBarrierFailed()
            }
        }
    }
    fun mode(value: String) = studioSettings.mode(value)
    fun fullscreen(value: Boolean) = studioSettings.fullscreen(value)
    fun zoom(value: Float) = studioSettings.zoom(value)
    fun readerZoom(value: Float, fullscreen: Boolean) = studioSettings.readerZoom(value, fullscreen)
    fun appearance(accent: String? = null, theme: String? = null, fullTheme: String? = null, motion: Boolean? = null, font: String? = null, size: Float? = null) =
        studioSettings.appearance(accent, theme, fullTheme, motion, font, size)
    fun pdf(value: String) = studioSettings.pdf(value)
    fun noteLocation(): String = studioSettings.noteLocation()
    internal suspend fun saveAgentMedia(args: JSONObject): JSONObject = withContext(Dispatchers.IO) {
        media.saveAgentMedia(args, noteLocation()).also { readerFolderIndex.clear() }
    }
    fun noteLocation(uri: Uri) = studioSettings.noteLocation(uri)
    fun reading(widthPercent: Float? = null, lineHeight: Float? = null, autosave: Boolean? = null) =
        studioSettings.reading(widthPercent, lineHeight, autosave)
    fun writing(spellCheck: Boolean? = null, grammarCheck: Boolean? = null) = studioSettings.writing(spellCheck, grammarCheck)
    fun selectionAssistant(value: String) = studioSettings.selectionAssistant(value)
    fun latexAutofix(enabled: Boolean) = studioSettings.latexAutofix(enabled)
    fun typewriterScroll(enabled: Boolean) = studioSettings.typewriterScroll(enabled)
    fun overlay(open: Boolean, image: Boolean = false) = studioSettings.overlay(open, image)
    fun editorFocus(focused: Boolean) = studioSettings.editorFocus(focused)
    fun importFont(uri: Uri) = viewModelScope.launch {
        try { val family=withContext(Dispatchers.IO) {fonts.import(uri)};appearance(font=family);prefs.edit().putLong("fonts",System.currentTimeMillis()).apply();mutable.value=mutable.value.copy(customFonts=fonts.families,message="Imported $family for reading and PDF export") }
        catch(error: Exception) {fail("Could not import font: ${error.message}")}
    }
    fun rename(
        id: String,
        requested: String,
        showGlobalError: Boolean = true,
        onResult: (Boolean, String?) -> Unit = { _, _ -> },
    ) = viewModelScope.launch {
        val note = mutable.value.tabs.find { it.id == id } ?: run {
            onResult(false, "Note is no longer open")
            return@launch
        }
        try {
            val hasSavedTarget = note.uri != null
            val existingExt = noteExtension(note.name)
            val extension = when {
                existingExt.isNotEmpty() -> existingExt
                hasSavedTarget -> ""
                note.portable -> "smd"
                else -> "md"
            }
            val name = validateFolderEntryName(requested, isDirectory = false, currentExtension = extension, hasSavedTarget = hasSavedTarget)
            if (name == note.name) {
                onResult(true, null)
                return@launch
            }
            val existingUri = note.uri
            if (existingUri == null) {
                change { s -> s.copy(tabs = s.tabs.map { if (it.id == id) it.copy(name = name) else it }) }
                onResult(true, null)
                return@launch
            }
            val ownShareAuthority = "${getApplication<Application>().packageName}.share"
            val parsedUri = Uri.parse(existingUri)
            if (writeIsBlocked(existingUri)) {
                val lazilyConfirmed = DocumentsContract.isTreeUri(parsedUri) &&
                    documentAccess.resolveReadAccess(parsedUri) is SafReadAccess.PendingTreeMembership &&
                    withContext(Dispatchers.IO) { documentAccess.confirmEmbeddedTreeMembershipIfWritable(parsedUri) }
                if (lazilyConfirmed) {
                    clearDocumentAccessFailure(existingUri)
                } else if (requestWriteAccessIfBlocked(id, explicit = true)) {
                    onResult(false, DOCUMENT_ACCESS_MESSAGE)
                    return@launch
                }
            }
            val currentFolderRaw = mutable.value.folder
            val currentFolderUri = currentFolderRaw?.let(Uri::parse)
            val openFolderReadable = currentFolderUri != null &&
                withContext(Dispatchers.IO) { documentAccess.resolveReadableTreeRoot(currentFolderUri) != null }
            val openFolderRel = note.relative
                ?: relativeInOpenFolder(parsedUri)
                ?: if (openFolderReadable) withContext(Dispatchers.IO) { resolveOpenFolderRelativeOnIo(parsedUri) } else null
            if (openFolderRel != null && currentFolderUri != null) {
                if (openFolderReadable) {
                    performRenameFolderEntry(parsedUri, openFolderRel, isDirectory = false, validatedName = name)
                    clearDocumentAccessFailure(existingUri)
                    mutable.value.tabs.find { it.id == id }?.uri?.let(::clearDocumentAccessFailure)
                    onResult(true, null)
                    return@launch
                }
                val hasStandaloneWrite = withContext(Dispatchers.IO) {
                    val target = resolveVerifiedWriteDestination(parsedUri)
                    !DocumentsContract.isTreeUri(target) &&
                        (target.scheme != "content" || target.authority == ownShareAuthority || documentAccess.hasWriteGrant(target))
                }
                if (!hasStandaloneWrite) {
                    throw SecurityException("Choose the folder again to restore access")
                }
            }
            liveStudioViewModels(this@StudioViewModel).forEach { vm -> vm.metadataJob?.cancel() }
            withContext(Dispatchers.IO) {
                documentWrites.withLock {
                    val target = resolveVerifiedWriteDestination(parsedUri)
                    if (target.scheme == "content" && target.authority != ownShareAuthority && !documentAccess.hasWriteGrant(target)) {
                        throw SecurityException("Android did not grant write access to this file")
                    }
                    val targetTreeWritable = DocumentsContract.isTreeUri(target) &&
                        documentAccess.hasTreeScopedWriteGrant(target) &&
                        documentAccess.hasWriteGrant(target)
                    val rawRenamed = DocumentsContract.renameDocument(resolver, target, name)
                        ?: error("This provider does not support renaming. Use Save as instead.")
                    val hadConfirmedSource = listOfNotNull(
                        canonicalTreeDocumentKey(parsedUri),
                        canonicalTreeDocumentKey(target),
                    ).any(confirmedTreeDocumentKeys::remove)
                    val confirmedInTargetTree = targetTreeWritable && (
                        hadConfirmedSource || isKnownPathContainedInTree(
                            target.authority,
                            runCatching { DocumentsContract.getTreeDocumentId(target) }.getOrDefault(""),
                            runCatching { DocumentsContract.getDocumentId(rawRenamed) }.getOrDefault(""),
                        )
                    )
                    val effectiveRenamed = if (confirmedInTargetTree && !DocumentsContract.isTreeUri(rawRenamed)) {
                        canonicalTreeScopedUri(target, rawRenamed)
                    } else {
                        rawRenamed
                    }
                    documentAccess.persist(effectiveRenamed)
                    if (hadConfirmedSource && confirmedInTargetTree) {
                        canonicalTreeDocumentKey(effectiveRenamed)?.let(confirmedTreeDocumentKeys::add)
                    }
                    val renamedUri = effectiveRenamed.toString()
                    val newRelative = renamedRelative(note.relative, name)
                    withContext(Dispatchers.Main) {
                        clearDocumentAccessFailure(existingUri)
                        clearDocumentAccessFailure(renamedUri)
                        applyUriRemaps(
                            listOf(UriRemap(existingUri, renamedUri, name, newRelative)),
                            folderTreeRaw = if (currentFolderUri != null && !openFolderReadable) "" else null,
                            statusMessage = "Renamed to $name",
                        )
                        mutable.value.tabs.find { it.id == id }?.let(::remember)
                    }
                }
            }
            onResult(true, null)
        } catch (cancelled: kotlinx.coroutines.CancellationException) {
            throw cancelled
        } catch (error: Exception) {
            val msg = reportDocumentRenameFailure(id, error, showGlobalError = showGlobalError)
            onResult(false, msg)
        }
    }
    fun welcomeDone() { change { it.copy(welcomed = true) }; prefs.edit().putBoolean("welcomed", true).apply() }
    fun dismissMessage() { mutable.value = mutable.value.copy(message = null) }
    fun dismissError() { mutable.value = mutable.value.copy(error = null) }
    internal fun clearPendingPortableWriteState() {
        portableOutput = null
        portableDestinationIsNew = false
        portableSaveAsNoteId = null
        portableForceOverwrite = false
        closeAfterSaveNoteId = null
    }
    fun fail(message: String) { shareFile = null; clearPendingPortableWriteState(); mutable.value = mutable.value.copy(busy = false, error = message) }
    internal fun pdfExportCancelled() {
        shareFile = null
        outputUri = null
        mutable.value = mutable.value.copy(busy = false, message = "PDF export cancelled")
    }
    fun busy(value: Boolean) { mutable.value = mutable.value.copy(busy = value) }
    fun consumePendingHeading(token: String) {
        if (mutable.value.pendingHeading?.token == token) {
            mutable.value = mutable.value.copy(pendingHeading = null)
        }
    }
    fun dismissWorkspaceFolderPrompt() {
        mutable.value = mutable.value.copy(folderAccessPrompt = null)
    }
    private enum class DocumentWriteOpenState {
        UNCHANGED,
        RESTORED,
        BLOCKED,
    }
    private suspend fun applyWorkspaceFolder(uri: Uri, clearPrompt: Boolean = false) {
        withContext(Dispatchers.IO) { documentAccess.persist(uri) }
        workspaceLinks.invalidate()
        listedRelative = ""
        windowPrefs.edit().putBoolean("folderMigrated", true).putString("folder", uri.toString()).putString("folderRelative", "").apply()
        change {
            if (clearPrompt) it.copy(folder = uri.toString(), folderRelative = "", folderAccessPrompt = null)
            else it.copy(folder = uri.toString(), folderRelative = "")
        }
        val listJob = listFolder(uri, "")
        startupAccessSeedJob?.let { seedJob ->
            if (seedJob.isActive) runCatching { seedJob.join() }
        }
        if (synchronized(blockedDocumentWrites) { blockedDocumentWrites.isNotEmpty() }) {
            listJob.join()
            val candidates = synchronized(blockedDocumentWrites) { blockedDocumentWrites.toList() }
            val stateBeforeUnblock = mutable.value
            val listedFileUris = stateBeforeUnblock.files.asSequence().filter { !it.directory }.map { it.uri }.toSet()
            val relativeHints = buildMap<String, String> {
                recentMutable.value.forEach { r -> if (!r.relative.isNullOrEmpty()) put(r.uri, r.relative) }
                stateBeforeUnblock.tabs.forEach { t -> if (t.uri != null && !t.relative.isNullOrEmpty()) put(t.uri, t.relative) }
            }
            val (unblockedTargets, confirmedKeys) = withContext(Dispatchers.IO) {
                val selectedAuthority = uri.authority?.takeIf { it.isNotEmpty() }
                val selectedRoot = if (DocumentsContract.isTreeUri(uri)) {
                    runCatching { DocumentsContract.getTreeDocumentId(uri) }.getOrNull()
                        ?.takeIf { it.isNotEmpty() && '\u0000' !in it }
                } else {
                    null
                }
                if (selectedAuthority == null || selectedRoot == null || !documentAccess.hasWriteGrant(uri)) {
                    emptyList<Pair<String, Uri>>() to emptySet()
                } else {
                    val knownPathProvider = isKnownPathDocumentProvider(selectedAuthority)
                    val canonicalSelectedTree = DocumentsContract.buildTreeDocumentUri(selectedAuthority, selectedRoot)
                    val passLazy = lazy(LazyThreadSafetyMode.NONE) { SafProjectionPass(resolver) }
                    val matched = candidates.mapNotNull { raw ->
                        val parsedRaw = Uri.parse(raw)
                        if (parsedRaw.scheme != "content" || parsedRaw.authority != selectedAuthority) {
                            return@mapNotNull null
                        }
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
                        if (passLazy.isInitialized()) {
                            confirmedTreeDocumentKeys.addAll(passLazy.value.confirmedTreeKeys)
                        }
                        val writable = documentAccess.hasWriteGrant(scopedTarget) &&
                            runCatching { resolver.openFileDescriptor(scopedTarget, "rw")?.use { true } == true }.getOrDefault(false)
                        if (writable) raw to scopedTarget else null
                    }
                    val discoveredKeys = if (passLazy.isInitialized()) passLazy.value.confirmedTreeKeys else emptySet()
                    matched to discoveredKeys
                }
            }
            if (confirmedKeys.isNotEmpty()) {
                confirmedTreeDocumentKeys.addAll(confirmedKeys)
            }
            if (unblockedTargets.isNotEmpty()) {
                unblockedTargets.forEach { (raw, scopedTarget) ->
                    clearDocumentAccessFailure(raw)
                    clearDocumentAccessFailure(scopedTarget.toString())
                }
                val dirtyUnblockedIds = mutableListOf<String>()
                change { current ->
                    val updatedTabs = current.tabs.map { tab ->
                        val tabUri = tab.uri ?: return@map tab
                        if (tab.id in closingNoteIds) return@map tab
                        val match = unblockedTargets.firstOrNull { (raw, scopedTarget) ->
                            sameDocumentUri(tabUri, raw) || sameDocumentUri(tabUri, scopedTarget.toString())
                        } ?: return@map tab
                        val nextUri = match.second.toString()
                        val nextRelative = relativeInOpenFolder(match.second, uri.toString()) ?: tab.relative
                        if (tab.dirty) dirtyUnblockedIds += tab.id
                        if (tab.uri != nextUri || tab.relative != nextRelative) {
                            tab.copy(uri = nextUri, relative = nextRelative)
                        } else {
                            tab
                        }
                    }
                    if (updatedTabs != current.tabs) current.copy(tabs = updatedTabs) else current
                }
                dirtyUnblockedIds.forEach(::scheduleAutosave)
            }
        }
    }
    fun grantWorkspaceFolderForLink(uri: Uri) = viewModelScope.launch {
        val prompt = mutable.value.folderAccessPrompt
        try {
            applyWorkspaceFolder(uri, clearPrompt = true)
            if (prompt != null) {
                openWorkspaceLink(prompt.noteId, prompt.target, prompt.fragment, prompt.wikilink, allowFolderPrompt = false)
            }
        } catch (cancelled: kotlinx.coroutines.CancellationException) {
            throw cancelled
        } catch (error: Exception) {
            mutable.value = mutable.value.copy(folderAccessPrompt = null)
            fail("Could not open folder: ${error.message}")
        }
    }
    private fun loadNoteForOpen(uri: Uri, relative: String?): Note {
        documentAccess.persist(uri)
        val target = documentAccess.resolve(uri)
        return loadResolvedNoteForOpen(target, uri, relative, externalIntentFlags = null, externalCaller = ExternalIntentCaller())
    }
    private fun loadNoteForOpen(
        uri: Uri,
        relative: String?,
        externalIntentFlags: Int?,
        externalCaller: ExternalIntentCaller,
        admittedDrop: AdmittedExternalDrop? = null,
        strictDroppedNote: Boolean = false,
    ): Note {
        if (externalIntentFlags == null && admittedDrop == null) return loadNoteForOpen(uri, relative)
        // External Intents and drops must prove their own live caller grant or admitted file handle;
        // never manufacture access from persisted SAF folder trees or untrusted app-private paths.
        return loadResolvedNoteForOpen(
            target = uri,
            originalUri = uri,
            relative = relative,
            externalIntentFlags = externalIntentFlags ?: admittedDrop?.intentFlags,
            externalCaller = externalCaller,
            admittedDrop = admittedDrop,
            strictDroppedNote = strictDroppedNote,
        )
    }
    private fun loadResolvedNoteForOpen(
        target: Uri,
        originalUri: Uri,
        relative: String?,
        externalIntentFlags: Int?,
        externalCaller: ExternalIntentCaller,
        admittedDrop: AdmittedExternalDrop? = null,
        strictDroppedNote: Boolean = false,
    ): Note {
        val app = getApplication<Application>()
        val existing = mutable.value.tabs.find { it.uri?.let { raw -> sameDocumentUri(raw, originalUri.toString()) } == true }
        // Reopening an existing draft must still validate its grant or admitted descriptor,
        // but must never reload older disk bytes over its edits.
        if (existing != null) {
            val verifyStream = when {
                admittedDrop != null -> admittedDrop.openInputStream(app, resolver)
                externalIntentFlags != null -> ExternalDocumentEntryGuard.openVerifiedExternalInputStream(app, resolver, target, externalIntentFlags, externalCaller)
                else -> resolver.openInputStream(target) ?: error("Document permission is unavailable; choose it again")
            }
            verifyStream.use { }
            val keepPendingTreeUri = existing.uri != null &&
                DocumentsContract.isTreeUri(target) &&
                documentAccess.resolveReadAccess(target) is SafReadAccess.PendingTreeMembership
            val keepStrongerExistingUri = externalIntentFlags != null &&
                (externalIntentFlags and Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION) == 0 &&
                existing.uri != null
            return existing.copy(
                uri = if (keepPendingTreeUri || keepStrongerExistingUri) existing.uri else target.toString(),
                relative = relative ?: existing.relative,
            )
        }
        val inputStream = when {
            admittedDrop != null -> admittedDrop.openInputStream(app, resolver)
            externalIntentFlags != null -> ExternalDocumentEntryGuard.openVerifiedExternalInputStream(app, resolver, target, externalIntentFlags, externalCaller)
            else -> resolver.openInputStream(target) ?: error("Document permission is unavailable; choose it again")
        }
        return inputStream.use { stream ->
            val name = resolveDisplayName(target)
                ?: relative?.substringAfterLast('/')?.takeIf(String::isNotBlank)
                ?: "Note.md"
            val buffered = stream.buffered()
            buffered.mark(65536)
            val prefix = ByteArray(32768); val count = buffered.read(prefix); buffered.reset()
            val header = if (count > 0) String(prefix, 0, count, Charsets.UTF_8).trimStart('\uFEFF', ' ', '\n', '\r', '\t') else ""
            val portable = portableGzipHeader(prefix.copyOfRange(0, maxOf(count, 0))) || portableEnvelopeHeader(header)
            if (portable) {
                val opened = media.openFmd(buffered)
                Note(name = name, uri = target.toString(), content = opened.markdown, saved = opened.markdown, relative = relative, assetDirectory = opened.directory)
                    .also { recordPortableBaseline(it.id, opened.directory) }
            } else {
                if (strictDroppedNote) {
                    val lowerExt = name.substringAfterLast('.', "").lowercase()
                    require(lowerExt != "smd" && lowerExt != "fmd") { "Unsupported portable note file" }
                }
                val rawBytes = readLimited(buffered, 20_000_000)
                if (strictDroppedNote) {
                    require(rawBytes.none { it == 0.toByte() }) { "Binary files cannot be opened as Markdown notes" }
                }
                val content = rawBytes.toString(Charsets.UTF_8).removePrefix("\uFEFF")
                Note(name = name, uri = target.toString(), content = content, saved = content, relative = relative)
            }
        }
    }
    private fun retainOpenedNote(note: Note, activate: Boolean, headingFragment: String? = null): String {
        val existing = mutable.value.tabs.find { it.uri != null && note.uri != null && sameDocumentUri(it.uri, note.uri) }
        val targetId = existing?.id ?: note.id
        val jump = headingFragment?.takeIf { it.isNotBlank() }?.let { PendingHeadingJump(targetId, it, UUID.randomUUID().toString()) }
        change { state ->
            state.copy(
                tabs = if (existing != null) state.tabs.map { if (it.id == existing.id) it.copy(uri = note.uri, relative = note.relative ?: it.relative) else it } else state.tabs + note,
                activeId = if (activate) targetId else state.activeId,
                pendingHeading = if (activate) jump else state.pendingHeading,
            )
        }
        mutable.value.tabs.firstOrNull { it.id == targetId }?.let(::remember)
        return targetId
    }
    private suspend fun openNoteInternal(
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
            mutable.value.tabs.any { it.uri != null && sameDocumentUri(it.uri, uri.toString()) && writeIsBlocked(it.uri) }
        try {
            val (note, writeOpenState) = withContext(Dispatchers.IO) {
                var loaded = loadNoteForOpen(uri, relative, externalIntentFlags, externalCaller)
                val loadedUriStr = loaded.uri
                val parsedLoaded = loadedUriStr?.let(Uri::parse)
                val wasBlocked = wasBlockedInitially || writeIsBlocked(uri.toString()) || (loadedUriStr != null && writeIsBlocked(loadedUriStr))
                if (parsedLoaded == null || !parsedLoaded.scheme.equals("content", ignoreCase = true)) {
                    loaded to DocumentWriteOpenState.UNCHANGED
                } else if (wasBlocked) {
                    val callerAllowsWrite = externalIntentFlags == null ||
                        (externalIntentFlags and Intent.FLAG_GRANT_WRITE_URI_PERMISSION) != 0
                    val writeTarget = if (externalIntentFlags == null) {
                        documentAccess.resolve(parsedLoaded, writing = true)
                    } else {
                        parsedLoaded
                    }
                    val candidateVerified = callerAllowsWrite &&
                        documentAccess.hasWriteGrant(writeTarget) &&
                        runCatching { resolver.openFileDescriptor(writeTarget, "rw")?.use { true } == true }.getOrDefault(false)
                    if (candidateVerified) {
                        if (writeTarget.toString() != loadedUriStr) {
                            loaded = loaded.copy(uri = writeTarget.toString())
                        }
                        loaded to DocumentWriteOpenState.RESTORED
                    } else {
                        val fallbackLoadedVerified = externalIntentFlags == null &&
                            writeTarget != parsedLoaded &&
                            callerAllowsWrite &&
                            documentAccess.hasWriteGrant(parsedLoaded) &&
                            runCatching { resolver.openFileDescriptor(parsedLoaded, "rw")?.use { true } == true }.getOrDefault(false)
                        if (fallbackLoadedVerified) {
                            loaded to DocumentWriteOpenState.RESTORED
                        } else {
                            loaded to DocumentWriteOpenState.BLOCKED
                        }
                    }
                } else {
                    val ownShareAuthority = "${getApplication<Application>().packageName}.share"
                    val writeTarget = if (externalIntentFlags == null) {
                        documentAccess.resolve(parsedLoaded, writing = true)
                    } else {
                        parsedLoaded
                    }
                    if (externalIntentFlags == null && documentAccess.hasWriteGrant(writeTarget) && writeTarget.toString() != loadedUriStr) {
                        val writeVerified = runCatching {
                            resolver.openFileDescriptor(writeTarget, "rw")?.use { true } == true
                        }.getOrDefault(false)
                        if (writeVerified) {
                            loaded = loaded.copy(uri = writeTarget.toString())
                            loaded to DocumentWriteOpenState.UNCHANGED
                        } else {
                            val loadedWritable = documentAccess.hasWriteGrant(parsedLoaded) &&
                                runCatching { resolver.openFileDescriptor(parsedLoaded, "rw")?.use { true } == true }.getOrDefault(false)
                            if (parsedLoaded.authority != ownShareAuthority && !loadedWritable) {
                                loaded to DocumentWriteOpenState.BLOCKED
                            } else {
                                loaded to DocumentWriteOpenState.UNCHANGED
                            }
                        }
                    } else {
                        val effectiveWriteTarget = if (documentAccess.hasWriteGrant(writeTarget)) writeTarget else parsedLoaded
                        val readOnlyOrUnconfirmedGrant = parsedLoaded.authority != ownShareAuthority &&
                            documentAccess.hasAnyReadOrPendingGrant(parsedLoaded) &&
                            !documentAccess.hasWriteGrant(effectiveWriteTarget)
                        if (readOnlyOrUnconfirmedGrant) {
                            loaded to DocumentWriteOpenState.BLOCKED
                        } else {
                            loaded to DocumentWriteOpenState.UNCHANGED
                        }
                    }
                }
            }
            when (writeOpenState) {
                DocumentWriteOpenState.RESTORED -> {
                    clearDocumentAccessFailure(uri.toString())
                    note.uri?.let(::clearDocumentAccessFailure)
                }
                DocumentWriteOpenState.BLOCKED -> {
                    markDocumentWriteBlocked(uri.toString())
                    note.uri?.let(::markDocumentWriteBlocked)
                }
                DocumentWriteOpenState.UNCHANGED -> Unit
            }
            if (!openRequests.isCurrent(request)) {
                // A newer open or a user tab action owns focus, but every file
                // the user requested still becomes an available tab.
                retainOpenedNote(note, activate = false)
                return JSONObject().put("opened", false)
            }
            var openedTabId: String? = null
            val accepted = performCurrentReaderBarrier { currentActiveId ->
                if (scheduleDirtyAutosave) {
                    mutable.value.tabs.firstOrNull { it.id == currentActiveId }
                        ?.takeIf { it.dirty && it.uri != null }
                        ?.let { scheduleAutosave(it.id) }
                }
                val activate = openRequests.isCurrent(request)
                val carriedHeading = requestedHeading ?: note.uri?.let { targetUri ->
                    pendingAccessHeadings.keys.firstOrNull { key -> sameDocumentUri(key, targetUri) }?.let(pendingAccessHeadings::remove)
                }
                openedTabId = retainOpenedNote(
                    note,
                    activate = activate,
                    headingFragment = carriedHeading?.takeIf { activate && it.isNotBlank() },
                )
                if (writeOpenState == DocumentWriteOpenState.RESTORED) {
                    openedTabId?.let { id ->
                        if (mutable.value.tabs.firstOrNull { it.id == id }?.dirty == true) {
                            scheduleAutosave(id)
                        }
                    }
                }
            }
            if (!accepted || openedTabId == null) {
                if (!openRequests.isCurrent(request)) retainOpenedNote(note, activate = false)
                else readerBarrierFailed()
                return JSONObject().put("opened", false)
            }
            return JSONObject().put("opened", true).put("id", openedTabId).put("uri", note.uri ?: uri.toString())
        } catch (cancelled: kotlinx.coroutines.CancellationException) {
            throw cancelled
        } catch (error: Exception) {
            if (wasBlockedInitially) markDocumentWriteBlocked(uri.toString())
            if (!alwaysReportError && !openRequests.isCurrent(request)) return JSONObject().put("opened", false)
            val msg = if (isDocumentAccessFailure(error)) {
                if (requestedHeading != null) pendingAccessHeadings[uri.toString()] = requestedHeading
                requestDocumentAccess(uri.toString(), mutable.value.tabs.firstOrNull { it.uri?.let { raw -> sameDocumentUri(raw, uri.toString()) } == true }, writing = false, explicit = true)
            } else {
                "$errorPrefix: ${error.message}".also(::fail)
            }
            return JSONObject().put("opened", false).put("message", msg)
        }
    }
    fun open(uri: Uri, relative: String? = null, pendingHeading: String? = null): Job =
        openDocument(uri, relative, pendingHeading = pendingHeading)
    internal fun openDocument(
        uri: Uri,
        relative: String? = null,
        externalIntentFlags: Int? = null,
        externalCaller: ExternalIntentCaller = ExternalIntentCaller(),
        pendingHeading: String? = null,
    ): Job {
        val request = openRequests.begin()
        return viewModelScope.launch {
            openNoteInternal(
                uri = uri,
                relative = relative,
                headingFragment = pendingHeading,
                externalIntentFlags = externalIntentFlags,
                externalCaller = externalCaller,
                request = request,
            )
        }
    }
    private suspend fun writeStagedPortableWithRecovery(
        target: Uri,
        markdown: String,
        savedBaselineMarkdown: String,
        updatedAssets: JSONObject,
        baselineAssets: JSONObject,
        diskChangedMessage: String,
        writeFailureMessage: String,
        prepareBeforeWrite: () -> Unit = {},
        recheckSnapshotBeforeWrite: () -> Unit = {},
        commitOnSuccess: suspend () -> Unit,
    ) {
        val staged = File(getApplication<Application>().cacheDir, "agent-portable-${UUID.randomUUID()}.smd.gz")
        try {
            val backup = resolver.openInputStream(target)?.use { readLimited(it, 120_000_000) }
                ?: error("Cannot read the current portable note")
            require(media.portableEnvelopeMatches(backup.inputStream(), savedBaselineMarkdown, baselineAssets)) {
                diskChangedMessage
            }
            recheckSnapshotBeforeWrite()
            staged.outputStream().use { media.writeFmd(it, markdown, updatedAssets, baselineAssets) }
            verifyExportHeader(staged, NativeExportFormat.PORTABLE_SMD)
            val stagedBytes = staged.readBytes()
            prepareBeforeWrite()
            val latestBytes = resolver.openInputStream(target)?.use { readLimited(it, 120_000_000) }
                ?: error("Cannot recheck the current portable note before saving")
            require(latestBytes.contentEquals(backup)) { "The portable note changed on disk; no changes were saved" }
            recheckSnapshotBeforeWrite()
            try {
                resolver.openOutputStream(target, "wt")?.use { output -> staged.inputStream().use { it.copyTo(output) }; output.flush() }
                    ?: error(writeFailureMessage)
                val postWriteObserver = portablePostWriteObserver
                postWriteObserver?.takeIf { portablePostWriteObserver === it }?.invoke()
                commitOnSuccess()
            } catch (error: Exception) {
                withContext(kotlinx.coroutines.NonCancellable) {
                    runCatching {
                        val current = resolver.openInputStream(target)?.use { readLimited(it, 120_000_000) }
                            ?: error("Cannot inspect the portable note after the failed write")
                        when (portableSaveRecovery(current, backup, stagedBytes)) {
                            PortableSaveRecovery.ORIGINAL_INTACT -> Unit
                            PortableSaveRecovery.RESTORE_OUR_WRITE -> {
                                resolver.openOutputStream(target, "wt")?.use { it.write(backup); it.flush() }
                                    ?: error("Cannot restore the previous portable note")
                                val restored = resolver.openInputStream(target)?.use { readLimited(it, 120_000_000) }
                                require(restored != null && restored.contentEquals(backup)) { "Cannot confirm restoration of the previous portable note" }
                            }
                            PortableSaveRecovery.LEAVE_CONCURRENT_BYTES -> error("The portable destination changed after the write; it was left intact to avoid overwriting newer bytes")
                        }
                    }.getOrElse { rollbackError ->
                        rollbackError.addSuppressed(error)
                        throw IllegalStateException("The portable save failed and the destination was not overwritten during recovery. Inspect it or reopen it from disk before editing.", rollbackError)
                    }
                }
                throw error
            }
        } finally {
            staged.delete()
        }
    }
    internal suspend fun saveAgentPortable(id: String, expectedRevision: String) {
        if (requestWriteAccessIfBlocked(id)) throw SecurityException(DOCUMENT_ACCESS_MESSAGE)
        require(mutable.value.activeId == id) { "Select the portable note before saving it on Android" }
        require(performReaderBarrier(id) { }) { "The note draft could not be synchronized before saving" }
        val note = mutable.value.tabs.firstOrNull { it.id == id } ?: error("The note is no longer open")
        require(note.portable && note.uri != null) { "This portable note has no saved destination" }
        require(agentContentRevision(note.content).equals(expectedRevision, ignoreCase = true)) { "The note changed since the supplied revision; no changes were saved" }
        val assets = media.portableAssets(note.assetDirectory)
        var openedDirectory: String? = null
        try {
            withContext(Dispatchers.IO) {
                documentWrites.withLock {
                    val latest = mutable.value.tabs.firstOrNull { it.id == id } ?: error("The note is no longer open")
                    require(latest == note && agentContentRevision(latest.content).equals(expectedRevision, ignoreCase = true)) {
                        "The note changed since the supplied revision; no changes were saved"
                    }
                    val target = resolveVerifiedWriteDestination(Uri.parse(latest.uri ?: error("This portable note has no saved destination")))
                    var nextDirectory = ""
                    writeStagedPortableWithRecovery(
                        target = target,
                        markdown = note.content,
                        savedBaselineMarkdown = note.saved,
                        updatedAssets = assets,
                        baselineAssets = assets,
                        diskChangedMessage = "The portable note changed on disk; reopen it before saving",
                        writeFailureMessage = "Cannot save the portable note",
                        prepareBeforeWrite = {
                            val reuseExisting = note.assetDirectory != null && media.hasExactLocalPortableAssets(note.assetDirectory, assets)
                            nextDirectory = if (reuseExisting) {
                                note.assetDirectory!!
                            } else {
                                media.materializePortableDirectory(assets, reuseFromDirectory = note.assetDirectory).also { openedDirectory = it }
                            }
                        },
                        commitOnSuccess = {
                            withContext(Dispatchers.Main) {
                                val current = mutable.value.tabs.firstOrNull { it.id == id }
                                require(current == note && current?.let { agentContentRevision(it.content).equals(expectedRevision, ignoreCase = true) } == true) {
                                    "The note changed while it was saving; the portable file was restored"
                                }
                                recordPortableBaseline(id, nextDirectory)
                                change { state -> state.copy(tabs = state.tabs.map { if (it.id == id) it.copy(saved = note.content, assetsDirty = false, uri = target.toString(), assetDirectory = nextDirectory) else it }, conflictedTabIds = state.conflictedTabIds - id, busy = false, message = "Portable note saved") }
                                mutable.value.tabs.firstOrNull { it.id == id }?.let(::remember)
                                openedDirectory = null
                            }
                        },
                    )
                }
            }
        } finally {
            openedDirectory?.let { File(getApplication<Application>().filesDir, "portable-assets/$it").deleteRecursively() }
        }
    }
    internal suspend fun saveAgentAs(id: String, expectedRevision: String, requestedFilename: String): Pair<String, String> {
        require(mutable.value.activeId == id) { "Select the note before saving it on Android" }
        require(performReaderBarrier(id) { }) { "The note draft could not be synchronized before saving" }
        val note = mutable.value.tabs.firstOrNull { it.id == id } ?: error("The note is no longer open")
        require(agentContentRevision(note.content).equals(expectedRevision, ignoreCase = true)) { "The note changed since the supplied revision; no changes were saved" }
        val format = if (note.portable) NativeExportFormat.PORTABLE_SMD else NativeExportFormat.MARKDOWN
        val filename = ExportFilename.suggestedName(requestedFilename, format)
        val mime = format.mimeType
        val location = noteLocation()
        val locationTree = location.takeIf { it.isNotBlank() }?.let(Uri::parse)?.takeIf { DocumentsContract.isTreeUri(it) }
        val assets = if (note.portable) media.portableAssets(note.assetDirectory) else JSONObject()
        return documentWrites.withLock {
            val current = mutable.value.tabs.firstOrNull { it.id == id } ?: error("The note is no longer open")
            require(current == note && agentContentRevision(current.content).equals(expectedRevision, ignoreCase = true)) {
                "The note changed since the supplied revision; no changes were saved"
            }
            val (destination, savedName) = withContext(Dispatchers.IO) {
                media.writeAgentDocument(filename, mime, location) { uri, output ->
                    if (note.portable) media.writeFmd(output, note.content, assets, savedPortableAssets[note.id])
                    else {
                        copyAttachments(note, uri, locationTree)
                        output.write(note.content.toByteArray(Charsets.UTF_8))
                    }
                }
            }
            try {
                withContext(Dispatchers.Main) {
                    val latest = mutable.value.tabs.firstOrNull { it.id == id }
                    require(latest == note && latest?.let { agentContentRevision(it.content).equals(expectedRevision, ignoreCase = true) } == true) {
                        "The note changed while Save As was writing; the new copy was removed"
                    }
                    if (note.portable) recordPortableBaseline(id, note.assetDirectory)
                    change { state -> state.copy(tabs = state.tabs.map { if (it.id == id) it.copy(uri = destination.toString(), name = savedName, saved = note.content, assetsDirty = false, assetDirectory = note.assetDirectory) else it }, conflictedTabIds = state.conflictedTabIds - id, pendingSaveConflictNoteId = state.pendingSaveConflictNoteId?.takeUnless { it == id }, busy = false, message = "Saved as $savedName") }
                    mutable.value.tabs.firstOrNull { it.id == id }?.let(::remember)
                }
            } catch (error: Exception) {
                withContext(Dispatchers.IO) { runCatching { media.deleteAgentDocument(destination) } }
                throw error
            }
            destination.toString() to savedName
        }
    }
    internal suspend fun writeAgentExport(content: String, assets: JSONObject, format: String, requestedFilename: String, rawPdfOptions: String, archive: Boolean = format == "mdzip"): Pair<Uri, String> {
        val isMarkdownArchive = archive || format == "mdzip"
        if (format == "md" || isMarkdownArchive) {
            val trimmedName = if (isMarkdownArchive && requestedFilename.endsWith(".zip", ignoreCase = true)) {
                requestedFilename.dropLast(4)
            } else requestedFilename
            val mdFilename = ExportFilename.suggestedName(trimmedName, NativeExportFormat.MARKDOWN)
            return withContext(Dispatchers.IO) {
                MarkdownExport(getApplication(), mdFilename, content, assets).use { bundle ->
                    bundle.save(noteLocation(), isMarkdownArchive)
                }
            }
        }
        val nativeFormat = NativeExportFormat.fromShareFormat(format)
        val filename = ExportFilename.suggestedName(requestedFilename, nativeFormat)
        val staged = File(getApplication<Application>().cacheDir, "agent-export-${UUID.randomUUID()}.${nativeFormat.extension}")
        try {
            when (nativeFormat) {
                NativeExportFormat.PDF -> {
                    val provided = JSONObject(rawPdfOptions)
                    val safe = JSONObject()
                    listOf("pageSize", "margin", "fontSize", "lineHeight", "paragraphSpacing", "fontFamily", "pageNumbers", "themed")
                        .forEach { key -> if (provided.has(key)) safe.put(key, provided.get(key)) }
                    export(content, safe.toString(), assets, destination = Uri.fromFile(staged))
                }
                NativeExportFormat.PORTABLE_SMD -> withContext(Dispatchers.IO) {
                    staged.outputStream().use { media.writeFmd(it, content, assets) }
                    verifyExportHeader(staged, nativeFormat)
                }
                NativeExportFormat.MARKDOWN -> error("Markdown exports are handled via MarkdownExport")
            }
            require(staged.length() in 1L..(128L * 1024 * 1024)) { "Agent downloads are limited to 128 MiB per export" }
            val (uri, savedName) = withContext(Dispatchers.IO) {
                media.writeAgentDocument(filename, nativeFormat.mimeType, noteLocation()) { _, output ->
                    staged.inputStream().use { it.copyTo(output) }
                }
            }
            return uri to savedName
        } finally { staged.delete() }
    }
    internal fun bundlePortableAssetKeys(directory: String?): List<String> =
        runCatching { media.portableAssetKeys(directory) }.getOrDefault(emptyList())
    private fun localPortableAssetKeys(note: Note): List<String> {
        val keys = LinkedHashSet(bundlePortableAssetKeys(note.assetDirectory))
        val sources = JSONArray(markdownImageSourcesJson(note.content))
        for (i in 0 until sources.length()) {
            val source = sources.getString(i)
            if (!keys.contains(source) && media.validKey(source) && media.local(source, note.assetDirectory) != null) {
                keys.add(source)
            }
        }
        return keys.toList()
    }
    private fun canWritePortableNatively(note: Note): Boolean {
        if (note.content.contains("![[")) return false
        val directory = note.assetDirectory
        if (directory != null) {
            if (!Regex("[a-f0-9-]{36}").matches(directory)) return false
            if (runCatching { media.portableAssetKeys(directory); true }.getOrDefault(false).not()) return false
        }
        val sources = JSONArray(markdownImageSourcesJson(note.content))
        for (i in 0 until sources.length()) {
            val source = sources.getString(i)
            if (!media.validKey(source) || media.local(source, directory) == null) return false
        }
        return true
    }
    private fun collectNativePortableAssets(note: Note): JSONObject {
        val existing = media.portableAssets(note.assetDirectory)
        val assets = JSONObject()
        existing.keys().forEach { key -> assets.put(key, existing.getString(key)) }
        val sources = JSONArray(markdownImageSourcesJson(note.content))
        for (i in 0 until sources.length()) {
            val source = sources.getString(i)
            if (!assets.has(source)) {
                media.local(source, note.assetDirectory)?.let { assets.put(source, media.data(it)) }
            }
        }
        return assets
    }
    fun cancelSaveAs() {
        clearPendingPortableWriteState()
    }
    private suspend fun synchronizeNoteForSave(noteId: String): Pair<Note, Boolean>? {
        var targetOpen = false
        var switchedActiveTab = false
        val barrierAccepted = try {
            performCurrentReaderBarrier { currentActiveId ->
                targetOpen = !closingNoteIds.contains(noteId) && mutable.value.tabs.any { it.id == noteId }
                if (targetOpen && currentActiveId != noteId) {
                    switchedActiveTab = true
                    change { it.copy(activeId = noteId) }
                }
            }
        } catch (cancelled: kotlinx.coroutines.CancellationException) {
            closeAfterSaveNoteId = null
            throw cancelled
        }
        if (!barrierAccepted) {
            readerBarrierFailed()
            closeAfterSaveNoteId = null
            return null
        }
        if (!targetOpen) {
            closeAfterSaveNoteId = null
            return null
        }
        val note = mutable.value.tabs.find { it.id == noteId }?.takeUnless { closingNoteIds.contains(noteId) }
        if (note == null) {
            closeAfterSaveNoteId = null
            return null
        }
        return note to switchedActiveTab
    }
    private suspend fun launchPortableWriteOrFallback(note: Note, save: Boolean, switchedActiveTab: Boolean) {
        if (requestPortableWrite == null && readerFlushRequester == null && readerFlushStatusRequester == null && !readerStateIsNativeAuthoritative(note.id)) {
            clearPendingPortableWriteState()
            fail("The reader is not ready")
            return
        }
        val useNativeFastPath = withContext(Dispatchers.IO) { canWritePortableNatively(note) }
        if (useNativeFastPath) {
            busy(true)
            try {
                val latest = mutable.value.tabs.find { it.id == note.id }
                    ?.takeUnless { closingNoteIds.contains(note.id) }
                    ?: error("The note is no longer open")
                require(latest.content == note.content) { "The note changed while preparing the portable save; try saving again" }
                val assets = withContext(Dispatchers.IO) { collectNativePortableAssets(latest) }
                writePortable(latest.id, latest.content, assets, save = save, originalContent = latest.content)
            } catch (cancelled: kotlinx.coroutines.CancellationException) {
                clearPendingPortableWriteState()
                mutable.value = mutable.value.copy(busy = false)
                throw cancelled
            } catch (error: Exception) {
                clearPendingPortableWriteState()
                val fallback = "Could not save portable note: ${error.message}"
                if (save) reportDocumentSaveFailure(note.id, error, fallback) else fail(fallback)
            }
            return
        }
        val localAssets = withContext(Dispatchers.IO) { localPortableAssetKeys(note) }
        if (switchedActiveTab && (readerFlushStatusRequester != null || readerFlushRequester != null) && !awaitReaderSnapshot(note.id)) {
            clearPendingPortableWriteState()
            readerBarrierFailed()
            return
        }
        val current = mutable.value.tabs.find { it.id == note.id }
        if (closingNoteIds.contains(note.id) || current == null || current.content != note.content) {
            clearPendingPortableWriteState()
            fail("Could not save portable note: ${if (current == null || closingNoteIds.contains(note.id)) "The note is no longer open" else "The note changed while preparing the portable save; try saving again"}")
            return
        }
        if (requestPortableWrite?.invoke(PortableWriteRequest(save = save, noteId = note.id, localAssets = localAssets)) == true) return
        clearPendingPortableWriteState()
        fail("The reader is not ready")
    }
    fun beginSaveAs(noteId: String = mutable.value.active.id) {
        if (mutable.value.busy) return
        viewModelScope.launch {
            val (note, _) = synchronizeNoteForSave(noteId) ?: return@launch
            val picker = requestSaveAs
            if (picker != null) picker(note) else closeAfterSaveNoteId = null
        }
    }
    fun completePortableSaveAs(uri: Uri, noteId: String = portableSaveAsNoteId ?: mutable.value.active.id) {
        if (mutable.value.busy) return
        viewModelScope.launch {
            if (closingNoteIds.contains(noteId) || mutable.value.tabs.none { it.id == noteId }) {
                clearPendingPortableWriteState()
                fail("Could not save portable note: The note is no longer open")
                return@launch
            }
            if (requestPortableWrite == null && readerFlushRequester == null && readerFlushStatusRequester == null && !readerStateIsNativeAuthoritative(noteId)) {
                clearPendingPortableWriteState()
                fail("The reader is not ready")
                return@launch
            }
            promptedAssetAccess.removeAll { it.startsWith("$noteId\n") }
            val synced = synchronizeNoteForSave(noteId) ?: run {
                clearPendingPortableWriteState()
                return@launch
            }
            val (note, switchedActiveTab) = synced
            portableOutput = uri
            portableDestinationIsNew = true
            portableSaveAsNoteId = note.id
            portableForceOverwrite = true
            launchPortableWriteOrFallback(note, save = false, switchedActiveTab = switchedActiveTab)
        }
    }
    fun saveManual(noteId: String = mutable.value.active.id, forceOverwrite: Boolean = false) {
        if (mutable.value.busy) return
        if (requestWriteAccessIfBlocked(noteId, explicit = true)) {
            closeAfterSaveNoteId = null
            return
        }
        viewModelScope.launch {
            promptedAssetAccess.removeAll { it.startsWith("$noteId\n") }
            val (note, switchedActiveTab) = synchronizeNoteForSave(noteId) ?: return@launch
            if (note.uri == null) {
                if (note.portable) portableSaveAsNoteId = note.id
                val picker = requestSaveAs
                if (picker != null) picker(note) else {
                    portableSaveAsNoteId = null
                    closeAfterSaveNoteId = null
                }
                return@launch
            }
            if (!forceOverwrite && note.id in mutable.value.conflictedTabIds) {
                mutable.value = mutable.value.copy(pendingSaveConflictNoteId = note.id)
                return@launch
            }
            if (note.portable) {
                portableSaveAsNoteId = null
                portableForceOverwrite = forceOverwrite
                launchPortableWriteOrFallback(note, save = true, switchedActiveTab = switchedActiveTab)
            } else {
                save(uri = null, noteId = note.id, forceOverwrite = forceOverwrite, manualGuard = true)
            }
        }
    }
    fun dismissSaveConflict() {
        closeAfterSaveNoteId = null
        mutable.value = mutable.value.copy(pendingSaveConflictNoteId = null)
    }
    fun resolveSaveConflict(choice: String) {
        val id = mutable.value.pendingSaveConflictNoteId ?: mutable.value.active.id
        mutable.value = mutable.value.copy(pendingSaveConflictNoteId = null)
        when (choice) {
            "overwrite" -> saveManual(noteId = id, forceOverwrite = true)
            "save_as" -> beginSaveAs(noteId = id)
            else -> closeAfterSaveNoteId = null
        }
    }
    private lateinit var reloadCoordinatorCache: ReloadFromDiskCoordinator
    private val reloadCoordinator: ReloadFromDiskCoordinator
        get() = if (::reloadCoordinatorCache.isInitialized) reloadCoordinatorCache else synchronized(this) {
            if (!::reloadCoordinatorCache.isInitialized) {
                reloadCoordinatorCache = ReloadFromDiskCoordinator(
                    scope = viewModelScope,
                    resolver = resolver,
                    documentAccess = { documentAccess },
                    media = media,
                    closedNoteStore = closedNoteStore,
                    readerActionMutex = readerActionMutex,
                    closedNoteMutex = closedNoteMutex,
                    documentWrites = documentWrites,
                    closingNoteIds = closingNoteIds,
                    autosavePending = autosavePending,
                    readerEcho = readerEcho,
                    savedPortableAssets = savedPortableAssets,
                    viewModelRetired = viewModelRetired,
                    readState = { mutable.value },
                    changeState = ::change,
                    readClosedNoteRefs = { closedNoteRefs },
                    writeClosedNoteRefs = { closedNoteRefs = it },
                    saveClosedNoteIndex = ::saveClosedNoteIndex,
                    flushActiveNoteLocked = ::flushActiveNoteLocked,
                    flushRecoveryAndAwait = ::flushRecoveryAndAwait,
                    readerBarrierFailed = ::readerBarrierFailed,
                    collectNativePortableAssets = ::collectNativePortableAssets,
                    cleanupPortableDirectories = ::cleanupPortableDirectories,
                    invalidateNoteAssets = ::invalidateNoteAssets,
                    clearReaderEditProtocol = ::clearReaderEditProtocol,
                    recordPortableBaseline = ::recordPortableBaseline,
                    isDocumentAccessFailure = ::isDocumentAccessFailure,
                    requestDocumentAccess = { rawUri, existingNote, writing, explicit ->
                        requestDocumentAccess(rawUri, existingNote, writing, explicit)
                    },
                    fail = ::fail,
                    readReloadAfterIndexCommitObserver = { reloadAfterIndexCommitObserver },
                )
            }
            reloadCoordinatorCache
        }
    fun reloadFromDisk(id: String = mutable.value.active.id) = reloadCoordinator.reloadFromDisk(id)
    fun save(uri: Uri? = null, noteId: String? = null, expectedRevision: String? = null, forceOverwrite: Boolean = false, manualGuard: Boolean = false, onComplete: ((String?) -> Unit)? = null) = viewModelScope.launch {
        val requestedNoteId = noteId ?: mutable.value.active.id
        if (uri == null && requestWriteAccessIfBlocked(requestedNoteId, explicit = onComplete == null)) {
            closeAfterSaveNoteId = null
            onComplete?.invoke(DOCUMENT_ACCESS_MESSAGE)
            return@launch
        }
        if (requestedNoteId != mutable.value.active.id) {
            closeAfterSaveNoteId = null
            onComplete?.invoke("Select the target note before saving it on Android")
            return@launch
        }
        // Save As keeps its explicit destination, while ordinary Save resolves
        // the current URI only after it owns the document-write lock.
        if (uri == null && mutable.value.tabs.find { it.id == requestedNoteId }?.uri == null) {
            closeAfterSaveNoteId = null
            onComplete?.invoke("This note has no saved location; Save As requires the Android file picker")
            return@launch
        }
        if (!performReaderBarrier(requestedNoteId) { }) {
            closeAfterSaveNoteId = null
            readerBarrierFailed()
            onComplete?.invoke("The note draft could not be synchronized before saving")
            return@launch
        }
        busy(true)
        try {
            var shouldCloseAfterSave = false
            documentWrites.withLock {
            val note = mutable.value.tabs.find { it.id == requestedNoteId }
            if (closingNoteIds.contains(requestedNoteId) || note == null) {
                closeAfterSaveNoteId = null
                mutable.value = mutable.value.copy(busy = false, message = "Save canceled because the note was closed before the write began.")
                onComplete?.invoke("The note was closed before saving")
                return@withLock
            }
            if (expectedRevision != null && !agentContentRevision(note.content).equals(expectedRevision, ignoreCase = true)) {
                closeAfterSaveNoteId = null
                mutable.value = mutable.value.copy(busy = false)
                onComplete?.invoke("The note changed since the supplied revision; no changes were saved")
                return@withLock
            }
            val target = uri ?: note.uri?.let(Uri::parse)
            if (target == null) {
                closeAfterSaveNoteId = null
                mutable.value = mutable.value.copy(busy = false, message = "Save canceled because the note no longer has a destination.")
                onComplete?.invoke("The note no longer has a saved destination")
                return@withLock
            }
            val guardDisk = uri == null && !forceOverwrite && (manualGuard || expectedRevision != null)
            val savedResult = withContext(Dispatchers.IO) {
                require(!note.portable || uri != null) { "Use portable save for this SMD file" }
                val destination = if (uri != null) prepareExportDestination(target, NativeExportFormat.MARKDOWN, allowRename = true) else resolveVerifiedWriteDestination(target)
                if (guardDisk && !diskMatchesBaseline(destination, note)) throw ExternalConflictDetectedException()
                copyAttachments(note, destination)
                resolver.openOutputStream(destination, "wt")?.use { it.write(note.content.toByteArray()) } ?: error("Writing permission is unavailable; use Save as")
                documentAccess.persist(destination)
                val resolvedName = resolveDisplayName(destination) ?: ExportFilename.suggestedName(note.name, NativeExportFormat.MARKDOWN)
                Triple(destination, resolvedName, resolveOpenFolderRelativeOnIo(destination))
            }
            val (writtenTarget, savedName, openRel) = savedResult
            savedPortableAssets.remove(note.id)
            autosavePending.remove(note.id)
            clearDocumentAccessFailure(writtenTarget.toString())
            val nextRelative = if (uri != null) openRel else (openRel ?: note.relative)
            change { s -> s.copy(busy = false, tabs = s.tabs.map { if (it.id == note.id) it.copy(uri = writtenTarget.toString(), name = savedName, saved = note.content, relative = nextRelative, assetsDirty = false, assetDirectory = null) else it }, conflictedTabIds = s.conflictedTabIds - note.id, pendingSaveConflictNoteId = s.pendingSaveConflictNoteId?.takeUnless { it == note.id }, message = "Saved") }
            mutable.value.tabs.find { it.id == note.id }?.let(::remember)
            if (openRel != null) mutable.value.folder?.let { listFolder(Uri.parse(it), listedRelative) }
            if (closeAfterSaveNoteId == note.id) {
                closeAfterSaveNoteId = null
                shouldCloseAfterSave = true
            }
            onComplete?.invoke(null)
            }
            if (shouldCloseAfterSave) close(requestedNoteId)
        } catch (_: ExternalConflictDetectedException) {
            autosavePending.remove(requestedNoteId)
            if (manualGuard) {
                change { s -> s.copy(busy = false, conflictedTabIds = s.conflictedTabIds + requestedNoteId, pendingSaveConflictNoteId = requestedNoteId) }
            } else {
                closeAfterSaveNoteId = null
                change { s -> s.copy(busy = false, conflictedTabIds = s.conflictedTabIds + requestedNoteId, message = "This file changed on disk. Autosave is paused for this tab.") }
            }
            onComplete?.invoke("The note changed on disk; resolve the conflict or Save As before saving")
        } catch (error: Exception) {
            closeAfterSaveNoteId = null
            val message = if (uri == null) reportDocumentSaveFailure(requestedNoteId, error, "Could not save note: ${error.message}")
                else "Could not save note: ${error.message}".also(::fail)
            onComplete?.invoke(message)
        }
    }
    private lateinit var safWorkspaceCache: SafWorkspaceCoordinator
    private val safWorkspace: SafWorkspaceCoordinator
        get() = if (::safWorkspaceCache.isInitialized) safWorkspaceCache else synchronized(this) {
            if (!::safWorkspaceCache.isInitialized) {
                safWorkspaceCache = SafWorkspaceCoordinator(
                    owner = this, scope = viewModelScope, prefs = prefs, windowPrefs = windowPrefs,
                    resolver = resolver, readDocumentAccess = { documentAccess },
                    documentWrites = documentWrites, isOwnerRetired = { viewModelRetired.get() },
                    confirmedTreeDocumentKeys = confirmedTreeDocumentKeys,
                    readState = { mutable.value }, writeState = { mutable.value = it }, changeState = ::change,
                    readListedRelative = { listedRelative }, writeListedRelative = { listedRelative = it },
                    readListFolderSeq = { listFolderSeq }, writeListFolderSeq = { listFolderSeq = it },
                    readListFolderJob = { listFolderJob }, writeListFolderJob = { listFolderJob = it },
                    readRecent = { recentMutable.value }, storeRecent = ::storeRecent,
                    applyWorkspaceFolder = { uri -> applyWorkspaceFolder(uri) }, fail = ::fail, sameDocumentUri = ::sameDocumentUri,
                    liveViewModels = { liveStudioViewModels(this) }, readVmState = { it.mutable.value },
                    changeVmState = { vm, block -> vm.change(block) }, readVmListFolderSeq = { it.listFolderSeq },
                    readVmListedRelative = { it.listedRelative }, readVmSeededFind = { it.seededFindMutable.value },
                    writeVmSeededFind = { vm, seed -> vm.seededFindMutable.value = seed },
                    refreshVmFolderSearchIfActive = { vm -> if (vm.folderSearchMutable.value.visible && vm.folderSearchMutable.value.query.isNotEmpty()) vm.updateFolderSearch() },
                )
            }
            safWorkspaceCache
        }
    fun setFolder(uri: Uri) = safWorkspace.setFolder(uri)
    fun closeFolder() = safWorkspace.closeFolder()
    fun navigateFolderUp(): Boolean = safWorkspace.navigateFolderUp()
    fun listFolder(uri: Uri, relative: String): Job = safWorkspace.listFolder(uri, relative)
    internal fun relativeInOpenFolder(uri: Uri, folderTreeRaw: String? = mutable.value.folder): String? =
        safWorkspace.relativeInOpenFolder(uri, folderTreeRaw)
    private fun resolveOpenFolderRelativeOnIo(uri: Uri, folderTreeRaw: String? = mutable.value.folder): String? =
        safWorkspace.resolveOpenFolderRelativeOnIo(uri, folderTreeRaw)
    private fun trackedEntriesInOpenFolder(
        folderTreeUri: Uri,
        projectedRelativeByDocId: Map<String, String> = emptyMap(),
    ): Map<String, String> = safWorkspace.trackedEntriesInOpenFolder(folderTreeUri, projectedRelativeByDocId)
    private fun updatePersistedMetadata(transformUri: (String) -> String?) =
        safWorkspace.updatePersistedMetadata(transformUri)
    private fun remapPersistedMetadata(remaps: List<UriRemap>) = safWorkspace.remapPersistedMetadata(remaps)
    private fun applyUriRemaps(
        remaps: List<UriRemap>,
        oldFolderPrefix: String? = null,
        newFolderPrefix: String? = null,
        folderTreeRaw: String? = null,
        statusMessage: String? = null,
        preRenameFolderState: Map<StudioViewModel, Pair<Long, String>> = emptyMap(),
    ) = safWorkspace.applyUriRemaps(remaps, oldFolderPrefix, newFolderPrefix, folderTreeRaw, statusMessage, preRenameFolderState)

    fun createFolderNote(
        parentRelative: String = listedRelative,
        rawName: String,
        portable: Boolean = false,
        onComplete: ((Note?) -> Unit)? = null,
    ) {
        val folderRaw = mutable.value.folder
        if (folderRaw.isNullOrBlank()) {
            fail("Open a folder first to create a folder note")
            onComplete?.invoke(null)
            return
        }
        openRequests.invalidate()
        val expectedActiveId = mutable.value.active.id
        viewModelScope.launch {
            var createdDirCleanup: String? = null
            try {
                val fileName = validateFolderEntryName(
                    rawName = rawName,
                    isDirectory = false,
                    currentExtension = if (portable) "smd" else "md",
                )
                val cleanParent = normalizeRelativePath(parentRelative)
                val folderUri = Uri.parse(folderRaw)
                val createdNote = withContext(Dispatchers.IO) {
                    documentWrites.withLock {
                        val pass = SafProjectionPass(resolver)
                        val resolvedParent = resolveSafParentDirectory(documentAccess, pass, folderUri, cleanParent)
                        confirmedTreeDocumentKeys.addAll(pass.confirmedTreeKeys)
                        require(findDuplicateProjectedChild(resolvedParent.children, resolvedParent.treeUri, fileName) == null) {
                            "'$fileName' already exists in this folder"
                        }
                        val mime = if (portable) "application/vnd.supermd.smd" else "text/markdown"
                        val staged = if (portable) File(getApplication<Application>().cacheDir, "create-smd-${UUID.randomUUID()}.smd") else null
                        try {
                            val assetDir = if (staged != null) {
                                staged.outputStream().use { media.writeFmd(it, "", JSONObject()) }
                                verifyExportHeader(staged, NativeExportFormat.PORTABLE_SMD)
                                staged.inputStream().use(media::openFmd).directory.also { createdDirCleanup = it }
                            } else null
                            val rawCreatedUri = DocumentsContract.createDocument(resolver, resolvedParent.parentDocumentUri, mime, fileName)
                                ?: error("The selected folder could not create '$fileName'")
                            val createdUri = canonicalTreeScopedUri(resolvedParent.treeUri, rawCreatedUri)
                            try {
                                resolver.openOutputStream(createdUri, "wt")?.use { out ->
                                    staged?.inputStream()?.use { it.copyTo(out) }
                                    out.flush()
                                } ?: error("Could not write to '$fileName'")
                            } catch (writeError: Exception) {
                                runCatching { DocumentsContract.deleteDocument(resolver, createdUri) }
                                throw writeError
                            }
                            documentAccess.persist(createdUri)
                            canonicalTreeDocumentKey(createdUri)?.let(confirmedTreeDocumentKeys::add)
                            val actualName = (querySingleDocumentMetadata(resolver, createdUri) as? ProviderMetadata.Found)
                                ?.name?.takeIf { it.isNotBlank() } ?: fileName
                            Note(
                                name = actualName,
                                uri = createdUri.toString(),
                                content = "",
                                saved = "",
                                relative = childRelativePath(cleanParent, actualName),
                                assetDirectory = assetDir,
                            )
                        } finally {
                            staged?.delete()
                        }
                    }
                }
                createdDirCleanup = null
                workspaceLinks.invalidate()
                // Expand and display the parent folder before activating the tab so state.files and folderRelative are already in sync.
                listFolder(folderUri, cleanParent).join()
                val accepted = performReaderBarrier(expectedActiveId) {
                    retainOpenedNote(createdNote, activate = true)
                }
                if (!accepted) {
                    retainOpenedNote(createdNote, activate = false)
                }
                mutable.value = mutable.value.copy(message = "Created ${createdNote.name}")
                onComplete?.invoke(createdNote)
            } catch (cancelled: kotlinx.coroutines.CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                createdDirCleanup?.let { File(getApplication<Application>().filesDir, "portable-assets/$it").deleteRecursively() }
                fail("Could not create note: ${error.message}")
                onComplete?.invoke(null)
            }
        }
    }

    fun createSubfolder(
        parentRelative: String = listedRelative,
        rawName: String,
        onComplete: ((FileEntry?) -> Unit)? = null,
    ) {
        val folderRaw = mutable.value.folder
        if (folderRaw.isNullOrBlank()) {
            fail("Open a folder first to create a subfolder")
            onComplete?.invoke(null)
            return
        }
        viewModelScope.launch {
            try {
                val folderName = validateFolderEntryName(rawName, isDirectory = true)
                val cleanParent = normalizeRelativePath(parentRelative)
                val folderUri = Uri.parse(folderRaw)
                val entry = withContext(Dispatchers.IO) {
                    documentWrites.withLock {
                        val pass = SafProjectionPass(resolver)
                        val resolvedParent = resolveSafParentDirectory(documentAccess, pass, folderUri, cleanParent)
                        confirmedTreeDocumentKeys.addAll(pass.confirmedTreeKeys)
                        require(findDuplicateProjectedChild(resolvedParent.children, resolvedParent.treeUri, folderName) == null) {
                            "'$folderName' already exists in this folder"
                        }
                        val rawCreatedUri = DocumentsContract.createDocument(
                            resolver,
                            resolvedParent.parentDocumentUri,
                            DocumentsContract.Document.MIME_TYPE_DIR,
                            folderName,
                        ) ?: error("The selected folder could not create '$folderName'")
                        val createdUri = canonicalTreeScopedUri(resolvedParent.treeUri, rawCreatedUri)
                        val actualName = (querySingleDocumentMetadata(resolver, createdUri) as? ProviderMetadata.Found)
                            ?.name?.takeIf { it.isNotBlank() } ?: folderName
                        FileEntry(actualName, createdUri.toString(), true, childRelativePath(cleanParent, actualName))
                    }
                }
                workspaceLinks.invalidate()
                listFolder(folderUri, cleanParent).join()
                mutable.value = mutable.value.copy(message = "Created folder ${entry.name}")
                onComplete?.invoke(entry)
            } catch (cancelled: kotlinx.coroutines.CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                fail("Could not create subfolder: ${error.message}")
                onComplete?.invoke(null)
            }
        }
    }

    fun renameFolderEntry(
        entryUri: Uri,
        entryRelative: String,
        isDirectory: Boolean,
        requested: String,
        showGlobalError: Boolean = true,
        onResult: (Boolean, String?) -> Unit = { _, _ -> },
    ) = viewModelScope.launch {
        try {
            val cleanRelative = normalizeRelativePath(entryRelative)
            val currentName = cleanRelative.substringAfterLast('/')
            val currentExt = if (isDirectory) "" else noteExtension(currentName)
            val validatedName = validateFolderEntryName(
                rawName = requested,
                isDirectory = isDirectory,
                currentExtension = currentExt,
                hasSavedTarget = !isDirectory,
            )
            if (validatedName == currentName) {
                onResult(true, null)
                return@launch
            }
            performRenameFolderEntry(entryUri, cleanRelative, isDirectory, validatedName)
            onResult(true, null)
        } catch (cancelled: kotlinx.coroutines.CancellationException) {
            throw cancelled
        } catch (error: Exception) {
            val msg = error.message ?: "Could not rename"
            if (showGlobalError) fail("Could not rename: $msg")
            onResult(false, msg)
        }
    }

    private suspend fun performRenameFolderEntry(
        entryUri: Uri,
        cleanRelative: String,
        isDirectory: Boolean,
        validatedName: String,
    ) {
        val folderRaw = mutable.value.folder ?: error("No folder is open")
        val folderUri = Uri.parse(folderRaw)
        val parentRel = parentRelativePath(cleanRelative)
        val currentName = cleanRelative.substringAfterLast('/')
        val liveVms = liveStudioViewModels(this)
        val preRenameFolderState = liveVms.associateWith { vm ->
            vm.listFolderSeq to vm.mutable.value.folderRelative.ifEmpty { vm.listedRelative }
        }
        liveVms.forEach { vm ->
            vm.metadataJob?.cancel()
            val vmFolder = vm.mutable.value.folder
            if (vmFolder != null && sameDocumentUri(vmFolder, folderRaw)) {
                vm.listFolderJob?.cancel()
            }
        }

        withContext(Dispatchers.IO) {
            documentWrites.withLock {
                val pass = SafProjectionPass(resolver)
                val resolvedParent = resolveSafParentDirectory(documentAccess, pass, folderUri, parentRel)
                confirmedTreeDocumentKeys.addAll(pass.confirmedTreeKeys)
                require(findDuplicateProjectedChild(resolvedParent.children, resolvedParent.treeUri, validatedName, ignoreUri = entryUri) == null) {
                    "'$validatedName' already exists in this folder"
                }

                val entryDocId = runCatching { DocumentsContract.getDocumentId(entryUri) }.getOrNull()
                val projectedTarget = resolvedParent.children.firstOrNull { child ->
                    !child.isVirtual &&
                        child.isDirectory == isDirectory &&
                        ((entryDocId != null && child.documentId == entryDocId) || child.displayName == currentName)
                }
                val confirmedEntryTreeUri = projectedTarget?.let {
                    DocumentsContract.buildDocumentUriUsingTree(resolvedParent.treeUri, it.documentId)
                }
                if (confirmedEntryTreeUri != null && !isDirectory) {
                    canonicalTreeDocumentKey(confirmedEntryTreeUri)?.let(confirmedTreeDocumentKeys::add)
                }

                val beforeSubtreeNodes = if (isDirectory && projectedTarget != null) {
                    collectSafSubtree(pass, resolvedParent.treeUri, projectedTarget.documentId, cleanRelative)
                } else {
                    emptyList()
                }
                confirmedTreeDocumentKeys.addAll(pass.confirmedTreeKeys)
                val beforeRelativeByDocId = beforeSubtreeNodes.associate { it.documentId to it.relativePath }
                val trackedBefore = if (isDirectory) {
                    trackedEntriesInOpenFolder(resolvedParent.treeUri, beforeRelativeByDocId)
                } else {
                    emptyMap()
                }

                val ownShareAuthority = "${getApplication<Application>().packageName}.share"
                val treeWritable = documentAccess.hasTreeScopedWriteGrant(resolvedParent.treeUri)
                val targetForRename = confirmedEntryTreeUri
                    ?.takeIf { treeWritable }
                    ?: resolveVerifiedWriteDestination(entryUri)
                if (targetForRename.scheme == "content" &&
                    targetForRename.authority != ownShareAuthority &&
                    !(targetForRename == confirmedEntryTreeUri && treeWritable) &&
                    !documentAccess.hasWriteGrant(targetForRename)
                ) {
                    throw SecurityException("Android did not grant write access to this file")
                }
                val rawRenamedUri = DocumentsContract.renameDocument(resolver, targetForRename, validatedName)
                    ?: error("This storage provider does not support renaming")
                val confirmedInOpenTree = treeWritable && (
                    confirmedEntryTreeUri != null ||
                        isKnownPathContainedInTree(
                            resolvedParent.treeUri.authority,
                            resolvedParent.rootDocumentId,
                            runCatching { DocumentsContract.getDocumentId(rawRenamedUri) }.getOrDefault(""),
                        )
                    )
                val renamedUri = if (confirmedInOpenTree) {
                    canonicalTreeScopedUri(resolvedParent.treeUri, rawRenamedUri)
                } else {
                    rawRenamedUri
                }
                documentAccess.persist(renamedUri)
                val finalName = (querySingleDocumentMetadata(resolver, renamedUri) as? ProviderMetadata.Found)
                    ?.name?.takeIf { it.isNotBlank() } ?: validatedName
                val finalRelative = childRelativePath(parentRel, finalName)

                val (actualNewName, actualNewRelative, remaps) = if (!isDirectory) {
                    confirmedEntryTreeUri?.let(::canonicalTreeDocumentKey)?.let(confirmedTreeDocumentKeys::remove)
                    canonicalTreeDocumentKey(entryUri)?.let(confirmedTreeDocumentKeys::remove)
                    if (confirmedInOpenTree) {
                        canonicalTreeDocumentKey(renamedUri)?.let(confirmedTreeDocumentKeys::add)
                    }
                    Triple(
                        finalName,
                        finalRelative,
                        listOf(UriRemap(entryUri.toString(), renamedUri.toString(), finalName, finalRelative)),
                    )
                } else {
                    beforeSubtreeNodes.filter { !it.isDirectory }.forEach { oldNode ->
                        canonicalTreeDocumentKey(oldNode.treeDocumentUri)?.let(confirmedTreeDocumentKeys::remove)
                    }
                    val afterPass = SafProjectionPass(resolver)
                    val renamedDirDocId = runCatching { DocumentsContract.getDocumentId(renamedUri) }.getOrNull()
                    val afterSubtreeNodes = if (renamedDirDocId != null) {
                        collectSafSubtree(afterPass, resolvedParent.treeUri, renamedDirDocId, finalRelative)
                    } else {
                        val refreshedParent = resolveSafParentDirectory(documentAccess, afterPass, resolvedParent.treeUri, parentRel)
                        val refreshedDir = refreshedParent.children.firstOrNull { it.isDirectory && !it.isVirtual && it.displayName == finalName }
                        if (refreshedDir != null) collectSafSubtree(afterPass, resolvedParent.treeUri, refreshedDir.documentId, finalRelative) else emptyList()
                    }
                    confirmedTreeDocumentKeys.addAll(afterPass.confirmedTreeKeys)
                    val afterByRelative = afterSubtreeNodes.associateBy { it.relativePath }

                    val childRemaps = trackedBefore.mapNotNull { (oldUri, oldRel) ->
                        if (!matchesRelativePrefix(oldRel, cleanRelative)) return@mapNotNull null
                        val updatedRel = remapRelativePrefix(oldRel, cleanRelative, finalRelative) ?: return@mapNotNull null
                        val afterNode = afterByRelative[updatedRel] ?: return@mapNotNull null
                        if (!afterNode.isDirectory) {
                            documentAccess.persist(afterNode.treeDocumentUri)
                            canonicalTreeDocumentKey(afterNode.treeDocumentUri)?.let(confirmedTreeDocumentKeys::add)
                        }
                        UriRemap(oldUri, afterNode.treeDocumentUri.toString(), afterNode.displayName, updatedRel)
                    }
                    Triple(finalName, finalRelative, childRemaps)
                }

                withContext(Dispatchers.Main) {
                    applyUriRemaps(
                        remaps = remaps,
                        oldFolderPrefix = if (isDirectory) cleanRelative else null,
                        newFolderPrefix = if (isDirectory) actualNewRelative else null,
                        folderTreeRaw = folderRaw,
                        statusMessage = "Renamed to $actualNewName",
                        preRenameFolderState = preRenameFolderState,
                    )
                }
            }
        }
    }

    fun openFolderSearch(initialQuery: String? = null) = folderSearchController.openFolderSearch(initialQuery)
    fun updateFolderSearch(
        query: String = folderSearch.value.query,
        caseSensitive: Boolean = folderSearch.value.caseSensitive,
        includeDiagrams: Boolean = folderSearch.value.includeDiagrams,
    ) = folderSearchController.updateFolderSearch(query, caseSensitive, includeDiagrams)
    fun closeFolderSearch() = folderSearchController.closeFolderSearch()
    fun cancelWorkspaceSearch() = folderSearchController.cancelWorkspaceSearch()
    fun openSearchMatch(match: FolderSearchMatch) = folderSearchController.openSearchMatch(match)
    fun consumeSeededFind(nonce: Long) = folderSearchController.consumeSeededFind(nonce)
    internal fun activeMatchesSeedTarget(note: Note, seed: PendingSeededFind): Boolean =
        folderSearchController.activeMatchesSeedTarget(note, seed)

    private data class SafTreeMatch(val folderUri: Uri, val rootId: String, val relativePath: String)

    private fun openNoteForDocument(document: String): Note? = mutable.value.tabs.firstOrNull {
        it.id == document || it.uri?.let { uri -> sameDocumentUri(uri, document) } == true
    }

    private fun noteForAsset(document: String): Note =
        openNoteForDocument(document) ?: error("The asset's document is no longer open")

    private fun findSafTree(noteUri: Uri, allowEmbeddedTreeFallback: Boolean = false): SafTreeMatch? {
        val documentId = runCatching { DocumentsContract.getDocumentId(noteUri) }.getOrDefault("")
        val knownPathProvider = isKnownPathDocumentProvider(noteUri.authority)
        val embeddedTreeRoot = if (DocumentsContract.isTreeUri(noteUri)) {
            runCatching { DocumentsContract.getTreeDocumentId(noteUri) }.getOrNull()
        } else {
            null
        }
        val persisted = (
            resolver.persistedUriPermissions.map { StoredUriGrant(it.uri, it.isReadPermission, it.isWritePermission) } +
                TestAuthorityGrants.persistedSnapshot()
            )
            .filter { it.isReadPermission && DocumentsContract.isTreeUri(it.uri) && it.uri.authority == noteUri.authority }
            .mapNotNull { permission ->
                val root = runCatching { DocumentsContract.getTreeDocumentId(permission.uri) }.getOrNull() ?: return@mapNotNull null
                val contained = (knownPathProvider && isKnownPathContainedInTree(noteUri.authority, root, documentId)) ||
                    (allowEmbeddedTreeFallback && embeddedTreeRoot == root && (!knownPathProvider || isKnownPathContainedInTree(noteUri.authority, root, documentId))) ||
                    relativeInOpenFolder(noteUri, permission.uri.toString()) != null
                if (contained && documentAccess.resolveReadableTreeRoot(permission.uri) != null) root to permission.uri else null
            }
            .maxByOrNull { it.first.length }
        val active = persisted ?: if (allowEmbeddedTreeFallback && embeddedTreeRoot != null) {
            runCatching {
                val builtTree = DocumentsContract.buildTreeDocumentUri(noteUri.authority, embeddedTreeRoot)
                val validContainment = !knownPathProvider || isKnownPathContainedInTree(noteUri.authority, embeddedTreeRoot, documentId)
                if (validContainment && documentAccess.resolveReadableTreeRoot(builtTree) != null) embeddedTreeRoot to builtTree else null
            }.getOrNull()
        } else null
        val (rootId, folderUri) = active ?: return null
        val trimmed = rootId.trimEnd('/')
        val canExtractSyntactically = knownPathProvider || embeddedTreeRoot == rootId
        val relative = documentId.takeIf { canExtractSyntactically && it.startsWith("$trimmed/") }?.removePrefix("$trimmed/")
            ?: documentId.takeIf { canExtractSyntactically && rootId.endsWith(':') && it.startsWith(rootId) }?.removePrefix(rootId)?.trimStart('/')
            ?: relativeInOpenFolder(noteUri, folderUri.toString())
            ?: if (allowEmbeddedTreeFallback && embeddedTreeRoot == rootId) "" else return null
        return SafTreeMatch(folderUri, rootId, relative)
    }

    /** Resolves only an already granted tree or an individually user-selected linked file. */
    private fun resolveLinkedAssetUri(note: Note, source: String): Uri {
        validateRelativeAssetSource(source)
        note.relative?.let { readerAssetPathParts(it.substringBeforeLast('/', ""), source) }
        linkedAssetUri(note, source)?.let { return it }
        val noteUri = note.uri?.let(Uri::parse) ?: throw LinkedAssetAccessRequiredException()
        val tree = findSafTree(noteUri) ?: throw LinkedAssetAccessRequiredException()
        val parts = readerAssetPathParts(tree.relativePath.substringBeforeLast('/', ""), source)
        return readerFolderIndex.resolve(resolver, note.id, tree.folderUri, tree.rootId, parts).uri
    }

    private class PromptWorkspaceNoteAccessException(val targetUri: Uri) : Exception()

    suspend fun openWorkspaceLink(
        documentPath: String,
        target: String,
        fragment: String,
        wikilink: Boolean,
        allowFolderPrompt: Boolean = true,
    ): JSONObject {
        val trimmedTarget = target.trim()
        val trimmedFragment = fragment.trim()
        require(trimmedTarget.length in 1..4096 && trimmedFragment.length <= 1024) { "Invalid workspace link" }
        val stateSnapshot = mutable.value
        val sourceNote = if (documentPath.isNotBlank()) {
            openNoteForDocument(documentPath) ?: run {
                val notice = "The note for this link is no longer open."
                mutable.value = mutable.value.copy(busy = false, message = notice)
                return JSONObject().put("opened", false).put("message", notice)
            }
        } else {
            stateSnapshot.active
        }
        val explicitRelative = isExplicitRelativeWorkspaceTarget(trimmedTarget, wikilink)
        val openFolder = stateSnapshot.folder?.let(Uri::parse)?.let {
            documentAccess.resolveReadableTreeRoot(it)?.first
        }
        val rawNoteUri = sourceNote.uri
        if (rawNoteUri.isNullOrBlank()) {
            if (explicitRelative || openFolder == null) {
                val notice = "Save this note before opening linked notes."
                mutable.value = mutable.value.copy(busy = false, message = notice)
                return JSONObject().put("opened", false).put("message", notice)
            }
        }

        val sourceUri = rawNoteUri?.takeIf { it.isNotBlank() }?.let(Uri::parse)
        val resolved = try {
            withContext(Dispatchers.IO) {
                val cleaned = sanitizeWorkspaceLinkTarget(trimmedTarget)
                if (sourceUri != null && sourceUri.scheme == "file") {
                    return@withContext resolveLocalFileWorkspaceLink(sourceUri, cleaned, wikilink)!!
                }
                fun firstReadableRankedCandidate(candidates: List<WorkspaceResolvedNote>): WorkspaceResolvedNote? {
                    for (candidate in candidates) {
                        canonicalTreeDocumentKey(candidate.uri)?.let(confirmedTreeDocumentKeys::add)
                        val targetUri = documentAccess.resolve(candidate.uri)
                        if (documentAccess.hasReadGrant(targetUri) &&
                            runCatching { resolver.openInputStream(targetUri)?.use { true } == true }.getOrDefault(false)
                        ) {
                            return candidate.copy(uri = targetUri)
                        }
                    }
                    return null
                }
                val treeMatch = when {
                    sourceUri != null -> findSafTree(sourceUri, allowEmbeddedTreeFallback = true)
                        ?: run {
                            val candidateTrees = documentAccess
                                .readableCandidateTrees(sourceUri.authority, openFolder)
                                .map { it.first }
                            candidateTrees.firstNotNullOfOrNull { folderUri ->
                                val rel = runCatching {
                                    workspaceLinks.noteRelativeInTree(folderUri, sourceUri, knownRelative = sourceNote.relative)
                                }.getOrNull()
                                if (rel != null) SafTreeMatch(folderUri, DocumentsContract.getTreeDocumentId(folderUri), rel) else null
                            }
                        }
                    openFolder != null -> SafTreeMatch(openFolder, DocumentsContract.getTreeDocumentId(openFolder), "")
                    else -> null
                }
                if (treeMatch != null) {
                    if (!explicitRelative) {
                        val noteRel = if (sourceUri == null) null else treeMatch.relativePath
                        val ranked = runCatching {
                            workspaceLinks.resolveCandidates(treeMatch.folderUri, noteRelative = noteRel, rawTarget = cleaned, wikilink = true)
                        }.getOrDefault(emptyList())
                        firstReadableRankedCandidate(ranked)?.let { return@withContext it }
                    }
                    val parentRelative = treeMatch.relativePath.substringBeforeLast('/', "")
                    val candidateLists = expandWorkspaceCandidatePaths(parentRelative, cleaned, wikilink)
                    var deniedTreeCandidate: Uri? = null
                    for (parts in candidateLists) {
                        val relJoined = parts.joinToString("/")
                        val indexedUri = try {
                            readerFolderIndex.resolve(resolver, sourceNote.id, treeMatch.folderUri, treeMatch.rootId, parts).uri
                        } catch (_: LinkedAssetAccessRequiredException) {
                            null
                        } catch (_: SecurityException) {
                            null
                        } catch (_: UnsupportedOperationException) {
                            null
                        } catch (_: java.io.FileNotFoundException) {
                            null
                        }
                        if (indexedUri != null) {
                            canonicalTreeDocumentKey(indexedUri)?.let(confirmedTreeDocumentKeys::add)
                            val targetUri = documentAccess.resolve(indexedUri)
                            return@withContext WorkspaceResolvedNote(targetUri, parts.last(), relJoined)
                        }
                        val candidateDocId = if (treeMatch.rootId.endsWith(':')) {
                            "${treeMatch.rootId}$relJoined"
                        } else {
                            "${treeMatch.rootId.trimEnd('/')}/$relJoined"
                        }
                        val candidateUri = documentAccess.resolve(
                            DocumentsContract.buildDocumentUriUsingTree(treeMatch.folderUri, candidateDocId),
                        )
                        if (!documentAccess.hasReadGrant(candidateUri)) {
                            if (deniedTreeCandidate == null) deniedTreeCandidate = candidateUri
                            continue
                        }
                        val readable = try {
                            resolver.openInputStream(candidateUri)?.use { true } == true
                        } catch (_: java.io.FileNotFoundException) {
                            false
                        } catch (error: Exception) {
                            if (isDocumentAccessFailure(error) && deniedTreeCandidate == null) {
                                deniedTreeCandidate = candidateUri
                            }
                            false
                        }
                        if (readable) {
                            return@withContext WorkspaceResolvedNote(candidateUri, parts.last(), relJoined)
                        }
                    }
                    if (explicitRelative && sourceUri != null) {
                        val rankedRel = runCatching {
                            workspaceLinks.resolveCandidates(treeMatch.folderUri, noteRelative = treeMatch.relativePath, rawTarget = cleaned, wikilink = false)
                        }.getOrDefault(emptyList())
                        firstReadableRankedCandidate(rankedRel)?.let { return@withContext it }
                    }
                    if (deniedTreeCandidate != null) {
                        throw PromptWorkspaceNoteAccessException(deniedTreeCandidate)
                    }
                    throw WorkspaceLinkException("Linked note not found: ${Uri.decode(cleaned)}")
                }
                if (!explicitRelative && openFolder != null) {
                    val ranked = runCatching {
                        workspaceLinks.resolveCandidates(openFolder, noteRelative = null, rawTarget = cleaned, wikilink = true)
                    }.getOrDefault(emptyList())
                    firstReadableRankedCandidate(ranked)?.let { return@withContext it }
                }

                val nonNullSourceUri = sourceUri ?: throw WorkspaceLinkException("Save this note before opening linked notes.")
                val candidateLists = expandWorkspaceCandidatePaths("", cleaned, wikilink)
                val documentId = runCatching { DocumentsContract.getDocumentId(nonNullSourceUri) }.getOrDefault("")
                val sep = maxOf(documentId.lastIndexOf('/'), documentId.lastIndexOf(':'))

                linkedAssetUri(sourceNote, cleaned)?.let { grantedUri ->
                    val resolvedGranted = documentAccess.resolve(grantedUri)
                    val grantedReadable = documentAccess.hasReadGrant(resolvedGranted) &&
                        runCatching { resolver.openInputStream(resolvedGranted)?.use { true } == true }.getOrDefault(false)
                    if (grantedReadable) {
                        val firstParts = candidateLists.first()
                        return@withContext WorkspaceResolvedNote(resolvedGranted, firstParts.last(), firstParts.joinToString("/"))
                    }
                }

                var deniedCandidate: Uri? = null
                for (parts in candidateLists) {
                    val relJoined = parts.joinToString("/")
                    val siblingDocId = if (sep >= 0) documentId.substring(0, sep + 1) + relJoined else relJoined
                    val rawCandidate = if (documentId.isNotEmpty() && nonNullSourceUri.authority != null) {
                        DocumentsContract.buildDocumentUri(nonNullSourceUri.authority, siblingDocId)
                    } else {
                        nonNullSourceUri.buildUpon().path((nonNullSourceUri.path?.substringBeforeLast('/', "") ?: "") + "/" + relJoined).build()
                    }
                    val openMatch = mutable.value.tabs.firstOrNull { tab ->
                        tab.uri?.let { existingUri -> sameDocumentUri(existingUri, rawCandidate.toString()) } == true
                    }?.uri?.let(Uri::parse)
                    val candidateUri = documentAccess.resolve(openMatch ?: rawCandidate)
                    if (!documentAccess.hasReadGrant(candidateUri)) {
                        if (deniedCandidate == null) deniedCandidate = candidateUri
                        continue
                    }
                    val readable = try {
                        resolver.openInputStream(candidateUri)?.use { true } == true
                    } catch (_: java.io.FileNotFoundException) {
                        false
                    } catch (error: Exception) {
                        if (isDocumentAccessFailure(error) && deniedCandidate == null) {
                            deniedCandidate = candidateUri
                        }
                        false
                    }
                    if (readable) {
                        return@withContext WorkspaceResolvedNote(candidateUri, parts.last(), relJoined)
                    }
                }
                if (!explicitRelative) {
                    return@withContext null
                }
                if (deniedCandidate != null) {
                    throw PromptWorkspaceNoteAccessException(deniedCandidate)
                }
                throw WorkspaceLinkException("Linked note not found: ${Uri.decode(cleaned)}")
            }
        } catch (cancelled: kotlinx.coroutines.CancellationException) {
            throw cancelled
        } catch (prompt: PromptWorkspaceNoteAccessException) {
            val targetStr = prompt.targetUri.toString()
            if (trimmedFragment.isNotEmpty()) pendingAccessHeadings[targetStr] = trimmedFragment
            val notice = requestDocumentAccess(targetStr, openNoteForDocument(targetStr), writing = false, explicit = true)
            return JSONObject().put("opened", false).put("message", notice)
        } catch (security: SecurityException) {
            val msg = security.message ?: DOCUMENT_ACCESS_MESSAGE
            mutable.value = mutable.value.copy(busy = false, message = msg)
            return JSONObject().put("opened", false).put("message", msg)
        } catch (error: WorkspaceLinkException) {
            val msg = error.message ?: "Invalid relative note path."
            mutable.value = mutable.value.copy(busy = false, message = msg)
            return JSONObject().put("opened", false).put("message", msg)
        }

        if (resolved == null) {
            val notice = if (allowFolderPrompt) {
                "Folder permission is needed to follow links from ${sourceNote.name}. Choose its containing folder."
            } else {
                "Choose the folder containing ${sourceNote.name} to follow relative links."
            }
            val prompt = if (allowFolderPrompt && sourceUri != null) {
                WorkspaceFolderPrompt(
                    noteId = sourceNote.id,
                    noteName = sourceNote.name,
                    initialUri = sourceUri,
                    target = trimmedTarget,
                    fragment = trimmedFragment,
                    wikilink = wikilink,
                )
            } else null
            mutable.value = mutable.value.copy(folderAccessPrompt = prompt, message = notice)
            return JSONObject().put("opened", false).put("promptedFolderAccess", prompt != null).put("message", notice)
        }

        return openNoteInternal(
            resolved.uri,
            resolved.relative,
            headingFragment = trimmedFragment,
            scheduleDirtyAutosave = true,
            alwaysReportError = true,
            errorPrefix = "Could not open linked note",
        )
    }

    private lateinit var readerAssetCoordinatorCache: ReaderAssetCoordinator
    private val readerAssetCoordinator: ReaderAssetCoordinator
        get() = if (::readerAssetCoordinatorCache.isInitialized) readerAssetCoordinatorCache else synchronized(this) {
            if (!::readerAssetCoordinatorCache.isInitialized) {
                readerAssetCoordinatorCache = ReaderAssetCoordinator(
                    prefs = prefs, resolver = resolver, media = media,
                    readerFolderIndex = readerFolderIndex, readerCapabilities = readerCapabilities,
                    readState = { mutable.value }, sameDocumentUri = ::sameDocumentUri,
                    noteForAsset = ::noteForAsset, resolveLinkedAssetUri = ::resolveLinkedAssetUri,
                    openWorkspaceLink = { documentPath, target, fragment, wikilink -> openWorkspaceLink(documentPath, target, fragment, wikilink) },
                )
            }
            readerAssetCoordinatorCache
        }
    suspend fun openRelativeNote(documentPath: String, target: String, heading: String? = null): JSONObject =
        readerAssetCoordinator.openRelativeNote(documentPath, target, heading)
    suspend fun textAsset(document: String, source: String): JSONObject = readerAssetCoordinator.textAsset(document, source)
    suspend fun asset(document: String, source: String): String = readerAssetCoordinator.asset(document, source)
    internal fun resolveReaderAsset(document: String, source: String): Pair<String, ReaderAssetSource> =
        readerAssetCoordinator.resolveReaderAsset(document, source)
    internal fun openReaderAsset(capability: ReaderAssetCapability): OpenReaderAsset = readerAssetCoordinator.openReaderAsset(capability)
    internal fun openReaderAsset(noteId: String, source: String, expectedFingerprint: String): OpenReaderAsset =
        readerAssetCoordinator.openReaderAsset(noteId, source, expectedFingerprint)

    /** Replace one image inside a saved portable note, without changing Markdown or other assets. */
    internal suspend fun replacePortableAsset(id: String, assetName: String, replacementPath: String, expectedRevision: String): JSONObject = withContext(Dispatchers.IO) {
        documentWrites.withLock {
            val note = mutable.value.tabs.find { it.id == id } ?: error("The document is no longer open")
            require(mutable.value.activeId == id) { "Select the target tab before replacing its image" }
            val revision = agentContentRevision(note.content)
            require(revision.equals(expectedRevision, ignoreCase = true)) { "The document changed; read it again before replacing an image" }
            require(note.portable && note.uri != null && note.saved == note.content) { "Image replacement requires a saved, unchanged portable .smd note" }
            val sourceList = JSONArray(markdownImageSourcesJson(note.content))
            val linkedAssets = (0 until sourceList.length()).map { sourceList.getString(it) }.distinct().filter(media::validKey)
            val resolvedAssetName = linkedAssets.firstOrNull { source ->
                source == assetName || java.security.MessageDigest.getInstance("SHA-256").digest(source.toByteArray(Charsets.UTF_8)).joinToString("") { byte -> "%02x".format(byte) } == assetName
            } ?: error("The image ID is not linked from the current note")
            require(replacementPath.length in 1..4096 && !replacementPath.startsWith("/") && !replacementPath.contains('\\')) {
                "Choose an image path inside the note folder or an app-authorized asset folder"
            }
            val target = media.local(resolvedAssetName, note.assetDirectory) ?: error("Image asset is not present in this portable note")
            val old = media.readerAsset(target)
            val (_, incoming) = resolveReaderAsset(note.id, replacementPath)
            require(incoming.mime == old.mime) { "Replacement must keep the current image type and extension" }
            require(incoming.size in 1..BoundedAssetInputStream.MAX_READER_ASSET_BYTES) { "Replacement image must be at most 25 MB" }
            val incomingBytes = incoming.open().use { readLimited(it, 25_000_000) }
            val backup = target.readBytes()
            require(backup.size <= 25_000_000) { "Current image exceeds 25 MB" }
            val temporaryAsset = File(target.parentFile, ".${target.name}.${UUID.randomUUID()}.tmp")
            val backupAsset = File(target.parentFile, ".${target.name}.${UUID.randomUUID()}.bak")
            val stagedNote = File(getApplication<Application>().cacheDir, "agent-asset-${UUID.randomUUID()}.smd.gz")
            val noteUri = Uri.parse(note.uri)
            var replaced = false
            var diskAssets: String? = null
            try {
                // Refuse to overwrite a portable file whose saved bytes changed outside this app.
                val disk = resolver.openInputStream(noteUri)?.use(media::openFmd) ?: error("Cannot read the current portable note")
                diskAssets = disk.directory
                require(disk.markdown == note.saved) { "The portable note's Markdown changed on disk; reopen it before replacement" }
                val sources = JSONArray(markdownImageSourcesJson(note.content))
                (0 until sources.length()).map { sources.getString(it) }.distinct().filter(media::validKey).forEach { source ->
                    val currentFile = media.local(source, note.assetDirectory) ?: error("An open image is missing: $source")
                    val diskFile = media.local(source, disk.directory) ?: error("The saved note no longer contains image $source")
                    require(currentFile.readBytes().contentEquals(diskFile.readBytes())) { "The portable note's images changed on disk; reopen it before replacement" }
                }
                require((media.local(resolvedAssetName, disk.directory) ?: error("The saved note no longer contains this image")).readBytes().contentEquals(backup)) {
                    "The portable note's image changed on disk; reopen it before replacement"
                }
                val previousModified = target.lastModified()
                val stagedAssetStream = temporaryAsset.outputStream()
                stagedAssetStream.use { it.write(incomingBytes); it.fd.sync() }
                check(target.renameTo(backupAsset)) { "Could not safely stage the current image" }
                check(temporaryAsset.renameTo(target)) { backupAsset.renameTo(target); error("Could not stage the replacement image") }
                replaced = true
                media.invalidateLocalAsset(target)
                if (!backup.contentEquals(incomingBytes) && target.lastModified() == previousModified && previousModified > 0L) {
                    target.setLastModified(maxOf(System.currentTimeMillis(), previousModified + 1_000L))
                    media.invalidateLocalAsset(target)
                }
                stagedNote.outputStream().use { media.writeLocalPortable(it, note.content, note.assetDirectory) }
                verifyExportHeader(stagedNote, NativeExportFormat.PORTABLE_SMD)
                resolver.openOutputStream(noteUri, "wt")?.use { output -> stagedNote.inputStream().use { it.copyTo(output) } }
                    ?: error("Cannot save the updated portable note")
                withContext(Dispatchers.Main) {
                    invalidateNoteAssets(id)
                    recordPortableBaseline(id, note.assetDirectory)
                    change { state -> state.copy(tabs = state.tabs.map { if (it.id == id) it.copy(saved = it.content, assetsDirty = false) else it }, conflictedTabIds = state.conflictedTabIds - id, busy = false, message = "Portable image replaced") }
                    mutable.value.tabs.find { it.id == id }?.let(::remember)
                }
                backupAsset.delete()
                JSONObject().put("tabId", id).put("assetName", resolvedAssetName).put("assetId", assetName).put("revision", revision).put("changed", !backup.contentEquals(incomingBytes)).put("saved", true)
            } catch (error: Exception) {
                if (replaced) {
                    target.delete()
                    backupAsset.renameTo(target)
                    media.invalidateLocalAsset(target)
                }
                throw error
            } finally {
                temporaryAsset.delete(); backupAsset.delete(); stagedNote.delete()
                diskAssets?.let { File(getApplication<Application>().filesDir, "portable-assets/$it").deleteRecursively() }
            }
        }
    }

    /** Read original embedded assets or add one model-supplied image to a saved portable note. */
    internal suspend fun agentAssetAction(request: JSONObject): JSONObject = withContext(Dispatchers.IO) {
        val id = request.getString("tabId")
        val action = request.getString("assetAction")
        documentWrites.withLock {
            require(action in setOf("list", "source", "attach")) { "Unsupported asset action" }
            val note = mutable.value.tabs.find { it.id == id } ?: error("The document is no longer open")
            val revision = agentContentRevision(note.content)
            require(revision.equals(request.getString("expectedRevision"), ignoreCase = true)) { "The document changed; read it again before using an asset" }
            val directory = note.assetDirectory
            if (action == "list") {
                val page = media.portableAssetPage(directory, request.optInt("offset", 0), request.optInt("limit", 50))
                return@withLock JSONObject().put("tabId", id).put("revision", revision)
                    .put("assets", page.getJSONArray("assets")).put("total", page.getInt("total"))
                    .put("nextOffset", page.opt("nextOffset") ?: JSONObject.NULL)
            }
            if (action == "source") {
                val name = media.resolvePortableAssetName(directory, request.getString("assetName"))
                    ?: error("Asset is not present in the current note")
                val (mime, bytes) = media.portableAssetBytes(directory, name, 1_048_576)
                return@withLock JSONObject().put("tabId", id).put("revision", revision).put("assetName", name)
                    .put("mimeType", mime).put("bytes", bytes.size)
                    .put("sha256", java.security.MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) })
                    .put("body", android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP))
            }
            require(mutable.value.activeId == id) { "Select the target tab before attaching its image" }
            require(note.portable && note.uri != null && note.saved == note.content) { "Attaching an image requires a saved, unchanged portable .smd note" }
            val rawName = request.getString("assetName")
            val filename = rawName.removePrefix("assets/")
            require(isValidPortableAssetFilename(filename)) { "Asset name must be a simple filename" }
            val mime = request.getString("mimeType").substringBefore(';').lowercase()
            require(mime in setOf("image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/svg+xml")) { "Unsupported image type" }
            val extension = filename.substringAfterLast('.', "").lowercase()
            val normalizedName = if (extension.isEmpty()) "$filename.${when(mime) { "image/png" -> "png"; "image/jpeg" -> "jpg"; "image/gif" -> "gif"; "image/webp" -> "webp"; "image/avif" -> "avif"; else -> "svg" }}" else filename
            require(isValidPortableAssetFilename(normalizedName)) { "Asset name must be a simple filename" }
            require(media.assetMime(normalizedName) == mime) { "Asset extension must match its image type" }
            val encoded = request.getString("body")
            require(encoded.length <= 1_400_000 && encoded.length % 4 == 0) { "Asset body must be at most 1 MiB" }
            val incomingBytes = android.util.Base64.decode(encoded, android.util.Base64.DEFAULT)
            require(incomingBytes.size in 1..1_048_576 && android.util.Base64.encodeToString(incomingBytes, android.util.Base64.NO_WRAP) == encoded) { "Asset body must be canonical base64 and at most 1 MiB" }
            fun currentNote(): Note? = mutable.value.tabs.find { it.id == id }
            fun requireSameSnapshot(active: Boolean = true) {
                val latest = currentNote() ?: error("The document is no longer open")
                require(matchesAssetWriteSnapshot(latest, mutable.value.activeId, note, requireActive = active) && latest.assetDirectory == directory) {
                    "The document changed while the image was being attached; no changes were saved"
                }
            }
            requireSameSnapshot()
            val currentAssets = media.portableAssets(directory)
            val newKey = "assets/$normalizedName"
            require(!currentAssets.has(newKey)) { "An asset with that name already exists" }
            val newData = media.portableImageData(mime, incomingBytes)
            val updated = JSONObject()
            currentAssets.keys().forEach { key -> updated.put(key, currentAssets.getString(key)) }
            updated.put(newKey, newData)
            val uri = Uri.parse(note.uri)
            var openedDir: String? = null
            try {
                writeStagedPortableWithRecovery(
                    target = uri,
                    markdown = note.content,
                    savedBaselineMarkdown = note.saved,
                    updatedAssets = updated,
                    baselineAssets = currentAssets,
                    diskChangedMessage = "The portable note changed on disk; reopen it before attaching an image",
                    writeFailureMessage = "Cannot save the updated portable note",
                    prepareBeforeWrite = {
                        openedDir = media.materializePortableDirectory(
                            updated,
                            reuseFromDirectory = directory,
                            predecodedBytes = mapOf(newKey to (mime to incomingBytes)),
                        )
                    },
                    recheckSnapshotBeforeWrite = ::requireSameSnapshot,
                    commitOnSuccess = {
                        requireSameSnapshot()
                        val writtenSource = note.content
                        val writtenDirectory = openedDir ?: error("The updated portable note was not staged")
                        val committed = withContext(Dispatchers.Main) {
                            val latest = mutable.value.tabs.find { it.id == id }
                            val matches = latest != null && latest.content == writtenSource
                                && matchesAssetWriteSnapshot(latest, mutable.value.activeId, note) && latest.assetDirectory == directory
                            if (!matches) return@withContext false
                            invalidateNoteAssets(id)
                            recordPortableBaseline(id, writtenDirectory)
                            change { state -> state.copy(tabs = state.tabs.map {
                                if (it.id == id && it.content == writtenSource && it.uri == note.uri && it.assetDirectory == directory)
                                    it.copy(saved = writtenSource, assetsDirty = false, assetDirectory = writtenDirectory) else it
                            }, conflictedTabIds = state.conflictedTabIds - id, busy = false, message = "Portable image attached") }
                            mutable.value.tabs.find { it.id == id }?.let(::remember)
                            true
                        }
                        if (!committed) {
                            error("The document changed while the image was being attached; the new draft was preserved")
                        }
                    },
                )
                JSONObject().put("tabId", id).put("assetName", newKey).put("mimeType", mime)
                    .put("bytes", incomingBytes.size)
                    .put("sha256", java.security.MessageDigest.getInstance("SHA-256").digest(incomingBytes).joinToString("") { "%02x".format(it) })
                    .put("revision", revision).put("saved", true).put("changed", true)
            } finally {
                openedDir?.takeIf { it != mutable.value.tabs.find { tab -> tab.id == id }?.assetDirectory }
                    ?.let { File(getApplication<Application>().filesDir, "portable-assets/$it").deleteRecursively() }
            }
        }
    }

    suspend fun python(code: String): JSONObject = withContext(Dispatchers.IO) {
        PythonCellRunner.run(getApplication(), viewModelScope, code)
    }
    private fun copyAttachments(note: Note, destination: Uri, destinationTree: Uri? = null) {
        val sources = JSONArray(markdownImageSourcesJson(note.content))
        val local = (0 until sources.length()).map { sources.getString(it) }.distinct().mapNotNull { source -> media.local(source, note.assetDirectory)?.let { source to it } }
        if (local.isEmpty()) return
        val tree = destinationTree ?: mutable.value.folder?.let(Uri::parse) ?: error("Images need a containing folder permission. Choose a folder destination or export a single portable .smd file instead.")
        val rootId = DocumentsContract.getTreeDocumentId(tree)
        val targetId = DocumentsContract.getDocumentId(destination)
        require(targetId.startsWith("$rootId/")) { "Open the destination folder, or export a portable .fmd file to include images." }
        val parent = targetId.removePrefix("$rootId/").substringBeforeLast('/', "")
        var directory = DocumentFile.fromTreeUri(getApplication(), tree) ?: error("Restore folder permission")
        parent.split('/').filter { it.isNotEmpty() }.forEach { directory = directory.findFile(it) ?: error("Destination folder disappeared") }
        val assets = directory.findFile("assets") ?: directory.createDirectory("assets") ?: error("Cannot create image folder")
        require(assets.isDirectory)
        local.forEach { (source, file) ->
            val name = source.substringAfter('/')
            val existing = assets.findFile(name)
            if (existing != null) {
                val bytes = resolver.openInputStream(existing.uri)?.use { readLimited(it, 25_000_000) }
                require(bytes != null && bytes.contentEquals(file.readBytes())) { "A different image already exists at assets/$name; use FMD export instead." }
            } else {
                val type = media.data(file).substringAfter("data:").substringBefore(';')
                val target = assets.createFile(type, name) ?: error("Cannot create image $name")
                resolver.openOutputStream(target.uri, "wt")?.use { output -> file.inputStream().use { it.copyTo(output) } } ?: error("Cannot write image")
            }
        }
        readerFolderIndex.clear()
    }
    var portableOutput: Uri? = null
    suspend fun writePortable(
        id: String,
        content: String,
        assets: JSONObject,
        save: Boolean,
        originalContent: String,
        mergeLocalAssets: Boolean = false,
    ) {
        var closeTargetId: String? = null
        withContext(Dispatchers.IO) { documentWrites.withLock {
            val rebindId = if (!save) portableSaveAsNoteId else null
            val effectiveId = rebindId ?: id
            if (rebindId != null && id.isNotEmpty() && id != rebindId) {
                clearPendingPortableWriteState()
                error("The export note changed")
            }
            val note = mutable.value.tabs.find { it.id == effectiveId }
            if (closingNoteIds.contains(effectiveId) || note == null) {
                clearPendingPortableWriteState()
                error("The note is no longer open")
            }
            if (note.content != originalContent) {
                clearPendingPortableWriteState()
                error("The note changed while preparing the portable save; try saving again")
            }
            val target = if (save) note.uri?.let { resolveVerifiedWriteDestination(Uri.parse(it)) } else portableOutput
            require(target != null) { "Choose a portable file destination" }
            val force = portableForceOverwrite
            portableForceOverwrite = false
            if (save && !force && !diskMatchesBaseline(target, note)) {
                autosavePending.remove(effectiveId)
                withContext(Dispatchers.Main) {
                    change { s -> s.copy(busy = false, conflictedTabIds = s.conflictedTabIds + effectiveId, pendingSaveConflictNoteId = effectiveId) }
                }
                return@withLock
            }
            val effectiveAssets = if (mergeLocalAssets) {
                val combined = collectNativePortableAssets(note.copy(content = content))
                assets.keys().forEach { key -> combined.put(key, assets.getString(key)) }
                combined
            } else assets
            val destination = if (save) target else prepareExportDestination(target, NativeExportFormat.PORTABLE_SMD, allowRename = portableDestinationIsNew)
            val staged = File(getApplication<Application>().cacheDir, "fmd-${UUID.randomUUID()}.tmp")
            var materializedDirectory: String? = null
            try {
                // Reuse existing extracted assets when unchanged; otherwise materialize only changed/new assets
                // before writing the archive so new assets are Base64-decoded once rather than twice.
                val rebinding = save || rebindId != null
                val nextDirectory = if (rebinding) {
                    val reuseExisting = save && rebindId == null && note.assetDirectory != null &&
                        media.hasExactLocalPortableAssets(note.assetDirectory, effectiveAssets)
                    if (reuseExisting) {
                        note.assetDirectory!!
                    } else {
                        media.materializePortableDirectory(effectiveAssets, reuseFromDirectory = note.assetDirectory).also {
                            materializedDirectory = it
                        }
                    }
                } else null
                staged.outputStream().use { media.writeFmd(it, content, effectiveAssets, savedPortableAssets[effectiveId]) }
                verifyExportHeader(staged, NativeExportFormat.PORTABLE_SMD)
                resolver.openOutputStream(destination, "wt")?.use { output -> staged.inputStream().use { it.copyTo(output) } } ?: error("Cannot write portable file")
                documentAccess.persist(destination)
                val savedName = if (rebindId != null) {
                    resolveDisplayName(destination) ?: ExportFilename.suggestedName(note.name, NativeExportFormat.PORTABLE_SMD)
                } else note.name
                val openRel = if (rebinding) resolveOpenFolderRelativeOnIo(destination) else null
                withContext(Dispatchers.Main) {
                    if (rebinding) {
                        portableOutput = null
                        portableDestinationIsNew = false
                        portableSaveAsNoteId = null
                        autosavePending.remove(effectiveId)
                        clearDocumentAccessFailure(destination.toString())
                        recordPortableBaseline(effectiveId, nextDirectory!!)
                        change { s ->
                            s.copy(
                                tabs = s.tabs.map {
                                    if (it.id == effectiveId) it.copy(
                                        name = if (rebindId != null) savedName else it.name,
                                        content = if (it.content == originalContent) content else it.content,
                                        saved = content,
                                        assetsDirty = false,
                                        uri = destination.toString(),
                                        relative = if (rebindId != null) openRel else (openRel ?: it.relative),
                                        assetDirectory = nextDirectory,
                                    ) else it
                                },
                                conflictedTabIds = s.conflictedTabIds - effectiveId,
                                pendingSaveConflictNoteId = s.pendingSaveConflictNoteId?.takeUnless { it == effectiveId },
                                busy = false,
                                message = if (rebindId != null) "Saved" else "Portable note saved",
                            )
                        }
                        materializedDirectory = null
                        mutable.value.tabs.find { it.id == effectiveId }?.let(::remember)
                        if (openRel != null) mutable.value.folder?.let { listFolder(Uri.parse(it), listedRelative) }
                        if (closeAfterSaveNoteId == effectiveId) {
                            closeAfterSaveNoteId = null
                            closeTargetId = effectiveId
                        }
                    } else {
                        portableOutput = null
                        portableDestinationIsNew = false
                        if (!finishShare(destination)) mutable.value = mutable.value.copy(busy = false, message = "Portable .smd exported")
                    }
                }
            } finally {
                materializedDirectory?.let { File(getApplication<Application>().filesDir, "portable-assets/$it").deleteRecursively() }
                staged.delete()
            }
        } }
        closeTargetId?.let { close(it) }
    }
    internal fun discardDroppedImages(images: JSONArray) {
        viewModelScope.launch(Dispatchers.IO) { media.discardImportedImages(images) }
    }
    fun importPickedImages(uris: List<Uri>, id: String, result: (JSONArray?) -> Unit) = viewModelScope.launch {
        if (uris.isEmpty()) {
            result(null)
            return@launch
        }
        try {
            val images = withContext(Dispatchers.IO) { media.importUris(uris) }
            if (mutable.value.active.id != id) {
                withContext(Dispatchers.IO) { media.discardImportedImages(images) }
                mutable.value = mutable.value.copy(message = MediaStorage.SWITCHED_NOTE_IMPORT_MESSAGE)
                result(null)
                return@launch
            }
            markAssetsDirty(id)
            result(images)
        } catch (error: Exception) {
            fail("Could not insert image: ${error.message}")
            result(null)
        }
    }
    fun importDropped(
        uris: List<Uri>,
        id: String,
        dragReadPermissionGranted: Boolean = true,
        result: (JSONArray?) -> Unit,
    ) = viewModelScope.launch {
        if (uris.isEmpty()) {
            mutable.value = mutable.value.copy(message = MediaStorage.UNSUPPORTED_DROP_IMAGE_MESSAGE)
            result(null)
            return@launch
        }
        try {
            val batch = withContext(Dispatchers.IO) { media.importDroppedUris(uris, dragReadPermissionGranted) }
            val images = batch.images
            if (images.length() == 0) {
                val failureMessage = if (batch.missingGrantCount > 0 && batch.skippedCount == batch.missingGrantCount) {
                    MediaStorage.UNGRANTED_DROP_IMAGE_MESSAGE
                } else {
                    MediaStorage.UNSUPPORTED_DROP_IMAGE_MESSAGE
                }
                mutable.value = mutable.value.copy(message = failureMessage)
                result(null)
                return@launch
            }
            if (mutable.value.active.id != id) {
                withContext(Dispatchers.IO) { media.discardImportedImages(images) }
                mutable.value = mutable.value.copy(message = MediaStorage.SWITCHED_NOTE_IMPORT_MESSAGE)
                result(null)
                return@launch
            }
            markAssetsDirty(id)
            if (batch.skippedCount > 0) {
                val skippedMessage = if (batch.missingGrantCount > 0 && batch.skippedCount == batch.missingGrantCount) {
                    if (batch.missingGrantCount == 1) {
                        "Skipped 1 image without read permission."
                    } else {
                        "Skipped ${batch.missingGrantCount} images without read permission."
                    }
                } else if (batch.skippedCount == 1) {
                    "Skipped 1 unsupported file; only PNG, JPEG, GIF, WebP, AVIF, and SVG images were imported."
                } else {
                    "Skipped ${batch.skippedCount} unsupported files; only PNG, JPEG, GIF, WebP, AVIF, and SVG images were imported."
                }
                mutable.value = mutable.value.copy(message = skippedMessage)
            }
            result(images)
        } catch (error: Exception) {
            fail("Could not insert image: ${error.message}")
            result(null)
        }
    }
    internal suspend fun export(
        content: String,
        options: String,
        assets: JSONObject,
        destination: Uri? = outputUri,
        job: PdfExportJob? = null,
        onPublishing: (suspend (PdfExportJob) -> Unit)? = null,
    ) = withContext(Dispatchers.IO + kotlinx.coroutines.NonCancellable) {
        val target = destination ?: error("Choose a PDF destination first")
        val outputTarget = prepareExportDestination(target, NativeExportFormat.PDF, allowRename = target == outputUri && pdfDestinationIsNew)
        val staging = File(getApplication<Application>().cacheDir, "pdf-${UUID.randomUUID()}").apply { mkdirs() }
        try {
            val assetDir = File(staging, "assets").apply { mkdirs() }
            assets.keys().forEach { key -> require(Regex("[a-zA-Z0-9_.-]+").matches(key)); File(assetDir, key).writeBytes(Base64.decode(assets.getString(key), Base64.DEFAULT)) }
            fonts.addPdfFonts(JSONObject(options).optString("fontFamily"),assetDir)
            val output = File(staging, "document.pdf")
            val error = PdfEngine.export(content, options, assetDir.absolutePath, output.absolutePath)
            if (error.isNotEmpty()) error(error)
            verifyExportHeader(output, NativeExportFormat.PDF)
            if (job != null) {
                check(job.beginPublishing()) { "PDF export cancelled" }
                onPublishing?.invoke(job)
            }
            resolver.openOutputStream(outputTarget, "wt")?.use { stream -> output.inputStream().use { it.copyTo(stream) } } ?: error("Cannot write PDF destination")
            job?.succeed()
            withContext(Dispatchers.Main) { if (!finishShare(outputTarget)) mutable.value = mutable.value.copy(busy = false, message = "PDF exported"); outputUri = null; pdfDestinationIsNew = false }
        } catch (error: Exception) {
            job?.fail()
            throw error
        } finally { staging.deleteRecursively() }
    }

    private data class AdmittedDroppedNoteCandidate(
        val admitted: AdmittedExternalDrop,
        val name: String?,
        val providerMime: String?,
    )

    private suspend fun openDroppedNoteBatch(
        candidates: List<AdmittedDroppedNoteCandidate>,
        batchNotice: String?,
    ) {
        val request = openRequests.begin()
        val dropCaller = ExternalIntentCaller(allowGrantedShareFile = false)
        val loadedNotes = mutableListOf<Note>()
        val createdPortableDirectories = LinkedHashSet<String>()
        val openErrors = mutableListOf<String>()
        try {
            withContext(Dispatchers.IO) {
                for (candidate in candidates) {
                    val label = candidate.name ?: candidate.admitted.uri.lastPathSegment ?: "note"
                    runCatching {
                        candidate.admitted.use { admitted ->
                            loadNoteForOpen(
                                uri = admitted.uri,
                                relative = null,
                                externalIntentFlags = admitted.intentFlags,
                                externalCaller = dropCaller,
                                admittedDrop = admitted,
                                strictDroppedNote = true,
                            )
                        }
                    }.onSuccess { note ->
                        loadedNotes += note
                        note.assetDirectory?.let { dir ->
                            if (mutable.value.tabs.none { it.assetDirectory == dir }) {
                                createdPortableDirectories += dir
                            }
                        }
                    }.onFailure { error ->
                        openErrors += "$label: ${error.message ?: "Could not read note"}"
                    }
                }
            }
            if (loadedNotes.isEmpty()) {
                val parts = mutableListOf<String>()
                if (openErrors.isNotEmpty()) parts += "Could not open ${openErrors.joinToString("; ")}"
                if (!batchNotice.isNullOrBlank()) parts += batchNotice
                fail(parts.joinToString(" ").ifBlank { "Could not open dropped note" })
                return
            }
            if (!openRequests.isCurrent(request)) {
                loadedNotes.forEach { retainOpenedNote(it, activate = false) }
            } else {
                val expectedActiveId = mutable.value.active.id
                var retainedCount = 0
                val accepted = performReaderBarrier(expectedActiveId) {
                    val activateLast = openRequests.isCurrent(request)
                    loadedNotes.forEachIndexed { index, note ->
                        retainOpenedNote(
                            note,
                            activate = activateLast && index == loadedNotes.lastIndex,
                        )
                        retainedCount++
                    }
                }
                if (!accepted || retainedCount == 0) {
                    if (!openRequests.isCurrent(request)) {
                        loadedNotes.forEach { retainOpenedNote(it, activate = false) }
                    } else {
                        cleanupPortableDirectories(createdPortableDirectories)
                        readerBarrierFailed()
                        return
                    }
                }
            }
            val notices = mutableListOf<String>()
            if (openErrors.isNotEmpty()) notices += "Could not open ${openErrors.joinToString("; ")}"
            if (!batchNotice.isNullOrBlank()) notices += batchNotice
            if (notices.isNotEmpty()) {
                mutable.value = mutable.value.copy(message = notices.joinToString(" "))
            }
        } catch (cancelled: kotlinx.coroutines.CancellationException) {
            cleanupPortableDirectories(createdPortableDirectories)
            throw cancelled
        } finally {
            candidates.forEach { runCatching { it.admitted.close() } }
        }
    }

    internal fun handleExternalDrop(
        uris: List<Uri>,
        activeNoteId: String,
        dragReadPermissionGranted: Boolean,
        onComplete: () -> Unit = {},
        result: (JSONArray?) -> Unit = {},
    ): Job = viewModelScope.launch {
        val admittedHandles = mutableListOf<AdmittedExternalDrop>()
        try {
            val seen = LinkedHashSet<String>()
            val orderedUris = uris.filter { seen.add(it.toString()) }
            if (orderedUris.isEmpty()) {
                mutable.value = mutable.value.copy(message = DROP_UNSUPPORTED_ITEM_MESSAGE)
                result(null)
                return@launch
            }
            val app = getApplication<Application>()
            val imageCandidates = mutableListOf<MediaStorage.AdmittedDroppedImageCandidate>()
            val noteCandidates = mutableListOf<AdmittedDroppedNoteCandidate>()
            var folderRejectedCount = 0
            var missingGrantCount = 0
            var unsupportedFileCount = 0
            val securityRejectedReasons = mutableListOf<String>()

            withContext(Dispatchers.IO) {
                for (uri in orderedUris) {
                    when (val decision = ExternalDocumentEntryGuard.admitDroppedUri(app, uri, dragReadPermissionGranted)) {
                        is ExternalDropUriDecision.MissingGrant -> missingGrantCount++
                        is ExternalDropUriDecision.Rejected -> {
                            if (decision.isFolder) folderRejectedCount++
                            else securityRejectedReasons += decision.reason
                        }
                        is ExternalDropUriDecision.Allowed -> {
                            admittedHandles += decision.admitted
                            val name = resolveDisplayName(uri)
                            val providerMime = if (uri.scheme.equals("content", ignoreCase = true)) {
                                runCatching { resolver.getType(uri) }.getOrNull()
                            } else {
                                null
                            }
                            if (providerMime?.substringBefore(';')?.trim()?.equals(DocumentsContract.Document.MIME_TYPE_DIR, ignoreCase = true) == true) {
                                decision.close()
                                folderRejectedCount++
                                continue
                            }
                            val imageMime = MediaStorage.resolveDroppedImageMime(name, providerMime)
                            when {
                                imageMime != null -> imageCandidates += MediaStorage.AdmittedDroppedImageCandidate(
                                    admitted = decision.admitted,
                                    name = name,
                                    resolvedMime = imageMime,
                                )
                                isSupportedDroppedNote(name, providerMime) -> noteCandidates += AdmittedDroppedNoteCandidate(
                                    admitted = decision.admitted,
                                    name = name,
                                    providerMime = providerMime,
                                )
                                else -> {
                                    decision.close()
                                    unsupportedFileCount++
                                }
                            }
                        }
                    }
                }
            }

            when {
                noteCandidates.isNotEmpty() -> {
                    imageCandidates.forEach { runCatching { it.admitted.close() } }
                    val skippedParts = mutableListOf<String>()
                    if (folderRejectedCount > 0) {
                        skippedParts += if (folderRejectedCount == 1) {
                            "Skipped 1 folder (use Open folder instead)."
                        } else {
                            "Skipped $folderRejectedCount folders (use Open folder instead)."
                        }
                    }
                    if (imageCandidates.isNotEmpty()) {
                        skippedParts += "Drop images inside an open note after opening it."
                    }
                    val skippedOther = unsupportedFileCount + missingGrantCount + securityRejectedReasons.size
                    if (skippedOther > 0) {
                        skippedParts += if (skippedOther == 1) {
                            "Skipped 1 unsupported item."
                        } else {
                            "Skipped $skippedOther unsupported items."
                        }
                    }
                    openDroppedNoteBatch(
                        candidates = noteCandidates,
                        batchNotice = skippedParts.joinToString(" ").takeIf { it.isNotBlank() },
                    )
                    result(null)
                }
                imageCandidates.isNotEmpty() -> {
                    try {
                        val batch = withContext(Dispatchers.IO) { media.importAdmittedDroppedImages(imageCandidates) }
                        val images = batch.images
                        if (images.length() == 0) {
                            val totalMissing = missingGrantCount + batch.missingGrantCount
                            val totalOtherSkipped = folderRejectedCount + unsupportedFileCount + securityRejectedReasons.size +
                                (batch.skippedCount - batch.missingGrantCount)
                            val failureMessage = if (totalMissing > 0 && totalOtherSkipped == 0) {
                                MediaStorage.UNGRANTED_DROP_IMAGE_MESSAGE
                            } else {
                                MediaStorage.UNSUPPORTED_DROP_IMAGE_MESSAGE
                            }
                            mutable.value = mutable.value.copy(message = failureMessage)
                            result(null)
                            return@launch
                        }
                        if (mutable.value.active.id != activeNoteId) {
                            withContext(Dispatchers.IO) { media.discardImportedImages(images) }
                            mutable.value = mutable.value.copy(message = MediaStorage.SWITCHED_NOTE_IMPORT_MESSAGE)
                            result(null)
                            return@launch
                        }
                        markAssetsDirty(activeNoteId)
                        val totalMissing = missingGrantCount + batch.missingGrantCount
                        val totalSkipped = batch.skippedCount + folderRejectedCount + unsupportedFileCount + missingGrantCount + securityRejectedReasons.size
                        if (totalSkipped > 0) {
                            val skippedMessage = if (totalMissing > 0 && totalSkipped == totalMissing) {
                                if (totalMissing == 1) {
                                    "Skipped 1 image without read permission."
                                } else {
                                    "Skipped $totalMissing images without read permission."
                                }
                            } else if (totalSkipped == 1) {
                                "Skipped 1 unsupported file; only PNG, JPEG, GIF, WebP, AVIF, and SVG images were imported."
                            } else {
                                "Skipped $totalSkipped unsupported files; only PNG, JPEG, GIF, WebP, AVIF, and SVG images were imported."
                            }
                            mutable.value = mutable.value.copy(message = skippedMessage)
                        }
                        result(images)
                    } catch (error: Exception) {
                        fail("Could not insert image: ${error.message}")
                        result(null)
                    }
                }
                else -> {
                    when {
                        folderRejectedCount > 0 && unsupportedFileCount == 0 && missingGrantCount == 0 && securityRejectedReasons.isEmpty() ->
                            mutable.value = mutable.value.copy(message = DROP_FOLDER_UNSUPPORTED_MESSAGE)
                        missingGrantCount > 0 && folderRejectedCount == 0 && unsupportedFileCount == 0 && securityRejectedReasons.isEmpty() ->
                            mutable.value = mutable.value.copy(message = DROP_UNGRANTED_ITEM_MESSAGE)
                        securityRejectedReasons.isNotEmpty() && unsupportedFileCount == 0 && folderRejectedCount == 0 && missingGrantCount == 0 ->
                            fail("Could not open dropped file: ${securityRejectedReasons.first()}")
                        else ->
                            mutable.value = mutable.value.copy(message = DROP_UNSUPPORTED_ITEM_MESSAGE)
                    }
                    result(null)
                }
            }
        } finally {
            admittedHandles.forEach { runCatching { it.close() } }
            onComplete()
        }
    }
}

internal const val DROP_UNSUPPORTED_ITEM_MESSAGE =
    "Only supported Markdown notes (.md, .smd, .fmd, .markdown, .txt) or images can be dropped."
internal const val DROP_FOLDER_UNSUPPORTED_MESSAGE =
    "Folder drops are not supported; use Open folder instead."
internal const val DROP_UNGRANTED_ITEM_MESSAGE =
    "Dropped file read access was not granted; use Open or Insert image instead."

private val UNAMBIGUOUS_DROPPED_NOTE_MIMES = setOf(
    "text/markdown",
    "text/x-markdown",
    "text/x-supermarkdown",
    "application/vnd.supermd.smd",
    "application/vnd.supermd.fmd",
    "application/x-smd",
    "application/x-fmd",
)

private val PORTABLE_COMPATIBLE_NOTE_MIMES = UNAMBIGUOUS_DROPPED_NOTE_MIMES + setOf(
    "application/gzip",
    "application/x-gzip",
    "application/json",
    "application/octet-stream",
    "text/plain",
)

private val PLAIN_COMPATIBLE_NOTE_MIMES = UNAMBIGUOUS_DROPPED_NOTE_MIMES + setOf(
    "text/plain",
    "application/octet-stream",
)

internal fun isSupportedDroppedNote(name: String?, providerMime: String?): Boolean {
    val normalizedMime = providerMime?.substringBefore(';')?.trim()?.lowercase()?.takeIf { it.isNotEmpty() }
    if (normalizedMime == DocumentsContract.Document.MIME_TYPE_DIR.lowercase()) return false
    if (
        normalizedMime != null && (
            normalizedMime.startsWith("image/") ||
                normalizedMime.startsWith("video/") ||
                normalizedMime.startsWith("audio/") ||
                normalizedMime == "application/pdf" ||
                normalizedMime == "application/zip"
        )
    ) {
        return false
    }
    val leaf = name?.substringAfterLast('/')?.substringAfterLast('\\')?.trim().orEmpty()
    val dot = leaf.lastIndexOf('.')
    val ext = if (dot > 0 && dot < leaf.lastIndex) leaf.substring(dot + 1).lowercase() else ""
    if (ext.isNotEmpty()) {
        if (ext !in FOLDER_NOTE_EXTENSIONS) return false
        if (normalizedMime == null) return true
        return if (ext == "smd" || ext == "fmd") {
            normalizedMime in PORTABLE_COMPATIBLE_NOTE_MIMES
        } else {
            normalizedMime in PLAIN_COMPATIBLE_NOTE_MIMES
        }
    }
    return normalizedMime != null && normalizedMime in UNAMBIGUOUS_DROPPED_NOTE_MIMES
}
