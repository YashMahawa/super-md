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

data class Note(val id: String = UUID.randomUUID().toString(), val name: String = "Untitled.md", val uri: String? = null, val content: String = "", val saved: String = "", val relative: String? = null, val assetDirectory: String? = null) { val dirty get() = content != saved; val portable get() = assetDirectory != null }
internal fun matchesAssetWriteSnapshot(current: Note?, activeId: String, expected: Note, requireActive: Boolean = true): Boolean =
    current != null && current.id == expected.id && (!requireActive || activeId == expected.id)
        && current.content == expected.content && current.saved == expected.saved
        && current.uri == expected.uri && current.assetDirectory == expected.assetDirectory && current.portable == expected.portable
data class RecentNote(val name: String, val uri: String, val relative: String? = null, val pinned:Boolean=false)
internal fun orderedRecents(notes:List<RecentNote>)=notes.distinctBy {it.uri}.sortedByDescending {it.pinned}.take(10)
private fun renamedRelative(relative:String?,name:String)=relative?.let {val parent=it.substringBeforeLast('/',"");if(parent.isEmpty())name else "$parent/$name"}
data class FileEntry(val name: String, val uri: String, val directory: Boolean, val relative: String)
data class OutlineHeading(val id: String, val title: String, val level: Int, val offset: Int)
data class StudioState(val latexAutofix:Boolean=false, val selectionAssistant:String="chatgpt", val centerLock:Boolean=true, val customTheme:String="", val patternKind:String="", val patternOpacity:Float=-1f, val patternSize:Float=0f, val patternSpacing:Float=0f, val restorePosition:Boolean=true, val fullDocumentAccessibility:Boolean=false, val startup:String="restore", val imageAppearance:String="original", val svgAppearance:String="original", val imageContrast:Float=1.25f, val spellCheck:Boolean = false, val grammarCheck:Boolean = false, val accent: String = "system", val widthPercent: Float = 100f, val lineHeight: Float = 1.65f, val autosave: Boolean = true, val customFonts: List<String> = emptyList(), val readerOverlay: Boolean = false, val zoomCommand: Long = 0, val tabs: List<Note> = listOf(Note(name = "Welcome.md", content = sample, saved = sample)), val closedTabs: List<Note> = emptyList(), val activeId: String = "", val mode: String = "live", val fullscreen: Boolean = false, val normalZoom: Float = 100f, val fullscreenZoom: Float = 100f, val theme: String = "system", val fullscreenTheme: String = "black", val motion: Boolean = true, val font: String = "Manrope", val size: Float = 15f, val folder: String? = null, val files: List<FileEntry> = emptyList(), val busy: Boolean = false, val message: String? = null, val error: String? = null, val welcomed: Boolean = false, val pdf: String = "{\"pageSize\":\"a4\",\"margin\":18,\"fontSize\":10.5,\"lineHeight\":1.55,\"paragraphSpacing\":1.35,\"fontFamily\":\"Manrope\",\"pageNumbers\":true}", val storageReport: StorageReport? = null, val storageScanning: Boolean = false) {
    val active get() = tabs.find { it.id == activeId } ?: tabs.first()
    val zoom get() = if (fullscreen) fullscreenZoom else normalZoom
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
    private val windowPrefs = app.getSharedPreferences("studio-window-$workspaceKey", 0)
    val media = MediaStorage(app)
    val fonts = FontLibrary(app)
    val updates = AppUpdates(app)
    private fun loadRecent()=runCatching { val list=JSONArray(prefs.getString("recent","[]"));orderedRecents((0 until minOf(list.length(),100)).map {i->val n=list.getJSONObject(i);RecentNote(n.getString("name"),n.getString("uri"),n.optString("relative").takeIf {it.isNotBlank()},n.optBoolean("pinned"))}) }.getOrDefault(emptyList())
    private val recentMutable = MutableStateFlow(loadRecent())
    val recent = recentMutable.asStateFlow()
    var requestPortable: (() -> Unit)? = null
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
    private fun readerBarrierFailed() {
        mutable.value = mutable.value.copy(message = "The reader could not confirm its latest edits. The action was canceled; keep the note open and try again.")
    }
    private fun remember(note: Note) {
        val uri = note.uri ?: return
        storeRecent(listOf(RecentNote(note.name,uri,note.relative,recentMutable.value.any {it.uri==uri&&it.pinned}))+recentMutable.value.filter {it.uri!=uri})
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
        override fun onChange(selfChange:Boolean){refreshMetadata();refreshExternal()}
        override fun onChange(selfChange:Boolean,uri:Uri?){refreshMetadata();if(uri==null||uri.toString()==mutable.value.active.uri)refreshExternal()}
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
    init { prefs.registerOnSharedPreferenceChangeListener(preferencesChanged);observeActive();observeCustomTheme();migrateLegacyClosedNotes();if(workspaceKey=="main")viewModelScope.launch{updates.restore();if(!BuildConfig.DEBUG && updates.state.value.checkOnOpen){kotlinx.coroutines.delay(6000);updates.check()}} }
    override fun onCleared() { viewModelRetired.set(true); recoveryWriter.closeAfterLatest(mutable.value); prefs.unregisterOnSharedPreferenceChangeListener(preferencesChanged);resolver.unregisterContentObserver(documentObserver);resolver.unregisterContentObserver(themeObserver); super.onCleared() }
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
    private var autosaveJob: Job? = null
    private val autosavePending = mutableSetOf<String>()
    private fun scheduleAutosave(id: String) {
        if (!mutable.value.autosave) return
        autosavePending.add(id)
        if (autosaveJob?.isActive == true) return
        autosaveJob = viewModelScope.launch {
            while (autosavePending.isNotEmpty()) {
                delay(900)
                val next=autosavePending.first();autosavePending.remove(next)
                var note=mutable.value.tabs.find { it.id==next && it.uri!=null && it.dirty } ?: continue
                if (!mutable.value.autosave) continue
                try {
                    if (mutable.value.active.id == note.id) {
                        if (!performReaderBarrier(note.id) { }) {
                            mutable.value = mutable.value.copy(message = "Autosave paused because the reader could not confirm its latest edits.")
                            continue
                        }
                        note = mutable.value.tabs.find { it.id == next && it.uri != null && it.dirty } ?: continue
                    }
                    // Do not cancel an in-flight write when another keystroke or
                    // window transition arrives. Recovery remains an independent stream.
                    withContext(kotlinx.coroutines.NonCancellable) {
                        documentWrites.withLock {
                        if (closingNoteIds.contains(note.id) || mutable.value.tabs.none {
                                it.id == note.id && it.uri == note.uri && it.content == note.content
                            }) return@withLock
                        withContext(Dispatchers.IO) {
                            val target=Uri.parse(note.uri)
                            val previous=resolver.openInputStream(target)?.use { if(note.portable) media.portableMarkdown(it) else readLimited(it,20_000_000).toString(Charsets.UTF_8).removePrefix("\uFEFF") } ?: error("Writing permission is unavailable")
                            require(previous==note.saved) {"This file changed outside Super MD. Use Save as to keep both versions; your draft is safe."}
                            val staged=File(getApplication<Application>().cacheDir,"autosave-${UUID.randomUUID()}.tmp")
                            try {
                                staged.outputStream().use { if(note.portable) media.writeLocalPortable(it,note.content,note.assetDirectory) else it.write(note.content.toByteArray()) }
                                if (!note.portable) copyAttachments(note,target)
                                resolver.openOutputStream(target,"wt")?.use { staged.inputStream().use { input->input.copyTo(it) } } ?: error("Cannot write this document")
                            } finally {staged.delete()}
                        }
                        change { s->s.copy(tabs=s.tabs.map { if(it.id==note.id)it.copy(saved=note.content) else it }) }
                        if(mutable.value.tabs.any {it.id==note.id && it.dirty})autosavePending.add(note.id)
                        }
                    }
                } catch(error:Exception) {fail("Autosave paused: ${error.message}")}
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
        if (mutable.value.busy || format !in listOf("pdf", "smd", "md")) return false
        val folder = File(getApplication<Application>().cacheDir, "share/${UUID.randomUUID()}").apply { mkdirs() }
        val exportFormat = NativeExportFormat.fromShareFormat(format)
        val filename = ExportFilename.suggestedName(mutable.value.active.name, exportFormat)
        val file = File(folder, filename)
        shareFile = file
        busy(true)
        when (format) {
            "pdf" -> { outputUri = Uri.fromFile(file); pdfDestinationIsNew = false }
            "smd" -> { portableOutput = Uri.fromFile(file); portableDestinationIsNew = false }
        }
        return true
    }
    suspend fun shareMarkdown(content: String) {
        val file = shareFile?.takeIf { it.extension == "md" } ?: error("Choose Markdown in Share first")
        withContext(Dispatchers.IO) { file.writeText(content) }
        finishShare(Uri.fromFile(file))
    }
    private fun finishShare(target: Uri): Boolean {
        val file = shareFile ?: return false
        if (target != Uri.fromFile(file)) return false
        val app = getApplication<Application>()
        val uri = androidx.core.content.FileProvider.getUriForFile(app, "${app.packageName}.share", file)
        val format = NativeExportFormat.fromShareFormat(file.extension)
        val mime = format.mimeType
        val send = Intent(Intent.ACTION_SEND).setType(mime).putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION).apply { clipData = android.content.ClipData.newUri(app.contentResolver, file.name, uri) }
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

    private fun change(block: (StudioState) -> StudioState) { mutable.value = block(mutable.value);observeActive(); schedulePersist() }
    private fun restore(): StudioState {
        var s = StudioState(theme = prefs.getString("theme", "system")!!, fullscreenTheme = prefs.getString("fullTheme", "black")!!, motion = prefs.getBoolean("motion", true), welcomed = prefs.getBoolean("welcomed", false), font = prefs.getString("font", "Manrope")!!, size = prefs.getFloat("size", 15f), folder = windowPrefs.getString("folder", if (workspaceKey == "main" && !windowPrefs.getBoolean("folderMigrated", false)) prefs.getString("folder", null) else null), pdf = prefs.getString("pdf", null) ?: StudioState().pdf)
        s = s.copy(spellCheck=prefs.getBoolean("spellCheck",false),grammarCheck=prefs.getBoolean("grammarCheck",false),accent = prefs.getString("accent","system")!!, widthPercent = prefs.getFloat("widthPercent",100f),lineHeight = prefs.getFloat("lineHeight",1.65f),autosave = prefs.getBoolean("autosave",true),customFonts = fonts.families)
        try {
            if (snapshot.isFile) s=snapshot.bufferedReader().use {NoteRecovery.read(it,s)}
        } catch (_: Exception) { s = s.copy(error = "The recovery snapshot could not be read. Your original files are untouched.") }
        s=readingPreferences(s).copy(customTheme=prefs.getString("customTheme","")?:"",selectionAssistant=SelectionActions.provider(prefs.getString("selectionAssistant",null)),latexAutofix=prefs.getBoolean("latexAutofix",false))
        if(s.welcomed) {
            val kept=s.tabs.filter {it.dirty || s.startup=="restore"&&!(it.uri==null&&it.name=="Welcome.md")}
            val tabs=if(s.startup=="new")listOf(Note())+kept else kept.ifEmpty {listOf(Note())}
            s=s.copy(tabs=tabs,activeId=if(s.startup=="new")tabs.first().id else s.activeId)
        }
        val activeIds=s.tabs.map {it.id}.toSet()
        val indexResult=runCatching {closedNoteStore.loadIndexStrict()}
        if(indexResult.isSuccess)closedNoteIndexError=null else closedNoteIndexError=indexResult.exceptionOrNull()?.message ?: "invalid closed-note index"
        val refs=indexResult.getOrDefault(emptyList()).filterNot {it.id in activeIds}.take(ClosedNoteStore.LIMIT)
        closedNoteRefs=refs
        return s.copy(closedTabs=closedNotesForRestore(refs,s.closedTabs,activeIds,indexResult.isSuccess),
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
    fun newNote() {
        openRequests.invalidate()
        val expected = mutable.value.active.id
        viewModelScope.launch {
            val note = Note()
            if (!performReaderBarrier(expected) { change { it.copy(tabs = it.tabs + note, activeId = note.id) } }) readerBarrierFailed()
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
        val note=mutable.value.active
        if(note.uri==null || note.dirty || note.portable)return
        refreshJob=viewModelScope.launch {
            delay(200)
            val text=runCatching{withContext(Dispatchers.IO){resolver.openInputStream(Uri.parse(note.uri))?.use{readLimited(it,20_000_000).toString(Charsets.UTF_8)}}}.getOrNull() ?: return@launch
            if(text==note.content)return@launch
            change {s->s.copy(tabs=s.tabs.map{if(it.id==note.id && it.content==note.content && !it.dirty)it.copy(content=text,saved=text)else it})}
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
    fun close(id: String) {
        openRequests.invalidate()
        viewModelScope.launch {
            var preserve = false
            val activeId = mutable.value.active.id
            val accepted = performReaderBarrier(activeId) {
                val note = mutable.value.tabs.find { it.id == id } ?: return@performReaderBarrier
                if (!closingNoteIds.add(id)) return@performReaderBarrier
                if (note.uri == null && note.content.isBlank() && note.assetDirectory == null) {
                    readerEcho.remove(id)
                    clearReaderEditProtocol(id)
                    change { state ->
                        val remaining = state.tabs.filterNot { it.id == id }
                        val next = remaining.ifEmpty { listOf(Note()) }
                        state.copy(tabs = next, activeId = if (state.active.id == id) next.first().id else state.activeId,
                            message = "Empty tab discarded")
                    }
                    closingNoteIds.remove(id)
                } else preserve = true
            }
            if (!accepted) {
                readerBarrierFailed()
                return@launch
            }
            if (preserve) closeAfterReaderBarrier(id)
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
            change { state ->
                val remaining = state.tabs.filterNot { it.id == id }
                val next = remaining.ifEmpty { listOf(Note()) }
                state.copy(tabs = next, closedTabs = (listOf(reference.placeholder()) + state.closedTabs.filterNot { it.id == id }).take(ClosedNoteStore.LIMIT),
                    activeId = if (state.active.id == id) next.first().id else state.activeId,
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
            val accepted = performReaderBarrier(expectedActiveId) {
                if(mutable.value.closedTabs.none {it.id==referenceNote.id})return@performReaderBarrier
                readerEcho.remove(note.id)
                closedNoteRefs=closedNoteRefs.filterNot {it.id==note.id}
                change { state ->
                    val existing=state.tabs.find {it.id==note.id}
                    val tabs=if(existing==null)state.tabs+note else state.tabs
                    state.copy(tabs=tabs,closedTabs=state.closedTabs.dropWhile {it.id==referenceNote.id}.filterNot {it.id==referenceNote.id},activeId=note.id)
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
        media.saveAgentMedia(args, noteLocation())
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
    private fun retainOpenedNote(note: Note, activate: Boolean) {
        val existing = mutable.value.tabs.find { it.uri == note.uri }
        change { state ->
            state.copy(
                tabs = if (existing != null) state.tabs else state.tabs + note,
                activeId = if (activate) existing?.id ?: note.id else state.activeId,
            )
        }
        remember(existing ?: note)
    }
    fun open(uri: Uri, relative: String? = null): Job {
        val request = openRequests.begin()
        return viewModelScope.launch {
        try {
            val note = withContext(Dispatchers.IO) {
                val existing = mutable.value.tabs.find { it.uri == uri.toString() }; if (existing != null) return@withContext existing
                try { resolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION) } catch (_: SecurityException) { }
                val name = DocumentFile.fromSingleUri(getApplication(), uri)?.name ?: "Note.md"
                resolver.openInputStream(uri)?.use { stream ->
                    val buffered = stream.buffered()
                    buffered.mark(65536)
                    val prefix = ByteArray(32768); val count = buffered.read(prefix); buffered.reset()
                    val header = if (count > 0) String(prefix, 0, count, Charsets.UTF_8).trimStart('\uFEFF', ' ', '\n', '\r', '\t') else ""
                    val portable = portableGzipHeader(prefix.copyOfRange(0, maxOf(count, 0))) || portableEnvelopeHeader(header)
                    if (portable) { val opened = media.openFmd(buffered); Note(name = name, uri = uri.toString(), content = opened.markdown, saved = opened.markdown, relative = relative, assetDirectory = opened.directory) }
                    else { val content = readLimited(buffered, 20_000_000).toString(Charsets.UTF_8); Note(name = name, uri = uri.toString(), content = content, saved = content, relative = relative) }
                } ?: error("Document permission is unavailable; choose it again")
            }
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
        catch (error: Exception) { if (openRequests.isCurrent(request)) fail("Could not open note: ${error.message}") }
        }
    }
    fun save(uri: Uri? = null) = viewModelScope.launch {
        val requestedNoteId = mutable.value.active.id
        // Save As keeps its explicit destination, while ordinary Save resolves
        // the current URI only after it owns the document-write lock.
        if (uri == null && mutable.value.active.uri == null) return@launch
        if (!performReaderBarrier(requestedNoteId) { }) {
            readerBarrierFailed()
            return@launch
        }
        busy(true)
        try {
            documentWrites.withLock {
            val note = mutable.value.tabs.find { it.id == requestedNoteId }
            if (closingNoteIds.contains(requestedNoteId) || note == null) {
                mutable.value = mutable.value.copy(busy = false, message = "Save canceled because the note was closed before the write began.")
                return@withLock
            }
            val target = uri ?: note.uri?.let(Uri::parse)
            if (target == null) {
                mutable.value = mutable.value.copy(busy = false, message = "Save canceled because the note no longer has a destination.")
                return@withLock
            }
            val (writtenTarget, savedName) = withContext(Dispatchers.IO) {
                require(!note.portable || uri != null) { "Use portable save for this SMD file" }
                val destination = if (uri != null) prepareExportDestination(target, NativeExportFormat.MARKDOWN, allowRename = true) else target
                copyAttachments(note, destination)
                resolver.openOutputStream(destination, "wt")?.use { it.write(note.content.toByteArray()) } ?: error("Writing permission is unavailable; use Save as")
                destination to (DocumentFile.fromSingleUri(getApplication(), destination)?.name ?: note.name)
            }
            change { s -> s.copy(busy = false, tabs = s.tabs.map { if (it.id == note.id) it.copy(uri = writtenTarget.toString(), name = savedName, saved = note.content, assetDirectory = null) else it }, message = "Saved") }
            mutable.value.tabs.find { it.id == note.id }?.let(::remember)
            }
        } catch (error: Exception) { fail("Could not save note: ${error.message}") }
    }
    fun setFolder(uri: Uri) = viewModelScope.launch {
        try {
            withContext(Dispatchers.IO) { resolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION) }
            windowPrefs.edit().putBoolean("folderMigrated", true).putString("folder", uri.toString()).apply()
            change { it.copy(folder = uri.toString()) }; listFolder(uri, "")
        } catch (error: Exception) { fail("Could not open folder: ${error.message}") }
    }
    fun closeFolder() {
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
    suspend fun asset(document: String, source: String): String = withContext(Dispatchers.IO) {
        val note = mutable.value.tabs.find { it.uri == document || it.id == document } ?: error("The image's document is no longer open")
        media.local(source, note.assetDirectory)?.let { return@withContext media.data(it) }
        val documentId = runCatching { DocumentsContract.getDocumentId(Uri.parse(document)) }.getOrDefault("")
        // A recently reopened note may belong to a different previously granted
        // folder. Prefer its matching tree grant, not the currently browsed tree.
        val folderUri = resolver.persistedUriPermissions.filter { it.isReadPermission && DocumentsContract.isTreeUri(it.uri) && it.uri.authority == Uri.parse(document).authority }.mapNotNull { permission ->
            val root = runCatching { DocumentsContract.getTreeDocumentId(permission.uri) }.getOrNull() ?: return@mapNotNull null
            if (documentId.startsWith("$root/") || root.endsWith(':') && documentId.startsWith(root)) root to permission.uri else null
        }.maxByOrNull { it.first.length }?.second ?: mutable.value.folder?.let(Uri::parse) ?: error("Open the note's containing folder to grant access to relative images")
        var file = DocumentFile.fromTreeUri(getApplication(), folderUri) ?: error("Restore folder access by opening it again")
        val rootId = DocumentsContract.getTreeDocumentId(folderUri)
        val relative = documentId.takeIf { it.startsWith("$rootId/") }?.removePrefix("$rootId/") ?: documentId.takeIf { rootId.endsWith(':') && it.startsWith(rootId) }?.removePrefix(rootId)?.trimStart('/') ?: note.relative
        val parent = relative?.substringBeforeLast('/', "") ?: ""
        val parts = (if (parent.isEmpty()) "" else "$parent/") + Uri.decode(source)
        val stack = ArrayDeque<String>()
        parts.replace('\\', '/').split('/').forEach { part -> when(part) { "", "." -> Unit; ".." -> if (stack.isEmpty()) error("Image escapes the selected folder") else stack.removeLast(); else -> stack.addLast(part) } }
        stack.forEach { part -> file = file.findFile(part) ?: error("Image not found: $source") }
        val bytes = resolver.openInputStream(file.uri)?.use { readLimited(it, 25_000_000) } ?: error("Cannot read image")
        val mime = resolver.getType(file.uri)?.takeIf { it.startsWith("image/") } ?: when(file.name?.substringAfterLast('.')?.lowercase()) { "svg" -> "image/svg+xml"; "jpg", "jpeg" -> "image/jpeg"; else -> "image/png" }
        "data:$mime;base64," + Base64.encodeToString(bytes, Base64.NO_WRAP)
    }

    /** Resolves only a note still open in this workspace, using its existing SAF grant. */
    internal fun resolveReaderAsset(document: String, source: String): Pair<String, ReaderAssetSource> {
        val note = mutable.value.tabs.find { it.uri == document || it.id == document } ?: error("The image's document is no longer open")
        media.local(source, note.assetDirectory)?.let { return note.id to media.readerAsset(it) }
        val noteUri = note.uri?.let(Uri::parse) ?: error("Save this document before loading relative images")
        val documentId = runCatching { DocumentsContract.getDocumentId(noteUri) }.getOrDefault("")
        // Prefer the matching persisted tree grant for this note, not merely
        // whichever folder the user most recently browsed.
        val folderUri = resolver.persistedUriPermissions.filter { it.isReadPermission && DocumentsContract.isTreeUri(it.uri) && it.uri.authority == noteUri.authority }.mapNotNull { permission ->
            val root = runCatching { DocumentsContract.getTreeDocumentId(permission.uri) }.getOrNull() ?: return@mapNotNull null
            if (documentId.startsWith("$root/") || root.endsWith(':') && documentId.startsWith(root)) root to permission.uri else null
        }.maxByOrNull { it.first.length }?.second ?: mutable.value.folder?.let(Uri::parse) ?: error("Open the note's containing folder to grant access to relative images")
        var file = DocumentFile.fromTreeUri(getApplication(), folderUri) ?: error("Restore folder access by opening it again")
        val rootId = DocumentsContract.getTreeDocumentId(folderUri)
        val relative = documentId.takeIf { it.startsWith("$rootId/") }?.removePrefix("$rootId/") ?: documentId.takeIf { rootId.endsWith(':') && it.startsWith(rootId) }?.removePrefix(rootId)?.trimStart('/') ?: note.relative
        val parent = relative?.substringBeforeLast('/', "") ?: ""
        val parts = readerAssetPathParts(parent, source)
        parts.forEach { part -> file = file.findFile(part) ?: error("Image not found: $source") }
        require(file.isFile) { "Image not found: $source" }
        val size = file.length()
        require(size <= BoundedAssetInputStream.MAX_READER_ASSET_BYTES) { "Image exceeds 25 MB" }
        val uri = file.uri
        val open = { resolver.openInputStream(uri) ?: error("Cannot read image") }
        val mime = media.imageMime(file.name ?: source.substringAfterLast('/'), resolver.getType(uri))
        val fingerprint = readerAssetFingerprint("${note.id}|$source|$uri", size, file.lastModified(), open)
        return note.id to ReaderAssetSource(mime, fingerprint, size, open)
    }

    /** Revalidates open-note ownership and the source fingerprint on every stream request. */
    internal fun openReaderAsset(noteId: String, source: String, expectedFingerprint: String): OpenReaderAsset {
        val note = mutable.value.tabs.find { it.id == noteId } ?: error("The image's document is no longer open")
        val (_, current) = resolveReaderAsset(note.id, source)
        require(current.fingerprint == expectedFingerprint) { "The image changed; reload the document image" }
        require(current.size <= BoundedAssetInputStream.MAX_READER_ASSET_BYTES) { "Image exceeds 25 MB" }
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
            val sourceList = JSONArray(PdfEngine.imageSources(note.content))
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
                val sources = JSONArray(PdfEngine.imageSources(note.content))
                (0 until sources.length()).map { sources.getString(it) }.distinct().filter(media::validKey).forEach { source ->
                    val currentFile = media.local(source, note.assetDirectory) ?: error("An open image is missing: $source")
                    val diskFile = media.local(source, disk.directory) ?: error("The saved note no longer contains image $source")
                    require(currentFile.readBytes().contentEquals(diskFile.readBytes())) { "The portable note's images changed on disk; reopen it before replacement" }
                }
                require((media.local(resolvedAssetName, disk.directory) ?: error("The saved note no longer contains this image")).readBytes().contentEquals(backup)) {
                    "The portable note's image changed on disk; reopen it before replacement"
                }
                val stagedAssetStream = temporaryAsset.outputStream()
                stagedAssetStream.use { it.write(incomingBytes); it.fd.sync() }
                check(target.renameTo(backupAsset)) { "Could not safely stage the current image" }
                check(temporaryAsset.renameTo(target)) { backupAsset.renameTo(target); error("Could not stage the replacement image") }
                replaced = true
                stagedNote.outputStream().use { media.writeLocalPortable(it, note.content, note.assetDirectory) }
                verifyExportHeader(stagedNote, NativeExportFormat.PORTABLE_SMD)
                resolver.openOutputStream(noteUri, "wt")?.use { output -> stagedNote.inputStream().use { it.copyTo(output) } }
                    ?: error("Cannot save the updated portable note")
                withContext(Dispatchers.Main) {
                    change { state -> state.copy(tabs = state.tabs.map { if (it.id == id) it.copy(saved = it.content) else it }, busy = false, message = "Portable image replaced") }
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
                    change { state -> state.copy(tabs = state.tabs.map {
                        if (it.id == id && it.content == writtenSource && it.uri == note.uri && it.assetDirectory == directory)
                            it.copy(saved = writtenSource, assetDirectory = writtenDirectory) else it
                    }, busy = false, message = "Portable image attached") }
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

    private fun sameAssets(left: JSONObject, right: JSONObject): Boolean {
        if (left.length() != right.length()) return false
        return left.keys().asSequence().all { right.has(it) && left.getString(it) == right.getString(it) }
    }
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
    private fun copyAttachments(note: Note, destination: Uri) {
        val sources = JSONArray(PdfEngine.imageSources(note.content))
        val local = (0 until sources.length()).map { sources.getString(it) }.distinct().mapNotNull { source -> media.local(source, note.assetDirectory)?.let { source to it } }
        if (local.isEmpty()) return
        val tree = mutable.value.folder?.let(Uri::parse) ?: error("Images need a containing folder permission. Open that folder, or export a single portable .smd file instead.")
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
    }
    var portableOutput: Uri? = null
    suspend fun writePortable(id: String, content: String, assets: JSONObject, save: Boolean, originalContent: String) = withContext(Dispatchers.IO) { documentWrites.withLock {
        val note = mutable.value.tabs.find { it.id == id } ?: error("The note is no longer open")
        val target = if (save) note.uri?.let(Uri::parse) else portableOutput
        require(target != null) { "Choose a portable file destination" }
        val destination = if (save) target else prepareExportDestination(target, NativeExportFormat.PORTABLE_SMD, allowRename = portableDestinationIsNew)
        val staged = File(getApplication<Application>().cacheDir, "fmd-${UUID.randomUUID()}.tmp")
        try {
            staged.outputStream().use { media.writeFmd(it, content, assets) }
            verifyExportHeader(staged, NativeExportFormat.PORTABLE_SMD)
            // Extract assets independently so a saved draft can immediately resolve
            // new portable references without carrying binary data in its state.
            val opened = if (save) staged.inputStream().use(media::openFmd) else null
            resolver.openOutputStream(destination, "wt")?.use { output -> staged.inputStream().use { it.copyTo(output) } } ?: error("Cannot write portable file")
            withContext(Dispatchers.Main) {
                if (save) { change { s -> s.copy(tabs = s.tabs.map { if (it.id == id) it.copy(content = if (it.content == originalContent) content else it.content, saved = content, assetDirectory = opened!!.directory) else it }, busy = false, message = "Portable note saved") }; mutable.value.tabs.find { it.id == id }?.let(::remember) }
                else { portableOutput = null; portableDestinationIsNew = false; if (!finishShare(destination)) mutable.value = mutable.value.copy(busy = false, message = "Portable .smd exported") }
            }
        } finally { staged.delete() }
        }
    }
    fun importDropped(uris: List<Uri>, id: String, result: (JSONArray?) -> Unit) = viewModelScope.launch {
        try { val images = withContext(Dispatchers.IO) { media.importUris(uris) }; if (mutable.value.active.id == id) result(images) else { val insertion = (0 until images.length()).joinToString("\n\n") { i -> val image = images.getJSONObject(i); "![${image.getString("alt").replace("[", "\\[").replace("]", "\\]")}](<${image.getString("source")}>)" }; val note = mutable.value.tabs.find { it.id == id }; if (note != null) edit(id, note.content + "\n\n" + insertion + "\n"); result(null) } }
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
object PdfEngine {
    init { System.loadLibrary("smd_core") }
    @JvmStatic external fun export(markdown: String, options: String, assets: String, output: String): String
    @JvmStatic external fun imageSources(markdown: String): String
    @JvmStatic external fun fontFamilies(path: String): String
    @JvmStatic external fun validateTheme(input:String):String
}
