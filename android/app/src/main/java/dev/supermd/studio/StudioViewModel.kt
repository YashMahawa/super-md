package dev.supermd.studio

import android.app.Application
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import android.util.Base64
import androidx.documentfile.provider.DocumentFile
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.chaquo.python.Python
import com.chaquo.python.android.AndroidPlatform
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

data class Note(val id: String = UUID.randomUUID().toString(), val name: String = "Untitled.md", val uri: String? = null, val content: String = "", val saved: String = "", val relative: String? = null, val assetDirectory: String? = null, val assetsDirty: Boolean = false) {
    val dirty get() = content != saved || assetsDirty
    val portable get() = assetDirectory != null
    val requiresCloseConfirmation get() = if (uri == null) (content.isNotBlank() || assetsDirty) && dirty else dirty
}
private class ExternalConflictDetectedException : RuntimeException()
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
data class StudioState(val latexAutofix:Boolean=false, val typewriterScroll:Boolean=false, val selectionAssistant:String="chatgpt", val centerLock:Boolean=true, val customTheme:String="", val patternKind:String="", val patternOpacity:Float=-1f, val patternSize:Float=0f, val patternSpacing:Float=0f, val restorePosition:Boolean=true, val fullDocumentAccessibility:Boolean=false, val startup:String="restore", val imageAppearance:String="original", val svgAppearance:String="original", val imageContrast:Float=1.25f, val spellCheck:Boolean = false, val grammarCheck:Boolean = false, val accent: String = "system", val widthPercent: Float = 100f, val lineHeight: Float = 1.65f, val autosave: Boolean = true, val customFonts: List<String> = emptyList(), val readerOverlay: Boolean = false, val zoomCommand: Long = 0, val tabs: List<Note> = listOf(Note(name = "Welcome.md", content = sample, saved = sample)), val closedTabs: List<Note> = emptyList(), val activeId: String = "", val mode: String = "live", val fullscreen: Boolean = false, val normalZoom: Float = 100f, val fullscreenZoom: Float = 100f, val theme: String = "system", val fullscreenTheme: String = "black", val motion: Boolean = true, val font: String = "Manrope", val size: Float = 15f, val folder: String? = null, val files: List<FileEntry> = emptyList(), val busy: Boolean = false, val message: String? = null, val error: String? = null, val welcomed: Boolean = false, val pdf: String = "{\"pageSize\":\"a4\",\"margin\":14,\"fontSize\":10.5,\"lineHeight\":1.4,\"paragraphSpacing\":0.65,\"fontFamily\":\"Manrope\",\"pageNumbers\":true}", val storageReport: StorageReport? = null, val storageScanning: Boolean = false, val conflictedTabIds: Set<String> = emptySet(), val pendingCloseNoteId: String? = null, val pendingSaveConflictNoteId: String? = null, val pendingHeading: PendingHeadingJump? = null, val folderAccessPrompt: WorkspaceFolderPrompt? = null) {
    val active get() = tabs.find { it.id == activeId } ?: tabs.first()
    val zoom get() = if (fullscreen) fullscreenZoom else normalZoom
    val activeConflicted get() = active.id in conflictedTabIds
    val pendingCloseNote get() = pendingCloseNoteId?.let { id -> tabs.find { it.id == id } }
    val pendingSaveConflictNote get() = pendingSaveConflictNoteId?.let { id -> tabs.find { it.id == id } }
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
// All windows share one killable Python worker. A per-window lock would allow
// one cell's cleanup/timeout to kill another window's in-flight execution.
private val pythonExecution = kotlinx.coroutines.sync.Mutex()

class StudioViewModel(app: Application, val workspaceKey: String = "main") : AndroidViewModel(app) {
    private val prefs = app.getSharedPreferences("studio", 0)
    private val documentAccess = DocumentAccess(app)
    internal var workspaceLinks = WorkspaceLinkCache(ContentResolverTreeLister(app))
    private val accessRequestsMutable = MutableStateFlow<DocumentAccessRequest?>(null)
    val documentAccessRequests = accessRequestsMutable.asStateFlow()
    private val blockedDocumentWrites = mutableSetOf<String>()
    private val promptedDocumentAccess = mutableSetOf<String>()
    private val promptedAssetAccess = mutableSetOf<String>()
    internal val readerFolderIndex = ReaderFolderIndex()
    private val readerCapabilities = java.util.concurrent.CopyOnWriteArraySet<ReaderAssetCapabilities>()
    internal fun attachReaderCapabilities(capabilities: ReaderAssetCapabilities) { readerCapabilities += capabilities }
    internal fun detachReaderCapabilities(capabilities: ReaderAssetCapabilities) { readerCapabilities -= capabilities }
    internal fun invalidateNoteAssets(noteId: String) {
        readerFolderIndex.clearNote(noteId)
        readerCapabilities.forEach { it.clearNote(noteId) }
    }
    internal fun invalidateAllNoteAssets() {
        readerFolderIndex.clear()
        readerCapabilities.forEach { it.clear() }
    }
    internal fun matchesReaderAssetNote(noteId: String, target: ReaderAssetTarget? = null): Boolean {
        val note = mutable.value.tabs.firstOrNull { it.id == noteId } ?: return false
        if (target == null) return true
        return note.uri == target.noteUri && note.relative == target.noteRelative && note.assetDirectory == target.assetDirectory
    }
    var assetAccessRestored: ((String, String) -> Unit)? = null
    fun retainDocumentAccess(uri: Uri) = documentAccess.persist(uri)
    fun dismissDocumentAccess() { accessRequestsMutable.value = null }
    private fun linkedAssetUri(note: Note, source: String): Uri? = runCatching {
        val grants = JSONArray(prefs.getString("linkedAssetGrants", "[]"))
        (0 until minOf(grants.length(), 256)).asSequence().map { grants.getJSONObject(it) }
            .firstOrNull { record -> record.optString("source") == source && sameDocumentUri(record.optString("document"), note.uri ?: note.id) }
            ?.getString("uri")?.let(Uri::parse)
    }.getOrNull()
    private fun rememberLinkedAsset(note: Note, source: String, uri: Uri) {
        val previous = runCatching { JSONArray(prefs.getString("linkedAssetGrants", "[]")) }.getOrDefault(JSONArray())
        val records = JSONArray().put(JSONObject().put("document", note.uri ?: note.id).put("source", source).put("uri", uri.toString()))
        for (i in 0 until minOf(previous.length(), 255)) {
            val record = previous.optJSONObject(i) ?: continue
            if (!(record.optString("source") == source && sameDocumentUri(record.optString("document"), note.uri ?: note.id))) records.put(record)
        }
        prefs.edit().putString("linkedAssetGrants", records.toString()).apply()
    }
    internal fun reportLinkedAssetFailure(document: String, source: String, error: Throwable): Boolean {
        if (!isDocumentAccessFailure(error)) return false
        val note = mutable.value.tabs.firstOrNull { it.id == document || it.uri?.let { uri -> sameDocumentUri(uri, document) } == true } ?: return false
        val key = "${note.id}\n$source"
        if (accessRequestsMutable.value == null && promptedAssetAccess.add(key)) {
            accessRequestsMutable.value = DocumentAccessRequest(note.uri ?: note.id, Uri.decode(source).substringAfterLast('/'), note.id, false, assetSource = source)
            mutable.value = mutable.value.copy(busy = false, message = LINKED_ASSET_ACCESS_MESSAGE)
        } else mutable.value = mutable.value.copy(busy = false)
        return true
    }
    private fun sameDocumentUri(left: String, right: String) = sameDocument(Uri.parse(left), Uri.parse(right))
    private fun writeIsBlocked(uri: String) = blockedDocumentWrites.any { sameDocumentUri(it, uri) }
    private fun clearDocumentAccessFailure(uri: String) {
        blockedDocumentWrites.removeAll { sameDocumentUri(it, uri) }
        promptedDocumentAccess.removeAll { sameDocumentUri(it, uri) }
    }
    private fun requestDocumentAccess(uri: String, note: Note?, writing: Boolean, explicit: Boolean = false): String {
        if (writing) blockedDocumentWrites.add(uri)
        val alreadyPrompted = promptedDocumentAccess.any { sameDocumentUri(it, uri) }
        promptedDocumentAccess.add(uri)
        if ((!alreadyPrompted || explicit) && accessRequestsMutable.value == null) {
            val name = note?.name ?: Uri.parse(uri).lastPathSegment?.substringAfterLast('/') ?: "This note"
            accessRequestsMutable.value = DocumentAccessRequest(uri, name, note?.id, writing)
        }
        mutable.value = if (!alreadyPrompted || explicit) mutable.value.copy(busy = false, message = DOCUMENT_ACCESS_MESSAGE)
            else mutable.value.copy(busy = false)
        return DOCUMENT_ACCESS_MESSAGE
    }
    fun requestWriteAccessIfBlocked(id: String, explicit: Boolean = false): Boolean {
        val note = mutable.value.tabs.firstOrNull { it.id == id } ?: return false
        val uri = note.uri ?: return false
        if (!writeIsBlocked(uri)) return false
        requestDocumentAccess(uri, note, writing = true, explicit = explicit)
        return true
    }
    fun documentWriteNeedsAccess(id: String) = mutable.value.tabs.firstOrNull { it.id == id }?.uri?.let(::writeIsBlocked) == true
    internal fun reportDocumentSaveFailure(id: String, error: Throwable, fallback: String): String {
        val note = mutable.value.tabs.firstOrNull { it.id == id }
        return if (isDocumentAccessFailure(error) && note?.uri != null) requestDocumentAccess(note.uri, note, writing = true)
        else { fail(fallback); fallback }
    }
    fun restoreDocumentAccess(request: DocumentAccessRequest, chosen: Uri) = viewModelScope.launch {
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
            val resolved = withContext(Dispatchers.IO) {
                documentAccess.persist(chosen)
                val target = documentAccess.resolve(chosen, request.writing)
                // Verify without truncating or writing any bytes. The existing
                // draft and its saved baseline remain authoritative.
                resolver.openFileDescriptor(target, if (request.writing) "rw" else "r")?.use { }
                    ?: error("Android did not grant access to this file")
                target
            }
            val note = mutable.value.tabs.firstOrNull { it.id == request.noteId }
            require(request.noteId == null || note != null) { "The note was closed; its recovery data was left intact." }
            if (note != null) {
                require(note.uri?.let { sameDocumentUri(it, request.uri) } == true) { "The note's destination changed; its draft was left intact." }
                change { state -> state.copy(tabs = state.tabs.map { if (it.id == note.id) it.copy(uri = resolved.toString()) else it }, message = "File access restored; your draft is unchanged") }
                if (request.writing || documentAccess.hasWriteGrant(resolved)) clearDocumentAccessFailure(request.uri)
                accessRequestsMutable.value = null
                mutable.value.tabs.first { it.id == note.id }.let(::remember)
                if (note.dirty) scheduleAutosave(note.id)
            } else {
                clearDocumentAccessFailure(request.uri)
                accessRequestsMutable.value = null
                open(resolved)
            }
        } catch (cancelled: kotlinx.coroutines.CancellationException) { throw cancelled }
        catch (error: Exception) {
            val detail = if (isDocumentAccessFailure(error)) "This file is still read-only. Your draft is safe; choose the original file with write access or save a copy." else error.message ?: "Access could not be restored"
            accessRequestsMutable.value = request.copy(detail = detail)
        }
    }
    private val windowPrefs = app.getSharedPreferences("studio-window-$workspaceKey", 0)
    val media = MediaStorage(app)
    val fonts = FontLibrary(app)
    val updates = AppUpdates(app)
    private fun loadRecent()=runCatching { val list=JSONArray(prefs.getString("recent","[]"));orderedRecents((0 until minOf(list.length(),100)).map {i->val n=list.getJSONObject(i);RecentNote(n.getString("name"),n.getString("uri"),n.optString("relative").takeIf {it.isNotBlank()},n.optBoolean("pinned"))}) }.getOrDefault(emptyList())
    private val recentMutable = MutableStateFlow(loadRecent())
    val recent = recentMutable.asStateFlow()
    var requestPortable: (() -> Unit)? = null
    var requestSaveAs: ((Note) -> Unit)? = null
    var requestPortableWrite: ((Boolean) -> Boolean)? = null
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
    private fun diskMatchesBaseline(target: Uri, note: Note): Boolean =
        if (note.portable) {
            val disk = resolver.openInputStream(target)?.use(media::openFmd) ?: error("Cannot read the current portable note")
            try {
                disk.markdown == note.saved && portableAssetsMatch(baselinePortableAssets(note), media.portableAssets(disk.directory))
            } finally {
                File(getApplication<Application>().filesDir, "portable-assets/${disk.directory}").deleteRecursively()
            }
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
    private val readerActionMutex = Mutex()
    private val openRequests = OpenRequestGate()
    private val openIntentDispatcher = OpenIntentDispatcher<Uri>()
    internal val openDispatcherSessionId: String = java.util.UUID.randomUUID().toString()
    private var initialOpenIntentUri: String? = null
    fun requestOpen(uri: Uri, relative: String? = null) = openIntentDispatcher.request(uri, relative)
    fun requestInitialOpen(uri: Uri) {
        val key = uri.toString()
        if (initialOpenIntentUri == key) return
        initialOpenIntentUri = key
        requestOpen(uri)
    }
    internal fun attachReaderOpenHandler(handler: OpenIntentDispatcher.Handler<Uri>?) = openIntentDispatcher.attach(handler)
    internal fun detachReaderOpenHandler(handler: OpenIntentDispatcher.Handler<Uri>) = openIntentDispatcher.detach(handler)
    private suspend fun performReaderBarrier(expectedActiveId: String, action: () -> Unit): Boolean = readerActionMutex.withLock {
        if (mutable.value.active.id != expectedActiveId) return@withLock false
        // A missing bridge is not an implicit flush acknowledgement. Only
        // proceed when the native snapshot is already the last acknowledged
        // reader state (for example, before the reader has ever attached).
        val accepted = try {
            readerFlushRequester?.invoke(expectedActiveId)
                ?: readerStateIsNativeAuthoritative(expectedActiveId)
        }
        catch (cancelled: kotlinx.coroutines.CancellationException) { throw cancelled }
        catch (_: Exception) { false }
        if (!accepted || mutable.value.active.id != expectedActiveId) return@withLock false
        action()
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
    private var closedNoteRefs: List<ClosedNoteReference> = runCatching {closedNoteStore.loadIndexStrict()}
        .onFailure {closedNoteIndexError=it.message}
        .getOrDefault(emptyList())
    private val closingNoteIds = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()
    private val closedNoteMutex = Mutex()
    private val mutable = MutableStateFlow(restore())
    private val viewModelRetired = AtomicBoolean(false)
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
                    windowPrefs.edit().putBoolean("folderMigrated", true).putString("folder", state.folder).apply()
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
        if(key=="customTheme")mutable.value=mutable.value.copy(customTheme=prefs.getString("customTheme","")?:"")
        if(key=="customThemeSource")observeCustomTheme()
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
    private fun observeCustomTheme(){
        resolver.unregisterContentObserver(themeObserver)
        prefs.getString("customThemeSource",null)?.let {source->runCatching {resolver.registerContentObserver(Uri.parse(source),true,themeObserver)}}
    }
    fun reloadCustomTheme(){if(themeJob?.isActive==true){themeReloadPending=true;return};prefs.getString("customThemeSource",null)?.let {importCustomTheme(Uri.parse(it),false)}}
    fun resetCustomTheme(){themeReloadPending=false;themeJob?.cancel();prefs.edit().remove("customTheme").remove("customThemeSource").apply()}
    fun importCustomTheme(uri:Uri,remember:Boolean=true){
        themeJob?.cancel()
        themeJob=viewModelScope.launch {
            if(!remember)delay(250)
            try {
                val canonical=withContext(Dispatchers.IO){
                    val bytes=resolver.openInputStream(uri)?.use {input->
                        val output=java.io.ByteArrayOutputStream();val buffer=ByteArray(4096)
                        while(output.size()<=MAX_THEME_BYTES){val count=input.read(buffer,0,minOf(buffer.size,MAX_THEME_BYTES+1-output.size()));if(count<0)break;if(count==0)error("Theme provider returned no data");output.write(buffer,0,count)}
                        output.toByteArray()
                    }?:error("Cannot read theme")
                    require(bytes.size<=MAX_THEME_BYTES){"Theme exceeds 2 MB"}
                    val raw=Charsets.UTF_8.newDecoder().onMalformedInput(java.nio.charset.CodingErrorAction.REPORT).onUnmappableCharacter(java.nio.charset.CodingErrorAction.REPORT).decode(java.nio.ByteBuffer.wrap(bytes)).toString()
                    val response=JSONObject(PdfEngine.validateTheme(raw))
                    require(!response.has("error")){response.optString("error")}
                    response.getJSONObject("theme").toString()
                }
                if(remember)runCatching {resolver.takePersistableUriPermission(uri,Intent.FLAG_GRANT_READ_URI_PERMISSION)}
                val changed=canonical!=mutable.value.customTheme
                prefs.edit().putString("customTheme",canonical).apply {if(remember)putString("customThemeSource",uri.toString())}.apply()
                if(remember||changed)mutable.value=mutable.value.copy(message="Applied "+JSONObject(canonical).getString("name"))
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
    private var listedRelative=""
    private val deletedDrafts=DeletedDraftStore(File(app.filesDir,"deleted-drafts/$workspaceKey"))
    private val documentObserver=object:android.database.ContentObserver(android.os.Handler(android.os.Looper.getMainLooper())) {
        override fun onChange(selfChange:Boolean){readerFolderIndex.clear();refreshMetadata();refreshExternal()}
        override fun onChange(selfChange:Boolean,uri:Uri?){if(uri==null||mutable.value.tabs.none{it.uri!=null&&sameDocumentUri(it.uri,uri.toString())})readerFolderIndex.clear();refreshMetadata();if(uri==null||mutable.value.tabs.any{it.uri!=null&&sameDocumentUri(it.uri,uri.toString())})refreshExternal()}
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
            val uris=(mutable.value.tabs.mapNotNull {it.uri}+recentMutable.value.map {it.uri}).distinct()
            val metadata=withContext(Dispatchers.IO) {
                uris.mapNotNull {raw->
                    val uri=Uri.parse(raw)
                    if(uri.scheme!="content")return@mapNotNull null
                    when(val info=queryProviderMetadata {
                        resolver.query(uri,arrayOf(android.provider.OpenableColumns.DISPLAY_NAME),null,null,null)?.use {cursor->
                            if(cursor.moveToFirst())ProviderMetadata.Found(cursor.getString(0)) else ProviderMetadata.Missing
                        }
                    }) {
                        is ProviderMetadata.Found->info.name?.takeIf {it.isNotBlank()}?.let {raw to it}
                        ProviderMetadata.Missing->raw to null
                        ProviderMetadata.Unavailable->null
                    }
                }.toMap()
            }
            val removed=metadata.filterValues {it==null}.keys
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
            mutable.value.folder?.let {listFolder(Uri.parse(it),listedRelative)}
        }
    }
    init { mutable.value.tabs.filter { it.portable && it.uri != null && !it.assetsDirty }.forEach { recordPortableBaseline(it.id, it.assetDirectory) }; prefs.registerOnSharedPreferenceChangeListener(preferencesChanged);observeActive();observeCustomTheme();migrateLegacyClosedNotes();if(workspaceKey=="main")viewModelScope.launch{updates.restore();if(!BuildConfig.DEBUG && updates.state.value.checkOnOpen){kotlinx.coroutines.delay(6000);updates.check()}} }
    override fun onCleared() { viewModelRetired.set(true); invalidateAllNoteAssets(); recoveryWriter.closeAfterLatest(mutable.value); prefs.unregisterOnSharedPreferenceChangeListener(preferencesChanged);resolver.unregisterContentObserver(documentObserver);resolver.unregisterContentObserver(themeObserver); super.onCleared() }
    val state = mutable.asStateFlow()
    fun inspectStorage() {
        if (mutable.value.storageScanning) return
        mutable.value = mutable.value.copy(storageScanning = true)
        viewModelScope.launch {
            val report = withContext(Dispatchers.IO) {
                runCatching {
                    val app = getApplication<Application>()
                    StorageInspector.inspect(app.filesDir, app.cacheDir)
                }.getOrElse { StorageInspector.unavailableReport() }
            }
            mutable.value = mutable.value.copy(storageReport = report, storageScanning = false)
        }
    }
    fun clearPythonStorage() {
        if (mutable.value.storageScanning) return
        mutable.value = mutable.value.copy(storageScanning = true)
        viewModelScope.launch {
            val result = withContext(Dispatchers.IO) {
                runCatching {
                    val app = getApplication<Application>()
                    val cleared = StorageInspector.clearPythonResults(app.filesDir, app.cacheDir)
                    cleared to StorageInspector.inspect(app.filesDir, app.cacheDir)
                }
            }
            val value = result.getOrNull()
            mutable.value = mutable.value.copy(
                storageScanning = false,
                storageReport = value?.second ?: mutable.value.storageReport,
                message = if (value != null) "Cleared ${value.first} temporary Python result files. Notes and recovery data were preserved." else mutable.value.message,
                error = if (value == null) "Could not safely clear temporary results: ${result.exceptionOrNull()?.message.orEmpty()}" else null,
            )
        }
    }
    private val outlineMutable = MutableStateFlow<List<OutlineHeading>>(emptyList())
    val headings = outlineMutable.asStateFlow()
    private val imageMutable = MutableStateFlow(false)
    val imageOverlay = imageMutable.asStateFlow()
    fun outline(id: String, entries: JSONArray) {
        if (id != mutable.value.active.id) return
        outlineMutable.value = (0 until minOf(entries.length(), 2000)).map { index ->
            val entry = entries.getJSONObject(index)
            OutlineHeading(entry.getString("id"), entry.getString("title"), entry.getInt("level").coerceIn(1,6), entry.getInt("offset").coerceAtLeast(0))
        }
        val note = mutable.value.active
        if (note.uri == null && note.name.startsWith("Untitled") && outlineMutable.value.isNotEmpty()) {
            val title = outlineMutable.value.first().title.filter { it.code >= 32 && it !in "/\\:*?\"<>|" }.trim().trim('.').take(120)
            if (title.isNotEmpty()) change { s -> s.copy(tabs = s.tabs.map { if (it.id == id) it.copy(name = title + if (it.portable) ".smd" else ".md") else it }) }
        }
    }
    private fun resolveDisplayName(target: Uri): String? =
        DocumentFile.fromSingleUri(getApplication(), target)?.name?.takeIf(String::isNotBlank)
            ?: target.takeIf { it.scheme == "file" }?.lastPathSegment?.takeIf(String::isNotBlank)

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
                            val target=documentAccess.resolve(Uri.parse(note.uri), writing = true)
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
        var s = StudioState(theme = prefs.getString("theme", "system")!!, fullscreenTheme = prefs.getString("fullTheme", "black")!!, motion = prefs.getBoolean("motion", true), welcomed = prefs.getBoolean("welcomed", false), font = prefs.getString("font", "Manrope")!!, size = prefs.getFloat("size", 15f), folder = windowPrefs.getString("folder", if (workspaceKey == "main" && !windowPrefs.getBoolean("folderMigrated", false)) prefs.getString("folder", null) else null), pdf = prefs.getString("pdf", null) ?: StudioState().pdf)
        s = s.copy(spellCheck=prefs.getBoolean("spellCheck",false),grammarCheck=prefs.getBoolean("grammarCheck",false),accent = prefs.getString("accent","system")!!, widthPercent = prefs.getFloat("widthPercent",100f),lineHeight = prefs.getFloat("lineHeight",1.65f),autosave = prefs.getBoolean("autosave",true),customFonts = fonts.families)
        try {
            if (snapshot.isFile) s=snapshot.bufferedReader().use {NoteRecovery.read(it,s)}
        } catch (_: Exception) { s = s.copy(error = "The recovery snapshot could not be read. Your original files are untouched.") }
        s=readingPreferences(s).copy(customTheme=prefs.getString("customTheme","")?:"",selectionAssistant=SelectionActions.provider(prefs.getString("selectionAssistant",null)),latexAutofix=prefs.getBoolean("latexAutofix",false),typewriterScroll=prefs.getBoolean("typewriterScroll",false))
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
    private fun readingPreferences(s:StudioState)=s.copy(patternKind=prefs.getString("patternKind","")?:"",patternOpacity=prefs.getFloat("patternOpacity",-1f),patternSize=prefs.getFloat("patternSize",0f),patternSpacing=prefs.getFloat("patternSpacing",0f),centerLock=prefs.getBoolean("centerLock",true),restorePosition=prefs.getBoolean("restorePosition",true),fullDocumentAccessibility=prefs.getBoolean("fullDocumentAccessibility",false),startup=prefs.getString("startup","restore") ?: "restore",imageAppearance=prefs.getString("imageAppearance","original") ?: "original",svgAppearance=prefs.getString("svgAppearance","original") ?: "original",imageContrast=prefs.getFloat("imageContrast",1.25f))
    fun readingPreference(key:String,value:String) {
        if(key=="patternKind"&&value in listOf("","none","paws","dots","grid","diagonal","gradient"))prefs.edit().putString(key,value).apply()
        if(key in listOf("imageAppearance","svgAppearance")&&value in listOf("original","invert-dark","auto","monochrome","contrast") || key=="startup"&&value in listOf("restore","new"))prefs.edit().putString(key,value).apply()
    }
    fun themeBackgroundPreference(key:String,value:Float) {
        val range=when(key){"patternOpacity"->0f..0.25f;"patternSize"->8f..64f;"patternSpacing"->12f..192f;else->return}
        if(value.isFinite()&&value in range)prefs.edit().putFloat(key,value).apply()
    }
    fun resetThemeBackground(){prefs.edit().remove("patternKind").remove("patternOpacity").remove("patternSize").remove("patternSpacing").apply()}
    fun restorePosition(value:Boolean){prefs.edit().putBoolean("restorePosition",value).apply()}
    fun fullDocumentAccessibility(value:Boolean){prefs.edit().putBoolean("fullDocumentAccessibility",value).apply()}
    fun centerLock(value:Boolean){prefs.edit().putBoolean("centerLock",value).apply()}
    fun imageContrast(value:Float){if(value.isFinite())prefs.edit().putFloat("imageContrast",value.coerceIn(1f,2f)).apply()}
    fun readingLocation(uri:String?):JSONObject?=if(uri==null)null else runCatching {JSONObject(prefs.getString("readingPositions","{}")!!).optJSONObject(uri)}.getOrNull()
    fun readingPosition(id:String,location:JSONObject) {
        val note=mutable.value.tabs.find {it.id==id} ?: return
        val uri=note.uri ?: return
        if(!mutable.value.restorePosition)return
        if(listOf("top","offset","zoom").any {val value=location.optDouble(it,Double.NaN);!value.isFinite()||value<0} || location.optString("mode") !in listOf("reader","live","editor","split"))return
        val old=runCatching {JSONObject(prefs.getString("readingPositions","{}")!!)}.getOrDefault(JSONObject())
        old.remove(uri);old.put(uri,JSONObject().put("top",location.getDouble("top")).put("offset",location.getDouble("offset")).put("zoom",location.getDouble("zoom")).put("mode",location.getString("mode")))
        while(old.length()>200)old.remove(old.keys().next())
        prefs.edit().putString("readingPositions",old.toString()).apply()
    }
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
    internal fun clearReaderEditProtocol(id: String) { readerEditProtocol.clear(id) }
    internal fun readerStateIsNativeAuthoritative(id: String): Boolean =
        mutable.value.tabs.find { it.id == id }?.let { readerEditProtocol.matchesNative(id, it.content) } == true
    /** An edit that came from the reader itself; only these may skip the echo. */
    fun readerEdit(id: String, content: String, protocolPatch: Boolean = false) {
        if (mutable.value.tabs.none { it.id == id }) return
        if (!protocolPatch) readerEditProtocol.clear(id)
        readerEcho[id] = content
        edit(id, content)
    }

    internal fun readerSync(id: String, epoch: String, revision: Long, content: String): JSONObject {
        val note = mutable.value.tabs.find { it.id == id }
        return readerProtocolJson(readerEditProtocol.sync(id, epoch, revision, content, note?.content))
    }

    internal fun readerPatch(
        id: String,
        epoch: String,
        baseRevision: Long,
        revision: Long,
        changes: List<ReaderEditChange>,
    ): JSONObject {
        val note = mutable.value.tabs.find { it.id == id }
        val ack = readerEditProtocol.patch(id, epoch, baseRevision, revision, changes, note?.content) { updated ->
            readerEdit(id, updated, protocolPatch = true)
        }
        return readerProtocolJson(ack)
    }

    internal fun readerResync(
        id: String,
        epoch: String,
        revision: Long,
        bases: List<String>,
        content: String,
    ): JSONObject {
        val note = mutable.value.tabs.find { it.id == id }
        val ack = readerEditProtocol.resync(id, epoch, revision, bases, content, note?.content) { updated ->
            readerEdit(id, updated, protocolPatch = true)
        }
        if (!ack.accepted) preserveReaderConflictDraft(id, note?.name ?: "Reader draft", content)
        return readerProtocolJson(ack)
    }

    /** Preserve a bounded draft from a malformed resync envelope when its text is still usable. */
    internal fun preserveMalformedReaderResync(id: String?, content: String?) {
        if (content == null) return
        if (!readerConflictDraftWithinLimits(content)) {
            fail("Reader edits conflicted with newer native content, but the incoming draft is too large for a private recovery copy. Keep the reader open and copy it before continuing.")
            return
        }
        preserveReaderConflictDraft(id?.takeIf { it.isNotBlank() && it.length <= 256 } ?: "unknown-reader", "Reader draft", content)
    }

    private fun readerProtocolJson(ack: ReaderEditProtocol.Ack): JSONObject =
        if (ack.accepted) JSONObject().put("accepted", true).put("revision", ack.revision)
        else JSONObject().put("accepted", false).put("reason", "conflict")

    /** Preserve a conflicting renderer draft without blocking the UI thread. */
    private fun preserveReaderConflictDraft(id: String, name: String, content: String) {
        if (!readerConflictDraftWithinLimits(content)) {
            fail("Reader edits conflicted with newer native content, but the incoming draft is too large for a private recovery copy. Keep the reader open and copy it before continuing.")
            return
        }
        viewModelScope.launch(Dispatchers.IO) {
            var temporary: File? = null
            val saved = runCatching {
                val root = File(getApplication<Application>().filesDir, "reader-conflicts").apply { check(isDirectory || mkdirs()) }
                val destination = File(root, "reader-conflict-${UUID.randomUUID()}.json")
                val tempFile = File(root, destination.name + ".tmp")
                temporary = tempFile
                val output = java.io.FileOutputStream(tempFile)
                val writer = android.util.JsonWriter(java.io.OutputStreamWriter(output, Charsets.UTF_8))
                try {
                    writer.beginObject().name("id").value(id).name("name").value(name).name("content").value(content).endObject()
                    writer.flush()
                    output.fd.sync()
                } finally { writer.close() }
                check(tempFile.renameTo(destination)) { "Could not replace private conflict draft" }
            }.onFailure { temporary?.delete() }
            withContext(Dispatchers.Main) {
                fail(if (saved.isSuccess) "Reader edits conflicted with newer native content. A private recovery copy was saved." else "Reader edits conflicted with newer native content, and the private recovery copy could not be written. Keep the reader draft open and copy it before continuing.")
            }
        }
    }

    fun edit(id: String, content: String) { change { s -> s.copy(tabs = s.tabs.map { if (it.id == id) it.copy(content = content) else it }) }; scheduleAutosave(id) }
    /** Commit an inactive-note patch computed from an immutable reader snapshot. */
    internal suspend fun commitAgentSnapshotPatch(id: String, expectedRevision: String, patchedContent: String, patchedRevision: String) = documentWrites.withLock {
        require(patchedContent.toByteArray(Charsets.UTF_8).size <= MAX_AGENT_SNAPSHOT_BYTES) { "The patched document exceeds Android's 2 MiB relay snapshot limit" }
        val note = mutable.value.tabs.firstOrNull { it.id == id } ?: error("The requested note is no longer open")
        val currentRevision = java.security.MessageDigest.getInstance("SHA-256")
            .digest(note.content.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
        require(currentRevision.equals(expectedRevision, ignoreCase = true)) { "Revision conflict: the note changed before the patch could be saved" }
        val actualPatchedRevision = java.security.MessageDigest.getInstance("SHA-256")
            .digest(patchedContent.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
        require(actualPatchedRevision.equals(patchedRevision, ignoreCase = true)) { "The computed patch failed revision verification" }
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
        val expected = mutable.value.active.id
        viewModelScope.launch {
            val nativeFormat = if (format == "smd") NativeExportFormat.PORTABLE_SMD else NativeExportFormat.MARKDOWN
            val title = ExportFilename.suggestedName(titleHint ?: "Untitled", nativeFormat)
            val assets = if (format == "smd") media.createEmptyPortableDirectory() else null
            val note = Note(name = title, content = content ?: "", assetDirectory = assets)
            val accepted = performReaderBarrier(expected) {
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
            val accepted=performReaderBarrier(expectedActiveId) {
                if(mutable.value.tabs.any {it.id==targetId})change {it.copy(activeId=targetId)}
            }
            if(!accepted)readerBarrierFailed()
        }
    }
    private var refreshJob:Job?=null
    fun refreshExternal() {
        refreshJob?.cancel()
        val candidates = mutable.value.tabs.filter { it.uri != null }
        if (candidates.isEmpty()) return
        refreshJob = viewModelScope.launch {
            delay(200)
            val snapshotTabs = mutable.value.tabs.filter { it.uri != null }
            val newlyConflicted = mutableSetOf<String>()
            val cleanUpdates = mutableMapOf<String, Triple<String, String?, JSONObject?>>()
            withContext(Dispatchers.IO) {
                for (note in snapshotTabs) {
                    val target = runCatching { documentAccess.resolve(Uri.parse(note.uri!!)) }.getOrNull() ?: continue
                    if (note.dirty) {
                        if (note.id !in mutable.value.conflictedTabIds) {
                            val matches = runCatching { diskMatchesBaseline(target, note) }.getOrNull()
                            if (matches == false) newlyConflicted.add(note.id)
                        }
                    } else if (note.id !in mutable.value.conflictedTabIds) {
                        if (note.portable) {
                            val disk = runCatching { resolver.openInputStream(target)?.use(media::openFmd) }.getOrNull() ?: continue
                            val diskAssets = runCatching { media.portableAssets(disk.directory) }.getOrDefault(JSONObject())
                            if (disk.markdown == note.content && portableAssetsMatch(baselinePortableAssets(note), diskAssets)) {
                                File(getApplication<Application>().filesDir, "portable-assets/${disk.directory}").deleteRecursively()
                            } else {
                                cleanUpdates[note.id] = Triple(disk.markdown, disk.directory, diskAssets)
                            }
                        } else {
                            val text = runCatching { resolver.openInputStream(target)?.use { readLimited(it, 20_000_000).toString(Charsets.UTF_8) } }.getOrNull() ?: continue
                            if (text != note.content) cleanUpdates[note.id] = Triple(text, null, null)
                        }
                    }
                }
            }
            if (newlyConflicted.isEmpty() && cleanUpdates.isEmpty()) return@launch
            newlyConflicted.forEach { autosavePending.remove(it) }
            val obsoletePortableDirs = mutableListOf<String>()
            cleanUpdates.forEach { (id, update) ->
                val current = mutable.value.tabs.find { it.id == id }
                if (current != null && !current.dirty && id !in mutable.value.conflictedTabIds) {
                    invalidateNoteAssets(id)
                    readerEcho.remove(id)
                    clearReaderEditProtocol(id)
                    if (update.second != null && update.third != null) {
                        savedPortableAssets[id] = update.third!!
                        if (current.assetDirectory != null && current.assetDirectory != update.second) obsoletePortableDirs.add(current.assetDirectory)
                    }
                } else if (update.second != null) {
                    obsoletePortableDirs.add(update.second!!)
                }
            }
            if (obsoletePortableDirs.isNotEmpty()) {
                withContext(Dispatchers.IO) { obsoletePortableDirs.forEach { File(getApplication<Application>().filesDir, "portable-assets/$it").deleteRecursively() } }
            }
            change { s ->
                s.copy(
                    tabs = s.tabs.map { tab ->
                        val update = cleanUpdates[tab.id]
                        if (update != null && !tab.dirty && tab.id !in s.conflictedTabIds) {
                            tab.copy(content = update.first, saved = update.first, assetDirectory = update.second ?: tab.assetDirectory, assetsDirty = false)
                        } else tab
                    },
                    conflictedTabIds = s.conflictedTabIds + newlyConflicted,
                    message = if (newlyConflicted.isNotEmpty()) "This file changed on disk. Autosave is paused for this tab." else s.message,
                )
            }
        }
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
            withContext(Dispatchers.IO){closedNoteStore.saveIndex(next)}
            val replacements=stillClosed.associate {it.first.id to it}
            val finalRefs=next.filter {ref ->
                val old=replacements[ref.id]?.first
                old==null || mutable.value.closedTabs.any {it==old}
            }
            if(finalRefs!=next)withContext(Dispatchers.IO){closedNoteStore.saveIndex(finalRefs)}
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
        viewModelScope.launch {
            val activeId = mutable.value.active.id
            if (id == activeId && !performReaderBarrier(activeId) { }) {
                readerBarrierFailed()
                return@launch
            }
            val note = mutable.value.tabs.find { it.id == id } ?: return@launch
            if (note.requiresCloseConfirmation) {
                change { state -> state.copy(activeId = if (state.tabs.any { it.id == id }) id else state.activeId, pendingCloseNoteId = id) }
            } else {
                close(id)
            }
        }
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
    fun close(id: String, expectedRevision: String? = null, refuseDirty: Boolean = false, discardChanges: Boolean = false, onComplete: ((String?) -> Unit)? = null) {
        openRequests.invalidate()
        viewModelScope.launch {
            var preserve = false
            var revisionError: String? = null
            var closeError: String? = null
            val activeId = mutable.value.active.id
            val accepted = performReaderBarrier(activeId) {
                val note = mutable.value.tabs.find { it.id == id } ?: return@performReaderBarrier
                if (expectedRevision != null && !agentContentRevision(note.content).equals(expectedRevision, ignoreCase = true)) {
                    revisionError = "Revision conflict: the note changed since the supplied revision; it remains open"
                    return@performReaderBarrier
                }
                if (refuseDirty && note.dirty && !discardChanges) {
                    closeError = "The note has unsaved changes. Set options.discardChanges=true to close it; Android will retain its recovery copy."
                    return@performReaderBarrier
                }
                if (!closingNoteIds.add(id)) return@performReaderBarrier
                if (note.uri == null && note.content.isBlank() && note.assetDirectory == null) {
                    readerEcho.remove(id)
                    clearReaderEditProtocol(id)
                    autosavePending.remove(id)
                    change { state ->
                        val remaining = state.tabs.filterNot { it.id == id }
                        val next = remaining.ifEmpty { listOf(Note()) }
                        state.copy(tabs = next, activeId = if (state.active.id == id) next.first().id else state.activeId,
                            conflictedTabIds = state.conflictedTabIds - id,
                            pendingCloseNoteId = state.pendingCloseNoteId?.takeUnless { it == id },
                            pendingSaveConflictNoteId = state.pendingSaveConflictNoteId?.takeUnless { it == id },
                            message = "Empty tab discarded")
                    }
                    closingNoteIds.remove(id)
                } else if (note.uri == null && note.content.isBlank() && !note.assetsDirty && runCatching { media.portableAssets(note.assetDirectory).length() == 0 }.getOrDefault(false)) {
                    readerEcho.remove(id)
                    clearReaderEditProtocol(id)
                    autosavePending.remove(id)
                    savedPortableAssets.remove(id)
                    change { state ->
                        val remaining = state.tabs.filterNot { it.id == id }
                        val next = remaining.ifEmpty { listOf(Note()) }
                        state.copy(tabs = next, activeId = if (state.active.id == id) next.first().id else state.activeId,
                            conflictedTabIds = state.conflictedTabIds - id,
                            pendingCloseNoteId = state.pendingCloseNoteId?.takeUnless { it == id },
                            pendingSaveConflictNoteId = state.pendingSaveConflictNoteId?.takeUnless { it == id },
                            message = "Empty tab discarded")
                    }
                    closingNoteIds.remove(id)
                } else preserve = true
            }
            if (!accepted) {
                readerBarrierFailed()
                onComplete?.invoke("The note draft could not be synchronized before closing")
                return@launch
            }
            if (revisionError != null) { onComplete?.invoke(revisionError); return@launch }
            if (closeError != null) { onComplete?.invoke(closeError); return@launch }
            if (preserve) closeAfterReaderBarrier(id)
            val afterClose = mutable.value
            if (afterClose.tabs.any { it.id == id }) {
                onComplete?.invoke("The note could not be closed; it remains open")
                return@launch
            }
            if (afterClose.active.id != activeId && !awaitReaderSnapshot(afterClose.active.id)) {
                val message = "The note was closed and preserved, but the active reader is still loading; refresh the tabs before the next action."
                mutable.value = mutable.value.copy(message = message)
                onComplete?.invoke(message)
                return@launch
            }
            onComplete?.invoke(null)
        }
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
            if (noteToClose.uri == null && noteToClose.content.isBlank() && noteToClose.assetDirectory == null) {
                readerEcho.remove(id)
                clearReaderEditProtocol(id)
                change { state ->
                    val remaining = state.tabs.filterNot { it.id == id }
                    val next = remaining.ifEmpty { listOf(Note()) }
                    state.copy(tabs = next, activeId = if (state.active.id == id) next.first().id else state.activeId,
                        message = "Empty tab discarded")
                }
                return
            }
            val reference = withContext(Dispatchers.IO) { closedNoteStore.save(noteToClose) }
            if (mutable.value.tabs.find { it.id == id } != noteToClose) {
                mutable.value = mutable.value.copy(message = "The note changed while it was closing. It remains open with the latest text.")
                return
            }
            val previousRefs = withContext(Dispatchers.IO) { closedNoteStore.loadIndexStrict() }
            val nextRefs = (listOf(reference) + previousRefs.filterNot { it.id == id }).take(ClosedNoteStore.LIMIT)
            try { withContext(Dispatchers.IO) { closedNoteStore.saveIndex(nextRefs) } }
            catch (error: Exception) {
                mutable.value = mutable.value.copy(message = "Could not update closed-note recovery: ${error.message}")
                return
            }
            if (mutable.value.tabs.find { it.id == id } != noteToClose) {
                withContext(Dispatchers.IO) { closedNoteStore.saveIndex(previousRefs) }
                mutable.value = mutable.value.copy(message = "The note changed while it was closing. It remains open with the latest text.")
                return
            }
            closedNoteRefs = nextRefs
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
        val expectedActiveId = mutable.value.active.id
        val referenceNote=mutable.value.closedTabs.firstOrNull() ?: return
        val reference=closedNoteRefs.firstOrNull {it.id==referenceNote.id}
        viewModelScope.launch {
            val note=try {if(reference==null)referenceNote else withContext(Dispatchers.IO){closedNoteStore.load(reference)}}
                catch(error:Exception) {mutable.value=mutable.value.copy(message="Could not reopen the closed note: ${error.message}");return@launch}
            var updatedRefs: List<ClosedNoteReference>? = null
            val accepted = performReaderBarrier(expectedActiveId) {
                if(mutable.value.closedTabs.none {it.id==referenceNote.id})return@performReaderBarrier
                readerEcho.remove(note.id)
                if (note.portable && note.uri != null && !note.assetsDirty) recordPortableBaseline(note.id, note.assetDirectory)
                closedNoteRefs=closedNoteRefs.filterNot {it.id==note.id}
                updatedRefs = closedNoteRefs
                change { state ->
                    val existing=state.tabs.find {it.id==note.id}
                    val tabs=if(existing==null)state.tabs+note else state.tabs
                    state.copy(tabs=tabs,closedTabs=state.closedTabs.dropWhile {it.id==referenceNote.id}.filterNot {it.id==referenceNote.id},activeId=note.id)
                }
            }
            if(!accepted)readerBarrierFailed()
            else updatedRefs?.let { refs -> withContext(Dispatchers.IO) { runCatching { closedNoteStore.saveIndex(refs) } } }
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
    fun mode(value: String) {
        val expectedActiveId=mutable.value.active.id
        viewModelScope.launch {
            val accepted=performReaderBarrier(expectedActiveId) {change {it.copy(mode=value)}}
            if(!accepted)readerBarrierFailed()
        }
    }
    fun fullscreen(value: Boolean) = change { s ->
        if (value == s.fullscreen) s else s.copy(fullscreen = value,
            // Fullscreen is a chrome change, not a request to load an old scale.
            fullscreenZoom = if (value) s.normalZoom else s.fullscreenZoom)
    }
    // Reader gestures are acknowledgements, not a second command back to WebView.
    // Only an explicit native control/shortcut advances the command generation.
    fun zoom(value: Float) = change { s -> val command=maxOf(System.currentTimeMillis(),s.zoomCommand+1);if (s.fullscreen) s.copy(fullscreenZoom = value.coerceIn(40f, 300f), zoomCommand = command) else s.copy(normalZoom = value.coerceIn(40f, 300f), zoomCommand = command) }
    fun readerZoom(value: Float, fullscreen: Boolean) = change { s -> if (fullscreen) s.copy(fullscreenZoom = value.coerceIn(40f, 300f)) else s.copy(normalZoom = value.coerceIn(40f, 300f)) }
    fun appearance(accent: String? = null, theme: String? = null, fullTheme: String? = null, motion: Boolean? = null, font: String? = null, size: Float? = null) {
        if(size!=null && (!size.isFinite() || size !in 6f..32f))return
        change { it.copy(accent = accent ?: it.accent, theme = theme ?: it.theme, fullscreenTheme = fullTheme ?: it.fullscreenTheme, motion = motion ?: it.motion, font = font ?: it.font, size = size ?: it.size) }
        prefs.edit().apply { accent?.let { putString("accent", it) }; theme?.let { putString("theme", it) }; fullTheme?.let { putString("fullTheme", it) }; motion?.let { putBoolean("motion", it) }; font?.let { putString("font", it) }; size?.let { putFloat("size", it) } }.apply()
    }
    fun pdf(value: String) { change { it.copy(pdf = value) }; prefs.edit().putString("pdf", value).apply() }
    fun noteLocation(): String = prefs.getString("newNoteLocation", "") ?: ""
    internal suspend fun saveAgentMedia(args: JSONObject): JSONObject = withContext(Dispatchers.IO) {
        media.saveAgentMedia(args, noteLocation()).also { readerFolderIndex.clear() }
    }
    fun noteLocation(uri: Uri) {
        getApplication<Application>().contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        prefs.edit().putString("newNoteLocation", uri.toString()).apply()
    }
    fun reading(widthPercent: Float? = null, lineHeight: Float? = null, autosave: Boolean? = null) {
        val width=widthPercent?.takeIf { it.isFinite() }?.coerceIn(50f,150f)
        val leading=lineHeight?.takeIf { it.isFinite() }?.coerceIn(1.15f,2.2f)
        change { it.copy(widthPercent=width ?: it.widthPercent,lineHeight=leading ?: it.lineHeight,autosave=autosave ?: it.autosave) }
        prefs.edit().apply { width?.let { putFloat("widthPercent",it) };leading?.let { putFloat("lineHeight",it) };autosave?.let { putBoolean("autosave",it) } }.apply()
    }
    fun writing(spellCheck:Boolean?=null,grammarCheck:Boolean?=null) {
        change {it.copy(spellCheck=spellCheck?:it.spellCheck,grammarCheck=grammarCheck?:it.grammarCheck)}
        prefs.edit().apply {spellCheck?.let {putBoolean("spellCheck",it)};grammarCheck?.let {putBoolean("grammarCheck",it)}}.apply()
    }
    fun selectionAssistant(value:String) {
        if(SelectionActions.assistants.none {it.first==value})return
        change {it.copy(selectionAssistant=value)}
        prefs.edit().putString("selectionAssistant",value).apply()
    }
    fun latexAutofix(enabled:Boolean) {
        change {it.copy(latexAutofix=enabled)}
        prefs.edit().putBoolean("latexAutofix",enabled).apply()
    }
    fun typewriterScroll(enabled:Boolean) {
        change {it.copy(typewriterScroll=enabled)}
        prefs.edit().putBoolean("typewriterScroll",enabled).apply()
    }
    fun overlay(open: Boolean, image: Boolean = false) { mutable.value=mutable.value.copy(readerOverlay=open); imageMutable.value=image }
    fun importFont(uri: Uri) = viewModelScope.launch {
        try { val family=withContext(Dispatchers.IO) {fonts.import(uri)};appearance(font=family);prefs.edit().putLong("fonts",System.currentTimeMillis()).apply();mutable.value=mutable.value.copy(customFonts=fonts.families,message="Imported $family for reading and PDF export") }
        catch(error: Exception) {fail("Could not import font: ${error.message}")}
    }
    fun rename(id: String, requested: String) = viewModelScope.launch {
        val note=mutable.value.tabs.find {it.id==id} ?: return@launch
        try {
            var name=requested.trim();require(name.isNotBlank() && name !in listOf(".","..") && !name.any {it=='/' || it=='\\' || it=='\u0000'}) {"Choose a filename without path separators"}
            val extension=note.name.substringAfterLast('.',"md")
            if(!name.contains('.'))name+=".$extension"
            require(name.substringAfterLast('.').equals(extension,true)) {"Rename keeps the note format. Use Export to change formats."}
            val uri=note.uri?.let {withContext(Dispatchers.IO) {DocumentsContract.renameDocument(resolver,Uri.parse(it),name)?.toString() ?: error("This provider does not support renaming. Use Save as instead.")}}
            workspaceLinks.invalidate()
            change {s->s.copy(tabs=s.tabs.map {if(it.id==id)it.copy(name=name,uri=uri,relative=it.relative?.let {r->r.substringBeforeLast('/',"").let {parent->if(parent.isEmpty())name else "$parent/$name"}}) else it})}
            mutable.value.tabs.find {it.id==id}?.let(::remember)
        } catch(error:Exception){fail("Could not rename note: ${error.message}")}
    }
    fun welcomeDone() { change { it.copy(welcomed = true) }; prefs.edit().putBoolean("welcomed", true).apply() }
    fun dismissMessage() { mutable.value = mutable.value.copy(message = null) }
    fun dismissError() { mutable.value = mutable.value.copy(error = null) }
    fun fail(message: String) { shareFile = null; mutable.value = mutable.value.copy(busy = false, error = message) }
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
    fun grantWorkspaceFolderForLink(uri: Uri) = viewModelScope.launch {
        val prompt = mutable.value.folderAccessPrompt
        try {
            withContext(Dispatchers.IO) {
                val retained = persistDocumentGrants { resolver.takePersistableUriPermission(uri, it) }
                require(retained and Intent.FLAG_GRANT_READ_URI_PERMISSION != 0) { "Android did not grant folder read permission" }
            }
            workspaceLinks.invalidate()
            windowPrefs.edit().putBoolean("folderMigrated", true).putString("folder", uri.toString()).apply()
            change { it.copy(folder = uri.toString(), folderAccessPrompt = null) }
            listFolder(uri, "")
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
    private fun candidateWorkspaceTrees(noteUri: Uri?): List<Uri> {
        val candidates = ArrayList<Uri>()
        mutable.value.folder?.let(Uri::parse)?.takeIf { DocumentsContract.isTreeUri(it) }?.let(candidates::add)
        val persisted = resolver.persistedUriPermissions
            .filter { it.isReadPermission && DocumentsContract.isTreeUri(it.uri) && (noteUri == null || it.uri.authority == noteUri.authority) }
            .sortedByDescending { runCatching { DocumentsContract.getTreeDocumentId(it.uri).length }.getOrDefault(0) }
            .map { it.uri }
        for (tree in persisted) {
            if (candidates.none { it == tree }) candidates.add(tree)
        }
        return candidates
    }
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
        val sourceNote = stateSnapshot.tabs.firstOrNull {
            documentPath.isNotBlank() && (it.id == documentPath || it.uri?.let { raw -> sameDocumentUri(raw, documentPath) } == true)
        } ?: stateSnapshot.active
        val explicitRelative = !wikilink ||
            trimmedTarget.startsWith("./") ||
            trimmedTarget.startsWith("../") ||
            trimmedTarget.startsWith(".\\") ||
            trimmedTarget.startsWith("..\\")

        if (sourceNote.uri == null) {
            if (explicitRelative) {
                val notice = "Save this note first before following relative links."
                mutable.value = mutable.value.copy(message = notice)
                return JSONObject().put("opened", false).put("message", notice)
            }
            val openFolder = stateSnapshot.folder?.let(Uri::parse)?.takeIf { DocumentsContract.isTreeUri(it) }
            if (openFolder == null) {
                val notice = "Save this note or open a folder before following workspace links."
                mutable.value = mutable.value.copy(message = notice)
                return JSONObject().put("opened", false).put("message", notice)
            }
            val resolved = try {
                withContext(Dispatchers.IO) {
                    workspaceLinks.resolve(openFolder, noteRelative = null, rawTarget = trimmedTarget, wikilink = true)
                }
            } catch (cancelled: kotlinx.coroutines.CancellationException) {
                throw cancelled
            } catch (error: WorkspaceLinkException) {
                val msg = error.message ?: "Note not found"
                mutable.value = mutable.value.copy(message = msg)
                return JSONObject().put("opened", false).put("message", msg)
            }
            return openResolvedWorkspaceNote(resolved, trimmedFragment)
        }

        val sourceUri = Uri.parse(sourceNote.uri)
        val candidates = candidateWorkspaceTrees(sourceUri)
        val resolvedResult = try {
            withContext(Dispatchers.IO) {
                var coveringTree: Uri? = null
                var noteRelative: String? = null
                for (candidate in candidates) {
                    val rel = workspaceLinks.noteRelativeInTree(
                        candidate,
                        sourceUri,
                        knownRelative = sourceNote.relative.takeIf { candidate.toString() == stateSnapshot.folder },
                    )
                    if (rel != null) {
                        coveringTree = candidate
                        noteRelative = rel
                        break
                    }
                }
                if (coveringTree == null && !explicitRelative) {
                    val fallbackFolder = stateSnapshot.folder?.let(Uri::parse)?.takeIf { DocumentsContract.isTreeUri(it) }
                    if (fallbackFolder != null) {
                        return@withContext workspaceLinks.resolve(fallbackFolder, noteRelative = null, rawTarget = trimmedTarget, wikilink = true)
                    }
                }
                if (coveringTree == null) return@withContext null
                workspaceLinks.resolve(coveringTree, noteRelative = noteRelative, rawTarget = trimmedTarget, wikilink = wikilink)
            }
        } catch (cancelled: kotlinx.coroutines.CancellationException) {
            throw cancelled
        } catch (error: WorkspaceLinkException) {
            val msg = error.message ?: "Could not resolve note link"
            mutable.value = mutable.value.copy(message = msg)
            return JSONObject().put("opened", false).put("message", msg)
        }

        if (resolvedResult == null) {
            val notice = if (allowFolderPrompt) {
                "Folder permission is needed to follow links from ${sourceNote.name}. Choose its containing folder."
            } else {
                "Choose the folder containing ${sourceNote.name} to follow relative links."
            }
            val prompt = if (allowFolderPrompt) {
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

        return openResolvedWorkspaceNote(resolvedResult, trimmedFragment)
    }
    private suspend fun openResolvedWorkspaceNote(resolved: WorkspaceResolvedNote, fragment: String): JSONObject {
        val request = openRequests.begin()
        try {
            val note = loadNoteForOpen(resolved.uri, resolved.relative)
            if (note.uri?.let { documentAccess.hasWriteGrant(Uri.parse(it)) } == true) {
                clearDocumentAccessFailure(resolved.uri.toString())
            }
            if (!openRequests.isCurrent(request)) {
                retainOpenedNote(note, activate = false)
                return JSONObject().put("opened", false)
            }
            val expectedActiveId = mutable.value.active.id
            var openedTabId: String? = null
            val accepted = performReaderBarrier(expectedActiveId) {
                val previous = mutable.value.tabs.firstOrNull { it.id == expectedActiveId }
                if (previous != null && previous.dirty && previous.uri != null) {
                    scheduleAutosave(previous.id)
                }
                val activate = openRequests.isCurrent(request)
                openedTabId = retainOpenedNote(note, activate = activate, headingFragment = fragment.takeIf { activate && it.isNotBlank() })
            }
            if (!accepted || openedTabId == null) {
                if (!openRequests.isCurrent(request)) retainOpenedNote(note, activate = false)
                else readerBarrierFailed()
                return JSONObject().put("opened", false)
            }
            return JSONObject().put("opened", true).put("id", openedTabId).put("uri", note.uri ?: resolved.uri.toString())
        } catch (cancelled: kotlinx.coroutines.CancellationException) {
            throw cancelled
        } catch (error: Exception) {
            val msg = if (isDocumentAccessFailure(error)) {
                requestDocumentAccess(resolved.uri.toString(), mutable.value.tabs.firstOrNull { it.uri?.let { raw -> sameDocumentUri(raw, resolved.uri.toString()) } == true }, writing = false, explicit = true)
            } else {
                val detail = "Could not open linked note: ${error.message}"
                mutable.value = mutable.value.copy(message = detail)
                detail
            }
            return JSONObject().put("opened", false).put("message", msg)
        }
    }
    private fun loadNoteForOpen(uri: Uri, relative: String?): Note {
        documentAccess.persist(uri)
        val target = documentAccess.resolve(uri)
        val existing = mutable.value.tabs.find { it.uri?.let { raw -> sameDocumentUri(raw, uri.toString()) } == true }
        // Reopening an existing draft must still validate its grant,
        // but must never reload older disk bytes over its edits.
        if (existing != null) {
            resolver.openInputStream(target)?.use { } ?: error("Document permission is unavailable; choose it again")
            return existing.copy(uri = target.toString(), relative = relative ?: existing.relative)
        }
        val name = resolveDisplayName(target)
            ?: relative?.substringAfterLast('/')
            ?: "Note.md"
        return resolver.openInputStream(target)?.use { stream ->
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
                val content = readLimited(buffered, 20_000_000).toString(Charsets.UTF_8)
                Note(name = name, uri = target.toString(), content = content, saved = content, relative = relative)
            }
        } ?: error("Document permission is unavailable; choose it again")
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
    fun open(uri: Uri, relative: String? = null): Job {
        val request = openRequests.begin()
        return viewModelScope.launch {
        try {
            val note = withContext(Dispatchers.IO) { loadNoteForOpen(uri, relative) }
            if (note.uri?.let { documentAccess.hasWriteGrant(Uri.parse(it)) } == true) clearDocumentAccessFailure(uri.toString())
            if (!openRequests.isCurrent(request)) {
                // A newer open or a user tab action owns focus, but every file
                // the user requested still becomes an available tab.
                retainOpenedNote(note, activate = false)
                return@launch
            }
            val expectedActiveId = mutable.value.active.id
            var applied = false
            val accepted = performReaderBarrier(expectedActiveId) {
                retainOpenedNote(note, activate = openRequests.isCurrent(request))
                applied = true
            }
            if (!accepted || !applied) {
                if (!openRequests.isCurrent(request)) retainOpenedNote(note, activate = false)
                else readerBarrierFailed()
            }
        } catch (cancelled: kotlinx.coroutines.CancellationException) { throw cancelled }
        catch (error: Exception) { if (openRequests.isCurrent(request)) {
            if (isDocumentAccessFailure(error)) requestDocumentAccess(uri.toString(), mutable.value.tabs.firstOrNull { it.uri?.let { raw -> sameDocumentUri(raw, uri.toString()) } == true }, writing = false, explicit = true)
            else fail("Could not open note: ${error.message}")
        } }
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
        val target = documentAccess.resolve(Uri.parse(note.uri), writing = true)
        val staged = File(getApplication<Application>().cacheDir, "agent-portable-save-${UUID.randomUUID()}.smd.gz")
        var openedDirectory: String? = null
        try { withContext(Dispatchers.IO) {
            documentWrites.withLock {
                val latest = mutable.value.tabs.firstOrNull { it.id == id } ?: error("The note is no longer open")
                require(latest == note && agentContentRevision(latest.content).equals(expectedRevision, ignoreCase = true)) {
                    "The note changed since the supplied revision; no changes were saved"
                }
                val backup = resolver.openInputStream(target)?.use { readLimited(it, 120_000_000) }
                    ?: error("Cannot read the current portable note")
                val disk = backup.inputStream().use(media::openFmd)
                try {
                    require(portableSaveSnapshotMatches(note, expectedRevision, disk.markdown, assets, media.portableAssets(disk.directory))) {
                        "The portable note changed on disk; reopen it before saving"
                    }
                    staged.outputStream().use { media.writeFmd(it, note.content, assets) }
                    verifyExportHeader(staged, NativeExportFormat.PORTABLE_SMD)
                    val stagedBytes = staged.readBytes()
                    val opened = staged.inputStream().use(media::openFmd)
                    openedDirectory = opened.directory
                    val latestBytes = resolver.openInputStream(target)?.use { readLimited(it, 120_000_000) }
                        ?: error("Cannot recheck the portable note before saving")
                    require(latestBytes.contentEquals(backup)) { "The portable note changed on disk; no changes were saved" }
                    try {
                        resolver.openOutputStream(target, "wt")?.use { output -> staged.inputStream().use { it.copyTo(output) } }
                            ?: error("Cannot save the portable note")
                        withContext(Dispatchers.Main) {
                            val current = mutable.value.tabs.firstOrNull { it.id == id }
                            require(current == note && current?.let { agentContentRevision(it.content).equals(expectedRevision, ignoreCase = true) } == true) {
                                "The note changed while it was saving; the portable file was restored"
                            }
                            recordPortableBaseline(id, opened.directory)
                            change { state -> state.copy(tabs = state.tabs.map { if (it.id == id) it.copy(saved = note.content, assetsDirty = false, uri = target.toString(), assetDirectory = opened.directory) else it }, conflictedTabIds = state.conflictedTabIds - id, busy = false, message = "Portable note saved") }
                            mutable.value.tabs.firstOrNull { it.id == id }?.let(::remember)
                            openedDirectory = null
                        }
                    } catch (error: Exception) {
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
                            throw IllegalStateException("The portable save failed and the destination was not overwritten during recovery. Inspect it or reopen it from disk before editing.", rollbackError)
                        }
                        throw error
                    }
                } finally {
                    disk.directory.let { File(getApplication<Application>().filesDir, "portable-assets/$it").deleteRecursively() }
                }
            }
        } } finally {
            openedDirectory?.let { File(getApplication<Application>().filesDir, "portable-assets/$it").deleteRecursively() }
            staged.delete()
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
                    if (note.portable) media.writeFmd(output, note.content, assets)
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
    internal suspend fun writeAgentExport(content: String, assets: JSONObject, format: String, requestedFilename: String, rawPdfOptions: String): Pair<Uri, String> {
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
                NativeExportFormat.MARKDOWN -> withContext(Dispatchers.IO) {
                    staged.writeText(content, Charsets.UTF_8)
                }
            }
            val minimumSize = if (nativeFormat == NativeExportFormat.MARKDOWN) 0L else 1L
            require(staged.length() in minimumSize..(128L * 1024 * 1024)) { "Agent downloads are limited to 128 MiB per export" }
            val (uri, savedName) = withContext(Dispatchers.IO) {
                media.writeAgentDocument(filename, nativeFormat.mimeType, noteLocation()) { _, output ->
                    staged.inputStream().use { it.copyTo(output) }
                }
            }
            return uri to savedName
        } finally { staged.delete() }
    }
    private fun collectNativePortableAssets(note: Note): JSONObject {
        val assets = JSONObject(media.portableAssets(note.assetDirectory).toString())
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
        portableSaveAsNoteId = null
        portableForceOverwrite = false
        closeAfterSaveNoteId = null
    }
    fun beginSaveAs(noteId: String = mutable.value.active.id) {
        if (mutable.value.busy) return
        viewModelScope.launch {
            if (noteId != mutable.value.active.id && mutable.value.tabs.any { it.id == noteId }) {
                val prevActive = mutable.value.active.id
                if (!performReaderBarrier(prevActive) { change { it.copy(activeId = noteId) } }) {
                    readerBarrierFailed()
                    closeAfterSaveNoteId = null
                    return@launch
                }
            } else if (!performReaderBarrier(noteId) { }) {
                readerBarrierFailed()
                closeAfterSaveNoteId = null
                return@launch
            }
            val note = mutable.value.tabs.find { it.id == noteId } ?: return@launch
            val picker = requestSaveAs
            if (picker != null) picker(note) else closeAfterSaveNoteId = null
        }
    }
    fun completePortableSaveAs(uri: Uri, noteId: String = portableSaveAsNoteId ?: mutable.value.active.id) {
        portableOutput = uri
        portableDestinationIsNew = true
        portableSaveAsNoteId = noteId
        portableForceOverwrite = true
        if (requestPortableWrite?.invoke(false) == true) return
        if (readerStateIsNativeAuthoritative(noteId)) {
            viewModelScope.launch {
                busy(true)
                try {
                    val note = mutable.value.tabs.find { it.id == noteId } ?: error("The note is no longer open")
                    val assets = withContext(Dispatchers.IO) { collectNativePortableAssets(note) }
                    writePortable(note.id, note.content, assets, save = false, originalContent = note.content)
                } catch (error: Exception) {
                    portableSaveAsNoteId = null
                    closeAfterSaveNoteId = null
                    fail("Could not save portable note: ${error.message}")
                }
            }
        } else {
            portableSaveAsNoteId = null
            closeAfterSaveNoteId = null
            fail("The reader is not ready")
        }
    }
    fun saveManual(noteId: String = mutable.value.active.id, forceOverwrite: Boolean = false) {
        if (mutable.value.busy) return
        if (requestWriteAccessIfBlocked(noteId, explicit = true)) {
            closeAfterSaveNoteId = null
            return
        }
        viewModelScope.launch {
            if (noteId != mutable.value.active.id && mutable.value.tabs.any { it.id == noteId }) {
                val prevActive = mutable.value.active.id
                if (!performReaderBarrier(prevActive) { change { it.copy(activeId = noteId) } }) {
                    readerBarrierFailed()
                    closeAfterSaveNoteId = null
                    return@launch
                }
            } else if (!performReaderBarrier(noteId) { }) {
                readerBarrierFailed()
                closeAfterSaveNoteId = null
                return@launch
            }
            val note = mutable.value.tabs.find { it.id == noteId } ?: return@launch
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
                if (requestPortableWrite?.invoke(true) == true) return@launch
                if (readerStateIsNativeAuthoritative(note.id)) {
                    busy(true)
                    try {
                        val assets = withContext(Dispatchers.IO) { collectNativePortableAssets(note) }
                        writePortable(note.id, note.content, assets, save = true, originalContent = note.content)
                    } catch (error: Exception) {
                        portableForceOverwrite = false
                        closeAfterSaveNoteId = null
                        reportDocumentSaveFailure(note.id, error, "Could not save portable note: ${error.message}")
                    }
                } else {
                    portableForceOverwrite = false
                    closeAfterSaveNoteId = null
                    fail("The reader is not ready")
                }
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
    fun reloadFromDisk(id: String = mutable.value.active.id) = viewModelScope.launch {
        val note = mutable.value.tabs.find { it.id == id } ?: return@launch
        val rawUri = note.uri ?: return@launch
        try {
            val reloaded = withContext(Dispatchers.IO) {
                val target = documentAccess.resolve(Uri.parse(rawUri))
                resolver.openInputStream(target)?.use { stream ->
                    if (note.portable) {
                        val opened = media.openFmd(stream)
                        Note(id = note.id, name = note.name, uri = target.toString(), content = opened.markdown, saved = opened.markdown, relative = note.relative, assetDirectory = opened.directory, assetsDirty = false)
                    } else {
                        val text = readLimited(stream, 20_000_000).toString(Charsets.UTF_8)
                        Note(id = note.id, name = note.name, uri = target.toString(), content = text, saved = text, relative = note.relative, assetsDirty = false)
                    }
                } ?: error("Document permission is unavailable; choose it again")
            }
            autosavePending.remove(id)
            invalidateNoteAssets(id)
            readerEcho.remove(id)
            clearReaderEditProtocol(id)
            if (reloaded.portable) {
                recordPortableBaseline(id, reloaded.assetDirectory)
                if (note.assetDirectory != null && note.assetDirectory != reloaded.assetDirectory) {
                    withContext(Dispatchers.IO) { File(getApplication<Application>().filesDir, "portable-assets/${note.assetDirectory}").deleteRecursively() }
                }
            }
            change { state ->
                state.copy(
                    tabs = state.tabs.map { if (it.id == id) reloaded else it },
                    conflictedTabIds = state.conflictedTabIds - id,
                    pendingSaveConflictNoteId = state.pendingSaveConflictNoteId?.takeUnless { it == id },
                    message = "Reloaded from disk",
                )
            }
        } catch (error: Exception) {
            if (isDocumentAccessFailure(error)) requestDocumentAccess(rawUri, note, writing = false, explicit = true)
            else fail("Could not reload note: ${error.message}")
        }
    }
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
            if (expectedRevision != null && !java.security.MessageDigest.getInstance("SHA-256")
                    .digest(note.content.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }.equals(expectedRevision, ignoreCase = true)) {
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
            val (writtenTarget, savedName) = withContext(Dispatchers.IO) {
                require(!note.portable || uri != null) { "Use portable save for this SMD file" }
                val destination = if (uri != null) prepareExportDestination(target, NativeExportFormat.MARKDOWN, allowRename = true) else documentAccess.resolve(target, writing = true)
                if (guardDisk && !diskMatchesBaseline(destination, note)) throw ExternalConflictDetectedException()
                copyAttachments(note, destination)
                resolver.openOutputStream(destination, "wt")?.use { it.write(note.content.toByteArray()) } ?: error("Writing permission is unavailable; use Save as")
                documentAccess.persist(destination)
                destination to (resolveDisplayName(destination) ?: ExportFilename.suggestedName(note.name, NativeExportFormat.MARKDOWN))
            }
            savedPortableAssets.remove(note.id)
            autosavePending.remove(note.id)
            change { s -> s.copy(busy = false, tabs = s.tabs.map { if (it.id == note.id) it.copy(uri = writtenTarget.toString(), name = savedName, saved = note.content, assetsDirty = false, assetDirectory = null) else it }, conflictedTabIds = s.conflictedTabIds - note.id, pendingSaveConflictNoteId = s.pendingSaveConflictNoteId?.takeUnless { it == note.id }, message = "Saved") }
            mutable.value.tabs.find { it.id == note.id }?.let(::remember)
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
    fun setFolder(uri: Uri) = viewModelScope.launch {
        try {
            withContext(Dispatchers.IO) {
                val retained = persistDocumentGrants { resolver.takePersistableUriPermission(uri, it) }
                require(retained and Intent.FLAG_GRANT_READ_URI_PERMISSION != 0) { "Android did not grant folder read permission" }
            }
            workspaceLinks.invalidate()
            windowPrefs.edit().putBoolean("folderMigrated", true).putString("folder", uri.toString()).apply()
            change { it.copy(folder = uri.toString()) }; listFolder(uri, "")
        } catch (error: Exception) { fail("Could not open folder: ${error.message}") }
    }
    fun closeFolder() {
        workspaceLinks.invalidate()
        windowPrefs.edit().putBoolean("folderMigrated", true).remove("folder").apply()
        change { it.copy(folder = null, files = emptyList()) }
    }
    fun listFolder(uri: Uri, relative: String) = viewModelScope.launch {
        listedRelative=relative
        try {
            val entries = withContext(Dispatchers.IO) {
                var folder = DocumentFile.fromTreeUri(getApplication(), Uri.parse(mutable.value.folder ?: uri.toString())) ?: error("Choose the folder again to restore access")
                relative.split('/').filter { it.isNotEmpty() }.forEach { part -> folder = folder.findFile(part) ?: error("Folder disappeared") }
                folder.listFiles().mapNotNull { f -> val name = f.name ?: return@mapNotNull null; if (name.startsWith('.')) return@mapNotNull null; if (f.isDirectory || name.substringAfterLast('.').lowercase() in listOf("md", "smd", "markdown", "fmd")) FileEntry(name, f.uri.toString(), f.isDirectory, (if (relative.isEmpty()) "" else "$relative/") + name) else null }.sortedWith(compareByDescending<FileEntry> { it.directory }.thenBy { it.name.lowercase() })
            }
            mutable.value = mutable.value.copy(files = entries)
        } catch (error: Exception) { fail("Could not list folder: ${error.message}") }
    }
    private fun noteForAsset(document: String): Note = mutable.value.tabs.firstOrNull {
        it.id == document || it.uri?.let { uri -> sameDocumentUri(uri, document) } == true
    } ?: error("The asset's document is no longer open")

    /** Resolves only an already granted tree or an individually user-selected linked file. */
    private fun resolveLinkedAssetUri(note: Note, source: String): Uri {
        validateRelativeAssetSource(source)
        note.relative?.let { readerAssetPathParts(it.substringBeforeLast('/', ""), source) }
        linkedAssetUri(note, source)?.let { return it }
        val noteUri = note.uri?.let(Uri::parse) ?: throw LinkedAssetAccessRequiredException()
        val documentId = runCatching { DocumentsContract.getDocumentId(noteUri) }.getOrDefault("")
        val folderUri = resolver.persistedUriPermissions.filter { it.isReadPermission && DocumentsContract.isTreeUri(it.uri) && it.uri.authority == noteUri.authority }.mapNotNull { permission ->
            val root = runCatching { DocumentsContract.getTreeDocumentId(permission.uri) }.getOrNull() ?: return@mapNotNull null
            if (documentId.startsWith("$root/") || root.endsWith(':') && documentId.startsWith(root)) root to permission.uri else null
        }.maxByOrNull { it.first.length }?.second ?: throw LinkedAssetAccessRequiredException()
        val rootId = DocumentsContract.getTreeDocumentId(folderUri)
        val relative = documentId.takeIf { it.startsWith("$rootId/") }?.removePrefix("$rootId/")
            ?: documentId.takeIf { rootId.endsWith(':') && it.startsWith(rootId) }?.removePrefix(rootId)?.trimStart('/')
            ?: throw LinkedAssetAccessRequiredException()
        val parts = readerAssetPathParts(relative.substringBeforeLast('/', ""), source)
        return readerFolderIndex.resolve(resolver, note.id, folderUri, rootId, parts).uri
    }

    suspend fun textAsset(document: String, source: String): JSONObject = withContext(Dispatchers.IO) {
        require(Uri.decode(source).substringBefore('?').substringBefore('#').substringAfterLast('.').lowercase() in setOf("mmd", "mermaid")) { "Choose a Mermaid source file" }
        val uri = resolveLinkedAssetUri(noteForAsset(document), source)
        querySafAssetMetadata(resolver, uri)
        val bytes = resolver.openInputStream(uri)?.use { readLimited(it, 2_000_000) } ?: error("Cannot read diagram source")
        val text = Charsets.UTF_8.newDecoder().onMalformedInput(java.nio.charset.CodingErrorAction.REPORT)
            .decode(java.nio.ByteBuffer.wrap(bytes)).toString()
        JSONObject().put("text", text)
    }

    suspend fun asset(document: String, source: String): String = withContext(Dispatchers.IO) {
        val note = noteForAsset(document)
        media.localTarget(source, note.assetDirectory, note.uri, note.relative)?.let { return@withContext media.data(it.file) }
        val uri = resolveLinkedAssetUri(note, source)
        val meta = querySafAssetMetadata(resolver, uri)
        if (meta.size >= 0L) require(meta.size <= BoundedAssetInputStream.MAX_READER_ASSET_BYTES) { "Image exceeds 25 MB" }
        val bytes = resolver.openInputStream(uri)?.use { readLimited(it, 25_000_000) } ?: error("Cannot read image")
        val mime = media.imageMime(meta.displayName ?: Uri.decode(source).substringAfterLast('/'), meta.mimeType)
        "data:$mime;base64," + Base64.encodeToString(bytes, Base64.NO_WRAP)
    }

    internal fun resolveReaderAsset(document: String, source: String): Pair<String, ReaderAssetSource> {
        val note = noteForAsset(document)
        media.localTarget(source, note.assetDirectory, note.uri, note.relative)?.let { return note.id to media.readerAsset(it) }
        val uri = resolveLinkedAssetUri(note, source)
        val meta = querySafAssetMetadata(resolver, uri)
        if (meta.size >= 0L) require(meta.size <= BoundedAssetInputStream.MAX_READER_ASSET_BYTES) { "Image exceeds 25 MB" }
        val open = { resolver.openInputStream(uri) ?: error("Cannot read image") }
        val mime = media.imageMime(meta.displayName ?: Uri.decode(source).substringAfterLast('/'), meta.mimeType)
        val identity = "${note.id}|$source|$uri"
        val fingerprint = readerAssetFingerprint(identity, meta.size, meta.lastModified, open)
        val target = ReaderAssetTarget.SafDocument(uri, identity, note.uri, note.relative, note.assetDirectory)
        return note.id to ReaderAssetSource(mime, fingerprint, meta.size, open, target)
    }

    /** Revalidates open-note ownership and target metadata without repeating folder path walks. */
    internal fun openReaderAsset(capability: ReaderAssetCapability): OpenReaderAsset {
        val target = capability.target
            ?: return openReaderAsset(capability.noteId, capability.source, capability.fingerprint)
        val note = mutable.value.tabs.find { it.id == capability.noteId } ?: error("The image's document is no longer open")
        require(note.uri == target.noteUri && note.relative == target.noteRelative && note.assetDirectory == target.assetDirectory) {
            "The image's document moved; reload the document image"
        }
        return when (target) {
            is ReaderAssetTarget.LocalFile -> {
                val current = media.readerAsset(target)
                require(current.fingerprint == capability.fingerprint && current.mime == capability.mime) {
                    "The image changed; reload the document image"
                }
                require(current.size <= BoundedAssetInputStream.MAX_READER_ASSET_BYTES) { "Image exceeds 25 MB" }
                OpenReaderAsset(current.mime, current.fingerprint, current.open())
            }
            is ReaderAssetTarget.SafDocument -> {
                val meta = querySafAssetMetadata(resolver, target.uri) { IllegalStateException("Image not found") }
                if (meta.size >= 0L) require(meta.size <= BoundedAssetInputStream.MAX_READER_ASSET_BYTES) { "Image exceeds 25 MB" }
                val mime = media.imageMime(meta.displayName ?: Uri.decode(capability.source).substringAfterLast('/'), meta.mimeType)
                val open = { resolver.openInputStream(target.uri) ?: error("Cannot read image") }
                val currentFingerprint = readerAssetFingerprint(target.identity, meta.size, meta.lastModified, open)
                require(currentFingerprint == capability.fingerprint && mime == capability.mime) {
                    "The image changed; reload the document image"
                }
                OpenReaderAsset(mime, currentFingerprint, open())
            }
        }
    }

    /** Fallback when opening a capability created without a retained target. */
    internal fun openReaderAsset(noteId: String, source: String, expectedFingerprint: String): OpenReaderAsset {
        val note = mutable.value.tabs.find { it.id == noteId } ?: error("The image's document is no longer open")
        val (_, current) = resolveReaderAsset(note.id, source)
        require(current.fingerprint == expectedFingerprint) { "The image changed; reload the document image" }
        if (current.size >= 0L) require(current.size <= BoundedAssetInputStream.MAX_READER_ASSET_BYTES) { "Image exceeds 25 MB" }
        return OpenReaderAsset(current.mime, current.fingerprint, current.open())
    }

    /** Replace one image inside a saved portable note, without changing Markdown or other assets. */
    internal suspend fun replacePortableAsset(id: String, assetName: String, replacementPath: String, expectedRevision: String): JSONObject = withContext(Dispatchers.IO) {
        documentWrites.withLock {
            val note = mutable.value.tabs.find { it.id == id } ?: error("The document is no longer open")
            require(mutable.value.activeId == id) { "Select the target tab before replacing its image" }
            val revision = java.security.MessageDigest.getInstance("SHA-256").digest(note.content.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
            require(revision == expectedRevision) { "The document changed; read it again before replacing an image" }
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
                if (!backup.contentEquals(incomingBytes) && target.lastModified() == previousModified && previousModified > 0L) {
                    target.setLastModified(maxOf(System.currentTimeMillis(), previousModified + 1_000L))
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
            val revision = java.security.MessageDigest.getInstance("SHA-256").digest(note.content.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
            require(request.getString("expectedRevision") == revision) { "The document changed; read it again before using an asset" }
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
            require(Regex("[A-Za-z0-9_.-]{1,150}").matches(filename) && filename !in setOf(".", "..")) { "Asset name must be a simple filename" }
            val mime = request.getString("mimeType").substringBefore(';').lowercase()
            require(mime in setOf("image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/svg+xml")) { "Unsupported image type" }
            val extension = filename.substringAfterLast('.', "").lowercase()
            val normalizedName = if (extension.isEmpty()) "$filename.${when(mime) { "image/png" -> "png"; "image/jpeg" -> "jpg"; "image/gif" -> "gif"; "image/webp" -> "webp"; "image/avif" -> "avif"; else -> "svg" }}" else filename
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
            val uri = Uri.parse(note.uri)
            val backup = resolver.openInputStream(uri)?.use { readLimited(it, 120_000_000) } ?: error("Cannot read the current portable note")
            val diskNote = backup.inputStream().use(media::openFmd)
            val diskAssetsDir = diskNote.directory
            val stagedNote = File(getApplication<Application>().cacheDir, "agent-attach-${UUID.randomUUID()}.smd.gz")
            var writeAttempted = false
            var openedDir: String? = null
            fun rollbackWrite() {
                resolver.openOutputStream(uri, "wt")?.use { it.write(backup); it.flush() }
                    ?: error("The document changed during attachment and its previous bytes could not be restored")
                val restored = resolver.openInputStream(uri)?.use { readLimited(it, 120_000_000) }
                require(restored != null && restored.contentEquals(backup)) {
                    "The document changed during attachment and rollback could not be confirmed; reopen it from disk"
                }
                writeAttempted = false
            }
            try {
                require(diskNote.markdown == note.saved && sameAssets(currentAssets, media.portableAssets(diskAssetsDir))) {
                    "The portable note changed on disk; reopen it before attaching an image"
                }
                requireSameSnapshot()
                val updated = JSONObject(currentAssets.toString()).put(newKey, newData)
                stagedNote.outputStream().use { media.writeFmd(it, note.content, updated) }
                verifyExportHeader(stagedNote, NativeExportFormat.PORTABLE_SMD)
                openedDir = stagedNote.inputStream().use(media::openFmd).directory
                val currentDiskBytes = resolver.openInputStream(uri)?.use { readLimited(it, 120_000_000) }
                    ?: error("Cannot recheck the current portable note before saving")
                require(currentDiskBytes.contentEquals(backup)) { "The portable note changed on disk; no changes were saved" }
                requireSameSnapshot()
                writeAttempted = true
                try {
                    resolver.openOutputStream(uri, "wt")?.use { output -> stagedNote.inputStream().use { it.copyTo(output) } }
                        ?: error("Cannot save the updated portable note")
                } catch (error: Exception) { throw error }
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
                    rollbackWrite()
                    error("The document changed while the image was being attached; the new draft was preserved")
                }
                writeAttempted = false
                JSONObject().put("tabId", id).put("assetName", newKey).put("mimeType", mime)
                    .put("bytes", incomingBytes.size)
                    .put("sha256", java.security.MessageDigest.getInstance("SHA-256").digest(incomingBytes).joinToString("") { "%02x".format(it) })
                    .put("revision", revision).put("saved", true).put("changed", true)
            } catch (error: Exception) {
                if (writeAttempted) {
                    try { rollbackWrite() }
                    catch (rollbackError: Exception) {
                        throw IllegalStateException("The portable note may not match the latest draft; rollback could not be confirmed. Reopen it from disk before editing.", rollbackError)
                    }
                }
                throw error
            } finally {
                stagedNote.delete()
                File(getApplication<Application>().filesDir, "portable-assets/$diskAssetsDir").deleteRecursively()
                openedDir?.takeIf { it != mutable.value.tabs.find { tab -> tab.id == id }?.assetDirectory }
                    ?.let { File(getApplication<Application>().filesDir, "portable-assets/$it").deleteRecursively() }
            }
        }
    }

    private fun sameAssets(left: JSONObject, right: JSONObject): Boolean = portableAssetsMatch(left, right)
    suspend fun python(code: String): JSONObject = withContext(Dispatchers.IO) {
        pythonExecution.lock()
        val app = getApplication<Application>()
        val token = UUID.randomUUID().toString()
        val input = File(app.cacheDir, "python-$token.py")
        val output = File(app.cacheDir, "python-$token.json")
        var remote: android.os.Messenger? = null
        var connection: android.content.ServiceConnection? = null
        try {
            input.writeText(code)
            kotlinx.coroutines.withTimeout(115_000) {
                kotlinx.coroutines.suspendCancellableCoroutine<JSONObject> { continuation ->
                    val reply = android.os.Messenger(android.os.Handler(android.os.Looper.getMainLooper()) { message ->
                        if (continuation.isActive) {
                            if (message.what == 1) {
                                viewModelScope.launch(Dispatchers.IO) { try { val result = JSONObject(output.readText()); if (continuation.isActive) continuation.resumeWith(Result.success(result)) } catch (error: Exception) { if (continuation.isActive) continuation.resumeWith(Result.failure(error)) } }
                            } else continuation.resumeWith(Result.failure(IllegalStateException(message.data.getString("error") ?: "Python failed")))
                        }
                        true
                    })
                    val service = object : android.content.ServiceConnection {
                        override fun onServiceConnected(name: android.content.ComponentName, binder: android.os.IBinder) {
                            remote = android.os.Messenger(binder)
                            runCatching { remote!!.send(android.os.Message.obtain(null, 1).apply { replyTo = reply; data = android.os.Bundle().apply { putString("input", input.absolutePath); putString("output", output.absolutePath) } }) }.onFailure { if (continuation.isActive) continuation.resumeWith(Result.failure(it)) }
                        }
                        override fun onServiceDisconnected(name: android.content.ComponentName) { if (continuation.isActive) continuation.resumeWith(Result.failure(IllegalStateException("Python worker stopped"))) }
                    }
                    connection = service
                    if (!app.bindService(Intent(app, PythonWorkerService::class.java), service, android.content.Context.BIND_AUTO_CREATE)) continuation.resumeWith(Result.failure(IllegalStateException("Cannot start Python worker")))
                }
            }
        } finally {
            kotlinx.coroutines.withContext(kotlinx.coroutines.NonCancellable) {
                // Release worker resources before another window can bind. Even
                // cancellation must complete this barrier and unlock the queue.
                runCatching { remote?.send(android.os.Message.obtain(null, 2)) }
                remote?.binder?.let { binder -> kotlinx.coroutines.withTimeoutOrNull(2000) { while (binder.isBinderAlive) kotlinx.coroutines.delay(10) } }
                connection?.let { runCatching { app.unbindService(it) } }
                input.delete(); output.delete()
                pythonExecution.unlock()
            }
        }
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
    suspend fun writePortable(id: String, content: String, assets: JSONObject, save: Boolean, originalContent: String) {
        var closeTargetId: String? = null
        withContext(Dispatchers.IO) { documentWrites.withLock {
            val rebindId = if (!save) portableSaveAsNoteId else null
            val effectiveId = rebindId ?: id
            val note = mutable.value.tabs.find { it.id == effectiveId } ?: error("The note is no longer open")
            val target = if (save) note.uri?.let { documentAccess.resolve(Uri.parse(it), writing = true) } else portableOutput
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
            val destination = if (save) target else prepareExportDestination(target, NativeExportFormat.PORTABLE_SMD, allowRename = portableDestinationIsNew)
            val staged = File(getApplication<Application>().cacheDir, "fmd-${UUID.randomUUID()}.tmp")
            try {
                staged.outputStream().use { media.writeFmd(it, content, assets) }
                verifyExportHeader(staged, NativeExportFormat.PORTABLE_SMD)
                // Extract assets independently so a saved draft can immediately resolve
                // new portable references without carrying binary data in its state.
                val rebinding = save || rebindId != null
                val opened = if (rebinding) staged.inputStream().use(media::openFmd) else null
                resolver.openOutputStream(destination, "wt")?.use { output -> staged.inputStream().use { it.copyTo(output) } } ?: error("Cannot write portable file")
                documentAccess.persist(destination)
                val savedName = if (rebindId != null) {
                    resolveDisplayName(destination) ?: ExportFilename.suggestedName(note.name, NativeExportFormat.PORTABLE_SMD)
                } else note.name
                withContext(Dispatchers.Main) {
                    if (rebinding) {
                        portableOutput = null
                        portableDestinationIsNew = false
                        portableSaveAsNoteId = null
                        autosavePending.remove(effectiveId)
                        recordPortableBaseline(effectiveId, opened!!.directory)
                        change { s ->
                            s.copy(
                                tabs = s.tabs.map {
                                    if (it.id == effectiveId) it.copy(
                                        name = if (rebindId != null) savedName else it.name,
                                        content = if (it.content == originalContent) content else it.content,
                                        saved = content,
                                        assetsDirty = false,
                                        uri = destination.toString(),
                                        assetDirectory = opened.directory,
                                    ) else it
                                },
                                conflictedTabIds = s.conflictedTabIds - effectiveId,
                                pendingSaveConflictNoteId = s.pendingSaveConflictNoteId?.takeUnless { it == effectiveId },
                                busy = false,
                                message = if (rebindId != null) "Saved" else "Portable note saved",
                            )
                        }
                        mutable.value.tabs.find { it.id == effectiveId }?.let(::remember)
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
            } finally { staged.delete() }
        } }
        closeTargetId?.let { close(it) }
    }
    fun importDropped(uris: List<Uri>, id: String, result: (JSONArray?) -> Unit) = viewModelScope.launch {
        try { val images = withContext(Dispatchers.IO) { media.importUris(uris) }; markAssetsDirty(id); if (mutable.value.active.id == id) result(images) else { val insertion = (0 until images.length()).joinToString("\n\n") { i -> val image = images.getJSONObject(i); "![${image.getString("alt").replace("[", "\\[").replace("]", "\\]")}](<${image.getString("source")}>)" }; val note = mutable.value.tabs.find { it.id == id }; if (note != null) edit(id, note.content + "\n\n" + insertion + "\n"); result(null) } }
        catch (error: Exception) { fail("Could not insert image: ${error.message}"); result(null) }
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
}
internal fun markdownImageSourcesJson(markdown: String): String = try {
    PdfEngine.imageSources(markdown)
} catch (_: UnsatisfiedLinkError) {
    fallbackMarkdownImageSourcesJson(markdown)
} catch (_: NoClassDefFoundError) {
    fallbackMarkdownImageSourcesJson(markdown)
}

private fun fallbackMarkdownImageSourcesJson(markdown: String): String {
    val result = JSONArray()
    val pattern = Regex("""!\[(?:\\.|[^\]])*]\(\s*(?:<([^>\r\n]+)>|([^\s)\r\n]+))(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)""")
    pattern.findAll(markdown).forEach { match ->
        val source = (match.groupValues[1].ifEmpty { match.groupValues[2] }).trim()
        if (source.isNotEmpty()) result.put(source)
    }
    return result.toString()
}

object PdfEngine {
    init { System.loadLibrary("smd_core") }
    @JvmStatic external fun export(markdown: String, options: String, assets: String, output: String): String
    @JvmStatic external fun imageSources(markdown: String): String
    @JvmStatic external fun fontFamilies(path: String): String
    @JvmStatic external fun validateTheme(input:String):String
}
